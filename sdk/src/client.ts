/**
 * Minimal client for the Proof of Agent program. Uses only the public IDL and
 * program id, so it works for any operator without access to our app code.
 */
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import anchor, { AnchorProvider, Program, Wallet, type BN as AnchorBN, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

// Node before 26 cannot see BN as a named export of anchor's CommonJS build.
export const BN = anchor.BN;
export type BN = AnchorBN;

export const IDL = JSON.parse(readFileSync(fileURLToPath(new URL("../idl/proof_of_agent.json", import.meta.url)), "utf8")) as Idl & { address: string };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const SYSTEM = SystemProgram.programId;
export const LAMPORTS = 1_000_000_000;

const seed = (s: string) => Buffer.from(s);
export const agentPda = (operator: PublicKey, agentId: number | BN) =>
  PublicKey.findProgramAddressSync([seed("agent"), operator.toBuffer(), new BN(agentId).toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];
export const agentVaultPda = (agent: PublicKey) => PublicKey.findProgramAddressSync([seed("agent_vault"), agent.toBuffer()], PROGRAM_ID)[0];
export const positionVaultPda = (position: PublicKey) => PublicKey.findProgramAddressSync([seed("position_vault"), position.toBuffer()], PROGRAM_ID)[0];
export const positionPda = (agent: PublicKey, trader: PublicKey, nonce: BN) =>
  PublicKey.findProgramAddressSync([seed("position"), agent.toBuffer(), trader.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)], PROGRAM_ID)[0];

export type AgentStatus = "draft" | "active" | "paused";
export type PositionStatus = "open" | "trading" | "settled" | "defaulted" | "cancelled";
export type Breach = "none" | "drawdown" | "missedDeadline";

export type Agent = {
  publicKey: PublicKey;
  operator: PublicKey;
  executor: PublicKey;
  agentId: BN;
  status: AgentStatus;
  name: string;
  description: string;
  terms: {
    collateralRatioBps: number;
    feeBps: number;
    maxDrawdownBps: number;
    minDurationSecs: BN;
    maxDurationSecs: BN;
    allowedAssets: PublicKey[];
    rules: string;
  };
  totalCollateral: BN;
  lockedCollateral: BN;
  capitalManaged: BN;
  openPositions: number;
  settledPositions: number;
  defaultedPositions: number;
  breachCount: number;
  slashedTotal: BN;
  feesEarned: BN;
  publishedAt: BN;
};

export type Position = {
  publicKey: PublicKey;
  trader: PublicKey;
  agent: PublicKey;
  nonce: BN;
  principal: BN;
  lockedCollateral: BN;
  status: PositionStatus;
  breach: Breach;
  openedAt: BN;
  deadline: BN;
  drawnAt: BN;
  closedAt: BN;
  returned: BN;
  slashed: BN;
  feePaid: BN;
};

const enumKey = <T extends string>(v: object) => Object.keys(v)[0] as T;

/** Lamports or seconds: a safe-integer number, a bigint, or a BN. */
export type Amount = number | bigint | BN;

export function toBN(x: Amount, what = "amount"): BN {
  if (BN.isBN(x)) {
    // borsh encodes a negative BN as its absolute value, so -5 would silently become 5
    if ((x as BN).isNeg()) throw new Error(`${what} must not be negative (got ${x.toString()})`);
    return x as BN;
  }
  if (typeof x === "number" && !Number.isSafeInteger(x)) throw new Error(`${what} must be a whole number below 2^53 (got ${x}); pass a bigint or BN`);
  if (x < 0) throw new Error(`${what} must not be negative (got ${x})`);
  return new BN(x.toString());
}

/** Loads a JSON keypair file, warning if other users can read it. */
export function loadKeypair(path: string) {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) console.warn(`warning: key file ${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`);
  } catch {
    // readFileSync below reports a missing file
  }
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
}

export class PoaClient {
  readonly connection: Connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly program: any;
  constructor(rpcUrl: string, readonly signer: Keypair) {
    this.connection = new Connection(rpcUrl, "confirmed");
    const provider = new AnchorProvider(this.connection, new Wallet(signer), { commitment: "confirmed" });
    this.program = new Program(IDL, provider);
  }

  async agent(key: PublicKey): Promise<Agent | null> {
    const a = await this.program.account.agent.fetchNullable(key);
    return a ? { publicKey: key, ...a, status: enumKey<AgentStatus>(a.status) } : null;
  }

