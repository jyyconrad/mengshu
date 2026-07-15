import { types as nodeUtilTypes } from "node:util";

import {
  canonicalAuthorityScope,
  type CanonicalAuthorityScope,
} from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../domain/types.js";
import type {
  CandidateRecord,
  CandidateRepository,
  CandidateStatus,
} from "./candidate-types.js";

export interface PostgresCandidateReviewQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

/** Caller-owned narrow query client. This adapter never begins, commits, rolls back, or closes it. */
export interface PostgresCandidateReviewQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCandidateReviewQueryResult<Row>>;
}

export type PostgresCandidateReviewRepositoryErrorCode =
  | "INVALID_INPUT"
  | "NOT_READY"
  | "QUERY_FAILED"
  | "INVALID_RESULT"
  | "NOT_FOUND"
  | "CONFLICT";

export class PostgresCandidateReviewRepositoryError extends Error {
  readonly code: PostgresCandidateReviewRepositoryErrorCode;
  readonly retryable: boolean;

  constructor(code: PostgresCandidateReviewRepositoryErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "PostgresCandidateReviewRepositoryError";
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The durable subset consumed by CandidateReviewService and Console.
 * Enqueue and hit accounting intentionally remain on their provider-owned write paths.
 */
export interface ScopeBoundCandidateReviewRepository extends Pick<
  CandidateRepository,
  "get" | "list" | "setStatus" | "count" | "deleteByIds"
> {
  archiveByIds(ids: string[], reason?: string): Promise<number>;
  runEvictionScan(options?: {
    readonly evictionDays?: number;
    readonly archiveDays?: number;
  }): Promise<{ evicted: number; archived: number }>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const UNSAFE_STRING = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const CANDIDATE_STATUSES = new Set<CandidateStatus>([
  "pending", "approved", "rejected", "archived", "expired",
]);
const REVIEW_TARGET_STATUSES = new Set<CandidateStatus>([
  "approved", "rejected", "archived", "expired",
]);
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const MAX_LIST_LIMIT = 10_000;
const MAX_BATCH_IDS = 1_000;
const DEFAULT_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

const SCOPE_WHERE = `tenant_id = $1 AND user_id = $2 AND app_id = $3
  AND project_id = $4 AND agent_id = $5 AND namespace = $6
  AND visibility = $7 AND workspace_id = $8 AND session_id = $9`;
const CANDIDATE_COLUMNS = `id, tenant_id, user_id, app_id, project_id, agent_id,
  namespace, visibility, workspace_id, session_id, text, semantic_type, kind,
  confidence, reason, evidence_ids, extractor, status, hit_count, metadata,
  created_at, updated_at, last_hit_at, promoted_to_memory_id`;

const GET_SQL = `SELECT ${CANDIDATE_COLUMNS}
FROM mengshu_candidates
WHERE ${SCOPE_WHERE} AND id = $10
LIMIT 2`;
const LIST_SQL = `SELECT ${CANDIDATE_COLUMNS}
FROM mengshu_candidates
WHERE ${SCOPE_WHERE}
  AND ($10::text IS NULL OR status = $10)
  AND ($11::text IS NULL OR semantic_type = $11)
  AND ($12::double precision IS NULL OR confidence >= $12)
ORDER BY created_at DESC, id
LIMIT $13`;
const COUNT_SQL = `SELECT count(*)::text AS count
FROM mengshu_candidates
WHERE ${SCOPE_WHERE}
  AND ($10::text IS NULL OR status = $10)`;
const SET_STATUS_SQL = `WITH transitioned AS (
  UPDATE mengshu_candidates
  SET status = $11,
    active_content_hash = NULL,
    promoted_to_memory_id = CASE
      WHEN $11 = 'approved' THEN COALESCE($12, promoted_to_memory_id)
      ELSE promoted_to_memory_id
    END,
    metadata = CASE
      WHEN $13::text IS NULL THEN metadata
      ELSE metadata || jsonb_build_object('statusReason', $13::text)
    END,
    updated_at = $14
  WHERE ${SCOPE_WHERE} AND id = $10 AND status = 'pending'
  RETURNING id, status, promoted_to_memory_id,
    metadata ->> 'statusReason' AS status_reason, true AS changed
)
SELECT id, status, promoted_to_memory_id, status_reason, changed
FROM transitioned
UNION ALL
SELECT id, status, promoted_to_memory_id,
  metadata ->> 'statusReason' AS status_reason, false AS changed
FROM mengshu_candidates
WHERE ${SCOPE_WHERE} AND id = $10
  AND NOT EXISTS (SELECT 1 FROM transitioned)
LIMIT 2`;
const ARCHIVE_SQL = `UPDATE mengshu_candidates
SET status = 'archived', active_content_hash = NULL,
  metadata = CASE
    WHEN $11::text IS NULL THEN metadata
    ELSE metadata || jsonb_build_object('statusReason', $11::text)
  END,
  updated_at = $12
WHERE ${SCOPE_WHERE} AND id = ANY($10::text[]) AND status = 'pending'
RETURNING id`;
const DELETE_EXPIRED_SQL = `DELETE FROM mengshu_candidates
WHERE ${SCOPE_WHERE} AND id = ANY($10::text[]) AND status = 'expired'
RETURNING id`;
const EVICTION_SQL = `WITH archived AS (
  UPDATE mengshu_candidates
  SET status = 'archived', active_content_hash = NULL,
    metadata = metadata || jsonb_build_object('statusReason', 'archived_after_hit_timeout'),
    updated_at = $12
  WHERE ${SCOPE_WHERE} AND status = 'pending'
    AND last_hit_at IS NOT NULL AND created_at <= $10
  RETURNING id
), evicted AS (
  DELETE FROM mengshu_candidates
  WHERE ${SCOPE_WHERE} AND status = 'pending'
    AND last_hit_at IS NULL AND created_at <= $11
  RETURNING id
)
SELECT (SELECT count(*)::text FROM evicted) AS evicted,
  (SELECT count(*)::text FROM archived) AS archived`;

const CANDIDATE_KEYS = [
  "id", "tenant_id", "user_id", "app_id", "project_id", "agent_id",
  "namespace", "visibility", "workspace_id", "session_id", "text",
  "semantic_type", "kind", "confidence", "reason", "evidence_ids", "extractor",
  "status", "hit_count", "metadata", "created_at", "updated_at", "last_hit_at",
  "promoted_to_memory_id",
] as const;

function invalid(message = "Candidate review input is invalid"): PostgresCandidateReviewRepositoryError {
  return new PostgresCandidateReviewRepositoryError("INVALID_INPUT", message);
}

function invalidResult(): PostgresCandidateReviewRepositoryError {
  return new PostgresCandidateReviewRepositoryError(
    "INVALID_RESULT",
    "Candidate review query result is invalid",
  );
}

function safeId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || UNPAIRED_SURROGATE.test(value)) {
    throw invalid();
  }
  return value;
}

function safeText(value: unknown, max: number, options: { readonly nonBlank?: boolean } = {}): string {
  if (typeof value !== "string" || value.length > max || UNSAFE_STRING.test(value) ||
      UNPAIRED_SURROGATE.test(value) || (options.nonBlank && value.trim().length === 0)) {
    throw invalidResult();
  }
  return value;
}

function exactDataRecord(value: unknown, allowed: readonly string[], required = allowed): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    throw invalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key)) ||
      required.some((key) => !keys.includes(key))) throw invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function snapshotScope(value: unknown): {
  readonly canonical: CanonicalAuthorityScope;
  readonly publicScope: Readonly<MemoryScope>;
} {
  const keys = [
    "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
    "visibility", "workspaceId", "sessionId",
  ] as const;
  const raw = exactDataRecord(value, keys, keys.slice(0, 7));
  let canonical: CanonicalAuthorityScope;
  try {
    canonical = canonicalAuthorityScope(raw as unknown as MemoryScope);
  } catch {
    throw invalid();
  }
  const publicScope = Object.freeze({
    tenantId: canonical.tenantId,
    userId: canonical.userId,
    appId: canonical.appId,
    projectId: canonical.projectId,
    agentId: canonical.agentId,
    namespace: canonical.namespace,
    visibility: canonical.visibility,
    ...(canonical.workspaceId === "" ? {} : { workspaceId: canonical.workspaceId }),
    ...(canonical.sessionId === "" ? {} : { sessionId: canonical.sessionId }),
  });
  return Object.freeze({ canonical, publicScope });
}

