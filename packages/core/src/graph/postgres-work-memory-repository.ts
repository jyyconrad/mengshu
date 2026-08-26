import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  WorkMemoryEdge,
  WorkMemoryEdgeFilter,
  WorkMemoryGraphBatch,
  WorkMemoryGraphNode,
  WorkMemoryGraphRepository,
  WorkMemoryNodeFilter,
} from "./work-memory-types.js";
import { validateWorkMemoryEdge, validateWorkMemoryNode } from "./work-memory-validation.js";

export interface PostgresWorkMemoryQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresWorkMemoryQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresWorkMemoryQueryResult<Row>>;
}

export interface PostgresWorkMemoryTransactionClient extends PostgresWorkMemoryQueryClient {
  release(): void;
}

export interface PostgresWorkMemoryPool extends PostgresWorkMemoryQueryClient {
  connect(): Promise<PostgresWorkMemoryTransactionClient>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const NODE_TYPES = new Set(["evidence", "memory", "summary", "skill_candidate"]);
const EDGE_PREDICATES = new Set([
  "grounded_by", "derives_from", "contradicts", "supersedes", "promoted_to",
]);
const SEMANTIC_TYPES = new Set(["profile", "task_context", "rules", "experience", "resource"]);
const LIFECYCLE_STATUSES = new Set(["active", "archived", "revoked", "superseded", "promoted"]);
const EVIDENCE_KINDS = new Set(["chunk", "observation", "document", "message", "resource"]);
const TREE_TYPES = new Set(["source", "topic", "global"]);
const SKILL_STATUSES = new Set(["pending", "active", "archived", "rejected"]);

const SCOPE_COLUMNS = `scope_fingerprint, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, session_id`;
const SCOPE_WHERE = `scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10`;
const NODE_COLUMNS = `id, ${SCOPE_COLUMNS}, node_type, record_id, label, evidence_kind,
  semantic_type, lifecycle_status, tree_type, level, skill_candidate_status,
  evidence_memory_ids, evidence_chunk_ids, metadata, created_at, updated_at`;
const EDGE_COLUMNS = `id, ${SCOPE_COLUMNS}, edge_type, predicate, source_id, target_id,
  confidence, evidence_chunk_ids, reason, metadata, created_at, updated_at`;

const NODE_INSERT_SQL = `INSERT INTO mengshu_work_memory_nodes (
  id, ${SCOPE_COLUMNS}, node_type, record_id, label, evidence_kind, semantic_type,
  lifecycle_status, tree_type, level, skill_candidate_status, evidence_memory_ids,
  evidence_chunk_ids, metadata, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17, $18, $19, $20, $21::jsonb, $22::jsonb, $23::jsonb, $24, $25
)
ON CONFLICT (scope_fingerprint, id) DO UPDATE SET
  label = EXCLUDED.label,
  evidence_kind = EXCLUDED.evidence_kind,
  semantic_type = EXCLUDED.semantic_type,
  lifecycle_status = EXCLUDED.lifecycle_status,
  tree_type = EXCLUDED.tree_type,
  level = EXCLUDED.level,
  skill_candidate_status = EXCLUDED.skill_candidate_status,
  evidence_memory_ids = EXCLUDED.evidence_memory_ids,
  evidence_chunk_ids = EXCLUDED.evidence_chunk_ids,
  metadata = mengshu_work_memory_nodes.metadata || EXCLUDED.metadata,
  updated_at = EXCLUDED.updated_at
WHERE mengshu_work_memory_nodes.node_type = EXCLUDED.node_type
  AND mengshu_work_memory_nodes.record_id = EXCLUDED.record_id
  AND (
    EXCLUDED.node_type <> 'summary'
    OR (
      mengshu_work_memory_nodes.label = EXCLUDED.label
      AND mengshu_work_memory_nodes.tree_type IS NOT DISTINCT FROM EXCLUDED.tree_type
      AND mengshu_work_memory_nodes.level IS NOT DISTINCT FROM EXCLUDED.level
      AND mengshu_work_memory_nodes.evidence_chunk_ids = EXCLUDED.evidence_chunk_ids
      AND mengshu_work_memory_nodes.metadata = EXCLUDED.metadata
      AND mengshu_work_memory_nodes.created_at = EXCLUDED.created_at
    )
  )
RETURNING id`;

const EDGE_INSERT_SQL = `INSERT INTO mengshu_work_memory_edges (
  id, ${SCOPE_COLUMNS}, edge_type, predicate, source_id, target_id, confidence,
  evidence_chunk_ids, reason, metadata, created_at, updated_at
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16, $17::jsonb, $18, $19::jsonb, $20, $21
)
ON CONFLICT (scope_fingerprint, id) DO UPDATE SET
  confidence = GREATEST(mengshu_work_memory_edges.confidence, EXCLUDED.confidence),
  evidence_chunk_ids = EXCLUDED.evidence_chunk_ids,
  reason = EXCLUDED.reason,
  metadata = mengshu_work_memory_edges.metadata || EXCLUDED.metadata,
  updated_at = EXCLUDED.updated_at
WHERE mengshu_work_memory_edges.predicate = EXCLUDED.predicate
  AND mengshu_work_memory_edges.source_id = EXCLUDED.source_id
  AND mengshu_work_memory_edges.target_id = EXCLUDED.target_id
  AND (
    EXCLUDED.predicate <> 'derives_from'
    OR (
      mengshu_work_memory_edges.confidence = EXCLUDED.confidence
      AND mengshu_work_memory_edges.evidence_chunk_ids = EXCLUDED.evidence_chunk_ids
      AND mengshu_work_memory_edges.reason IS NOT DISTINCT FROM EXCLUDED.reason
      AND mengshu_work_memory_edges.metadata = EXCLUDED.metadata
      AND mengshu_work_memory_edges.created_at = EXCLUDED.created_at
    )
  )
RETURNING id`;

const GET_NODE_SQL = `SELECT ${NODE_COLUMNS}
FROM mengshu_work_memory_nodes WHERE ${SCOPE_WHERE} AND id = $11 LIMIT 2`;
const FIND_NODES_SQL = `SELECT ${NODE_COLUMNS}
FROM mengshu_work_memory_nodes WHERE ${SCOPE_WHERE}
  AND ($11::text IS NULL OR node_type = $11)
  AND ($12::text IS NULL OR record_id = $12)
  AND ($13::text IS NULL OR lower(label) LIKE '%' || lower($13) || '%')
ORDER BY created_at DESC, id LIMIT $14`;
const GET_EDGE_SQL = `SELECT ${EDGE_COLUMNS}
FROM mengshu_work_memory_edges WHERE ${SCOPE_WHERE} AND id = $11 LIMIT 2`;
const FIND_EDGES_SQL = `SELECT ${EDGE_COLUMNS}
FROM mengshu_work_memory_edges WHERE ${SCOPE_WHERE}
  AND ($11::text IS NULL OR source_id = $11 OR target_id = $11)
  AND ($12::text IS NULL OR predicate = $12)
ORDER BY confidence DESC, id LIMIT $13`;
const FIND_EVIDENCE_SQL = `SELECT ${NODE_COLUMNS}
FROM mengshu_work_memory_nodes WHERE ${SCOPE_WHERE}
  AND node_type = 'evidence' AND record_id = ANY($11::text[])
ORDER BY record_id`;
const FIND_ENDPOINTS_SQL = `SELECT ${NODE_COLUMNS}
FROM mengshu_work_memory_nodes WHERE ${SCOPE_WHERE}
  AND id = ANY($11::text[]) ORDER BY id`;

const NODE_KEYS = [
  "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
  "agent_id", "namespace", "visibility", "workspace_id", "session_id", "node_type",
  "record_id", "label", "evidence_kind", "semantic_type", "lifecycle_status", "tree_type",
  "level", "skill_candidate_status", "evidence_memory_ids", "evidence_chunk_ids", "metadata",
  "created_at", "updated_at",
] as const;
const EDGE_KEYS = [
  "id", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
  "agent_id", "namespace", "visibility", "workspace_id", "session_id", "edge_type",
  "predicate", "source_id", "target_id", "confidence", "evidence_chunk_ids", "reason",
  "metadata", "created_at", "updated_at",
] as const;

function invalid(message = "Postgres Work Memory Graph input is invalid"): Error {
  return new Error(message);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid(label);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw invalid(label);
  }
  return value as Record<string, unknown>;
}

