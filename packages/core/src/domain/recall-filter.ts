/**
 * 召回过滤层（recall-filter）。
 *
 * 本文件做什么：在召回评分（recall-scoring）与槽位组装（slot-context-builder）之间，
 * 统一执行"注入前过滤"，并为每一条被剔除的记忆记录 filteredReason，便于
 * UI / eval / `ms why` 解释"为什么这条记忆没有进入上下文"。
 *
 * 覆盖三类过滤原因（plan §12.3 RecallExplain.filteredReason）：
 * 1. scope_mismatch        —— 记忆 scope 不满足当前请求 scope 的复用策略（委托 scope-policy）。
 * 2. salience_below_threshold —— 记忆重算后的 importance（salience）低于注入阈值。
 * 3. dedup_merged          —— 与已选中的更高分记忆近重复（contentHash 相同），去重合并。
 *
 * 设计要点：
 * - 纯函数，不修改入参数组，返回新对象/新数组。
 * - 过滤顺序固定：scope -> salience -> dedup。先按 scope/salience 排除，
 *   再对剩余记忆按综合分降序去重，保证保留的是同组里分数最高的代表。
 * - filtered 每项复用 core/semantic-types 的 FilteredEntry，reason 取统一枚举。
 */

import type { FilteredEntry } from "./semantic-types.js";
import type { MemoryRecord, MemoryScope } from "../../../../core/types.js";
import {
  applyScopeReusePolicy,
  DEFAULT_SLOT_REUSE_POLICY,
  type SlotReusePolicy,
} from "../../../../core/scope-policy.js";
import {
  computeNodeScore,
  DEFAULT_RECALL_WEIGHTS,
  type RecallWeights,
} from "../../../../core/recall-scoring.js";

/**
 * 默认 salience 注入阈值。
 *
 * 与 plan §0.3.1 准入带对齐：低于该值视为低优先，不进入必读层注入。
 * 记忆的 importance 字段在准入阶段已用 SCORING_WEIGHTS_V1 重算（即 salience），
 * 这里直接读取并与阈值比较。
 */
export const DEFAULT_SALIENCE_THRESHOLD = 0.4;

/** 召回过滤选项。 */
export interface RecallFilterOptions {
  /** scope 复用策略（默认 DEFAULT_SLOT_REUSE_POLICY） */
  scopePolicy?: SlotReusePolicy;
  /** salience（importance）注入阈值（默认 DEFAULT_SALIENCE_THRESHOLD） */
  salienceThreshold?: number;
  /** 召回评分权重，用于去重排序（默认 DEFAULT_RECALL_WEIGHTS） */
  weights?: RecallWeights;
  /** 是否启用 scope 过滤（默认 true） */
  enableScopeFilter?: boolean;
  /** 是否启用 salience 阈值过滤（默认 true） */
  enableSalienceFilter?: boolean;
  /** 是否启用去重合并（默认 true） */
  enableDedup?: boolean;
}

/** 召回过滤结果。 */
export interface RecallFilterResult {
  /** 通过全部过滤、可进入注入的记忆 */
  kept: MemoryRecord[];
  /** 被过滤记忆的逐条解释，reason 取统一枚举 */
  filtered: FilteredEntry[];
}

/**
 * 计算去重 key：优先 contentHash，缺失时回退到归一化文本。
 * 同 key 视为近重复，仅保留综合分最高的一条。
 */
function dedupKey(record: MemoryRecord): string {
  if (record.contentHash && record.contentHash.trim().length > 0) {
    return `hash:${record.contentHash}`;
  }
  return `text:${record.text.trim().toLowerCase()}`;
}

/**
 * 对召回候选执行注入前过滤，记录 filteredReason。
 *
 * @param records      召回候选记忆（任意顺序）
 * @param requestScope 当前请求 scope
 * @param options      过滤选项
 * @returns kept（保留）与 filtered（带 reason 的剔除解释）
 */
export function filterRecallRecords(
  records: readonly MemoryRecord[],
  requestScope: MemoryScope,
  options: RecallFilterOptions = {},
): RecallFilterResult {
  const {
    scopePolicy = DEFAULT_SLOT_REUSE_POLICY,
    salienceThreshold = DEFAULT_SALIENCE_THRESHOLD,
    weights = DEFAULT_RECALL_WEIGHTS,
    enableScopeFilter = true,
    enableSalienceFilter = true,
    enableDedup = true,
  } = options;

  const filtered: FilteredEntry[] = [];

  // 1. scope 复用过滤：委托 scope-policy，剔除项记 scope_mismatch。
  let candidates: MemoryRecord[] = [...records];
  if (enableScopeFilter) {
    const scopeResult = applyScopeReusePolicy(candidates, requestScope, scopePolicy);
    candidates = scopeResult.reusable;
    for (const { record } of scopeResult.filtered) {
      filtered.push({
        recordId: record.id,
        reason: "scope_mismatch",
        semanticType: record.semanticType,
      });
    }
  }

  // 2. salience 阈值过滤：importance（已重算的 salience）低于阈值则剔除。
  if (enableSalienceFilter) {
    const passed: MemoryRecord[] = [];
    for (const record of candidates) {
      const salience = record.importance ?? 0;
      if (salience < salienceThreshold) {
        filtered.push({
          recordId: record.id,
          reason: "salience_below_threshold",
          semanticType: record.semanticType,
        });
        continue;
      }
      passed.push(record);
    }
    candidates = passed;
  }

  // 3. 去重合并：按综合分降序，同 dedupKey 仅保留首条（最高分），其余记 dedup_merged。
  if (enableDedup) {
    const ranked = [...candidates].sort(
      (a, b) => computeNodeScore(b, weights) - computeNodeScore(a, weights),
    );
    const seen = new Set<string>();
    const kept: MemoryRecord[] = [];
    for (const record of ranked) {
      const key = dedupKey(record);
      if (seen.has(key)) {
        filtered.push({
          recordId: record.id,
          reason: "dedup_merged",
          semanticType: record.semanticType,
        });
        continue;
      }
      seen.add(key);
      kept.push(record);
    }
    return { kept, filtered };
  }

  return { kept: candidates, filtered };
}
