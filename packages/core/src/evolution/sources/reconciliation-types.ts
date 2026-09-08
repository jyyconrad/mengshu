import type { MemoryScope } from "../../domain/types.js";
import type { EvolutionLease } from "../types.js";
import type { SourceCommitReceipt, SourceSemantics } from "./types.js";

export interface SourceReconciliationEvent {
  pathId: string;
  logicalFileId: string;
  semantics: SourceSemantics;
  kind: "observe_revision" | "supersede_spans" | "history_revised" | "history_rotated" | "source_unavailable";
  previousRevisionId?: string;
  revisionId?: string;
  spanIds: string[];
  /** Historical quotes survive reconciliation. Only explicit host revoke blocks injection. */
  preserveHistoricalEvidence: true;
  requestReview: boolean;
}

export interface SourceReconciliationPlan {
  id: string;
  scope: MemoryScope;
  sourceId: string;
  configFingerprint: string;
  snapshotHash: string;
  /** Gates missing-file events only; complete-file supersede_spans remain valid when false. */
  enumerationComplete: boolean;
  events: SourceReconciliationEvent[];
  recordIds: string[];
  /** No raw quote copy. Keep event continuity separate from content-root deduplication. */
  records: {
    id: string; logicalFileId: string; revisionId: string; spanOrEventId: string;
    contentHash: string; rootEvidenceId: string; independenceGroupId: string; continuityKey: string;
  }[];
}

/**
 * Provider must check source tombstones, CAS and job fencing in the same receipt transaction.
 * Apply complete-file supersede_spans even when enumerationComplete is false, including zero-record pages.
 */
export interface SourceReconciliationPort {
  reconcile(input: {
    plan: SourceReconciliationPlan;
    lease: EvolutionLease;
    verifySource: () => Promise<{ valid: boolean }>;
  }): Promise<SourceCommitReceipt>;
  /** Revocation is host-reviewed, never synthesized from source text or absence. */
  revoke(input: {
    scope: MemoryScope;
    sourceId: string;
    expectedRevision: string;
    reviewReceiptId: string;
    idempotencyKey: string;
    lease: EvolutionLease;
  }): Promise<{ receiptId: string; affectedMemoryIds: string[]; suppressed: true }>;
}
