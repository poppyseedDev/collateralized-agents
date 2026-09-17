"use client";

import { useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  BPS,
  KNOWN_ASSETS,
  MAX_ALLOWED_ASSETS,
  MAX_DESCRIPTION_LEN,
  MAX_DRAWDOWN_BPS,
  MAX_NAME_LEN,
  MAX_RATIO_BPS,
  MAX_RULES_LEN,
  MIN_RATIO_BPS,
  assetLabel,
  fmtDuration,
  maxFeeForRatio,
  pct,
} from "@/lib/program";
import type { TermsInput } from "@/lib/useProtocol";

export type AgentDraft = { name: string; description: string; terms: TermsInput };

export const DEFAULT_DRAFT: AgentDraft = {
  name: "",
  description: "",
  terms: {
    collateralRatioBps: 3000,
    feeBps: 1500,
    maxDrawdownBps: 1000,
    minDurationSecs: 3_600,
    maxDurationSecs: 7 * 86_400,
    allowedAssets: [KNOWN_ASSETS[0].mint, KNOWN_ASSETS[1].mint],
    rules: "",
  },
};

const DURATION_CHOICES = [60, 15 * 60, 3_600, 6 * 3_600, 86_400, 7 * 86_400, 30 * 86_400, 90 * 86_400];

const RULES_TEMPLATE = `Strategy: 
Assets traded: 
Max share of a position in one asset: 
Leverage: none
Exit rule: 
When I settle: `;

export function draftProblems(d: AgentDraft): string[] {
  const t = d.terms;
  const out: string[] = [];
  if (!d.name.trim()) out.push("Give the agent a name.");
  if (t.feeBps > maxFeeForRatio(t.collateralRatioBps)) out.push("Fee is above the cap for this collateral ratio.");
  if (t.minDurationSecs > t.maxDurationSecs) out.push("Shortest deadline is longer than the longest.");
  if (t.allowedAssets.length === 0) out.push("Choose at least one asset.");
  if (!t.rules.trim()) out.push("Write the agent's trading rules.");
  return out;
}

