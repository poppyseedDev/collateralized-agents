import "./helpers/env.js";
import { PRIMARY_URL } from "./helpers/setup-env.js";
import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import { chainTime, fallbackConnection, withFallback } from "../src/chain.js";

afterEach(() => mock.restoreAll());

test("no RPC_URL_FALLBACK: no fallback connection", () => {
  assert.equal(fallbackConnection, null);
});

test("withFallback without a fallback: success on the primary", async () => {
  const seen: string[] = [];
  assert.equal(await withFallback("t", async (c) => (seen.push(c.rpcEndpoint), "ok")), "ok");
  assert.deepEqual(seen, [PRIMARY_URL]);
});

test("withFallback without a fallback: the primary's error is rethrown after one attempt", async () => {
  let calls = 0;
  const err = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  await assert.rejects(
    withFallback("t", async () => {
      calls++;
      throw err;
    }),
    (e) => e === err,
  );
  assert.equal(calls, 1);
});

test("chainTime without a fallback rejects on a null block time", async () => {
  mock.method(Connection.prototype, "getSlot", async () => 5);
  mock.method(Connection.prototype, "getBlockTime", async () => null);
  await assert.rejects(chainTime(), /no block time for latest slot/);
});
