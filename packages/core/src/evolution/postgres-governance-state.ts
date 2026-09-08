import { jsonHash } from "./postgres-common.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const EVOLUTION_REVERSIBLE_METADATA_KEYS = ["effectiveRootIds", "disputed", "needsReview", "aliasOf", "lastOperationId", "lastRevalidatedAt", "lastSourceReconciliationId", "ownerApprovalReceiptId", "proposalId"] as const;

/** Bounded semantic/control projection. Quotes and scheduling/access counters are not an audit log. */
export function evolutionGovernanceState(row: Record<string, unknown>): Record<string, unknown> {
  const metadata = object(row.metadata), governance = object(metadata.governance), evolution = object(governance.evolution);
  return { id: row.id, contentHash: row.content_hash ?? null, native: governance.native ?? {}, semanticType: metadata.semanticType ?? null,
    revision: row.revision ?? 0, lineageId: row.lineage_id ?? null, lifecycleStatus: row.lifecycle_status, validTo: row.valid_to_ms ?? null, closedAt: row.closed_at_ms ?? null,
    disputed: row.evolution_disputed ?? false, aliasOf: row.evolution_alias_of ?? null, reviewDueAt: row.evolution_review_due_at ?? 0,
    contextEligible: metadata.contextEligible ?? false, admissionRoute: metadata.admissionRoute ?? null, pinned: metadata.pinned === true,
    confidence: metadata.confidence ?? 0, sourceNodeIds: metadata.sourceNodeIds ?? [], evidenceIds: governance.evidenceIds ?? [],
    evolution: Object.fromEntries(EVOLUTION_REVERSIBLE_METADATA_KEYS.filter(key => Object.hasOwn(evolution, key)).map(key => [key, evolution[key]])) };
}
export function evolutionLinkState(links: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return links.map(link => ({ id: link.link_id, memoryId: link.target_memory_id, evidenceId: link.evidence_memory_id, state: link.relation_state,
    sourceId: link.source_id ?? null, sourceRevision: link.source_current_revision ?? link.source_revision ?? null, rootId: link.root_evidence_id ?? null }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
export function evolutionGovernanceSnapshotHash(states: readonly Record<string, unknown>[], links: readonly Record<string, unknown>[]): string {
  return jsonHash({ states: states.map(({ reviewDueAt: _due, ...state }) => state).sort((a, b) => String(a.id).localeCompare(String(b.id))), links });
}
