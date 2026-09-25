/**
 * Runs hooks/hummingbot-orca.sh against a mock Hummingbot Gateway on 127.0.0.1.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { SDK_DIR, nowSecs, tempDir, waitFor } from "./helpers.js";

const HOOK = join(SDK_DIR, "hooks", "hummingbot-orca.sh");
const SOL_MINT = "So11111111111111111111111111111111111111112";

const missing = ["python3", "zsh", "curl"].filter((bin) => spawnSync(bin, ["--version"], { stdio: "ignore" }).status !== 0);
const skip = missing.length ? `needs ${missing.join(", ")} on PATH, not found` : false;

type Req = { path: string; raw: string; body: Record<string, unknown> };

/** A mock Gateway: the USDC balance goes up by `bought` after a swap into USDC and down by the amount sold after a swap out of it. */
async function mockGateway(t: { after: (fn: () => void) => void }, { usdcBefore = 10, bought = 2.5 } = {}) {
  const requests: Req[] = [];
  let usdc = usdcBefore;
  let usdcMint = "";
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        requests.push({ path: req.url!, raw, body: { __invalid_json: true } });
        res.writeHead(400).end("{}");
        return;
      }
      requests.push({ path: req.url!, raw, body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/chains/solana/balances") {
        usdcMint = String((body.tokens as string[])[0]);
        res.end(JSON.stringify({ balances: { [usdcMint]: usdc } }));
      } else if (req.url === "/trading/clmm/execute-swap") {
        usdc = body.quoteToken === usdcMint ? usdc + bought : usdc - Number(body.amount);
        res.end(JSON.stringify({ signature: "mocksig", status: 1 }));
      } else {
        res.writeHead(404).end("{}");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests };
}

function runHook(env: Record<string, string>) {
  const child = spawn(HOOK, [], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env },
  });
  let out = "";
  child.stdout!.on("data", (c) => (out += c));
  child.stderr!.on("data", (c) => (out += c));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.on("exit", (code, signal) => r({ code, signal })));
  return { child, done, output: () => out };
}

const swaps = (reqs: Req[]) => reqs.filter((r) => r.path === "/trading/clmm/execute-swap");
const balances = (reqs: Req[]) => reqs.filter((r) => r.path === "/chains/solana/balances");

