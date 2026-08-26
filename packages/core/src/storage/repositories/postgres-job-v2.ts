import { isDeepStrictEqual } from "node:util";

import {
  resolveAuthorityScope,
  type AuthorityScope,
  type ClientAuthorityScopeRequest,
} from "../../domain/authority-scope.js";
import type {
  DurableJobHandlerRegistry,
  DurableJobV2,
  DurableJobV2Scope,
  DurableJobV2TransitionResult,
} from "./job-v2.js";
import {
  JobV2ContractError,
  assertDurableJobV2,
  completeDurableJobV2,
  createDurableJobHandlerRegistry,
  createDurableJobV2,
  deriveDurableJobV2ScopedDedupeKey,
  failDurableJobV2,
  isDurableJobV2SafeIdentifier,
  leaseDurableJobV2,
  quarantineUnknownDurableJobV2,
  reapExpiredDurableJobV2,
  renewDurableJobLeaseV2,
} from "./job-v2.js";

export interface PostgresDurableJobV2QueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresDurableJobV2PoolClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresDurableJobV2QueryResult<Row>>;
  release(): void;
}

export interface PostgresDurableJobV2Pool {
  connect(): Promise<PostgresDurableJobV2PoolClient>;
}

export interface PostgresDurableJobV2Dependencies {
  readonly registry: DurableJobHandlerRegistry;
  readonly clock: () => number;
  readonly tokenFactory: () => string;
  readonly backoffMs: (attempts: number) => number;
}

export interface PostgresDurableJobV2OperationResult {
  readonly applied: 0 | 1;
  readonly job?: DurableJobV2;
}

export interface PostgresDurableJobV2EnqueueInput {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string;
  readonly scope: DurableJobV2Scope;
  readonly maxAttempts: number;
}

export interface PostgresDurableJobV2LeaseInput {
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseMs: number;
  readonly idPrefix?: string;
  readonly excludeIdPrefix?: string;
  readonly idAllowlist?: readonly string[];
}

export interface PostgresDurableJobV2ReapInput {
  readonly scope: DurableJobV2Scope;
  readonly idPrefix?: string;
  readonly excludeIdPrefix?: string;
  readonly idAllowlist?: readonly string[];
}

export interface PostgresDurableJobV2QuarantineUnknownInput {
  readonly scope: DurableJobV2Scope;
  /** 当前 runtime 的完整 handler 集合；必须与 repository 启动配置完全一致。 */
  readonly authoritativeHandlerTypes: readonly string[];
  readonly idPrefix?: string;
  readonly excludeIdPrefix?: string;
  readonly idAllowlist?: readonly string[];
}

export interface PostgresDurableJobV2FencedInput {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
}

export interface PostgresDurableJobV2RenewInput extends PostgresDurableJobV2FencedInput {
  readonly leaseMs: number;
}

export interface PostgresDurableJobV2FailInput extends PostgresDurableJobV2FencedInput {
  readonly failure: {
    readonly code: string;
    readonly retryable: boolean;
    readonly message?: string;
  };
}

// 表名是 migration v5 的内部常量；不接受调用方 tableName，杜绝 identifier 注入。
const JOB_TABLE = "mengshu_jobs_v2";
const SCOPE_VALIDATION_KEY = "scope-validation";
const HISTORY_JOB_ID_PREFIX = "history-job:";
const MAX_RUNNABLE_SCOPE_DISCOVERY_LIMIT = 1_000;
const CANONICAL_NON_NEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

const RETURNING_COLUMNS = `id, type, payload, dedupe_key, scoped_dedupe_key,
tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
status, attempts, lease_generation, max_attempts, next_attempt_at,
lease_owner, lease_token, lease_until, heartbeat_at,
last_error_code, last_error_retryable, last_error_fingerprint,
created_at, updated_at`;

function invalidJob(message: string): never {
  throw new JobV2ContractError("INVALID_JOB", message);
}

function idPrefixFilter(
  idPrefix: string | undefined,
  excludeIdPrefix: string | undefined,
): string {
  if (idPrefix !== undefined && excludeIdPrefix !== undefined) {
    invalidJob("Postgres durable job id prefix filters are mutually exclusive");
  }
  const prefix = idPrefix ?? excludeIdPrefix;
  if (prefix === undefined) return "";
  if (prefix !== HISTORY_JOB_ID_PREFIX) {
    invalidJob("Postgres durable job id prefix is invalid");
  }
  return excludeIdPrefix === undefined
    ? "  AND id LIKE 'history-job:%'\n"
    : "  AND id NOT LIKE 'history-job:%'\n";
}

function canonicalIdAllowlist(
  value: readonly string[] | undefined,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    invalidJob("Postgres durable job id allowlist must be a non-empty array");
  }
  const ids = [...value];
  if (ids.some((id) => !isDurableJobV2SafeIdentifier(id))) {
    invalidJob("Postgres durable job id allowlist contains an unsafe identifier");
  }
  if (new Set(ids).size !== ids.length) {
    invalidJob("Postgres durable job id allowlist contains duplicate identifiers");
  }
  return Object.freeze(ids);
}

