import { describe, expect, it, vi } from "vitest";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { MemoryEvolutionReviewService } from "./review-service.js";
import { validateEvolutionApprovedProposal } from "./proposal-validation.js";
import { authority, draft, inputPort, scope, unit } from "./test-fixtures.js";
import type { EvolutionApplyReceipt, EvolutionGovernedWriter, EvolutionProposal, EvolutionProposalSourcePort, EvolutionReviewActor } from "./types.js";

const actor: EvolutionReviewActor = { tenantId: scope.tenantId, userId: scope.userId, actorId: "local-operator", authentication: "local_owner" };
async function setup(options: { incomplete?: boolean } = {}) {
  let now = 1000;
  const input = unit();
  input.evidence[0].trust = "untrusted";
  if (options.incomplete) input.evidence[0].contextIncomplete = true;
  const repository = new InMemoryEvolutionRepository(() => now);
  const stage = vi.spyOn(repository, "stageProposal");
  const proposer = { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose: vi.fn(async () => draft(input)) };
  const source: EvolutionProposalSourcePort = { read: vi.fn(async () => ({ unit: structuredClone(input), recordsRead: input.evidence.length + input.targets.length, filesRead: 0, bytesRead: Buffer.byteLength(input.evidence[0].text) })) };
  const batchOptions = { authority, scope, repository, configFingerprint: "config", inputs: [inputPort([input])], proposer, reviews: repository, proposalSource: source, now: () => now };
  const batches = new MemoryEvolutionBatchService(batchOptions);
  await batches.run({ input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "proposal" });
  const proposal = stage.mock.calls[0][0] as EvolutionProposal;
  const reviewOptions = { authority, scope, repository, configFingerprint: "config", source, actor, now: () => now, reviewTtlMs: 1000 };
  const reviews = new MemoryEvolutionReviewService(reviewOptions);
  return { input, repository, proposal, batches, reviews, proposer, source, options: batchOptions, reviewOptions, setNow: (n: number) => { now = n; } };
}

