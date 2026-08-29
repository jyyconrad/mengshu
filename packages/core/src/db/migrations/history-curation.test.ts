import { describe, expect, test } from "vitest";

import {
  HistoryCurationPlannerError,
  historyCurationSnapshotSha256,
  planHistoryCuration,
  type HistoryCurationSource,
  type PlanHistoryCurationInput,
} from "./history-curation.js";

const POLICY_VERSION = "history-curation/v1";
const SCOPE_A = "a".repeat(64);
const SCOPE_B = "b".repeat(64);
const CONTENT_A = "1".repeat(64);
const CONTENT_B = "2".repeat(64);

function source(
  sourceRef: string,
  overrides: Partial<HistoryCurationSource> = {},
): HistoryCurationSource {
  const ordinal = Number(sourceRef.replace(/\D/g, "")) || 1;
  return {
    sourceRef,
    sourceHash: ordinal.toString(16).padStart(64, "0"),
    scopeFingerprint: SCOPE_A,
    sourceKind: "memory",
    contentHash: CONTENT_A,
    semanticType: "rules",
    lifecycle: "active",
    quality: {
      importance: 0.7,
      valueScore: 0.8,
      confidence: 0.9,
      route: "canonical",
    },
    evidenceRefs: [`evidence-${sourceRef}`],
    createdAt: 100,
    ...overrides,
  };
}

function input(
  sources: readonly HistoryCurationSource[],
  overrides: Partial<PlanHistoryCurationInput> = {},
): PlanHistoryCurationInput {
  return {
    policyVersion: POLICY_VERSION,
    expectedSourceCount: sources.length,
    expectedSnapshotSha256: historyCurationSnapshotSha256(sources),
    sources,
    ...overrides,
  };
}

function mapping(
  result: ReturnType<typeof planHistoryCuration>,
  sourceRef: string,
) {
  return result.mappings.find((entry) => entry.sourceRef === sourceRef);
}

