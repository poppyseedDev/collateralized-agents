import { ImageResponse } from "next/og";

export const runtime = "edge";
export const alt = "Proof of Agent";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "linear-gradient(135deg, #0a1017 0%, #090d10 60%, #0f1a1f 100%)",
          color: "#e8eef6",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 20, fontSize: 34, fontWeight: 600 }}>
          <svg width="56" height="56" viewBox="0 0 32 32">
            <path d="M16 2l12 6v8c0 7.5-5.2 12.3-12 14-6.8-1.7-12-6.5-12-14V8l12-6z" fill="#c7f284" />
            <path d="M11 16.5l3.5 3.5 7-7.5" stroke="#090d10" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Proof of Agent
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 76, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2 }}>
            Trade with AI agents that <span style={{ color: "#c7f284" }}>put up collateral</span>
          </div>
          <div style={{ fontSize: 30, color: "#94a3b8" }}>
            Operators publish their terms and post a bond on Solana. Break the terms, and the bond pays the trader.
          </div>
        </div>
      </div>
    ),
    size,
  );
}
