import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import {
  TYPED_MEMORY_BATCH_PLAN_SCHEMA,
  parseTypedMemoryBatchPlan,
  planTypedMemoryBatches,
  serializeTypedMemoryBatchPlan,
  typedMemoryClusterBindingsSemanticSha256,
  type PlanTypedMemoryBatchesInput,
  type TypedMemoryClusterBindingInput,
  type TypedMemoryUnitResolutionInput,
} from "./typed-memory-batch-plan.js";
import type { MarkdownScopeRegistry } from "./markdown-scope-registry.js";
import type {
  MemoryCurationBatchPlan,
  MemoryCurationCohort,
} from "./markdown-curation-batch-planner.js";

const SCOPE_A_DESCRIPTOR: MemoryScope = {
  tenantId: "tenant-a",
  appId: "app-a",
  userId: "user-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  workspaceId: "workspace-a",
  visibility: "private",
};
const SCOPE_B_DESCRIPTOR: MemoryScope = {
  ...SCOPE_A_DESCRIPTOR,
  projectId: "project-b",
  workspaceId: "workspace-b",
};
const SCOPE_A = authorityScopeFingerprint(SCOPE_A_DESCRIPTOR);
const SCOPE_B = authorityScopeFingerprint(SCOPE_B_DESCRIPTOR);
const CREATED_AT = "2026-08-28T12:00:00.000Z";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

function resolutionSemanticHash(records: readonly TypedMemoryUnitResolutionInput[]): string {
  const sorted = [...records].sort((left, right) => left.unitId.localeCompare(right.unitId));
  return createHash("sha256")
    .update("mengshu.typed-memory-unit-resolutions/semantic/v1")
    .update("\0")
    .update(stableJson(sorted))
    .digest("hex");
}

function rehashPlan(plan: MemoryCurationBatchPlan): MemoryCurationBatchPlan {
  const { planSha256: ignored, ...body } = plan;
  return { ...body, planSha256: sha256(stableJson(body)) };
}

function memoryPlan(): MemoryCurationBatchPlan {
  const units: any[] = [];
  const batches: any[] = [];
  for (let sequence = 1; sequence <= 37; sequence += 1) {
    const p2 = sequence <= 34;
    const cohort: MemoryCurationCohort = p2
      ? sequence === 1 ? "quarantine" : "untyped"
      : sequence <= 36 ? "rules" : "profile";
    const scopeFingerprint = sequence === 37 ? SCOPE_B : SCOPE_A;
    const unitId = sha256(`unit:${sequence}`);
    const sourceRef = `memories:source-${sequence}`;
    const sourceHash = sha256(`source:${sequence}`);
    units.push({
      unitId,
      cohort,
      scopeFingerprint,
      sourceRefs: [sourceRef],
      sourceHashes: [sourceHash],
      candidateTypes: p2 ? [] : [cohort],
      qualityFlags: [],
      files: [{
        sourceRef,
        sourceHash,
        relativePath: `memory/${sequence}.md`,
        markdownSha256: sha256(`markdown:${sequence}`),
        bytes: 100,
      }],
      sourceCount: 1,
      bytes: 100,
    });
    batches.push({
      batchId: sha256(`batch:${sequence}`),
      sequence,
      cohort,
      mode: p2
        ? sequence === 1 ? "exclude" : "type_review"
        : "memory_document_proposal",
      scopeFingerprint,
      unitIds: [unitId],
      sourceCount: 1,
      bytes: 100,
    });
  }
  const body = {
    schema: "mengshu.memory-curation-batch-plan/v1" as const,
    migrationRunId: "typed-memory-fixture",
    sourceSnapshotSha256: sha256("snapshot"),
    sourceManifestSha256: sha256("manifest"),
    preprocessedManifestSha256: sha256("preprocessed"),
    inventorySha256: sha256("inventory"),
    policyVersion: "memory-curation/v1",
    createdAt: "2026-08-28T00:00:00.000Z",
    maxUnitsPerBatch: 10,
    maxBytesPerBatch: 10_000,
    units,
    batches,
    summary: {
      sourceCount: units.length,
      unitCount: units.length,
      batchCount: batches.length,
      byCohort: {},
    },
    guards: ["candidate_only"],
  };
  return { ...body, planSha256: sha256(stableJson(body)) } as MemoryCurationBatchPlan;
}

