import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import {
  KNOWLEDGE_RESOURCE_PLAN_SCHEMA,
  parseKnowledgeResourcePlan,
  planKnowledgeResourceCuration,
  serializeKnowledgeResourcePlan,
  type PlanKnowledgeResourceCurationInput,
} from "./knowledge-resource-curation.js";

const SCOPE = "a".repeat(64);
const OTHER_SCOPE = "b".repeat(64);

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function node(
  id: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    sourceRef: `knowledge:${id}`,
    sourceHash: hash(`source:${id}`),
    sourceTable: "knowledge",
    scopeFingerprint: SCOPE,
    normalizedContentHash: hash(`content:${id}`),
    semanticTypeCandidates: [{ semanticType: "resource", confidence: 1, reason: "namespace" }],
    logicalSourceCandidates: [],
    revisionCandidates: [],
    ordinalCandidates: [],
    resourceCandidates: [],
    topicCandidates: [],
    routeCandidates: {
      source: "threshold_met",
      topic: "threshold_met",
      global: "threshold_not_met",
    },
    qualityFlags: [],
    ...overrides,
  };
}

function group(kind: string, key: string, members: readonly string[]): Record<string, unknown> {
  return { kind, key, members };
}

function makeInput(
  nodes: readonly Record<string, unknown>[],
  groups: readonly Record<string, unknown>[] = [],
  factOverrides: Readonly<Record<string, Partial<{ bytes: number; contentLength: number }>>> = {},
): PlanKnowledgeResourceCurationInput {
  const frozenHashes = {
    sourceManifestSha256: hash("source-manifest"),
    sourceSnapshotSha256: hash("source-snapshot"),
    preprocessedManifestSha256: hash("preprocessed-manifest"),
    inventoryFileSha256: hash("inventory-file"),
    inventorySemanticSha256: hash("inventory-semantic"),
  };
  const files = nodes.map((candidate) => ({
    relativePath: `knowledge/${String(candidate.sourceRef).slice("knowledge:".length)}.md`,
    sourceRef: candidate.sourceRef as string,
    sourceHash: candidate.sourceHash as string,
    markdownSha256: hash(`markdown:${String(candidate.sourceRef)}`),
    nodeSha256: hash(`node:${String(candidate.sourceRef)}`),
  }));
  const sourceFacts = nodes.map((candidate) => {
    const sourceRef = candidate.sourceRef as string;
    const override = factOverrides[sourceRef] ?? {};
    return {
      sourceRef,
      bytes: override.bytes ?? 100,
      contentLength: override.contentLength ?? 10,
    };
  });

  return {
    runId: "p3-fixture",
    policyVersion: "knowledge-resource-curation/v1",
    createdAt: "2026-08-28T00:00:00.000Z",
    expectedKnowledgeSourceCount: nodes.length,
    frozenHashes,
    observedHashes: { ...frozenHashes },
    preprocessedManifest: {
      schema: "mengshu.markdown-workset-preprocess-manifest/v1",
      migrationRunId: "p3-fixture",
      policyVersion: "markdown-preprocess/v1",
      createdAt: "2026-08-28T00:00:00.000Z",
      sourceCount: nodes.length,
      sourceManifestSha256: frozenHashes.sourceManifestSha256,
      sourceSnapshotSha256: frozenHashes.sourceSnapshotSha256,
      inventoryFileSha256: frozenHashes.inventoryFileSha256,
      inventorySha256: frozenHashes.inventorySemanticSha256,
      files,
      summary: {},
    },
    inventory: {
      schema: "mengshu.markdown-workset-preprocess/v1",
      sourceSnapshotSha256: frozenHashes.sourceSnapshotSha256,
      policyVersion: "markdown-preprocess/v1",
      sourceCount: nodes.length,
      nodes,
      groups,
      relationships: [],
      summary: {},
      inventorySha256: frozenHashes.inventorySemanticSha256,
    },
    sourceFacts,
  } as unknown as PlanKnowledgeResourceCurationInput;
}

