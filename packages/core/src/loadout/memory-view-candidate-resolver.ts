import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import {
  isRecallScoreBreakdown,
  type CompleteRecallScoreBreakdown,
} from "../domain/recall-scoring.js";
import type { MemoryRecord, MemoryScope, RecallHit } from "../domain/types.js";
import type {
  MemoryViewAssetDescriptor,
  MemoryViewAssetReadResult,
} from "../assets/types.js";
import type { LoadoutAssetCandidate } from "./types.js";

function normalized(scope: MemoryScope): MemoryScope {
  return scope.visibility === undefined ? { ...scope, visibility: "private" } : scope;
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(normalized(left)) ===
      authorityScopeFingerprint(normalized(right));
  } catch {
    return false;
  }
}

function memoryHit(hit: RecallHit): hit is RecallHit & {
  record: MemoryRecord;
  scoreBreakdown: CompleteRecallScoreBreakdown;
} {
  return "text" in hit.record && "importance" in hit.record &&
    isRecallScoreBreakdown(hit.scoreBreakdown) &&
    Math.abs(hit.score - hit.scoreBreakdown.score) <= 1e-9;
}

function riskFlags(record: MemoryRecord): readonly string[] | undefined {
  const value = record.metadata.riskFlags;
  if (value === undefined) return [];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function conflictUnresolved(record: MemoryRecord): boolean {
  const value = record.metadata.conflictUnresolved ?? record.metadata.conflict_unresolved;
  const status = record.metadata.conflictStatus;
  return value !== undefined && value !== false ||
    typeof status === "string" && status !== "none" && status !== "resolved";
}

/**
 * Resolve a memory_view using only governed RecallHits. Missing or stale sources
 * never get re-queried through an ungoverned path.
 */
export function resolveMemoryViewLoadoutCandidate(
  asset: MemoryViewAssetDescriptor,
  governedHits: readonly RecallHit[],
  currentRead?: MemoryViewAssetReadResult,
): LoadoutAssetCandidate | undefined {
  const byId = new Map(
    governedHits.filter(memoryHit).map((hit) => [hit.record.id, hit] as const),
  );
  const resolved = asset.contentRef.recordIds
    .map((id) => byId.get(id))
    .filter((hit): hit is RecallHit & {
      record: MemoryRecord;
      scoreBreakdown: CompleteRecallScoreBreakdown;
    } => hit !== undefined);
  if (resolved.length === 0) return undefined;

  const treeCurrent = asset.contentRef.treeNodeIds.length === 0 || Boolean(
    currentRead?.asset.id === asset.id &&
    currentRead.asset.version === asset.version &&
    currentRead.contentValidity === "current",
  );
  const sourceCurrent = resolved.length === asset.contentRef.recordIds.length && treeCurrent &&
    resolved.every((hit) => hit.record.lifecycleStatus === "active" &&
      sameScope(hit.record.scope, asset.sourceScope) &&
      hit.record.semanticType !== undefined &&
      asset.semanticTypes.includes(hit.record.semanticType));
  const provenEvidence = new Set(resolved.flatMap((hit) => hit.record.sourceNodeIds ?? []));
  const evidenceCurrent = asset.contentRef.evidenceIds.every((id) => provenEvidence.has(id));
  const conservative = [...resolved]
    .sort((left, right) => left.score - right.score ||
      left.record.id.localeCompare(right.record.id))[0]!;
  const flags = resolved.map((hit) => riskFlags(hit.record));
  const content = resolved.map((hit) => hit.record.text).join("\n");

  return Object.freeze({
    assetId: asset.id,
    assetVersion: asset.version,
    assetKind: "memory_view",
    status: asset.status,
    contentValidity: sourceCurrent && evidenceCurrent ? "current" : "stale",
    scope: asset.sourceScope,
    semanticTypes: asset.semanticTypes,
    recordId: asset.contentRef.recordIds.join(","),
    content,
    evidenceRefs: asset.evidenceRefs,
    lifecycleEligible: sourceCurrent,
    riskBlocked: asset.riskFlags.length > 0 || flags.some((value) => value === undefined ||
      value.some((flag) => flag === "prompt_injection" || flag === "scope_risk" ||
        flag === "conflict_possible")),
    conflictUnresolved: resolved.some((hit) => conflictUnresolved(hit.record)),
    score: conservative.score,
    scoreBreakdown: conservative.scoreBreakdown,
    recallSource: conservative.source,
    tokenEstimate: content.length,
  });
}
