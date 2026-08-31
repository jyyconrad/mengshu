import type { MemoryScope } from "../domain/types.js";
import type {
  MemoryHistoryResult,
  MemoryLineageHead,
  MemoryPurgeReceipt,
  MemoryTemporalVersion,
  MemoryVersionTransitionReceipt,
  MemoryVersionTransitionResult,
  TemporalPurgeRetryBatchResult,
} from "./types.js";

export interface AppendTemporalMemoryVersionInput {
  readonly scope: MemoryScope;
  readonly expectedHeadRevision: number;
  readonly version: MemoryTemporalVersion;
  readonly receipt: MemoryVersionTransitionReceipt;
}

export interface CloseTemporalMemoryHeadInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly expectedHeadRevision: number;
  readonly validTo: number;
  readonly reason?: string;
  readonly transitionType: "expired" | "revoked";
  readonly receipt: MemoryVersionTransitionReceipt;
}

export interface PurgeTemporalMemoryLineageInput {
  readonly scope: MemoryScope;
  readonly lineageId: string;
  readonly receipt: MemoryPurgeReceipt;
}

export interface TemporalMemoryRepository {
  getTransitionReceipt(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<MemoryVersionTransitionReceipt | undefined>;
  getPurgeReceipt(
    scope: MemoryScope,
    idempotencyKey: string,
  ): Promise<MemoryPurgeReceipt | undefined>;
  getHead(scope: MemoryScope, lineageId: string): Promise<MemoryLineageHead | undefined>;
  getVersion(
    scope: MemoryScope,
    lineageId: string,
    versionId: string,
  ): Promise<MemoryTemporalVersion | undefined>;
  appendVersion(input: AppendTemporalMemoryVersionInput): Promise<MemoryVersionTransitionResult>;
  closeHead(input: CloseTemporalMemoryHeadInput): Promise<MemoryVersionTransitionResult>;
  current(
    scope: MemoryScope,
    lineageId: string,
    at: number,
  ): Promise<MemoryTemporalVersion | undefined>;
  asOf(
    scope: MemoryScope,
    lineageId: string,
    asOf: number,
    knownAt?: number,
  ): Promise<MemoryTemporalVersion | undefined>;
  history(scope: MemoryScope, lineageId: string): Promise<MemoryHistoryResult | undefined>;
  activateDue(now: number, limit: number): Promise<number>;
  materializeExpired(now: number, limit: number): Promise<number>;
  retryPendingPurges(now: number, limit: number): Promise<TemporalPurgeRetryBatchResult>;
  purge(input: PurgeTemporalMemoryLineageInput): Promise<MemoryPurgeReceipt>;
}
