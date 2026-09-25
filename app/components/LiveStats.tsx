"use client";

import { useEffect, useState } from "react";

const AGENT = "CAagent2";
const POSITION = "CApos_v2";
// Byte offsets from programs/proof_of_agent/src/state.rs (and lib/idl.json); fixed-size fields only.
const AGENT_STATUS_OFFSET = 8 + 32 + 32 + 8; // discriminator + operator + executor + agent_id
const AGENT_DRAFT = 0; // AgentStatus::Draft; Active = 1, Paused = 2
const POSITION_STATUS_OFFSET = 8 + 32 + 32 + 8 + 8 + 8 + 2 + 2; // discriminator + trader + agent + nonce + principal + locked + fee + drawdown
const POSITION_BREACH_OFFSET = POSITION_STATUS_OFFSET + 1;
const POSITION_SETTLED = 2; // PositionStatus::Settled
const BREACH_NONE = 0;

/** Live counts from the devnet program, read without loading the Solana client libraries. */
export function LiveStats() {
  const [s, setS] = useState<{ agents: number; positions: number; settled: number } | null>(null);
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { accounts: { data: string }[] }) => {
        let agents = 0, positions = 0, settled = 0;
        for (const a of d.accounts) {
          const raw = atob(a.data);
          const disc = raw.slice(0, 8);
          if (disc === AGENT) {
            // Published agents only (live or paused); drafts aren't visible to traders.
            if (raw.length > AGENT_STATUS_OFFSET && raw.charCodeAt(AGENT_STATUS_OFFSET) !== AGENT_DRAFT) agents++;
          } else if (disc === POSITION) {
            positions++;
            if (raw.charCodeAt(POSITION_STATUS_OFFSET) === POSITION_SETTLED && raw.charCodeAt(POSITION_BREACH_OFFSET) === BREACH_NONE) settled++;
          }
        }
        setS({ agents, positions, settled });
      })
      .catch(() => setS(null));
  }, []);
  if (!s) return null;
  return (
    <div className="live-stats rise d2">
      <span className="dot" />
      <span><b>{s.agents}</b> agents live on devnet</span>
      <span className="sep" />
      <span><b>{s.positions}</b> positions opened</span>
      <span className="sep" />
      <span><b>{s.settled}</b> settled within terms</span>
    </div>
  );
}
