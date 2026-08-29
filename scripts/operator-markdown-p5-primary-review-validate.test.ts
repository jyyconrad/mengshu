import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { GovernedAssetProposal } from
  "../packages/core/src/db/migrations/governed-asset-proposal.js";
import {
  validateP5PrimaryReviewRow,
} from "./operator-markdown-p5-primary-review-validate.js";

const HASH = (value: string): string => createHash("sha256").update(value).digest("hex");
const SOURCE_TEXT = "规则一。规则二。";
const SOURCE_REFS = ["memories:a", "memories:b"];

function proposal(): GovernedAssetProposal {
  const sourceBindings = SOURCE_REFS.map((sourceRef) => ({
    schema: "mengshu.governed-asset-source-anchor/v1" as const,
    sourceRef,
    sourceHash: HASH(sourceRef),
    startByte: 0,
    endByte: Buffer.byteLength(SOURCE_TEXT, "utf8"),
    excerptHash: HASH(SOURCE_TEXT),
  }));
  return {
    schema: "mengshu.governed-asset-proposal/v1",
    proposalId: HASH("proposal"),
    assetCandidateId: HASH("asset"),
    sourceBatchIds: [HASH("source-batch")],
    scopeFingerprint: HASH("scope"),
    scope: {} as GovernedAssetProposal["scope"],
    semanticType: "rules",
    unitIds: [HASH("unit")],
    governanceClusterId: null,
    titleCandidate: "规则",
    claims: [{
      schema: "mengshu.governed-asset-claim-candidate/v1",
      claimId: HASH("claim"),
      text: SOURCE_TEXT,
      sourceBindings,
    }],
    relationCandidates: [],
    resourceIdentityRefs: [],
    needsReview: true,
    reviewReasons: ["whole_body_claim_requires_review"],
    candidateOnly: true,
  };
}

function review(
  candidate: GovernedAssetProposal,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schema: "mengshu.p5-proposal-review-draft/v1",
    batchId: HASH("review-batch"),
    proposalId: candidate.proposalId,
    assetCandidateId: candidate.assetCandidateId,
    scopeFingerprint: candidate.scopeFingerprint,
    semanticType: candidate.semanticType,
    unitIds: candidate.unitIds,
    verdict: "accept_exact_claims",
    titleCandidate: "两条规则",
    claims: [{
      claimKey: "claim_exact",
      text: SOURCE_TEXT,
      sourceBindings: candidate.claims[0]!.sourceBindings.map((binding) => ({
        sourceRef: binding.sourceRef,
        sourceHash: binding.sourceHash,
        startByte: binding.startByte,
        endByte: binding.endByte,
        excerptHash: binding.excerptHash,
      })),
    }],
    relationCandidates: [],
    confidence: 0.95,
    reasonCodes: ["exact_source_anchor_preserved"],
    notes: "已复核",
    candidateOnly: true,
    ...overrides,
  };
}

describe("P5 primary review validator", () => {
  it("接受逐字对应 UTF-8 byte slice 的 claim，并归一化 notes", () => {
    const candidate = proposal();
    const result = validateP5PrimaryReviewRow(
      review(candidate),
      candidate,
      HASH("review-batch"),
      new Map([[candidate.assetCandidateId, candidate]]),
    );

    expect(result.row).toMatchObject({
      verdict: "accept_exact_claims",
      notes: ["已复核"],
      confidence: 0.95,
    });
    expect(result.row.claims[0]!.sourceBindings).toHaveLength(2);
  });

  it("拒绝 claim 改写后仍沿用原 excerptHash", () => {
    const candidate = proposal();
    const value = review(candidate);
    const claims = structuredClone(value.claims) as Array<Record<string, unknown>>;
    claims[0]!.text = "规则一和规则二。";

    expect(() => validateP5PrimaryReviewRow(
      { ...value, claims },
      candidate,
      HASH("review-batch"),
      new Map([[candidate.assetCandidateId, candidate]]),
    )).toThrow(/EVIDENCE_INVALID/);
  });

  it("拒绝公开 title/claim 泄漏 raw sourceRef", () => {
    const candidate = proposal();
    expect(() => validateP5PrimaryReviewRow(
      review(candidate, { titleCandidate: `读取 ${SOURCE_REFS[0]}` }),
      candidate,
      HASH("review-batch"),
      new Map([[candidate.assetCandidateId, candidate]]),
    )).toThrow(/PUBLIC_CONTENT_INVALID/);
  });
});
