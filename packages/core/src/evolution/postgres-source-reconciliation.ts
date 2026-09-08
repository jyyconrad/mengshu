import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import { appendEvolutionMutationEvent, persistEvolutionMetadata, readEvolutionLinks, recomputeEvolutionConfidence } from "./governed-metadata.js";
import { boundedJson, checkedHash, fail, integer, jsonHash, lockLease, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionClient, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import type { PostgresEvolutionRepository } from "./postgres-repository.js";
import type { SourceReconciliationPlan, SourceReconciliationPort } from "./sources/reconciliation-types.js";
import type { SourceCommitReceipt } from "./sources/types.js";

export interface EvolutionAdministrativeReviewRequest {
  operation: "source_revoke" | "undo_governance";
  reviewReceiptId: string;
  scopeFingerprint: string;
  bindingHash: string;
  target: { sourceId: string; revision: string } | { operationReceiptId: string; currentStateHash: string };
  idempotencyKey: string;
}
/** Host-only: lock, verify and consume an exact administrative approval on the supplied client. */
export type PostgresEvolutionAdministrativeReviewGuard = (client: PostgresEvolutionQueryClient, request: EvolutionAdministrativeReviewRequest) => Promise<void>;
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Shared with explicit revoke. Retiring evidence is not rewriting the historical quote. */
export async function retireEvolutionSourceLinks(client: PostgresEvolutionClient, input: {
  scope: MemoryScope; scopeFingerprint: string; links: Record<string, unknown>[]; state: "superseded" | "revoked"; operationId: string; now: number;
}): Promise<string[]> {
  if (input.links.length > 256) fail("SOURCE_RELATION_LIMIT");
  const ids = [...new Set(input.links.map(link => requiredId(link.target_memory_id)))].sort();
  if (!ids.length) return [];
  const heads = (await client.query(`/* evolution:source-target-heads */ SELECT id::text AS id, lineage_id FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = ANY($10::text[])`, [...scopeParams(input.scope), ids])).rows;
  for (const lineage of [...new Set(heads.flatMap(row => typeof row.lineage_id === "string" ? [row.lineage_id] : []))].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory-lineage:${input.scopeFingerprint}:${lineage}`]);
  const rows = (await client.query(`/* evolution:source-target-lock */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = ANY($10::text[]) AND temporal_purge_pending IS NOT TRUE ORDER BY id FOR UPDATE`, [...scopeParams(input.scope), ids])).rows;
  if (rows.length !== ids.length) fail("SOURCE_TARGET_CHANGED");
  const updated = await client.query(`/* evolution:source-retire */ UPDATE mengshu_memory_evidence_links
SET relation_state = $3, retired_at = $4 WHERE scope_fingerprint = $1 AND link_id = ANY($2::text[])
AND relation_state IN ('effective','reviewed_reference','contradicting') RETURNING link_id`, [input.scopeFingerprint, input.links.map(link => requiredId(link.link_id)), input.state, input.now]);
  if (updated.rows.length !== input.links.length) fail("SOURCE_RELATION_CHANGED");
  for (const row of rows) {
    const id = String(row.id), links = await readEvolutionLinks(client, input.scopeFingerprint, [id]);
    const metadata = boundedJson(object(row.metadata)), governance = object(metadata.governance), evolution = object(governance.evolution);
    const retiredIds = new Set(links.filter(link => ["superseded", "revoked"].includes(String(link.relation_state))).map(link => String(link.evidence_memory_id)));
    const oldIds = Array.isArray(governance.evidenceIds) ? governance.evidenceIds.filter((value): value is string => typeof value === "string") : [];
    const readable = links.filter(link => ["effective", "reviewed_reference"].includes(String(link.relation_state))).map(link => String(link.evidence_memory_id));
    const evidenceIds = [...new Set([...oldIds.filter(value => !retiredIds.has(value)), ...readable])].sort();
    governance.evidenceIds = evidenceIds; metadata.sourceNodeIds = evidenceIds;
    const candidate = object(governance.candidate); candidate.evidence = { ...object(candidate.evidence), eventIds: evidenceIds }; governance.candidate = candidate;
    evolution.effectiveRootIds = [...new Set(links.filter(link => link.relation_state === "effective").flatMap(link => typeof link.root_evidence_id === "string" ? [link.root_evidence_id] : []))].sort();
    evolution.needsReview = true; evolution.lastSourceReconciliationId = input.operationId;
    governance.evolution = evolution; metadata.governance = governance;
    metadata.confidence = Math.min(Number(metadata.confidence ?? 0), recomputeEvolutionConfidence(metadata.semanticType as MemorySemanticType | undefined, links, Number(metadata.confidence ?? 0)));
    await persistEvolutionMetadata(client, input.scope, row, metadata, { now: input.now, dueAt: input.now });
    await appendEvolutionMutationEvent(client, input.scope, id, input.operationId, input.now);
  }
  return ids;
}

export class PostgresEvolutionSourceReconciliationPort implements SourceReconciliationPort {
  readonly #now: () => number;
  constructor(private readonly options: {
    repository: PostgresEvolutionRepository; sourceId: string; configFingerprint: string;
    now?: () => number; authorizeAdministrativeReview?: PostgresEvolutionAdministrativeReviewGuard;
  }) {
    requiredId(options.sourceId); checkedHash(options.configFingerprint); this.#now = options.now ?? Date.now;
  }
  async #lock(client: PostgresEvolutionQueryClient): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-source:${this.options.repository.scopeFingerprint}:${this.options.sourceId}`]);
  }
  async reconcile(input: Parameters<SourceReconciliationPort["reconcile"]>[0]): Promise<SourceCommitReceipt> {
    const { repository } = this.options, plan = boundedJson(input.plan), { id, ...body } = plan;
    repository.assertScope(scopedFingerprint(plan.scope), plan.scope);
    if (plan.sourceId !== this.options.sourceId || plan.configFingerprint !== this.options.configFingerprint || checkedHash(id) !== jsonHash(body) ||
      plan.records.length > 256 || plan.events.length > 128 || plan.recordIds.length > 256 || jsonHash([...new Set(plan.records.map(r => r.id))].sort()) !== jsonHash(plan.recordIds)) fail("SOURCE_PLAN_INVALID");
    checkedHash(plan.snapshotHash);
    for (const event of plan.events) {
      requiredId(event.pathId); requiredId(event.logicalFileId);
      if (!event.preserveHistoricalEvidence || event.spanIds.length > 256) fail("SOURCE_PLAN_INVALID");
      event.spanIds.forEach(requiredId);
      if (event.kind === "source_unavailable" && !plan.enumerationComplete) fail("SOURCE_ENUMERATION_REQUIRED");
      if (["supersede_spans", "history_revised"].includes(event.kind) && (!event.previousRevisionId || !event.revisionId || event.kind === "supersede_spans" && event.semantics !== "current_document")) fail("SOURCE_REVISION_REQUIRED");
    }
    return repository.mutation(async client => {
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId);
      await this.#lock(client);
      const tombstone = (await client.query(`/* evolution:source-global-lock */ SELECT revision, disposition FROM mengshu_evolution_source_dispositions
WHERE scope_fingerprint = $1 AND source_id = $2 AND logical_file_id = '' FOR UPDATE`, [repository.scopeFingerprint, plan.sourceId])).rows[0];
      if (tombstone?.disposition === "revoked") fail("SOURCE_REVOKED");
      if (!(await input.verifySource()).valid) fail("SOURCE_CHANGED");
      const prior = (await client.query(`/* evolution:source-prior-receipt */ SELECT request_hash, receipt FROM mengshu_evolution_operation_receipts
WHERE scope_fingerprint = $1 AND idempotency_key = $2`, [repository.scopeFingerprint, `source:${plan.id}`])).rows[0];
      if (prior) { if (prior.request_hash !== plan.id) fail("SOURCE_RECEIPT_CONFLICT"); return boundedJson(prior.receipt) as unknown as SourceCommitReceipt; }
      const now = integer(this.#now());
      const files = [...new Set(plan.events.map(event => event.logicalFileId))].sort();
      for (const file of files) {
        const events = plan.events.filter(event => event.logicalFileId === file), event = events.find(e => e.revisionId) ?? events[0]!;
        const previous = (await client.query(`/* evolution:source-file-lock */ SELECT revision, disposition FROM mengshu_evolution_source_dispositions
WHERE scope_fingerprint = $1 AND source_id = $2 AND logical_file_id = $3 FOR UPDATE`, [repository.scopeFingerprint, plan.sourceId, file])).rows[0];
        if (previous?.disposition === "revoked" || previous && previous.revision !== event.previousRevisionId && previous.revision !== event.revisionId) fail("SOURCE_REVISION_STALE");
        for (const removal of events.filter(e => ["supersede_spans", "history_revised"].includes(e.kind))) {
          const links = (await client.query(`/* evolution:source-retire-select */ SELECT * FROM mengshu_memory_evidence_links
WHERE scope_fingerprint = $1 AND source_id = $2 AND (source_logical_file_id = $3 OR source_path_id = $4)
AND COALESCE(source_current_revision, source_revision) = $5 AND source_span_id = ANY($6::text[])
AND relation_state IN ('effective','reviewed_reference','contradicting') ORDER BY target_memory_id, link_id LIMIT 257`,
          [repository.scopeFingerprint, plan.sourceId, file, removal.pathId, removal.previousRevisionId, removal.spanIds])).rows;
          await retireEvolutionSourceLinks(client, { scope: plan.scope, scopeFingerprint: repository.scopeFingerprint, links, state: "superseded", operationId: plan.id, now });
        }
        if (events.some(e => e.requestReview)) await client.query(`/* evolution:source-mark-due */ UPDATE memories SET evolution_review_due_at = $3
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + 3}`)} AND id::text IN
(SELECT target_memory_id FROM mengshu_memory_evidence_links WHERE scope_fingerprint = $1 AND source_id = $2 AND (source_logical_file_id = $13 OR source_path_id = $14))`,
        [repository.scopeFingerprint, plan.sourceId, now, ...scopeParams(plan.scope), file, event.pathId]);
        const revision = event.revisionId ?? event.previousRevisionId;
        if (!revision) fail("SOURCE_REVISION_REQUIRED");
        await client.query(`/* evolution:source-file-save */ INSERT INTO mengshu_evolution_source_dispositions
(scope_fingerprint,source_id,logical_file_id,revision,source_hash,disposition,receipt_id,changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
ON CONFLICT (scope_fingerprint,source_id,logical_file_id) DO UPDATE SET revision=EXCLUDED.revision, source_hash=EXCLUDED.source_hash,
disposition=EXCLUDED.disposition, receipt_id=EXCLUDED.receipt_id, changed_at=EXCLUDED.changed_at`,
        [repository.scopeFingerprint, plan.sourceId, file, revision, plan.snapshotHash, events.some(e => ["source_unavailable", "history_rotated"].includes(e.kind)) ? "unavailable" : "current", plan.id, now]);
        if (event.revisionId) await client.query(`/* evolution:source-advance-relations */ UPDATE mengshu_memory_evidence_links
SET source_current_revision=$5, source_logical_file_id=$3 WHERE scope_fingerprint=$1 AND source_id=$2
AND (source_logical_file_id=$3 OR source_path_id=$4) AND relation_state IN ('effective','reviewed_reference','contradicting')`, [repository.scopeFingerprint, plan.sourceId, file, event.pathId, event.revisionId]);
      }
      for (const record of plan.records) await client.query(`/* evolution:source-record-bind */ UPDATE mengshu_memory_evidence_links
SET source_logical_file_id=$4, source_span_id=$5, continuity_key=$6, independence_group_id=$7, source_current_revision=$8
WHERE scope_fingerprint=$1 AND source_id=$2 AND source_record_id=$3 AND root_evidence_id=$9 AND source_revision=$8`,
      [repository.scopeFingerprint, plan.sourceId, record.id, record.logicalFileId, record.spanOrEventId, record.continuityKey, record.independenceGroupId, record.revisionId, record.rootEvidenceId]);
      const receipt: SourceCommitReceipt = { receiptId: plan.id, sourceSnapshotHash: plan.snapshotHash, recordIds: plan.recordIds };
      boundedJson(receipt, 32768);
      await client.query(`/* evolution:source-receipt */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES ($1,$2,$3,'source_reconcile',$4::jsonb,$5)`, [repository.scopeFingerprint, `source:${plan.id}`, plan.id, JSON.stringify(receipt), now]);
      await client.query(`/* evolution:source-global-save */ INSERT INTO mengshu_evolution_source_dispositions
(scope_fingerprint,source_id,logical_file_id,revision,source_hash,disposition,receipt_id,changed_at) VALUES ($1,$2,'',$3,$3,'current',$4,$5)
ON CONFLICT(scope_fingerprint,source_id,logical_file_id) DO UPDATE SET revision=EXCLUDED.revision,source_hash=EXCLUDED.source_hash,receipt_id=EXCLUDED.receipt_id,changed_at=EXCLUDED.changed_at`, [repository.scopeFingerprint, plan.sourceId, plan.snapshotHash, plan.id, now]);
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId);
      return receipt;
    });
  }
  async revoke(input: Parameters<SourceReconciliationPort["revoke"]>[0]): Promise<{ receiptId: string; affectedMemoryIds: string[]; suppressed: true }> {
    const { repository, authorizeAdministrativeReview } = this.options;
    repository.assertScope(scopedFingerprint(input.scope), input.scope);
    if (input.sourceId !== this.options.sourceId) fail("SOURCE_SCOPE_MISMATCH");
    if (!authorizeAdministrativeReview) fail("source_revoke_review_unavailable");
    requiredId(input.idempotencyKey); requiredId(input.expectedRevision); requiredId(input.reviewReceiptId);
    const binding = { operation: "source_revoke" as const, scopeFingerprint: repository.scopeFingerprint, target: { sourceId: input.sourceId, revision: input.expectedRevision }, idempotencyKey: input.idempotencyKey };
    const bindingHash = jsonHash(binding);
    return repository.mutation(async client => {
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId); await this.#lock(client);
      const prior = (await client.query(`/* evolution:source-revoke-receipt */ SELECT request_hash, receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND idempotency_key=$2`, [repository.scopeFingerprint, `revoke:${input.idempotencyKey}`])).rows[0];
      if (prior) { if (prior.request_hash !== bindingHash) fail("SOURCE_RECEIPT_CONFLICT"); return boundedJson(prior.receipt) as { receiptId: string; affectedMemoryIds: string[]; suppressed: true }; }
      await authorizeAdministrativeReview(client, { ...binding, reviewReceiptId: input.reviewReceiptId, bindingHash });
      const state = (await client.query(`/* evolution:source-global-lock */ SELECT revision, disposition FROM mengshu_evolution_source_dispositions WHERE scope_fingerprint=$1 AND source_id=$2 AND logical_file_id='' FOR UPDATE`, [repository.scopeFingerprint, input.sourceId])).rows[0];
      if (!state || state.revision !== input.expectedRevision) fail("SOURCE_REVISION_STALE");
      const links = (await client.query(`/* evolution:source-revoke-select */ SELECT * FROM mengshu_memory_evidence_links WHERE scope_fingerprint=$1 AND source_id=$2 AND relation_state IN ('effective','reviewed_reference','contradicting') ORDER BY target_memory_id,link_id LIMIT 257`, [repository.scopeFingerprint, input.sourceId])).rows;
      const now = integer(this.#now()), receiptId = jsonHash(["source-revoke", bindingHash]);
      const affectedMemoryIds = await retireEvolutionSourceLinks(client, { scope: input.scope, scopeFingerprint: repository.scopeFingerprint, links, state: "revoked", operationId: receiptId, now });
      await client.query(`/* evolution:source-revoke-state */ UPDATE mengshu_evolution_source_dispositions SET disposition='revoked',receipt_id=$3,changed_at=$4 WHERE scope_fingerprint=$1 AND source_id=$2`, [repository.scopeFingerprint, input.sourceId, receiptId, now]);
      const receipt = { receiptId, affectedMemoryIds, suppressed: true as const };
      await client.query(`/* evolution:source-revoke-commit */ INSERT INTO mengshu_evolution_operation_receipts(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES ($1,$2,$3,'source_revoke',$4::jsonb,$5)`, [repository.scopeFingerprint, `revoke:${input.idempotencyKey}`, bindingHash, JSON.stringify(receipt), now]);
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId);
      return receipt;
    });
  }
}