describe("history canonical curation pure planner", () => {
  test("exact duplicate 形成 many-to-one mapping，并按质量确定 canonical", () => {
    const sources = [
      source("source-1", { quality: { importance: 0.6, valueScore: 0.8, confidence: 0.9, route: "canonical" } }),
      source("source-2", {
        quality: { importance: 0.9, valueScore: 0.8, confidence: 0.9, route: "canonical" },
        evidenceRefs: ["evidence-2a", "evidence-2b"],
      }),
      source("source-3", { quality: { importance: 0.7, valueScore: 0.8, confidence: 0.9, route: "canonical" } }),
    ];

    const result = planHistoryCuration(input(sources));

    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "canonical_keep",
      canonicalTargetRef: "source-2",
      reasonCode: "exact_cluster_canonical",
    });
    expect(mapping(result, "source-1")).toMatchObject({
      disposition: "merge_exact",
      canonicalTargetRef: "source-2",
      reasonCode: "exact_content_duplicate",
      undo: { action: "restore_distinct", canonicalTargetRef: "source-2" },
    });
    expect(mapping(result, "source-3")).toMatchObject({
      disposition: "merge_exact",
      canonicalTargetRef: "source-2",
    });
    expect(result.metrics).toMatchObject({
      sourceTotal: 3,
      sourceMappedTotal: 3,
      unresolvedTotal: 0,
      sourceMappingCoverage: 1,
      before: { canonicalTotal: 3 },
      after: { canonicalTotal: 1 },
      reduction: { count: 2, rate: 2 / 3, physicalPurged: 0 },
    });
    expect(planHistoryCuration(input([...sources].reverse())).mappings).toEqual(result.mappings);
  });

  test("同 source identity 的明确旧 revision 被最新 revision supersede", () => {
    const result = planHistoryCuration(input([
      source("source-1", {
        contentHash: CONTENT_A,
        sourceIdentity: "resource://guide",
        revision: { id: "rev-1", order: 1 },
      }),
      source("source-2", {
        contentHash: CONTENT_B,
        sourceIdentity: "resource://guide",
        revision: { id: "rev-2", order: 2 },
      }),
    ]));

    expect(mapping(result, "source-1")).toMatchObject({
      disposition: "supersede",
      canonicalTargetRef: "source-2",
      reasonCode: "older_source_revision",
      undo: { action: "restore_distinct" },
    });
    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "canonical_keep",
      canonicalTargetRef: "source-2",
      reasonCode: "current_source_revision",
    });
    expect(result.metrics.reduction.count).toBe(1);
  });

  test("stale、lookup-only、缺 scope quarantine 与普通 distinct 均有唯一 disposition", () => {
    const result = planHistoryCuration(input([
      source("source-1", { lifecycle: "archived", staleReason: "expired_task_context" }),
      source("source-2", {
        contentHash: CONTENT_B,
        quality: { importance: 0.4, valueScore: 0.45, confidence: 0.7, route: "lookup_only" },
      }),
      source("source-3", { contentHash: "3".repeat(64), scopeFingerprint: undefined }),
      source("source-4", { contentHash: "4".repeat(64) }),
    ]));

    expect(mapping(result, "source-1")).toMatchObject({
      disposition: "archive_stale",
      reasonCode: "expired_task_context",
      undo: { action: "reactivate_source" },
    });
    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "lookup_only",
      canonicalTargetRef: "source-2",
      reasonCode: "quality_route_lookup_only",
    });
    expect(mapping(result, "source-3")).toMatchObject({
      disposition: "quarantine",
      reasonCode: "missing_scope",
    });
    expect(mapping(result, "source-3")?.canonicalTargetRef).toBeUndefined();
    expect(mapping(result, "source-4")).toMatchObject({
      disposition: "distinct_keep",
      canonicalTargetRef: "source-4",
      reasonCode: "no_merge_candidate",
    });
    expect(result.metrics).toMatchObject({
      sourceTotal: 4,
      sourceMappedTotal: 4,
      unresolvedTotal: 0,
      sourceMappingCoverage: 1,
    });
  });

  test("lookup-only Knowledge 先做 exact 收敛，未重复 Knowledge 才保持 lookup-only", () => {
    const result = planHistoryCuration(input([
      source("source-1", {
        sourceKind: "knowledge",
        semanticType: "resource",
        quality: { importance: 0.4, valueScore: 0.45, confidence: 0.7, route: "lookup_only" },
      }),
      source("source-2", {
        sourceKind: "knowledge",
        semanticType: "resource",
        quality: { importance: 0.8, valueScore: 0.45, confidence: 0.7, route: "lookup_only" },
      }),
      source("source-3", {
        sourceKind: "knowledge",
        semanticType: "resource",
        contentHash: CONTENT_B,
        quality: { importance: 0.5, valueScore: 0.45, confidence: 0.7, route: "lookup_only" },
      }),
    ]));

    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "canonical_keep",
      canonicalTargetRef: "source-2",
    });
    expect(mapping(result, "source-1")).toMatchObject({
      disposition: "merge_exact",
      canonicalTargetRef: "source-2",
    });
    expect(mapping(result, "source-3")).toMatchObject({
      disposition: "lookup_only",
      canonicalTargetRef: "source-3",
    });
  });

  test("真实 conflict 与跨 scope/type 同文保持 distinct，绝不自动合并", () => {
    const conflict = planHistoryCuration(input([
      source("source-1", { conflict: true }),
      source("source-2"),
    ]));
    expect(mapping(conflict, "source-1")).toMatchObject({
      disposition: "distinct_keep",
      reasonCode: "conflict_preserved",
    });
    expect(mapping(conflict, "source-2")?.disposition).toBe("distinct_keep");

    const isolated = planHistoryCuration(input([
      source("source-1", { scopeFingerprint: SCOPE_A, semanticType: "rules" }),
      source("source-2", { scopeFingerprint: SCOPE_B, semanticType: "rules" }),
      source("source-3", { scopeFingerprint: SCOPE_A, semanticType: "resource" }),
    ]));
    expect(isolated.mappings.map((entry) => entry.disposition)).toEqual([
      "distinct_keep", "distinct_keep", "distinct_keep",
    ]);
    expect(isolated.metrics.reduction).toMatchObject({
      count: 0,
      rate: 0,
      explanation: "no_reduction_candidates",
    });
  });

  test("仅接受同 scope/type 且由当前确定性 policy 批准的 semantic duplicate", () => {
    const result = planHistoryCuration(input([
      source("source-1", { contentHash: CONTENT_A }),
      source("source-2", {
        contentHash: CONTENT_B,
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "source-1",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "embedding",
          confidence: 0.93,
        },
      }),
      source("source-3", {
        contentHash: "3".repeat(64),
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "source-1",
          approved: false,
          policyVersion: POLICY_VERSION,
          method: "lexical",
          confidence: 0.8,
        },
      }),
    ]));

    expect(mapping(result, "source-1")?.disposition).toBe("canonical_keep");
    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "merge_semantic",
      canonicalTargetRef: "source-1",
      reasonCode: "policy_approved_semantic_duplicate",
      merge: { method: "embedding", confidence: 0.93, policyVersion: POLICY_VERSION },
    });
    expect(mapping(result, "source-3")).toMatchObject({
      disposition: "distinct_keep",
      reasonCode: "semantic_merge_not_approved",
    });
  });

  test("approved semantic target 跨 scope 时 fail closed 到 quarantine", () => {
    const result = planHistoryCuration(input([
      source("source-1", { scopeFingerprint: SCOPE_A, contentHash: CONTENT_A }),
      source("source-2", {
        scopeFingerprint: SCOPE_B,
        contentHash: CONTENT_B,
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "source-1",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "graph",
          confidence: 0.98,
        },
      }),
    ]));

    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "quarantine",
      reasonCode: "semantic_target_incompatible",
    });
    expect(result.metrics.sourceMappingCoverage).toBe(1);
  });

  test("semantic canonical target 的 exact peer 仍合并到同一 canonical", () => {
    const result = planHistoryCuration(input([
      source("source-1", { contentHash: CONTENT_A }),
      source("source-2", {
        contentHash: CONTENT_B,
        semanticMerge: {
          decision: "duplicate",
          canonicalTargetRef: "source-1",
          approved: true,
          policyVersion: POLICY_VERSION,
          method: "embedding",
          confidence: 0.94,
        },
      }),
      source("source-3", {
        contentHash: CONTENT_A,
        quality: { importance: 1, valueScore: 1, confidence: 1, route: "canonical" },
        evidenceRefs: ["evidence-3a", "evidence-3b", "evidence-3c"],
      }),
    ]));

    expect(mapping(result, "source-1")?.disposition).toBe("canonical_keep");
    expect(mapping(result, "source-2")).toMatchObject({
      disposition: "merge_semantic",
      canonicalTargetRef: "source-1",
    });
    expect(mapping(result, "source-3")).toMatchObject({
      disposition: "merge_exact",
      canonicalTargetRef: "source-1",
    });
    expect(result.metrics.after.canonicalTotal).toBe(1);
    expect(result.metrics.reduction.count).toBe(2);
  });

  test("重复 sourceRef 与 manifest count/hash 漂移均 fail closed", () => {
    const duplicated = [source("source-1"), source("source-1", { sourceHash: "f".repeat(64) })];
    expect(() => planHistoryCuration({
      policyVersion: POLICY_VERSION,
      expectedSourceCount: 2,
      expectedSnapshotSha256: "f".repeat(64),
      sources: duplicated,
    })).toThrowError(expect.objectContaining({ code: "HISTORY_CURATION_DUPLICATE_SOURCE_REF" }));

    const sources = [source("source-1")];
    expect(() => planHistoryCuration(input(sources, { expectedSourceCount: 2 })))
      .toThrowError(expect.objectContaining({ code: "HISTORY_CURATION_SOURCE_DRIFT" }));
    expect(() => planHistoryCuration(input(sources, { expectedSnapshotSha256: "f".repeat(64) })))
      .toThrowError(expect.objectContaining({ code: "HISTORY_CURATION_SOURCE_DRIFT" }));
    expect(HistoryCurationPlannerError).toBeTypeOf("function");
  });

  test("disposition summary 始终覆盖完整 8 类且无减量时可解释", () => {
    const result = planHistoryCuration(input([
      source("source-1", { contentHash: CONTENT_A }),
      source("source-2", { contentHash: CONTENT_B }),
    ]));

    expect(result.dispositionCounts).toEqual({
      canonical_keep: 0,
      merge_exact: 0,
      merge_semantic: 0,
      supersede: 0,
      archive_stale: 0,
      lookup_only: 0,
      quarantine: 0,
      distinct_keep: 2,
    });
    expect(result.metrics.reduction).toEqual({
      count: 0,
      rate: 0,
      physicalPurged: 0,
      explanation: "no_reduction_candidates",
    });
  });
});
