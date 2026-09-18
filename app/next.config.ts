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
