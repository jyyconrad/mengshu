import { describe, expect, test, vi } from "vitest";
import { PostgresEvolutionGovernanceUndoPort } from "./postgres-governance-undo.js";
import { PostgresEvolutionRepository } from "./postgres-repository.js";
import { evolutionGovernanceSnapshotHash, evolutionGovernanceState } from "./governed-metadata.js";
import { scopedFingerprint } from "./postgres-common.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";

const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const fp = scopedFingerprint(scope), id = "11111111-1111-4111-8111-111111111111";
const rawText = "The original documented fact.", raw = { id: "raw", text: rawText, content_hash: computeCanonicalContentHash(rawText), created_at_ms: 100, data_type: "memory", legacy_quarantine_reason: null, lifecycle_status: "archived", metadata: {
  evolutionEvidence: { sourceId: "docs" },
  admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation", sourceNodeIds: ["event"],
  governance: { commandType: "importEvidence", evidenceIds: ["event"], native: { dataType: "memory", kind: "observation", container: "session_candidate" }, provenance: { source: "evolution", sourceId: "event" }, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: rawText, sourceId: "event" } },
} };
const oldRow = { id, content_hash: "a".repeat(64), lineage_id: null, revision: null, lifecycle_status: "active", metadata: { contextEligible: true, admissionRoute: "active", confidence: 0.9, sourceNodeIds: ["raw"], governance: { evidenceIds: ["raw"], native: { kind: "fact" }, evolution: { effectiveRootIds: ["root"] } } } };
const row = { ...oldRow, evolution_disputed: true, evolution_review_due_at: 2000, metadata: { ...oldRow.metadata, contextEligible: false, governance: { ...oldRow.metadata.governance, evolution: { ...oldRow.metadata.governance.evolution, disputed: true, lastOperationId: "proposal" } } } };
const before = [evolutionGovernanceState(oldRow)], after = [evolutionGovernanceState(row)];
const operation = { id: "c".repeat(64), proposalId: "proposal", operation: "mark_disputed", memoryIds: [id], before, after, beforeLinks: [], afterLinks: [], currentStateHash: evolutionGovernanceSnapshotHash(after, []), at: 2000 };
const lease = { batchId: "batch", scopeFingerprint: fp, ownerId: "owner", fencingToken: 1, expiresAt: 10000 };
const input = { scope, operationReceiptId: operation.id, currentStateHash: operation.currentStateHash, reviewReceiptId: "administrative-review", idempotencyKey: "undo", lease };
function harness(options: { changed?: boolean; authorized?: boolean; sourceRevoked?: boolean } = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("evolution:lease-lock")) return { rows: [{ id: "batch" }] };
    if (sql.includes("evolution:undo-original")) return { rows: [{ receipt: operation }] };
    if (sql.includes("evolution:undo-target")) return { rows: [options.changed ? { ...row, content_hash: "b".repeat(64) } : row] };
    if (sql.includes("evolution:undo-raw-origins")) return { rows: [{ id: raw.id, metadata: raw.metadata }] };
    if (sql.includes("evolution:undo-source-revocations")) return { rows: options.sourceRevoked ? [{ source_id: "docs" }] : [] };
    if (sql.includes("evolution:undo-raw-lock")) return { rows: [raw] };
    if (sql.includes("evolution:metadata-write") || sql.includes("evolution:undo-restore-row")) return { rows: [{ id }] };
    return { rows: [] };
  });
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const repository = new PostgresEvolutionRepository({ scope, pool: pool as never });
  const guard = vi.fn(async (client: unknown) => { expect(client).toMatchObject({ query }); });
  return { calls, guard, port: new PostgresEvolutionGovernanceUndoPort({ repository, readClient: pool as never, now: () => 3000,
    ...(options.authorized === false ? {} : { authorizeAdministrativeReview: guard }) }) };
}
describe("governance undo", () => {
  test("requires a distinct administrative approval; an ordinary proposal receipt is not sufficient", async () => {
    const h = harness({ authorized: false });
    await expect(h.port.undo(input)).rejects.toThrow("undo_governance_review_unavailable");
    expect(h.calls).toHaveLength(0);
  });
  test("approved exact-state undo restores context eligibility and keeps source/audit/receipts", async () => {
    const h = harness();
    await expect(h.port.undo(input)).resolves.toMatchObject({ restoredMemoryIds: [id], receiptId: expect.any(String) });
    expect(h.guard).toHaveBeenCalledTimes(1);
    const update = h.calls.find(c => c.sql.includes("evolution:metadata-write"))!;
    expect(JSON.parse(String(update.params[10]))).toMatchObject({ contextEligible: true, governance: { evidenceIds: ["raw"] } });
    expect(h.calls.some(c => /DELETE FROM/.test(c.sql))).toBe(false);
    expect(h.calls.some(c => c.sql.includes("evolution:undo-receipt"))).toBe(true);
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
  });
  test("changed content or governance CAS rolls back without restoring old support", async () => {
    const h = harness({ changed: true });
    await expect(h.port.undo(input)).rejects.toThrow("UNDO_STATE_CHANGED");
    expect(h.calls.some(c => c.sql.includes("evolution:metadata-write"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("legacy raw without a governance link cannot regain context after its source was revoked", async () => {
    const h = harness({ sourceRevoked: true });
    await expect(h.port.undo(input)).rejects.toThrow("UNDO_SOURCE_REVOKED");
    expect(h.calls.find(c => c.sql.includes("evolution:undo-source-revocations"))?.params[1]).toContain("docs");
    expect(h.guard).not.toHaveBeenCalled();
    expect(h.calls.some(c => c.sql.includes("evolution:undo-restore-row") || c.sql.includes("evolution:metadata-write"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
