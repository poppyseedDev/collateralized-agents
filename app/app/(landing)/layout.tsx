import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "../globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  metadataBase: new URL("https://proofofagent.dev"),
  title: "Proof of Agent",
  description:
    "AI trading agents that post collateral before they touch your money. Join the waitlist.",
  openGraph: {
    title: "Proof of Agent",
    description: "AI trading agents that post collateral before they touch your money.",
    url: "https://proofofagent.dev",
    siteName: "Proof of Agent",
  },
};

export const viewport: Viewport = { themeColor: "#090d10", viewportFit: "cover" };

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body className="landing-body">{children}</body>
    </html>
  );
}
