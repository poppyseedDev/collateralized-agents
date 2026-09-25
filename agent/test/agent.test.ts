import "./helpers/env.js";
import { afterEach, beforeEach, describe, test, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair, type PublicKey } from "@solana/web3.js";
import type { KeyPairSigner } from "@solana/kit";
import { AGENTS, MAIN_POOL, type Strategy } from "../src/config.js";
import { BN, type Position, type PositionStatus } from "../src/chain.js";
import { SwapInFlight, SwapRejected, type Quote, type Resolution, type Signed, type SwapResult } from "../src/orca.js";
import { loadState, type Book, type PendingSwap } from "../src/state.js";
import {
  AgentRunner,
  LAST_CALL_SECS,
  SETTLE_RESERVE_LAMPORTS,
  clock,
  heartbeatNote,
  now,
  pastLastCall,
  refreshClock,
  settleAmount,
  settleTime,
  shouldAlert,
  tickAll,
  tooLateToDraw,
} from "../src/agent.js";

const SOL = 1_000_000_000n;
/** Local clock for every test, in seconds. */
const T = 1_800_000_000;

let lines: string[] = [];
beforeEach(async () => {
  lines = [];
  mock.method(console, "log", (...a: unknown[]) => lines.push(a.map(String).join(" ")));
  mock.timers.enable({ apis: ["Date"], now: T * 1000 });
  await refreshClock(async () => T); // chain clock == local clock unless a test says otherwise
});
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

// ---------- fakes ----------

type Calls = { draw: number; settle: string[]; fallbackSettle: string[] };
function fakeProgram(calls: Calls, which: "settle" | "fallbackSettle", settle: () => Promise<string> = async () => "settleSig") {
  const chain = <T>(fn: () => Promise<T>) => ({ accounts: () => ({ rpc: fn }) });
  return {
    methods: {
      drawFunds: () => chain(async () => (calls.draw++, "drawSig")),
      settlePosition: (amount: InstanceType<typeof BN>) =>
        chain(async () => {
          calls[which].push(amount.toString());
          return settle();
        }),
    },
  };
}

const unexpected = (name: string) => async () => {
  throw new Error(`unexpected ${name} call`);
};

let n = 0;
function makeRunner(strategy: Strategy, holdSecs = 600) {
  const cfg = { ...AGENTS[0], id: `test-agent-${++n}`, strategy, holdSecs };
  const r = new AgentRunner(cfg, { operator: Keypair.generate().publicKey, executor: Keypair.generate() });
  r.signer = { address: r.kp.publicKey.toBase58() } as KeyPairSigner;
  const calls: Calls = { draw: 0, settle: [], fallbackSettle: [] };
  r.program = fakeProgram(calls, "settle");
  r.fallbackProgram = null;
  const deps = {
    bestQuote: mock.fn<(side: "SOL" | "USDC", amount: bigint, s: KeyPairSigner) => Promise<Quote>>(unexpected("bestQuote")),
    swapExactIn: mock.fn<
      (pool: string, side: "SOL" | "USDC", amount: bigint, s: KeyPairSigner, onSigned: (s: Signed) => void | Promise<void>, minOut?: bigint) => Promise<SwapResult>
    >(unexpected("swapExactIn")),
    resolveSwap: mock.fn<(p: PendingSwap, owner: string) => Promise<Resolution>>(unexpected("resolveSwap")),
    balanceOf: mock.fn(async (_k: PublicKey) => 100n * SOL),
  };
  r.deps = deps as unknown as AgentRunner["deps"];
  return { r, calls, deps };
}

function position(r: AgentRunner, status: PositionStatus, deadline: number, drawnAt = 0): Position {
  return {
    publicKey: Keypair.generate().publicKey,
    trader: Keypair.generate().publicKey,
    agent: r.agent,
    principal: new BN(SOL.toString()),
    lockedCollateral: new BN(0),
    deadline: new BN(deadline),
    drawnAt: new BN(drawnAt),
    status,
  };
}

function addBook(r: AgentRunner, p: Position, over: Partial<Book> = {}): Book {
  const b: Book = {
    principal: SOL.toString(),
    sol: SOL.toString(),
    usdc: "0",
    drawnAt: T - 60,
    settleAt: T + 600,
    deadline: p.deadline.toNumber(),
    cycles: 0,
    trades: [],
    ...over,
  };
  r.state.books[p.publicKey.toBase58()] = b;
  return b;
}

