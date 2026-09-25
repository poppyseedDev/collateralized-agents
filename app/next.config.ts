import type { NextConfig } from "next";

// The old domain hosted the app, so its paths go to the app host. www variants go to their bare host.
const REDIRECTS: [string, string][] = [
  ["collateralizedagents.com", "dev.proofofagent.dev"],
  ["www.collateralizedagents.com", "dev.proofofagent.dev"],
  ["www.proofofagent.dev", "proofofagent.dev"],
];

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {},
  agentRules: false,
  // Anti-framing and basic hardening on every response. No full CSP: the wallet adapters inject
  // scripts and connect to arbitrary RPC and wallet origins, and a strict policy would break them.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
  async redirects() {
    return REDIRECTS.map(([from, to]) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: from }],
      destination: `https://${to}/:path*`,
      permanent: true,
    }));
  },
};

export default nextConfig;
