import { STATE_DIR } from "./helpers/env.js";
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadState, loadStateFrom, saveState, writeAtomic, type AgentState } from "../src/state.js";

const quiet = () => mock.method(console, "error", () => {});
const file = (id: string) => join(STATE_DIR, `${id}.json`);

const sample = (n: number): AgentState => ({
  books: {
    pos1: {
      principal: "1000000000",
      sol: String(900_000_000 + n),
      usdc: "12345",
      drawnAt: 100,
      settleAt: 200,
      deadline: 500,
      cycles: n,
      trades: [],
    },
  },
  prices: [
    { at: 100, price: 150.5 },
    { at: 130, price: 151 },
  ],
  history: [],
});

test("uses the temp STATE_DIR, not agent/state", () => {
  assert.equal(process.env.STATE_DIR, STATE_DIR);
  assert.match(STATE_DIR, /poa-agent-test-/);
});

test("a missing state file loads as empty", () => {
  assert.deepEqual(loadState("nobody"), { books: {}, prices: [], history: [] });
});

test("saveState round-trips and leaves no temp file", () => {
  saveState("rt", sample(1));
  assert.deepEqual(loadState("rt"), sample(1));
  assert.deepEqual(readdirSync(STATE_DIR).filter((f) => f.startsWith("rt.json.tmp")), []);
  // first write: nothing to back up yet
  assert.equal(existsSync(`${file("rt")}.bak`), false);
});

test("writeAtomic keeps the previous version as .bak and renames the new one in", () => {
  const p = join(STATE_DIR, "atomic.json");
  writeAtomic(p, "v1");
  writeAtomic(p, "v2");
  assert.equal(readFileSync(p, "utf8"), "v2");
  assert.equal(readFileSync(`${p}.bak`, "utf8"), "v1");
  writeAtomic(p, "v3");
  assert.equal(readFileSync(p, "utf8"), "v3");
  assert.equal(readFileSync(`${p}.bak`, "utf8"), "v2");
  assert.deepEqual(readdirSync(STATE_DIR).filter((f) => f.startsWith("atomic.json.tmp")), []);
});

test("writeAtomic creates the file with mode 600", async () => {
  const { statSync } = await import("node:fs");
  const p = join(STATE_DIR, "mode.json");
  writeAtomic(p, "{}");
  assert.equal(statSync(p).mode & 0o777, 0o600);
});

test("the pending swap field round-trips", () => {
  const s = sample(2);
  s.books.pos1.pending = {
    sig: "5igSig",
    lastValidBlockHeight: 123_456,
    side: "USDC",
    in: "2500000",
    pool: "PoolAddr",
    at: 1_700_000_000,
    bumpCycle: true,
  };
  saveState("pend", s);
  assert.deepEqual(loadState("pend").books.pos1.pending, s.books.pos1.pending);

  s.books.pos1.pending = null;
  saveState("pend", s);
  assert.equal(loadState("pend").books.pos1.pending, null);
});

test("a corrupt state file is moved to .corrupt-<ts> and the .bak is loaded", () => {
  const err = quiet();
  saveState("corrupt", sample(1));
  saveState("corrupt", sample(2)); // .bak now holds sample(1)
  writeFileSync(file("corrupt"), "{ not json");
  const s = loadState("corrupt");
  err.mock.restore();

  assert.deepEqual(s, sample(1));
  assert.equal(existsSync(file("corrupt")), false);
  const aside = readdirSync(STATE_DIR).filter((f) => f.startsWith("corrupt.json.corrupt-"));
  assert.equal(aside.length, 1);
  assert.match(aside[0], /^corrupt\.json\.corrupt-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
  assert.equal(readFileSync(join(STATE_DIR, aside[0]), "utf8"), "{ not json");
  assert.ok(err.mock.calls.some((c) => String(c.arguments[0]).includes("ALERT")));
});

test("a corrupt state file with a corrupt .bak falls back to empty", () => {
  const err = quiet();
  writeFileSync(file("bothbad"), "garbage");
  writeFileSync(`${file("bothbad")}.bak`, "also garbage");
  const s = loadState("bothbad");
  err.mock.restore();
  assert.deepEqual(s, { books: {}, prices: [], history: [] });
  assert.equal(readdirSync(STATE_DIR).filter((f) => f.startsWith("bothbad.json.corrupt-")).length, 1);
});

test("a corrupt state file without a .bak falls back to empty", () => {
  const err = quiet();
  writeFileSync(file("nobak"), "");
  const s = loadState("nobak");
  err.mock.restore();
  assert.deepEqual(s, { books: {}, prices: [], history: [] });
});

test("missing top-level fields are filled with defaults", () => {
  writeFileSync(file("partial"), JSON.stringify({ prices: [{ at: 5, price: 1 }] }));
  assert.deepEqual(loadState("partial"), { books: {}, prices: [{ at: 5, price: 1 }], history: [] });
});

test("price samples saved as plain numbers load as stale samples (at 0)", () => {
  writeFileSync(file("oldprices"), JSON.stringify({ books: {}, prices: [150, 151.5], history: [] }));
  assert.deepEqual(loadState("oldprices").prices, [
    { at: 0, price: 150 },
    { at: 0, price: 151.5 },
  ]);
});

test("loadStateFrom says whether the state came from the backup", () => {
  const err = quiet();
  saveState("src", sample(1));
  assert.equal(loadStateFrom("src").fromBackup, false);
  saveState("src", sample(2));
  writeFileSync(file("src"), "{ torn");
  const out = loadStateFrom("src");
  err.mock.restore();
  assert.equal(out.fromBackup, true);
  assert.deepEqual(out.state, sample(1));
  assert.equal(loadStateFrom("src-missing").fromBackup, false);
});
