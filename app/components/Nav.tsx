"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/program";
import { LocalFaucet } from "./LocalFaucet";
import { IconAgents, IconConsole, IconPositions, Logo } from "./Icons";

const LABELS = {
  "change-wallet": "Change wallet",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied",
  disconnect: "Disconnect",
  "has-wallet": "Connect",
  "no-wallet": "Connect",
};

const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then((m) => {
      const Button = () => <m.BaseWalletMultiButton labels={LABELS} />;
      return Button;
    }),
  { ssr: false, loading: () => <span className="wallet-placeholder" /> },
);

const sections = [
  {
    title: "Trade",
    links: [
      { href: "/", label: "Agents", short: "Agents", Icon: IconAgents },
      { href: "/positions", label: "My positions", short: "Positions", Icon: IconPositions },
    ],
  },
  {
    title: "Build",
    links: [{ href: "/agent", label: "Agent console", short: "Console", Icon: IconConsole }],
  },
];
const allLinks = sections.flatMap((s) => s.links);

function Brand({ showCluster = false }: { showCluster?: boolean }) {
  return (
    <Link href="/" className="brand" aria-label="Collateralized Agents home">
      <Logo />
      <span className="brand-text">
        <span className="brand-name">
          Collateralized <span className="brand-accent">Agents</span>
        </span>
        {showCluster && (
          <span className={"brand-cluster " + CLUSTER}>
            <span className="dot" />
            {CLUSTER}
          </span>
        )}
      </span>
    </Link>
  );
}

export function Sidebar() {
  const path = usePathname();
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="side-nav">
        {sections.map((s) => (
          <div key={s.title} className="side-section">
            <div className="side-title">{s.title}</div>
            {s.links.map(({ href, label, Icon }) => (
              <Link key={href} href={href} className={"side-link" + (path === href ? " active" : "")}>
                <Icon />
                <span>{label}</span>
              </Link>
            ))}
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <span className="dot" /> Collateral is locked and slashed on-chain
      </div>
    </aside>
  );
}

export function TopBar() {
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Brand showCluster />
      </div>
      <div className="topbar-right">
        <span className={"cluster-pill " + CLUSTER} title={`Connected to ${CLUSTER}`}>
          <span className="dot" />
          <span className="cluster-name">{CLUSTER}</span>
        </span>
        <LocalFaucet />
        <WalletButton />
      </div>
    </header>
  );
}

/** Phone-only tab bar fixed to the bottom of the screen. */
export function BottomNav() {
  const path = usePathname();
  return (
    <nav className="bottom-nav" aria-label="Main">
      {allLinks.map(({ href, short, Icon }) => {
        const active = path === href;
        return (
          <Link key={href} href={href} className={"bottom-tab" + (active ? " active" : "")} aria-current={active ? "page" : undefined}>
            <span className="bottom-icon">
              <Icon />
            </span>
            <span>{short}</span>
          </Link>
        );
      })}
    </nav>
  );
}
