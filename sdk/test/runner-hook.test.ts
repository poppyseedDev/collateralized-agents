/**
 * Hook lifecycle with real processes: tiny shell scripts in a temp dir stand in
 * for the operator's bot. Grace periods are a second or two so the file runs in seconds.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exists, nowSecs, position, waitFor } from "./helpers.js";
import { book, makeRunner } from "./runner-fixture.js";

/** Writes an executable /bin/sh script into dir and returns its path. `$D` in the body is the dir. */
function script(dir: string, name: string, body: string) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nexec 2>/dev/null\nD='${dir}'\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

const pgidOf = (pid: number) => Number(execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }).trim());
const readPid = (path: string) => Number(readFileSync(path, "utf8").trim());

/** Starts the hook for a fresh trading position and waits until the script has written its ready file. */
async function started(t: Parameters<typeof makeRunner>[0], body: string, opts: Parameters<typeof makeRunner>[1] = {}, bookFields = {}) {
  const fx = makeRunner(t, opts);
  const hookPath = script(fx.dir, "hook.sh", body);
  Object.assign((fx.runner as unknown as { opts: object }).opts, { hook: hookPath });
  const p = position({ status: "trading" });
  const b = book(p, bookFields);
  fx.r.state.active = b;
  fx.chain.positions = [p];
  fx.r.startHook(b);
  const pgid = fx.r.hook!.pid!;
  await waitFor(() => existsSync(join(fx.dir, "ready")), 5000, "hook ready");
  return { ...fx, p, b, pgid };
}