function happyInput(): PlanKnowledgeResourceCurationInput {
  const emptyOne = node("empty-1", { semanticTypeCandidates: [] });
  const emptyTwo = node("empty-2", { semanticTypeCandidates: [] });
  const snapshotOne = node("snapshot-1", {
    logicalSourceCandidates: [{ identity: "doc-1", field: "documentId", confidence: 1 }],
    ordinalCandidates: [{ ordinal: 0, field: "chunkIndex", confidence: 1 }],
    resourceCandidates: [{ kind: "document_id", locator: "doc-1", field: "documentId", confidence: 1 }],
  });
  const snapshotTwo = node("snapshot-2", {
    logicalSourceCandidates: [{ identity: "doc-1", field: "documentId", confidence: 1 }],
    ordinalCandidates: [{ ordinal: 1, field: "chunkIndex", confidence: 1 }],
    resourceCandidates: [{ kind: "document_id", locator: "doc-1", field: "documentId", confidence: 1 }],
  });
  const locatorOne = node("locator-1", {
    resourceCandidates: [{ kind: "url", locator: "https://example.test/a", field: "url", confidence: 1 }],
  });
  const locatorTwo = node("locator-2", {
    resourceCandidates: [{ kind: "url", locator: "https://example.test/a", field: "url", confidence: 1 }],
  });
  const locatorSingle = node("locator-single", {
    resourceCandidates: [{ kind: "path", locator: "docs/a.md", field: "path", confidence: 1 }],
  });
  const lowSignal = node("low-signal");
  const namespaceOnly = node("namespace-only", {
    semanticTypeCandidates: [{
      semanticType: "resource", confidence: 0.4, reason: "legacy.dataType:document",
    }],
  });
  const quarantined = node("legacy-q", { qualityFlags: ["legacy_quarantine"] });
  const nodes = [
    locatorTwo,
    emptyOne,
    namespaceOnly,
    snapshotTwo,
    quarantined,
    lowSignal,
    locatorSingle,
    snapshotOne,
    emptyTwo,
    locatorOne,
  ];
  return makeInput(nodes, [
    group("exact_content", "empty", ["knowledge:empty-2", "knowledge:empty-1"]),
    group("snapshot_revision", "doc-1", ["knowledge:snapshot-2", "knowledge:snapshot-1"]),
    group("logical_source", "doc-1", ["knowledge:snapshot-1", "knowledge:snapshot-2"]),
    group("resource_locator", "doc-1", ["knowledge:snapshot-2", "knowledge:snapshot-1"]),
    group("resource_locator", "url-a", ["knowledge:locator-2", "knowledge:locator-1"]),
  ], {
    "knowledge:empty-1": { contentLength: 0 },
    "knowledge:empty-2": { contentLength: 0 },
  });
}