function decodeResult(value: unknown): readonly Record<string, unknown>[] {
  const result = exactRecord(value, ["rows", "rowCount"], "Postgres Work Memory Graph query result is invalid");
  if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) throw invalid("Postgres Work Memory Graph query result is invalid");
  return result.rows as Record<string, unknown>[];
}

function idValue(value: unknown, label = "id"): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw invalid(`Postgres Work Memory Graph ${label} is invalid`);
  return value;
}

function integer(value: unknown, nullable = false): number | undefined {
  if (nullable && value === null) return undefined;
  if (typeof value === "string") {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw invalid("Postgres Work Memory Graph row is invalid");
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw invalid("Postgres Work Memory Graph row is invalid");
    }
    return parsed;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalid("Postgres Work Memory Graph row is invalid");
  }
  return value as number;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw invalid("Postgres Work Memory Graph row is invalid");
  }
  return value;
}

function stringArray(value: unknown, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || !SAFE_ID.test(item)) ||
      new Set(value).size !== value.length) throw invalid("Postgres Work Memory Graph row is invalid");
  return [...value] as string[];
}

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (!value || typeof value !== "object" || ancestors.has(value)) throw invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneJson(item, ancestors));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      result[key] = cloneJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function metadata(value: unknown): Record<string, unknown> {
  const result = cloneJson(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw invalid();
  return result as Record<string, unknown>;
}

function scopeParams(scope: CanonicalAuthorityScope, fingerprint: string): readonly string[] {
  return [fingerprint, scope.tenantId, scope.userId, scope.appId, scope.projectId,
    scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId];
}

function publicScope(scope: CanonicalAuthorityScope): MemoryScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    ...(scope.workspaceId === "" ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
  });
}

