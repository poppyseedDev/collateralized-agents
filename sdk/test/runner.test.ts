import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BN } from "../src/client.js";
import { Runner, SETTLE_TX_SECS, hookGraceSecs, loadRunnerState, writeAtomic } from "../src/runner.js";
import { nowSecs, position, tempDir } from "./helpers.js";
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, book, makeRunner } from "./runner-fixture.js";

describe("hookGraceSecs", () => {
  const T = 1_800_000_000;
  test("is graceSecs when the deadline is far", () => {
    assert.equal(hookGraceSecs(60, T + 3600, T), 60);
    assert.equal(hookGraceSecs(5, T + 3600, T), 5);
  });
  test("defaults to 60", () => {
    assert.equal(hookGraceSecs(undefined, T + 3600, T), 60);
  });
  test("is cut to deadline - 30s - now", () => {
    assert.equal(SETTLE_TX_SECS, 30);
    assert.equal(hookGraceSecs(60, T + 75, T), 45);
    assert.equal(hookGraceSecs(60, T + 31, T), 1);
    assert.equal(hookGraceSecs(60, T + 90, T), 60);
    assert.equal(hookGraceSecs(60, T + 89, T), 59);
  });
  test("is never negative", () => {
    assert.equal(hookGraceSecs(60, T + 30, T), 0);
    assert.equal(hookGraceSecs(60, T + 10, T), 0);
    assert.equal(hookGraceSecs(60, T - 500, T), 0);
    assert.equal(hookGraceSecs(0, T + 3600, T), 0);
    assert.equal(hookGraceSecs(-5, T + 3600, T), 0);
  });
});

