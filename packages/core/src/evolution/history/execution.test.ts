import { describe, expect, it, vi } from "vitest";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { auditHistory } from "./audit.js";
import { planHistory } from "./plan.js";
import { applyHistory, archiveHistory, rollbackHistory, verifyHistory } from "./execution.js";
import { historyHash } from "./schema.js";
import type { HistoryDiagnostic } from "./diagnostics.js";
import type { HistoryAuthorization, HistoryNativePort, HistoryNativeSession, HistoryOperationReceipt, HistoryPlan, HistoryPlanUnit } from "./types.js";

function authorization(plan: HistoryPlan, action: string): HistoryAuthorization {
  return { token: `P16_${action.toUpperCase()}:${plan.input.runId}:${plan.hash}`, reviewReceiptId: "host-review",
    backupReceiptHash: historyHash("backup"), restoreReceiptHash: historyHash("restore"), rehearsalReceiptHash: historyHash("rehearsal"), maintenanceReceiptId: "maintenance", quiescenceReceiptId: "quiescence" };
}
async function harness() {
  const fixture = historyFixture(), plan = planHistory(fixture.input, await auditHistory(fixture.input, fixture.port));
  const receipts = new Map<string, HistoryOperationReceipt>(), calls: string[] = [];
  const makeReceipt = (unit: HistoryPlanUnit) => {
    const body = { id: unit.id, runId: plan.input.runId, parentRunId: plan.input.parentRunId, planHash: plan.hash, unitId: unit.id, phase: unit.phase,
      status: "committed" as const, sourceWitnessHash: historyHash(unit.sources), affectedRefs: unit.phase === "archive" ? unit.sources.map(source => source.sourceRef) : [],
      evidenceMemoryIds: unit.bindings.map(binding => `raw-${binding.rootEvidenceId}`), evidenceRootIds: [...new Set(unit.bindings.map(binding => binding.rootEvidenceId))],
      beforeStateHash: historyHash(`before-${unit.id}`), afterStateHash: historyHash(`after-${unit.id}`), rollbackRef: `rollback-${unit.id}` };
    return { ...body, hash: historyHash(body) };
  };
  const session: HistoryNativeSession = {
    assertGates: vi.fn(async ({ action }) => { calls.push(`gates:${action}`); }),
    readReceipt: vi.fn(async ({ unitId }) => { calls.push(`read:${unitId}`); return receipts.get(unitId); }),
    applyUnit: vi.fn(async ({ unit }) => { calls.push(`apply:${unit.phase}`); const receipt = makeReceipt(unit); receipts.set(unit.id, receipt); return receipt; }),
    verifyUnit: vi.fn(async ({ unit, receipt }) => { calls.push(`verify:${unit.phase}`); return { unitId: unit.id, currentRead: true, evidenceRead: true, lookupRead: true, contextRead: true,
      exactScope: true, confidenceNotIncreased: true, canonicalIdentityPreserved: true, evidenceRootIds: receipt.evidenceRootIds, receiptHash: receipt.hash }; }),
    rollbackUnit: vi.fn(async ({ unit, receipt }) => {
      calls.push(`rollback:${unit.phase}`);
      const { hash: _hash, ...old } = receipt;
      const body = { ...old, status: "rolled_back" as const, afterStateHash: receipt.beforeStateHash };
      const restored = { ...body, hash: historyHash(body) }; receipts.set(unit.id, restored); return restored;
    }),
    verifyConservation: vi.fn(async () => ({ mappingsComplete: true, outsideCohortUnchanged: true, unrelatedQueueUnchanged: true })),
  };
  const port: HistoryNativePort = { withOperatorLock: async (_input, work) => { calls.push("lock"); try { return await work(session); } finally { calls.push("unlock"); } } };
  return { plan, fixture, port, session, receipts, calls, makeReceipt, auth: (action: string) => authorization(plan, action) };
}
describe("P16 controlled native execution", () => {
  it("separates apply and archive, verifies native reads before archive, and rolls back in dependency order", async () => {
    const h = await harness();
    await expect(archiveHistory(h.plan, h.port, h.auth("apply"))).rejects.toThrow("HISTORY_AUTHORIZATION_REQUIRED");
    const applied = await applyHistory(h.plan, h.port, h.auth("apply"));
    expect(applied.receipts).toHaveLength(4);
    expect(h.calls).not.toContain("apply:archive");
    expect((await verifyHistory(h.plan, h.port)).verifications).toHaveLength(4);
    await archiveHistory(h.plan, h.port, h.auth("archive"));
    expect(h.calls.indexOf("verify:activate")).toBeLessThan(h.calls.indexOf("apply:archive"));
    expect((await verifyHistory(h.plan, h.port, { includeArchive: true })).verifications).toHaveLength(7);
    await rollbackHistory(h.plan, h.port, h.auth("rollback"));
    expect(h.calls.filter(call => call.startsWith("rollback:"))).toEqual(["rollback:archive", "rollback:archive", "rollback:archive", "rollback:knowledge", "rollback:activate", "rollback:evidence", "rollback:evidence"]);
    const calls = h.calls.filter(call => call.startsWith("rollback:"));
    await rollbackHistory(h.plan, h.port, h.auth("rollback"));
    expect(h.calls.filter(call => call.startsWith("rollback:"))).toEqual(calls);
    expect(h.calls.at(-1)).toBe("unlock");
  });
  it("repeated apply uses durable receipts and never double-writes or reactivates rolled-back units", async () => {
    const h = await harness();
    await applyHistory(h.plan, h.port, h.auth("apply")); await applyHistory(h.plan, h.port, h.auth("apply"));
    expect(h.session.applyUnit).toHaveBeenCalledTimes(4);
    await rollbackHistory(h.plan, h.port, h.auth("rollback"));
    await expect(applyHistory(h.plan, h.port, h.auth("apply"))).rejects.toThrow("HISTORY_RECEIPT_INVALID");
  });
  it("lost COMMIT response is recovered by receipt, not a second mutation", async () => {
    const h = await harness(), diagnostics: HistoryDiagnostic[] = [];
    h.session.applyUnit = vi.fn(async ({ unit }) => { const receipt = h.makeReceipt(unit); h.receipts.set(unit.id, receipt); throw { code: "08006", message: "network lost after commit" }; });
    expect((await applyHistory(h.plan, h.port, h.auth("apply"), { onDiagnostic: diagnostic => { diagnostics.push(diagnostic); throw new Error("observer unavailable"); } })).complete).toBe(true);
    expect(h.session.applyUnit).toHaveBeenCalledTimes(4);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every(diagnostic => diagnostic.receiptState === "recovered" && diagnostic.sqlState === "08006")).toBe(true);
    expect(h.session.verifyUnit).toHaveBeenCalled();
  });
  it("CAS failure without receipt stops with an uncertainty code and no blind replay", async () => {
    const h = await harness();
    h.session.applyUnit = vi.fn(async () => { throw new Error("CAS failed; never expose body here"); });
    await expect(applyHistory(h.plan, h.port, h.auth("apply"))).rejects.toThrow("HISTORY_COMMIT_UNCERTAIN");
    expect(h.session.applyUnit).toHaveBeenCalledTimes(1);
    expect(h.calls.at(-1)).toBe("unlock");
  });
  it("exposes an allowlisted native failure only after receipt-first reconciliation", async () => {
    const h = await harness(), diagnostics: HistoryDiagnostic[] = [], receiptReadsAtDiagnostic: number[] = [];
    h.session.applyUnit = vi.fn(async () => { throw { code: "CLIENT_FIELD_FORBIDDEN", message: "private scope detail" }; });
    await expect(applyHistory(h.plan, h.port, h.auth("apply"), { onDiagnostic: diagnostic => { diagnostics.push(diagnostic); receiptReadsAtDiagnostic.push(h.calls.filter(call => call.startsWith("read:")).length); } })).rejects.toThrow("HISTORY_COMMIT_UNCERTAIN");
    expect(receiptReadsAtDiagnostic).toEqual([2]);
    expect(diagnostics).toEqual([{ schema: "mengshu.history-p16-diagnostic/v1", phase: "evidence", stage: "receipt-recheck", code: "CLIENT_FIELD_FORBIDDEN", receiptState: "missing" }]);
    expect(h.session.applyUnit).toHaveBeenCalledTimes(1);
    expect(h.session.verifyUnit).not.toHaveBeenCalled();
  });
  it("receipt query failure remains uncertain and never triggers a second mutation", async () => {
    const h = await harness(), onDiagnostic = vi.fn();
    h.session.applyUnit = vi.fn(async () => { h.session.readReceipt = async () => { throw { code: "08006", detail: "private connection" }; }; throw { code: "40001" }; });
    await expect(applyHistory(h.plan, h.port, h.auth("apply"), { onDiagnostic })).rejects.toThrow("HISTORY_COMMIT_UNCERTAIN");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "receipt-recheck", sqlState: "08006", receiptState: "unavailable" }));
    expect(h.session.applyUnit).toHaveBeenCalledTimes(1);
    expect(h.calls.at(-1)).toBe("unlock");
  });
  it("rollback diagnostics preserve the CAS refusal, receipt and no-replay boundary", async () => {
    const h = await harness(), onDiagnostic = vi.fn();
    const applied = await applyHistory(h.plan, h.port, h.auth("apply"), { limit: 1 });
    h.session.rollbackUnit = vi.fn(async () => { throw { code: "HISTORY_ROLLBACK_CAS_FAILED", detail: "private row" }; });
    await expect(rollbackHistory(h.plan, h.port, h.auth("rollback"), { onDiagnostic })).rejects.toThrow("HISTORY_ROLLBACK_UNCERTAIN");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ code: "HISTORY_ROLLBACK_CAS_FAILED", receiptState: "missing" }));
    expect(h.session.rollbackUnit).toHaveBeenCalledTimes(1);
    expect(h.receipts.get(applied.receipts[0].unitId)).toEqual(applied.receipts[0]);
  });
  it.each(["currentRead", "evidenceRead", "lookupRead", "contextRead", "confidenceNotIncreased", "exactScope", "canonicalIdentityPreserved"] as const)("blocks archive and diagnoses the fixed %s flag without private data", async key => {
    const h = await harness(); await applyHistory(h.plan, h.port, h.auth("apply"));
    const original = h.session.verifyUnit;
    h.session.verifyUnit = async input => ({ ...await original(input), [key]: false });
    const error = await archiveHistory(h.plan, h.port, h.auth("archive")).catch(error => error);
    expect(error).toMatchObject({ code: "HISTORY_NATIVE_READ_VERIFICATION_FAILED", failedChecks: [key] });
    expect(error.message).toContain(`failed=${key}`);
    expect(error.message).not.toContain(h.plan.input.runId);
    expect(h.calls).not.toContain("apply:archive");
  });
  it("reports all rejected native read flags after commit without retrying or classifying them as uncertain", async () => {
    const h = await harness(), original = h.session.verifyUnit, onDiagnostic = vi.fn();
    h.session.verifyUnit = async input => ({ ...await original(input), ...(input.unit.phase === "activate" ? { currentRead: false, lookupRead: false, confidenceNotIncreased: false } : {}) });
    const error = await applyHistory(h.plan, h.port, h.auth("apply"), { onDiagnostic }).catch(error => error);
    expect(error.code).toBe("HISTORY_NATIVE_READ_VERIFICATION_FAILED");
    expect(error.phase).toBe("activate");
    expect([...error.failedChecks].sort()).toEqual(["confidenceNotIncreased", "currentRead", "lookupRead"]);
    expect(error.message).not.toContain("UNCERTAIN");
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ stage: "native-read-verification", phase: "activate", code: error.code, failedChecks: error.failedChecks }));
    expect(h.session.applyUnit).toHaveBeenCalledTimes(3);
    expect(h.receipts.size).toBe(3);
    expect(h.calls).not.toContain("apply:archive");
  });
  it.each(["unitIdentity", "receiptIdentity", "evidenceRoots"] as const)("diagnoses %s mismatch using its fixed name, never the mismatched value", async key => {
    const h = await harness(), original = h.session.verifyUnit;
    h.session.verifyUnit = async input => ({ ...await original(input), ...(key === "unitIdentity" ? { unitId: "private-unit" } : key === "receiptIdentity" ? { receiptHash: "private-receipt" } : { evidenceRootIds: ["private-root"] }) });
    const error = await applyHistory(h.plan, h.port, h.auth("apply")).catch(error => error);
    expect(error).toMatchObject({ code: "HISTORY_NATIVE_READ_VERIFICATION_FAILED", failedChecks: [key] });
    expect(error.message).not.toContain("private-");
    expect(h.session.applyUnit).toHaveBeenCalledTimes(1);
  });
  it("cannot skip dependency receipts or reverse rollback dependencies using a cursor", async () => {
    const h = await harness();
    await expect(archiveHistory(h.plan, h.port, h.auth("archive"))).rejects.toThrow("HISTORY_DEPENDENCY_NOT_COMMITTED");
    await applyHistory(h.plan, h.port, h.auth("apply")); await archiveHistory(h.plan, h.port, h.auth("archive"));
    const lastArchive = [...h.plan.units].reverse().filter(unit => unit.phase === "archive").at(-1)!;
    await expect(rollbackHistory(h.plan, h.port, h.auth("rollback"), { afterUnitId: lastArchive.id })).rejects.toThrow("HISTORY_ROLLBACK_DEPENDENT_COMMITTED");
  });
  it("restarts at a bounded page cursor while preserving dependency checks", async () => {
    const h = await harness();
    const first = await applyHistory(h.plan, h.port, h.auth("apply"), { limit: 1 });
    expect(first.complete).toBe(false);
    const second = await applyHistory(h.plan, h.port, h.auth("apply"), { afterUnitId: first.next, limit: 1 });
    expect(second.receipts[0].phase).toBe("evidence");
    expect(h.session.applyUnit).toHaveBeenCalledTimes(2);
    await expect(applyHistory(h.plan, h.port, h.auth("apply"), { afterUnitId: "not-in-plan" })).rejects.toThrow("HISTORY_CURSOR_INVALID");
  });
  it("unexplained sources and provider refusal stop before mutation", async () => {
    const h = await harness(), { hash: _hash, ...body } = h.plan;
    const changed = { ...body, unresolvedCount: 1 };
    const blocked = { ...changed, hash: historyHash(changed) };
    await expect(applyHistory(blocked, h.port, authorization(blocked, "apply"))).rejects.toThrow("HISTORY_UNEXPLAINED_SOURCES");
    h.session.assertGates = async () => { throw new Error("host receipt not approved"); };
    await expect(applyHistory(h.plan, h.port, h.auth("apply"))).rejects.toThrow("host receipt not approved");
    expect(h.session.applyUnit).not.toHaveBeenCalled();
  });
  it("rejects conservation drift, false receipt identities and unrecognized body fields", async () => {
    const h = await harness();
    h.session.verifyConservation = async () => ({ mappingsComplete: true, outsideCohortUnchanged: false, unrelatedQueueUnchanged: true });
    await expect(applyHistory(h.plan, h.port, h.auth("apply"))).rejects.toThrow("HISTORY_CONSERVATION_FAILED");
    expect(h.session.applyUnit).not.toHaveBeenCalled();
    const other = await harness();
    other.session.applyUnit = async ({ unit }) => {
      const { hash: _hash, ...body } = other.makeReceipt(unit);
      const bad = { ...body, affectedRefs: ["memories:outside-cohort"] }; return { ...bad, hash: historyHash(bad) };
    };
    await expect(applyHistory(other.plan, other.port, other.auth("apply"))).rejects.toThrow("HISTORY_RECEIPT_OUTSIDE_COHORT");
  });
  it("aborted or over-budget calls never acquire the operator lock", async () => {
    const h = await harness(), controller = new AbortController(); controller.abort();
    await expect(applyHistory(h.plan, h.port, h.auth("apply"), { signal: controller.signal })).rejects.toThrow("HISTORY_EXECUTION_BUDGET");
    expect(h.calls).toEqual([]);
  });
});
