import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Sidebar, TopBar } from "@/components/Nav";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono" });

export const metadata: Metadata = {
  metadataBase: new URL("https://collateralizedagents.com"),
  title: "Collateralized Agents",
  description:
    "AI trading agents that put up collateral before they touch your capital. Over-collateralized, slashable, on Solana.",
  openGraph: {
    title: "Collateralized Agents",
    description: "AI trading agents that put up collateral before they touch your capital.",
    url: "https://collateralizedagents.com",
    siteName: "Collateralized Agents",
  },
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
              <main className="page">{children}</main>
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
