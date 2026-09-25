import { LAMPORTS_PER_SOL, type Keypair, type PublicKey } from "@solana/web3.js";
import type { KeyPairSigner } from "@solana/kit";
import { AGENTS, ALERT_WINDOW_SECS, MAIN_POOL, POLL_MS, SETTLE_BUFFER_SECS, type AgentConfig } from "./config.js";
import {
  BN,
  agentPda,
  agentVaultPda,
  balanceOf,
  chainTime,
  fallbackConnection,
  isNetworkError,
  positionVaultPda,
  positionsByKey,
  positionsForAgent,
  programFor,
  sys,
  type Position,
  type Prog,
} from "./chain.js";
import { bestQuote, initOrca, mainPrice, resolveSwap, signerFor, swapExactIn, SwapInFlight, type SwapResult } from "./orca.js";
import { agentKeys } from "./keys.js";
import { loadState, saveState, type AgentState, type Book } from "./state.js";

/** Cluster time minus local time, refreshed at the start of every tick. */
let skew = 0;
let clockSource: "chain" | "local" | null = null;
/** Seconds, on the cluster's clock when it could be read this tick, else the local clock. */
const now = () => Math.floor(Date.now() / 1000) + skew;
const fmt = (lamports: bigint | string) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
const msg = (e: unknown) => (e as Error)?.message ?? String(e);
const glog = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

/** Deadlines are enforced on-chain with the cluster clock, so decisions use it too. */
async function refreshClock() {
  try {
    const t = await chainTime();
    skew = t - Math.floor(Date.now() / 1000);
    if (clockSource !== "chain") glog(`using chain time (local clock is ${Math.abs(skew)}s ${skew <= 0 ? "ahead" : "behind"})`);
    clockSource = "chain";
  } catch (e) {
    if (clockSource !== "local") glog("chain time unavailable, using local clock:", msg(e));
    skew = 0;
    clockSource = "local";
  }
}

/** Unwinding within this many seconds of the deadline gives up and settles in SOL. */
const LAST_CALL_SECS = 120;

type SwapOpts = { pool?: string; minOut?: bigint; bumpCycle?: boolean };

class AgentRunner {
  /** The bound trading key: draws, swaps, and settles. */
  kp: Keypair;
  operator: PublicKey;
  program: Prog;
  /** Same key on RPC_URL_FALLBACK, used to retry a settle when the primary RPC is unreachable. */
  fallbackProgram: Prog | null;
  agent: PublicKey;
  signer!: KeyPairSigner;
  state: AgentState;

  constructor(readonly cfg: AgentConfig) {
    const keys = agentKeys(cfg.id);
    this.kp = keys.executor;
    this.operator = keys.operator.publicKey;
    this.program = programFor(this.kp);
    this.fallbackProgram = fallbackConnection ? programFor(this.kp, fallbackConnection) : null;
    this.agent = agentPda(this.operator, cfg.agentId);
    this.state = loadState(cfg.id);
  }

  log(...args: unknown[]) {
    console.log(new Date().toISOString(), `[${this.cfg.id}]`, ...args);
  }

  save() {
    saveState(this.cfg.id, this.state);
  }

  async init() {
    this.signer = await signerFor(this.kp);
    const acc = await this.program.account.agent.fetchNullable(this.agent);
    if (!acc) throw new Error(`${this.cfg.id} is not registered; run npm run setup`);
    if (!acc.executor.equals(this.kp.publicKey)) {
      throw new Error(`${this.cfg.id}: trading key is not bound; run npm run setup`);
    }
    this.log("agent", this.agent.toBase58(), "status", Object.keys(acc.status)[0], "trading key", this.kp.publicKey.toBase58());
  }

  /**
   * One pass over this agent's positions. `partial` means the program scan failed and
   * `positions` holds only the positions already in the books: settle and trade them,
   * but do not draw or adopt anything.
   */
  async tick(price: number | null, positions: Position[], partial = false) {
    if (price !== null) {
      this.state.prices = [...this.state.prices, price].slice(-100);
    }

    if (!partial) {
      for (const p of positions) {
        const key = p.publicKey.toBase58();
        if (p.status === "open") await this.maybeDraw(p);
        else if (p.status === "trading" && !this.state.books[key]) this.adoptOrphan(p);
      }
    }

    for (const [key, book] of Object.entries(this.state.books)) {
      const p = positions.find((x) => x.publicKey.toBase58() === key);
      if (!p || p.status !== "trading") {
        this.log("book closed on-chain", key, p?.status ?? "missing", book.pending ? `(swap ${book.pending.sig} was unresolved)` : "");
        delete this.state.books[key];
        this.save();
        continue;
      }
      try {
        if (book.pending && !(await this.resolvePending(book))) {
          if (now() < book.deadline - LAST_CALL_SECS) continue; // resolve it next tick
          this.log(`ALERT swap ${book.pending.sig} on ${key.slice(0, 8)} is still unresolved ${book.deadline - now()}s before the deadline; settling with the book as it stands`);
          await this.settle(p, book, true);
        } else if (now() >= book.settleAt) await this.settle(p, book);
        else await this.trade(key, book, price);
      } catch (e) {
        if (e instanceof SwapInFlight) this.log("swap in flight on", key.slice(0, 8), "-", msg(e), "- will resolve next tick");
        else this.log("error on", key, msg(e));
      }
      this.save();
    }
  }

