import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type {
  MemoryLifecycleStatus,
  MemorySemanticType,
} from "../../domain/types.js";

export type HistoricalSourceDisposition =
  | "canonical_keep"
  | "merge_exact"
  | "merge_semantic"
  | "supersede"
  | "archive_stale"
  | "lookup_only"
  | "quarantine"
  | "distinct_keep";

export type HistoryCurationSourceKind = "memory" | "knowledge";

export interface HistoryCurationQuality {
  readonly importance: number;
  readonly valueScore: number;
  readonly confidence: number;
  readonly route: "canonical" | "lookup_only" | "quarantine";
}

export interface HistoryCurationRevision {
  readonly id: string;
  readonly order: number;
}

export interface HistoryCurationSemanticMergeApproval {
  readonly decision: "duplicate" | "conflict" | "related" | "distinct";
  readonly canonicalTargetRef: string;
  readonly approved: boolean;
  readonly policyVersion: string;
  readonly method: "lexical" | "embedding" | "graph";
  readonly confidence: number;
}

export interface HistoryCurationSource {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly scopeFingerprint?: string;
  readonly sourceKind: HistoryCurationSourceKind;
  readonly contentHash?: string;
  readonly semanticType?: MemorySemanticType;
  readonly lifecycle: MemoryLifecycleStatus;
  readonly sourceIdentity?: string;
  readonly revision?: HistoryCurationRevision;
  readonly quality: HistoryCurationQuality;
  readonly evidenceRefs: readonly string[];
  readonly createdAt: number;
  readonly staleReason?: string;
  readonly conflict?: boolean;
  readonly semanticMerge?: HistoryCurationSemanticMergeApproval;
}

export interface PlanHistoryCurationInput {
  readonly policyVersion: string;
  readonly expectedSourceCount: number;
  readonly expectedSnapshotSha256: string;
  readonly sources: readonly HistoryCurationSource[];
}

export interface HistoryCurationUndoPlan {
  readonly action:
    | "remove_mapping"
    | "restore_distinct"
    | "reactivate_source"
    | "release_quarantine";
  readonly sourceRef: string;
  readonly priorLifecycle: MemoryLifecycleStatus;
  readonly canonicalTargetRef?: string;
}

export interface HistoricalSourceDispositionMapping {
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly scopeFingerprint?: string;
  readonly disposition: HistoricalSourceDisposition;
  readonly canonicalTargetRef?: string;
  readonly reasonCode: string;
  readonly policyVersion: string;
  readonly undo: HistoryCurationUndoPlan;
  readonly merge?: Readonly<{
    method: "exact" | HistoryCurationSemanticMergeApproval["method"];
    confidence: number;
    policyVersion: string;
  }>;
}

export interface HistoryCurationPlanMetrics {
  readonly sourceTotal: number;
  readonly sourceMappedTotal: number;
  readonly unresolvedTotal: number;
  readonly sourceMappingCoverage: number;
  readonly before: Readonly<{ canonicalTotal: number }>;
  readonly after: Readonly<{
    canonicalTotal: number;
    lookupOnlyTotal: number;
    archivedTotal: number;
    quarantineTotal: number;
  }>;
  readonly reduction: Readonly<{
    count: number;
    rate: number;
    physicalPurged: 0;
    explanation: "no_reduction_candidates" | "logical_reduction_planned";
  }>;
}

export interface HistoryCurationPlan {
  readonly policyVersion: string;
  readonly snapshotSha256: string;
  readonly mappings: readonly HistoricalSourceDispositionMapping[];
  readonly dispositionCounts: Readonly<Record<HistoricalSourceDisposition, number>>;
  readonly metrics: HistoryCurationPlanMetrics;
}

export type HistoryCurationPlannerErrorCode =
  | "HISTORY_CURATION_INVALID_INPUT"
  | "HISTORY_CURATION_DUPLICATE_SOURCE_REF"
  | "HISTORY_CURATION_SOURCE_DRIFT";

const ERROR_MESSAGES: Record<HistoryCurationPlannerErrorCode, string> = {
  HISTORY_CURATION_INVALID_INPUT: "History curation planner input is invalid",
  HISTORY_CURATION_DUPLICATE_SOURCE_REF: "History curation source reference is duplicated",
  HISTORY_CURATION_SOURCE_DRIFT: "History curation source snapshot drifted",
};

