import { freshRequire, setEnv } from "./helpers/stubs";
import { blob } from "./helpers/fakeBlob";
import { MAINNET_GENESIS, rpc } from "./helpers/fakeSolana";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Keypair, LAMPORTS_PER_SOL, SystemInstruction, SystemProgram } from "@solana/web3.js";

type Route = typeof import("@/app/api/faucet/route");

const AMOUNT = 0.2 * LAMPORTS_PER_SOL;
const FAUCET = Keypair.generate();
const today = () => new Date().toISOString().slice(0, 10);
const dayPrefix = () => `faucet-daily/${today()}/`;
const walletMarker = (addr: string) => `faucet/${addr}.json`;
const dayMarker = (addr: string) => `${dayPrefix()}${addr}.json`;
const newWallet = () => Keypair.generate().publicKey.toBase58();

let route: Route;
let ip = 0;
/** Loads the route afresh, so env read at load time, the cluster check cache and the rate limiter reset. */
const load = (env: Record<string, string | undefined> = {}) => {
  setEnv(env);
  route = freshRequire<Route>("@/app/api/faucet/route");
};

const post = (body: unknown, fromIp = `10.0.${Math.floor(++ip / 250)}.${ip % 250}`) =>
  route.POST(
    new Request("https://app.test/api/faucet", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": fromIp },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
const drip = (address: string) => post({ address });

/** Asserts the status and that the response is uncached JSON with an error message. */
async function expectError(res: Response, status: number, pattern?: RegExp) {
  assert.equal(res.status, status);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(typeof body.error, "string");
  if (pattern) assert.match(body.error, pattern);
  return body;
}

const fillDay = (n: number) => {
  for (let i = 0; i < n; i++) blob.files.set(`${dayPrefix()}prefill-${i}.json`, "{}");
};

beforeEach(() => {
  blob.reset();
  rpc.reset();
  mock.method(console, "error", () => {});
  (process.env as Record<string, string>).NODE_ENV = "test";
  load({
    FAUCET_KEYPAIR: JSON.stringify([...FAUCET.secretKey]),
    BLOB_READ_WRITE_TOKEN: "test-token",
    RPC_URL: "https://rpc.devnet.test",
    NEXT_PUBLIC_RPC_URL: undefined,
    NEXT_PUBLIC_CLUSTER: "devnet",
    FAUCET_DAILY_CAP_SOL: "1", // 5 drops a day
  });
});
afterEach(() => mock.restoreAll());

describe("faucet cluster guard", () => {
  it("is enabled when the RPC reports the devnet genesis hash", async () => {
    const res = await route.GET();
    assert.deepEqual(await res.json(), { enabled: true, amountSol: 0.2, remainingDrops: 5 });
    assert.deepEqual(rpc.urls, ["https://rpc.devnet.test", "https://rpc.devnet.test"]);
  });

  it("is disabled, and refuses to drip, for any other genesis hash", async () => {
    rpc.genesis = MAINNET_GENESIS;
    assert.deepEqual(await (await route.GET()).json(), { enabled: false });
    await expectError(await drip(newWallet()), 404, /only available on devnet/);
    assert.equal(rpc.sent.length, 0);
    assert.equal(blob.calls.put.length, 0);
  });

  it("doesn't trust NEXT_PUBLIC_CLUSTER alone: a non-devnet cluster is refused without asking the RPC", async () => {
    load({ NEXT_PUBLIC_CLUSTER: "mainnet-beta" });
    assert.deepEqual(await (await route.GET()).json(), { enabled: false });
    await expectError(await drip(newWallet()), 404);
    assert.equal(rpc.genesisCalls, 0);
  });

  it("caches a successful check but not a network failure", async () => {
    rpc.failGenesis = true;
    assert.deepEqual(await (await route.GET()).json(), { enabled: false });
    rpc.failGenesis = false;
    assert.equal((await (await route.GET()).json()).enabled, true);
    assert.equal((await (await route.GET()).json()).enabled, true);
    assert.equal(rpc.genesisCalls, 2);
  });

  for (const url of ["http://127.0.0.1:8899", "http://localhost:8899", "http://[::1]:8899"]) {
    it(`allows localnet in development with a local RPC (${url})`, async () => {
      (process.env as Record<string, string>).NODE_ENV = "development";
      load({ NEXT_PUBLIC_CLUSTER: "localnet", RPC_URL: url });
      assert.equal((await (await route.GET()).json()).enabled, true);
      assert.equal(rpc.genesisCalls, 0);
    });
  }

  it("refuses localnet in production, even with a local RPC", async () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    load({ NEXT_PUBLIC_CLUSTER: "localnet", RPC_URL: "http://127.0.0.1:8899" });
    assert.deepEqual(await (await route.GET()).json(), { enabled: false });
    await expectError(await drip(newWallet()), 404);
  });

  it("refuses localnet with a remote RPC", async () => {
    (process.env as Record<string, string>).NODE_ENV = "development";
    for (const url of ["https://api.mainnet-beta.solana.com", "http://127.0.0.1.evil.test:8899", "not a url"]) {
      load({ NEXT_PUBLIC_CLUSTER: "localnet", RPC_URL: url });
      assert.deepEqual(await (await route.GET()).json(), { enabled: false }, url);
    }
  });

  it("is disabled without a faucet key or Blob storage", async () => {
    for (const env of [{ FAUCET_KEYPAIR: undefined }, { FAUCET_KEYPAIR: "not json" }, { BLOB_READ_WRITE_TOKEN: undefined }]) {
      load({ FAUCET_KEYPAIR: JSON.stringify([...FAUCET.secretKey]), BLOB_READ_WRITE_TOKEN: "test-token", ...env });
      assert.deepEqual(await (await route.GET()).json(), { enabled: false });
      await expectError(await drip(newWallet()), 404);
    }
    assert.equal(rpc.sent.length, 0);
  });
});

describe("faucet status", () => {
  it("reports drops left, limited by today's cap and by the balance above the reserve", async () => {
    fillDay(2);
    assert.equal((await (await route.GET()).json()).remainingDrops, 3);
    rpc.balance = 0.5 * LAMPORTS_PER_SOL; // (0.5 - 0.05 reserve) / 0.2 = 2
    assert.equal((await (await route.GET()).json()).remainingDrops, 2);
    rpc.balance = 0;
    assert.equal((await (await route.GET()).json()).remainingDrops, 0);
  });

  it("reports disabled rather than throwing when the RPC fails", async () => {
    rpc.failBalance = true;
    const res = await route.GET();
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false });
  });
});