  /** Loud log line for books that are close to their deadline and not on track to settle. */
  alertNearDeadline(tickRan: boolean) {
    for (const [key, book] of Object.entries(this.state.books)) {
      const left = book.deadline - now();
      if (left > ALERT_WINDOW_SECS) continue;
      if (tickRan && now() < book.settleAt && !book.pending) continue; // waiting for its scheduled settle
      console.log(
        new Date().toISOString(),
        `ALERT [${this.cfg.id}] position ${key} is unsettled with ${left}s to its deadline`,
        tickRan ? "" : "(this tick could not run)",
        book.pending ? `(swap ${book.pending.sig} unresolved)` : "",
      );
    }
  }

  settleTime(drawnAt: number, deadline: number) {
    return Math.min(deadline - SETTLE_BUFFER_SECS, drawnAt + this.cfg.holdSecs);
  }

  async maybeDraw(p: Position) {
    const deadline = p.deadline.toNumber();
    if (now() >= deadline - SETTLE_BUFFER_SECS - 120) return; // too close to the deadline to trade safely
    const sig = await this.program.methods
      .drawFunds()
      .accounts({
        executor: this.kp.publicKey,
        agent: this.agent,
        position: p.publicKey,
        positionVault: positionVaultPda(p.publicKey),
        systemProgram: sys,
      })
      .rpc();
    const t = now();
    this.state.books[p.publicKey.toBase58()] = {
      principal: p.principal.toString(),
      sol: p.principal.toString(),
      usdc: "0",
      drawnAt: t,
      settleAt: this.settleTime(t, deadline),
      deadline,
      cycles: 0,
      trades: [],
    };
    p.status = "trading"; // the list was fetched before the draw
    this.save();
    this.log("drew", fmt(p.principal.toString()), "SOL from", p.publicKey.toBase58(), sig);
  }

  adoptOrphan(p: Position) {
    const drawnAt = p.drawnAt.toNumber();
    const deadline = p.deadline.toNumber();
    this.state.books[p.publicKey.toBase58()] = {
      principal: p.principal.toString(),
      sol: p.principal.toString(),
      usdc: "0",
      drawnAt,
      // keep the original schedule; if it has already passed, settle soon but before the deadline
      settleAt: Math.max(now(), Math.min(Math.max(this.settleTime(drawnAt, deadline), now() + 60), deadline - SETTLE_BUFFER_SECS)),
      deadline,
      cycles: 0,
      trades: [],
    };
    this.save();
    this.log("adopted trading position without a book", p.publicKey.toBase58());
  }

  /** Applies a landed swap to the book. */
  private record(book: Book, side: "SOL" | "USDC", amount: bigint, pool: string, r: SwapResult, bumpCycle?: boolean) {
    const sol = BigInt(book.sol) + r.solDelta;
    const usdc = BigInt(book.usdc) + r.usdcDelta;
    book.sol = (sol < 0n ? 0n : sol).toString();
    book.usdc = (usdc < 0n ? 0n : usdc).toString();
    if (bumpCycle) book.cycles++;
    const out = side === "SOL" ? r.usdcDelta : r.solDelta;
    book.trades.push({
      at: now(),
      side: side === "SOL" ? "SOL->USDC" : "USDC->SOL",
      in: amount.toString(),
      out: out.toString(),
      pool,
      sig: r.signature,
    });
    this.log(
      side === "SOL" ? `sold ${fmt(amount)} SOL for ${Number(out) / 1e6} USDC` : `sold ${Number(amount) / 1e6} USDC for ${fmt(out)} SOL`,
      "on", pool.slice(0, 6),
    );
  }

