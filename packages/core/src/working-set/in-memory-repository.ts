import type {
  SessionWorkingSetRepository,
  WorkingSetCleanupPlan,
  WorkingSetIdempotencyReceipt,
} from
  "./repository.js";
import type {
  ContextRewriteReceipt,
  TaskOutline,
  WorkingSetCleanupReceipt,
  WorkingSetEntry,
  WorkingSetRetentionDueSession,
} from "./types.js";
import { createHash } from "node:crypto";
import type { MemoryScope } from "../domain/types.js";

function key(...parts: readonly string[]): string {
  return parts.join("\0");
}

export class InMemorySessionWorkingSetRepository implements SessionWorkingSetRepository {
  readonly auditLog: Array<{
    readonly operation: "persist_shell" | "attach_summary" | "replace" | "outline" | "rewrite" | "close";
    readonly id: string;
  }> = [];

  readonly #entries = new Map<string, WorkingSetEntry>();
  readonly #idempotency = new Map<string, WorkingSetIdempotencyReceipt>();
  readonly #outlines = new Map<string, TaskOutline>();
  readonly #rewrites = new Map<string, ContextRewriteReceipt>();
  readonly #cleanupReceipts = new Map<string, WorkingSetCleanupReceipt>();
  readonly #scopes = new Map<string, MemoryScope>();

