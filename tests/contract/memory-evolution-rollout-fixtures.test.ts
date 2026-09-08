import { describe, expect, test, vi } from "vitest";
import { PostgresEvolutionInventoryReadPort } from "../../packages/core/src/evolution/postgres-inventory.js";
import type { PostgresEvolutionQueryClient } from "../../packages/core/src/evolution/postgres-common.js";
import { validateEvolutionProposal } from "../../packages/core/src/evolution/proposal-validation.js";
import { EvolutionError } from "../../packages/core/src/evolution/schema.js";
import { transaction, type PostgresEvolutionPool } from "../../packages/core/src/evolution/postgres-common.js";
import { computeCanonicalContentHash } from "../../packages/core/src/scoring/hash-utils.js";
import { createPostgresRolloutSeed, openPostgresRollout, pgMetadataDraft } from "../fixtures/memory-evolution-rollout/postgres.js";
import { recordToMemoryEntry } from "../../packages/core/src/domain/legacy-mapping.js";
import type { MemoryRecord } from "../../packages/core/src/domain/types.js";
import { PostgresGovernedRetrievalHydrator } from "../../packages/core/src/retrieval/postgres-governed-retrieval-hydrator.js";
import { GovernedRetrievalEngine, type GovernedRetrievalCandidate } from "../../packages/core/src/retrieval/governed-retrieval-engine.js";
import { EVIDENCE_ID, EVIDENCE_TEXT, KNOWN_AT, MEMORY_ID, SCOPE, evidenceRow, memoryRow } from "../fixtures/memory-evolution/known-records.js";

// Native row decoding over a SQL transport fixture, never a real transaction/default Runtime proof.
function inventoryRows() {
  const raw = { ...evidenceRow(), id: EVIDENCE_ID, text: EVIDENCE_TEXT, created_at_ms: KNOWN_AT - 100,
    content_hash: computeCanonicalContentHash(EVIDENCE_TEXT) };
  const canonical = memoryRow(true);
  const client: PostgresEvolutionQueryClient = {
    async query<Row extends Record<string, unknown>>(sql: string) {
      let rows: Record<string, unknown>[];
      if (sql.includes("inventory-page") || sql.includes("inventory-targets")) rows = [canonical];
      else if (sql.includes("inventory-evidence") || sql.includes("inventory-hydrate")) rows = [raw];
      else throw new Error("unmodeled_sql_in_fixture_validation");
      return { rows: structuredClone(rows) as Row[], rowCount: rows.length };
    },
  };
  const inventory = new PostgresEvolutionInventoryReadPort({ client, scope: SCOPE });
  const read = () => inventory.readPage(SCOPE, { selectionEpoch: KNOWN_AT + 1,
    upperKey: { memoryId: MEMORY_ID, createdAt: KNOWN_AT } }, undefined, 1, { maxRecords: 20, maxBytes: 131_072 });
  return { inventory, read };
}

function scopeColumns(record: MemoryRecord) {
  const entry = recordToMemoryEntry(record);
  return { tenant_id: entry.tenantId, user_id: entry.userId, app_id: entry.productId, project_id: entry.canonicalProjectId,
    agent_id: entry.producerId, namespace: entry.namespace, visibility: entry.visibility,
    workspace_id: entry.workspaceId ?? "", session_id: record.scope.sessionId ?? "" };
}

// Transport-only SQL projections of the exact records passed to provider.store by the live fixture.
function seedReader(seed: ReturnType<typeof createPostgresRolloutSeed>) {
  const canonical = recordToMemoryEntry(seed.canonical), raw = recordToMemoryEntry(seed.raw);
  const memory = { id: canonical.id, text: canonical.text, content_hash: canonical.contentHash,
    importance: canonical.importance, category: canonical.category, data_type: canonical.dataType,
    created_at_ms: String(canonical.createdAt), updated_at_ms: String(canonical.createdAt), ...scopeColumns(seed.canonical),
    lifecycle_status: canonical.lifecycleStatus, legacy_quarantine_reason: null, metadata: canonical.metadata, evolution_disputed: false };
  const evidence = { evidence_id: raw.id, evidence_text: raw.text, evidence_created_at_ms: String(raw.createdAt),
    ...scopeColumns(seed.raw), data_type: raw.dataType, lifecycle_status: raw.lifecycleStatus, legacy_quarantine_reason: null,
    metadata: raw.metadata, evidence_origin: "record", ledger_link_id: null, ledger_target_memory_id: null,
    ledger_evidence_memory_id: null, ledger_link_kind: null, ledger_source: null, ledger_tenant_id: null, ledger_user_id: null,
    ledger_app_id: null, ledger_project_id: null, ledger_agent_id: null, ledger_namespace: null, ledger_visibility: null,
    ledger_workspace_id: null, ledger_session_id: null };
  const hydrator = new PostgresGovernedRetrievalHydrator({ async query<Row extends Record<string, unknown>>(sql: string) {
    if (sql.startsWith("SELECT")) return { rows: [structuredClone(memory)] as unknown as Row[], rowCount: 1 };
    if (sql.startsWith("WITH direct_evidence")) return { rows: [structuredClone(evidence)] as unknown as Row[], rowCount: 1 };
    throw new Error("unexpected_hydration_query");
  } });
  const candidate: GovernedRetrievalCandidate = { candidateId: "synthetic-bm25", authoritativeRecordId: seed.id,
    scope: seed.canonical.scope, source: "bm25", nodeType: "memory", relevance: 1, evidenceIds: [seed.rawId] };
  const engine = new GovernedRetrievalEngine(hydrator);
  return { hydrate: () => hydrator.hydrate({ scope: seed.canonical.scope, authoritativeRecordId: seed.id, candidates: [candidate] }),
    retrieve: (intent: "lookup" | "context") => engine.retrieve({ scope: seed.canonical.scope, candidates: [candidate], intent, minScore: 0 }) };
}

