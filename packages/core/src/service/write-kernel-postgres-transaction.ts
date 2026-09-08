import { createHash } from "node:crypto";
import {
  createMemoryWriteReceipt,
  type MemoryWriteReceipt,
  type MemoryWriteReceiptResult,
  type NormalizedMemoryWriteReceipt,
  type WriteIdempotencyIdentity,
} from "./write-kernel-transaction.js";
import type {
  MemoryWriteTransactionContext,
  WriteAdmissionRoute,
  WriteAuditEvent,
  WriteMemoryRecord,
  WriteOutboxEvent,
  WriteScope,
} from "./write-kernel.js";

export interface PostgresMemoryWriteKernelQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresMemoryWriteKernelClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresMemoryWriteKernelQueryResult<Row>>;
  release(): void;
}

export interface PostgresMemoryWriteKernelPool {
  connect(): Promise<PostgresMemoryWriteKernelClient>;
}

export type PostgresMemoryWriteKernelMutation = (
  client: PostgresMemoryWriteKernelClient,
  memory: WriteMemoryRecord,
) => Promise<{ memoryId: string; stored: boolean }>;

/** Only provider composition supplies these hooks; both run on the kernel's dedicated transaction client. */
export interface PostgresMemoryWriteKernelTransactionHooks {
  afterBegin?(client: PostgresMemoryWriteKernelClient): Promise<void>;
  beforeMutation?(client: PostgresMemoryWriteKernelClient, memory: WriteMemoryRecord): Promise<void>;
  afterReceipt?(client: PostgresMemoryWriteKernelClient, receipt: NormalizedMemoryWriteReceipt, memory: WriteMemoryRecord): Promise<void>;
}

export interface ProviderOwnedMemoryWriteKernelTransactionPort {
  transaction<T>(work: (context: MemoryWriteTransactionContext) => Promise<T>): Promise<T>;
}

const providerOwnedPorts = new WeakSet<object>();
const providerHooks = new WeakMap<object, PostgresMemoryWriteKernelTransactionHooks>();
const SHA256 = /^[a-f0-9]{64}$/;
const CANDIDATE_ROUTES = new Set<WriteAdmissionRoute>([
  "candidate_low_priority",
  "candidate",
]);
const MEMORY_ROUTES = new Set<WriteAdmissionRoute>([
  "active",
  "lookup_only",
  "evidence_only",
]);
type DurableRecordType = "memory" | "candidate";

type TransactionStage =
  | "begin"
  | "callback"
  | "receipt_read"
  | "mutation"
  | "audit"
  | "outbox"
  | "receipt_write"
  | "commit";

const SQLSTATE = /^[0-9A-Z]{5}$/;

export interface PostgresMemoryWriteKernelFailureDiagnostic {
  readonly phase: TransactionStage | "connect" | "rollback" | "cleanup";
  readonly code: "TRANSACTION_FAILED" | "TRANSACTION_CONTRACT" | "CONNECTION_FAILED" | "ROLLBACK_FAILED" | "CLEANUP_FAILED";
  readonly sqlState?: string;
}

// Diagnostics stay off thrown/public error objects and never retain the provider cause.
const transactionDiagnostics = new WeakMap<object, Readonly<PostgresMemoryWriteKernelFailureDiagnostic>>();

export function getPostgresMemoryWriteKernelFailureDiagnostic(error: unknown): Readonly<PostgresMemoryWriteKernelFailureDiagnostic> | undefined {
  return error !== null && typeof error === "object" ? transactionDiagnostics.get(error) : undefined;
}

function sqlStateOf(error: unknown): string | undefined {
  try {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
  } catch { return undefined; }
}

function diagnose<T extends Error>(error: T, phase: PostgresMemoryWriteKernelFailureDiagnostic["phase"], code: PostgresMemoryWriteKernelFailureDiagnostic["code"], sqlState?: string): T {
  transactionDiagnostics.set(error, Object.freeze({ phase, code, ...(sqlState ? { sqlState } : {}) }));
  return error;
}

