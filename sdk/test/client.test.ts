import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, type Transaction, type TransactionInstruction } from "@solana/web3.js";
import {
  BN, IDL, PROGRAM_ID, PoaClient, agentPda, agentVaultPda, loadKeypair, positionPda, positionVaultPda, toBN, type Agent, type Position,
} from "../src/client.js";
import { DEAD_RPC, SDK_DIR, position as makePosition, tempDir } from "./helpers.js";

const U64_MAX = 2n ** 64n - 1n;

describe("toBN", () => {
  test("accepts safe-integer numbers, bigints and BNs", () => {
    assert.equal(toBN(0).toString(), "0");
    assert.equal(toBN(1_500_000_000).toString(), "1500000000");
    assert.equal(toBN(Number.MAX_SAFE_INTEGER).toString(), String(Number.MAX_SAFE_INTEGER));
    assert.equal(toBN(10n ** 18n).toString(), "1000000000000000000");
    assert.equal(toBN(U64_MAX).toString(), U64_MAX.toString());
    const bn = new BN("123456789012345678901");
    assert.equal(toBN(bn), bn, "a BN is passed through unchanged");
  });

  test("rejects floats, NaN, infinities and unsafe integers", () => {
    for (const bad of [1.5, 0.1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, 2 ** 64]) {
      assert.throws(() => toBN(bad, "lamports"), /lamports must be a whole number below 2\^53/, String(bad));
    }
  });

  test("rejects negatives of every kind", () => {
    assert.throws(() => toBN(-1), /must not be negative/);
    assert.throws(() => toBN(-1n), /must not be negative/);
    // borsh would encode BN(-5) as 5, so a negative BN must be refused too
    assert.throws(() => toBN(new BN(-5), "returnedLamports"), /returnedLamports must not be negative/);
  });
});

describe("PDAs", () => {
  const constantsRs = join(SDK_DIR, "../programs/proof_of_agent/src/constants.rs");
  const seedConst = (name: string) => {
    const m = readFileSync(constantsRs, "utf8").match(new RegExp(`pub const ${name}: &\\[u8\\] = b"([^"]*)";`));
    assert.ok(m, `${name} in constants.rs`);
    return Buffer.from(m[1]);
  };
  const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
  const le8 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

  test("program id is the IDL address", () => {
    assert.equal(PROGRAM_ID.toBase58(), IDL.address);
  });

  test("seeds match the program's constants.rs", { skip: !existsSync(constantsRs) && "programs/ not next to sdk/" }, () => {
    const operator = Keypair.generate().publicKey;
    const trader = Keypair.generate().publicKey;
    // create_agent.rs: [AGENT_SEED, operator, agent_id.to_le_bytes()]
    for (const id of [0n, 1n, 7n, 2n ** 40n]) {
      assert.ok(agentPda(operator, Number(id)).equals(derive([seedConst("AGENT_SEED"), operator.toBuffer(), le8(id)])));
      assert.ok(agentPda(operator, new BN(id.toString())).equals(derive([seedConst("AGENT_SEED"), operator.toBuffer(), le8(id)])));
    }
    const agent = agentPda(operator, 1);
    // [AGENT_VAULT_SEED, agent]
    assert.ok(agentVaultPda(agent).equals(derive([seedConst("AGENT_VAULT_SEED"), agent.toBuffer()])));
    // open_position.rs: [POSITION_SEED, agent, trader, nonce.to_le_bytes()]
    for (const nonce of [0n, 1n, U64_MAX, 0x0102030405060708n]) {
      const pos = positionPda(agent, trader, new BN(nonce.toString()));
      assert.ok(pos.equals(derive([seedConst("POSITION_SEED"), agent.toBuffer(), trader.toBuffer(), le8(nonce)])), `nonce ${nonce}`);
      // [POSITION_VAULT_SEED, position]
      assert.ok(positionVaultPda(pos).equals(derive([seedConst("POSITION_VAULT_SEED"), pos.toBuffer()])));
    }
  });

  test("seeds match the IDL's pda constants", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ix = (IDL.instructions as any[]).find((i) => i.name === "settle_position");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const constSeed = (acc: string) => Buffer.from(ix.accounts.find((a: any) => a.name === acc).pda.seeds[0].value).toString();
    assert.equal(constSeed("agent"), "agent");
    assert.equal(constSeed("agent_vault"), "agent_vault");
    assert.equal(constSeed("position"), "position");
    assert.equal(constSeed("position_vault"), "position_vault");
  });
});

