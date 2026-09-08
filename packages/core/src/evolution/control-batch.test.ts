import { describe, expect, test, vi } from "vitest";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { parseEvolutionControlRequest, parseEvolutionRunRequest } from "./schema.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { evolutionHash } from "./fingerprints.js";
import { authority, inputPort, scope } from "./test-fixtures.js";
import type { EvolutionControlPort, EvolutionControlRequest } from "./types.js";

const request: EvolutionControlRequest = { input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes" } },
  action: "execute_control", idempotencyKey: "control-one", limits: { maxRecords: 20, maxFiles: 2, maxBytes: 1000, maxDurationMs: 10_000 } };
function fixture() {
  const repository = new InMemoryEvolutionRepository(), input = inputPort([]);
  const open = vi.spyOn(input, "open"), create = vi.spyOn(repository, "createBatch");
  const execute = vi.fn<EvolutionControlPort["execute"]>(async () => ({ status: "completed", receiptId: "a".repeat(64),
    sourceManifestConfirmed: true, sourceSnapshotHash: "b".repeat(64) }));
  const authorizePrepare = vi.fn<EvolutionControlPort["authorizePrepare"]>(async value => { parseEvolutionControlRequest(value); });
  const control: EvolutionControlPort = { authorizePrepare, execute };
  const service = new MemoryEvolutionBatchService({ repository, authority, scope, configFingerprint: "c".repeat(64), inputs: [input], control });
  return { repository, create, execute, authorizePrepare, service, open };
}

