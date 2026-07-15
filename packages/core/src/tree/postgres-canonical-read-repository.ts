import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  MemoryTreeType,
  SummaryNodeStatus,
  TreeBuffer,
  TreeLeaf,
  TreeRepository,
  TreeSummaryNode,
} from "./types.js";

export interface PostgresCanonicalTreeReadQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** The caller owns the query/transaction client and its entire lifecycle. */
export interface PostgresCanonicalTreeReadQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCanonicalTreeReadQueryResult<Row>>;
}

const TREE_TYPES = new Set<MemoryTreeType>(["source", "topic", "global"]);
const SUMMARY_STATUSES = new Set<SummaryNodeStatus>(["open", "sealed", "stale", "archived"]);
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;

const SCOPE_SELECT = `scope_fingerprint, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, session_id`;
const SCOPE_WHERE = `scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10`;

const LEAF_COLUMNS = `id, ${SCOPE_SELECT}, chunk_id, source_id, entity_ids,
  importance, event_at, created_at, text, token_count`;
const BUFFER_COLUMNS = `id, ${SCOPE_SELECT}, tree_type, tree_key, level, leaf_ids,
  child_node_ids, token_count, opened_at, updated_at, seal_after_at`;
const SUMMARY_COLUMNS = `id, ${SCOPE_SELECT}, tree_type, tree_key, level, title,
  summary, child_node_ids, leaf_ids, evidence_chunk_ids, entity_ids, relation_ids,
  token_count, start_at, end_at, status, created_at, sealed_at, metadata`;

const GET_LEAF_SQL = `SELECT ${LEAF_COLUMNS}
FROM mengshu_tree_leaves
WHERE ${SCOPE_WHERE} AND id = $11
LIMIT 2`;
const LIST_LEAVES_SQL = `SELECT ${LEAF_COLUMNS}
FROM mengshu_tree_leaves
WHERE ${SCOPE_WHERE} AND id = ANY($11::text[])
ORDER BY id`;
const GET_BUFFER_SQL = `SELECT ${BUFFER_COLUMNS}
FROM mengshu_tree_buffers
WHERE ${SCOPE_WHERE} AND id = $11
LIMIT 2`;
const GET_SUMMARY_SQL = `SELECT ${SUMMARY_COLUMNS}
FROM mengshu_tree_summary_nodes
WHERE ${SCOPE_WHERE} AND id = $11
LIMIT 2`;
const LIST_SUMMARIES_SQL = `SELECT ${SUMMARY_COLUMNS}
FROM mengshu_tree_summary_nodes
WHERE ${SCOPE_WHERE}
  AND ($11::text IS NULL OR tree_type = $11)
  AND ($12::text IS NULL OR tree_key = $12)
ORDER BY sealed_at DESC NULLS LAST, created_at DESC, id`;
const GET_PARENT_SQL = `SELECT ${SUMMARY_COLUMNS}
FROM mengshu_tree_summary_nodes
WHERE ${SCOPE_WHERE} AND child_node_ids @> $11::jsonb
ORDER BY sealed_at DESC NULLS LAST, created_at DESC, id
LIMIT 2`;

const SCOPE_KEYS = [
  "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
  "namespace", "visibility", "workspace_id", "session_id",
] as const;
const LEAF_KEYS = [
  "id", ...SCOPE_KEYS, "chunk_id", "source_id", "entity_ids", "importance",
  "event_at", "created_at", "text", "token_count",
] as const;
const BUFFER_KEYS = [
  "id", ...SCOPE_KEYS, "tree_type", "tree_key", "level", "leaf_ids",
  "child_node_ids", "token_count", "opened_at", "updated_at", "seal_after_at",
] as const;
const SUMMARY_KEYS = [
  "id", ...SCOPE_KEYS, "tree_type", "tree_key", "level", "title", "summary",
  "child_node_ids", "leaf_ids", "evidence_chunk_ids", "entity_ids", "relation_ids",
  "token_count", "start_at", "end_at", "status", "created_at", "sealed_at", "metadata",
] as const;

function invalid(message = "Canonical tree row is invalid"): Error {
  return new Error(message);
}

function exactRow(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) {
    throw invalid();
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
  }
  return value as Record<string, unknown>;
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) throw invalid();
  return value;
}

function text(value: unknown, max: number, nonBlank = false): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      (nonBlank && value.trim().length === 0)) throw invalid();
  return value;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw invalid();
  }
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalid();
  return parsed;
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid();
  return value;
}

