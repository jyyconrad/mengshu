import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import type { DurableJobV2Scope } from "./job-v2.js";
import {
  deriveDurableJobV2ScopedDedupeKey,
  isDurableJobV2SafeIdentifier,
} from "./job-v2.js";

const JOB_TABLE = "mengshu_jobs_v2";
const RECEIPT_TABLE = "mengshu_job_v2_effect_receipts";
const ID = /^[^\s\p{Cc}]{1,256}$/u;
const OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const EFFECT_KEY = /^[a-z][a-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const RELATION_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CANDIDATE_RELATION = "mengshu_candidates";
const MAX_PENDING_CANDIDATES_PER_SESSION = 50;
const PROVIDER_OWNED_DOMAIN_EFFECT_AUTHORITY = Object.freeze({});

export interface PostgresDurableJobV2EffectQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: readonly Row[];
  readonly rowCount?: number | null;
}

export interface PostgresDurableJobV2EffectClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresDurableJobV2EffectQueryResult<Row>>;
  release(): void;
}

export interface PostgresDurableJobV2EffectPool {
  connect(): Promise<PostgresDurableJobV2EffectClient>;
}

export interface PostgresDurableJobV2EffectWorkClient {
  /** 该 query 始终运行在 job fence 与 receipt 所在的同一个 PostgreSQL 事务中。 */
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresDurableJobV2EffectQueryResult<Row>>;
}

export interface PostgresPendingCandidateCapacityContext {
  readonly workspaceId?: string;
  readonly sessionId?: string;
}

export interface PostgresPendingCandidateCapacityExecution {
  readonly context: PostgresPendingCandidateCapacityContext;
  readonly requestedCount: number;
}

export interface PostgresPendingCandidateCapacityReservation {
  readonly max: 50;
  readonly pendingCount: number;
  readonly remaining: number;
}

/** Narrow grammar capability for one domain relation's idempotent INSERT. */
export interface PostgresInsertOnConflictPolicy {
  readonly relation: string;
  /** Exact, ordered PostgreSQL conflict target; expressions/predicates are never allowed. */
  readonly conflictColumns: readonly string[];
  /** Optional exact, ordered simple-column RETURNING projection. Omission remains allowed. */
  readonly returningColumns?: readonly string[];
  /** Exact built-in casts allowed at the VALUES position for the named insert column. */
  readonly valueCasts?: readonly PostgresInsertValueCastPolicy[];
}

export interface PostgresInsertValueCastPolicy {
  readonly column: string;
  readonly type: "jsonb";
}

export interface PostgresDurableJobV2EffectInput {
  readonly id: string;
  readonly scope: DurableJobV2Scope;
  readonly owner: string;
  readonly leaseToken: string;
  readonly leaseGeneration: number;
  /** 同一 job 内稳定的逻辑副作用名；重试不得改变。 */
  readonly effectKey: string;
  /** 对副作用输入做 canonical JSON 后计算的 SHA-256。 */
  readonly requestFingerprint: string;
}

export interface PostgresDurableJobV2EffectReceipt<Result extends Record<string, unknown>> {
  readonly jobId: string;
  readonly effectKey: string;
  readonly requestFingerprint: string;
  /** 首次提交副作用的 generation；后续 generation replay 时保持不变。 */
  readonly leaseGeneration: number;
  readonly result: Result;
  readonly committedAt: number;
}

export type PostgresDurableJobV2EffectResult<Result extends Record<string, unknown>> =
  | { readonly status: "applied" | "replayed"; readonly receipt: PostgresDurableJobV2EffectReceipt<Result> }
  | { readonly status: "stale" };

export class PostgresDurableJobV2EffectError extends Error {
  readonly code:
    | "DURABLE_JOB_EFFECT_INVALID_INPUT"
    | "DURABLE_JOB_EFFECT_INVALID_RESULT"
    | "DURABLE_JOB_EFFECT_INVALID_RECEIPT"
    | "DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH"
    | "DURABLE_JOB_EFFECT_LEASE_LOST"
    | "DURABLE_JOB_EFFECT_CAPACITY_UNAVAILABLE"
    | "DURABLE_JOB_EFFECT_CAPACITY_EXCEEDED"
    | "DURABLE_JOB_EFFECT_UNSAFE_SQL"
    | "DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN"
    | "DURABLE_JOB_EFFECT_RELEASE_FAILED";
  readonly retryable: boolean;

  constructor(code: PostgresDurableJobV2EffectError["code"], message: string) {
    super(message);
    this.name = "PostgresDurableJobV2EffectError";
    this.code = code;
    this.retryable = code === "DURABLE_JOB_EFFECT_LEASE_LOST" ||
      code === "DURABLE_JOB_EFFECT_CAPACITY_UNAVAILABLE" ||
      code === "DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN" ||
      code === "DURABLE_JOB_EFFECT_RELEASE_FAILED";
  }
}

function effectError(
  code: PostgresDurableJobV2EffectError["code"],
  message: string,
): never {
  throw new PostgresDurableJobV2EffectError(code, message);
}

function canonicalScope(scope: DurableJobV2Scope): DurableJobV2Scope {
  try {
    deriveDurableJobV2ScopedDedupeKey(scope, "effect-scope-validation");
  } catch {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect scope is invalid");
  }
  return Object.freeze({ ...scope });
}

function validateInput(input: PostgresDurableJobV2EffectInput): PostgresDurableJobV2EffectInput {
  const scope = canonicalScope(input.scope);
  if (!ID.test(input.id) || !OWNER.test(input.owner) || !LEASE_TOKEN.test(input.leaseToken) ||
      !Number.isSafeInteger(input.leaseGeneration) || input.leaseGeneration < 1 ||
      !EFFECT_KEY.test(input.effectKey) || !SHA256.test(input.requestFingerprint)) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect input is invalid");
  }
  return Object.freeze({ ...input, scope });
}

function nowFrom(clock: () => number): number {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect clock is invalid");
  }
  return now;
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

function canonicalCapacityExecution(
  value: unknown,
): Readonly<PostgresPendingCandidateCapacityExecution> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity execution is invalid");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || !keys.includes("context") || !keys.includes("requestedCount") ||
      keys.some((key) => typeof key !== "string" ||
        (key !== "context" && key !== "requestedCount"))) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity execution is invalid");
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity execution is invalid");
    }
    snapshot[key] = descriptor.value;
  }
  const context = snapshot.context;
  if (!context || typeof context !== "object" || Array.isArray(context) ||
      nodeUtilTypes.isProxy(context) || Object.getPrototypeOf(context) !== Object.prototype) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity context is invalid");
  }
  const contextKeys = Reflect.ownKeys(context);
  if (contextKeys.some((key) => typeof key !== "string" ||
      (key !== "workspaceId" && key !== "sessionId"))) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity context is invalid");
  }
  const contextSnapshot = Object.create(null) as Record<string, unknown>;
  for (const key of contextKeys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(context, key);
    if (!descriptor?.enumerable || !("value" in descriptor) ||
        !isDurableJobV2SafeIdentifier(descriptor.value)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity context is invalid");
    }
    contextSnapshot[key] = descriptor.value;
  }
  if (!Number.isSafeInteger(snapshot.requestedCount) || Number(snapshot.requestedCount) < 0) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity execution is invalid");
  }
  return Object.freeze({
    context: Object.freeze({
      ...(contextSnapshot.workspaceId === undefined
        ? {}
        : { workspaceId: contextSnapshot.workspaceId as string }),
      ...(contextSnapshot.sessionId === undefined
        ? {}
        : { sessionId: contextSnapshot.sessionId as string }),
    }),
    requestedCount: Number(snapshot.requestedCount),
  });
}

