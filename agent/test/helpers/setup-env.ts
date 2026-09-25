/**
 * Test env. Imported (through env.ts or env-fallback.ts) first in every test file:
 * ES modules evaluate imports in order, so this runs before config.ts and state.ts read it.
 * - STATE_DIR is a fresh temp dir, never agent/state/.
 * - RPC URLs point at closed local ports, so an accidental RPC call fails at once
 *   instead of reaching devnet.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const PRIMARY_URL = "http://127.0.0.1:9";
export const FALLBACK_URL = "http://127.0.0.1:10";

export function setupEnv(withFallback: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "poa-agent-test-"));
  const live = fileURLToPath(new URL("../../state", import.meta.url));
  if (realpathSync(dir) === live) throw new Error("refusing to run tests against agent/state");
  process.env.STATE_DIR = dir;
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  process.env.RPC_URL = PRIMARY_URL;
  if (withFallback) process.env.RPC_URL_FALLBACK = FALLBACK_URL;
  else delete process.env.RPC_URL_FALLBACK;
  delete process.env.HEARTBEAT_SECRET;
  delete process.env.SLIPPAGE_BPS;
  delete process.env.POLL_MS;
  return dir;
}
