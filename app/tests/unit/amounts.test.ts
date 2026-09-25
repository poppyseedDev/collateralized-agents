import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lamportsToInput, parseNonNegativeSolInput, parseSolInput, toLamports, u64 } from "@/lib/amounts";
import { toLamports as programToLamports } from "@/lib/program";
import { withLocale } from "./helpers/locale";

const LAMPORTS = 1_000_000_000;

for (const locale of ["en-US", "de-DE"]) {
  describe(`amount helpers (${locale})`, () => {
    const run = (fn: () => void) => () => withLocale(locale, fn);

    it("the locale is really in effect", run(() => {
      assert.equal((1.5).toLocaleString(), locale === "de-DE" ? "1,5" : "1.5");
    }));

    it("lamportsToInput floors to 3 decimals, with a '.' separator", run(() => {
      assert.equal(lamportsToInput(1_999_999_999), "1.999");
      assert.equal(lamportsToInput(1_500_000_000), "1.500");
      assert.equal(lamportsToInput(999_999), "0.000");
      assert.equal(lamportsToInput(0), "0.000");
      assert.equal(lamportsToInput(1_234_567_890_123), "1234.567", "no thousands separator");
    }));

    it("lamportsToInput honours digits", run(() => {
      assert.equal(lamportsToInput(1_999_999_999, 2), "1.99");
      assert.equal(lamportsToInput(1_999_999_999, 9), "1.999999999");
      assert.equal(lamportsToInput(1_999_999_999, 0), "1");
    }));

    it("Max never fills in more than is available", run(() => {
      let seed = 12345;
      const rand = () => (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
      const samples = [0, 1, 999_999, 1_000_000, 1_000_001, 10_000_000, 29_999_999, 1_099_999_999, 5 * LAMPORTS - 1];
      for (let i = 0; i < 2_000; i++) samples.push(Math.floor(rand() * 10_000 * LAMPORTS));
      for (const lamports of samples) {
        const filled = parseSolInput(lamportsToInput(lamports));
        assert.ok(filled <= lamports, `${lamports} -> ${filled}`);
        assert.ok(lamports - filled < 1_000_000, `${lamports} -> ${filled} loses at most 0.001 SOL`);
      }
    }));

    it("parseSolInput reads '.' decimals and returns lamports", run(() => {
      assert.equal(parseSolInput("1.5"), 1_500_000_000);
      assert.equal(parseSolInput("0.1"), 100_000_000);
      assert.equal(parseSolInput(".25"), 250_000_000);
      assert.equal(parseSolInput("1e-3"), 1_000_000);
      assert.equal(parseSolInput(" 2 "), 2 * LAMPORTS);
      assert.equal(parseSolInput("0.000000001"), 1);
    }));

    it("parseSolInput is 0 for empty or non-numeric input", run(() => {
      for (const s of ["", " ", "abc", "-", ".", "Infinity", "-Infinity", "NaN"]) assert.equal(parseSolInput(s), 0, JSON.stringify(s));
    }));

    it("parseSolInput doesn't read ',' as a decimal separator", run(() => {
      // <input type="number"> always yields "." decimals, so a comma never reaches this in practice.
      assert.equal(parseSolInput("1,5"), LAMPORTS);
    }));

    it("toLamports rounds to the nearest lamport and is the one lib/program exports", run(() => {
      assert.equal(programToLamports, toLamports);
      assert.equal(toLamports(0.1 + 0.2), 300_000_000);
      assert.equal(toLamports(1.0000000004), LAMPORTS);
      assert.equal(toLamports(1.0000000006), LAMPORTS + 1);
    }));

    it("parseNonNegativeSolInput accepts 0 and rejects empty, negative and non-numeric input", run(() => {
      assert.equal(parseNonNegativeSolInput("0"), 0);
      assert.equal(parseNonNegativeSolInput("1.5"), 1_500_000_000);
      assert.equal(parseNonNegativeSolInput(""), null);
      assert.equal(parseNonNegativeSolInput("  "), null);
      assert.equal(parseNonNegativeSolInput("-0.5"), null);
      assert.equal(parseNonNegativeSolInput("abc"), null);
      assert.equal(parseNonNegativeSolInput("1e30"), null, "beyond the safe integer range");
    }));

    it("u64 refuses amounts borsh would mis-encode", run(() => {
      assert.equal(u64(5).toString(), "5");
      assert.equal(u64(0).toString(), "0");
      assert.throws(() => u64(-500_000_000), /Invalid amount/);
      assert.throws(() => u64(1.5), /Invalid amount/);
      assert.throws(() => u64(Number.NaN), /Invalid amount/);
      assert.throws(() => u64(2 ** 60), /Invalid amount/);
    }));
  });
}
