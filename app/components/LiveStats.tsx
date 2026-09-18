"use client";

import { useEffect, useState } from "react";

const AGENT = "CAagent2";
const POSITION = "CApos_v2";
const STATUS_OFFSET = 8 + 32 + 32 + 8 + 8 + 8 + 2 + 2; // discriminator + trader + agent + nonce + principal + locked + fee + drawdown

/** Live counts from the devnet program, read without loading the Solana client libraries. */
export function LiveStats() {
  const [s, setS] = useState<{ agents: number; positions: number; settled: number } | null>(null);
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((d: { accounts: { data: string }[] }) => {
        let agents = 0, positions = 0, settled = 0;
        for (const a of d.accounts) {
          const raw = atob(a.data);
          const disc = raw.slice(0, 8);
          if (disc === AGENT) agents++;
          else if (disc === POSITION) {
            positions++;
            if (raw.charCodeAt(STATUS_OFFSET) === 2) settled++;
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