const pend = (over: Partial<PendingSwap> = {}): PendingSwap => ({
  sig: "pendingSig111",
  lastValidBlockHeight: 100,
  side: "SOL",
  in: (SOL / 2n).toString(),
  pool: "PoolA",
  at: T - 30,
  bumpCycle: true,
  ...over,
});

/** A swapExactIn that signs (calling onSigned) and lands with the given deltas. */
const lands = (solDelta: bigint, usdcDelta: bigint, sig = "swapSig") =>
  async (_pool: string, _side: "SOL" | "USDC", _amt: bigint, _s: KeyPairSigner, onSigned: (s: Signed) => void | Promise<void>, _minOut?: bigint) => {
    await onSigned({ signature: sig, lastValidBlockHeight: 500 });
    return { signature: sig, solDelta, usdcDelta };
  };

const rotate: Strategy = { kind: "rotate", sizeBps: 5000 };
const arb: Strategy = { kind: "arbitrage", minEdgeBps: 50, sizeBps: 5000 };

// ---------- clock ----------

describe("clock", () => {
  test("uses chain time when it can be read", async () => {
    await refreshClock(async () => T + 200);
    assert.deepEqual(clock(), { skew: 200, source: "chain" });
    assert.equal(now(), T + 200);
    await refreshClock(async () => T - 50);
    assert.equal(now(), T - 50);
  });

  test("falls back to the local clock when chain time fails", async () => {
    await refreshClock(async () => T + 200);
    await refreshClock(async () => {
      throw new Error("fetch failed");
    });
    assert.deepEqual(clock(), { skew: 0, source: "local" });
    assert.equal(now(), T);
    assert.ok(lines.some((l) => l.includes("chain time unavailable, using local clock: fetch failed")));
  });
});

// ---------- pure timing rules ----------

describe("timing rules", () => {
  test("settle time: hold time after drawing, capped at 5 minutes before the deadline", () => {
    assert.equal(settleTime(T, T + 3600, 600), T + 600);
    assert.equal(settleTime(T, T + 800, 600), T + 500);
    assert.equal(settleTime(T, T + 900, 600), T + 600);
  });

  test("draw guard: no draws from 7 minutes before the deadline", () => {
    assert.equal(tooLateToDraw(T, T + 7 * 60), true);
    assert.equal(tooLateToDraw(T, T + 7 * 60 - 1), true);
    assert.equal(tooLateToDraw(T, T + 7 * 60 + 1), false);
  });

  test("last call is 2 minutes before the deadline", () => {
    assert.equal(LAST_CALL_SECS, 120);
    assert.equal(pastLastCall(T, T + 120), true);
    assert.equal(pastLastCall(T, T + 121), false);
  });

  test("ALERT only within 10 minutes of the deadline", () => {
    const b = { deadline: T + 601, settleAt: T + 1000, pending: null };
    assert.equal(shouldAlert(b, T, false), false);
    assert.equal(shouldAlert({ ...b, pending: pend() }, T, true), false);
    assert.equal(shouldAlert({ ...b, deadline: T + 600, settleAt: T }, T, true), true);
  });

  test("ALERT: a book waiting for its scheduled settle is quiet", () => {
    assert.equal(shouldAlert({ deadline: T + 400, settleAt: T + 100, pending: null }, T, true), false);
  });

  test("ALERT: a stuck pending swap near the deadline", () => {
    assert.equal(shouldAlert({ deadline: T + 400, settleAt: T + 100, pending: pend() }, T, true), true);
  });

  test("ALERT: a tick that did not run", () => {
    assert.equal(shouldAlert({ deadline: T + 400, settleAt: T + 100, pending: null }, T, false), true);
  });

  test("ALERT: past its settle time and still open", () => {
    assert.equal(shouldAlert({ deadline: T + 400, settleAt: T - 1, pending: null }, T, true), true);
  });

  test("alertNearDeadline logs one ALERT line per book at risk", () => {
    const { r } = makeRunner(rotate);
    const a = position(r, "trading", T + 300);
    const b = position(r, "trading", T + 3600);
    addBook(r, a, { settleAt: T + 100, pending: pend() });
    addBook(r, b);
    lines = [];
    r.alertNearDeadline(true);
    assert.equal(lines.length, 1);
    assert.match(lines[0], new RegExp(`ALERT \\[${r.cfg.id}\\] position ${a.publicKey.toBase58()} is unsettled with 300s to its deadline`));
    assert.match(lines[0], /swap pendingSig111 unresolved/);
    lines = [];
    r.alertNearDeadline(false);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /this tick could not run/);
  });
});

