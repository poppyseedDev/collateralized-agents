import "./helpers/env.js";
import { afterEach, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { connection } from "../src/chain.js";
import { USDC_MINT } from "../src/config.js";
import { resolveSwap, withRetry } from "../src/orca.js";

const OWNER = "Owner1111111111111111111111111111111111111";
const OTHER = "Other1111111111111111111111111111111111111";
const pending = (side: "SOL" | "USDC", amountIn: string, lastValidBlockHeight = 1000) => ({
  sig: "sig1",
  lastValidBlockHeight,
  side,
  in: amountIn,
});

const tok = (owner: string, mint: string, amount: string) => ({ owner, mint, uiTokenAmount: { amount } });

/** Meta of a SOL->USDC swap: wallet pays 5000 fee + rent, owner gains 3_000_000 USDC. */
const sellSolMeta = {
  err: null,
  fee: 5000,
  preBalances: [10_000_000_000, 1],
  postBalances: [8_997_000_000, 1],
  preTokenBalances: [tok(OWNER, USDC_MINT, "1000000"), tok(OTHER, USDC_MINT, "999"), tok(OWNER, "OtherMint", "5")],
  postTokenBalances: [tok(OWNER, USDC_MINT, "4000000"), tok(OTHER, USDC_MINT, "1"), tok(OWNER, "OtherMint", "0")],
};
/** Meta of a USDC->SOL swap: wallet gains 1 SOL net of the 5000 fee. */
const buySolMeta = {
  err: null,
  fee: 5000,
  preBalances: [2_000_000_000],
  postBalances: [2_999_995_000],
  preTokenBalances: [tok(OWNER, USDC_MINT, "3000000")],
  postTokenBalances: [tok(OWNER, USDC_MINT, "0")],
};

type Status = { confirmationStatus?: string; err: unknown } | null;
function chain(opts: { status: Status; tx?: unknown; height?: number }) {
  const calls = { status: 0, tx: 0, height: 0 };
  mock.method(connection, "getSignatureStatuses", async (sigs: string[], cfg: unknown) => {
    calls.status++;
    assert.deepEqual(sigs, ["sig1"]);
    assert.deepEqual(cfg, { searchTransactionHistory: true });
    return { context: { slot: 1 }, value: [opts.status] };
  });
  mock.method(connection, "getTransaction", async () => {
    calls.tx++;
    return opts.tx ?? null;
  });
  mock.method(connection, "getBlockHeight", async () => {
    calls.height++;
    if (opts.height === undefined) throw new Error("getBlockHeight not expected");
    return opts.height;
  });
  return calls;
}

/** Runs `p` while advancing mocked timers, so fetchMeta's 1.5s retries do not wait. */
async function drain<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const out = p.finally(() => (done = true));
  out.catch(() => {}); // handled by the caller; avoid an unhandled rejection while ticking
  while (!done) {
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(1500);
  }
  return out;
}

beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test("landed and succeeded, selling SOL: SOL is -amountIn, USDC from the owner's token balances", async () => {
  const calls = chain({ status: { confirmationStatus: "confirmed", err: null }, tx: { meta: sellSolMeta } });
  const r = await drain(resolveSwap(pending("SOL", "1000000000"), OWNER));
  assert.deepEqual(r, { state: "landed", result: { signature: "sig1", solDelta: -1_000_000_000n, usdcDelta: 3_000_000n } });
  assert.equal(calls.height, 0);
});

test("landed and succeeded, buying SOL: SOL delta from pre/post balances excluding the fee", async () => {
  chain({ status: { confirmationStatus: "finalized", err: null }, tx: { meta: buySolMeta } });
  const r = await drain(resolveSwap(pending("USDC", "3000000"), OWNER));
  assert.deepEqual(r, { state: "landed", result: { signature: "sig1", solDelta: 1_000_000_000n, usdcDelta: -3_000_000n } });
});

test("landed but failed on-chain: failed, nothing booked", async () => {
  const calls = chain({ status: { confirmationStatus: "confirmed", err: { InstructionError: [1, { Custom: 6036 }] } } });
  const r = await drain(resolveSwap(pending("SOL", "1"), OWNER));
  assert.equal(r.state, "failed");
  assert.match((r as { reason: string }).reason, /failed on-chain.*6036/);
  assert.equal(calls.tx, 0);
});