interface CandidateCapacityBinding {
  readonly expectedColumns: Readonly<Record<string, unknown>>;
  readonly reservation: PostgresPendingCandidateCapacityReservation;
}

function advisoryCapacityKeys(
  scope: DurableJobV2Scope,
  context: PostgresPendingCandidateCapacityContext,
): readonly [number, number] {
  const digest = createHash("sha256").update(JSON.stringify([
    "mengshu.candidate.pending-capacity.v1",
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, context.workspaceId ?? "", context.sessionId ?? "",
  ])).digest();
  return Object.freeze([digest.readInt32BE(0), digest.readInt32BE(4)]);
}

async function reservePendingCandidateCapacity(
  client: PostgresDurableJobV2EffectClient,
  scope: DurableJobV2Scope,
  execution: PostgresPendingCandidateCapacityExecution,
): Promise<CandidateCapacityBinding> {
  if (execution.requestedCount === 0) {
    return Object.freeze({
      expectedColumns: Object.freeze({
        tenant_id: scope.tenantId,
        user_id: scope.userId,
        app_id: scope.appId,
        project_id: scope.projectId,
        agent_id: scope.agentId,
        namespace: scope.namespace,
        visibility: scope.visibility,
        workspace_id: execution.context.workspaceId ?? "",
        session_id: execution.context.sessionId ?? "",
        status: "pending",
      }),
      reservation: Object.freeze({ max: 50 as const, pendingCount: 0, remaining: 0 }),
    });
  }
  try {
    const [firstKey, secondKey] = advisoryCapacityKeys(scope, execution.context);
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [firstKey, secondKey]);
    const row = exactlyOneRow(await client.query(
      `SELECT COUNT(*)::bigint AS pending_count
FROM ${CANDIDATE_RELATION}
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = $9 AND status = $10`,
      [...scopeParams(scope), execution.context.workspaceId ?? "",
        execution.context.sessionId ?? "", "pending"],
    ));
    if (!row) {
      effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "candidate capacity count is invalid");
    }
    const pendingCount = integerField(row, "pending_count");
    const remaining = Math.max(0, MAX_PENDING_CANDIDATES_PER_SESSION - pendingCount);
    return Object.freeze({
      expectedColumns: Object.freeze({
        tenant_id: scope.tenantId,
        user_id: scope.userId,
        app_id: scope.appId,
        project_id: scope.projectId,
        agent_id: scope.agentId,
        namespace: scope.namespace,
        visibility: scope.visibility,
        workspace_id: execution.context.workspaceId ?? "",
        session_id: execution.context.sessionId ?? "",
        status: "pending",
      }),
      reservation: Object.freeze({
        max: 50 as const,
        pendingCount,
        remaining,
      }),
    });
  } catch (error) {
    if (error instanceof PostgresDurableJobV2EffectError) throw error;
    effectError(
      "DURABLE_JOB_EFFECT_CAPACITY_UNAVAILABLE",
      "Pending candidate capacity is unavailable",
    );
  }
}

function exactlyOneRow<Row extends Record<string, unknown>>(
  result: PostgresDurableJobV2EffectQueryResult<Row>,
): Row | undefined {
  if (!result || !Array.isArray(result.rows) ||
      (result.rowCount !== undefined && result.rowCount !== null && result.rowCount !== result.rows.length) ||
      result.rows.length > 1) {
    effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect query returned invalid rows");
  }
  return result.rows[0];
}

type StrictJsonValue =
  | null
  | boolean
  | number
  | string
  | StrictJsonValue[]
  | { [key: string]: StrictJsonValue };

type StrictJsonErrorCode =
  | "DURABLE_JOB_EFFECT_INVALID_RESULT"
  | "DURABLE_JOB_EFFECT_INVALID_RECEIPT";

function cloneStrictJsonValue(
  value: unknown,
  ancestors: Set<object>,
  errorCode: StrictJsonErrorCode = "DURABLE_JOB_EFFECT_INVALID_RESULT",
): StrictJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      effectError(errorCode, "durable job effect JSON contains invalid number");
    }
    return value;
  }
  if (typeof value !== "object") {
    effectError(errorCode, "durable job effect JSON contains non-JSON value");
  }
  if (ancestors.has(value)) {
    effectError(errorCode, "durable job effect JSON contains a cycle");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value);
      if (ownKeys.some((key) => typeof key !== "string" ||
          (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) ||
            !Number.isSafeInteger(Number(key)) || Number(key) >= value.length)))) {
        effectError(errorCode, "durable job effect JSON array has invalid properties");
      }
      const result: StrictJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          effectError(errorCode, "durable job effect JSON array has a hole");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          effectError(errorCode, "durable job effect JSON array has an accessor");
        }
        result.push(cloneStrictJsonValue(descriptor.value, ancestors, errorCode));
      }
      return Object.freeze(result) as StrictJsonValue[];
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      effectError(errorCode, "durable job effect JSON contains non-plain object");
    }
    const result: Record<string, StrictJsonValue> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        effectError(errorCode, "durable job effect JSON has a symbol property");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        effectError(errorCode, "durable job effect JSON has a non-data property");
      }
      Object.defineProperty(result, key, {
        value: cloneStrictJsonValue(descriptor.value, ancestors, errorCode),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(result);
  } finally {
    ancestors.delete(value);
  }
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    effectError("DURABLE_JOB_EFFECT_INVALID_RESULT", "durable job effect result must be an object");
  }
  return cloneStrictJsonValue(value, new Set()) as Record<string, unknown>;
}

function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect receipt is invalid");
  }
  return value;
}

function integerField(row: Record<string, unknown>, field: string): number {
  const raw = row[field];
  const value = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect receipt is invalid");
  }
  return Number(value);
}

function decodeReceipt<Result extends Record<string, unknown>>(
  row: Record<string, unknown>,
  expected: Pick<PostgresDurableJobV2EffectInput, "id" | "effectKey" | "leaseGeneration">,
): PostgresDurableJobV2EffectReceipt<Result> {
  const safeRow = cloneStrictJsonValue(
    row,
    new Set(),
    "DURABLE_JOB_EFFECT_INVALID_RECEIPT",
  ) as Record<string, unknown>;
  const expectedFields = [
    "job_id",
    "effect_key",
    "request_fingerprint",
    "lease_generation",
    "result",
    "committed_at",
  ];
  const fields = Reflect.ownKeys(safeRow);
  if (fields.length !== expectedFields.length || fields.some((field) =>
    typeof field !== "string" || !expectedFields.includes(field))) {
    effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect receipt fields are invalid");
  }
  const receipt = {
    jobId: stringField(safeRow, "job_id"),
    effectKey: stringField(safeRow, "effect_key"),
    requestFingerprint: stringField(safeRow, "request_fingerprint"),
    leaseGeneration: integerField(safeRow, "lease_generation"),
    result: safeRow.result as Result,
    committedAt: integerField(safeRow, "committed_at"),
  };
  if (receipt.jobId !== expected.id || receipt.effectKey !== expected.effectKey ||
      !SHA256.test(receipt.requestFingerprint) || receipt.leaseGeneration < 1 ||
      receipt.leaseGeneration > expected.leaseGeneration) {
    effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect receipt identity is invalid");
  }
  return Object.freeze({ ...receipt, result: Object.freeze(receipt.result) });
}

