import type { MemoryScope } from "../domain/types.js";
import { appendEvolutionMutationEvent, EVOLUTION_REVERSIBLE_METADATA_KEYS, evolutionGovernanceSnapshotHash, evolutionGovernanceState, evolutionLinkState, persistEvolutionMetadata, readEvolutionLinks } from "./governed-metadata.js";
import { boundedJson, checkedHash, fail, integer, jsonHash, lockLease, requiredId, scopedFingerprint, scopeParams, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { decodeEvolutionOriginalEvidence, EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_ROW_BOUNDS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import type { PostgresEvolutionRepository } from "./postgres-repository.js";
import type { PostgresEvolutionAdministrativeReviewGuard } from "./postgres-source-reconciliation.js";
import type { EvolutionLease } from "./types.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function sourceIds(row: Record<string, unknown>): string[] {
  const metadata = object(row.metadata);
  return [object(metadata.evolutionEvidence).sourceId, object(object(metadata.governance).provenance).sourceId]
    .filter((value): value is string => typeof value === "string").map(requiredId);
}
interface UndoableReceipt {
  id: string; proposalId: string; operation: string; memoryIds: string[];
  before: Record<string, unknown>[]; after: Record<string, unknown>[];
  beforeLinks: Record<string, unknown>[]; afterLinks: Record<string, unknown>[];
  currentStateHash: string;
}
export interface PostgresEvolutionGovernanceUndoRequest {
  scope: MemoryScope; operationReceiptId: string; currentStateHash: string;
  reviewReceiptId: string; idempotencyKey: string; lease: EvolutionLease;
}

/** Administrative reversal of metadata/aliases only. Text, purge and source revocation are never reversed. */
export class PostgresEvolutionGovernanceUndoPort {
  readonly #now: () => number;
  constructor(private readonly options: {
    repository: PostgresEvolutionRepository; readClient?: PostgresEvolutionQueryClient; now?: () => number;
    authorizeAdministrativeReview?: PostgresEvolutionAdministrativeReviewGuard;
  }) { this.#now = options.now ?? Date.now; }
  async #original(client: PostgresEvolutionQueryClient, id: string): Promise<UndoableReceipt> {
    const row = (await client.query(`/* evolution:undo-original */ SELECT receipt FROM mengshu_evolution_operation_receipts
WHERE scope_fingerprint=$1 AND receipt ? 'id' AND receipt->>'id'=$2 LIMIT 1`, [this.options.repository.scopeFingerprint, checkedHash(id)])).rows[0];
    const receipt = boundedJson(row?.receipt ?? null, 32768) as UndoableReceipt | null;
    if (!receipt || receipt.id !== id || !["mark_disputed", "revalidate", "add_evidence", "merge_equivalent"].includes(receipt.operation) ||
      !Array.isArray(receipt.memoryIds) || receipt.memoryIds.length < 1 || receipt.memoryIds.length > 8 || new Set(receipt.memoryIds).size !== receipt.memoryIds.length ||
      !Array.isArray(receipt.before) || !Array.isArray(receipt.after) || receipt.before.length !== receipt.memoryIds.length || receipt.after.length !== receipt.memoryIds.length ||
      !Array.isArray(receipt.beforeLinks) || !Array.isArray(receipt.afterLinks) || receipt.beforeLinks.length > 128 || receipt.afterLinks.length > 128 ||
      receipt.currentStateHash !== evolutionGovernanceSnapshotHash(receipt.after, receipt.afterLinks)) fail("UNDO_RECEIPT_UNAVAILABLE");
    receipt.memoryIds.forEach(requiredId);
    if (receipt.before.some(state => !receipt.memoryIds.includes(String(state.id)) || state.aliasOf !== null || state.disputed !== false && state.disputed !== true)) fail("UNDO_RECEIPT_UNAVAILABLE");
    return receipt;
  }
  async #targets(client: PostgresEvolutionQueryClient, ids: string[], lock: boolean) {
    const rows = (await client.query(`/* evolution:undo-target${lock ? "-lock" : "-read"} */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL} AND id::text=ANY($10::text[]) AND temporal_purge_pending IS NOT TRUE
AND temporal_invalidated IS NOT TRUE AND lifecycle_status<>'revoked' ORDER BY id${lock ? " FOR UPDATE" : ""}`, [...scopeParams(this.options.repository.scope), ids])).rows;
    if (rows.length !== ids.length) fail("UNDO_STATE_CHANGED");
    return rows;
  }
  async previewUndo(input: { scope: MemoryScope; operationReceiptId: string }): Promise<{ operation: string; memoryIds: string[]; currentStateHash: string }> {
    const { repository } = this.options; repository.assertScope(scopedFingerprint(input.scope), input.scope);
    const client = this.options.readClient ?? repository.pool, receipt = await this.#original(client, input.operationReceiptId);
    const rows = await this.#targets(client, receipt.memoryIds, false), links = evolutionLinkState(await readEvolutionLinks(client, repository.scopeFingerprint, receipt.memoryIds));
    const currentStateHash = evolutionGovernanceSnapshotHash(rows.map(evolutionGovernanceState), links);
    if (currentStateHash !== receipt.currentStateHash) fail("UNDO_STATE_CHANGED");
    return { operation: receipt.operation, memoryIds: receipt.memoryIds, currentStateHash };
  }
  async undo(input: PostgresEvolutionGovernanceUndoRequest): Promise<{ receiptId: string; restoredMemoryIds: string[] }> {
    const { repository, authorizeAdministrativeReview } = this.options;
    repository.assertScope(scopedFingerprint(input.scope), input.scope);
    if (!authorizeAdministrativeReview) fail("undo_governance_review_unavailable");
    checkedHash(input.currentStateHash); checkedHash(input.operationReceiptId); requiredId(input.reviewReceiptId); requiredId(input.idempotencyKey);
    const binding = { operation: "undo_governance" as const, scopeFingerprint: repository.scopeFingerprint,
      target: { operationReceiptId: input.operationReceiptId, currentStateHash: input.currentStateHash }, idempotencyKey: input.idempotencyKey };
    const bindingHash = jsonHash(binding), key = `undo:${jsonHash(input.idempotencyKey)}`;
    return repository.mutation(async client => {
      await lockLease(client, input.lease, repository.scopeFingerprint, input.lease.batchId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-undo:${repository.scopeFingerprint}:${input.operationReceiptId}`]);
      const prior = (await client.query(`/* evolution:undo-replay */ SELECT request_hash,receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND idempotency_key=$2`, [repository.scopeFingerprint,key])).rows[0];
      if (prior) { if (prior.request_hash !== bindingHash) fail("UNDO_IDEMPOTENCY_CONFLICT"); return boundedJson(prior.receipt) as { receiptId: string; restoredMemoryIds: string[] }; }
      const receipt = await this.#original(client, input.operationReceiptId);
      if (receipt.currentStateHash !== input.currentStateHash) fail("UNDO_STATE_CHANGED");
      const rawIds = [...new Set(receipt.before.filter(state => state.contextEligible === true).flatMap(state => Array.isArray(state.evidenceIds) ? state.evidenceIds.map(requiredId) : []))];
      if (rawIds.length > 128) fail("UNDO_EVIDENCE_LIMIT");
      const origins = rawIds.length ? (await client.query(`/* evolution:undo-raw-origins */ SELECT id::text AS id, metadata FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL} AND id::text=ANY($10::text[]) LIMIT 128`, [...scopeParams(input.scope),rawIds])).rows : [];
      if (origins.length !== rawIds.length) fail("UNDO_EVIDENCE_CHANGED");
      const sources = [...new Set([...receipt.afterLinks.flatMap(link => typeof link.sourceId === "string" ? [link.sourceId] : []), ...origins.flatMap(sourceIds)])].sort();
      for (const sourceId of sources) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-source:${repository.scopeFingerprint}:${sourceId}`]);
      if (sources.length && (await client.query(`/* evolution:undo-source-revocations */ SELECT source_id FROM mengshu_evolution_source_dispositions
WHERE scope_fingerprint=$1 AND source_id=ANY($2::text[]) AND logical_file_id='' AND disposition='revoked' LIMIT 1`, [repository.scopeFingerprint,sources])).rows.length) fail("UNDO_SOURCE_REVOKED");
      for (const lineage of [...new Set(receipt.before.flatMap(state => typeof state.lineageId === "string" ? [state.lineageId] : []))].sort()) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`memory-lineage:${repository.scopeFingerprint}:${lineage}`]);
      const rows = await this.#targets(client, receipt.memoryIds, true), links = await readEvolutionLinks(client, repository.scopeFingerprint, receipt.memoryIds);
      if (evolutionGovernanceSnapshotHash(rows.map(evolutionGovernanceState), evolutionLinkState(links)) !== input.currentStateHash) fail("UNDO_STATE_CHANGED");
      if (rawIds.length) {
        const raw = (await client.query(`/* evolution:undo-raw-lock */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL}
AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL} AND id::text=ANY($10::text[]) ORDER BY id FOR SHARE`, [...scopeParams(input.scope),rawIds])).rows;
        if (raw.length !== rawIds.length || raw.some(row => { const evidence = decodeEvolutionOriginalEvidence(row,input.scope); return !evidence || evidence.revoked || sourceIds(row).some(source => !sources.includes(source)); })) fail("UNDO_EVIDENCE_CHANGED");
      }
      await authorizeAdministrativeReview(client, { ...binding, bindingHash, reviewReceiptId: input.reviewReceiptId });
      const now = integer(this.#now()), receiptId = jsonHash(["evolution-governance-undo",repository.scopeFingerprint,bindingHash]);
      const previousLinks = new Set(receipt.beforeLinks.map(link => String(link.id))), added = receipt.afterLinks.filter(link => !previousLinks.has(String(link.id))).map(link => String(link.id));
      if (added.length) await client.query(`/* evolution:undo-added-links */ UPDATE mengshu_memory_evidence_links SET relation_state='superseded',retired_at=$3
WHERE scope_fingerprint=$1 AND link_id=ANY($2::text[]) AND relation_state IN ('effective','reviewed_reference','contradicting')`, [repository.scopeFingerprint,added,now]);
      for (const before of receipt.before) {
        const row = rows.find(row => row.id === before.id)!;
        const after = receipt.after.find(state => state.id === before.id)!;
        if (receipt.operation === "merge_equivalent" && after.aliasOf !== null && typeof before.lineageId === "string") {
          const head = await client.query(`/* evolution:undo-alias-head */ UPDATE mengshu_memory_lineage_heads SET current_version_id=$3,current_version_revision=$4,updated_at=$5
WHERE scope_fingerprint=$1 AND lineage_id=$2 AND latest_revision=$4 AND current_version_id IS NULL RETURNING lineage_id`, [repository.scopeFingerprint,before.lineageId,before.id,before.revision,now]);
          if (head.rows.length !== 1) fail("UNDO_HEAD_CHANGED");
        }
        const restored = await client.query(`/* evolution:undo-restore-row */ UPDATE memories SET lifecycle_status=$11,
valid_to=CASE WHEN $12::bigint IS NULL THEN NULL ELSE to_timestamp($12::double precision/1000) END,
closed_at=CASE WHEN $13::bigint IS NULL THEN NULL ELSE to_timestamp($13::double precision/1000) END,evolution_alias_of=NULL
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10 AND temporal_purge_pending IS NOT TRUE AND temporal_invalidated IS NOT TRUE
AND lifecycle_status<>'revoked' AND content_hash=$14 AND COALESCE(revision,0)=$15 RETURNING id::text AS id`, [...scopeParams(input.scope),before.id,before.lifecycleStatus,before.validTo,before.closedAt,before.contentHash,before.revision]);
        if (restored.rows[0]?.id !== before.id) fail("UNDO_STATE_CHANGED");
        const metadata = boundedJson(object(row.metadata)), governance = object(metadata.governance), evolution = object(governance.evolution);
        for (const field of EVOLUTION_REVERSIBLE_METADATA_KEYS) {
          if (Object.hasOwn(object(before.evolution),field)) evolution[field] = object(before.evolution)[field]; else delete evolution[field];
        }
        governance.evolution = evolution; governance.evidenceIds = before.evidenceIds;
        governance.candidate = { ...object(governance.candidate), evidence: { ...object(object(governance.candidate).evidence), eventIds: before.evidenceIds } };
        metadata.governance = governance; metadata.sourceNodeIds = before.sourceNodeIds; metadata.confidence = before.confidence; metadata.contextEligible = before.contextEligible;
        await persistEvolutionMetadata(client,input.scope,row,metadata,{ now,disputed: before.disputed === true,dueAt: now });
        await appendEvolutionMutationEvent(client,input.scope,String(row.id),receiptId,now);
      }
      const result = { receiptId, restoredMemoryIds: receipt.memoryIds };
      await client.query(`/* evolution:undo-receipt */ INSERT INTO mengshu_evolution_operation_receipts
(scope_fingerprint,idempotency_key,request_hash,operation,receipt,created_at) VALUES($1,$2,$3,'undo_governance',$4::jsonb,$5)`, [repository.scopeFingerprint,key,bindingHash,JSON.stringify({ ...result,operationReceiptId: receipt.id,reviewReceiptId: input.reviewReceiptId }),now]);
      await lockLease(client,input.lease,repository.scopeFingerprint,input.lease.batchId);
      return result;
    });
  }
}
