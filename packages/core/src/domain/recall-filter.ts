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
import { kindToSemanticType } from "./semantic-type-mapper.js";
import { matchesReuseScope } from "./scope-policy.js";

const RECALLABLE_ROUTES = new Set(["active", "lookup_only"]);

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

interface GovernanceSignals {
  riskFlags: readonly string[];
  targetScope?: string;
}

function governanceSignals(record: MemoryRecord): GovernanceSignals | undefined {
  const governance = record.metadata?.governance;
  if (governance === undefined) return { riskFlags: [] };
  if (!governance || typeof governance !== "object" || Array.isArray(governance)) return undefined;
  const candidate = (governance as Record<string, unknown>).candidate;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
  const snapshot = candidate as Record<string, unknown>;
  const riskFlags = snapshot.riskFlags === undefined ? [] : stringArray(snapshot.riskFlags);
  if (!riskFlags || (snapshot.targetScope !== undefined && typeof snapshot.targetScope !== "string")) {
    return undefined;
  }
  return {
    riskFlags,
    ...(typeof snapshot.targetScope === "string" ? { targetScope: snapshot.targetScope } : {}),
  };
}

function recallScopeEligible(
  record: MemoryRecord,
  requestScope: MemoryScope,
  policy: SlotReusePolicy,
): boolean {
  const semanticType = record.semanticType ?? kindToSemanticType(record.kind, record).semanticType;
  if (semanticType) return matchesReuseScope(record.scope, requestScope, semanticType, policy);
  return applyScopeReusePolicy([record], requestScope, policy).reusable.length === 1;
}

/** F0 生产召回硬过滤：只返回受治理、可检索且未扩大 scope 的 MemoryRecord。 */
export function filterRecallEligibleRecords<T extends MemoryRecord>(
  records: readonly T[],
  requestScope: MemoryScope,
  policy: SlotReusePolicy = DEFAULT_SLOT_REUSE_POLICY,
): T[] {
  return records.filter((record) => {
    const route = record.metadata?.admissionRoute;
    if (route !== undefined &&
        (typeof route !== "string" || !RECALLABLE_ROUTES.has(route))) return false;

    const lookupOnly = route === "lookup_only";
    const contextEligible = record.metadata?.contextEligible;
    if (contextEligible !== undefined && typeof contextEligible !== "boolean") return false;
    if (route === "active" && contextEligible === false) return false;
    if (lookupOnly && contextEligible === true) return false;
    const lifecycle = record.lifecycleStatus ?? "active";
    if (lookupOnly) {
      if (lifecycle !== "archived" || record.container !== "session_candidate") return false;
    } else if (lifecycle !== "active" || record.container === "session_candidate") {
      return false;
    }

    const metadataRiskFlags = record.metadata?.riskFlags === undefined
      ? []
      : stringArray(record.metadata.riskFlags);
    const governance = governanceSignals(record);
    if (!metadataRiskFlags || !governance) return false;
    const riskFlags = Array.from(new Set([
      ...metadataRiskFlags,
      ...governance.riskFlags,
    ]));
    if (riskFlags.includes("prompt_injection")) return false;
    const visibility = record.scope.visibility ?? "private";
    const expandedSensitiveScope = visibility !== "private" ||
      governance.targetScope === "workspace" || governance.targetScope === "global";
    if (riskFlags.includes("sensitive") && expandedSensitiveScope) return false;

    const conflictStatus = record.metadata?.conflictStatus;
    const conflictUnresolved = record.metadata?.conflictUnresolved ??
      record.metadata?.conflict_unresolved;
    if (conflictUnresolved !== undefined && typeof conflictUnresolved !== "boolean") return false;
    const unresolvedConflict =
      (conflictStatus !== undefined && conflictStatus !== "resolved" && conflictStatus !== "none") ||
      conflictUnresolved === true ||
      riskFlags.includes("conflict_possible");
    if (unresolvedConflict && !lookupOnly) return false;

    return recallScopeEligible(record, requestScope, policy);
  });
}

/** 五槽位/Context 只允许 active 路由，lookup-only 只能通过显式检索访问。 */
export function filterContextEligibleRecords<T extends MemoryRecord>(
  records: readonly T[],
  requestScope: MemoryScope,
  policy: SlotReusePolicy = DEFAULT_SLOT_REUSE_POLICY,
): T[] {
  return filterRecallEligibleRecords(records, requestScope, policy).filter((record) => {
    const route = record.metadata?.admissionRoute;
    if (route === "lookup_only") return false;
    return route === undefined || route === "active";
  });
}

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
