"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useActions, usePositions } from "@/lib/useProtocol";
import {
  AgentAccount,
  MAX_DRAWDOWN_BPS,
  MAX_RATIO_BPS,
  MIN_RATIO_BPS,
  PositionAccount,
  agentPda,
  decodeAgent,
  feeForRatio,
  freeCollateral,
  pct,
  readonlyProgram,
  short,
  sol,
  toLamports,
} from "@/lib/program";
import { TxNotice } from "@/components/TxNotice";
import { Avatar } from "@/components/Avatar";

type Actions = ReturnType<typeof useActions>;

export default function AgentConsole() {
  const { publicKey } = useWallet();
  const { connection } = useConnection();
  const actions = useActions();
  const [agent, setAgent] = useState<AgentAccount | null | undefined>(undefined);

  const load = async () => {
    if (!publicKey) return setAgent(undefined);
    try {
      const program = readonlyProgram(connection);
      const acc = await program.account.agent.fetchNullable(agentPda(publicKey));
      setAgent(acc ? decodeAgent({ publicKey: agentPda(publicKey), account: acc }) : null);
    } catch {
      setAgent(null);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, connection]);

  if (!publicKey) return <div className="empty">Connect the wallet that operates your agent.</div>;
  if (agent === undefined) return <div className="empty">Loading…</div>;

  return (
    <div className="split">
      <div>
        <div className="sec-head">
          <h2>Agent console</h2>
          <span className="meta">{short(publicKey)}</span>
        </div>
        <TxNotice tx={actions.tx} />
        {agent === null ? (
          <RegisterForm actions={actions} onDone={load} />
        ) : (
          <>
            <Dashboard agent={agent} actions={actions} onDone={load} />
            <AgentPositions agent={agent} actions={actions} onDone={load} />
          </>
        )}
      </div>
      <div className="sticky">
        <div className="cert">
          <div className="cert-head">
            <h3 className="cert-title">How bonding works</h3>
            <span className="stamp">Terms</span>
          </div>
          <div className="details">
          <div className="cert-row"><span className="k">Ratio range</span><span className="v">{pct(MIN_RATIO_BPS)} – {pct(MAX_RATIO_BPS)}</span></div>
          <div className="cert-row"><span className="k">Fee rule</span><span className="v seal">ratio ÷ 2</span></div>
          <div className="cert-row"><span className="k">Max loss tolerance</span><span className="v">{pct(MAX_DRAWDOWN_BPS)}</span></div>
          </div>
          <p className="note">
            For every position you accept, principal × ratio of your collateral is locked until you settle.
            Return the funds late, or return less than the principal minus your loss tolerance, and the bond pays the trader.
            Fees are charged only on profit.
          </p>
        </div>
      </div>
    </div>
  );
}

function RegisterForm({ actions, onDone }: { actions: Actions; onDone: () => void }) {
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("");
  const [ratio, setRatio] = useState(3000);
  const [drawdown, setDrawdown] = useState(2000);
  return (
    <div className="card rise">
      <h3>Register an agent</h3>
      <div className="field">
        <label>Name</label>
        <input type="text" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} placeholder="Momentum Bot" />
      </div>
      <div className="field">
        <label>Strategy</label>
        <input type="text" maxLength={128} value={strategy} onChange={(e) => setStrategy(e.target.value)} placeholder="SOL/USDC momentum, 4h candles" />
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Collateral ratio · {pct(ratio)}</label>
          <input type="range" min={MIN_RATIO_BPS} max={MAX_RATIO_BPS} step={500} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} />
          <span className="hint">Performance fee: <span className="pos">{pct(feeForRatio(ratio))}</span> of profit</span>
        </div>
        <div className="field">
          <label>Loss tolerance · {pct(drawdown)}</label>
          <input type="range" min={0} max={MAX_DRAWDOWN_BPS} step={500} value={drawdown} onChange={(e) => setDrawdown(Number(e.target.value))} />
          <span className="hint">Losses beyond this are paid to traders from your bond</span>
        </div>
      </div>
      <button
        className="btn"
        disabled={!name || actions.tx.kind === "pending"}
        onClick={() => actions.registerAgent(name, strategy, ratio, drawdown).then(onDone).catch(() => {})}
      >
        Register agent
      </button>
    </div>
  );
}