// ---------- drawing ----------

describe("drawing", () => {
  test("draws an open position and books it with its settle time", async () => {
    const { r, calls, deps } = makeRunner(rotate, 600);
    const p = position(r, "open", T + 3600);
    deps.swapExactIn.mock.mockImplementation(lands(-SOL / 2n, 75_000_000n));
    deps.bestQuote.mock.mockImplementation(async () => ({ pool: "PoolA", mintIn: "SOL", amountIn: SOL / 2n, out: 75_000_000n, minOut: 74_625_000n }));
    await r.tick(150, [p]);
    assert.equal(calls.draw, 1);
    const book = r.state.books[p.publicKey.toBase58()];
    assert.equal(book.drawnAt, T);
    assert.equal(book.settleAt, T + 600);
    assert.equal(book.deadline, T + 3600);
    assert.equal(p.status, "trading");
  });

  test("does not draw 7 minutes or less before the deadline", async () => {
    const { r, calls } = makeRunner(rotate);
    const p = position(r, "open", T + 420);
    await r.tick(150, [p]);
    assert.equal(calls.draw, 0);
    assert.deepEqual(r.state.books, {});
  });

  test("the draw guard uses chain time, not local time", async () => {
    const { r, calls } = makeRunner(rotate);
    const p = position(r, "open", T + 500); // local: 500s left, drawable
    await refreshClock(async () => T + 100); // chain: 400s left, too late
    await r.tick(150, [p]);
    assert.equal(calls.draw, 0);
  });

  test("a near-deadline draw settles 5 minutes before the deadline", async () => {
    const { r, calls } = makeRunner({ kind: "rotate", sizeBps: 0 }, 3600);
    const p = position(r, "open", T + 900);
    await r.tick(150, [p]);
    assert.equal(calls.draw, 1);
    assert.equal(r.state.books[p.publicKey.toBase58()].settleAt, T + 600);
  });
});

// ---------- settle timing ----------

