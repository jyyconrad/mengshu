import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemorySemanticType } from "../../domain/types.js";
import type {
  MarkdownPreprocessGroup,
  MarkdownPreprocessNode,
} from "./markdown-workset-preprocessor.js";

export const MEMORY_CURATION_BATCH_PLAN_SCHEMA =
  "mengshu.memory-curation-batch-plan/v1" as const;

export type MemoryCurationCohort =
  | "quarantine"
  | "untyped"
  | "type_conflict"
  | MemorySemanticType;

export type MemoryCurationBatchMode =
  | "exclude"
  | "type_review"
  | "memory_document_proposal"
  | "resource_deferred";

export interface MemoryCurationPlannerFile {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly relativePath: string;
  readonly markdownSha256: string;
  readonly bytes: number;
}

export interface MemoryCurationUnit {
  readonly unitId: string;
  readonly cohort: MemoryCurationCohort;
  readonly scopeFingerprint?: string;
  readonly sourceRefs: readonly string[];
  readonly sourceHashes: readonly string[];
  readonly candidateTypes: readonly MemorySemanticType[];
  readonly qualityFlags: readonly string[];
  readonly files: readonly MemoryCurationPlannerFile[];
  readonly sourceCount: number;
  readonly bytes: number;
}

export interface MemoryCurationBatch {
  readonly batchId: string;
  readonly sequence: number;
  readonly cohort: MemoryCurationCohort;
  readonly mode: MemoryCurationBatchMode;
  readonly scopeFingerprint?: string;
  readonly unitIds: readonly string[];
  readonly sourceCount: number;
  readonly bytes: number;
}

export interface MemoryCurationBatchPlan {
  readonly schema: typeof MEMORY_CURATION_BATCH_PLAN_SCHEMA;
  readonly migrationRunId: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceManifestSha256: string;
  readonly preprocessedManifestSha256: string;
  readonly inventorySha256: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly maxUnitsPerBatch: number;
  readonly maxBytesPerBatch: number;
  readonly units: readonly MemoryCurationUnit[];
  readonly batches: readonly MemoryCurationBatch[];
  readonly summary: Readonly<{
    sourceCount: number;
    unitCount: number;
    batchCount: number;
    byCohort: Readonly<Partial<Record<MemoryCurationCohort, Readonly<{
      units: number;
      sources: number;
    }>>>>;
  }>;
  readonly guards: readonly string[];
  readonly planSha256: string;
}

export interface PlanMemoryCurationBatchesInput {
  readonly migrationRunId: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceManifestSha256: string;
  readonly preprocessedManifestSha256: string;
  readonly inventorySha256: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly nodes: readonly MarkdownPreprocessNode[];
  readonly groups: readonly MarkdownPreprocessGroup[];
  readonly files: readonly MemoryCurationPlannerFile[];
  readonly maxUnitsPerBatch: number;
  readonly maxBytesPerBatch: number;
}

export type MemoryCurationBatchPlannerErrorCode =
  | "MEMORY_CURATION_BATCH_PLAN_INVALID_INPUT"
  | "MEMORY_CURATION_BATCH_PLAN_SCOPE_VIOLATION"
  | "MEMORY_CURATION_BATCH_PLAN_DUPLICATE_SOURCE"
  | "MEMORY_CURATION_BATCH_PLAN_COVERAGE_VIOLATION";

const MESSAGES: Record<MemoryCurationBatchPlannerErrorCode, string> = {
  MEMORY_CURATION_BATCH_PLAN_INVALID_INPUT: "Memory curation batch plan input is invalid",
  MEMORY_CURATION_BATCH_PLAN_SCOPE_VIOLATION: "Memory curation exact unit crosses scope",
  MEMORY_CURATION_BATCH_PLAN_DUPLICATE_SOURCE: "Memory curation source is assigned more than once",
  MEMORY_CURATION_BATCH_PLAN_COVERAGE_VIOLATION: "Memory curation source coverage is incomplete",
};

