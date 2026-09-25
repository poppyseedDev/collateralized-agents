import { setEnv } from "./helpers/stubs";
import { store } from "./helpers/mockStore";
import { beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EMPTY } from "@/lib/waitlist";
import type { Stored } from "@/lib/waitlistStore";
import { GET, POST } from "@/app/api/waitlist/route";

const ADMIN = "admin-key";
const EXPORT = "export-token";
const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const row = (over: Partial<Stored> = {}): Stored => ({
  ...EMPTY,
  name: "Ada",
  email: "ada@example.com",
  telegram: "ada",
  wallet: WALLET,
  wouldTrust: "Yes",
  allocation: "Not sure yet",
  id: "id-1",
  submittedAt: "2026-01-01T00:00:00.000Z",
  userAgent: "ua",
  ...over,
});

let ipCounter = 0;
const nextIp = () => `203.0.113.${++ipCounter % 250}.${ipCounter}`;

function get(query = "", authorization?: string) {
  return GET(new Request(`https://app.test/api/waitlist${query}`, { headers: authorization ? { authorization } : {} }));
}
function post(body: unknown, ip = nextIp(), extra: Record<string, string> = {}) {
  return POST(
    new Request("https://app.test/api/waitlist", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip, ...extra },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  setEnv({ WAITLIST_ADMIN_KEY: ADMIN, WAITLIST_EXPORT_TOKEN: undefined });
  store.reset();
  store.entries = [row()];
});

describe("GET /api/waitlist auth", () => {
  it("is 404 without a credential", async () => {
    const res = await get();
    assert.equal(res.status, 404);
    assert.equal(await res.text(), "Not found");
  });

  it("is 404 with a wrong credential", async () => {
    assert.equal((await get("", "Bearer nope")).status, 404);
    assert.equal((await get("?key=nope")).status, 404);
    assert.equal((await get("", `Basic ${ADMIN}`)).status, 404);
  });

  it("is 404 when no key is configured at all, even for an empty credential", async () => {
    setEnv({ WAITLIST_ADMIN_KEY: undefined });
    assert.equal((await get("?key=")).status, 404);
    assert.equal((await get("", "Bearer ")).status, 404);
  });

  it("accepts the bearer header", async () => {
    assert.equal((await get("", `Bearer ${ADMIN}`)).status, 200);
  });

  it("no longer accepts ?key=, which would end up in URL logs", async () => {
    assert.equal((await get(`?key=${ADMIN}`)).status, 404);
    assert.equal((await get(`?key=${ADMIN}`, "Bearer wrong")).status, 404, "a wrong header isn't rescued by a right key");
    assert.equal((await get("?key=wrong", `Bearer ${ADMIN}`)).status, 200);
  });

  it("uses WAITLIST_EXPORT_TOKEN instead of the admin key when it is set", async () => {
    setEnv({ WAITLIST_EXPORT_TOKEN: EXPORT });
    assert.equal((await get("", `Bearer ${ADMIN}`)).status, 404);
    assert.equal((await get("", `Bearer ${EXPORT}`)).status, 200);
  });

  it("falls back to the admin key when WAITLIST_EXPORT_TOKEN is empty", async () => {
    setEnv({ WAITLIST_EXPORT_TOKEN: "" });
    assert.equal((await get("", `Bearer ${ADMIN}`)).status, 200);
  });
});

