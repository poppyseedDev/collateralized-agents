"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/program";
import { LocalFaucet } from "./LocalFaucet";
import { IconAgents, IconConsole, IconPositions, Logo } from "./Icons";

const WalletButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false },
);

const sections = [
  {
    title: "Trade",
    links: [
      { href: "/", label: "Agents", Icon: IconAgents },
      { href: "/positions", label: "My positions", Icon: IconPositions },
    ],
  },
  {
    title: "Build",
    links: [{ href: "/agent", label: "Agent console", Icon: IconConsole }],
  },
];

function Brand() {
  return (
    <Link href="/" className="brand">
      <Logo />
      <span>Collateralized Agents</span>
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
  const path = usePathname();
  const all = sections.flatMap((s) => s.links);
  return (
    <header className="topbar">
      <div className="topbar-brand">
        <Brand />
      </div>
      <nav className="top-tabs">
        {all.map(({ href, label }) => (
          <Link key={href} href={href} className={"top-tab" + (path === href ? " active" : "")}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="topbar-right">
        <span className={"cluster-pill " + CLUSTER}>
          <span className="dot" />
          {CLUSTER}
        </span>
        <LocalFaucet />
        <WalletButton />
      </div>
    </header>
  );
}
