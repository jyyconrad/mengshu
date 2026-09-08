import { afterEach, describe, expect, test, vi } from "vitest";
import { parseEvolutionControlRequest } from "../../packages/core/src/evolution/schema.js";
import type { EvolutionBatchReport } from "../../packages/core/src/evolution/types.js";
import type { EvolutionUndoApprovalReceipt, EvolutionUndoPreview } from "../../packages/api/src/evolution-control.js";
import type { EvolutionSourceControlReceipt } from "../../packages/api/src/evolution-source-control.js";
import { nativeControlRequest, NATIVE_CONTROL_SOURCE_ID, openNativeControl, prepareNativeRevalidation, receiptIdHash,
  safeNativeControlDiagnostic, type NativeControl } from "../fixtures/memory-evolution-rollout/native-control.js";
import { CONTROLLED_NATIVE_SOURCE } from "../fixtures/memory-evolution-rollout/native-runtime.js";

const enabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1" && process.env.MENGSHU_EVOLUTION_ISOLATED_DB === "1";
afterEach(() => vi.restoreAllMocks());
const reconcile = (key: string) => nativeControlRequest({ kind: "source_reconcile", sourceId: NATIVE_CONTROL_SOURCE_ID }, key);
const zeroModel = (h: NativeControl) => expect(h.controlledTransport!.snapshot()).toEqual({ mode: "controlled_synthetic", proposalCalls: 0, embeddingCalls: 0, blockedNetworkCalls: 0 });
function completed(report: EvolutionBatchReport, kind: string) {
  const diagnostic = safeNativeControlDiagnostic(report);
  expect(report.status, diagnostic).toBe("completed");
  expect(report.counts.applied, diagnostic).toBe(1);
  expect(report.work?.kind, diagnostic).toBe(kind);
  expect(report.work?.result?.receiptId, diagnostic).toMatch(/^[a-f0-9]{64}$/);
  expect(report.usage, diagnostic).toMatchObject({ llmCalls: 0, inputTokens: 0, outputTokens: 0 });
  return report.work!.result!.receiptId!;
}
async function queue(h: NativeControl, request: ReturnType<typeof nativeControlRequest>) {
  const response = await h.control("control/run", request);
  expect(response.status).toBe(200);
  const report = response.body as EvolutionBatchReport;
  expect(report.status, safeNativeControlDiagnostic(report)).toBe("queued");
  return report;
}

test("native control fixtures construct only closed zero-model work and bounded safe diagnostics", () => {
  for (const work of [
    { kind: "source_reconcile" as const, sourceId: NATIVE_CONTROL_SOURCE_ID },
    { kind: "source_revoke" as const, sourceId: NATIVE_CONTROL_SOURCE_ID, expectedRevision: "a".repeat(64), reviewReceiptId: "owner-receipt" },
    { kind: "undo_governance" as const, operationReceiptId: "a".repeat(64), currentStateHash: "b".repeat(64), reviewReceiptId: "owner-receipt" },
  ]) {
    const request = nativeControlRequest(work, "synthetic-control-key");
    expect(request).toMatchObject({ action: "execute_control", input: { mode: "control", work } });
    expect(request.limits).not.toHaveProperty("maxLlmCalls");
    expect(parseEvolutionControlRequest(request).limits).toMatchObject({ maxLlmCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 });
    expect(() => parseEvolutionControlRequest({ ...request, authority: { userId: "forged" } })).toThrow();
    expect(() => parseEvolutionControlRequest({ ...request, limits: { maxLlmCalls: 1 } })).toThrow();
  }
  const report = { status: "failed", reasons: ["undo_state_changed", "secret-body"], counts: {}, usage: {}, resumable: false,
    work: { kind: "undo_governance", result: { path: "/secret-path", text: "secret-body" } } } as unknown as EvolutionBatchReport;
  const diagnostic = safeNativeControlDiagnostic(report);
  expect(diagnostic).toContain("undo_state_changed");
  expect(diagnostic).not.toContain("secret");
});