export class PostgresMemoryWriteKernelTransactionError extends Error {
  override readonly name = "PostgresMemoryWriteKernelTransactionError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function transactionFailure(stage: TransactionStage, cause: unknown) {
  const sqlState = sqlStateOf(cause);
  return diagnose(new PostgresMemoryWriteKernelTransactionError(
    `MEMORY_WRITE_TX_${stage.toUpperCase()}_FAILED${sqlState ? `_${sqlState}` : ""}`,
    `Postgres memory write kernel transaction failed at ${stage.replaceAll("_", " ")}`,
  ), stage, "TRANSACTION_FAILED", sqlState);
}

export function isProviderOwnedMemoryWriteKernelTransactionPort(
  value: unknown,
): value is ProviderOwnedMemoryWriteKernelTransactionPort {
  return typeof value === "object" && value !== null && providerOwnedPorts.has(value);
}

export function isProviderOwnedMemoryWriteKernelTransactionWithHooks(
  value: unknown,
  hooks: PostgresMemoryWriteKernelTransactionHooks,
): value is ProviderOwnedMemoryWriteKernelTransactionPort {
  return isProviderOwnedMemoryWriteKernelTransactionPort(value) && providerHooks.get(value) === hooks;
}

class TransactionContractError extends Error {}

function contractError(message: string): never {
  throw new TransactionContractError(message);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    contractError(`Postgres memory write kernel ${label} is invalid`);
  }
  return value;
}

function assertIdentity(identity: WriteIdempotencyIdentity): void {
  requiredString(identity.tenantId, "tenant id");
  requiredString(identity.userId, "user id");
  requiredString(identity.clientKey, "client key");
  if (!SHA256.test(identity.storageKey)) {
    contractError("Postgres memory write kernel storage key is invalid");
  }
}

function sameIdentity(
  left: WriteIdempotencyIdentity,
  right: WriteIdempotencyIdentity,
): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.clientKey === right.clientKey && left.storageKey === right.storageKey;
}

function sameScope(left: WriteScope, right: WriteScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId &&
    left.appId === right.appId && left.projectId === right.projectId &&
    left.agentId === right.agentId && left.namespace === right.namespace &&
    (left.visibility ?? "private") === (right.visibility ?? "private") &&
    (left.workspaceId ?? "") === (right.workspaceId ?? "") &&
    (left.sessionId ?? "") === (right.sessionId ?? "");
}

function assertScopeOwner(scope: WriteScope, identity: WriteIdempotencyIdentity): void {
  if (scope.tenantId !== identity.tenantId || scope.userId !== identity.userId) {
    contractError("Postgres memory write kernel scope owner mismatch");
  }
}

function memoryScopeParams(scope: WriteScope): readonly string[] {
  return [
    requiredString(scope.tenantId, "scope tenant id"),
    requiredString(scope.userId, "scope user id"),
    requiredString(scope.projectId, "scope project id"),
    requiredString(scope.appId, "scope app id"),
    requiredString(scope.agentId, "scope agent id"),
    requiredString(scope.namespace, "scope namespace"),
    scope.visibility ?? "private",
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
  ];
}

function candidateScopeParams(scope: WriteScope): readonly string[] {
  return [
    requiredString(scope.tenantId, "scope tenant id"),
    requiredString(scope.userId, "scope user id"),
    requiredString(scope.appId, "scope app id"),
    requiredString(scope.projectId, "scope project id"),
    requiredString(scope.agentId, "scope agent id"),
    requiredString(scope.namespace, "scope namespace"),
    scope.visibility ?? "private",
    scope.workspaceId ?? "",
    scope.sessionId ?? "",
  ];
}

function normalizeReceipt(
  identity: WriteIdempotencyIdentity,
  fingerprint: unknown,
  result: unknown,
): NormalizedMemoryWriteReceipt {
  if (typeof fingerprint !== "string" || !SHA256.test(fingerprint)) {
    contractError("Postgres memory write kernel receipt row is invalid");
  }
  try {
    return createMemoryWriteReceipt(
      identity,
      fingerprint,
      result as MemoryWriteReceiptResult,
    );
  } catch {
    contractError("Postgres memory write kernel receipt row is invalid");
  }
}

