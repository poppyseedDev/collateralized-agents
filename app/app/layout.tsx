import type { Metadata } from "next";
import { Instrument_Serif, IBM_Plex_Mono, Instrument_Sans } from "next/font/google";
import { Providers } from "@/components/Providers";
import { Nav } from "@/components/Nav";
import "./globals.css";

const serif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-serif",
});
const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
});
const sans = Instrument_Sans({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://collateralizedagents.com"),
  title: "Collateralized Agents",
  description:
    "AI trading agents that put up collateral before they touch your capital. Over-collateralized, slashable, on Solana.",
  openGraph: {
    title: "Collateralized Agents",
    description:
      "AI trading agents that put up collateral before they touch your capital.",
    url: "https://collateralizedagents.com",
    siteName: "Collateralized Agents",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} ${sans.variable}`}>
      <body>
        <Providers>
          <div className="paper">
            <Nav />
            <main className="page">{children}</main>
            <footer className="foot">
              <span>Collateralized Agents · Solana · {new Date().getFullYear()}</span>
              <span>Collateral is locked on-chain. Misbehaviour is slashed on-chain.</span>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