function assertRowScope(row: Record<string, unknown>, scope: CanonicalAuthorityScope, fingerprint: string): void {
  const expected = scopeParams(scope, fingerprint);
  const actual = [row.scope_fingerprint, row.tenant_id, row.user_id, row.app_id, row.project_id,
    row.agent_id, row.namespace, row.visibility, row.workspace_id, row.session_id];
  if (actual.some((value, index) => value !== expected[index])) throw invalid("Postgres Work Memory Graph row scope is invalid");
}

function optionalEnum(value: unknown, allowed: Set<string>): string | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || !allowed.has(value)) throw invalid("Postgres Work Memory Graph row is invalid");
  return value;
}

function decodeNode(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): WorkMemoryGraphNode {
  const row = exactRecord(value, NODE_KEYS, "Postgres Work Memory Graph node row is invalid");
  assertRowScope(row, scope, fingerprint);
  if (typeof row.node_type !== "string" || !NODE_TYPES.has(row.node_type) ||
      typeof row.label !== "string" || row.label.trim().length === 0) throw invalid("Postgres Work Memory Graph node row is invalid");
  const nodeScope = publicScope(scope);
  const common = {
    id: idValue(row.id), scope: nodeScope, nodeType: row.node_type, recordId: idValue(row.record_id, "record id"),
    label: row.label, metadata: metadata(row.metadata), createdAt: integer(row.created_at)!,
    ...(integer(row.updated_at, true) === undefined ? {} : { updatedAt: integer(row.updated_at, true)! }),
  };
  const evidenceMemoryIds = stringArray(row.evidence_memory_ids);
  const evidenceChunkIds = stringArray(row.evidence_chunk_ids);
  const evidenceKind = optionalEnum(row.evidence_kind, EVIDENCE_KINDS);
  const semanticType = optionalEnum(row.semantic_type, SEMANTIC_TYPES);
  const lifecycleStatus = optionalEnum(row.lifecycle_status, LIFECYCLE_STATUSES);
  const treeType = optionalEnum(row.tree_type, TREE_TYPES);
  const skillStatus = optionalEnum(row.skill_candidate_status, SKILL_STATUSES);
  const level = integer(row.level, true);
  let node: WorkMemoryGraphNode;
  if (row.node_type === "evidence" && evidenceKind && !semanticType && !lifecycleStatus && !treeType &&
      level === undefined && !skillStatus && evidenceMemoryIds.length === 0 && evidenceChunkIds.length === 0) {
    node = { ...common, nodeType: "evidence", evidenceKind } as WorkMemoryGraphNode;
  } else if (row.node_type === "memory" && lifecycleStatus && !evidenceKind && !treeType &&
      level === undefined && !skillStatus && evidenceMemoryIds.length === 0 && evidenceChunkIds.length > 0) {
    node = { ...common, nodeType: "memory", lifecycleStatus,
      ...(semanticType ? { semanticType } : {}), evidenceChunkIds } as WorkMemoryGraphNode;
  } else if (row.node_type === "summary" && treeType && level !== undefined && !evidenceKind &&
      !semanticType && !lifecycleStatus && !skillStatus && evidenceMemoryIds.length === 0 && evidenceChunkIds.length > 0) {
    node = { ...common, nodeType: "summary", treeType, level, evidenceChunkIds } as WorkMemoryGraphNode;
  } else if (row.node_type === "skill_candidate" && skillStatus && !evidenceKind && !semanticType &&
      !lifecycleStatus && !treeType && level === undefined && evidenceMemoryIds.length > 0 && evidenceChunkIds.length > 0) {
    node = { ...common, nodeType: "skill_candidate", status: skillStatus,
      evidenceMemoryIds, evidenceChunkIds } as WorkMemoryGraphNode;
  } else {
    throw invalid("Postgres Work Memory Graph node row is invalid");
  }
  validateWorkMemoryNode(node, nodeScope);
  return node;
}

