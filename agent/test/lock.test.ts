import { STATE_DIR } from "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireLock, defaultLockIo, staleReason, type LockInfo, type LockIo } from "../src/lock.js";

const me: LockInfo = { pid: 7, host: "machine-1", bootId: "boot-b", startedAt: "2026-09-25T12:00:00.000Z" };

let n = 0;
const lockPath = () => join(STATE_DIR, `runner-${++n}.lock`);

/** Real file calls, with this process's identity and the pid check faked. */
const io = (who: LockInfo, alive: number[] = []): LockIo => ({ ...defaultLockIo, me: () => who, pidAlive: (pid) => alive.includes(pid) });

const hold = (path: string, over: Partial<LockInfo>) => writeFileSync(path, JSON.stringify({ ...me, pid: 42, ...over }));

test("takes a free lock, writing pid, host, boot id and start time, mode 600", () => {
  const path = lockPath();
  const release = acquireLock(path, io(me), () => {});
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), me);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  release();
  assert.equal(existsSync(path), false);
});

test("a live runner on the same host and boot keeps the lock: startup fails", () => {
  const path = lockPath();
  hold(path, {});
  assert.throws(() => acquireLock(path, io(me, [42]), () => {}), /another runner holds .*"pid":42/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 42, "left in place");
});

test("a dead pid on the same boot is stale and taken over with a log line", () => {
  const path = lockPath();
  hold(path, {});
  const logs: string[] = [];
  acquireLock(path, io(me, []), (l) => logs.push(l));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, me.pid);
  assert.match(logs[0], /taking over stale runner lock .*pid 42 is not running/);
});

test("a lock from an earlier boot is stale even if its pid is now in use (Fly restart)", () => {
  const path = lockPath();
  hold(path, { bootId: "boot-a" });
  const logs: string[] = [];
  acquireLock(path, io(me, [42]), (l) => logs.push(l));
  assert.match(logs[0], /before the last reboot/);
});

test("a lock holding this process's own pid is stale", () => {
  const path = lockPath();
  hold(path, { pid: me.pid, startedAt: "earlier" });
  const logs: string[] = [];
  acquireLock(path, io(me, [me.pid]), (l) => logs.push(l));
  assert.match(logs[0], /pid 7 is this process/);
});

test("a lock from another host is stale", () => {
  const path = lockPath();
  hold(path, { host: "machine-0" });
  const logs: string[] = [];
  acquireLock(path, io(me, [42]), (l) => logs.push(l));
  assert.match(logs[0], /taken on host machine-0/);
});

test("a torn lock file is stale", () => {
  const path = lockPath();
  writeFileSync(path, "");
  const logs: string[] = [];
  acquireLock(path, io(me), (l) => logs.push(l));
  assert.match(logs[0], /does not parse/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, me.pid);
});

test("without boot ids (macOS), the pid decides", () => {
  const noBoot = { ...me, bootId: null };
  assert.equal(staleReason({ ...noBoot, pid: 42 }, noBoot, () => true), null);
  assert.match(staleReason({ ...noBoot, pid: 42 }, noBoot, () => false) ?? "", /not running/);
  assert.equal(staleReason({ ...me, pid: 42 }, noBoot, () => true), null);
});

test("losing the race to re-create a stale lock fails instead of sharing it", () => {
  const path = lockPath();
  hold(path, {});
  const racing: LockIo = {
    ...io(me, []),
    remove: (p) => {
      defaultLockIo.remove(p);
      hold(p, { pid: 99 }); // another runner takes it in between
    },
  };
  assert.throws(() => acquireLock(path, racing, () => {}), /another runner took/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 99);
});

test("release leaves a lock that another runner has since taken", () => {
  const path = lockPath();
  const release = acquireLock(path, io(me), () => {});
  hold(path, { pid: 99 });
  release();
  assert.equal(JSON.parse(readFileSync(path, "utf8")).pid, 99);
  release(); // idempotent
});

test("the default pid check sees this process and not a free pid", () => {
  assert.equal(defaultLockIo.pidAlive(process.pid), true);
  assert.equal(defaultLockIo.pidAlive(2 ** 22 + 12345), false);
});
