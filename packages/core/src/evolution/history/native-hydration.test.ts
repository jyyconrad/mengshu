import { describe, expect, test } from "vitest";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { historyNativeProjection } from "../../../../../tests/fixtures/evolution-history/native-projection.js";
import { resolveAuthorityScope, type AuthorityScope } from "../../domain/authority-scope.js";
import type { MemoryRecord } from "../../domain/types.js";
import { MemoryWriteKernel, type MemoryWriteCommand, type MemoryWriteKernelDependencies, type WriteMemoryRecord } from "../../service/write-kernel.js";
import { validateCandidate } from "../../lifecycle/candidate-validator.js";
import { PostgresGovernedRetrievalHydrator } from "../../retrieval/postgres-governed-retrieval-hydrator.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidate } from "../../retrieval/governed-retrieval-engine.js";
import { historyClientScope } from "./postgres-store.js";
import { historyNativeMemoryRecord, historyRawEvidenceCommand } from "./postgres-native.js";

const SOURCE_ID = "10000000-0000-4000-a000-000000000001", TARGET_ID = "10000000-0000-4000-a000-000000000002", RAW_ID = "10000000-0000-4000-a000-000000000003";
async function fixture() {
  const scope = historyFixture().scope, projection = historyNativeProjection(scope, SOURCE_ID, TARGET_ID);
  const authority: AuthorityScope = { tenantId: scope.tenantId, userId: scope.userId, allow: { appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: ["private"] } };
  const rawCommand = historyRawEvidenceCommand({ sourceRef: projection.sourceRef, text: projection.text, serverAuthority: authority, clientScope: historyClientScope(scope), idempotencyKey: "raw-fixture" });
  const canonicalCommand: MemoryWriteCommand = { type: "saveExplicit", kind: "fact", semanticType: "resource", text: projection.text, serverAuthority: authority, clientScope: historyClientScope(scope), idempotencyKey: "canonical-fixture", evidenceIds: [RAW_ID], provenance: { source: "history-curation", sourceId: projection.asset.assetId } };
  const capture = async (command: MemoryWriteCommand, raw: boolean) => {
    let record: WriteMemoryRecord | undefined;
    const dependencies: MemoryWriteKernelDependencies = {
      temporalMemoryEnabled: !raw, temporalLookupOnlyEnabled: true,
      resolveAuthority: ({ serverAuthority, clientScope }) => resolveAuthorityScope(serverAuthority as AuthorityScope, clientScope),
      normalize: () => ({ text: projection.text, metadata: { ...(!raw ? projection.bundle.memories[0].row.metadata as Record<string, unknown> : {}), eventType: "observation" }, promptRisk: false }),
      embeddingGuard: () => ({ ok: true }), embed: async () => [],
      validate: () => {
        if (raw) return { accepted: true, candidate: { phase: "raw_evidence", evidenceOnly: true, quote: projection.text, sourceId: projection.sourceRef } };
        const candidate = validateCandidate({ text: projection.text, semanticType: "resource", salience: 0.8, temporality: "persistent", crossContextual: false, targetScope: "project", evidence: { quote: projection.text, eventIds: [RAW_ID] } }, { text: projection.text, scope: "project", eventIds: [RAW_ID] });
        if (candidate.rejected) throw new Error("SYNTHETIC_CANDIDATE_REJECTED");
        return { accepted: true, candidate: { ...candidate, confidence: 0, historicalConfidenceCeiling: 0.6 } };
      },
      scoreAdmission: () => ({ route: raw ? "evidence_only" : "lookup_only", valueScore: raw ? 0 : 0.6 }), scoreImportance: () => 0.6,
      exactDedup: () => ({ duplicate: false }), semanticDedup: () => ({ duplicate: false }),
      transaction: work => work({ getReceipt: async () => undefined, saveReceipt: async () => {}, appendAudit: async () => {}, appendOutbox: async () => {}, writeMemory: async value => { record = value; return { memoryId: value.id, stored: true }; } }),
      ack: () => {}, createId: () => raw ? RAW_ID : TARGET_ID, now: () => 1000,
    };
    expect((await new MemoryWriteKernel(dependencies).execute(command)).status).toBe("persisted");
    if (!record) throw new Error("SYNTHETIC_WRITE_MISSING");
    return record;
  };
  const rawRecord = await capture(rawCommand, true), canonicalRecord = await capture(canonicalCommand, false);
  return { scope, rawCommand, rawRecord, canonicalRecord, raw: historyNativeMemoryRecord(rawRecord), canonical: historyNativeMemoryRecord(canonicalRecord), capture };
}

