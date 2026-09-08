import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { resolveAuthorityScope } from "../domain/authority-scope.js";
import { redactSecrets } from "../ingest/agent-history/redaction.js";
import { deterministicUuid } from "../scoring/hash-utils.js";
import { evolutionHash } from "./fingerprints.js";
import { evolutionProposalDraft, buildEvolutionReviewBinding } from "./review-binding.js";
import { stageEvolutionEvidence, validateEvolutionApprovedProposal } from "./proposal-validation.js";
import { abortableEvolution } from "./proposer.js";
import { assertEvolutionCheckpoint, EVOLUTION_POLICY_VERSION, EvolutionError, parseEvolutionProposalList, parseEvolutionReviewDecision, parseEvolutionRunRequest } from "./schema.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDetail, EvolutionProposalListRequest, EvolutionProposalPage, EvolutionProposalSourcePort, EvolutionReviewDecisionRequest, EvolutionReviewItem, EvolutionReviewReceipt, MemoryEvolutionReviewServiceOptions } from "./types.js";

/** An authenticated owner's decision is administrative approval, not an historical author attestation. */
export class MemoryEvolutionReviewService {
  private readonly scopeFingerprint: string;
  private readonly now: () => number;
  private readonly options: MemoryEvolutionReviewServiceOptions;
  private readonly ttl: number;
  constructor(options: MemoryEvolutionReviewServiceOptions) {
    const { appId, projectId, agentId, namespace, visibility } = options.scope;
    this.scopeFingerprint = authorityScopeFingerprint(resolveAuthorityScope(options.authority, { appId, projectId, agentId, namespace, visibility }));
    if (this.scopeFingerprint !== authorityScopeFingerprint(options.scope) || options.actor.tenantId !== options.scope.tenantId || options.actor.userId !== options.scope.userId || !options.actor.actorId || !["local_owner", "authenticated_owner"].includes(options.actor.authentication)) throw new EvolutionError("review_authority_mismatch");
    this.options = { ...options, scope: structuredClone(options.scope), authority: structuredClone(options.authority), actor: structuredClone(options.actor) };
    this.now = options.now ?? Date.now;
    this.ttl = options.reviewTtlMs ?? 900_000;
    if (!Number.isSafeInteger(this.ttl) || this.ttl < 1000 || this.ttl > 86_400_000) throw new EvolutionError("review_ttl_invalid");
  }
  async status(reviewId: string): Promise<EvolutionReviewItem | undefined> {
    return this.options.repository.getReview(reviewId, this.scopeFingerprint);
  }
  async list(value: EvolutionProposalListRequest = {}): Promise<EvolutionProposalPage> {
    const request = { ...parseEvolutionProposalList(value), limit: value.limit ?? 20, maxBytes: 262_144 };
    const page = await this.options.repository.listProposals(this.scopeFingerprint, request);
    if (page.proposals.length > request.limit || Buffer.byteLength(JSON.stringify(page)) > request.maxBytes || page.proposals.some(p => p.scopeFingerprint !== this.scopeFingerprint)) throw new EvolutionError("review_list_contract_invalid");
    if (page.nextCursor) assertEvolutionCheckpoint(page.nextCursor);
    return page;
  }
  async detail(proposalId: string): Promise<EvolutionProposalDetail | undefined> {
    const proposal = await this.options.repository.getProposal(proposalId, this.scopeFingerprint);
    if (!proposal) return undefined;
    const evidence = await this.options.repository.getStagedEvidence(proposalId, this.scopeFingerprint);
    const review = await this.options.repository.findProposalReview(proposalId, this.scopeFingerprint);
    const detail = { proposal, evidence, ...(review ? { review } : {}) };
    if (evidence.length > 8 || Buffer.byteLength(JSON.stringify(detail)) > 262_144) throw new EvolutionError("review_detail_contract_invalid");
    return detail;
  }
  private async proposal(id: string): Promise<EvolutionProposal> {
    const proposal = await this.options.repository.getProposal(id, this.scopeFingerprint);
    if (!proposal) throw new EvolutionError("proposal_not_found");
    if (proposal.configFingerprint !== this.options.configFingerprint || proposal.policyVersion !== (this.options.policyVersion ?? EVOLUTION_POLICY_VERSION)) throw new EvolutionError("config_changed");
    if ((await this.options.repository.findProposalReview(id, this.scopeFingerprint))?.decision === "reject") throw new EvolutionError("proposal_review_rejected");
    if (["applied", "rejected", "noop"].includes(proposal.status)) throw new EvolutionError("proposal_not_reviewable");
    return proposal;
  }
  private async current(proposal: EvolutionProposal, signal?: AbortSignal): Promise<EvolutionInputUnit> {
    signal?.throwIfAborted();
    const batch = await this.options.repository.getBatch(proposal.batchId, this.scopeFingerprint);
    if (!batch) throw new EvolutionError("batch_not_found");
    if (batch.request.action === "execute_control") throw new EvolutionError("control_input_forbidden");
    const limits = parseEvolutionRunRequest({ input: batch.request.input, action: "preview", idempotencyKey: "review", ...(this.options.limits ? { limits: this.options.limits } : {}) }).limits;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, limits.maxDurationMs);
    let read: Awaited<ReturnType<EvolutionProposalSourcePort["read"]>>;
    try {
      read = await abortableEvolution(this.options.source.read(proposal, { input: batch.request.input, scope: this.options.scope, limits, signal: controller.signal }), controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new EvolutionError(timedOut ? "max_duration" : "cancelled");
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
    signal?.throwIfAborted();
    if (![read.recordsRead, read.filesRead, read.bytesRead].every(n => Number.isSafeInteger(n) && n >= 0) || read.recordsRead > limits.maxRecords || read.filesRead > limits.maxFiles || read.bytesRead > limits.maxBytes) throw new EvolutionError("review_source_budget_exceeded");
    const unit = read.unit;
    if (!unit || unit.id !== proposal.inputUnitId || unit.snapshotHash !== proposal.sourceSnapshotHash) throw new EvolutionError("review_source_changed");
    if (unit.targets.length + unit.evidence.length > read.recordsRead || unit.targets.length > 8 || unit.evidence.length > 8 || Buffer.byteLength(JSON.stringify(unit)) > 128_000) throw new EvolutionError("review_source_budget_exceeded");
    if ([unit.scope, ...unit.targets.map(t => t.scope), ...unit.evidence.map(e => e.scope)].some(s => authorityScopeFingerprint(s) !== this.scopeFingerprint)) throw new EvolutionError("scope_mismatch");
    if ([...unit.targets, ...unit.evidence].some(item => redactSecrets(item.text).redactedCount)) throw new EvolutionError("input_redaction_required");
    return unit;
  }
  async preview(proposalId: string, signal?: AbortSignal): Promise<EvolutionReviewItem> {
    const proposal = await this.proposal(proposalId);
    const unit = await this.current(proposal, signal);
    const binding = buildEvolutionReviewBinding(proposal, unit);
    const bindingHash = evolutionHash(binding);
    const now = this.now();
    const evidence = stageEvolutionEvidence(proposal, unit);
    if (evidence.length !== proposal.quotes.length) throw new EvolutionError("quote_mismatch");
    const stored = await this.options.repository.getStagedEvidence(proposal.id, this.scopeFingerprint);
    // Drift changes must produce a fresh proposal, not silently replace the original staged spans.
    if (evolutionHash(stored) !== evolutionHash(evidence)) throw new EvolutionError("review_source_changed");
    const createdAt = Math.floor(now / this.ttl) * this.ttl;
    return (await this.options.repository.createReview({
      id: deterministicUuid(`evolution-review:${bindingHash}:${Math.floor(now / this.ttl)}`), binding, bindingHash,
      proposal: evolutionProposalDraft(proposal), targets: proposal.targetRefs.map(ref => unit.targets.find(t => t.memoryId === ref.memoryId)!), evidence,
      status: "pending", createdAt, expiresAt: createdAt + this.ttl,
    })).review;
  }
  async decide(value: EvolutionReviewDecisionRequest, signal?: AbortSignal): Promise<EvolutionReviewReceipt> {
    const request = parseEvolutionReviewDecision(value);
    if (request.reason) request.reason = redactSecrets(request.reason).text;
    const review = await this.status(request.reviewId);
    if (!review) throw new EvolutionError("review_not_found");
    if (review.bindingHash !== request.expectedBindingHash || evolutionHash(review.binding) !== request.expectedBindingHash) throw new EvolutionError("review_binding_mismatch");
    const existing = await this.options.repository.findProposalReview(review.binding.proposalId, this.scopeFingerprint);
    if (existing?.reviewId === review.id) {
      if (existing.idempotencyKey !== request.idempotencyKey || existing.decision !== request.decision || existing.reason !== request.reason || evolutionHash(existing.actor) !== evolutionHash(this.options.actor)) throw new EvolutionError("review_decision_conflict");
      return existing;
    }
    if (review.status !== "pending") throw new EvolutionError("review_decision_conflict");
    if (review.expiresAt <= this.now()) throw new EvolutionError("approval_expired");
    const proposal = await this.proposal(review.binding.proposalId);
    const receipt: EvolutionReviewReceipt = { id: deterministicUuid(`evolution-review-receipt:${review.id}`), reviewId: review.id, binding: review.binding, bindingHash: review.bindingHash,
      decision: request.decision, actor: this.options.actor, idempotencyKey: request.idempotencyKey, decidedAt: this.now(), expiresAt: review.expiresAt,
      ...(request.reason ? { reason: redactSecrets(request.reason).text } : {}),
    };
    if (request.decision === "approve") {
      const unit = await this.current(proposal, signal);
      const validation = validateEvolutionApprovedProposal(proposal, unit, this.options.scope, receipt, this.now());
      if (!["allowed", "noop"].includes(validation.outcome)) throw new EvolutionError(validation.reasons[0] ?? "proposal_not_approvable");
    }
    signal?.throwIfAborted();
    return this.options.repository.decideReview(receipt, request.expectedBindingHash);
  }
}
