import "./helpers/stubs";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { clientIp, rateLimiter } from "@/lib/rateLimit";

describe("rateLimiter", () => {
  beforeEach(() => mock.timers.enable({ apis: ["Date"], now: 1_000_000 }));
  afterEach(() => mock.timers.reset());

  it("allows `max` hits per key and limits the next", () => {
    const limited = rateLimiter({ windowMs: 60_000, max: 3 });
    assert.deepEqual([1, 2, 3, 4, 5].map(() => limited("a")), [false, false, false, true, true]);
    assert.equal(limited("b"), false, "other keys are independent");
  });

  it("forgets hits once they leave the window", () => {
    const limited = rateLimiter({ windowMs: 60_000, max: 2 });
    limited("a");
    mock.timers.tick(30_000);
    limited("a");
    assert.equal(limited("a"), true);
    mock.timers.tick(30_000); // the first hit is now exactly windowMs old
    assert.equal(limited("a"), true, "second and third hits are still in the window");
    mock.timers.tick(30_000);
    assert.equal(limited("a"), false, "hits older than the window don't count");
  });

  it("is a sliding window, not a fixed one", () => {
    const limited = rateLimiter({ windowMs: 10_000, max: 1 });
    assert.equal(limited("a"), false);
    mock.timers.tick(9_999);
    assert.equal(limited("a"), true);
    mock.timers.tick(1);
    // The first hit expired but the limited one at t=9999 still counts.
    assert.equal(limited("a"), true);
    mock.timers.tick(10_000);
    assert.equal(limited("a"), false);
  });

  it("evicts stale keys on the next sweep", () => {
    const limited = rateLimiter({ windowMs: 1_000, max: 1, maxKeys: 3 });
    limited("a");
    limited("b");
    mock.timers.tick(1_001);
    limited("c");
    limited("d");
    limited("e");
    // With a, b swept out, c, d, e are the only keys: all still limited.
    assert.equal(limited("c"), true);
    assert.equal(limited("d"), true);
  });

  it("never holds more than maxKeys, dropping the oldest key first", () => {
    const limited = rateLimiter({ windowMs: 60_000, max: 1, maxKeys: 5_000 });
    for (let i = 0; i < 5_000; i++) limited(`ip-${i}`);
    assert.equal(limited("ip-4999"), true, "the newest key is still tracked");
    // ip-4999 was just re-inserted; adding a new key evicts the oldest (ip-0).
    limited("new-key");
    assert.equal(limited("ip-0"), false, "ip-0 was evicted, so it starts fresh");
    assert.equal(limited("ip-4999"), true);
    assert.equal(limited("new-key"), true);
  });

  it("uses a default cap of 5000 keys", () => {
    const limited = rateLimiter({ windowMs: 60_000, max: 1 });
    for (let i = 0; i < 5_000; i++) limited(`ip-${i}`);
    assert.equal(limited("ip-1"), true, "5000 keys fit");
    limited("one-more");
    assert.equal(limited("ip-0"), false, "the oldest key was evicted at the cap");
  });

  it("doesn't evict (and so reset) a caller's own key when the map is full", () => {
    // Regression: at the cap, a repeat hit used to evict the oldest key first, which could be the
    // caller itself, wiping its history and letting it past the limit.
    const limited = rateLimiter({ windowMs: 60_000, max: 1, maxKeys: 3 });
    limited("a");
    limited("b");
    limited("c");
    assert.equal(limited("a"), true);
    assert.equal(limited("a"), true);
    assert.equal(limited("b"), true);
    assert.equal(limited("c"), true);
  });

  it("moves a re-used key to the newest end so it isn't evicted first", () => {
    const limited = rateLimiter({ windowMs: 60_000, max: 1, maxKeys: 3 });
    limited("a");
    limited("b");
    limited("c");
    limited("a"); // a is now newest; b is oldest
    limited("d"); // evicts b
    assert.equal(limited("a"), true);
    assert.equal(limited("b"), false);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => new Request("https://app.test/", { headers });

  it("uses the first x-forwarded-for entry", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" })), "203.0.113.7");
    assert.equal(clientIp(req({ "x-forwarded-for": "  198.51.100.4  " })), "198.51.100.4");
    assert.equal(clientIp(req({ "x-forwarded-for": "2001:db8::1,10.0.0.1" })), "2001:db8::1");
  });
  it("prefers x-forwarded-for over x-real-ip", () => {
    assert.equal(clientIp(req({ "x-forwarded-for": "203.0.113.7", "x-real-ip": "198.51.100.4" })), "203.0.113.7");
  });
  it("falls back to x-real-ip", () => {
    assert.equal(clientIp(req({ "x-real-ip": " 198.51.100.4 " })), "198.51.100.4");
    assert.equal(clientIp(req({ "x-forwarded-for": " , 10.0.0.1", "x-real-ip": "198.51.100.4" })), "198.51.100.4");
  });
  it("is 'unknown' with no usable header", () => {
    assert.equal(clientIp(req({})), "unknown");
    assert.equal(clientIp(req({ "x-forwarded-for": "" })), "unknown");
  });
});
