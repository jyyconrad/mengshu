import { types as nodeUtilTypes } from "node:util";

import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";

export interface CanonicalEntityCentralityRefreshInput {
  readonly scope: MemoryScope;
  readonly now: number;
  readonly signal: AbortSignal;
}

export interface CanonicalEntityCentralityRefreshResult {
  readonly activeEntityCount: number;
  readonly activeRelationCount: number;
  readonly updatedCount: number;
  readonly centralities: Readonly<Record<string, number>>;
}

export interface CanonicalEntityCentralityRefreshPort {
  refresh(
    input: CanonicalEntityCentralityRefreshInput,
  ): Promise<CanonicalEntityCentralityRefreshResult>;
}

export interface PostgresCanonicalEntityCentralityClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: readonly Row[]; readonly rowCount?: number | null }>;
}

const REFRESH_SQL = `WITH active_entities AS MATERIALIZED (
  SELECT id
  FROM mengshu_graph_entities
  WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
    AND agent_id = $5 AND namespace = $6 AND visibility = $7
    AND workspace_id = $8 AND session_id = $9 AND status = 'active'
), active_relations AS MATERIALIZED (
  SELECT subject_id, object_id
  FROM mengshu_graph_relations
  WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
    AND agent_id = $5 AND namespace = $6 AND visibility = $7
    AND workspace_id = $8 AND session_id = $9 AND status = 'active'
), invalid_relations AS MATERIALIZED (
  SELECT count(*)::text AS invalid_relation_count
  FROM active_relations AS relation
  WHERE NOT EXISTS (SELECT 1 FROM active_entities WHERE id = relation.subject_id)
     OR NOT EXISTS (SELECT 1 FROM active_entities WHERE id = relation.object_id)
), relation_endpoints AS MATERIALIZED (
  SELECT subject_id AS entity_id FROM active_relations
  UNION ALL
  SELECT object_id AS entity_id FROM active_relations
), degrees AS MATERIALIZED (
  SELECT entity.id, count(endpoint.entity_id)::integer AS degree
  FROM active_entities AS entity
  LEFT JOIN relation_endpoints AS endpoint ON endpoint.entity_id = entity.id
  GROUP BY entity.id
), normalized AS MATERIALIZED (
  SELECT id, CASE WHEN max(degree) OVER () > 0
    THEN degree::double precision / max(degree) OVER ()
    ELSE 0::double precision END AS centrality
  FROM degrees
), updated AS (
  UPDATE mengshu_graph_entities AS entity
  SET graph_centrality = normalized.centrality, updated_at = GREATEST(entity.updated_at, $10)
  FROM normalized
  WHERE entity.id = normalized.id
    AND entity.tenant_id = $1 AND entity.user_id = $2 AND entity.app_id = $3
    AND entity.project_id = $4 AND entity.agent_id = $5 AND entity.namespace = $6
    AND entity.visibility = $7 AND entity.workspace_id = $8 AND entity.session_id = $9
    AND entity.status = 'active'
    AND (SELECT invalid_relation_count FROM invalid_relations) = '0'
  RETURNING entity.id, entity.graph_centrality
)
SELECT
  (SELECT count(*)::text FROM active_entities) AS active_entity_count,
  (SELECT count(*)::text FROM active_relations) AS active_relation_count,
  (SELECT invalid_relation_count FROM invalid_relations) AS invalid_relation_count,
  (SELECT count(*)::text FROM updated) AS updated_count,
  COALESCE((SELECT jsonb_object_agg(id, graph_centrality ORDER BY id) FROM updated), '{}'::jsonb)
    AS centralities`;

export class PostgresCanonicalEntityCentralityRefreshError extends Error {
  readonly code = "POSTGRES_CANONICAL_ENTITY_CENTRALITY_REFRESH_INVALID" as const;

  constructor() {
    super("Postgres canonical Entity centrality refresh is invalid or incomplete");
    this.name = "PostgresCanonicalEntityCentralityRefreshError";
  }
}

function invalid(): never {
  throw new PostgresCanonicalEntityCentralityRefreshError();
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error && signal.reason.name === "AbortError"
    ? signal.reason
    : new DOMException("Canonical Entity centrality refresh aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function scopeParams(scope: CanonicalAuthorityScope, now: number): readonly unknown[] {
  return Object.freeze([
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId, now,
  ]);
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) invalid();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) invalid();
  return parsed;
}

function dataRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") invalid();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
    record[key] = descriptor.value;
  }
  return record;
}

export class PostgresCanonicalEntityCentralityRefresh
implements CanonicalEntityCentralityRefreshPort {
  constructor(private readonly client: PostgresCanonicalEntityCentralityClient) {
    if (!client || typeof client.query !== "function") invalid();
  }

  async refresh(
    input: CanonicalEntityCentralityRefreshInput,
  ): Promise<CanonicalEntityCentralityRefreshResult> {
    if (!input || !(input.signal instanceof AbortSignal) ||
        !Number.isSafeInteger(input.now) || input.now < 0) invalid();
    throwIfAborted(input.signal);
    let scope: CanonicalAuthorityScope;
    try {
      scope = canonicalAuthorityScope(input.scope);
    } catch {
      return invalid();
    }
    const result = await this.client.query(REFRESH_SQL, scopeParams(scope, input.now));
    throwIfAborted(input.signal);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1 ||
        (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== 1)) {
      return invalid();
    }
    const row = dataRecord(result.rows[0]);
    const expected = [
      "active_entity_count", "active_relation_count", "invalid_relation_count",
      "updated_count", "centralities",
    ];
    if (Reflect.ownKeys(row).length !== expected.length ||
        expected.some((key) => !Object.hasOwn(row, key))) invalid();
    const activeEntityCount = count(row.active_entity_count);
    const activeRelationCount = count(row.active_relation_count);
    const invalidRelationCount = count(row.invalid_relation_count);
    const updatedCount = count(row.updated_count);
    const rawCentralities = dataRecord(row.centralities);
    const centralities: Record<string, number> = {};
    for (const [id, value] of Object.entries(rawCentralities)) {
      if (!id || typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
        invalid();
      }
      centralities[id] = value;
    }
    if (invalidRelationCount !== 0 || updatedCount !== activeEntityCount ||
        Object.keys(centralities).length !== updatedCount) invalid();
    return Object.freeze({
      activeEntityCount,
      activeRelationCount,
      updatedCount,
      centralities: Object.freeze(centralities),
    });
  }
}
