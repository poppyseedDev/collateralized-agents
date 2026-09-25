"use client";

import { useEffect, useState } from "react";
import { countLiveStats } from "@/lib/liveStats";

/** Live counts from the devnet program, read without loading the Solana client libraries. */
export function LiveStats() {
  const [s, setS] = useState<{ agents: number; positions: number; settled: number } | null>(null);
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { accounts: { data: string }[] }) => setS(countLiveStats(d.accounts)))
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
