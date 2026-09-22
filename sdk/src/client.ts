/**
 * Minimal client for the Proof of Agent program. Uses only the public IDL and
 * program id, so it works for any operator without access to our app code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

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

export function loadKeypair(path: string) {
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
  depositCollateral(agent: PublicKey, lamports: number) {
    return this.program.methods.depositCollateral(new BN(lamports))
      .accounts({ operator: this.signer.publicKey, agent, agentVault: agentVaultPda(agent), systemProgram: SYSTEM }).rpc() as Promise<string>;
  }
  withdrawCollateral(agent: PublicKey, lamports: number) {
    return this.program.methods.withdrawCollateral(new BN(lamports))
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
  settlePosition(a: Agent, p: Position, returnedLamports: number) {
    return this.program.methods.settlePosition(new BN(returnedLamports))
      .accounts({
        executor: this.signer.publicKey, operator: a.operator, agent: a.publicKey, agentVault: agentVaultPda(a.publicKey),
        position: p.publicKey, positionVault: positionVaultPda(p.publicKey), trader: p.trader, systemProgram: SYSTEM,
      }).rpc() as Promise<string>;
  }

  // ---- trader (for testing) ----
  openPosition(agent: PublicKey, lamports: number, durationSecs: number) {
    const nonce = new BN(Date.now());
    const position = positionPda(agent, this.signer.publicKey, nonce);
    return this.program.methods.openPosition(nonce, new BN(lamports), new BN(durationSecs))
      .accounts({ trader: this.signer.publicKey, agent, position, positionVault: positionVaultPda(position), systemProgram: SYSTEM })
      .rpc().then((sig: string) => ({ position, sig }));
  }
  claimDefault(a: Agent, p: Position) {
    return this.program.methods.claimDefault()
      .accounts({ trader: this.signer.publicKey, agent: a.publicKey, agentVault: agentVaultPda(a.publicKey), position: p.publicKey, positionVault: positionVaultPda(p.publicKey), systemProgram: SYSTEM })
      .rpc() as Promise<string>;
  }
}