function row(memory: MemoryRecord) {
  return { id: memory.id, text: memory.text, content_hash: memory.contentHash, importance: memory.importance, category: memory.category, data_type: memory.dataType, created_at_ms: "1000", updated_at_ms: "1000",
    tenant_id: memory.scope.tenantId, user_id: memory.scope.userId, app_id: memory.scope.appId, project_id: memory.scope.projectId, agent_id: memory.scope.agentId, namespace: memory.scope.namespace, visibility: memory.scope.visibility, workspace_id: "", session_id: "",
    lifecycle_status: memory.lifecycleStatus, legacy_quarantine_reason: null, evolution_disputed: false, metadata: JSON.parse(JSON.stringify(memory.metadata)) };
}
function evidenceRow(memory: MemoryRecord) {
  const { id, text, content_hash: _hash, importance: _importance, category: _category, created_at_ms, updated_at_ms: _updated, evolution_disputed: _disputed, ...rest } = row(memory);
  return { ...rest, evidence_id: id, evidence_text: text, evidence_created_at_ms: created_at_ms, evidence_origin: "record", ledger_link_id: null, ledger_target_memory_id: null, ledger_evidence_memory_id: null, ledger_link_kind: null, ledger_source: null,
    ledger_tenant_id: null, ledger_user_id: null, ledger_app_id: null, ledger_project_id: null, ledger_agent_id: null, ledger_namespace: null, ledger_visibility: null, ledger_workspace_id: null, ledger_session_id: null };
}
function reader(canonical: MemoryRecord, raw: MemoryRecord) {
  const client = { query: async <Row extends Record<string, unknown>>(sql: string) => ({ rows: [sql.includes("WITH direct_evidence") ? evidenceRow(raw) : row(canonical)] as unknown as Row[], rowCount: 1 }) };
  const candidate: GovernedRetrievalCandidate = { candidateId: canonical.id, authoritativeRecordId: canonical.id, scope: canonical.scope, source: "vector", nodeType: "memory", relevance: 1, evidenceIds: [raw.id] };
  const hydrator = new PostgresGovernedRetrievalHydrator(client);
  return { hydrator, engine: new GovernedRetrievalEngine(hydrator), input: { scope: canonical.scope, authoritativeRecordId: canonical.id, candidates: [candidate] } };
}

describe("history native kernel mapping -> actual hydrator (offline row contract, no PostgreSQL)", () => {
  test("raw evidence includes the native container required by the authoritative hydrator", async () => {
    const h = await fixture(), r = reader(h.canonical, h.raw);
    expect(h.rawCommand.container).toBe("session_candidate");
    expect(h.raw.metadata.governance).toMatchObject({ native: { container: "session_candidate" } });
    expect((await r.hydrator.hydrate(r.input))?.record.confidence).toBe(0);
    expect((await r.engine.retrieve({ ...r.input, intent: "lookup", minScore: 0 })).hits.map(hit => hit.record.id)).toEqual([h.canonical.id]);
    expect((await r.engine.retrieve({ ...r.input, intent: "context", minScore: 0 })).hits).toEqual([]);
  });
  test("reproduces the r3 read failure with the original missing-container native command", async () => {
    const h = await fixture(), { container: _container, ...originalCommand } = h.rawCommand;
    const original = historyNativeMemoryRecord(await h.capture(originalCommand, true));
    expect(original.container).toBe("session_candidate");
    expect(original.metadata.governance).not.toHaveProperty("native.container");
    const r = reader(h.canonical, original);
    expect(await r.hydrator.hydrate(r.input)).toBeUndefined();
    expect((await r.engine.retrieve({ ...r.input, intent: "lookup", minScore: 0 })).hits).toEqual([]);
  });
  test("adopted record/snapshot mirrors use the governed confidence and lookup route, not the old 0.6 mirror", async () => {
    const h = await fixture();
    expect(h.canonicalRecord.metadata.confidence).toBe(0.6);
    expect(h.canonicalRecord).toHaveProperty("temporal");
    expect(h.canonical).toMatchObject({ confidence: 0, lifecycleStatus: "archived", container: "session_candidate", metadata: { confidence: 0, admissionRoute: "lookup_only", contextEligible: false, memoryContainer: "session_candidate" } });
    expect(h.canonical.confidence).toBeLessThanOrEqual(0.6);
    expect(h.canonical.metadata.sourceNodeIds).toEqual(h.canonical.sourceNodeIds);
    expect(h.canonical.metadata.governance).toMatchObject({ evidenceIds: h.canonical.sourceNodeIds, native: { semanticType: "resource", dataType: "memory", category: "fact" } });
  });
});