/** Identity and terms editor for a draft agent. */
export function AgentForm({
  value,
  onChange,
  bondSol,
}: {
  value: AgentDraft;
  onChange: (d: AgentDraft) => void;
  bondSol?: number;
}) {
  const t = value.terms;
  const setT = (patch: Partial<TermsInput>) => onChange({ ...value, terms: { ...t, ...patch } });
  const feeCap = maxFeeForRatio(t.collateralRatioBps);
  const [custom, setCustom] = useState("");
  const customValid = (() => {
    try {
      return custom.length > 30 && !!new PublicKey(custom);
    } catch {
      return false;
    }
  })();

  const toggleAsset = (mint: string) => {
    const has = t.allowedAssets.includes(mint);
    if (!has && t.allowedAssets.length >= MAX_ALLOWED_ASSETS) return;
    setT({ allowedAssets: has ? t.allowedAssets.filter((m) => m !== mint) : [...t.allowedAssets, mint] });
  };
  const perSol = BPS / t.collateralRatioBps;
  const customAssets = t.allowedAssets.filter((m) => !KNOWN_ASSETS.some((k) => k.mint === m));

  return (
    <div className="form-grid">
      <section className="form-section">
        <h4>Identity</h4>
        <div className="field">
          <label>Name</label>
          <input type="text" maxLength={MAX_NAME_LEN} value={value.name} placeholder="Orca Momentum"
            onChange={(e) => onChange({ ...value, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Short description</label>
          <input type="text" maxLength={MAX_DESCRIPTION_LEN} value={value.description} placeholder="Rotates into USDC when SOL dips"
            onChange={(e) => onChange({ ...value, description: e.target.value })} />
        </div>
      </section>

      <section className="form-section">
        <h4>Collateral and fee</h4>
        <div className="field">
          <label>Collateral ratio · {pct(t.collateralRatioBps)}</label>
          <input type="range" min={MIN_RATIO_BPS} max={MAX_RATIO_BPS} step={500} value={t.collateralRatioBps}
            onChange={(e) => {
              const r = Number(e.target.value);
              setT({ collateralRatioBps: r, feeBps: Math.min(t.feeBps, maxFeeForRatio(r)) });
            }} />
          <span className="hint">
            Each 1 SOL of collateral lets the agent manage up to {perSol.toFixed(2)} SOL.
            {bondSol !== undefined && ` Your ${bondSol} SOL bond covers ${(bondSol * perSol).toFixed(2)} SOL.`}
          </span>
        </div>
        <div className="field">
          <label>Performance fee · {pct(t.feeBps, 1)}</label>
          <input type="range" min={0} max={feeCap} step={50} value={Math.min(t.feeBps, feeCap)}
            onChange={(e) => setT({ feeBps: Number(e.target.value) })} />
          <span className="hint">Charged on profit only. The cap is half the collateral ratio: {pct(feeCap)}.</span>
        </div>
      </section>

      <section className="form-section">
        <h4>Risk and deadline</h4>
        <div className="field">
          <label>Maximum drawdown · {pct(t.maxDrawdownBps)}</label>
          <input type="range" min={0} max={MAX_DRAWDOWN_BPS} step={100} value={t.maxDrawdownBps}
            onChange={(e) => setT({ maxDrawdownBps: Number(e.target.value) })} />
          <span className="hint">Returning less than {pct(BPS - t.maxDrawdownBps)} of a position is a breach, paid from your bond.</span>
        </div>
        <div className="grid-2">
          <div className="field">
            <label>Shortest deadline</label>
            <select value={t.minDurationSecs} onChange={(e) => setT({ minDurationSecs: Number(e.target.value) })}>
              {DURATION_CHOICES.map((d) => <option key={d} value={d}>{fmtDuration(d)}</option>)}
            </select>
          </div>
          <div className="field">
            <label>Longest deadline</label>
            <select value={t.maxDurationSecs} onChange={(e) => setT({ maxDurationSecs: Number(e.target.value) })}>
              {DURATION_CHOICES.map((d) => <option key={d} value={d}>{fmtDuration(d)}</option>)}
            </select>
          </div>
        </div>
        <span className="hint">Traders pick a settlement deadline inside this window. Missing it pays them the reserved collateral.</span>
      </section>

      <section className="form-section">
        <h4>Allowed assets</h4>
        <div className="chips">
          {KNOWN_ASSETS.map((a) => (
            <button key={a.mint} type="button" className={"chip" + (t.allowedAssets.includes(a.mint) ? " on" : "")}
              onClick={() => toggleAsset(a.mint)} title={a.mint}>
              {a.symbol}
            </button>
          ))}
          {customAssets.map((m) => (
            <button key={m} type="button" className="chip on" onClick={() => toggleAsset(m)} title={m}>
              {assetLabel(m)} ×
            </button>
          ))}
        </div>
        <div className="actions">
          <input type="text" placeholder="Add a token mint address" value={custom} onChange={(e) => setCustom(e.target.value.trim())} style={{ flex: 1, minWidth: 0 }} />
          <button type="button" className="btn ghost sm" disabled={!customValid || t.allowedAssets.includes(custom)}
            onClick={() => { toggleAsset(custom); setCustom(""); }}>
            Add
          </button>
        </div>
        <span className="hint">{t.allowedAssets.length} of {MAX_ALLOWED_ASSETS} selected.</span>
      </section>

      <section className="form-section wide">
        <h4>Trading rules</h4>
        <div className="field">
          <textarea rows={7} maxLength={MAX_RULES_LEN} value={t.rules} placeholder={RULES_TEMPLATE}
            onChange={(e) => setT({ rules: e.target.value })} />
          <span className="hint">
            Published on-chain with the agent and shown to every trader. {t.rules.length}/{MAX_RULES_LEN}
            {!t.rules && (
              <>
                {" · "}
                <button type="button" className="rules-toggle" onClick={() => setT({ rules: RULES_TEMPLATE })}>Use a template</button>
              </>
            )}
          </span>
        </div>
      </section>
    </div>
  );
}
