import { describe, expect, test } from "vitest";
import { openHistoryNativePostgres } from "../fixtures/evolution-history/native-postgres.js";
import { applyHistory, archiveHistory, rollbackHistory, verifyHistory } from "../../packages/core/src/evolution/history/execution.js";
import { auditHistory } from "../../packages/core/src/evolution/history/audit.js";
import { historyNativeEvidenceId } from "../../packages/core/src/evolution/history/native-materials.js";
import { historyHash } from "../../packages/core/src/evolution/history/schema.js";
import { historySemanticSql } from "../../packages/core/src/evolution/history/postgres-read.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidate } from "../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { PostgresGovernedRetrievalHydrator } from "../../packages/core/src/retrieval/postgres-governed-retrieval-hydrator.js";
import { PostgresEvidenceContentReadPort } from "../../packages/core/src/graph/postgres-evidence-content-read.js";

const enabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
type Fixture = Awaited<ReturnType<typeof openHistoryNativePostgres>>;
const receiptCount = async (h: Fixture) => (await h.pool.query("SELECT count(*)::int AS n FROM mengshu_evolution_operation_receipts WHERE operation IN ('history_evidence','history_activate','history_knowledge','history_archive') AND receipt->>'runId'=$1", [h.input.runId])).rows[0].n;
async function snapshot(h: Fixture) {
  const tables = ["memories", "knowledge", "mengshu_memory_evidence_links", "mengshu_memory_lineage_heads", "mengshu_memory_version_outbox", "mengshu_memory_version_transition_receipts", "mengshu_governed_document_bindings", "mengshu_governed_document_complete_heads", "mengshu_governed_document_sync_receipts", "mengshu_asset_versions", "mengshu_asset_heads", "mengshu_write_receipts", "mengshu_write_outbox", "mengshu_forget_receipts", "mengshu_forget_outbox", "mengshu_jobs_v2"] as const;
  const rows: Record<string, unknown> = {};
  for (const table of tables) rows[table] = (await h.pool.query(`SELECT to_jsonb(owned.*) AS row FROM ${table} owned ORDER BY to_jsonb(owned.*)::text`)).rows;
  return rows;
}