describe("loadKeypair", () => {
  const writeKey = (dir: string, mode: number) => {
    const kp = Keypair.generate();
    const path = join(dir, `k-${mode.toString(8)}.json`);
    writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
    chmodSync(path, mode);
    return { kp, path };
  };

  test("loads a 600 key without warning", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    const { kp, path } = writeKey(tempDir(t), 0o600);
    assert.ok(loadKeypair(path).publicKey.equals(kp.publicKey));
    assert.equal(warn.mock.callCount(), 0);
  });

  for (const mode of [0o640, 0o604, 0o644, 0o666]) {
    test(`warns on mode ${mode.toString(8)}`, (t) => {
      const warn = t.mock.method(console, "warn", () => {});
      const { kp, path } = writeKey(tempDir(t), mode);
      assert.ok(loadKeypair(path).publicKey.equals(kp.publicKey));
      assert.equal(warn.mock.callCount(), 1);
      const msg = String(warn.mock.calls[0].arguments[0]);
      assert.match(msg, /readable by other users/);
      assert.ok(msg.includes(`mode ${mode.toString(8)}`) && msg.includes(`chmod 600 ${path}`), msg);
    });
  }

  test("a missing file throws from the read, not the permission check", (t) => {
    t.mock.method(console, "warn", () => {});
    assert.throws(() => loadKeypair(join(tempDir(t), "nope.json")), /ENOENT/);
  });
});

// ---- instruction building, against a provider that captures instead of sending ----

type IdlAccount = { name: string; writable?: boolean; signer?: boolean; address?: string };
type IdlIx = { name: string; discriminator: number[]; accounts: IdlAccount[]; args: { name: string; type: string }[] };
const idlIx = (name: string) => (IDL.instructions as unknown as IdlIx[]).find((i) => i.name === name)!;

function captureClient() {
  const signer = Keypair.generate();
  const client = new PoaClient(DEAD_RPC, signer);
  const sent: Transaction[] = [];
  client.program.provider.sendAndConfirm = async (tx: Transaction) => {
    sent.push(tx);
    return "fakesig111111111111111111111111";
  };
  client.connection.getLatestBlockhash = () => { throw new Error("network call in a test"); };
  const only = () => {
    assert.equal(sent.length, 1, "one transaction built");
    assert.equal(sent[0].instructions.length, 1, "one instruction");
    return sent.pop()!.instructions[0];
  };
  return { client, signer, only, sent };
}

/** Checks program id, discriminator (against the IDL and Anchor's sighash rule), and account order, keys and flags against the IDL. */
function checkIx(ix: TransactionInstruction, name: string, expected: Record<string, PublicKey>) {
  const def = idlIx(name);
  assert.ok(ix.programId.equals(PROGRAM_ID), "program id");
  assert.deepEqual([...ix.data.subarray(0, 8)], def.discriminator, "discriminator matches the IDL");
  const sighash = createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
  assert.deepEqual([...ix.data.subarray(0, 8)], [...sighash], "discriminator matches sha256('global:<name>')");
  assert.equal(ix.keys.length, def.accounts.length, "account count");
  def.accounts.forEach((acc, i) => {
    const key = ix.keys[i];
    const want = acc.address ? new PublicKey(acc.address) : expected[acc.name];
    assert.ok(want, `test gives an expected key for ${acc.name}`);
    assert.ok(key.pubkey.equals(want), `${acc.name}: ${key.pubkey.toBase58()} != ${want.toBase58()}`);
    assert.equal(key.isSigner, !!acc.signer, `${acc.name} signer flag`);
    assert.equal(key.isWritable, !!acc.writable, `${acc.name} writable flag`);
  });
  return ix.data.subarray(8);
}

