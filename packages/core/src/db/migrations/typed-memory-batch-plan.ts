import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../../domain/types.js";
import {
  MEMORY_CURATION_BATCH_PLAN_SCHEMA,
  type MemoryCurationBatch,
  type MemoryCurationBatchPlan,
  type MemoryCurationUnit,
} from "./markdown-curation-batch-planner.js";
import {
  parseMarkdownScopeRegistry,
  serializeMarkdownScopeRegistry,
  type MarkdownScopeRegistry,
} from "./markdown-scope-registry.js";

export const TYPED_MEMORY_BATCH_PLAN_SCHEMA =
  "mengshu.typed-memory-batch-plan/v1" as const;
const ELIGIBLE_UNIT_SCHEMA = "mengshu.typed-memory-eligible-unit/v1" as const;
const EXCLUDED_RESOLUTION_SCHEMA = "mengshu.typed-memory-excluded-resolution/v1" as const;
const BATCH_SCHEMA = "mengshu.typed-memory-governance-batch/v1" as const;
const RESOLUTION_SCHEMA = "mengshu.unit-type-resolution/v1" as const;
const CLUSTER_BINDING_SCHEMA = "mengshu.typed-memory-cluster-binding/v1" as const;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const SAFE_REASON = /^[a-z][a-z0-9_]{0,127}$/;
const MAX_UNITS_PER_BATCH = 30;
const MAX_BYTES_PER_BATCH = 400_000;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const SEMANTIC_ORDER: readonly MemorySemanticType[] = [
  "profile", "rules", "task_context", "experience", "resource",
];
const DISPOSITIONS = new Set<TypedMemoryDisposition>([
  "canonical_keep", "merge_exact", "merge_semantic", "supersede", "archive_stale",
  "lookup_only", "quarantine", "distinct_keep",
]);
const ELIGIBLE_DISPOSITIONS = new Set<TypedMemoryDisposition>([
  "canonical_keep", "merge_exact", "merge_semantic", "distinct_keep",
]);

export type TypedMemoryDisposition =
  | "canonical_keep"
  | "merge_exact"
  | "merge_semantic"
  | "supersede"
  | "archive_stale"
  | "lookup_only"
  | "quarantine"
  | "distinct_keep";

export interface TypedMemorySourceBinding {
  sourceRef: string;
  sourceHash: string;
}

export interface TypedMemoryUnitResolutionInput {
  schema: typeof RESOLUTION_SCHEMA;
  unitId: string;
  batchId: string;
  sequence: number;
  scopeFingerprint: string | null;
  sources: TypedMemorySourceBinding[];
  semanticType: MemorySemanticType | null;
  disposition: TypedMemoryDisposition;
  confidence: number | null;
  conflict: boolean;
  resolutionBasis: "quarantine" | "accepted_primary" | "arbitration";
  proposalId: string | null;
  reviewedArtifactHash: string | null;
  reasonCodes: string[];
  candidateOnly: false;
}

export interface TypedMemoryBatchPlanFrozenHashes {
  memoryPlanFileSha256: string;
  memoryPlanSemanticSha256: string;
  unitResolutionsFileSha256: string;
  unitResolutionsSemanticSha256: string;
  mergeSemanticClusterBindingsFileSha256: string;
  mergeSemanticClusterBindingsSemanticSha256: string;
  knowledgeResourceBindingsFileSha256: string;
  scopeRegistryFileSha256: string;
  scopeRegistrySha256: string;
}

export interface TypedMemoryClusterBindingInput {
  readonly schema: typeof CLUSTER_BINDING_SCHEMA;
  readonly clusterKey: string;
  readonly scopeFingerprint: string;
  readonly semanticType: MemorySemanticType;
  readonly memberUnitIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: false;
}

export interface PlanTypedMemoryBatchesInput {
  policyVersion: string;
  createdAt: string;
  expectedMemorySourceCount: number;
  expectedMemoryUnitCount: number;
  frozenHashes: TypedMemoryBatchPlanFrozenHashes;
  scopeRegistry: MarkdownScopeRegistry;
  memoryPlan: MemoryCurationBatchPlan;
  unitResolutions: TypedMemoryUnitResolutionInput[];
  mergeSemanticClusterBindings: readonly TypedMemoryClusterBindingInput[];
}

export interface TypedMemoryEligibleUnit {
  readonly schema: typeof ELIGIBLE_UNIT_SCHEMA;
  readonly unitId: string;
  readonly origin: "p2_resolution" | "typed_plan";
  readonly sourcePlanSequence: number;
  readonly scopeFingerprint: string;
  readonly scope: MemoryScope;
  readonly semanticType: MemorySemanticType;
  readonly disposition: Extract<TypedMemoryDisposition,
    "canonical_keep" | "merge_exact" | "merge_semantic" | "distinct_keep">;
  readonly sources: readonly TypedMemorySourceBinding[];
  readonly sourceCount: number;
  readonly bytes: number;
  readonly governanceClusterId: string | null;
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: true;
}

export interface TypedMemoryExcludedResolution {
  readonly schema: typeof EXCLUDED_RESOLUTION_SCHEMA;
  readonly unitId: string;
  readonly sourcePlanSequence: number;
  readonly scopeFingerprint: string | null;
  readonly semanticType: MemorySemanticType | null;
  readonly disposition: Extract<TypedMemoryDisposition,
    "supersede" | "archive_stale" | "lookup_only" | "quarantine">;
  readonly sources: readonly TypedMemorySourceBinding[];
  readonly sourceCount: number;
  readonly bytes: number;
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: true;
}

