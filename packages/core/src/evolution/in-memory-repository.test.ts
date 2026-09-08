import { describe, expect, it } from "vitest";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { stageEvolutionEvidence } from "./proposal-validation.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { authority, draft, scope, unit } from "./test-fixtures.js";
import type { EvolutionProposal } from "./types.js";

async function setup() {
  let now = 100;
  const repository = new InMemoryEvolutionRepository(() => now);
  const service = new MemoryEvolutionBatchService({ authority, scope, repository, inputs: [], configFingerprint: "config", now: () => now });
  const prepared = await service.prepare({ input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "batch" });
  const fp = authorityScopeFingerprint(scope);
  const batch = (await repository.getBatch(prepared.batchId, fp))!;
  const lease = (await repository.acquireLease(batch.id, fp, "worker", 100))!;
  const input = unit();
  const proposal: EvolutionProposal = { ...draft(input), id: "proposal", batchId: batch.id, scope, scopeFingerprint: fp, inputUnitId: input.id, inputFingerprint: "fingerprint", sourceSnapshotHash: input.snapshotHash, configFingerprint: "config", policyVersion: batch.policyVersion, validation: { outcome: "allowed", reasons: [], reviewRequirement: "none", contextEligible: false, independentEvidenceRootIds: [input.evidence[0].rootEvidenceId] }, status: "staged", createdAt: now };
  const evidence = stageEvolutionEvidence(proposal, input);
  return { repository, service, fp, batch, lease, input, proposal, evidence, setNow: (value: number) => { now = value; } };
}

describe("evolution reference repository fencing and isolation", () => {
  it("rejects conflicting idempotency, stale versions and foreign batch mutations", async () => {
    const t = await setup();
    await expect(t.repository.createBatch({ ...t.batch, requestHash: "different" })).rejects.toThrow("idempotency_conflict");
    await t.repository.saveBatch(t.batch, 0, t.lease);
    await expect(t.repository.saveBatch(t.batch, 0, t.lease)).rejects.toThrow("batch_cas_conflict");
    await expect(t.repository.stageProposal({ ...t.proposal, batchId: "different" }, t.evidence, t.lease)).rejects.toThrow("scope_mismatch");
  });
  it("does not release newer leases with old tokens and forbids expired writes", async () => {
    const t = await setup();
    expect(await t.repository.acquireLease(t.batch.id, t.fp, "other", 100)).toBeUndefined();
    await t.repository.releaseLease({ ...t.lease, fencingToken: 999 });
    expect(await t.repository.acquireLease(t.batch.id, t.fp, "other", 100)).toBeUndefined();
    t.setNow(201);
    const next = (await t.repository.acquireLease(t.batch.id, t.fp, "other", 100))!;
    expect(next.fencingToken).toBe(t.lease.fencingToken + 1);
    await expect(t.repository.saveBatch(t.batch, 0, t.lease)).rejects.toThrow("lease_lost");
    await expect(t.repository.acquireLease("missing", t.fp, "worker", 100)).rejects.toThrow("batch_not_found");
    await t.repository.releaseLease(next);
  });
  it("rejects same-id changed proposal diffs or staged spans instead of silently accepting a replacement", async () => {
    const t = await setup();
    await t.repository.stageProposal(t.proposal, t.evidence, t.lease);
    await expect(t.repository.stageProposal({ ...t.proposal, proposedText: "Different unapproved immutable proposal text." }, t.evidence, t.lease)).rejects.toThrow("proposal_conflict");
    await expect(t.repository.stageProposal(t.proposal, [{ ...t.evidence[0], trust: "untrusted" }], t.lease)).rejects.toThrow("proposal_conflict");
    await expect(t.repository.stageProposal({ ...t.proposal, createdAt: 101 }, t.evidence, t.lease)).rejects.toThrow("proposal_conflict");
    expect(await t.repository.stageProposal(t.proposal, t.evidence, t.lease)).toEqual(t.proposal);
  });
  it("requires a scoped staged proposal for processed proof and forbids a second owner for the same input action", async () => {
    const t = await setup();
    await t.repository.stageProposal(t.proposal, t.evidence, t.lease);
    const processed = { scopeFingerprint: t.fp, inputFingerprint: t.proposal.inputFingerprint, action: "propose" as const, proposalId: t.proposal.id, processedAt: 100 };
    await expect(t.repository.recordProcessed({ ...processed, scopeFingerprint: "foreign" }, t.lease)).rejects.toThrow("scope_mismatch");
    await expect(t.repository.recordProcessed({ ...processed, proposalId: "missing" }, t.lease)).rejects.toThrow("proposal_missing");
    await t.repository.recordProcessed(processed, t.lease);
    await t.repository.stageProposal({ ...t.proposal, id: "second" }, t.evidence, t.lease);
    await expect(t.repository.recordProcessed({ ...processed, proposalId: "second" }, t.lease)).rejects.toThrow("idempotency_conflict");
    await t.repository.recordProcessed({ ...processed, processedAt: 110 }, t.lease);
    expect((await t.repository.findProcessed(t.fp, processed.inputFingerprint, "propose"))?.processedAt).toBe(100);
    expect(await t.repository.findProcessed(t.fp, processed.inputFingerprint, "apply_allowed")).toBeUndefined();
  });
  it("never commits review-only or missing proposals and keeps receipts immutable", async () => {
    const t = await setup();
    const receipt = { id: "receipt", batchId: t.batch.id, proposalId: t.proposal.id, scopeFingerprint: t.fp, operation: "create" as const, outcome: "applied" as const, memoryIds: ["memory"], committedAt: 100 };
    await expect(t.repository.commitReceipt(receipt, t.lease)).rejects.toThrow("apply_not_allowed");
    await t.repository.stageProposal(t.proposal, t.evidence, t.lease);
    await t.repository.commitReceipt(receipt, t.lease);
    await t.repository.commitReceipt({ ...receipt, committedAt: 110 }, t.lease);
    expect(await t.repository.getReceipt(t.proposal.id, t.fp)).toEqual(receipt);
    const review = { ...t.proposal, id: "reviewed", validation: { ...t.proposal.validation, outcome: "review" as const } };
    await t.repository.stageProposal(review, t.evidence, t.lease);
    await expect(t.repository.commitReceipt({ ...receipt, proposalId: review.id }, t.lease)).rejects.toThrow("apply_not_allowed");
  });
  it("returns no foreign proposal/evidence/cancellation and leaves a completed batch completed", async () => {
    const t = await setup();
    await t.repository.stageProposal(t.proposal, t.evidence, t.lease);
    expect(await t.repository.getProposal(t.proposal.id, "other")).toBeUndefined();
    expect(await t.repository.getStagedEvidence(t.proposal.id, "other")).toEqual([]);
    expect(await t.repository.requestCancellation(t.batch.id, "other", 101)).toBeUndefined();
    await t.repository.saveBatch({ ...t.batch, status: "completed" }, 0, t.lease);
    expect(await t.repository.requestCancellation(t.batch.id, t.fp, 101)).toMatchObject({ status: "completed" });
  });
});