describe("instruction building", () => {
  test("openPosition: accounts, flags and args", async () => {
    const { client, signer, only } = captureClient();
    const agent = Keypair.generate().publicKey;
    const { position, nonce, sig } = await client.openPosition(agent, 250_000_000n, 1800);
    assert.equal(sig, "fakesig111111111111111111111111");
    const ix = only();
    assert.ok(position.equals(positionPda(agent, signer.publicKey, nonce)));
    const args = checkIx(ix, "open_position", {
      trader: signer.publicKey, agent, position, position_vault: positionVaultPda(position),
    });
    assert.deepEqual(idlIx("open_position").args.map((a) => `${a.name}:${a.type}`), ["nonce:u64", "amount:u64", "duration_secs:i64"]);
    assert.equal(args.length, 24);
    assert.equal(args.readBigUInt64LE(0).toString(), nonce.toString());
    assert.equal(args.readBigUInt64LE(8), 250_000_000n);
    assert.equal(args.readBigInt64LE(16), 1800n);
    // and Anchor's own decoder agrees
    const decoded = client.program.coder.instruction.decode(ix.data);
    assert.equal(decoded.name, "openPosition");
    assert.equal(decoded.data.amount.toString(), "250000000");
  });

  test("openPosition rejects bad amounts before building anything", async () => {
    const { client, sent } = captureClient();
    const agent = Keypair.generate().publicKey;
    assert.throws(() => client.openPosition(agent, 0.5, 60), /lamports must be a whole number/);
    assert.throws(() => client.openPosition(agent, 1, -60), /durationSecs must not be negative/);
    assert.equal(sent.length, 0);
  });

  test("openPosition nonces are random u64s, unique over many calls", async () => {
    const { client, signer, sent } = captureClient();
    const agent = Keypair.generate().publicKey;
    const nonces = new Set<string>();
    let highBitSeen = false;
    for (let i = 0; i < 300; i++) {
      const { nonce, position } = await client.openPosition(agent, 1, 60);
      assert.ok(!nonce.isNeg() && nonce.lte(new BN(U64_MAX.toString())), "in u64 range");
      assert.ok(nonce.byteLength() <= 8);
      if (nonce.gt(new BN(Number.MAX_SAFE_INTEGER))) highBitSeen = true;
      // the nonce in the instruction data is the one the position was derived from
      const data = sent[i].instructions[0].data;
      assert.equal(data.readBigUInt64LE(8).toString(), nonce.toString());
      assert.ok(position.equals(positionPda(agent, signer.publicKey, nonce)));
      nonces.add(nonce.toString());
    }
    assert.equal(nonces.size, 300, "no repeated nonce");
    assert.ok(highBitSeen, "nonces use the full 64 bits, not just 53");
  });

  test("cancelPosition: accounts, flags and no args", async () => {
    const { client, signer, only } = captureClient();
    const agent = Keypair.generate().publicKey;
    const position = Keypair.generate().publicKey;
    await client.cancelPosition(agent, position);
    const args = checkIx(only(), "cancel_position", {
      trader: signer.publicKey, agent, position, position_vault: positionVaultPda(position),
    });
    assert.equal(args.length, 0);
  });

  test("drawFunds: accounts, flags and no args", async () => {
    const { client, signer, only } = captureClient();
    const agent = Keypair.generate().publicKey;
    const position = Keypair.generate().publicKey;
    await client.drawFunds(agent, position);
    const args = checkIx(only(), "draw_funds", {
      executor: signer.publicKey, agent, position, position_vault: positionVaultPda(position),
    });
    assert.equal(args.length, 0);
  });

  test("settlePosition: accounts, flags and the returned amount", async () => {
    const { client, signer, only } = captureClient();
    const operator = Keypair.generate().publicKey;
    const agentKey = agentPda(operator, 3);
    const a = { publicKey: agentKey, operator } as Agent;
    const p: Position = makePosition({ status: "trading", agent: agentKey });
    await client.settlePosition(a, p, 1_234_567_890_123n);
    const args = checkIx(only(), "settle_position", {
      executor: signer.publicKey, operator, agent: agentKey, agent_vault: agentVaultPda(agentKey),
      position: p.publicKey, position_vault: positionVaultPda(p.publicKey), trader: p.trader,
    });
    assert.equal(args.length, 8);
    assert.equal(args.readBigUInt64LE(0), 1_234_567_890_123n);
  });

  test("settlePosition encodes 0 and u64::MAX, and refuses a negative BN", async () => {
    const { client, only } = captureClient();
    const a = { publicKey: Keypair.generate().publicKey, operator: Keypair.generate().publicKey } as Agent;
    const p = makePosition({ status: "trading" });
    await client.settlePosition(a, p, 0);
    assert.equal(checkIx(only(), "settle_position", {
      executor: client.signer.publicKey, operator: a.operator, agent: a.publicKey, agent_vault: agentVaultPda(a.publicKey),
      position: p.publicKey, position_vault: positionVaultPda(p.publicKey), trader: p.trader,
    }).readBigUInt64LE(0), 0n);
    await client.settlePosition(a, p, U64_MAX);
    assert.equal(only().data.readBigUInt64LE(8), U64_MAX);
    assert.throws(() => client.settlePosition(a, p, new BN(-5)), /must not be negative/);
  });

  test("the system program account is the real one", () => {
    for (const name of ["open_position", "cancel_position", "draw_funds", "settle_position"]) {
      const sys = idlIx(name).accounts.find((a) => a.name === "system_program")!;
      assert.equal(sys.address, SystemProgram.programId.toBase58());
    }
  });
});
