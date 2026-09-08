import { describe, expect, test, vi } from "vitest";
import { PostgresEvolutionMaintenancePort } from "./postgres-maintenance.js";
import { PostgresEvolutionRepository } from "./postgres-repository.js";
import { jsonHash, scopedFingerprint } from "./postgres-common.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const fp = scopedFingerprint(scope), id = "11111111-1111-4111-8111-111111111111", text = "Temporary selected raw quotation.";
const origin = { sourceEvidenceId: "source-record", sourceId: "docs", revision: "1", snapshotHash: computeCanonicalContentHash(text), rootEvidenceId: "root", expiresAt: 1000 };
const raw = { id, text, content_hash: computeCanonicalContentHash(text), created_at_ms: 100, data_type: "memory", legacy_quarantine_reason: null, lineage_id: null, lifecycle_status: "archived", metadata: { evolutionEvidence: origin, admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate", eventType: "observation", sourceNodeIds: ["source-key"], governance: { commandType: "importEvidence", evidenceIds: ["source-key"], native: { dataType: "memory", kind: "observation", container: "session_candidate" }, provenance: { source: "evolution", sourceId: "source-key" }, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: text, sourceId: "source-key" } } } };
const candidate = { id, revision: jsonHash([id, raw.content_hash, origin]), kind: "orphan_evidence" as const, expiresAt: 1000 };
const lease = { batchId: "batch", scopeFingerprint: fp, ownerId: "owner", fencingToken: 1, expiresAt: 10000 };
function harness(referenced = false, lockBusy = false) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (lockBusy && sql.startsWith("LOCK TABLE")) throw Object.assign(new Error("lock busy"), { code: "55P03" });
    if (sql.includes("evolution:lease-lock")) return { rows: [{ id: "batch" }] };
    if (sql.includes("evolution:retention-raw-lock")) return { rows: [raw] };
    if (sql.includes("evolution:retention-references")) return { rows: [{ referenced }] };
    if (sql.includes("evolution:retention-delete")) return { rows: [{ id }] };
    return { rows: [] };
  });
  const repository = new PostgresEvolutionRepository({ scope, pool: { query, connect: async () => ({ query, release() {} }) } as never });
  return { calls, port: new PostgresEvolutionMaintenancePort({ repository, now: () => 2000 }) };
}
describe("postgres maintenance retention", () => {
  test("expired temporary raw is really removed only with reference guard and same transaction receipt", async () => {
    const h = harness();
    await expect(h.port.cleanupUnreferenced({ scope, candidate, lease })).resolves.toMatchObject({ status: "deleted", receiptId: expect.any(String) });
    const queries = h.calls.map(c => c.sql);
    expect(queries.some(sql => sql.startsWith("LOCK TABLE"))).toBe(true);
    expect(queries.find(sql => sql.startsWith("LOCK TABLE"))).toContain("NOWAIT");
    expect(queries.findIndex(sql => sql.startsWith("LOCK TABLE"))).toBeLessThan(queries.findIndex(sql => sql.includes("evolution:retention-raw-lock")));
    expect(queries.findIndex(sql => sql.includes("evolution:retention-references"))).toBeLessThan(queries.findIndex(sql => sql.includes("evolution:retention-delete")));
    expect(queries.some(sql => /DELETE FROM mengshu_.*receipts/.test(sql))).toBe(false);
    expect(queries.at(-1)).toBe("COMMIT");
  });
  test("busy foreground references immediately defer cleanup without taking the raw row or deleting", async () => {
    const h = harness(false, true);
    await expect(h.port.cleanupUnreferenced({ scope, candidate, lease })).resolves.toEqual({ status: "stale" });
    expect(h.calls.some(c => c.sql.includes("evolution:retention-raw-lock") || c.sql.includes("evolution:retention-delete"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("current, historical or derived references prevent deletion, including cross-scope anomalies", async () => {
    const h = harness(true);
    await expect(h.port.cleanupUnreferenced({ scope, candidate, lease })).resolves.toEqual({ status: "referenced" });
    const sql = h.calls.find(c => c.sql.includes("evolution:retention-references"))!.sql;
    expect(sql).toContain("mengshu_graph_entity_evidence");
    expect(sql).toContain("mengshu_session_working_set_entries");
    for (const table of ["mengshu_work_memory_nodes", "mengshu_work_memory_edges"]) {
      expect(sql).toContain(table);
      expect(h.calls.find(c => c.sql.startsWith("LOCK TABLE"))?.sql).toContain(table);
    }
    expect(sql).toContain("evidence_memory_ids ? $1");
    expect(sql).toContain("evidence_chunk_ids ? $1");
    expect(sql).not.toContain("relation_state = 'effective'");
    expect(h.calls.some(c => c.sql.includes("evolution:retention-delete"))).toBe(false);
  });
  test("scope and expired snapshot CAS do not allow deleting changed raw", async () => {
    const h = harness();
    await expect(h.port.cleanupUnreferenced({ scope: { ...scope, userId: "other" }, candidate, lease })).rejects.toThrow("SCOPE_MISMATCH");
    await expect(h.port.cleanupUnreferenced({ scope, candidate: { ...candidate, revision: "a".repeat(64) }, lease })).resolves.toEqual({ status: "stale" });
    expect(h.calls.some(c => c.sql.includes("evolution:retention-delete"))).toBe(false);
  });
});