function p2Resolutions(plan: MemoryCurationBatchPlan): TypedMemoryUnitResolutionInput[] {
  const unitById = new Map(plan.units.map((unit) => [unit.unitId, unit] as const));
  return plan.batches.filter((batch) => batch.sequence <= 34).map((batch) => {
    const unit = unitById.get(batch.unitIds[0]!)!;
    const sequence = batch.sequence;
    const disposition = sequence === 1 ? "quarantine"
      : sequence === 2 ? "archive_stale"
        : sequence === 3 || sequence >= 8 ? "lookup_only"
          : sequence === 4 || sequence === 5 ? "merge_semantic"
            : sequence === 6 ? "canonical_keep" : "distinct_keep";
    const semanticType = sequence === 1 ? null
      : sequence === 3 || sequence >= 8 ? "resource"
        : sequence === 4 || sequence === 5 ? "rules"
          : sequence === 6 ? "profile" : "task_context";
    return {
      schema: "mengshu.unit-type-resolution/v1",
      unitId: unit.unitId,
      batchId: batch.batchId,
      sequence,
      scopeFingerprint: unit.scopeFingerprint ?? null,
      sources: unit.sourceRefs.map((sourceRef, index) => ({
        sourceRef,
        sourceHash: unit.sourceHashes[index]!,
      })),
      semanticType,
      disposition,
      confidence: sequence === 1 ? null : 0.95,
      conflict: false,
      resolutionBasis: sequence === 1 ? "quarantine" : "accepted_primary",
      proposalId: sequence === 1 ? null : `proposal_${sha256(`proposal:${sequence}`).slice(0, 32)}`,
      reviewedArtifactHash: sequence === 1 ? null : sha256(`artifact:${sequence}`),
      reasonCodes: [sequence === 1 ? "legacy_quarantine" : "reviewed_resolution"],
      candidateOnly: false,
    } as TypedMemoryUnitResolutionInput;
  });
}

function input(): PlanTypedMemoryBatchesInput {
  const plan = memoryPlan();
  const resolutions = p2Resolutions(plan);
  const mergeMembers = plan.batches.filter((batch) => batch.sequence === 4 || batch.sequence === 5)
    .flatMap((batch) => batch.unitIds).sort();
  const mergeSemanticClusterBindings: TypedMemoryClusterBindingInput[] = [{
    schema: "mengshu.typed-memory-cluster-binding/v1",
    clusterKey: "fixture_rules_cluster",
    scopeFingerprint: SCOPE_A,
    semanticType: "rules",
    memberUnitIds: mergeMembers,
    reasonCodes: ["explicit_evidence_match"],
    candidateOnly: false,
  }];
  const entries = [
    { fingerprint: SCOPE_A, scope: structuredClone(SCOPE_A_DESCRIPTOR) },
    { fingerprint: SCOPE_B, scope: structuredClone(SCOPE_B_DESCRIPTOR) },
  ].map(({ fingerprint, scope }) => {
    const sources = plan.units.filter((unit) => unit.scopeFingerprint === fingerprint)
      .flatMap((unit) => unit.sourceRefs.map((sourceRef, index) =>
        `${sourceRef}\u001f${unit.sourceHashes[index]}`)).sort();
    return {
      scopeFingerprint: fingerprint,
      scope,
      sourceCount: sources.length,
      memorySourceCount: sources.length,
      knowledgeSourceCount: 0,
      sourceSetSha256: sha256(sources.join("\n")),
    };
  }).sort((left, right) => left.scopeFingerprint.localeCompare(right.scopeFingerprint));
  const registryPayload = {
    schema: "mengshu.authority-scope-registry/v1" as const,
    migrationRunId: plan.migrationRunId,
    sourceManifestFileSha256: plan.sourceManifestSha256,
    sourceSnapshotSha256: plan.sourceSnapshotSha256,
    createdAt: "2026-08-28T01:00:00.000Z",
    entries,
    summary: {
      sourceCount: plan.summary.sourceCount,
      scopedSourceCount: plan.summary.sourceCount,
      unscopedSourceCount: 0,
      memoryScopedSourceCount: plan.summary.sourceCount,
      knowledgeScopedSourceCount: 0,
      scopeCount: entries.length,
    },
  };
  const scopeRegistry = {
    ...registryPayload,
    registrySha256: sha256(stableJson(registryPayload)),
  } as MarkdownScopeRegistry;
  return {
    policyVersion: "typed-memory-batch-plan/v1",
    createdAt: CREATED_AT,
    expectedMemorySourceCount: plan.summary.sourceCount,
    expectedMemoryUnitCount: plan.summary.unitCount,
    frozenHashes: {
      memoryPlanFileSha256: sha256("memory-plan-file"),
      memoryPlanSemanticSha256: plan.planSha256,
      unitResolutionsFileSha256: sha256("unit-resolutions-file"),
      unitResolutionsSemanticSha256: resolutionSemanticHash(resolutions),
      mergeSemanticClusterBindingsFileSha256: sha256("cluster-bindings-file"),
      mergeSemanticClusterBindingsSemanticSha256:
        typedMemoryClusterBindingsSemanticSha256(mergeSemanticClusterBindings),
      knowledgeResourceBindingsFileSha256: sha256("knowledge-bindings-file"),
      scopeRegistryFileSha256: sha256("scope-registry-file"),
      scopeRegistrySha256: scopeRegistry.registrySha256,
    },
    scopeRegistry,
    memoryPlan: plan,
    unitResolutions: resolutions,
    mergeSemanticClusterBindings,
  };
}