export interface TypedMemoryGovernanceBatch {
  readonly schema: typeof BATCH_SCHEMA;
  readonly batchId: string;
  readonly sequence: number;
  readonly scopeFingerprint: string;
  readonly scope: MemoryScope;
  readonly semanticType: MemorySemanticType;
  readonly unitIds: readonly string[];
  readonly governanceClusterIds: readonly string[];
  readonly sourceCount: number;
  readonly bytes: number;
  readonly candidateOnly: true;
}

export interface TypedMemoryBatchPlan {
  readonly schema: typeof TYPED_MEMORY_BATCH_PLAN_SCHEMA;
  readonly migrationRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly frozenHashes: Readonly<TypedMemoryBatchPlanFrozenHashes>;
  readonly expectedMemorySourceCount: number;
  readonly expectedMemoryUnitCount: number;
  readonly maxUnitsPerBatch: 30;
  readonly maxBytesPerBatch: 400000;
  readonly eligibleUnits: readonly TypedMemoryEligibleUnit[];
  readonly excludedResolutions: readonly TypedMemoryExcludedResolution[];
  readonly batches: readonly TypedMemoryGovernanceBatch[];
  readonly summary: Readonly<{
    sourceCount: number;
    unitCount: number;
    eligibleUnits: number;
    eligibleSources: number;
    excludedUnits: number;
    excludedSources: number;
    batchCount: number;
    mergeSemanticClusters: number;
    sourceCoverage: 1;
    unitCoverage: 1;
    excludedByDisposition: Readonly<Record<string, number>>;
    eligibleBySemanticType: Readonly<Record<MemorySemanticType, number>>;
  }>;
  readonly guards: Readonly<{
    candidateOnly: true;
    canonicalTargetsSelected: false;
    formalAssetsWritten: false;
    treeArtifactsWritten: false;
    postgresTouched: false;
    knowledgePrivateBindingsAreInputsOnly: true;
    crossScopeBatchingAllowed: false;
    crossTypeBatchingAllowed: false;
  }>;
  readonly semanticPlanSha256: string;
}