describe("settle timing", () => {
  test("settles once chain time reaches settleAt, even if the local clock has not", async () => {
    const { r, calls } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T + 100, cycles: 1, sol: "1234" });
    await refreshClock(async () => T + 150);
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, ["1234"]);
    assert.deepEqual(r.state.books, {});
    assert.equal(r.state.history[0].returned, "1234");
  });

  test("with chain time unavailable, the local clock decides", async () => {
    const { r, calls } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T + 100, cycles: 1 });
    await refreshClock(async () => {
      throw new Error("down");
    });
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, []);
    assert.ok(r.state.books[p.publicKey.toBase58()]);
  });

  test("settling unwinds USDC on the main pool first", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1, sol: String(SOL / 2n), usdc: "75000000" });
    deps.swapExactIn.mock.mockImplementation(lands(SOL / 2n - 1000n, -75_000_000n));
    await r.tick(150, [p]);
    assert.equal(deps.swapExactIn.mock.callCount(), 1);
    const [pool, side, amount, , , minOut] = deps.swapExactIn.mock.calls[0].arguments;
    assert.deepEqual([pool, side, amount, minOut], [MAIN_POOL, "USDC", 75_000_000n, undefined]);
    assert.equal(deps.bestQuote.mock.callCount(), 0);
    assert.deepEqual(calls.settle, [String(SOL - 1000n)]);
  });

  test("a failed unwind before the last call retries next tick instead of settling", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1, usdc: "75000000" });
    deps.swapExactIn.mock.mockImplementation(async () => {
      throw new Error("price moved");
    });
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, []);
    assert.ok(lines.some((l) => l.includes("error on") && l.includes("price moved")));
  });

  test("a failed unwind at the last call settles with SOL only", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 100);
    addBook(r, p, { settleAt: T - 200, cycles: 1, sol: "500", usdc: "75000000" });
    deps.swapExactIn.mock.mockImplementation(async () => {
      throw new Error("price moved");
    });
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, ["500"]);
  });

  test("a wallet short of the book's SOL does not settle before the last call", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1 });
    deps.balanceOf.mock.mockImplementation(async () => SOL);
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, []);
    assert.ok(lines.some((l) => l.includes("needs 1.0000 to settle")));
  });

  test("a wallet short of the book's SOL at the last call settles with what it has, keeping the reserve", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + LAST_CALL_SECS);
    addBook(r, p, { settleAt: T - 200, cycles: 1 });
    deps.balanceOf.mock.mockImplementation(async () => SOL / 2n);
    await r.tick(150, [p]);
    const sent = SOL / 2n - SETTLE_RESERVE_LAMPORTS;
    assert.deepEqual(calls.settle, [sent.toString()]);
    assert.ok(SETTLE_RESERVE_LAMPORTS >= 890_880n + 5_000n, "reserve covers the rent-exempt minimum and a fee");
    assert.deepEqual(r.state.books, {});
    assert.equal(r.state.history[0].returned, sent.toString());
    assert.ok(lines.some((l) => l.includes("ALERT wallet has 0.5000 SOL, short of the 1.0000 owed")));
  });

  test("settleAmount: the book's SOL, capped at the wallet less the reserve, never negative", () => {
    assert.equal(settleAmount(SOL, 2n * SOL), SOL);
    assert.equal(settleAmount(SOL, SOL + SETTLE_RESERVE_LAMPORTS), SOL);
    assert.equal(settleAmount(SOL, SOL), SOL - SETTLE_RESERVE_LAMPORTS);
    assert.equal(settleAmount(SOL, SETTLE_RESERVE_LAMPORTS), 0n);
    assert.equal(settleAmount(SOL, 1000n), 0n);
  });

  test("a failed draw does not stop a due book from settling", async () => {
    const { r, calls } = makeRunner(rotate);
    const due = position(r, "trading", T + 3600);
    addBook(r, due, { settleAt: T, cycles: 1 });
    const open = position(r, "open", T + 3600);
    const open2 = position(r, "open", T + 3600);
    let draws = 0;
    const settleProgram = fakeProgram(calls, "settle");
    r.program = {
      methods: {
        ...settleProgram.methods,
        drawFunds: () => ({
          accounts: () => ({
            rpc: async () => {
              draws++;
              throw new Error("draw rejected");
            },
          }),
        }),
      },
    } as unknown as AgentRunner["program"];
    await r.tick(150, [open, due, open2]);
    assert.deepEqual(calls.settle, [SOL.toString()]);
    assert.equal(draws, 2, "each open position gets its own attempt");
    assert.equal(lines.filter((l) => l.includes("could not draw or adopt") && l.includes("draw rejected")).length, 2);
  });

  test("a network error settling on the primary retries on the fallback", async () => {
    const { r, calls } = makeRunner(rotate);
    r.program = fakeProgram(calls, "settle", async () => {
      throw new TypeError("fetch failed");
    });
    r.fallbackProgram = fakeProgram(calls, "fallbackSettle");
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1 });
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, [SOL.toString()]);
    assert.deepEqual(calls.fallbackSettle, [SOL.toString()]);
    assert.deepEqual(r.state.books, {});
  });

  test("a program error settling is not retried on the fallback", async () => {
    const { r, calls } = makeRunner(rotate);
    r.program = fakeProgram(calls, "settle", async () => {
      throw new Error("AnchorError: DeadlinePassed");
    });
    r.fallbackProgram = fakeProgram(calls, "fallbackSettle");
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1 });
    await r.tick(150, [p]);
    assert.deepEqual(calls.fallbackSettle, []);
    assert.ok(r.state.books[p.publicKey.toBase58()]);
  });

  test("without a fallback, a network error settling is left for the next tick", async () => {
    const { r, calls } = makeRunner(rotate);
    r.program = fakeProgram(calls, "settle", async () => {
      throw new TypeError("fetch failed");
    });
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T, cycles: 1 });
    await r.tick(150, [p]);
    assert.ok(r.state.books[p.publicKey.toBase58()]);
  });

  test("a book whose position closed on-chain is dropped", async () => {
    const { r } = makeRunner(rotate);
    const p = position(r, "settled", T + 3600);
    addBook(r, p);
    const gone = position(r, "trading", T + 3600);
    addBook(r, gone);
    await r.tick(150, [p]);
    assert.deepEqual(r.state.books, {});
  });

  test("an orphaned trading position is adopted and keeps its original schedule", async () => {
    const { r } = makeRunner({ kind: "rotate", sizeBps: 0 }, 600);
    const p = position(r, "trading", T + 3600, T - 100);
    await r.tick(150, [p]);
    assert.equal(r.state.books[p.publicKey.toBase58()].settleAt, T + 500);
  });
});

