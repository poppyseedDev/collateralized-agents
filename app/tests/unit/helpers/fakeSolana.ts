/**
 * Replaces `Connection` from @solana/web3.js with an in-memory fake; everything else in the
 * package (Keypair, Transaction, ...) is the real thing. Import after ./stubs, before the route.
 */
import { stubPackage } from "./stubs";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const real = require("@solana/web3.js") as typeof import("@solana/web3.js");

export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const BLOCKHASH = real.Keypair.generate().publicKey.toBase58();
const tick = () => new Promise<void>((r) => setImmediate(r));

export const rpc = {
  urls: [] as string[],
  genesis: DEVNET_GENESIS,
  genesisCalls: 0,
  failGenesis: false,
  balance: 10 * real.LAMPORTS_PER_SOL,
  failBalance: false,
  failBlockhash: false,
  /** "rejected": the RPC refused it (preflight). "timeout": the request failed after it may have gone out. */
  failSend: null as null | "rejected" | "timeout",
  /** "ok", "err" (landed but failed on chain) or "timeout" (confirmation threw). */
  confirm: "ok" as "ok" | "err" | "timeout",
  sent: [] as import("@solana/web3.js").Transaction[],
  /** Context slots returned by successive getProgramAccounts calls; the last one repeats. */
  programSlots: [1] as number[],
  programAccountCalls: 0,
  reset() {
    Object.assign(this, {
      urls: [], genesis: DEVNET_GENESIS, genesisCalls: 0, failGenesis: false, balance: 10 * real.LAMPORTS_PER_SOL,
      failBalance: false, failBlockhash: false, failSend: null, confirm: "ok", sent: [],
      programSlots: [1], programAccountCalls: 0,
    });
  },
};

class FakeConnection {
  constructor(url: string) {
    rpc.urls.push(url);
  }
  async getGenesisHash() {
    await tick();
    rpc.genesisCalls++;
    if (rpc.failGenesis) throw new Error("fetch failed");
    return rpc.genesis;
  }
  async getBalance() {
    await tick();
    if (rpc.failBalance) throw new Error("RPC 500");
    return rpc.balance;
  }
  async getLatestBlockhash() {
    await tick();
    if (rpc.failBlockhash) throw new Error("blockhash unavailable");
    return { blockhash: BLOCKHASH, lastValidBlockHeight: 1_000 };
  }
  async sendRawTransaction(raw: Buffer) {
    await tick();
    if (rpc.failSend === "rejected") {
      throw new real.SendTransactionError({
        action: "simulate",
        signature: "",
        transactionMessage: "Transaction simulation failed: Blockhash not found",
        logs: [],
      });
    }
    if (rpc.failSend === "timeout") {
      rpc.sent.push(real.Transaction.from(raw)); // it reached the network; only the response was lost
      throw new Error("fetch failed: request timed out");
    }
    rpc.sent.push(real.Transaction.from(raw));
    return `sig${rpc.sent.length}`;
  }
  async getProgramAccounts() {
    await tick();
    const slot = rpc.programSlots[Math.min(rpc.programAccountCalls++, rpc.programSlots.length - 1)];
    return { context: { slot }, value: [] };
  }
  async confirmTransaction() {
    await tick();
    if (rpc.confirm === "timeout") throw new Error("TransactionExpiredBlockheightExceededError");
    return { context: { slot: 1 }, value: { err: rpc.confirm === "err" ? { InstructionError: [0, "Custom"] } : null } };
  }
}

stubPackage("@solana/web3.js", { ...real, Connection: FakeConnection });
