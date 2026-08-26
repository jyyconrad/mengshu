/**
 * F0 PostgreSQL Entity Graph recall feedback.
 *
 * Recall 只提交 active memory identity；实体集合必须沿 provider-owned
 * memory/evidence ledger 权威解析，不能来自调用方 metadata。
 */

import {
  authorityScopeFingerprint,
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { SCORING_WEIGHTS_V1 } from "../scoring/scoring-weights.js";
import type {
  EntityGraphQueryHitsInput,
  EntityGraphQueryHitsPort,
  EntityGraphQueryHitsResult,
} from "./query-hits-tracker.js";

export interface PostgresEntityGraphQueryHitsQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresEntityGraphQueryHitsQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresEntityGraphQueryHitsQueryResult<Row>>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const MAX_MEMORY_IDS = 500;

function scopeWhere(alias: string): string {
  return `${alias}.scope_fingerprint = $1
    AND ${alias}.tenant_id = $2 AND ${alias}.user_id = $3
    AND ${alias}.app_id = $4 AND ${alias}.project_id = $5
    AND ${alias}.agent_id = $6 AND ${alias}.namespace = $7
    AND ${alias}.visibility = $8 AND ${alias}.workspace_id = $9
    AND ${alias}.session_id = $10`;
}

const INCREMENT_QUERY_HITS_SQL = `WITH recalled_memory_ids AS (
  SELECT DISTINCT recalled.memory_id
  FROM unnest($11::text[]) AS recalled(memory_id)
), entity_targets AS (
  SELECT DISTINCT entity_evidence.entity_id
  FROM recalled_memory_ids AS recalled
  JOIN mengshu_memory_evidence_links AS memory_link
    ON memory_link.target_memory_id = recalled.memory_id
    AND memory_link.link_kind = 'grounded_by'
    AND memory_link.source = 'entity_graph'
    AND ${scopeWhere("memory_link")}
  JOIN mengshu_graph_entity_evidence AS entity_evidence
    ON entity_evidence.evidence_memory_id = memory_link.evidence_memory_id
    AND ${scopeWhere("entity_evidence")}
), updated_entities AS (
  UPDATE mengshu_graph_entities AS entity
  SET query_hits_30d = entity.query_hits_30d + 1,
    hotness = entity.hotness + $13,
    updated_at = GREATEST(entity.updated_at, $12)
  FROM entity_targets AS target
  WHERE entity.id = target.entity_id
    AND entity.status = 'active'
    AND ${scopeWhere("entity")}
  RETURNING entity.id AS entity_id, entity.query_hits_30d, entity.hotness
)
SELECT entity_id, query_hits_30d, hotness
FROM updated_entities
ORDER BY entity_id`;

const RESULT_KEYS = Object.freeze(["entity_id", "query_hits_30d", "hotness"] as const);

function invalid(kind: "input" | "result"): Error {
  return new Error(`Postgres Entity Graph query hits ${kind} is invalid`);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value);
}

function exactRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("result");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid("result");
  const keys = Reflect.ownKeys(value);
  if (keys.length !== RESULT_KEYS.length ||
      keys.some((key) => typeof key !== "string" || !RESULT_KEYS.includes(key as never))) {
    throw invalid("result");
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 0) throw invalid("result");
  return Number(parsed);
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw invalid("result");
  }
  return value;
}

function validateInput(input: EntityGraphQueryHitsInput): {
  readonly scope: CanonicalAuthorityScope;
  readonly fingerprint: string;
  readonly memoryIds: readonly string[];
  readonly occurredAt: number;
} {
  if (!input || typeof input !== "object" || !Array.isArray(input.memoryIds) ||
      input.memoryIds.length > MAX_MEMORY_IDS || input.memoryIds.some((id) => !safeId(id)) ||
      !Number.isSafeInteger(input.occurredAt) || input.occurredAt < 0) {
    throw invalid("input");
  }
  let scope: CanonicalAuthorityScope;
  let fingerprint: string;
  try {
    scope = canonicalAuthorityScope(input.scope);
    fingerprint = authorityScopeFingerprint(input.scope);
  } catch {
    throw invalid("input");
  }
  return Object.freeze({
    scope,
    fingerprint,
    memoryIds: Object.freeze([...new Set(input.memoryIds)].sort()),
    occurredAt: input.occurredAt,
  });
}

function validateResult(value: unknown, limit: number): EntityGraphQueryHitsResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("result");
  const result = value as PostgresEntityGraphQueryHitsQueryResult;
  if (!Array.isArray(result.rows) || result.rows.length > limit ||
      (result.rowCount !== undefined && result.rowCount !== null &&
        (!Number.isSafeInteger(result.rowCount) || result.rowCount !== result.rows.length))) {
    throw invalid("result");
  }
  const updatedEntityIds: string[] = [];
  for (const valueRow of result.rows) {
    const row = exactRow(valueRow);
    if (!safeId(row.entity_id)) throw invalid("result");
    nonNegativeInteger(row.query_hits_30d);
    finite(row.hotness);
    updatedEntityIds.push(row.entity_id);
  }
  if (new Set(updatedEntityIds).size !== updatedEntityIds.length ||
      updatedEntityIds.some((id, index) => index > 0 && updatedEntityIds[index - 1]! >= id)) {
    throw invalid("result");
  }
  return Object.freeze({ updatedEntityIds: Object.freeze(updatedEntityIds) });
}

export class PostgresEntityGraphQueryHitsPort implements EntityGraphQueryHitsPort {
  constructor(private readonly client: PostgresEntityGraphQueryHitsQueryClient) {
    if (!client || typeof client.query !== "function") throw invalid("input");
  }

  async incrementRecallHits(input: EntityGraphQueryHitsInput): Promise<EntityGraphQueryHitsResult> {
    const snapshot = validateInput(input);
    if (snapshot.memoryIds.length === 0) {
      return Object.freeze({ updatedEntityIds: Object.freeze([]) });
    }
    const raw = await this.client.query(INCREMENT_QUERY_HITS_SQL, [
      snapshot.fingerprint,
      snapshot.scope.tenantId,
      snapshot.scope.userId,
      snapshot.scope.appId,
      snapshot.scope.projectId,
      snapshot.scope.agentId,
      snapshot.scope.namespace,
      snapshot.scope.visibility,
      snapshot.scope.workspaceId,
      snapshot.scope.sessionId,
      snapshot.memoryIds,
      snapshot.occurredAt,
      SCORING_WEIGHTS_V1.hotness.query_hits_coeff,
    ]);
    return validateResult(raw, snapshot.memoryIds.length * 32);
  }
}