function decodeEdge(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): WorkMemoryEdge {
  const row = exactRecord(value, EDGE_KEYS, "Postgres Work Memory Graph edge row is invalid");
  assertRowScope(row, scope, fingerprint);
  if (row.edge_type !== "memory_relation" || typeof row.predicate !== "string" ||
      !EDGE_PREDICATES.has(row.predicate) || (row.reason !== null && typeof row.reason !== "string")) {
    throw invalid("Postgres Work Memory Graph edge row is invalid");
  }
  const updatedAt = integer(row.updated_at, true);
  return {
    id: idValue(row.id), scope: publicScope(scope), edgeType: "memory_relation", predicate: row.predicate as WorkMemoryEdge["predicate"],
    sourceId: idValue(row.source_id), targetId: idValue(row.target_id), confidence: finite(row.confidence),
    evidenceChunkIds: stringArray(row.evidence_chunk_ids, false),
    ...(row.reason === null ? {} : { reason: row.reason }), metadata: metadata(row.metadata),
    createdAt: integer(row.created_at)!, ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}

function nodeParams(scope: CanonicalAuthorityScope, fingerprint: string, node: WorkMemoryGraphNode): readonly unknown[] {
  return [node.id, ...scopeParams(scope, fingerprint), node.nodeType, node.recordId, node.label,
    node.nodeType === "evidence" ? node.evidenceKind : null,
    node.nodeType === "memory" ? node.semanticType ?? null : null,
    node.nodeType === "memory" ? node.lifecycleStatus : null,
    node.nodeType === "summary" ? node.treeType : null,
    node.nodeType === "summary" ? node.level : null,
    node.nodeType === "skill_candidate" ? node.status : null,
    JSON.stringify(node.nodeType === "skill_candidate" ? node.evidenceMemoryIds : []),
    JSON.stringify(node.nodeType === "evidence" ? [] : node.evidenceChunkIds),
    JSON.stringify(node.metadata), node.createdAt, node.updatedAt ?? null];
}

function edgeParams(scope: CanonicalAuthorityScope, fingerprint: string, edge: WorkMemoryEdge): readonly unknown[] {
  return [edge.id, ...scopeParams(scope, fingerprint), edge.edgeType, edge.predicate, edge.sourceId,
    edge.targetId, edge.confidence, JSON.stringify(edge.evidenceChunkIds), edge.reason ?? null,
    JSON.stringify(edge.metadata), edge.createdAt, edge.updatedAt ?? null];
}

function decodeReturnedId(value: unknown, expected: string): void {
  const rows = decodeResult(value);
  if (rows.length !== 1) throw invalid("Postgres Work Memory Graph identity conflict");
  const row = exactRecord(rows[0], ["id"], "Postgres Work Memory Graph query result is invalid");
  if (row.id !== expected) throw invalid("Postgres Work Memory Graph query result is invalid");
}

function assertLimit(value: number | undefined): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw invalid();
  return limit;
}

