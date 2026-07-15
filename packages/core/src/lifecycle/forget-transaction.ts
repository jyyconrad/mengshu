import { createHash } from "node:crypto";
import { resolveAuthorityScope } from "../domain/authority-scope.js";
import {
  normalizeProviderFilter,
  type NormalizedProviderFilter,
  type ProviderFilterValues,
} from "../domain/provider-filter.js";
import type {
  AuthorityScopedForgetAction,
  AuthorityScopedForgetInput,
  AuthorityScopedForgetResult,
  ForgetAuditEvent,
  ForgetOutboxEvent,
  ForgetTargetSelection,
  ForgetTransactionPort,
} from "../domain/service-types.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type { ForgetAuditEntry, LifecycleStatus } from "./forget-types.js";

export type AuthorityScopedForgetErrorCode =
  | "TRANSACTION_UNAVAILABLE"
  | "AUTHORITY_REQUIRED"
  | "INVALID_REQUEST"
  | "IDEMPOTENCY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "TARGET_NOT_FOUND_OR_FORBIDDEN";

export class AuthorityScopedForgetError extends Error {
  readonly code: AuthorityScopedForgetErrorCode;

  constructor(code: AuthorityScopedForgetErrorCode, message: string) {
    super(message);
    this.name = "AuthorityScopedForgetError";
    this.code = code;
  }
}

const ACTIONS = new Set<AuthorityScopedForgetAction>(["revoke", "archive", "delete"]);
const SCOPE_FILTER_FIELDS = [
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
] as const;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new AuthorityScopedForgetError(
      "IDEMPOTENCY_REQUIRED",
      "transactional forget requires a canonical idempotency key",
    );
  }
  return value;
}

function validateAction(value: unknown): AuthorityScopedForgetAction {
  if (typeof value !== "string" || !ACTIONS.has(value as AuthorityScopedForgetAction)) {
    throw new AuthorityScopedForgetError("INVALID_REQUEST", "forget action is not supported");
  }
  return value as AuthorityScopedForgetAction;
}

function validateNow(value: unknown): number {
  const now = value ?? Date.now();
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    throw new AuthorityScopedForgetError("INVALID_REQUEST", "forget timestamp is invalid");
  }
  return now;
}

function scopedFilter(
  requested: ProviderFilterValues,
  scope: MemoryScope,
): ProviderFilterValues {
  const result: ProviderFilterValues = { ...requested };
  for (const field of SCOPE_FILTER_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(requested, field) &&
      requested[field] !== scope[field]
    ) {
      throw new AuthorityScopedForgetError(
        "TARGET_NOT_FOUND_OR_FORBIDDEN",
        "forget target was not found or is not authorized",
      );
    }
    result[field] = scope[field] as never;
  }
  return result;
}

function normalizeSelection(
  input: AuthorityScopedForgetInput,
  scope: MemoryScope,
): ForgetTargetSelection {
  const hasIds = Array.isArray(input.ids) && input.ids.length > 0;
  const hasFilter = input.filter !== undefined;
  if (hasIds === hasFilter) {
    throw new AuthorityScopedForgetError(
      "INVALID_REQUEST",
      "forget requires exactly one of ids or filter",
    );
  }

  const tableName = input.tableName ?? "memories";
  const dataTypes = input.dataTypes ?? (tableName === "memories" ? ["memory"] : ["knowledge"]);
  const providerAuthority = { tenantId: scope.tenantId, userId: scope.userId };

  if (hasIds) {
    const ids = [...input.ids!].sort();
    if (new Set(ids).size !== ids.length) {
      throw new AuthorityScopedForgetError("INVALID_REQUEST", "forget ids must be unique");
    }
    const filters = ids.map((id) =>
      normalizeProviderFilter(providerAuthority, {
        operation: "delete",
        tableName,
        dataTypes,
        filter: scopedFilter({ id }, scope),
      }));
    return { kind: "ids", scope, tableName, dataTypes: filters[0]!.dataTypes, filters };
  }

  const requested = input.filter as ProviderFilterValues;
  if (
    !requested ||
    typeof requested !== "object" ||
    Array.isArray(requested) ||
    Object.keys(requested).length === 0
  ) {
    throw new AuthorityScopedForgetError(
      "INVALID_REQUEST",
      "filter forget requires at least one explicit filter",
    );
  }
  const filter = normalizeProviderFilter(providerAuthority, {
    operation: "delete",
    tableName,
    dataTypes,
    filter: scopedFilter(requested, scope),
  });
  return { kind: "filter", scope, tableName, dataTypes: filter.dataTypes, filter };
}

function requestFingerprint(
  action: AuthorityScopedForgetAction,
  selection: ForgetTargetSelection,
  input: AuthorityScopedForgetInput,
): string {
  const normalizedSelection = selection.kind === "ids"
    ? selection.filters.map((filter) => filter.filter)
    : selection.filter.filter;
  return createHash("sha256")
    .update(JSON.stringify({
      action,
      actor: input.actor,
      reason: input.reason,
      scope: selection.scope,
      tableName: selection.tableName,
      dataTypes: selection.dataTypes,
      selection: normalizedSelection,
    }))
    .digest("hex");
}

function sameOwnedScope(record: MemoryRecord, expected: MemoryScope): boolean {
  const actualVisibility = record.scope.visibility ?? "private";
  return (
    record.scope.tenantId === expected.tenantId &&
    record.scope.userId === expected.userId &&
    record.scope.appId === expected.appId &&
    record.scope.projectId === expected.projectId &&
    record.scope.agentId === expected.agentId &&
    record.scope.namespace === expected.namespace &&
    actualVisibility === expected.visibility
  );
}