function idAllowlistFilter(
  idAllowlist: readonly string[] | undefined,
  parameter: number,
  column = "id",
): string {
  return idAllowlist === undefined ? "" : `  AND ${column} = ANY($${parameter}::text[])\n`;
}

function withIdAllowlist(
  params: readonly unknown[],
  idAllowlist: readonly string[] | undefined,
): readonly unknown[] {
  return idAllowlist === undefined ? params : [...params, idAllowlist];
}

function assertIdAllowed(id: string, idAllowlist: readonly string[] | undefined): void {
  if (idAllowlist !== undefined && !idAllowlist.includes(id)) {
    invalidJob("Postgres durable job candidate escaped id allowlist");
  }
}

function canonicalScope(scope: DurableJobV2Scope): DurableJobV2Scope {
  // 复用 job-v2 的 exact-field/plain-object/visibility 验证，再在首次 await 前复制。
  deriveDurableJobV2ScopedDedupeKey(scope, SCOPE_VALIDATION_KEY);
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
  });
}

function authorityRequestSeed(authority: AuthorityScope): ClientAuthorityScopeRequest {
  const allow = authority && typeof authority === "object" && !Array.isArray(authority)
    ? (authority as { readonly allow?: unknown }).allow
    : undefined;
  const candidate = allow && typeof allow === "object" && !Array.isArray(allow)
    ? allow as Record<string, unknown>
    : {};
  const first = (field: string): unknown => {
    const values = candidate[field];
    return Array.isArray(values) ? values[0] : undefined;
  };
  return {
    appId: first("appIds") as string,
    projectId: first("projectIds") as string,
    agentId: first("agentIds") as string,
    namespace: first("namespaces") as string,
    visibility: first("visibilities") as DurableJobV2Scope["visibility"],
  };
}

function canonicalDiscoveryAuthority(authority: AuthorityScope): AuthorityScope {
  const seed = authorityRequestSeed(authority);
  const resolved = resolveAuthorityScope(authority, seed);
  return Object.freeze({
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    ...(resolved.workspaceId === undefined ? {} : { workspaceId: resolved.workspaceId }),
    ...(resolved.sessionId === undefined ? {} : { sessionId: resolved.sessionId }),
    allow: Object.freeze({
      appIds: Object.freeze([...authority.allow.appIds]),
      projectIds: Object.freeze([...authority.allow.projectIds]),
      agentIds: Object.freeze([...authority.allow.agentIds]),
      namespaces: Object.freeze([...authority.allow.namespaces]),
      visibilities: Object.freeze([...authority.allow.visibilities]),
    }),
  });
}

function decodeRunnableScope(
  row: Record<string, unknown>,
  authority: AuthorityScope,
): DurableJobV2Scope {
  const candidate = canonicalScope({
    tenantId: requiredString(row, "tenant_id"),
    userId: requiredString(row, "user_id"),
    appId: requiredString(row, "app_id"),
    projectId: requiredString(row, "project_id"),
    agentId: requiredString(row, "agent_id"),
    namespace: requiredString(row, "namespace"),
    visibility: requiredString(row, "visibility") as DurableJobV2Scope["visibility"],
  });
  const resolved = resolveAuthorityScope(authority, {
    appId: candidate.appId,
    projectId: candidate.projectId,
    agentId: candidate.agentId,
    namespace: candidate.namespace,
    visibility: candidate.visibility,
  });
  const exact = canonicalScope({
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    appId: resolved.appId,
    projectId: resolved.projectId,
    agentId: resolved.agentId,
    namespace: resolved.namespace,
    visibility: resolved.visibility!,
  });
  if (!sameScope(candidate, exact)) {
    invalidJob("Postgres durable job runnable scope escaped authority");
  }
  return exact;
}

function canonicalDiscoveryCursor(
  rawCursor: DurableJobV2Scope,
  authority: AuthorityScope,
): DurableJobV2Scope {
  const cursor = canonicalScope(rawCursor);
  const resolved = resolveAuthorityScope(authority, {
    appId: cursor.appId,
    projectId: cursor.projectId,
    agentId: cursor.agentId,
    namespace: cursor.namespace,
    visibility: cursor.visibility,
  });
  const exact = canonicalScope({
    tenantId: resolved.tenantId,
    userId: resolved.userId,
    appId: resolved.appId,
    projectId: resolved.projectId,
    agentId: resolved.agentId,
    namespace: resolved.namespace,
    visibility: resolved.visibility!,
  });
  if (!sameScope(cursor, exact)) {
    invalidJob("Postgres durable job runnable scope cursor escaped authority");
  }
  return exact;
}

function nowFrom(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) invalidJob("durable job clock is invalid");
  return now;
}

