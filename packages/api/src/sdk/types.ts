/**
 * JavaScript SDK 对外类型。
 *
 * 这些类型复用 core service DTO，SDK 只负责 HTTP 传输和错误包装。
 */

import type {
  BuildContextInput,
  HealthSnapshot,
  RecallInput,
  StoreMemoryInput,
  StoreMemoryResult,
} from "../../../../core/service-types.js";
import type { ContextBlock, RecallResult } from "../../../../core/types.js";
export type { EvolutionControlRequest, EvolutionControlResult } from "../../../core/src/evolution/types.js";
export type { EvolutionUndoPreviewRequest, EvolutionUndoPreview, EvolutionUndoApprovalRequest, EvolutionUndoApprovalReceipt } from "../evolution-control.js";

export type MemoryClientFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MemoryClientOptions {
  baseUrl: string;
  token?: string;
  /** Explicit owner control credential; only owner control methods send it. */
  ownerToken?: string;
  timeoutMs?: number;
  fetch?: MemoryClientFetch;
}

export type MemoryClientHealth = HealthSnapshot;
export interface MemoryClientStoreInput extends StoreMemoryInput {
  /** Retry-safe operation key required by the governed REST write path. */
  idempotencyKey: string;
}
export type MemoryClientStoreResult = StoreMemoryResult;
export type MemoryClientRecallInput = RecallInput;
export type MemoryClientRecallResult = RecallResult;
export type MemoryClientContextInput = BuildContextInput;
export type MemoryClientContextResult = ContextBlock;
