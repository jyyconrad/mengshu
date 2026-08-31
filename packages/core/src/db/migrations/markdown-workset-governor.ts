import { types as nodeUtilTypes } from "node:util";

import type { MemorySemanticType } from "../../domain/types.js";
import { computeCanonicalContentHash } from "../../scoring/hash-utils.js";
import {
  historyCurationSnapshotSha256,
  planHistoryCuration,
  type HistoryCurationPlan,
  type HistoryCurationSemanticMergeApproval,
  type HistoryCurationSource,
} from "./history-curation.js";
import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  parseNativeRecordMarkdown,
  renderNativeRecordMarkdown,
  verifyMarkdownWorksetManifest,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetRecord,
} from "./markdown-workset.js";

export interface GovernMarkdownWorksetInput {
  readonly sourceManifest: MarkdownWorksetManifest;
  readonly sourceFiles: readonly MarkdownWorksetFileInput[];
  readonly policyVersion: string;
}

export interface GovernMarkdownWorksetResult {
  readonly sourceSnapshotSha256: string;
  readonly plan: HistoryCurationPlan;
  readonly governedFiles: readonly MarkdownWorksetFileInput[];
  readonly governedManifest: MarkdownWorksetManifest;
}

export type MarkdownWorksetGovernorErrorCode =
  | "MARKDOWN_WORKSET_GOVERNOR_INVALID_INPUT"
  | "MARKDOWN_WORKSET_GOVERNOR_INVALID_PHASE"
  | "MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION";

const ERROR_MESSAGES: Record<MarkdownWorksetGovernorErrorCode, string> = {
  MARKDOWN_WORKSET_GOVERNOR_INVALID_INPUT: "Markdown workset governor input is invalid",
  MARKDOWN_WORKSET_GOVERNOR_INVALID_PHASE: "Markdown workset governor requires a source manifest",
  MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION: "Markdown workset governance invariant failed",
};

export class MarkdownWorksetGovernorError extends Error {
  constructor(readonly code: MarkdownWorksetGovernorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownWorksetGovernorError";
  }
}

const SAFE_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,510}[^\s\p{Cc}])?$/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const SEMANTIC_DECISIONS = new Set<HistoryCurationSemanticMergeApproval["decision"]>([
  "duplicate", "conflict", "related", "distinct",
]);
const SEMANTIC_METHODS = new Set<HistoryCurationSemanticMergeApproval["method"]>([
  "lexical", "embedding", "graph",
]);

function fail(code: MarkdownWorksetGovernorErrorCode): never {
  throw new MarkdownWorksetGovernorError(code);
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

function semanticType(
  record: MarkdownWorksetNativeRecord,
): MemorySemanticType | undefined {
  const candidate = record.metadata.semanticType;
  if (typeof candidate === "string" && SEMANTIC_TYPES.has(candidate as MemorySemanticType)) {
    return candidate as MemorySemanticType;
  }
  // Knowledge remains a Knowledge source; resource is only the planner's compatibility key.
  return record.sourceTable === "knowledge" ? "resource" : undefined;
}

function evidenceRefs(metadata: Readonly<Record<string, unknown>>): readonly string[] {
  const value = metadata.evidenceRefs;
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      value.some((item) => !safeText(item)) || new Set(value).size !== value.length) {
    return Object.freeze([]);
  }
  return Object.freeze([...value].sort((left, right) => left.localeCompare(right)));
}

function explicitRevision(metadata: Readonly<Record<string, unknown>>): Readonly<{
  sourceIdentity: string;
  revision: Readonly<{ id: string; order: number }>;
}> | undefined {
  const sourceIdentity = metadata.sourceIdentity;
  const revision = metadata.revision;
  if (!safeText(sourceIdentity) || !plainRecord(revision) || !safeText(revision.id) ||
      !Number.isSafeInteger(revision.order) || (revision.order as number) < 0) return undefined;
  return Object.freeze({
    sourceIdentity,
    revision: Object.freeze({ id: revision.id, order: revision.order as number }),
  });
}

