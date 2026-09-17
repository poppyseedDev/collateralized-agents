import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { Keypair } from "@solana/web3.js";
import { loadKeypair } from "./chain.js";

const dir = fileURLToPath(new URL("../keys/", import.meta.url));

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
