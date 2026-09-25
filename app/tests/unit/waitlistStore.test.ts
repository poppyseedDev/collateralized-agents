import { offline, setEnv } from "./helpers/stubs";
import { blob } from "./helpers/fakeBlob";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EMPTY } from "@/lib/waitlist";
import { describeUpdates, groupByEmail } from "@/lib/waitlistExport";
import {
  BY_EMAIL_PREFIX,
  ENTRY_PREFIX,
  SNAPSHOT_PREFIX,
  decrypt,
  emailId,
  encrypt,
  loadEntries,
  loadLatestSnapshot,
  saveEntry,
  storageConfigured,
  writeSnapshot,
  type Stored,
} from "@/lib/waitlistStore";

const KEY = "test-admin-key";
const entry = (email: string, submittedAt: string, over: Partial<Stored> = {}): Stored => ({
  ...EMPTY,
  name: email.split("@")[0],
  email,
  id: `id-${email}-${submittedAt}`,
  submittedAt,
  userAgent: "test",
  ...over,
});

beforeEach(() => {
  setEnv({ WAITLIST_ADMIN_KEY: KEY, BLOB_READ_WRITE_TOKEN: "test-token" });
  blob.reset();
  globalThis.fetch = blob.fetch;
});
afterEach(() => {
  globalThis.fetch = offline;
});

describe("encrypt / decrypt", () => {
  it("round-trips text, including unicode and empty strings", () => {
    for (const plain of ["", "hello", JSON.stringify({ a: "ü ✓ 🚀" }), "x".repeat(10_000)]) {
      assert.equal(decrypt(encrypt(plain)), plain);
    }
  });

  it("uses a fresh IV, so the same text encrypts differently each time", () => {
    assert.notEqual(encrypt("same"), encrypt("same"));
  });

  it("fails with a different key", () => {
    const c = encrypt("secret");
    setEnv({ WAITLIST_ADMIN_KEY: "another-key" });
    assert.throws(() => decrypt(c));
  });

  it("fails when any part of the ciphertext is tampered with", () => {
    const buf = Buffer.from(encrypt("secret payload"), "base64");
    for (const i of [0, 11, 12, 27, 28, buf.length - 1]) {
      // iv, auth tag, and body bytes
      const t = Buffer.from(buf);
      t[i] ^= 0x01;
      assert.throws(() => decrypt(t.toString("base64")), `byte ${i}`);
    }
    assert.throws(() => decrypt(buf.subarray(0, buf.length - 1).toString("base64")), "truncated");
  });

  it("throws without WAITLIST_ADMIN_KEY", () => {
    setEnv({ WAITLIST_ADMIN_KEY: undefined });
    assert.throws(() => encrypt("x"), /WAITLIST_ADMIN_KEY is not set/);
  });
});

describe("emailId", () => {
  it("is stable, hex, and pathname-safe", () => {
    const id = emailId("ada@example.com");
    assert.equal(id, emailId("ada@example.com"));
    assert.match(id, /^[0-9a-f]{64}$/);
  });
  it("ignores case and surrounding whitespace", () => {
    assert.equal(emailId("  Ada@Example.COM\n"), emailId("ada@example.com"));
  });
  it("differs per email and per key", () => {
    assert.notEqual(emailId("ada@example.com"), emailId("bob@example.com"));
    const a = emailId("ada@example.com");
    setEnv({ WAITLIST_ADMIN_KEY: "another-key" });
    assert.notEqual(emailId("ada@example.com"), a);
  });
  it("doesn't reveal the email", () => {
    assert.ok(!emailId("ada@example.com").includes("ada"));
  });
});

describe("storageConfigured", () => {
  it("needs both the blob token and the admin key", () => {
    assert.equal(storageConfigured(), true);
    setEnv({ BLOB_READ_WRITE_TOKEN: undefined });
    assert.equal(storageConfigured(), false);
    setEnv({ BLOB_READ_WRITE_TOKEN: "t", WAITLIST_ADMIN_KEY: "" });
    assert.equal(storageConfigured(), false);
  });
});

