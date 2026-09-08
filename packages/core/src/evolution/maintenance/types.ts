import type { MemoryScope } from "../../domain/types.js";
import type { EvolutionLease } from "../types.js";

export interface MaintenanceBudget {
  records: number;
  files: number;
  bytes: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costMicros: number;
}

export type MaintenanceKind = "revalidate" | "merge_equivalent" | "compile_pattern" | "propose_skill" | "retention" | "source_reconcile";
export interface MaintenanceWorkItem {
  id: string;
  kind: MaintenanceKind;
  scope: MemoryScope;
  revision: string;
  dueAt: number;
  lastAttemptAt?: number;
  budget: MaintenanceBudget;
}

export interface MaintenanceEnvironment {
  enabled: boolean;
  foregroundBusy: boolean;
  storageHealthy: boolean;
  now: number;
  remaining: MaintenanceBudget;
  maxTasks: number;
}

/** Provider orders by lastAttemptAt (never attempted first), dueAt, id; limit is mandatory. */
export interface MaintenanceDuePort {
  listDue(input: { now: number; limit: number }): Promise<MaintenanceWorkItem[]>;
  markEnqueued(input: { scope: MemoryScope; id: string; expectedRevision: string; at: number; jobId: string }): Promise<void>;
}

/** Shared daily ledger; reserve atomically across scopes/workers, never a per-task counter. */
export interface MaintenanceBudgetPort {
  reserve(input: { idempotencyKey: string; budget: MaintenanceBudget }): Promise<{ id: string } | undefined>;
}

export interface MaintenanceEnqueuePort {
  enqueue(input: { item: MaintenanceWorkItem; reservationId: string; idempotencyKey: string }): Promise<{ jobId: string }>;
}

export interface MaintenanceOutcome {
  scope: MemoryScope;
  workId: string;
  inputFingerprint: string;
  policyVersion: string;
  outcome: "rejected" | "noop" | "failed";
  reasonCode: string;
  at: number;
}

export interface RetentionCandidate {
  id: string;
  revision: string;
  kind: "temporary_artifact" | "rejected_proposal_body" | "noop_proposal_body" | "orphan_evidence";
  expiresAt: number;
}

export interface MaintenanceRetentionPort {
  /** UPSERT one aggregate per fingerprint, dedup eventId; no raw error/proposal body. */
  recordOutcome(input: MaintenanceOutcome & { fingerprint: string; eventId: string; retryAfter: number }): Promise<void>;
  listExpired(input: { scope: MemoryScope; before: number; limit: number }): Promise<RetentionCandidate[]>;
  /** Atomic reference/CAS recheck. Preserve current/historical support, receipts, tombstones and audit roots. */
  cleanupUnreferenced(input: { scope: MemoryScope; candidate: RetentionCandidate; lease: EvolutionLease }): Promise<{
    status: "deleted" | "referenced" | "stale";
    receiptId?: string;
  }>;
}

export interface EquivalentClaim {
  memoryId: string;
  revision: number;
  contentHash: string;
  scope: MemoryScope;
  subject: string;
  predicate: string;
  object: string;
  applicability: string[];
  validFrom?: number;
  validTo?: number;
  polarity: "positive" | "negative";
  /** Must be a persisted verifier receipt, not an LLM claim of equivalence. */
  verificationReceiptId?: string;
  evidenceRootIds: string[];
  confidence: number;
  blocked?: boolean;
}

export interface EquivalentMergePlan {
  id: string;
  canonical: EquivalentClaim;
  alias: EquivalentClaim;
  proofHash: string;
  confidenceCeiling: number;
  preserveAliases: true;
}

export interface EquivalentMergePort {
  /** Rehydrate and recheck proof/receipts/CAS/scope under the job fence; retain aliases and history. */
  mergeEquivalent(input: { plan: EquivalentMergePlan; lease: EvolutionLease }): Promise<{ receiptId: string }>;
}
