import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";
import { parseCli, parseId, parsePercentBps, parseScaled, parseSol, runnerFees, runnerTiming } from "../src/args.js";
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

  test("run: the buffer must cover a poll plus 30s for the settle transaction", () => {
    const timing = (...a: string[]) => runnerTiming(parseCli(["run", ...a]).values);
    assert.throws(() => timing("--buffer-min", "0"), /--buffer-min 0 \(0s\) must be at least --poll \(15s\) \+ 30s for the settle transaction = 45s/);
    assert.throws(() => timing("--buffer-min", "1", "--poll", "120"), /must be at least --poll \(120s\) \+ 30s .* = 150s; raise --buffer-min or lower --poll/);
    assert.equal(timing("--buffer-min", "0.75").bufferSecs, 45, "exactly poll + 30s is enough");
    assert.throws(() => timing("--buffer-min", "0.74"), /must be at least/);
    assert.equal(timing("--buffer-min", "1", "--poll", "30").bufferSecs, 60);
  });

  test("run: --poll must be whole seconds", () => {
    assert.throws(() => runnerTiming(parseCli(["run", "--poll", "1.5"]).values), /--poll must be a whole number/);
    assert.throws(() => runnerTiming(parseCli(["run", "--poll", "15s"]).values), /--poll must be a whole number/);
  });

  test("run: priority fees default and parse strictly", () => {
    assert.deepEqual(runnerFees(parseCli(["run"]).values), { priorityMicroLamports: 1000, urgentPriorityMicroLamports: 50_000 });
    assert.deepEqual(runnerFees(parseCli(["run", "--priority-fee", "0", "--priority-fee-urgent", "200000"]).values), { priorityMicroLamports: 0, urgentPriorityMicroLamports: 200_000 });
    assert.throws(() => runnerFees(parseCli(["run", "--priority-fee", "1.5"]).values), /--priority-fee must be a whole number/);
    assert.throws(() => runnerFees(parseCli(["run", "--priority-fee-urgent=-1"]).values), /--priority-fee-urgent must be a whole number/);
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

describe("strict amount parsing", () => {
  test("parseSol converts exactly, with no float rounding", () => {
    assert.equal(parseSol("1"), 1_000_000_000n);
    assert.equal(parseSol("1.5"), 1_500_000_000n);
    assert.equal(parseSol("0.000000001"), 1n);
    assert.equal(parseSol("0.1"), 100_000_000n);
    assert.equal(parseSol("0.29"), 290_000_000n, "0.29 * 1e9 is 289999999.99... as a float");
    assert.equal(parseSol("123456789.123456789"), 123_456_789_123_456_789n);
    assert.equal(parseSol("18446744073.709551615"), 2n ** 64n - 1n, "u64 max, beyond a double's precision");
    assert.equal(parseSol("007"), 7_000_000_000n);
  });

  test("parseSol rejects anything that is not a plain decimal", () => {
    for (const bad of ["1,5", "1.", ".5", "", " 1", "1 ", "-1", "+1", "1e3", "0x10", "1.0000000001", "NaN", "Infinity", "1.5 SOL", "1_000"]) {
      assert.throws(() => parseSol(bad), /--sol must be a SOL amount like 1.5, with at most 9 decimals/, JSON.stringify(bad));
    }
  });

  test("parseId accepts only whole numbers", () => {
    assert.equal(parseId("0"), 0);
    assert.equal(parseId("42"), 42);
    for (const bad of ["1.5", "1,5", "1a", "", "-1", "1e3", " 1", "9007199254740993"]) {
      assert.throws(() => parseId(bad), /--id must be a whole number/, JSON.stringify(bad));
    }
  });

  test("parsePercentBps is exact to 0.01% and strict", () => {
    assert.equal(parsePercentBps("30", "ratio"), 3000);
    assert.equal(parsePercentBps("12.5", "fee"), 1250);
    assert.equal(parsePercentBps("0.07", "fee"), 7, "0.07 * 100 is 7.000000000000001 as a float");
    for (const bad of ["1,5", "10.001", "-5", "", "5%"]) {
      assert.throws(() => parsePercentBps(bad, "fee"), /--fee must be a percentage/, JSON.stringify(bad));
    }
  });

  test("parseScaled is strict about the number it scales", () => {
    assert.equal(parseScaled("1", "min-hours", 3600), 3600);
    assert.equal(parseScaled("0.5", "minutes", 60), 30);
    for (const bad of ["1,5", "", "-1", "1e3", "abc", ".5"]) {
      assert.throws(() => parseScaled(bad, "minutes", 60), /--minutes must be a non-negative number/, JSON.stringify(bad));
    }
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

  test("agent deposit refuses \"1,5\" before touching the network", (t) => {
    const cwd = tempDir(t);
    assert.equal(poa(cwd, ["keygen", "--out", "op.json"]).code, 0);
    const r = poa(cwd, ["agent", "deposit", "--key", "op.json", "--agent", Keypair.generate().publicKey.toBase58(), "--sol", "1,5"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), "--sol must be a SOL amount like 1.5, with at most 9 decimals (got 1,5)");
  });

  test("agent create refuses a non-integer --id", (t) => {
    const cwd = tempDir(t);
    assert.equal(poa(cwd, ["keygen", "--out", "op.json"]).code, 0);
    const r = poa(cwd, ["agent", "create", "--key", "op.json", "--name", "n", "--ratio", "30", "--fee", "10", "--drawdown", "15", "--rules", "r", "--id", "1.5"]);
    assert.equal(r.code, 1);
    assert.equal(r.stderr.trim(), "--id must be a whole number (got 1.5)");
  });

  test("run refuses a bad --grace-sec before starting", (t) => {
    const cwd = tempDir(t);
    assert.equal(poa(cwd, ["keygen", "--out", "trading.json"]).code, 0);
    const r = poa(cwd, ["run", "--key", "trading.json", "--agent", Keypair.generate().publicKey.toBase58(), "--grace-sec", "soon"]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--grace-sec must be a non-negative number \(got soon\)/);
  });
});