describe("state file", () => {
  test("writeAtomic creates the directory, writes mode 600, keeps a .bak and leaves no temp file", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "nested", "state.json");
    writeAtomic(path, "one");
    assert.equal(readFileSync(path, "utf8"), "one");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${path}.bak`), "no backup before there is a previous version");
    writeAtomic(path, "two");
    assert.equal(readFileSync(path, "utf8"), "two");
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "one");
    writeAtomic(path, "three");
    assert.equal(readFileSync(`${path}.bak`, "utf8"), "two");
    assert.deepEqual(readdirSync(join(dir, "nested")).sort(), ["state.json", "state.json.bak"]);
  });

  test("a missing file is empty state", (t) => {
    const logs: string[] = [];
    assert.deepEqual(loadRunnerState(join(tempDir(t), "none.json"), (m) => logs.push(m)), { active: null, history: [] });
    assert.deepEqual(logs, []);
  });

  test("a valid file loads, with missing fields defaulted", (t) => {
    const path = join(tempDir(t), "s.json");
    writeFileSync(path, JSON.stringify({ active: { position: "P" } }));
    assert.deepEqual(loadRunnerState(path, () => {}), { active: { position: "P" }, history: [] });
  });

  test("a corrupt file is moved aside and the backup is used", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "s.json");
    const good = { active: { position: "FROM_BAK" }, history: [{ position: "old", principal: "1", returned: "2", at: 3 }] };
    writeFileSync(`${path}.bak`, JSON.stringify(good));
    writeFileSync(path, '{"active": {"posit');
    const logs: string[] = [];
    assert.deepEqual(loadRunnerState(path, (m) => logs.push(m)), good);
    assert.ok(!existsSync(path), "corrupt file moved away");
    const aside = readdirSync(dir).filter((f) => f.startsWith("s.json.corrupt-"));
    assert.equal(aside.length, 1);
    assert.equal(readFileSync(join(dir, aside[0]), "utf8"), '{"active": {"posit', "corrupt contents kept for inspection");
    assert.ok(logs.some((l) => /ALERT state file .* did not parse/.test(l)));
    assert.ok(logs.some((l) => /ALERT resuming from backup/.test(l)));
  });

  test("a corrupt file with a corrupt backup starts empty", (t) => {
    const dir = tempDir(t);
    const path = join(dir, "s.json");
    writeFileSync(path, "garbage");
    writeFileSync(`${path}.bak`, "also garbage");
    const logs: string[] = [];
    assert.deepEqual(loadRunnerState(path, (m) => logs.push(m)), { active: null, history: [] });
    assert.ok(logs.some((l) => /backup .* did not parse either/.test(l)));
    assert.ok(logs.some((l) => /starting with empty state/.test(l)));
  });

  test("a corrupt file without a backup starts empty", (t) => {
    const path = join(tempDir(t), "s.json");
    writeFileSync(path, "");
    assert.deepEqual(loadRunnerState(path, () => {}), { active: null, history: [] });
  });

  test("the runner persists its book and a new runner resumes it", async (t) => {
    const { r, chain, dir } = makeRunner(t);
    const p = position({ status: "open" });
    chain.positions = [p];
    await r.tick();
    const path = join(dir, "state", "state.json");
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.active.position, p.publicKey.toBase58());
    const logs: string[] = [];
    const again = new Runner({ ...(r as unknown as { opts: ConstructorParameters<typeof Runner>[0] }).opts, log: (m) => logs.push(m) });
    assert.deepEqual((again as unknown as typeof r).state.active, saved.active);
  });

  test("the runner recovers from a corrupt state file at startup", (t) => {
    const dir = tempDir(t);
    const stateFile = join(dir, "state.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(stateFile, "{not json");
    const { r, logs } = makeRunner(t, { stateFile });
    assert.deepEqual(r.state, { active: null, history: [] });
    assert.ok(logs.some((l) => l.includes("ALERT")));
  });
});

describe("tick: what to draw", () => {
  test("draws the oldest open position with enough time left", async (t) => {
    const { r, chain } = makeRunner(t, { bufferSecs: 60 });
    const now = nowSecs();
    const tooClose = position({ status: "open", openedAt: new BN(now - 500), deadline: new BN(now + 60 + 120) });
    const newer = position({ status: "open", openedAt: new BN(now - 100), deadline: new BN(now + 3600) });
    const older = position({ status: "open", openedAt: new BN(now - 200), deadline: new BN(now + 3600) });
    const done = position({ status: "settled", openedAt: new BN(now - 900) });
    chain.positions = [tooClose, newer, older, done];
    await r.tick();
    assert.deepEqual(chain.drawn.map(String), [older.publicKey.toBase58()]);
    assert.equal(r.state.active!.position, older.publicKey.toBase58());
    assert.equal(r.state.active!.balanceAtDraw, "5000000000", "balance read after the draw");
  });

  test("draws nothing when every open position is too close to its deadline", async (t) => {
    const { r, chain } = makeRunner(t, { bufferSecs: 60 });
    chain.positions = [position({ status: "open", deadline: new BN(nowSecs() + 180) })];
    await r.tick();
    assert.equal(chain.drawn.length, 0);
    assert.equal(r.state.active, null);
  });

  test("settleAt is drawnAt + hold when that comes first", async (t) => {
    const { r, chain } = makeRunner(t, { holdSecs: 600, bufferSecs: 60 });
    const p = position({ status: "open", deadline: new BN(nowSecs() + 3600) });
    chain.positions = [p];
    await r.tick();
    const b = r.state.active!;
    assert.equal(b.settleAt, b.drawnAt + 600);
    assert.equal(b.deadline, p.deadline.toNumber());
  });

  test("settleAt is deadline - buffer when that comes first", async (t) => {
    const { r, chain } = makeRunner(t, { holdSecs: 7200, bufferSecs: 300 });
    const p = position({ status: "open", deadline: new BN(nowSecs() + 3600) });
    chain.positions = [p];
    await r.tick();
    assert.equal(r.state.active!.settleAt, p.deadline.toNumber() - 300);
  });

  test("one position at a time: an active book blocks new draws", async (t) => {
    const { r, chain } = makeRunner(t);
    const trading = position({ status: "trading" });
    r.state.active = book(trading);
    chain.positions = [trading, position({ status: "open" })];
    await r.tick();
    assert.equal(chain.drawn.length, 0);
    assert.equal(chain.settled.length, 0);
  });
});

describe("tick: when to settle", () => {
  test("settles once settleAt has passed", async (t) => {
    const { r, chain } = makeRunner(t);
    const p = position({ status: "trading" });
    r.state.active = book(p, { settleAt: nowSecs() - 1 });
    chain.positions = [p];
    await r.tick();
    assert.equal(chain.settled.length, 1);
    assert.equal(r.state.active, null);
  });

  test("settles at exactly settleAt", async (t) => {
    const { r, chain } = makeRunner(t);
    const p = position({ status: "trading" });
    r.state.active = book(p, { settleAt: nowSecs() });
    chain.positions = [p];
    await r.tick();
    assert.equal(chain.settled.length, 1);
  });

  test("does not settle early while no hook has exited", async (t) => {
    const { r, chain, logs } = makeRunner(t);
    const p = position({ status: "trading" });
    r.state.active = book(p, { settleAt: nowSecs() + 300 });
    chain.positions = [p];
    await r.tick();
    assert.equal(chain.settled.length, 0);
    assert.ok(!logs.some((l) => l.startsWith("settle-soon")));
  });

  test("sends settle-soon once, in the poll window before the last minute", async (t) => {
    const { r, chain, logs } = makeRunner(t, { pollMs: 15_000 });
    const p = position({ status: "trading" });
    chain.positions = [p];
    r.state.active = book(p, { settleAt: nowSecs() + 50 });
    await r.tick();
    assert.equal(logs.filter((l) => l.startsWith("settle-soon")).length, 1);
    r.state.active = book(p, { settleAt: nowSecs() + 40 });
    await r.tick();
    assert.equal(logs.filter((l) => l.startsWith("settle-soon")).length, 1, "not again on the next poll");
    assert.equal(chain.settled.length, 0);
  });

  test("drops the book when the position is no longer trading", async (t) => {
    for (const status of ["settled", "defaulted", "gone"] as const) {
      const { r, chain, logs, dir } = makeRunner(t);
      const p = position({ status: status === "gone" ? "open" : status });
      r.state.active = book(p);
      chain.positions = status === "gone" ? [] : [p];
      await r.tick();
      assert.equal(r.state.active, null, status);
      assert.equal(chain.settled.length, 0, status);
      assert.ok(logs.some((l) => l.includes(`is ${status}; dropping book`)), status);
      assert.equal(JSON.parse(readFileSync(join(dir, "state", "state.json"), "utf8")).active, null);
    }
  });

  test("adopts a trading position it has no book for, settling no sooner than 30s from now", async (t) => {
    const { r, chain, logs } = makeRunner(t, { holdSecs: 600, bufferSecs: 60 });
    chain.balance = 7_000_000_000;
    const now = nowSecs();
    const longAgo = position({ status: "trading", drawnAt: new BN(now - 5000), deadline: new BN(now + 3600) });
    chain.positions = [longAgo];
    await r.tick();
    const b = r.state.active!;
    assert.equal(b.position, longAgo.publicKey.toBase58());
    assert.equal(b.balanceAtDraw, "7000000000", "balance change counts from adoption");
    assert.ok(b.settleAt >= now + 30 && b.settleAt <= nowSecs() + 30);
    assert.ok(logs.some((l) => l.startsWith("adopted:")));
    assert.equal(chain.drawn.length, 0);
  });

  test("an adopted position keeps its own settle time when that is later", async (t) => {
    const { r, chain } = makeRunner(t, { holdSecs: 600, bufferSecs: 60 });
    const now = nowSecs();
    const recent = position({ status: "trading", drawnAt: new BN(now - 100), deadline: new BN(now + 3600) });
    chain.positions = [recent];
    await r.tick();
    assert.equal(r.state.active!.settleAt, now - 100 + 600);
  });
});

describe("settle amount", () => {
  const run = async (t: Parameters<typeof makeRunner>[0], balance: number, balanceAtDraw: string, principal = 1_000_000_000, paper = false) => {
    const { r, chain } = makeRunner(t, { paper });
    const p = position({ status: "trading", principal: new BN(principal) });
    chain.balance = balance;
    await r.settle(p, book(p, { balanceAtDraw }));
    assert.equal(chain.settled.length, 1);
    return { returned: chain.settled[0].returned, r, chain };
  };

  test("principal plus the wallet's gain", async (t) => {
    assert.equal((await run(t, 5_200_000_000, "5000000000")).returned, 1_200_000_000n);
  });
  test("principal minus the wallet's loss", async (t) => {
    assert.equal((await run(t, 4_500_000_000, "5000000000")).returned, 500_000_000n);
  });
  test("never negative", async (t) => {
    assert.equal((await run(t, 3_000_000_000, "5000000000")).returned, 0n);
  });
  test("keeps 20,000 lamports in the wallet for the settle fee", async (t) => {
    assert.equal((await run(t, 1_100_000_000, "1000000000")).returned, 1_100_000_000n - 20_000n);
    assert.equal((await run(t, 10_000, "1000000000", 2_000_000_000)).returned, 0n);
  });
  test("paper mode returns exactly the principal and reads nothing", async (t) => {
    const { returned, chain } = await run(t, 1, "5000000000", 1_000_000_000, true);
    assert.equal(returned, 1_000_000_000n);
    assert.equal(chain.tokenLookups, 0);
  });
  test("records history and clears the book", async (t) => {
    const { r } = await run(t, 5_000_000_000, "5000000000");
    assert.equal(r.state.active, null);
    assert.equal(r.state.history.length, 1);
    assert.equal(r.state.history[0].returned, "1000000000");
  });
});

describe("non-SOL token warning", () => {
  const settleWith = async (t: Parameters<typeof makeRunner>[0], setup: (c: import("./runner-fixture.js").FakeChain) => void) => {
    const { r, chain, logs } = makeRunner(t);
    setup(chain);
    const p = position({ status: "trading" });
    await r.settle(p, book(p));
    assert.equal(chain.settled.length, 1, "settles regardless");
    return logs.filter((l) => l.startsWith("warning:"));
  };

  test("warns listing every non-zero token balance in both token programs", async (t) => {
    const warnings = await settleWith(t, (c) => {
      c.tokens[TOKEN_PROGRAM] = [
        { mint: "USDCmint", amount: "1500000", ui: "1.5" },
        { mint: "EmptyMint", amount: "0", ui: "0" },
      ];
      c.tokens[TOKEN_2022_PROGRAM] = [{ mint: "T22mint", amount: "7", ui: "0.000007" }];
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /non-SOL tokens at settle time/);
    assert.ok(warnings[0].includes("1.5 of USDCmint"));
    assert.ok(warnings[0].includes("0.000007 of T22mint"));
    assert.ok(!warnings[0].includes("EmptyMint"));
  });

  test("no warning when only empty token accounts remain", async (t) => {
    const warnings = await settleWith(t, (c) => {
      c.tokens[TOKEN_PROGRAM] = [{ mint: "EmptyMint", amount: "0", ui: "0" }];
    });
    assert.deepEqual(warnings, []);
  });

  test("a failed lookup still warns, and still settles", async (t) => {
    const warnings = await settleWith(t, (c) => {
      c.tokenError = new Error("rpc down");
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /could not check token balances: rpc down/);
  });
});
