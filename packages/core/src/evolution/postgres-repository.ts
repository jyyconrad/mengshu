import type { MemoryScope } from "../domain/types.js";
import type { EvolutionApplyReceipt, EvolutionBatch, EvolutionLease, EvolutionProcessedInput, EvolutionProposal, EvolutionProposalListRequest, EvolutionRepository, EvolutionStagedEvidence, EvolutionReviewRepository, EvolutionReviewItem, EvolutionReviewReceipt } from "./types.js";
import { PostgresEvolutionReviewRepository } from "./postgres-review.js";
import { boundedJson, checkedHash, DB_NOW_MS, fail, integer, jsonHash, lockLease, requiredId, scopedFingerprint, scopeParams, transaction, type PostgresEvolutionClient, type PostgresEvolutionPool, type PostgresEvolutionQueryClient } from "./postgres-common.js";
export { POSTGRES_EVOLUTION_SCHEMA_VERSION } from "./postgres-common.js";

export interface PostgresEvolutionProposalEnvelope {
  version: 1;
  proposal: EvolutionProposal;
  evidence: EvolutionStagedEvidence[];
  requestHash: string;
  relationState: "staged";
  expiresAt: number;
}
const CANDIDATE_SCOPE = `tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7 AND workspace_id = $8 AND session_id = $9`;
export const EVOLUTION_CANDIDATE_SCOPE_SQL = CANDIDATE_SCOPE;

export function proposalRequestHash(proposal: EvolutionProposal, evidence: EvolutionStagedEvidence[]): string {
  // Applied/noop are results, not different proposal requests.
  const { status: _status, ...request } = proposal;
  return jsonHash({ proposal: request, evidence });
}
export function validateStagedEvidence(proposal: EvolutionProposal, evidence: EvolutionStagedEvidence[]): void {
  if (!Array.isArray(evidence) || evidence.length > 32 || evidence.length !== proposal.quotes.length) fail("INVALID_STAGED_EVIDENCE");
  for (const item of evidence) {
    if (scopedFingerprint(item.scope) !== proposal.scopeFingerprint) fail("SCOPE_MISMATCH");
    checkedHash(item.snapshotHash);
    requiredId(item.rootEvidenceId);
    if (!proposal.quotes.some((q) => q.evidenceId === item.id && q.quote === item.quote && q.start === item.start && q.end === item.end) ||
        typeof item.quote !== "string" || item.quote.length === 0 || item.quote.length > 8192 ||
        integer(item.start) > integer(item.end) || item.quote.length !== item.end - item.start) fail("INVALID_STAGED_EVIDENCE");
  }
  if (new Set(evidence.map((e) => JSON.stringify([e.id, e.start, e.end]))).size !== evidence.length) fail("INVALID_STAGED_EVIDENCE");
}

