/**
 * Agent definitions. Each entry becomes one on-chain agent with its own key
 * in keys/<id>.json, and one independent loop in the runner.
 */
export type Strategy =
  | {
      /** Sell SOL on the Orca pool that pays the most USDC, buy it back on the pool that pays the most SOL. */
      kind: "arbitrage";
      /** Minimum round-trip gain before trading, in bps. */
      minEdgeBps: number;
      /** Share of each position's SOL used per round trip, in bps. */
      sizeBps: number;
    }
  | {
      /** Move into USDC when price falls below its moving average, back into SOL when it recovers. */
      kind: "momentum";
      window: number;
      bandBps: number;
      sizeBps: number;
    }
  | {
      /** Hold a fixed share in USDC for the life of the position. */
      kind: "rotate";
      sizeBps: number;
    };

export type AgentConfig = {
  id: string;
  /** On-chain agent index under the operator key. */
  agentId: number;
  name: string;
  description: string;
  collateralRatioBps: number;
  /** Performance fee, at most half the collateral ratio. */
  feeBps: number;
  toleranceBps: number;
  /** Deadline window offered to traders, in seconds. */
  minDurationSecs: number;
  maxDurationSecs: number;
  /** Trading rules published on-chain with the agent. */
  rules: string;
  /** SOL posted as collateral at startup (topped up to this amount). */
  bondSol: number;
  /** Extra SOL the agent keeps for fees and token account rent. */
  gasSol: number;
  /** Settle this long after drawing, even if the deadline is later. */
  holdSecs: number;
  strategy: Strategy;
};

export const AGENTS: AgentConfig[] = [
  {
    id: "orca-arb",
    agentId: 1,
    name: "Orca Pool Arbitrage",
    description: "Buys SOL where Orca devnet pools price it lowest, sells where highest",
    collateralRatioBps: 5000,
    feeBps: 2500,
    toleranceBps: 500,
    minDurationSecs: 30 * 60,
    maxDurationSecs: 7 * 86_400,
    rules: [
      "Trades SOL and devnet USDC on Orca whirlpools only.",
      "Sells SOL on the pool paying the most USDC and buys it back on the pool paying the most SOL, only when the round trip gains at least 0.5%.",
      "Uses at most half of a position per round trip, up to three round trips.",
      "Holds everything in SOL between trades. Settles about 15 minutes after drawing, or before the deadline.",
    ].join("\n"),
    bondSol: 0.8,
    gasSol: 0.12,
    holdSecs: 15 * 60,
    strategy: { kind: "arbitrage", minEdgeBps: 50, sizeBps: 5000 },
  },
  {
    id: "orca-momentum",
    agentId: 1,
    name: "Orca Momentum",
    description: "Rotates into USDC when SOL dips below its moving average",
    collateralRatioBps: 3000,
    feeBps: 1500,
    toleranceBps: 1500,
    minDurationSecs: 30 * 60,
    maxDurationSecs: 7 * 86_400,
    rules: [
      "Trades SOL and devnet USDC on Orca whirlpools only.",
      "Moves 60% of a position into USDC when the SOL price falls 0.3% below its 10-sample average, and back when it rises 0.3% above.",
      "No leverage. Settles about 20 minutes after drawing, or before the deadline.",
    ].join("\n"),
    bondSol: 0.6,
    gasSol: 0.12,
    holdSecs: 20 * 60,
    strategy: { kind: "momentum", window: 10, bandBps: 30, sizeBps: 6000 },
  },
  {
    id: "orca-rotator",
    agentId: 1,
    name: "Half-Stable Rotator",
    description: "Keeps half of every position in devnet USDC",
    collateralRatioBps: 1000,
    feeBps: 500,
    toleranceBps: 3000,
    minDurationSecs: 30 * 60,
    maxDurationSecs: 7 * 86_400,
    rules: [
      "Trades SOL and devnet USDC on Orca whirlpools only.",
      "Swaps half of each position into USDC after drawing and back to SOL before settling.",
      "No leverage. Settles about 10 minutes after drawing, or before the deadline.",
    ].join("\n"),
    bondSol: 0.3,
    gasSol: 0.12,
    holdSecs: 10 * 60,
    strategy: { kind: "rotate", sizeBps: 5000 },
  },
];

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const POLL_MS = Number(process.env.POLL_MS ?? 30_000);

/** Orca devnet market. */
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k";
/** Deepest SOL/devUSDC whirlpool, used for the momentum price signal. */
export const MAIN_POOL = "2WUgXbAmhquXMLhqqUthztDaVYnG8Mmp57CkXNb5ym9G";
/**
 * SOL/devUSDC whirlpools that had liquidity when this was written. Listing them
 * avoids a program-wide scan, which the public devnet RPC rate-limits.
 * Pools that lose liquidity are skipped at runtime.
 */
export const POOLS = [
  MAIN_POOL,
  "3KBZiL2g8C7tiJ32hTv5v3KM7aK9htpqTw4cTXz1HvPt",
  "Bz7wxD47Y1pDQNAmT6SejSETj6o8SneWMUaFXERDB1fr",
  "26WuWhkPBhG5d6kZwHBTruLxLvbSe7C62qH21zpisP9c",
  "A68ZcUxXqDwkRvAFbYjuutfBAQotGg4YfGgocHMg2J8S",
];
export const SLIPPAGE_BPS = 300;
