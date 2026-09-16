"use client";

import { useState } from "react";
import {
  AgentAccount,
  capacity,
  freeCollateral,
  pct,
  requiredCollateral,
  sol,
  toLamports,
} from "@/lib/program";
import { Avatar } from "./Avatar";
import { IconArrowDown, IconShield } from "./Icons";

const DURATIONS = [
  { label: "1H", secs: 3_600 },
  { label: "1D", secs: 86_400 },
  { label: "7D", secs: 7 * 86_400 },
  { label: "30D", secs: 30 * 86_400 },
];

/** Swap-style widget: what a trader gets when allocating capital to an agent. */
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
  const [amount, setAmount] = useState("1");
  const [duration, setDuration] = useState(DURATIONS[1].secs);

  const head = (
    <div className="cert-head">
      <div className="cert-tabs">
        <span className="cert-tab active">Allocate</span>
      </div>
      <span className="stamp">
        <IconShield width={12} height={12} /> Bonded
      </span>
    </div>
  );

  if (!agent) {
    return (
      <div className="cert">
        {head}
        <div className="cert-empty">
          <div className="big-icon">
            <IconShield />
          </div>
          <div style={{ fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>Select an agent</div>
          <div className="tiny">Pick an agent from the list to see how much collateral it guarantees for your deposit.</div>
        </div>
      </div>
    );
  }

  const value = parseFloat(amount);
  const lamports = toLamports(Number.isFinite(value) ? value : 0);
  const guaranteed = requiredCollateral(lamports, agent.collateralRatioBps);
  const cap = capacity(agent);
  const overCap = lamports > cap;
  const tolerance = Math.floor((lamports * agent.maxDrawdownBps) / 10_000);

  const label = !connected
    ? "Connect wallet"
    : !agent.accepting
      ? "Agent paused"
      : !(lamports > 0)
        ? "Enter an amount"
        : overCap
          ? "Exceeds agent capacity"
          : busy
            ? "Confirming…"
            : "Allocate";

  return (
    <div className="cert rise">
      {head}

      <div className="box">
        <div className="box-label">
          <span>You allocate</span>
          <span>to {agent.name}</span>
        </div>
        <div className="box-row">
          <input
            className="amount"
            type="number"
            inputMode="decimal"
            min={0}
            step={0.1}
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <span className="token">
            <span className="token-icon" />
            SOL
          </span>
        </div>
      </div>

      <div className="flip">
        <IconArrowDown width={16} height={16} />
      </div>

      <div className="box">
        <div className="box-label">
          <span>Guaranteed to you</span>
          <span>{pct(agent.collateralRatioBps)} of deposit</span>
        </div>
        <div className="box-row">
          <span className="amount-static">{sol(guaranteed, 3)}</span>
          <span className="token">
            <Avatar seed={agent.publicKey.toBase58()} name={agent.name} size={26} />
            Bond
          </span>
        </div>
      </div>

      <div className="details">
        <div className="cert-row">
          <span className="k">Settlement deadline</span>
          <div className="segmented">
            {DURATIONS.map((d) => (
              <button key={d.secs} className={duration === d.secs ? "on" : ""} onClick={() => setDuration(d.secs)}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="cert-row">
          <span className="k">Performance fee</span>
          <span className="v seal">{pct(agent.feeBps)} of profit</span>
        </div>
        <div className="cert-row">
          <span className="k">Loss tolerance</span>
          <span className="v">
            {pct(agent.maxDrawdownBps)} · {sol(tolerance, 3)} SOL
          </span>
        </div>
        <div className="cert-row">
          <span className="k">Agent capacity</span>
          <span className={"v " + (overCap ? "neg" : "")}>{sol(cap)} SOL</span>
        </div>
      </div>

      <p className="note">
        If the agent returns less than {pct(10_000 - agent.maxDrawdownBps)} of your SOL, or misses the deadline, up to{" "}
        <b>{sol(guaranteed, 3)} SOL</b> of its bond is paid to you. Free bond now: {sol(freeCollateral(agent))} SOL.
      </p>

      <button
        className="btn lg"
        disabled={!connected || busy || overCap || !agent.accepting || !(lamports > 0)}
        onClick={() => onOpen(lamports, duration)}
      >
        {label}
      </button>
    </div>
  );
}