interface PreparedWorkMemoryGraphBatch {
  readonly batch: WorkMemoryGraphBatch;
  readonly scope: CanonicalAuthorityScope;
  readonly fingerprint: string;
}

function prepareWorkMemoryGraphBatch(batch: WorkMemoryGraphBatch): PreparedWorkMemoryGraphBatch {
  const scope = canonicalAuthorityScope(batch.scope);
  const fingerprint = authorityScopeFingerprint(batch.scope);
  if (!Array.isArray(batch.nodes) || !Array.isArray(batch.edges) ||
      batch.nodes.length + batch.edges.length > 256) throw invalid();
  for (const node of batch.nodes) validateWorkMemoryNode(node, batch.scope);
  if (new Set(batch.nodes.map((node) => node.id)).size !== batch.nodes.length ||
      new Set(batch.edges.map((edge) => edge.id)).size !== batch.edges.length) throw invalid();
  return { batch, scope, fingerprint };
}

async function upsertPreparedWorkMemoryGraph(
  client: PostgresWorkMemoryQueryClient,
  prepared: PreparedWorkMemoryGraphBatch,
): Promise<void> {
  const { batch, scope, fingerprint } = prepared;
  for (const node of batch.nodes) {
    decodeReturnedId(await client.query(NODE_INSERT_SQL, nodeParams(scope, fingerprint, node)), node.id);
  }
  const evidenceIds = Array.from(new Set([
    ...batch.nodes.flatMap((node) => node.nodeType === "evidence" ? [] : node.evidenceChunkIds),
    ...batch.edges.flatMap((edge) => edge.evidenceChunkIds),
  ])).sort();
  const evidenceRows = decodeResult(await client.query(FIND_EVIDENCE_SQL, [
    ...scopeParams(scope, fingerprint), evidenceIds,
  ]));
  const evidenceNodes = evidenceRows.map((row) => decodeNode(row, scope, fingerprint));
  const foundEvidence = new Set(evidenceNodes.map((node) => node.recordId));
  if (foundEvidence.size !== evidenceIds.length || evidenceIds.some((id) => !foundEvidence.has(id))) {
    throw invalid("Postgres Work Memory Graph evidence endpoint is missing from the bound scope");
  }
  const endpointIds = Array.from(new Set(
    batch.edges.flatMap((edge) => [edge.sourceId, edge.targetId]),
  )).sort();
  const endpointRows = decodeResult(await client.query(FIND_ENDPOINTS_SQL, [
    ...scopeParams(scope, fingerprint), endpointIds,
  ]));
  const endpointNodes = endpointRows.map((row) => decodeNode(row, scope, fingerprint));
  const endpointMap = new Map(endpointNodes.map((node) => [node.id, node]));
  if (endpointMap.size !== endpointIds.length || endpointIds.some((id) => !endpointMap.has(id))) {
    throw invalid("Postgres Work Memory Graph edge endpoint is missing from the bound scope");
  }
  for (const edge of batch.edges) {
    validateWorkMemoryEdge(edge, batch.scope, (id) => endpointMap.get(id));
    decodeReturnedId(await client.query(EDGE_INSERT_SQL, edgeParams(scope, fingerprint, edge)), edge.id);
  }
}