describe("Knowledge resource curation planner", () => {
  test("完整分区 Knowledge，保持 snapshot/locator component 不拆并只产候选", () => {
    const plan = planKnowledgeResourceCuration(happyInput());

    expect(plan.schema).toBe(KNOWLEDGE_RESOURCE_PLAN_SCHEMA);
    expect(plan.summary).toMatchObject({
      sourceCount: 10,
      unitCount: 7,
      batchCount: 5,
      quarantineSourceCount: 3,
      eligibleSourceCount: 7,
      eligibleStrongRevisionCount: 0,
      sourceCoverage: 1,
    });
    expect(plan.summary.byCohort).toMatchObject({
      quarantine: { units: 2, sources: 3, batches: 1 },
      snapshot_document: { units: 1, sources: 2, batches: 1 },
      strong_locator: { units: 2, sources: 3, batches: 1 },
      low_signal_resource: { units: 1, sources: 1, batches: 1 },
      namespace_hint_only: { units: 1, sources: 1, batches: 1 },
    });
    expect(plan.units.every((unit) => unit.candidateOnly)).toBe(true);
    expect(plan.units.filter((unit) => unit.cohort === "quarantine")
      .every((unit) => unit.dispositionCandidate === "quarantine")).toBe(true);
    expect(plan.units.filter((unit) => unit.cohort !== "quarantine")
      .every((unit) => unit.dispositionCandidate === "lookup_only")).toBe(true);
    expect(plan.guards).toEqual({
      candidateOnly: true,
      canonicalTargetsSelected: false,
      formalAssetsWritten: false,
      treeArtifactsWritten: false,
      postgresTouched: false,
      supersedeAllowed: false,
      crossScopeGroupingAllowed: false,
    });

    const snapshotUnit = plan.units.find((unit) => unit.cohort === "snapshot_document");
    expect(snapshotUnit?.sources.map((source) => source.sourceRef)).toEqual([
      "knowledge:snapshot-1", "knowledge:snapshot-2",
    ]);
    const locatorUnit = plan.units.find((unit) => unit.sources.length === 2 &&
      unit.cohort === "strong_locator");
    expect(locatorUnit?.sources.map((source) => source.sourceRef)).toEqual([
      "knowledge:locator-1", "knowledge:locator-2",
    ]);
  });

  test("review 与 deterministic 批次分别遵守 20 unit 和 500 source 上限", () => {
    const locatorNodes = Array.from({ length: 21 }, (_, index) => node(`locator-${index}`, {
      resourceCandidates: [{
        kind: "path", locator: `docs/${index}.md`, field: "path", confidence: 1,
      }],
    }));
    const lowNodes = Array.from({ length: 501 }, (_, index) => node(`low-${index}`));
    const plan = planKnowledgeResourceCuration(makeInput([...locatorNodes, ...lowNodes]));

    expect(plan.batches.filter((batch) => batch.cohort === "strong_locator"))
      .toHaveLength(2);
    expect(plan.batches.filter((batch) => batch.cohort === "low_signal_resource"))
      .toHaveLength(2);
    expect(plan.batches.filter((batch) => batch.mode === "review")
      .every((batch) => batch.unitIds.length <= 20 && batch.bytes <= 400_000)).toBe(true);
    expect(plan.batches.filter((batch) => batch.mode === "deterministic")
      .every((batch) => batch.sourceCount <= 500 && batch.bytes <= 4_000_000)).toBe(true);
  });

  test("语义 plan hash 不受输入顺序与 createdAt 影响，batchId 绑定 source bindings", () => {
    const firstInput = happyInput();
    const first = planKnowledgeResourceCuration(firstInput);
    const reordered = {
      ...firstInput,
      createdAt: "2026-08-28T12:00:00.000Z",
      preprocessedManifest: {
        ...firstInput.preprocessedManifest,
        files: [...firstInput.preprocessedManifest.files].reverse(),
      },
      inventory: {
        ...firstInput.inventory,
        nodes: [...firstInput.inventory.nodes].reverse(),
        groups: [...firstInput.inventory.groups].reverse(),
      },
      sourceFacts: [...firstInput.sourceFacts].reverse(),
    };
    const second = planKnowledgeResourceCuration(reordered);

    expect(second.semanticPlanSha256).toBe(first.semanticPlanSha256);
    expect(second.batches.map((batch) => batch.batchId))
      .toEqual(first.batches.map((batch) => batch.batchId));

    const changed = structuredClone(firstInput);
    (changed.inventory.nodes[0] as { sourceHash: string }).sourceHash = hash("changed-source");
    (changed.preprocessedManifest.files[0] as { sourceHash: string }).sourceHash =
      hash("changed-source");
    expect(planKnowledgeResourceCuration(changed).semanticPlanSha256)
      .not.toBe(first.semanticPlanSha256);
  });

  test("序列化/解析执行 strict exact-key 与 semantic hash 校验", () => {
    const plan = planKnowledgeResourceCuration(happyInput());
    expect(parseKnowledgeResourcePlan(serializeKnowledgeResourcePlan(plan))).toEqual(plan);

    const extra = { ...plan, canonicalTarget: "forbidden" };
    expect(() => parseKnowledgeResourcePlan(JSON.stringify(extra))).toThrow(/invalid/i);

    const drifted = { ...plan, semanticPlanSha256: hash("drifted") };
    expect(() => parseKnowledgeResourcePlan(JSON.stringify(drifted))).toThrow(/hash/i);
  });

  test("遇到 proxy、cycle、unknown enum、duplicate source 和 hash drift 时 fail closed", () => {
    expect(() => planKnowledgeResourceCuration(new Proxy(happyInput(), {})))
      .toThrow(/proxy|invalid/i);

    const cycle = structuredClone(happyInput()) as PlanKnowledgeResourceCurationInput & {
      self?: unknown;
    };
    cycle.self = cycle;
    expect(() => planKnowledgeResourceCuration(cycle)).toThrow(/cycle|invalid/i);

    const unknown = structuredClone(happyInput());
    unknown.inventory.groups[0].kind = "unknown_group";
    expect(() => planKnowledgeResourceCuration(unknown)).toThrow(/enum|invalid/i);

    const duplicate = structuredClone(happyInput());
    (duplicate.preprocessedManifest.files as Array<
      (typeof duplicate.preprocessedManifest.files)[number]
    >).push({
      ...duplicate.preprocessedManifest.files[0],
    });
    expect(() => planKnowledgeResourceCuration(duplicate)).toThrow(/duplicate/i);

    const drift = structuredClone(happyInput());
    drift.observedHashes.inventoryFileSha256 = hash("unexpected");
    expect(() => planKnowledgeResourceCuration(drift)).toThrow(/hash/i);
  });

  test("coverage gap、scope crossing 和单 component 超限时 fail closed", () => {
    const gap = structuredClone(happyInput());
    (gap.sourceFacts as Array<(typeof gap.sourceFacts)[number]>).pop();
    expect(() => planKnowledgeResourceCuration(gap)).toThrow(/coverage/i);

    const crossingNodes = [
      node("scope-a", {
        resourceCandidates: [{ kind: "path", locator: "docs/a.md", field: "path", confidence: 1 }],
      }),
      node("scope-b", {
        scopeFingerprint: OTHER_SCOPE,
        resourceCandidates: [{ kind: "path", locator: "docs/a.md", field: "path", confidence: 1 }],
      }),
    ];
    const crossing = makeInput(crossingNodes, [
      group("resource_locator", "cross", ["knowledge:scope-a", "knowledge:scope-b"]),
    ]);
    expect(() => planKnowledgeResourceCuration(crossing)).toThrow(/scope/i);

    const oversizedNode = node("oversized", {
      resourceCandidates: [{ kind: "path", locator: "docs/big.md", field: "path", confidence: 1 }],
    });
    const oversized = makeInput([oversizedNode], [], {
      "knowledge:oversized": { bytes: 400_001 },
    });
    expect(() => planKnowledgeResourceCuration(oversized)).toThrow(/oversize/i);
  });

  test("eligible strong revision 为 0 时无 supersede，low-signal/namespace 保持 singleton", () => {
    const plan = planKnowledgeResourceCuration(happyInput());
    expect(plan.summary.eligibleStrongRevisionCount).toBe(0);
    expect(plan.guards.supersedeAllowed).toBe(false);
    expect(plan.units.some((unit) =>
      (unit.dispositionCandidate as string) === "supersede")).toBe(false);
    expect(plan.units.filter((unit) =>
      unit.cohort === "low_signal_resource" || unit.cohort === "namespace_hint_only")
      .every((unit) => unit.sources.length === 1)).toBe(true);
  });
});
