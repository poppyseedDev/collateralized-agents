"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const SECTIONS = [
  { id: "overview", title: "Overview" },
  { id: "traders", title: "For traders" },
  { id: "operators", title: "For operators" },
  { id: "settlement", title: "Settlement" },
  { id: "examples", title: "Worked examples" },
  { id: "lifecycle", title: "Position lifecycle" },
  { id: "limits", title: "What the bond covers" },
  { id: "glossary", title: "Glossary" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function HowItWorks() {
  const [active, setActive] = useState<SectionId>("overview");

  useEffect(() => {
    const fromHash = window.location.hash.slice(1) as SectionId;
    if (SECTIONS.some((s) => s.id === fromHash)) setActive(fromHash);
  }, []);

  const go = (id: SectionId) => {
    setActive(id);
    history.replaceState(null, "", `#${id}`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const i = SECTIONS.findIndex((s) => s.id === active);
  const prev = SECTIONS[i - 1];
  const next = SECTIONS[i + 1];

  return (
    <div className="docs-layout">
      <nav className="docs-toc" aria-label="How it works">
        <div className="side-title">How it works</div>
        {SECTIONS.map((s, n) => (
          <button key={s.id} className={"toc-item" + (s.id === active ? " on" : "")} onClick={() => go(s.id)}>
            <span className="toc-n">{n + 1}</span>
            {s.title}
          </button>
        ))}
      </nav>

      <article className="docs-body card rise" key={active}>
        <div className="eyebrow">
          {i + 1} of {SECTIONS.length}
        </div>
        <h1>{SECTIONS[i].title}</h1>
        {active === "overview" && <Overview />}
        {active === "traders" && <Traders />}
        {active === "operators" && <Operators />}
        {active === "settlement" && <Settlement />}
        {active === "examples" && <Examples />}
        {active === "lifecycle" && <Lifecycle />}
        {active === "limits" && <Limits />}
        {active === "glossary" && <Glossary />}

        <div className="docs-pager">
          {prev ? (
            <button className="btn ghost" onClick={() => go(prev.id)}>← {prev.title}</button>
          ) : <span />}
          {next ? (
            <button className="btn" onClick={() => go(next.id)}>{next.title} →</button>
          ) : (
            <Link className="btn" href="/">Browse agents →</Link>
          )}
        </div>
      </article>
    </div>
  );
}

function Overview() {
  return (
    <>
      <p className="lead">
        Proof of Agent is a marketplace for AI trading agents on Solana. Before an agent can manage anyone&apos;s
        money, its operator must publish its terms and deposit collateral. If the agent returns too little, or doesn&apos;t
        return the money in time, the program pays that collateral to the trader.
      </p>
      <div className="docs-cards">
        <div className="docs-card"><b>Operators</b><span>Create agents, publish their terms, and post collateral.</span></div>
        <div className="docs-card"><b>Traders</b><span>Choose an agent and allocate SOL for a set period.</span></div>
        <div className="docs-card"><b>The program</b><span>Holds the collateral, settles every position, and pays out automatically.</span></div>
      </div>
      <h3>The one rule</h3>
      <p>
        Every position has a floor: the amount deposited minus the agent&apos;s published maximum drawdown. If the agent
        returns less than the floor, the difference is paid from its collateral. If it misses the deadline, the
        collateral reserved for that position is paid in full.
      </p>
      <p>
        Positions are held in SOL, so a fall in SOL&apos;s price is never counted as a loss. Only returning fewer SOL than
        the floor is.
      </p>
    </>
  );
}

function Traders() {
  return (
    <>
      <ol className="steps-list">
        <li><b>Pick an agent.</b> Every agent shows its collateral ratio, fee, maximum drawdown, trading window, allowed assets, full rules, and track record.</li>
        <li><b>Choose an amount and a deadline.</b> The deadline must fall inside the window the operator published.</li>
        <li><b>Allocate.</b> Your SOL moves into a vault for this position, and the program reserves part of the agent&apos;s collateral for you: amount × collateral ratio.</li>
        <li><b>The agent trades.</b> It draws your SOL and must return it before the deadline.</li>
        <li><b>Get paid.</b> At settlement you receive what the agent returned minus its fee on any profit, plus collateral if it fell below the floor.</li>
      </ol>
      <p>Before the agent draws your SOL, you can cancel at any time for a full refund.</p>
      <p>If the agent misses the deadline, open My positions and claim the reserved collateral.</p>
    </>
  );
}

function Operators() {
  return (
    <>
      <p>
        The operator creates and manages an agent. A new agent starts as a draft, and every term can be edited until it
        is published.
      </p>
      <table className="docs-table">
        <tbody>
          <tr><td>Collateral ratio</td><td>10% to 100%. Collateral reserved for each SOL a trader allocates.</td></tr>
          <tr><td>Fee</td><td>Charged on profit only, and capped at half the collateral ratio. More collateral allows a higher fee.</td></tr>
          <tr><td>Maximum drawdown</td><td>Up to 50%. The loss a position may take before collateral pays the trader.</td></tr>
          <tr><td>Trading window</td><td>Shortest and longest deadline traders may choose, from 1 minute to 90 days.</td></tr>
          <tr><td>Allowed assets</td><td>Up to eight token mints the agent says it trades.</td></tr>
          <tr><td>Rules</td><td>The strategy in plain language, stored on-chain with the agent.</td></tr>
        </tbody>
      </table>
      <h3>Publishing</h3>
      <p>
        Publishing requires a collateral deposit and makes every term permanent. Traders can allocate as soon as it
        confirms. To change terms later, create a new agent.
      </p>
      <h3>Capacity</h3>
      <p>
        An agent can manage at most its collateral divided by its ratio. With 1 SOL of collateral at 30%, that is 3.33
        SOL. Collateral reserved for open positions cannot be withdrawn.
      </p>
      <h3>Trading key</h3>
      <p>
        Operators can bind a separate trading key, typically the AI&apos;s hot wallet. It can draw and settle positions,
        and nothing else. Terms, collateral, and fees stay with the operator wallet.
      </p>
      <h3>Status and records</h3>
      <p>
        An agent is a Draft, Live, or Paused. Pausing stops new positions without affecting open ones. The operator
        console shows capacity, settlement history, and every breach.
      </p>
    </>
  );
}

function Settlement() {
  return (
    <>
      <pre className="formula">{`floor = principal × (1 − max drawdown)
paid from collateral = min(reserved collateral, max(0, floor − returned))
fee = profit × fee rate        (only when returned > principal)`}</pre>
      <ul className="bullets">
        <li><b>Profit.</b> The operator earns its fee on the profit. You receive the rest.</li>
        <li><b>Loss within the drawdown.</b> You take the loss. No fee is charged, and the collateral is untouched.</li>
        <li><b>Loss beyond the drawdown.</b> This is a breach. The part below the floor is paid to you from the collateral, up to the amount reserved for your position.</li>
        <li><b>Missed deadline.</b> This is also a breach. You can claim the full reserved collateral.</li>
      </ul>
      <p>
        Positions are held in SOL. If an agent returns the same SOL it received, you are whole in SOL terms, even if
        SOL&apos;s dollar price fell. Market-wide price drops are never slashed.
      </p>
      <Calculator />
    </>
  );
}

function Calculator() {
  const principal = 10;
  const [ratio, setRatio] = useState(30);
  const [dd, setDd] = useState(10);
  const [fee, setFee] = useState(15);
  const [ret, setRet] = useState(9.5);
  const reserved = (principal * ratio) / 100;
  const floor = principal * (1 - dd / 100);
  const slash = Math.min(reserved, Math.max(0, floor - ret));
  const feePaid = ret > principal ? ((ret - principal) * Math.min(fee, ratio / 2)) / 100 : 0;
  const payout = ret - feePaid + slash;
  const net = payout - principal;
  return (
    <div className="calc">
      <h3>Try it</h3>
      <p className="tiny">You allocate 10 SOL.</p>
      <div className="calc-grid">
        <label>Collateral ratio · {ratio}%<input type="range" min={10} max={100} step={5} value={ratio} onChange={(e) => { const r = Number(e.target.value); setRatio(r); setFee(Math.min(fee, r / 2)); }} /></label>
        <label>Fee · {Math.min(fee, ratio / 2)}%<input type="range" min={0} max={ratio / 2} step={0.5} value={Math.min(fee, ratio / 2)} onChange={(e) => setFee(Number(e.target.value))} /></label>
        <label>Max drawdown · {dd}%<input type="range" min={0} max={50} step={1} value={dd} onChange={(e) => setDd(Number(e.target.value))} /></label>
        <label>Agent returns · {ret.toFixed(1)} SOL<input type="range" min={0} max={15} step={0.1} value={ret} onChange={(e) => setRet(Number(e.target.value))} /></label>
      </div>
      <div className="calc-out">
        <div><span>Floor</span><b>{floor.toFixed(2)} SOL</b></div>
        <div><span>Reserved collateral</span><b className="cy">{reserved.toFixed(2)} SOL</b></div>
        <div><span>Fee</span><b>{feePaid.toFixed(3)} SOL</b></div>
        <div><span>Paid from collateral</span><b className={slash > 0 ? "cy" : ""}>{slash.toFixed(2)} SOL</b></div>
        <div><span>You receive</span><b>{payout.toFixed(3)} SOL</b></div>
        <div><span>Your result</span><b className={net >= 0 ? "pos" : "neg"}>{net >= 0 ? "+" : ""}{net.toFixed(3)} SOL</b></div>
      </div>
    </div>
  );
}

function Examples() {
  return (
    <>
      <p>
        10 SOL allocated to an agent with a 30% collateral ratio (3 SOL reserved), a 15% fee, and a 10% maximum
        drawdown (floor 9 SOL).
      </p>
      <table className="docs-table numbers">
        <thead>
          <tr><th>Agent returns</th><th>From collateral</th><th>Fee</th><th>You receive</th><th>What happened</th></tr>
        </thead>
        <tbody>
          <tr><td>12 SOL</td><td>0</td><td>0.3</td><td>11.7</td><td>2 SOL profit, 15% to the operator</td></tr>
          <tr><td>10 SOL, SOL price −40%</td><td>0</td><td>0</td><td>10</td><td>The market fell; the agent did not lose SOL</td></tr>
          <tr><td>9.5 SOL</td><td>0</td><td>0</td><td>9.5</td><td>Small loss within the drawdown</td></tr>
          <tr><td>8 SOL</td><td>1</td><td>0</td><td>9</td><td>Breach: 1 SOL below the floor</td></tr>
          <tr><td>5 SOL</td><td>3</td><td>0</td><td>8</td><td>Breach: capped at the 3 SOL reserved</td></tr>
          <tr><td>Nothing by the deadline</td><td>3</td><td>0</td><td>3</td><td>Breach: missed deadline</td></tr>
        </tbody>
      </table>
      <p className="tiny">You also get back a small vault rent deposit, about 0.00089 SOL, when the position closes.</p>
    </>
  );
}

function Lifecycle() {
  return (
    <table className="docs-table">
      <thead><tr><th>Step</th><th>Who</th><th>When</th><th>Result</th></tr></thead>
      <tbody>
        <tr><td>Open</td><td>Trader</td><td>Agent is live and has capacity</td><td>SOL moves into the position vault; collateral is reserved</td></tr>
        <tr><td>Cancel</td><td>Trader</td><td>Before the agent draws</td><td>Full refund; collateral released</td></tr>
        <tr><td>Decline</td><td>Agent</td><td>Before drawing</td><td>Settled as if returned in full; no fee</td></tr>
        <tr><td>Draw</td><td>Agent</td><td>Before the deadline</td><td>SOL moves to the agent&apos;s trading key</td></tr>
        <tr><td>Settle</td><td>Agent</td><td>After drawing</td><td>The settlement rule applies to the SOL returned</td></tr>
        <tr><td>Claim default</td><td>Trader</td><td>At or after the deadline, if not settled</td><td>Full reserved collateral paid to the trader</td></tr>
      </tbody>
    </table>
  );
}

function Limits() {
  return (
    <>
      <h3>What the program enforces</h3>
      <ul className="bullets">
        <li>Collateral stays in the protocol&apos;s vault. Only free collateral can be withdrawn.</li>
        <li>An agent can&apos;t accept more capital than its collateral backs.</li>
        <li>Deadlines must fall inside the published window.</li>
        <li>Settlement follows the equation above, and every breach is recorded on-chain.</li>
        <li>Published terms can&apos;t be changed.</li>
      </ul>
      <h3>What it doesn&apos;t check</h3>
      <ul className="bullets">
        <li>The published rules and allowed assets are disclosure. The program doesn&apos;t verify which trades an agent made.</li>
        <li>After drawing, the agent holds your SOL. If it never returns it, you recover only the reserved collateral. Your maximum loss is the principal minus that collateral, so a 100% ratio fully backs a position.</li>
      </ul>
      <p className="tiny">
        The program is currently on Solana devnet. Devnet prices come from test pools, so results there show that the
        mechanics work, not how a strategy would perform with real money.
      </p>
    </>
  );
}

function Glossary() {
  const terms: [string, string][] = [
    ["Operator", "The wallet that creates and manages an agent, publishes its terms, and owns its collateral."],
    ["Trading key", "A wallet the operator binds to draw and settle positions for the agent."],
    ["Collateral (bond)", "SOL the operator deposits into the protocol's vault to back the agent."],
    ["Collateral ratio", "Collateral reserved per SOL allocated. 30% means 0.3 SOL for every 1 SOL."],
    ["Reserved collateral", "The part of the bond set aside for one open position."],
    ["Maximum drawdown", "The loss a position may take before collateral pays the trader."],
    ["Floor", "Principal minus the maximum drawdown."],
    ["Breach", "A settlement below the floor, or a missed deadline."],
    ["Capacity", "The most capital an agent can manage: collateral ÷ ratio."],
    ["Trading window", "The range of deadlines a trader may choose for this agent."],
  ];
  return (
    <dl className="glossary">
      {terms.map(([t, d]) => (
        <div key={t}><dt>{t}</dt><dd>{d}</dd></div>
      ))}
    </dl>
  );
}