function decodeMemoryReceiptRow(
  row: Record<string, unknown>,
  identity: WriteIdempotencyIdentity,
): NormalizedMemoryWriteReceipt {
  if (Reflect.ownKeys(row).length !== 5 ||
      row.storage_key !== identity.storageKey ||
      row.tenant_id !== identity.tenantId ||
      row.user_id !== identity.userId ||
      typeof row.request_fingerprint !== "string") {
    contractError("Postgres memory write kernel receipt row is invalid");
  }
  return normalizeReceipt(identity, row.request_fingerprint, row.result);
}

function decodeCandidateReceiptRow(
  row: Record<string, unknown>,
  identity: WriteIdempotencyIdentity,
): NormalizedMemoryWriteReceipt {
  const expected = [
    "storage_key", "request_fingerprint", "candidate_id", "tenant_id", "user_id",
    "app_id", "project_id", "agent_id", "namespace", "visibility", "workspace_id",
    "session_id", "route", "result",
  ];
  if (Reflect.ownKeys(row).length !== expected.length ||
      expected.some((key) => !Reflect.ownKeys(row).includes(key)) ||
      row.storage_key !== identity.storageKey || row.tenant_id !== identity.tenantId ||
      row.user_id !== identity.userId || typeof row.candidate_id !== "string" ||
      row.candidate_id.length === 0 || typeof row.route !== "string" ||
      !CANDIDATE_ROUTES.has(row.route as WriteAdmissionRoute)) {
    contractError("Postgres memory write kernel candidate receipt row is invalid");
  }
  for (const field of ["app_id", "project_id", "agent_id", "namespace"] as const) {
    requiredString(row[field], `candidate receipt ${field}`);
  }
  if (!["private", "workspace", "team", "public"].includes(String(row.visibility)) ||
      typeof row.workspace_id !== "string" || typeof row.session_id !== "string") {
    contractError("Postgres memory write kernel candidate receipt row is invalid");
  }
  const receipt = normalizeReceipt(identity, row.request_fingerprint, row.result);
  if (receipt.result.recordType !== "candidate" ||
      !("route" in receipt.result) || receipt.result.route !== row.route ||
      !("candidateId" in receipt.result) || receipt.result.candidateId !== row.candidate_id ||
      receipt.result.memoryId !== row.candidate_id) {
    contractError("Postgres memory write kernel candidate receipt row is invalid");
  }
  return receipt;
}

function eventId(topic: "memory.written" | "candidate.written", storageKey: string, id: string): string {
  return createHash("sha256")
    .update(`${topic}.v1\0${storageKey}\0${id}`)
    .digest("hex");
}

function recordTypeOf(memory: WriteMemoryRecord): DurableRecordType {
  if (memory.mutation !== "content") {
    contractError("Postgres memory write kernel lifecycle changes require the forget transaction");
  }
  if (CANDIDATE_ROUTES.has(memory.route)) return "candidate";
  if (MEMORY_ROUTES.has(memory.route)) return "memory";
  contractError("Postgres memory write kernel cannot persist a drop route");
}

interface TransactionState {
  identity?: WriteIdempotencyIdentity;
  existingReceipt?: MemoryWriteReceipt;
  receiptRead: boolean;
  mutation?: {
    memory: WriteMemoryRecord;
    memoryId: string;
    stored: boolean;
    recordType: DurableRecordType;
  };
  journalFingerprint?: string;
  auditWritten: boolean;
  outboxWritten: boolean;
  receiptWritten: boolean;
}

/**
 * MemoryWriteKernel 的 PostgreSQL callback transaction。
 *
 * Provider 注入的 mutation 必须使用传入 client；端口本身拥有 receipt lock、
 * journal 与 commit，因此 runtime 不能把其它 repository transaction 拼进来。
 */