function refreshScopeRegistry(value: PlanTypedMemoryBatchesInput): PlanTypedMemoryBatchesInput {
  const registry = value.scopeRegistry as any;
  const memory = registry.entries.reduce(
    (sum: number, entry: any) => sum + entry.memorySourceCount,
    0,
  );
  const knowledge = registry.entries.reduce(
    (sum: number, entry: any) => sum + entry.knowledgeSourceCount,
    0,
  );
  registry.summary = {
    sourceCount: memory + knowledge,
    scopedSourceCount: memory + knowledge,
    unscopedSourceCount: 0,
    memoryScopedSourceCount: memory,
    knowledgeScopedSourceCount: knowledge,
    scopeCount: registry.entries.length,
  };
  const { registrySha256: ignored, ...payload } = registry;
  registry.registrySha256 = sha256(stableJson(payload));
  return {
    ...value,
    frozenHashes: { ...value.frozenHashes, scopeRegistrySha256: registry.registrySha256 },
  };
}

function refreshResolutionHash(value: PlanTypedMemoryBatchesInput): PlanTypedMemoryBatchesInput {
  return {
    ...value,
    frozenHashes: {
      ...value.frozenHashes,
      unitResolutionsSemanticSha256: resolutionSemanticHash(value.unitResolutions),
    },
  };
}

function refreshPlanHash(value: PlanTypedMemoryBatchesInput): PlanTypedMemoryBatchesInput {
  const memoryPlan = rehashPlan(value.memoryPlan);
  return {
    ...value,
    memoryPlan,
    frozenHashes: {
      ...value.frozenHashes,
      memoryPlanSemanticSha256: memoryPlan.planSha256,
    },
  };
}