test("seen but only processed: stays pending", async () => {
  chain({ status: { confirmationStatus: "processed", err: null } });
  const r = await drain(resolveSwap(pending("SOL", "1"), OWNER));
  assert.deepEqual(r, { state: "pending", reason: "status processed" });
});

test("not found, blockhash still valid: stays pending", async () => {
  const calls = chain({ status: null, height: 990 });
  const r = await drain(resolveSwap(pending("SOL", "1", 1000), OWNER));
  assert.equal(r.state, "pending");
  assert.match((r as { reason: string }).reason, /valid for 10 more blocks/);
  assert.equal(calls.tx, 0);
});

test("not found, at the last valid block height: still pending", async () => {
  chain({ status: null, height: 1000 });
  assert.equal((await drain(resolveSwap(pending("SOL", "1", 1000), OWNER))).state, "pending");
});

test("not found, blockhash expired: failed", async () => {
  const calls = chain({ status: null, height: 1001, tx: null });
  const r = await drain(resolveSwap(pending("SOL", "1", 1000), OWNER));
  assert.deepEqual(r, { state: "failed", reason: "blockhash expired without the swap landing" });
  assert.equal(calls.tx, 10); // checked once more (with retries) that it did not land meanwhile
});

test("not found, blockhash expired, but it did land in the meantime: landed", async () => {
  chain({ status: null, height: 1001, tx: { meta: sellSolMeta } });
  const r = await drain(resolveSwap(pending("SOL", "1000000000", 1000), OWNER));
  assert.equal(r.state, "landed");
});

test("not found, blockhash expired, landed but failed in the meantime: failed", async () => {
  chain({ status: null, height: 1001, tx: { meta: { ...sellSolMeta, err: { InstructionError: [0, "x"] } } } });
  assert.equal((await drain(resolveSwap(pending("SOL", "1", 1000), OWNER))).state, "failed");
});

test("found but the meta is missing: stays pending, SOL delta is not booked as 0", async () => {
  const calls = chain({ status: { confirmationStatus: "confirmed", err: null }, tx: { meta: null } });
  const r = await drain(resolveSwap(pending("USDC", "3000000"), OWNER));
  assert.deepEqual(r, { state: "pending", reason: "landed, transaction meta not available yet" });
  assert.equal("result" in r, false);
  assert.equal(calls.tx, 10);
});

test("found, transaction not indexed yet: stays pending", async () => {
  chain({ status: { confirmationStatus: "confirmed", err: null }, tx: null });
  assert.equal((await drain(resolveSwap(pending("SOL", "1"), OWNER))).state, "pending");
});

test("an RPC failure while resolving propagates (the book keeps its pending swap)", async () => {
  mock.method(connection, "getSignatureStatuses", async () => {
    throw new TypeError("fetch failed");
  });
  await assert.rejects(drain(resolveSwap(pending("SOL", "1"), OWNER)), /fetch failed/);
});

test("withRetry retries rate limits with backoff, not other errors", async () => {
  let n = 0;
  const out = await drain(
    withRetry(async () => {
      if (++n < 3) throw new Error("429 Too Many Requests");
      return "ok";
    }),
  );
  assert.equal(out, "ok");
  assert.equal(n, 3);

  let m = 0;
  await assert.rejects(
    drain(
      withRetry(async () => {
        m++;
        throw new Error("custom program error: 0x1");
      }),
    ),
    /0x1/,
  );
  assert.equal(m, 1);
});

// Quote and minOut in swapExactIn: the check that a fresh quote is not worse than the
// evaluated one (and the slippage tightening) is inline in swapExactIn, behind an Orca
// swapInstructions call that needs a live RPC. Testing it needs a small pure helper
// extracted in orca.ts; that file runs live, so it is left for review. The runner side
// (minOut taken from the evaluated quote and passed on) is covered in agent.test.ts.
test("swapExactIn aborts when the fresh quote is below the evaluated minOut", { skip: "needs a pure helper extracted from swapExactIn (orca.ts runs live)" }, () => {});
