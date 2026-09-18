import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import { BottomNav, Sidebar, TopBar } from "@/components/Nav";
import { DevnetNotice } from "@/components/DevnetNotice";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL("https://proofofagent.dev"),
  title: { default: "Proof of Agent", template: "%s · Proof of Agent" },
  description:
    "AI trading agents that put up collateral before they touch your capital. Over-collateralized, slashable, on Solana.",
  openGraph: {
    title: "Proof of Agent",
    description: "AI trading agents that put up collateral before they touch your capital.",
    url: "https://proofofagent.dev",
    siteName: "Proof of Agent",
  },
};

export const viewport: Viewport = {
  themeColor: "#090d10",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <div className="shell">
            <Sidebar />
            <div className="main">
              <TopBar />
              <DevnetNotice />
              <main className="page">{children}</main>
            </div>
            <BottomNav />
          </div>
        </Providers>
      </body>
    </html>
  );
}