function authoritativeRegistryFor(
  rawTypes: readonly string[],
  configuredRegistry: DurableJobHandlerRegistry,
): DurableJobHandlerRegistry {
  if (!Array.isArray(rawTypes) || rawTypes.length === 0) {
    invalidJob("authoritative durable job handler registry is empty or invalid");
  }
  const authoritativeRegistry = createDurableJobHandlerRegistry(rawTypes);
  if (authoritativeRegistry.types.length !== rawTypes.length ||
      authoritativeRegistry.types.some((type, index) => type !== rawTypes[index])) {
    invalidJob("authoritative durable job handler registry is not canonical");
  }
  const configuredTypes = configuredRegistry?.types;
  if (!Array.isArray(configuredTypes) || configuredTypes.length === 0 ||
      typeof configuredRegistry.isRegistered !== "function" ||
      !isDeepStrictEqual(authoritativeRegistry.types, configuredTypes) ||
      authoritativeRegistry.types.some((type) => !configuredRegistry.isRegistered(type))) {
    invalidJob("authoritative durable job handler registry does not match repository registry");
  }
  return authoritativeRegistry;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") invalidJob(`Postgres durable job row ${key} is invalid`);
  return value;
}

function requiredInteger(row: Record<string, unknown>, key: string): number {
  const raw = row[key];
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && CANONICAL_NON_NEGATIVE_INTEGER.test(raw)
      ? Number(raw)
      : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidJob(`Postgres durable job row ${key} is invalid`);
  }
  return value;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const decoded = typeof value === "number"
    ? value
    : typeof value === "string" && CANONICAL_NON_NEGATIVE_INTEGER.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    invalidJob("Postgres durable job optional time is invalid");
  }
  return decoded;
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") invalidJob("Postgres durable job optional string is invalid");
  return value;
}

