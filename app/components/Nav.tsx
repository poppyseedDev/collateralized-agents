"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import dynamic from "next/dynamic";
import { CLUSTER } from "@/lib/program";

const WalletButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (m) => m.WalletMultiButton,
    ),
  { ssr: false },
);

const links = [
  { href: "/", label: "Agents" },
  { href: "/positions", label: "My positions" },
  { href: "/agent", label: "Agent console" },
];

export function Nav() {
  const path = usePathname();
  return (
    <header className="nav">
      <Link href="/" className="brand">
        <span className="brand-mark">◈</span>
        <span>
          Collateralized<em>Agents</em>
        </span>
      </Link>
      <nav className="nav-links">
        {links.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={path === l.href ? "active" : ""}
          >
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="nav-right">
        <span className="cluster-pill">{CLUSTER}</span>
        <WalletButton />
      </div>
    </header>
  );
}
