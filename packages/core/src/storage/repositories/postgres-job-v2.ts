import { isDeepStrictEqual } from "node:util";

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
}

export interface PostgresDurableJobV2QuarantineUnknownInput {
  readonly scope: DurableJobV2Scope;
  /** 当前 runtime 的完整 handler 集合；必须与 repository 启动配置完全一致。 */
  readonly authoritativeHandlerTypes: readonly string[];
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
  AND status IN ('queued', 'retry_wait')
  AND (status = 'queued' OR next_attempt_at <= $9)
  AND NOT (type = ANY($8::text[]))
  AND attempts < max_attempts
ORDER BY CASE WHEN status = 'queued' THEN created_at ELSE next_attempt_at END ASC,
  created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
        [...scopeParams(scope), [...authoritativeRegistry.types], now],
      );
      const selectedRow = oneRow(
        selected,
        "Postgres durable job orphan quarantine selection returned invalid rows",
      );
      if (!selectedRow) return { applied: 0 };
      const previous = decodeRow(selectedRow);
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

  async lease(input: PostgresDurableJobV2LeaseInput): Promise<PostgresDurableJobV2OperationResult> {
    const scope = canonicalScope(input.scope);
    const now = nowFrom(this.#dependencies.clock);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND type = ANY($8::text[])
  AND attempts < max_attempts
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
        [...scopeParams(scope), [...this.#dependencies.registry.types], now],
      );
      const selectedRow = oneRow(selected, "Postgres durable job lease selection returned invalid rows");
      if (!selectedRow) return { applied: 0 };
      const previous = decodeRow(selectedRow);
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

  async reap(input: { readonly scope: DurableJobV2Scope }): Promise<PostgresDurableJobV2OperationResult> {
    const scope = canonicalScope(input.scope);
    const now = nowFrom(this.#dependencies.clock);
    return this.transaction(async (client) => {
      const selected = await client.query(
        `SELECT ${RETURNING_COLUMNS}
FROM ${JOB_TABLE}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND status = 'running' AND lease_until <= $8 AND attempts >= max_attempts
ORDER BY lease_until ASC, created_at ASC, id ASC
FOR UPDATE SKIP LOCKED
LIMIT 1`,
        [...scopeParams(scope), now],
      );
      const selectedRow = oneRow(selected, "Postgres durable job reap selection returned invalid rows");
      if (!selectedRow) return { applied: 0 };
      const previous = decodeRow(selectedRow);
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
