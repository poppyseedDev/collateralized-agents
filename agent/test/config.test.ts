import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import * as config from "../src/config.js";

type Config = typeof config;
let n = 0;
/** A fresh copy of config.ts, evaluated with `env` applied. */
async function loadWith(env: Record<string, string | undefined>): Promise<Config> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    const url = new URL(`../src/config.ts?fresh=${++n}`, import.meta.url).href;
    return (await import(url)) as Config;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("defaults when the env is unset", async () => {
  const c = await loadWith({ RPC_URL: undefined, RPC_URL_FALLBACK: undefined, POLL_MS: undefined, SLIPPAGE_BPS: undefined });
  assert.equal(c.SLIPPAGE_BPS, 50);
  assert.equal(c.POLL_MS, 30_000);
  assert.equal(c.RPC_URL, "https://api.devnet.solana.com");
  assert.equal(c.RPC_URL_FALLBACK, null);
});

test("env overrides", async () => {
  const c = await loadWith({ RPC_URL: "http://a", RPC_URL_FALLBACK: "http://b", POLL_MS: "5000", SLIPPAGE_BPS: "120" });
  assert.equal(c.SLIPPAGE_BPS, 120);
  assert.equal(c.POLL_MS, 5000);
  assert.equal(c.RPC_URL, "http://a");
  assert.equal(c.RPC_URL_FALLBACK, "http://b");
});

test("an empty RPC_URL_FALLBACK means no fallback", async () => {
  const c = await loadWith({ RPC_URL_FALLBACK: "" });
  assert.equal(c.RPC_URL_FALLBACK, null);
});

test("empty numeric env values fall back to defaults", async () => {
  const c = await loadWith({ POLL_MS: "", SLIPPAGE_BPS: " " });
  assert.equal(c.POLL_MS, 30_000);
  assert.equal(c.SLIPPAGE_BPS, 50);
});

test("invalid or out-of-range numeric env values stop the runner with a clear error", async () => {
  const bad: Record<string, string>[] = [
    { POLL_MS: "abc" },
    { POLL_MS: "0" },
    { POLL_MS: "-5000" },
    { POLL_MS: "999" },
    { POLL_MS: "Infinity" },
    { POLL_MS: "1e10" },
    { SLIPPAGE_BPS: "abc" },
    { SLIPPAGE_BPS: "0" },
    { SLIPPAGE_BPS: "-1" },
    { SLIPPAGE_BPS: "12.5" },
    { SLIPPAGE_BPS: "1001" },
  ];
  for (const env of bad) {
    const [name] = Object.keys(env);
    await assert.rejects(loadWith(env), new RegExp(`^Error: ${name}=.* is invalid: expected a whole number from`), JSON.stringify(env));
  }
});

test("numeric env bounds are inclusive", async () => {
  const lo = await loadWith({ POLL_MS: "1000", SLIPPAGE_BPS: "1" });
  assert.equal(lo.POLL_MS, 1000);
  assert.equal(lo.SLIPPAGE_BPS, 1);
  const hi = await loadWith({ POLL_MS: "3600000", SLIPPAGE_BPS: "1000" });
  assert.equal(hi.POLL_MS, 3_600_000);
  assert.equal(hi.SLIPPAGE_BPS, 1000);
});

test("constants the runner's timing relies on", () => {
  assert.equal(config.SETTLE_BUFFER_SECS, 5 * 60);
  assert.equal(config.ALERT_WINDOW_SECS, 10 * 60);
  assert.ok(config.POOLS.includes(config.MAIN_POOL));
});

test("agent configs are consistent", () => {
  const ids = new Set<string>();
  for (const a of config.AGENTS) {
    assert.ok(!ids.has(a.id), `duplicate id ${a.id}`);
    ids.add(a.id);
    assert.ok(a.feeBps * 2 <= a.collateralRatioBps, `${a.id}: fee is more than half the collateral ratio`);
    assert.ok(a.minDurationSecs <= a.maxDurationSecs, a.id);
    // a position at the minimum duration must still be drawable (deadline - buffer - 2 min)
    assert.ok(a.minDurationSecs > config.SETTLE_BUFFER_SECS + 120, a.id);
  }
});