describe("explicit evolution control batches", () => {
  test.each([
    { kind: "source_reconcile", sourceId: "notes" },
    { kind: "source_revoke", sourceId: "notes", expectedRevision: "r1", reviewReceiptId: "review" },
    { kind: "undo_governance", operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64), reviewReceiptId: "review" },
  ])("$kind is a closed non-model work request, never an ordinary preview", work => {
    const parsed = parseEvolutionControlRequest({ ...request, input: { mode: "control", work } });
    expect(parsed.input.work).toEqual(work);
    expect(parsed.limits).toMatchObject({ maxLlmCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 });
    expect(() => parseEvolutionRunRequest(parsed)).toThrow("schema_invalid");
  });
  test.each([
    { ...request, action: "preview" }, { ...request, path: "/private" }, { ...request, model: "other" },
    { ...request, authority }, { ...request, limits: { maxLlmCalls: 1 } },
    { ...request, input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes:other" } } },
    { ...request, input: { mode: "control", work: { kind: "custom_handler", sourceId: "notes" } } },
    { ...request, input: { mode: "control", work: { kind: "source_revoke", sourceId: "notes", expectedRevision: "r1" } } },
  ])("rejects unsupported or unbound control fields", value => {
    expect(() => parseEvolutionControlRequest(value)).toThrow("schema_invalid");
  });
  test("prepare requires the host owner before a real batch is created; execute has the actual lease", async () => {
    const f = fixture();
    f.authorizePrepare.mockRejectedValueOnce(new Error("owner required"));
    await expect(f.service.prepareControl(request)).rejects.toThrow("owner required");
    expect(f.create).not.toHaveBeenCalled();
    const prepared = await f.service.prepareControl(request);
    expect(prepared).toMatchObject({ status: "queued", work: { kind: "source_reconcile" }, usage: { records: 0, llmCalls: 0 } });
    expect(f.open).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
    expect(await f.service.prepareControl(request)).toEqual(prepared);
    f.execute.mockImplementationOnce(async context => {
      const batch = await f.repository.getBatch(prepared.batchId, authorityScopeFingerprint(scope));
      expect(batch?.requestHash).toBe(evolutionHash(parseEvolutionControlRequest(request)));
      expect(batch?.usage).toMatchObject({ records: 20, files: 2, bytes: 1000 });
      expect(context.lease).toMatchObject({ batchId: prepared.batchId, scopeFingerprint: authorityScopeFingerprint(scope) });
      expect(context.batchId).toBe(prepared.batchId); expect(context.request.input.work.kind).toBe("source_reconcile");
      return { status: "completed", receiptId: "a".repeat(64), sourceManifestConfirmed: true, sourceSnapshotHash: "b".repeat(64) };
    });
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ status: "completed", counts: { applied: 1 },
      work: { kind: "source_reconcile", result: { receiptId: "a".repeat(64), sourceManifestConfirmed: true } }, usage: { llmCalls: 0 } });
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ status: "completed" });
    expect(f.execute).toHaveBeenCalledTimes(1); expect(f.open).not.toHaveBeenCalled();
  });
  test("automatic retry keeps uncertain I/O reserved; only an authenticated explicit resume starts a new segment", async () => {
    const f = fixture(), batch = await f.service.prepareControl(request);
    f.execute.mockRejectedValueOnce(new Error("commit status unknown"));
    expect(await f.service.retry(batch.batchId)).toMatchObject({ status: "failed", usage: { records: 20, files: 2, bytes: 1000 } });
    expect(await f.service.retry(batch.batchId)).toMatchObject({ status: "partial", reasons: ["max_records"], segment: { attempt: 1 } });
    expect(f.execute).toHaveBeenCalledTimes(1);
    f.authorizePrepare.mockRejectedValueOnce(new Error("owner required"));
    await expect(f.service.prepareResume(batch.batchId)).rejects.toThrow("owner required");
    expect(await f.service.prepareResume(batch.batchId)).toMatchObject({ status: "queued", segment: { attempt: 2 } });
    expect(await f.service.retry(batch.batchId)).toMatchObject({ status: "completed", usage: { records: 40, files: 4, bytes: 2000, llmCalls: 0 } });
    expect(f.execute).toHaveBeenCalledTimes(2);
  });
  test("cancellation never reaches a control mutation", async () => {
    const f = fixture(), batch = await f.service.prepareControl(request);
    expect(await f.service.retry(batch.batchId, AbortSignal.abort())).toMatchObject({ status: "cancelled" });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  });
  test("request drift cannot change queued work or add a model budget", async () => {
    const f = fixture(), prepared = await f.service.prepareControl(request);
    const original = (await f.repository.getBatch(prepared.batchId, authorityScopeFingerprint(scope)))!;
    const read = vi.spyOn(f.repository, "getBatch");
    read.mockResolvedValueOnce({ ...original, request: { ...original.request, limits: { ...original.request.limits, maxLlmCalls: 1 } } });
    await expect(f.service.retry(prepared.batchId)).rejects.toThrow("control_request_invalid");
    read.mockResolvedValueOnce({ ...original, request: { ...original.request, idempotencyKey: "drift" } });
    await expect(f.service.retry(prepared.batchId)).rejects.toThrow("control_request_changed");
    expect(f.execute).not.toHaveBeenCalled();
  });
  test("bounded partial receipts are explicit, and unknown impact remains absent", async () => {
    const f = fixture(), prepared = await f.service.prepareControl(request);
    f.execute.mockResolvedValueOnce({ status: "partial", receiptId: "a".repeat(64), sourceManifestConfirmed: true,
      sourceSnapshotHash: "b".repeat(64), reasons: ["source_scan_partial"] });
    const report = await f.service.retry(prepared.batchId);
    expect(report).toMatchObject({ status: "partial", reasons: ["source_scan_partial"], counts: { applied: 1 } });
    expect(report.work!.result).not.toHaveProperty("affectedMemoryIds");
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ status: "partial", reasons: ["max_records"] });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  test("without a native control port preparation fails closed", async () => {
    const f = fixture();
    const service = new MemoryEvolutionBatchService({ repository: f.repository, authority, scope, inputs: [], configFingerprint: "c".repeat(64) });
    await expect(service.prepareControl(request)).rejects.toThrow("control_capability_unavailable");
    expect(f.create).not.toHaveBeenCalled();
  });
  test.each([
    { kind: "source_revoke" as const, sourceId: "notes", expectedRevision: "r1", reviewReceiptId: "review" },
    { kind: "undo_governance" as const, operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64), reviewReceiptId: "review" },
  ])("$kind uses no files and real strict authorization accepts an explicit resume", async work => {
    const f = fixture();
    const control: EvolutionControlRequest = { ...request, input: { mode: "control", work }, limits: { ...request.limits, maxFiles: 0 } };
    const prepared = await f.service.prepareControl(control);
    f.execute.mockRejectedValueOnce(new Error("retry"));
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ status: "failed", usage: { files: 0 } });
    expect(await f.service.prepareResume(prepared.batchId)).toMatchObject({ status: "queued", segment: { attempt: 2 } });
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ status: "completed", usage: { files: 0, llmCalls: 0 } });
    for (const [authorized] of f.authorizePrepare.mock.calls) {
      expect(authorized.limits).not.toHaveProperty("maxLlmCalls");
      expect(authorized.limits).not.toHaveProperty("maxInputTokens");
      expect(authorized.limits).not.toHaveProperty("maxOutputTokens");
    }
    expect(f.execute.mock.calls.every(([context]) => context.limits.maxFiles === 0)).toBe(true);
  });
  test("source reconcile requires files, while default database control does not reserve files", () => {
    expect(() => parseEvolutionControlRequest({ ...request, limits: { maxFiles: 0 } })).toThrow("schema_invalid");
    const parsed = parseEvolutionControlRequest({ ...request, limits: {}, input: { mode: "control",
      work: { kind: "source_revoke", sourceId: "notes", expectedRevision: "r1", reviewReceiptId: "review" } } });
    expect(parsed.limits.maxFiles).toBe(0);
  });
  test("confirm recovery does not double-count the same committed administrative receipt", async () => {
    const f = fixture(), prepared = await f.service.prepareControl(request);
    f.execute.mockResolvedValueOnce({ status: "partial", receiptId: "a".repeat(64), sourceManifestConfirmed: false,
      reasons: ["source_manifest_confirmation_failed"] });
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ counts: { applied: 1 }, status: "partial" });
    await f.service.prepareResume(prepared.batchId);
    expect(await f.service.retry(prepared.batchId)).toMatchObject({ counts: { applied: 1 }, status: "completed", work: { result: { sourceManifestConfirmed: true } } });
  });
  test("cancellation waits for execution rollback before releasing the real lease", async () => {
    const f = fixture(), prepared = await f.service.prepareControl(request), controller = new AbortController();
    let reject!: (error: Error) => void;
    f.execute.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const release = vi.spyOn(f.repository, "releaseLease");
    const running = f.service.retry(prepared.batchId, controller.signal);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    controller.abort();
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    reject(new Error("rollback complete"));
    expect(await running).toMatchObject({ status: "cancelled", usage: { records: 20, files: 2, bytes: 1000 } });
    expect(release).toHaveBeenCalledTimes(1);
  });
  test("an invalid control result cannot publish raw fields or claim an applied operation", async () => {
    const f = fixture(), prepared = await f.service.prepareControl(request);
    f.execute.mockResolvedValueOnce({ status: "completed", receiptId: "a".repeat(64), path: "/private" } as never);
    const report = await f.service.retry(prepared.batchId);
    expect(report).toMatchObject({ status: "failed", reasons: ["schema_invalid"], counts: { applied: 0 } });
    expect(report.work).not.toHaveProperty("result");
  });
});
