import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { EntityFilter, InMemoryGraphRepository, RelationFilter } from "./repository.js";
import { ENTITY_TYPES, RELATION_PREDICATES } from "./schema.js";
import type {
  EntityStatus,
  EntityType,
  GraphEntityRecord,
  GraphRelationRecord,
  RelationPredicate,
  RelationStatus,
} from "./types.js";

export interface PostgresCanonicalGraphReadQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** The caller owns the query/transaction client and its entire lifecycle. */
export interface PostgresCanonicalGraphReadQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCanonicalGraphReadQueryResult<Row>>;
}

const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATION_PREDICATE_SET = new Set<string>(RELATION_PREDICATES);
const ENTITY_STATUSES = new Set<EntityStatus>(["active", "archived", "merged"]);
const RELATION_STATUSES = new Set<RelationStatus>(["active", "weak", "contradicted", "archived"]);
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SAFE_QUERY = /^[^\p{Cc}]{0,1000}$/u;

const SCOPE_SELECT = `scope_fingerprint, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, session_id`;
const SCOPE_WHERE = `scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10`;
const ENTITY_COLUMNS = `id, ${SCOPE_SELECT}, canonical_name, display_name, entity_type,
  aliases, mention_count, mention_count_30d, distinct_source_count, last_seen_at,
  hotness, graph_centrality, query_hits_30d, status, merged_into, created_at,
  updated_at, metadata`;
const RELATION_COLUMNS = `id, ${SCOPE_SELECT}, subject_id, predicate, object_id,
  confidence, evidence_chunk_ids, evidence_count, first_seen_at, last_seen_at,
  status, source_kinds, metadata`;

const GET_ENTITY_SQL = `SELECT ${ENTITY_COLUMNS}
FROM mengshu_graph_entities
WHERE ${SCOPE_WHERE} AND id = $11
LIMIT 2`;
const FIND_ENTITIES_SQL = `SELECT ${ENTITY_COLUMNS}
FROM mengshu_graph_entities
WHERE ${SCOPE_WHERE}
  AND ($11::text IS NULL OR entity_type = $11)
  AND (
    $12::text IS NULL
    OR lower(canonical_name) LIKE '%' || lower($12) || '%'
    OR lower(display_name) LIKE '%' || lower($12) || '%'
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(aliases) AS alias(value)
      WHERE lower(alias.value) LIKE '%' || lower($12) || '%'
    )
  )
ORDER BY hotness DESC, mention_count DESC, id
LIMIT $13`;
const GET_RELATION_SQL = `SELECT ${RELATION_COLUMNS}
FROM mengshu_graph_relations
WHERE ${SCOPE_WHERE} AND id = $11
LIMIT 2`;
const FIND_RELATIONS_SQL = `SELECT ${RELATION_COLUMNS}
FROM mengshu_graph_relations
WHERE ${SCOPE_WHERE}
  AND ($11::text IS NULL OR subject_id = $11 OR object_id = $11)
  AND ($12::text IS NULL OR predicate = $12)
ORDER BY confidence DESC, evidence_count DESC, id
LIMIT $13`;

const SCOPE_KEYS = [
  "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
  "namespace", "visibility", "workspace_id", "session_id",
] as const;
const ENTITY_KEYS = [
  "id", ...SCOPE_KEYS, "canonical_name", "display_name", "entity_type", "aliases",
  "mention_count", "mention_count_30d", "distinct_source_count", "last_seen_at",
  "hotness", "graph_centrality", "query_hits_30d", "status", "merged_into",
  "created_at", "updated_at", "metadata",
] as const;
const RELATION_KEYS = [
  "id", ...SCOPE_KEYS, "subject_id", "predicate", "object_id", "confidence",
  "evidence_chunk_ids", "evidence_count", "first_seen_at", "last_seen_at", "status",
  "source_kinds", "metadata",
] as const;

