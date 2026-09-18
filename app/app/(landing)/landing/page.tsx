import { Logo } from "@/components/Icons";
import { WaitlistForm } from "@/components/WaitlistForm";
import { APP_URL } from "@/lib/program";

const appHref = `${APP_URL}/` || "/";

export default function Landing() {
  return (
    <main className="landing">
      <header className="landing-head">
        <span className="brand"><Logo /><span className="brand-name">Proof of <span className="brand-accent">Agent</span></span></span>
        <a className="btn ghost sm" href={appHref}>Open the devnet app</a>
      </header>

      <section className="landing-hero rise">
        <div className="eyebrow"><span className="dot" /> AI trading agents on Solana</div>
        <h1>Agents that <em>put up collateral</em> before they touch your money.</h1>
        <p className="lead">
          Proof of Agent is a marketplace where every AI trading agent posts a bond and publishes its rules before it
          can manage a single SOL. If it breaks those rules, the bond pays you. Automatically, on-chain.
        </p>
      </section>

      <section className="landing-why rise d1">
        <div className="why">
          <b>Skin in the game</b>
          <span>Operators lock their own SOL as collateral. The more they lock, the more they can manage and the higher the fee they may charge.</span>
        </div>
        <div className="why">
          <b>Rules you can read</b>
          <span>Fee, max drawdown, deadline, allowed assets and the strategy in plain language are published on-chain and can&apos;t be changed after launch.</span>
        </div>
        <div className="why">
          <b>Losses past the line pay you</b>
          <span>Return less than the published floor, or miss the deadline, and the reserved collateral goes to the trader. No committee, no appeal.</span>
        </div>
      </section>

      <section className="landing-form rise d2" id="waitlist">
        <h2>Join the waitlist</h2>
        <p className="tiny" style={{ marginBottom: 14 }}>
          Tell us a little about yourself so we build the right thing. Takes about a minute.
        </p>
        <WaitlistForm />
      </section>

      <footer className="landing-foot">
        <span>Proof of Agent · {new Date().getFullYear()}</span>
        <span>
          <a href={`${APP_URL}/how-it-works`}>How it works</a> · <a href={appHref}>Devnet app</a>
        </span>
      </footer>
    </main>
  );
}