function currentSemanticApproval(
  metadata: Readonly<Record<string, unknown>>,
  policyVersion: string,
): HistoryCurationSemanticMergeApproval | undefined {
  const value = metadata.semanticMerge;
  if (!plainRecord(value) || value.decision !== "duplicate" ||
      !SEMANTIC_DECISIONS.has(value.decision as HistoryCurationSemanticMergeApproval["decision"]) ||
      value.approved !== true || value.policyVersion !== policyVersion ||
      !safeText(value.canonicalTargetRef) || typeof value.method !== "string" ||
      !SEMANTIC_METHODS.has(value.method as HistoryCurationSemanticMergeApproval["method"]) ||
      !score(value.confidence)) return undefined;
  return Object.freeze({
    decision: "duplicate",
    canonicalTargetRef: value.canonicalTargetRef,
    approved: true,
    policyVersion,
    method: value.method as HistoryCurationSemanticMergeApproval["method"],
    confidence: value.confidence,
  });
}

function toHistorySource(
  source: MarkdownWorksetRecord,
  policyVersion: string,
): HistoryCurationSource {
  const record = source.record;
  const metadata = record.metadata;
  const staleReason = safeText(metadata.staleReason) ? metadata.staleReason : undefined;
  const stale = staleReason !== undefined ||
    record.lifecycleStatus === "archived" || record.lifecycleStatus === "revoked" ||
    record.lifecycleStatus === "superseded";
  const route = record.legacyQuarantineReason
    ? "quarantine" as const
    : record.sourceTable === "knowledge" && !stale
      ? "lookup_only" as const
      : "canonical" as const;
  const revision = explicitRevision(metadata);
  const semanticMerge = record.sourceTable === "memories"
    ? currentSemanticApproval(metadata, policyVersion)
    : undefined;
  const projectedSemanticType = semanticType(record);
  const importance = record.importance ?? (record.sourceTable === "knowledge" ? 0.5 : 0.7);

  return Object.freeze({
    sourceRef: source.sourceRef,
    sourceHash: source.sourceHash,
    ...(source.scopeFingerprint ? { scopeFingerprint: source.scopeFingerprint } : {}),
    sourceKind: record.sourceTable === "knowledge" ? "knowledge" : "memory",
    contentHash: computeCanonicalContentHash(record.text),
    ...(projectedSemanticType ? { semanticType: projectedSemanticType } : {}),
    lifecycle: record.lifecycleStatus ?? "active",
    ...(revision ?? {}),
    quality: Object.freeze({
      importance,
      valueScore: score(metadata.valueScore) ? metadata.valueScore : importance,
      confidence: score(metadata.confidence) ? metadata.confidence : 0.5,
      route,
    }),
    evidenceRefs: evidenceRefs(metadata),
    createdAt: Date.parse(record.createdAt),
    ...(staleReason ? { staleReason } : {}),
    ...(metadata.conflict === true ? { conflict: true } : {}),
    ...(semanticMerge ? { semanticMerge } : {}),
  });
}

function governedPath(relativePath: string): string {
  return relativePath.startsWith("source/")
    ? `governed/${relativePath.slice("source/".length)}`
    : `governed/${relativePath}`;
}

function mergedFromByTarget(plan: HistoryCurationPlan): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const mapping of plan.mappings) {
    if ((mapping.disposition !== "merge_exact" && mapping.disposition !== "merge_semantic") ||
        !mapping.canonicalTargetRef) continue;
    const values = grouped.get(mapping.canonicalTargetRef) ?? [];
    values.push(mapping.sourceRef);
    grouped.set(mapping.canonicalTargetRef, values);
  }
  return new Map([...grouped].map(([target, refs]) => [
    target,
    Object.freeze([...new Set(refs)].sort((left, right) => left.localeCompare(right))),
  ]));
}