describe("hook process group", () => {
  test("the hook runs detached in its own process group, with the POA_* environment", async (t) => {
    const { r, dir, pgid, b, tradingKey } = await started(t, `
      ps -o pgid= -p $$ | tr -d ' ' > "$D/pgid"
      env | grep '^POA_' > "$D/env"
      touch "$D/ready"
      while :; do sleep 0.05; done`);
    assert.equal(readPid(join(dir, "pgid")), pgid, "the hook leads its own group");
    assert.notEqual(pgid, pgidOf(process.pid), "not the runner's group");
    const env = readFileSync(join(dir, "env"), "utf8");
    assert.ok(env.includes(`POA_POSITION=${b.position}`));
    assert.ok(env.includes("POA_PRINCIPAL_SOL=1.0000"));
    assert.ok(env.includes("POA_PRINCIPAL_LAMPORTS=1000000000"));
    assert.ok(env.includes(`POA_SETTLE_BY=${b.settleAt}`));
    assert.ok(env.includes(`POA_DEADLINE=${b.deadline}`));
    assert.ok(env.includes(`POA_WALLET=${tradingKey.publicKey.toBase58()}`));
    assert.ok(env.includes("POA_PAPER=0"));
    await r.stopHook(b.deadline);
    assert.ok(!exists(-pgid));
  });

  test("at settle time the whole group gets SIGTERM and may unwind", async (t) => {
    const { r, dir, pgid, p, b, logs, chain } = await started(t, `
      trap 'echo term > "$D/parent-term"; exit 0' TERM
      ( trap 'sleep 0.3; echo term > "$D/child-term"; exit 0' TERM; while :; do sleep 0.05; done ) &
      echo $! > "$D/child.pid"
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 5 });
    const child = readPid(join(dir, "child.pid"));
    assert.equal(pgidOf(child), pgid, "the background child is in the hook's group");
    const t0 = Date.now();
    await r.settle(p, b);
    const took = Date.now() - t0;
    assert.equal(readFileSync(join(dir, "parent-term"), "utf8").trim(), "term");
    assert.equal(readFileSync(join(dir, "child-term"), "utf8").trim(), "term", "the child got SIGTERM and finished unwinding");
    assert.ok(!exists(-pgid) && !exists(child));
    assert.ok(took < 3000, `returned once the group was gone (${took}ms), not after the full grace`);
    assert.ok(logs.some((l) => /sending SIGTERM to its process group, 5s to finish/.test(l)));
    assert.ok(!logs.some((l) => l.includes("SIGKILL")), "no SIGKILL needed");
    assert.equal(chain.settled.length, 1);
  });

  test("a hook that ignores SIGTERM gets the grace period, then SIGKILL", async (t) => {
    const { r, pgid, b, logs } = await started(t, `
      trap '' TERM
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 1 });
    const t0 = Date.now();
    await r.stopHook(b.deadline);
    const took = Date.now() - t0;
    assert.ok(took >= 1000, `waited the grace period (${took}ms)`);
    assert.ok(took < 3000, `then killed it promptly (${took}ms)`);
    assert.ok(logs.some((l) => l.includes("1s to finish")));
    assert.ok(logs.some((l) => l.includes("sending SIGKILL to its process group")));
    assert.ok(!exists(-pgid));
  });

  test("a hook that ignores SIGTERM and has a background child: the whole group ends dead", async (t) => {
    const { r, dir, pgid, p, b, chain } = await started(t, `
      trap '' TERM
      sh -c 'trap "" TERM; while :; do sleep 0.05; done' &
      echo $! > "$D/child.pid"
      sleep 1000 &
      echo $! > "$D/sleeper.pid"
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 1 });
    const pids = [pgid, readPid(join(dir, "child.pid")), readPid(join(dir, "sleeper.pid"))];
    for (const pid of pids) assert.equal(pgidOf(pid), pgid);
    let groupAliveAtRead: boolean | null = null;
    chain.onBalance = () => { groupAliveAtRead = exists(-pgid); };
    await r.settle(p, b);
    assert.equal(groupAliveAtRead, false, "balance read only after the group was gone");
    assert.ok(!exists(-pgid));
    for (const pid of pids) assert.ok(!exists(pid), `pid ${pid} is dead`);
  });

  test("the balance is read only after every process in the group has exited", async (t) => {
    // the parent exits at once on SIGTERM; its child takes a while to unwind
    const { r, dir, pgid, p, b, chain, logs } = await started(t, `
      trap 'exit 0' TERM
      ( trap 'sleep 0.8; touch "$D/child-done"; exit 0' TERM; while :; do sleep 0.05; done ) &
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 5 });
    const reads: { groupAlive: boolean; childDone: boolean }[] = [];
    chain.onBalance = () => reads.push({ groupAlive: exists(-pgid), childDone: existsSync(join(dir, "child-done")) });
    await r.settle(p, b);
    assert.deepEqual(reads, [{ groupAlive: false, childDone: true }]);
    assert.ok(!logs.some((l) => l.includes("SIGKILL")));
  });

  test("a hook with no time left before the deadline is killed without a grace period", async (t) => {
    const { r, pgid, b, logs } = await started(t, `
      trap '' TERM
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 60 }, { deadline: nowSecs() + 10 });
    const t0 = Date.now();
    await r.stopHook(b.deadline);
    assert.ok(Date.now() - t0 < 2000);
    assert.ok(logs.some((l) => l.includes(", 0s to finish")));
    assert.ok(logs.some((l) => l.includes("SIGKILL")));
    assert.ok(!exists(-pgid));
  });

  test("the grace period is cut to end 30s before the deadline", async (t) => {
    const { r, pgid, b, logs } = await started(t, `
      trap '' TERM
      touch "$D/ready"
      while :; do sleep 0.05; done`, { graceSecs: 60 }, { deadline: nowSecs() + 31 });
    const t0 = Date.now();
    await r.stopHook(b.deadline);
    const took = Date.now() - t0;
    // 1s, or 0s if the clock ticked over between building the book and stopping
    assert.ok(logs.some((l) => /, [01]s to finish/.test(l)), logs.join("\n"));
    assert.ok(took < 3000, `${took}ms`);
    assert.ok(!exists(-pgid));
  });
});

describe("early hook exit", () => {
  test("a hook that exits early is detected and settles before settleAt", async (t) => {
    const { r, chain, logs } = await started(t, `touch "$D/ready"; sleep 0.1; exit 3`, {}, { settleAt: nowSecs() + 600 });
    await waitFor(() => r.hookExited, 5000, "hook exit");
    assert.ok(logs.some((l) => l === "hook exited with code 3"));
    await r.tick();
    assert.equal(chain.settled.length, 1);
    assert.equal(r.state.active, null);
  });

  test("a hook killed by a signal is detected as an exit too", async (t) => {
    const { r, chain, logs } = await started(t, `touch "$D/ready"; sleep 0.1; kill -KILL $$`, {}, { settleAt: nowSecs() + 600 });
    await waitFor(() => r.hookExited, 5000, "hook exit");
    assert.ok(logs.some((l) => l === "hook exited with signal SIGKILL"), logs.join("\n"));
    await r.tick();
    assert.equal(chain.settled.length, 1);
  });

  test("an early exit still waits for the hook's leftover children before reading the balance", async (t) => {
    const { r, dir, pgid, chain } = await started(t, `
      ( trap 'sleep 0.3; touch "$D/child-done"; exit 0' TERM; while :; do sleep 0.05; done ) &
      touch "$D/ready"
      exit 0`, { graceSecs: 5 }, { settleAt: nowSecs() + 600 });
    await waitFor(() => r.hookExited, 5000, "hook exit");
    assert.ok(exists(-pgid), "the child outlives the shell");
    const reads: boolean[] = [];
    chain.onBalance = () => reads.push(exists(-pgid) || !existsSync(join(dir, "child-done")));
    await r.tick();
    assert.equal(chain.settled.length, 1);
    assert.deepEqual(reads, [false]);
  });

  test("a running hook does not trigger an early settle", async (t) => {
    const { r, chain, pgid } = await started(t, `touch "$D/ready"; while :; do sleep 0.05; done`, {}, { settleAt: nowSecs() + 600 });
    await r.tick();
    assert.equal(r.hookExited, false);
    assert.equal(chain.settled.length, 0);
    await r.stopHook(nowSecs() + 3600);
    assert.ok(!exists(-pgid));
  });

  test("stop() sends SIGTERM to the hook's group", async (t) => {
    const { r, dir, pgid } = await started(t, `
      trap 'touch "$D/term"; exit 0' TERM
      touch "$D/ready"
      while :; do sleep 0.05; done`);
    r.stop();
    await waitFor(() => !exists(-pgid), 5000, "group gone");
    assert.ok(existsSync(join(dir, "term")));
  });

  test("a draw with a hook configured starts it", async (t) => {
    const fx = makeRunner(t);
    const hookPath = script(fx.dir, "hook.sh", `echo "$POA_POSITION" > "$D/ran"`);
    Object.assign((fx.runner as unknown as { opts: object }).opts, { hook: hookPath });
    const p = position({ status: "open" });
    fx.chain.positions = [p];
    await fx.r.tick();
    await waitFor(() => fx.r.hookExited, 5000, "hook exit");
    assert.equal(readFileSync(join(fx.dir, "ran"), "utf8").trim(), p.publicKey.toBase58());
  });
  test("a hook spawn error is logged and counts as an exit instead of crashing the runner", async (t) => {
    const { r, logs, chain, p, pgid } = await started(t, `touch "$D/ready"; while :; do sleep 0.05; done`, {}, { settleAt: nowSecs() + 600 });
    // an 'error' event with no listener would throw here
    (r.hook as unknown as import("node:events").EventEmitter).emit("error", new Error("spawn /bin/sh EACCES"));
    assert.equal(r.hookExited, true);
    assert.ok(logs.some((l) => l === "hook failed to start: spawn /bin/sh EACCES"));
    await r.tick();
    assert.equal(chain.settled.length, 1, "settles early, as for an exited hook");
    assert.ok(chain.settled[0].position.equals(p.publicKey));
    assert.ok(!exists(-pgid));
  });
});
