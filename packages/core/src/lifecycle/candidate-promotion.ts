/**
 * 候选记录提升为 Durable Memory 的转换 helper。
 *
 * 本文件做什么：把审核通过的 CandidateRecord 转换为 MemoryRecord，供
 * CandidateReviewService.promoteCandidate 回调写入主库。
 *
 * 核心流程：
 * 1. 复用候选的 scope / text / semanticType / kind / confidence / evidence。
 * 2. 计算 contentHash（去重边界），lifecycleStatus 固定为 active。
 * 3. provenance 标记来源为 candidate 审核，保留 evidence 与原候选 id 可追溯。
 *
 * 关键边界：
 * - 只做纯转换，不写库（写库由调用方 MemoryService.storeMemory 完成）。
 * - 不修改入参；contentHash 由文本派生，保证同文本幂等。
 */

import { computeContentHash } from "../scoring/hash-utils.js";
import type { MemoryCategory } from "../../../../config.js";
import type { CandidateRecord } from "./candidate-types.js";
import type { MemoryKind, MemoryRecord } from "../domain/types.js";

/** 候选 kind 字符串收敛到 MemoryKind；未知值归为 other。 */
function toMemoryKind(kind: string): MemoryKind {
  const known: MemoryKind[] = [
    "preference",
    "decision",
    "entity",
    "fact",
    "task",
    "plan",
    "goal",
    "document",
    "knowledge",
    "observation",
    "other",
  ];
  return (known as string[]).includes(kind) ? (kind as MemoryKind) : "other";
}

/** 将审核通过的候选转换为 active MemoryRecord。now 可注入以便测试确定性。 */
export function candidateToMemoryRecord(
  candidate: CandidateRecord,
  now: number = Date.now(),
): MemoryRecord {
  return {
    id: `mem-${candidate.id}`,
    scope: candidate.scope,
    kind: toMemoryKind(candidate.kind),
    semanticType: candidate.semanticType,
    container: "personal",
    lifecycleStatus: "active",
    confidence: candidate.confidence,
    text: candidate.text,
    contentHash: computeContentHash(candidate.text),
    importance: candidate.confidence,
    category: "other" as MemoryCategory,
    dataType: "memory",
    metadata: {
      ...candidate.metadata,
      promotedFromCandidate: candidate.id,
    },
    provenance: {
      source: "system",
      sourceId: candidate.id,
      createdAt: now,
    },
    sourceNodeIds: candidate.evidenceIds,
    createdAt: now,
  };
}