export function governMarkdownWorkset(
  input: GovernMarkdownWorksetInput,
): GovernMarkdownWorksetResult {
  if (!plainRecord(input) || !Array.isArray(input.sourceFiles) ||
      nodeUtilTypes.isProxy(input.sourceFiles) || !safeText(input.policyVersion)) {
    fail("MARKDOWN_WORKSET_GOVERNOR_INVALID_INPUT");
  }

  // This is intentionally the first content operation: never govern an unverified snapshot.
  const verified = verifyMarkdownWorksetManifest(input.sourceManifest, input.sourceFiles);
  if (input.sourceManifest.phase !== "source") {
    fail("MARKDOWN_WORKSET_GOVERNOR_INVALID_PHASE");
  }

  const parsedByPath = new Map(input.sourceFiles.map((file) => [
    file.relativePath,
    parseNativeRecordMarkdown(file.markdown),
  ]));
  const historySources = Object.freeze(input.sourceManifest.files.map((file) => {
    const parsed = parsedByPath.get(file.relativePath);
    if (!parsed || parsed.sourceRef !== file.sourceRef || parsed.sourceHash !== file.sourceHash) {
      fail("MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION");
    }
    return toHistorySource(parsed, input.policyVersion);
  }));
  const historySnapshotSha256 = historyCurationSnapshotSha256(historySources);
  if (historySnapshotSha256 !== verified.snapshotSha256) {
    fail("MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION");
  }

  const plan = planHistoryCuration({
    policyVersion: input.policyVersion,
    expectedSourceCount: verified.sourceCount,
    expectedSnapshotSha256: verified.snapshotSha256,
    sources: historySources,
  });
  if (plan.metrics.sourceMappedTotal !== verified.sourceCount ||
      plan.metrics.sourceMappingCoverage !== 1 || plan.metrics.unresolvedTotal !== 0 ||
      plan.mappings.length !== verified.sourceCount) {
    fail("MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION");
  }

  const mappingByRef = new Map(plan.mappings.map((mapping) => [mapping.sourceRef, mapping]));
  const mergedFrom = mergedFromByTarget(plan);
  const governedFiles = Object.freeze(input.sourceManifest.files.map((manifestFile) => {
    const source = parsedByPath.get(manifestFile.relativePath);
    const mapping = source ? mappingByRef.get(source.sourceRef) : undefined;
    if (!source || !mapping || source.phase !== "source") {
      fail("MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION");
    }
    const governed = createMarkdownWorksetRecord({
      phase: "governed",
      scopeFingerprint: source.scopeFingerprint,
      disposition: mapping.disposition,
      canonicalTargetRef: mapping.canonicalTargetRef,
      mergedFrom: mergedFrom.get(source.sourceRef),
      policyVersion: input.policyVersion,
      record: source.record,
    });
    return Object.freeze({
      relativePath: governedPath(manifestFile.relativePath),
      markdown: renderNativeRecordMarkdown(governed),
    });
  }));
  const governedManifest = createMarkdownWorksetManifest({
    migrationRunId: input.sourceManifest.migrationRunId,
    phase: "governed",
    policyVersion: input.policyVersion,
    createdAt: input.sourceManifest.createdAt,
    files: governedFiles,
  });
  verifyMarkdownWorksetManifest(governedManifest, governedFiles);
  if (governedManifest.sourceCount !== verified.sourceCount ||
      governedManifest.snapshotSha256 !== input.sourceManifest.snapshotSha256 ||
      plan.snapshotSha256 !== input.sourceManifest.snapshotSha256) {
    fail("MARKDOWN_WORKSET_GOVERNOR_INVARIANT_VIOLATION");
  }

  return Object.freeze({
    sourceSnapshotSha256: input.sourceManifest.snapshotSha256,
    plan,
    governedFiles,
    governedManifest,
  });
}
