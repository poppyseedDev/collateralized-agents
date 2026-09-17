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
  name: string;
  description: string;
  collateralRatioBps: number;
  toleranceBps: number;
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
    name: "Orca Pool Arbitrage",
    description: "Buys SOL where Orca devnet pools price it lowest, sells where highest",
    collateralRatioBps: 5000,
    toleranceBps: 500,
    bondSol: 0.8,
    gasSol: 0.12,
    holdSecs: 15 * 60,
    strategy: { kind: "arbitrage", minEdgeBps: 50, sizeBps: 5000 },
  },
  {
    id: "orca-momentum",
    name: "Orca Momentum",
    description: "Rotates into USDC when SOL dips below its moving average",
    collateralRatioBps: 3000,
    toleranceBps: 1500,
    bondSol: 0.6,
    gasSol: 0.12,
    holdSecs: 20 * 60,
    strategy: { kind: "momentum", window: 10, bandBps: 30, sizeBps: 6000 },
  },
  {
    id: "orca-rotator",
    name: "Half-Stable Rotator",
    description: "Keeps half of every position in devnet USDC",
    collateralRatioBps: 1000,
    toleranceBps: 3000,
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