function matchesStorageSelection(record: MemoryRecord, selection: ForgetTargetSelection): boolean {
  const actualTable = record.tableName ?? (record.dataType === "memory" ? "memories" : "knowledge");
  return actualTable === selection.tableName && selection.dataTypes.includes(record.dataType);
}

function validateTargets(
  records: readonly MemoryRecord[],
  selection: ForgetTargetSelection,
): MemoryRecord[] {
  const unique = new Map(records.map((record) => [record.id, record]));
  const expectedIds = selection.kind === "ids"
    ? selection.filters.map((filter) => String(filter.filter.id))
    : undefined;
  if (
    (expectedIds && (unique.size !== expectedIds.length || expectedIds.some((id) => !unique.has(id)))) ||
    records.some(
      (record) =>
        !sameOwnedScope(record, selection.scope) ||
        !matchesStorageSelection(record, selection),
    )
  ) {
    throw new AuthorityScopedForgetError(
      "TARGET_NOT_FOUND_OR_FORBIDDEN",
      "forget target was not found or is not authorized",
    );
  }
  return Array.from(unique.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function lifecycleUpdate(
  record: MemoryRecord,
  action: "revoke" | "archive",
  input: AuthorityScopedForgetInput,
  now: number,
): MemoryRecord | undefined {
  const nextStatus: LifecycleStatus = action === "revoke" ? "revoked" : "archived";
  const currentStatus = (record.lifecycleStatus ?? record.metadata.lifecycleStatus ?? "active") as LifecycleStatus;
  if (currentStatus === nextStatus) return undefined;

  const entry: ForgetAuditEntry = {
    action,
    at: now,
    actor: input.actor,
    reason: input.reason,
    before: { lifecycleStatus: currentStatus },
    after: { lifecycleStatus: nextStatus },
  };
  const existingLog = Array.isArray(record.metadata.forgetLog)
    ? (record.metadata.forgetLog as ForgetAuditEntry[])
    : [];
  return {
    ...record,
    lifecycleStatus: nextStatus,
    metadata: {
      ...record.metadata,
      lifecycleStatus: nextStatus,
      forgetLog: [...existingLog, entry],
    },
    updatedAt: now,
  };
}

function eventsFor(
  records: readonly MemoryRecord[],
  input: AuthorityScopedForgetInput,
  action: AuthorityScopedForgetAction,
  idempotencyKey: string,
  now: number,
): { audit: ForgetAuditEvent[]; outbox: ForgetOutboxEvent[] } {
  return {
    audit: records.map((record) => {
      const latestForgetLog = Array.isArray(record.metadata.forgetLog)
        ? (record.metadata.forgetLog as ForgetAuditEntry[]).at(-1)
        : undefined;
      return {
        idempotencyKey,
        action,
        targetId: record.id,
        scope: record.scope,
        actor: input.actor,
        reason: input.reason,
        at: now,
        before: action === "delete"
          ? { lifecycleStatus: record.lifecycleStatus ?? record.metadata.lifecycleStatus ?? "active" }
          : latestForgetLog?.before,
        after: action === "delete" ? { deleted: true } : latestForgetLog?.after,
      };
    }),
    outbox: records.map((record) => ({
      eventId: `${idempotencyKey}:${record.id}`,
      idempotencyKey,
      topic: action === "delete" ? "memory.deleted" : "memory.lifecycle.changed",
      action,
      targetId: record.id,
      scope: record.scope,
      occurredAt: now,
    })),
  };
}

/**
 * 事务化、authority-scoped forget 内核。所有输入验证在开启事务前完成；所有
 * 记录变更、audit、outbox、receipt 在同一个 provider transaction 内提交。
 */
export async function executeAuthorityScopedForget(
  port: ForgetTransactionPort | undefined,
  input: AuthorityScopedForgetInput,
): Promise<AuthorityScopedForgetResult> {
  if (!port || typeof port.transaction !== "function") {
    throw new AuthorityScopedForgetError(
      "TRANSACTION_UNAVAILABLE",
      "provider does not support transactional forget",
    );
  }
  const action = validateAction(input.action);
  const idempotencyKey = validateIdempotencyKey(input.idempotencyKey);
  const now = validateNow(input.now);
  const scope = resolveAuthorityScope(input.serverAuthority, input.clientScope);
  const selection = normalizeSelection(input, scope);
  const fingerprint = requestFingerprint(action, selection, input);

  return port.transaction(async (transaction) => {
    const existingReceipt = await transaction.getReceipt(scope, idempotencyKey);
    if (existingReceipt) {
      if (existingReceipt.requestFingerprint !== fingerprint) {
        throw new AuthorityScopedForgetError(
          "IDEMPOTENCY_CONFLICT",
          "idempotency key was already used for a different forget request",
        );
      }
      return { ...existingReceipt.result, idempotentReplay: true };
    }

    const targets = validateTargets(await transaction.findTargets(selection), selection);
    const changed = action === "delete"
      ? targets
      : targets.flatMap((record) => {
          const updated = lifecycleUpdate(record, action, input, now);
          return updated ? [updated] : [];
        });

    if (action === "delete") {
      await transaction.delete(changed.map((record) => record.id));
    } else {
      await transaction.replace(changed);
    }

    const events = eventsFor(changed, input, action, idempotencyKey, now);
    await transaction.appendAudit(events.audit);
    await transaction.appendOutbox(events.outbox);

    const result: AuthorityScopedForgetResult = {
      action,
      affected: changed.length,
      deleted: action === "delete" ? changed.length : 0,
      affectedIds: changed.map((record) => record.id),
      transactional: true,
      idempotentReplay: false,
    };
    await transaction.saveReceipt({ idempotencyKey, scope, requestFingerprint: fingerprint, result });
    return result;
  });
}
