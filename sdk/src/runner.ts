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
 *
 * The hook runs in its own process group. At settle time the whole group gets
 * SIGTERM, then up to `graceSecs` to unwind (never past the deadline), then
 * SIGKILL. The balance is read only once nothing in the group is running.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { PublicKey, type Keypair } from "@solana/web3.js";
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
  /**
   * After SIGTERM at settle time, how long the hook may take to unwind before SIGKILL.
   * Default 60. Capped so the hook never runs past the deadline minus the time needed to settle.
   */
  graceSecs?: number;
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Seconds kept free before the deadline for the settle transaction itself. */
export const SETTLE_TX_SECS = 30;

/** How long the hook may unwind after SIGTERM: `graceSecs` (default 60), cut so it ends SETTLE_TX_SECS before the deadline, never negative. */
export function hookGraceSecs(graceSecs: number | undefined, deadline: number, nowSecs: number) {
  return Math.max(0, Math.min(graceSecs ?? 60, deadline - SETTLE_TX_SECS - nowSecs));
}
const TOKEN_PROGRAMS = [
  new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

/** True while any process in the group still exists. */
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pgid: number, sig: NodeJS.Signals) {
  try {
    process.kill(-pgid, sig);
  } catch {
    // group already gone
  }
}

/** Writes to a temp file, fsyncs, keeps the previous version as `.bak`, then renames over the original. */
export function writeAtomic(path: string, data: string) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(tmp, path);
}

/**
 * Loads the runner state. A file that does not parse is moved aside to
 * `<file>.corrupt-<ts>` and the backup is used, so a bad write cannot crash-loop the runner.
 */
export function loadRunnerState(path: string, log: (m: string) => void): State {
  const empty: State = { active: null, history: [] };
  if (!existsSync(path)) return empty;
  try {
    return { ...empty, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (e) {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    renameSync(path, aside);
    log(`ALERT state file ${path} did not parse (${(e as Error).message}); moved it to ${aside}`);
    const bak = `${path}.bak`;
    if (existsSync(bak)) {
      try {
        const s = { ...empty, ...JSON.parse(readFileSync(bak, "utf8")) };
        log(`ALERT resuming from backup ${bak}; check the wallet against it`);
        return s;
      } catch (e2) {
        log(`ALERT backup ${bak} did not parse either (${(e2 as Error).message})`);
      }
    }
    log("ALERT starting with empty state; a trading position will be re-adopted from chain");
    return empty;
  }
}

export class Runner {
  private client: PoaClient;
  private agentAcc!: Agent;
  private state: State;
  private hook: ChildProcess | null = null;
  /** Set when the hook's shell has exited; its children may still be running. */
  private hookExited = false;
  private stopping = false;
  private log: (msg: string) => void;

  constructor(private opts: RunnerOptions) {
    this.client = new PoaClient(opts.rpcUrl, opts.tradingKey);
    this.log = opts.log ?? ((m) => console.log(new Date().toISOString(), m));
    this.state = loadRunnerState(opts.stateFile, this.log);
  }

  private save() {
    writeAtomic(this.opts.stateFile, JSON.stringify(this.state, null, 2));
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
    if (this.hook?.pid) signalGroup(this.hook.pid, "SIGTERM");
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
        if (this.hook?.pid) signalGroup(this.hook.pid, "SIGTERM");
        this.hook = null;
        this.state.active = null;
        this.save();
        return;
      }
      const dueIn = active.settleAt - now();
      if (dueIn <= 0 || (this.hook && this.hookExited)) {
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
    // Own process group, so settle can stop the hook and everything it started.
    const hook = spawn(this.opts.hook, { shell: true, stdio: "inherit", env, detached: true });
    this.hook = hook;
    this.hookExited = false;
    this.log(`hook started (pid ${hook.pid}): ${this.opts.hook}`);
    hook.on("exit", (code, signal) => {
      if (this.hook === hook) this.hookExited = true;
      this.log(`hook exited with ${signal ? `signal ${signal}` : `code ${code}`}`);
    });
  }

  /**
   * Stops the hook's process group: SIGTERM, up to the grace period for it to
   * unwind, then SIGKILL. Returns once no process in the group is left.
   */
  private async stopHook(deadline: number) {
    const hook = this.hook;
    this.hook = null;
    if (!hook?.pid) return;
    const pgid = hook.pid;
    if (!groupAlive(pgid)) return;
    const grace = hookGraceSecs(this.opts.graceSecs, deadline, now());
    this.log(`hook still running at settle time; sending SIGTERM to its process group, ${grace}s to finish`);
    signalGroup(pgid, "SIGTERM");
    const until = Date.now() + grace * 1000;
    while (groupAlive(pgid) && Date.now() < until) await sleep(250);
    if (groupAlive(pgid)) {
      this.log("hook did not stop in time; sending SIGKILL to its process group");
      signalGroup(pgid, "SIGKILL");
      const hard = Date.now() + 5000;
      while (groupAlive(pgid) && Date.now() < hard) await sleep(100);
      if (groupAlive(pgid)) this.log("warning: hook process group still present after SIGKILL");
    }
  }

  /** Token accounts with a non-zero balance: anything the hook left outside SOL is not counted. */
  private async strayTokens(): Promise<string[]> {
    const out: string[] = [];
    for (const programId of TOKEN_PROGRAMS) {
      const res = await this.client.connection.getParsedTokenAccountsByOwner(this.opts.tradingKey.publicKey, { programId });
      for (const a of res.value) {
        const info = a.account.data.parsed?.info;
        if (info && info.tokenAmount?.amount !== "0") out.push(`${info.tokenAmount.uiAmountString} of ${info.mint}`);
      }
    }
    return out;
  }

  private async settle(p: Position, book: Book) {
    // Read the balance only once nothing the hook started is still running.
    await this.stopHook(book.deadline);

    const principal = BigInt(book.principal);
    let returned = principal;
    if (!this.opts.paper) {
      const stray = await this.strayTokens().catch((e) => [`(could not check token balances: ${(e as Error).message})`]);
      if (stray.length) {
        await this.notify("warning", `trading wallet holds non-SOL tokens at settle time, which are not counted for the position: ${stray.join(", ")}`);
      }
      const balance = BigInt(await this.client.connection.getBalance(this.opts.tradingKey.publicKey));
      const delta = balance - BigInt(book.balanceAtDraw);
      returned = principal + delta;
      if (returned < 0n) returned = 0n;
      // keep enough in the wallet to pay for the settle transaction itself
      const spare = balance - returned;
      if (spare < 20_000n) returned = balance > 20_000n ? balance - 20_000n : 0n;
    }
    const sig = await this.client.settlePosition(this.agentAcc, p, returned);
    const pnl = returned - principal;
    await this.notify("settled", `position ${book.position}: principal ${sol(principal)} returned ${sol(returned)} (${pnl >= 0n ? "+" : ""}${sol(pnl)}) ${sig.slice(0, 12)}…`);
    this.state.history.push({ position: book.position, principal: book.principal, returned: returned.toString(), at: now() });
    this.state.active = null;
    this.save();
  }
}
