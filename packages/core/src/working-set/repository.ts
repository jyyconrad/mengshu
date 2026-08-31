import type {
  ContextRewriteReceipt,
  TaskOutline,
  WorkingSetCleanupReceipt,
  WorkingSetRetentionDueSession,
  WorkingSetEntry,
} from "./types.js";
import type { MemoryScope } from "../domain/types.js";

export interface WorkingSetIdempotencyReceipt {
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly entryId: string;
}

export interface WorkingSetCleanupPlan {
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly retainedEntryIds: readonly string[];
  readonly deletedPayloadEntryIds: readonly string[];
  readonly failedPayloadEntryIds: readonly string[];
  readonly reason: WorkingSetCleanupReceipt["reason"];
  readonly retentionDays?: number;
  readonly warnings: readonly string[];
  readonly closedAt: string;
}

export interface SessionWorkingSetRepository {
  getIdempotencyReceipt(
    scopeFingerprint: string,
    sessionId: string,
    idempotencyKey: string,
  ): Promise<WorkingSetIdempotencyReceipt | undefined>;
  putToolPairShell(
    entry: WorkingSetEntry,
    receipt: WorkingSetIdempotencyReceipt,
    scope: MemoryScope,
  ): Promise<void>;
  updateEntry(entry: WorkingSetEntry): Promise<void>;
  getEntry(scopeFingerprint: string, sessionId: string, entryId: string): Promise<WorkingSetEntry | undefined>;
  listEntries(scopeFingerprint: string, sessionId: string): Promise<readonly WorkingSetEntry[]>;
  getTaskOutline(
    scopeFingerprint: string,
    sessionId: string,
    taskBoundaryId: string,
  ): Promise<TaskOutline | undefined>;
  listTaskOutlines(scopeFingerprint: string, sessionId: string): Promise<readonly TaskOutline[]>;
  appendTaskOutline(outline: TaskOutline, expectedVersion: number): Promise<void>;
  appendRewriteReceipt(receipt: ContextRewriteReceipt): Promise<void>;
  getRewriteReceipt(
    scopeFingerprint: string,
    receiptId: string,
  ): Promise<ContextRewriteReceipt | undefined>;
  closeSession(plan: WorkingSetCleanupPlan): Promise<WorkingSetCleanupReceipt>;
  listRetentionDue(now: string, limit: number): Promise<readonly WorkingSetRetentionDueSession[]>;
}
