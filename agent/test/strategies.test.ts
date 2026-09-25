import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENTS } from "../src/config.js";
import { arbitrageEdge, arbitrageStep, leg2MinOut, momentumAction, rotateAction, share } from "../src/strategies.js";

const SOL = 1_000_000_000n;
const rotate = { kind: "rotate", sizeBps: 5000 } as const;
const momentum = { kind: "momentum", window: 10, bandBps: 30, sizeBps: 6000 } as const;
const arb = { kind: "arbitrage", minEdgeBps: 50, sizeBps: 5000 } as const;

test("the strategies match the configured agents", () => {
  assert.deepEqual(AGENTS.map((a) => a.strategy), [arb, momentum, rotate]);
});

test("share rounds down", () => {
  assert.equal(share(SOL, 5000), SOL / 2n);
  assert.equal(share(3n, 5000), 1n);
  assert.equal(share(0n, 5000), 0n);
});

test("rotate: sells half the SOL on the first cycle only", () => {
  assert.deepEqual(rotateAction(rotate, { cycles: 0, sol: 2n * SOL }), { side: "SOL", amount: SOL, bumpCycle: true });
  assert.equal(rotateAction(rotate, { cycles: 1, sol: 2n * SOL }), null);
  // an empty book gives a zero amount, which swap() skips
  assert.equal(rotateAction(rotate, { cycles: 0, sol: 0n })?.amount, 0n);
});

/** Series as the runner builds it: the current price is already the last sample. */
const series = (...xs: number[]) => xs;
const flat = (n: number, p = 150) => Array.from({ length: n }, () => p);
const book = (sol: bigint, usdc = 0n) => ({ sol, usdc });

test("momentum: no price, no action", () => {
  assert.equal(momentumAction(momentum, flat(20), null, book(SOL)), null);
});

test("momentum: first tick and too few samples, no action", () => {
  assert.equal(momentumAction(momentum, series(100), 100, book(SOL)), null);
  assert.equal(momentumAction(momentum, series(), 100, book(SOL)), null);
  // 9 samples, even with a crash on the last one
  assert.equal(momentumAction(momentum, [...flat(8), 50], 50, book(SOL)), null);
});

test("momentum: flat price, no action either way", () => {
  assert.equal(momentumAction(momentum, flat(10), 150, book(SOL)), null);
  assert.equal(momentumAction(momentum, flat(50), 150, book(SOL, 1_000_000n)), null);
});

test("momentum: a drop below the band sells sizeBps of SOL into USDC", () => {
  const prices = [...flat(9), 140];
  const a = momentumAction(momentum, prices, 140, book(10n * SOL));
  assert.equal(a?.side, "SOL");
  assert.equal(a?.amount, 6n * SOL);
  assert.equal(a?.bumpCycle, true);
  assert.match(a?.note ?? "", /^risk-off: price 140\.000 < SMA 149\.000/);
});

test("momentum: a drop inside the band does nothing", () => {
  // SMA of 9×150 and 149.8 is 149.98; the band's floor is 149.98 × 0.997 ≈ 149.53
  assert.equal(momentumAction(momentum, [...flat(9), 149.8], 149.8, book(SOL)), null);
});

test("momentum: already in USDC, a further drop does not sell again", () => {
  assert.equal(momentumAction(momentum, [...flat(9), 140], 140, book(SOL, 5_000_000n)), null);
});

test("momentum: a rise above the band buys back all the USDC", () => {
  const a = momentumAction(momentum, [...flat(9), 160], 160, book(SOL, 5_000_000n));
  assert.deepEqual({ side: a?.side, amount: a?.amount, bumpCycle: a?.bumpCycle }, { side: "USDC", amount: 5_000_000n, bumpCycle: undefined });
  assert.match(a?.note ?? "", /^risk-on/);
});

test("momentum: a rise with nothing in USDC does nothing", () => {
  assert.equal(momentumAction(momentum, [...flat(9), 160], 160, book(SOL)), null);
});

test("momentum: only the last `window` samples count", () => {
  // old high prices outside the window must not drag the SMA up
  const prices = [...flat(50, 300), ...flat(9, 150), 150];
  assert.equal(momentumAction(momentum, prices, 150, book(SOL)), null);
});

test("arbitrage step: USDC left from a round trip is unwound first", () => {
  assert.deepEqual(arbitrageStep(arb, { cycles: 3, sol: SOL, usdc: 7n }), { kind: "unwind", amount: 7n });
});

test("arbitrage step: at most three round trips", () => {
  assert.deepEqual(arbitrageStep(arb, { cycles: 3, sol: SOL, usdc: 0n }), { kind: "done" });
  assert.deepEqual(arbitrageStep(arb, { cycles: 2, sol: SOL, usdc: 0n }), { kind: "quote", size: SOL / 2n });
});

const q = (pool: string, out: bigint, minOut = (out * 9950n) / 10_000n) => ({ pool, out, minOut });

test("arbitrage edge: trades only at or above minEdgeBps across two pools", () => {
  const size = SOL;
  const leg1 = q("A", 150_000_000n);
  assert.deepEqual(arbitrageEdge(arb, size, leg1, q("B", size + size / 200n)), { edgeBps: 50, go: true });
  assert.deepEqual(arbitrageEdge(arb, size, leg1, q("B", size + size / 250n)), { edgeBps: 40, go: false });
  assert.deepEqual(arbitrageEdge(arb, size, leg1, q("A", 2n * size)), { edgeBps: 10_000, go: false }, "same pool");
  assert.equal(arbitrageEdge(arb, size, leg1, q("B", size - 1n)).go, false, "a losing round trip");
});

test("arbitrage leg 2: aborted when leg 1 misses its quote", () => {
  const leg1 = q("A", 150_000_000n);
  const leg2 = q("B", 1_010_000_000n, 1_000_000_000n);
  assert.equal(leg2MinOut(leg1, leg2, 149_999_999n), null);
  assert.equal(leg2MinOut(leg1, leg2, 0n), null);
});

test("arbitrage leg 2: minOut from its evaluated quote, scaled to what leg 1 returned", () => {
  const leg1 = q("A", 150_000_000n);
  const leg2 = q("B", 1_010_000_000n, 1_000_000_000n);
  assert.equal(leg2MinOut(leg1, leg2, 150_000_000n), 1_000_000_000n);
  assert.equal(leg2MinOut(leg1, leg2, 165_000_000n), 1_100_000_000n);
});
