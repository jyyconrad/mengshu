/**
 * Candidate 去重前的 scope-bound 存量读取边界。
 *
 * 调用方只能拿到同 authority、完整 scope、原生分类与 embedding space 下，
 * 且仍可参与 active memory 去重的记录；禁止退化为全局 content hash 查询。
 */

import { canonicalAuthorityScope } from "../domain/authority-scope-fingerprint.js";
import type { MemoryKind, MemoryScope, MemorySemanticType } from "../domain/types.js";
import type { CandidateDedupComparable } from "./candidate-dedup-policy.js";

export interface CandidateDedupReadInput {
  readonly scope: MemoryScope;
  readonly kind: MemoryKind;
  readonly semanticType?: MemorySemanticType;
  readonly embeddingSpaceId: string;
  readonly embeddingSpaceState: "known-queryable";
  /** Durable replay 的稳定记录 ID；查询时必须排除，避免把自身识别为重复项。 */
  readonly excludeIds: readonly string[];
}

/** Provider-agnostic read port consumed by candidate materialization. */
export interface CandidateDedupReadPort {
  findExisting(input: CandidateDedupReadInput): Promise<readonly CandidateDedupComparable[]>;
}

export interface PostgresCandidateDedupReadQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Query client lifecycle belongs to the Runtime/provider composition. */
export interface PostgresCandidateDedupReadQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCandidateDedupReadQueryResult<Row>>;
}

const MEMORY_KINDS = new Set<MemoryKind>([
  "preference",
  "decision",
  "entity",
  "fact",
  "task",
  "plan",
  "goal",
  "document",
  "knowledge",
  "observation",
  "other",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
]);
const ACTIVE_CONTAINERS = new Set(["personal", "project", "team", "enterprise"]);
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const EMBEDDING_SPACE_ID = /^embedding-space:v1:[a-f0-9]{64}$/;
const MAX_EXCLUDED_IDS = 10_000;

const ROW_KEYS = [
  "id",
  "text",
  "vector_text",
  "tenant_id",
  "user_id",
  "app_id",
  "project_id",
  "agent_id",
  "namespace",
  "visibility",
  "workspace_id",
  "session_id",
  "memory_kind",
  "semantic_type",
  "lifecycle_status",
  "admission_route",
  "context_eligible",
  "memory_container",
  "embedding_space_id",
  "embedding_space_state",
  "metadata_embedding_space_id",
  "metadata_embedding_space_state",
] as const;

/**
 * memories 暂无独立 session_id：metadata.sessionId 是目标镜像，当前 Write Kernel
 * 的治理快照 provenance.sessionId 是兼容来源。两者同时存在时必须一致。
 */
const SESSION_SQL = `COALESCE(
  metadata->>'sessionId',
  metadata #>> '{governance,provenance,sessionId}',
  ''
)`;

const FIND_EXISTING_SQL = `SELECT
  id::text AS id,
  text,
  vector::text AS vector_text,
  tenant_id,
  user_id,
  product_id AS app_id,
  canonical_project_id AS project_id,
  producer_id AS agent_id,
  namespace,
  visibility,
  COALESCE(workspace_id, '') AS workspace_id,
  ${SESSION_SQL} AS session_id,
  metadata #>> '{governance,native,kind}' AS memory_kind,
  metadata->>'semanticType' AS semantic_type,
  lifecycle_status,
  metadata->>'admissionRoute' AS admission_route,
  metadata->>'contextEligible' AS context_eligible,
  metadata->>'memoryContainer' AS memory_container,
  embedding_space_id,
  embedding_space_state,
  metadata->>'embeddingSpaceId' AS metadata_embedding_space_id,
  metadata->>'embeddingSpaceState' AS metadata_embedding_space_state
FROM memories
WHERE tenant_id = $1
  AND user_id = $2
  AND product_id = $3
  AND canonical_project_id = $4
  AND producer_id = $5
  AND namespace = $6
  AND visibility = $7
  AND COALESCE(workspace_id, '') = $8
  AND ${SESSION_SQL} = $9
  AND (
    metadata->>'sessionId' IS NULL
    OR metadata #>> '{governance,provenance,sessionId}' IS NULL
    OR metadata->>'sessionId' = metadata #>> '{governance,provenance,sessionId}'
  )
  AND metadata #>> '{governance,native,kind}' = $10
  AND (
    ($11::text IS NULL
      AND metadata->>'semanticType' IS NULL
      AND metadata #>> '{governance,native,semanticType}' IS NULL)
    OR
    ($11::text IS NOT NULL
      AND metadata->>'semanticType' = $11
      AND metadata #>> '{governance,native,semanticType}' = $11)
  )
  AND embedding_space_id = $12
  AND embedding_space_state = $13
  AND metadata->>'embeddingSpaceId' = $12
  AND metadata->>'embeddingSpaceState' = $13
  AND NOT (id::text = ANY($14::text[]))
  AND data_type = 'memory'
  AND lifecycle_status = 'active'
  AND metadata->>'admissionRoute' = 'active'
  AND metadata->>'contextEligible' = 'true'
  AND metadata->>'memoryContainer' IN ('personal', 'project', 'team', 'enterprise')
  AND legacy_quarantine_reason IS NULL
ORDER BY created_at ASC, id ASC`;

