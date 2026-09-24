"use client";

import { CLUSTER } from "@/lib/program";

/** Shown on every network except mainnet, so devnet results are not read as real returns. */
export function DevnetNotice() {
  if (CLUSTER === "mainnet-beta") return null;
  return (
    <div className="devnet-notice" role="note">
      <span className="dot" />
      <span>
        <b>{CLUSTER === "localnet" ? "Local test network" : "Devnet"}.</b> Test SOL and test-pool prices only.
        Returns shown here are not real results.{" "}
        {CLUSTER === "devnet" && <a href="/start" className="box-link" style={{ color: "var(--amber)" }}>New here? Start testing →</a>}
      </span>
    </div>
  );
}
