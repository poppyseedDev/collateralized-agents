import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_DRAFT, draftProblems, maxDrawdownForRatio } from "@/components/operator/AgentForm";

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
