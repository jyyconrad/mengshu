import type { EvolutionApplyReceipt, EvolutionBatch, EvolutionLease, EvolutionProcessedInput, EvolutionProposal, EvolutionProposalListRequest, EvolutionProposalPage, EvolutionRepository, EvolutionReviewItem, EvolutionReviewReceipt, EvolutionReviewRepository, EvolutionStagedEvidence } from "./types.js";
import { EvolutionError } from "./schema.js";
import { evolutionHash } from "./fingerprints.js";

/** Isolated reference repository for tests; production must use a durable provider. */
export class InMemoryEvolutionRepository implements EvolutionRepository, EvolutionReviewRepository {
  private readonly batches = new Map<string, EvolutionBatch>();
  private readonly keys = new Map<string, string>();
  private readonly leases = new Map<string, EvolutionLease>();
  private readonly fences = new Map<string, number>();
  private readonly proposals = new Map<string, EvolutionProposal>();
  private readonly stagedEvidence = new Map<string, EvolutionStagedEvidence[]>();
  private readonly receipts = new Map<string, EvolutionApplyReceipt>();
  private readonly processed = new Map<string, EvolutionProcessedInput>();
  private readonly reviews = new Map<string, EvolutionReviewItem>();
  private readonly reviewReceipts = new Map<string, EvolutionReviewReceipt>();
  constructor(private readonly now: () => number = Date.now) {}
  private key(scope: string, id: string): string { return JSON.stringify([scope, id]); }
  private assertLease(lease: EvolutionLease): void {
    const live = this.leases.get(this.key(lease.scopeFingerprint, lease.batchId));
    if (!live || live.ownerId !== lease.ownerId || live.fencingToken !== lease.fencingToken || live.expiresAt <= this.now()) throw new EvolutionError("lease_lost");
  }
  async createBatch(batch: EvolutionBatch): Promise<{ batch: EvolutionBatch; created: boolean }> {
    const key = this.key(batch.scopeFingerprint, batch.request.idempotencyKey);
    const existing = this.keys.get(key);
    if (existing) {
      const previous = this.batches.get(existing)!;
      if (previous.requestHash !== batch.requestHash) throw new EvolutionError("idempotency_conflict");
      return { batch: structuredClone(previous), created: false };
    }
    this.keys.set(key, batch.id);
    this.batches.set(batch.id, structuredClone(batch));
    return { batch: structuredClone(batch), created: true };
  }
  async getBatch(id: string, scope: string): Promise<EvolutionBatch | undefined> {
    const batch = this.batches.get(id);
    return batch?.scopeFingerprint === scope ? structuredClone(batch) : undefined;
  }
  async acquireLease(batchId: string, scope: string, ownerId: string, ttlMs: number): Promise<EvolutionLease | undefined> {
    if (!await this.getBatch(batchId, scope)) throw new EvolutionError("batch_not_found");
    const key = this.key(scope, batchId);
    if ((this.leases.get(key)?.expiresAt ?? 0) > this.now()) return undefined;
    const fencingToken = (this.fences.get(key) ?? 0) + 1;
    const lease = { batchId, scopeFingerprint: scope, ownerId, fencingToken, expiresAt: this.now() + ttlMs };
    this.fences.set(key, fencingToken);
    this.leases.set(key, lease);
    return structuredClone(lease);
  }
  async releaseLease(lease: EvolutionLease): Promise<void> {
    const key = this.key(lease.scopeFingerprint, lease.batchId);
    const live = this.leases.get(key);
    if (live?.fencingToken === lease.fencingToken && live.ownerId === lease.ownerId) this.leases.delete(key);
  }
  async saveBatch(batch: EvolutionBatch, expectedVersion: number, lease: EvolutionLease): Promise<EvolutionBatch> {
    this.assertLease(lease);
    const previous = await this.getBatch(batch.id, batch.scopeFingerprint);
    if (batch.id !== lease.batchId || batch.scopeFingerprint !== lease.scopeFingerprint || !previous || previous.version !== expectedVersion) throw new EvolutionError("batch_cas_conflict");
    const cancelled = previous.cancelRequestedAt !== undefined && (batch.segment?.attempt ?? 1) <= (previous.segment?.attempt ?? 1);
    const saved = structuredClone({ ...batch, ...(cancelled ? { cancelRequestedAt: previous.cancelRequestedAt, status: "cancelled" as const, reasons: ["cancelled"] } : {}), version: expectedVersion + 1 });
    this.batches.set(batch.id, saved);
    return structuredClone(saved);
  }
  async stageProposal(proposal: EvolutionProposal, evidence: EvolutionStagedEvidence[], lease: EvolutionLease): Promise<EvolutionProposal> {
    this.assertLease(lease);
    if (proposal.batchId !== lease.batchId || proposal.scopeFingerprint !== lease.scopeFingerprint) throw new EvolutionError("scope_mismatch");
    const key = this.key(proposal.scopeFingerprint, proposal.id);
    const old = this.proposals.get(key);
    if (old) {
      const { status: _oldStatus, ...previous } = old;
      const { status: _newStatus, ...request } = proposal;
      if (evolutionHash({ proposal: previous, evidence: this.stagedEvidence.get(key) }) !== evolutionHash({ proposal: request, evidence })) throw new EvolutionError("proposal_conflict");
      return structuredClone(old);
    }
    this.proposals.set(key, structuredClone(proposal));
    this.stagedEvidence.set(key, structuredClone(evidence));
    return structuredClone(proposal);
  }
  async getProposal(id: string, scope: string): Promise<EvolutionProposal | undefined> { return structuredClone(this.proposals.get(this.key(scope, id))); }
  async getReceipt(id: string, scope: string): Promise<EvolutionApplyReceipt | undefined> { return structuredClone(this.receipts.get(this.key(scope, id))); }
  async getStagedEvidence(id: string, scope: string): Promise<EvolutionStagedEvidence[]> { return structuredClone(this.stagedEvidence.get(this.key(scope, id)) ?? []); }
  async listProposals(scope: string, request: EvolutionProposalListRequest & { limit: number; maxBytes: number }): Promise<EvolutionProposalPage> {
    const rows = [...this.proposals.values()].filter(p => p.scopeFingerprint === scope && (!request.batchId || p.batchId === request.batchId) && (!request.status || p.status === request.status) && (!request.cursor || p.id > request.cursor)).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const proposals: EvolutionProposal[] = [];
    for (const proposal of rows.slice(0, request.limit)) {
      if (Buffer.byteLength(JSON.stringify({ proposals: [...proposals, proposal], nextCursor: proposal.id })) > request.maxBytes) break;
      proposals.push(proposal);
    }
    if (rows.length && !proposals.length) throw new EvolutionError("review_detail_contract_invalid");
    return structuredClone({ proposals, ...(rows.length > proposals.length ? { nextCursor: proposals.at(-1)!.id } : {}) });
  }
  async createReview(review: EvolutionReviewItem): Promise<{ review: EvolutionReviewItem; created: boolean }> {
    const proposal = await this.getProposal(review.binding.proposalId, review.binding.scopeFingerprint);
    if (!proposal || review.bindingHash !== evolutionHash(review.binding) || proposal.status === "applied") throw new EvolutionError("review_binding_mismatch");
    const key = this.key(review.binding.scopeFingerprint, review.id);
    const old = this.reviews.get(key);
    if (old && old.bindingHash !== review.bindingHash) throw new EvolutionError("review_binding_mismatch");
    if (!old) this.reviews.set(key, structuredClone(review));
    return { review: structuredClone(old ?? review), created: !old };
  }
  async getReview(id: string, scope: string): Promise<EvolutionReviewItem | undefined> { return structuredClone(this.reviews.get(this.key(scope, id))); }
  async getReviewReceipt(id: string, scope: string): Promise<EvolutionReviewReceipt | undefined> { return structuredClone(this.reviewReceipts.get(this.key(scope, id))); }
  async findProposalReview(proposalId: string, scope: string): Promise<EvolutionReviewReceipt | undefined> {
    return structuredClone([...this.reviewReceipts.values()].filter(r => r.binding.proposalId === proposalId && r.binding.scopeFingerprint === scope).sort((a, b) => b.decidedAt - a.decidedAt)[0]);
  }
  async decideReview(receipt: EvolutionReviewReceipt, expectedBindingHash: string): Promise<EvolutionReviewReceipt> {
    const key = this.key(receipt.binding.scopeFingerprint, receipt.reviewId);
    const review = this.reviews.get(key);
    const old = this.reviewReceipts.get(this.key(receipt.binding.scopeFingerprint, receipt.id));
    if (old) { if (evolutionHash(old) !== evolutionHash(receipt)) throw new EvolutionError("review_decision_conflict"); return structuredClone(old); }
    if (!review || review.bindingHash !== expectedBindingHash || expectedBindingHash !== receipt.bindingHash || evolutionHash(receipt.binding) !== expectedBindingHash) throw new EvolutionError("review_binding_mismatch");
    if (review.status !== "pending") throw new EvolutionError("review_decision_conflict");
    if (review.expiresAt <= this.now() || receipt.expiresAt !== review.expiresAt || receipt.decidedAt > this.now()) throw new EvolutionError("approval_expired");
    const pkey = this.key(receipt.binding.scopeFingerprint, receipt.binding.proposalId);
    const proposal = this.proposals.get(pkey);
    if (!proposal || ["applied", "rejected", "noop"].includes(proposal.status)) throw new EvolutionError("proposal_not_reviewable");
    if (receipt.actor.tenantId !== proposal.scope.tenantId || receipt.actor.userId !== proposal.scope.userId) throw new EvolutionError("review_authority_mismatch");
    this.reviews.set(key, { ...review, status: receipt.decision === "approve" ? "approved" : "rejected" });
    this.reviewReceipts.set(this.key(receipt.binding.scopeFingerprint, receipt.id), structuredClone(receipt));
    if (receipt.decision === "reject") this.proposals.set(pkey, { ...proposal, status: "rejected", validation: { outcome: "rejected", reasons: ["owner_rejected"], reviewRequirement: "none", contextEligible: false, independentEvidenceRootIds: [] } });
    return structuredClone(receipt);
  }
  async requestCancellation(batchId: string, scope: string, requestedAt: number): Promise<EvolutionBatch | undefined> {
    const batch = this.batches.get(batchId);
    if (!batch || batch.scopeFingerprint !== scope) return undefined;
    if (batch.status !== "completed") this.batches.set(batchId, { ...batch, cancelRequestedAt: batch.cancelRequestedAt ?? requestedAt, status: "cancelled", reasons: ["cancelled"] });
    return this.getBatch(batchId, scope);
  }
  async findProcessed(scope: string, inputFingerprint: string, action: "propose" | "apply_allowed"): Promise<EvolutionProcessedInput | undefined> { return structuredClone(this.processed.get(this.key(scope, `${action}:${inputFingerprint}`))); }
  async recordProcessed(input: EvolutionProcessedInput, lease: EvolutionLease): Promise<void> {
    this.assertLease(lease);
    if (input.scopeFingerprint !== lease.scopeFingerprint) throw new EvolutionError("scope_mismatch");
    const proposal = await this.getProposal(input.proposalId, input.scopeFingerprint);
    if (!proposal || proposal.batchId !== lease.batchId || proposal.inputFingerprint !== input.inputFingerprint) throw new EvolutionError("proposal_missing");
    const key = this.key(input.scopeFingerprint, `${input.action}:${input.inputFingerprint}`);
    const old = this.processed.get(key);
    if (old && old.proposalId !== input.proposalId) throw new EvolutionError("idempotency_conflict");
    if (!old) this.processed.set(key, structuredClone(input));
  }
  /** Test writer's atomic stand-in. This does not implement canonical memory writes. */
  async commitReceipt(receipt: EvolutionApplyReceipt, lease: EvolutionLease): Promise<void> {
    this.assertLease(lease);
    const key = this.key(receipt.scopeFingerprint, receipt.proposalId);
    const proposal = this.proposals.get(key);
    if (!proposal || proposal.validation.outcome !== "allowed" || proposal.batchId !== lease.batchId || receipt.batchId !== lease.batchId || receipt.scopeFingerprint !== lease.scopeFingerprint) throw new EvolutionError("apply_not_allowed");
    if (!this.receipts.has(key)) {
      this.receipts.set(key, structuredClone(receipt));
      this.proposals.set(key, { ...proposal, status: receipt.outcome === "applied" ? "applied" : "noop" });
    }
  }
}