describe("dedicated evolution owner review", () => {
  it("binds the exact staged diff and approves unknown authors only as reviewed references", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    expect(review).toMatchObject({ status: "pending", binding: { proposalId: t.proposal.id, sourceSnapshotHash: t.input.snapshotHash, targetRefs: [] } });
    expect(review.evidence[0]).not.toHaveProperty("text");
    const request = { reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve" as const, idempotencyKey: "approve" };
    const approval = await t.reviews.decide(request);
    expect(await t.reviews.decide(request)).toEqual(approval);
    expect(await t.reviews.status(review.id)).toMatchObject({ status: "approved" });
    expect(validateEvolutionApprovedProposal(t.proposal, t.input, scope, approval, 1000)).toMatchObject({ outcome: "allowed", evidenceMode: "reviewed_reference", independentEvidenceRootIds: [], contextEligible: false, ownerApprovalReceiptId: approval.id });
    expect(t.input.evidence[0].trust).toBe("untrusted");
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("does not accept injected owner, diff, expiry or authority request fields", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    for (const key of ["actor", "scope", "expiresAt", "proposedText", "approval"]) {
      await expect(t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "x", [key]: "owner" })).rejects.toThrow("schema_invalid");
    }
    expect(() => new MemoryEvolutionReviewService({ ...t.reviewOptions, actor: { ...actor, userId: "other" } })).toThrow("review_authority_mismatch");
  });
  it("rejects changed source, altered binding, expired approvals and current target drift", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    await expect(t.reviews.decide({ reviewId: review.id, expectedBindingHash: "0".repeat(64), decision: "approve", idempotencyKey: "bad" })).rejects.toThrow("review_binding_mismatch");
    const approval = await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "okay" });
    t.input.snapshotHash = "1".repeat(64);
    expect(() => validateEvolutionApprovedProposal(t.proposal, t.input, scope, approval, 1000)).toThrow("approval_binding_mismatch");
    t.input.snapshotHash = t.proposal.sourceSnapshotHash;
    t.setNow(2001);
    expect(() => validateEvolutionApprovedProposal(t.proposal, t.input, scope, approval, 2001)).toThrow("approval_expired");
  });
  it("keeps rejection terminal for unchanged inputs without another model proposal", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "reject", idempotencyKey: "reject", reason: "Unsupported change" });
    await expect(t.reviews.preview(t.proposal.id)).rejects.toThrow("proposal_review_rejected");
    await t.batches.run({ input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "same-source" });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("does not let administrative approval waive incomplete context or unrelated quotes", async () => {
    const t = await setup({ incomplete: true });
    const review = await t.reviews.preview(t.proposal.id);
    await expect(t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "incomplete" })).rejects.toThrow("source_context_incomplete");
  });
  it("checks current source again before approval and never promotes a stale review", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    t.input.evidence[0].text += " Except in production.";
    await expect(t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "drift" })).rejects.toThrow();
    expect(await t.repository.findProposalReview(t.proposal.id, t.proposal.scopeFingerprint)).toBeUndefined();
  });
  it("has a bounded source re-read and fails before any decision mutation if it exceeds the allowance", async () => {
    const t = await setup();
    t.source.read = async () => ({ unit: t.input, recordsRead: 1001, filesRead: 0, bytesRead: 10 });
    await expect(t.reviews.preview(t.proposal.id)).rejects.toThrow("review_source_budget_exceeded");
  });
  it("prepares and replays the approved staged proposal without another LLM or changing evidence trust", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    const approval = await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "approved-replay" });
    const writer: EvolutionGovernedWriter = { supportedOperations: ["create"], apply: vi.fn(async context => {
      expect(context.approval).toEqual(approval);
      expect(context.evidence[0].trust).toBe("untrusted");
      expect(await context.verifySource()).toMatchObject({ valid: true });
      const receipt: EvolutionApplyReceipt = { id: "written", proposalId: context.proposal.id, batchId: context.proposal.batchId, scopeFingerprint: context.proposal.scopeFingerprint, operation: "create", outcome: "applied", memoryIds: ["new-head"], committedAt: 1000 };
      await t.repository.commitReceipt(receipt, context.lease);
      return { outcome: "applied" as const, receipt, replayed: false };
    }) };
    const service = new MemoryEvolutionBatchService({ ...t.options, writer });
    const read = vi.mocked(t.source.read).mock.calls.length;
    const queued = await service.prepareApproved(approval.id);
    expect(queued.status).toBe("queued");
    expect(vi.mocked(t.source.read).mock.calls.length).toBe(read);
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "completed", counts: { applied: 1 }, usage: { llmCalls: 0 } });
    expect(await service.replayApproved(approval.id)).toMatchObject({ batchId: queued.batchId, status: "completed" });
    expect(writer.apply).toHaveBeenCalledTimes(1);
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("blocks approved replay after a source snapshot change and never calls the writer", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    const approval = await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "source-drift" });
    const writer: EvolutionGovernedWriter = { supportedOperations: ["create"], apply: vi.fn() };
    const service = new MemoryEvolutionBatchService({ ...t.options, writer });
    const queued = await service.prepareApproved(approval.id);
    t.input.snapshotHash = "f".repeat(64);
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "blocked", reasons: ["approval_binding_mismatch"] });
    expect(writer.apply).not.toHaveBeenCalled();
  });
  it("reuses the exact approved stage after a transient writer failure without replacing its creation time", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    const approval = await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "writer-retry" });
    let attempts = 0;
    const writer: EvolutionGovernedWriter = { supportedOperations: ["create"], apply: vi.fn(async context => {
      if (++attempts === 1) throw new Error("transient writer failure");
      expect(context.proposal.createdAt).toBe(1000);
      expect(await context.verifySource()).toMatchObject({ valid: true });
      const receipt: EvolutionApplyReceipt = { id: "retried", proposalId: context.proposal.id, batchId: context.proposal.batchId, scopeFingerprint: context.proposal.scopeFingerprint, operation: "create", outcome: "applied", memoryIds: ["new-head"], committedAt: 1100 };
      await t.repository.commitReceipt(receipt, context.lease);
      return { outcome: "applied" as const, receipt, replayed: false };
    }) };
    const service = new MemoryEvolutionBatchService({ ...t.options, writer });
    const queued = await service.prepareApproved(approval.id);
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "failed", segment: { attempt: 1 } });
    t.setNow(1100);
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "completed", segment: { attempt: 1 }, counts: { applied: 1, proposed: 1 }, usage: { llmCalls: 0 } });
    expect(writer.apply).toHaveBeenCalledTimes(2);
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("persists cancellation, never un-cancels on worker retry, and permits only explicit bounded resume", async () => {
    const t = await setup();
    const queued = await t.batches.prepare({ input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "cancel-me" });
    expect(await t.batches.cancel(queued.batchId)).toMatchObject({ status: "cancelled" });
    expect(await t.batches.retry(queued.batchId)).toMatchObject({ status: "cancelled", segment: { attempt: 1 } });
    expect(await t.batches.resume(queued.batchId)).toMatchObject({ status: "completed", segment: { attempt: 2 } });
  });
  it("retains IO reservations on failed approved reads so durable retry cannot refill them", async () => {
    const t = await setup();
    const review = await t.reviews.preview(t.proposal.id);
    const approval = await t.reviews.decide({ reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "io-budget" });
    const service = new MemoryEvolutionBatchService({ ...t.options, writer: { supportedOperations: ["create"], apply: vi.fn() } });
    const queued = await service.prepareApproved(approval.id, { maxRecords: 5, maxBytes: 1000 });
    t.source.read = vi.fn(async () => { throw new Error("read interrupted after IO"); });
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "failed", usage: { records: 5, bytes: 1000 } });
    expect(await service.retry(queued.batchId)).toMatchObject({ status: "partial", reasons: ["max_records"], segment: { attempt: 1 } });
    expect(t.source.read).toHaveBeenCalledTimes(1);
    await service.resume(queued.batchId);
    expect(t.source.read).toHaveBeenCalledTimes(2);
  });
  it("lists bounded proposals, retains rejected detail, and gives no cross-owner existence leak", async () => {
    const t = await setup();
    expect(await t.reviews.list({ limit: 1, status: "review" })).toMatchObject({ proposals: [{ id: t.proposal.id }] });
    expect(await t.reviews.detail(t.proposal.id)).toMatchObject({ proposal: { id: t.proposal.id }, evidence: [{ trust: "untrusted" }] });
    await expect(t.reviews.list({ limit: 51 })).rejects.toThrow("schema_invalid");
    const other = new MemoryEvolutionReviewService({ ...t.reviewOptions, scope: { ...scope, userId: "other" }, authority: { ...authority, userId: "other" }, actor: { ...actor, userId: "other" } });
    expect(await other.list()).toEqual({ proposals: [] });
    expect(await other.detail(t.proposal.id)).toBeUndefined();
  });
  it("replays the same review preview throughout its bounded validity window", async () => {
    const t = await setup(); const first = await t.reviews.preview(t.proposal.id);
    t.setNow(1100);
    expect(await t.reviews.preview(t.proposal.id)).toEqual(first);
  });
  it("does not lose a cancellation arriving during a leased batch save", async () => {
    const t = await setup();
    const queued = await t.batches.prepare({ input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "race" });
    const batch = (await t.repository.getBatch(queued.batchId, t.proposal.scopeFingerprint))!;
    const lease = (await t.repository.acquireLease(batch.id, batch.scopeFingerprint, "worker", 1000))!;
    await t.batches.cancel(batch.id);
    const saved = await t.repository.saveBatch({ ...batch, status: "running" }, batch.version, lease);
    expect(saved).toMatchObject({ status: "cancelled", cancelRequestedAt: 1000 });
    await t.repository.releaseLease(lease);
  });
  it.each(["cancel", "timeout"] as const)("bounds a noncooperative source read on %s", async mode => {
    const t = await setup();
    let release!: () => void; let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    t.source.read = async () => { started(); await gate; return { unit: t.input, recordsRead: 1, filesRead: 0, bytesRead: 100 }; };
    const controller = new AbortController();
    const reviews = new MemoryEvolutionReviewService({ ...t.reviewOptions, limits: { maxDurationMs: mode === "timeout" ? 5 : 1000 } });
    const pending = reviews.preview(t.proposal.id, controller.signal).then(() => "done", error => error.code);
    await ready;
    if (mode === "cancel") controller.abort();
    try {
      const outcome = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve("still_waiting"), 50))]);
      expect(outcome).toBe(mode === "cancel" ? "cancelled" : "max_duration");
    } finally { release(); await pending; }
  });
});
