import type { NextConfig } from "next";

const CANONICAL_HOST = "proofofagent.dev";
const OLD_HOSTS = ["collateralizedagents.com", "www.collateralizedagents.com", "www.proofofagent.dev"];

const nextConfig: NextConfig = {
  reactCompiler: true,
  turbopack: {},
  agentRules: false,
  // Old domain and www variants redirect permanently to the canonical host.
  async redirects() {
    return OLD_HOSTS.map((host) => ({
      source: "/:path*",
      has: [{ type: "host" as const, value: host }],
      destination: `https://${CANONICAL_HOST}/:path*`,
      permanent: true,
    }));
  },
};

export default nextConfig;
