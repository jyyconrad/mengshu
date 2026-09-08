import { describe, expect, test, vi } from "vitest";
import { invokeEvolutionGovernanceControl, parseEvolutionGovernanceRequest, type EvolutionGovernanceOperation } from "./evolution-control.js";
import { publicEvolutionReport, type EvolutionBatchCapability } from "./evolution.js";
import { parseEvolutionControlRequest, EvolutionError } from "../../core/src/evolution/schema.js";
import type { EvolutionBatchReport, EvolutionControlWork } from "../../core/src/evolution/types.js";

const hash = "a".repeat(64), stateHash = "b".repeat(64);
const preview = { operationReceiptId: hash };
const approval = { ...preview, currentStateHash: stateHash, expectedRevision: 0, idempotencyKey: "review-retry",
  operationIdempotencyKey: "operation-retry", expiresAt: 1000 };
const report: EvolutionBatchReport = { batchId: "batch", status: "completed", reasons: [],
  usage: { records: 2, files: 0, bytes: 10, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 3 },
  counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
  checkpoint: { cursor: { locator: "/private/source", sourceText: "not-public" } }, configFingerprint: hash, resumable: false };
const works: EvolutionControlWork[] = [
  { kind: "source_reconcile", sourceId: "notes" },
  { kind: "source_revoke", sourceId: "notes", expectedRevision: "r1", reviewReceiptId: "approved-revoke" },
  { kind: "undo_governance", operationReceiptId: hash, currentStateHash: stateHash, reviewReceiptId: "approved-undo" },
];
function fixture() {
  const control = { run: vi.fn(async () => report), previewUndo: vi.fn(async () => ({ ...preview,
    operation: "mark_disputed" as const, memoryIds: ["memory-one"], currentStateHash: stateHash })),
  approveUndo: vi.fn(async () => ({ id: hash, kind: "governance_undo" as const, entryId: stateHash,
    operation: "put" as const, revision: 1, valueHash: hash, createdAt: 1 })) };
  const capability: EvolutionBatchCapability = { run: async () => report, status: async () => report, resume: async () => report, control };
  return { control, capability };
}

