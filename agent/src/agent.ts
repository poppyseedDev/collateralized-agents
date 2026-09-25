import { LAMPORTS_PER_SOL, type Keypair, type PublicKey } from "@solana/web3.js";
import type { KeyPairSigner } from "@solana/kit";
import { ALERT_WINDOW_SECS, MAIN_POOL, POLL_MS, SETTLE_BUFFER_SECS, type AgentConfig } from "./config.js";
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
  withFallback,
  type Position,
  type Prog,
} from "./chain.js";
import { bestQuote, resolveSwap, signerFor, swapExactIn, SwapInFlight, type SwapResult } from "./orca.js";
import { runnerKeys } from "./keys.js";
import { loadStateFrom, saveState, type AgentState, type Book, type PriceSample } from "./state.js";
import { arbitrageEdge, arbitrageStep, leg2MinOut, momentumAction, rotateAction } from "./strategies.js";

/** Cluster time minus local time, refreshed at the start of every tick. */
let skew = 0;
let clockSource: "chain" | "local" | null = null;
/** Seconds, on the cluster's clock when it could be read this tick, else the local clock. */
export const now = () => Math.floor(Date.now() / 1000) + skew;
export const clock = () => ({ skew, source: clockSource });
const fmt = (lamports: bigint | string) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);
export const msg = (e: unknown) => (e as Error)?.message ?? String(e);
export const glog = (...args: unknown[]) => console.log(new Date().toISOString(), ...args);