  /** Resolves a swap left pending by an earlier tick. True once the book no longer has one. */
  async resolvePending(book: Book): Promise<boolean> {
    const pend = book.pending!;
    const r = await resolveSwap(pend, this.kp.publicKey.toBase58());
    if (r.state === "pending") {
      this.log(`swap ${pend.sig.slice(0, 12)}… still unresolved: ${r.reason}`);
      return false;
    }
    book.pending = null;
    if (r.state === "failed") this.log(`swap ${pend.sig.slice(0, 12)}… did not land (${r.reason}); nothing booked`);
    else {
      this.log(`swap ${pend.sig.slice(0, 12)}… landed after all; booking it`);
      this.record(book, pend.side, BigInt(pend.in), pend.pool, r.result, pend.bumpCycle);
    }
    this.save();
    return true;
  }

  /**
   * Sells `amount` of `side`. Without a pool, the best pool is quoted now and its quote
   * sets the minimum output. The signed swap is saved as pending before it is sent.
   */
  async swap(book: Book, side: "SOL" | "USDC", amount: bigint, opts: SwapOpts = {}) {
    if (amount <= 0n) return null;
    if (book.pending) throw new Error(`swap ${book.pending.sig} is still pending on this book`);
    let { pool, minOut } = opts;
    if (!pool) {
      const q = await bestQuote(side, amount, this.signer);
      pool = q.pool;
      minOut ??= q.minOut;
    }
    const target = pool;
    let r: SwapResult;
    try {
      r = await swapExactIn(
        target,
        side,
        amount,
        this.signer,
        (s) => {
          book.pending = { sig: s.signature, lastValidBlockHeight: s.lastValidBlockHeight, side, in: amount.toString(), pool: target, at: now(), bumpCycle: opts.bumpCycle };
          this.save();
        },
        minOut,
      );
    } catch (e) {
      if (!(e instanceof SwapInFlight) && book.pending) {
        book.pending = null; // never sent, or rejected: it cannot land
        this.save();
      }
      throw e;
    }
    book.pending = null;
    this.record(book, side, amount, target, r, opts.bumpCycle);
    this.save();
    return r;
  }

  async trade(key: string, book: Book, price: number | null) {
    const s = this.cfg.strategy;
    const sol = BigInt(book.sol);
    const usdc = BigInt(book.usdc);

    if (s.kind === "rotate") {
      if (book.cycles === 0) await this.swap(book, "SOL", (sol * BigInt(s.sizeBps)) / 10_000n, { bumpCycle: true });
      return;
    }

    if (s.kind === "momentum") {
      const prices = this.state.prices;
      if (price === null || prices.length < s.window) return;
      const recent = prices.slice(-s.window);
      const sma = recent.reduce((a, b) => a + b, 0) / recent.length;
      const band = s.bandBps / 10_000;
      if (usdc === 0n && price < sma * (1 - band)) {
        this.log(`risk-off: price ${price.toFixed(3)} < SMA ${sma.toFixed(3)}`);
        await this.swap(book, "SOL", (sol * BigInt(s.sizeBps)) / 10_000n, { bumpCycle: true });
      } else if (usdc > 0n && price > sma * (1 + band)) {
        this.log(`risk-on: price ${price.toFixed(3)} > SMA ${sma.toFixed(3)}`);
        await this.swap(book, "USDC", usdc);
      }
      return;
    }

    if (s.kind === "arbitrage") {
      if (usdc > 0n) {
        // finish an interrupted or aborted round trip
        await this.swap(book, "USDC", usdc);
        return;
      }
      if (book.cycles >= 3) return;
      const size = (sol * BigInt(s.sizeBps)) / 10_000n;
      const leg1 = await bestQuote("SOL", size, this.signer);
      const leg2 = await bestQuote("USDC", leg1.out, this.signer);
      const edgeBps = Number(((leg2.out - size) * 10_000n) / size);
      if (edgeBps < s.minEdgeBps || leg1.pool === leg2.pool) return;
      this.log(`arb edge ${edgeBps} bps on ${key.slice(0, 6)}: ${leg1.pool.slice(0, 6)} -> ${leg2.pool.slice(0, 6)}`);
      const r1 = await this.swap(book, "SOL", size, { pool: leg1.pool, minOut: leg1.minOut, bumpCycle: true });
      if (!r1) return;
      if (r1.usdcDelta < leg1.out) {
        this.log(`leg 1 returned ${r1.usdcDelta} USDC, below its quote of ${leg1.out}; aborting the round trip (the USDC is sold back next tick)`);
        return;
      }
      // Leg 2's minimum comes from its evaluated quote, scaled to what leg 1 actually returned.
      await this.swap(book, "USDC", r1.usdcDelta, { pool: leg2.pool, minOut: (leg2.minOut * r1.usdcDelta) / leg1.out });
    }
  }

