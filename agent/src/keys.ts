import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";
import { loadKeypair } from "./chain.js";

const dir = process.env.KEYS_DIR
  ? `${process.env.KEYS_DIR.replace(/\/$/, "")}/`
  : fileURLToPath(new URL("../keys/", import.meta.url));

export function keyFor(id: string, create = false): Keypair {
  const path = `${dir}${id}.json`;
  if (!existsSync(path)) {
    if (!create) throw new Error(`missing key ${path}; run npm run setup`);
    mkdirSync(dir, { recursive: true });
    const kp = Keypair.generate();
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
    return kp;
  }
  return loadKeypair(path);
}

export function funderKey(): Keypair {
  return loadKeypair(process.env.FUNDER_KEYPAIR ?? `${homedir()}/.config/solana/id.json`);
}

/** The agent's operator key (creates, bonds, publishes) and its bound trading key. */
export function agentKeys(id: string, create = false) {
  return { operator: keyFor(id, create), executor: keyFor(`${id}-executor`, create) };
}

/** A JSON object from an env var, or null when it is unset. */
function jsonEnv(name: string): Record<string, unknown> | null {
  const raw = process.env[name]?.trim();
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // reported below
  }
  throw new Error(`${name} must be a JSON object keyed by agent id`);
}

/**
 * What the runner needs: the trading key's secret and only the operator's public key,
 * so a server can run agents without holding the key that controls their collateral.
 * EXECUTOR_KEYS ({"<id>": [secret bytes]}) and OPERATOR_PUBKEYS ({"<id>": "<base58>"})
 * take precedence over the files in keys/.
 */
export function runnerKeys(id: string): { operator: PublicKey; executor: Keypair } {
  const secret = jsonEnv("EXECUTOR_KEYS")?.[id];
  const executor = secret ? Keypair.fromSecretKey(Uint8Array.from(secret as number[])) : keyFor(`${id}-executor`);
  const pub = jsonEnv("OPERATOR_PUBKEYS")?.[id];
  const operator = pub ? new PublicKey(pub as string) : keyFor(id).publicKey;
  return { operator, executor };
}
