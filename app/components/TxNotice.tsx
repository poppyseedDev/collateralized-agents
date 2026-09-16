"use client";

import { explorer } from "@/lib/program";
import type { TxState } from "@/lib/useProtocol";

export function TxNotice({ tx }: { tx: TxState }) {
  if (tx.kind === "idle") return null;
  if (tx.kind === "pending") return <div className="notice">⏳ {tx.label}… confirm in your wallet.</div>;
  if (tx.kind === "err") return <div className="notice">✕ {tx.message}</div>;
  return (
    <div className="notice ok">
      ✓ {tx.label} confirmed ·{" "}
      <a href={explorer(tx.sig)} target="_blank" rel="noreferrer" style={{ textDecoration: "underline" }}>
        view on explorer
      </a>
    </div>
  );
}
