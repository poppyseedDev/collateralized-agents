import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DRAFT, byteLen, draftProblems, maxDrawdownForRatio } from "@/components/operator/AgentForm";
import { MAX_DESCRIPTION_LEN, MAX_NAME_LEN, MAX_RULES_LEN } from "@/lib/program";

const draft = (collateralRatioBps: number, maxDrawdownBps: number) => ({
  ...DEFAULT_DRAFT,
  name: "Test",
  terms: { ...DEFAULT_DRAFT.terms, collateralRatioBps, maxDrawdownBps, feeBps: 0, rules: "Trade SOL." },
});

describe("agent form terms", () => {
  it("caps drawdown so ratio + drawdown stays within 100%", () => {
    assert.equal(maxDrawdownForRatio(1_000), 5_000, "the protocol max still applies");
    assert.equal(maxDrawdownForRatio(7_000), 3_000);
    assert.equal(maxDrawdownForRatio(10_000), 0);
  });

  it("flags terms the program would reject with RatioPlusDrawdownTooHigh", () => {
    const msg = /can't exceed 100%/;
    assert.ok(draftProblems(draft(7_000, 4_000)).some((p) => msg.test(p)));
    assert.ok(!draftProblems(draft(7_000, 3_000)).some((p) => msg.test(p)));
    assert.ok(!draftProblems(draft(5_000, 5_000)).some((p) => msg.test(p)));
  });
});

describe("agent form text limits", () => {
  const withText = (name: string, description = "", rules = "Trade SOL.") => ({ ...draft(3_000, 1_000), name, description, terms: { ...draft(3_000, 1_000).terms, rules } });
  const tooLong = (d: ReturnType<typeof withText>) => draftProblems(d).filter((p) => /too long/.test(p));

  it("counts UTF-8 bytes, like the program", () => {
    assert.equal(byteLen("abc"), 3);
    assert.equal(byteLen("é"), 2);
    assert.equal(byteLen("🚀"), 4, "2 UTF-16 units, 4 bytes");
  });

  it("accepts text at the byte limits", () => {
    assert.deepEqual(tooLong(withText("a".repeat(MAX_NAME_LEN), "d".repeat(MAX_DESCRIPTION_LEN), "r".repeat(MAX_RULES_LEN))), []);
  });

  it("flags multi-byte text that fits maxLength but not the program's byte limit", () => {
    const name = "🚀".repeat(9); // 18 UTF-16 units (under maxLength 32), 36 bytes
    assert.ok(name.length <= MAX_NAME_LEN);
    assert.deepEqual(tooLong(withText(name)), [`Name is too long (max ${MAX_NAME_LEN} bytes).`]);
    assert.deepEqual(tooLong(withText("ok", "é".repeat(65))), [`Description is too long (max ${MAX_DESCRIPTION_LEN} bytes).`]);
    assert.deepEqual(tooLong(withText("ok", "", "€".repeat(171))), [`Trading rules are too long (max ${MAX_RULES_LEN} bytes).`]);
  });

  it("measures name and description as sent (trimmed), rules as typed", () => {
    assert.deepEqual(tooLong(withText(`  ${"a".repeat(MAX_NAME_LEN)}  `, ` ${"d".repeat(MAX_DESCRIPTION_LEN)} `)), []);
    assert.equal(tooLong(withText("ok", "", ` ${"r".repeat(MAX_RULES_LEN)}`)).length, 1);
  });
});
