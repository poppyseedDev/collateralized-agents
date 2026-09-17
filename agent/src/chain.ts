import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AnchorProvider, BN, Program, Wallet, type Idl } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { RPC_URL } from "./config.js";

const idlPath = fileURLToPath(new URL("../../app/lib/idl.json", import.meta.url));
export const IDL = JSON.parse(readFileSync(idlPath, "utf8")) as Idl & { address: string };
export const PROGRAM_ID = new PublicKey(IDL.address);
export const connection = new Connection(RPC_URL, "confirmed");

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

export function programFor(kp: Keypair): Prog {
  return new Program(IDL, new AnchorProvider(connection, new Wallet(kp), { commitment: "confirmed" }));
}

export function loadKeypair(path: string) {
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

/** All positions for the given agents in one scan, grouped by agent. */
export async function positionsByAgent(program: Prog, agents: PublicKey[]): Promise<Map<string, Position[]>> {
  const wanted = new Set(agents.map((a) => a.toBase58()));
  const all = await allPositions(program);
  const out = new Map<string, Position[]>([...wanted].map((k) => [k, []]));
  for (const p of all) {
    const k = p.agent.toBase58();
    if (wanted.has(k)) out.get(k)!.push(p);
  }
  return out;
}

async function allPositions(program: Prog): Promise<Position[]> {
  const raw = await program.account.position.all();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return raw.map((r: any) => ({
    publicKey: r.publicKey,
    ...r.account,
    status: Object.keys(r.account.status)[0] as PositionStatus,
  }));
}

export async function positionsForAgent(program: Prog, agent: PublicKey): Promise<Position[]> {
  return (await positionsByAgent(program, [agent])).get(agent.toBase58()) ?? [];
}

export const sys = SystemProgram.programId;