function sameScope(left: CanonicalAuthorityScope, right: CanonicalAuthorityScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    left.visibility === right.visibility && left.workspaceId === right.workspaceId &&
    left.sessionId === right.sessionId;
}

function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  let parsed: number;
  if (typeof value === "number") parsed = value;
  else if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) parsed = Number(value);
  else throw invalidResult();
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw invalidResult();
  return parsed;
}

function optionalInteger(value: unknown, min = 0): number | undefined {
  return value === null ? undefined : integer(value, min);
}

function finite(value: unknown, min = 0, max = Number.POSITIVE_INFINITY): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
    throw invalidResult();
  }
  return value;
}

function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (UNSAFE_STRING.test(value) || UNPAIRED_SURROGATE.test(value)) throw invalidResult();
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidResult();
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    throw invalidResult();
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 10_000) throw invalidResult();
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length") ||
          keys.some((key) => typeof key !== "string" ||
            (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
        throw invalidResult();
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidResult();
        result.push(cloneJson(descriptor.value, ancestors));
      }
      return Object.freeze(result);
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw invalidResult();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw invalidResult();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw invalidResult();
      result[key] = cloneJson(descriptor.value, ancestors);
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function stringIds(value: unknown, max = MAX_BATCH_IDS): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length > max) throw invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || !keys.includes("length") ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= value.length)))) {
    throw invalid();
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) throw invalid();
    const id = safeId(descriptor.value);
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return Object.freeze(result);
}

function rowRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  try {
    return exactDataRecord(value, keys);
  } catch {
    throw invalidResult();
  }
}

function assertRowScope(row: Record<string, unknown>, scope: CanonicalAuthorityScope): void {
  if (row.tenant_id !== scope.tenantId || row.user_id !== scope.userId ||
      row.app_id !== scope.appId || row.project_id !== scope.projectId ||
      row.agent_id !== scope.agentId || row.namespace !== scope.namespace ||
      row.visibility !== scope.visibility || row.workspace_id !== scope.workspaceId ||
      row.session_id !== scope.sessionId) throw invalidResult();
}

function decodeCandidate(
  value: unknown,
  scope: CanonicalAuthorityScope,
  publicScope: Readonly<MemoryScope>,
): CandidateRecord {
  const row = rowRecord(value, CANDIDATE_KEYS);
  assertRowScope(row, scope);
  if (typeof row.status !== "string" || !CANDIDATE_STATUSES.has(row.status as CandidateStatus) ||
      (row.semantic_type !== null &&
        (typeof row.semantic_type !== "string" || !SEMANTIC_TYPES.has(row.semantic_type as MemorySemanticType)))) {
    throw invalidResult();
  }
  const evidence = cloneJson(row.evidence_ids);
  if (!Array.isArray(evidence) || evidence.some((id) => typeof id !== "string" || safeId(id) !== id)) {
    throw invalidResult();
  }
  const metadata = cloneJson(row.metadata);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw invalidResult();
  const createdAt = integer(row.created_at);
  const updatedAt = optionalInteger(row.updated_at, createdAt);
  const lastHitAt = optionalInteger(row.last_hit_at, createdAt);
  const reason = row.reason === null ? undefined : safeText(row.reason, 2_000);
  const extractor = row.extractor === null ? undefined : safeId(row.extractor);
  const promotedToMemoryId = row.promoted_to_memory_id === null
    ? undefined
    : safeId(row.promoted_to_memory_id);
  return Object.freeze({
    id: safeId(row.id),
    scope: publicScope as MemoryScope,
    text: safeText(row.text, 100_000, { nonBlank: true }),
    ...(row.semantic_type === null ? {} : { semanticType: row.semantic_type as MemorySemanticType }),
    kind: safeId(row.kind),
    confidence: finite(row.confidence, 0, 1),
    ...(reason === undefined ? {} : { reason }),
    evidenceIds: evidence as string[],
    ...(extractor === undefined ? {} : { extractor }),
    status: row.status as CandidateStatus,
    hitCount: integer(row.hit_count),
    metadata: metadata as Record<string, unknown>,
    createdAt,
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(lastHitAt === undefined ? {} : { lastHitAt }),
    ...(promotedToMemoryId === undefined ? {} : { promotedToMemoryId }),
  });
}