describe("groupByEmail", () => {
  it("keeps the first entry per email, case- and whitespace-insensitively, oldest first", () => {
    const rows = [
      entry("bob@example.com", "2026-01-03T00:00:00.000Z"),
      entry(" ADA@example.com ", "2026-01-05T00:00:00.000Z", { name: "new" }),
      entry("ada@example.com", "2026-01-01T00:00:00.000Z", { name: "first" }),
      entry("ada@example.com", "2026-01-02T00:00:00.000Z", { name: "middle" }),
    ];
    const out = groupByEmail(rows);
    assert.deepEqual(out.map((r) => [r.entry.email.trim().toLowerCase(), r.entry.name, r.updates.map((u) => u.name)]), [
      ["ada@example.com", "first", ["middle", "new"]],
      ["bob@example.com", "bob", []],
    ]);
  });

  it("drops later submissions that change nothing, or repeat an earlier update", () => {
    const a = entry("a@x.co", "2026-01-01T00:00:00.000Z", { wallet: "W1" });
    const out = groupByEmail([
      a,
      { ...a, id: "again", submittedAt: "2026-01-02T00:00:00.000Z", email: "A@X.CO", userAgent: "other" },
      entry("a@x.co", "2026-01-03T00:00:00.000Z", { wallet: "W2" }),
      entry("a@x.co", "2026-01-04T00:00:00.000Z", { wallet: "W2" }),
    ]);
    assert.equal(out.length, 1);
    assert.deepEqual(out[0].updates.map((u) => u.submittedAt), ["2026-01-03T00:00:00.000Z"]);
  });

  it("keeps rows without an email apart, by id", () => {
    const t = "2026-01-01T00:00:00.000Z";
    const out = groupByEmail([entry("", t, { id: "1" }), entry("", t, { id: "2" }), { ...entry("", t, { id: "3" }), email: undefined as unknown as string }]);
    assert.equal(out.length, 3);
  });

  it("describes each update by the fields it changes, on one line", () => {
    const [row] = groupByEmail([
      entry("a@x.co", "2026-01-01T00:00:00.000Z", { wallet: "W1", telegram: "ada" }),
      entry("a@x.co", "2026-01-02T00:00:00.000Z", { wallet: "W2", telegram: "ada" }),
      entry("a@x.co", "2026-01-03T00:00:00.000Z", { wallet: "W1", telegram: "eve", notes: "line\nbreak", trustFactors: ["Track record", "Agent posts a bond"] }),
    ]);
    assert.equal(
      describeUpdates(row),
      "2026-01-02T00:00:00.000Z: wallet=W2 | 2026-01-03T00:00:00.000Z: telegram=eve; trustFactors=Track record, Agent posts a bond; notes=line break",
    );
    assert.equal(describeUpdates({ entry: row.entry, updates: [] }), "");
  });
});

describe("saveEntry", () => {
  it("never overwrites the first entry for an email; later ones are stored beside it", async () => {
    await saveEntry(entry("ada@example.com", "2026-01-01T00:00:00.000Z", { name: "first" }));
    await saveEntry(entry("ADA@example.com", "2026-01-02T00:00:00.000Z", { name: "second" }));
    const first = `${BY_EMAIL_PREFIX}${emailId("ada@example.com")}.enc`;
    const later = `${BY_EMAIL_PREFIX}${emailId("ada@example.com")}/2026-01-02T00-00-00-000Z-id-ADA@example.com-2026-01-02T00:00:00.000Z.enc`;
    assert.deepEqual([...blob.files.keys()], [first, later]);
    const stored = blob.files.get(first)!;
    assert.ok(!stored.includes("ada"), "contents are encrypted");
    assert.equal(JSON.parse(decrypt(stored)).name, "first");
    assert.equal(JSON.parse(decrypt(blob.files.get(later)!)).name, "second");
  });

  it("exports the first entry with the later one as an update, alongside older date-path entries", async () => {
    blob.files.set(`${ENTRY_PREFIX}2025-12-01/old-x.enc`, encrypt(JSON.stringify(entry("old@example.com", "2025-12-01T00:00:00.000Z"))));
    await saveEntry(entry("ada@example.com", "2026-01-01T00:00:00.000Z", { wallet: "W1" }));
    await saveEntry(entry("ada@example.com", "2026-01-02T00:00:00.000Z", { wallet: "W2" }));
    const rows = groupByEmail(await loadEntries());
    assert.deepEqual(rows.map((r) => [r.entry.email, r.entry.wallet, r.updates.map((u) => u.wallet)]), [
      ["old@example.com", "", []],
      ["ada@example.com", "W1", ["W2"]],
    ]);
  });

  it("rethrows a storage failure that isn't an existing entry", async () => {
    blob.beforePut = () => {
      throw new Error("blob down");
    };
    await assert.rejects(saveEntry(entry("ada@example.com", "2026-01-01T00:00:00.000Z")), /blob down/);
  });
});

