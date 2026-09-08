import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { vectorDimsForModel } from "../../../config.js";
import { PostgresProvider } from "../../../packages/core/src/db/providers/postgres.js";
import { createEmbeddingSpace } from "../../../packages/core/src/domain/embedding-space.js";
import { recordToMemoryEntry } from "../../../packages/core/src/domain/legacy-mapping.js";
import type { MemoryRecord, MemoryScope } from "../../../packages/core/src/domain/types.js";
import { computeContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { historyHash } from "../../../packages/core/src/evolution/history/schema.js";
import { auditHistory } from "../../../packages/core/src/evolution/history/audit.js";
import { planHistory } from "../../../packages/core/src/evolution/history/plan.js";
import { PostgresHistoryReadPort, type HistoryPgClient, type HistoryPgPool } from "../../../packages/core/src/evolution/history/postgres-read.js";
import { createPostgresHistoryNativePort } from "../../../packages/core/src/evolution/history/postgres-native.js";
import type { HistoryNativeMaterials } from "../../../packages/core/src/evolution/history/native-materials.js";
import type { HistoryApprovedOperation } from "../../../packages/core/src/evolution/history/postgres-store.js";
import type { HistoryContinuationInput } from "../../../packages/core/src/evolution/history/types.js";
import { provisionEvolutionVerificationSchema } from "../memory-evolution/isolated-postgres.js";
import { historyNativeProjection } from "./native-projection.js";

/** Live-only synthetic seed. All DDL comes from the actual provider, never simplified test tables. */
export async function openHistoryNativePostgres() {
  if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1") throw new Error("HISTORY_FIXTURE_REQUIRES_LIVE_OPT_IN");
  const isolated = await provisionEvolutionVerificationSchema();
  const model = isolated.config.embedding.model ?? "text-embedding-3-small";
  const provider = new PostgresProvider(isolated.postgres, model);
  const pool = new pg.Pool({ ...isolated.postgres, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000, options: `-c search_path=${isolated.schema},public` });
  let root: string | undefined;
  const close = async () => { try { await provider.close(); } finally { try { await pool.end(); } finally { try { await isolated.dispose(); } finally { if (root) await rm(root, { recursive: true, force: true }); } } } };
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "history-native-pg-")));
    await provider.initialize();
    await provider.applyScopeContentHashDedupeContract({ maintenance: true, quiescenceConfirmed: true });
    if ((await pool.query("SELECT current_schema() AS schema")).rows[0]?.schema !== isolated.schema) throw new Error("HISTORY_FIXTURE_SCHEMA_ISOLATION_FAILED");
    const space = createEmbeddingSpace({ provider: isolated.config.embedding.provider, baseURL: isolated.config.embedding.baseURL ?? "", model, dim: vectorDimsForModel(model), normalization: "none" });
    await provider.registerActiveEmbeddingSpace(space);
    const vector = Array.from({ length: vectorDimsForModel(model) }, (_, index) => index === 0 ? 1 : 0);
    const scope: MemoryScope = { tenantId: "history-fixture", userId: "history-fixture-owner", appId: "fixture-app", projectId: "p16", agentId: "fixture-agent", namespace: "fixture", visibility: "private" };
    const sourceId = randomUUID(), targetId = randomUUID(), outsideId = randomUUID(), parentRunId = `p15-fixture-${randomUUID()}`, runId = `p16-fixture-${randomUUID()}`;
    const fixture = historyNativeProjection(scope, sourceId, targetId), { bundle, asset, fingerprint } = fixture, now = Date.now() - 20000;
    const stamp = { embeddingSpaceId: space.embeddingSpaceId, embeddingSpaceState: "known-queryable" };
    const record = (id: string, text: string, pending = false): MemoryRecord => ({ id, scope, text, contentHash: computeContentHash(text), kind: "fact", semanticType: "resource", container: "project", lifecycleStatus: "active", importance: 0.6, confidence: 0.6, category: "fact", dataType: "memory", createdAt: now, vector,
      provenance: { source: "synthetic-pg-fixture", sourceId: `synthetic:${id}` }, sourceNodeIds: [],
      metadata: { ...bundle.memories[0].row.metadata as Record<string, unknown>, ...stamp, admissionRoute: pending ? "pending" : "lookup_only", contextEligible: false,
        governance: { commandType: "observeAuto", evidenceIds: [], native: { dataType: "memory", kind: "fact", category: "fact", container: "project" }, candidate: { riskFlags: [], targetScope: "project", evidence: { eventIds: [] } }, provenance: { source: "synthetic-pg-fixture", sourceId: `synthetic:${id}` } } } });
    await provider.store([recordToMemoryEntry(record(sourceId, fixture.sourceText)), recordToMemoryEntry(record(targetId, fixture.text, true)), recordToMemoryEntry(record(outsideId, "An unrelated synthetic record must remain byte-for-byte unchanged."))]);
    // Reproduce legacy P15 pending staging; this seed is not a native P16 mutation.
    await pool.query("UPDATE memories SET lifecycle_status='pending' WHERE id=$1", [targetId]);
    await pool.query(`INSERT INTO mengshu_markdown_migration_runs(run_id,source_manifest_sha256,source_snapshot_sha256,governed_manifest_sha256,policy_version,status,source_count,mapped_count,staged_live_count,prepared_at,updated_at) VALUES($1,$2,$3,$4,'synthetic-p15/v1','verified',1,1,1,$5,$5)`, [parentRunId, historyHash("source-manifest"), historyHash("source-snapshot"), historyHash("governance-manifest"), now]);
    // Model v35 ledger payloads against current provider schema defaults, without altering schema.
    const oldPayload = "to_jsonb(m.*) - ARRAY['evolution_review_due_at','evolution_disputed','text_tsv']::text[]";
    await pool.query(`INSERT INTO mengshu_markdown_migration_before_rows(run_id,source_table,record_id,row_sha256,row_payload,captured_at) SELECT $1,'memories',$2,encode(sha256(convert_to((${oldPayload})::text,'UTF8')),'hex'),${oldPayload},$3 FROM memories m WHERE id::text=$2`, [parentRunId, sourceId, now]);
    await pool.query(`INSERT INTO mengshu_markdown_migration_staged_rows(run_id,source_table,record_id,source_ref,source_hash,row_sha256,row_payload,created_at) SELECT $1,'memories',$2,$3,$4,$5,${oldPayload},$6 FROM memories m WHERE id::text=$2`, [parentRunId, targetId, `canonical:${targetId}`, bundle.memories[0].rowSha256, historyHash("synthetic-vector-domain"), now]);
    await pool.query(`INSERT INTO mengshu_markdown_migration_mappings(run_id,source_ref,source_hash,scope_fingerprint,disposition,canonical_target_ref,reason_code,mapping_sha256,created_at) VALUES($1,$2,$3,$4,'merge_semantic',$5,'synthetic_review',$6,$7)`, [parentRunId, fixture.sourceRef, fixture.sourceHash, fingerprint, `memories:${targetId}`, bundle.mappings[0].mappingSha256, now]);
    await pool.query(`INSERT INTO mengshu_vaults(scope_fingerprint,vault_id,descriptor,status,created_at,updated_at) VALUES($1,'fixture-vault','{}','active',$2,$2)`, [fingerprint, now]);
    await pool.query(`INSERT INTO mengshu_asset_versions(scope_fingerprint,asset_id,version,kind,status,visibility,owner_user_id,descriptor,created_at) VALUES($1,$2,1,'memory_view','review','private',$3,'{}',$4)`, [fingerprint, asset.assetId, scope.userId, now]);
    await pool.query(`INSERT INTO mengshu_governed_document_bindings(scope_fingerprint,vault_id,asset_id,asset_version,schema_version,kind,purpose,semantic_type,lifecycle_state,governance_state,relative_path,normalized_path,governance_descriptor,public_content_hash,governance_projection_hash,render_hash,sync_state,updated_at)
      VALUES($1,'fixture-vault',$2,1,1,'memory_document','typed_memory','resource','review','current','reference.md','reference.md',$3::jsonb,$4,$5,$6,'sync_pending',$7)`, [fingerprint, asset.assetId, JSON.stringify({ p15RunId: parentRunId, projection: bundle.documents[0], claimEvidenceBindings: bundle.evidence }), asset.publicContentHash, asset.governanceProjectionHash, historyHash("pending-render"), now]);
    const query = { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => { const result = await pool.query<Row>(sql, [...values]); return { rows: result.rows, rowCount: result.rowCount }; } };
    const transport: HistoryPgPool = { connect: async () => { const client = await pool.connect(); return { query: async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => { const result = await client.query<Row>(sql, [...values]); return { rows: result.rows, rowCount: result.rowCount }; }, release: () => client.release() } satisfies HistoryPgClient; } };
    const input: HistoryContinuationInput = { schema: "mengshu.history-p16-input/v1", runId, parentRunId, parentReceiptHash: historyHash("unfrozen"), projectionHash: bundle.manifest.projectionHash, sourceManifestHash: historyHash("source-manifest"), governanceManifestHash: historyHash("governance-manifest"), policyVersion: "synthetic-p16/v1",
      expected: { sources: 1, targets: 1, claimBindings: 1, scopes: 1 }, limits: { pageSize: 10, maxSources: 10, maxTargets: 10, maxBindings: 10, maxBatchUnits: 10, maxDurationMs: 60000 } };
    input.parentReceiptHash = (await new PostgresHistoryReadPort(query, bundle, input).readParent(input)).receiptHash;
    const read = new PostgresHistoryReadPort(query, bundle, input), audit = await auditHistory(input, read), plan = planHistory(input, audit);
    if (audit.unresolved.length || audit.held.length || plan.counts.memoryTargets !== 1) throw new Error(`HISTORY_FIXTURE_AUDIT_FAILED:${JSON.stringify({ unresolved: audit.unresolved, held: audit.held })}`);
    const activation = plan.units.find(unit => unit.phase === "activate")!;
    const body: Omit<HistoryNativeMaterials, "hash"> = { schema: "mengshu.history-p16-native-materials/v1", planHash: plan.hash, reviewReceiptId: "synthetic-owner-review", historicalAuthorshipAsserted: false,
      activations: [{ unitId: activation.id, route: "lookup_only", confidenceCeiling: 0.6, candidate: { text: fixture.text, semanticType: "resource", salience: 0.8, temporality: "persistent", crossContextual: false, targetScope: "project", evidence: { quote: fixture.text, eventIds: [] } } }],
      documents: [{ asset, vaultId: "fixture-vault", canonicalPath: "reference.md" }], knowledge: [] };
    const materials = { ...body, hash: historyHash(body) };
    const identity = (await pool.query(`SELECT current_database() AS name,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS oid,COALESCE(inet_server_addr()::text,'unix') AS address,COALESCE(inet_server_port(),0) AS port`)).rows[0];
    const approvals: HistoryApprovedOperation[] = (["apply", "archive", "rollback"] as const).map(action => ({ planHash: plan.hash, action, expiresAt: Date.now() + 300000, databaseFingerprint: historyHash(identity), scopes: [scope], nativeMaterialHash: materials.hash,
      authorization: { token: `P16_${action.toUpperCase()}:${runId}:${plan.hash}`, reviewReceiptId: materials.reviewReceiptId, backupReceiptHash: historyHash("synthetic-empty-schema-seed"), restoreReceiptHash: historyHash("synthetic-recreate-only-not-a-real-backup"), rehearsalReceiptHash: historyHash("synthetic-test-harness"), maintenanceReceiptId: "synthetic-no-host", quiescenceReceiptId: "synthetic-no-workers" } }));
    const native = createPostgresHistoryNativePort({ pool: transport, read, plan, materials, approvedOperations: approvals, vaultRoots: { "fixture-vault": root } });
    return { ...fixture, input, plan, audit, read, provider, pool, query, scope, sourceId, targetId, outsideId, native, approvals, close,
      authorization: (action: HistoryApprovedOperation["action"]) => approvals.find(item => item.action === action)!.authorization };
  } catch (error) { await close(); throw error; }
}