function readQuery(client: unknown): PostgresCandidateReviewQueryClient["query"] {
  if (!client || typeof client !== "object" || nodeUtilTypes.isProxy(client)) throw invalid();
  const descriptor = Object.getOwnPropertyDescriptor(client, "query");
  if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "function") {
    throw invalid();
  }
  return descriptor.value as PostgresCandidateReviewQueryClient["query"];
}

function decodeQueryResult(value: unknown): {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
} {
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value)) throw invalidResult();
  const rowsDescriptor = Object.getOwnPropertyDescriptor(value, "rows");
  const countDescriptor = Object.getOwnPropertyDescriptor(value, "rowCount");
  if (!rowsDescriptor || !("value" in rowsDescriptor) || !Array.isArray(rowsDescriptor.value) ||
      (countDescriptor !== undefined && !("value" in countDescriptor))) throw invalidResult();
  const rowCount = countDescriptor === undefined ? null : countDescriptor.value;
  if (rowCount !== null && (!Number.isSafeInteger(rowCount) || rowCount < 0)) throw invalidResult();
  return Object.freeze({ rows: rowsDescriptor.value, rowCount: rowCount as number | null });
}

function decodeMutationResult(value: unknown): number {
  const result = decodeQueryResult(value);
  const count = result.rowCount ?? result.rows.length;
  if (count !== result.rows.length || result.rows.some((row) => {
    const exact = rowRecord(row, ["id"]);
    return typeof exact.id !== "string" || safeId(exact.id) !== exact.id;
  })) throw invalidResult();
  return count;
}

function decodeTransitionResult(value: unknown): {
  readonly id: string;
  readonly status: CandidateStatus;
  readonly promotedToMemoryId?: string;
  readonly reason?: string;
  readonly changed: boolean;
} | undefined {
  const result = decodeQueryResult(value);
  if (result.rows.length > 1 || (result.rowCount !== null && result.rowCount !== result.rows.length)) {
    throw invalidResult();
  }
  if (result.rows[0] === undefined) return undefined;
  const row = rowRecord(result.rows[0], [
    "id", "status", "promoted_to_memory_id", "status_reason", "changed",
  ]);
  if (typeof row.status !== "string" || !CANDIDATE_STATUSES.has(row.status as CandidateStatus) ||
      typeof row.changed !== "boolean") throw invalidResult();
  const promotedToMemoryId = row.promoted_to_memory_id === null
    ? undefined
    : safeId(row.promoted_to_memory_id);
  const reason = row.status_reason === null ? undefined : safeText(row.status_reason, 2_000);
  return Object.freeze({
    id: safeId(row.id),
    status: row.status as CandidateStatus,
    ...(promotedToMemoryId === undefined ? {} : { promotedToMemoryId }),
    ...(reason === undefined ? {} : { reason }),
    changed: row.changed,
  });
}

function decodeCountResult(value: unknown, keys: readonly string[]): readonly number[] {
  const result = decodeQueryResult(value);
  if (result.rows.length !== 1 || (result.rowCount !== null && result.rowCount !== 1)) throw invalidResult();
  const row = rowRecord(result.rows[0], keys);
  return keys.map((key) => integer(row[key]));
}

function listFilter(value: unknown): {
  readonly scope?: MemoryScope;
  readonly status?: CandidateStatus;
  readonly semanticType?: MemorySemanticType;
  readonly minConfidence?: number;
  readonly limit?: number;
} {
  if (value === undefined) return Object.freeze({});
  const keys = ["scope", "status", "semanticType", "minConfidence", "limit"] as const;
  const record = exactDataRecord(value, keys, []);
  if (record.status !== undefined &&
      (typeof record.status !== "string" || !CANDIDATE_STATUSES.has(record.status as CandidateStatus))) throw invalid();
  if (record.semanticType !== undefined &&
      (typeof record.semanticType !== "string" || !SEMANTIC_TYPES.has(record.semanticType as MemorySemanticType))) {
    throw invalid();
  }
  if (record.minConfidence !== undefined &&
      (typeof record.minConfidence !== "number" || !Number.isFinite(record.minConfidence) ||
        record.minConfidence < 0 || record.minConfidence > 1)) throw invalid();
  if (record.limit !== undefined &&
      (!Number.isSafeInteger(record.limit) || Number(record.limit) < 1 || Number(record.limit) > MAX_LIST_LIMIT)) {
    throw invalid();
  }
  return Object.freeze(record) as ReturnType<typeof listFilter>;
}

