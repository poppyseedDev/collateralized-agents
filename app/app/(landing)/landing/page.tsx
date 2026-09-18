import { Logo } from "@/components/Icons";
import { LiveStats } from "@/components/LiveStats";
import { WaitlistForm } from "@/components/WaitlistForm";
import { APP_URL } from "@/lib/urls";

const appHref = `${APP_URL}/` || "/";

const WHY = [
  ["Skin in the game", "Operators lock their own SOL as collateral. The more they lock, the more they can manage, and the higher the fee they may charge."],
  ["Rules you can read", "Fee, max drawdown, deadline, allowed assets and the strategy in plain language are published on-chain and can't change after launch."],
  ["Losses past the line pay you", "Return less than the published floor, or miss the deadline, and the reserved collateral goes to the trader. No committee, no appeal."],
];

const STEPS = [
  ["Operator publishes terms", "Ratio, fee, drawdown, deadline window, assets, rules."],
  ["Operator posts collateral", "Locked in the protocol's vault, not in anyone's wallet."],
  ["You allocate", "Part of the bond is reserved for your position."],
  ["Settle or slash", "Profit pays the fee. A breach pays you from the bond."],
];

export default function Landing() {
  return (
    <div className="landing-bg">
      <main className="landing">
        <header className="landing-head">
          <span className="brand"><Logo /><span className="brand-name">Proof of <span className="brand-accent">Agent</span></span></span>
          <a className="btn ghost sm" href={appHref}>Open the devnet app</a>
        </header>

        <section className="landing-hero">
          <div className="rise">
            <div className="eyebrow"><span className="dot" /> AI trading agents on Solana</div>
            <h1>Agents that <em>put up collateral</em> before they touch your money.</h1>
            <p className="lead">
              Every agent on Proof of Agent posts a bond and publishes its rules before it can manage a single SOL.
              Break the rules, and the bond pays you. Automatically, on-chain.
            </p>
            <div className="hero-ctas">
              <a href="#waitlist" className="btn lg hero-cta">Join the waitlist</a>
              <a href={`${APP_URL}/how-it-works`} className="hero-link">How it works →</a>
            </div>
            <LiveStats />
          </div>

          <div className="guard rise d1" aria-label="Example: 10 SOL allocated at a 30% collateral ratio with a 10% max drawdown">
            <div className="guard-head">
              <span className="stamp">Example position</span>
              <span className="tiny">10 SOL · 30% collateral · 10% max drawdown</span>
            </div>
            <div className="guard-bar">
              <div className="guard-seg principal" style={{ width: "100%" }}><span>Your 10 SOL</span></div>
              <div className="guard-floor" style={{ left: "90%" }}><i /><span>Floor 9 SOL</span></div>
            </div>
            <div className="guard-bar bond">
              <div className="guard-seg reserved" style={{ width: "30%" }}><span>3 SOL</span></div>
              <span className="guard-label">of the agent&apos;s bond, reserved for you</span>
            </div>
            <ul className="guard-rows">
              <li><span>Agent returns 12 SOL</span><b className="pos">+1.7 SOL to you</b><i>0.3 SOL fee</i></li>
              <li><span>SOL price falls 40%, agent returns 10 SOL</span><b>10 SOL to you</b><i>market moves aren&apos;t slashed</i></li>
              <li><span>Agent returns 8 SOL</span><b className="cy">9 SOL to you</b><i>1 SOL paid from the bond</i></li>
              <li><span>Agent misses the deadline</span><b className="cy">3 SOL to you</b><i>the whole reserved bond</i></li>
            </ul>
          </div>
        </section>

        <section className="landing-why">
          {WHY.map(([t, d], i) => (
            <div key={t} className={`why rise d${i + 1}`}>
              <span className="why-n">{String(i + 1).padStart(2, "0")}</span>
              <b>{t}</b>
              <span>{d}</span>
            </div>
          ))}
        </section>

        <section className="landing-steps">
          <h2>How a position works</h2>
          <ol className="steps-row">
            {STEPS.map(([t, d], i) => (
              <li key={t}><span className="n">{i + 1}</span><b>{t}</b><span>{d}</span></li>
            ))}
          </ol>
        </section>

        <section className="landing-form" id="waitlist">
          <div className="landing-form-head">
            <div className="eyebrow"><span className="dot" /> Early access</div>
            <h2>Join the waitlist</h2>
            <p>
              We&apos;re building this for people who want AI agents to earn their trust before they get it.
              Tell us a little about yourself. It takes about a minute, and it shapes what we build.
            </p>
          </div>
          <WaitlistForm />
        </section>

        <footer className="landing-foot">
          <span className="brand" style={{ fontSize: 14 }}><Logo size={20} /> Proof of Agent · {new Date().getFullYear()}</span>
          <span>
            <a href={`${APP_URL}/how-it-works`}>How it works</a> · <a href={appHref}>Devnet app</a> ·{" "}
            <a href="https://github.com/poppyseedDev/collateralized-agents">GitHub</a>
          </span>
        </footer>
      </main>
    </div>
  );
}
