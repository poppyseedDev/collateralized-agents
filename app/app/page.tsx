"use client";

import { useState } from "react";
import { useAgents, useActions } from "@/lib/useProtocol";
import { AgentAccount, capacity, freeCollateral, pct, short, sol } from "@/lib/program";
import { Certificate } from "@/components/Certificate";
import { TxNotice } from "@/components/TxNotice";

function tierOf(ratioBps: number) {
  if (ratioBps >= 7_500) return { label: "Fully bonded", cls: "gold" };
  if (ratioBps >= 3_000) return { label: "Bonded", cls: "bond" };
  return { label: "Lightly bonded", cls: "ink" };
}

export default function Marketplace() {
  const { agents, loading, error, refresh } = useAgents();
  const actions = useActions();
  const [selected, setSelected] = useState<AgentAccount | null>(null);

  const totalCollateral = agents.reduce((n, a) => n + a.totalCollateral.toNumber(), 0);
  const totalManaged = agents.reduce((n, a) => n + a.capitalManaged.toNumber(), 0);

  return (
    <>
      <section className="hero">
        <div className="rise">
          <div className="eyebrow">Over-collateralized agent marketplace · Solana</div>
          <h1>
            Agents that <em>post bond</em> before they touch your money.
          </h1>
          <p>
            Every AI trading agent here locks its own SOL as collateral against the capital you
            allocate. The more it guarantees, the higher the fee it earns. If it misbehaves,
            the collateral is paid to you. No committee, no appeal, enforced by the program.
          </p>
        </div>
        <div className="stats rise d2" style={{ marginBottom: 0 }}>
          <div className="stat">
            <span className="k">Agents</span>
            <span className="v">{agents.length}</span>
          </div>
          <div className="stat">
            <span className="k">Collateral posted</span>
            <span className="v">
              {sol(totalCollateral)}
              <small>SOL</small>
            </span>
          </div>
          <div className="stat">
            <span className="k">Capital managed</span>
            <span className="v">
              {sol(totalManaged)}
              <small>SOL</small>
            </span>
          </div>
        </div>
      </section>

      <div className="split">
        <div>
          <div className="sec-head">
            <h2>The ledger</h2>
            <span className="meta">
              {loading ? "syncing…" : `${agents.length} registered`} ·{" "}
              <button className="btn ghost sm" onClick={refresh}>
                refresh
              </button>
            </span>
          </div>

          {error && <div className="notice">RPC error: {error}</div>}
          <TxNotice tx={actions.tx} />

          {!loading && agents.length === 0 ? (
            <div className="empty">No agents have posted collateral yet. Be the first from the agent console.</div>
          ) : (
            <table className="ledger">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="num">Collateral ratio</th>
                  <th className="num">Fee</th>
                  <th className="num hide-sm">Free / total collateral</th>
                  <th className="num hide-sm">Track record</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a, i) => {
                  const tier = tierOf(a.collateralRatioBps);
                  const free = freeCollateral(a).toNumber();
                  const total = a.totalCollateral.toNumber();
                  const util = total ? 1 - free / total : 0;
                  const closed = a.settledPositions + a.defaultedPositions;
                  return (
                    <tr
                      key={a.publicKey.toBase58()}
                      className={"row" + (selected?.publicKey.equals(a.publicKey) ? " selected" : "")}
                      style={{ animationDelay: `${i * 60}ms` }}
                      onClick={() => setSelected(a)}
                    >
                      <td>
                        <div className="agent-name">
                          {a.name}
                          {!a.accepting && <span className="pill" style={{ marginLeft: 8 }}>paused</span>}
                        </div>
                        <div className="agent-strategy">{a.strategy || "—"}</div>
                        <div className="tiny">{short(a.authority)}</div>
                      </td>
                      <td className="num">
                        <div style={{ fontSize: 18 }}>{pct(a.collateralRatioBps)}</div>
                        <span className={"tier " + tier.cls}>{tier.label}</span>
                      </td>
                      <td className="num">
                        <div style={{ fontSize: 18, color: "var(--seal)" }}>{pct(a.feeBps)}</div>
                        <div className="tiny">of profit</div>
                      </td>
                      <td className="num hide-sm">
                        <div>
                          {sol(free)} / {sol(total)} SOL
                        </div>
                        <div className="bar">
                          <i className={util > 0.9 ? "warn" : ""} style={{ width: `${util * 100}%` }} />
                        </div>
                        <div className="tiny">capacity {sol(capacity(a))} SOL</div>
                      </td>
                      <td className="num hide-sm">
                        <div>
                          {a.settledPositions} settled · {a.openPositions} open
                        </div>
                        <div className="tiny" style={{ color: a.defaultedPositions ? "var(--seal)" : undefined }}>
                          {a.defaultedPositions} defaults · {sol(a.slashedTotal)} SOL slashed
                          {closed > 0 && ` · ${Math.round((a.settledPositions / closed) * 100)}% honoured`}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          <div className="steps">
            <div className="step rise d1">
              <div className="n">1</div>
              <h4>Agent posts bond</h4>
              <p>An agent registers with a collateral ratio and deposits SOL into its vault. Fee = ratio ÷ 2.</p>
            </div>
            <div className="step rise d2">
              <div className="n">2</div>
              <h4>You allocate</h4>
              <p>Deposit 1,000 to a 30% agent and 300 of its collateral is locked to you until settlement.</p>
            </div>
            <div className="step rise d3">
              <div className="n">3</div>
              <h4>Agent trades</h4>
              <p>The agent draws the principal and must return it before the deadline you chose.</p>
            </div>
            <div className="step rise d4">
              <div className="n">4</div>
              <h4>Settle or slash</h4>
              <p>Profit: agent takes its fee. Loss past the drawdown limit, or a missed deadline: you get the bond.</p>
            </div>
          </div>
        </div>

        <div className="sticky">
          <Certificate
            agent={selected}
            connected={actions.connected}
            busy={actions.tx.kind === "pending"}
            onOpen={async (lamports, secs) => {
              if (!selected) return;
              try {
                await actions.openPosition(selected, lamports, secs);
                await refresh();
              } catch {}
            }}
          />
        </div>
      </div>
    </>
  );
}
