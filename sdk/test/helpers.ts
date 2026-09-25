import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { BN, type Position } from "../src/client.js";

/** An RPC URL nothing listens on, so any accidental network call fails at once instead of reaching a real cluster. */
export const DEAD_RPC = "http://127.0.0.1:9";

export const SDK_DIR = new URL("..", import.meta.url).pathname;

/** A fresh temp directory, removed after the test. */
export function tempDir(t: { after: (fn: () => void) => void }, prefix = "poa-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const nowSecs = () => Math.floor(Date.now() / 1000);

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` returns true or `ms` elapse. */
export async function waitFor(fn: () => boolean, ms = 5000, what = "condition") {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** True while a process (or, with a negative id, a process group) exists. */
export function exists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function position(fields: Partial<Record<keyof Position, unknown>> & { status: Position["status"] }): Position {
  const t = nowSecs();
  return {
    publicKey: PublicKey.unique(), trader: PublicKey.unique(), agent: PublicKey.unique(), nonce: new BN(1),
    principal: new BN(1_000_000_000), lockedCollateral: new BN(0), breach: "none",
    openedAt: new BN(t - 60), deadline: new BN(t + 3600), drawnAt: new BN(0), closedAt: new BN(0),
    returned: new BN(0), slashed: new BN(0), feePaid: new BN(0),
    ...fields,
  } as Position;
}
