import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Simulation",
  description:
    "What posting collateral costs an honest operator, measured on six years of real SOL price history.",
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