  async getIdempotencyReceipt(
    scopeFingerprint: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<WorkingSetIdempotencyReceipt | undefined> {
    return structuredClone(this.#idempotency.get(key(scopeFingerprint, sessionId, idempotencyKey)));
  }

  async putToolPairShell(
    entry: WorkingSetEntry,
    receipt: WorkingSetIdempotencyReceipt,
    scope: MemoryScope,
  ): Promise<void> {
    const entryKey = key(entry.scopeFingerprint, entry.sessionId, entry.id);
    const receiptKey = key(receipt.scopeFingerprint, receipt.sessionId, receipt.idempotencyKey);
    if (this.#entries.has(entryKey) || this.#idempotency.has(receiptKey)) {
      throw new Error("WORKING_SET_CONFLICT");
    }
    this.#entries.set(entryKey, structuredClone(entry));
    this.#idempotency.set(receiptKey, structuredClone(receipt));
    this.#scopes.set(key(entry.scopeFingerprint, entry.sessionId), structuredClone(scope));
    this.auditLog.push({ operation: "persist_shell", id: entry.id });
  }

  async updateEntry(entry: WorkingSetEntry): Promise<void> {
    const entryKey = key(entry.scopeFingerprint, entry.sessionId, entry.id);
    const previous = this.#entries.get(entryKey);
    if (previous === undefined) throw new Error("WORKING_SET_NOT_FOUND");
    this.#entries.set(entryKey, structuredClone(entry));
    this.auditLog.push({
      operation: previous.summary === undefined && entry.summary !== undefined
        ? "attach_summary"
        : "replace",
      id: entry.id,
    });
  }

  async getEntry(
    scopeFingerprint: string,
    sessionId: string,
    entryId: string,
  ): Promise<WorkingSetEntry | undefined> {
    return structuredClone(this.#entries.get(key(scopeFingerprint, sessionId, entryId)));
  }

  async listEntries(scopeFingerprint: string, sessionId: string): Promise<readonly WorkingSetEntry[]> {
    return [...this.#entries.values()]
      .filter((entry) => entry.scopeFingerprint === scopeFingerprint && entry.sessionId === sessionId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
      .map((entry) => structuredClone(entry));
  }

  async getTaskOutline(
    scopeFingerprint: string,
    sessionId: string,
    taskBoundaryId: string,
  ): Promise<TaskOutline | undefined> {
    return structuredClone(this.#outlines.get(key(scopeFingerprint, sessionId, taskBoundaryId)));
  }

  async listTaskOutlines(scopeFingerprint: string, sessionId: string): Promise<readonly TaskOutline[]> {
    return [...this.#outlines.values()]
      .filter((outline) => outline.scopeFingerprint === scopeFingerprint &&
        outline.sessionId === sessionId)
      .sort((left, right) => left.taskBoundaryId.localeCompare(right.taskBoundaryId))
      .map((outline) => structuredClone(outline));
  }

  async appendTaskOutline(outline: TaskOutline, expectedVersion: number): Promise<void> {
    const outlineKey = key(outline.scopeFingerprint, outline.sessionId, outline.taskBoundaryId);
    const previous = this.#outlines.get(outlineKey);
    if ((previous?.version ?? 0) !== expectedVersion || outline.version !== expectedVersion + 1) {
      throw new Error("WORKING_SET_VERSION_STALE");
    }
    this.#outlines.set(outlineKey, structuredClone(outline));
    this.auditLog.push({ operation: "outline", id: outline.id });
  }

  async appendRewriteReceipt(receipt: ContextRewriteReceipt): Promise<void> {
    const receiptKey = key(receipt.scopeFingerprint, receipt.id);
    const existing = this.#rewrites.get(receiptKey);
    if (existing !== undefined && existing.inputHash !== receipt.inputHash) {
      throw new Error("WORKING_SET_CONFLICT");
    }
    this.#rewrites.set(receiptKey, structuredClone(receipt));
    this.auditLog.push({ operation: "rewrite", id: receipt.id });
  }

  async getRewriteReceipt(
    scopeFingerprint: string,
    receiptId: string,
  ): Promise<ContextRewriteReceipt | undefined> {
    return structuredClone(this.#rewrites.get(key(scopeFingerprint, receiptId)));
  }

  async closeSession(plan: WorkingSetCleanupPlan): Promise<WorkingSetCleanupReceipt> {
    const cleanupKey = key(plan.scopeFingerprint, plan.sessionId, plan.reason);
    const existing = this.#cleanupReceipts.get(cleanupKey);
    if (existing !== undefined) return structuredClone(existing);
    const entries = [...this.#entries.entries()].filter(([, entry]) =>
      entry.scopeFingerprint === plan.scopeFingerprint && entry.sessionId === plan.sessionId);
    const entryIds = new Set(entries.map(([, entry]) => entry.id));
    const retained = new Set(plan.retainedEntryIds.filter((id) => entryIds.has(id)));
    const deleted = new Set(plan.deletedPayloadEntryIds.filter((id) =>
      entryIds.has(id) && !retained.has(id)));
    const failed = new Set(plan.failedPayloadEntryIds.filter((id) =>
      entryIds.has(id) && !retained.has(id) && !deleted.has(id)));
    for (const [entryKey, entry] of this.#entries) {
      if (entry.scopeFingerprint !== plan.scopeFingerprint || entry.sessionId !== plan.sessionId ||
          entry.status === "revoked" || entry.status === "expired") continue;
      this.#entries.set(entryKey, { ...entry, status: "expired", updatedAt: plan.closedAt });
    }
    const archivedCount = entries.length - retained.size - deleted.size - failed.size;
    const receipt: WorkingSetCleanupReceipt = {
      id: createHash("sha256").update(JSON.stringify([
        plan.scopeFingerprint, plan.sessionId, plan.closedAt, entries.length,
        [...retained].sort(), [...deleted].sort(), [...failed].sort(),
      ])).digest("hex"),
      scopeFingerprint: plan.scopeFingerprint,
      sessionId: plan.sessionId,
      scannedCount: entries.length,
      retainedCount: retained.size,
      archivedCount,
      deletedCount: deleted.size,
      failedCount: failed.size,
      reason: plan.reason,
      ...(plan.retentionDays === undefined ? {} : { retentionDays: plan.retentionDays }),
      warnings: [...new Set(plan.warnings)].sort(),
      closedAt: plan.closedAt,
    };
    this.#cleanupReceipts.set(cleanupKey, structuredClone(receipt));
    this.auditLog.push({ operation: "close", id: plan.sessionId });
    return structuredClone(receipt);
  }

  async listRetentionDue(now: string, limit: number): Promise<readonly WorkingSetRetentionDueSession[]> {
    const nowMs = Date.parse(now);
    const values: WorkingSetRetentionDueSession[] = [];
    for (const receipt of this.#cleanupReceipts.values()) {
      if (receipt.reason !== "session_closed" || receipt.retentionDays === undefined ||
          receipt.retentionDays <= 0 ||
          this.#cleanupReceipts.has(key(receipt.scopeFingerprint, receipt.sessionId, "retention_expired"))) {
        continue;
      }
      const dueAtMs = Date.parse(receipt.closedAt) + receipt.retentionDays * 86_400_000;
      const scope = this.#scopes.get(key(receipt.scopeFingerprint, receipt.sessionId));
      if (dueAtMs > nowMs || scope === undefined) continue;
      values.push({
        scope: structuredClone(scope),
        scopeFingerprint: receipt.scopeFingerprint,
        sessionId: receipt.sessionId,
        retentionDays: receipt.retentionDays,
        dueAt: new Date(dueAtMs).toISOString(),
      });
    }
    return values.sort((left, right) => left.dueAt.localeCompare(right.dueAt) ||
      left.sessionId.localeCompare(right.sessionId)).slice(0, limit);
  }
}
