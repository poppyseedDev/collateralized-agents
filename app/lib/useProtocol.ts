"use client";

import { useCallback, useEffect, useState } from "react";
import { useAnchorWallet, useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { fetchProgramAccounts } from "./accounts";
import {
  AgentAccount,
  PositionAccount,
  agentPda,
  agentVaultPda,
  positionPda,
  positionVaultPda,
  walletProgram,
} from "./program";

/** Realised results for traders on one agent, from its closed positions. */
export type AgentStats = {
  closed: number;
  principal: number;
  /** What traders got back minus what they put in, in lamports, after fees and slashing. */
  traderPnl: number;
};

export function useAgents() {
  const [agents, setAgents] = useState<AgentAccount[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      const snap = await fetchProgramAccounts(fresh === true);
      const list = [...snap.agents];
      list.sort((a, b) => b.totalCollateral.cmp(a.totalCollateral));
      const next: Record<string, AgentStats> = {};
      for (const p of snap.positions) {
        if (p.status !== "settled" && p.status !== "defaulted") continue;
        const k = p.agent.toBase58();
        const s = (next[k] ??= { closed: 0, principal: 0, traderPnl: 0 });
        const principal = p.principal.toNumber();
        const payout = p.returned.toNumber() - p.feePaid.toNumber() + p.slashed.toNumber();
        s.closed += 1;
        s.principal += principal;
        s.traderPnl += payout - principal;
      }
      setAgents(list);
      setStats(next);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  return { agents, stats, loading, error, refresh: () => refresh(true) };
}

/** Positions belonging to a trader or to an agent. */
export function usePositions(filter: { trader?: PublicKey; agent?: PublicKey } | null) {
  const [positions, setPositions] = useState<PositionAccount[]>([]);
  const [loading, setLoading] = useState(false);
  const key = filter?.trader?.toBase58() ?? filter?.agent?.toBase58() ?? null;
  const kind = filter?.trader ? "trader" : "agent";

  const load = useCallback(
    async (fresh: boolean) => {
      if (!key) {
        setPositions([]);
        return;
      }
      setLoading(true);
      try {
        const snap = await fetchProgramAccounts(fresh);
        const list = snap.positions.filter((p) => (kind === "trader" ? p.trader : p.agent).toBase58() === key);
        list.sort((a, b) => b.openedAt.cmp(a.openedAt));
        setPositions(list);
      } finally {
        setLoading(false);
      }
    },
    [key, kind],
  );

  useEffect(() => {
    load(false);
  }, [load]);
  return { positions, loading, refresh: () => load(true) };
}

export type TxState =
  | { kind: "idle" }
  | { kind: "pending"; label: string }
  | { kind: "ok"; sig: string; label: string }
  | { kind: "err"; message: string };

/** Every write instruction the UI needs, bound to the connected wallet. */
export function useActions() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const { publicKey } = useWallet();
  const [tx, setTx] = useState<TxState>({ kind: "idle" });

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setTx({ kind: "pending", label });
      try {
        const sig = await fn();
        setTx({ kind: "ok", sig, label });
        return sig;
      } catch (e) {
        const msg = parseAnchorError(e);
        setTx({ kind: "err", message: msg });
        throw e;
      }
    },
    [],
  );

  const need = () => {
    if (!wallet || !publicKey) throw new Error("Connect a wallet first");
    return { program: walletProgram(connection, wallet), me: publicKey };
  };

  return {
    tx,
    reset: () => setTx({ kind: "idle" }),
    connected: !!publicKey,

    // ---- trader ----
    openPosition: (agent: AgentAccount, lamports: number, durationSecs: number) =>
      run("Open position", async () => {
        const { program, me } = need();
        const nonce = new BN(Date.now());
        const position = positionPda(agent.publicKey, me, nonce);
        return program.methods
          .openPosition(nonce, new BN(lamports), new BN(durationSecs))
          .accounts({
            trader: me,
            agent: agent.publicKey,
            position,
            positionVault: positionVaultPda(position),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),
    cancelPosition: (p: PositionAccount) =>
      run("Cancel position", async () => {
        const { program, me } = need();
        return program.methods
          .cancelPosition()
          .accounts({
            trader: me,
            agent: p.agent,
            position: p.publicKey,
            positionVault: positionVaultPda(p.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),
    claimDefault: (p: PositionAccount) =>
      run("Claim collateral", async () => {
        const { program, me } = need();
        return program.methods
          .claimDefault()
          .accounts({
            trader: me,
            agent: p.agent,
            agentVault: agentVaultPda(p.agent),
            position: p.publicKey,
            positionVault: positionVaultPda(p.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),

    // ---- agent ----
    registerAgent: (name: string, strategy: string, ratioBps: number, drawdownBps: number) =>
      run("Register agent", async () => {
        const { program, me } = need();
        const agent = agentPda(me);
        return program.methods
          .registerAgent(name, strategy, ratioBps, drawdownBps)
          .accounts({
            authority: me,
            agent,
            agentVault: agentVaultPda(agent),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),
    depositCollateral: (lamports: number) =>
      run("Deposit collateral", async () => {
        const { program, me } = need();
        const agent = agentPda(me);
        return program.methods
          .depositCollateral(new BN(lamports))
          .accounts({ authority: me, agent, agentVault: agentVaultPda(agent), systemProgram: SystemProgram.programId })
          .rpc();
      }),
    withdrawCollateral: (lamports: number) =>
      run("Withdraw collateral", async () => {
        const { program, me } = need();
        const agent = agentPda(me);
        return program.methods
          .withdrawCollateral(new BN(lamports))
          .accounts({ authority: me, agent, agentVault: agentVaultPda(agent), systemProgram: SystemProgram.programId })
          .rpc();
      }),
    setAccepting: (accepting: boolean) =>
      run(accepting ? "Resume accepting" : "Pause agent", async () => {
        const { program, me } = need();
        return program.methods.setAccepting(accepting).accounts({ authority: me, agent: agentPda(me) }).rpc();
      }),
    drawFunds: (p: PositionAccount) =>
      run("Draw funds", async () => {
        const { program, me } = need();
        return program.methods
          .drawFunds()
          .accounts({
            authority: me,
            agent: p.agent,
            position: p.publicKey,
            positionVault: positionVaultPda(p.publicKey),
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),
    settlePosition: (p: PositionAccount, returnedLamports: number) =>
      run("Settle position", async () => {
        const { program, me } = need();
        return program.methods
          .settlePosition(new BN(returnedLamports))
          .accounts({
            authority: me,
            agent: p.agent,
            agentVault: agentVaultPda(p.agent),
            position: p.publicKey,
            positionVault: positionVaultPda(p.publicKey),
            trader: p.trader,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }),
  };
}

function parseAnchorError(e: unknown): string {
  const err = e as { error?: { errorMessage?: string }; message?: string; logs?: string[] };
  if (err?.error?.errorMessage) return err.error.errorMessage;
  const m = err?.message ?? String(e);
  if (m.includes("User rejected")) return "Transaction rejected in wallet.";
  return m.length > 240 ? m.slice(0, 240) + "…" : m;
}
