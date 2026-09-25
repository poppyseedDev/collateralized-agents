import "./helpers/stubs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bearerToken, hasBearer, safeEqual } from "@/lib/auth";

const req = (authorization?: string) =>
  new Request("https://app.test/", { headers: authorization === undefined ? {} : { authorization } });

describe("safeEqual", () => {
  it("is false when either side is empty or missing", () => {
    assert.equal(safeEqual("", "secret"), false);
    assert.equal(safeEqual("secret", ""), false);
    assert.equal(safeEqual("", ""), false);
    assert.equal(safeEqual(null, "secret"), false);
    assert.equal(safeEqual("secret", undefined), false);
    assert.equal(safeEqual(undefined, null), false);
  });
  it("is true for equal strings", () => {
    assert.equal(safeEqual("secret", "secret"), true);
    assert.equal(safeEqual("ünïcödé ✓", "ünïcödé ✓"), true);
  });
  it("is false for unequal strings of the same length", () => {
    assert.equal(safeEqual("secret", "secreT"), false);
  });
  it("is false for strings of different lengths", () => {
    assert.equal(safeEqual("secret", "secret2"), false);
    assert.equal(safeEqual("a", "a".repeat(1000)), false);
  });
});

describe("bearerToken", () => {
  it("returns null without an Authorization header", () => {
    assert.equal(bearerToken(req()), null);
  });
  it("reads the token", () => {
    assert.equal(bearerToken(req("Bearer abc123")), "abc123");
  });
  it("accepts the scheme in any case", () => {
    assert.equal(bearerToken(req("bearer abc")), "abc");
    assert.equal(bearerToken(req("BEARER abc")), "abc");
  });
  it("tolerates extra whitespace", () => {
    assert.equal(bearerToken(req("  Bearer    abc  ")), "abc");
    assert.equal(bearerToken(req("Bearer\tabc")), "abc");
  });
  it("rejects other schemes and a bare scheme", () => {
    assert.equal(bearerToken(req("Basic dXNlcjpwYXNz")), null);
    assert.equal(bearerToken(req("Token abc")), null);
    assert.equal(bearerToken(req("abc")), null);
    assert.equal(bearerToken(req("Bearer")), null);
    assert.equal(bearerToken(req("Bearer   ")), null);
    assert.equal(bearerToken(req("Bearerabc")), null);
  });
});

describe("hasBearer", () => {
  it("is true only for the configured secret", () => {
    assert.equal(hasBearer(req("Bearer s3cret"), "s3cret"), true);
    assert.equal(hasBearer(req("bearer  s3cret "), "s3cret"), true);
    assert.equal(hasBearer(req("Bearer wrong"), "s3cret"), false);
    assert.equal(hasBearer(req(), "s3cret"), false);
    assert.equal(hasBearer(req("Basic s3cret"), "s3cret"), false);
  });
  it("is false when no secret is configured, whatever is sent", () => {
    assert.equal(hasBearer(req("Bearer anything"), undefined), false);
    assert.equal(hasBearer(req("Bearer "), ""), false);
    assert.equal(hasBearer(req(), undefined), false);
  });
});