function fail(message: string): never {
  throw new Error(`TYPED_MEMORY_BATCH_PLAN_INVALID: ${message}`);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("proxy or cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("invalid object or cycle");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("invalid canonical value");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0")
    .update(stableJson(value)).digest("hex");
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} invalid shape or proxy`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length ||
      actual.some((key, index) => key !== expected[index])) fail(`${label} exact keys invalid`);
  return value;
}

function exactKeysWithOptional(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} invalid shape or proxy`);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) fail(`${label} exact keys invalid`);
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash invalid`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || value !== value.normalize("NFC") ||
      !SAFE_TEXT.test(value)) fail(`${label} text invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} timestamp invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} integer invalid`);
  }
  return value;
}

function sourceBindings(value: unknown, label: string): TypedMemorySourceBinding[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail(`${label} source coverage invalid`);
  }
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const source = exactKeys(raw, ["sourceRef", "sourceHash"], `${label} source[${index}]`);
    const sourceRef = text(source.sourceRef, `${label} source ref`);
    if (seen.has(sourceRef)) fail(`${label} duplicate source`);
    seen.add(sourceRef);
    return { sourceRef, sourceHash: hash(source.sourceHash, `${label} source`) };
  });
}

function sameSources(
  left: readonly TypedMemorySourceBinding[],
  right: readonly TypedMemorySourceBinding[],
): boolean {
  return left.length === right.length && left.every((source, index) =>
    source.sourceRef === right[index]?.sourceRef && source.sourceHash === right[index]?.sourceHash);
}

function semanticType(value: unknown, allowNull: boolean, label: string): MemorySemanticType | null {
  if (allowNull && value === null) return null;
  if (typeof value !== "string" || !SEMANTIC_TYPES.has(value as MemorySemanticType)) {
    fail(`${label} semantic type invalid`);
  }
  return value as MemorySemanticType;
}

function disposition(value: unknown): TypedMemoryDisposition {
  if (typeof value !== "string" || !DISPOSITIONS.has(value as TypedMemoryDisposition)) {
    fail("resolution disposition enum invalid");
  }
  return value as TypedMemoryDisposition;
}

function validateFrozenHashes(value: unknown): TypedMemoryBatchPlanFrozenHashes {
  const item = exactKeys(value, [
    "memoryPlanFileSha256", "memoryPlanSemanticSha256", "unitResolutionsFileSha256",
    "unitResolutionsSemanticSha256", "mergeSemanticClusterBindingsFileSha256",
    "mergeSemanticClusterBindingsSemanticSha256", "knowledgeResourceBindingsFileSha256",
    "scopeRegistryFileSha256", "scopeRegistrySha256",
  ], "frozen hashes");
  return {
    memoryPlanFileSha256: hash(item.memoryPlanFileSha256, "memory plan file"),
    memoryPlanSemanticSha256: hash(item.memoryPlanSemanticSha256, "memory plan semantic"),
    unitResolutionsFileSha256: hash(item.unitResolutionsFileSha256, "unit resolutions file"),
    unitResolutionsSemanticSha256: hash(
      item.unitResolutionsSemanticSha256,
      "unit resolutions semantic",
    ),
    mergeSemanticClusterBindingsFileSha256: hash(
      item.mergeSemanticClusterBindingsFileSha256,
      "merge semantic cluster bindings file",
    ),
    mergeSemanticClusterBindingsSemanticSha256: hash(
      item.mergeSemanticClusterBindingsSemanticSha256,
      "merge semantic cluster bindings semantic",
    ),
    knowledgeResourceBindingsFileSha256: hash(
      item.knowledgeResourceBindingsFileSha256,
      "knowledge bindings file",
    ),
    scopeRegistryFileSha256: hash(item.scopeRegistryFileSha256, "scope registry file"),
    scopeRegistrySha256: hash(item.scopeRegistrySha256, "scope registry semantic"),
  };
}

function validateScopeRegistry(
  value: unknown,
  frozenHashes: TypedMemoryBatchPlanFrozenHashes,
  plan: MemoryCurationBatchPlan,
): ReadonlyMap<string, MemoryScope> {
  if (!plainRecord(value)) fail("scope registry invalid");
  let registry: MarkdownScopeRegistry;
  try {
    registry = parseMarkdownScopeRegistry(
      serializeMarkdownScopeRegistry(value as unknown as MarkdownScopeRegistry),
    );
  } catch {
    fail("scope registry artifact or fingerprint drift");
  }
  if (registry.registrySha256 !== frozenHashes.scopeRegistrySha256 ||
      registry.migrationRunId !== plan.migrationRunId ||
      registry.sourceManifestFileSha256 !== plan.sourceManifestSha256 ||
      registry.sourceSnapshotSha256 !== plan.sourceSnapshotSha256) {
    fail("scope registry frozen hash or source binding drift");
  }
  const result = new Map<string, MemoryScope>();
  const memorySourcesByScope = new Map<string, number>();
  for (const unit of plan.units) {
    if (!unit.scopeFingerprint) continue;
    memorySourcesByScope.set(
      unit.scopeFingerprint,
      (memorySourcesByScope.get(unit.scopeFingerprint) ?? 0) + unit.sourceCount,
    );
  }
  for (const entry of registry.entries) {
    if (entry.memorySourceCount !== (memorySourcesByScope.get(entry.scopeFingerprint) ?? 0)) {
      fail("scope registry memory source coverage drift");
    }
    result.set(entry.scopeFingerprint, stableValue(entry.scope) as MemoryScope);
  }
  if (registry.summary.memoryScopedSourceCount !==
      [...memorySourcesByScope.values()].reduce((sum, count) => sum + count, 0) ||
      [...memorySourcesByScope.keys()].some((fingerprint) => !result.has(fingerprint))) {
    fail("scope registry memory source coverage or mapping missing");
  }
  return result;
}

function validateOutputScope(value: unknown, fingerprint: unknown, label: string): void {
  const scope = exactKeysWithOptional(value, [
    "tenantId", "appId", "userId", "projectId", "agentId", "namespace", "visibility",
  ], ["workspaceId", "sessionId"], `${label} scope`);
  let actual: string;
  try {
    actual = authorityScopeFingerprint(scope as unknown as MemoryScope);
  } catch {
    fail(`${label} scope descriptor invalid`);
  }
  if (actual !== hash(fingerprint, `${label} scope`)) {
    fail(`${label} scope fingerprint drift`);
  }
}

function validateMemoryPlan(
  value: unknown,
  frozenHashes: TypedMemoryBatchPlanFrozenHashes,
  expectedSources: number,
  expectedUnits: number,
): Readonly<{
  plan: MemoryCurationBatchPlan;
  unitById: ReadonlyMap<string, MemoryCurationUnit>;
  batchByUnit: ReadonlyMap<string, MemoryCurationBatch>;
  orderedBatches: readonly MemoryCurationBatch[];
}> {
  const root = exactKeys(value, [
    "schema", "migrationRunId", "sourceSnapshotSha256", "sourceManifestSha256",
    "preprocessedManifestSha256", "inventorySha256", "policyVersion", "createdAt",
    "maxUnitsPerBatch", "maxBytesPerBatch", "units", "batches", "summary", "guards",
    "planSha256",
  ], "memory plan");
  if (root.schema !== MEMORY_CURATION_BATCH_PLAN_SCHEMA || !Array.isArray(root.units) ||
      !Array.isArray(root.batches) || !Array.isArray(root.guards)) fail("memory plan contract invalid");
  const { planSha256, ...body } = root;
  if (hash(planSha256, "memory plan") !== sha256(stableJson(body)) ||
      planSha256 !== frozenHashes.memoryPlanSemanticSha256) fail("memory plan semantic hash drift");
  const plan = root as unknown as MemoryCurationBatchPlan;
  if (!plainRecord(plan.summary) || plan.units.length !== expectedUnits ||
      plan.summary.unitCount !== expectedUnits || plan.summary.sourceCount !== expectedSources ||
      plan.batches.length !== plan.summary.batchCount) fail("memory plan expected coverage invalid");
  const unitById = new Map<string, MemoryCurationUnit>();
  const globalSources = new Set<string>();
  let actualSources = 0;
  for (const unit of plan.units) {
    const item = exactKeysWithOptional(unit, [
      "unitId", "cohort", "sourceRefs", "sourceHashes", "candidateTypes", "qualityFlags",
      "files", "sourceCount", "bytes",
    ], ["scopeFingerprint"], "memory unit");
    if (unitById.has(unit.unitId) || !SHA256.test(unit.unitId) ||
        !Array.isArray(item.sourceRefs) || !Array.isArray(item.sourceHashes) ||
        !Array.isArray(item.files) || unit.sourceRefs.length !== unit.sourceHashes.length ||
        unit.sourceRefs.length !== unit.files.length || unit.sourceCount !== unit.files.length ||
        !Number.isSafeInteger(unit.bytes) || unit.bytes < 0) fail("memory unit coverage invalid");
    let bytes = 0;
    for (const [index, file] of unit.files.entries()) {
      exactKeys(file, [
        "sourceRef", "sourceHash", "relativePath", "markdownSha256", "bytes",
      ], "memory unit file");
      if (file.sourceRef !== unit.sourceRefs[index] || file.sourceHash !== unit.sourceHashes[index] ||
          !SHA256.test(file.sourceHash) || !SHA256.test(file.markdownSha256) ||
          !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
          globalSources.has(file.sourceRef)) fail("memory unit source hash duplicate or drift");
      globalSources.add(file.sourceRef);
      actualSources += 1;
      bytes += file.bytes;
    }
    if (bytes !== unit.bytes) fail("memory unit byte coverage drift");
    unitById.set(unit.unitId, unit);
  }
  if (actualSources !== expectedSources) fail("memory source coverage invalid");
  const orderedBatches = [...plan.batches].sort((left, right) => left.sequence - right.sequence);
  if (orderedBatches.length < 35 || orderedBatches.length > 91 ||
      orderedBatches.some((batch, index) => batch.sequence !== index + 1)) {
    fail("memory plan sequence coverage invalid");
  }
  const batchByUnit = new Map<string, MemoryCurationBatch>();
  for (const batch of orderedBatches) {
    exactKeysWithOptional(batch, [
      "batchId", "sequence", "cohort", "mode", "unitIds", "sourceCount", "bytes",
    ], ["scopeFingerprint"], "memory batch");
    if (!SHA256.test(batch.batchId) || !Array.isArray(batch.unitIds) ||
        batch.unitIds.length === 0 || new Set(batch.unitIds).size !== batch.unitIds.length) {
      fail("memory batch contract invalid");
    }
    let sources = 0;
    let bytes = 0;
    for (const unitId of batch.unitIds) {
      const unit = unitById.get(unitId);
      if (!unit || batchByUnit.has(unitId) || unit.cohort !== batch.cohort ||
          (unit.scopeFingerprint ?? null) !== (batch.scopeFingerprint ?? null)) {
        fail("memory batch unit scope coverage invalid");
      }
      batchByUnit.set(unitId, batch);
      sources += unit.sourceCount;
      bytes += unit.bytes;
    }
    if (sources !== batch.sourceCount || bytes !== batch.bytes) {
      fail("memory batch source byte coverage drift");
    }
  }
  if (batchByUnit.size !== unitById.size) fail("memory unit batch coverage invalid");
  return Object.freeze({ plan, unitById, batchByUnit, orderedBatches });
}

function parseResolution(value: unknown): TypedMemoryUnitResolutionInput {
  const item = exactKeys(value, [
    "schema", "unitId", "batchId", "sequence", "scopeFingerprint", "sources",
    "semanticType", "disposition", "confidence", "conflict", "resolutionBasis",
    "proposalId", "reviewedArtifactHash", "reasonCodes", "candidateOnly",
  ], "P2 resolution");
  if (item.schema !== RESOLUTION_SCHEMA || item.candidateOnly !== false ||
      typeof item.conflict !== "boolean" ||
      !["quarantine", "accepted_primary", "arbitration"].includes(String(item.resolutionBasis)) ||
      !Array.isArray(item.reasonCodes) || item.reasonCodes.length === 0 ||
      item.reasonCodes.some((reason) => typeof reason !== "string" || !SAFE_REASON.test(reason))) {
    fail("P2 resolution contract invalid");
  }
  const confidence = item.confidence;
  if (confidence !== null && (typeof confidence !== "number" || !Number.isFinite(confidence) ||
      confidence < 0 || confidence > 1)) fail("P2 resolution confidence invalid");
  if (item.scopeFingerprint !== null) hash(item.scopeFingerprint, "P2 scope");
  if (item.reviewedArtifactHash !== null) hash(item.reviewedArtifactHash, "P2 artifact");
  if (item.proposalId !== null) text(item.proposalId, "P2 proposal");
  return {
    schema: RESOLUTION_SCHEMA,
    unitId: hash(item.unitId, "P2 unit"),
    batchId: hash(item.batchId, "P2 batch"),
    sequence: nonNegativeInteger(item.sequence, "P2 sequence"),
    scopeFingerprint: item.scopeFingerprint as string | null,
    sources: sourceBindings(item.sources, "P2 resolution"),
    semanticType: semanticType(item.semanticType, true, "P2"),
    disposition: disposition(item.disposition),
    confidence: confidence as number | null,
    conflict: item.conflict,
    resolutionBasis: item.resolutionBasis as TypedMemoryUnitResolutionInput["resolutionBasis"],
    proposalId: item.proposalId as string | null,
    reviewedArtifactHash: item.reviewedArtifactHash as string | null,
    reasonCodes: [...item.reasonCodes] as string[],
    candidateOnly: false,
  };
}

function resolutionSemanticHash(records: readonly TypedMemoryUnitResolutionInput[]): string {
  return canonicalHash(
    "mengshu.typed-memory-unit-resolutions/semantic/v1",
    [...records].sort((left, right) => left.unitId.localeCompare(right.unitId)),
  );
}

export function typedMemoryUnitResolutionsSemanticSha256(
  records: readonly unknown[],
): string {
  if (!Array.isArray(records) || nodeUtilTypes.isProxy(records)) {
    fail("P2 resolutions invalid");
  }
  return resolutionSemanticHash(records.map(parseResolution));
}

function parseClusterBinding(value: unknown): TypedMemoryClusterBindingInput {
  const item = exactKeys(value, [
    "schema", "clusterKey", "scopeFingerprint", "semanticType", "memberUnitIds",
    "reasonCodes", "candidateOnly",
  ], "merge semantic cluster binding");
  if (item.schema !== CLUSTER_BINDING_SCHEMA || item.candidateOnly !== false ||
      typeof item.clusterKey !== "string" || !SAFE_REASON.test(item.clusterKey) ||
      !Array.isArray(item.memberUnitIds) || nodeUtilTypes.isProxy(item.memberUnitIds) ||
      item.memberUnitIds.length < 2 ||
      !Array.isArray(item.reasonCodes) || nodeUtilTypes.isProxy(item.reasonCodes) ||
      item.reasonCodes.length === 0) {
    fail("merge semantic cluster binding contract invalid");
  }
  const memberUnitIds = item.memberUnitIds.map((unitId) =>
    hash(unitId, "merge semantic cluster member"));
  const reasonCodes = item.reasonCodes.map((reason) => {
    if (typeof reason !== "string" || !SAFE_REASON.test(reason)) {
      fail("merge semantic cluster reason invalid");
    }
    return reason;
  });
  if (new Set(memberUnitIds).size !== memberUnitIds.length ||
      memberUnitIds.some((unitId, index) => index > 0 &&
        memberUnitIds[index - 1]!.localeCompare(unitId) >= 0) ||
      new Set(reasonCodes).size !== reasonCodes.length ||
      reasonCodes.some((reason, index) => index > 0 &&
        reasonCodes[index - 1]!.localeCompare(reason) >= 0)) {
    fail("merge semantic cluster member or reason ordering invalid");
  }
  return {
    schema: CLUSTER_BINDING_SCHEMA,
    clusterKey: item.clusterKey,
    scopeFingerprint: hash(item.scopeFingerprint, "merge semantic cluster scope"),
    semanticType: semanticType(item.semanticType, false, "merge semantic cluster")!,
    memberUnitIds,
    reasonCodes,
    candidateOnly: false,
  };
}

export function typedMemoryClusterBindingsSemanticSha256(
  bindings: readonly unknown[],
): string {
  if (!Array.isArray(bindings) || nodeUtilTypes.isProxy(bindings)) {
    fail("merge semantic cluster bindings invalid");
  }
  const parsed = bindings.map(parseClusterBinding).sort((left, right) =>
    left.clusterKey.localeCompare(right.clusterKey));
  if (new Set(parsed.map((binding) => binding.clusterKey)).size !== parsed.length) {
    fail("merge semantic cluster key duplicated");
  }
  return canonicalHash("mengshu.typed-memory-cluster-bindings/semantic/v1", parsed);
}

interface MutableEligibleUnit extends Omit<TypedMemoryEligibleUnit, "governanceClusterId"> {
  governanceClusterId: string | null;
}

function planSemanticBody(plan: Omit<TypedMemoryBatchPlan, "semanticPlanSha256">): unknown {
  const { createdAt: ignored, ...body } = plan;
  return body;
}

export function planTypedMemoryBatches(
  input: PlanTypedMemoryBatchesInput,
): TypedMemoryBatchPlan {
  stableValue(input);
  const root = exactKeys(input, [
    "policyVersion", "createdAt", "expectedMemorySourceCount", "expectedMemoryUnitCount",
    "frozenHashes", "scopeRegistry", "memoryPlan", "unitResolutions",
    "mergeSemanticClusterBindings",
  ], "planner input");
  if (!Array.isArray(root.unitResolutions) || nodeUtilTypes.isProxy(root.unitResolutions)) {
    fail("P2 resolutions invalid");
  }
  if (!Array.isArray(root.mergeSemanticClusterBindings) ||
      nodeUtilTypes.isProxy(root.mergeSemanticClusterBindings)) {
    fail("merge semantic cluster bindings invalid");
  }
  const policyVersion = text(root.policyVersion, "policy version");
  const createdAt = iso(root.createdAt, "createdAt");
  const expectedSources = nonNegativeInteger(root.expectedMemorySourceCount, "expected sources");
  const expectedUnits = nonNegativeInteger(root.expectedMemoryUnitCount, "expected units");
  const frozenHashes = validateFrozenHashes(root.frozenHashes);
  const validated = validateMemoryPlan(
    root.memoryPlan,
    frozenHashes,
    expectedSources,
    expectedUnits,
  );
  const scopeByFingerprint = validateScopeRegistry(
    root.scopeRegistry,
    frozenHashes,
    validated.plan,
  );
  const resolutions = root.unitResolutions.map(parseResolution);
  if (typedMemoryUnitResolutionsSemanticSha256(resolutions) !==
      frozenHashes.unitResolutionsSemanticSha256) {
    fail("P2 resolution semantic hash drift");
  }
  const clusterBindings = root.mergeSemanticClusterBindings.map(parseClusterBinding)
    .sort((left, right) => left.clusterKey.localeCompare(right.clusterKey));
  if (typedMemoryClusterBindingsSemanticSha256(clusterBindings) !==
      frozenHashes.mergeSemanticClusterBindingsSemanticSha256) {
    fail("merge semantic cluster bindings semantic hash drift");
  }
  const p2Batches = validated.orderedBatches.filter((batch) => batch.sequence <= 34);
  const typedBatches = validated.orderedBatches.filter((batch) => batch.sequence >= 35);
  if (p2Batches.length !== 34 || p2Batches.some((batch, index) => batch.sequence !== index + 1)) {
    fail("P2 batch sequence coverage invalid");
  }
  const p2UnitIds = new Set(p2Batches.flatMap((batch) => batch.unitIds));
  const resolutionByUnit = new Map<string, TypedMemoryUnitResolutionInput>();
  for (const resolution of resolutions) {
    if (resolutionByUnit.has(resolution.unitId)) fail("P2 duplicate resolution unit coverage");
    resolutionByUnit.set(resolution.unitId, resolution);
  }
  if (resolutionByUnit.size !== p2UnitIds.size ||
      [...p2UnitIds].some((unitId) => !resolutionByUnit.has(unitId)) ||
      [...resolutionByUnit.keys()].some((unitId) => !p2UnitIds.has(unitId))) {
    fail("P2 resolution coverage missing or extra");
  }

  const eligible: MutableEligibleUnit[] = [];
  const excluded: TypedMemoryExcludedResolution[] = [];
  for (const batch of p2Batches) {
    for (const unitId of batch.unitIds) {
      const unit = validated.unitById.get(unitId)!;
      const resolution = resolutionByUnit.get(unitId)!;
      const planSources = unit.sourceRefs.map((sourceRef, index) => ({
        sourceRef,
        sourceHash: unit.sourceHashes[index]!,
      }));
      if (resolution.batchId !== batch.batchId || resolution.sequence !== batch.sequence ||
          resolution.scopeFingerprint !== (unit.scopeFingerprint ?? null) ||
          !sameSources(resolution.sources, planSources)) {
        fail("P2 resolution source scope batch hash drift");
      }
      if (ELIGIBLE_DISPOSITIONS.has(resolution.disposition)) {
        if (!resolution.scopeFingerprint || !resolution.semanticType) {
          fail("eligible P2 resolution missing scope or semantic type");
        }
        eligible.push({
          schema: ELIGIBLE_UNIT_SCHEMA,
          unitId,
          origin: "p2_resolution",
          sourcePlanSequence: batch.sequence,
          scopeFingerprint: resolution.scopeFingerprint,
          scope: scopeByFingerprint.get(resolution.scopeFingerprint) ??
            fail("eligible scope registry mapping missing"),
          semanticType: resolution.semanticType,
          disposition: resolution.disposition as TypedMemoryEligibleUnit["disposition"],
          sources: planSources,
          sourceCount: unit.sourceCount,
          bytes: unit.bytes,
          governanceClusterId: null,
          reasonCodes: [...resolution.reasonCodes],
          candidateOnly: true,
        });
      } else {
        excluded.push({
          schema: EXCLUDED_RESOLUTION_SCHEMA,
          unitId,
          sourcePlanSequence: batch.sequence,
          scopeFingerprint: resolution.scopeFingerprint,
          semanticType: resolution.semanticType,
          disposition: resolution.disposition as TypedMemoryExcludedResolution["disposition"],
          sources: planSources,
          sourceCount: unit.sourceCount,
          bytes: unit.bytes,
          reasonCodes: [...resolution.reasonCodes],
          candidateOnly: true,
        });
      }
    }
  }

  for (const batch of typedBatches) {
    const validMode = batch.mode === "memory_document_proposal" ||
      batch.cohort === "resource" && batch.mode === "resource_deferred";
    if (!validMode || !SEMANTIC_TYPES.has(batch.cohort as MemorySemanticType) ||
        !batch.scopeFingerprint) {
      fail("original typed batch mode or cohort invalid");
    }
    const type = batch.cohort as MemorySemanticType;
    for (const unitId of batch.unitIds) {
      const unit = validated.unitById.get(unitId)!;
      if (unit.cohort !== type || unit.scopeFingerprint !== batch.scopeFingerprint ||
          unit.candidateTypes.length !== 1 || unit.candidateTypes[0] !== type) {
        fail("original typed unit cohort type scope drift");
      }
      eligible.push({
        schema: ELIGIBLE_UNIT_SCHEMA,
        unitId,
        origin: "typed_plan",
        sourcePlanSequence: batch.sequence,
        scopeFingerprint: batch.scopeFingerprint,
        scope: scopeByFingerprint.get(batch.scopeFingerprint) ??
          fail("eligible scope registry mapping missing"),
        semanticType: type,
        disposition: "merge_exact",
        sources: unit.sourceRefs.map((sourceRef, index) => ({
          sourceRef,
          sourceHash: unit.sourceHashes[index]!,
        })),
        sourceCount: unit.sourceCount,
        bytes: unit.bytes,
        governanceClusterId: null,
        reasonCodes: ["original_typed_exact_unit"],
        candidateOnly: true,
      });
    }
  }
  eligible.sort((left, right) => left.scopeFingerprint.localeCompare(right.scopeFingerprint) ||
    SEMANTIC_ORDER.indexOf(left.semanticType) - SEMANTIC_ORDER.indexOf(right.semanticType) ||
    left.unitId.localeCompare(right.unitId));
  excluded.sort((left, right) => left.sourcePlanSequence - right.sourcePlanSequence ||
    left.unitId.localeCompare(right.unitId));

  const eligibleById = new Map(eligible.map((unit) => [unit.unitId, unit] as const));
  const clusteredUnitIds = new Set<string>();
  for (const binding of clusterBindings) {
    const units = binding.memberUnitIds.map((unitId) =>
      eligibleById.get(unitId) ?? fail("merge semantic cluster member missing or excluded"));
    if (units.some((unit) => unit.scopeFingerprint !== binding.scopeFingerprint ||
        unit.semanticType !== binding.semanticType) ||
        !units.some((unit) => unit.disposition === "merge_semantic") ||
        units.some((unit) => clusteredUnitIds.has(unit.unitId))) {
      fail("merge semantic cluster scope type disposition or uniqueness invalid");
    }
    const clusterId = canonicalHash("mengshu.typed-memory-governance-cluster/v1", {
      frozenHashes,
      binding,
      scope: units[0]!.scope,
      sources: units.flatMap((unit) => unit.sources)
        .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)),
    });
    for (const unit of units) {
      clusteredUnitIds.add(unit.unitId);
      unit.governanceClusterId = clusterId;
    }
  }
  const mergeSemanticUnitIds = eligible
    .filter((unit) => unit.disposition === "merge_semantic")
    .map((unit) => unit.unitId);
  if (mergeSemanticUnitIds.some((unitId) => !clusteredUnitIds.has(unitId)) ||
      clusterBindings.length === 0 && mergeSemanticUnitIds.length > 0) {
    fail("merge semantic unit missing explicit cluster binding");
  }

  interface Block {
    key: string;
    units: MutableEligibleUnit[];
    sourceCount: number;
    bytes: number;
  }
  const partitions = new Map<string, MutableEligibleUnit[]>();
  for (const unit of eligible) {
    const key = `${unit.scopeFingerprint}\0${unit.semanticType}`;
    const values = partitions.get(key) ?? [];
    values.push(unit);
    partitions.set(key, values);
  }
  const pending: Array<Omit<TypedMemoryGovernanceBatch, "batchId" | "sequence">> = [];
  for (const partitionKey of [...partitions.keys()].sort()) {
    const units = partitions.get(partitionKey)!;
    const clusterBlocks = new Map<string, MutableEligibleUnit[]>();
    const blocks: Block[] = [];
    for (const unit of units) {
      if (unit.governanceClusterId) {
        const values = clusterBlocks.get(unit.governanceClusterId) ?? [];
        values.push(unit);
        clusterBlocks.set(unit.governanceClusterId, values);
      } else {
        blocks.push({
          key: unit.unitId,
          units: [unit],
          sourceCount: unit.sourceCount,
          bytes: unit.bytes,
        });
      }
    }
    for (const [clusterId, clusterUnits] of clusterBlocks) {
      blocks.push({
        key: clusterId,
        units: clusterUnits,
        sourceCount: clusterUnits.reduce((sum, unit) => sum + unit.sourceCount, 0),
        bytes: clusterUnits.reduce((sum, unit) => sum + unit.bytes, 0),
      });
    }
    blocks.sort((left, right) => left.key.localeCompare(right.key));
    let current: MutableEligibleUnit[] = [];
    let currentSources = 0;
    let currentBytes = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      pending.push({
        schema: BATCH_SCHEMA,
        scopeFingerprint: current[0]!.scopeFingerprint,
        scope: current[0]!.scope,
        semanticType: current[0]!.semanticType,
        unitIds: current.map((unit) => unit.unitId),
        governanceClusterIds: [...new Set(current.map((unit) => unit.governanceClusterId)
          .filter((value): value is string => value !== null))].sort(),
        sourceCount: currentSources,
        bytes: currentBytes,
        candidateOnly: true,
      });
      current = [];
      currentSources = 0;
      currentBytes = 0;
    };
    for (const block of blocks) {
      if (block.units.length > MAX_UNITS_PER_BATCH || block.bytes > MAX_BYTES_PER_BATCH) {
        fail("merge_semantic governance cluster oversize 30/400000");
      }
      if (current.length > 0 && (current.length + block.units.length > MAX_UNITS_PER_BATCH ||
          currentBytes + block.bytes > MAX_BYTES_PER_BATCH)) flush();
      current.push(...block.units);
      currentSources += block.sourceCount;
      currentBytes += block.bytes;
    }
    flush();
  }
  const batches: TypedMemoryGovernanceBatch[] = pending.map((batch, index) => ({
    ...batch,
    sequence: index + 1,
    batchId: canonicalHash("mengshu.typed-memory-governance-batch/v1", {
      frozenHashes,
      scopeFingerprint: batch.scopeFingerprint,
      scope: batch.scope,
      semanticType: batch.semanticType,
      sources: batch.unitIds.flatMap((unitId) =>
        eligibleById.get(unitId)!.sources).sort((left, right) =>
        left.sourceRef.localeCompare(right.sourceRef)),
    }),
  }));
  const assigned = batches.flatMap((batch) => batch.unitIds);
  if (assigned.length !== eligible.length || new Set(assigned).size !== eligible.length) {
    fail("eligible unit batch coverage invalid");
  }
  const eligibleSources = eligible.reduce((sum, unit) => sum + unit.sourceCount, 0);
  const excludedSources = excluded.reduce((sum, unit) => sum + unit.sourceCount, 0);
  if (eligible.length + excluded.length !== expectedUnits ||
      eligibleSources + excludedSources !== expectedSources) {
    fail("final source unit coverage invalid");
  }
  const excludedByDisposition: Record<string, number> = {
    supersede: 0, archive_stale: 0, lookup_only: 0, quarantine: 0,
  };
  for (const unit of excluded) {
    excludedByDisposition[unit.disposition] =
      (excludedByDisposition[unit.disposition] ?? 0) + unit.sourceCount;
  }
  const eligibleBySemanticType = Object.fromEntries(SEMANTIC_ORDER.map((type) => [type, 0])) as
    Record<MemorySemanticType, number>;
  for (const unit of eligible) eligibleBySemanticType[unit.semanticType] += unit.sourceCount;
  const summary = {
    sourceCount: expectedSources,
    unitCount: expectedUnits,
    eligibleUnits: eligible.length,
    eligibleSources,
    excludedUnits: excluded.length,
    excludedSources,
    batchCount: batches.length,
    mergeSemanticClusters: clusterBindings.length,
    sourceCoverage: 1 as const,
    unitCoverage: 1 as const,
    excludedByDisposition,
    eligibleBySemanticType,
  };
  const guards = {
    candidateOnly: true as const,
    canonicalTargetsSelected: false as const,
    formalAssetsWritten: false as const,
    treeArtifactsWritten: false as const,
    postgresTouched: false as const,
    knowledgePrivateBindingsAreInputsOnly: true as const,
    crossScopeBatchingAllowed: false as const,
    crossTypeBatchingAllowed: false as const,
  };
  const body: Omit<TypedMemoryBatchPlan, "semanticPlanSha256"> = {
    schema: TYPED_MEMORY_BATCH_PLAN_SCHEMA,
    migrationRunId: validated.plan.migrationRunId,
    policyVersion,
    createdAt,
    frozenHashes,
    expectedMemorySourceCount: expectedSources,
    expectedMemoryUnitCount: expectedUnits,
    maxUnitsPerBatch: MAX_UNITS_PER_BATCH,
    maxBytesPerBatch: MAX_BYTES_PER_BATCH,
    eligibleUnits: eligible,
    excludedResolutions: excluded,
    batches,
    summary,
    guards,
  };
  return stableValue({
    ...body,
    semanticPlanSha256: canonicalHash(
      "mengshu.typed-memory-batch-plan/semantic/v1",
      planSemanticBody(body),
    ),
  }) as TypedMemoryBatchPlan;
}

function validateParsedPlan(value: unknown): TypedMemoryBatchPlan {
  const root = exactKeys(value, [
    "schema", "migrationRunId", "policyVersion", "createdAt", "frozenHashes",
    "expectedMemorySourceCount", "expectedMemoryUnitCount", "maxUnitsPerBatch",
    "maxBytesPerBatch", "eligibleUnits", "excludedResolutions", "batches", "summary",
    "guards", "semanticPlanSha256",
  ], "typed Memory plan");
  if (root.schema !== TYPED_MEMORY_BATCH_PLAN_SCHEMA || !Array.isArray(root.eligibleUnits) ||
      !Array.isArray(root.excludedResolutions) || !Array.isArray(root.batches) ||
      root.maxUnitsPerBatch !== MAX_UNITS_PER_BATCH || root.maxBytesPerBatch !== MAX_BYTES_PER_BATCH) {
    fail("typed Memory plan contract invalid");
  }
  validateFrozenHashes(root.frozenHashes);
  iso(root.createdAt, "typed Memory plan");
  hash(root.semanticPlanSha256, "typed Memory semantic plan");
  for (const unit of root.eligibleUnits) {
    const item = exactKeys(unit, [
      "schema", "unitId", "origin", "sourcePlanSequence", "scopeFingerprint", "semanticType",
      "scope", "disposition", "sources", "sourceCount", "bytes", "governanceClusterId",
      "reasonCodes", "candidateOnly",
    ], "eligible unit");
    validateOutputScope(item.scope, item.scopeFingerprint, "eligible unit");
  }
  for (const unit of root.excludedResolutions) {
    exactKeys(unit, [
      "schema", "unitId", "sourcePlanSequence", "scopeFingerprint", "semanticType",
      "disposition", "sources", "sourceCount", "bytes", "reasonCodes", "candidateOnly",
    ], "excluded resolution");
  }
  for (const batch of root.batches) {
    const item = exactKeys(batch, [
      "schema", "batchId", "sequence", "scopeFingerprint", "semanticType", "unitIds",
      "scope", "governanceClusterIds", "sourceCount", "bytes", "candidateOnly",
    ], "typed batch");
    validateOutputScope(item.scope, item.scopeFingerprint, "typed batch");
  }
  const plan = root as unknown as TypedMemoryBatchPlan;
  const { semanticPlanSha256, ...body } = plan;
  if (semanticPlanSha256 !== canonicalHash(
    "mengshu.typed-memory-batch-plan/semantic/v1",
    planSemanticBody(body),
  )) fail("typed Memory semantic plan hash drift");
  return stableValue(plan) as TypedMemoryBatchPlan;
}

export function serializeTypedMemoryBatchPlan(plan: TypedMemoryBatchPlan): string {
  return canonicalJson(validateParsedPlan(plan));
}

export function parseTypedMemoryBatchPlan(serialized: string): TypedMemoryBatchPlan {
  if (typeof serialized !== "string") fail("serialized typed Memory plan invalid");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("serialized typed Memory plan invalid");
  }
  return validateParsedPlan(value);
}