export class PostgresMemoryWriteKernelTransactionPort
implements ProviderOwnedMemoryWriteKernelTransactionPort {
  constructor(
    private readonly pool: PostgresMemoryWriteKernelPool,
    private readonly mutate: PostgresMemoryWriteKernelMutation,
    private readonly hooks: PostgresMemoryWriteKernelTransactionHooks = {},
  ) {
    if (!pool || typeof pool.connect !== "function" || typeof mutate !== "function") {
      throw new Error("Postgres memory write kernel transaction dependencies are required");
    }
    providerOwnedPorts.add(this);
    providerHooks.set(this, hooks);
  }

  async transaction<T>(
    work: (context: MemoryWriteTransactionContext) => Promise<T>,
  ): Promise<T> {
    if (typeof work !== "function") {
      throw new Error("Postgres memory write kernel transaction callback is required");
    }
    let client: PostgresMemoryWriteKernelClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      throw diagnose(new Error("Postgres memory write kernel connection failed"), "connect", "CONNECTION_FAILED", sqlStateOf(error));
    }
    let begun = false;
    let committed = false;
    let failure: unknown;
    let stage: TransactionStage = "begin";
    const state: TransactionState = {
      receiptRead: false,
      auditWritten: false,
      outboxWritten: false,
      receiptWritten: false,
    };

    const requireIdentity = (): WriteIdempotencyIdentity => {
      if (!state.identity || !state.receiptRead) {
        contractError("Postgres memory write kernel receipt identity must be locked first");
      }
      return state.identity;
    };

    const context: MemoryWriteTransactionContext = {
      getReceipt: async (identity) => {
        stage = "receipt_read";
        assertIdentity(identity);
        if (state.identity && !sameIdentity(state.identity, identity)) {
          contractError("Postgres memory write kernel transaction identity conflict");
        }
        if (state.receiptRead) return state.existingReceipt;
        state.identity = Object.freeze({ ...identity });
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [identity.storageKey]);
        const memoryResult = await client.query(
          `SELECT storage_key, tenant_id, user_id, request_fingerprint, result
FROM mengshu_write_receipts
WHERE storage_key = $1`,
          [identity.storageKey],
        );
        const candidateResult = await client.query(
          `SELECT storage_key, request_fingerprint, candidate_id, tenant_id, user_id,
  app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, route, result
FROM mengshu_candidate_write_receipts
WHERE storage_key = $1`,
          [identity.storageKey],
        );
        if (memoryResult.rows.length > 1 || candidateResult.rows.length > 1 ||
            (memoryResult.rowCount ?? memoryResult.rows.length) !== memoryResult.rows.length ||
            (candidateResult.rowCount ?? candidateResult.rows.length) !== candidateResult.rows.length) {
          contractError("Postgres memory write kernel receipt query is inconsistent");
        }
        if (memoryResult.rows.length === 1 && candidateResult.rows.length === 1) {
          contractError("Postgres memory write kernel idempotency key exists in both receipt journals");
        }
        state.receiptRead = true;
        state.existingReceipt = memoryResult.rows[0]
          ? decodeMemoryReceiptRow(memoryResult.rows[0], identity)
          : candidateResult.rows[0]
          ? decodeCandidateReceiptRow(candidateResult.rows[0], identity)
          : undefined;
        stage = "callback";
        return state.existingReceipt;
      },
      writeMemory: async (memory) => {
        stage = "mutation";
        const identity = requireIdentity();
        if (state.existingReceipt) {
          contractError("Postgres memory write kernel replay cannot mutate memory");
        }
        if (state.mutation) {
          contractError("Postgres memory write kernel supports one mutation per transaction");
        }
        assertScopeOwner(memory.scope, identity);
        const recordType = recordTypeOf(memory);
        await this.hooks.beforeMutation?.(client, memory);
        const result = await this.mutate(client, memory);
        if (!result || typeof result.memoryId !== "string" || result.memoryId.length === 0 ||
            typeof result.stored !== "boolean") {
          contractError("Postgres memory write kernel mutation result is invalid");
        }
        state.mutation = { memory, recordType, ...result };
        stage = "callback";
        return result;
      },
      appendAudit: async (event) => {
        stage = "audit";
        const identity = requireIdentity();
        const mutation = state.mutation;
        if (!mutation || !mutation.stored) {
          contractError("Postgres memory write kernel audit requires a stored mutation");
        }
        if (mutation.memory.mutation !== "content" || event.correctionKind !== undefined) {
          contractError("Postgres memory write kernel lifecycle changes require the forget transaction");
        }
        this.assertJournalEvent(event, mutation.memory, mutation.memoryId, identity);
        if (!SHA256.test(event.requestFingerprint)) {
          contractError("Postgres memory write kernel journal fingerprint is invalid");
        }
        if (state.auditWritten) {
          contractError("Postgres memory write kernel audit was already written");
        }
        const occurredAt = this.timestamp(event.at);
        if (mutation.recordType === "candidate") {
          if (event.action !== "candidate.write" || event.recordType !== "candidate" ||
              !CANDIDATE_ROUTES.has(mutation.memory.route) ||
              event.route !== mutation.memory.route) {
            contractError("Postgres memory write kernel candidate audit is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_candidate_write_audit (
  storage_key, request_fingerprint, candidate_id, action, tenant_id, user_id,
  app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id,
  route, occurred_at
) VALUES ($1, $2, $3, 'candidate.store', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [identity.storageKey, event.requestFingerprint, mutation.memoryId,
              ...candidateScopeParams(event.scope), mutation.memory.route, occurredAt],
          );
        } else {
          if (event.action !== "memory.write" ||
              !MEMORY_ROUTES.has(mutation.memory.route) || event.route !== mutation.memory.route) {
            contractError("Postgres memory write kernel memory audit is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_write_audit (
  storage_key, memory_id, action, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.store', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [identity.storageKey, mutation.memoryId, ...memoryScopeParams(event.scope), occurredAt],
          );
        }
        state.journalFingerprint = event.requestFingerprint;
        state.auditWritten = true;
        stage = "callback";
      },
      appendOutbox: async (event) => {
        stage = "outbox";
        const identity = requireIdentity();
        const mutation = state.mutation;
        if (!mutation || !mutation.stored || !state.auditWritten) {
          contractError("Postgres memory write kernel outbox requires its committed audit");
        }
        if (mutation.memory.mutation !== "content" || event.correctionKind !== undefined) {
          contractError(
            "Postgres memory write kernel lifecycle changes require the forget transaction",
          );
        }
        this.assertJournalEvent(event, mutation.memory, mutation.memoryId, identity);
        if (!SHA256.test(event.requestFingerprint) ||
            event.requestFingerprint !== state.journalFingerprint) {
          contractError("Postgres memory write kernel journal fingerprint is invalid");
        }
        if (state.outboxWritten) {
          contractError("Postgres memory write kernel outbox was already written");
        }
        const occurredAt = this.timestamp(event.at);
        if (mutation.recordType === "candidate") {
          if (event.topic !== "candidate.written" || event.recordType !== "candidate" ||
              !CANDIDATE_ROUTES.has(mutation.memory.route)) {
            contractError("Postgres memory write kernel candidate outbox is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_candidate_write_outbox (
  event_id, storage_key, request_fingerprint, candidate_id, topic, tenant_id, user_id,
  app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id,
  route, occurred_at
) VALUES ($1, $2, $3, $4, 'candidate.written', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [eventId("candidate.written", identity.storageKey, mutation.memoryId),
              identity.storageKey, event.requestFingerprint, mutation.memoryId,
              ...candidateScopeParams(event.scope), mutation.memory.route, occurredAt],
          );
        } else {
          if (event.topic !== "memory.written" ||
              !MEMORY_ROUTES.has(mutation.memory.route)) {
            contractError("Postgres memory write kernel memory outbox is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_write_outbox (
  event_id, storage_key, topic, memory_id, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.written', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
            [eventId("memory.written", identity.storageKey, mutation.memoryId),
              identity.storageKey, mutation.memoryId,
              ...memoryScopeParams(event.scope), occurredAt],
          );
        }
        state.outboxWritten = true;
        stage = "callback";
      },
      saveReceipt: async (receipt) => {
        stage = "receipt_write";
        const identity = requireIdentity();
        const mutation = state.mutation;
        if (!mutation || state.existingReceipt || state.receiptWritten) {
          contractError("Postgres memory write kernel receipt is not writable");
        }
        if (!sameIdentity(receipt.identity, identity) ||
            receipt.result.memoryId !== mutation.memoryId ||
            receipt.result.stored !== mutation.stored ||
            (mutation.stored && receipt.requestFingerprint !== state.journalFingerprint)) {
          contractError("Postgres memory write kernel receipt does not match its mutation");
        }
        if (mutation.stored !== (state.auditWritten && state.outboxWritten)) {
          contractError("Postgres memory write kernel durable journal is incomplete");
        }
        const validated = normalizeReceipt(identity, receipt.requestFingerprint, receipt.result);
        if (mutation.recordType === "candidate") {
          if (validated.result.recordType !== "candidate" ||
              !("route" in validated.result) ||
              !CANDIDATE_ROUTES.has(validated.result.route) ||
              !("candidateId" in validated.result) ||
              validated.result.candidateId !== mutation.memoryId) {
            contractError("Postgres memory write kernel candidate receipt is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_candidate_write_receipts (
  storage_key, request_fingerprint, candidate_id, tenant_id, user_id, app_id,
  project_id, agent_id, namespace, visibility, workspace_id, session_id, route, result
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
            [identity.storageKey, validated.requestFingerprint, mutation.memoryId,
              ...candidateScopeParams(mutation.memory.scope), validated.result.route,
              JSON.stringify(validated.result)],
          );
        } else {
          if (validated.result.recordType !== "memory" ||
              !("route" in validated.result) || !MEMORY_ROUTES.has(validated.result.route)) {
            contractError("Postgres memory write kernel memory receipt is invalid");
          }
          await client.query(
            `INSERT INTO mengshu_write_receipts (
  storage_key, tenant_id, user_id, request_fingerprint, result
) VALUES ($1, $2, $3, $4, $5::jsonb)`,
            [identity.storageKey, identity.tenantId, identity.userId,
              validated.requestFingerprint, JSON.stringify(validated.result)],
          );
        }
        await this.hooks.afterReceipt?.(client, validated, mutation.memory);
        state.receiptWritten = true;
        stage = "callback";
      },
    };

    try {
      await client.query("BEGIN");
      begun = true;
      await this.hooks.afterBegin?.(client);
      stage = "callback";
      const result = await work(context);
      if (state.mutation && !state.receiptWritten) {
        contractError("Postgres memory write kernel mutation is missing its receipt");
      }
      stage = "commit";
      await client.query("COMMIT");
      committed = true;
      return result;
    } catch (error) {
      failure = error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (error) {
          failure = diagnose(new PostgresMemoryWriteKernelTransactionError(
            "MEMORY_WRITE_TX_ROLLBACK_FAILED",
            "Postgres memory write kernel transaction and rollback failed",
          ), "rollback", "ROLLBACK_FAILED", sqlStateOf(error));
        }
      }
      if (failure instanceof TransactionContractError) throw diagnose(failure, stage, "TRANSACTION_CONTRACT");
      if (failure instanceof PostgresMemoryWriteKernelTransactionError) {
        if (!transactionDiagnostics.has(failure)) diagnose(failure, stage, "TRANSACTION_FAILED");
        throw failure;
      }
      throw transactionFailure(stage, failure);
    } finally {
      try {
        client.release();
      } catch (error) {
        if (!failure && committed) {
          throw diagnose(new PostgresMemoryWriteKernelTransactionError(
            "MEMORY_WRITE_TX_CLEANUP_FAILED",
            "Postgres memory write kernel transaction committed but connection cleanup failed",
          ), "cleanup", "CLEANUP_FAILED", sqlStateOf(error));
        }
      }
    }
  }

  private assertJournalEvent(
    event: WriteAuditEvent | WriteOutboxEvent,
    memory: WriteMemoryRecord,
    memoryId: string,
    identity: WriteIdempotencyIdentity,
  ): void {
    assertScopeOwner(event.scope, identity);
    if (!sameScope(event.scope, memory.scope) || event.memoryId !== memoryId ||
        event.commandType !== memory.commandType || event.at !== memory.createdAt) {
      contractError("Postgres memory write kernel journal event does not match its mutation");
    }
  }

  private timestamp(value: number): Date {
    const timestamp = new Date(value);
    if (!Number.isFinite(timestamp.getTime())) {
      contractError("Postgres memory write kernel event time is invalid");
    }
    return timestamp;
  }
}