function statusMetadata(value: unknown): {
  readonly promotedToMemoryId?: string;
  readonly reason?: string;
} {
  if (value === undefined) return Object.freeze({});
  const record = exactDataRecord(value, ["promotedToMemoryId", "reason"], []);
  if (record.promotedToMemoryId !== undefined) safeId(record.promotedToMemoryId);
  if (record.reason !== undefined &&
      (typeof record.reason !== "string" || record.reason.length > 2_000 ||
        UNSAFE_STRING.test(record.reason) || UNPAIRED_SURROGATE.test(record.reason))) throw invalid();
  return Object.freeze(record) as ReturnType<typeof statusMetadata>;
}

function retentionDays(value: unknown, fallback: number): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || Number(resolved) < 1 || Number(resolved) > 3_650) throw invalid();
  return Number(resolved);
}

export class PostgresBoundCandidateReviewRepository implements ScopeBoundCandidateReviewRepository {
  readonly #client: PostgresCandidateReviewQueryClient;
  readonly #query: PostgresCandidateReviewQueryClient["query"];
  readonly #scope: CanonicalAuthorityScope;
  readonly #publicScope: Readonly<MemoryScope>;
  readonly #assertReady: () => void;
  readonly #now: () => number;

  constructor(options: {
    readonly client: PostgresCandidateReviewQueryClient;
    readonly scope: MemoryScope;
    readonly assertReady?: () => void;
    readonly now?: () => number;
  }) {
    const keys = ["client", "scope", "assertReady", "now"] as const;
    const raw = exactDataRecord(options, keys, ["client", "scope"]);
    this.#query = readQuery(raw.client);
    this.#client = raw.client as PostgresCandidateReviewQueryClient;
    const scopeSnapshot = snapshotScope(raw.scope);
    this.#scope = scopeSnapshot.canonical;
    this.#publicScope = scopeSnapshot.publicScope;
    if (raw.assertReady !== undefined && typeof raw.assertReady !== "function") throw invalid();
    if (raw.now !== undefined && typeof raw.now !== "function") throw invalid();
    this.#assertReady = (raw.assertReady as (() => void) | undefined) ?? (() => undefined);
    this.#now = (raw.now as (() => number) | undefined) ?? Date.now;
  }

  #scopeParams(): readonly string[] {
    return [
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

  #assertBoundScope(value: MemoryScope | undefined): void {
    if (value === undefined) return;
    let candidate: CanonicalAuthorityScope;
    try {
      candidate = snapshotScope(value).canonical;
    } catch {
      throw invalid("Candidate review scope does not match bound scope");
    }
    if (!sameScope(candidate, this.#scope)) throw invalid("Candidate review scope does not match bound scope");
  }

  #timestamp(): number {
    let value: number;
    try {
      value = this.#now();
    } catch {
      throw invalid("Candidate review clock is invalid");
    }
    if (!Number.isSafeInteger(value) || value < 0) throw invalid("Candidate review clock is invalid");
    return value;
  }

  async #run(sql: string, params: readonly unknown[]): Promise<unknown> {
    try {
      this.#assertReady();
    } catch {
      throw new PostgresCandidateReviewRepositoryError(
        "NOT_READY",
        "Candidate review repository is not ready",
      );
    }
    try {
      return await this.#query.call(this.#client, sql, params);
    } catch {
      throw new PostgresCandidateReviewRepositoryError(
        "QUERY_FAILED",
        "Candidate review query failed",
        true,
      );
    }
  }

