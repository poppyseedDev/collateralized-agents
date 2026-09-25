import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import anchor, { AnchorProvider, Program, Wallet, type BN as AnchorBN, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { RPC_URL, RPC_URL_FALLBACK } from "./config.js";

// Node before 26 cannot see BN as a named export of anchor's CommonJS build.
export const BN = anchor.BN;
export type BN = AnchorBN;

const idlPath = fileURLToPath(new URL("../../app/lib/idl.json", import.meta.url));
export const IDL = JSON.parse(readFileSync(idlPath, "utf8")) as Idl & { address: string };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const connection = new Connection(RPC_URL, "confirmed");
export const fallbackConnection = RPC_URL_FALLBACK ? new Connection(RPC_URL_FALLBACK, "confirmed") : null;

const seed = (s: string) => Buffer.from(s);
export const agentPda = (operator: PublicKey, agentId: number) =>
  PublicKey.findProgramAddressSync(
    [seed("agent"), operator.toBuffer(), new BN(agentId).toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
export const agentVaultPda = (agent: PublicKey) =>
  PublicKey.findProgramAddressSync([seed("agent_vault"), agent.toBuffer()], PROGRAM_ID)[0];
export const positionPda = (agent: PublicKey, trader: PublicKey, nonce: BN) =>
  PublicKey.findProgramAddressSync(
    [seed("position"), agent.toBuffer(), trader.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID,
  )[0];
export const positionVaultPda = (position: PublicKey) =>
  PublicKey.findProgramAddressSync([seed("position_vault"), position.toBuffer()], PROGRAM_ID)[0];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Prog = any;

export function programFor(kp: Keypair, conn: Connection = connection): Prog {
  return new Program(IDL, new AnchorProvider(conn, new Wallet(kp), { commitment: "confirmed" }));
}

/** Read-only programs, one per configured RPC, primary first. */
const readers: { url: string; conn: Connection; program: Prog }[] = [
  { url: RPC_URL, conn: connection },
  ...(fallbackConnection ? [{ url: RPC_URL_FALLBACK!, conn: fallbackConnection }] : []),
].map((r) => ({ ...r, program: programFor(Keypair.generate(), r.conn) }));

/** Errors that say nothing about the request itself, so another RPC may succeed. */
export const isNetworkError = (e: unknown) =>
  /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|timed? ?out|\b429\b|Too Many Requests|\b50[234]\b/i.test(
    String((e as Error)?.message ?? e) + String((e as { cause?: { code?: string } })?.cause?.code ?? ""),
  );

/** Runs a read on the primary RPC, then on RPC_URL_FALLBACK if the primary throws. */
export async function withFallback<T>(what: string, fn: (conn: Connection, program: Prog) => Promise<T>): Promise<T> {
  let first: unknown;
  for (const [i, r] of readers.entries()) {
    try {
      const out = await fn(r.conn, r.program);
      if (i > 0) console.log(`${what}: primary RPC failed (${(first as Error)?.message}); used fallback ${r.url}`);
      return out;
    } catch (e) {
      first ??= e;
      if (i === readers.length - 1) throw e;
    }
  }
  throw first;
}

export function loadKeypair(path: string) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) {
      console.warn(`warning: key file ${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
    }
  } catch {
    // readFileSync below reports a missing file
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export type PositionStatus = "open" | "trading" | "settled" | "defaulted" | "cancelled";
export type Position = {
  publicKey: PublicKey;
  trader: PublicKey;
  agent: PublicKey;
  principal: BN;
  lockedCollateral: BN;
  deadline: BN;
  drawnAt: BN;
  status: PositionStatus;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const toPosition = (publicKey: PublicKey, account: any): Position => ({
  publicKey,
  ...account,
  status: Object.keys(account.status)[0] as PositionStatus,
});

/** Byte offset of `Position.agent`: 8-byte discriminator + 32-byte trader. */
const POSITION_AGENT_OFFSET = 40;

/** Positions on one agent, via a program scan filtered on the agent field. */
export async function positionsForAgent(agent: PublicKey): Promise<Position[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw: any[] = await withFallback(`position scan ${agent.toBase58().slice(0, 8)}`, (_c, program) =>
    program.account.position.all([{ memcmp: { offset: POSITION_AGENT_OFFSET, bytes: agent.toBase58() } }]),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return raw.map((r: any) => toPosition(r.publicKey, r.account));
}

/**
 * Fetches known positions by address (getMultipleAccounts), for when the scan fails.
 * Accounts that no longer exist are left out.
 */
export async function positionsByKey(keys: string[]): Promise<Position[]> {
  if (!keys.length) return [];
  const pks = keys.map((k) => new PublicKey(k));
  const accs = await withFallback("tracked positions", (_c, program) => program.account.position.fetchMultiple(pks));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (accs as any[]).flatMap((a, i) => (a ? [toPosition(pks[i], a)] : []));
}

/** Cluster time: block time of the latest confirmed slot. */
export async function chainTime(): Promise<number> {
  return withFallback("chain time", async (c) => {
    const t = await c.getBlockTime(await c.getSlot("confirmed"));
    if (t === null) throw new Error("no block time for latest slot");
    return t;
  });
}

/** Lamport balance, read through the fallback RPC if the primary fails. */
export async function balanceOf(key: PublicKey): Promise<bigint> {
  return BigInt(await withFallback("balance", (c) => c.getBalance(key)));
}

export const sys = SystemProgram.programId;
