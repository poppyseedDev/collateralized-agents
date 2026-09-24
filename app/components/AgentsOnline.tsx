"use client";

import { useEffect, useState } from "react";
import { CLUSTER } from "@/lib/program";

type Beat = { online: boolean; ageSec: number | null };

/** Shows whether the agent runners have checked in recently. */
export function AgentsOnline() {
  const [beat, setBeat] = useState<Beat | null>(null);
  useEffect(() => {
    if (CLUSTER !== "devnet") return;
    const load = () => fetch("/api/heartbeat").then((r) => r.json()).then(setBeat).catch(() => setBeat(null));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  if (CLUSTER !== "devnet" || !beat) return null;
  if (beat.online) {
    return (
      <span className="cluster-pill online" title="Our agents' runner checked in within the last 5 minutes">
        <span className="dot" />
        <span className="cluster-name">Agents online</span>
      </span>
    );
  }
  const mins = beat.ageSec === null ? null : Math.round(beat.ageSec / 60);
  return (
    <span className="cluster-pill offline" title="Our agents are not settling positions right now. Anything you allocate can be cancelled before it is drawn.">
      <span className="dot" />
      <span className="cluster-name">Agents offline{mins !== null && mins < 6000 ? ` · ${mins} min` : ""}</span>
    </span>
  );
}