describe("F2 governance parser and bounded public results", () => {
  test.each(works)("preserves $kind exact identity and only exposes supported I/O limits", async work => {
    const input = { input: { mode: "control", work }, action: "execute_control", idempotencyKey: "operation-retry" };
    const parsed = parseEvolutionGovernanceRequest("control/run", input);
    const core = parseEvolutionControlRequest(parsed);
    expect(core.limits).toMatchObject({ maxLlmCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 });
    expect(core.input.work).toEqual(work);
    expect(parsed).not.toHaveProperty("limits.maxLlmCalls");
    expect(core.limits.maxFiles).toBe(work.kind === "source_reconcile" ? 20 : 0);
    const f = fixture(); await invokeEvolutionGovernanceControl(f.capability, "control/run", input);
    expect(f.control.run).toHaveBeenCalledExactlyOnceWith(parsed);
  });

  test.each([
    { operation: "control/undo-preview" as const, input: preview },
    { operation: "control/undo-approve" as const, input: approval },
  ])("$operation uses closed primitive JSON and cannot execute getters", row => {
    expect(parseEvolutionGovernanceRequest(row.operation, row.input)).toEqual(row.input);
    const getter = vi.fn(() => hash);
    for (const value of [null, [], Object.assign(Object.create({ injected: true }), row.input),
      { ...row.input, operationReceiptId: "A".repeat(64) }, { ...row.input, operationReceiptId: "a".repeat(63) },
      { ...row.input, ownerSecret: "x".repeat(20_000) },
      Object.defineProperty({ ...row.input }, "operationReceiptId", { enumerable: true, get: getter })]) {
      expect(() => parseEvolutionGovernanceRequest(row.operation, value)).toThrow("EVOLUTION_REQUEST_INVALID");
    }
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseEvolutionGovernanceRequest("control/unknown" as EvolutionGovernanceOperation, approval)).toThrow("EVOLUTION_REQUEST_INVALID");
  });

  test("approval keeps expiry and replay bindings for the host and rejects malformed revision/time", async () => {
    const f = fixture();
    await invokeEvolutionGovernanceControl(f.capability, "control/undo-approve", approval);
    expect(f.control.approveUndo).toHaveBeenCalledExactlyOnceWith(approval);
    for (const change of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { expiresAt: Number.MAX_SAFE_INTEGER + 1 },
      { expiresAt: -1 }, { operationIdempotencyKey: "../other" }]) {
      expect(() => parseEvolutionGovernanceRequest("control/undo-approve", { ...approval, ...change })).toThrow("EVOLUTION_REQUEST_INVALID");
    }
    f.control.approveUndo.mockRejectedValueOnce(new EvolutionError("host_state_expiry_invalid"));
    await expect(invokeEvolutionGovernanceControl(f.capability, "control/undo-approve", approval))
      .rejects.toMatchObject({ status: 409, code: "EVOLUTION_HOST_STATE_EXPIRY_INVALID" });
  });

  test.each(["source_reconcile", "source_revoke", "undo_governance"] as const)("public %s work omits unknown impact and all internal checkpoints", kind => {
    const result = { status: "partial" as const, receiptId: hash, sourceManifestConfirmed: false, sourceSnapshotHash: stateHash, reasons: ["max_records"] };
    const projected = publicEvolutionReport({ ...report, work: { kind, result } });
    expect(projected.work).toEqual({ kind, result });
    expect(projected.work!.result).not.toHaveProperty("affectedMemoryIds");
    expect(JSON.stringify(projected)).not.toMatch(/private|not-public|sourceText|locator/);
    expect(projected.checkpoint.cursor).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(publicEvolutionReport({ ...report, work: { kind } }).work).toEqual({ kind });
  });

  test("public reports reject unknown work kinds and arbitrary result fields", () => {
    expect(() => publicEvolutionReport({ ...report, work: { kind: "custom_handler" } } as never)).toThrow();
    expect(() => publicEvolutionReport({ ...report, work: { kind: "source_revoke", result: null } } as never)).toThrow();
    for (const change of [{ sourcePath: "/private/source" }, { affectedMemoryIds: ["../private"] }, { receiptId: "not-a-hash" },
      { reasons: ["author says verified"] }, { affectedMemoryIds: Array.from({ length: 257 }, (_, i) => `memory-${i}`) }]) {
      expect(() => publicEvolutionReport({ ...report, work: { kind: "source_revoke",
        result: { status: "completed", receiptId: hash, ...change } } } as never)).toThrow();
    }
    expect(publicEvolutionReport({ ...report, work: { kind: "source_revoke", result: {
      status: "completed", receiptId: hash, affectedMemoryIds: [],
    } } }).work!.result!.affectedMemoryIds).toEqual([]);
  });

  test("undo responses project only valid bounded identities and no owner/private fields", async () => {
    const f = fixture();
    f.control.previewUndo.mockResolvedValueOnce({ ...preview, operation: "mark_disputed", memoryIds: ["memory-one"],
      currentStateHash: stateHash, privateState: "private-body" } as never);
    expect(await invokeEvolutionGovernanceControl(f.capability, "control/undo-preview", preview))
      .toEqual({ ...preview, operation: "mark_disputed", memoryIds: ["memory-one"], currentStateHash: stateHash });
    for (const change of [{ operationReceiptId: stateHash }, { operation: "delete" }, { memoryIds: ["/private/body"] },
      { memoryIds: Array.from({ length: 9 }, (_, i) => `memory-${i}`) }, { currentStateHash: "not-a-hash" }]) {
      f.control.previewUndo.mockResolvedValueOnce({ ...preview, operation: "mark_disputed", memoryIds: [], currentStateHash: stateHash, ...change } as never);
      await expect(invokeEvolutionGovernanceControl(f.capability, "control/undo-preview", preview))
        .rejects.toMatchObject({ code: "EVOLUTION_OPERATION_FAILED" });
    }
    f.control.approveUndo.mockResolvedValueOnce({ id: hash, kind: "source_revocation", entryId: "private/body",
      operation: "put", revision: 1, valueHash: hash, createdAt: 1 } as never);
    await expect(invokeEvolutionGovernanceControl(f.capability, "control/undo-approve", approval))
      .rejects.toMatchObject({ code: "EVOLUTION_OPERATION_FAILED" });
  });
});
