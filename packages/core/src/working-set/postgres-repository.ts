import { createHash } from "node:crypto";

import type { MemoryScope } from "../domain/types.js";
import type {
  SessionWorkingSetRepository,
  WorkingSetCleanupPlan,
  WorkingSetIdempotencyReceipt,
} from
  "./repository.js";
import type {
  ContextRewriteReceipt,
  SessionPayloadRef,
  TaskOutline,
  WorkingSetCleanupReceipt,
  WorkingSetEntry,
  WorkingSetEntryKind,
  WorkingSetEntryStatus,
  WorkingSetRetentionDueSession,
} from "./types.js";

interface QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresWorkingSetClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  release?(): void;
}

export interface PostgresWorkingSetPool extends PostgresWorkingSetClient {
  connect(): Promise<PostgresWorkingSetClient>;
}

export type PostgresWorkingSetRepositoryErrorCode =
  | "WORKING_SET_DATABASE_FAILED"
  | "WORKING_SET_CONFLICT"
  | "WORKING_SET_INVALID_ROW";

export class PostgresWorkingSetRepositoryError extends Error {
  override readonly name = "PostgresWorkingSetRepositoryError";

  constructor(readonly code: PostgresWorkingSetRepositoryErrorCode) {
    super(code);
  }
}

const ENTRY_KINDS = new Set<WorkingSetEntryKind>([
  "user_message_ref", "assistant_message_ref", "tool_pair", "tool_result_ref", "task_boundary",
]);
const ENTRY_STATUSES = new Set<WorkingSetEntryStatus>([
  "active", "summarized", "replaced", "expired", "revoked",
]);