/** The proposal zone is the only place that stores staged spans; canonical readers never query it. */
export class PostgresEvolutionRepository implements EvolutionRepository, EvolutionReviewRepository {
  readonly scope: MemoryScope;
  readonly scopeFingerprint: string;
  readonly pool: PostgresEvolutionPool;
  readonly reviews = new PostgresEvolutionReviewRepository(this);
  readonly #stagedTtlMs: number;
  readonly #beforeMutation?: (client: PostgresEvolutionQueryClient) => Promise<void>;
  constructor(options: { pool: PostgresEvolutionPool; scope: MemoryScope; stagedTtlMs?: number; beforeMutation?: (client: PostgresEvolutionQueryClient) => Promise<void> }) {
    this.pool = options.pool;
    this.scope = Object.freeze({ ...options.scope, visibility: options.scope.visibility ?? "private" });
    this.scopeFingerprint = scopedFingerprint(this.scope);
    this.#stagedTtlMs = integer(options.stagedTtlMs ?? 7 * 86400000, 30 * 86400000);
    this.#beforeMutation = options.beforeMutation;
  }
  /** Host factory binds its minted job fence here; callers never submit a fence as request data. */
  async assertMutationAllowed(client: PostgresEvolutionQueryClient): Promise<void> {
    await this.#beforeMutation?.(client);
  }
  async mutation<T>(work: (client: PostgresEvolutionClient) => Promise<T>): Promise<T> {
    return transaction(this.pool, async (client) => {
      await this.assertMutationAllowed(client);
      const result = await work(client);
      await this.assertMutationAllowed(client);
      return result;
    });
  }
  assertScope(fingerprint: string, scope?: MemoryScope): void {
    if (fingerprint !== this.scopeFingerprint || (scope && scopedFingerprint(scope) !== fingerprint)) fail("SCOPE_MISMATCH");
  }
  getStagedEvidence(proposalId: string, scopeFingerprint: string) { return this.reviews.getStagedEvidence(proposalId, scopeFingerprint); }
  listProposals(scopeFingerprint: string, request: EvolutionProposalListRequest & { limit: number; maxBytes: number }) { return this.reviews.listProposals(scopeFingerprint, request); }
  createReview(review: EvolutionReviewItem) { return this.reviews.createReview(review); }
  getReview(reviewId: string, scopeFingerprint: string) { return this.reviews.getReview(reviewId, scopeFingerprint); }
  decideReview(receipt: EvolutionReviewReceipt, expectedBindingHash: string) { return this.reviews.decideReview(receipt, expectedBindingHash); }
  getReviewReceipt(receiptId: string, scopeFingerprint: string) { return this.reviews.getReviewReceipt(receiptId, scopeFingerprint); }
  findProposalReview(proposalId: string, scopeFingerprint: string) { return this.reviews.findProposalReview(proposalId, scopeFingerprint); }
  #batch(value: unknown): EvolutionBatch {
    const batch = boundedJson(value) as EvolutionBatch;
    if (!batch || typeof batch !== "object") fail("INVALID_BATCH");
    this.assertScope(batch.scopeFingerprint, batch.scope);
    requiredId(batch.id); integer(batch.version); checkedHash(batch.requestHash);
    return batch;
  }
  async createBatch(input: EvolutionBatch): Promise<{ batch: EvolutionBatch; created: boolean }> {
    const batch = this.#batch(input);
    requiredId(batch.request.idempotencyKey);
    return this.mutation(async (client) => {
      const inserted = await client.query(
        `/* evolution:batch-insert */ INSERT INTO mengshu_evolution_batches
(scope_fingerprint, id, idempotency_key, request_hash, body, version)
VALUES ($1, $2, $3, $4, $5::jsonb, $6)
ON CONFLICT (scope_fingerprint, idempotency_key) DO NOTHING RETURNING body`,
        [this.scopeFingerprint, batch.id, batch.request.idempotencyKey, batch.requestHash, JSON.stringify(batch), batch.version],
      );
      if (inserted.rows.length === 1) return { batch: this.#batch(inserted.rows[0]!.body), created: true };
      const prior = await client.query(
        `/* evolution:batch-by-key */ SELECT body FROM mengshu_evolution_batches WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
        [this.scopeFingerprint, batch.request.idempotencyKey],
      );
      const existing = this.#batch(prior.rows[0]?.body);
      if (existing.requestHash !== batch.requestHash || existing.configFingerprint !== batch.configFingerprint || existing.policyVersion !== batch.policyVersion) fail("IDEMPOTENCY_CONFLICT");
      return { batch: existing, created: false };
    });
  }
  async getBatch(batchId: string, scopeFingerprint: string): Promise<EvolutionBatch | undefined> {
    this.assertScope(scopeFingerprint);
    const result = await this.pool.query(`/* evolution:batch-get */ SELECT body FROM mengshu_evolution_batches WHERE scope_fingerprint = $1 AND id = $2`, [scopeFingerprint, requiredId(batchId)]);
    return result.rows[0] ? this.#batch(result.rows[0].body) : undefined;
  }
  async acquireLease(batchId: string, scopeFingerprint: string, ownerId: string, ttlMs: number): Promise<EvolutionLease | undefined> {
    this.assertScope(scopeFingerprint);
    if (integer(ttlMs, 3600000) < 1) fail("INVALID_LEASE_TTL");
    const result = await this.mutation((client) => client.query(
      `/* evolution:lease-acquire */ UPDATE mengshu_evolution_batches
SET lease_owner = $3, fencing_token = fencing_token + 1, lease_expires_at = ${DB_NOW_MS} + $4
WHERE scope_fingerprint = $1 AND id = $2 AND lease_expires_at <= ${DB_NOW_MS}
RETURNING fencing_token, lease_expires_at`,
      [scopeFingerprint, requiredId(batchId), requiredId(ownerId), ttlMs],
    ));
    if (!result.rows[0]) return undefined;
    return { batchId, scopeFingerprint, ownerId, fencingToken: integer(Number(result.rows[0].fencing_token)), expiresAt: integer(Number(result.rows[0].lease_expires_at)) };
  }
  async requestCancellation(batchId: string, scopeFingerprint: string, requestedAt: number): Promise<EvolutionBatch | undefined> {
    this.assertScope(scopeFingerprint); requiredId(batchId); integer(requestedAt);
    const result = await this.mutation(client => client.query(`/* evolution:batch-cancel */ UPDATE mengshu_evolution_batches
SET body = CASE WHEN body->>'status' = 'completed' THEN body ELSE body || jsonb_build_object(
  'cancelRequestedAt', COALESCE(body->'cancelRequestedAt', to_jsonb($3::bigint)), 'status', 'cancelled') END
WHERE scope_fingerprint = $1 AND id = $2 RETURNING body`, [scopeFingerprint, batchId, requestedAt]));
    return result.rows[0] ? this.#batch(result.rows[0].body) : undefined;
  }
  async releaseLease(lease: EvolutionLease): Promise<void> {
    this.assertScope(lease.scopeFingerprint);
    await this.mutation((client) => client.query(
      `/* evolution:lease-release */ UPDATE mengshu_evolution_batches SET lease_owner = NULL, lease_expires_at = 0
WHERE scope_fingerprint = $1 AND id = $2 AND lease_owner = $3 AND fencing_token = $4`,
      [this.scopeFingerprint, requiredId(lease.batchId), requiredId(lease.ownerId), integer(lease.fencingToken)],
    ));
  }
  async saveBatch(input: EvolutionBatch, expectedVersion: number, lease: EvolutionLease): Promise<EvolutionBatch> {
    const batch = this.#batch(input);
    if (lease.batchId !== batch.id) fail("SCOPE_MISMATCH");
    this.assertScope(lease.scopeFingerprint);
    batch.version = integer(expectedVersion) + 1;
    const result = await this.mutation((client) => client.query(
      `/* evolution:batch-save */ UPDATE mengshu_evolution_batches SET body = CASE
WHEN body ? 'cancelRequestedAt' AND NOT ($3::jsonb->>'status' = 'queued'
  AND COALESCE(($3::jsonb #>> '{segment,attempt}')::bigint,1) > COALESCE((body #>> '{segment,attempt}')::bigint,1))
THEN $3::jsonb || jsonb_build_object('cancelRequestedAt', body->'cancelRequestedAt', 'status', 'cancelled') ELSE $3::jsonb END, version = version + 1
WHERE scope_fingerprint = $1 AND id = $2 AND version = $4 AND lease_owner = $5
  AND fencing_token = $6 AND lease_expires_at > ${DB_NOW_MS} AND request_hash = $7 RETURNING body`,
      [this.scopeFingerprint, batch.id, JSON.stringify(batch), expectedVersion, requiredId(lease.ownerId), integer(lease.fencingToken), batch.requestHash],
    ));
    if (result.rows.length !== 1) fail("STALE_BATCH_OR_LEASE");
    return this.#batch(result.rows[0]!.body);
  }
  async stageProposal(input: EvolutionProposal, spans: EvolutionStagedEvidence[], lease: EvolutionLease): Promise<EvolutionProposal> {
    const proposal = boundedJson(input);
    const evidence = boundedJson(spans);
    this.assertScope(proposal.scopeFingerprint, proposal.scope);
    requiredId(proposal.id); requiredId(proposal.batchId);
    if (!["staged", "review", "rejected", "noop"].includes(proposal.status)) fail("INVALID_PROPOSAL_STATUS");
    validateStagedEvidence(proposal, evidence);
    const requestHash = proposalRequestHash(proposal, evidence);
    const envelope: PostgresEvolutionProposalEnvelope = { version: 1, proposal, evidence, requestHash, relationState: "staged", expiresAt: integer(proposal.createdAt) + this.#stagedTtlMs };
    const metadata = boundedJson({ evolution: envelope });
    // Include identity in the envelope text so unrelated updates cannot share a legacy content-dedup key.
    const text = JSON.stringify({ evolutionProposal: proposal.id, operation: proposal.operation, proposedText: proposal.proposedText ?? "" });
    const contentHash = jsonHash(text);
    return this.mutation(async (client) => {
      await lockLease(client, lease, this.scopeFingerprint, proposal.batchId);
      const result = await client.query(
        `/* evolution:proposal-insert */ INSERT INTO mengshu_candidates
(tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id,
 id, text, kind, confidence, content_hash, active_content_hash, evidence_ids, metadata, status, created_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'other',0,$12,$12,'[]'::jsonb,$13::jsonb,'pending',$14)
ON CONFLICT (id) DO NOTHING RETURNING id`,
        [...scopeParams(this.scope), proposal.id, text, contentHash, JSON.stringify(metadata), proposal.createdAt],
      );
      if (result.rows.length !== 1) {
        const existing = await this.readEnvelope(client, proposal.id, true);
        if (!existing || existing.requestHash !== requestHash) fail("IDEMPOTENCY_CONFLICT");
        return existing.proposal;
      }
      return proposal;
    });
  }
  async readEnvelope(client: PostgresEvolutionQueryClient, proposalId: string, forUpdate = false): Promise<PostgresEvolutionProposalEnvelope | undefined> {
    const result = await client.query(
      `/* evolution:proposal-get */ SELECT metadata, status FROM mengshu_candidates WHERE ${CANDIDATE_SCOPE} AND id = $10${forUpdate ? " FOR UPDATE" : ""}`,
      [...scopeParams(this.scope), requiredId(proposalId)],
    );
    if (!result.rows[0]) return undefined;
    const metadata = boundedJson(result.rows[0].metadata) as { evolution?: PostgresEvolutionProposalEnvelope };
    const envelope = metadata?.evolution;
    if (envelope?.version !== 1 || envelope.proposal.id !== proposalId || envelope.relationState !== "staged") fail("INVALID_PROPOSAL");
    this.assertScope(envelope.proposal.scopeFingerprint, envelope.proposal.scope);
    validateStagedEvidence(envelope.proposal, envelope.evidence);
    if (envelope.requestHash !== proposalRequestHash(envelope.proposal, envelope.evidence)) fail("INVALID_PROPOSAL");
    if (forUpdate && result.rows[0].status !== "pending") fail("PROPOSAL_NOT_PENDING");
    return envelope;
  }
  async getProposal(proposalId: string, scopeFingerprint: string): Promise<EvolutionProposal | undefined> {
    this.assertScope(scopeFingerprint);
    return (await this.readEnvelope(this.pool, proposalId))?.proposal;
  }
  async getReceipt(proposalId: string, scopeFingerprint: string): Promise<EvolutionApplyReceipt | undefined> {
    this.assertScope(scopeFingerprint);
    const result = await this.pool.query(
      `/* evolution:receipt-get */ SELECT receipt FROM mengshu_evolution_apply_receipts WHERE scope_fingerprint = $1 AND proposal_id = $2`,
      [scopeFingerprint, requiredId(proposalId)],
    );
    if (!result.rows[0]) return undefined;
    const receipt = boundedJson(result.rows[0].receipt) as EvolutionApplyReceipt;
    if (receipt?.scopeFingerprint !== scopeFingerprint || receipt.proposalId !== proposalId || !["applied", "noop"].includes(receipt.outcome)) fail("INVALID_RECEIPT");
    return receipt;
  }
  async findProcessed(scopeFingerprint: string, inputFingerprint: string, action: "propose" | "apply_allowed"): Promise<EvolutionProcessedInput | undefined> {
    this.assertScope(scopeFingerprint);
    const result = await this.pool.query(
      `/* evolution:processed-get */ SELECT proposal_id, processed_at FROM mengshu_evolution_processed_inputs
WHERE scope_fingerprint = $1 AND input_fingerprint = $2 AND action = $3`,
      [scopeFingerprint, checkedHash(inputFingerprint), action],
    );
    return result.rows[0] ? { scopeFingerprint, inputFingerprint, action, proposalId: requiredId(result.rows[0].proposal_id), processedAt: integer(Number(result.rows[0].processed_at)) } : undefined;
  }
  async recordProcessed(input: EvolutionProcessedInput, lease: EvolutionLease): Promise<void> {
    this.assertScope(input.scopeFingerprint);
    checkedHash(input.inputFingerprint); requiredId(input.proposalId); integer(input.processedAt);
    if (!["propose", "apply_allowed"].includes(input.action)) fail("INVALID_ACTION");
    await this.mutation(async (client) => {
      await lockLease(client, lease, this.scopeFingerprint, lease.batchId);
      const envelope = await this.readEnvelope(client, input.proposalId);
      if (!envelope || envelope.proposal.batchId !== lease.batchId || envelope.proposal.inputFingerprint !== input.inputFingerprint) fail("PROCESSED_PROOF_MISSING");
      const result = await client.query(
        `/* evolution:processed-insert */ INSERT INTO mengshu_evolution_processed_inputs
(scope_fingerprint, input_fingerprint, action, proposal_id, processed_at) VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (scope_fingerprint, input_fingerprint, action) DO UPDATE
SET processed_at = mengshu_evolution_processed_inputs.processed_at
WHERE mengshu_evolution_processed_inputs.proposal_id = EXCLUDED.proposal_id RETURNING proposal_id`,
        [this.scopeFingerprint, input.inputFingerprint, input.action, input.proposalId, input.processedAt],
      );
      if (result.rows.length !== 1 || result.rows[0]?.proposal_id !== input.proposalId) fail("IDEMPOTENCY_CONFLICT");
    });
  }
}
