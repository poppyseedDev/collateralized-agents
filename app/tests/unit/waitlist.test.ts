import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOCATIONS,
  EMPTY,
  MAX_LEN,
  TRUST_FACTORS,
  YES_NO,
  YES_NO_MAYBE,
  lengthProblems,
  normalize,
  validate,
  type Submission,
} from "@/lib/waitlist";

const WALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
const valid = (over: Partial<Submission> = {}): Submission => ({
  ...EMPTY,
  name: "Ada",
  email: "ada@example.com",
  telegram: "ada",
  wallet: WALLET,
  wouldTrust: "Yes",
  allocation: "Not sure yet",
  ...over,
});

describe("validate", () => {
  it("accepts a complete submission", () => {
    assert.deepEqual(validate(valid()), []);
  });

  it("requires name, email, telegram, wallet, wouldTrust and allocation", () => {
    const problems = validate(EMPTY);
    assert.deepEqual(problems, [
      "Name is required.",
      "Enter a valid email.",
      "Telegram handle is required.",
      "Solana wallet address is required.",
      "Tell us whether you'd trust an agent to trade for you.",
      "Pick a rough allocation.",
    ]);
  });

  it("treats whitespace-only fields as missing", () => {
    const p = validate(valid({ name: "   ", telegram: "\t", wallet: "  " }));
    assert.ok(p.includes("Name is required."));
    assert.ok(p.includes("Telegram handle is required."));
    assert.ok(p.includes("Solana wallet address is required."));
  });

  it("checks the email format", () => {
    for (const email of ["ada@example.com", "a.b+c@sub.example.co", "  ada@example.com  "]) {
      assert.deepEqual(validate(valid({ email })), [], email);
    }
    for (const email of ["", "ada", "ada@", "@example.com", "ada@example", "ada @example.com", "ada@exa mple.com", "a@b@c.com"]) {
      assert.deepEqual(validate(valid({ email })), ["Enter a valid email."], email);
    }
  });

  it("checks the wallet looks like base58 of the right length", () => {
    assert.deepEqual(validate(valid({ wallet: "11111111111111111111111111111111" })), []);
    for (const wallet of ["0x1234", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4O" /* O isn't base58 */, "abc", "1".repeat(45)]) {
      assert.deepEqual(validate(valid({ wallet })), ["Wallet address doesn't look like a Solana address."], wallet);
    }
  });

  it("rejects over-long free-text fields", () => {
    for (const k of Object.keys(MAX_LEN) as (keyof typeof MAX_LEN)[]) {
      // Stay valid apart from the length: repeat a character that keeps each field's format.
      const atMax = k === "email" ? "a".repeat(MAX_LEN.email - "@example.com".length) + "@example.com" : "x".repeat(MAX_LEN[k]);
      if (k !== "wallet") assert.deepEqual(validate(valid({ [k]: atMax })), [], `${k} at max`);
      const over = validate(valid({ [k]: atMax + "x" }));
      assert.ok(over.some((p) => p.includes("is too long")), `${k} over max: ${over.join(" ")}`);
    }
  });
});

describe("lengthProblems", () => {
  it("ignores non-objects and missing fields", () => {
    assert.deepEqual(lengthProblems(null), []);
    assert.deepEqual(lengthProblems("text"), []);
    assert.deepEqual(lengthProblems(42), []);
    assert.deepEqual(lengthProblems({}), []);
    assert.deepEqual(lengthProblems({ name: null, notes: undefined }), []);
  });

  it("flags each over-long field with its max", () => {
    for (const [k, max] of Object.entries(MAX_LEN)) {
      assert.deepEqual(lengthProblems({ [k]: "x".repeat(max) }), [], k);
      const [p] = lengthProblems({ [k]: "x".repeat(max + 1) });
      assert.match(p, new RegExp(`too long \\(max ${max} characters\\)`), k);
    }
  });

  it("measures length after trimming", () => {
    assert.deepEqual(lengthProblems({ name: `  ${"x".repeat(MAX_LEN.name)}  ` }), []);
  });

  it("flags non-string values", () => {
    assert.deepEqual(lengthProblems({ email: 5, notes: { a: 1 }, wallet: ["x"] }), [
      "Email must be text.",
      "Wallet address must be text.",
      "Notes must be text.",
    ]);
  });

  it("flags a non-array or oversized trustFactors", () => {
    assert.deepEqual(lengthProblems({ trustFactors: [...TRUST_FACTORS] }), []);
    assert.deepEqual(lengthProblems({ trustFactors: "Track record" }), ["Invalid trust factors."]);
    assert.deepEqual(lengthProblems({ trustFactors: [...TRUST_FACTORS, "Track record"] }), ["Invalid trust factors."]);
  });
});

describe("normalize", () => {
  it("returns null for a non-object", () => {
    assert.equal(normalize(null), null);
    assert.equal(normalize("x"), null);
  });

  it("trims, lowercases the email and strips a leading @ from telegram", () => {
    const s = normalize({ name: "  Ada ", email: " Ada@Example.COM ", telegram: "@ada_l", location: " Paris ", wallet: ` ${WALLET} `, notes: " hi " })!;
    assert.equal(s.name, "Ada");
    assert.equal(s.email, "ada@example.com");
    assert.equal(s.telegram, "ada_l");
    assert.equal(s.location, "Paris");
    assert.equal(s.wallet, WALLET);
    assert.equal(s.notes, "hi");
  });

  it("drops non-string values and unknown keys", () => {
    const s = normalize({ name: 5, email: ["a@b.co"], extra: "x", __proto__: { polluted: true } })!;
    assert.equal(s.name, "");
    assert.equal(s.email, "");
    assert.deepEqual(Object.keys(s).sort(), Object.keys(EMPTY).sort());
  });

  it("truncates free text to the field max", () => {
    const s = normalize({ notes: "x".repeat(5000), name: "n".repeat(500) })!;
    assert.equal(s.notes.length, MAX_LEN.notes);
    assert.equal(s.name.length, MAX_LEN.name);
  });

  const choices: [keyof Submission, readonly string[]][] = [
    ["tradesCrypto", YES_NO],
    ["usedAgents", YES_NO],
    ["wouldTrust", YES_NO_MAYBE],
    ["allocation", ALLOCATIONS],
    ["collateralHelps", YES_NO_MAYBE],
    ["testDevnet", YES_NO],
  ];
  for (const [field, options] of choices) {
    it(`accepts every ${field} option and nothing else`, () => {
      for (const o of options) assert.equal(normalize({ [field]: o })![field], o);
      assert.equal(normalize({ [field]: ` ${options[0]} ` })![field], options[0], "trimmed before matching");
      for (const bad of ["", "maybe", "YES", "Other", 1, true, null, [options[0]]]) {
        assert.equal(normalize({ [field]: bad })![field], "", `${field}=${JSON.stringify(bad)}`);
      }
    });
  }

  it("keeps only known trust factors, once each", () => {
    const s = normalize({ trustFactors: ["Track record", "Bogus", "Track record", 7, "On-chain history"] })!;
    assert.deepEqual(s.trustFactors, ["Track record", "On-chain history"]);
    assert.deepEqual(normalize({ trustFactors: [...TRUST_FACTORS] })!.trustFactors, [...TRUST_FACTORS]);
    assert.deepEqual(normalize({ trustFactors: "Track record" })!.trustFactors, []);
    assert.deepEqual(normalize({})!.trustFactors, []);
  });

  it("round-trips a valid submission", () => {
    const s = normalize({ ...valid(), trustFactors: ["Capital protection"], tradesCrypto: "No" })!;
    assert.deepEqual(validate(s), []);
  });
});
