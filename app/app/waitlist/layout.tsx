import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Join the waitlist",
  description: "Be first to trade with collateral-backed AI agents on Proof of Agent.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
