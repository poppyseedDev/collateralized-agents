import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { parseCli, runnerTiming } from "../src/args.js";
import { DEAD_RPC, SDK_DIR, tempDir } from "./helpers.js";

const POA = join(SDK_DIR, "bin", "poa.js");

/** Runs `poa` as a subprocess from cwd, with an RPC URL nothing listens on. */
function poa(cwd: string, args: string[], { umask }: { umask?: string } = {}) {
  const env = { ...process.env, POA_RPC_URL: DEAD_RPC };
  const r = umask
    ? spawnSync("/bin/sh", ["-c", `umask ${umask}; exec "$0" "$@"`, process.execPath, POA, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 })
    : spawnSync(process.execPath, [POA, ...args], { cwd, env, encoding: "utf8", timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("argument parsing", () => {
  test("run: --grace-sec and the other timing options", () => {
    const { values, positionals } = parseCli(["run", "--key", "t.json", "--agent", "AG", "--hook", "./bot.sh --x 'y'", "--grace-sec", "5", "--hold-min", "1.5", "--buffer-min", "2", "--poll", "3", "--paper"]);
    assert.deepEqual(positionals, ["run"]);
    assert.equal(values["grace-sec"], "5");
    assert.equal(values.hook, "./bot.sh --x 'y'");
    assert.equal(values.paper, true);
    assert.deepEqual(runnerTiming(values), { holdSecs: 90, bufferSecs: 120, graceSecs: 5, pollMs: 3000 });
  });

  test("run: defaults", () => {
    const { values } = parseCli(["run"]);
    assert.equal(values.state, ".poa/state.json");
    assert.equal(values.paper, false);
    assert.deepEqual(runnerTiming(values), { holdSecs: 900, bufferSecs: 300, graceSecs: 60, pollMs: 15_000 });
  });

  test("run: --grace-sec 0 is allowed (SIGKILL at once)", () => {
    assert.equal(runnerTiming(parseCli(["run", "--grace-sec", "0"]).values).graceSecs, 0);
  });

  test("run: timing values that do not parse are refused", () => {
    // a NaN settle time never comes due, so the runner would miss the deadline
    assert.throws(() => runnerTiming(parseCli(["run", "--hold-min", "abc"]).values), /--hold-min must be a non-negative number/);
    assert.throws(() => runnerTiming(parseCli(["run", "--buffer-min", "soon"]).values), /--buffer-min must be a non-negative number/);
    assert.throws(() => runnerTiming(parseCli(["run", "--grace-sec", "x"]).values), /--grace-sec must be a non-negative number/);
    assert.throws(() => runnerTiming(parseCli(["run", "--grace-sec=-1"]).values), /--grace-sec must be a non-negative number/);
    assert.throws(() => runnerTiming(parseCli(["run", "--poll", "0"]).values), /--poll must be a whole number of seconds above 0/);
    assert.throws(() => runnerTiming(parseCli(["run", "--poll", "fast"]).values), /--poll/);
  });

  test("dev cancel", () => {
    const { values, positionals } = parseCli(["dev", "cancel", "--key", "trader.json", "--agent", "AG", "--position", "POS"]);
    assert.deepEqual(positionals, ["dev", "cancel"]);
    assert.equal(values.key, "trader.json");
    assert.equal(values.agent, "AG");
    assert.equal(values.position, "POS");
  });

  test("dev open", () => {
    const { values, positionals } = parseCli(["dev", "open", "--key", "trader.json", "--agent", "AG", "--sol", "0.1"]);
    assert.deepEqual(positionals, ["dev", "open"]);
    assert.equal(values.sol, "0.1");
    assert.equal(values.minutes, "30");
  });

  test("agent create", () => {
    const { values, positionals } = parseCli(["agent", "create", "--key", "op.json", "--name", "My Bot", "--ratio", "30", "--fee", "10", "--drawdown", "15", "--rules", "r"]);
    assert.deepEqual(positionals, ["agent", "create"]);
    assert.equal(values.name, "My Bot");
    assert.equal(values.id, "1");
    assert.equal(values.assets, "SOL,USDC");
  });

  test("keygen defaults to trading.json", () => {
    assert.equal(parseCli(["keygen"]).values.out, "trading.json");
  });

  test("unknown options and missing values throw", () => {
    assert.throws(() => parseCli(["run", "--grace", "5"]), /Unknown option '--grace'/);
    assert.throws(() => parseCli(["run", "--grace-sec"]), /argument missing/);
  });
});

describe("poa (subprocess, from a directory outside sdk/)", () => {
  test("--help prints usage from any directory", (t) => {
    const cwd = tempDir(t);
    for (const args of [["--help"], []]) {
      const r = poa(cwd, args);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /poa — operate a Proof of Agent agent/);
      assert.match(r.stdout, /--grace-sec 60/);
      assert.match(r.stdout, /poa dev cancel/);
    }
  });

  test("keygen writes mode 600 even under umask 000, and says to gitignore it", (t) => {
    const cwd = tempDir(t);
    const r = poa(cwd, ["keygen", "--out", "k.json"], { umask: "000" });
    assert.equal(r.code, 0, r.stderr);
    const path = join(cwd, "k.json");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8"))));
    assert.ok(r.stdout.includes(`public key: ${kp.publicKey.toBase58()}`));
    assert.ok(r.stdout.includes("wrote k.json (mode 600)"));
    assert.ok(r.stdout.includes("keep it out of git: add k.json to your .gitignore"));
  });

  test("keygen defaults to ./trading.json", (t) => {
    const cwd = tempDir(t);
    const r = poa(cwd, ["keygen"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statSync(join(cwd, "trading.json")).mode & 0o777, 0o600);
  });

  test("keygen refuses to overwrite an existing file", (t) => {
    const cwd = tempDir(t);
    const path = join(cwd, "k.json");
    writeFileSync(path, "precious");
    const r = poa(cwd, ["keygen", "--out", "k.json"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /k.json already exists; not overwriting a key file/);
    assert.equal(readFileSync(path, "utf8"), "precious");
  });

  test("dev cancel needs --position, and fails before touching the network", (t) => {
    const cwd = tempDir(t);
    assert.equal(poa(cwd, ["keygen", "--out", "trader.json"]).code, 0);
    const agent = Keypair.generate().publicKey.toBase58();
    const r = poa(cwd, ["dev", "cancel", "--key", "trader.json", "--agent", agent]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), "--position is required");
    const r2 = poa(cwd, ["dev", "cancel", "--agent", agent, "--position", agent]);
    assert.equal(r2.code, 1);
    assert.equal(r2.stderr.trim(), "--key is required");
  });

  test("run refuses a bad --grace-sec before starting", (t) => {
    const cwd = tempDir(t);
    assert.equal(poa(cwd, ["keygen", "--out", "trading.json"]).code, 0);
    const r = poa(cwd, ["run", "--key", "trading.json", "--agent", Keypair.generate().publicKey.toBase58(), "--grace-sec", "soon"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--grace-sec must be a non-negative number \(got soon\)/);
  });
});