function invalid(message = "Canonical graph row is invalid"): Error {
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

function text(value: unknown, max: number, nonBlank = true): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max ||
      (nonBlank && value.trim().length === 0)) throw invalid();
  return value;
}

function integer(value: unknown, min = 0): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) {
    parsed = Number(value);
  } else {
    throw invalid();
  }
  if (!Number.isSafeInteger(parsed) || parsed < min) throw invalid();
  return parsed;
}

function optionalInteger(value: unknown): number | undefined {
  return value === null ? undefined : integer(value);
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid();
  return value;
}

function optionalFinite(value: unknown): number | undefined {
  return value === null ? undefined : finite(value);
}

function stringArray(value: unknown, options: { readonly nonEmpty?: boolean; readonly max?: number } = {}): string[] {
  const max = options.max ?? 256;
  if (!Array.isArray(value) || value.length > 10_000 || (options.nonEmpty && value.length === 0) ||
      value.some((item) => typeof item !== "string" || item.length < 1 || item.length > max ||
        item.trim().length === 0 || /\p{Cc}/u.test(item))) throw invalid();
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

function decodeEntity(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): GraphEntityRecord {
  const row = exactRow(value, ENTITY_KEYS);
  assertRowScope(row, scope, fingerprint);
  if (typeof row.entity_type !== "string" || !ENTITY_TYPE_SET.has(row.entity_type) ||
      typeof row.status !== "string" || !ENTITY_STATUSES.has(row.status as EntityStatus)) throw invalid();
  const id = safeId(row.id);
  const mergedInto = row.merged_into === null ? undefined : safeId(row.merged_into);
  const createdAt = integer(row.created_at);
  const updatedAt = integer(row.updated_at, createdAt);
  const lastSeenAt = optionalInteger(row.last_seen_at);
  const graphCentrality = optionalFinite(row.graph_centrality);
  return Object.freeze({
    id,
    scope,
    canonicalName: text(row.canonical_name, 1_000),
    displayName: text(row.display_name, 1_000),
    type: row.entity_type as EntityType,
    aliases: stringArray(row.aliases, { max: 1_000 }),
    mentionCount: integer(row.mention_count),
    mentionCount30d: integer(row.mention_count_30d),
    distinctSourceCount: integer(row.distinct_source_count),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    hotness: finite(row.hotness),
    ...(graphCentrality === undefined ? {} : { graphCentrality }),
    queryHits30d: integer(row.query_hits_30d),
    status: row.status as EntityStatus,
    ...(mergedInto === undefined ? {} : { mergedInto }),
    createdAt,
    updatedAt,
    metadata: metadata(row.metadata),
  });
}

function decodeRelation(value: unknown, scope: CanonicalAuthorityScope, fingerprint: string): GraphRelationRecord {
  const row = exactRow(value, RELATION_KEYS);
  assertRowScope(row, scope, fingerprint);
  if (typeof row.predicate !== "string" || !RELATION_PREDICATE_SET.has(row.predicate) ||
      typeof row.status !== "string" || !RELATION_STATUSES.has(row.status as RelationStatus)) throw invalid();
  const subjectId = safeId(row.subject_id);
  const objectId = safeId(row.object_id);
  if (subjectId === objectId) throw invalid();
  const evidenceChunkIds = stringArray(row.evidence_chunk_ids, { nonEmpty: true });
  const evidenceCount = integer(row.evidence_count, 1);
  const firstSeenAt = integer(row.first_seen_at);
  const lastSeenAt = integer(row.last_seen_at, firstSeenAt);
  if (evidenceCount !== evidenceChunkIds.length) throw invalid();
  return Object.freeze({
    id: safeId(row.id),
    scope,
    subjectId,
    predicate: row.predicate as RelationPredicate,
    objectId,
    confidence: finite(row.confidence, Number.EPSILON, 1),
    evidenceChunkIds,
    evidenceCount,
    firstSeenAt,
    lastSeenAt,
    status: row.status as RelationStatus,
    sourceKinds: stringArray(row.source_kinds, { nonEmpty: true }),
    metadata: metadata(row.metadata),
  });
}

function singleton<T>(rows: readonly Record<string, unknown>[], decode: (row: unknown) => T): T | undefined {
  if (rows.length > 1) throw invalid("Canonical graph query returned duplicate rows");
  return rows[0] === undefined ? undefined : decode(rows[0]);
}

/** Read-only, scope-bound adapter over the v9 canonical graph tables. */
export class PostgresCanonicalGraphReadRepository implements Pick<
  InMemoryGraphRepository,
  "getEntity" | "findEntities" | "getRelation" | "findRelations"
> {
  readonly #client: PostgresCanonicalGraphReadQueryClient;
  readonly #scope: CanonicalAuthorityScope;
  readonly #fingerprint: string;

  constructor(client: PostgresCanonicalGraphReadQueryClient, rawScope: MemoryScope) {
    if (!client || typeof client.query !== "function") throw invalid("Canonical graph query client is invalid");
    this.#client = client;
    this.#scope = canonicalAuthorityScope(rawScope);
    // Keep omitted optional dimensions omitted while deriving the fingerprint;
    // the canonical SQL snapshot uses empty strings only as persisted values.
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
      throw invalid("Canonical graph read scope does not match bound scope");
    }
    if (!sameScope(requested, this.#scope)) {
      throw invalid("Canonical graph read scope does not match bound scope");
    }
  }

  async getEntity(id: string, rawScope?: MemoryScope): Promise<GraphEntityRecord | undefined> {
    if (rawScope !== undefined) this.#assertScope(rawScope);
    const result = await this.#client.query(GET_ENTITY_SQL, [...this.#scopeParams(), safeId(id)]);
    return singleton(result.rows, (row) => decodeEntity(row, this.#scope, this.#fingerprint));
  }

  async findEntities(filter: EntityFilter): Promise<GraphEntityRecord[]> {
    this.#assertScope(filter.scope);
    if (filter.type !== undefined && !ENTITY_TYPE_SET.has(filter.type)) throw invalid("Canonical graph filter is invalid");
    if (filter.query !== undefined && !SAFE_QUERY.test(filter.query)) throw invalid("Canonical graph filter is invalid");
    const limit = filter.limit === undefined ? null : integer(filter.limit);
    if (limit !== null && limit > 10_000) throw invalid("Canonical graph filter is invalid");
    const result = await this.#client.query(FIND_ENTITIES_SQL, [
      ...this.#scopeParams(), filter.type ?? null, filter.query ?? null, limit,
    ]);
    return result.rows.map((row) => decodeEntity(row, this.#scope, this.#fingerprint));
  }

  async getRelation(id: string, rawScope?: MemoryScope): Promise<GraphRelationRecord | undefined> {
    if (rawScope !== undefined) this.#assertScope(rawScope);
    const result = await this.#client.query(GET_RELATION_SQL, [...this.#scopeParams(), safeId(id)]);
    return singleton(result.rows, (row) => decodeRelation(row, this.#scope, this.#fingerprint));
  }

  async findRelations(filter: RelationFilter): Promise<GraphRelationRecord[]> {
    this.#assertScope(filter.scope);
    if (filter.entityId !== undefined) safeId(filter.entityId);
    if (filter.predicate !== undefined && !RELATION_PREDICATE_SET.has(filter.predicate)) {
      throw invalid("Canonical graph filter is invalid");
    }
    const limit = filter.limit === undefined ? null : integer(filter.limit);
    if (limit !== null && limit > 10_000) throw invalid("Canonical graph filter is invalid");
    const result = await this.#client.query(FIND_RELATIONS_SQL, [
      ...this.#scopeParams(), filter.entityId ?? null, filter.predicate ?? null, limit,
    ]);
    return result.rows.map((row) => decodeRelation(row, this.#scope, this.#fingerprint));
  }
}