  /** `emergency`: a swap is unresolved at the last call, so skip the unwind and settle the book as it is. */
  async settle(p: Position, book: Book, emergency = false) {
    const key = p.publicKey.toBase58();
    const usdc = BigInt(book.usdc);
    if (usdc > 0n && !emergency) {
      try {
        // Near the deadline, one quote on the deepest pool instead of quoting every pool.
        await this.swap(book, "USDC", usdc, { pool: MAIN_POOL });
      } catch (e) {
        if (e instanceof SwapInFlight || now() < book.deadline - LAST_CALL_SECS) throw e; // retry next tick
        this.log("could not unwind USDC before deadline; settling with SOL only", msg(e));
      }
    }
    const returned = BigInt(book.sol);
    const wallet = await balanceOf(this.kp.publicKey);
    if (wallet < returned + 10_000n) {
      throw new Error(`wallet has ${fmt(wallet)} SOL, needs ${fmt(returned)} to settle`);
    }
    const send = (program: Prog): Promise<string> =>
      program.methods
        .settlePosition(new BN(returned.toString()))
        .accounts({
          executor: this.kp.publicKey,
          operator: this.operator,
          agent: this.agent,
          agentVault: agentVaultPda(this.agent),
          position: p.publicKey,
          positionVault: positionVaultPda(p.publicKey),
          trader: p.trader,
          systemProgram: sys,
        })
        .rpc();
    let sig: string;
    try {
      sig = await send(this.program);
    } catch (e) {
      if (!this.fallbackProgram || !isNetworkError(e)) throw e;
      this.log("settle on the primary RPC failed, retrying on the fallback:", msg(e));
      sig = await send(this.fallbackProgram);
    }
    const pnl = returned - BigInt(book.principal);
    this.log(`settled ${key.slice(0, 8)}: principal ${fmt(book.principal)} returned ${fmt(returned)} (${pnl >= 0n ? "+" : ""}${fmt(pnl)})`, sig);
    this.state.history.push({ position: key, principal: book.principal, returned: returned.toString(), at: now() });
    delete this.state.books[key];
  }
}

const HEARTBEAT_URL = process.env.HEARTBEAT_URL ?? "https://dev.proofofagent.dev/api/heartbeat";
const HEARTBEAT_SECRET = process.env.HEARTBEAT_SECRET;

/** Tells the site the runner is alive so testers can see whether agents are online. */
async function heartbeat(agents: string[], note?: string) {
  if (!HEARTBEAT_SECRET) return;
  try {
    await fetch(HEARTBEAT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${HEARTBEAT_SECRET}` },
      body: JSON.stringify({ agents, note }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) {
    glog("heartbeat failed:", (e as Error).message);
  }
}

async function main() {
  await initOrca();
  const only = process.argv.slice(2);
  const runners = AGENTS.filter((a) => !only.length || only.includes(a.id)).map((a) => new AgentRunner(a));
  for (const r of runners) await r.init();

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("stopping after this tick…");
  });

  while (!stopping) {
    await refreshClock();
    let price: number | null = null;
    try {
      price = await mainPrice();
    } catch (e) {
      glog("price unavailable:", msg(e));
    }
    const ran: string[] = [];
    const degraded: string[] = [];
    for (const r of runners) {
      // One filtered scan per agent, so one failure does not hold up the others.
      let positions: Position[] | null = null;
      let partial = false;
      try {
        positions = await positionsForAgent(r.agent);
      } catch (e) {
        r.log("position scan failed:", msg(e));
        // Fall back to the positions already in the books, so settlement still happens.
        const tracked = Object.keys(r.state.books);
        try {
          positions = await positionsByKey(tracked);
          partial = true;
          if (tracked.length) r.log(`fetched ${positions.length} of ${tracked.length} tracked positions directly; not drawing new ones this tick`);
        } catch (e2) {
          r.log("fetching tracked positions failed too:", msg(e2));
        }
      }
      let ok = false;
      if (positions) {
        try {
          await r.tick(price, positions, partial);
          ok = true;
        } catch (e) {
          r.log("tick failed:", msg(e));
        }
      }
      if (ok) {
        ran.push(r.agent.toBase58());
        if (partial) degraded.push(r.cfg.id);
      }
      r.alertNearDeadline(ok);
    }
    // Only report agents whose tick actually ran.
    if (ran.length) await heartbeat(ran, degraded.length ? `degraded, position scan failed: ${degraded.join(", ")}` : undefined);
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  for (const r of runners) r.save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
