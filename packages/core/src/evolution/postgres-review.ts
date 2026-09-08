import { evolutionHash } from "./fingerprints.js";
import { evolutionProposalDraft } from "./review-binding.js";
import { boundedJson, checkedHash, DB_NOW_MS, fail, integer, requiredId, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import type { PostgresEvolutionRepository, PostgresEvolutionProposalEnvelope } from "./postgres-repository.js";
import type { EvolutionApplyContext, EvolutionProposal, EvolutionProposalListRequest, EvolutionProposalPage, EvolutionReviewItem, EvolutionReviewReceipt, EvolutionReviewRepository } from "./types.js";
import { EVOLUTION_CANDIDATE_SCOPE_SQL } from "./postgres-repository.js";
import { scopeParams } from "./postgres-common.js";

/** Review decisions are host-authenticated capabilities, not trust on imported author labels. */
export class PostgresEvolutionReviewRepository implements EvolutionReviewRepository {
  constructor(private readonly repository: PostgresEvolutionRepository) {}
  async listProposals(scopeFingerprint: string, request: EvolutionProposalListRequest & { limit: number; maxBytes: number }): Promise<EvolutionProposalPage> {
    this.repository.assertScope(scopeFingerprint);
    const limit = integer(request.limit, 100), maxBytes = integer(request.maxBytes, 1048576);
    if (limit < 1 || maxBytes < 1) fail("INVALID_PROPOSAL_LIST_LIMIT");
    let cursor: { at: number; id: string } | undefined;
    if (request.cursor !== undefined) {
      if (!/^[A-Za-z0-9_-]{1,512}$/.test(request.cursor)) fail("INVALID_PROPOSAL_CURSOR");
      try { cursor = JSON.parse(Buffer.from(request.cursor, "base64url").toString("utf8")); } catch { fail("INVALID_PROPOSAL_CURSOR"); }
      if (!cursor) fail("INVALID_PROPOSAL_CURSOR");
      integer(cursor.at); requiredId(cursor.id);
    }
    if (request.status && !["staged", "review", "rejected", "noop", "applied"].includes(request.status)) fail("INVALID_PROPOSAL_STATUS");
    if (request.batchId) requiredId(request.batchId);
    const rows = (await this.repository.pool.query(`/* evolution:proposal-list */ SELECT id, created_at, metadata #> '{evolution,proposal}' AS proposal
FROM mengshu_candidates WHERE ${EVOLUTION_CANDIDATE_SCOPE_SQL} AND metadata #>> '{evolution,version}' = '1'
AND ($10::bigint IS NULL OR (created_at, id) > ($10::bigint, $11::text))
AND ($12::text IS NULL OR metadata #>> '{evolution,proposal,batchId}' = $12)
AND ($13::text IS NULL OR metadata #>> '{evolution,proposal,status}' = $13)
ORDER BY created_at, id LIMIT $14`, [...scopeParams(this.repository.scope), cursor?.at ?? null, cursor?.id ?? null, request.batchId ?? null, request.status ?? null, limit + 1])).rows;
    const proposals: EvolutionProposal[] = [];
    let bytes = 0, last: typeof cursor;
    for (const row of rows.slice(0, limit)) {
      const proposal = boundedJson(row.proposal) as EvolutionProposal;
      this.repository.assertScope(proposal.scopeFingerprint, proposal.scope);
      bytes += Buffer.byteLength(JSON.stringify(proposal));
      if (bytes > maxBytes) { if (!last) fail("PROPOSAL_LIST_BYTE_LIMIT"); break; }
      proposals.push(proposal);
      last = { at: integer(Number(row.created_at)), id: requiredId(row.id) };
    }
    return { proposals, ...(last && proposals.length < rows.length ? { nextCursor: Buffer.from(JSON.stringify(last)).toString("base64url") } : {}) };
  }
  #review(input: EvolutionReviewItem): EvolutionReviewItem {
    const review = boundedJson(input);
    this.repository.assertScope(review.binding.scopeFingerprint);
    requiredId(review.id); requiredId(review.binding.proposalId);
    integer(review.createdAt); integer(review.expiresAt);
    if (review.expiresAt <= review.createdAt || review.expiresAt - review.createdAt > 86400000 ||
      checkedHash(review.bindingHash) !== evolutionHash(review.binding) ||
      review.binding.diffHash !== evolutionHash(evolutionProposalDraft(review.proposal)) ||
      review.binding.targetStateHash !== evolutionHash(review.targets)) fail("REVIEW_BINDING_MISMATCH");
    const sources = review.proposal.quotes.map(quote => {
      const item = review.evidence.find(e => e.id === quote.evidenceId && e.start === quote.start && e.end === quote.end && e.quote === quote.quote);
      if (!item) fail("REVIEW_BINDING_MISMATCH");
      const { quote: _quote, start: _start, end: _end, ...source } = item;
      this.repository.assertScope(review.binding.scopeFingerprint, source.scope);
      return { ...source, quote };
    });
    if (review.binding.evidenceHash !== evolutionHash(sources)) fail("REVIEW_BINDING_MISMATCH");
    for (const target of review.targets) this.repository.assertScope(review.binding.scopeFingerprint, target.scope);
    return review;
  }
  #receipt(input: EvolutionReviewReceipt): EvolutionReviewReceipt {
    const receipt = boundedJson(input, 32768);
    this.repository.assertScope(receipt.binding.scopeFingerprint);
    requiredId(receipt.id); requiredId(receipt.reviewId); requiredId(receipt.idempotencyKey);
    if (receipt.bindingHash !== evolutionHash(receipt.binding) || !["approve", "reject"].includes(receipt.decision) ||
      integer(receipt.expiresAt) <= integer(receipt.decidedAt)) fail("INVALID_REVIEW_RECEIPT");
    const actor = receipt.actor;
    if (actor.tenantId !== this.repository.scope.tenantId || actor.userId !== this.repository.scope.userId ||
      !["local_owner", "authenticated_owner"].includes(actor.authentication)) fail("REVIEW_AUTHORITY_MISMATCH");
    requiredId(actor.actorId);
    return receipt;
  }
  #bind(review: EvolutionReviewItem, envelope: PostgresEvolutionProposalEnvelope | undefined): void {
    const p = envelope?.proposal, b = review.binding;
    if (!p || ["applied", "rejected", "noop"].includes(p.status) || p.id !== b.proposalId || p.inputFingerprint !== b.inputFingerprint ||
      p.sourceSnapshotHash !== b.sourceSnapshotHash || p.configFingerprint !== b.configFingerprint || p.policyVersion !== b.policyVersion ||
      evolutionHash(evolutionProposalDraft(p)) !== b.diffHash || evolutionHash(envelope.evidence) !== evolutionHash(review.evidence)) fail("REVIEW_PROPOSAL_CHANGED");
  }
  async getStagedEvidence(proposalId: string, scopeFingerprint: string) {
    this.repository.assertScope(scopeFingerprint);
    return (await this.repository.readEnvelope(this.repository.pool, proposalId))?.evidence ?? [];
  }
  async createReview(input: EvolutionReviewItem): Promise<{ review: EvolutionReviewItem; created: boolean }> {
    const review = this.#review(input);
    if (review.status !== "pending") fail("INVALID_REVIEW_STATUS");
    return this.repository.mutation(async client => {
      this.#bind(review, await this.repository.readEnvelope(client, review.binding.proposalId, true));
      const inserted = await client.query(`/* evolution:review-insert */ INSERT INTO mengshu_evolution_reviews
(scope_fingerprint, review_id, proposal_id, request_hash, binding_hash, review, created_at, expires_at)
VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) ON CONFLICT (scope_fingerprint, review_id) DO NOTHING RETURNING review`,
      [review.binding.scopeFingerprint, review.id, review.binding.proposalId, evolutionHash(review), review.bindingHash, JSON.stringify(review), review.createdAt, review.expiresAt]);
      if (inserted.rows[0]) return { review: this.#review(inserted.rows[0].review as EvolutionReviewItem), created: true };
      const prior = await client.query(`/* evolution:review-get */ SELECT review, request_hash FROM mengshu_evolution_reviews WHERE scope_fingerprint = $1 AND review_id = $2`, [review.binding.scopeFingerprint, review.id]);
      if (!prior.rows[0] || prior.rows[0].request_hash !== evolutionHash(review)) fail("IDEMPOTENCY_CONFLICT");
      return { review: this.#review(prior.rows[0].review as EvolutionReviewItem), created: false };
    });
  }
  async getReview(reviewId: string, scopeFingerprint: string): Promise<EvolutionReviewItem | undefined> {
    this.repository.assertScope(scopeFingerprint);
    const row = (await this.repository.pool.query(`/* evolution:review-get */ SELECT review FROM mengshu_evolution_reviews WHERE scope_fingerprint = $1 AND review_id = $2`, [scopeFingerprint, requiredId(reviewId)])).rows[0];
    return row ? this.#review(row.review as EvolutionReviewItem) : undefined;
  }
  async decideReview(input: EvolutionReviewReceipt, expectedBindingHash: string): Promise<EvolutionReviewReceipt> {
    const receipt = this.#receipt(input);
    if (receipt.bindingHash !== checkedHash(expectedBindingHash)) fail("REVIEW_BINDING_MISMATCH");
    return this.repository.mutation(async client => {
      const envelope = await this.repository.readEnvelope(client, receipt.binding.proposalId, true);
      const row = (await client.query(`/* evolution:review-lock */ SELECT review, receipt, revoked_at FROM mengshu_evolution_reviews
WHERE scope_fingerprint = $1 AND review_id = $2 FOR UPDATE`, [receipt.binding.scopeFingerprint, receipt.reviewId])).rows[0];
      if (!row || row.revoked_at != null) fail("REVIEW_MISSING_OR_REVOKED");
      const review = this.#review(row.review as EvolutionReviewItem);
      this.#bind(review, envelope);
      if (review.bindingHash !== receipt.bindingHash || review.expiresAt !== receipt.expiresAt) fail("REVIEW_BINDING_MISMATCH");
      if (row.receipt != null) {
        const prior = this.#receipt(row.receipt as EvolutionReviewReceipt);
        if (evolutionHash(prior) !== evolutionHash(receipt)) fail("REVIEW_DECISION_CONFLICT");
        return prior;
      }
      const result = await client.query(`/* evolution:review-decide */ UPDATE mengshu_evolution_reviews
SET review = jsonb_set(review, '{status}', $6::jsonb), reviewer_id = $4, decision = $5, receipt_id = $7, receipt = $8::jsonb
WHERE scope_fingerprint = $1 AND review_id = $2 AND binding_hash = $3 AND receipt IS NULL
AND revoked_at IS NULL AND expires_at > ${DB_NOW_MS} AND $9 <= ${DB_NOW_MS} AND $9 >= created_at RETURNING receipt`,
      [receipt.binding.scopeFingerprint, receipt.reviewId, receipt.bindingHash, receipt.actor.actorId, receipt.decision, JSON.stringify(receipt.decision === "approve" ? "approved" : "rejected"), receipt.id, JSON.stringify(receipt), receipt.decidedAt]);
      if (!result.rows[0]) fail("REVIEW_EXPIRED_OR_CHANGED");
      return this.#receipt(result.rows[0].receipt as EvolutionReviewReceipt);
    });
  }
  async getReviewReceipt(receiptId: string, scopeFingerprint: string): Promise<EvolutionReviewReceipt | undefined> {
    this.repository.assertScope(scopeFingerprint);
    const row = (await this.repository.pool.query(`/* evolution:review-receipt-get */ SELECT receipt FROM mengshu_evolution_reviews WHERE scope_fingerprint = $1 AND receipt_id = $2 AND revoked_at IS NULL`, [scopeFingerprint, requiredId(receiptId)])).rows[0];
    return row?.receipt ? this.#receipt(row.receipt as EvolutionReviewReceipt) : undefined;
  }
  async findProposalReview(proposalId: string, scopeFingerprint: string): Promise<EvolutionReviewReceipt | undefined> {
    this.repository.assertScope(scopeFingerprint);
    const row = (await this.repository.pool.query(`/* evolution:review-for-proposal */ SELECT receipt FROM mengshu_evolution_reviews
WHERE scope_fingerprint = $1 AND proposal_id = $2 AND receipt IS NOT NULL AND revoked_at IS NULL
ORDER BY created_at DESC, review_id DESC LIMIT 1`, [scopeFingerprint, requiredId(proposalId)])).rows[0];
    return row?.receipt ? this.#receipt(row.receipt as EvolutionReviewReceipt) : undefined;
  }
  async lockApproval(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext): Promise<void> {
    const p = context.proposal, supplied = context.approval;
    if (!supplied || p.ownerApprovalReceiptId !== supplied.id || p.reviewedProposalId !== supplied.binding.proposalId) fail("APPROVAL_REQUIRED");
    const receipt = this.#receipt(supplied);
    const row = (await client.query(`/* evolution:approval-lock */ SELECT receipt, consumed_by_proposal_id FROM mengshu_evolution_reviews
WHERE scope_fingerprint = $1 AND receipt_id = $2 AND binding_hash = $3 AND decision = 'approve'
AND revoked_at IS NULL AND expires_at > ${DB_NOW_MS} FOR UPDATE`, [p.scopeFingerprint, receipt.id, receipt.bindingHash])).rows[0];
    if (!row || evolutionHash(row.receipt) !== evolutionHash(receipt) ||
      row.consumed_by_proposal_id != null && row.consumed_by_proposal_id !== p.id) fail("APPROVAL_EXPIRED_CHANGED_OR_CONSUMED");
  }
  async consumeApproval(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext): Promise<void> {
    if (!context.approval) return;
    await this.lockApproval(client, context);
    const row = (await client.query(`/* evolution:approval-consume */ UPDATE mengshu_evolution_reviews SET consumed_at = ${DB_NOW_MS}, consumed_by_proposal_id = $3
WHERE scope_fingerprint = $1 AND receipt_id = $2 AND expires_at > ${DB_NOW_MS} AND revoked_at IS NULL
AND (consumed_by_proposal_id IS NULL OR consumed_by_proposal_id = $3) RETURNING receipt_id`, [context.proposal.scopeFingerprint, context.approval.id, context.proposal.id])).rows[0];
    if (!row) fail("APPROVAL_EXPIRED_CHANGED_OR_CONSUMED");
  }
}
