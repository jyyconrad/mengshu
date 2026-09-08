import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import { computeConfidence } from "../scoring/confidence-score.js";
import type { SourceKind } from "../scoring/importance-score.js";
import { PostgresTemporalMemoryRepository, type PostgresTemporalMemoryClient } from "../temporal/postgres-repository.js";
import type { MemoryVersionTransitionReceipt } from "../temporal/types.js";
import { boundedJson, fail, integer, jsonHash, scopeParams, type PostgresEvolutionClient, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import type { PostgresEvolutionEvidenceBinding, PostgresEvolutionVerifiedInput } from "./governed-writer.js";
import { evolutionGovernanceSnapshotHash, evolutionGovernanceState, evolutionLinkState } from "./postgres-governance-state.js";
export { EVOLUTION_REVERSIBLE_METADATA_KEYS, evolutionGovernanceSnapshotHash, evolutionGovernanceState, evolutionLinkState } from "./postgres-governance-state.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const kinds: Record<string, SourceKind> = { user_statement: "session_user", verified_document: "document", verified_result: "tool_result" };
export const EVOLUTION_METADATA_OPERATIONS = ["add_evidence", "mark_disputed", "expire", "deprecate", "revalidate", "merge_equivalent"] as const;

export function recomputeEvolutionConfidence(type: MemorySemanticType | undefined, links: Record<string, unknown>[], previous: number): number {
  const roots = new Map<string, SourceKind>();
  for (const link of links) if (link.relation_state === "effective" && typeof link.root_evidence_id === "string" && kinds[String(link.source_kind)] && !roots.has(link.root_evidence_id)) roots.set(link.root_evidence_id, kinds[String(link.source_kind)]!);
  if (roots.size === 0) return 0;
  return type ? computeConfidence(type, [...roots.values()].map(sourceKind => ({ sourceKind }))) : previous;
}
export async function readEvolutionLinks(client: PostgresEvolutionQueryClient, scopeFingerprint: string, ids: string[]): Promise<Record<string, unknown>[]> {
  const rows = (await client.query(`/* evolution:governed-links */ SELECT * FROM mengshu_memory_evidence_links
WHERE scope_fingerprint = $1 AND target_memory_id = ANY($2::text[]) ORDER BY target_memory_id, link_id LIMIT 129 FOR SHARE`, [scopeFingerprint, ids])).rows;
  if (rows.length > 128) fail("EVIDENCE_LINK_LIMIT");
  return rows;
}
export async function writeEvolutionLink(client: PostgresEvolutionQueryClient, input: {
  scope: MemoryScope; scopeFingerprint: string; memoryId: string; evidenceId: string; now: number;
  state: "effective" | "reviewed_reference" | "contradicting"; rootId: string; sourceId: string; sourceRevision: string; sourceHash: string; sourceKind: string;
  sourceRecordId?: string; sourceLocator?: string;
  sourceCurrentRevision?: string; sourceLogicalFileId?: string; sourcePathId?: string; sourceSpanId?: string;
  continuityKey?: string; independenceGroupId?: string;
}): Promise<void> {
  const linkKind = input.state === "contradicting" ? "conflict_evidence" : "grounded_by";
  const locator = input.sourceLocator?.match(/^([a-f0-9]{64}):\d+-\d+:(.{1,256})$/);
  await client.query(`/* evolution:governed-link */ INSERT INTO mengshu_memory_evidence_links
(link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id,
target_memory_id, evidence_memory_id, link_kind, source, created_at, relation_state, root_evidence_id, source_id, source_revision, source_hash, source_kind, source_record_id, source_path_id, source_span_id,
source_current_revision, source_logical_file_id, continuity_key, independence_group_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'memory_evolution',$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
ON CONFLICT (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source) DO NOTHING`,
  [jsonHash(["evolution-governed-link-v1", input.scopeFingerprint, input.memoryId, input.evidenceId, linkKind]), input.scopeFingerprint, ...scopeParams(input.scope), input.memoryId, input.evidenceId, linkKind, input.now, input.state, input.rootId, input.sourceId, input.sourceRevision, input.sourceHash, input.sourceKind,
    input.sourceRecordId ?? null, input.sourcePathId ?? locator?.[1] ?? null, input.sourceSpanId ?? locator?.[2] ?? null,
    input.sourceCurrentRevision ?? input.sourceRevision, input.sourceLogicalFileId ?? null, input.continuityKey ?? null, input.independenceGroupId ?? null]);
}
export async function appendEvolutionMutationEvent(client: PostgresEvolutionQueryClient, scope: MemoryScope, memoryId: string, operationId: string, now: number, origin = true): Promise<void> {
  const storageKey = jsonHash(["evolution-governance-write-v1", scopeParams(scope), operationId, memoryId]);
  const [tenant, user, app, project, agent, namespace, visibility, workspace, session] = scopeParams(scope);
  const values = [tenant, user, project, app, agent, namespace, visibility, workspace, session];
  await client.query(`/* evolution:metadata-audit */ INSERT INTO mengshu_write_audit
(storage_key, memory_id, action, tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at)
VALUES ($1,$2,'memory.store',$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12::double precision/1000))`, [storageKey, memoryId, ...values, now]);
  await client.query(`/* evolution:metadata-outbox */ INSERT INTO mengshu_write_outbox
(event_id, storage_key, topic, memory_id, tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at, evolution_origin)
VALUES ($1,$2,'memory.written',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,to_timestamp($13::double precision/1000),$14)
ON CONFLICT (event_id) DO NOTHING`, [jsonHash([storageKey, "event"]), storageKey, memoryId, ...values, now, origin]);
}
function closingReceipt(verified: PostgresEvolutionVerifiedInput, row: Record<string, unknown>, now: number): MemoryVersionTransitionReceipt {
  const p = verified.context.proposal;
  return { id: jsonHash(["evolution-close", p.id, row.id]), idempotencyKey: `evolution-close:${jsonHash([p.id, row.id])}`, requestHash: jsonHash([p.id, p.operation, p.targetRefs, p.validTo]), scopeFingerprint: p.scopeFingerprint,
    lineageId: String(row.lineage_id), transitionType: "expired", previousVersionId: String(row.id), revision: Number(row.revision), occurredAt: now };
}
/** Match temporal writer lock order before any canonical row lock; multiple lineages are sorted. */
export async function lockEvolutionMetadataHeads(client: PostgresEvolutionQueryClient, verified: PostgresEvolutionVerifiedInput, rows: Record<string, unknown>[], now: number): Promise<void> {
  const temporal = rows.filter(row => typeof row.lineage_id === "string" && Number(row.revision) > 0);
  const receipts = temporal.map(row => closingReceipt(verified, row, now)).sort((a, b) => a.idempotencyKey.localeCompare(b.idempotencyKey));
  for (const receipt of receipts) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory-version-receipt:${receipt.scopeFingerprint}:${receipt.idempotencyKey}`]);
  for (const lineage of [...new Set(temporal.map(row => String(row.lineage_id)))].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory-lineage:${verified.context.proposal.scopeFingerprint}:${lineage}`]);
}
export async function persistEvolutionMetadata(client: PostgresEvolutionQueryClient, scope: MemoryScope, row: Record<string, unknown>, metadata: Record<string, unknown>, options: { now: number; disputed?: boolean; aliasOf?: string; dueAt?: number } ): Promise<void> {
  const evolution = object(object(metadata.governance).evolution);
  if ((options.disputed ?? row.evolution_disputed) === true || evolution.disputed === true || evolution.needsReview === true) metadata.contextEligible = false;
  boundedJson(metadata, 65536);
  const result = await client.query(`/* evolution:metadata-write */ UPDATE memories SET metadata = $11::jsonb,
evolution_disputed = COALESCE($12::boolean, evolution_disputed), evolution_alias_of = COALESCE($13::uuid, evolution_alias_of),
evolution_review_due_at = COALESCE($14::bigint, evolution_review_due_at),
temporal_snapshot = CASE WHEN temporal_snapshot IS NULL THEN NULL ELSE
jsonb_set(jsonb_set(jsonb_set(temporal_snapshot,'{record,metadata}',$11::jsonb),'{record,sourceNodeIds}',COALESCE($11::jsonb->'sourceNodeIds','[]'::jsonb)),
'{record,confidence}',COALESCE($11::jsonb->'confidence','0'::jsonb)) END
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = $10 AND temporal_purge_pending IS NOT TRUE RETURNING id::text AS id`,
  [...scopeParams(scope), row.id, JSON.stringify(metadata), options.disputed ?? null, options.aliasOf ?? null, options.dueAt ?? null]);
  if (result.rows[0]?.id !== row.id) fail("GOVERNANCE_TARGET_CHANGED");
}

