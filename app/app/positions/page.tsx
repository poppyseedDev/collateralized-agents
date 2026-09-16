"use client";

import { useWallet } from "@solana/wallet-adapter-react";
import { useAgents, useActions, usePositions } from "@/lib/useProtocol";
import { PositionAccount, pct, short, sol } from "@/lib/program";
import { TxNotice } from "@/components/TxNotice";

function fmtTime(ts: number) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function Positions() {
  const { publicKey } = useWallet();
  const { positions, loading, refresh } = usePositions(publicKey ? { trader: publicKey } : null);
  const { agents } = useAgents();
  const actions = useActions();
  const now = Math.floor(Date.now() / 1000);
  const agentName = (k: PositionAccount["agent"]) =>
    agents.find((a) => a.publicKey.equals(k))?.name ?? short(k);

  if (!publicKey) return <div className="empty">Connect your wallet to see your positions.</div>;

  return (
    <>
      <div className="sec-head">
        <h2>My positions</h2>
        <span className="meta">
          {loading ? "syncing…" : `${positions.length} total`} ·{" "}
          <button className="btn ghost sm" onClick={refresh}>refresh</button>
        </span>
      </div>
      <TxNotice tx={actions.tx} />
      {positions.length === 0 && !loading ? (
        <div className="empty">You have not allocated capital to any agent yet.</div>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th className="num">Principal</th>
              <th className="num">Guaranteed</th>
              <th className="num hide-sm">Deadline</th>
              <th className="num hide-sm">Outcome</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => {
              const deadline = p.deadline.toNumber();
              const expired = now >= deadline;
              const payout = p.returned.toNumber() - p.feePaid.toNumber() + p.slashed.toNumber();
              return (
                <tr key={p.publicKey.toBase58()} className="row">
                  <td>
                    <div className="agent-name">{agentName(p.agent)}</div>
                    <div className="tiny">opened {fmtTime(p.openedAt.toNumber())}</div>
                  </td>
                  <td>
                    <span className={"pill " + p.status}>{p.status}</span>
                  </td>
                  <td className="num">{sol(p.principal, 3)} SOL</td>
                  <td className="num" style={{ color: "var(--bond)" }}>
                    {sol(p.lockedCollateral, 3)} SOL
                    <div className="tiny">fee {pct(p.feeBps)} · dd {pct(p.maxDrawdownBps)}</div>
                  </td>
                  <td className="num hide-sm" style={{ color: expired && p.status === "trading" ? "var(--seal)" : undefined }}>
                    {fmtTime(deadline)}
                  </td>
                  <td className="num hide-sm">
                    {p.status === "settled" || p.status === "defaulted" ? (
                      <>
                        <div>{sol(payout, 3)} SOL to you</div>
                        <div className="tiny">
                          returned {sol(p.returned, 3)} · fee {sol(p.feePaid, 3)} ·{" "}
                          <span style={{ color: p.slashed.gtn(0) ? "var(--seal)" : undefined }}>
                            slashed {sol(p.slashed, 3)}
                          </span>
                        </div>
                      </>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="num">
                    {p.status === "open" && (
                      <button className="btn ghost sm" onClick={() => actions.cancelPosition(p).then(refresh).catch(() => {})}>
                        Cancel
                      </button>
                    )}
                    {p.status === "trading" && (
                      <button
                        className="btn seal sm"
                        disabled={!expired}
                        title={expired ? "Deadline passed: claim the locked collateral" : "Available after the deadline"}
                        onClick={() => actions.claimDefault(p).then(refresh).catch(() => {})}
                      >
                        {expired ? "Claim collateral" : "Awaiting settlement"}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
