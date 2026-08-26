import { types as nodeUtilTypes } from "node:util";

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { ENTITY_TYPES, RELATION_PREDICATES } from "./schema.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

export const MENGSHU_GRAPH_ENTITY_RELATION = "mengshu_graph_entities";
export const MENGSHU_GRAPH_RELATION_RELATION = "mengshu_graph_relations";
export const MENGSHU_GRAPH_ENTITY_CONFLICT_COLUMNS = Object.freeze([
  "scope_fingerprint", "id",
] as const);
export const MENGSHU_GRAPH_RELATION_CONFLICT_COLUMNS = MENGSHU_GRAPH_ENTITY_CONFLICT_COLUMNS;

export interface PostgresGraphQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** The caller owns BEGIN/COMMIT/ROLLBACK and must supply one transaction-bound client. */
export interface PostgresGraphQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresGraphQueryResult<Row>>;
}

export interface PostgresGraphPersistResult extends Record<string, unknown> {
  readonly createdEntities: number;
  readonly createdRelations: number;
  /** All accepted input ids in stable input order, including conflict updates. */
  readonly entityIds: readonly string[];
  /** All accepted input ids in stable input order, including conflict updates. */
  readonly relationIds: readonly string[];
}

export interface PostgresGraphSnapshot {
  readonly scope: CanonicalAuthorityScope;
  readonly scopeFingerprint: string;
  readonly entities: readonly Readonly<GraphEntityRecord>[];
  readonly relations: readonly Readonly<GraphRelationRecord>[];
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const UNSAFE_STRING = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const ENTITY_TYPE_SET = new Set<string>(ENTITY_TYPES);
const RELATION_PREDICATE_SET = new Set<string>(RELATION_PREDICATES);
const ENTITY_STATUS_SET = new Set(["active", "archived", "merged"]);
const RELATION_STATUS_SET = new Set(["active", "weak", "contradicted", "archived"]);
const ENTITY_REQUIRED = Object.freeze([
  "id", "scope", "canonicalName", "displayName", "type", "aliases", "mentionCount",
  "mentionCount30d", "distinctSourceCount", "hotness", "queryHits30d", "status",
  "createdAt", "updatedAt", "metadata",
] as const);
const ENTITY_OPTIONAL = Object.freeze(["lastSeenAt", "graphCentrality", "mergedInto"] as const);
const RELATION_REQUIRED = Object.freeze([
  "id", "scope", "subjectId", "predicate", "objectId", "confidence",
  "evidenceChunkIds", "evidenceCount", "firstSeenAt", "lastSeenAt", "status",
  "sourceKinds", "metadata",
] as const);

const ENTITY_INSERT_SQL = `INSERT INTO ${MENGSHU_GRAPH_ENTITY_RELATION} (
  id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, canonical_name, display_name, entity_type,
  aliases, mention_count, mention_count_30d, distinct_source_count, last_seen_at,
  hotness, graph_centrality, query_hits_30d, status, merged_into, created_at,
  updated_at, metadata
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27::jsonb
)
ON CONFLICT (scope_fingerprint, id) DO NOTHING
RETURNING id`;

const ENTITY_UPDATE_SQL = `UPDATE ${MENGSHU_GRAPH_ENTITY_RELATION} SET
  canonical_name = $12,
  display_name = $13,
  entity_type = $14,
  aliases = (
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(aliases || $15::jsonb) AS merged(value)
    ) AS unique_aliases
  ),
  mention_count = mention_count + $16,
  mention_count_30d = mention_count_30d + $17,
  distinct_source_count = GREATEST(distinct_source_count, $18),
  last_seen_at = CASE
    WHEN last_seen_at IS NULL THEN $19::bigint
    WHEN $19::bigint IS NULL THEN last_seen_at
    ELSE GREATEST(last_seen_at, $19::bigint)
  END,
  hotness = GREATEST(hotness, $20),
  graph_centrality = COALESCE($21, graph_centrality),
  query_hits_30d = query_hits_30d + $22,
  status = $23,
  merged_into = $24,
  created_at = LEAST(created_at, $25),
  updated_at = GREATEST(updated_at, $26),
  metadata = metadata || $27::jsonb
WHERE scope_fingerprint = $2
  AND tenant_id = $3 AND user_id = $4 AND app_id = $5 AND project_id = $6
  AND agent_id = $7 AND namespace = $8 AND visibility = $9
  AND workspace_id = $10 AND session_id = $11 AND id = $1
RETURNING id`;

const ENTITY_ENDPOINTS_SQL = `SELECT id
FROM ${MENGSHU_GRAPH_ENTITY_RELATION}
WHERE scope_fingerprint = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10
  AND id = ANY($11::text[])
ORDER BY id`;

const RELATION_INSERT_SQL = `INSERT INTO ${MENGSHU_GRAPH_RELATION_RELATION} (
  id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
  visibility, workspace_id, session_id, subject_id, predicate, object_id, confidence,
  evidence_chunk_ids, evidence_count, first_seen_at, last_seen_at, status,
  source_kinds, metadata
) VALUES (
  $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
  $16::jsonb, $17, $18, $19, $20, $21::jsonb, $22::jsonb
)
ON CONFLICT (scope_fingerprint, id) DO NOTHING
RETURNING id`;

const RELATION_UPDATE_SQL = `UPDATE ${MENGSHU_GRAPH_RELATION_RELATION} SET
  subject_id = $12,
  predicate = $13,
  object_id = $14,
  confidence = GREATEST(confidence, $15),
  evidence_chunk_ids = (
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(evidence_chunk_ids || $16::jsonb) AS merged(value)
    ) AS unique_evidence
  ),
  evidence_count = (
    SELECT COUNT(*)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(evidence_chunk_ids || $16::jsonb) AS merged(value)
    ) AS unique_evidence
  ),
  first_seen_at = LEAST(first_seen_at, $18),
  last_seen_at = GREATEST(last_seen_at, $19),
  status = $20,
  source_kinds = (
    SELECT COALESCE(jsonb_agg(value ORDER BY value), '[]'::jsonb)
    FROM (
      SELECT DISTINCT value
      FROM jsonb_array_elements_text(source_kinds || $21::jsonb) AS merged(value)
    ) AS unique_sources
  ),
  metadata = metadata || $22::jsonb
WHERE scope_fingerprint = $2
  AND tenant_id = $3 AND user_id = $4 AND app_id = $5 AND project_id = $6
  AND agent_id = $7 AND namespace = $8 AND visibility = $9
  AND workspace_id = $10 AND session_id = $11 AND id = $1
  AND $17::bigint = jsonb_array_length($16::jsonb)
RETURNING id`;

function invalid(label = "Postgres graph input is invalid"): Error {
  return new Error(label);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && !UNPAIRED_SURROGATE.test(value);
}

function safeText(value: unknown, max = Number.POSITIVE_INFINITY): value is string {
  return typeof value === "string" && value.length <= max &&
    !UNSAFE_STRING.test(value) && !UNPAIRED_SURROGATE.test(value);
}

function cloneStrictJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (!safeText(value)) throw invalid();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid();
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    throw invalid();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw invalid();
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (!lengthDescriptor || !("value" in lengthDescriptor) ||
          !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) throw invalid();
      const length = Number(lengthDescriptor.value);
      const keys = Reflect.ownKeys(value);
      if (keys.length !== length + 1 || !keys.includes("length") ||
          keys.some((key) => typeof key !== "string" ||
            (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
        throw invalid();
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
        result.push(cloneStrictJson(descriptor.value, ancestors));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalid();
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor" ||
          !safeText(key)) throw invalid();
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
      result[key] = cloneStrictJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  errorLabel?: string,
): Readonly<Record<string, unknown>> {
  let record: Record<string, unknown>;
  try {
    record = cloneStrictJson(value) as Record<string, unknown>;
  } catch {
    throw invalid(errorLabel);
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw invalid(errorLabel);
  const keys = Reflect.ownKeys(record);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      required.some((key) => !keys.includes(key))) throw invalid(errorLabel);
  return record;
}

function exactDenseArray(value: unknown): readonly unknown[] {
  const cloned = cloneStrictJson(value);
  if (!Array.isArray(cloned)) throw invalid();
  return cloned;
}

function canonicalScope(value: unknown): CanonicalAuthorityScope {
  const scope = exactRecord(
    value,
    ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"],
    ["workspaceId", "sessionId"],
  ) as unknown as MemoryScope;
  try {
    return canonicalAuthorityScope(scope);
  } catch {
    throw invalid();
  }
}

function sameScope(left: CanonicalAuthorityScope, right: CanonicalAuthorityScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility && left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId;
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid();
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalid();
  return Number(value);
}

function stringList(value: unknown, options: { readonly nonEmpty?: boolean; readonly maxItem?: number } = {}): readonly string[] {
  const cloned = exactDenseArray(value);
  if ((options.nonEmpty && cloned.length === 0) || cloned.length > 10_000 ||
      cloned.some((item) => !safeText(item, options.maxItem ?? 256) || item.trim().length === 0) ||
      new Set(cloned).size !== cloned.length) throw invalid();
  return Object.freeze(cloned as string[]);
}

function snapshotEntity(value: unknown, expectedScope: CanonicalAuthorityScope): Readonly<GraphEntityRecord> {
  const record = exactRecord(value, ENTITY_REQUIRED, ENTITY_OPTIONAL);
  const recordScope = canonicalScope(record.scope);
  const aliases = stringList(record.aliases, { maxItem: 200 });
  const metadata = cloneStrictJson(record.metadata);
  if (!safeId(record.id) || !sameScope(recordScope, expectedScope) ||
      !safeText(record.canonicalName, 200) || record.canonicalName.trim().length === 0 ||
      !safeText(record.displayName, 200) || record.displayName.trim().length === 0 ||
      typeof record.type !== "string" || !ENTITY_TYPE_SET.has(record.type) ||
      typeof record.status !== "string" || !ENTITY_STATUS_SET.has(record.status) ||
      (record.mergedInto !== undefined && !safeId(record.mergedInto)) ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw invalid();
  const createdAt = integer(record.createdAt);
  const updatedAt = integer(record.updatedAt);
  const lastSeenAt = record.lastSeenAt === undefined ? undefined : integer(record.lastSeenAt);
  if (updatedAt < createdAt) throw invalid();
  return Object.freeze({
    id: record.id,
    scope: expectedScope,
    canonicalName: record.canonicalName,
    displayName: record.displayName,
    type: record.type,
    aliases,
    mentionCount: integer(record.mentionCount),
    mentionCount30d: integer(record.mentionCount30d),
    distinctSourceCount: integer(record.distinctSourceCount),
    ...(lastSeenAt === undefined ? {} : { lastSeenAt }),
    hotness: finite(record.hotness),
    ...(record.graphCentrality === undefined ? {} : { graphCentrality: finite(record.graphCentrality) }),
    queryHits30d: integer(record.queryHits30d),
    status: record.status,
    ...(record.mergedInto === undefined ? {} : { mergedInto: record.mergedInto }),
    createdAt,
    updatedAt,
    metadata: metadata as Record<string, unknown>,
  } as GraphEntityRecord);
}

function snapshotRelation(value: unknown, expectedScope: CanonicalAuthorityScope): Readonly<GraphRelationRecord> {
  const record = exactRecord(value, RELATION_REQUIRED);
  const recordScope = canonicalScope(record.scope);
  const evidenceChunkIds = stringList(record.evidenceChunkIds, { nonEmpty: true });
  const sourceKinds = stringList(record.sourceKinds, { nonEmpty: true });
  const metadata = cloneStrictJson(record.metadata);
  if (!safeId(record.id) || !sameScope(recordScope, expectedScope) ||
      !safeId(record.subjectId) || !safeId(record.objectId) ||
      record.subjectId === record.objectId ||
      typeof record.predicate !== "string" || !RELATION_PREDICATE_SET.has(record.predicate) ||
      typeof record.status !== "string" || !RELATION_STATUS_SET.has(record.status) ||
      !metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw invalid();
  const evidenceCount = integer(record.evidenceCount);
  const firstSeenAt = integer(record.firstSeenAt);
  const lastSeenAt = integer(record.lastSeenAt);
  if (evidenceCount !== evidenceChunkIds.length || lastSeenAt < firstSeenAt) throw invalid();
  return Object.freeze({
    id: record.id,
    scope: expectedScope,
    subjectId: record.subjectId,
    predicate: record.predicate,
    objectId: record.objectId,
    confidence: finite(record.confidence, Number.EPSILON, 1),
    evidenceChunkIds,
    evidenceCount,
    firstSeenAt,
    lastSeenAt,
    status: record.status,
    sourceKinds,
    metadata: metadata as Record<string, unknown>,
  } as GraphRelationRecord);
}

function snapshotBatch(value: unknown, item: (entry: unknown) => unknown): readonly unknown[] {
  const entries = exactDenseArray(value);
  if (entries.length > 32) throw invalid();
  return Object.freeze(entries.map(item));
}

function scopeParams(scope: CanonicalAuthorityScope, fingerprint: string): readonly string[] {
  return Object.freeze([
    fingerprint,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    scope.workspaceId,
    scope.sessionId,
  ]);
}

function entityParams(
  scope: CanonicalAuthorityScope,
  fingerprint: string,
  entity: Readonly<GraphEntityRecord>,
): readonly unknown[] {
  return Object.freeze([
    entity.id,
    ...scopeParams(scope, fingerprint),
    entity.canonicalName,
    entity.displayName,
    entity.type,
    JSON.stringify(entity.aliases),
    entity.mentionCount,
    entity.mentionCount30d,
    entity.distinctSourceCount,
    entity.lastSeenAt ?? null,
    entity.hotness,
    entity.graphCentrality ?? null,
    entity.queryHits30d,
    entity.status,
    entity.mergedInto ?? null,
    entity.createdAt,
    entity.updatedAt,
    JSON.stringify(entity.metadata),
  ]);
}

function relationParams(
  scope: CanonicalAuthorityScope,
  fingerprint: string,
  relation: Readonly<GraphRelationRecord>,
): readonly unknown[] {
  return Object.freeze([
    relation.id,
    ...scopeParams(scope, fingerprint),
    relation.subjectId,
    relation.predicate,
    relation.objectId,
    relation.confidence,
    JSON.stringify(relation.evidenceChunkIds),
    relation.evidenceCount,
    relation.firstSeenAt,
    relation.lastSeenAt,
    relation.status,
    JSON.stringify(relation.sourceKinds),
    JSON.stringify(relation.metadata),
  ]);
}

function readQuery(client: unknown): PostgresGraphQueryClient["query"] {
  if (!client || typeof client !== "object" || nodeUtilTypes.isProxy(client)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(client, "query");
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw invalid();
  }
  return descriptor.value as PostgresGraphQueryClient["query"];
}

function decodeRows(value: unknown, label = "Postgres graph query result is invalid"): readonly string[] {
  const result = exactRecord(value, ["rows", "rowCount"], [], label);
  if (!Array.isArray(result.rows) || !Number.isSafeInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) throw invalid(label);
  const ids = result.rows.map((row) => {
    const decoded = exactRecord(row, ["id"], [], label);
    if (!safeId(decoded.id)) throw invalid(label);
    return decoded.id;
  });
  if (new Set(ids).size !== ids.length) throw invalid(label);
  return Object.freeze(ids);
}

function decodeUpsert(value: unknown, expectedId: string, inserted: boolean): boolean {
  const ids = decodeRows(value);
  if (inserted) {
    if (ids.length > 1 || (ids.length === 1 && ids[0] !== expectedId)) throw invalid("Postgres graph query result is invalid");
    return ids.length === 1;
  }
  if (ids.length !== 1 || ids[0] !== expectedId) throw invalid("Postgres graph query result is invalid");
  return false;
}

export class PostgresGraphRepository {
  readonly #assertReady: () => void;

  constructor(options: { readonly assertReady?: () => void } = {}) {
    if (options.assertReady !== undefined && typeof options.assertReady !== "function") throw invalid();
    this.#assertReady = options.assertReady ?? (() => undefined);
  }

  snapshotGraph(
    rawScope: MemoryScope,
    rawEntities: readonly GraphEntityRecord[],
    rawRelations: readonly GraphRelationRecord[],
  ): PostgresGraphSnapshot {
    const scope = canonicalScope(rawScope);
    const entities = snapshotBatch(rawEntities, (value) => snapshotEntity(value, scope)) as
      readonly Readonly<GraphEntityRecord>[];
    const relations = snapshotBatch(rawRelations, (value) => snapshotRelation(value, scope)) as
      readonly Readonly<GraphRelationRecord>[];
    if (entities.length + relations.length > 32) throw invalid();
    const entityIds = entities.map((entity) => entity.id);
    const relationIds = relations.map((relation) => relation.id);
    if (new Set(entityIds).size !== entityIds.length || new Set(relationIds).size !== relationIds.length) {
      throw invalid();
    }
    return Object.freeze({
      scope,
      scopeFingerprint: authorityScopeFingerprint(scope),
      entities,
      relations,
    });
  }

  /**
   * Atomically upserts one graph batch through a caller-owned transaction client.
   * The method intentionally never issues transaction-control SQL.
   */
  async upsertGraphWithClient(
    client: PostgresGraphQueryClient,
    rawScope: MemoryScope,
    rawEntities: readonly GraphEntityRecord[],
    rawRelations: readonly GraphRelationRecord[],
  ): Promise<PostgresGraphPersistResult> {
    const snapshot = this.snapshotGraph(rawScope, rawEntities, rawRelations);
    this.#assertReady();
    const query = readQuery(client);
    let createdEntities = 0;
    for (const entity of snapshot.entities) {
      const params = entityParams(snapshot.scope, snapshot.scopeFingerprint, entity);
      const inserted = decodeUpsert(await query.call(client, ENTITY_INSERT_SQL, params), entity.id, true);
      if (inserted) {
        createdEntities += 1;
      } else {
        decodeUpsert(await query.call(client, ENTITY_UPDATE_SQL, params), entity.id, false);
      }
    }

    if (snapshot.relations.length > 0) {
      const endpointIds = Array.from(new Set(snapshot.relations.flatMap((relation) => [
        relation.subjectId, relation.objectId,
      ]))).sort();
      const endpointResult = decodeRows(await query.call(client, ENTITY_ENDPOINTS_SQL, [
        ...scopeParams(snapshot.scope, snapshot.scopeFingerprint), endpointIds,
      ]));
      if (endpointResult.length !== endpointIds.length ||
          endpointResult.some((id, index) => id !== endpointIds[index])) {
        throw invalid("Postgres graph relation endpoint is missing from the bound scope");
      }
    }

    let createdRelations = 0;
    for (const relation of snapshot.relations) {
      const params = relationParams(snapshot.scope, snapshot.scopeFingerprint, relation);
      const inserted = decodeUpsert(await query.call(client, RELATION_INSERT_SQL, params), relation.id, true);
      if (inserted) {
        createdRelations += 1;
      } else {
        decodeUpsert(await query.call(client, RELATION_UPDATE_SQL, params), relation.id, false);
      }
    }

    return Object.freeze({
      createdEntities,
      createdRelations,
      entityIds: Object.freeze(snapshot.entities.map((entity) => entity.id)),
      relationIds: Object.freeze(snapshot.relations.map((relation) => relation.id)),
    });
  }
}