// ---------- pending swaps ----------

describe("pending swaps", () => {
  test("a pending swap is resolved, not re-swapped", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p, { pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({ state: "pending", reason: "not seen yet" }));
    await r.tick(150, [p]);
    assert.equal(deps.resolveSwap.mock.callCount(), 1);
    assert.equal(deps.resolveSwap.mock.calls[0].arguments[1], r.kp.publicKey.toBase58());
    assert.equal(deps.bestQuote.mock.callCount(), 0);
    assert.equal(deps.swapExactIn.mock.callCount(), 0);
    assert.equal(book.pending?.sig, "pendingSig111");
    assert.equal(book.cycles, 0);
  });

  test("a pending swap that landed is booked once, then the strategy continues", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p, { pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({
      state: "landed",
      result: { signature: "pendingSig111", solDelta: -SOL / 2n, usdcDelta: 75_000_000n },
    }));
    await r.tick(150, [p]);
    assert.equal(book.pending, null);
    assert.equal(book.sol, String(SOL / 2n));
    assert.equal(book.usdc, "75000000");
    assert.equal(book.cycles, 1); // bumpCycle carried over from the pending swap
    assert.equal(book.trades.length, 1);
    assert.deepEqual({ ...book.trades[0], at: 0 }, { at: 0, side: "SOL->USDC", in: String(SOL / 2n), out: "75000000", pool: "PoolA", sig: "pendingSig111" });
    assert.equal(deps.swapExactIn.mock.callCount(), 0); // rotate is done after one cycle
    // persisted
    assert.equal(loadState(r.cfg.id).books[p.publicKey.toBase58()].usdc, "75000000");
  });

  test("a pending swap that failed is cleared with nothing booked", async () => {
    const { r, deps } = makeRunner({ kind: "rotate", sizeBps: 0 });
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p, { pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({ state: "failed", reason: "blockhash expired" }));
    await r.tick(150, [p]);
    assert.equal(book.pending, null);
    assert.equal(book.sol, SOL.toString());
    assert.equal(book.usdc, "0");
    assert.equal(book.trades.length, 0);
    assert.equal(book.cycles, 0);
  });

  test("a pending swap past settleAt is resolved before settling", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p, { settleAt: T - 10, pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({ state: "pending", reason: "not seen yet" }));
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, []);
  });

  test("still unresolved 2 minutes before the deadline: settle with the book as it stands", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + LAST_CALL_SECS);
    addBook(r, p, { settleAt: T - 200, sol: String(SOL / 2n), usdc: "75000000", pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({ state: "pending", reason: "not seen yet" }));
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, [String(SOL / 2n)]);
    assert.equal(deps.swapExactIn.mock.callCount(), 0, "no unwind in an emergency settle");
    assert.ok(lines.some((l) => l.includes("ALERT swap pendingSig111") && l.includes("settling with the book as it stands")));
  });

  test("unresolved 121s before the deadline: keeps waiting", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + LAST_CALL_SECS + 1);
    addBook(r, p, { settleAt: T - 200, pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => ({ state: "pending", reason: "not seen yet" }));
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, []);
  });

  test("an RPC error resolving a pending swap keeps it pending", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p, { pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await r.tick(150, [p]);
    assert.equal(book.pending?.sig, "pendingSig111");
    assert.equal(deps.swapExactIn.mock.callCount(), 0);
  });

  test("an RPC error resolving a pending swap at the last call still settles", async () => {
    const { r, calls, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + LAST_CALL_SECS);
    addBook(r, p, { settleAt: T - 200, sol: String(SOL / 2n), usdc: "75000000", pending: pend() });
    deps.resolveSwap.mock.mockImplementation(async () => {
      throw new TypeError("fetch failed");
    });
    await r.tick(150, [p]);
    assert.deepEqual(calls.settle, [String(SOL / 2n)]);
    assert.equal(deps.swapExactIn.mock.callCount(), 0, "no unwind in an emergency settle");
    assert.ok(lines.some((l) => l.includes("could not check swap") && l.includes("fetch failed")));
    assert.ok(lines.some((l) => l.includes("ALERT swap pendingSig111")));
  });
});

