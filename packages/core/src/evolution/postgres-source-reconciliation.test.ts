import { describe, expect, test, vi } from "vitest";
import { PostgresEvolutionSourceReconciliationPort, retireEvolutionSourceLinks } from "./postgres-source-reconciliation.js";
import { PostgresEvolutionRepository } from "./postgres-repository.js";
import { jsonHash, scopedFingerprint } from "./postgres-common.js";
import type { SourceReconciliationPlan } from "./sources/reconciliation-types.js";
const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const fp = scopedFingerprint(scope), hash = "a".repeat(64), prior = "b".repeat(64);
const lease = { batchId: "batch", scopeFingerprint: fp, ownerId: "owner", fencingToken: 1, expiresAt: 10000 };
function harness(options: { revokeRows?: Record<string, unknown>[]; authorize?: boolean } = {}) {
  const calls: { sql: string; params: readonly unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("evolution:lease-lock")) return { rows: [{ id: "batch" }] };
    if (sql.includes("evolution:source-file-lock")) return { rows: [{ revision: prior, disposition: "current" }] };
    if (sql.includes("evolution:source-global-lock")) return { rows: [{ revision: prior, disposition: "current" }] };
    if (sql.includes("evolution:source-revoke-select")) return { rows: options.revokeRows ?? [] };
    return { rows: [] };
  });
  const repository = new PostgresEvolutionRepository({ scope, pool: { query, connect: async () => ({ query, release() {} }) } as never });
  const guard = vi.fn(async () => undefined);
  return { calls, guard, port: new PostgresEvolutionSourceReconciliationPort({ repository, sourceId: "docs", configFingerprint: hash, now: () => 2000,
    ...(options.authorize ? { authorizeAdministrativeReview: guard } : {}) }) };
}
function plan(): SourceReconciliationPlan {
  const body = { scope, sourceId: "docs", configFingerprint: hash, snapshotHash: hash, enumerationComplete: false, events: [{ pathId: hash, logicalFileId: "file", semantics: "current_document" as const, kind: "supersede_spans" as const, previousRevisionId: prior, revisionId: hash, spanIds: ["removed-span"], preserveHistoricalEvidence: true as const, requestReview: true }], recordIds: [], records: [] };
  return { id: jsonHash(body), ...body };
}
describe("source reconciliation persistence", () => {
  test("retiring one source suppresses context even while another effective source remains readable", async () => {
    const id = "11111111-1111-4111-8111-111111111111", calls: { sql: string; params: readonly unknown[] }[] = [];
    const row = { id, lineage_id: null, metadata: { admissionRoute: "active", contextEligible: true, confidence: 0.9, semanticType: "resource", sourceNodeIds: ["retired-raw", "remaining-raw"], governance: { evidenceIds: ["retired-raw", "remaining-raw"], candidate: { evidence: { eventIds: ["retired-raw", "remaining-raw"] } } } } };
    const retired = { target_memory_id: id, evidence_memory_id: "retired-raw", link_id: "link1", relation_state: "superseded", root_evidence_id: "old-root", source_kind: "verified_document" };
    const remaining = { ...retired, evidence_memory_id: "remaining-raw", link_id: "link2", relation_state: "effective", root_evidence_id: "new-root" };
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("evolution:source-target")) return { rows: [row] };
      if (sql.includes("evolution:source-retire")) return { rows: [{ link_id: "link1" }] };
      if (sql.includes("evolution:governed-links")) return { rows: [retired, remaining] };
      if (sql.includes("evolution:metadata-write")) return { rows: [{ id }] };
      return { rows: [] };
    });
    await retireEvolutionSourceLinks({ query } as never, { scope, scopeFingerprint: fp, links: [retired], state: "superseded", operationId: "source-change", now: 2000 });
    const metadata = JSON.parse(String(calls.find(c => c.sql.includes("evolution:metadata-write"))!.params[10]));
    expect(metadata.contextEligible).toBe(false);
    expect(metadata.admissionRoute).toBe("active");
    expect(metadata.governance.evidenceIds).toEqual(["remaining-raw"]);
    expect(metadata.governance.evolution).toMatchObject({ needsReview: true, lastSourceReconciliationId: "source-change", effectiveRootIds: ["new-root"] });
    expect(calls.some(c => c.sql.includes("evolution:metadata-outbox"))).toBe(true);
  });
  test("complete file deletion is not swallowed by partial whole-source enumeration", async () => {
    const h = harness(), verifySource = vi.fn(async () => ({ valid: true }));
    await expect(h.port.reconcile({ plan: plan(), lease, verifySource })).resolves.toMatchObject({ sourceSnapshotHash: hash, recordIds: [] });
    expect(h.calls.some(c => c.sql.includes("evolution:source-retire-select") && c.params.includes(prior))).toBe(true);
    expect(h.calls.some(c => c.sql.includes("evolution:source-receipt"))).toBe(true);
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
    expect(verifySource).toHaveBeenCalledTimes(1);
  });
  test("unavailable file without whole-source enumeration fails rather than silently confirming", async () => {
    const h = harness(), p = plan();
    p.events[0]!.kind = "source_unavailable";
    const { id: _id, ...body } = p; p.id = jsonHash(body);
    await expect(h.port.reconcile({ plan: p, lease, verifySource: async () => ({ valid: true }) })).rejects.toThrow("SOURCE_ENUMERATION_REQUIRED");
    expect(h.calls.some(c => c.sql.includes("evolution:source-receipt"))).toBe(false);
  });
  test("source drift rolls back and cannot confirm the manifest", async () => {
    const h = harness();
    await expect(h.port.reconcile({ plan: plan(), lease, verifySource: async () => ({ valid: false }) })).rejects.toThrow("SOURCE_CHANGED");
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
  test("ordinary review IDs never authorize source-wide revoke", async () => {
    const h = harness();
    await expect(h.port.revoke({ scope, sourceId: "docs", expectedRevision: prior, reviewReceiptId: "ordinary-candidate-review", idempotencyKey: "revoke", lease })).rejects.toThrow("source_revoke_review_unavailable");
    expect(h.calls).toHaveLength(0);
  });
  test("257 source links exceed the explicit atomic cap without committing a partial revocation", async () => {
    const h = harness({ authorize: true, revokeRows: Array.from({ length: 257 }, (_, i) => ({ link_id: String(i), target_memory_id: String(i) })) });
    await expect(h.port.revoke({ scope, sourceId: "docs", expectedRevision: prior, reviewReceiptId: "administrative-approval", idempotencyKey: "revoke", lease })).rejects.toThrow("SOURCE_RELATION_LIMIT");
    expect(h.guard).toHaveBeenCalledTimes(1);
    expect(h.calls.find(c => c.sql.includes("evolution:source-revoke-select"))?.sql).toContain("LIMIT 257");
    expect(h.calls.some(c => c.sql.includes("evolution:source-revoke-state") || c.sql.includes("evolution:source-revoke-commit") || c.sql.includes("evolution:source-retire */"))).toBe(false);
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
