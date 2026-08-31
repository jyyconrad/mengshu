import type { MemoryScope } from "../domain/types.js";
import type { MemorySemanticType } from "../domain/types.js";

export type WorkingSetEntryKind =
  | "user_message_ref"
  | "assistant_message_ref"
  | "tool_pair"
  | "tool_result_ref"
  | "task_boundary";

export type WorkingSetEntryStatus =
  | "active"
  | "summarized"
  | "replaced"
  | "expired"
  | "revoked";

export interface SessionPayloadRef {
  readonly provider: "session_log" | "local_file" | "object_store";
  readonly locator: string;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly mimeType?: string;
}

export interface WorkingSetEntry {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly taskBoundaryId?: string;
  readonly kind: WorkingSetEntryKind;
  readonly status: WorkingSetEntryStatus;
  readonly sourceMessageIds: readonly string[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly payloadRef?: SessionPayloadRef;
  readonly summary?: string;
  readonly replaceability: number;
  readonly evidenceRefs: readonly string[];
  readonly riskFlags: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaskOutline {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly taskBoundaryId: string;
  readonly goal: string;
  readonly status: "doing" | "blocked" | "completed" | "abandoned";
  readonly completedSteps: readonly string[];
  readonly currentSteps: readonly string[];
  readonly nextSteps: readonly string[];
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly entryRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly version: number;
  readonly policyVersion: string;
  readonly updatedAt: string;
}

export type ContextRewriteLevel = "normal" | "mild" | "aggressive" | "emergency";

export interface ContextRewriteReceipt {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly taskBoundaryId?: string;
  readonly level: ContextRewriteLevel;
  readonly contextWindow: number;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly targetTokens: number;
  readonly protectedMessageIds: readonly string[];
  readonly replacedEntryIds: readonly string[];
  readonly removedMessageIds: readonly string[];
  readonly injectedOutlineVersion?: number;
  readonly evidenceRefs: readonly string[];
  readonly policyVersion: string;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly warnings: readonly string[];
  readonly createdAt: string;
}

export interface SessionContextMessage {
  readonly id: string;
  readonly role: "system" | "developer" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
}

export interface IngestToolPairInput {
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly taskBoundaryId?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly sourceMessageIds: readonly [string, string] | readonly string[];
  readonly payloadRef: SessionPayloadRef;
  readonly outcome: "success" | "failure" | "permission_denied" | "cancelled";
  readonly summary?: string;
  readonly replaceability: number;
  readonly evidenceRefs: readonly string[];
  readonly riskFlags: readonly string[];
  readonly idempotencyKey: string;
}

export interface WorkingSetAck {
  readonly entry: WorkingSetEntry;
  readonly replayed: boolean;
}

export interface RecordTaskBoundaryInput {
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly taskBoundaryId: string;
  readonly expectedVersion: number;
  readonly goal: string;
  readonly status: TaskOutline["status"];
  readonly completedSteps: readonly string[];
  readonly currentSteps: readonly string[];
  readonly nextSteps: readonly string[];
  readonly decisions: readonly string[];
  readonly openQuestions: readonly string[];
  readonly entryRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly policyVersion: string;
}

export interface TaskBoundaryAck {
  readonly outline: TaskOutline;
}

export interface SessionAssembleInput {
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly taskBoundaryId?: string;
  readonly messages: readonly SessionContextMessage[];
  readonly contextWindow: number;
  readonly protectedMessageIds: readonly string[];
}

export interface SessionAssembleResult {
  readonly messages: readonly SessionContextMessage[];
  readonly outline?: TaskOutline;
  readonly receipt: ContextRewriteReceipt;
}

export interface ReadSessionPayloadInput {
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly entryId: string;
  readonly maxBytes: number;
}

export interface SessionPayloadReadResult {
  readonly entryId: string;
  readonly payloadRef: SessionPayloadRef;
  readonly contentBase64: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
  readonly contentHashVerified: boolean;
  readonly warnings: readonly string[];
}

export interface WorkingSetCleanupReceipt {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly scannedCount: number;
  readonly retainedCount: number;
  readonly archivedCount: number;
  readonly deletedCount: number;
  readonly failedCount: number;
  readonly reason: "session_closed" | "retention_expired";
  readonly retentionDays?: number;
  readonly warnings: readonly string[];
  readonly closedAt: string;
}

export interface WorkingSetRetentionDueSession {
  readonly scope: MemoryScope;
  readonly scopeFingerprint: string;
  readonly sessionId: string;
  readonly retentionDays: number;
  readonly dueAt: string;
}

export interface WorkingSetRetentionBatchResult {
  readonly sessions: number;
  readonly receipts: readonly WorkingSetCleanupReceipt[];
  readonly failedSessions: number;
}

export type WorkingSetPromotionSource =
  | "user_explicit"
  | "verified_decision"
  | "verified_outcome";

export interface PromoteWorkingSetClaimInput {
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly source: WorkingSetPromotionSource;
  readonly text: string;
  readonly semanticType: MemorySemanticType;
  readonly evidenceEntryIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly idempotencyKey: string;
  /** user_explicit 的独立确认；自动来源不得设置。 */
  readonly confirmation?: "REMEMBER";
}

export interface WorkingSetRewritePolicy {
  readonly version: string;
  readonly mildRatio: number;
  readonly aggressiveRatio: number;
  readonly emergencyRatio: number;
  readonly emergencyTargetRatio: number;
  readonly outlineMaxRatio: number;
}