// ---------- swaps and minOut ----------

describe("swaps", () => {
  test("minOut comes from the evaluated quote and is passed to the swap", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    addBook(r, p);
    deps.bestQuote.mock.mockImplementation(async (side, amount) => ({ pool: "PoolQ", mintIn: side, amountIn: amount, out: 75_000_000n, minOut: 74_625_000n }));
    deps.swapExactIn.mock.mockImplementation(lands(-SOL / 2n, 75_100_000n));
    await r.tick(150, [p]);
    assert.equal(deps.bestQuote.mock.callCount(), 1);
    assert.deepEqual(deps.bestQuote.mock.calls[0].arguments.slice(0, 2), ["SOL", SOL / 2n]);
    const [pool, side, amount, , , minOut] = deps.swapExactIn.mock.calls[0].arguments;
    assert.deepEqual([pool, side, amount, minOut], ["PoolQ", "SOL", SOL / 2n, 74_625_000n]);
  });

  test("the signed swap is saved as pending before it is sent", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const key = p.publicKey.toBase58();
    const book = addBook(r, p);
    deps.bestQuote.mock.mockImplementation(async (side, amount) => ({ pool: "PoolQ", mintIn: side, amountIn: amount, out: 1n, minOut: 1n }));
    let onDisk: PendingSwap | null | undefined;
    deps.swapExactIn.mock.mockImplementation(async (_pool, _side, _amt, _s, onSigned) => {
      await onSigned({ signature: "S1", lastValidBlockHeight: 42 });
      onDisk = loadState(r.cfg.id).books[key].pending; // what a crash right now would leave
      throw new SwapInFlight("send failed, outcome unknown");
    });
    await r.tick(150, [p]);
    assert.deepEqual(onDisk, { sig: "S1", lastValidBlockHeight: 42, side: "SOL", in: String(SOL / 2n), pool: "PoolQ", at: T, bumpCycle: true });
    // in flight: kept, and resolved on the next tick
    assert.equal(book.pending?.sig, "S1");
    assert.equal(loadState(r.cfg.id).books[key].pending?.sig, "S1");
  });

  test("a rejected swap clears its pending entry and books nothing", async () => {
    const { r, deps } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p);
    deps.bestQuote.mock.mockImplementation(async (side, amount) => ({ pool: "PoolQ", mintIn: side, amountIn: amount, out: 1n, minOut: 1n }));
    deps.swapExactIn.mock.mockImplementation(async (_pool, _side, _amt, _s, onSigned) => {
      await onSigned({ signature: "S1", lastValidBlockHeight: 42 });
      throw new SwapRejected("failed on-chain");
    });
    await r.tick(150, [p]);
    assert.equal(book.pending, null);
    assert.equal(book.cycles, 0);
    assert.equal(book.sol, SOL.toString());
  });

  test("swap refuses to run while the book has a pending swap", async () => {
    const { r } = makeRunner(rotate);
    const p = position(r, "trading", T + 3600);
    const book = addBook(r, p, { pending: pend() });
    await assert.rejects(r.swap(book, "SOL", 1n), /still pending/);
  });

  test("a zero-size swap does nothing", async () => {
    const { r, deps } = makeRunner(rotate);
    const book = addBook(r, position(r, "trading", T + 3600));
    assert.equal(await r.swap(book, "SOL", 0n), null);
    assert.equal(deps.bestQuote.mock.callCount(), 0);
  });
});

