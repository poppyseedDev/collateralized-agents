import { AgentAccount, BPS, assetLabel, feePct, fmtDuration, maxCapacity, pct, sol } from "@/lib/program";

/** Read-only summary of an agent's terms, as traders see them. */
export function TermsView({ agent }: { agent: AgentAccount }) {
  const t = agent.terms;
  return (
    <div className="details">
      <div className="cert-row"><span className="k">Collateral ratio</span><span className="v">{pct(t.collateralRatioBps)}</span></div>
      <div className="cert-row"><span className="k">Performance fee</span><span className="v seal">{feePct(t.feeBps)} of profit</span></div>
      <div className="cert-row"><span className="k">Maximum drawdown</span><span className="v">{pct(t.maxDrawdownBps)}</span></div>
      <div className="cert-row">
        <span className="k">Trading window</span>
        <span className="v">{fmtDuration(t.minDurationSecs.toNumber())} to {fmtDuration(t.maxDurationSecs.toNumber())}</span>
      </div>
      <div className="cert-row">
        <span className="k">Allowed assets</span>
        <span className="v">{t.allowedAssets.map((m) => assetLabel(m)).join(", ")}</span>
      </div>
      <div className="cert-row">
        <span className="k">Capital per 1 SOL bond</span>
        <span className="v">{(BPS / t.collateralRatioBps).toFixed(2)} SOL</span>
      </div>
      <div className="cert-row">
        <span className="k">Max manageable capital</span>
        <span className="v bond">{sol(maxCapacity(agent))} SOL</span>
      </div>
      <div className="rules-box">{t.rules}</div>
    </div>
  );
}