function optionalInteger(value: unknown, min = 0): number | undefined {
  return value === null ? undefined : integer(value, min);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 10_000 ||
      value.some((item) => typeof item !== "string" || !SAFE_ID.test(item))) throw invalid();
  return Object.freeze([...value]) as unknown as string[];
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
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key !== "string" ||
          (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
        throw invalid();
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
        result.push(cloneJson(descriptor.value, ancestors));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      result[key] = cloneJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function metadata(value: unknown): Record<string, unknown> {
  const cloned = cloneJson(value);
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) throw invalid();
  return cloned as Record<string, unknown>;
}

function sameScope(left: CanonicalAuthorityScope, right: CanonicalAuthorityScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility && left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId;
}

function assertRowScope(row: Record<string, unknown>, scope: CanonicalAuthorityScope, fingerprint: string): void {
  if (row.scope_fingerprint !== fingerprint || row.tenant_id !== scope.tenantId ||
      row.user_id !== scope.userId || row.app_id !== scope.appId ||
      row.project_id !== scope.projectId || row.agent_id !== scope.agentId ||
      row.namespace !== scope.namespace || row.visibility !== scope.visibility ||
      row.workspace_id !== scope.workspaceId || row.session_id !== scope.sessionId) throw invalid();
}

function decodeLeaf(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): TreeLeaf {
  const row = exactRow(value, LEAF_KEYS);
  assertRowScope(row, scope, fingerprint);
  return Object.freeze({
    id: safeId(row.id),
    scope,
    chunkId: safeId(row.chunk_id),
    sourceId: safeId(row.source_id),
    entityIds: stringArray(row.entity_ids),
    importance: finite(row.importance, 0, 1),
    eventAt: integer(row.event_at),
    createdAt: integer(row.created_at),
    text: text(row.text, 100_000, true),
    tokenCount: integer(row.token_count, 1),
  });
}

function decodeBuffer(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): TreeBuffer {
  const row = exactRow(value, BUFFER_KEYS);
  assertRowScope(row, scope, fingerprint);
  if (typeof row.tree_type !== "string" || !TREE_TYPES.has(row.tree_type as MemoryTreeType)) throw invalid();
  const openedAt = integer(row.opened_at);
  const updatedAt = integer(row.updated_at, openedAt);
  const sealAfterAt = optionalInteger(row.seal_after_at, openedAt);
  return Object.freeze({
    id: safeId(row.id),
    scope,
    treeType: row.tree_type as MemoryTreeType,
    treeKey: safeId(row.tree_key),
    level: integer(row.level, 0, 3),
    leafIds: stringArray(row.leaf_ids),
    childNodeIds: stringArray(row.child_node_ids),
    tokenCount: integer(row.token_count),
    openedAt,
    updatedAt,
    ...(sealAfterAt === undefined ? {} : { sealAfterAt }),
  });
}

function decodeSummary(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): TreeSummaryNode {
  const row = exactRow(value, SUMMARY_KEYS);
  assertRowScope(row, scope, fingerprint);
  if (typeof row.tree_type !== "string" || !TREE_TYPES.has(row.tree_type as MemoryTreeType) ||
      typeof row.status !== "string" || !SUMMARY_STATUSES.has(row.status as SummaryNodeStatus)) throw invalid();
  const createdAt = integer(row.created_at);
  const sealedAt = optionalInteger(row.sealed_at, createdAt);
  if (row.status === "sealed" && sealedAt === undefined) throw invalid();
  const startAt = integer(row.start_at);
  const endAt = integer(row.end_at, startAt);
  return Object.freeze({
    id: safeId(row.id),
    scope,
    treeType: row.tree_type as MemoryTreeType,
    treeKey: safeId(row.tree_key),
    level: integer(row.level, 1, 3),
    title: text(row.title, 1_000),
    summary: text(row.summary, 100_000),
    childNodeIds: stringArray(row.child_node_ids),
    leafIds: stringArray(row.leaf_ids),
    evidenceChunkIds: stringArray(row.evidence_chunk_ids),
    entityIds: stringArray(row.entity_ids),
    relationIds: stringArray(row.relation_ids),
    tokenCount: integer(row.token_count),
    timeRange: Object.freeze({ startAt, endAt }),
    status: row.status as SummaryNodeStatus,
    createdAt,
    ...(sealedAt === undefined ? {} : { sealedAt }),
    metadata: metadata(row.metadata),
  });
}

function singleton<T>(rows: readonly Record<string, unknown>[], decode: (row: unknown) => T): T | undefined {
  if (rows.length > 1) throw invalid("Canonical tree query returned duplicate rows");
  return rows[0] === undefined ? undefined : decode(rows[0]);
}

/**
 * Read-only adapter over the v9 canonical tree tables.
 *
 * It is deliberately scope-bound because legacy singleton read signatures do not
 * accept a scope. Every query therefore carries both the fingerprint and full 9D.
 */