  /** Positions on one agent, via a filtered program-account scan. */
  async positions(agent: PublicKey): Promise<Position[]> {
    const raw = await this.program.account.position.all([{ memcmp: { offset: 40, bytes: agent.toBase58() } }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return raw.map((r: any) => ({ publicKey: r.publicKey, ...r.account, status: enumKey<PositionStatus>(r.account.status), breach: enumKey<Breach>(r.account.breach) }));
  }

  async position(key: PublicKey): Promise<Position> {
    const p = await this.program.account.position.fetch(key);
    return { publicKey: key, ...p, status: enumKey<PositionStatus>(p.status), breach: enumKey<Breach>(p.breach) };
  }

  // ---- operator ----
  createAgent(agentId: number, name: string, description: string, terms: Agent["terms"]) {
    const agent = agentPda(this.signer.publicKey, agentId);
    return this.program.methods.createAgent(new BN(agentId), name, description, terms)
      .accounts({ operator: this.signer.publicKey, agent, agentVault: agentVaultPda(agent), systemProgram: SYSTEM }).rpc() as Promise<string>;
  }
  depositCollateral(agent: PublicKey, lamports: Amount) {
    return this.program.methods.depositCollateral(toBN(lamports, "lamports"))
      .accounts({ operator: this.signer.publicKey, agent, agentVault: agentVaultPda(agent), systemProgram: SYSTEM }).rpc() as Promise<string>;
  }
  withdrawCollateral(agent: PublicKey, lamports: Amount) {
    return this.program.methods.withdrawCollateral(toBN(lamports, "lamports"))
      .accounts({ operator: this.signer.publicKey, agent, agentVault: agentVaultPda(agent), systemProgram: SYSTEM }).rpc() as Promise<string>;
  }
  setExecutor(agent: PublicKey, executor: PublicKey) {
    return this.program.methods.setExecutor(executor).accounts({ operator: this.signer.publicKey, agent }).rpc() as Promise<string>;
  }
  publishAgent(agent: PublicKey) {
    return this.program.methods.publishAgent().accounts({ operator: this.signer.publicKey, agent }).rpc() as Promise<string>;
  }
  setAccepting(agent: PublicKey, accepting: boolean) {
    return this.program.methods.setAccepting(accepting).accounts({ operator: this.signer.publicKey, agent }).rpc() as Promise<string>;
  }

  // ---- trading key ----
  drawFunds(agent: PublicKey, position: PublicKey) {
    return this.program.methods.drawFunds()
      .accounts({ executor: this.signer.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: SYSTEM }).rpc() as Promise<string>;
  }
  settlePosition(a: Agent, p: Position, returnedLamports: Amount) {
    return this.program.methods.settlePosition(toBN(returnedLamports, "returnedLamports"))
      .accounts({
        executor: this.signer.publicKey, operator: a.operator, agent: a.publicKey, agentVault: agentVaultPda(a.publicKey),
        position: p.publicKey, positionVault: positionVaultPda(p.publicKey), trader: p.trader, systemProgram: SYSTEM,
      }).rpc() as Promise<string>;
  }

  // ---- trader (for testing) ----
  /** Opens a position under a random u64 nonce, so two opens in the same millisecond cannot collide. */
  openPosition(agent: PublicKey, lamports: Amount, durationSecs: Amount) {
    const nonce = new BN(randomBytes(8), "le");
    const position = positionPda(agent, this.signer.publicKey, nonce);
    return this.program.methods.openPosition(nonce, toBN(lamports, "lamports"), toBN(durationSecs, "durationSecs"))
      .accounts({ trader: this.signer.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: SYSTEM })
      .rpc().then((sig: string) => ({ position, nonce, sig }));
  }
  /** Withdraws a position's principal before the agent has drawn it. No fee, no slash. */
  cancelPosition(agent: PublicKey, position: PublicKey) {
    return this.program.methods.cancelPosition()
      .accounts({ trader: this.signer.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: SYSTEM })
      .rpc() as Promise<string>;
  }
  claimDefault(a: Agent, p: Position) {
    return this.program.methods.claimDefault()
      .accounts({ trader: this.signer.publicKey, agent: a.publicKey, agentVault: agentVaultPda(a.publicKey), position: p.publicKey, positionVault: positionVaultPda(p.publicKey), systemProgram: SYSTEM })
      .rpc() as Promise<string>;
  }
}