function Dashboard({ agent, actions, onDone }: { agent: AgentAccount; actions: Actions; onDone: () => void }) {
  const [amt, setAmt] = useState(1);
  const busy = actions.tx.kind === "pending";
  return (
    <div className="card rise">
      <h3>
        <Avatar seed={agent.publicKey.toBase58()} name={agent.name} size={30} />
        {agent.name}
        <span className={"pill " + (agent.accepting ? "accepting" : "paused")}>{agent.accepting ? "Accepting" : "Paused"}</span>
      </h3>
      <div className="stats">
        <div className="stat"><span className="k">Ratio</span><span className="v">{pct(agent.collateralRatioBps)}</span></div>
        <div className="stat"><span className="k">Fee</span><span className="v pos">{pct(agent.feeBps)}</span></div>
        <div className="stat"><span className="k">Total bond</span><span className="v">{sol(agent.totalCollateral)}<small>SOL</small></span></div>
        <div className="stat"><span className="k">Locked</span><span className="v">{sol(agent.lockedCollateral)}<small>SOL</small></span></div>
        <div className="stat"><span className="k">Free</span><span className="v cy">{sol(freeCollateral(agent))}<small>SOL</small></span></div>
        <div className="stat"><span className="k">Fees earned</span><span className="v">{sol(agent.feesEarned)}<small>SOL</small></span></div>
        <div className="stat"><span className="k">Slashed</span><span className={"v " + (agent.slashedTotal.gtn(0) ? "neg" : "")}>{sol(agent.slashedTotal)}<small>SOL</small></span></div>
      </div>
      <div className="field">
        <label>Amount (SOL)</label>
        <input type="number" min={0.01} step={0.1} value={amt} onChange={(e) => setAmt(parseFloat(e.target.value))} style={{ width: 160 }} />
      </div>
      <div className="actions">
        <button className="btn" disabled={busy || !(amt > 0)} onClick={() => actions.depositCollateral(toLamports(amt)).then(onDone).catch(() => {})}>Deposit bond</button>
        <button className="btn ghost" disabled={busy || !(amt > 0)} onClick={() => actions.withdrawCollateral(toLamports(amt)).then(onDone).catch(() => {})}>Withdraw free bond</button>
        <button className={"btn " + (agent.accepting ? "danger" : "ghost")} disabled={busy} onClick={() => actions.setAccepting(!agent.accepting).then(onDone).catch(() => {})}>
          {agent.accepting ? "Pause new positions" : "Resume"}
        </button>
      </div>
    </div>
  );
}

function AgentPositions({ agent, actions, onDone }: { agent: AgentAccount; actions: Actions; onDone: () => void }) {
  const { positions, refresh } = usePositions({ agent: agent.publicKey });
  const [ret, setRet] = useState<Record<string, string>>({});
  const now = Math.floor(Date.now() / 1000);
  const busy = actions.tx.kind === "pending";
  const done = () => Promise.all([refresh(), onDone()]);
  const live = positions.filter((p) => p.status === "open" || p.status === "trading");
  const past = positions.filter((p) => p.status !== "open" && p.status !== "trading");

  const renderRow = (p: PositionAccount) => {
    const key = p.publicKey.toBase58();
    const deadline = p.deadline.toNumber();
    const late = now >= deadline;
    return (
      <tr key={key}>
        <td>
          <div>{short(p.trader)}</div>
          <div className="tiny">{new Date(p.openedAt.toNumber() * 1000).toLocaleString()}</div>
        </td>
        <td><span className={"pill " + p.status} style={{ textTransform: "capitalize" }}>{p.status}</span></td>
        <td className="num">{sol(p.principal, 3)} SOL</td>
        <td className="num cy">{sol(p.lockedCollateral, 3)} SOL</td>
        <td className="num" style={{ color: late && p.status === "trading" ? "var(--red)" : undefined }}>
          {new Date(deadline * 1000).toLocaleString()}
          {late && p.status === "trading" && <div className="tiny neg">Overdue: trader may claim</div>}
        </td>
        <td className="num">
          {p.status === "open" && (
            <div className="actions" style={{ marginTop: 0, justifyContent: "flex-end" }}>
              <button className="btn sm" disabled={busy || late} onClick={() => actions.drawFunds(p).then(done).catch(() => {})}>Draw funds</button>
              <button className="btn ghost sm" disabled={busy} onClick={() => actions.settlePosition(p, 0).then(done).catch(() => {})}>Decline</button>
            </div>
          )}
          {p.status === "trading" && (
            <div className="actions" style={{ marginTop: 0, justifyContent: "flex-end", alignItems: "center" }}>
              <input
                type="number"
                min={0}
                step={0.01}
                placeholder="return SOL"
                value={ret[key] ?? ""}
                onChange={(e) => setRet({ ...ret, [key]: e.target.value })}
                style={{ width: 120 }}
              />
              <button
                className="btn sm"
                disabled={busy || ret[key] === undefined || ret[key] === ""}
                onClick={() => actions.settlePosition(p, toLamports(parseFloat(ret[key]))).then(done).catch(() => {})}
              >
                Settle
              </button>
            </div>
          )}
          {(p.status === "settled" || p.status === "defaulted") && (
            <div className="tiny">
              returned {sol(p.returned, 3)} · fee {sol(p.feePaid, 3)} · slashed {sol(p.slashed, 3)}
            </div>
          )}
        </td>
      </tr>
    );
  };

  const renderTable = (rows: PositionAccount[]) => (
    <div className="table-wrap">
    <table className="ledger">
      <thead>
        <tr>
          <th>Trader</th><th>Status</th><th className="num">Principal</th><th className="num">Locked</th><th className="num">Deadline</th><th></th>
        </tr>
      </thead>
      <tbody>{rows.map(renderRow)}</tbody>
    </table>
    </div>
  );

  return (
    <div className="card rise d1">
      <h3>Positions on your agent</h3>
      {live.length === 0 ? <div className="empty">No open positions.</div> : renderTable(live)}
      {past.length > 0 && (
        <>
          <h3 style={{ marginTop: 24 }}>History</h3>
          {renderTable(past)}
        </>
      )}
    </div>
  );
}