describe("faucet drip", () => {
  it("sends 0.2 SOL from the faucet key and records the signature", async () => {
    const addr = newWallet();
    const res = await drip(addr);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, sig: "sig1", amountSol: 0.2 });
    assert.equal(rpc.sent.length, 1);
    const [ix] = rpc.sent[0].instructions;
    assert.ok(ix.programId.equals(SystemProgram.programId));
    const t = SystemInstruction.decodeTransfer(ix);
    assert.equal(t.fromPubkey.toBase58(), FAUCET.publicKey.toBase58());
    assert.equal(t.toPubkey.toBase58(), addr);
    assert.equal(Number(t.lamports), AMOUNT);
    assert.ok(rpc.sent[0].verifySignatures());
    const marker = JSON.parse(blob.files.get(walletMarker(addr))!);
    assert.equal(marker.state, "sent");
    assert.equal(marker.sig, "sig1");
    assert.ok(blob.files.has(dayMarker(addr)));
  });

  it("rejects an invalid address with 400 JSON", async () => {
    for (const body of [{ address: "not-a-key" }, { address: "0x1234" }, {}, { address: 42 }, { address: [1, 2, 3] }, "{bad json", "null"]) {
      await expectError(await post(body), 400, /valid Solana address/);
    }
    assert.equal(rpc.sent.length, 0);
    assert.equal(blob.calls.put.length, 0);
  });

  it("pays each wallet once", async () => {
    const addr = newWallet();
    assert.equal((await drip(addr)).status, 200);
    await expectError(await drip(addr), 409, /already received/);
    assert.equal(rpc.sent.length, 1);
  });

  it("pays once when two requests for the same wallet race", async () => {
    const addr = newWallet();
    const results = await Promise.all([drip(addr), drip(addr), drip(addr)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
    for (const r of results.filter((r) => r.status === 409)) await expectError(r, 409);
    assert.equal(rpc.sent.length, 1);
    assert.equal([...blob.files.keys()].filter((k) => k.startsWith(dayPrefix())).length, 1);
  });

  it("stops at the daily cap without claiming the wallet", async () => {
    fillDay(5);
    const addr = newWallet();
    await expectError(await drip(addr), 503, /budget is used up/);
    assert.equal(blob.files.has(walletMarker(addr)), false);
    assert.equal(rpc.sent.length, 0);
  });

  it("backs out when a concurrent request pushes the day over the cap", async () => {
    fillDay(4);
    const addr = newWallet();
    let dayLists = 0;
    blob.beforeList = (prefix) => {
      // Between this request's first count and its recount, another request lands its day marker.
      if (prefix === dayPrefix() && ++dayLists === 2) blob.files.set(`${dayPrefix()}concurrent.json`, "{}");
    };
    await expectError(await drip(addr), 503, /budget is used up/);
    assert.equal(rpc.sent.length, 0);
    assert.equal(blob.files.has(walletMarker(addr)), false, "wallet marker released");
    assert.equal(blob.files.has(dayMarker(addr)), false, "day marker released");
    assert.ok(blob.files.has(`${dayPrefix()}concurrent.json`), "the other request's marker is untouched");
    // The wallet can try again another day (here: once there's room).
    blob.beforeList = null;
    blob.files.delete(`${dayPrefix()}concurrent.json`);
    assert.equal((await drip(addr)).status, 200);
  });

  it("never sends more than the cap when many wallets race", async () => {
    fillDay(3);
    const results = await Promise.all(Array.from({ length: 6 }, () => drip(newWallet())));
    const ok = results.filter((r) => r.status === 200).length;
    assert.ok(ok <= 2, `${ok} payouts with 2 left`);
    assert.equal(rpc.sent.length, ok);
    for (const r of results.filter((r) => r.status !== 200)) await expectError(r, 503);
    const dayCount = [...blob.files.keys()].filter((k) => k.startsWith(dayPrefix())).length;
    assert.equal(dayCount, 3 + ok, "backed-out requests removed their day markers");
    assert.equal([...blob.files.keys()].filter((k) => k.startsWith("faucet/")).length, ok, "and their wallet markers");
  });

  it("treats a cap of 0 as off and an invalid cap as the default 20 SOL", async () => {
    load({ FAUCET_DAILY_CAP_SOL: "0" });
    await expectError(await drip(newWallet()), 503, /budget/);
    load({ FAUCET_DAILY_CAP_SOL: "lots" });
    assert.equal((await (await route.GET()).json()).remainingDrops, 49); // 100 by cap, 49 by balance
  });

  it("is 503 when the faucet balance can't cover a drop plus the reserve", async () => {
    rpc.balance = AMOUNT + 0.05 * LAMPORTS_PER_SOL - 1;
    await expectError(await drip(newWallet()), 503, /faucet is empty/);
    assert.equal(blob.calls.put.length, 0);
  });

  it("rate-limits each IP to 3 requests an hour", async () => {
    const from = "198.51.100.9";
    for (let i = 0; i < 3; i++) assert.equal((await post({ address: "bad" }, from)).status, 400);
    await expectError(await post({ address: newWallet() }, from), 429, /Too many requests/);
    assert.equal((await post({ address: newWallet() }, "198.51.100.10")).status, 200);
  });

  describe("send failures", () => {
    it("releases both markers when the transfer can't be sent, so the wallet can retry", async () => {
      const addr = newWallet();
      rpc.failSend = true;
      await expectError(await drip(addr), 502, /Could not send/);
      assert.equal(blob.files.has(walletMarker(addr)), false);
      assert.equal(blob.files.has(dayMarker(addr)), false);
      rpc.failSend = false;
      assert.equal((await drip(addr)).status, 200);
    });

    it("releases both markers when no blockhash is available", async () => {
      const addr = newWallet();
      rpc.failBlockhash = true;
      await expectError(await drip(addr), 502);
      assert.equal(blob.files.has(walletMarker(addr)), false);
      assert.equal(blob.files.has(dayMarker(addr)), false);
    });

    it("releases both markers when the transfer fails on chain", async () => {
      const addr = newWallet();
      rpc.confirm = "err";
      await expectError(await drip(addr), 502, /transfer failed/);
      assert.equal(blob.files.has(walletMarker(addr)), false);
      assert.equal(blob.files.has(dayMarker(addr)), false);
    });

    it("keeps both markers when confirmation times out, so the wallet can't be paid twice", async () => {
      const addr = newWallet();
      rpc.confirm = "timeout";
      const body = await expectError(await drip(addr), 504, /confirmation timed out/);
      assert.equal(body.sig, "sig1");
      assert.equal(JSON.parse(blob.files.get(walletMarker(addr))!).state, "claimed");
      assert.ok(blob.files.has(dayMarker(addr)));
      rpc.confirm = "ok";
      await expectError(await drip(addr), 409);
      assert.equal(rpc.sent.length, 1);
    });

    it("still succeeds when recording the signature fails", async () => {
      const addr = newWallet();
      blob.beforePut = (p) => {
        if (p === walletMarker(addr) && blob.files.has(p)) throw new Error("blob down");
      };
      assert.equal((await drip(addr)).status, 200);
      assert.equal(JSON.parse(blob.files.get(walletMarker(addr))!).state, "claimed");
    });
  });

  describe("unexpected errors return JSON 500", () => {
    it("when the RPC balance check throws", async () => {
      rpc.failBalance = true;
      await expectError(await drip(newWallet()), 500, /faucet hit an error/);
    });

    it("when Blob fails to write the claim", async () => {
      blob.beforePut = () => {
        throw new Error("blob down");
      };
      await expectError(await drip(newWallet()), 500, /faucet hit an error/);
      assert.equal(rpc.sent.length, 0);
    });

    it("when Blob fails to list today's payouts", async () => {
      blob.beforeList = () => {
        throw new Error("blob down");
      };
      await expectError(await drip(newWallet()), 500);
      assert.equal(rpc.sent.length, 0);
    });
  });
});
