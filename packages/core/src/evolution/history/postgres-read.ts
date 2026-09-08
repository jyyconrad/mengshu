import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { canonicalSourceMigrationDisposition, type CanonicalProjectionBundle } from "../../db/migrations/canonical-postgres-rehydration.js";
import type { MemoryKind, MemoryScope, MemorySemanticType } from "../../domain/types.js";
import { historyHash, isCount, isHash, parseHistoryInput, rejectHistory } from "./schema.js";
import type { HistoryClaimBinding, HistoryContinuationInput, HistoryParentObservation, HistoryReadPort, HistorySourceWitness, HistoryTargetWitness } from "./types.js";

export interface HistoryPgClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount?: number | null }>;
  release(): void;
}
export interface HistoryPgPool { connect(): Promise<HistoryPgClient> }
export type HistoryPgQuery = Pick<HistoryPgClient, "query">;
const scalar = (value: unknown): string => typeof value === "string" ? value : "";
const nullable = (value: unknown): string | null => typeof value === "string" ? value : null;
const count = (value: unknown): number => { const n = Number(value); if (!isCount(n, Number.MAX_SAFE_INTEGER)) rejectHistory("HISTORY_PG_COUNT_INVALID"); return n; };
const DERIVED_COLUMNS = ["vector", "importance", "created_at", "updated_at", "last_accessed_at", "accessed_at", "access_count", "hotness", "query_hits", "embedding_space_id", "embedding_space_state", "search_vector", "tsv", "text_search_vector", "text_tsv"];
const OPERATIONAL_METADATA = ["accessCount", "lastAccessedAt", "queryHits", "hotness", "p15RunId", "p15ActivationState", "embeddingSpaceId", "embeddingSpaceState"];
const SCHEMA_DEFAULTS = { evolution_review_due_at: 0, evolution_disputed: false } as const;
const sqlArray = (values: readonly string[]) => `ARRAY[${values.map(value => `'${value}'`).join(",")}]::text[]`;

/** Offline policy oracle. Production computes this witness in SQL without returning source bodies. */
export function historySemanticPayload(value: Record<string, unknown>): Record<string, unknown> {
  const row = structuredClone(value);
  for (const key of DERIVED_COLUMNS) delete row[key];
  for (const [key, fallback] of Object.entries(SCHEMA_DEFAULTS)) if (row[key] === fallback) delete row[key];
  const metadata = { ...(row.metadata as Record<string, unknown> | null ?? {}) };
  for (const key of OPERATIONAL_METADATA) delete metadata[key];
  row.metadata = metadata;
  const strip = (item: unknown): unknown => Array.isArray(item) ? item.map(strip) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, nested]) => nested !== null).map(([key, nested]) => [key, strip(nested)])) : item;
  return strip(row) as Record<string, unknown>;
}

/** No text/vector value leaves SQL. Unknown non-null fields remain in the semantic witness. */
export function historySemanticSql(expression: "b.row_payload" | "to_jsonb(m.*)" | "s.row_payload" | "source.row_payload"): string {
  if (!["b.row_payload", "to_jsonb(m.*)", "s.row_payload", "source.row_payload"].includes(expression)) rejectHistory("HISTORY_PG_EXPRESSION_INVALID");
  const row = `(${expression})`;
  const defaults = Object.entries(SCHEMA_DEFAULTS).map(([key, value]) => ` - CASE WHEN ${row}->'${key}' = '${JSON.stringify(value)}'::jsonb THEN ${sqlArray([key])} ELSE ARRAY[]::text[] END`).join("");
  return `encode(sha256(convert_to(jsonb_strip_nulls((${row} - ${sqlArray(DERIVED_COLUMNS)}${defaults}) || jsonb_build_object('metadata', COALESCE(NULLIF(${row}->'metadata','null'::jsonb),'{}'::jsonb) - ${sqlArray(OPERATIONAL_METADATA)}))::text, 'UTF8')), 'hex')`;
}
export const historyRowHashSql = (expression: "b.row_payload" | "to_jsonb(m.*)" | "s.row_payload" | "source.row_payload") => `encode(sha256(convert_to((${expression})::text, 'UTF8')), 'hex')`;

export function historyPgScope(row: Record<string, unknown>): MemoryScope {
  return { tenantId: scalar(row.tenant_id), userId: scalar(row.user_id), appId: scalar(row.product_id), projectId: scalar(row.canonical_project_id), agentId: scalar(row.producer_id), namespace: scalar(row.namespace),
    visibility: scalar(row.visibility) as MemoryScope["visibility"], ...(row.workspace_id ? { workspaceId: scalar(row.workspace_id) } : {}), ...(row.session_id ? { sessionId: scalar(row.session_id) } : {}) };
}

