import { freshRequire } from "./helpers/stubs";
import { rpc } from "./helpers/fakeSolana";
import { accountsUrl, noteConfirmedSlot } from "@/lib/accounts";
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

type Route = typeof import("@/app/api/accounts/route");

let route: Route;
const get = async (query = "") => {
  const res = await route.GET(new Request(`https://app.test/api/accounts${query}`));
  return { res, body: await res.json() };
};

beforeEach(() => {
  rpc.reset();
  route = freshRequire<Route>("@/app/api/accounts/route"); // empty cache
});

describe("GET /api/accounts ?minSlot", () => {
  it("serves the cached snapshot without minSlot", async () => {
    rpc.programSlots = [100, 200];
    assert.equal((await get()).body.slot, 100);
    assert.equal((await get("?fresh=1")).body.slot, 100, "fresh within 2s of the last load reuses it");
    assert.equal(rpc.programAccountCalls, 1);
  });

  it("reloads until the snapshot reaches the slot the client's transaction confirmed in", async () => {
    rpc.programSlots = [100, 100, 150, 205];
    await get();
    const { res, body } = await get("?fresh=1&minSlot=200");
    assert.equal(body.slot, 205);
    assert.equal(rpc.programAccountCalls, 4);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("gives up after a few tries and serves the newest snapshot it has", async () => {
    rpc.programSlots = [100, 90, 120];
    await get();
    const { body } = await get("?minSlot=10000");
    assert.equal(rpc.programAccountCalls, 1 + 4, "bounded");
    assert.equal(body.slot, 120, "never steps back to a lagging node's older view");
  });

  it("ignores a minSlot the cache already covers", async () => {
    rpc.programSlots = [300];
    await get();
    assert.equal((await get("?fresh=1&minSlot=250")).body.slot, 300);
    assert.equal(rpc.programAccountCalls, 1);
  });
});

describe("accountsUrl", () => {
  it("asks for the slot of the latest confirmed transaction on fresh loads only", () => {
    assert.equal(accountsUrl(false), "/api/accounts");
    assert.equal(accountsUrl(true, 1), "/api/accounts?fresh=1");
    noteConfirmedSlot(500);
    noteConfirmedSlot(400); // an older transaction confirming late doesn't lower it
    assert.equal(accountsUrl(true, 2), "/api/accounts?fresh=2&minSlot=500");
    assert.equal(accountsUrl(false), "/api/accounts");
  });
});