export class HistoryCurationPlannerError extends Error {
  constructor(readonly code: HistoryCurationPlannerErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HistoryCurationPlannerError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,510}[^\s\p{Cc}])?$/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const LIFECYCLE_STATUSES = new Set<MemoryLifecycleStatus>([
  "active", "archived", "revoked", "superseded", "promoted",
]);
const SOURCE_KINDS = new Set<HistoryCurationSourceKind>(["memory", "knowledge"]);
const ROUTES = new Set<HistoryCurationQuality["route"]>([
  "canonical", "lookup_only", "quarantine",
]);
const SEMANTIC_DECISIONS = new Set<HistoryCurationSemanticMergeApproval["decision"]>([
  "duplicate", "conflict", "related", "distinct",
]);
const SEMANTIC_METHODS = new Set<HistoryCurationSemanticMergeApproval["method"]>([
  "lexical", "embedding", "graph",
]);
const DISPOSITIONS = Object.freeze([
  "canonical_keep", "merge_exact", "merge_semantic", "supersede",
  "archive_stale", "lookup_only", "quarantine", "distinct_keep",
] as const satisfies readonly HistoricalSourceDisposition[]);

function fail(code: HistoryCurationPlannerErrorCode): never {
  throw new HistoryCurationPlannerError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && SAFE_TEXT.test(value);
}

function score(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function denseSafeStrings(value: unknown): value is readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      Reflect.ownKeys(value).length !== value.length + 1) return false;
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor) || !safeText(descriptor.value) ||
        seen.has(descriptor.value)) return false;
    seen.add(descriptor.value);
  }
  return true;
}

function validQuality(value: unknown): value is HistoryCurationQuality {
  return plainRecord(value) && score(value.importance) && score(value.valueScore) &&
    score(value.confidence) && typeof value.route === "string" &&
    ROUTES.has(value.route as HistoryCurationQuality["route"]);
}

function validRevision(value: unknown): value is HistoryCurationRevision {
  return plainRecord(value) && safeText(value.id) && Number.isSafeInteger(value.order) &&
    (value.order as number) >= 0;
}

function validSemanticMerge(value: unknown): value is HistoryCurationSemanticMergeApproval {
  return plainRecord(value) && typeof value.decision === "string" &&
    SEMANTIC_DECISIONS.has(value.decision as HistoryCurationSemanticMergeApproval["decision"]) &&
    safeText(value.canonicalTargetRef) && typeof value.approved === "boolean" &&
    safeText(value.policyVersion) && typeof value.method === "string" &&
    SEMANTIC_METHODS.has(value.method as HistoryCurationSemanticMergeApproval["method"]) &&
    score(value.confidence);
}

function validateSource(value: unknown): asserts value is HistoryCurationSource {
  if (!plainRecord(value) || !safeText(value.sourceRef) ||
      typeof value.sourceHash !== "string" || !SHA256.test(value.sourceHash) ||
      typeof value.sourceKind !== "string" ||
      !SOURCE_KINDS.has(value.sourceKind as HistoryCurationSourceKind) ||
      (value.contentHash !== undefined &&
        (typeof value.contentHash !== "string" || !SHA256.test(value.contentHash))) ||
      (value.semanticType !== undefined &&
        (typeof value.semanticType !== "string" ||
          !SEMANTIC_TYPES.has(value.semanticType as MemorySemanticType))) ||
      typeof value.lifecycle !== "string" ||
      !LIFECYCLE_STATUSES.has(value.lifecycle as MemoryLifecycleStatus) ||
      (value.sourceIdentity !== undefined && !safeText(value.sourceIdentity)) ||
      (value.revision !== undefined && !validRevision(value.revision)) ||
      (value.revision !== undefined) !== (value.sourceIdentity !== undefined) ||
      !validQuality(value.quality) || !denseSafeStrings(value.evidenceRefs) ||
      typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) ||
      value.createdAt < 0 ||
      (value.staleReason !== undefined && !safeText(value.staleReason)) ||
      (value.conflict !== undefined && typeof value.conflict !== "boolean") ||
      (value.semanticMerge !== undefined && !validSemanticMerge(value.semanticMerge))) {
    fail("HISTORY_CURATION_INVALID_INPUT");
  }
}

function sortedSources(sources: readonly HistoryCurationSource[]): readonly HistoryCurationSource[] {
  return [...sources].sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
}