describe("offline PG fixture construction and native row contracts", () => {
  test("transaction wraps an attestation guard rejection, rolls back and releases, without a public raw cause", async () => {
    const calls: string[] = [];
    const query: PostgresEvolutionPool["query"] = async sql => { calls.push(sql); return { rows: [], rowCount: 0 }; };
    const release = vi.fn();
    const pool: PostgresEvolutionPool = { query, connect: async () => ({ query, release }) };
    const rejection = new EvolutionError("attestation_revoked_or_changed");
    const result = await transaction(pool, async client => { await client.query("SELECT synthetic_pre_guard_work"); throw rejection; }).catch(error => error);
    expect(result).toMatchObject({ name: "PostgresEvolutionError", code: "TRANSACTION_FAILED" });
    expect(result).not.toHaveProperty("cause");
    expect(calls[0]).toBe("BEGIN");
    expect(calls.at(-1)).toBe("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
  test("PG helper refuses before configuration discovery unless live is explicit", async () => {
    vi.stubEnv("MENGSHU_RUN_LIVE_TESTS", "0");
    try { await expect(openPostgresRollout()).rejects.toThrow("rollout_postgres_requires_explicit_live_opt_in"); }
    finally { vi.unstubAllEnvs(); }
  });
  test("live seed survives native hydration and lookup while kind-only context remains denied", async () => {
    const seed = createPostgresRolloutSeed("A synthetic release fact.", { embeddingSpaceId: "synthetic-space", vector: [1] });
    const reader = seedReader(seed);
    expect(await reader.hydrate()).toMatchObject({ record: { id: seed.id, category: "fact", kind: "fact", container: "session_candidate",
      metadata: { admissionRoute: "lookup_only", contextEligible: false, governance: { native: { category: "fact" } } } }, evidenceIds: [seed.rawId] });
    expect((await reader.retrieve("lookup")).hits.map(hit => hit.record.id)).toEqual([seed.id]);
    expect((await reader.retrieve("context")).hits).toEqual([]);
  });
  test.each(["wrong-container", "missing-category", "foreign-raw-scope"] as const)("native decoder still rejects %s in synthetic seed", async problem => {
    const seed = createPostgresRolloutSeed("A synthetic release fact.", { embeddingSpaceId: "synthetic-space", vector: [1] });
    const native = (seed.canonical.metadata.governance as { native: Record<string, unknown> }).native;
    if (problem === "wrong-container") {
      seed.canonical.container = "project";
      seed.canonical.metadata.memoryContainer = "project";
      native.container = "project";
    } else if (problem === "missing-category") delete native.category;
    else seed.raw.scope = { ...seed.raw.scope, userId: "foreign-owner" };
    const reader = seedReader(seed);
    expect(await reader.hydrate()).toBeUndefined();
    expect(await reader.retrieve("lookup")).toMatchObject({ hits: [], filtered: [{ filteredReason: "hydration_unavailable" }] });
  });
  test.each(["revalidate", "mark_disputed", "deprecate", "expire"] as const)("%s fixture uses the real proposal schema and preserves untrusted author state", async operation => {
    const { read } = inventoryRows();
    const unit = (await read()).units[0];
    unit.evidence = unit.evidence.filter(item => item.origin === "external");
    expect(unit.evidence).toHaveLength(1);
    expect(unit.evidence[0].trust).toBe("untrusted");
    const draft = pgMetadataDraft(unit, operation, KNOWN_AT + 1000);
    expect(draft.quotes[0].quote).toBe(EVIDENCE_TEXT);
    expect(validateEvolutionProposal(draft, unit, SCOPE)).toMatchObject({ outcome: "review", contextEligible: false, independentEvidenceRootIds: [] });
    if (operation === "expire") expect(draft).toMatchObject({ validTo: KNOWN_AT + 999, reasonCode: "applicability_ended" });
  });
  test("S15 unchanged native readTargets preserves the exact target state bound by readPage review", async () => {
    const { inventory, read } = inventoryRows();
    const unit = (await read()).units[0];
    const refs = unit.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    const current = await inventory.readTargets(SCOPE, refs);
    const original = unit.evidence.find(evidence => evidence.id === EVIDENCE_ID)!;
    expect(original).toMatchObject({ origin: "external", trust: "untrusted", text: EVIDENCE_TEXT });
    expect(original.rootEvidenceId).toMatch(/^legacy-root:/);
    expect(unit.targets[0].evidenceRootIds).toEqual([`canonical:${MEMORY_ID}`]);
    expect(current, "Hydrated raw is input evidence, not effective target support; unchanged full review target bindings must match.").toEqual(unit.targets);
    await expect(inventory.verifyEvidence(SCOPE, [original])).resolves.toEqual({ valid: true });
  });
});