export async function applyEvolutionMetadata(input: {
  client: PostgresEvolutionClient; verified: PostgresEvolutionVerifiedInput; rows: Record<string, unknown>[];
  bindings: readonly PostgresEvolutionEvidenceBinding[]; now: number; temporal?: PostgresTemporalMemoryRepository;
}): Promise<string[]> {
  const { client, verified, rows, bindings, now } = input, p = verified.context.proposal;
  if (!rows.length || rows.length > 8) fail("GOVERNANCE_TARGET_LIMIT");
  const byId = new Map(rows.map(row => [String(row.id), row]));
  const ordered = p.targetRefs.map(ref => byId.get(ref.memoryId)!);
  if (ordered.some(row => !row)) fail("GOVERNANCE_TARGET_CHANGED");
  const primary = ordered[0]!, primaryId = String(primary.id), before = boundedJson(rows.map(evolutionGovernanceState), 24576);
  let links = await readEvolutionLinks(client, p.scopeFingerprint, rows.map(row => String(row.id)));
  const beforeLinks = evolutionLinkState(links), after: Record<string, unknown>[] = [];
  if (["add_evidence", "mark_disputed"].includes(p.operation)) {
    for (const binding of bindings) {
      const source = verified.supportedEvidence.find(e => e.id === binding.sourceEvidenceId)!;
      if (!source) fail("EVIDENCE_BINDING_MISSING");
      const state = p.operation === "mark_disputed" ? "contradicting" : "effective";
      if (state === "effective" && (!verified.validation.independentEvidenceRootIds.includes(source.rootEvidenceId) || source.trust === "untrusted")) continue;
      await writeEvolutionLink(client, { scope: p.scope, scopeFingerprint: p.scopeFingerprint, memoryId: primaryId, evidenceId: binding.evidenceMemoryId, now,
        state, rootId: source.rootEvidenceId, sourceId: source.sourceId, sourceRevision: source.revision, sourceHash: source.snapshotHash, sourceKind: source.trust, sourceRecordId: source.id, sourceLocator: source.locator });
    }
    links = await readEvolutionLinks(client, p.scopeFingerprint, rows.map(row => String(row.id)));
  }
  if (p.operation === "merge_equivalent") {
    const first = verified.targets.find(target => target.memoryId === primaryId)!;
    const normalize = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
    if (rows.length < 2 || verified.targets.some(target => normalize(target.text) !== normalize(first.text) || target.kind !== first.kind || target.semanticType !== first.semanticType || target.validFrom !== first.validFrom || target.validTo !== first.validTo)) fail("MERGE_EQUIVALENCE_UNVERIFIED");
    for (const link of links) {
      if (!["effective", "reviewed_reference", "contradicting"].includes(String(link.relation_state)) || !link.source_hash || !link.root_evidence_id) continue;
      await writeEvolutionLink(client, { scope: p.scope, scopeFingerprint: p.scopeFingerprint, memoryId: primaryId, evidenceId: String(link.evidence_memory_id), now,
        state: link.relation_state as "effective", rootId: String(link.root_evidence_id), sourceId: String(link.source_id), sourceRevision: String(link.source_revision), sourceHash: String(link.source_hash), sourceKind: String(link.source_kind),
        sourceRecordId: typeof link.source_record_id === "string" ? link.source_record_id : undefined,
        sourceCurrentRevision: typeof link.source_current_revision === "string" ? link.source_current_revision : undefined,
        sourcePathId: typeof link.source_path_id === "string" ? link.source_path_id : undefined,
        sourceSpanId: typeof link.source_span_id === "string" ? link.source_span_id : undefined,
        sourceLogicalFileId: typeof link.source_logical_file_id === "string" ? link.source_logical_file_id : undefined,
        continuityKey: typeof link.continuity_key === "string" ? link.continuity_key : undefined,
        independenceGroupId: typeof link.independence_group_id === "string" ? link.independence_group_id : undefined });
    }
    links = await readEvolutionLinks(client, p.scopeFingerprint, [primaryId]);
  }
  const ids: string[] = [];
  for (const row of ordered) {
    const id = String(row.id), alias = p.operation === "merge_equivalent" && id !== primaryId;
    const metadata = boundedJson(object(row.metadata)), governance = object(metadata.governance), evolution = { ...object(governance.evolution) };
    const relevant = links.filter(link => link.target_memory_id === id);
    if ((p.operation === "add_evidence" || p.operation === "merge_equivalent") && !alias) {
      const effective = relevant.filter(link => link.relation_state === "effective"), readable = relevant.filter(link => ["effective", "reviewed_reference"].includes(String(link.relation_state)));
      const oldIds = Array.isArray(governance.evidenceIds) ? governance.evidenceIds.filter((value): value is string => typeof value === "string") : [];
      const evidenceIds = [...new Set([...oldIds, ...readable.map(link => String(link.evidence_memory_id))])].sort();
      if (evidenceIds.length > 64) fail("EVIDENCE_LINK_LIMIT");
      governance.evidenceIds = evidenceIds; metadata.sourceNodeIds = evidenceIds;
      const candidate = object(governance.candidate); candidate.evidence = { ...object(candidate.evidence), eventIds: evidenceIds }; governance.candidate = candidate;
      evolution.effectiveRootIds = [...new Set(effective.flatMap(link => typeof link.root_evidence_id === "string" ? [link.root_evidence_id] : []))].sort();
      const prior = Number(metadata.confidence ?? 0), type = verified.targets.find(target => target.memoryId === id)?.semanticType;
      const computed = recomputeEvolutionConfidence(type, relevant, prior);
      metadata.confidence = p.operation === "merge_equivalent" ? Math.min(computed, ...rows.map(r => Number(object(r.metadata).confidence ?? 0))) : computed;
    }
    if (p.operation === "mark_disputed") evolution.disputed = true;
    if (p.operation === "revalidate") evolution.lastRevalidatedAt = now;
    if (alias) evolution.aliasOf = primaryId;
    evolution.lastOperationId = p.id;
    governance.evolution = evolution; metadata.governance = governance;
    if (alias || ["expire", "deprecate"].includes(p.operation)) {
      const validTo = p.validTo ?? now;
      if (typeof row.lineage_id === "string" && Number(row.revision) > 0) {
        if (!input.temporal) fail("temporal_close_unavailable");
        await input.temporal.closeHeadWithClient(client as PostgresTemporalMemoryClient, { scope: p.scope, lineageId: row.lineage_id, expectedHeadRevision: Number(row.revision), validTo, transitionType: "expired", reason: p.reasonCode, receipt: closingReceipt(verified, row, now) });
        await client.query(`/* evolution:metadata-version-origin */ UPDATE mengshu_memory_version_outbox SET evolution_origin=TRUE
WHERE scope_fingerprint=$1 AND lineage_id=$2 AND revision=$3 AND event_type='memory.version.closed' AND occurred_at=$4`, [p.scopeFingerprint,row.lineage_id,row.revision,now]);
      } else {
        const closed = await client.query(`/* evolution:legacy-expire */ UPDATE memories SET valid_to = to_timestamp($11::double precision/1000),
closed_at = to_timestamp($12::double precision/1000), lifecycle_status = 'archived'
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = $10 AND valid_to IS NULL AND lineage_id IS NULL RETURNING id::text AS id`, [...scopeParams(p.scope), id, validTo, now]);
        if (closed.rows[0]?.id !== id) fail("GOVERNANCE_TARGET_CHANGED");
      }
    }
    await persistEvolutionMetadata(client, p.scope, row, metadata, { now, ...(p.operation === "mark_disputed" ? { disputed: true } : {}), ...(alias ? { aliasOf: primaryId } : {}), dueAt: p.operation === "mark_disputed" ? now : now + 604800000 });
    await appendEvolutionMutationEvent(client, p.scope, id, p.id, now);
    const closing = alias || ["expire", "deprecate"].includes(p.operation), validTo = p.validTo ?? now;
    after.push(evolutionGovernanceState({ ...row, metadata, evolution_disputed: p.operation === "mark_disputed" || row.evolution_disputed === true,
      evolution_alias_of: alias ? primaryId : row.evolution_alias_of, evolution_review_due_at: p.operation === "mark_disputed" ? now : now + 604800000,
      ...(closing ? { valid_to_ms: validTo, ...(validTo <= now || row.lineage_id == null ? { closed_at_ms: now, lifecycle_status: "archived" } : {}) } : {}) }));
    ids.push(id);
  }
  const afterLinks = evolutionLinkState(await readEvolutionLinks(client, p.scopeFingerprint, ids));
  const receipt = boundedJson({ id: jsonHash(["evolution-metadata", p.scopeFingerprint, p.id]), proposalId: p.id, operation: p.operation, memoryIds: ids,
    before, after, beforeLinks, afterLinks, currentStateHash: evolutionGovernanceSnapshotHash(after, afterLinks), at: integer(now),
    ...(p.operation === "merge_equivalent" ? { canonicalId: primaryId, aliasIds: ids.slice(1), retainedHistory: true } : {}) }, 32768);
  await client.query(`/* evolution:metadata-receipt */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint, idempotency_key, request_hash, operation, receipt, created_at) VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
  [p.scopeFingerprint, `proposal:${p.id}`, jsonHash([p.id, p.operation, p.targetRefs, p.quotes]), p.operation, JSON.stringify(receipt), now]);
  return ids;
}