const ALLOWED_SQL_COMMANDS = new Set(["INSERT", "UPDATE", "DELETE"]);
const FORBIDDEN_SQL_WORDS = new Set([
  "BEGIN", "START", "COMMIT", "ROLLBACK", "END", "ABORT", "SAVEPOINT", "RELEASE",
  "PREPARE", "CREATE", "ALTER", "DROP", "TRUNCATE", "CALL", "DO", "CONFLICT", "COPY", "VACUUM",
  "ANALYZE", "GRANT", "REVOKE", "RESET", "LISTEN", "NOTIFY", "LOCK", "CLUSTER",
  "REINDEX", "REFRESH", "MERGE", "WITH", "SELECT", "TABLE", "TEMP", "TEMPORARY",
  "JOIN", "USING", "UNION", "INTERSECT", "EXCEPT", "ONLY", "PG_CATALOG", "INFORMATION_SCHEMA",
  "TRUE", "FALSE", "NULL", "DEFAULT", "CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME",
]);
/**
 * PostgreSQL parser keyword SSOT. This is an offline, auditable snapshot of all
 * 494 entries in PostgreSQL 18's `src/include/parser/kwlist.h` at commit:
 * d1d9688b1f92590110cb868ce4f65f39da0af2a8
 * Source SHA-256: fdcdf3694513cba63b4016f63032472b686e381bb35f17c5d645bc2f6f1dac16
 *
 * Both reserved and non-reserved parser keywords are rejected as unquoted
 * relation policy names. Domain relations therefore remain a narrow set of
 * ordinary identifiers and cannot gain grammar meaning after a PostgreSQL parse.
 */
export const POSTGRESQL_18_RELATION_KEYWORDS = Object.freeze([
  "ABORT", "ABSENT", "ABSOLUTE", "ACCESS", "ACTION", "ADD", "ADMIN", "AFTER", "AGGREGATE", "ALL", "ALSO",
  "ALTER", "ALWAYS", "ANALYSE", "ANALYZE", "AND", "ANY", "ARRAY", "AS", "ASC", "ASENSITIVE", "ASSERTION",
  "ASSIGNMENT", "ASYMMETRIC", "AT", "ATOMIC", "ATTACH", "ATTRIBUTE", "AUTHORIZATION", "BACKWARD", "BEFORE",
  "BEGIN", "BETWEEN", "BIGINT", "BINARY", "BIT", "BOOLEAN", "BOTH", "BREADTH", "BY", "CACHE", "CALL", "CALLED",
  "CASCADE", "CASCADED", "CASE", "CAST", "CATALOG", "CHAIN", "CHAR", "CHARACTER", "CHARACTERISTICS", "CHECK",
  "CHECKPOINT", "CLASS", "CLOSE", "CLUSTER", "COALESCE", "COLLATE", "COLLATION", "COLUMN", "COLUMNS",
  "COMMENT", "COMMENTS", "COMMIT", "COMMITTED", "COMPRESSION", "CONCURRENTLY", "CONDITIONAL", "CONFIGURATION",
  "CONFLICT", "CONNECTION", "CONSTRAINT", "CONSTRAINTS", "CONTENT", "CONTINUE", "CONVERSION", "COPY", "COST",
  "CREATE", "CROSS", "CSV", "CUBE", "CURRENT", "CURRENT_CATALOG", "CURRENT_DATE", "CURRENT_ROLE",
  "CURRENT_SCHEMA", "CURRENT_TIME", "CURRENT_TIMESTAMP", "CURRENT_USER", "CURSOR", "CYCLE", "DATA", "DATABASE",
  "DAY", "DEALLOCATE", "DEC", "DECIMAL", "DECLARE", "DEFAULT", "DEFAULTS", "DEFERRABLE", "DEFERRED", "DEFINER",
  "DELETE", "DELIMITER", "DELIMITERS", "DEPENDS", "DEPTH", "DESC", "DETACH", "DICTIONARY", "DISABLE",
  "DISCARD", "DISTINCT", "DO", "DOCUMENT", "DOMAIN", "DOUBLE", "DROP", "EACH", "ELSE", "EMPTY", "ENABLE",
  "ENCODING", "ENCRYPTED", "END", "ENFORCED", "ENUM", "ERROR", "ESCAPE", "EVENT", "EXCEPT", "EXCLUDE",
  "EXCLUDING", "EXCLUSIVE", "EXECUTE", "EXISTS", "EXPLAIN", "EXPRESSION", "EXTENSION", "EXTERNAL", "EXTRACT",
  "FALSE", "FAMILY", "FETCH", "FILTER", "FINALIZE", "FIRST", "FLOAT", "FOLLOWING", "FOR", "FORCE", "FOREIGN",
  "FORMAT", "FORWARD", "FREEZE", "FROM", "FULL", "FUNCTION", "FUNCTIONS", "GENERATED", "GLOBAL", "GRANT",
  "GRANTED", "GREATEST", "GROUP", "GROUPING", "GROUPS", "HANDLER", "HAVING", "HEADER", "HOLD", "HOUR",
  "IDENTITY", "IF", "ILIKE", "IMMEDIATE", "IMMUTABLE", "IMPLICIT", "IMPORT", "IN", "INCLUDE", "INCLUDING",
  "INCREMENT", "INDENT", "INDEX", "INDEXES", "INHERIT", "INHERITS", "INITIALLY", "INLINE", "INNER", "INOUT",
  "INPUT", "INSENSITIVE", "INSERT", "INSTEAD", "INT", "INTEGER", "INTERSECT", "INTERVAL", "INTO", "INVOKER",
  "IS", "ISNULL", "ISOLATION", "JOIN", "JSON", "JSON_ARRAY", "JSON_ARRAYAGG", "JSON_EXISTS", "JSON_OBJECT",
  "JSON_OBJECTAGG", "JSON_QUERY", "JSON_SCALAR", "JSON_SERIALIZE", "JSON_TABLE", "JSON_VALUE", "KEEP", "KEY",
  "KEYS", "LABEL", "LANGUAGE", "LARGE", "LAST", "LATERAL", "LEADING", "LEAKPROOF", "LEAST", "LEFT", "LEVEL",
  "LIKE", "LIMIT", "LISTEN", "LOAD", "LOCAL", "LOCALTIME", "LOCALTIMESTAMP", "LOCATION", "LOCK", "LOCKED",
  "LOGGED", "MAPPING", "MATCH", "MATCHED", "MATERIALIZED", "MAXVALUE", "MERGE", "MERGE_ACTION", "METHOD",
  "MINUTE", "MINVALUE", "MODE", "MONTH", "MOVE", "NAME", "NAMES", "NATIONAL", "NATURAL", "NCHAR", "NESTED",
  "NEW", "NEXT", "NFC", "NFD", "NFKC", "NFKD", "NO", "NONE", "NORMALIZE", "NORMALIZED", "NOT", "NOTHING",
  "NOTIFY", "NOTNULL", "NOWAIT", "NULL", "NULLIF", "NULLS", "NUMERIC", "OBJECT", "OBJECTS", "OF", "OFF",
  "OFFSET", "OIDS", "OLD", "OMIT", "ON", "ONLY", "OPERATOR", "OPTION", "OPTIONS", "OR", "ORDER", "ORDINALITY",
  "OTHERS", "OUT", "OUTER", "OVER", "OVERLAPS", "OVERLAY", "OVERRIDING", "OWNED", "OWNER", "PARALLEL",
  "PARAMETER", "PARSER", "PARTIAL", "PARTITION", "PASSING", "PASSWORD", "PATH", "PERIOD", "PLACING", "PLAN",
  "PLANS", "POLICY", "POSITION", "PRECEDING", "PRECISION", "PREPARE", "PREPARED", "PRESERVE", "PRIMARY",
  "PRIOR", "PRIVILEGES", "PROCEDURAL", "PROCEDURE", "PROCEDURES", "PROGRAM", "PUBLICATION", "QUOTE", "QUOTES",
  "RANGE", "READ", "REAL", "REASSIGN", "RECURSIVE", "REF", "REFERENCES", "REFERENCING", "REFRESH", "REINDEX",
  "RELATIVE", "RELEASE", "RENAME", "REPEATABLE", "REPLACE", "REPLICA", "RESET", "RESTART", "RESTRICT",
  "RETURN", "RETURNING", "RETURNS", "REVOKE", "RIGHT", "ROLE", "ROLLBACK", "ROLLUP", "ROUTINE", "ROUTINES",
  "ROW", "ROWS", "RULE", "SAVEPOINT", "SCALAR", "SCHEMA", "SCHEMAS", "SCROLL", "SEARCH", "SECOND", "SECURITY",
  "SELECT", "SEQUENCE", "SEQUENCES", "SERIALIZABLE", "SERVER", "SESSION", "SESSION_USER", "SET", "SETOF",
  "SETS", "SHARE", "SHOW", "SIMILAR", "SIMPLE", "SKIP", "SMALLINT", "SNAPSHOT", "SOME", "SOURCE", "SQL",
  "STABLE", "STANDALONE", "START", "STATEMENT", "STATISTICS", "STDIN", "STDOUT", "STORAGE", "STORED", "STRICT",
  "STRING", "STRIP", "SUBSCRIPTION", "SUBSTRING", "SUPPORT", "SYMMETRIC", "SYSID", "SYSTEM", "SYSTEM_USER",
  "TABLE", "TABLES", "TABLESAMPLE", "TABLESPACE", "TARGET", "TEMP", "TEMPLATE", "TEMPORARY", "TEXT", "THEN",
  "TIES", "TIME", "TIMESTAMP", "TO", "TRAILING", "TRANSACTION", "TRANSFORM", "TREAT", "TRIGGER", "TRIM",
  "TRUE", "TRUNCATE", "TRUSTED", "TYPE", "TYPES", "UESCAPE", "UNBOUNDED", "UNCOMMITTED", "UNCONDITIONAL",
  "UNENCRYPTED", "UNION", "UNIQUE", "UNKNOWN", "UNLISTEN", "UNLOGGED", "UNTIL", "UPDATE", "USER", "USING",
  "VACUUM", "VALID", "VALIDATE", "VALIDATOR", "VALUE", "VALUES", "VARCHAR", "VARIADIC", "VARYING", "VERBOSE",
  "VERSION", "VIEW", "VIEWS", "VIRTUAL", "VOLATILE", "WHEN", "WHERE", "WHITESPACE", "WINDOW", "WITH", "WITHIN",
  "WITHOUT", "WORK", "WRAPPER", "WRITE", "XML", "XMLATTRIBUTES", "XMLCONCAT", "XMLELEMENT", "XMLEXISTS",
  "XMLFOREST", "XMLNAMESPACES", "XMLPARSE", "XMLPI", "XMLROOT", "XMLSERIALIZE", "XMLTABLE", "YEAR", "YES",
  "ZONE",
] as const);
const POSTGRESQL_18_RELATION_KEYWORD_SET = Object.freeze(
  new Set<string>(POSTGRESQL_18_RELATION_KEYWORDS),
);
const MENGSHU_CONTROL_PLANE_RELATIONS = Object.freeze([
  "mengshu_schema_migrations",
  "mengshu_jobs_v2",
  "mengshu_job_v2_effect_receipts",
  "mengshu_embedding_spaces",
  "mengshu_active_embedding_space",
  "mengshu_forget_audit",
  "mengshu_forget_outbox",
  "mengshu_forget_receipts",
  "mengshu_jobs_v2_legacy_quarantine",
] as const);
const RESERVED_EFFECT_RELATIONS = new Set([
  ...MENGSHU_CONTROL_PLANE_RELATIONS.map((relation) => relation.toUpperCase()),
  "PG_CATALOG",
  "INFORMATION_SCHEMA",
]);
const FORBIDDEN_SQL_FUNCTIONS = new Set([
  "PG_ADVISORY_LOCK", "PG_ADVISORY_XACT_LOCK", "PG_TRY_ADVISORY_LOCK",
  "PG_TRY_ADVISORY_XACT_LOCK", "PG_ADVISORY_UNLOCK", "PG_ADVISORY_UNLOCK_ALL",
  "SET_CONFIG", "CURRENT_SETTING", "NEXTVAL", "SETVAL", "CURRVAL", "PG_NOTIFY",
  "PG_TERMINATE_BACKEND", "PG_CANCEL_BACKEND", "LO_IMPORT", "LO_EXPORT",
]);

