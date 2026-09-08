import { describe, expect, test, vi } from "vitest";
import { applyEvolutionMetadata, recomputeEvolutionConfidence } from "./governed-metadata.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { PostgresEvolutionVerifiedInput } from "./governed-writer.js";
const scope = { tenantId: "tenant", userId: "user", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const fp = authorityScopeFingerprint(scope), id = "11111111-1111-4111-8111-111111111111";
describe("evolution metadata governance", () => {
  test("equivalent merge preserves raw source revision and current file/span reconciliation identity", async () => {
    const otherId = "22222222-2222-4222-8222-222222222222", text = "The same scoped literal fact.";
    const link = { link_id: "old-link", target_memory_id: otherId, evidence_memory_id: "33333333-3333-4333-8333-333333333333",
      relation_state: "effective", root_evidence_id: "root", source_id: "docs", source_revision: "original-revision", source_current_revision: "current-revision",
      source_hash: "a".repeat(64), source_kind: "verified_document", source_record_id: "record-1", source_path_id: "b".repeat(64), source_span_id: "span-1",
      source_logical_file_id: "file-1", continuity_key: "continuity-1", independence_group_id: "group-1" };
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    let copied = false;
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("evolution:governed-links")) return { rows: [link, ...(copied ? [{ ...link, link_id: "copied-link", target_memory_id: id }] : [])].filter(l => (params[1] as string[]).includes(l.target_memory_id)) };
      if (sql.includes("evolution:governed-link */")) copied = true;
      if (sql.includes("evolution:metadata-write") || sql.includes("evolution:legacy-expire")) return { rows: [{ id: params[9] }] };
      return { rows: [] };
    });
    const rows = [id, otherId].map(memoryId => ({ id: memoryId, text, lineage_id: null, revision: 0, lifecycle_status: "archived",
      metadata: { admissionRoute: "lookup_only", contextEligible: false, confidence: 0.4, governance: { evidenceIds: [] } } }));
    const verified = { context: { proposal: { id: "proposal", batchId: "batch", operation: "merge_equivalent", reasonCode: "equivalent_claim", scope, scopeFingerprint: fp,
      targetRefs: [id, otherId].map(memoryId => ({ memoryId, expectedRevision: 0, beforeHash: "a".repeat(64) })) } },
      targets: [id, otherId].map(memoryId => ({ memoryId, text, kind: "fact" })), supportedEvidence: [], validation: { independentEvidenceRootIds: [] } } as unknown as PostgresEvolutionVerifiedInput;
    await applyEvolutionMetadata({ client: { query } as never, verified, rows, bindings: [], now: 2000 });
    const insert = calls.find(c => c.sql.includes("evolution:governed-link */"))!;
    for (const [column, value] of Object.entries(link).filter(([column]) => ["source_current_revision", "source_record_id", "source_path_id", "source_span_id", "source_logical_file_id", "continuity_key", "independence_group_id"].includes(column))) {
      expect(insert.sql).toContain(column);
      expect(insert.params).toContain(value);
    }
    expect(insert.params).toContain("original-revision");
  });
  test("confidence counts a root once and excludes counterevidence/reviewed references", () => {
    const fact = { root_evidence_id: "root", source_kind: "verified_document", relation_state: "effective" };
    const score = recomputeEvolutionConfidence("resource", [fact], 0.5);
    expect(recomputeEvolutionConfidence("resource", [fact, fact, { ...fact, root_evidence_id: "untrusted", relation_state: "reviewed_reference" }, { ...fact, root_evidence_id: "counter", relation_state: "contradicting" }], 0.5)).toBe(score);
    expect(recomputeEvolutionConfidence("resource", [{ ...fact, relation_state: "revoked" }], score)).toBe(0);
  });
  test("revalidate updates only governance with receipt/audit/outbox in one supplied client", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => { calls.push(sql); return { rows: sql.includes("evolution:metadata-write") ? [{ id }] : [] }; });
    const row = { id, revision: null, lineage_id: null, lifecycle_status: "archived", metadata: { admissionRoute: "lookup_only", contextEligible: false, confidence: 0, governance: { evidenceIds: [], candidate: { evidence: { eventIds: [] } } }, sourceNodeIds: [] } };
    const verified = { context: { proposal: { id: "proposal", batchId: "batch", operation: "revalidate", reasonCode: "source_changed", scope, scopeFingerprint: fp, targetRefs: [{ memoryId: id, expectedRevision: 0, beforeHash: "a".repeat(64) }] } }, targets: [{ memoryId: id }], supportedEvidence: [], validation: { independentEvidenceRootIds: [] } } as unknown as PostgresEvolutionVerifiedInput;
    await expect(applyEvolutionMetadata({ client: { query } as never, verified, rows: [row], bindings: [], now: 2000 })).resolves.toEqual([id]);
    expect(calls.some(sql => /INSERT INTO memories/.test(sql))).toBe(false);
    expect(calls.some(sql => sql.includes("evolution:metadata-receipt"))).toBe(true);
    expect(calls.some(sql => sql.includes("evolution:metadata-outbox") && sql.includes("evolution_origin"))).toBe(true);
    expect(calls.some(sql => sql === "BEGIN" || sql === "COMMIT")).toBe(false);
  });
  test.each(["mark_disputed", "revalidate"])("%s suppresses context and preserves lookup/evidence while review is unresolved", async (operation) => {
    const calls: { sql: string; params: readonly unknown[] }[] = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: sql.includes("evolution:metadata-write") ? [{ id }] : [] };
    });
    const row = { id, revision: null, lineage_id: null, lifecycle_status: "active", metadata: { admissionRoute: "active", contextEligible: true, confidence: 0.9, governance: { evidenceIds: ["original"], evolution: operation === "revalidate" ? { needsReview: true } : {}, candidate: { evidence: { eventIds: ["original"] } } }, sourceNodeIds: ["original"] } };
    const verified = { context: { proposal: { id: "proposal", batchId: "batch", operation, reasonCode: "source_changed", scope, scopeFingerprint: fp, targetRefs: [{ memoryId: id, expectedRevision: 0, beforeHash: "a".repeat(64) }] } }, targets: [{ memoryId: id }], supportedEvidence: [], validation: { independentEvidenceRootIds: [] } } as unknown as PostgresEvolutionVerifiedInput;
    await applyEvolutionMetadata({ client: { query } as never, verified, rows: [row], bindings: [], now: 2000 });
    const update = calls.find(c => c.sql.includes("evolution:metadata-write"))!;
    const metadata = JSON.parse(String(update.params[10]));
    expect(metadata.contextEligible).toBe(false);
    expect(metadata.admissionRoute).toBe("active");
    expect(metadata.governance.evidenceIds).toEqual(["original"]);
    expect(update.sql).toContain("{record,metadata}");
    expect(calls.find(c => c.sql.includes("evolution:metadata-outbox"))?.sql).toContain("evolution_origin");
    if (operation === "mark_disputed") expect(metadata.governance.evolution.disputed).toBe(true);
    else expect(metadata.governance.evolution.needsReview).toBe(true);
  });
});