describe("hooks/hummingbot-orca.sh", { skip }, () => {
  test("sends valid JSON with the expected fields, and sells back only what it bought", async (t) => {
    const gw = await mockGateway(t);
    const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const h = runHook({
      GATEWAY_URL: gw.url, GATEWAY_NETWORK: "solana-devnet", POA_WALLET: wallet, POA_PRINCIPAL_SOL: "1.0000",
      POA_SETTLE_BY: String(nowSecs() + 3600), POA_PAPER: "0", HOLD_SECS: "0", TRADE_SHARE: "0.5", POOL: "PoolAddr111", USDC_MINT: "UsdcMint111",
    });
    const { code } = await h.done;
    assert.equal(code, 0, h.output());
    assert.deepEqual(gw.requests.map((r) => r.path), [
      "/chains/solana/balances", "/trading/clmm/execute-swap", "/chains/solana/balances", "/trading/clmm/execute-swap",
    ]);
    for (const r of gw.requests) assert.ok(!r.body.__invalid_json, `valid JSON: ${r.raw}`);
    for (const b of balances(gw.requests)) {
      assert.deepEqual(b.body, { network: "devnet", address: wallet, tokens: ["UsdcMint111"] });
    }
    const [buy, sellBack] = swaps(gw.requests).map((r) => r.body);
    assert.deepEqual(buy, {
      chainNetwork: "solana-devnet", connector: "orca", walletAddress: wallet, baseToken: SOL_MINT, quoteToken: "UsdcMint111",
      amount: 0.5, side: "SELL", poolAddress: "PoolAddr111", slippagePct: 2,
    });
    assert.deepEqual(sellBack, { ...buy, baseToken: "UsdcMint111", quoteToken: SOL_MINT, amount: 2.5 });
    assert.match(h.output(), /selling 2.5 USDC back into SOL/);
    assert.match(h.output(), /\[hummingbot-hook\] done/);
  });

  test("paper mode does not trade", async (t) => {
    const gw = await mockGateway(t);
    const h = runHook({
      GATEWAY_URL: gw.url, POA_WALLET: "W", POA_PRINCIPAL_SOL: "1", POA_SETTLE_BY: String(nowSecs() + 3600), POA_PAPER: "1",
    });
    assert.equal((await h.done).code, 0, h.output());
    assert.equal(swaps(gw.requests).length, 0);
    assert.match(h.output(), /paper mode: not trading/);
  });

  test("values with quotes, $(...) and backticks reach the Gateway verbatim, with no injection", async (t) => {
    const gw = await mockGateway(t);
    const dir = tempDir(t);
    const evil = (n: number) =>
      `x"; touch ${dir}/pwned${n}a; echo "$(touch ${dir}/pwned${n}b)\`touch ${dir}/pwned${n}c\`'); import os; os.system('touch ${dir}/pwned${n}d'); ('\\"}`;
    const env = {
      GATEWAY_URL: gw.url, GATEWAY_NETWORK: `solana-${evil(1)}`, POA_WALLET: evil(2), POOL: evil(3), USDC_MINT: evil(4), SOL_MINT: evil(5),
      POA_PRINCIPAL_SOL: "1", POA_SETTLE_BY: String(nowSecs() + 3600), POA_PAPER: "0", HOLD_SECS: "0", TRADE_SHARE: "0.5",
    };
    const h = runHook(env);
    assert.equal((await h.done).code, 0, h.output());
    assert.deepEqual(readdirSync(dir), [], "no injected command ran");
    assert.equal(gw.requests.length, 4, h.output());
    for (const r of gw.requests) assert.ok(!r.body.__invalid_json, `valid JSON: ${r.raw}`);
    const bal = balances(gw.requests)[0].body;
    assert.equal(bal.address, env.POA_WALLET);
    assert.equal(bal.network, evil(1));
    assert.deepEqual(bal.tokens, [env.USDC_MINT]);
    const [buy, sellBack] = swaps(gw.requests).map((r) => r.body);
    assert.equal(buy.walletAddress, env.POA_WALLET);
    assert.equal(buy.poolAddress, env.POOL);
    assert.equal(buy.chainNetwork, env.GATEWAY_NETWORK);
    assert.equal(buy.baseToken, env.SOL_MINT);
    assert.equal(buy.quoteToken, env.USDC_MINT);
    assert.equal(buy.side, "SELL");
    assert.equal(sellBack.baseToken, env.USDC_MINT);
    assert.equal(sellBack.side, "SELL");
    assert.equal(Object.keys(buy).length, 9, "no extra fields smuggled in");
  });

  test("a numeric value that is not a number fails the hook instead of reaching the Gateway", async (t) => {
    const gw = await mockGateway(t);
    const dir = tempDir(t);
    const h = runHook({
      GATEWAY_URL: gw.url, POA_WALLET: "W", POA_PRINCIPAL_SOL: `1$(touch ${dir}/pwned)`, POA_SETTLE_BY: String(nowSecs() + 3600),
      POA_PAPER: "0", HOLD_SECS: "0",
    });
    assert.notEqual((await h.done).code, 0);
    assert.equal(swaps(gw.requests).length, 0);
    assert.ok(!existsSync(join(dir, "pwned")));
  });

  test("SIGTERM to the process group unwinds: sells the bought USDC back and exits 0", async (t) => {
    const gw = await mockGateway(t);
    const h = runHook({
      GATEWAY_URL: gw.url, POA_WALLET: "W", POA_PRINCIPAL_SOL: "2", POA_SETTLE_BY: String(nowSecs() + 3600), POA_PAPER: "0",
      HOLD_SECS: "600", TRADE_SHARE: "0.25", USDC_MINT: "UsdcMint111",
    });
    t.after(() => { try { process.kill(-h.child.pid!, "SIGKILL"); } catch { /* gone */ } });
    await waitFor(() => swaps(gw.requests).length === 1, 10_000, "first swap");
    assert.equal(swaps(gw.requests)[0].body.amount, 0.5);
    await waitFor(() => /hummingbot-hook\] selling 0.5/.test(h.output()), 5000, "hook to log the swap");
    await new Promise((r) => setTimeout(r, 300)); // let it reach the hold loop
    const t0 = Date.now();
    process.kill(-h.child.pid!, "SIGTERM"); // what the runner does at settle time
    const { code, signal } = await h.done;
    assert.equal(signal, null, h.output());
    assert.equal(code, 0, h.output());
    assert.ok(Date.now() - t0 < 5000, "did not sit out the hold");
    assert.match(h.output(), /asked to stop, unwinding/);
    assert.match(h.output(), /selling 2.5 USDC back into SOL/);
    const all = swaps(gw.requests);
    assert.equal(all.length, 2);
    assert.deepEqual([all[1].body.baseToken, all[1].body.quoteToken, all[1].body.amount], ["UsdcMint111", SOL_MINT, 2.5]);
  });
});
