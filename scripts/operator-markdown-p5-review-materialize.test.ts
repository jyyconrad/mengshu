import { describe, expect, it } from "vitest";

import type { GovernedAssetProposal } from
  "../packages/core/src/db/migrations/governed-asset-proposal.js";
import { buildP5ReviewBatches } from "./operator-markdown-p5-review-materialize.js";

function proposal(
  index: number,
  semanticType: "rules" | "experience",
  scopeFingerprint = "a".repeat(64),
): GovernedAssetProposal {
  const identity = index.toString(16).padStart(64, "0");
  return {
    assetCandidateId: identity,
    proposalId: identity,
    scopeFingerprint,
    semanticType,
  } as GovernedAssetProposal;
}

describe("P5 proposal review materializer", () => {
  it("rules/profile 每批最多10，其他类型每批最多25，且不跨 scope/type", () => {
    const input = [
      ...Array.from({ length: 11 }, (_, index) => proposal(index + 1, "rules")),
      ...Array.from({ length: 26 }, (_, index) => proposal(index + 100, "experience")),
      proposal(999, "rules", "b".repeat(64)),
    ];
    const batches = buildP5ReviewBatches(input);

    expect(batches).toHaveLength(5);
    expect(batches.filter((batch) => batch.riskLane === "protected")
      .every((batch) => batch.proposals.length <= 10)).toBe(true);
    expect(batches.filter((batch) => batch.riskLane === "standard")
      .every((batch) => batch.proposals.length <= 25)).toBe(true);
    expect(batches.every((batch) => new Set(batch.proposals.map((item) =>
      `${item.scopeFingerprint}:${item.semanticType}`)).size === 1)).toBe(true);
    expect(new Set(batches.flatMap((batch) => batch.proposals.map((item) => item.proposalId))).size)
      .toBe(input.length);
  });

  it("输入顺序不影响 batchId 和成员", () => {
    const input = Array.from({ length: 17 }, (_, index) => proposal(index + 1, "rules"));
    const first = buildP5ReviewBatches(input);
    const second = buildP5ReviewBatches([...input].reverse());

    expect(second.map((batch) => ({
      batchId: batch.batchId,
      proposalIds: batch.proposals.map((item) => item.proposalId),
    }))).toEqual(first.map((batch) => ({
      batchId: batch.batchId,
      proposalIds: batch.proposals.map((item) => item.proposalId),
    })));
  });
});
