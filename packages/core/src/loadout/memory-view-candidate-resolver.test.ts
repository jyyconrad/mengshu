import { describe, expect, test } from "vitest";

import { computeRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryRecord, RecallHit } from "../domain/types.js";
import type { MemoryViewAssetDescriptor } from "../assets/types.js";
import { resolveMemoryViewLoadoutCandidate } from "./memory-view-candidate-resolver.js";

const scope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
  agentId: "agent-a", namespace: "memory", visibility: "private" as const,
};
const asset: MemoryViewAssetDescriptor = {
  id: "asset-1", kind: "memory_view", owner: { subjectType: "user", subjectId: scope.userId },
  title: "Rules", semanticTypes: ["rules"], sourceScope: scope, version: 1,
  status: "published", visibility: "private",
  contentRef: { type: "memory_projection", recordIds: ["m1", "m2"], treeNodeIds: [],
    evidenceIds: ["e1", "e2"], semanticTypes: ["rules"], resolutionHash: "a".repeat(64) },
  provenanceRefs: [], evidenceRefs: ["e1", "e2"], riskFlags: [],
  qualitySnapshot: { scoringVersion: "v1" },
  createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
};

function hit(id: string, evidence: string, relevance: number): RecallHit {
  const record: MemoryRecord = {
    id, scope, kind: "decision", semanticType: "rules", lifecycleStatus: "active",
    text: `rule ${id}`, contentHash: id, importance: 0.9, confidence: 0.9,
    category: "decision", dataType: "memory", metadata: {}, provenance: {},
    sourceNodeIds: [evidence], createdAt: 1,
  };
  const scoreBreakdown = computeRecallScoreBreakdown(
    record, { relevance, scopeFit: 1 }, ["vector"], { vector: relevance },
  );
  return { record, score: scoreBreakdown.score, source: "vector", scoreBreakdown };
}

describe("resolveMemoryViewLoadoutCandidate", () => {
  test("uses the lowest governed six-factor receipt and requires all source evidence", () => {
    const high = hit("m1", "e1", 1);
    const low = hit("m2", "e2", 0.4);
    const result = resolveMemoryViewLoadoutCandidate(asset, [high, low]);
    expect(result).toMatchObject({
      contentValidity: "current", lifecycleEligible: true,
      score: low.score, scoreBreakdown: low.scoreBreakdown, recallSource: "vector",
      content: "rule m1\nrule m2",
    });
  });

  test("marks partial recall stale instead of bypassing retrieval", () => {
    expect(resolveMemoryViewLoadoutCandidate(asset, [hit("m1", "e1", 1)]))
      .toMatchObject({ contentValidity: "stale", lifecycleEligible: false });
  });

  test("tree-backed asset requires a current read-time source receipt while preserving governed scoring", () => {
    const treeAsset: MemoryViewAssetDescriptor = {
      ...asset,
      contentRef: {
        ...asset.contentRef,
        treeNodeIds: ["tree-1"],
      },
    };
    const first = hit("m1", "e1", 1);
    const second = hit("m2", "e2", 0.4);

    expect(resolveMemoryViewLoadoutCandidate(treeAsset, [first, second]))
      .toMatchObject({ contentValidity: "stale", lifecycleEligible: false });
    expect(resolveMemoryViewLoadoutCandidate(treeAsset, [first, second], {
      asset: treeAsset,
      contentValidity: "current",
      staleReasons: [],
      explanation: {
        assetId: treeAsset.id,
        version: treeAsset.version,
        status: treeAsset.status,
        scopeFingerprint: "scope-fingerprint",
        recordIds: treeAsset.contentRef.recordIds,
        treeNodeIds: treeAsset.contentRef.treeNodeIds,
        evidenceIds: treeAsset.contentRef.evidenceIds,
        semanticTypes: treeAsset.semanticTypes,
        qualitySnapshot: treeAsset.qualitySnapshot,
      },
    })).toMatchObject({
      contentValidity: "current",
      lifecycleEligible: true,
      score: second.score,
      scoreBreakdown: second.scoreBreakdown,
    });
  });
});