// Explicit loopback/config/isolation guards run before provisioning; default npm test never connects.
describe.skipIf(!enabled)("P16 history: real schema/provider, synthetic native transactions, no model/history", () => {
  test("pending -> evidence + reviewed lookup current; idempotency, archive and inverse rollback", async () => {
    const h = await openHistoryNativePostgres();
    try {
      const before = await snapshot(h), parent = await h.read.readParent(h.input);
      expect(h.plan.units.find(unit => unit.phase === "activate")!.target!.confidence).toBe(0.6);
      const applied = await applyHistory(h.plan, h.native, h.authorization("apply"));
      expect(applied.complete).toBe(true); expect(applied.receipts.map(receipt => receipt.phase)).toEqual(["evidence", "activate"]);
      const adopted = (await h.pool.query(`SELECT
        lifecycle_status='archived' AND temporal_activation_state='active' AS lookup_lifecycle,
        metadata->>'admissionRoute'='lookup_only' AND metadata->'contextEligible'='false'::jsonb AS lookup_route,
        metadata->>'memoryContainer'='session_candidate' AS lookup_container,
        jsonb_typeof(metadata->'confidence')='number' AND metadata->'confidence' BETWEEN '0'::jsonb AND '0.6'::jsonb AS confidence_ceiling,
        temporal_snapshot#>'{record,confidence}'=metadata->'confidence' AND temporal_snapshot#>'{record,metadata,confidence}'=metadata->'confidence' AS confidence_snapshot,
        temporal_snapshot#>'{record,metadata,admissionRoute}'=metadata->'admissionRoute' AND temporal_snapshot#>'{record,metadata,contextEligible}'=metadata->'contextEligible' AS route_snapshot,
        temporal_snapshot#>'{record,container}'=metadata->'memoryContainer' AND temporal_snapshot#>'{record,metadata,memoryContainer}'=metadata->'memoryContainer' AS container_snapshot,
        temporal_snapshot#>>'{record,lifecycleStatus}'=lifecycle_status AND temporal_snapshot#>>'{record,text}'=text AND temporal_snapshot#>>'{record,contentHash}'=content_hash AS record_snapshot,
        EXISTS (SELECT 1 FROM mengshu_memory_lineage_heads head WHERE head.scope_fingerprint=memories.scope_fingerprint AND head.lineage_id=memories.lineage_id AND head.current_version_id=memories.id AND head.current_version_revision=memories.revision) AS current_head
        FROM memories WHERE id=$1`, [h.targetId])).rows[0];
      expect(adopted).toEqual({ lookup_lifecycle: true, lookup_route: true, lookup_container: true, confidence_ceiling: true, confidence_snapshot: true, route_snapshot: true, container_snapshot: true, record_snapshot: true, current_head: true });
      const verification = await verifyHistory(h.plan, h.native);
      expect(verification.verifications).toHaveLength(2);
      const evidenceId = historyNativeEvidenceId(h.plan, h.plan.units.find(unit => unit.phase === "evidence")!);
      expect((await h.pool.query(`SELECT metadata->>'memoryContainer'='session_candidate' AND metadata#>>'{governance,native,container}'='session_candidate' AS container_contract,
        lifecycle_status='archived' AND metadata->>'admissionRoute'='evidence_only' AND metadata->'contextEligible'='false'::jsonb AS evidence_only,
        vector IS NOT NULL AND embedding_space_id IS NULL AND embedding_space_state='unknown-unqueryable' AS unqueryable_carrier
        FROM memories WHERE id=$1`, [evidenceId])).rows[0]).toEqual({ container_contract: true, evidence_only: true, unqueryable_carrier: true });
      expect((await new PostgresEvidenceContentReadPort(h.query).read(h.scope, [{ source: "memory", ref: evidenceId }]))[0]?.preview).toBe(h.text);
      const candidate: GovernedRetrievalCandidate = { candidateId: h.targetId, authoritativeRecordId: h.targetId, scope: h.scope, source: "vector", nodeType: "memory", relevance: 1, evidenceIds: [evidenceId] };
      const hydrator = new PostgresGovernedRetrievalHydrator(h.query), engine = new GovernedRetrievalEngine(hydrator);
      const current = await hydrator.hydrate({ scope: h.scope, authoritativeRecordId: h.targetId, candidates: [candidate] });
      expect(current?.record.id).toBe(h.targetId); expect(current?.record.confidence).toBeLessThanOrEqual(0.6);
      expect((await engine.retrieve({ intent: "lookup", scope: h.scope, candidates: [candidate], minScore: 0 })).hits.map(hit => hit.record.id)).toEqual([h.targetId]);
      expect((await engine.retrieve({ intent: "context", scope: h.scope, candidates: [candidate], minScore: 0 })).hits).toEqual([]);
      expect((await engine.retrieve({ intent: "lookup", scope: { ...h.scope, userId: "other-owner" }, candidates: [candidate], minScore: 0 })).hits).toEqual([]);
      const committed = await snapshot(h), count = await receiptCount(h);
      expect(count).toBe(2);
      const replayed = await applyHistory(h.plan, h.native, h.authorization("apply"));
      expect(replayed.receipts).toEqual(applied.receipts); expect(await receiptCount(h)).toBe(count); expect(await snapshot(h)).toEqual(committed);
      await expect(archiveHistory(h.plan, h.native, h.authorization("apply"))).rejects.toThrow("HISTORY_AUTHORIZATION_REQUIRED");
      const archived = await archiveHistory(h.plan, h.native, h.authorization("archive"));
      expect(archived.receipts).toHaveLength(1); expect(archived.receipts[0].phase).toBe("archive");
      expect((await h.pool.query("SELECT lifecycle_status FROM memories WHERE id=$1", [h.sourceId])).rows[0].lifecycle_status).toBe("archived");
      expect((await verifyHistory(h.plan, h.native, { includeArchive: true })).verifications).toHaveLength(3);
      expect((await archiveHistory(h.plan, h.native, h.authorization("archive"))).receipts).toEqual(archived.receipts);
      const restored = await rollbackHistory(h.plan, h.native, h.authorization("rollback"));
      expect(restored.receipts.map(receipt => receipt.phase)).toEqual(["archive", "activate", "evidence"]);
      expect(restored.receipts.every(receipt => receipt.status === "rolled_back")).toBe(true);
      expect(await snapshot(h)).toEqual(before);
      expect(await h.read.readParent(h.input)).toEqual(parent);
      expect((await rollbackHistory(h.plan, h.native, h.authorization("rollback"))).receipts).toEqual(restored.receipts);
    } finally { await h.close(); }
  }, 120000);

  test("actual PostgreSQL v35 -> v37 defaults are equivalent; dispute/deadline drift is held", async () => {
    const h = await openHistoryNativePostgres();
    try {
      expect(h.audit.held).toEqual([]);
      const baseline = await h.pool.query(`SELECT ${historySemanticSql("b.row_payload")} AS before,${historySemanticSql("to_jsonb(m.*)")} AS current FROM mengshu_markdown_migration_before_rows b JOIN memories m ON m.id::text=b.record_id WHERE b.run_id=$1`, [h.input.parentRunId]);
      expect(baseline.rows[0].before).toBe(baseline.rows[0].current);
      for (const [disputed, due] of [[true, 0], [false, 1], [false, 2]] as const) {
        await h.pool.query("UPDATE memories SET evolution_disputed=$2,evolution_review_due_at=$3 WHERE id=$1", [h.sourceId, disputed, due]);
        expect((await auditHistory(h.input, h.read)).held).toContainEqual({ ref: h.sourceRef, reason: "source_semantic_drift_or_missing" });
      }
      await expect(applyHistory(h.plan, h.native, h.authorization("apply"))).rejects.toThrow("HISTORY_COMMIT_UNCERTAIN");
      expect(await receiptCount(h)).toBe(0);
      expect((await h.pool.query("SELECT count(*)::int AS n FROM mengshu_memory_evidence_links")).rows[0].n).toBe(0);
    } finally { await h.close(); }
  }, 120000);

  test("rollback CAS preserves newer writes and outside same-count drift fails conservation", async () => {
    const h = await openHistoryNativePostgres();
    try {
      const outsideBefore = (await h.pool.query("SELECT text FROM memories WHERE id=$1", [h.outsideId])).rows[0].text;
      await h.pool.query("UPDATE memories SET text=$2 WHERE id=$1", [h.outsideId, "A changed outside fixture row with the same row count."]);
      await expect(applyHistory(h.plan, h.native, h.authorization("apply"))).rejects.toThrow("HISTORY_CONSERVATION_FAILED");
      expect(await receiptCount(h)).toBe(0);
      await h.pool.query("UPDATE memories SET text=$2 WHERE id=$1", [h.outsideId, outsideBefore]);
      const applied = await applyHistory(h.plan, h.native, h.authorization("apply"), { limit: 1 });
      expect(applied.receipts).toHaveLength(1);
      const rawId = applied.receipts[0].evidenceMemoryIds[0];
      await h.pool.query("UPDATE memories SET text=$2 WHERE id=$1", [rawId, "Newer synthetic evidence content must survive a stale rollback."]);
      await expect(rollbackHistory(h.plan, h.native, h.authorization("rollback"))).rejects.toThrow("HISTORY_ROLLBACK_UNCERTAIN");
      expect((await h.pool.query("SELECT text FROM memories WHERE id=$1", [rawId])).rows[0].text).toBe("Newer synthetic evidence content must survive a stale rollback.");
      expect(historyHash((await h.pool.query("SELECT text FROM memories WHERE id=$1", [h.outsideId])).rows[0].text)).toBe(historyHash(outsideBefore));
    } finally { await h.close(); }
  }, 120000);
});