describe.skipIf(!enabled)("F2 actual default REST/RuntimeHost/PG control with synthetic fixtures, not historical data or model evaluation", () => {
  test("reconcile requires owner, waits for a separate batch allowlist, and binds a real source receipt to the confirmed manifest", async () => {
    const h = await openNativeControl();
    try {
      const before = await h.effects();
      expect(await h.manifest()).toEqual({ invalid: false });
      expect((await h.control("control/run", reconcile("reconcile-primary"), false)).status).toBe(403);
      expect(await h.effects()).toEqual(before);
      expect(await h.manifest()).toEqual({ invalid: false });
      const queued = await queue(h, reconcile("reconcile-primary"));
      const other = await queue(h, reconcile("reconcile-not-allowlisted"));
      expect(h.runtime.backgroundWork!.snapshot().mode).toBe("paused");
      expect(await h.job(queued)).toMatchObject({ type: "evolve_memory_batch", status: "queued", attempts: 0 });
      expect(await h.manifest()).toEqual({ invalid: false });
      expect(await h.sourceState()).toBeUndefined();
      zeroModel(h);
      const report = await h.waitControl(queued), id = completed(report, "source_reconcile");
      expect(h.runtime.backgroundWork!.snapshot().allowedBatchIds).toEqual([queued.batchId]);
      expect(await h.job(report)).toMatchObject({ type: "evolve_memory_batch", status: "completed", attempts: 1 });
      expect(await h.job(other)).toMatchObject({ status: "queued", attempts: 0 });
      expect((await h.capability.status(other.batchId))?.status).toBe("queued");
      const stored = await h.operationReceipt(id), manifest = await h.manifest();
      expect(stored?.operation).toBe("source_reconcile");
      expect(stored?.receipt).toMatchObject({ receiptId: id, sourceSnapshotHash: report.work!.result!.sourceSnapshotHash });
      expect((stored!.receipt as { recordIds: string[] }).recordIds.length).toBe(1);
      expect(manifest.invalid).toBe(false);
      expect(manifest.manifest?.generation).toBe(1);
      expect(manifest.manifest?.receiptIdHash).toBe(receiptIdHash(id));
      expect(Object.keys(manifest.manifest?.files ?? {}).length).toBe(1);
      expect(report.work!.result!.sourceManifestConfirmed).toBe(true);
      expect(await h.sourceState()).toMatchObject({ disposition: "current", receipt_id: id, revision: report.work!.result!.sourceSnapshotHash });
      const after = await h.effects();
      expect(after.memories).toBe(0);
      const replay = await h.control("control/run", reconcile("reconcile-primary"));
      expect(replay.status).toBe(200);
      expect((replay.body as EvolutionBatchReport).batchId).toBe(report.batchId);
      expect(await h.effects()).toEqual(after);
      expect(await h.manifest()).toEqual(manifest);
      zeroModel(h);
    } finally { await h.close(); }
  }, 180_000);

  test("source revoke consumes exact independent owner approval in the real control job, retires canonical references and replays once", async () => {
    const h = await openNativeControl();
    try {
      const seed = await h.seed(true);
      completed(await h.waitControl(await queue(h, reconcile("revoke-source-baseline"))), "source_reconcile");
      const source = await h.sourceState();
      const approvalRequest = { sourceId: NATIVE_CONTROL_SOURCE_ID, sourceRevision: String(source!.revision), expectedRevision: 0,
        idempotencyKey: "approve-native-source-revoke", operationIdempotencyKey: "execute-native-source-revoke", expiresAt: Date.now() + 120_000 };
      const before = await h.effects();
      expect((await h.control("source/revoke-attestation", approvalRequest, false)).status).toBe(403);
      expect(await h.effects()).toEqual(before);
      const approved = await h.control("source/revoke-attestation", approvalRequest);
      expect(approved.status).toBe(200);
      const approval = approved.body as EvolutionSourceControlReceipt;
      expect(approval.kind).toBe("source_revocation");
      expect(await h.consumption(approval.id)).toEqual({ consumed_by: null, consumed_at: null });
      expect(await h.sourceState()).toEqual(source);
      const request = nativeControlRequest({ kind: "source_revoke", sourceId: NATIVE_CONTROL_SOURCE_ID,
        expectedRevision: String(source!.revision), reviewReceiptId: approval.id }, approvalRequest.operationIdempotencyKey);
      const beforeUnauthorized = await h.effects();
      expect((await h.control("control/run", request, false)).status).toBe(403);
      expect(await h.effects()).toEqual(beforeUnauthorized);
      const queued = await queue(h, request);
      expect(await h.consumption(approval.id)).toEqual({ consumed_by: null, consumed_at: null });
      const report = await h.waitControl(queued), id = completed(report, "source_revoke");
      expect(await h.sourceState()).toMatchObject({ disposition: "revoked", receipt_id: id });
      expect((await h.operationReceipt(id))?.receipt).toMatchObject({ receiptId: id, suppressed: true, affectedMemoryIds: [seed.id] });
      const links = (await h.pool.query("SELECT relation_state FROM mengshu_memory_evidence_links WHERE scope_fingerprint=$1 AND target_memory_id=$2 AND evidence_memory_id=$3",
        [h.scopeFingerprint, seed.id, seed.rawId])).rows;
      expect(links).toEqual([{ relation_state: "revoked" }]);
      expect((await h.consumption(approval.id))?.consumed_by).toMatch(/^[a-f0-9]{64}$/);
      const raw = (await h.persistence.inventory.hydrateEvidence(h.scope, [seed.rawId]))[0];
      expect(raw?.text === CONTROLLED_NATIVE_SOURCE && raw.trust === "untrusted").toBe(true);
      const target = await h.memory(seed.id);
      expect(target.text === CONTROLLED_NATIVE_SOURCE).toBe(true);
      expect((target.metadata as { sourceNodeIds: string[]; contextEligible: boolean }).sourceNodeIds).not.toContain(seed.rawId);
      expect((target.metadata as { contextEligible: boolean }).contextEligible).toBe(false);
      const after = await h.effects(), consumption = await h.consumption(approval.id);
      const replay = await h.control("control/run", request);
      expect(replay.status).toBe(200);
      expect((replay.body as EvolutionBatchReport).batchId).toBe(report.batchId);
      expect(await h.effects()).toEqual(after);
      expect(await h.consumption(approval.id)).toEqual(consumption);
      zeroModel(h);
    } finally { await h.close(); }
  }, 180_000);

  test("undo previews a real metadata receipt, requires exact owner approval, restores native state and rejects stale reuse", async () => {
    const h = await openNativeControl();
    try {
      const seed = await h.seed(), beforeHash = await h.governanceHash(seed.id);
      const setup = await prepareNativeRevalidation(h, seed.id);
      expect(setup.setupProposalCalls).toBe(1);
      const beforeControlTransport = h.controlledTransport!.snapshot();
      expect(beforeControlTransport.blockedNetworkCalls).toBe(0);
      expect(await h.governanceHash(seed.id)).not.toBe(beforeHash);
      const previewRequest = { operationReceiptId: setup.receipt.id }, beforeOwner = await h.effects();
      expect((await h.control("control/undo-preview", previewRequest, false)).status).toBe(403);
      expect(await h.effects()).toEqual(beforeOwner);
      const response = await h.control("control/undo-preview", previewRequest);
      expect(response.status).toBe(200);
      const preview = response.body as EvolutionUndoPreview;
      expect(preview.operation).toBe("revalidate");
      expect(preview.memoryIds).toEqual([seed.id]);
      expect(preview.currentStateHash).toBe(setup.receipt.currentStateHash);
      const approvalRequest = { operationReceiptId: setup.receipt.id, currentStateHash: preview.currentStateHash, expectedRevision: 0,
        idempotencyKey: "approve-native-undo", operationIdempotencyKey: "execute-native-undo", expiresAt: Date.now() + 120_000 };
      expect((await h.control("control/undo-approve", approvalRequest, false)).status).toBe(403);
      expect((await h.control("control/undo-approve", { ...approvalRequest, currentStateHash: "0".repeat(64) })).status).toBe(409);
      expect(await h.effects()).toEqual(beforeOwner);
      const approved = await h.control("control/undo-approve", approvalRequest);
      expect(approved.status).toBe(200);
      const approval = approved.body as EvolutionUndoApprovalReceipt;
      expect(approval.kind).toBe("governance_undo");
      expect(await h.consumption(approval.id)).toEqual({ consumed_by: null, consumed_at: null });
      const request = nativeControlRequest({ kind: "undo_governance", operationReceiptId: preview.operationReceiptId,
        currentStateHash: preview.currentStateHash, reviewReceiptId: approval.id }, approvalRequest.operationIdempotencyKey);
      const beforeUnauthorized = await h.effects();
      expect((await h.control("control/run", request, false)).status).toBe(403);
      expect(await h.effects()).toEqual(beforeUnauthorized);
      const queued = await queue(h, request);
      expect(await h.consumption(approval.id)).toEqual({ consumed_by: null, consumed_at: null });
      const report = await h.waitControl(queued), id = completed(report, "undo_governance");
      expect(await h.governanceHash(seed.id)).toBe(beforeHash);
      expect((await h.operationReceipt(id))?.receipt).toMatchObject({ receiptId: id, restoredMemoryIds: [seed.id], operationReceiptId: preview.operationReceiptId });
      const consumption = await h.consumption(approval.id);
      expect(consumption?.consumed_by).toMatch(/^[a-f0-9]{64}$/);
      const after = await h.effects();
      expect((await h.control("control/run", request)).body).toMatchObject({ batchId: report.batchId });
      expect(await h.effects()).toEqual(after);
      expect((await h.control("control/undo-preview", previewRequest)).status).toBe(409);
      const stale = await h.waitControl(await queue(h, { ...request, idempotencyKey: "stale-native-undo" }));
      expect(stale.status, safeNativeControlDiagnostic(stale)).not.toBe("completed");
      expect(stale.counts.applied, safeNativeControlDiagnostic(stale)).toBe(0);
      expect(stale.reasons, safeNativeControlDiagnostic(stale)).toContain("undo_state_changed");
      expect(await h.governanceHash(seed.id)).toBe(beforeHash);
      expect(await h.consumption(approval.id)).toEqual(consumption);
      expect((await h.effects()).operations).toBe(after.operations);
      expect(h.controlledTransport!.snapshot()).toEqual(beforeControlTransport);
    } finally { await h.close(); }
  }, 240_000);
});
