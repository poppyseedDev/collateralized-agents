import "./helpers/env.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair } from "@solana/web3.js";
import { runnerKeys } from "../src/keys.js";

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

test("runnerKeys takes the trading secret and only the operator's public key from env", () => {
  const executor = Keypair.generate();
  const operator = Keypair.generate().publicKey;
  const keys = withEnv(
    {
      EXECUTOR_KEYS: JSON.stringify({ "no-such-agent": Array.from(executor.secretKey) }),
      OPERATOR_PUBKEYS: JSON.stringify({ "no-such-agent": operator.toBase58() }),
    },
    () => runnerKeys("no-such-agent"),
  );
  assert.ok(keys.executor.publicKey.equals(executor.publicKey));
  assert.ok(keys.operator.equals(operator));
});

test("runnerKeys rejects env that is not a JSON object", () => {
  for (const bad of ["[1,2]", "not json", "42"]) {
    assert.throws(() => withEnv({ EXECUTOR_KEYS: bad }, () => runnerKeys("x")), /EXECUTOR_KEYS must be a JSON object/);
  }
});

test("runnerKeys falls back to key files, which a server without them does not have", () => {
  const keys = withEnv({ EXECUTOR_KEYS: undefined, OPERATOR_PUBKEYS: undefined, KEYS_DIR: undefined }, () => () => runnerKeys("no-such-agent"));
  assert.throws(keys, /missing key/);
});