/** Construct only with the existing strict P13/P15 projection parser's verified bundle. */
export class PostgresHistoryReadPort implements HistoryReadPort {
  readonly input: HistoryContinuationInput;
  constructor(readonly client: HistoryPgQuery, readonly bundle: CanonicalProjectionBundle, input: HistoryContinuationInput, private readonly ownEvidenceMemoryIds: readonly string[] = []) {
    this.input = parseHistoryInput(input);
    if (bundle.manifest.projectionHash !== input.projectionHash || bundle.mappings.length !== input.expected.sources || bundle.memories.length !== input.expected.targets || bundle.evidence.length !== input.expected.claimBindings ||
        new Set(bundle.mappings.map(row => row.sourceRef)).size !== bundle.mappings.length || new Set(bundle.memories.map(row => row.memoryId)).size !== bundle.memories.length) rejectHistory("HISTORY_PG_PROJECTION_MISMATCH");
  }
  private page<T>(rows: readonly T[], key: (row: T) => string, input: { parentRunId: string; after?: string; limit: number }) {
    if (input.parentRunId !== this.input.parentRunId || !isCount(input.limit, this.input.limits.pageSize, 1)) rejectHistory("HISTORY_PG_PAGE_INVALID");
    const eligible = rows.filter(row => !input.after || key(row) > input.after).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
    const selected = eligible.slice(0, input.limit);
    return { selected, ...(eligible.length > input.limit ? { next: key(selected.at(-1)!) } : {}) };
  }
  async readParent(input: HistoryContinuationInput): Promise<HistoryParentObservation> {
    if (input.parentRunId !== this.input.parentRunId) rejectHistory("HISTORY_PG_PARENT_MISMATCH");
    const result = await this.client.query(`/* history:parent-metadata */
WITH outside_rows AS (
  SELECT 'memories:' || m.id::text AS identity, to_jsonb(m.*) AS payload FROM memories m
  WHERE NOT EXISTS (SELECT 1 FROM mengshu_markdown_migration_before_rows b WHERE b.run_id=$1 AND b.source_table='memories' AND b.record_id=m.id::text)
    AND m.id::text <> ALL($2::text[])
  UNION ALL
  SELECT 'knowledge:' || m.id::text, to_jsonb(m.*) FROM knowledge m
  WHERE NOT EXISTS (SELECT 1 FROM mengshu_markdown_migration_before_rows b WHERE b.run_id=$1 AND b.source_table='knowledge' AND b.record_id=m.id::text)
)
SELECT run.run_id, run.status, run.source_manifest_sha256, run.governed_manifest_sha256,
  encode(sha256(convert_to(to_jsonb(run.*)::text,'UTF8')),'hex') AS receipt_hash,
  (SELECT count(*) FROM mengshu_markdown_migration_before_rows WHERE run_id=$1)::text AS sources,
  (SELECT count(*) FROM mengshu_markdown_migration_mappings WHERE run_id=$1)::text AS mappings,
  (SELECT count(*) FROM mengshu_markdown_migration_staged_rows WHERE run_id=$1)::text AS targets,
  (SELECT COALESCE(sum(jsonb_array_length(governance_descriptor->'claimEvidenceBindings')),0)
    FROM mengshu_governed_document_bindings WHERE governance_descriptor->>'p15RunId'=$1)::text AS claim_bindings,
  (SELECT count(*)::text FROM outside_rows) AS outside_rows,
  (SELECT encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(jsonb_build_array(identity,payload)::text,'UTF8')),'hex'),'' ORDER BY identity COLLATE "C"),''),'UTF8')),'hex') FROM outside_rows) AS outside_hash,
  (SELECT encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(to_jsonb(job.*)::text,'UTF8')),'hex'),'' ORDER BY job.id),''),'UTF8')),'hex') FROM mengshu_jobs_v2 job) AS queue_hash
FROM mengshu_markdown_migration_runs run WHERE run.run_id=$1`, [input.parentRunId, [...this.bundle.memories.map(row => row.memoryId), ...this.ownEvidenceMemoryIds]]);
    const row = result.rows[0];
    if (result.rows.length !== 1 || !row || !isHash(row.receipt_hash) || !isHash(row.outside_hash) || !isHash(row.queue_hash)) rejectHistory("HISTORY_PG_PARENT_MISSING");
    return { runId: scalar(row.run_id), materializationComplete: row.status === "verified" || row.status === "activated", receiptHash: scalar(row.receipt_hash), projectionHash: this.bundle.manifest.projectionHash,
      sourceManifestHash: scalar(row.source_manifest_sha256), governanceManifestHash: scalar(row.governed_manifest_sha256), sources: count(row.sources), mappings: count(row.mappings), targets: count(row.targets), claimBindings: count(row.claim_bindings), outsideCohortRows: count(row.outside_rows), outsideCohortHash: scalar(row.outside_hash), unrelatedQueueHash: scalar(row.queue_hash) };
  }
  async readSources(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistorySourceWitness[]; next?: string }> {
    const page = this.page(this.bundle.mappings, row => row.sourceRef, input);
    if (!page.selected.length) return { rows: [] };
    const requested = page.selected.map(row => ({ source_ref: row.sourceRef, source_table: row.sourceTable, record_id: row.sourceRecordId }));
    const result = await this.client.query(`/* history:source-metadata */
WITH requested AS (SELECT * FROM jsonb_to_recordset($2::jsonb) AS x(source_ref text,source_table text,record_id text)),
current_rows AS (
  SELECT r.source_ref, to_jsonb(m.*) AS row_payload, m.xmin::text AS revision FROM requested r JOIN memories m ON r.source_table='memories' AND m.id::text=r.record_id
  UNION ALL SELECT r.source_ref, to_jsonb(m.*), m.xmin::text FROM requested r JOIN knowledge m ON r.source_table='knowledge' AND m.id::text=r.record_id
)
SELECT requested.source_ref, mapping.source_hash, mapping.scope_fingerprint, mapping.mapping_sha256, mapping.disposition,
  ${historySemanticSql("b.row_payload")} AS before_semantic_hash, ${historyRowHashSql("b.row_payload")} AS before_row_hash,
  ${historySemanticSql("source.row_payload")} AS current_semantic_hash, ${historyRowHashSql("source.row_payload")} AS current_row_hash, source.revision,
  b.row_sha256 AS immutable_row_hash
FROM requested LEFT JOIN mengshu_markdown_migration_before_rows b ON b.run_id=$1 AND b.source_table=requested.source_table AND b.record_id=requested.record_id
LEFT JOIN mengshu_markdown_migration_mappings mapping ON mapping.run_id=$1 AND mapping.source_ref=requested.source_ref
LEFT JOIN current_rows source ON source.source_ref=requested.source_ref ORDER BY requested.source_ref COLLATE "C"`, [input.parentRunId, JSON.stringify(requested)]);
    const observed = new Map(result.rows.map(row => [scalar(row.source_ref), row]));
    const rows = page.selected.map(mapping => {
      const row = observed.get(mapping.sourceRef);
      if (!row || row.source_hash !== mapping.sourceHash || row.scope_fingerprint !== mapping.scopeFingerprint || row.mapping_sha256 !== mapping.mappingSha256 || row.disposition !== canonicalSourceMigrationDisposition(mapping).migrationDisposition ||
          !isHash(row.before_semantic_hash) || row.before_row_hash !== row.immutable_row_hash) rejectHistory("HISTORY_PG_SOURCE_LEDGER_DRIFT");
      return { sourceRef: mapping.sourceRef, sourceHash: mapping.sourceHash, mappingHash: mapping.mappingSha256, scopeFingerprint: mapping.scopeFingerprint,
        beforeSemanticHash: scalar(row.before_semantic_hash), currentSemanticHash: row.revision ? nullable(row.current_semantic_hash) : null, beforeRowHash: scalar(row.before_row_hash), currentRowHash: nullable(row.current_row_hash), currentRevision: nullable(row.revision),
        disposition: mapping.disposition, operation: mapping.operation, targetMemoryIds: [...mapping.targetMemoryIds] };
    });
    return { rows, ...(page.next ? { next: page.next } : {}) };
  }
  async readTargets(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistoryTargetWitness[]; next?: string }> {
    const page = this.page(this.bundle.memories, row => row.memoryId, input);
    if (!page.selected.length) return { rows: [] };
    const result = await this.client.query(`/* history:target-metadata */
SELECT s.record_id, s.source_hash AS projection_row_hash, ${historySemanticSql("s.row_payload")} AS expected_semantic_hash,
  ${historySemanticSql("to_jsonb(m.*)")} AS current_semantic_hash, m.xmin::text AS revision, m.lifecycle_status,
  m.tenant_id,m.user_id,m.product_id,m.canonical_project_id,m.producer_id,m.namespace,m.visibility,m.workspace_id,
  m.metadata->>'sessionId' AS session_id, COALESCE(m.metadata->>'kind',m.metadata #>> '{governance,native,kind}') AS kind, m.category,
  m.metadata->>'semanticType' AS semantic_type, m.metadata->>'confidence' AS confidence,
  m.metadata->>'pinned' AS pinned, m.temporal_invalidated, m.temporal_purge_pending,
  m.temporal_activation_state, m.valid_to,
  d.lifecycle_state AS document_state, (d.governance_descriptor->'projection'=frozen.projection) AS projection_matches
FROM mengshu_markdown_migration_staged_rows s LEFT JOIN memories m ON m.id::text=s.record_id
JOIN jsonb_to_recordset($3::jsonb) AS frozen(memory_id text,projection jsonb) ON frozen.memory_id=s.record_id
LEFT JOIN mengshu_governed_document_bindings d ON d.governance_descriptor->>'p15RunId'=$1 AND d.governance_descriptor #>> '{projection,memoryId}'=s.record_id
WHERE s.run_id=$1 AND s.record_id=ANY($2::text[]) ORDER BY s.record_id COLLATE "C"`, [input.parentRunId, page.selected.map(row => row.memoryId), JSON.stringify(this.bundle.documents.filter(document => page.selected.some(memory => memory.memoryId === document.memoryId)).map(projection => ({ memory_id: projection.memoryId, projection })))]);
    const observed = new Map(result.rows.map(row => [scalar(row.record_id), row]));
    const rows = page.selected.map(memory => {
      const row = observed.get(memory.memoryId), document = this.bundle.documents.find(row => row.memoryId === memory.memoryId);
      if (!row || !document || row.projection_row_hash !== memory.rowSha256 || !isHash(row.expected_semantic_hash)) rejectHistory("HISTORY_PG_TARGET_LEDGER_DRIFT");
      const scope = row.revision ? historyPgScope(row) : historyPgScope(memory.row as Record<string, unknown>);
      const kind = scalar(row.kind || row.category || memory.row.category) as MemoryKind, semanticType = scalar(row.semantic_type) as MemorySemanticType;
      return { memoryId: memory.memoryId, assetId: document.assetId, assetVersion: document.assetVersion, scope,
        expectedSemanticHash: scalar(row.expected_semantic_hash), currentSemanticHash: row.revision ? nullable(row.current_semantic_hash) : null, revision: nullable(row.revision), lifecycle: nullable(row.lifecycle_status), documentState: nullable(row.document_state),
        documentMatchesProjection: row.projection_matches === true && authorityScopeFingerprint(scope) === document.scopeFingerprint,
        ...(kind ? { kind } : {}), ...(semanticType ? { semanticType } : {}), pinned: row.pinned === "true", tombstoned: row.temporal_invalidated === true || row.temporal_purge_pending === true || ["revoked", "superseded"].includes(scalar(row.lifecycle_status)),
        current: row.valid_to == null && row.temporal_activation_state !== "staged", confidence: Number(row.confidence ?? 0), claimIds: [...document.claimIds] };
    });
    return { rows, ...(page.next ? { next: page.next } : {}) };
  }
  async readBindings(input: { parentRunId: string; after?: string; limit: number }): Promise<{ rows: HistoryClaimBinding[]; next?: string }> {
    const page = this.page(this.bundle.evidence, row => row.evidenceId, input);
    const rows = page.selected.map(evidence => {
      const target = this.bundle.documents.find(document => document.assetId === evidence.assetId && document.assetVersion === evidence.assetVersion);
      if (!target) rejectHistory("HISTORY_PG_BINDING_TARGET_MISSING");
      return { evidenceId: evidence.evidenceId, claimId: evidence.claimId, assetId: evidence.assetId, assetVersion: evidence.assetVersion, targetMemoryId: target.memoryId,
        sourceRef: evidence.sourceRef, sourceHash: evidence.sourceHash, scopeFingerprint: evidence.scopeFingerprint,
        rootEvidenceId: evidence.sourceMemoryId,
        ...(evidence.anchor && typeof evidence.anchor === "object" ? { anchor: structuredClone(evidence.anchor) as HistoryClaimBinding["anchor"] } : {}),
        // Import approval does not prove independent authorship; retain one unknown-dependence group per cohort/scope.
        independenceGroupId: historyHash({ parentRunId: input.parentRunId, scope: evidence.scopeFingerprint, independence: "unproven" }) };
    });
    return { rows, ...(page.next ? { next: page.next } : {}) };
  }
}
