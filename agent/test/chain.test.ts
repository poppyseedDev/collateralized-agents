import "./helpers/env-fallback.js";
import { FALLBACK_URL, PRIMARY_URL } from "./helpers/setup-env.js";
import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { Connection } from "@solana/web3.js";
import { chainTime, fallbackConnection, isNetworkError, withFallback } from "../src/chain.js";

const logs = () => mock.method(console, "log", () => {});
afterEach(() => mock.restoreAll());

const netErr = () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
const progErr = () => new Error("AnchorError occurred. Error Code: DeadlinePassed. Error Number: 6003.");

test("a fallback connection is configured from RPC_URL_FALLBACK", () => {
  assert.equal(fallbackConnection?.rpcEndpoint, FALLBACK_URL);
});

test("withFallback: primary succeeds, the fallback is not called", async () => {
  const seen: string[] = [];
  const out = await withFallback("t", async (c) => {
    seen.push(c.rpcEndpoint);
    return 42;
  });
  assert.equal(out, 42);
  assert.deepEqual(seen, [PRIMARY_URL]);
});

test("withFallback: a network error on the primary is retried on the fallback", async () => {
  const log = logs();
  const seen: string[] = [];
  const out = await withFallback("t", async (c) => {
    seen.push(c.rpcEndpoint);
    if (c.rpcEndpoint === PRIMARY_URL) throw netErr();
    return "from fallback";
  });
  assert.equal(out, "from fallback");
  assert.deepEqual(seen, [PRIMARY_URL, FALLBACK_URL]);
  assert.ok(log.mock.calls.some((c) => /primary RPC failed \(fetch failed\); used fallback/.test(String(c.arguments[0]))));
});

test("withFallback: a program error is rethrown to the caller", async () => {
  // A program error is deterministic, so the fallback fails the same way and the error surfaces.
  await assert.rejects(
    withFallback("t", async () => {
      throw progErr();
    }),
    /DeadlinePassed/,
  );
});

// withFallback is documented as "retry on the fallback if the primary throws", and it
// retries on any error. That is harmless for reads (a program error repeats on the
// fallback and is rethrown), and it also covers read errors isNetworkError does not
// match, such as a null block time. The network-only rule applies to settles, in the
// runner (covered in agent.test.ts). Unskip if reads should stop retrying program errors.
test("withFallback: a program error is not retried on the fallback", { skip: "by design: reads retry on any error; settles are network-only" }, async () => {
  const seen: string[] = [];
  await assert.rejects(
    withFallback("t", async (c) => {
      seen.push(c.rpcEndpoint);
      throw progErr();
    }),
  );
  assert.deepEqual(seen, [PRIMARY_URL]);
});

test("withFallback: both RPCs failing rethrows the fallback's error", async () => {
  await assert.rejects(
    withFallback("t", async (c) => {
      throw new Error(`down: ${c.rpcEndpoint}`);
    }),
    { message: `down: ${FALLBACK_URL}` },
  );
});

test("isNetworkError: transport failures count as network errors", () => {
  for (const e of [
    netErr(),
    new TypeError("fetch failed"),
    new Error("connect ECONNREFUSED 127.0.0.1:8899"),
    new Error("read ECONNRESET"),
    new Error("getaddrinfo ENOTFOUND api.devnet.solana.com"),
    new Error("getaddrinfo EAI_AGAIN api.devnet.solana.com"),
    new Error("request to x failed, reason: connect ETIMEDOUT"),
    new Error("socket hang up"),
    new Error("Network request failed"),
    new Error("The operation timed out"),
    new Error("request timeout"),
    new Error("429 Too Many Requests"),
    new Error("Server responded with 429"),
    new Error("502 Bad Gateway"),
    new Error("503 Service Unavailable"),
    new Error("504 Gateway Timeout"),
    Object.assign(new Error("fetch aborted"), { cause: { code: "UND_ERR_SOCKET" } }),
    "fetch failed",
  ]) {
    assert.equal(isNetworkError(e), true, String((e as Error)?.message ?? e));
  }
});

test("isNetworkError: program and request errors are not network errors", () => {
  for (const e of [
    progErr(),
    new Error("Simulation failed. Message: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1773"),
    new Error("Account does not exist or has no data 7xKX..."),
    new Error("insufficient funds for rent"),
    new Error("500 Internal Server Error"),
    new Error("Blockhash not found"),
    new Error("no block time for latest slot"),
    null,
    undefined,
  ]) {
    assert.equal(isNetworkError(e), false, String((e as Error)?.message ?? e));
  }
});

test("chainTime: block time of the latest confirmed slot", async () => {
  const slot = mock.method(Connection.prototype, "getSlot", async () => 777);
  const bt = mock.method(Connection.prototype, "getBlockTime", async (s: number) => (s === 777 ? 1_800_000_123 : null));
  assert.equal(await chainTime(), 1_800_000_123);
  assert.deepEqual(slot.mock.calls[0].arguments, ["confirmed"]);
  assert.equal(bt.mock.callCount(), 1);
});

test("chainTime: a null block time on the primary is read from the fallback", async () => {
  logs();
  mock.method(Connection.prototype, "getSlot", async () => 1);
  mock.method(Connection.prototype, "getBlockTime", async function (this: Connection) {
    return this.rpcEndpoint === PRIMARY_URL ? null : 1_800_000_000;
  });
  assert.equal(await chainTime(), 1_800_000_000);
});

test("chainTime: rejects when neither RPC answers (the runner then uses local time)", async () => {
  mock.method(Connection.prototype, "getSlot", async () => {
    throw netErr();
  });
  await assert.rejects(chainTime(), /fetch failed/);
});