describe("loadEntries", () => {
  const seed = (n: number) => {
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.UTC(2026, 0, 1) + (n - i) * 60_000).toISOString(); // stored newest-first
      blob.files.set(`${ENTRY_PREFIX}2026-01-01/${String(i).padStart(3, "0")}.enc`, encrypt(JSON.stringify(entry(`u${i}@x.co`, at))));
    }
  };

  it("downloads and decrypts every entry across list pages, oldest first", async () => {
    seed(25);
    blob.pageSize = 10;
    const rows = await loadEntries();
    assert.equal(rows.length, 25);
    assert.deepEqual(rows.map((r) => r.submittedAt), [...rows.map((r) => r.submittedAt)].sort());
    assert.equal(blob.calls.list.length, 3, "followed the cursor");
  });

  it("keeps at most 8 downloads in flight", async () => {
    seed(30);
    let inFlight = 0;
    let peak = 0;
    let calls = 0;
    globalThis.fetch = async (input, init) => {
      calls++;
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      return blob.fetch(input, init);
    };
    const rows = await loadEntries();
    assert.equal(rows.length, 30);
    assert.equal(calls, 30);
    assert.equal(peak, 8);
  });

  it("uses the download URL", async () => {
    seed(1);
    const urls: string[] = [];
    globalThis.fetch = async (input, init) => {
      urls.push(String(input));
      return blob.fetch(input, init);
    };
    await loadEntries();
    assert.match(urls[0], /\?download=1$/);
  });

  it("skips files that download but don't decrypt", async () => {
    seed(3);
    blob.files.set(`${ENTRY_PREFIX}junk.enc`, "not-ciphertext");
    const warn = console.warn;
    console.warn = () => {};
    try {
      assert.equal((await loadEntries()).length, 3);
    } finally {
      console.warn = warn;
    }
  });

  it("throws rather than return a partial list when a download fails", async () => {
    seed(5);
    globalThis.fetch = async (input, init) =>
      String(input).includes("002.enc") ? new Response("gone", { status: 404 }) : blob.fetch(input, init);
    await assert.rejects(loadEntries(), /could not download 1 of 5 waitlist entries \(waitlist\/2026-01-01\/002\.enc: HTTP 404\)/);
  });

  it("retries a transient failure", async () => {
    seed(1);
    let n = 0;
    globalThis.fetch = async (input, init) => (++n === 1 ? new Response("busy", { status: 503 }) : blob.fetch(input, init));
    assert.equal((await loadEntries()).length, 1);
    assert.equal(n, 2);
  });

  it("returns an empty list for an empty store", async () => {
    assert.deepEqual(await loadEntries(), []);
  });
});

describe("snapshots", () => {
  it("writeSnapshot stores every entry, and loadLatestSnapshot reads the newest", async () => {
    blob.files.set(`${SNAPSHOT_PREFIX}2020-01-01T00-00-00-000Z-old.enc`, encrypt(JSON.stringify([entry("old@x.co", "2020")])));
    await saveEntry(entry("ada@example.com", "2026-01-01T00:00:00.000Z"));
    await saveEntry(entry("bob@example.com", "2026-01-02T00:00:00.000Z"));
    const { count, pathname } = await writeSnapshot();
    assert.equal(count, 2);
    assert.ok(pathname.startsWith(SNAPSHOT_PREFIX));
    const latest = await loadLatestSnapshot();
    assert.equal(latest?.pathname, pathname);
    assert.deepEqual(latest?.entries.map((e) => e.email), ["ada@example.com", "bob@example.com"]);
  });

  it("loadLatestSnapshot is null with no snapshots", async () => {
    assert.equal(await loadLatestSnapshot(), null);
  });
});