function unsafeSql(): PostgresDurableJobV2EffectError {
  return new PostgresDurableJobV2EffectError(
    "DURABLE_JOB_EFFECT_UNSAFE_SQL",
    "durable job effect callback SQL is unsafe",
  );
}

type SqlToken =
  | { readonly kind: "word"; readonly value: string; readonly raw: string; readonly quoted: boolean }
  | { readonly kind: "placeholder"; readonly index: number }
  | { readonly kind: "punct"; readonly value: string };

function exactDenseArraySnapshot(raw: unknown, allowEmpty: boolean): readonly unknown[] {
  if (nodeUtilTypes.isProxy(raw) || !Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Array.prototype) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect allowed relations are invalid");
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable || lengthDescriptor.configurable ||
      !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < (allowEmpty ? 0 : 1)) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect allowed relations are invalid");
  }
  const length = lengthDescriptor.value as number;
  const ownKeys = Reflect.ownKeys(raw);
  if (ownKeys.length !== length + 1 || !ownKeys.includes("length") ||
      ownKeys.some((key) => typeof key !== "string" ||
        (key !== "length" && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)))) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect allowed relations are invalid");
  }
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect allowed relations are invalid");
    }
    values.push(descriptor.value);
  }
  return Object.freeze(values);
}

function canonicalAllowedRelations(raw: unknown): ReadonlySet<string> {
  const values = exactDenseArraySnapshot(raw, false);
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !RELATION_IDENTIFIER.test(value) ||
        value.startsWith("pg_") ||
        POSTGRESQL_18_RELATION_KEYWORD_SET.has(value.toUpperCase()) ||
        RESERVED_EFFECT_RELATIONS.has(value.toUpperCase()) ||
        seen.has(value)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect allowed relations are invalid");
    }
    seen.add(value);
    normalized.push(value);
  }
  const snapshot = Object.freeze(normalized);
  return Object.freeze(new Set(snapshot));
}

interface CanonicalInsertOnConflictPolicy {
  readonly relation: string;
  readonly conflictColumns: readonly string[];
  readonly returningColumns: readonly string[];
  readonly valueCasts: ReadonlyMap<string, "jsonb">;
}

const ALLOWED_EXACT_VALUE_CASTS = Object.freeze(new Set<string>(["jsonb"]));

function canonicalPolicyColumns(raw: unknown, allowEmpty: boolean): readonly string[] {
  const values = exactDenseArraySnapshot(raw, allowEmpty);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || !RELATION_IDENTIFIER.test(value) ||
        POSTGRESQL_18_RELATION_KEYWORD_SET.has(value.toUpperCase()) || seen.has(value)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    seen.add(value);
    columns.push(value);
  }
  return Object.freeze(columns);
}

