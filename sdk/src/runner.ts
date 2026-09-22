/**
 * Drives an external trading bot through a Proof of Agent position:
 *   1. a trader opens a position on the agent
 *   2. the runner draws the SOL into the trading wallet
 *   3. it starts the operator's hook command (the bot) and waits
 *   4. it settles before the deadline with whatever the wallet gained or lost,
 *      killing the hook if it is still running
 *
 * One position trades at a time; others queue. Accounting is by wallet
 * balance, so anything the bot does with the wallet counts for the position.
 * State is persisted so a restart resumes open positions.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Keypair, PublicKey } from "@solana/web3.js";
import { LAMPORTS, PoaClient, type Agent, type Position } from "./client.js";

export type RunnerOptions = {
  rpcUrl: string;
  agent: PublicKey;
  tradingKey: Keypair;
  /** Shell command started after each draw. Env: POA_POSITION, POA_PRINCIPAL_SOL, POA_DEADLINE, POA_SETTLE_BY, POA_WALLET, POA_RPC_URL, POA_PAPER. */
  hook?: string;
  /** Shell command run on notable events, with POA_EVENT and POA_MESSAGE. */
  notify?: string;
  /** Settle this many seconds after drawing, even if the hook is still running. */
  holdSecs: number;
  /** Settle at least this many seconds before the deadline. */
  bufferSecs: number;
  /** Do not trade: run the hook with POA_PAPER=1 and settle exactly the principal. */
  paper: boolean;
  pollMs: number;
  stateFile: string;
  log?: (msg: string) => void;
};

type Book = { position: string; principal: string; balanceAtDraw: string; drawnAt: number; settleAt: number; deadline: number };
type State = { active: Book | null; history: { position: string; principal: string; returned: string; at: number }[] };

const now = () => Math.floor(Date.now() / 1000);
const sol = (n: bigint | number | string) => (Number(n) / LAMPORTS).toFixed(4);

export class Runner {
  private client: PoaClient;
  private agentAcc!: Agent;
  private state: State;
  private hook: ChildProcess | null = null;
  private stopping = false;
  private log: (msg: string) => void;

  constructor(private opts: RunnerOptions) {
    this.client = new PoaClient(opts.rpcUrl, opts.tradingKey);
    this.log = opts.log ?? ((m) => console.log(new Date().toISOString(), m));
    this.state = existsSync(opts.stateFile) ? JSON.parse(readFileSync(opts.stateFile, "utf8")) : { active: null, history: [] };
  }

  private save() {
    mkdirSync(require_dirname(this.opts.stateFile), { recursive: true });
    writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
  }

  private async notify(event: string, message: string) {
    this.log(`${event}: ${message}`);
    if (!this.opts.notify) return;
    spawn(this.opts.notify, { shell: true, stdio: "inherit", env: { ...process.env, POA_EVENT: event, POA_MESSAGE: message } });
  }

  async start() {
    const a = await this.client.agent(this.opts.agent);
    if (!a) throw new Error(`agent ${this.opts.agent.toBase58()} not found on ${this.opts.rpcUrl}`);
    if (!a.executor.equals(this.opts.tradingKey.publicKey) && !a.operator.equals(this.opts.tradingKey.publicKey)) {
      throw new Error(`trading key ${this.opts.tradingKey.publicKey.toBase58()} is not bound to this agent (bound: ${a.executor.toBase58()})`);
    }
    this.agentAcc = a;
    this.log(`agent "${a.name}" ${a.publicKey.toBase58()} status=${a.status} bond=${sol(a.totalCollateral.toString())} SOL trading-key=${this.opts.tradingKey.publicKey.toBase58()}${this.opts.paper ? " [paper]" : ""}`);
    process.on("SIGINT", () => this.stop());
    process.on("SIGTERM", () => this.stop());
    while (!this.stopping) {
      try {
        await this.tick();
      } catch (e) {
        await this.notify("error", (e as Error).message);
      }
      await new Promise((r) => setTimeout(r, this.opts.pollMs));
    }
  }

  stop() {
    this.stopping = true;
    this.hook?.kill("SIGTERM");
  }

  private settleTime(drawnAt: number, deadline: number) {
    return Math.min(deadline - this.opts.bufferSecs, drawnAt + this.opts.holdSecs);
  }