/** Writes into the caller's already-open PostgreSQL transaction. */
export async function upsertPostgresWorkMemoryGraphInTransaction(
  client: PostgresWorkMemoryQueryClient,
  batch: WorkMemoryGraphBatch,
): Promise<void> {
  if (!client || typeof client.query !== "function") throw invalid();
  await upsertPreparedWorkMemoryGraph(client, prepareWorkMemoryGraphBatch(batch));
}

export class PostgresWorkMemoryGraphRepository implements WorkMemoryGraphRepository {
  readonly #pool: PostgresWorkMemoryPool;

  constructor(pool: PostgresWorkMemoryPool) {
    if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") throw invalid();
    this.#pool = pool;
  }

  async upsertWorkMemoryGraph(batch: WorkMemoryGraphBatch): Promise<void> {
    const prepared = prepareWorkMemoryGraphBatch(batch);

    const client = await this.#pool.connect();
    let failure: unknown;
    try {
      await client.query("BEGIN");
      await upsertPreparedWorkMemoryGraph(client, prepared);
      await client.query("COMMIT");
    } catch (error) {
      failure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        failure = new AggregateError(
          [error, rollbackError],
          "Work Memory Graph write and rollback both failed",
        );
      }
      throw failure;
    } finally {
      try {
        client.release();
      } catch (releaseError) {
        if (!failure) throw releaseError;
      }
    }
  }

  async getWorkMemoryNode(id: string, rawScope: MemoryScope): Promise<WorkMemoryGraphNode | undefined> {
    const scope = canonicalAuthorityScope(rawScope);
    const fingerprint = authorityScopeFingerprint(rawScope);
    const rows = decodeResult(await this.#pool.query(GET_NODE_SQL, [...scopeParams(scope, fingerprint), idValue(id)]));
    if (rows.length > 1) throw invalid("Postgres Work Memory Graph query returned duplicate nodes");
    return rows[0] ? decodeNode(rows[0], scope, fingerprint) : undefined;
  }

  async getWorkMemoryEdge(id: string, rawScope: MemoryScope): Promise<WorkMemoryEdge | undefined> {
    const scope = canonicalAuthorityScope(rawScope);
    const fingerprint = authorityScopeFingerprint(rawScope);
    const rows = decodeResult(await this.#pool.query(GET_EDGE_SQL, [...scopeParams(scope, fingerprint), idValue(id)]));
    if (rows.length > 1) throw invalid("Postgres Work Memory Graph query returned duplicate edges");
    return rows[0] ? decodeEdge(rows[0], scope, fingerprint) : undefined;
  }

  async findWorkMemoryNodes(filter: WorkMemoryNodeFilter): Promise<WorkMemoryGraphNode[]> {
    const scope = canonicalAuthorityScope(filter.scope);
    const fingerprint = authorityScopeFingerprint(filter.scope);
    if (filter.nodeType !== undefined && !NODE_TYPES.has(filter.nodeType)) throw invalid();
    if (filter.recordId !== undefined) idValue(filter.recordId);
    if (filter.query !== undefined && (filter.query.length > 1000 || /\p{Cc}/u.test(filter.query))) throw invalid();
    const rows = decodeResult(await this.#pool.query(FIND_NODES_SQL, [
      ...scopeParams(scope, fingerprint), filter.nodeType ?? null, filter.recordId ?? null,
      filter.query ?? null, assertLimit(filter.limit),
    ]));
    return rows.map((row) => decodeNode(row, scope, fingerprint));
  }

  async findWorkMemoryEdges(filter: WorkMemoryEdgeFilter): Promise<WorkMemoryEdge[]> {
    const scope = canonicalAuthorityScope(filter.scope);
    const fingerprint = authorityScopeFingerprint(filter.scope);
    if (filter.nodeId !== undefined) idValue(filter.nodeId);
    if (filter.predicate !== undefined && !EDGE_PREDICATES.has(filter.predicate)) throw invalid();
    const rows = decodeResult(await this.#pool.query(FIND_EDGES_SQL, [
      ...scopeParams(scope, fingerprint), filter.nodeId ?? null, filter.predicate ?? null,
      assertLimit(filter.limit),
    ]));
    return rows.map((row) => decodeEdge(row, scope, fingerprint));
  }
}