function canonicalValueCasts(raw: unknown): ReadonlyMap<string, "jsonb"> {
  if (raw === undefined) return Object.freeze(new Map());
  const values = exactDenseArraySnapshot(raw, true);
  const casts = new Map<string, "jsonb">();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 2 || keys.some((key) => typeof key !== "string" ||
        (key !== "column" && key !== "type")) || !keys.includes("column") || !keys.includes("type")) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const columnDescriptor = Object.getOwnPropertyDescriptor(value, "column");
    const typeDescriptor = Object.getOwnPropertyDescriptor(value, "type");
    if (!columnDescriptor?.enumerable || !("value" in columnDescriptor) ||
        !typeDescriptor?.enumerable || !("value" in typeDescriptor)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const column = columnDescriptor.value;
    const type = typeDescriptor.value;
    if (typeof column !== "string" || !RELATION_IDENTIFIER.test(column) ||
        POSTGRESQL_18_RELATION_KEYWORD_SET.has(column.toUpperCase()) || casts.has(column) ||
        typeof type !== "string" || type !== type.toLowerCase() ||
        !ALLOWED_EXACT_VALUE_CASTS.has(type) ||
        POSTGRESQL_18_RELATION_KEYWORD_SET.has(type.toUpperCase())) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    casts.set(column, type as "jsonb");
  }
  return Object.freeze(casts);
}

function canonicalInsertOnConflictPolicies(
  raw: unknown,
  allowedRelations: ReadonlySet<string>,
): ReadonlyMap<string, CanonicalInsertOnConflictPolicy> {
  if (raw === undefined) return Object.freeze(new Map());
  const values = exactDenseArraySnapshot(raw, true);
  const policies = new Map<string, CanonicalInsertOnConflictPolicy>();
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some((key) => typeof key !== "string" ||
        !["relation", "conflictColumns", "returningColumns", "valueCasts"].includes(key)) ||
        !keys.includes("relation") || !keys.includes("conflictColumns")) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
      }
      descriptors.set(key, descriptor);
    }
    const relation = descriptors.get("relation")?.value;
    if (typeof relation !== "string" || !allowedRelations.has(relation) || policies.has(relation)) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect conflict policy is invalid");
    }
    const conflictColumns = canonicalPolicyColumns(descriptors.get("conflictColumns")?.value, false);
    const returningColumns = descriptors.has("returningColumns")
      ? canonicalPolicyColumns(descriptors.get("returningColumns")?.value, true)
      : Object.freeze([] as string[]);
    const valueCasts = canonicalValueCasts(descriptors.get("valueCasts")?.value);
    policies.set(relation, Object.freeze({ relation, conflictColumns, returningColumns, valueCasts }));
  }
  return Object.freeze(policies);
}

function lexWorkSql(sql: unknown): { readonly tokens: readonly SqlToken[]; readonly placeholders: ReadonlySet<number> } {
  if (typeof sql !== "string" || sql.trim().length === 0 ||
      sql.includes(";") || sql.includes("--") || sql.includes("/*") || sql.includes("*/")) {
    throw unsafeSql();
  }
  const tokens: SqlToken[] = [];
  const placeholders = new Set<number>();
  for (let index = 0; index < sql.length;) {
    const char = sql[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[(),.=:+*/<>-]/.test(char)) {
      tokens.push({ kind: "punct", value: char });
      index += 1;
      continue;
    }
    // 所有 value literal 必须改为 PostgreSQL positional parameter。
    if (char === "'") throw unsafeSql();
    if (char === '"') {
      let identifier = "";
      index += 1;
      let closed = false;
      while (index < sql.length) {
        if (sql[index] === '"') {
          if (sql[index + 1] === '"') {
            identifier += '"';
            index += 2;
            continue;
          }
          closed = true;
          index += 1;
          break;
        }
        identifier += sql[index]!;
        index += 1;
      }
      if (!closed || !SQL_IDENTIFIER.test(identifier)) throw unsafeSql();
      tokens.push({ kind: "word", value: identifier.toUpperCase(), raw: identifier, quoted: true });
      continue;
    }
    if (char === "$") {
      const match = /^\$([1-9][0-9]*)/.exec(sql.slice(index));
      if (!match) throw unsafeSql();
      const placeholder = Number(match[1]);
      if (!Number.isSafeInteger(placeholder)) throw unsafeSql();
      placeholders.add(placeholder);
      tokens.push({ kind: "placeholder", index: placeholder });
      index += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end]!)) end += 1;
      const raw = sql.slice(index, end);
      tokens.push({ kind: "word", value: raw.toUpperCase(), raw, quoted: false });
      index = end;
      continue;
    }
    // 数值也属于 value literal，必须使用 positional parameter。
    if (/[0-9]/.test(char)) throw unsafeSql();
    throw unsafeSql();
  }
  return { tokens, placeholders };
}

type IndexedSqlWord = Extract<SqlToken, { kind: "word" }> & { readonly tokenIndex: number };

interface InsertOnConflictGrammar {
  readonly allowedWordTokenIndexes: ReadonlySet<number>;
  readonly conflictWordTokenIndex?: number;
  readonly insertColumns?: readonly string[];
}

const NO_INSERT_ON_CONFLICT = Object.freeze({
  allowedWordTokenIndexes: Object.freeze(new Set<number>()),
}) satisfies InsertOnConflictGrammar;

function unquotedWord(token: SqlToken | undefined, value: string): boolean {
  return token?.kind === "word" && token.quoted === false && token.value === value;
}

function policyIdentifier(token: SqlToken | undefined): string | undefined {
  if (token?.kind !== "word") return undefined;
  const identifier = token.quoted ? token.raw : token.raw.toLowerCase();
  return RELATION_IDENTIFIER.test(identifier) ? identifier : undefined;
}

function sameOrderedStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function parseInsertOnConflictGrammar(
  tokens: readonly SqlToken[],
  command: IndexedSqlWord,
  relation: IndexedSqlWord,
  relationName: string,
  policies: ReadonlyMap<string, CanonicalInsertOnConflictPolicy>,
  paramsLength: number,
): InsertOnConflictGrammar {
  const marker = (value: string) => tokens
    .map((token, tokenIndex) => unquotedWord(token, value) ? tokenIndex : -1)
    .filter((tokenIndex) => tokenIndex >= 0);
  const conflictIndexes = marker("CONFLICT");
  const doIndexes = marker("DO");
  if (command.value !== "INSERT") {
    if (conflictIndexes.length !== 0 || doIndexes.length !== 0) throw unsafeSql();
    return NO_INSERT_ON_CONFLICT;
  }
  const hasConflict = conflictIndexes.length !== 0 || doIndexes.length !== 0;
  const onIndexes = marker("ON");
  const nothingIndexes = marker("NOTHING");
  if (hasConflict && (onIndexes.length !== 1 || conflictIndexes.length !== 1 ||
      doIndexes.length !== 1 || nothingIndexes.length !== 1)) throw unsafeSql();
  const policy = policies.get(relationName);
  if (hasConflict && !policy) throw unsafeSql();

  const onIndex = hasConflict ? onIndexes[0]! : tokens.length;
  let prefixCursor = relation.tokenIndex + 1;
  const insertOpen = tokens[prefixCursor];
  if (insertOpen?.kind !== "punct" || insertOpen.value !== "(") throw unsafeSql();
  prefixCursor += 1;
  const insertColumns: string[] = [];
  const seenInsertColumns = new Set<string>();
  while (true) {
    const identifier = policyIdentifier(tokens[prefixCursor]);
    if (!identifier || seenInsertColumns.has(identifier)) throw unsafeSql();
    seenInsertColumns.add(identifier);
    insertColumns.push(identifier);
    prefixCursor += 1;
    const separator = tokens[prefixCursor];
    if (separator?.kind === "punct" && separator.value === ",") {
      prefixCursor += 1;
      continue;
    }
    if (separator?.kind === "punct" && separator.value === ")") {
      prefixCursor += 1;
      break;
    }
    throw unsafeSql();
  }
  if ((policy?.conflictColumns.some((column) => !seenInsertColumns.has(column)) ?? false) ||
      !unquotedWord(tokens[prefixCursor], "VALUES")) throw unsafeSql();
  prefixCursor += 1;
  const valuesOpen = tokens[prefixCursor];
  if (valuesOpen?.kind !== "punct" || valuesOpen.value !== "(") throw unsafeSql();
  prefixCursor += 1;
  let valueCount = 0;
  while (true) {
    const placeholder = tokens[prefixCursor];
    if (placeholder?.kind !== "placeholder" || placeholder.index !== valueCount + 1) throw unsafeSql();
    const insertColumn = insertColumns[valueCount];
    const expectedCast = insertColumn === undefined ? undefined : policy?.valueCasts.get(insertColumn);
    valueCount += 1;
    prefixCursor += 1;
    const firstCastColon = tokens[prefixCursor];
    const secondCastColon = tokens[prefixCursor + 1];
    if (firstCastColon?.kind === "punct" && firstCastColon.value === ":" &&
        secondCastColon?.kind === "punct" && secondCastColon.value === ":") {
      const castType = policyIdentifier(tokens[prefixCursor + 2]);
      const castToken = tokens[prefixCursor + 2];
      if (!castType || castToken?.kind !== "word" || castToken.quoted || castType !== expectedCast) {
        throw unsafeSql();
      }
      prefixCursor += 3;
    } else if (expectedCast !== undefined) {
      throw unsafeSql();
    }
    const separator = tokens[prefixCursor];
    if (separator?.kind === "punct" && separator.value === ",") {
      prefixCursor += 1;
      continue;
    }
    if (separator?.kind === "punct" && separator.value === ")") {
      prefixCursor += 1;
      break;
    }
    throw unsafeSql();
  }
  if (valueCount !== insertColumns.length || paramsLength !== insertColumns.length ||
      [...(policy?.valueCasts.keys() ?? [])].some((column) => !seenInsertColumns.has(column)) ||
      prefixCursor !== onIndex) throw unsafeSql();
  if (!hasConflict) {
    return Object.freeze({
      allowedWordTokenIndexes: Object.freeze(new Set<number>()),
      insertColumns: Object.freeze(insertColumns),
    });
  }
  if (!policy) throw unsafeSql();

  let cursor = onIndex;
  if (!unquotedWord(tokens[cursor], "ON")) throw unsafeSql();
  const grammarWords = new Set<number>([cursor]);
  cursor += 1;
  if (!unquotedWord(tokens[cursor], "CONFLICT")) throw unsafeSql();
  const conflictWordTokenIndex = cursor;
  grammarWords.add(cursor);
  cursor += 1;
  const conflictOpen = tokens[cursor];
  if (conflictOpen?.kind !== "punct" || conflictOpen.value !== "(") throw unsafeSql();
  cursor += 1;

  const conflictColumns: string[] = [];
  while (true) {
    const identifier = policyIdentifier(tokens[cursor]);
    if (!identifier) throw unsafeSql();
    conflictColumns.push(identifier);
    cursor += 1;
    const separator = tokens[cursor];
    if (separator?.kind === "punct" && separator.value === ",") {
      cursor += 1;
      continue;
    }
    if (separator?.kind === "punct" && separator.value === ")") {
      cursor += 1;
      break;
    }
    throw unsafeSql();
  }
  if (!sameOrderedStrings(conflictColumns, policy.conflictColumns)) throw unsafeSql();
  if (!unquotedWord(tokens[cursor], "DO")) throw unsafeSql();
  grammarWords.add(cursor);
  cursor += 1;
  if (!unquotedWord(tokens[cursor], "NOTHING")) throw unsafeSql();
  grammarWords.add(cursor);
  cursor += 1;

  if (cursor < tokens.length) {
    if (!unquotedWord(tokens[cursor], "RETURNING") || policy.returningColumns.length === 0) {
      throw unsafeSql();
    }
    grammarWords.add(cursor);
    cursor += 1;
    const returningColumns: string[] = [];
    while (cursor < tokens.length) {
      const identifier = policyIdentifier(tokens[cursor]);
      if (!identifier) throw unsafeSql();
      returningColumns.push(identifier);
      cursor += 1;
      if (cursor === tokens.length) break;
      const separator = tokens[cursor];
      if (separator?.kind !== "punct" || separator.value !== ",") throw unsafeSql();
      cursor += 1;
    }
    if (!sameOrderedStrings(returningColumns, policy.returningColumns)) throw unsafeSql();
  }
  if (cursor !== tokens.length) throw unsafeSql();
  return Object.freeze({
    allowedWordTokenIndexes: Object.freeze(grammarWords),
    conflictWordTokenIndex,
    insertColumns: Object.freeze(insertColumns),
  });
}

interface ValidatedWorkSql {
  readonly command: "INSERT" | "UPDATE" | "DELETE";
  readonly relationName: string;
  readonly insertColumns?: readonly string[];
}

/** 只允许 exact relation allowlist 上的单条、全参数化 INSERT/UPDATE/DELETE。 */
function validateWorkSql(
  sql: unknown,
  params: readonly unknown[],
  allowedRelations: ReadonlySet<string>,
  insertOnConflictPolicies: ReadonlyMap<string, CanonicalInsertOnConflictPolicy>,
): ValidatedWorkSql {
  if (!Array.isArray(params)) throw unsafeSql();
  const { tokens, placeholders } = lexWorkSql(sql);
  const words = tokens
    .map((token, tokenIndex) => token.kind === "word" ? { ...token, tokenIndex } : undefined)
    .filter((token): token is IndexedSqlWord =>
      token !== undefined);
  const command = words[0];
  if (!command || command.tokenIndex !== 0 || command.quoted ||
      !ALLOWED_SQL_COMMANDS.has(command.value)) throw unsafeSql();
  // PostgreSQL permits DELETE/UPDATE FROM ONLY <relation>; this narrow capability
  // rejects that optional grammar instead of ever interpreting ONLY as the relation.
  if (words.some((word) => !word.quoted && word.value === "ONLY")) throw unsafeSql();

  let relation: typeof words[number] | undefined;
  if (command.value === "INSERT") {
    if (!unquotedWord(tokens[1], "INTO") || tokens[2]?.kind !== "word" ||
        tokens[3]?.kind !== "punct" || tokens[3].value !== "(") throw unsafeSql();
    relation = words[2];
    if (words.filter((word) => word.value === "INTO").length !== 1 ||
        words.some((word) => word.value === "FROM" || word.value === "USING")) throw unsafeSql();
  } else if (command.value === "UPDATE") {
    relation = words[1];
    if (words.filter((word) => word.value === "SET").length !== 1 ||
        words.some((word) => word.value === "FROM" || word.value === "INTO" || word.value === "USING")) {
      throw unsafeSql();
    }
  } else {
    if (words[1]?.value !== "FROM") throw unsafeSql();
    relation = words[2];
    if (words.filter((word) => word.value === "FROM").length !== 1 ||
        words.some((word) => word.value === "INTO" || word.value === "USING")) throw unsafeSql();
  }
  const relationName = relation?.quoted ? relation.raw : relation?.raw.toLowerCase();
  if (!relation || !relationName || !RELATION_IDENTIFIER.test(relationName) ||
      !allowedRelations.has(relationName)) throw unsafeSql();
  const relationNext = tokens[relation.tokenIndex + 1];
  if (relationNext?.kind === "punct" && relationNext.value === ".") throw unsafeSql();
  const conflictGrammar = parseInsertOnConflictGrammar(
    tokens,
    command,
    relation,
    relationName,
    insertOnConflictPolicies,
    params.length,
  );

  for (const word of words) {
    const exactConflictGrammarWord = conflictGrammar.allowedWordTokenIndexes.has(word.tokenIndex);
    if (!exactConflictGrammarWord &&
        (FORBIDDEN_SQL_WORDS.has(word.value) || RESERVED_EFFECT_RELATIONS.has(word.value) ||
          FORBIDDEN_SQL_FUNCTIONS.has(word.value) ||
          (word !== command && ALLOWED_SQL_COMMANDS.has(word.value)))) throw unsafeSql();
    const next = tokens[word.tokenIndex + 1];
    if (next?.kind === "punct" && next.value === "(" &&
        word !== relation && word.value !== "VALUES" && word.value !== "IN" &&
        word.tokenIndex !== conflictGrammar.conflictWordTokenIndex) throw unsafeSql();
  }

  if (
      params.length === 0 || placeholders.size !== params.length ||
      [...placeholders].some((placeholder) => placeholder > params.length) ||
      Array.from({ length: params.length }, (_, index) => index + 1)
        .some((placeholder) => !placeholders.has(placeholder))) {
    throw unsafeSql();
  }
  return Object.freeze({
    command: command.value as ValidatedWorkSql["command"],
    relationName,
    ...(conflictGrammar.insertColumns === undefined
      ? {}
      : { insertColumns: conflictGrammar.insertColumns }),
  });
}

