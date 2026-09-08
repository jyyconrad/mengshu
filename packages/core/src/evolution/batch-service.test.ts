import { describe, expect, it, vi } from "vitest";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { authority, draft, inputPort, scope, unit } from "./test-fixtures.js";
import type { EvolutionApplyReceipt, EvolutionGovernedWriter, EvolutionInputUnit, EvolutionProposer, EvolutionRunRequest } from "./types.js";

const request: EvolutionRunRequest = { input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "batch-1" };
function setup(units: EvolutionInputUnit[] = [unit()]) {
  const repository = new InMemoryEvolutionRepository();
  const input = inputPort(units);
  const proposer: EvolutionProposer = { available: true, maxAttempts: 1, estimateInputTokens: () => 32, propose: vi.fn(async u => draft(u)) };
  const writer: EvolutionGovernedWriter = { supportedOperations: ["create", "correct"], apply: vi.fn(async ({ proposal, lease }) => {
    const receipt: EvolutionApplyReceipt = { id: `receipt-${proposal.id}`, batchId: proposal.batchId, proposalId: proposal.id, scopeFingerprint: proposal.scopeFingerprint, operation: proposal.operation, outcome: "applied", memoryIds: ["created-memory"], committedAt: Date.now() };
    await repository.commitReceipt(receipt, lease);
    return { outcome: "applied" as const, receipt, replayed: false };
  }) };
  const options = { authority, scope, configFingerprint: "global-config-v1", repository, inputs: [input], proposer, writer };
  return { repository, input, proposer, writer, options, service: new MemoryEvolutionBatchService(options) };
}
describe("memory evolution batches", () => {
  it("prepare creates a real queued batch without source/model access and is enqueue-replay safe", async () => {
    const t = setup();
    const open = vi.spyOn(t.input, "open");
    const prepared = await t.service.prepare(request);
    expect(prepared).toMatchObject({ status: "queued", segment: { attempt: 1, usage: { llmCalls: 0 } } });
    expect(await t.service.prepare(request)).toEqual(prepared);
    expect(open).not.toHaveBeenCalled();
    expect(t.proposer.propose).not.toHaveBeenCalled();
    expect(await t.service.status(prepared.batchId)).toEqual(prepared);
    expect(await t.service.retry(prepared.batchId)).toMatchObject({ status: "completed" });
  });
  it("prepareResume grants exactly one segment across enqueue failure and worker retries", async () => {
    const t = setup([unit("one"), unit("two")]);
    const first = await t.service.run({ ...request, limits: { maxLlmCalls: 1 } });
    expect(first.status).toBe("partial");
    expect(await t.service.retry(first.batchId)).toMatchObject({ status: "partial", segment: { attempt: 1 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
    const continued = await t.service.prepareResume(first.batchId);
    expect(continued).toMatchObject({ status: "queued", usage: { llmCalls: 1 }, segment: { attempt: 2, usage: { llmCalls: 0 } } });
    expect(await t.service.prepareResume(first.batchId)).toEqual(continued);
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
    expect(await t.service.retry(first.batchId)).toMatchObject({ status: "completed", segment: { attempt: 2, usage: { llmCalls: 1 } } });
  });
  it("retains ordinary input IO reservations after an interrupted read and does not refill them on durable retry", async () => {
    const t = setup();
    t.input.readPage = vi.fn(async () => { throw new Error("interrupted source after read"); });
    const first = await t.service.run({ ...request, limits: { maxRecords: 5, maxFiles: 2, maxBytes: 1000 } });
    expect(first).toMatchObject({ status: "failed", usage: { records: 5, files: 2, bytes: 1000 }, segment: { attempt: 1 } });
    expect(await t.service.retry(first.batchId)).toMatchObject({ status: "partial", reasons: ["max_records"], segment: { attempt: 1 } });
    expect(t.input.readPage).toHaveBeenCalledTimes(1);
    expect(await t.service.resume(first.batchId)).toMatchObject({ status: "failed", usage: { records: 10, files: 4, bytes: 2000 }, segment: { attempt: 2 } });
    expect(t.input.readPage).toHaveBeenCalledTimes(2);
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it("reports already-read bytes if an adapter overruns its allowance instead of claiming zero IO", async () => {
    const t = setup();
    t.input.readPage = async () => ({ units: [], nextCursor: null, complete: false, recordsRead: 1, filesRead: 1, bytesRead: 101 });
    expect(await t.service.run({ ...request, limits: { maxBytes: 100 } })).toMatchObject({ status: "partial", reasons: ["input_budget_exceeded"], usage: { records: 1, files: 1, bytes: 101 } });
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it("continues empty metadata pages with exclusive cursor progress; real stagnation remains partial", async () => {
    const t = setup();
    const read = t.input.readPage;
    t.input.readPage = vi.fn(async context => context.cursor === null ? { units: [], nextCursor: "metadata", complete: false, bytesRead: 10, filesRead: 0 } : read({ ...context, cursor: null }));
    expect(await t.service.run(request)).toMatchObject({ status: "completed", counts: { proposed: 1 } });
    const stalled = setup();
    stalled.input.readPage = async () => ({ units: [], nextCursor: null, complete: false, bytesRead: 0, filesRead: 0 });
    expect(await stalled.service.run(request)).toMatchObject({ status: "partial", reasons: ["input_gap"] });
  });
  it("preview has no model call or canonical write", async () => {
    const t = setup();
    expect(await t.service.run({ ...request, action: "preview" })).toMatchObject({ status: "completed", counts: { proposed: 0, applied: 0 } });
    expect(t.proposer.propose).not.toHaveBeenCalled();
    expect(t.writer.apply).not.toHaveBeenCalled();
  });
  it("propose stages isolated quotes without invoking writer", async () => {
    const t = setup();
    const report = await t.service.run(request);
    expect(report).toMatchObject({ status: "completed", counts: { proposed: 1, applied: 0 } });
    expect(t.writer.apply).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(unit().evidence[0].text);
  });
  it("unchanged input skips LLM across different idempotency keys", async () => {
    const t = setup();
    await t.service.run(request);
    const again = await t.service.run({ ...request, idempotencyKey: "batch-2" });
    expect(again.counts.skipped).toBe(1);
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("configuration changes invalidate fingerprints and refuse mixed resume", async () => {
    const t = setup();
    const initial = await t.service.run(request);
    const updated = new MemoryEvolutionBatchService({ ...t.options, configFingerprint: "global-config-v2" });
    await updated.run({ ...request, idempotencyKey: "batch-2" });
    expect(t.proposer.propose).toHaveBeenCalledTimes(2);
    await expect(updated.resume(initial.batchId)).rejects.toThrow("config_changed");
  });
  it("rejects idempotency reuse with a different request", async () => {
    const t = setup();
    await t.service.run(request);
    await expect(t.service.run({ ...request, action: "preview" })).rejects.toThrow("idempotency_conflict");
  });
  it("a missing apply capability is blocked, not success", async () => {
    const t = setup();
    const s = new MemoryEvolutionBatchService({ ...t.options, writer: undefined });
    expect(await s.run({ ...request, action: "apply_allowed" })).toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["apply_capability_unavailable"]) });
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it("applies only through the writer and requires its committed receipt", async () => {
    const t = setup();
    const report = await t.service.run({ ...request, action: "apply_allowed" });
    expect(report).toMatchObject({ status: "completed", counts: { applied: 1 } });
    expect(t.writer.apply).toHaveBeenCalledTimes(1);
    expect(await t.service.resume(report.batchId)).toMatchObject({ status: "completed" });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("rejects forged writer success without repository receipt", async () => {
    const t = setup();
    t.writer.apply = vi.fn(async ({ proposal }) => ({ outcome: "applied" as const, replayed: false, receipt: { id: "fake", proposalId: proposal.id, batchId: proposal.batchId, scopeFingerprint: proposal.scopeFingerprint, operation: "create" as const, outcome: "applied" as const, memoryIds: [], committedAt: 1 } }));
    expect(await t.service.run({ ...request, action: "apply_allowed" })).toMatchObject({ status: "blocked", reasons: expect.arrayContaining(["apply_receipt_missing"]) });
  });
  it("resumes cancelled batches without re-proposing the completed unit", async () => {
    const t = setup([unit("one"), unit("two")]);
    const controller = new AbortController();
    t.input.acknowledge = vi.fn(async () => controller.abort());
    const report = await t.service.run({ ...request, action: "apply_allowed" }, controller.signal);
    expect(report.status).toBe("cancelled");
    t.input.acknowledge = undefined;
    const resumed = await new MemoryEvolutionBatchService(t.options).resume(report.batchId);
    expect(resumed).toMatchObject({ status: "completed", counts: { proposed: 2 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(2);
  });
  it("automatic retry retains exhausted budgets; explicit resume grants one bounded segment", async () => {
    const t = setup([unit("one"), unit("two")]);
    const report = await t.service.run({ ...request, limits: { maxLlmCalls: 1 } });
    expect(report).toMatchObject({ status: "partial", reasons: expect.arrayContaining(["max_llm_calls"]) });
    await t.service.run({ ...request, limits: { maxLlmCalls: 1 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
    const resumed = await t.service.resume(report.batchId);
    expect(resumed).toMatchObject({ status: "completed", usage: { llmCalls: 2 }, segment: { attempt: 2, usage: { llmCalls: 1 } } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(2);
  });
  it("rejects changed source hashes before canonical apply", async () => {
    const t = setup();
    t.input.verifyUnit = vi.fn().mockResolvedValueOnce({ valid: true }).mockResolvedValue({ valid: false, reason: "source_changed" });
    expect(await t.service.run({ ...request, action: "apply_allowed" })).toMatchObject({ counts: { applied: 0, rejected: 1 } });
    expect(t.writer.apply).not.toHaveBeenCalled();
  });
  it("preserves owner review when switching from propose to apply without another model call", async () => {
    const t = setup();
    t.proposer.propose = vi.fn(async u => ({ ...draft(u), claimClass: "decision" }));
    const staged = await t.service.run(request);
    expect(staged.counts.review).toBe(1);
    const applied = await t.service.run({ ...request, action: "apply_allowed", idempotencyKey: "apply" });
    expect(applied).toMatchObject({ status: "blocked", counts: { review: 1, applied: 0 } });
    expect(await t.service.resume(applied.batchId)).toMatchObject({ status: "blocked", counts: { review: 1 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
    expect(t.writer.apply).not.toHaveBeenCalled();
  });
  it("never sends an extra unrelated trusted quote to the writer, including staged proposal reuse", async () => {
    const input = unit();
    const extra = unit("extra", "The unrelated retention period is thirty days.").evidence[0];
    input.evidence.push(extra);
    const t = setup([input]);
    const stage = vi.spyOn(t.repository, "stageProposal");
    t.proposer.propose = vi.fn(async u => ({ ...draft(u), quotes: [...draft(u).quotes, { evidenceId: extra.id, quote: extra.text, start: 0, end: extra.text.length }] }));
    expect(await t.service.run(request)).toMatchObject({ status: "completed", counts: { review: 1, applied: 0 } });
    expect(stage.mock.calls[0][0].validation).toMatchObject({ outcome: "review", reasons: ["unrelated_evidence_requires_review"], independentEvidenceRootIds: [] });
    expect(await t.service.run({ ...request, action: "apply_allowed", idempotencyKey: "apply-extra-quote" })).toMatchObject({ status: "blocked", counts: { review: 1, applied: 0 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
    expect(t.writer.apply).not.toHaveBeenCalled();
  });
  it("records a terminal schema rejection, discards forged evidence, and skips unchanged model output", async () => {
    const t = setup();
    const stage = vi.spyOn(t.repository, "stageProposal");
    t.proposer.propose = vi.fn(async u => ({ ...draft(u), authority: "owner" }));
    expect(await t.service.run(request)).toMatchObject({ status: "completed", counts: { rejected: 1 }, reasons: expect.arrayContaining(["schema_invalid"]) });
    expect(stage.mock.calls[0][1]).toEqual([]);
    expect(await t.service.run({ ...request, idempotencyKey: "second" })).toMatchObject({ counts: { skipped: 1 } });
    expect(t.proposer.propose).toHaveBeenCalledTimes(1);
  });
  it("requires redaction before dispatching potentially secret-bearing inventory to a model", async () => {
    const t = setup([unit("secret", "API_KEY=synthetic-credential-for-redaction-testing")]);
    expect(await t.service.run(request)).toMatchObject({ status: "blocked", reasons: ["input_redaction_required"] });
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it("accounts actual strong-read bytes and blocks repeat verification from bypassing reservations", async () => {
    const input = unit();
    input.verificationBudget = { records: 1, files: 1, bytes: 500 };
    const t = setup([input]);
    t.input.verifyUnit = vi.fn(async () => ({ valid: true, bytesRead: 100 }));
    const result = await t.service.run(request);
    expect(result.usage.bytes).toBe(Buffer.byteLength(input.evidence[0].text) + 100);
    expect(result.usageAccounting).toBe("budget_reservation");
    const blocked = setup([input]);
    const verify = vi.spyOn(blocked.input, "verifyUnit");
    expect(await blocked.service.run({ ...request, limits: { maxBytes: 100 } })).toMatchObject({ status: "partial", reasons: ["max_bytes"] });
    expect(verify).not.toHaveBeenCalled();
  });
  it("does not leak batch existence across host scope", async () => {
    const t = setup();
    const report = await t.service.run(request);
    const other = new MemoryEvolutionBatchService({ ...t.options, scope: { ...scope, userId: "other" }, authority: { ...authority, userId: "other" } });
    expect(await other.status(report.batchId)).toBeUndefined();
  });
  it("precharges verification outside the writer transaction without nested repository writes", async () => {
    const t = setup();
    const apply = t.writer.apply;
    const save = t.repository.saveBatch.bind(t.repository);
    let insideWriter = false;
    t.repository.saveBatch = vi.fn<typeof save>(async (...args) => {
      expect(insideWriter).toBe(false);
      return save(...args);
    });
    t.writer.apply = vi.fn(async context => {
      insideWriter = true;
      expect(await context.verifySource()).toEqual({ valid: true });
      expect(await context.verifySource()).toEqual({ valid: false, reason: "verification_budget_exhausted" });
      const result = await apply(context);
      insideWriter = false;
      return result;
    });
    expect(await t.service.run({ ...request, action: "apply_allowed" })).toMatchObject({ status: "completed" });
  });
  it.each(["maxInputTokens", "maxOutputTokens"] as const)("keeps a hard %s budget before model dispatch", async limit => {
    const t = setup();
    expect(await t.service.run({ ...request, limits: { [limit]: 0 } })).toMatchObject({ status: "partial" });
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it.each(["attempts", "tokens"] as const)("rejects an invalid model %s reservation", async field => {
    const t = setup();
    t.options.proposer = { ...t.proposer, ...(field === "attempts" ? { maxAttempts: 0 } : { estimateInputTokens: () => NaN }) };
    const service = new MemoryEvolutionBatchService(t.options);
    expect(await service.run(request)).toMatchObject({ status: "blocked", reasons: ["model_budget_invalid"] });
    expect(t.proposer.propose).not.toHaveBeenCalled();
  });
  it.each(["records", "bytes", "checkpoint", "scope"] as const)("rejects an invalid input %s contract without model/canonical activity", async field => {
    const t = setup();
    const u = unit();
    if (field === "scope") u.scope = { ...scope, userId: "other" };
    t.input.readPage = async () => ({ units: [u], recordsRead: field === "records" ? 0 : 1, bytesRead: field === "bytes" ? NaN : 10, filesRead: 0, complete: true, nextCursor: field === "checkpoint" ? { text: "source-content" } : 1 });
    const result = await t.service.run(request);
    expect(["blocked", "failed"]).toContain(result.status);
    expect(t.proposer.propose).not.toHaveBeenCalled(); expect(t.writer.apply).not.toHaveBeenCalled();
  });
  it("reports absent input, writer and durable proposal capabilities precisely", async () => {
    const t = setup();
    expect(await new MemoryEvolutionBatchService({ ...t.options, inputs: [] }).run(request)).toMatchObject({ status: "blocked", reasons: ["input_capability_unavailable"] });
    const absent = setup();
    expect(await new MemoryEvolutionBatchService({ ...absent.options, writer: undefined }).run({ ...request, action: "apply_allowed" })).toMatchObject({ reasons: ["apply_capability_unavailable"] });
    const missing = setup(); missing.repository.findProcessed = async () => ({ scopeFingerprint: "scope", inputFingerprint: "fingerprint", proposalId: "missing", action: "propose", processedAt: 100 });
    expect(await missing.service.run(request)).toMatchObject({ status: "blocked", reasons: ["processed_proposal_missing"] });
  });
});