describe("GET /api/waitlist export", () => {
  const exportCsv = async () => {
    const res = await get("", `Bearer ${ADMIN}`);
    assert.equal(res.status, 200);
    return { res, lines: (await res.text()).split("\n") };
  };

  it("returns an uncached CSV attachment with a header row", async () => {
    const { res, lines } = await exportCsv();
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(res.headers.get("content-disposition")!, /^attachment; filename="waitlist-\d{4}-\d{2}-\d{2}\.csv"$/);
    assert.equal(lines[0], "submittedAt,name,email,telegram,location,wallet,tradesCrypto,usedAgents,wouldTrust,allocation,trustFactors,collateralHelps,testDevnet,notes,id,laterSubmissions");
    assert.equal(lines.length, 2);
    assert.ok(lines[1].startsWith(`"2026-01-01T00:00:00.000Z","Ada","ada@example.com"`));
  });

  it("defuses formula prefixes", async () => {
    const payloads = ["=SUM(A1:A9)", "+1+1", "-2+3", "@cmd", "\t=1", "\r=1"];
    store.entries = payloads.map((notes, i) => row({ id: String(i), email: `u${i}@example.com`, notes }));
    const { lines } = await exportCsv();
    // "\r" doesn't split lines; only "\n" does. Pull the notes cell (second to last) of each row.
    const body = lines.slice(1).join("\n");
    for (const p of payloads) assert.ok(body.includes(`"'${p}"`), JSON.stringify(p));
  });

  it("leaves safe values alone", async () => {
    store.entries = [row({ notes: "a=b", location: "São Paulo", telegram: "x-y" })];
    const { lines } = await exportCsv();
    assert.ok(lines[1].includes(`"a=b"`));
    assert.ok(lines[1].includes(`"São Paulo"`));
    assert.ok(lines[1].includes(`"x-y"`));
  });

  it("doubles quotes and keeps commas and newlines inside the quoted cell", async () => {
    store.entries = [row({ notes: 'say "hi", then\nleave' })];
    const res = await get("", `Bearer ${ADMIN}`);
    assert.ok((await res.text()).includes(`"say ""hi"", then\nleave"`));
  });

  it("joins arrays with '; ' and prints null and undefined as empty", async () => {
    store.entries = [
      row({
        trustFactors: ["Track record", "Agent posts a bond"],
        location: null as unknown as string,
        notes: undefined as unknown as string,
      }),
    ];
    const { lines } = await exportCsv();
    assert.ok(lines[1].includes(`"Track record; Agent posts a bond"`));
    assert.ok(lines[1].includes(`"ada","","${WALLET}"`), "null location is empty");
    assert.ok(lines[1].endsWith(`"","id-1",""`), "undefined notes is empty, and there are no later submissions");
  });

  it("defuses a formula smuggled in through an array", async () => {
    store.entries = [row({ trustFactors: ["=HYPERLINK(\"x\")"] as unknown as Stored["trustFactors"] })];
    const { lines } = await exportCsv();
    assert.ok(lines[1].includes(`"'=HYPERLINK(""x"")"`));
  });

  it("keeps the first submission per email and lists later changes instead of applying them", async () => {
    store.entries = [
      row(),
      row({ id: "id-2", email: "ADA@example.com", submittedAt: "2026-01-02T00:00:00.000Z", wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", telegram: "mallory" }),
      row({ id: "id-3", submittedAt: "2026-01-03T00:00:00.000Z" }), // identical resubmission: not a conflict
      row({ id: "b", email: "bob@example.com", name: "Bob", submittedAt: "2026-01-01T12:00:00.000Z" }),
    ];
    const { lines } = await exportCsv();
    assert.equal(lines.length, 3, "one row per email");
    assert.ok(lines[1].includes(`"ada","","${WALLET}"`), "the first wallet and telegram are kept");
    assert.ok(lines[1].endsWith(`"id-1","2026-01-02T00:00:00.000Z: telegram=mallory; wallet=9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"`));
    assert.ok(lines[2].endsWith(`"b",""`));
  });

  it("reads the latest snapshot with ?snapshot=latest", async () => {
    store.snapshot = { entries: [row({ name: "From snapshot" })], pathname: "waitlist-snapshots/x.enc" };
    const text = await (await get("?snapshot=latest", `Bearer ${ADMIN}`)).text();
    assert.ok(text.includes(`"From snapshot"`));
    store.snapshot = null;
    const empty = await (await get("?snapshot=latest", `Bearer ${ADMIN}`)).text();
    assert.equal(empty.split("\n").length, 1, "no snapshot: header only");
  });

  it("returns a 502 JSON error when loading fails, never a partial CSV", async () => {
    store.failLoad = true;
    const err = mock.method(console, "error", () => {});
    const res = await get("", `Bearer ${ADMIN}`);
    err.mock.restore();
    assert.equal(res.status, 502);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { error: "export failed", detail: "could not download 1 of 2 waitlist entries" });
  });
});

describe("POST /api/waitlist", () => {
  const good = { name: "Ada", email: "Ada@Example.com", telegram: "@ada", wallet: WALLET, wouldTrust: "Yes", allocation: "Not sure yet" };

  it("answers a resubmission exactly like a first submission", async () => {
    const first = await post(good);
    const again = await post({ ...good, wallet: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" });
    assert.equal(first.status, again.status);
    assert.deepEqual(await first.json(), await again.json());
    assert.equal(store.saved.length, 2, "both are handed to the store, which keeps the first");
  });

  it("stores a valid, normalized submission", async () => {
    const res = await post(good, nextIp(), { "user-agent": "u".repeat(400) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(store.saved.length, 1);
    const s = store.saved[0];
    assert.equal(s.email, "ada@example.com");
    assert.equal(s.telegram, "ada");
    assert.match(s.id, /^[0-9a-f-]{36}$/);
    assert.ok(!Number.isNaN(Date.parse(s.submittedAt)));
    assert.equal(s.userAgent.length, 300);
  });

  it("is 503 when storage isn't configured", async () => {
    store.configured = false;
    assert.equal((await post(good)).status, 503);
  });

  it("rejects a body over 8 KB with 413", async () => {
    const res = await post({ ...good, notes: "x".repeat(8 * 1024) });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "Submission is too large." });
    assert.equal(store.saved.length, 0);
  });

  it("measures the limit in bytes, not characters", async () => {
    // ~3000 three-byte characters: under 8 KB as a string length, over it in UTF-8.
    const res = await post(JSON.stringify({ ...good, x: "€".repeat(3000) }));
    assert.equal(res.status, 413);
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await post("{not json");
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Invalid request." });
  });

  it("rejects a non-object body with 400", async () => {
    assert.equal((await post("42")).status, 400);
    assert.equal((await post("null")).status, 400);
    assert.equal((await post('"text"')).status, 400);
  });

  it("rejects over-long or non-text fields with 400", async () => {
    const long = await post({ ...good, name: "x".repeat(81) });
    assert.equal(long.status, 400);
    assert.match((await long.json()).error, /Name is too long \(max 80 characters\)/);
    const typed = await post({ ...good, email: 42 });
    assert.equal(typed.status, 400);
    assert.match((await typed.json()).error, /Email must be text/);
  });

  it("rejects invalid input with 400 and lists the problems", async () => {
    const res = await post({ ...good, email: "nope", wallet: "0xabc", allocation: "a lot" });
    assert.equal(res.status, 400);
    const { error } = await res.json();
    assert.match(error, /Enter a valid email\./);
    assert.match(error, /doesn't look like a Solana address/);
    assert.match(error, /Pick a rough allocation\./);
    assert.equal(store.saved.length, 0);
  });

  it("pretends to accept honeypot submissions without storing them", async () => {
    const res = await post({ ...good, website: "http://spam.example" });
    assert.equal(res.status, 200);
    assert.equal(store.saved.length, 0);
  });

  it("returns 500 JSON when saving fails", async () => {
    store.failSave = true;
    const err = mock.method(console, "error", () => {});
    const res = await post(good);
    err.mock.restore();
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /Could not save/);
  });

  it("limits each IP to 5 submissions a minute", async () => {
    const ip = "198.51.100.77";
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post({ ...good, email: `a${i}@example.com` }, ip)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  });
});