interface WorkCapability {
  readonly client: PostgresDurableJobV2EffectWorkClient;
  revokeAndDrain(): Promise<void>;
}

function createWorkCapability(
  client: PostgresDurableJobV2EffectClient,
  allowedRelations: ReadonlySet<string>,
  insertOnConflictPolicies: ReadonlyMap<string, CanonicalInsertOnConflictPolicy>,
  candidateCapacity?: CandidateCapacityBinding,
  providerOwnedDomainWork = false,
): WorkCapability {
  let active = true;
  let inFlightFailure: unknown;
  let candidateInsertAttempts = 0;
  const operations: Array<Promise<PostgresDurableJobV2EffectQueryResult>> = [];
  const track = <Row extends Record<string, unknown>>(
    operation: Promise<PostgresDurableJobV2EffectQueryResult<Row>>,
  ): Promise<PostgresDurableJobV2EffectQueryResult<Row>> => {
    const tracked = operation.finally(() => undefined);
    operations.push(tracked as Promise<PostgresDurableJobV2EffectQueryResult>);
    // 每个返回 promise 在暴露给 callback 前先挂内部 rejection observer；
    // 原 promise 仍保持 rejected，使显式 await 的调用方得到固定错误。
    void tracked.catch((error) => {
      if (inFlightFailure === undefined) inFlightFailure = error;
    });
    return tracked;
  };
  const workClient = Object.freeze({
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<PostgresDurableJobV2EffectQueryResult<Row>> => {
      let operation: Promise<PostgresDurableJobV2EffectQueryResult<Row>>;
      try {
        if (!active) throw unsafeSql();
        if (providerOwnedDomainWork) {
          operation = Promise.resolve(client.query<Row>(sql, params));
          return track(operation);
        }
        const validated = validateWorkSql(sql, params, allowedRelations, insertOnConflictPolicies);
        if (validated.relationName === CANDIDATE_RELATION && candidateCapacity) {
          if (validated.command !== "INSERT" || validated.insertColumns === undefined) {
            effectError(
              "DURABLE_JOB_EFFECT_CAPACITY_EXCEEDED",
              "Pending candidate capacity binding is required",
            );
          }
          for (const [column, expected] of Object.entries(candidateCapacity.expectedColumns)) {
            const index = validated.insertColumns.indexOf(column);
            if (index < 0 || params[index] !== expected) {
              effectError(
                "DURABLE_JOB_EFFECT_CAPACITY_EXCEEDED",
                "Pending candidate capacity binding does not match insert",
              );
            }
          }
          if (candidateInsertAttempts >= candidateCapacity.reservation.remaining) {
            effectError(
              "DURABLE_JOB_EFFECT_CAPACITY_EXCEEDED",
              "Pending candidate capacity is exhausted",
            );
          }
          candidateInsertAttempts += 1;
        }
        operation = Promise.resolve(client.query<Row>(sql, params));
      } catch (error) {
        operation = Promise.reject(error);
      }
      return track(operation);
    },
  });
  return {
    client: workClient,
    async revokeAndDrain() {
      active = false;
      let observed = 0;
      while (true) {
        // 让 callback 返回前排入的最后一批 void query 进入 operation ledger。
        await Promise.resolve();
        const batch = operations.slice(observed);
        if (batch.length === 0) {
          await Promise.resolve();
          if (operations.length === observed) break;
          continue;
        }
        observed = operations.length;
        const settled = await Promise.allSettled(batch);
        const rejected = settled.find((item): item is PromiseRejectedResult => item.status === "rejected");
        if (rejected && inFlightFailure === undefined) inFlightFailure = rejected.reason;
      }
      if (inFlightFailure !== undefined) throw inFlightFailure;
    },
  };
}

export class PostgresDurableJobV2EffectRepository {
  readonly #pool: PostgresDurableJobV2EffectPool;
  readonly #clock: () => number;
  readonly #allowedRelations: ReadonlySet<string>;
  readonly #insertOnConflictPolicies: ReadonlyMap<string, CanonicalInsertOnConflictPolicy>;