/** Deadlines are enforced on-chain with the cluster clock, so decisions use it too. */
export async function refreshClock(readChainTime: () => Promise<number> = chainTime) {
  try {
    const t = await readChainTime();
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
export const LAST_CALL_SECS = 120;

/** When a book drawn at `drawnAt` settles: after its hold time, but at least SETTLE_BUFFER_SECS before the deadline. */
export const settleTime = (drawnAt: number, deadline: number, holdSecs: number) =>
  Math.min(deadline - SETTLE_BUFFER_SECS, drawnAt + holdSecs);

/** A book settles once its settle time comes, or once it is inside the settle buffer (books saved with a later settleAt too). */
export const dueToSettle = (book: Pick<Book, "settleAt" | "deadline">, t: number) =>
  t >= book.settleAt || t >= book.deadline - SETTLE_BUFFER_SECS;

/** Too close to the deadline to draw and trade safely: the settle buffer plus two minutes. */
export const tooLateToDraw = (t: number, deadline: number) => t >= deadline - SETTLE_BUFFER_SECS - 120;

/** An unresolved pending swap stops waiting and the book settles as it stands. */
export const pastLastCall = (t: number, deadline: number) => t >= deadline - LAST_CALL_SECS;

/** Whether a book gets an ALERT line: near its deadline and not simply waiting for its scheduled settle. */
export function shouldAlert(book: Pick<Book, "deadline" | "settleAt" | "pending">, t: number, tickRan: boolean) {
  if (book.deadline - t > ALERT_WINDOW_SECS) return false;
  if (tickRan && !dueToSettle(book, t) && !book.pending) return false;
  return true;
}

/**
 * Lamports a settle leaves in the trading wallet: the rent-exempt minimum for a
 * 0-data account (Solana rejects a transaction that leaves the fee payer non-zero
 * but below it) plus the transaction fee.
 */
export const SETTLE_RESERVE_LAMPORTS = 890_880n + 10_000n;

/** What a settle can return: the book's SOL, or as much of it as the wallet holds above the reserve. */
export const settleAmount = (owed: bigint, wallet: bigint) => {
  const spendable = wallet - SETTLE_RESERVE_LAMPORTS;
  return spendable <= 0n ? 0n : owed < spendable ? owed : spendable;
};

/**
 * Price samples older than this are left out of the momentum average, so after downtime
 * the series starts over instead of mixing in prices from before. Twice the window,
 * counting each tick as at least a minute since a tick's own work adds to POLL_MS.
 */
export const priceMaxAgeSecs = (window: number) => 2 * window * Math.max(POLL_MS / 1000, 60);

/** The prices of the samples no older than priceMaxAgeSecs(window) at `t`, oldest first. */
export const freshPrices = (samples: PriceSample[], t: number, window: number) =>
  samples.filter((s) => t - s.at <= priceMaxAgeSecs(window)).map((s) => s.price);

type SwapOpts = { pool?: string; minOut?: bigint; bumpCycle?: boolean };

/** Chain and swap calls the runner makes, replaceable in tests. */
export type RunnerDeps = {
  bestQuote: typeof bestQuote;
  swapExactIn: typeof swapExactIn;
  resolveSwap: typeof resolveSwap;
  balanceOf: typeof balanceOf;
  recentSignatures: typeof recentSignatures;
};

/** The trading key's latest transactions, newest first. */
const recentSignatures = (address: PublicKey, limit: number) =>
  withFallback("recent signatures", (conn) => conn.getSignaturesForAddress(address, { limit }));

export class AgentRunner {
  /** The bound trading key: draws, swaps, and settles. */
  kp: Keypair;
  operator: PublicKey;
  program: Prog;
  /** Same key on RPC_URL_FALLBACK, used to retry a settle when the primary RPC is unreachable. */
  fallbackProgram: Prog | null;
  agent: PublicKey;
  signer!: KeyPairSigner;
  state: AgentState;
  /** The state was loaded from `.bak`, which is one save behind. */
  fromBackup: boolean;
  deps: RunnerDeps = { bestQuote, swapExactIn, resolveSwap, balanceOf, recentSignatures };

  constructor(
    readonly cfg: AgentConfig,
    keys: { operator: PublicKey; executor: Keypair } = runnerKeys(cfg.id),
  ) {
    this.kp = keys.executor;
    this.operator = keys.operator;
    this.program = programFor(this.kp);
    this.fallbackProgram = fallbackConnection ? programFor(this.kp, fallbackConnection) : null;
    this.agent = agentPda(this.operator, cfg.agentId);
    ({ state: this.state, fromBackup: this.fromBackup } = loadStateFrom(cfg.id));
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
    if (this.fromBackup) await this.checkAfterBackup();
  }

  /**
   * The backup is one save behind, so a swap saved as pending in the lost save may have
   * landed without being booked. Lists the trading key's recent transactions that no book
   * knows about, for reconciling by hand; it does not book them.
   */
  async checkAfterBackup() {
    const books = Object.entries(this.state.books);
    this.log(`ALERT state for ${this.cfg.id} was restored from its backup, which is one save behind; ${books.length} open book(s) may be missing a swap`);
    if (!books.length) return;
    let recent: Awaited<ReturnType<typeof recentSignatures>>;
    try {
      recent = await this.deps.recentSignatures(this.kp.publicKey, 20);
    } catch (e) {
      this.log(`ALERT could not list the trading key's recent transactions (${msg(e)}); reconcile ${books.map(([k]) => k).join(", ")} by hand`);
      return;
    }
    const known = new Set(books.flatMap(([, b]) => [...b.trades.map((t) => t.sig), ...(b.pending ? [b.pending.sig] : [])]));
    for (const [key, book] of books) {
      const since = Math.max(book.drawnAt, ...book.trades.map((t) => t.at));
      const unknown = recent.filter((s) => !s.err && !known.has(s.signature) && (s.blockTime == null || s.blockTime > since));
      if (!unknown.length) continue;
      // Draws and settles of other positions show up here too; only swaps belong in a book.
      this.log(
        `ALERT ${key} needs manual reconciliation: ${unknown.length} transaction(s) from the trading key since its last booked trade are in no book;`,
        "check whether any is a swap for this position:",
        unknown.map((s) => s.signature).join(", "),
      );
    }
  }

  /**
   * One pass over this agent's positions. `partial` means the program scan failed and
   * `positions` holds only the positions already in the books: settle and trade them,
   * but do not draw or adopt anything.
   */
  async tick(price: number | null, positions: Position[], partial = false) {
    if (price !== null) {
      this.state.prices = [...this.state.prices, { at: now(), price }].slice(-100);
    }

    // Existing books first, so a failed draw can never hold up a due settle.
    await this.runBooks(positions, price);

    if (!partial) {
      for (const p of positions) {
        const key = p.publicKey.toBase58();
        try {
          if (p.status === "open") await this.maybeDraw(p);
          else if (p.status === "trading" && !this.state.books[key]) this.adoptOrphan(p);
        } catch (e) {
          this.log("could not draw or adopt", key, msg(e));
        }
      }
    }
  }

  /** Settles the books that are due and nothing else: the loop runs this for every agent before any agent trades. */
  async settleDue(positions: Position[]) {
    await this.runBooks(positions, null, true);
  }

  /** Settles each book that is due and, unless `settleOnly`, trades the others. */
  private async runBooks(positions: Position[], price: number | null, settleOnly = false) {
    for (const [key, book] of Object.entries(this.state.books)) {
      const p = positions.find((x) => x.publicKey.toBase58() === key);
      if (!p || p.status !== "trading") {
        this.log("book closed on-chain", key, p?.status ?? "missing", book.pending ? `(swap ${book.pending.sig} was unresolved)` : "");
        delete this.state.books[key];
        this.save();
        continue;
      }
      if (settleOnly && !dueToSettle(book, now())) continue;
      try {
        const pendingSig = book.pending?.sig;
        let resolved = true;
        if (pendingSig) {
          try {
            resolved = await this.resolvePending(book);
          } catch (e) {
            // An RPC failure leaves the swap unknown: treat it as still pending so the last call still applies.
            this.log(`could not check swap ${pendingSig.slice(0, 12)}…, treating it as unresolved:`, msg(e));
            resolved = false;
          }
        }
        if (!resolved) {
          if (!pastLastCall(now(), book.deadline)) continue; // resolve it next tick
          this.log(`ALERT swap ${pendingSig} on ${key.slice(0, 8)} is still unresolved ${book.deadline - now()}s before the deadline; settling with the book as it stands`);
          await this.settle(p, book, true);
        } else if (dueToSettle(book, now())) await this.settle(p, book);
        else if (!settleOnly) await this.trade(key, book, price);
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
      if (!shouldAlert(book, now(), tickRan)) continue;
      const left = book.deadline - now();
      console.log(
        new Date().toISOString(),
        `ALERT [${this.cfg.id}] position ${key} is unsettled with ${left}s to its deadline`,
        tickRan ? "" : "(this tick could not run)",
        book.pending ? `(swap ${book.pending.sig} unresolved)` : "",
      );
    }
  }

  settleTime(drawnAt: number, deadline: number) {
    return settleTime(drawnAt, deadline, this.cfg.holdSecs);
  }

  async maybeDraw(p: Position) {
    const deadline = p.deadline.toNumber();
    if (tooLateToDraw(now(), deadline)) return; // too close to the deadline to trade safely
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
    const r = await this.deps.resolveSwap(pend, this.kp.publicKey.toBase58());
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
      const q = await this.deps.bestQuote(side, amount, this.signer);
      pool = q.pool;
      minOut ??= q.minOut;
    }
    const target = pool;
    let r: SwapResult;
    try {
      r = await this.deps.swapExactIn(
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
      const a = rotateAction(s, { cycles: book.cycles, sol });
      if (a) await this.swap(book, a.side, a.amount, { bumpCycle: a.bumpCycle });
      return;
    }

    if (s.kind === "momentum") {
      const a = momentumAction(s, freshPrices(this.state.prices, now(), s.window), price, { sol, usdc });
      if (a) {
        this.log(a.note);
        await this.swap(book, a.side, a.amount, a.bumpCycle ? { bumpCycle: true } : {});
      }
      return;
    }

    if (s.kind === "arbitrage") {
      const step = arbitrageStep(s, { cycles: book.cycles, sol, usdc });
      if (step.kind === "unwind") {
        // finish an interrupted or aborted round trip
        await this.swap(book, "USDC", step.amount);
        return;
      }
      if (step.kind === "done") return;
      const size = step.size;
      const leg1 = await this.deps.bestQuote("SOL", size, this.signer);
      const leg2 = await this.deps.bestQuote("USDC", leg1.out, this.signer);
      const { edgeBps, go } = arbitrageEdge(s, size, leg1, leg2);
      if (!go) return;
      this.log(`arb edge ${edgeBps} bps on ${key.slice(0, 6)}: ${leg1.pool.slice(0, 6)} -> ${leg2.pool.slice(0, 6)}`);
      const r1 = await this.swap(book, "SOL", size, { pool: leg1.pool, minOut: leg1.minOut, bumpCycle: true });
      if (!r1) return;
      const min2 = leg2MinOut(leg1, leg2, r1.usdcDelta);
      if (min2 === null) {
        this.log(`leg 1 returned ${r1.usdcDelta} USDC, below its quote of ${leg1.out}; aborting the round trip (the USDC is sold back next tick)`);
        return;
      }
      // Leg 2's minimum comes from its evaluated quote, scaled to what leg 1 actually returned.
      await this.swap(book, "USDC", r1.usdcDelta, { pool: leg2.pool, minOut: min2 });
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
        if (e instanceof SwapInFlight || !pastLastCall(now(), book.deadline)) throw e; // retry next tick
        this.log("could not unwind USDC before deadline; settling with SOL only", msg(e));
      }
    }
    const owed = BigInt(book.sol);
    const wallet = await this.deps.balanceOf(this.kp.publicKey);
    const returned = settleAmount(owed, wallet);
    if (returned < owed) {
      if (!pastLastCall(now(), book.deadline)) {
        throw new Error(`wallet has ${fmt(wallet)} SOL, needs ${fmt(owed)} to settle`); // retry next tick
      }
      // A partial return costs at most the shortfall beyond the drawdown; missing the deadline costs the whole bond.
      this.log(`ALERT wallet has ${fmt(wallet)} SOL, short of the ${fmt(owed)} owed on ${key.slice(0, 8)}; settling with ${fmt(returned)} before the deadline`);
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
    p.status = "settled"; // the list was fetched before the settle; do not adopt it as an orphan
  }
}

/** Position reads the loop makes, replaceable in tests. */
export type ScanDeps = { positionsForAgent: typeof positionsForAgent; positionsByKey: typeof positionsByKey };

/**
 * Ticks every runner once. Each agent gets its own filtered scan, so one failure does not
 * hold up the others; if it fails, the positions already in the books are fetched directly
 * and the tick runs as `partial` (no draws). Books that are due settle across all agents
 * first, so one agent's slow trades cannot push another's book past its deadline.
 * Returns the agents whose tick ran.
 */
export async function tickAll(
  runners: AgentRunner[],
  price: number | null,
  io: ScanDeps = { positionsForAgent, positionsByKey },
): Promise<{ ran: string[]; degraded: string[] }> {
  const ran: string[] = [];
  const degraded: string[] = [];
  const scans: { r: AgentRunner; positions: Position[] | null; partial: boolean }[] = [];
  for (const r of runners) {
    let positions: Position[] | null = null;
    let partial = false;
    try {
      positions = await io.positionsForAgent(r.agent);
    } catch (e) {
      r.log("position scan failed:", msg(e));
      // Fall back to the positions already in the books, so settlement still happens.
      const tracked = Object.keys(r.state.books);
      try {
        positions = await io.positionsByKey(tracked);
        partial = true;
        if (tracked.length) r.log(`fetched ${positions.length} of ${tracked.length} tracked positions directly; not drawing new ones this tick`);
      } catch (e2) {
        r.log("fetching tracked positions failed too:", msg(e2));
      }
    }
    scans.push({ r, positions, partial });
  }

  for (const { r, positions } of scans) {
    if (!positions) continue;
    try {
      await r.settleDue(positions);
    } catch (e) {
      r.log("settle pass failed:", msg(e));
    }
  }

  for (const { r, positions, partial } of scans) {
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
  return { ran, degraded };
}

/** Heartbeat note for agents whose tick ran on a partial position list. */
export const heartbeatNote = (degraded: string[]) =>
  degraded.length ? `degraded, position scan failed: ${degraded.join(", ")}` : undefined;