function timestamp(value: string): number {
  const result = Date.parse(value);
  if (!Number.isFinite(result) || result < 0) {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  return result;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  return [...value];
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  return value;
}

function decodePayload(value: unknown): SessionPayloadRef | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  const row = value as Record<string, unknown>;
  if (!(["session_log", "local_file", "object_store"] as unknown[]).includes(row.provider) ||
      typeof row.locator !== "string" || typeof row.contentHash !== "string" ||
      typeof row.byteLength !== "number") {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  return {
    provider: row.provider as SessionPayloadRef["provider"],
    locator: row.locator,
    contentHash: row.contentHash,
    byteLength: row.byteLength,
    ...(typeof row.mimeType === "string" ? { mimeType: row.mimeType } : {}),
  };
}

function decodeEntry(row: Record<string, unknown> | undefined): WorkingSetEntry | undefined {
  if (row === undefined) return undefined;
  if (typeof row.entry_id !== "string" || typeof row.scope_fingerprint !== "string" ||
      typeof row.session_id !== "string" || typeof row.kind !== "string" ||
      !ENTRY_KINDS.has(row.kind as WorkingSetEntryKind) || typeof row.status !== "string" ||
      !ENTRY_STATUSES.has(row.status as WorkingSetEntryStatus) ||
      typeof row.replaceability !== "number" || typeof row.created_at_ms !== "string" ||
      typeof row.updated_at_ms !== "string") {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  const payloadRef = decodePayload(row.payload_ref);
  return {
    id: row.entry_id,
    scopeFingerprint: row.scope_fingerprint,
    sessionId: row.session_id,
    ...(optionalString(row.task_boundary_id) === undefined
      ? {}
      : { taskBoundaryId: optionalString(row.task_boundary_id)! }),
    kind: row.kind as WorkingSetEntryKind,
    status: row.status as WorkingSetEntryStatus,
    sourceMessageIds: strings(row.source_message_ids),
    ...(optionalString(row.tool_call_id) === undefined ? {} : { toolCallId: row.tool_call_id as string }),
    ...(optionalString(row.tool_name) === undefined ? {} : { toolName: row.tool_name as string }),
    ...(payloadRef === undefined ? {} : { payloadRef }),
    ...(optionalString(row.summary) === undefined ? {} : { summary: row.summary as string }),
    replaceability: row.replaceability,
    evidenceRefs: strings(row.evidence_refs),
    riskFlags: strings(row.risk_flags),
    createdAt: new Date(Number(row.created_at_ms)).toISOString(),
    updatedAt: new Date(Number(row.updated_at_ms)).toISOString(),
  };
}

function decodeCleanupReceipt(value: unknown): WorkingSetCleanupReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  const receipt = value as Record<string, unknown>;
  const counts = ["scannedCount", "retainedCount", "archivedCount", "deletedCount", "failedCount"];
  if (typeof receipt.id !== "string" || typeof receipt.scopeFingerprint !== "string" ||
      typeof receipt.sessionId !== "string" || typeof receipt.closedAt !== "string" ||
      !Array.isArray(receipt.warnings) || receipt.warnings.some((value) => typeof value !== "string") ||
      !counts.every((key) => Number.isSafeInteger(receipt[key]) && Number(receipt[key]) >= 0) ||
      (receipt.reason !== "session_closed" && receipt.reason !== "retention_expired") ||
      (receipt.retentionDays !== undefined &&
        (!Number.isSafeInteger(receipt.retentionDays) || Number(receipt.retentionDays) < 0))) {
    throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
  }
  return structuredClone(receipt) as unknown as WorkingSetCleanupReceipt;
}

const ENTRY_SELECT = `scope_fingerprint, session_id, entry_id, task_boundary_id,
       kind, status, source_message_ids, tool_call_id, tool_name, payload_ref,
       summary, replaceability, evidence_refs, risk_flags,
       (EXTRACT(EPOCH FROM to_timestamp(created_at::double precision / 1000)) * 1000)::bigint::text AS created_at_ms,
       (EXTRACT(EPOCH FROM to_timestamp(updated_at::double precision / 1000)) * 1000)::bigint::text AS updated_at_ms`;

export class PostgresSessionWorkingSetRepository implements SessionWorkingSetRepository {
  constructor(readonly pool: PostgresWorkingSetPool) {}

  async getIdempotencyReceipt(
    scopeFingerprint: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<WorkingSetIdempotencyReceipt | undefined> {
    const result = await this.pool.query<{
      scope_fingerprint: string; session_id: string; idempotency_key: string;
      request_hash: string; entry_id: string;
    }>(
      `/* working-set:get-idempotency */
SELECT scope_fingerprint, session_id, idempotency_key, request_hash, entry_id
FROM mengshu_session_working_set_idempotency_receipts
WHERE scope_fingerprint = $1 AND session_id = $2 AND idempotency_key = $3`,
      [scopeFingerprint, sessionId, idempotencyKey],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : {
      scopeFingerprint: row.scope_fingerprint,
      sessionId: row.session_id,
      idempotencyKey: row.idempotency_key,
      requestHash: row.request_hash,
      entryId: row.entry_id,
    };
  }

  async putToolPairShell(
    entry: WorkingSetEntry,
    receipt: WorkingSetIdempotencyReceipt,
    scope: MemoryScope,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ entry_id: string }>(
        `/* working-set:insert-entry */
INSERT INTO mengshu_session_working_set_entries (
  scope_fingerprint, session_id, entry_id, tenant_id, user_id, app_id, project_id,
  agent_id, namespace, visibility, workspace_id, task_boundary_id, kind, status,
  source_message_ids, tool_call_id, tool_name, payload_ref, summary, replaceability,
  evidence_refs, risk_flags, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
  $15::jsonb, $16, $17, $18::jsonb, $19, $20, $21::jsonb, $22::jsonb, $23, $24)
RETURNING entry_id`,
        [entry.scopeFingerprint, entry.sessionId, entry.id, scope.tenantId, scope.userId,
          scope.appId, scope.projectId, scope.agentId, scope.namespace, scope.visibility,
          scope.workspaceId ?? null, entry.taskBoundaryId ?? null, entry.kind, entry.status,
          JSON.stringify(entry.sourceMessageIds), entry.toolCallId ?? null, entry.toolName ?? null,
          entry.payloadRef === undefined ? null : JSON.stringify(entry.payloadRef),
          entry.summary ?? null, entry.replaceability, JSON.stringify(entry.evidenceRefs),
          JSON.stringify(entry.riskFlags), timestamp(entry.createdAt), timestamp(entry.updatedAt)],
      );
      if (inserted.rowCount !== 1 || inserted.rows[0]?.entry_id !== entry.id) {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      }
      const idempotency = await client.query<{ entry_id: string }>(
        `/* working-set:insert-idempotency */
INSERT INTO mengshu_session_working_set_idempotency_receipts (
  scope_fingerprint, session_id, idempotency_key, request_hash, entry_id, created_at
) VALUES ($1, $2, $3, $4, $5, $6)
RETURNING entry_id`,
        [receipt.scopeFingerprint, receipt.sessionId, receipt.idempotencyKey,
          receipt.requestHash, receipt.entryId, timestamp(entry.createdAt)],
      );
      if (idempotency.rowCount !== 1 || idempotency.rows[0]?.entry_id !== entry.id) {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_DATABASE_FAILED");
      }
      if (error instanceof PostgresWorkingSetRepositoryError) throw error;
      throw new PostgresWorkingSetRepositoryError("WORKING_SET_DATABASE_FAILED");
    } finally {
      client.release?.();
    }
  }

  async updateEntry(entry: WorkingSetEntry): Promise<void> {
    const result = await this.pool.query(
      `/* working-set:update-entry */
UPDATE mengshu_session_working_set_entries SET
  status = $1, summary = $2, replaceability = $3,
  evidence_refs = $4::jsonb, risk_flags = $5::jsonb, updated_at = $6
WHERE scope_fingerprint = $7 AND session_id = $8 AND entry_id = $9
  AND status NOT IN ('expired', 'revoked')
RETURNING entry_id`,
      [entry.status, entry.summary ?? null, entry.replaceability,
        JSON.stringify(entry.evidenceRefs), JSON.stringify(entry.riskFlags),
        timestamp(entry.updatedAt), entry.scopeFingerprint, entry.sessionId, entry.id],
    );
    if (result.rowCount !== 1) throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
  }

  async getEntry(
    scopeFingerprint: string,
    sessionId: string,
    entryId: string,
  ): Promise<WorkingSetEntry | undefined> {
    const result = await this.pool.query(
      `/* working-set:get-entry */
SELECT ${ENTRY_SELECT}
FROM mengshu_session_working_set_entries
WHERE scope_fingerprint = $1 AND session_id = $2 AND entry_id = $3`,
      [scopeFingerprint, sessionId, entryId],
    );
    return decodeEntry(result.rows[0]);
  }

  async listEntries(scopeFingerprint: string, sessionId: string): Promise<readonly WorkingSetEntry[]> {
    const result = await this.pool.query(
      `/* working-set:list-entries */
SELECT ${ENTRY_SELECT}
FROM mengshu_session_working_set_entries
WHERE scope_fingerprint = $1 AND session_id = $2
ORDER BY created_at, entry_id`,
      [scopeFingerprint, sessionId],
    );
    return result.rows.map((row) => decodeEntry(row)!);
  }

  async getTaskOutline(
    scopeFingerprint: string,
    sessionId: string,
    taskBoundaryId: string,
  ): Promise<TaskOutline | undefined> {
    const result = await this.pool.query<{ outline: TaskOutline }>(
      `/* working-set:get-outline */
SELECT versions.outline
FROM mengshu_session_task_outline_heads heads
JOIN mengshu_session_task_outline_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.session_id = heads.session_id
 AND versions.task_boundary_id = heads.task_boundary_id
 AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND heads.session_id = $2 AND heads.task_boundary_id = $3`,
      [scopeFingerprint, sessionId, taskBoundaryId],
    );
    return result.rows[0] === undefined ? undefined : structuredClone(result.rows[0].outline);
  }

  async listTaskOutlines(scopeFingerprint: string, sessionId: string): Promise<readonly TaskOutline[]> {
    const result = await this.pool.query<{ outline: TaskOutline }>(
      `/* working-set:list-outlines */
SELECT versions.outline
FROM mengshu_session_task_outline_heads heads
JOIN mengshu_session_task_outline_versions versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.session_id = heads.session_id
 AND versions.task_boundary_id = heads.task_boundary_id
 AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND heads.session_id = $2
ORDER BY heads.task_boundary_id`,
      [scopeFingerprint, sessionId],
    );
    return result.rows.map((row) => structuredClone(row.outline));
  }

  async appendTaskOutline(outline: TaskOutline, expectedVersion: number): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `working-set-outline:${outline.scopeFingerprint}:${outline.sessionId}:${outline.taskBoundaryId}`,
      ]);
      const hash = createHash("sha256").update(JSON.stringify(outline)).digest("hex");
      const inserted = await client.query(
        `/* working-set:insert-outline */
INSERT INTO mengshu_session_task_outline_versions (
  scope_fingerprint, session_id, task_boundary_id, outline_id, version,
  policy_version, content_hash, outline, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING version`,
        [outline.scopeFingerprint, outline.sessionId, outline.taskBoundaryId, outline.id,
          outline.version, outline.policyVersion, hash, JSON.stringify(outline),
          timestamp(outline.updatedAt)],
      );
      if (inserted.rowCount !== 1) throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      const advanced = expectedVersion === 0
        ? await client.query(
            `/* working-set:advance-outline */
INSERT INTO mengshu_session_task_outline_heads (
  scope_fingerprint, session_id, task_boundary_id, latest_version, updated_at
) VALUES ($1, $2, $3, $4, $5)
RETURNING latest_version`,
            [outline.scopeFingerprint, outline.sessionId, outline.taskBoundaryId,
              outline.version, timestamp(outline.updatedAt)],
          )
        : await client.query(
            `/* working-set:advance-outline */
UPDATE mengshu_session_task_outline_heads SET latest_version = $1, updated_at = $2
WHERE scope_fingerprint = $3 AND session_id = $4 AND task_boundary_id = $5
  AND latest_version = $6
RETURNING latest_version`,
            [outline.version, timestamp(outline.updatedAt), outline.scopeFingerprint,
              outline.sessionId, outline.taskBoundaryId, expectedVersion],
          );
      if (advanced.rowCount !== 1) throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* reported below */ }
      if (error instanceof PostgresWorkingSetRepositoryError) throw error;
      throw new PostgresWorkingSetRepositoryError("WORKING_SET_DATABASE_FAILED");
    } finally {
      client.release?.();
    }
  }

  async appendRewriteReceipt(receipt: ContextRewriteReceipt): Promise<void> {
    const result = await this.pool.query(
      `/* working-set:insert-rewrite */
INSERT INTO mengshu_context_rewrite_receipts (
  receipt_id, scope_fingerprint, session_id, task_boundary_id, input_hash,
  output_hash, policy_version, level, receipt, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
ON CONFLICT (scope_fingerprint, session_id, input_hash, policy_version) DO NOTHING
RETURNING receipt_id`,
      [receipt.id, receipt.scopeFingerprint, receipt.sessionId, receipt.taskBoundaryId ?? null,
        receipt.inputHash, receipt.outputHash, receipt.policyVersion, receipt.level,
        JSON.stringify(receipt), timestamp(receipt.createdAt)],
    );
    if (result.rowCount === 1) return;
    const existing = await this.getRewriteReceipt(receipt.scopeFingerprint, receipt.id);
    if (existing?.inputHash !== receipt.inputHash || existing.outputHash !== receipt.outputHash) {
      throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
    }
  }

  async getRewriteReceipt(
    scopeFingerprint: string,
    receiptId: string,
  ): Promise<ContextRewriteReceipt | undefined> {
    const result = await this.pool.query<{ receipt: ContextRewriteReceipt }>(
      `/* working-set:get-rewrite */
SELECT receipt FROM mengshu_context_rewrite_receipts
WHERE scope_fingerprint = $1 AND receipt_id = $2`,
      [scopeFingerprint, receiptId],
    );
    return result.rows[0] === undefined ? undefined : structuredClone(result.rows[0].receipt);
  }

  async closeSession(plan: WorkingSetCleanupPlan): Promise<WorkingSetCleanupReceipt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `working-set-session:${plan.scopeFingerprint}:${plan.sessionId}`,
      ]);
      const replay = await client.query<{ receipt: unknown }>(
        `/* working-set:get-cleanup-receipt */
SELECT receipt FROM mengshu_session_cleanup_receipts
WHERE scope_fingerprint = $1 AND session_id = $2 AND reason = $3`,
        [plan.scopeFingerprint, plan.sessionId, plan.reason],
      );
      if (replay.rows[0] !== undefined) {
        await client.query("COMMIT");
        return decodeCleanupReceipt(replay.rows[0].receipt);
      }
      const locked = await client.query<{ entry_id: string; status: WorkingSetEntryStatus }>(
        `/* working-set:lock-session */
SELECT entry_id, status FROM mengshu_session_working_set_entries
WHERE scope_fingerprint = $1 AND session_id = $2
ORDER BY entry_id FOR UPDATE`,
        [plan.scopeFingerprint, plan.sessionId],
      );
      const entryIds = new Set(locked.rows.map((row) => row.entry_id));
      const retained = new Set(plan.retainedEntryIds.filter((id) => entryIds.has(id)));
      for (const row of locked.rows) {
        if (plan.reason === "session_closed" &&
            (row.status === "expired" || row.status === "revoked")) retained.add(row.entry_id);
      }
      const deleted = new Set(plan.deletedPayloadEntryIds.filter((id) =>
        entryIds.has(id) && !retained.has(id)));
      const failed = new Set(plan.failedPayloadEntryIds.filter((id) =>
        entryIds.has(id) && !retained.has(id) && !deleted.has(id)));
      const time = timestamp(plan.closedAt);
      const updated = await client.query(
        `/* working-set:close-session */
UPDATE mengshu_session_working_set_entries SET status = 'expired', updated_at = $1
WHERE scope_fingerprint = $2 AND session_id = $3
  AND status NOT IN ('expired', 'revoked')
RETURNING entry_id`,
        [time, plan.scopeFingerprint, plan.sessionId],
      );
      if ((updated.rowCount ?? 0) !== locked.rows.filter((row) =>
        row.status !== "expired" && row.status !== "revoked").length) {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      }
      const archivedCount = locked.rows.length - retained.size - deleted.size - failed.size;
      const receipt: WorkingSetCleanupReceipt = {
        id: createHash("sha256").update(JSON.stringify([
          plan.scopeFingerprint, plan.sessionId, time, locked.rows.length,
          [...retained].sort(), [...deleted].sort(), [...failed].sort(),
        ])).digest("hex"),
        scopeFingerprint: plan.scopeFingerprint,
        sessionId: plan.sessionId,
        scannedCount: locked.rows.length,
        retainedCount: retained.size,
        archivedCount,
        deletedCount: deleted.size,
        failedCount: failed.size,
        reason: plan.reason,
        ...(plan.retentionDays === undefined ? {} : { retentionDays: plan.retentionDays }),
        warnings: [...new Set(plan.warnings)].sort(),
        closedAt: plan.closedAt,
      };
      await client.query(
        `/* working-set:insert-close-receipt */
INSERT INTO mengshu_session_close_receipts (
  receipt_id, scope_fingerprint, session_id, expired_entries, reason, closed_at
) VALUES ($1, $2, $3, $4, 'session_closed', $5)
ON CONFLICT (scope_fingerprint, session_id) DO NOTHING`,
        [receipt.id, plan.scopeFingerprint, plan.sessionId, updated.rowCount ?? 0, time],
      );
      const detailed = await client.query(
        `/* working-set:insert-cleanup-receipt */
INSERT INTO mengshu_session_cleanup_receipts (
  receipt_id, scope_fingerprint, session_id, reason, receipt, closed_at
) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
RETURNING receipt_id`,
        [receipt.id, plan.scopeFingerprint, plan.sessionId, plan.reason,
          JSON.stringify(receipt), time],
      );
      if (detailed.rowCount !== 1) {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_CONFLICT");
      }
      await client.query("COMMIT");
      return receipt;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* stable error below */ }
      if (error instanceof PostgresWorkingSetRepositoryError) throw error;
      throw new PostgresWorkingSetRepositoryError("WORKING_SET_DATABASE_FAILED");
    } finally {
      client.release?.();
    }
  }

  async listRetentionDue(now: string, limit: number): Promise<readonly WorkingSetRetentionDueSession[]> {
    const nowMs = timestamp(now);
    const result = await this.pool.query<{
      scope_fingerprint: string;
      session_id: string;
      retention_days: number | string;
      closed_at: number | string;
      tenant_id: string;
      user_id: string;
      app_id: string;
      project_id: string;
      agent_id: string;
      namespace: string;
      visibility: "private";
      workspace_id: string | null;
    }>(
      `/* working-set:list-retention-due */
SELECT closed.scope_fingerprint, closed.session_id,
       (closed.receipt->>'retentionDays')::integer AS retention_days,
       closed.closed_at,
       identity.tenant_id, identity.user_id, identity.app_id, identity.project_id,
       identity.agent_id, identity.namespace, identity.visibility, identity.workspace_id
FROM mengshu_session_cleanup_receipts closed
JOIN LATERAL (
  SELECT tenant_id, user_id, app_id, project_id, agent_id, namespace,
         visibility, workspace_id
  FROM mengshu_session_working_set_entries entries
  WHERE entries.scope_fingerprint = closed.scope_fingerprint
    AND entries.session_id = closed.session_id
  ORDER BY entry_id LIMIT 1
) identity ON TRUE
WHERE closed.reason = 'session_closed'
  AND (closed.receipt->>'retentionDays')::integer > 0
  AND closed.closed_at + (closed.receipt->>'retentionDays')::integer * 86400000 <= $1
  AND NOT EXISTS (
    SELECT 1 FROM mengshu_session_cleanup_receipts completed
    WHERE completed.scope_fingerprint = closed.scope_fingerprint
      AND completed.session_id = closed.session_id
      AND completed.reason = 'retention_expired'
  )
ORDER BY closed.closed_at, closed.scope_fingerprint, closed.session_id
LIMIT $2`,
      [nowMs, limit],
    );
    return result.rows.map((row) => {
      const retentionDays = Number(row.retention_days);
      const closedAt = Number(row.closed_at);
      if (!Number.isSafeInteger(retentionDays) || retentionDays < 1 ||
          !Number.isSafeInteger(closedAt) || closedAt < 0 || row.visibility !== "private") {
        throw new PostgresWorkingSetRepositoryError("WORKING_SET_INVALID_ROW");
      }
      return {
        scope: {
          tenantId: row.tenant_id,
          userId: row.user_id,
          appId: row.app_id,
          projectId: row.project_id,
          agentId: row.agent_id,
          namespace: row.namespace,
          visibility: "private",
          sessionId: row.session_id,
          ...(row.workspace_id === null ? {} : { workspaceId: row.workspace_id }),
        },
        scopeFingerprint: row.scope_fingerprint,
        sessionId: row.session_id,
        retentionDays,
        dueAt: new Date(closedAt + retentionDays * 86_400_000).toISOString(),
      };
    });
  }
}