  constructor(
    pool: PostgresDurableJobV2EffectPool,
    dependencies: {
      readonly clock?: () => number;
      readonly allowedRelations: readonly string[];
      readonly insertOnConflictPolicies?: readonly PostgresInsertOnConflictPolicy[];
    },
  ) {
    if (!dependencies || !pool || typeof pool.connect !== "function" ||
        (dependencies.clock !== undefined && typeof dependencies.clock !== "function")) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect dependencies are invalid");
    }
    this.#pool = pool;
    this.#clock = dependencies.clock ?? Date.now;
    this.#allowedRelations = canonicalAllowedRelations(dependencies.allowedRelations);
    this.#insertOnConflictPolicies = canonicalInsertOnConflictPolicies(
      dependencies.insertOnConflictPolicies,
      this.#allowedRelations,
    );
  }

  /**
   * 在同一 PostgreSQL 事务中执行 fenced side effect 与 receipt。
   * callback 只能通过受限 client 写同一数据库；外部 API、LanceDB、内存状态不在此合同内。
   */
  async execute<Result extends Record<string, unknown>>(
    rawInput: PostgresDurableJobV2EffectInput,
    work: (client: PostgresDurableJobV2EffectWorkClient) => Promise<Result>,
  ): Promise<PostgresDurableJobV2EffectResult<Result>> {
    return this.#execute(rawInput, (client) => work(client));
  }

  /** Provider-owned candidate path: capacity lock/count stay inside the fenced transaction. */
  async executeWithPendingCandidateCapacity<Result extends Record<string, unknown>>(
    rawInput: PostgresDurableJobV2EffectInput,
    rawExecution: PostgresPendingCandidateCapacityExecution,
    work: (
      client: PostgresDurableJobV2EffectWorkClient,
      capacity: PostgresPendingCandidateCapacityReservation,
    ) => Promise<Result>,
  ): Promise<PostgresDurableJobV2EffectResult<Result>> {
    if (this.#allowedRelations.size !== 1 || !this.#allowedRelations.has(CANDIDATE_RELATION) ||
        typeof work !== "function") {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "candidate capacity effect is invalid");
    }
    const execution = canonicalCapacityExecution(rawExecution);
    return this.#execute(rawInput, (client, capacity) => work(client, capacity!), execution);
  }

  /**
   * 仅供同模块 mint 的 provider-owned runner 使用。domain helper 的 SQL 是固定源码，
   * 但仍通过此 driver 复用 fence、receipt、rollback、commit-uncertain 与 drain 语义。
   */
  async executeProviderOwnedDomain<Result extends Record<string, unknown>>(
    authority: object,
    rawInput: PostgresDurableJobV2EffectInput,
    work: (client: PostgresDurableJobV2EffectWorkClient) => Promise<Result>,
  ): Promise<PostgresDurableJobV2EffectResult<Result>> {
    if (authority !== PROVIDER_OWNED_DOMAIN_EFFECT_AUTHORITY) {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "provider-owned domain authority is invalid");
    }
    return this.#execute(rawInput, (client) => work(client), undefined, true);
  }

  async #execute<Result extends Record<string, unknown>>(
    rawInput: PostgresDurableJobV2EffectInput,
    work: (
      client: PostgresDurableJobV2EffectWorkClient,
      capacity?: PostgresPendingCandidateCapacityReservation,
    ) => Promise<Result>,
    capacityExecution?: PostgresPendingCandidateCapacityExecution,
    providerOwnedDomainWork = false,
  ): Promise<PostgresDurableJobV2EffectResult<Result>> {
    const input = validateInput(rawInput);
    if (typeof work !== "function") {
      effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect callback is invalid");
    }
    const startedAt = nowFrom(this.#clock);
    const client = await this.#pool.connect();
    let result: PostgresDurableJobV2EffectResult<Result> | undefined;
    let failure: unknown;
    let begun = false;
    let committed = false;
    let commitAttempted = false;
    try {
      await client.query("BEGIN");
      begun = true;
      const fence = exactlyOneRow(await client.query(
        `SELECT id
FROM ${JOB_TABLE}
WHERE id = $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND status = 'running'
  AND lease_owner = $9 AND lease_token = $10 AND lease_generation = $11
  AND lease_until > $12
FOR UPDATE`,
        [input.id, ...scopeParams(input.scope), input.owner, input.leaseToken,
          input.leaseGeneration, startedAt],
      ));
      if (!fence) {
        result = { status: "stale" };
      } else {
        const priorRow = exactlyOneRow(await client.query(
          `SELECT job_id, effect_key, request_fingerprint, lease_generation, result, committed_at
FROM ${RECEIPT_TABLE}
WHERE job_id = $1 AND effect_key = $2
FOR UPDATE`,
          [input.id, input.effectKey],
        ));
        if (priorRow) {
          const receipt = decodeReceipt<Result>(priorRow, input);
          if (receipt.requestFingerprint !== input.requestFingerprint) {
            effectError(
              "DURABLE_JOB_EFFECT_FINGERPRINT_MISMATCH",
              "durable job effect receipt fingerprint mismatch",
            );
          }
          result = { status: "replayed", receipt };
        } else {
          const capacityBinding = capacityExecution === undefined
            ? undefined
            : await reservePendingCandidateCapacity(client, input.scope, capacityExecution);
          const capability = createWorkCapability(
            client,
            this.#allowedRelations,
            this.#insertOnConflictPolicies,
            capacityBinding,
            providerOwnedDomainWork,
          );
          let rawEffectResult: Result | undefined;
          let workFailure: unknown;
          try {
            rawEffectResult = await work(capability.client, capacityBinding?.reservation);
          } catch (error) {
            workFailure = error;
          }
          try {
            await capability.revokeAndDrain();
          } catch (drainFailure) {
            workFailure = workFailure && workFailure !== drainFailure
              ? new AggregateError([workFailure, drainFailure], "Durable job effect callback and drain failed")
              : (workFailure ?? drainFailure);
          }
          if (workFailure) throw workFailure;
          const effectResult = jsonRecord(rawEffectResult) as Result;
          const committedAt = nowFrom(this.#clock);
          if (committedAt < startedAt) {
            effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "durable job effect clock moved backwards");
          }
          const receiptRow = exactlyOneRow(await client.query(
            `INSERT INTO ${RECEIPT_TABLE} (
  job_id, effect_key, request_fingerprint, lease_generation, result, committed_at
)
SELECT $1, $2, $3, $4, $5::jsonb, $6
FROM ${JOB_TABLE}
WHERE id = $1
  AND tenant_id = $7 AND user_id = $8 AND app_id = $9 AND project_id = $10
  AND agent_id = $11 AND namespace = $12 AND visibility = $13
  AND status = 'running'
  AND lease_owner = $14 AND lease_token = $15 AND lease_generation = $16
  AND lease_until > $17
RETURNING job_id, effect_key, request_fingerprint, lease_generation, result, committed_at`,
            [input.id, input.effectKey, input.requestFingerprint, input.leaseGeneration,
              JSON.stringify(effectResult), committedAt, ...scopeParams(input.scope), input.owner,
              input.leaseToken, input.leaseGeneration, committedAt],
          ));
          if (!receiptRow) {
            effectError("DURABLE_JOB_EFFECT_LEASE_LOST", "durable job effect lease was lost before commit");
          }
          const receipt = decodeReceipt<Result>(receiptRow, input);
          if (receipt.requestFingerprint !== input.requestFingerprint ||
              receipt.leaseGeneration !== input.leaseGeneration) {
            effectError("DURABLE_JOB_EFFECT_INVALID_RECEIPT", "durable job effect receipt changed identity");
          }
          result = { status: "applied", receipt };
        }
      }
      commitAttempted = true;
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      const commitOutcomeUncertain = commitAttempted && !committed;
      failure = commitOutcomeUncertain
        ? new PostgresDurableJobV2EffectError(
          "DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN",
          "Durable job effect outcome is uncertain",
        )
        : error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackFailure) {
          if (!commitOutcomeUncertain) {
            failure = new AggregateError(
              [failure, rollbackFailure],
              "Postgres durable job effect transaction and rollback both failed",
            );
          }
        }
      }
    }
    try {
      client.release();
    } catch (releaseFailure) {
      if (committed) {
        failure = new PostgresDurableJobV2EffectError(
          "DURABLE_JOB_EFFECT_RELEASE_FAILED",
          "Durable job effect connection release failed",
        );
      } else if (commitAttempted) {
        failure = new PostgresDurableJobV2EffectError(
          "DURABLE_JOB_EFFECT_OUTCOME_UNCERTAIN",
          "Durable job effect outcome is uncertain",
        );
      } else {
        failure = failure
          ? new AggregateError(
            [failure, releaseFailure],
            "Postgres durable job effect transaction and release both failed",
          )
          : releaseFailure;
      }
    }
    if (failure) throw failure;
    return result!;
  }
}

export interface PostgresProviderOwnedDomainEffectRunner {
  execute<Result extends Record<string, unknown>>(
    input: PostgresDurableJobV2EffectInput,
    work: (client: PostgresDurableJobV2EffectWorkClient) => Promise<Result>,
  ): Promise<PostgresDurableJobV2EffectResult<Result>>;
}

/**
 * Provider composition seam. 返回值只携带固定 authority closure，不公开 raw Pool。
 * 它不是同进程恶意代码的安全沙箱；production provenance 仍由 provider-owned bundle 验证。
 */
export function createPostgresProviderOwnedDomainEffectRunner(
  repository: PostgresDurableJobV2EffectRepository,
): PostgresProviderOwnedDomainEffectRunner {
  if (!(repository instanceof PostgresDurableJobV2EffectRepository)) {
    effectError("DURABLE_JOB_EFFECT_INVALID_INPUT", "provider-owned domain repository is invalid");
  }
  return Object.freeze({
    execute: <Result extends Record<string, unknown>>(
      input: PostgresDurableJobV2EffectInput,
      work: (client: PostgresDurableJobV2EffectWorkClient) => Promise<Result>,
    ) => repository.executeProviderOwnedDomain(
      PROVIDER_OWNED_DOMAIN_EFFECT_AUTHORITY,
      input,
      work,
    ),
  });
}