  private async tick() {
    const positions = await this.client.positions(this.opts.agent);
    const active = this.state.active;

    if (active) {
      const p = positions.find((x) => x.publicKey.toBase58() === active.position);
      if (!p || p.status !== "trading") {
        this.log(`position ${active.position} is ${p?.status ?? "gone"}; dropping book`);
        this.hook?.kill("SIGTERM");
        this.state.active = null;
        this.save();
        return;
      }
      const dueIn = active.settleAt - now();
      if (dueIn <= 0 || (this.hook && this.hook.exitCode !== null)) {
        await this.settle(p, active);
      } else if (dueIn <= 60 && dueIn > 60 - this.opts.pollMs / 1000) {
        await this.notify("settle-soon", `position ${p.publicKey.toBase58()} settles in ${dueIn}s`);
      }
      return;
    }

    // adopt a position we drew before a restart
    const orphan = positions.find((p) => p.status === "trading");
    if (orphan) {
      const drawnAt = orphan.drawnAt.toNumber();
      const deadline = orphan.deadline.toNumber();
      const balance = await this.client.connection.getBalance(this.opts.tradingKey.publicKey);
      this.state.active = {
        position: orphan.publicKey.toBase58(), principal: orphan.principal.toString(), balanceAtDraw: String(balance),
        drawnAt, settleAt: Math.max(Math.min(this.settleTime(drawnAt, deadline), deadline - this.opts.bufferSecs), now() + 30), deadline,
      };
      this.save();
      await this.notify("adopted", `resumed trading position ${orphan.publicKey.toBase58()} without its book; settling with principal + balance change from now`);
      return;
    }

    const next = positions.filter((p) => p.status === "open" && p.deadline.toNumber() - now() > this.opts.bufferSecs + 120).sort((a, b) => a.openedAt.cmp(b.openedAt))[0];
    if (next) await this.draw(next);
  }

  private async draw(p: Position) {
    const deadline = p.deadline.toNumber();
    const sig = await this.client.drawFunds(this.opts.agent, p.publicKey);
    const balance = await this.client.connection.getBalance(this.opts.tradingKey.publicKey);
    const drawnAt = now();
    const book: Book = { position: p.publicKey.toBase58(), principal: p.principal.toString(), balanceAtDraw: String(balance), drawnAt, settleAt: this.settleTime(drawnAt, deadline), deadline };
    this.state.active = book;
    this.save();
    this.log(`drew ${sol(p.principal.toString())} SOL from ${book.position} (${sig.slice(0, 12)}…); settle by ${new Date(book.settleAt * 1000).toISOString()}`);
    this.startHook(book);
  }

  private startHook(book: Book) {
    if (!this.opts.hook) return;
    const env = {
      ...process.env,
      POA_POSITION: book.position,
      POA_PRINCIPAL_SOL: sol(book.principal),
      POA_PRINCIPAL_LAMPORTS: book.principal,
      POA_DEADLINE: String(book.deadline),
      POA_SETTLE_BY: String(book.settleAt),
      POA_WALLET: this.opts.tradingKey.publicKey.toBase58(),
      POA_RPC_URL: this.opts.rpcUrl,
      POA_PAPER: this.opts.paper ? "1" : "0",
    };
    this.hook = spawn(this.opts.hook, { shell: true, stdio: "inherit", env });
    this.log(`hook started (pid ${this.hook.pid}): ${this.opts.hook}`);
    this.hook.on("exit", (code) => this.log(`hook exited with code ${code}`));
  }

  private async settle(p: Position, book: Book) {
    if (this.hook && this.hook.exitCode === null) {
      this.log("hook still running at settle time; sending SIGTERM");
      this.hook.kill("SIGTERM");
      await new Promise((r) => setTimeout(r, 5000));
      if (this.hook.exitCode === null) this.hook.kill("SIGKILL");
    }
    this.hook = null;

    const principal = BigInt(book.principal);
    let returned = principal;
    if (!this.opts.paper) {
      const balance = BigInt(await this.client.connection.getBalance(this.opts.tradingKey.publicKey));
      const delta = balance - BigInt(book.balanceAtDraw);
      returned = principal + delta;
      if (returned < 0n) returned = 0n;
      // keep enough in the wallet to pay for the settle transaction itself
      const spare = balance - returned;
      if (spare < 20_000n) returned = balance > 20_000n ? balance - 20_000n : 0n;
    }
    const sig = await this.client.settlePosition(this.agentAcc, p, Number(returned));
    const pnl = returned - principal;
    await this.notify("settled", `position ${book.position}: principal ${sol(principal)} returned ${sol(returned)} (${pnl >= 0n ? "+" : ""}${sol(pnl)}) ${sig.slice(0, 12)}…`);
    this.state.history.push({ position: book.position, principal: book.principal, returned: returned.toString(), at: now() });
    this.state.active = null;
    this.save();
  }
}

function require_dirname(p: string) {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : ".";
}
