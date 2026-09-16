"use client";

import { AnchorProvider, BN, Idl, Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "./idl.json";

export const PROGRAM_ID = new PublicKey(idl.address);
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER ?? "devnet";

export const BPS = 10_000;
export const MIN_RATIO_BPS = 1_000;
export const MAX_RATIO_BPS = 10_000;
export const MAX_DRAWDOWN_BPS = 5_000;
export const FEE_DIVISOR = 2;

const enc = (s: string) => Buffer.from(s);

export function agentPda(authority: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [enc("agent"), authority.toBuffer()],
    PROGRAM_ID,
  )[0];
}
export function agentVaultPda(agent: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [enc("agent_vault"), agent.toBuffer()],
    PROGRAM_ID,
  )[0];
}
export function positionPda(agent: PublicKey, trader: PublicKey, nonce: BN) {
  return PublicKey.findProgramAddressSync(
    [
      enc("position"),
      agent.toBuffer(),
      trader.toBuffer(),
      nonce.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID,
  )[0];
}
export function positionVaultPda(position: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [enc("position_vault"), position.toBuffer()],
    PROGRAM_ID,
  )[0];
}

/** Read-only program (no wallet) for listing accounts. */
export function readonlyProgram(connection: Connection) {
  const provider = new AnchorProvider(
    connection,
    // Dummy wallet: never signs.
    {
      publicKey: PublicKey.default,
      signTransaction: async (tx) => tx,
      signAllTransactions: async (txs) => txs,
    },
    { commitment: "confirmed" },
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as Idl, provider) as any;
}

export function walletProgram(connection: Connection, wallet: AnchorWallet) {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Program(idl as Idl, provider) as any;
}

// ---------- decoded shapes ----------

export type AgentAccount = {
  publicKey: PublicKey;
  authority: PublicKey;
  name: string;
  strategy: string;
  collateralRatioBps: number;
  feeBps: number;
  maxDrawdownBps: number;
  accepting: boolean;
  totalCollateral: BN;
  lockedCollateral: BN;
  capitalManaged: BN;
  openPositions: number;
  settledPositions: number;
  defaultedPositions: number;
  slashedTotal: BN;
  feesEarned: BN;
  createdAt: BN;
};

export type PositionStatus =
  | "open"
  | "trading"
  | "settled"
  | "defaulted"
  | "cancelled";

export type PositionAccount = {
  publicKey: PublicKey;
  trader: PublicKey;
  agent: PublicKey;
  nonce: BN;
  principal: BN;
  lockedCollateral: BN;
  feeBps: number;
  maxDrawdownBps: number;
  status: PositionStatus;
  openedAt: BN;
  deadline: BN;
  drawnAt: BN;
  closedAt: BN;
  returned: BN;
  slashed: BN;
  feePaid: BN;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodeAgent(raw: { publicKey: PublicKey; account: any }): AgentAccount {
  return { publicKey: raw.publicKey, ...raw.account };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function decodePosition(raw: { publicKey: PublicKey; account: any }): PositionAccount {
  const statusKey = Object.keys(raw.account.status)[0] as PositionStatus;
  return { publicKey: raw.publicKey, ...raw.account, status: statusKey };
}

// ---------- math mirrors of the on-chain formulas ----------

export function feeForRatio(ratioBps: number) {
  return Math.floor(ratioBps / FEE_DIVISOR);
}
export function requiredCollateral(principalLamports: number, ratioBps: number) {
  return Math.ceil((principalLamports * ratioBps) / BPS);
}
export function freeCollateral(a: AgentAccount) {
  return a.totalCollateral.sub(a.lockedCollateral);
}
/** Max principal an agent can still back with its free collateral. */
export function capacity(a: AgentAccount) {
  const free = freeCollateral(a).toNumber();
  return Math.floor((free * BPS) / a.collateralRatioBps);
}

// ---------- formatting ----------

export const sol = (lamports: BN | number, digits = 2) =>
  (Number(lamports.toString()) / LAMPORTS_PER_SOL).toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
export const pct = (bps: number, digits = 0) =>
  (bps / 100).toLocaleString(undefined, { maximumFractionDigits: digits }) + "%";
export const short = (k: PublicKey | string) => {
  const s = k.toString();
  return s.slice(0, 4) + "…" + s.slice(-4);
};
export const toLamports = (solAmount: number) =>
  Math.round(solAmount * LAMPORTS_PER_SOL);
export const explorer = (sig: string) =>
  CLUSTER === "localnet"
    ? `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`
    : `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