  async get(idValue: string): Promise<CandidateRecord | undefined> {
    const id = safeId(idValue);
    const result = decodeQueryResult(await this.#run(GET_SQL, [...this.#scopeParams(), id]));
    if (result.rows.length > 1 || (result.rowCount !== null && result.rowCount !== result.rows.length)) {
      throw invalidResult();
    }
    return result.rows[0] === undefined
      ? undefined
      : decodeCandidate(result.rows[0], this.#scope, this.#publicScope);
  }

  async list(filterValue?: Parameters<CandidateRepository["list"]>[0]): Promise<CandidateRecord[]> {
    const filter = listFilter(filterValue);
    this.#assertBoundScope(filter.scope);
    const result = decodeQueryResult(await this.#run(LIST_SQL, [
      ...this.#scopeParams(),
      filter.status ?? null,
      filter.semanticType ?? null,
      filter.minConfidence ?? null,
      filter.limit ?? MAX_LIST_LIMIT,
    ]));
    if (result.rowCount !== null && result.rowCount !== result.rows.length) throw invalidResult();
    return result.rows.map((row) => decodeCandidate(row, this.#scope, this.#publicScope));
  }

  async setStatus(
    idValue: string,
    statusValue: CandidateStatus,
    metadataValue?: { promotedToMemoryId?: string; reason?: string },
  ): Promise<void> {
    const id = safeId(idValue);
    if (typeof statusValue !== "string" || !REVIEW_TARGET_STATUSES.has(statusValue)) throw invalid();
    const metadata = statusMetadata(metadataValue);
    if (metadata.promotedToMemoryId !== undefined && statusValue !== "approved") throw invalid();
    const result = decodeTransitionResult(await this.#run(SET_STATUS_SQL, [
      ...this.#scopeParams(), id, statusValue,
      metadata.promotedToMemoryId ?? null,
      metadata.reason ?? null,
      this.#timestamp(),
    ]));
    if (result === undefined) {
      throw new PostgresCandidateReviewRepositoryError("NOT_FOUND", "Candidate was not found");
    }
    if (result.id !== id || result.status !== statusValue ||
        (metadata.promotedToMemoryId !== undefined &&
          result.promotedToMemoryId !== metadata.promotedToMemoryId) ||
        (metadata.reason !== undefined && result.reason !== metadata.reason)) {
      throw new PostgresCandidateReviewRepositoryError("CONFLICT", "Candidate status transition conflicted");
    }
  }

  async archiveByIds(idsValue: string[], reasonValue?: string): Promise<number> {
    const ids = stringIds(idsValue);
    if (ids.length === 0) return 0;
    const reason = statusMetadata(reasonValue === undefined ? undefined : { reason: reasonValue }).reason;
    return decodeMutationResult(await this.#run(ARCHIVE_SQL, [
      ...this.#scopeParams(), ids, reason ?? null, this.#timestamp(),
    ]));
  }

  async count(filterValue?: Parameters<CandidateRepository["count"]>[0]): Promise<number> {
    if (filterValue !== undefined) {
      const filter = exactDataRecord(filterValue, ["scope", "status"], []);
      this.#assertBoundScope(filter.scope as MemoryScope | undefined);
      if (filter.status !== undefined &&
          (typeof filter.status !== "string" || !CANDIDATE_STATUSES.has(filter.status as CandidateStatus))) {
        throw invalid();
      }
      const [count] = decodeCountResult(await this.#run(COUNT_SQL, [
        ...this.#scopeParams(), filter.status ?? null,
      ]), ["count"]);
      return count!;
    }
    const [count] = decodeCountResult(await this.#run(COUNT_SQL, [
      ...this.#scopeParams(), null,
    ]), ["count"]);
    return count!;
  }

  async deleteByIds(idsValue: string[]): Promise<number> {
    const ids = stringIds(idsValue);
    if (ids.length === 0) return 0;
    return decodeMutationResult(await this.#run(DELETE_EXPIRED_SQL, [...this.#scopeParams(), ids]));
  }

  async runEvictionScan(optionsValue: {
    readonly evictionDays?: number;
    readonly archiveDays?: number;
  } = {}): Promise<{ evicted: number; archived: number }> {
    const options = exactDataRecord(optionsValue, ["evictionDays", "archiveDays"], []);
    const evictionDays = retentionDays(options.evictionDays, DEFAULT_RETENTION_DAYS);
    const archiveDays = retentionDays(options.archiveDays, DEFAULT_RETENTION_DAYS);
    const now = this.#timestamp();
    const archiveCutoff = Math.max(0, now - archiveDays * DAY_MS);
    const evictionCutoff = Math.max(0, now - evictionDays * DAY_MS);
    const [evicted, archived] = decodeCountResult(await this.#run(EVICTION_SQL, [
      ...this.#scopeParams(), archiveCutoff, evictionCutoff, now,
    ]), ["evicted", "archived"]);
    return Object.freeze({ evicted: evicted!, archived: archived! });
  }
}
