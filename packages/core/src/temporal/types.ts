import type { MemoryRecord, MemoryScope } from "../domain/types.js";

export type MemoryVersionTransitionType =
  | "created"
  | "evolved"
  | "corrected"
  | "expired"
  | "restored"
  | "revoked";

export type MemoryEvolutionErrorCode =
  | "MEMORY_EVOLUTION_INVALID"
  | "MEMORY_LINEAGE_NOT_FOUND"
  | "MEMORY_VERSION_NOT_FOUND"
  | "MEMORY_VERSION_STALE"
  | "MEMORY_VERSION_CONFLICT"
  | "MEMORY_IDEMPOTENCY_CONFLICT"
  | "MEMORY_PURGE_CONFIRMATION_REQUIRED"
  | "MEMORY_PURGE_PENDING";

export class MemoryEvolutionError extends Error {
  override readonly name = "MemoryEvolutionError";

  constructor(readonly code: MemoryEvolutionErrorCode) {
    super(code);
  }
}

export interface MemoryTemporalVersion {
  readonly lineageId: string;
  readonly revision: number;
  readonly record: MemoryRecord;
  readonly previousVersionId?: string;
  readonly restoredFromVersionId?: string;
  readonly validFrom: number;
  readonly validTo?: number;
  readonly recordedAt: number;
  readonly closedAt?: number;
  readonly transitionType: MemoryVersionTransitionType;
  readonly transitionReason?: string;
  readonly invalidated: boolean;
  readonly activationState: "active" | "staged";
}

export interface MemoryLineageHead {
  readonly scopeFingerprint: string;
  readonly lineageId: string;
  readonly latestRevision: number;
  readonly currentVersionId?: string;
  readonly currentVersionRevision?: number;
  readonly updatedAt: number;
}

export interface MemoryVersionTransitionReceipt {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly scopeFingerprint: string;
  readonly lineageId: string;
  readonly transitionType: MemoryVersionTransitionType;
  readonly previousVersionId?: string;
  readonly versionId?: string;
  readonly revision: number;
  readonly occurredAt: number;
}

export interface MemoryPurgeReceipt {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly scopeFingerprint: string;
  readonly lineageHash: string;
  readonly purgedVersions: number;
  readonly derivedArtifactsPurged: number;
  readonly occurredAt: number;
}

export interface TemporalPurgeRetryBatchResult {
  readonly attempted: number;
  readonly completed: number;
  readonly failed: number;
}

export interface MemoryTemporalReadResult extends MemoryTemporalVersion {
  readonly historical: boolean;
}

export interface MemoryHistoryResult {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly head: MemoryLineageHead;
  readonly versions: readonly MemoryTemporalVersion[];
}

export interface TemporalRecallSelector {
  readonly mode?: "current" | "as_of" | "all_versions";
  readonly asOf?: number;
  readonly knownAt?: number;
}

export interface MemoryVersionTransitionResult {
  readonly version: MemoryTemporalVersion;
  readonly receipt: MemoryVersionTransitionReceipt;
  readonly replayed: boolean;
}
