import type { MemoryScope } from "../domain/types.js";
import type { MaintenanceBudget, MaintenanceDuePort, MaintenanceRetentionPort, MaintenanceWorkItem, RetentionCandidate } from "./maintenance/types.js";
import { boundedJson, checkedHash, DB_NOW_MS, fail, integer, jsonHash, lockLease, PostgresEvolutionError, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { decodeEvolutionOriginalEvidence, EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import { EVOLUTION_CANDIDATE_SCOPE_SQL, proposalRequestHash, type PostgresEvolutionRepository } from "./postgres-repository.js";
import type { EvolutionLease } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rawExpiry = `CASE WHEN metadata #>> '{evolutionEvidence,expiresAt}' ~ '^[0-9]{1,16}$' THEN (metadata #>> '{evolutionEvidence,expiresAt}')::bigint END`;
const proposalExpiry = `CASE WHEN metadata #>> '{evolution,expiresAt}' ~ '^[0-9]{1,16}$' THEN (metadata #>> '{evolution,expiresAt}')::bigint END`;
function dueRevision(row: Record<string, unknown>): string { return jsonHash([row.id, row.revision ?? 0, row.content_hash, row.evolution_review_due_at, object(object(object(row.metadata).governance).evolution).lastAttemptAt ?? null]); }

/** Short, reference-aware retention transactions. No canonical/history/receipt purge API. */
export class PostgresEvolutionMaintenancePort implements MaintenanceDuePort, MaintenanceRetentionPort {
  readonly #now: () => number;
  readonly #read: PostgresEvolutionQueryClient;
  constructor(private readonly options: { repository: PostgresEvolutionRepository; readClient?: PostgresEvolutionQueryClient; now?: () => number; workBudget?: MaintenanceBudget }) {
    this.#now = options.now ?? Date.now; this.#read = options.readClient ?? options.repository.pool;
  }
  async listDue(input: { now: number; limit: number }): Promise<MaintenanceWorkItem[]> {
    const { repository } = this.options;
    if (integer(input.limit, 100) < 1) fail("INVALID_DUE_LIMIT"); integer(input.now);
    const budget = this.options.workBudget;
    if (!budget || Object.values(budget).some(value => !Number.isSafeInteger(value) || value < 0) ||
      (budget.llmCalls > 0 || budget.inputTokens > 0 || budget.outputTokens > 0) && budget.costMicros <= 0) fail("PRICED_MAINTENANCE_BUDGET_REQUIRED");
    const rows = (await this.#read.query(`/* evolution:maintenance-due */ SELECT id::text AS id, revision, content_hash, metadata, evolution_review_due_at
FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND evolution_review_due_at <= $10 AND evolution_alias_of IS NULL
AND temporal_purge_pending IS NOT TRUE AND temporal_invalidated IS NOT TRUE AND valid_to IS NULL
AND (lineage_id IS NULL OR temporal_activation_state='active')
AND (lifecycle_status='active' AND metadata->>'admissionRoute'='active' OR lifecycle_status='archived' AND metadata->>'admissionRoute'='lookup_only')
AND octet_length(COALESCE(metadata,'{}'::jsonb)::text)<=65536
ORDER BY CASE WHEN metadata #>> '{governance,evolution,lastAttemptAt}' ~ '^[0-9]{1,16}$'
  THEN (metadata #>> '{governance,evolution,lastAttemptAt}')::bigint END NULLS FIRST, evolution_review_due_at, id LIMIT $11`, [...scopeParams(repository.scope), input.now, input.limit])).rows;
    if (rows.length > input.limit) fail("DUE_LIMIT");
    return rows.map(row => {
      const attempt = object(object(object(row.metadata).governance).evolution).lastAttemptAt;
      return { id: `revalidate:${requiredId(row.id)}`, kind: "revalidate", scope: repository.scope, revision: dueRevision(row), dueAt: integer(Number(row.evolution_review_due_at)),
        ...(typeof attempt === "number" ? { lastAttemptAt: integer(attempt) } : {}), budget: boundedJson(budget) };
    });
  }
  async markEnqueued(input: { scope: MemoryScope; id: string; expectedRevision: string; at: number; jobId: string }): Promise<void> {
    const { repository } = this.options; repository.assertScope(scopedFingerprint(input.scope), input.scope);
    if (!input.id.startsWith("revalidate:")) fail("UNKNOWN_MAINTENANCE_ITEM");
    const id = requiredId(input.id.slice("revalidate:".length)); checkedHash(input.expectedRevision); requiredId(input.jobId); integer(input.at);
    await repository.mutation(async client => {
      const row = (await client.query(`/* evolution:maintenance-enqueue-lock */ SELECT id::text AS id,revision,content_hash,metadata,evolution_review_due_at FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10 FOR UPDATE`, [...scopeParams(input.scope), id])).rows[0];
      if (!row) fail("MAINTENANCE_ITEM_CHANGED");
      const metadata = boundedJson(object(row.metadata)), governance = object(metadata.governance), evolution = object(governance.evolution);
      if (evolution.enqueuedJobId === input.jobId && evolution.lastAttemptAt === input.at) return;
      if (dueRevision(row) !== input.expectedRevision) fail("MAINTENANCE_ITEM_CHANGED");
      evolution.lastAttemptAt = input.at; evolution.enqueuedJobId = input.jobId; governance.evolution = evolution; metadata.governance = governance;
      await client.query(`/* evolution:maintenance-enqueue */ UPDATE memories SET metadata=$11::jsonb,evolution_review_due_at=$12,
temporal_snapshot=CASE WHEN temporal_snapshot IS NULL THEN NULL ELSE jsonb_set(temporal_snapshot,'{record,metadata}',$11::jsonb) END
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10`, [...scopeParams(input.scope), id, JSON.stringify(metadata), input.at + 3600000]);
    });
  }
  async recordOutcome(input: Parameters<MaintenanceRetentionPort["recordOutcome"]>[0]): Promise<void> {
    const { repository } = this.options; repository.assertScope(scopedFingerprint(input.scope), input.scope);
    checkedHash(input.fingerprint); checkedHash(input.eventId); requiredId(input.workId); requiredId(input.inputFingerprint); requiredId(input.policyVersion);
    integer(input.at); integer(input.retryAfter);
    if (!["noop", "rejected", "failed"].includes(input.outcome) || !/^[a-z][a-z0-9_]{0,79}$/.test(input.reasonCode)) fail("INVALID_OUTCOME");
    await repository.mutation(async client => {
      const event = await client.query(`/* evolution:outcome-event */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES($1,$2,$3,'outcome_event',$4::jsonb,$5)
ON CONFLICT(scope_fingerprint,idempotency_key) DO NOTHING RETURNING idempotency_key`,
      [repository.scopeFingerprint, `outcome-event:${input.eventId}`, input.fingerprint, JSON.stringify({ fingerprint: input.fingerprint }), input.at]);
      if (!event.rows.length) return;
      const summary = { fingerprint: input.fingerprint, workId: input.workId, inputFingerprint: input.inputFingerprint, policyVersion: input.policyVersion, outcome: input.outcome, reasonCode: input.reasonCode, retryAfter: input.retryAfter, count: 1, firstAt: input.at, lastAt: input.at };
      await client.query(`/* evolution:outcome-summary */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES($1,$2,$3,'outcome_summary',$4::jsonb,$5)
ON CONFLICT(scope_fingerprint,idempotency_key) DO UPDATE SET receipt=EXCLUDED.receipt || jsonb_build_object(
'count',COALESCE((mengshu_evolution_operation_receipts.receipt->>'count')::bigint,0)+1,
'firstAt',LEAST((mengshu_evolution_operation_receipts.receipt->>'firstAt')::bigint,$5::bigint)),created_at=GREATEST(mengshu_evolution_operation_receipts.created_at,EXCLUDED.created_at)`,
      [repository.scopeFingerprint, `outcome:${input.fingerprint}`, input.fingerprint, JSON.stringify(summary), input.at]);
    });
  }
  async listExpired(input: { scope: MemoryScope; before: number; limit: number }): Promise<RetentionCandidate[]> {
    const { repository } = this.options; repository.assertScope(scopedFingerprint(input.scope), input.scope);
    if (integer(input.limit, 100) < 1) fail("INVALID_RETENTION_LIMIT"); integer(input.before);
    const raw = (await this.#read.query(`/* evolution:retention-list */ SELECT id::text AS id,content_hash,metadata->'evolutionEvidence' AS origin,${rawExpiry} AS expires_at
FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND metadata->>'admissionRoute'='evidence_only' AND metadata ? 'evolutionEvidence'
AND lineage_id IS NULL AND temporal_purge_pending IS NOT TRUE AND temporal_invalidated IS NOT TRUE AND lifecycle_status='archived'
AND ${rawExpiry} <= $10 ORDER BY ${rawExpiry},id LIMIT $11`, [...scopeParams(input.scope), input.before, input.limit])).rows;
    const result: RetentionCandidate[] = raw.map(row => ({ id: requiredId(row.id), revision: jsonHash([row.id,row.content_hash,row.origin]), kind: "orphan_evidence", expiresAt: integer(Number(row.expires_at)) }));
    const remaining = input.limit - result.length;
    if (remaining < 1) return result;
    const proposals = (await this.#read.query(`/* evolution:retention-proposals */ SELECT id,metadata #>> '{evolution,requestHash}' AS revision,
metadata #>> '{evolution,proposal,status}' AS proposal_status,${proposalExpiry} AS expires_at FROM mengshu_candidates
WHERE ${EVOLUTION_CANDIDATE_SCOPE_SQL} AND metadata #>> '{evolution,version}'='1' AND metadata #>> '{evolution,pruned}' IS DISTINCT FROM 'true'
AND metadata #>> '{evolution,proposal,status}' IN ('rejected','noop') AND ${proposalExpiry} <= $10
ORDER BY ${proposalExpiry},id LIMIT $11`, [...scopeParams(input.scope), input.before, remaining])).rows;
    return [...result, ...proposals.map(row => ({ id: requiredId(row.id), revision: checkedHash(String(row.revision)), kind: row.proposal_status === "noop" ? "noop_proposal_body" as const : "rejected_proposal_body" as const, expiresAt: integer(Number(row.expires_at)) }))];
  }
  async cleanupUnreferenced(input: Parameters<MaintenanceRetentionPort["cleanupUnreferenced"]>[0]): Promise<{ status: "deleted" | "referenced" | "stale"; receiptId?: string }> {
    const { repository } = this.options; repository.assertScope(scopedFingerprint(input.scope), input.scope);
    const candidate = boundedJson(input.candidate); requiredId(candidate.id); checkedHash(candidate.revision); integer(candidate.expiresAt);
    if (candidate.expiresAt > integer(this.#now())) return { status: "stale" };
    const requestHash = jsonHash(candidate), key = `retention:${requestHash}`;
    return repository.mutation<{ status: "deleted" | "referenced" | "stale"; receiptId?: string }>(async client => {
      if (candidate.kind === "orphan_evidence") {
        await client.query("SELECT set_config('statement_timeout', '500ms', true), set_config('idle_in_transaction_session_timeout', '1000ms', true)");
        // Legacy references lack UUID FKs. Try all table locks before row locks; never queue behind foreground writers.
        await client.query(`LOCK TABLE memories, mengshu_candidates, mengshu_memory_evidence_links,
mengshu_graph_entity_evidence, mengshu_graph_relation_evidence, mengshu_graph_entity_aliases,
mengshu_graph_entity_resolution_ledger, mengshu_graph_relation_resolution_ledger,
mengshu_session_working_set_entries, mengshu_asset_versions, mengshu_skill_asset_versions, mengshu_skill_candidates,
mengshu_work_memory_nodes, mengshu_work_memory_edges IN SHARE MODE NOWAIT`);
      }
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId);
      const prior = (await client.query(`/* evolution:retention-receipt-get */ SELECT receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND idempotency_key=$2`, [repository.scopeFingerprint,key])).rows[0];
      if (prior) return boundedJson(prior.receipt) as { status: "deleted"; receiptId: string };
      if (candidate.kind === "orphan_evidence") {
        const row = (await client.query(`/* evolution:retention-raw-lock */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10 FOR UPDATE`, [...scopeParams(input.scope),candidate.id])).rows[0];
        const origin = object(object(row?.metadata).evolutionEvidence);
        if (!row || row.lineage_id != null || !decodeEvolutionOriginalEvidence(row,input.scope) ||
          decodeEvolutionOriginalEvidence(row,input.scope)?.revoked || origin.expiresAt !== candidate.expiresAt || jsonHash([row.id,row.content_hash,origin]) !== candidate.revision) return { status: "stale" };
        const references = (await client.query(`/* evolution:retention-references */ SELECT (
EXISTS(SELECT 1 FROM mengshu_memory_evidence_links WHERE evidence_memory_id=$1 OR target_memory_id=$1)
OR EXISTS(SELECT 1 FROM memories WHERE id::text<>$1 AND (metadata #> '{governance,evidenceIds}' ? $1 OR metadata->'sourceNodeIds' ? $1
  OR temporal_snapshot #> '{record,sourceNodeIds}' ? $1 OR previous_version_id::text=$1 OR restored_from_version_id::text=$1 OR evolution_alias_of::text=$1))
OR EXISTS(SELECT 1 FROM mengshu_candidates WHERE evidence_ids ? $1 OR promoted_to_memory_id=$1 OR
  (status='pending' AND ${proposalExpiry} > ${DB_NOW_MS} AND jsonb_path_exists(metadata, '$.evolution.evidence[*] ? (@.id == $source)', jsonb_build_object('source',$2::text))))
OR EXISTS(SELECT 1 FROM mengshu_graph_entity_evidence WHERE evidence_memory_id=$1)
OR EXISTS(SELECT 1 FROM mengshu_graph_relation_evidence WHERE evidence_memory_id=$1)
OR EXISTS(SELECT 1 FROM mengshu_graph_entity_aliases WHERE evidence_memory_id=$1)
OR EXISTS(SELECT 1 FROM mengshu_graph_entity_resolution_ledger WHERE evidence_memory_id=$1)
OR EXISTS(SELECT 1 FROM mengshu_graph_relation_resolution_ledger WHERE evidence_memory_id=$1)
OR EXISTS(SELECT 1 FROM mengshu_work_memory_nodes WHERE record_id=$1 OR evidence_memory_ids ? $1 OR evidence_chunk_ids ? $1)
OR EXISTS(SELECT 1 FROM mengshu_work_memory_edges WHERE evidence_chunk_ids ? $1)
OR EXISTS(SELECT 1 FROM mengshu_session_working_set_entries WHERE evidence_refs ? $1 OR jsonb_path_exists(evidence_refs,'$.** ? (@ == $id)',jsonb_build_object('id',$1::text)))
OR EXISTS(SELECT 1 FROM mengshu_asset_versions WHERE jsonb_path_exists(descriptor,'$.** ? (@ == $id)',jsonb_build_object('id',$1::text)))
OR EXISTS(SELECT 1 FROM mengshu_skill_asset_versions WHERE jsonb_path_exists(artifact,'$.** ? (@ == $id)',jsonb_build_object('id',$1::text)))
OR EXISTS(SELECT 1 FROM mengshu_skill_candidates WHERE jsonb_path_exists(candidate,'$.** ? (@ == $id)',jsonb_build_object('id',$1::text)))
) AS referenced`, [candidate.id, String(origin.sourceEvidenceId)])).rows[0];
        if (!references || references.referenced !== false) return { status: "referenced" };
        const deleted = await client.query(`/* evolution:retention-delete */ DELETE FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10
AND lineage_id IS NULL AND temporal_purge_pending IS NOT TRUE AND metadata->>'admissionRoute'='evidence_only'
AND ${rawExpiry} <= ${DB_NOW_MS} RETURNING id::text AS id`, [...scopeParams(input.scope),candidate.id]);
        if (deleted.rows[0]?.id !== candidate.id) return { status: "stale" };
      } else if (["noop_proposal_body","rejected_proposal_body"].includes(candidate.kind)) {
        const envelope = await repository.readEnvelope(client,candidate.id);
        if (!envelope || envelope.requestHash !== candidate.revision || envelope.expiresAt !== candidate.expiresAt || !["rejected","noop"].includes(envelope.proposal.status)) return { status: "stale" };
        const { proposedText: _text, ...proposal } = envelope.proposal;
        const compact = { ...envelope, proposal: { ...proposal, quotes: [] }, evidence: [], pruned: true, originalRequestHash: envelope.requestHash };
        compact.requestHash = proposalRequestHash(compact.proposal,[]);
        const changed = await client.query(`/* evolution:retention-proposal-prune */ UPDATE mengshu_candidates SET text=$11,
metadata=jsonb_set(metadata,'{evolution}',$12::jsonb),status='rejected',active_content_hash=NULL
WHERE ${EVOLUTION_CANDIDATE_SCOPE_SQL} AND id=$10 AND metadata #>> '{evolution,requestHash}'=$13
AND ${proposalExpiry} <= ${DB_NOW_MS} RETURNING id`, [...scopeParams(input.scope),candidate.id,JSON.stringify({ evolutionProposal:candidate.id,pruned:true }),JSON.stringify(compact),candidate.revision]);
        if (changed.rows[0]?.id !== candidate.id) return { status: "stale" };
      } else return { status: "stale" };
      const receipt = { status: "deleted" as const, receiptId: jsonHash(["evolution-retention",repository.scopeFingerprint,key]) };
      await client.query(`/* evolution:retention-receipt */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES($1,$2,$3,'retention',$4::jsonb,${DB_NOW_MS})`, [repository.scopeFingerprint,key,requestHash,JSON.stringify({ ...receipt,candidateId:candidate.id,kind:candidate.kind,revision:candidate.revision })]);
      await lockLease(client,input.lease,repository.scopeFingerprint,input.lease.batchId);
      return receipt;
    }).catch(error => {
      if (error instanceof PostgresEvolutionError && ["LOCK_BUSY", "QUERY_TIMEOUT"].includes(error.code)) return { status: "stale" as const };
      throw error;
    });
  }
  async pruneMetadata(input: { lease: EvolutionLease; limit: number }): Promise<{ outcomeEvents: number }> {
    const { repository } = this.options;
    if (integer(input.limit,1000)<1) fail("INVALID_RETENTION_LIMIT");
    return repository.mutation(async client => {
      await lockLease(client,input.lease,repository.scopeFingerprint,input.lease.batchId);
      const result = await client.query(`/* evolution:retention-outcome-events */ WITH expired AS (
SELECT scope_fingerprint,idempotency_key FROM mengshu_evolution_operation_receipts
WHERE scope_fingerprint=$1 AND operation='outcome_event' AND created_at < ${DB_NOW_MS}-2592000000
ORDER BY created_at,idempotency_key LIMIT $2 FOR UPDATE SKIP LOCKED)
DELETE FROM mengshu_evolution_operation_receipts r USING expired e WHERE r.scope_fingerprint=e.scope_fingerprint AND r.idempotency_key=e.idempotency_key RETURNING r.idempotency_key`, [repository.scopeFingerprint,input.limit]);
      return { outcomeEvents: result.rows.length };
    });
  }
}
