import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";

/** What a runner writes into its lock file. */
export type LockInfo = { pid: number; host: string; bootId: string | null; startedAt: string };

/** The process and file calls the lock makes, replaceable in tests. */
export type LockIo = {
  me: () => LockInfo;
  /** Whether `pid` is a running process on this machine. */
  pidAlive: (pid: number) => boolean;
  /** Creates `path` only if it does not exist; throws an EEXIST error if it does. */
  create: (path: string, data: string) => void;
  read: (path: string) => string;
  remove: (path: string) => void;
};

/** Linux's per-boot id; null elsewhere (macOS). */
function bootId(): string | null {
  try {
    return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    return null;
  }
}

export const defaultLockIo: LockIo = {
  me: () => ({ pid: process.pid, host: hostname(), bootId: bootId(), startedAt: new Date().toISOString() }),
  pidAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
    }
  },
  create: (path, data) => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, data);
    } finally {
      closeSync(fd);
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  remove: (path) => unlinkSync(path),
};

/**
 * Why a lock left by another runner no longer holds, or null if that runner may still be
 * running. A volume is attached to one machine at a time, so a lock from another host is
 * stale; on the same host, a different boot or a dead pid is stale. Pids restart from
 * small numbers after every boot (Fly restarts the whole VM), so the pid alone is only
 * trusted within the same boot.
 */
export function staleReason(held: LockInfo, me: LockInfo, pidAlive: (pid: number) => boolean): string | null {
  if (held.host !== me.host) return `it was taken on host ${held.host}`;
  if (held.bootId && me.bootId && held.bootId !== me.bootId) return "it was taken before the last reboot";
  if (held.pid === me.pid) return `its pid ${held.pid} is this process`;
  if (!pidAlive(held.pid)) return `pid ${held.pid} is not running`;
  return null;
}

/**
 * Takes `path` as this process's exclusive lock, so two runners never trade the same
 * books. A stale lock is taken over with a log line; a live one throws. Returns a
 * function that removes the lock if it is still ours.
 */
export function acquireLock(path: string, io: LockIo = defaultLockIo, log: (s: string) => void = console.log): () => void {
  const me = io.me();
  const data = JSON.stringify(me);
  const tryCreate = () => {
    try {
      io.create(path, data);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  };

  if (!tryCreate()) {
    let reason: string | null;
    let raw = "";
    try {
      raw = io.read(path);
      reason = staleReason(JSON.parse(raw) as LockInfo, me, io.pidAlive);
    } catch (e) {
      reason = `it does not parse (${(e as Error).message})`; // a crash while writing it
    }
    if (!reason) {
      throw new Error(`another runner holds ${path} (${raw.trim()}); stop it first, or delete the file if it is not running`);
    }
    log(`taking over stale runner lock ${path}: ${reason}`);
    io.remove(path);
    // Two runners starting at once may both see it stale; only one creates it.
    if (!tryCreate()) throw new Error(`another runner took ${path} while this one was starting`);
  }

  return () => {
    try {
      if (io.read(path) === data) io.remove(path);
    } catch {
      // already gone
    }
  };
}