// ---------- arbitrage ----------

describe("arbitrage round trip", () => {
  const leg1: Quote = { pool: "PoolA", mintIn: "SOL", amountIn: SOL, out: 150_000_000n, minOut: 149_250_000n };
  const leg2: Quote = { pool: "PoolB", mintIn: "USDC", amountIn: 150_000_000n, out: 1_010_000_000n, minOut: 1_004_950_000n };

  function setup() {
    const x = makeRunner(arb);
    const p = position(x.r, "trading", T + 3600);
    const book = addBook(x.r, p, { sol: String(2n * SOL) });
    x.deps.bestQuote.mock.mockImplementation(async (side) => (side === "SOL" ? leg1 : leg2));
    return { ...x, p, book };
  }

  test("leg 1 missing its quote aborts before leg 2", async () => {
    const { r, p, book, deps } = setup();
    deps.swapExactIn.mock.mockImplementation(lands(-SOL, 149_999_999n));
    await r.tick(150, [p]);
    assert.equal(deps.swapExactIn.mock.callCount(), 1);
    const [pool, side, amount, , , minOut] = deps.swapExactIn.mock.calls[0].arguments;
    assert.deepEqual([pool, side, amount, minOut], ["PoolA", "SOL", SOL, leg1.minOut]);
    assert.equal(book.usdc, "149999999");
    assert.equal(book.cycles, 1);
    assert.ok(lines.some((l) => l.includes("aborting the round trip")));

    // next tick sells the USDC back before anything else
    deps.bestQuote.mock.mockImplementation(async (side, amount) => ({ pool: "PoolC", mintIn: side, amountIn: amount, out: SOL, minOut: 995_000_000n }));
    deps.swapExactIn.mock.mockImplementation(lands(SOL, -149_999_999n));
    await r.tick(150, [p]);
    const [pool2, side2, amount2, , , minOut2] = deps.swapExactIn.mock.calls[1].arguments;
    assert.deepEqual([pool2, side2, amount2, minOut2], ["PoolC", "USDC", 149_999_999n, 995_000_000n]);
    assert.equal(book.usdc, "0");
  });

  test("a full round trip: leg 2's minOut is scaled to what leg 1 returned", async () => {
    const { r, p, book, deps } = setup();
    let i = 0;
    deps.swapExactIn.mock.mockImplementation(async (...a) => (i++ === 0 ? lands(-SOL, 165_000_000n, "L1")(...a) : lands(1_100_000_000n, -165_000_000n, "L2")(...a)));
    await r.tick(150, [p]);
    assert.equal(deps.swapExactIn.mock.callCount(), 2);
    const [pool, side, amount, , , minOut] = deps.swapExactIn.mock.calls[1].arguments;
    assert.deepEqual([pool, side, amount, minOut], ["PoolB", "USDC", 165_000_000n, (leg2.minOut * 165_000_000n) / leg1.out]);
    assert.equal(book.sol, String(2n * SOL + 100_000_000n));
    assert.equal(book.usdc, "0");
    assert.equal(book.cycles, 1);
    assert.deepEqual(book.trades.map((t) => t.sig), ["L1", "L2"]);
  });

  test("no trade when the edge is below minEdgeBps", async () => {
    const { r, p, deps } = setup();
    deps.bestQuote.mock.mockImplementation(async (side) => (side === "SOL" ? leg1 : { ...leg2, out: 1_004_000_000n }));
    await r.tick(150, [p]);
    assert.equal(deps.swapExactIn.mock.callCount(), 0);
  });

  test("no trade after three round trips", async () => {
    const { r, p, book, deps } = setup();
    book.cycles = 3;
    await r.tick(150, [p]);
    assert.equal(deps.bestQuote.mock.callCount(), 0);
  });
});

// ---------- momentum in the runner ----------