function assertUniqueSourceRefs(sources: readonly HistoryCurationSource[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.sourceRef)) fail("HISTORY_CURATION_DUPLICATE_SOURCE_REF");
    seen.add(source.sourceRef);
  }
}

export function historyCurationSnapshotSha256(
  sources: readonly HistoryCurationSource[],
): string {
  if (!Array.isArray(sources) || nodeUtilTypes.isProxy(sources)) {
    fail("HISTORY_CURATION_INVALID_INPUT");
  }
  for (const source of sources) validateSource(source);
  assertUniqueSourceRefs(sources);
  return createHash("sha256").update(sortedSources(sources)
    .map((source) => `${source.sourceRef}\u001f${source.sourceHash}`)
    .join("\n"), "utf8").digest("hex");
}

function lifecycleRank(value: MemoryLifecycleStatus): number {
  switch (value) {
    case "active": return 5;
    case "promoted": return 4;
    case "archived": return 3;
    case "superseded": return 2;
    case "revoked": return 1;
  }
}

function compareCanonical(
  left: HistoryCurationSource,
  right: HistoryCurationSource,
): number {
  return lifecycleRank(right.lifecycle) - lifecycleRank(left.lifecycle) ||
    right.quality.importance - left.quality.importance ||
    right.evidenceRefs.length - left.evidenceRefs.length ||
    left.createdAt - right.createdAt ||
    left.sourceRef.localeCompare(right.sourceRef);
}

function groupKey(source: HistoryCurationSource, tail: string): string {
  return [source.scopeFingerprint, source.sourceKind, source.semanticType, tail].join("\u001f");
}

function undoFor(
  source: HistoryCurationSource,
  disposition: HistoricalSourceDisposition,
  canonicalTargetRef?: string,
): HistoryCurationUndoPlan {
  const action = disposition === "merge_exact" || disposition === "merge_semantic" ||
      disposition === "supersede"
    ? "restore_distinct"
    : disposition === "archive_stale"
      ? "reactivate_source"
      : disposition === "quarantine"
        ? "release_quarantine"
        : "remove_mapping";
  return Object.freeze({
    action,
    sourceRef: source.sourceRef,
    priorLifecycle: source.lifecycle,
    ...(canonicalTargetRef ? { canonicalTargetRef } : {}),
  });
}

function mappingFor(
  source: HistoryCurationSource,
  policyVersion: string,
  disposition: HistoricalSourceDisposition,
  reasonCode: string,
  canonicalTargetRef?: string,
  merge?: HistoricalSourceDispositionMapping["merge"],
): HistoricalSourceDispositionMapping {
  return Object.freeze({
    sourceRef: source.sourceRef,
    sourceHash: source.sourceHash,
    ...(source.scopeFingerprint ? { scopeFingerprint: source.scopeFingerprint } : {}),
    disposition,
    ...(canonicalTargetRef ? { canonicalTargetRef } : {}),
    reasonCode,
    policyVersion,
    undo: undoFor(source, disposition, canonicalTargetRef),
    ...(merge ? { merge: Object.freeze({ ...merge }) } : {}),
  });
}

function compatible(
  source: HistoryCurationSource,
  target: HistoryCurationSource,
): boolean {
  return source.scopeFingerprint !== undefined &&
    source.scopeFingerprint === target.scopeFingerprint &&
    source.sourceKind === target.sourceKind &&
    source.semanticType !== undefined && source.semanticType === target.semanticType &&
    source.conflict !== true && target.conflict !== true;
}

function fixedMapping(
  source: HistoryCurationSource,
  policyVersion: string,
): HistoricalSourceDispositionMapping | undefined {
  if (!source.scopeFingerprint) {
    return mappingFor(source, policyVersion, "quarantine", "missing_scope");
  }
  if (!SHA256.test(source.scopeFingerprint)) {
    return mappingFor(source, policyVersion, "quarantine", "invalid_scope");
  }
  if (!source.semanticType) {
    return mappingFor(source, policyVersion, "quarantine", "missing_semantic_type");
  }
  if (source.quality.route === "quarantine") {
    return mappingFor(source, policyVersion, "quarantine", "quality_route_quarantine");
  }
  if (source.conflict === true || source.semanticMerge?.decision === "conflict") {
    return mappingFor(
      source, policyVersion, "distinct_keep", "conflict_preserved", source.sourceRef,
    );
  }
  if (source.staleReason || ["archived", "revoked", "superseded"].includes(source.lifecycle)) {
    return mappingFor(
      source, policyVersion, "archive_stale",
      source.staleReason ?? `lifecycle_${source.lifecycle}`,
    );
  }
  return undefined;
}