function invalidInput(): Error {
  return new Error("candidate dedup read input is invalid");
}

function invalidRow(): Error {
  return new Error("candidate dedup read row is invalid");
}

function exactRow(value: unknown): Record<(typeof ROW_KEYS)[number], unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidRow();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalidRow();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== ROW_KEYS.length || keys.some(
    (key) => typeof key !== "string" || !ROW_KEYS.includes(key as (typeof ROW_KEYS)[number]),
  )) {
    throw invalidRow();
  }
  for (const key of ROW_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidRow();
  }
  return value as Record<(typeof ROW_KEYS)[number], unknown>;
}

function parseVector(value: unknown): readonly number[] {
  if (typeof value !== "string") throw invalidRow();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw invalidRow();
  }
  if (!Array.isArray(decoded) || decoded.length === 0 || decoded.some(
    (item) => typeof item !== "number" || !Number.isFinite(item),
  )) {
    throw invalidRow();
  }
  return Object.freeze([...decoded]);
}

function normalizedInput(input: CandidateDedupReadInput) {
  if (!input || typeof input !== "object" || !MEMORY_KINDS.has(input.kind) ||
      (input.semanticType !== undefined && !SEMANTIC_TYPES.has(input.semanticType)) ||
      !EMBEDDING_SPACE_ID.test(input.embeddingSpaceId) ||
      input.embeddingSpaceState !== "known-queryable" ||
      !Array.isArray(input.excludeIds) || input.excludeIds.length > MAX_EXCLUDED_IDS ||
      input.excludeIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
      new Set(input.excludeIds).size !== input.excludeIds.length) {
    throw invalidInput();
  }
  try {
    return Object.freeze({
      scope: canonicalAuthorityScope(input.scope),
      kind: input.kind,
      semanticType: input.semanticType,
      embeddingSpaceId: input.embeddingSpaceId,
      embeddingSpaceState: input.embeddingSpaceState,
      excludeIds: Object.freeze([...input.excludeIds]),
    });
  } catch {
    throw invalidInput();
  }
}

function comparable(
  value: unknown,
  input: ReturnType<typeof normalizedInput>,
): CandidateDedupComparable {
  const row = exactRow(value);
  const expected = input.scope;
  if (typeof row.id !== "string" || !SAFE_ID.test(row.id) ||
      typeof row.text !== "string" || row.text.trim().length === 0 ||
      row.tenant_id !== expected.tenantId || row.user_id !== expected.userId ||
      row.app_id !== expected.appId || row.project_id !== expected.projectId ||
      row.agent_id !== expected.agentId || row.namespace !== expected.namespace ||
      row.visibility !== expected.visibility || row.workspace_id !== expected.workspaceId ||
      row.session_id !== expected.sessionId || row.memory_kind !== input.kind ||
      row.semantic_type !== (input.semanticType ?? null) ||
      row.lifecycle_status !== "active" || row.admission_route !== "active" ||
      row.context_eligible !== "true" ||
      typeof row.memory_container !== "string" || !ACTIVE_CONTAINERS.has(row.memory_container) ||
      row.embedding_space_id !== input.embeddingSpaceId ||
      row.embedding_space_state !== input.embeddingSpaceState ||
      row.metadata_embedding_space_id !== input.embeddingSpaceId ||
      row.metadata_embedding_space_state !== input.embeddingSpaceState ||
      input.excludeIds.includes(row.id)) {
    throw invalidRow();
  }
  return Object.freeze({
    id: row.id,
    text: row.text,
    vector: parseVector(row.vector_text),
    kind: input.kind,
    ...(input.semanticType === undefined ? {} : { semanticType: input.semanticType }),
  });
}

export class PostgresCandidateDedupReadAdapter implements CandidateDedupReadPort {
  constructor(private readonly client: PostgresCandidateDedupReadQueryClient) {
    if (!client || typeof client.query !== "function") throw invalidInput();
  }

  async findExisting(
    rawInput: CandidateDedupReadInput,
  ): Promise<readonly CandidateDedupComparable[]> {
    const input = normalizedInput(rawInput);
    const { scope } = input;
    const result = await this.client.query(FIND_EXISTING_SQL, [
      scope.tenantId,
      scope.userId,
      scope.appId,
      scope.projectId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      scope.workspaceId,
      scope.sessionId,
      input.kind,
      input.semanticType ?? null,
      input.embeddingSpaceId,
      input.embeddingSpaceState,
      input.excludeIds,
    ]);
    if (!result || !Array.isArray(result.rows) ||
        (result.rowCount !== undefined && result.rowCount !== null &&
          result.rowCount !== result.rows.length)) {
      throw invalidRow();
    }
    const seen = new Set<string>();
    const records = result.rows.map((row) => {
      const record = comparable(row, input);
      if (seen.has(record.id)) throw invalidRow();
      seen.add(record.id);
      return record;
    });
    return Object.freeze(records);
  }
}