describe("typed Memory batch planner", () => {
  test("覆盖全量 plan，分离 eligible/excluded 并生成 scope+type 互斥 batches", () => {
    const plan = planTypedMemoryBatches(input());
    expect(plan.schema).toBe(TYPED_MEMORY_BATCH_PLAN_SCHEMA);
    expect(plan.summary).toMatchObject({
      sourceCount: 37,
      unitCount: 37,
      eligibleUnits: 7,
      eligibleSources: 7,
      excludedUnits: 30,
      excludedSources: 30,
      sourceCoverage: 1,
      unitCoverage: 1,
    });
    expect(plan.eligibleUnits.filter((unit) => unit.origin === "typed_plan")
      .every((unit) => unit.disposition === "merge_exact")).toBe(true);
    expect(plan.eligibleUnits.every((unit) =>
      authorityScopeFingerprint(unit.scope) === unit.scopeFingerprint)).toBe(true);
    expect(plan.batches.every((batch) =>
      batch.unitIds.length <= 30 && batch.bytes <= 400_000 && batch.candidateOnly)).toBe(true);
    for (const batch of plan.batches) {
      const units = plan.eligibleUnits.filter((unit) => batch.unitIds.includes(unit.unitId));
      expect(new Set(units.map((unit) => unit.scopeFingerprint)).size).toBe(1);
      expect(new Set(units.map((unit) => unit.semanticType)).size).toBe(1);
      expect(authorityScopeFingerprint(batch.scope)).toBe(batch.scopeFingerprint);
    }
    expect(plan.guards).toMatchObject({
      candidateOnly: true,
      canonicalTargetsSelected: false,
      formalAssetsWritten: false,
      treeArtifactsWritten: false,
      postgresTouched: false,
      knowledgePrivateBindingsAreInputsOnly: true,
    });
  });

  test("P2 resolution 漏项、重复和 source 漂移均 fail closed", () => {
    const missing = input();
    missing.unitResolutions.pop();
    expect(() => planTypedMemoryBatches(refreshResolutionHash(missing)))
      .toThrow(/P2|coverage|missing/i);

    const duplicate = input();
    duplicate.unitResolutions.push(structuredClone(duplicate.unitResolutions[0]!));
    expect(() => planTypedMemoryBatches(refreshResolutionHash(duplicate)))
      .toThrow(/duplicate|P2|coverage/i);

    const drift = input();
    drift.unitResolutions[0]!.sources[0]!.sourceHash = sha256("drifted");
    expect(() => planTypedMemoryBatches(refreshResolutionHash(drift)))
      .toThrow(/source|hash|drift/i);
  });

  test("拒绝非法 final disposition", () => {
    const value = input();
    (value.unitResolutions[3] as any).disposition = "drop";
    expect(() => planTypedMemoryBatches(refreshResolutionHash(value)))
      .toThrow(/disposition|enum|invalid/i);
  });

  test("拒绝原 typed cohort/type/mode 漂移", () => {
    const value = input();
    const batch = value.memoryPlan.batches.find((candidate) => candidate.sequence === 35)! as any;
    batch.mode = "resource_deferred";
    expect(() => planTypedMemoryBatches(refreshPlanHash(value)))
      .toThrow(/typed|mode|cohort/i);

    const typeDrift = input();
    const typed = typeDrift.memoryPlan.units.find((unit) =>
      typeDrift.memoryPlan.batches.find((batch) => batch.sequence === 35)?.unitIds
        .includes(unit.unitId))! as any;
    typed.candidateTypes = ["experience"];
    expect(() => planTypedMemoryBatches(refreshPlanHash(typeDrift)))
      .toThrow(/typed|type|cohort/i);
  });

  test("原计划 resource_deferred 仍进入 P5 resource 治理而不直接物化", () => {
    const value = input();
    const batch = value.memoryPlan.batches.find((candidate) => candidate.sequence === 35)! as any;
    const unit = value.memoryPlan.units.find(
      (candidate) => candidate.unitId === batch.unitIds[0],
    )! as any;
    batch.cohort = "resource";
    batch.mode = "resource_deferred";
    unit.cohort = "resource";
    unit.candidateTypes = ["resource"];

    const result = planTypedMemoryBatches(refreshPlanHash(value));
    expect(result.eligibleUnits.find((candidate) => candidate.unitId === unit.unitId))
      .toMatchObject({ semanticType: "resource", disposition: "merge_exact", candidateOnly: true });
    expect(result.guards.formalAssetsWritten).toBe(false);
  });

  test("拒绝 batch/unit scope crossing", () => {
    const value = input();
    const batch = value.memoryPlan.batches.find((candidate) => candidate.sequence === 35)!;
    const unit = value.memoryPlan.units.find((candidate) => candidate.unitId === batch.unitIds[0])!;
    (unit as any).scopeFingerprint = SCOPE_B;
    expect(() => planTypedMemoryBatches(refreshPlanHash(value))).toThrow(/scope/i);
  });

  test("scope registry 漏项、descriptor 错误和 fingerprint 漂移均拒绝", () => {
    const missing = input();
    (missing.scopeRegistry.entries as any[]).pop();
    expect(() => planTypedMemoryBatches(refreshScopeRegistry(missing)))
      .toThrow(/scope.*registry|scope.*missing/i);

    const wrongDescriptor = input();
    (wrongDescriptor.scopeRegistry.entries[0]!.scope as any).namespace = "changed";
    expect(() => planTypedMemoryBatches(wrongDescriptor)).toThrow(/scope.*fingerprint|scope.*drift/i);

    const wrongFingerprint = input();
    (wrongFingerprint.scopeRegistry.entries[0] as any).scopeFingerprint = sha256("wrong-scope");
    expect(() => planTypedMemoryBatches(wrongFingerprint)).toThrow(/scope.*fingerprint|scope.*drift/i);
  });

  test("同 scope/type merge_semantic cluster 不拆，整体超限时拒绝", () => {
    const value = input();
    for (const sequence of [4, 5]) {
      const batch = value.memoryPlan.batches.find((candidate) => candidate.sequence === sequence)!;
      const unit = value.memoryPlan.units.find((candidate) => candidate.unitId === batch.unitIds[0])!;
      (unit as any).bytes = 200_001;
      (unit.files[0] as any).bytes = 200_001;
      (batch as any).bytes = 200_001;
    }
    expect(() => planTypedMemoryBatches(refreshPlanHash(value)))
      .toThrow(/cluster|oversize|400/i);
  });

  test("merge_semantic 必须由显式 cluster binding 完整覆盖", () => {
    const missing = input();
    missing.mergeSemanticClusterBindings = [];
    missing.frozenHashes.mergeSemanticClusterBindingsSemanticSha256 =
      typedMemoryClusterBindingsSemanticSha256([]);
    expect(() => planTypedMemoryBatches(missing)).toThrow(/explicit|cluster|missing/i);

    const inferredByScopeOnly = input();
    (inferredByScopeOnly.mergeSemanticClusterBindings[0] as any).memberUnitIds = [
      inferredByScopeOnly.mergeSemanticClusterBindings[0]!.memberUnitIds[0]!,
      inferredByScopeOnly.memoryPlan.batches.find((batch) => batch.sequence === 35)!.unitIds[0]!,
    ].sort();
    inferredByScopeOnly.frozenHashes.mergeSemanticClusterBindingsSemanticSha256 =
      typedMemoryClusterBindingsSemanticSha256(
        inferredByScopeOnly.mergeSemanticClusterBindings,
      );
    expect(() => planTypedMemoryBatches(inferredByScopeOnly)).toThrow(/cluster|missing|explicit/i);
  });

  test("输入顺序和 createdAt 不影响 semantic hash 或 batchId", () => {
    const first = planTypedMemoryBatches(input());
    const reordered = input();
    reordered.unitResolutions.reverse();
    (reordered as any).createdAt = "2026-08-28T18:00:00.000Z";
    const second = planTypedMemoryBatches(reordered);
    expect(second.semanticPlanSha256).toBe(first.semanticPlanSha256);
    expect(second.batches.map((batch) => batch.batchId))
      .toEqual(first.batches.map((batch) => batch.batchId));
  });

  test("serialize/parse 严格校验 exact keys、proxy/cycle 和 semantic hash", () => {
    const plan = planTypedMemoryBatches(input());
    expect(parseTypedMemoryBatchPlan(serializeTypedMemoryBatchPlan(plan))).toEqual(plan);
    expect(() => parseTypedMemoryBatchPlan(JSON.stringify({ ...plan, canonicalTarget: "x" })))
      .toThrow(/key|invalid/i);
    expect(() => parseTypedMemoryBatchPlan(JSON.stringify({
      ...plan,
      semanticPlanSha256: sha256("drift"),
    }))).toThrow(/hash/i);
    expect(() => planTypedMemoryBatches(new Proxy(input(), {}))).toThrow(/proxy|invalid/i);
    const cycle = input() as PlanTypedMemoryBatchesInput & { self?: unknown };
    cycle.self = cycle;
    expect(() => planTypedMemoryBatches(cycle)).toThrow(/cycle|invalid/i);
  });
});