export class MemoryCurationBatchPlannerError extends Error {
  constructor(readonly code: MemoryCurationBatchPlannerErrorCode) {
    super(MESSAGES[code]);
    this.name = "MemoryCurationBatchPlannerError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const COHORT_ORDER: readonly MemoryCurationCohort[] = [
  "quarantine", "untyped", "type_conflict", "profile", "rules",
  "task_context", "experience", "resource",
];

function fail(code: MemoryCurationBatchPlannerErrorCode): never {
  throw new MemoryCurationBatchPlannerError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function validateInput(input: PlanMemoryCurationBatchesInput): void {
  if (!plainRecord(input) || !SAFE_TEXT.test(input.migrationRunId) ||
      !SHA256.test(input.sourceSnapshotSha256) || !SHA256.test(input.sourceManifestSha256) ||
      !SHA256.test(input.preprocessedManifestSha256) || !SHA256.test(input.inventorySha256) ||
      !SAFE_TEXT.test(input.policyVersion) || !Number.isFinite(Date.parse(input.createdAt)) ||
      new Date(input.createdAt).toISOString() !== input.createdAt ||
      !Array.isArray(input.nodes) || nodeUtilTypes.isProxy(input.nodes) ||
      !Array.isArray(input.groups) || nodeUtilTypes.isProxy(input.groups) ||
      !Array.isArray(input.files) || nodeUtilTypes.isProxy(input.files) ||
      !Number.isSafeInteger(input.maxUnitsPerBatch) || input.maxUnitsPerBatch < 1 ||
      !Number.isSafeInteger(input.maxBytesPerBatch) || input.maxBytesPerBatch < 1) {
    fail("MEMORY_CURATION_BATCH_PLAN_INVALID_INPUT");
  }
}

function candidateTypes(nodes: readonly MarkdownPreprocessNode[]): readonly MemorySemanticType[] {
  const types = new Set<MemorySemanticType>();
  for (const node of nodes) {
    for (const candidate of node.semanticTypeCandidates) {
      if (candidate.confidence >= 0.7 && SEMANTIC_TYPES.has(candidate.semanticType)) {
        types.add(candidate.semanticType);
      }
    }
  }
  return Object.freeze([...types].sort());
}

function cohort(
  nodes: readonly MarkdownPreprocessNode[],
  types: readonly MemorySemanticType[],
): MemoryCurationCohort {
  if (nodes.some((node) => !node.scopeFingerprint ||
      node.qualityFlags.includes("legacy_quarantine") ||
      node.qualityFlags.includes("missing_scope"))) return "quarantine";
  if (types.length === 0) return "untyped";
  if (types.length > 1) return "type_conflict";
  return types[0]!;
}

function batchMode(value: MemoryCurationCohort): MemoryCurationBatchMode {
  if (value === "quarantine") return "exclude";
  if (value === "untyped" || value === "type_conflict") return "type_review";
  if (value === "resource") return "resource_deferred";
  return "memory_document_proposal";
}

function createUnit(
  members: readonly MarkdownPreprocessNode[],
  fileBySource: ReadonlyMap<string, MemoryCurationPlannerFile>,
): MemoryCurationUnit {
  const sorted = [...members].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const scopes = new Set(sorted.map((node) => node.scopeFingerprint ?? "missing"));
  if (scopes.size !== 1) fail("MEMORY_CURATION_BATCH_PLAN_SCOPE_VIOLATION");
  const files = sorted.map((node) => {
    const file = fileBySource.get(node.sourceRef);
    if (!file || file.sourceHash !== node.sourceHash) {
      fail("MEMORY_CURATION_BATCH_PLAN_COVERAGE_VIOLATION");
    }
    return file;
  });
  const types = candidateTypes(sorted);
  const selectedCohort = cohort(sorted, types);
  const sourceRefs = Object.freeze(sorted.map((node) => node.sourceRef));
  const sourceHashes = Object.freeze(sorted.map((node) => node.sourceHash));
  const qualityFlags = Object.freeze([...new Set(sorted.flatMap((node) => node.qualityFlags))].sort());
  const unitId = sha256(sourceRefs.map((sourceRef, index) =>
    `${sourceRef}\u001f${sourceHashes[index]}`).join("\u001e"));
  return Object.freeze({
    unitId,
    cohort: selectedCohort,
    ...(sorted[0]?.scopeFingerprint ? { scopeFingerprint: sorted[0].scopeFingerprint } : {}),
    sourceRefs,
    sourceHashes,
    candidateTypes: types,
    qualityFlags,
    files: Object.freeze(files),
    sourceCount: sorted.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
  });
}

function createUnits(
  nodes: readonly MarkdownPreprocessNode[],
  groups: readonly MarkdownPreprocessGroup[],
  files: readonly MemoryCurationPlannerFile[],
): readonly MemoryCurationUnit[] {
  const memoryNodes = nodes.filter((node) => node.sourceTable === "memories");
  const nodeBySource = new Map(memoryNodes.map((node) => [node.sourceRef, node] as const));
  if (nodeBySource.size !== memoryNodes.length) fail("MEMORY_CURATION_BATCH_PLAN_DUPLICATE_SOURCE");
  const fileBySource = new Map<string, MemoryCurationPlannerFile>();
  for (const file of files) {
    if (!plainRecord(file) || !SAFE_TEXT.test(file.sourceRef) || !SHA256.test(file.sourceHash) ||
        !SAFE_TEXT.test(file.relativePath) || !SHA256.test(file.markdownSha256) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || fileBySource.has(file.sourceRef)) {
      fail("MEMORY_CURATION_BATCH_PLAN_INVALID_INPUT");
    }
    fileBySource.set(file.sourceRef, file);
  }
  if (fileBySource.size !== memoryNodes.length ||
      [...fileBySource.keys()].some((sourceRef) => !nodeBySource.has(sourceRef))) {
    fail("MEMORY_CURATION_BATCH_PLAN_COVERAGE_VIOLATION");
  }
  const assigned = new Set<string>();
  const units: MemoryCurationUnit[] = [];
  for (const group of groups.filter((value) => value.kind === "exact_content")) {
    const memberNodes = group.members.map((sourceRef) => nodeBySource.get(sourceRef)).filter(
      (node): node is MarkdownPreprocessNode => node !== undefined,
    );
    if (memberNodes.length === 0) continue;
    if (memberNodes.length !== group.members.length) {
      fail("MEMORY_CURATION_BATCH_PLAN_SCOPE_VIOLATION");
    }
    if (group.members.some((sourceRef) => assigned.has(sourceRef))) {
      fail("MEMORY_CURATION_BATCH_PLAN_DUPLICATE_SOURCE");
    }
    group.members.forEach((sourceRef) => assigned.add(sourceRef));
    units.push(createUnit(memberNodes, fileBySource));
  }
  for (const node of memoryNodes) {
    if (assigned.has(node.sourceRef)) continue;
    assigned.add(node.sourceRef);
    units.push(createUnit([node], fileBySource));
  }
  if (assigned.size !== memoryNodes.length) fail("MEMORY_CURATION_BATCH_PLAN_COVERAGE_VIOLATION");
  return Object.freeze(units.sort((left, right) =>
    COHORT_ORDER.indexOf(left.cohort) - COHORT_ORDER.indexOf(right.cohort) ||
      (left.scopeFingerprint ?? "").localeCompare(right.scopeFingerprint ?? "") ||
      left.unitId.localeCompare(right.unitId)));
}

function createBatches(
  units: readonly MemoryCurationUnit[],
  maxUnits: number,
  maxBytes: number,
): readonly MemoryCurationBatch[] {
  const grouped = new Map<string, MemoryCurationUnit[]>();
  for (const unit of units) {
    const key = `${COHORT_ORDER.indexOf(unit.cohort)}:${unit.cohort}:${unit.scopeFingerprint ?? "missing"}`;
    const current = grouped.get(key) ?? [];
    current.push(unit);
    grouped.set(key, current);
  }
  const pending: Array<Omit<MemoryCurationBatch, "batchId" | "sequence">> = [];
  for (const key of [...grouped.keys()].sort()) {
    const source = grouped.get(key)!.sort((left, right) => left.unitId.localeCompare(right.unitId));
    let current: MemoryCurationUnit[] = [];
    let bytes = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      pending.push(Object.freeze({
        cohort: current[0]!.cohort,
        mode: batchMode(current[0]!.cohort),
        ...(current[0]!.scopeFingerprint
          ? { scopeFingerprint: current[0]!.scopeFingerprint } : {}),
        unitIds: Object.freeze(current.map((unit) => unit.unitId)),
        sourceCount: current.reduce((total, unit) => total + unit.sourceCount, 0),
        bytes,
      }));
      current = [];
      bytes = 0;
    };
    for (const unit of source) {
      if (current.length > 0 &&
          (current.length >= maxUnits || bytes + unit.bytes > maxBytes)) flush();
      current.push(unit);
      bytes += unit.bytes;
      if (unit.bytes > maxBytes) flush();
    }
    flush();
  }
  return Object.freeze(pending.map((batch, index) => Object.freeze({
    batchId: sha256(`${index + 1}\u001f${stableJson(batch)}`),
    sequence: index + 1,
    ...batch,
  })));
}

export function planMemoryCurationBatches(
  input: PlanMemoryCurationBatchesInput,
): MemoryCurationBatchPlan {
  validateInput(input);
  const units = createUnits(input.nodes, input.groups, input.files);
  const batches = createBatches(units, input.maxUnitsPerBatch, input.maxBytesPerBatch);
  const byCohort: Partial<Record<MemoryCurationCohort, { units: number; sources: number }>> = {};
  for (const unit of units) {
    const current = byCohort[unit.cohort] ?? { units: 0, sources: 0 };
    current.units += 1;
    current.sources += unit.sourceCount;
    byCohort[unit.cohort] = current;
  }
  const summary = Object.freeze({
    sourceCount: units.reduce((total, unit) => total + unit.sourceCount, 0),
    unitCount: units.length,
    batchCount: batches.length,
    byCohort: Object.freeze(byCohort),
  });
  const body = Object.freeze({
    schema: MEMORY_CURATION_BATCH_PLAN_SCHEMA,
    migrationRunId: input.migrationRunId,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    sourceManifestSha256: input.sourceManifestSha256,
    preprocessedManifestSha256: input.preprocessedManifestSha256,
    inventorySha256: input.inventorySha256,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    maxUnitsPerBatch: input.maxUnitsPerBatch,
    maxBytesPerBatch: input.maxBytesPerBatch,
    units,
    batches,
    summary,
    guards: Object.freeze([
      "agent_output_is_proposal_not_disposition",
      "exact_unit_must_not_split_across_batches",
      "exact_scope_must_not_cross_batches",
      "quarantine_must_not_enter_formal_assets_or_trees",
      "source_ref_and_hash_coverage_must_equal_100_percent",
      "candidate_relationship_target_is_not_a_canonical_selector",
      "tree_routes_require_recomputed_final_receipts",
      "postgres_activation_is_forbidden_during_curation",
    ]),
  });
  return Object.freeze({ ...body, planSha256: sha256(stableJson(body)) });
}
