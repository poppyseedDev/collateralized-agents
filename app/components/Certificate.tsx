"use client";

import { useState } from "react";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";
import {
  AgentAccount,
  capacity,
  freeCollateral,
  pct,
  requiredCollateral,
  sol,
  toLamports,
} from "@/lib/program";

const DURATIONS = [
  { label: "1 hour", secs: 3_600 },
  { label: "1 day", secs: 86_400 },
  { label: "7 days", secs: 7 * 86_400 },
  { label: "30 days", secs: 30 * 86_400 },
];

/**
 * The "bond certificate": shows exactly what a trader gets when allocating
 * capital to an agent, and lets them open the position.
 */
export function Certificate({
  agent,
  connected,
  busy,
  onOpen,
}: {
  agent: AgentAccount | null;
  connected: boolean;
  busy: boolean;
  onOpen: (lamports: number, durationSecs: number) => void;
}) {
  const [amount, setAmount] = useState(1);
  const [duration, setDuration] = useState(DURATIONS[1].secs);

  if (!agent) {
    return (
      <div className="cert">
        <span className="stamp">Guarantee</span>
        <h3 className="cert-title">Select an agent</h3>
        <p className="tiny" style={{ margin: 0 }}>
          Pick an agent from the ledger to see the collateral it guarantees for your deposit.
        </p>
      </div>
    );
  }

  const lamports = toLamports(amount || 0);
  const guaranteed = requiredCollateral(lamports, agent.collateralRatioBps);
  const cap = capacity(agent);
  const overCap = lamports > cap;
  const maxLoss = Math.floor((lamports * agent.maxDrawdownBps) / 10_000);

  return (
    <div className="cert rise">
      <span className="stamp">Guarantee</span>
      <h3 className="cert-title">{agent.name}</h3>

      <div className="cert-row">
        <span className="k">You allocate</span>
        <span className="cert-input">
          <input
            type="number"
            min={0.01}
            step={0.1}
            value={amount}
            onChange={(e) => setAmount(parseFloat(e.target.value))}
          />
          <span className="tiny">SOL</span>
        </span>
      </div>
      <div className="cert-row">
        <span className="k">Agent locks for you</span>
        <span className="v bond">{sol(guaranteed, 3)} SOL</span>
      </div>
      <div className="cert-row">
        <span className="k">Collateral ratio</span>
        <span className="v">{pct(agent.collateralRatioBps)}</span>
      </div>
      <div className="cert-row">
        <span className="k">Performance fee</span>
        <span className="v seal">{pct(agent.feeBps)} of profit</span>
      </div>
      <div className="cert-row">
        <span className="k">Loss tolerated before slash</span>
        <span className="v">{pct(agent.maxDrawdownBps)} · {sol(maxLoss, 3)} SOL</span>
      </div>
      <div className="cert-row">
        <span className="k">Settlement deadline</span>
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          {DURATIONS.map((d) => (
            <option key={d.secs} value={d.secs}>
              {d.label}
            </option>
          ))}
        </select>
      </div>
      <div className="cert-row">
        <span className="k">Agent free capacity</span>
        <span className={"v " + (overCap ? "seal" : "")}>
          {sol(cap)} SOL
        </span>
      </div>

      <p className="tiny" style={{ margin: "14px 0 12px" }}>
        If the agent loses more than {pct(agent.maxDrawdownBps)} or fails to return funds by the
        deadline, up to <b>{sol(guaranteed, 3)} SOL</b> of its locked collateral is paid to you
        on-chain. Free collateral now: {sol(freeCollateral(agent))} SOL.
      </p>

      <button
        className="btn seal"
        style={{ width: "100%" }}
        disabled={!connected || busy || overCap || !agent.accepting || !(lamports > 0)}
        onClick={() => onOpen(lamports, duration)}
      >
        {!connected
          ? "Connect wallet to allocate"
          : !agent.accepting
            ? "Agent paused"
            : overCap
              ? "Exceeds agent capacity"
              : `Allocate ${amount} SOL`}
      </button>
      <p className="tiny" style={{ margin: "8px 0 0", textAlign: "center" }}>
        + {(0.00089).toFixed(5)} SOL vault rent, refunded at close · 1 SOL = {LAMPORTS_PER_SOL.toLocaleString()} lamports
      </p>
    </div>
  );
}
