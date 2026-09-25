/** Command-line parsing for `poa`, kept apart from cli.ts so it can be tested without running a command. */
import { parseArgs } from "node:util";

export const OPTIONS = {
  rpc: { type: "string" }, key: { type: "string" }, agent: { type: "string" }, id: { type: "string", default: "1" },
  name: { type: "string" }, description: { type: "string", default: "" }, ratio: { type: "string" }, fee: { type: "string" },
  drawdown: { type: "string" }, "min-hours": { type: "string", default: "1" }, "max-days": { type: "string", default: "7" },
  assets: { type: "string", default: "SOL,USDC" }, rules: { type: "string" }, sol: { type: "string" }, "trading-key": { type: "string" },
  hook: { type: "string" }, notify: { type: "string" }, "hold-min": { type: "string", default: "15" }, "buffer-min": { type: "string", default: "5" },
  "grace-sec": { type: "string", default: "60" }, position: { type: "string" },
  paper: { type: "boolean", default: false }, poll: { type: "string", default: "15" }, minutes: { type: "string", default: "30" },
  out: { type: "string", default: "trading.json" }, state: { type: "string", default: ".poa/state.json" }, help: { type: "boolean", default: false },
} as const;

/** Parses `args` (default: this process's arguments). Unknown options throw. */
export function parseCli(args?: string[]) {
  return parseArgs({ args, allowPositionals: true, options: OPTIONS });
}

export type CliValues = ReturnType<typeof parseCli>["values"];

/** A non-negative finite number, or a clear error naming the option. */
function nonNegative(s: string, name: string) {
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number (got ${s})`);
  return n;
}

/**
 * The runner's timing options in seconds and milliseconds. A value that does not
 * parse is an error: a NaN settle time would never come due and miss the deadline.
 */
export function runnerTiming(v: CliValues) {
  const pollMs = parseInt(v.poll!, 10) * 1000;
  if (!(pollMs > 0)) throw new Error(`--poll must be a whole number of seconds above 0 (got ${v.poll})`);
  return {
    holdSecs: Math.round(nonNegative(v["hold-min"]!, "hold-min") * 60),
    bufferSecs: Math.round(nonNegative(v["buffer-min"]!, "buffer-min") * 60),
    graceSecs: Math.round(nonNegative(v["grace-sec"]!, "grace-sec")),
    pollMs,
  };
}

const SOL_RE = /^\d+(\.\d{1,9})?$/;

/** An exact SOL amount in lamports. Strict: "1,5", "1e3", "-1", " 1" or more than 9 decimals are errors, not a silently different amount. */
export function parseSol(s: string, name = "sol"): bigint {
  if (!SOL_RE.test(s)) throw new Error(`--${name} must be a SOL amount like 1.5, with at most 9 decimals (got ${s})`);
  const [whole, frac = ""] = s.split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(frac.padEnd(9, "0"));
}

/** A whole non-negative id, strict: "1.5" or "1a" is an error rather than 1. */
export function parseId(s: string, name = "id"): number {
  const n = /^\d+$/.test(s) ? Number(s) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be a whole number (got ${s})`);
  return n;
}

/** A percentage in basis points, exact to 0.01%. */
export function parsePercentBps(s: string, name: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`--${name} must be a percentage like 12.5, with at most 2 decimals (got ${s})`);
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** A plain non-negative decimal such as 1 or 0.5, strict (no commas, exponents or signs), scaled and rounded to a whole number. */
export function parseScaled(s: string, name: string, scale: number): number {
  const n = /^\d+(\.\d+)?$/.test(s) ? Math.round(Number(s) * scale) : NaN;
  if (!Number.isSafeInteger(n)) throw new Error(`--${name} must be a non-negative number like 1 or 0.5 (got ${s})`);
  return n;
}
