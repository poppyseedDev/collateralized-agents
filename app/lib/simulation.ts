// Results of the operator risk simulation in sim/.
// Regenerate with: python3 sim/run.py && python3 sim/export_web.py
import data from "./simulation.json";

export type StrategyKind = "baseline" | "ordinary" | "bad" | "dishonest";

export type SimStrategy = {
  key: string;
  label: string;
  description: string;
  kind: StrategyKind;
};

export type SimCell = {
  /** Share of positions where collateral was paid out. */
  breach: number;
  /** Average amount slashed, as a fraction of the bond reserved. */
  slash: number;
  /** Average trader return over the position, in SOL terms. */
  trader: number;
  /** Operator's annual return on a fully deployed bond. */
  apr: number;
};

const meta = data.meta;
const strategies = data.strategies as SimStrategy[];
const cells = data.cells;

export const SIM = {
  source: meta.source,
  firstDate: meta.firstDate,
  lastDate: meta.lastDate,
  candles: meta.candles,
  swapCostBps: meta.swapCostBps,
  positionsPerCell: meta.positionsPerCell,
  durations: meta.durations as number[],
  drawdowns: meta.drawdowns as number[],
  ratios: meta.ratios as number[],
  strategies,
};

/** Cells are packed strategy -> duration -> drawdown -> ratio. */
function indexOf(strategy: string, duration: number, drawdownBps: number, ratioBps: number) {
  const s = strategies.findIndex((x) => x.key === strategy);
  const d = SIM.durations.indexOf(duration);
  const dd = SIM.drawdowns.indexOf(drawdownBps);
  const r = SIM.ratios.indexOf(ratioBps);
  if (s < 0 || d < 0 || dd < 0 || r < 0) return -1;
  return ((s * SIM.durations.length + d) * SIM.drawdowns.length + dd) * SIM.ratios.length + r;
}

export function lookup(
  strategy: string,
  duration: number,
  drawdownBps: number,
  ratioBps: number,
): SimCell | null {
  const i = indexOf(strategy, duration, drawdownBps, ratioBps);
  if (i < 0) return null;
  return {
    breach: cells.breach[i],
    slash: cells.slash[i],
    trader: cells.trader[i],
    apr: cells.apr[i],
  };
}

/** Tightest drawdown tolerance a strategy can publish and still profit. */
const safe = new Map<string, number | null>();
for (const row of data.safeDrawdown as { strategy: string; duration_days: number; safe_drawdown_bps: number | null }[]) {
  safe.set(`${row.strategy}|${row.duration_days}`, row.safe_drawdown_bps);
}

export function safeDrawdown(strategy: string, duration: number): number | null {
  return safe.get(`${strategy}|${duration}`) ?? null;
}