function decodePayload(value: unknown): Readonly<Record<string, unknown>> {
  let decoded = value;
  if (typeof value === "string") {
    try {
      decoded = JSON.parse(value) as unknown;
    } catch {
      invalidJob("Postgres durable job payload JSON is invalid");
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    invalidJob("Postgres durable job payload is invalid");
  }
  return decoded as Readonly<Record<string, unknown>>;
}

function decodeRow(row: Record<string, unknown>): DurableJobV2 {
  const nextAttemptAt = optionalInteger(row.next_attempt_at);
  const leaseOwner = optionalString(row.lease_owner);
  const leaseToken = optionalString(row.lease_token);
  const leaseUntil = optionalInteger(row.lease_until);
  const heartbeatAt = optionalInteger(row.heartbeat_at);
  const errorCode = optionalString(row.last_error_code);
  const errorRetryable = row.last_error_retryable;
  const errorFingerprint = optionalString(row.last_error_fingerprint);
  const lastError = errorCode === undefined && errorRetryable == null && errorFingerprint === undefined
    ? undefined
    : {
        code: errorCode ?? "",
        retryable: typeof errorRetryable === "boolean" ? errorRetryable : false,
        fingerprint: errorFingerprint ?? "",
      };
  const job: DurableJobV2 = {
    id: requiredString(row, "id"),
    type: requiredString(row, "type"),
    payload: decodePayload(row.payload),
    dedupeKey: requiredString(row, "dedupe_key"),
    scopedDedupeKey: requiredString(row, "scoped_dedupe_key"),
    scope: {
      tenantId: requiredString(row, "tenant_id"),
      userId: requiredString(row, "user_id"),
      appId: requiredString(row, "app_id"),
      projectId: requiredString(row, "project_id"),
      agentId: requiredString(row, "agent_id"),
      namespace: requiredString(row, "namespace"),
      visibility: requiredString(row, "visibility") as DurableJobV2Scope["visibility"],
    },
    status: requiredString(row, "status") as DurableJobV2["status"],
    attempts: requiredInteger(row, "attempts"),
    leaseGeneration: requiredInteger(row, "lease_generation"),
    maxAttempts: requiredInteger(row, "max_attempts"),
    ...(nextAttemptAt === undefined ? {} : { nextAttemptAt }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(leaseToken === undefined ? {} : { leaseToken }),
    ...(leaseUntil === undefined ? {} : { leaseUntil }),
    ...(heartbeatAt === undefined ? {} : { heartbeatAt }),
    ...(lastError === undefined ? {} : { lastError }),
    createdAt: requiredInteger(row, "created_at"),
    updatedAt: requiredInteger(row, "updated_at"),
  };
  assertDurableJobV2(job);
  return Object.freeze({
    ...job,
    payload: deepFreezeJson(job.payload),
    scope: Object.freeze({ ...job.scope }),
    ...(job.lastError ? { lastError: Object.freeze({ ...job.lastError }) } : {}),
  });
}

function deepFreezeJson<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function scopeParams(scope: DurableJobV2Scope): readonly unknown[] {
  return [
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
  ];
}

function sameScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return left.tenantId === right.tenantId &&
    left.userId === right.userId &&
    left.appId === right.appId &&
    left.projectId === right.projectId &&
    left.agentId === right.agentId &&
    left.namespace === right.namespace &&
    left.visibility === right.visibility;
}

function assertEnqueueIdentity(actual: DurableJobV2, expected: DurableJobV2): void {
  if (actual.type !== expected.type ||
      !isDeepStrictEqual(actual.payload, expected.payload) ||
      actual.maxAttempts !== expected.maxAttempts ||
      actual.dedupeKey !== expected.dedupeKey ||
      actual.scopedDedupeKey !== expected.scopedDedupeKey ||
      !sameScope(actual.scope, expected.scope)) {
    invalidJob("Postgres durable job dedupe collision identity mismatch");
  }
}

function assertInsertedJobEquivalent(actual: DurableJobV2, expected: DurableJobV2): void {
  assertEnqueueIdentity(actual, expected);
  if (actual.id !== expected.id || actual.status !== expected.status ||
      actual.attempts !== expected.attempts ||
      actual.leaseGeneration !== expected.leaseGeneration ||
      actual.nextAttemptAt !== expected.nextAttemptAt ||
      actual.leaseOwner !== expected.leaseOwner || actual.leaseToken !== expected.leaseToken ||
      actual.leaseUntil !== expected.leaseUntil || actual.heartbeatAt !== expected.heartbeatAt ||
      !isDeepStrictEqual(actual.lastError, expected.lastError) ||
      actual.createdAt !== expected.createdAt || actual.updatedAt !== expected.updatedAt) {
    invalidJob("Postgres durable job INSERT returned a different queued command");
  }
}

function oneRow(
  result: PostgresDurableJobV2QueryResult,
  message: string,
): Record<string, unknown> | undefined {
  const rowCount = result.rowCount ?? result.rows.length;
  if (rowCount === 0 && result.rows.length === 0) return undefined;
  if (rowCount !== 1 || result.rows.length !== 1) invalidJob(message);
  return result.rows[0];
}

function stateParams(job: DurableJobV2): readonly unknown[] {
  return [
    job.status,
    job.attempts,
    job.leaseGeneration,
    job.nextAttemptAt ?? null,
    job.leaseOwner ?? null,
    job.leaseToken ?? null,
    job.leaseUntil ?? null,
    job.heartbeatAt ?? null,
    job.lastError?.code ?? null,
    job.lastError?.retryable ?? null,
    job.lastError?.fingerprint ?? null,
    job.updatedAt,
  ];
}

export class PostgresDurableJobV2Repository {
  readonly #pool: PostgresDurableJobV2Pool;
  readonly #dependencies: PostgresDurableJobV2Dependencies;

  constructor(
    pool: PostgresDurableJobV2Pool,
    dependencies: PostgresDurableJobV2Dependencies,
  ) {
    this.#pool = pool;
    this.#dependencies = dependencies;
  }

  async listRunnableScopes(
    rawAuthority: AuthorityScope,
    limit: number,
    after?: DurableJobV2Scope,
  ): Promise<readonly DurableJobV2Scope[]> {
    const authority = canonicalDiscoveryAuthority(rawAuthority);
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_RUNNABLE_SCOPE_DISCOVERY_LIMIT) {
      invalidJob("Postgres durable job runnable scope limit is invalid");
    }
    const cursor = after === undefined ? undefined : canonicalDiscoveryCursor(after, authority);
    const now = nowFrom(this.#dependencies.clock);
    const client = await this.#pool.connect();
    let queryResult: PostgresDurableJobV2QueryResult | undefined;
    let failure: unknown;
    try {
      queryResult = await client.query(
        `SELECT tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
FROM (
  SELECT tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
    MIN(CASE
      WHEN status = 'queued' THEN created_at
      WHEN status = 'retry_wait' THEN next_attempt_at
      ELSE lease_until
    END) AS runnable_at
  FROM ${JOB_TABLE}
  WHERE tenant_id = $1 AND user_id = $2
    AND app_id = ANY($3::text[])
    AND project_id = ANY($4::text[])
    AND agent_id = ANY($5::text[])
    AND namespace = ANY($6::text[])
    AND visibility = ANY($7::text[])
    AND id NOT LIKE $8
    AND (
      (status = 'queued' AND attempts < max_attempts)
      OR (status = 'retry_wait' AND attempts < max_attempts AND next_attempt_at <= $9)
      OR (status = 'running' AND lease_until <= $9)
    )
  GROUP BY tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility
) AS runnable_scopes
ORDER BY CASE WHEN $10::text IS NULL OR
    ROW(app_id, project_id, agent_id, namespace, visibility) >
    ROW($10::text, $11::text, $12::text, $13::text, $14::text)
  THEN 0 ELSE 1 END,
  app_id ASC, project_id ASC, agent_id ASC, namespace ASC, visibility ASC
LIMIT $15`,
        [
          authority.tenantId,
          authority.userId,
          [...authority.allow.appIds],
          [...authority.allow.projectIds],
          [...authority.allow.agentIds],
          [...authority.allow.namespaces],
          [...authority.allow.visibilities],
          `${HISTORY_JOB_ID_PREFIX}%`,
          now,
          cursor?.appId ?? null,
          cursor?.projectId ?? null,
          cursor?.agentId ?? null,
          cursor?.namespace ?? null,
          cursor?.visibility ?? null,
          limit,
        ],
      );
    } catch (error) {
      failure = error;
    }
    try {
      client.release();
    } catch (releaseFailure) {
      failure = failure
        ? new AggregateError(
            [failure, releaseFailure],
            "Postgres durable job runnable scope query and release both failed",
          )
        : releaseFailure;
    }
    if (failure) throw failure;
    if (!queryResult || !Array.isArray(queryResult.rows)) {
      invalidJob("Postgres durable job runnable scope query returned invalid rows");
    }
    const rowCount = queryResult.rowCount ?? queryResult.rows.length;
    if (!Number.isSafeInteger(rowCount) || rowCount !== queryResult.rows.length || rowCount > limit) {
      invalidJob("Postgres durable job runnable scope query returned invalid row count");
    }
    const scopes: DurableJobV2Scope[] = [];
    const seen = new Set<string>();
    for (const row of queryResult.rows) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        invalidJob("Postgres durable job runnable scope row is invalid");
      }
      const exact = decodeRunnableScope(row, authority);
      const key = deriveDurableJobV2ScopedDedupeKey(exact, SCOPE_VALIDATION_KEY);
      if (seen.has(key)) {
        invalidJob("Postgres durable job runnable scope query returned duplicate scopes");
      }
      seen.add(key);
      scopes.push(exact);
    }
    return Object.freeze(scopes);
  }

  async enqueue(input: PostgresDurableJobV2EnqueueInput): Promise<DurableJobV2> {
    // 完整纯合同验证必须先于 connect，未注册 handler 不得触碰数据库。
    const expected = createDurableJobV2(input, {
      registry: this.#dependencies.registry,
      now: nowFrom(this.#dependencies.clock),
    });
    return this.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO ${JOB_TABLE} (
id, type, payload, dedupe_key, scoped_dedupe_key,
tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility,
status, attempts, lease_generation, max_attempts, created_at, updated_at
) VALUES (
$1, $2, $3::jsonb, $4, $5,
$6, $7, $8, $9, $10, $11, $12,
$13, $14, $15, $16, $17, $18
) ON CONFLICT (scoped_dedupe_key) DO NOTHING
RETURNING ${RETURNING_COLUMNS}`,
        [
          expected.id,
          expected.type,
          JSON.stringify(expected.payload),
          expected.dedupeKey,
          expected.scopedDedupeKey,
          ...scopeParams(expected.scope),
          expected.status,
          expected.attempts,
          expected.leaseGeneration,
          expected.maxAttempts,
          expected.createdAt,
          expected.updatedAt,
        ],
      );
      const insertedRow = oneRow(inserted, "Postgres durable job INSERT returned invalid rows");
      if (insertedRow) {
        const job = decodeRow(insertedRow);
        assertInsertedJobEquivalent(job, expected);
        return job;
      }

      const existing = await client.query(
        `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE scoped_dedupe_key = $1
FOR SHARE`,
        [expected.scopedDedupeKey],
      );
      const existingRow = oneRow(existing, "Postgres durable job conflict row is missing or ambiguous");
      if (!existingRow) invalidJob("Postgres durable job conflict row is missing");
      const job = decodeRow(existingRow);
      assertEnqueueIdentity(job, expected);
      return job;
    });
  }

  async quarantineUnknown(
    input: PostgresDurableJobV2QuarantineUnknownInput,
  ): Promise<PostgresDurableJobV2OperationResult> {
    const cohortFilter = idPrefixFilter(input.idPrefix, input.excludeIdPrefix);
    const idAllowlist = canonicalIdAllowlist(input.idAllowlist);
    const allowlistFilter = idAllowlistFilter(idAllowlist, 10);
    const scope = canonicalScope(input.scope);
    // 在 connect 前验证“完整且与 repository 一致”，partial worker pool 子集不得触碰 DB。
    const authoritativeRegistry = authoritativeRegistryFor(
      input.authoritativeHandlerTypes,
      this.#dependencies.registry,
    );
    const now = nowFrom(this.#dependencies.clock);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
${cohortFilter}${allowlistFilter}  AND status IN ('queued', 'retry_wait')
  AND (status = 'queued' OR next_attempt_at <= $9)
  AND NOT (type = ANY($8::text[]))
  AND attempts < max_attempts
ORDER BY CASE WHEN status = 'queued' THEN created_at ELSE next_attempt_at END ASC,
  created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
        withIdAllowlist(
          [...scopeParams(scope), [...authoritativeRegistry.types], now],
          idAllowlist,
        ),
      );
      const selectedRow = oneRow(
        selected,
        "Postgres durable job orphan quarantine selection returned invalid rows",
      );
      if (!selectedRow) return { applied: 0 };
      const previous = decodeRow(selectedRow);
      assertIdAllowed(previous.id, idAllowlist);
      const due = previous.status === "queued" ||
        (previous.status === "retry_wait" && previous.nextAttemptAt! <= now);
      if (!sameScope(previous.scope, scope) || !due ||
          authoritativeRegistry.isRegistered(previous.type)) {
        invalidJob("Postgres durable job quarantine candidate escaped authoritative constraints");
      }
      const transition = quarantineUnknownDurableJobV2(previous, {
        authoritativeRegistry,
        now,
      });
      if (transition.applied === 0) {
        invalidJob("Postgres durable job quarantine candidate was not eligible");
      }
      return this.applyLeaseCas(client, previous, transition.job, now);
    });
  }

  lease(input: PostgresDurableJobV2LeaseInput): Promise<PostgresDurableJobV2OperationResult> {
    const cohortFilter = idPrefixFilter(input.idPrefix, input.excludeIdPrefix);
    const idAllowlist = canonicalIdAllowlist(input.idAllowlist);
    const allowlistFilter = idAllowlistFilter(idAllowlist, 10);
    const historyLeafAllowlistFilter = idAllowlistFilter(
      idAllowlist,
      10,
      "history_leaf.id",
    );
    return Promise.resolve().then(() => {
      const scope = canonicalScope(input.scope);
      const now = nowFrom(this.#dependencies.clock);
      return this.transaction(async (client) => {
        const ordinaryLeaseSql = `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
${cohortFilter}${allowlistFilter}  AND type = ANY($8::text[])
  AND attempts < max_attempts
  AND (
    status = 'queued'
    OR (status = 'retry_wait' AND next_attempt_at <= $9)
    OR (status = 'running' AND lease_until <= $9)
  )
  AND NOT (
    type = 'build_tree'
    AND id LIKE 'history-job:%'
    AND payload#>>'{finalize,mode}' = 'history_rebuild'
    AND EXISTS (
      SELECT 1 FROM mengshu_jobs_v2 AS history_leaf
      WHERE history_leaf.tenant_id = mengshu_jobs_v2.tenant_id
        AND history_leaf.user_id = mengshu_jobs_v2.user_id
        AND history_leaf.app_id = mengshu_jobs_v2.app_id
        AND history_leaf.project_id = mengshu_jobs_v2.project_id
        AND history_leaf.agent_id = mengshu_jobs_v2.agent_id
        AND history_leaf.namespace = mengshu_jobs_v2.namespace
        AND history_leaf.visibility = mengshu_jobs_v2.visibility
        AND history_leaf.id <> mengshu_jobs_v2.id
        AND history_leaf.id LIKE 'history-job:%'
${historyLeafAllowlistFilter}        AND history_leaf.type = 'build_tree'
        AND history_leaf.payload ? 'leaf'
        AND history_leaf.payload->>'treeType' = mengshu_jobs_v2.payload->>'treeType'
        AND history_leaf.payload->>'treeKey' = mengshu_jobs_v2.payload->>'treeKey'
        AND COALESCE(history_leaf.payload#>>'{scope,workspaceId}', '') =
          COALESCE(mengshu_jobs_v2.payload#>>'{scope,workspaceId}', '')
        AND COALESCE(history_leaf.payload#>>'{scope,sessionId}', '') =
          COALESCE(mengshu_jobs_v2.payload#>>'{scope,sessionId}', '')
        AND (history_leaf.status <> 'completed' OR NOT EXISTS (
          SELECT 1 FROM mengshu_job_v2_effect_receipts AS leaf_receipt
          WHERE leaf_receipt.job_id = history_leaf.id
            AND leaf_receipt.effect_key = 'build_tree.persist.v1'
        ))
    )
  )
ORDER BY CASE
  WHEN status = 'queued' THEN created_at
  WHEN status = 'retry_wait' THEN next_attempt_at
  ELSE lease_until
END ASC, created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`;
        const params = withIdAllowlist(
          [...scopeParams(scope), [...this.#dependencies.registry.types], now],
          idAllowlist,
        );
        let selected;
        if (input.idPrefix === HISTORY_JOB_ID_PREFIX) {
          selected = await client.query(
            `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND id LIKE 'history-job:%'
${allowlistFilter}  AND type = ANY($8::text[])
  AND attempts < max_attempts AND payload ? 'leaf'
  AND (
    status = 'queued'
    OR (status = 'retry_wait' AND next_attempt_at <= $9)
    OR (status = 'running' AND lease_until <= $9)
  )
ORDER BY CASE
  WHEN status = 'queued' THEN created_at
  WHEN status = 'retry_wait' THEN next_attempt_at
  ELSE lease_until
END ASC, created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
            params,
          );
          let selectedRow = oneRow(
            selected,
            "Postgres durable job history leaf lease selection returned invalid rows",
          );
          if (!selectedRow) {
            selected = await client.query(
              `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND id LIKE 'history-job:%'
${allowlistFilter}  AND type = ANY($8::text[])
  AND attempts < max_attempts
  AND payload#>>'{finalize,mode}' = 'history_rebuild'
  AND (
    status = 'queued'
    OR (status = 'retry_wait' AND next_attempt_at <= $9)
    OR (status = 'running' AND lease_until <= $9)
  )
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_jobs_v2 AS history_leaf
    WHERE history_leaf.tenant_id = $1 AND history_leaf.user_id = $2
      AND history_leaf.app_id = $3 AND history_leaf.project_id = $4
      AND history_leaf.agent_id = $5 AND history_leaf.namespace = $6
      AND history_leaf.visibility = $7 AND history_leaf.id LIKE 'history-job:%'
${historyLeafAllowlistFilter}      AND history_leaf.type = 'build_tree' AND history_leaf.payload ? 'leaf'
      AND (history_leaf.status <> 'completed' OR NOT EXISTS (
        SELECT 1 FROM mengshu_job_v2_effect_receipts AS leaf_receipt
        WHERE leaf_receipt.job_id = history_leaf.id
          AND leaf_receipt.effect_key = 'build_tree.persist.v1'
      ))
  )
ORDER BY CASE
  WHEN status = 'queued' THEN created_at
  WHEN status = 'retry_wait' THEN next_attempt_at
  ELSE lease_until
END ASC, created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
              params,
            );
            selectedRow = oneRow(
              selected,
              "Postgres durable job history finalize lease selection returned invalid rows",
            );
          }
          if (!selectedRow) return { applied: 0 };
        } else {
          selected = await client.query(ordinaryLeaseSql, params);
        }
        const selectedRow = oneRow(
          selected,
          "Postgres durable job lease selection returned invalid rows",
        );
        if (!selectedRow) return { applied: 0 };
        const previous = decodeRow(selectedRow);
        assertIdAllowed(previous.id, idAllowlist);
        if (!sameScope(previous.scope, scope) ||
            !this.#dependencies.registry.isRegistered(previous.type)) {
          invalidJob("Postgres durable job lease candidate escaped scope or handler registry");
        }
        const transition = leaseDurableJobV2(previous, {
          owner: input.owner,
          now,
          leaseMs: input.leaseMs,
          tokenFactory: this.#dependencies.tokenFactory,
        });
        if (transition.applied === 0) return { applied: 0, job: previous };
        return this.applyLeaseCas(client, previous, transition.job, now);
      });
    });
  }

  async renew(input: PostgresDurableJobV2RenewInput): Promise<PostgresDurableJobV2OperationResult> {
    return this.fencedTransition(input, (job, now) => renewDurableJobLeaseV2(job, {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      now,
      leaseMs: input.leaseMs,
    }));
  }

  async complete(input: PostgresDurableJobV2FencedInput): Promise<PostgresDurableJobV2OperationResult> {
    return this.fencedTransition(input, (job, now) => completeDurableJobV2(job, {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      now,
    }));
  }

  async fail(input: PostgresDurableJobV2FailInput): Promise<PostgresDurableJobV2OperationResult> {
    return this.fencedTransition(input, (job, now) => failDurableJobV2(job, {
      owner: input.owner,
      leaseToken: input.leaseToken,
      leaseGeneration: input.leaseGeneration,
      now,
      failure: input.failure,
      backoffMs: this.#dependencies.backoffMs,
    }));
  }

  reap(input: PostgresDurableJobV2ReapInput): Promise<PostgresDurableJobV2OperationResult> {
    const cohortFilter = idPrefixFilter(input.idPrefix, input.excludeIdPrefix);
    const idAllowlist = canonicalIdAllowlist(input.idAllowlist);
    const allowlistFilter = idAllowlistFilter(idAllowlist, 9);
    return Promise.resolve().then(() => {
      const scope = canonicalScope(input.scope);
      const now = nowFrom(this.#dependencies.clock);
      return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
${cohortFilter}${allowlistFilter}  AND status = 'running' AND lease_until <= $8 AND attempts >= max_attempts
ORDER BY lease_until ASC, created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
        withIdAllowlist([...scopeParams(scope), now], idAllowlist),
      );
      const selectedRow = oneRow(selected, "Postgres durable job reap selection returned invalid rows");
      if (!selectedRow) return { applied: 0 };
      const previous = decodeRow(selectedRow);
      assertIdAllowed(previous.id, idAllowlist);
      if (!sameScope(previous.scope, scope)) {
        invalidJob("Postgres durable job reap candidate escaped scope");
      }
      const transition = reapExpiredDurableJobV2(previous, { now });
      if (transition.applied === 0) return { applied: 0, job: previous };
      const updated = await client.query(
        this.fencedUpdateSql("lease_until <= $25"),
        [
          ...stateParams(transition.job),
          previous.id,
          ...scopeParams(scope),
          previous.scopedDedupeKey,
          previous.leaseOwner,
          previous.leaseToken,
          previous.leaseGeneration,
          now,
          previous.updatedAt,
          previous.leaseUntil,
        ],
      );
      return this.decodeCasResult(updated, previous, transition.job);
      });
    });
  }

  private async fencedTransition(
    input: PostgresDurableJobV2FencedInput,
    transition: (job: DurableJobV2, now: number) => DurableJobV2TransitionResult,
  ): Promise<PostgresDurableJobV2OperationResult> {
    const scope = canonicalScope(input.scope);
    const now = nowFrom(this.#dependencies.clock);
    return this.transaction(async (client) => {
      const selected = await this.selectByIdForUpdate(client, input.id, scope);
      if (!selected) return { applied: 0 };
      const result = transition(selected, now);
      if (result.applied === 0) return { applied: 0, job: selected };
      const updated = await client.query(
        this.fencedUpdateSql("lease_until > $25"),
        [
          ...stateParams(result.job),
          selected.id,
          ...scopeParams(scope),
          selected.scopedDedupeKey,
          input.owner,
          input.leaseToken,
          input.leaseGeneration,
          now,
          selected.updatedAt,
          selected.leaseUntil,
        ],
      );
      return this.decodeCasResult(updated, selected, result.job);
    });
  }

  private async selectByIdForUpdate(
    client: PostgresDurableJobV2PoolClient,
    id: string,
    scope: DurableJobV2Scope,
  ): Promise<DurableJobV2 | undefined> {
    const selected = await client.query(
      `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND app_id = $4
  AND project_id = $5 AND agent_id = $6 AND namespace = $7 AND visibility = $8
FOR UPDATE`,
      [id, ...scopeParams(scope)],
    );
    const row = oneRow(selected, "Postgres durable job fenced selection returned invalid rows");
    if (!row) return undefined;
    const job = decodeRow(row);
    if (!sameScope(job.scope, scope)) invalidJob("Postgres durable job fenced candidate escaped scope");
    return job;
  }

  private async applyLeaseCas(
    client: PostgresDurableJobV2PoolClient,
    previous: DurableJobV2,
    next: DurableJobV2,
    now: number,
  ): Promise<PostgresDurableJobV2OperationResult> {
    const updated = await client.query(
      `UPDATE ${JOB_TABLE}
SET status = $1, attempts = $2, lease_generation = $3, next_attempt_at = $4,
    lease_owner = $5, lease_token = $6, lease_until = $7, heartbeat_at = $8,
    last_error_code = $9, last_error_retryable = $10, last_error_fingerprint = $11,
    updated_at = $12
WHERE id = $13
  AND tenant_id = $14 AND user_id = $15 AND app_id = $16 AND project_id = $17
  AND agent_id = $18 AND namespace = $19 AND visibility = $20
  AND scoped_dedupe_key = $21
  AND status = $22 AND attempts = $23 AND lease_generation = $24 AND updated_at = $25
  AND ($22 <> 'running' OR (lease_until <= $26 AND lease_token <> $6))
RETURNING ${RETURNING_COLUMNS}`,
      [
        ...stateParams(next),
        previous.id,
        ...scopeParams(previous.scope),
        previous.scopedDedupeKey,
        previous.status,
        previous.attempts,
        previous.leaseGeneration,
        previous.updatedAt,
        now,
      ],
    );
    return this.decodeCasResult(updated, previous, next);
  }

  private fencedUpdateSql(expiryPredicate: string): string {
    return `UPDATE ${JOB_TABLE}
SET status = $1, attempts = $2, lease_generation = $3, next_attempt_at = $4,
    lease_owner = $5, lease_token = $6, lease_until = $7, heartbeat_at = $8,
    last_error_code = $9, last_error_retryable = $10, last_error_fingerprint = $11,
    updated_at = $12
WHERE id = $13
  AND tenant_id = $14 AND user_id = $15 AND app_id = $16 AND project_id = $17
  AND agent_id = $18 AND namespace = $19 AND visibility = $20
  AND scoped_dedupe_key = $21
  AND status = 'running'
  AND lease_owner = $22 AND lease_token = $23 AND lease_generation = $24
  AND ${expiryPredicate} AND updated_at <= $25 AND updated_at = $26
  AND lease_until = $27
RETURNING ${RETURNING_COLUMNS}`;
  }

  private decodeCasResult(
    result: PostgresDurableJobV2QueryResult,
    previous: DurableJobV2,
    expected: DurableJobV2,
  ): PostgresDurableJobV2OperationResult {
    const row = oneRow(result, "Postgres durable job CAS returned invalid rows");
    if (!row) return { applied: 0, job: previous };
    const actual = decodeRow(row);
    if (actual.id !== previous.id || actual.type !== previous.type ||
        actual.dedupeKey !== previous.dedupeKey ||
        actual.scopedDedupeKey !== previous.scopedDedupeKey ||
        !sameScope(actual.scope, previous.scope) ||
        !isDeepStrictEqual(actual.payload, previous.payload)) {
      invalidJob("Postgres durable job CAS changed immutable identity");
    }
    if (actual.status !== expected.status || actual.attempts !== expected.attempts ||
        actual.leaseGeneration !== expected.leaseGeneration ||
        actual.nextAttemptAt !== expected.nextAttemptAt ||
        actual.leaseOwner !== expected.leaseOwner || actual.leaseToken !== expected.leaseToken ||
        actual.leaseUntil !== expected.leaseUntil || actual.heartbeatAt !== expected.heartbeatAt ||
        actual.updatedAt !== expected.updatedAt ||
        !isDeepStrictEqual(actual.lastError, expected.lastError)) {
      invalidJob("Postgres durable job CAS returned an unexpected state");
    }
    return { applied: 1, job: actual };
  }

  private async transaction<T>(
    work: (client: PostgresDurableJobV2PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.#pool.connect();
    let result: T | undefined;
    let failure: unknown;
    let begun = false;
    let committed = false;
    try {
      await client.query("BEGIN");
      begun = true;
      result = await work(client);
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      failure = error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackFailure) {
          failure = new AggregateError(
            [failure, rollbackFailure],
            "Postgres durable job transaction and rollback both failed",
          );
        }
      }
    }
    try {
      client.release();
    } catch (releaseFailure) {
      failure = failure
        ? new AggregateError(
            [failure, releaseFailure],
            "Postgres durable job transaction and release both failed",
          )
        : releaseFailure;
    }
    if (failure) throw failure;
    return result as T;
  }
}