function initializeDispositionCounts(): Record<HistoricalSourceDisposition, number> {
  return Object.fromEntries(DISPOSITIONS.map((disposition) => [disposition, 0])) as
    Record<HistoricalSourceDisposition, number>;
}

export function planHistoryCuration(input: PlanHistoryCurationInput): HistoryCurationPlan {
  if (!plainRecord(input) || !safeText(input.policyVersion) ||
      !Number.isSafeInteger(input.expectedSourceCount) || input.expectedSourceCount < 0 ||
      typeof input.expectedSnapshotSha256 !== "string" ||
      !SHA256.test(input.expectedSnapshotSha256) || !Array.isArray(input.sources) ||
      nodeUtilTypes.isProxy(input.sources)) {
    fail("HISTORY_CURATION_INVALID_INPUT");
  }
  for (const source of input.sources) validateSource(source);
  assertUniqueSourceRefs(input.sources);
  const snapshotSha256 = historyCurationSnapshotSha256(input.sources);
  if (input.sources.length !== input.expectedSourceCount ||
      snapshotSha256 !== input.expectedSnapshotSha256) {
    fail("HISTORY_CURATION_SOURCE_DRIFT");
  }

  const sources = sortedSources(input.sources);
  const byRef = new Map(sources.map((source) => [source.sourceRef, source]));
  const mappings = new Map<string, HistoricalSourceDispositionMapping>();

  for (const source of sources) {
    const fixed = fixedMapping(source, input.policyVersion);
    if (fixed) mappings.set(source.sourceRef, fixed);
  }

  const revisionGroups = new Map<string, HistoryCurationSource[]>();
  for (const source of sources) {
    if (mappings.has(source.sourceRef) || !source.sourceIdentity || !source.revision) continue;
    const key = groupKey(source, source.sourceIdentity);
    const group = revisionGroups.get(key) ?? [];
    group.push(source);
    revisionGroups.set(key, group);
  }
  for (const group of revisionGroups.values()) {
    if (group.length < 2) continue;
    const latestOrder = Math.max(...group.map((source) => source.revision!.order));
    const latest = group.filter((source) => source.revision!.order === latestOrder);
    if (latest.length !== 1) continue;
    const target = latest[0]!;
    mappings.set(target.sourceRef, mappingFor(
      target, input.policyVersion, "canonical_keep", "current_source_revision", target.sourceRef,
    ));
    for (const source of group) {
      if (source.sourceRef === target.sourceRef) continue;
      mappings.set(source.sourceRef, mappingFor(
        source, input.policyVersion, "supersede", "older_source_revision", target.sourceRef,
      ));
    }
  }

  for (const source of sources) {
    if (mappings.has(source.sourceRef) || source.semanticMerge?.decision !== "duplicate") continue;
    const proposal = source.semanticMerge;
    if (!proposal.approved || proposal.policyVersion !== input.policyVersion) continue;
    const target = byRef.get(proposal.canonicalTargetRef);
    const targetProposal = target?.semanticMerge;
    const targetAlreadyMerged = target ? mappings.get(target.sourceRef) : undefined;
    if (!target || !compatible(source, target) || source.sourceRef === target.sourceRef ||
        (targetProposal?.decision === "duplicate" && targetProposal.approved) ||
        (targetAlreadyMerged !== undefined && targetAlreadyMerged.disposition !== "canonical_keep")) {
      mappings.set(source.sourceRef, mappingFor(
        source, input.policyVersion, "quarantine", "semantic_target_incompatible",
      ));
      continue;
    }
    if (!targetAlreadyMerged) {
      mappings.set(target.sourceRef, mappingFor(
        target, input.policyVersion, "canonical_keep", "semantic_cluster_canonical", target.sourceRef,
      ));
    }
    mappings.set(source.sourceRef, mappingFor(
      source,
      input.policyVersion,
      "merge_semantic",
      "policy_approved_semantic_duplicate",
      target.sourceRef,
      {
        method: proposal.method,
        confidence: proposal.confidence,
        policyVersion: proposal.policyVersion,
      },
    ));
  }

  const exactGroups = new Map<string, HistoryCurationSource[]>();
  for (const source of sources) {
    const existing = mappings.get(source.sourceRef);
    if ((existing && existing.disposition !== "canonical_keep") || !source.contentHash) continue;
    const key = groupKey(source, source.contentHash);
    const group = exactGroups.get(key) ?? [];
    group.push(source);
    exactGroups.set(key, group);
  }
  for (const group of exactGroups.values()) {
    if (group.length < 2) continue;
    const existingCanonicals = group.filter((source) =>
      mappings.get(source.sourceRef)?.disposition === "canonical_keep");
    const canonical = [...(existingCanonicals.length > 0 ? existingCanonicals : group)]
      .sort(compareCanonical)[0]!;
    const duplicates = group.filter((source) => source.sourceRef !== canonical.sourceRef);
    if (!mappings.has(canonical.sourceRef)) {
      mappings.set(canonical.sourceRef, mappingFor(
        canonical, input.policyVersion, "canonical_keep", "exact_cluster_canonical",
        canonical.sourceRef,
      ));
    }
    for (const duplicate of duplicates) {
      mappings.set(duplicate.sourceRef, mappingFor(
        duplicate,
        input.policyVersion,
        "merge_exact",
        "exact_content_duplicate",
        canonical!.sourceRef,
        { method: "exact", confidence: 1, policyVersion: input.policyVersion },
      ));
      for (const [sourceRef, existing] of mappings) {
        if (sourceRef === duplicate.sourceRef ||
            existing.canonicalTargetRef !== duplicate.sourceRef) continue;
        const dependent = byRef.get(sourceRef)!;
        mappings.set(sourceRef, mappingFor(
          dependent,
          input.policyVersion,
          existing.disposition,
          existing.reasonCode,
          canonical.sourceRef,
          existing.merge,
        ));
      }
    }
  }

  // lookup-only 仍应先参与同 scope/kind/type 的 exact 收敛；只有未被
  // exact/revision/semantic 解释的独立记录才保留为 lookup-only。
  for (const source of sources) {
    if (mappings.has(source.sourceRef) || source.quality.route !== "lookup_only") continue;
    mappings.set(source.sourceRef, mappingFor(
      source, input.policyVersion, "lookup_only", "quality_route_lookup_only", source.sourceRef,
    ));
  }

  for (const source of sources) {
    if (mappings.has(source.sourceRef)) continue;
    const reasonCode = source.semanticMerge?.decision === "duplicate"
      ? "semantic_merge_not_approved"
      : source.semanticMerge
        ? "semantic_relation_preserved"
        : source.sourceIdentity && source.revision
          ? "ambiguous_or_single_revision"
          : "no_merge_candidate";
    mappings.set(source.sourceRef, mappingFor(
      source, input.policyVersion, "distinct_keep", reasonCode, source.sourceRef,
    ));
  }

  const orderedMappings = Object.freeze(sources.map((source) => mappings.get(source.sourceRef)!));
  const dispositionCounts = initializeDispositionCounts();
  for (const mapping of orderedMappings) dispositionCounts[mapping.disposition] += 1;
  const sourceTotal = sources.length;
  const sourceMappedTotal = orderedMappings.length;
  const unresolvedTotal = sourceTotal - sourceMappedTotal;
  const canonicalTotal = dispositionCounts.canonical_keep + dispositionCounts.distinct_keep;
  const reductionCount = sourceTotal - canonicalTotal;
  const reductionRate = sourceTotal === 0 ? 0 : reductionCount / sourceTotal;

  return Object.freeze({
    policyVersion: input.policyVersion,
    snapshotSha256,
    mappings: orderedMappings,
    dispositionCounts: Object.freeze({ ...dispositionCounts }),
    metrics: Object.freeze({
      sourceTotal,
      sourceMappedTotal,
      unresolvedTotal,
      sourceMappingCoverage: sourceTotal === 0 ? 1 : sourceMappedTotal / sourceTotal,
      before: Object.freeze({ canonicalTotal: sourceTotal }),
      after: Object.freeze({
        canonicalTotal,
        lookupOnlyTotal: dispositionCounts.lookup_only,
        archivedTotal: dispositionCounts.archive_stale + dispositionCounts.supersede,
        quarantineTotal: dispositionCounts.quarantine,
      }),
      reduction: Object.freeze({
        count: reductionCount,
        rate: reductionRate,
        physicalPurged: 0 as const,
        explanation: reductionCount === 0
          ? "no_reduction_candidates" as const
          : "logical_reduction_planned" as const,
      }),
    }),
  });
}
