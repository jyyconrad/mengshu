import type { ContextFastResponse } from "./semantic-types.js";
import type { ContextBlock, RecallHit, RecallResult } from "./types.js";
import {
  isRecallScoreBreakdown,
  type CompleteRecallScoreBreakdown,
  type RecallMatchedBy,
} from "./recall-scoring.js";

export const RECALL_SCORE_BREAKDOWN_REQUIRED = "RECALL_SCORE_BREAKDOWN_REQUIRED";
export const CONTEXT_RECALL_BREAKDOWN_REQUIRED = "CONTEXT_RECALL_BREAKDOWN_REQUIRED";

interface RecallReceiptCarrier {
  score?: unknown;
  source?: unknown;
  scoreBreakdown?: unknown;
}

const RECALL_SOURCES = new Set<RecallMatchedBy>([
  "vector",
  "text",
  "recent",
  "graph",
  "tree",
]);

function matchedSource(source: unknown): RecallMatchedBy | undefined {
  if (typeof source !== "string") return undefined;
  const normalized = source.startsWith("tree:") ? "tree" : source;
  return RECALL_SOURCES.has(normalized as RecallMatchedBy)
    ? normalized as RecallMatchedBy
    : undefined;
}

/**
 * 验证并返回 Retrieval Engine 产生的唯一六因子回执。
 * Adapter 只能透传返回值，不能在验证失败时自行重算。
 */
export function requireRecallReceipt(
  value: RecallReceiptCarrier,
  errorCode = RECALL_SCORE_BREAKDOWN_REQUIRED,
): CompleteRecallScoreBreakdown {
  const source = matchedSource(value.source);
  if (typeof value.score !== "number" || !Number.isFinite(value.score) ||
      !isRecallScoreBreakdown(value.scoreBreakdown) ||
      Math.abs(value.score - value.scoreBreakdown.score) > 1e-9 ||
      !source || !value.scoreBreakdown.matchedBy.includes(source)) {
    throw new Error(errorCode);
  }
  return value.scoreBreakdown;
}

export function requireRecallHitReceipt(hit: RecallHit): CompleteRecallScoreBreakdown {
  return requireRecallReceipt(hit);
}

export function requireRecallResultReceipts<T extends RecallResult>(result: T): T {
  for (const hit of result.hits) requireRecallHitReceipt(hit);
  return result;
}

export function requireContextBlockRecallReceipts<T extends ContextBlock>(context: T): T {
  for (const hit of context.hits) requireRecallHitReceipt(hit);
  return context;
}

export function requireLookupResultReceipts<T>(result: T): T {
  const hits = result && typeof result === "object" && "hits" in result
    ? (result as { hits?: unknown }).hits
    : undefined;
  if (!Array.isArray(hits)) throw new Error(RECALL_SCORE_BREAKDOWN_REQUIRED);
  for (const hit of hits) {
    if (!hit || typeof hit !== "object") {
      throw new Error(RECALL_SCORE_BREAKDOWN_REQUIRED);
    }
    requireRecallReceipt(hit as RecallReceiptCarrier);
  }
  return result;
}

/**
 * 验证 5 槽位的 sourceIds 与六因子回执一一同序。
 * 空槽位可以省略回执；任何含 sourceId 的生产槽位都必须携带完整回执。
 */
export function requireContextFastRecallReceipts<T extends ContextFastResponse>(response: T): T {
  for (const block of Object.values(response.slots)) {
    if (!block) continue;
    if (block.sourceIds.length === 0 && block.recallReceipts === undefined) continue;
    if (!Array.isArray(block.recallReceipts) ||
        block.recallReceipts.length !== block.sourceIds.length) {
      throw new Error(CONTEXT_RECALL_BREAKDOWN_REQUIRED);
    }
    for (let index = 0; index < block.sourceIds.length; index += 1) {
      const receipt = block.recallReceipts[index];
      if (!receipt || receipt.sourceId !== block.sourceIds[index]) {
        throw new Error(CONTEXT_RECALL_BREAKDOWN_REQUIRED);
      }
      requireRecallReceipt(receipt, CONTEXT_RECALL_BREAKDOWN_REQUIRED);
    }
  }
  return response;
}
