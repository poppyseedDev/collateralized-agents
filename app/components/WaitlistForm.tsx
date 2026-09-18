"use client";

import { useState } from "react";
import { ALLOCATIONS, EMPTY, TRUST_FACTORS, YES_NO, YES_NO_MAYBE, validate, type Submission } from "@/lib/waitlist";

function Choice<T extends readonly string[]>({
  label, value, options, onChange, hint,
}: { label: string; value: string; options: T; onChange: (v: T[number]) => void; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="chips">
        {options.map((o) => (
          <button key={o} type="button" className={"chip" + (value === o ? " on" : "")} onClick={() => onChange(o)}>{o}</button>
        ))}
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

export function WaitlistForm() {
  const [s, setS] = useState<Submission>(EMPTY);
  const [website, setWebsite] = useState(""); // honeypot
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Submission>) => setS((prev) => ({ ...prev, ...patch }));

  const submit = async () => {
    const problems = validate(s);
    if (problems.length) {
      setError(problems.join(" "));
      return;
    }
    setError(null);
    setState("busy");
    try {
      const res = await fetch("/api/waitlist", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...s, website }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Something went wrong.");
      setState("done");
    } catch (e) {
      setError((e as Error).message);
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <div className="card" style={{ textAlign: "center", padding: "40px 24px" }}>
        <div className="big-icon" style={{ margin: "0 auto 14px" }}>✓</div>
        <h3 style={{ justifyContent: "center", fontSize: 22 }}>You&apos;re on the list</h3>
        <p style={{ color: "var(--muted)", margin: 0 }}>
          Thanks, {s.name.split(" ")[0]}. We&apos;ll email you when there&apos;s something to try.
          {s.testDevnet === "Yes" && " You said you'd test on devnet, so you'll hear from us first."}
        </p>
      </div>
    );
  }

  return (
    <div className="waitlist">
      <div className="card">
        <div className="form-grid">
          <section className="form-section">
            <h4>About you</h4>
            <div className="field"><label>Name</label><input type="text" value={s.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} autoComplete="name" /></div>
            <div className="field"><label>Email</label><input type="email" value={s.email} maxLength={120} onChange={(e) => set({ email: e.target.value })} autoComplete="email" /></div>
            <div className="field"><label>Telegram <span className="opt">optional</span></label><input type="text" value={s.telegram} maxLength={64} placeholder="@handle" onChange={(e) => set({ telegram: e.target.value })} /></div>
            <div className="field"><label>Country or city <span className="opt">optional</span></label><input type="text" value={s.location} maxLength={80} onChange={(e) => set({ location: e.target.value })} /></div>
            <div className="field"><label>Solana wallet <span className="opt">optional</span></label><input type="text" value={s.wallet} maxLength={64} placeholder="For devnet access and early allocations" onChange={(e) => set({ wallet: e.target.value })} /></div>
            <input type="text" value={website} onChange={(e) => setWebsite(e.target.value)} tabIndex={-1} autoComplete="off" aria-hidden className="hp" />
          </section>

          <section className="form-section">
            <h4>Your trading</h4>
            <Choice label="Do you currently trade crypto?" value={s.tradesCrypto} options={YES_NO} onChange={(v) => set({ tradesCrypto: v })} />
            <Choice label="Have you used AI trading bots or agents before?" value={s.usedAgents} options={YES_NO} onChange={(v) => set({ usedAgents: v })} />
            <Choice label="Would you trust an AI agent to trade on your behalf?" value={s.wouldTrust} options={YES_NO_MAYBE} onChange={(v) => set({ wouldTrust: v })} />
            <Choice label="Roughly how much would you consider allocating to one agent?" value={s.allocation} options={ALLOCATIONS} onChange={(v) => set({ allocation: v })} />
          </section>

          <section className="form-section wide">
            <h4>What would earn your trust</h4>
            <div className="field">
              <label>What would make you trust an AI agent with your capital? <span className="opt">pick any</span></label>
              <div className="chips">
                {TRUST_FACTORS.map((f) => {
                  const on = s.trustFactors.includes(f);
                  return (
                    <button key={f} type="button" className={"chip" + (on ? " on" : "")}
                      onClick={() => setS((prev) => ({ ...prev, trustFactors: prev.trustFactors.includes(f) ? prev.trustFactors.filter((x) => x !== f) : [...prev.trustFactors, f] }))}>{f}</button>
                  );
                })}
              </div>
            </div>
            <div className="grid-2">
              <Choice label="Would you allocate more if the agent had to post its own collateral?" value={s.collateralHelps} options={YES_NO_MAYBE} onChange={(v) => set({ collateralHelps: v })} />
              <Choice label="Want to test Proof of Agent on devnet?" value={s.testDevnet} options={YES_NO} onChange={(v) => set({ testDevnet: v })} hint="Test SOL only, nothing at risk." />
            </div>
            <div className="field">
              <label>Anything else? <span className="opt">optional</span></label>
              <textarea rows={3} maxLength={1000} value={s.notes} onChange={(e) => set({ notes: e.target.value })} placeholder="What you'd want to see before allocating, agents you'd like listed, questions…" />
            </div>
          </section>
        </div>

        {error && <div className="notice" style={{ marginTop: 14 }}>{error}</div>}
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn lg" disabled={state === "busy"} onClick={submit}>{state === "busy" ? "Sending…" : "Join the waitlist"}</button>
        </div>
        <p className="tiny" style={{ marginTop: 10 }}>We only use this to contact you about Proof of Agent. No sharing, no spam.</p>
      </div>
    </div>
  );
}