describe("momentum in the runner", () => {
  test("the tick's price joins the series before deciding; no price, no trade", async () => {
    const { r, deps } = makeRunner({ kind: "momentum", window: 3, bandBps: 30, sizeBps: 6000 });
    const p = position(r, "trading", T + 3600);
    addBook(r, p);
    r.state.prices = [150, 150];
    await r.tick(null, [p]);
    assert.deepEqual(r.state.prices, [150, 150]);
    assert.equal(deps.bestQuote.mock.callCount(), 0);

    deps.bestQuote.mock.mockImplementation(async (side, amount) => ({ pool: "PoolQ", mintIn: side, amountIn: amount, out: 1n, minOut: 1n }));
    deps.swapExactIn.mock.mockImplementation(lands(-600_000_000n, 84_000_000n));
    await r.tick(140, [p]);
    assert.deepEqual(r.state.prices, [150, 150, 140]);
    assert.deepEqual(deps.bestQuote.mock.calls[0].arguments.slice(0, 2), ["SOL", 600_000_000n]);
  });

  test("the price series keeps the last 100 samples", async () => {
    const { r } = makeRunner({ kind: "rotate", sizeBps: 0 });
    r.state.prices = Array.from({ length: 100 }, (_, i) => i);
    await r.tick(1000, []);
    assert.equal(r.state.prices.length, 100);
    assert.equal(r.state.prices[0], 1);
    assert.equal(r.state.prices[99], 1000);
  });
});

// ---------- the loop: scan fallback and heartbeat ----------

describe("tickAll", () => {
  test("a failed scan falls back to the books' known positions and draws nothing", async () => {
    const { r, calls } = makeRunner({ kind: "rotate", sizeBps: 0 });
    const tracked = position(r, "trading", T + 3600);
    addBook(r, tracked, { cycles: 1 });
    const fresh = position(r, "open", T + 3600);
    const io = {
      positionsForAgent: mock.fn(async (_a: PublicKey): Promise<Position[]> => {
        throw new Error("429 Too Many Requests");
      }),
      positionsByKey: mock.fn(async (_k: string[]) => [tracked, fresh]),
    };
    const out = await tickAll([r], 150, io);
    assert.deepEqual(io.positionsByKey.mock.calls[0].arguments[0], [tracked.publicKey.toBase58()]);
    assert.equal(calls.draw, 0);
    assert.equal(r.state.books[fresh.publicKey.toBase58()], undefined);
    assert.ok(r.state.books[tracked.publicKey.toBase58()]);
    assert.deepEqual(out, { ran: [r.agent.toBase58()], degraded: [r.cfg.id] });
  });

  test("a failed scan still settles tracked books that are due", async () => {
    const { r, calls } = makeRunner(rotate);
    const tracked = position(r, "trading", T + 3600);
    addBook(r, tracked, { settleAt: T, cycles: 1 });
    const io = {
      positionsForAgent: async (): Promise<Position[]> => {
        throw new Error("fetch failed");
      },
      positionsByKey: async () => [tracked],
    };
    await tickAll([r], 150, io);
    assert.deepEqual(calls.settle, [SOL.toString()]);
  });

  test("heartbeat lists only agents whose tick ran", async () => {
    const a = makeRunner({ kind: "rotate", sizeBps: 0 });
    const b = makeRunner({ kind: "rotate", sizeBps: 0 });
    const c = makeRunner({ kind: "rotate", sizeBps: 0 });
    const bp = position(b.r, "trading", T + 300);
    addBook(b.r, bp, { settleAt: T + 100 });
    const io = {
      positionsForAgent: async (agent: PublicKey): Promise<Position[]> => {
        if (agent.equals(a.r.agent)) return [];
        throw new Error("fetch failed");
      },
      positionsByKey: async (keys: string[]): Promise<Position[]> => {
        if (keys.length) throw new Error("fetch failed"); // b: both reads fail
        return []; // c: nothing tracked, partial tick runs
      },
    };
    const out = await tickAll([a.r, b.r, c.r], 150, io);
    assert.deepEqual(out.ran, [a.r.agent.toBase58(), c.r.agent.toBase58()]);
    assert.deepEqual(out.degraded, [c.r.cfg.id]);
    assert.equal(heartbeatNote(out.degraded), `degraded, position scan failed: ${c.r.cfg.id}`);
    // b's tick did not run and its book is near the deadline
    assert.ok(lines.some((l) => l.includes(`ALERT [${b.r.cfg.id}]`) && l.includes("this tick could not run")));
  });

  test("no heartbeat note when every scan worked", () => {
    assert.equal(heartbeatNote([]), undefined);
  });
});
