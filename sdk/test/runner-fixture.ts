import { join } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Agent, Position } from "../src/client.js";
import { Runner, type RunnerOptions } from "../src/runner.js";
import { DEAD_RPC, tempDir } from "./helpers.js";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type TokenAccount = { mint: string; amount: string; ui: string };

/** A stand-in for the chain: the runner's client is swapped for this, so nothing leaves the process. */
export class FakeChain {
  positions: Position[] = [];
  balance = 5_000_000_000;
  tokens: Record<string, TokenAccount[]> = {};
  tokenError: Error | null = null;
  drawn: PublicKey[] = [];
  settled: { position: PublicKey; returned: bigint }[] = [];
  tokenLookups = 0;
  /** Called on every balance read, before it returns. */
  onBalance: (() => void) | null = null;

  client() {
    return {
      positions: async () => this.positions,
      drawFunds: async (_agent: PublicKey, position: PublicKey) => {
        this.drawn.push(position);
        const p = this.positions.find((x) => x.publicKey.equals(position));
        if (p) p.status = "trading";
        return "drawsig1111111111111";
      },
      settlePosition: async (_a: Agent, p: Position, returned: bigint) => {
        this.settled.push({ position: p.publicKey, returned: BigInt(returned) });
        return "settlesig11111111111";
      },
      connection: {
        getBalance: async () => {
          this.onBalance?.();
          return this.balance;
        },
        getParsedTokenAccountsByOwner: async (_owner: PublicKey, { programId }: { programId: PublicKey }) => {
          this.tokenLookups++;
          if (this.tokenError) throw this.tokenError;
          return {
            value: (this.tokens[programId.toBase58()] ?? []).map((a) => ({
              account: { data: { parsed: { info: { mint: a.mint, tokenAmount: { amount: a.amount, uiAmountString: a.ui } } } } },
            })),
          };
        },
      },
    };
  }
}

/** The runner's private members, for driving it one step at a time. */
export type RunnerInternals = {
  tick(): Promise<void>;
  settle(p: Position, book: Book): Promise<void>;
  startHook(book: Book): void;
  stopHook(deadline: number): Promise<void>;
  stop(): void;
  hook: { pid?: number } | null;
  hookExited: boolean;
  state: { active: Book | null; history: { position: string; principal: string; returned: string; at: number }[] };
};
export type Book = { position: string; principal: string; balanceAtDraw: string; drawnAt: number; settleAt: number; deadline: number };

export function makeRunner(t: { after: (fn: () => void) => void }, opts: Partial<RunnerOptions> = {}) {
  const dir = tempDir(t);
  const logs: string[] = [];
  const tradingKey = Keypair.generate();
  const agentKey = PublicKey.unique();
  const chain = new FakeChain();
  const runner = new Runner({
    rpcUrl: DEAD_RPC, agent: agentKey, tradingKey, holdSecs: 600, bufferSecs: 60, graceSecs: 5, paper: false,
    pollMs: 15_000, stateFile: join(dir, "state", "state.json"), log: (m) => logs.push(m), ...opts,
  });
  const agent = { publicKey: agentKey, operator: PublicKey.unique(), executor: tradingKey.publicKey } as Agent;
  Object.assign(runner, { client: chain.client(), agentAcc: agent });
  const r = runner as unknown as RunnerInternals;
  // never leave a hook running if a test fails half way
  t.after(() => {
    if (r.hook?.pid) try { process.kill(-r.hook.pid, "SIGKILL"); } catch { /* gone */ }
  });
  return { runner, r, chain, logs, dir, tradingKey, agent };
}

export function book(p: Position, fields: Partial<Book> = {}): Book {
  const t = Math.floor(Date.now() / 1000);
  return {
    position: p.publicKey.toBase58(), principal: p.principal.toString(), balanceAtDraw: "5000000000",
    drawnAt: t, settleAt: t + 600, deadline: t + 3600, ...fields,
  };
}