export class PostgresCanonicalTreeReadRepository implements Pick<
  TreeRepository,
  "getLeaf" | "listLeaves" | "getBuffer" | "getSummary" | "listSummaries" | "getParent"
> {
  readonly #client: PostgresCanonicalTreeReadQueryClient;
  readonly #scope: CanonicalAuthorityScope;
  readonly #fingerprint: string;

  constructor(client: PostgresCanonicalTreeReadQueryClient, rawScope: MemoryScope) {
    if (!client || typeof client.query !== "function") throw invalid("Canonical tree query client is invalid");
    this.#client = client;
    this.#scope = canonicalAuthorityScope(rawScope);
    // Fingerprint the caller shape, where workspace/session may be omitted.
    // The canonical snapshot represents omission as "" for SQL binding; feeding
    // that snapshot back through canonicalAuthorityScope would reject the empty
    // optional dimensions as explicitly supplied invalid identifiers.
    this.#fingerprint = authorityScopeFingerprint(rawScope);
  }

  #scopeParams(): readonly string[] {
    return [
      this.#fingerprint,
      this.#scope.tenantId,
      this.#scope.userId,
      this.#scope.appId,
      this.#scope.projectId,
      this.#scope.agentId,
      this.#scope.namespace,
      this.#scope.visibility,
      this.#scope.workspaceId,
      this.#scope.sessionId,
    ];
  }

  #assertScope(rawScope: MemoryScope): void {
    let requested: CanonicalAuthorityScope;
    try {
      requested = canonicalAuthorityScope(rawScope);
    } catch {
      throw invalid("Canonical tree read scope does not match bound scope");
    }
    if (!sameScope(requested, this.#scope)) {
      throw invalid("Canonical tree read scope does not match bound scope");
    }
  }

  async getLeaf(id: string): Promise<TreeLeaf | undefined> {
    const result = await this.#client.query(GET_LEAF_SQL, [...this.#scopeParams(), safeId(id)]);
    return singleton(result.rows, (row) => decodeLeaf(row, this.#scope, this.#fingerprint));
  }

  async listLeaves(ids: string[]): Promise<TreeLeaf[]> {
    if (!Array.isArray(ids) || ids.length > 10_000) throw invalid("Canonical tree leaf ids are invalid");
    if (ids.length === 0) return [];
    const safeIds = ids.map(safeId);
    const result = await this.#client.query(LIST_LEAVES_SQL, [...this.#scopeParams(), safeIds]);
    const byId = new Map<string, TreeLeaf>();
    for (const row of result.rows) {
      const leaf = decodeLeaf(row, this.#scope, this.#fingerprint);
      if (!safeIds.includes(leaf.id) || byId.has(leaf.id)) throw invalid("Canonical tree query returned invalid leaf rows");
      byId.set(leaf.id, leaf);
    }
    return safeIds.map((id) => byId.get(id)).filter((leaf): leaf is TreeLeaf => leaf !== undefined);
  }

  async getBuffer(id: string): Promise<TreeBuffer | undefined> {
    const result = await this.#client.query(GET_BUFFER_SQL, [...this.#scopeParams(), safeId(id)]);
    return singleton(result.rows, (row) => decodeBuffer(row, this.#scope, this.#fingerprint));
  }

  async getSummary(id: string): Promise<TreeSummaryNode | undefined> {
    const result = await this.#client.query(GET_SUMMARY_SQL, [...this.#scopeParams(), safeId(id)]);
    return singleton(result.rows, (row) => decodeSummary(row, this.#scope, this.#fingerprint));
  }

  async listSummaries(filter: {
    scope: MemoryScope;
    treeType?: MemoryTreeType;
    treeKey?: string;
  }): Promise<TreeSummaryNode[]> {
    this.#assertScope(filter.scope);
    if (filter.treeType !== undefined && !TREE_TYPES.has(filter.treeType)) throw invalid("Canonical tree filter is invalid");
    const treeKey = filter.treeKey === undefined ? null : safeId(filter.treeKey);
    const result = await this.#client.query(LIST_SUMMARIES_SQL, [
      ...this.#scopeParams(), filter.treeType ?? null, treeKey,
    ]);
    return result.rows.map((row) => decodeSummary(row, this.#scope, this.#fingerprint));
  }

  async getParent(nodeId: string): Promise<TreeSummaryNode | undefined> {
    const result = await this.#client.query(GET_PARENT_SQL, [
      ...this.#scopeParams(), JSON.stringify([safeId(nodeId)]),
    ]);
    return singleton(result.rows, (row) => decodeSummary(row, this.#scope, this.#fingerprint));
  }
}
