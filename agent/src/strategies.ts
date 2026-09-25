/**
 * Pure trading decisions for each strategy. The runner quotes, swaps and books;
 * these functions only decide what to do from the book, the price series and quotes.
 */
import type { Strategy } from "./config.js";

type Of<K extends Strategy["kind"]> = Extract<Strategy, { kind: K }>;

/** `bps` of `amount`, rounded down. */
export const share = (amount: bigint, bps: number) => (amount * BigInt(bps)) / 10_000n;

/** Sell `amount` of `side`. */
export type SwapAction = { side: "SOL" | "USDC"; amount: bigint; bumpCycle?: boolean; note?: string };

/** Rotate: one swap of a fixed share of SOL into USDC, on the first cycle only. */
export function rotateAction(s: Of<"rotate">, book: { cycles: number; sol: bigint }): SwapAction | null {
  if (book.cycles !== 0) return null;
  return { side: "SOL", amount: share(book.sol, s.sizeBps), bumpCycle: true };
}

/**
 * Momentum: `prices` already includes this tick's `price`. Sells SOL when the price is
 * `bandBps` below its `window`-sample average (and nothing is in USDC yet), buys it
 * back when the price is `bandBps` above.
 */
export function momentumAction(
  s: Of<"momentum">,
  prices: number[],
  price: number | null,
  book: { sol: bigint; usdc: bigint },
): SwapAction | null {
  if (price === null || prices.length < s.window) return null;
  const recent = prices.slice(-s.window);
  const sma = recent.reduce((a, b) => a + b, 0) / recent.length;
  const band = s.bandBps / 10_000;
  if (book.usdc === 0n && price < sma * (1 - band)) {
    return { side: "SOL", amount: share(book.sol, s.sizeBps), bumpCycle: true, note: `risk-off: price ${price.toFixed(3)} < SMA ${sma.toFixed(3)}` };
  }
  if (book.usdc > 0n && price > sma * (1 + band)) {
    return { side: "USDC", amount: book.usdc, note: `risk-on: price ${price.toFixed(3)} > SMA ${sma.toFixed(3)}` };
  }
  return null;
}

/** Arbitrage step before quoting: finish a round trip left in USDC, stop after three cycles, or size the next one. */
export function arbitrageStep(
  s: Of<"arbitrage">,
  book: { cycles: number; sol: bigint; usdc: bigint },
): { kind: "unwind"; amount: bigint } | { kind: "done" } | { kind: "quote"; size: bigint } {
  if (book.usdc > 0n) return { kind: "unwind", amount: book.usdc };
  if (book.cycles >= 3) return { kind: "done" };
  return { kind: "quote", size: share(book.sol, s.sizeBps) };
}

type LegQuote = { pool: string; out: bigint; minOut: bigint };

/** Round-trip edge in bps of `size`, and whether it is worth trading (enough edge, two different pools). */
export function arbitrageEdge(s: Of<"arbitrage">, size: bigint, leg1: LegQuote, leg2: LegQuote) {
  const edgeBps = Number(((leg2.out - size) * 10_000n) / size);
  return { edgeBps, go: !(edgeBps < s.minEdgeBps || leg1.pool === leg2.pool) };
}

/**
 * Leg 2's minimum output, from its evaluated quote scaled to what leg 1 actually returned.
 * Null when leg 1 returned less than its quote: abort the round trip.
 */
export function leg2MinOut(leg1: LegQuote, leg2: LegQuote, leg1Got: bigint): bigint | null {
  if (leg1Got < leg1.out) return null;
  return (leg2.minOut * leg1Got) / leg1.out;
}
