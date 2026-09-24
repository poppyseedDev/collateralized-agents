import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, type Keypair, type PublicKey } from "@solana/web3.js";
import type { KeyPairSigner } from "@solana/kit";
import { AGENTS, POLL_MS, type AgentConfig } from "./config.js";
import {
  agentPda,
  agentVaultPda,
  connection,
  positionVaultPda,
  positionsByAgent,
  programFor,
  sys,
  type Position,
  type Prog,
} from "./chain.js";
import { bestQuote, initOrca, mainPrice, signerFor, swapExactIn } from "./orca.js";
import { agentKeys } from "./keys.js";
import { loadState, saveState, type AgentState, type Book } from "./state.js";

const now = () => Math.floor(Date.now() / 1000);
const fmt = (lamports: bigint | string) => (Number(lamports) / LAMPORTS_PER_SOL).toFixed(4);

class AgentRunner {
  /** The bound trading key: draws, swaps, and settles. */
  kp: Keypair;
  operator: PublicKey;
  program: Prog;
  agent: PublicKey;
  signer!: KeyPairSigner;
  state: AgentState;

  constructor(readonly cfg: AgentConfig) {
    const keys = agentKeys(cfg.id);
    this.kp = keys.executor;
    this.operator = keys.operator.publicKey;
    this.program = programFor(this.kp);
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

  async tick(price: number | null, positions: Position[]) {
    if (price !== null) {
      this.state.prices = [...this.state.prices, price].slice(-100);
    }

    for (const p of positions) {
      const key = p.publicKey.toBase58();
      if (p.status === "open") await this.maybeDraw(p);
      else if (p.status === "trading" && !this.state.books[key]) this.adoptOrphan(p);
    }

    for (const [key, book] of Object.entries(this.state.books)) {
      const p = positions.find((x) => x.publicKey.toBase58() === key);
      if (!p || p.status !== "trading") {
        this.log("book closed on-chain", key, p?.status ?? "missing");
        delete this.state.books[key];
        continue;
      }
      try {
        if (now() >= book.settleAt) await this.settle(p, book);
        else await this.trade(key, book, price);
      } catch (e) {
        this.log("error on", key, (e as Error).message);
      }
      this.save();
    }
  }

  settleTime(drawnAt: number, deadline: number) {
    const buffer = Math.max(60, Math.min(300, Math.floor((deadline - drawnAt) / 4)));
    return Math.min(deadline - buffer, drawnAt + this.cfg.holdSecs);
  }

  async maybeDraw(p: Position) {
    const deadline = p.deadline.toNumber();
    if (now() >= deadline - 180) return; // too close to the deadline to trade safely
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
    this.state.books[p.publicKey.toBase58()] = {
      principal: p.principal.toString(),
      sol: p.principal.toString(),
      usdc: "0",
      drawnAt,
      // keep the original schedule; if it has already passed, settle soon but before the deadline
      settleAt: Math.min(
        Math.max(this.settleTime(drawnAt, p.deadline.toNumber()), now() + 60),
        p.deadline.toNumber() - 60,
      ),
      deadline: p.deadline.toNumber(),
      cycles: 0,
      trades: [],
    };
    this.log("adopted trading position without a book", p.publicKey.toBase58());
  }

  async swap(book: Book, side: "SOL" | "USDC", amount: bigint, pool?: string) {
    if (amount <= 0n) return null;
    const target = pool ?? (await bestQuote(side, amount, this.signer)).pool;
    const r = await swapExactIn(target, side, amount, this.signer);
    const sol = BigInt(book.sol) + r.solDelta;
    const usdc = BigInt(book.usdc) + r.usdcDelta;
    book.sol = (sol < 0n ? 0n : sol).toString();
    book.usdc = (usdc < 0n ? 0n : usdc).toString();
    const out = side === "SOL" ? r.usdcDelta : r.solDelta;
    book.trades.push({
      at: now(),
      side: side === "SOL" ? "SOL->USDC" : "USDC->SOL",
      in: amount.toString(),
      out: out.toString(),
      pool: target,
      sig: r.signature,
    });
    this.log(
      side === "SOL" ? `sold ${fmt(amount)} SOL for ${Number(out) / 1e6} USDC` : `sold ${Number(amount) / 1e6} USDC for ${fmt(out)} SOL`,
      "on", target.slice(0, 6),
    );
    return r;
  }

  async trade(key: string, book: Book, price: number | null) {
    const s = this.cfg.strategy;
    const sol = BigInt(book.sol);
    const usdc = BigInt(book.usdc);

    if (s.kind === "rotate") {
      if (book.cycles === 0) {
        await this.swap(book, "SOL", (sol * BigInt(s.sizeBps)) / 10_000n);
        book.cycles = 1;
      }
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
        await this.swap(book, "SOL", (sol * BigInt(s.sizeBps)) / 10_000n);
        book.cycles++;
      } else if (usdc > 0n && price > sma * (1 + band)) {
        this.log(`risk-on: price ${price.toFixed(3)} > SMA ${sma.toFixed(3)}`);
        await this.swap(book, "USDC", usdc);
      }
      return;
    }

    if (s.kind === "arbitrage") {
      if (usdc > 0n) {
        // finish an interrupted round trip
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
      const r1 = await this.swap(book, "SOL", size, leg1.pool);
      if (r1 && r1.usdcDelta > 0n) await this.swap(book, "USDC", r1.usdcDelta, leg2.pool);
      book.cycles++;
    }
  }

  async settle(p: Position, book: Book) {
    const key = p.publicKey.toBase58();
    const usdc = BigInt(book.usdc);
    if (usdc > 0n) {
      try {
        await this.swap(book, "USDC", usdc);
      } catch (e) {
        if (now() < book.deadline - 60) throw e; // retry next tick
        this.log("could not unwind USDC before deadline; settling with SOL only", (e as Error).message);
      }
    }
    const returned = BigInt(book.sol);
    const wallet = BigInt(await connection.getBalance(this.kp.publicKey));
    if (wallet < returned + 10_000n) {
      throw new Error(`wallet has ${fmt(wallet)} SOL, needs ${fmt(returned)} to settle`);
    }
    const sig = await this.program.methods
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
    console.log("heartbeat failed:", (e as Error).message);
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
    let price: number | null = null;
    try {
      price = await mainPrice();
    } catch (e) {
      console.log("price unavailable:", (e as Error).message);
    }
    let byAgent: Map<string, Position[]> | null = null;
    try {
      // One program scan per tick for every agent: the public RPC rate-limits this call.
      byAgent = await positionsByAgent(runners[0].program, runners.map((r) => r.agent));
    } catch (e) {
      console.log("position scan failed:", (e as Error).message);
    }
    if (byAgent) {
      for (const r of runners) {
        try {
          await r.tick(price, byAgent.get(r.agent.toBase58()) ?? []);
        } catch (e) {
          r.log("tick failed:", (e as Error).message);
        }
      }
      await heartbeat(runners.map((r) => r.agent.toBase58()));
    }
    await new Promise((res) => setTimeout(res, POLL_MS));
  }
  for (const r of runners) r.save();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
