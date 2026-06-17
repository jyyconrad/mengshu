/**
 * 5 问题语义协议的辅助类型与契约定义。
 *
 * 核心类型（MemorySemanticType / MemoryRecord 等）已迁移到 core/types.ts，
 * 本文件保留 5 槽位响应、上下文块等专用结构。
 */

import type {
  MemoryLifecycleStatus,
  MemoryScope,
  MemoryScopeInput,
  MemorySemanticType,
} from "./types.js";

export type { MemorySemanticType, MemoryScope, MemoryScopeInput };

/**
 * SlotContextBlock: 单个槽位上下文块
 */
export interface SlotContextBlock {
  semanticType: MemorySemanticType;
  question: string;
  content: string;
  sourceIds: string[];
  nodeCount: number;
  tokenEstimate?: number;
  warnings?: string[];
}

/**
 * FilteredReason: 记忆被过滤出必读层的原因固定枚举（plan §5.2.0）。
 *
 * 用于向 UI / eval 解释"为什么这条记忆没有进入 5 槽位上下文"。
 * 注意：lifecycle_superseded 为本实现新增（plan 原枚举未含 superseded，
 * 但 MemoryLifecycleStatus 存在 superseded 状态，需要精确区分而非并入 revoked）。
 */
export type FilteredReason =
  | "pending_candidate"
  | "raw_evidence"
  | "lifecycle_stale"
  | "lifecycle_revoked"
  | "lifecycle_superseded"
  | "lifecycle_archived"
  | "visibility_private"
  | "scope_mismatch"
  | "conflict_unresolved"
  | "budget_exceeded"
  | "no_semantic_type"
  | "sensitive_filtered"
  // 召回阶段过滤原因（recall-filter）：
  // salience（重算 importance）低于注入阈值
  | "salience_below_threshold"
  // 与已选中的更高分记忆近重复，被去重合并
  | "dedup_merged"
  // D-13 profile 分层过滤：同 profileDimension 被更高层覆盖
  | "overridden_by_layer";

/**
 * FilteredEntry: 单条被过滤记忆的解释。
 * recordId/semanticType 可缺失（如无法归类的记忆没有 semanticType）。
 */
export interface FilteredEntry {
  recordId?: string;
  reason: FilteredReason;
  semanticType?: MemorySemanticType;
  metadata?: Record<string, unknown>;
}

/**
 * WarningCode: warnings 的固定 code 枚举。
 *
 * warnings 仍为 string[]（向后兼容），约定格式 "<code>: <message>"。
 * 使用 formatWarning 生成，确保格式统一、可被消费方按 code 解析。
 */
export type WarningCode =
  | "latency_exceeded"
  | "embedding_unavailable"
  | "scope_expanded"
  | "cache_miss"
  | "budget_exceeded"
  | "lookup_only_high_ratio";

/**
 * 生成统一格式的 warning 字符串："<code>: <message>"。
 */
export function formatWarning(code: WarningCode, message: string): string {
  return `${code}: ${message}`;
}

/**
 * 将非 active 的生命周期状态映射为 FilteredReason。
 *
 * - revoked    → lifecycle_revoked（已撤销）
 * - superseded → lifecycle_superseded（被新版本替代）
 * - archived   → lifecycle_archived（归档，仅 lookup 可达）
 * - promoted   → lifecycle_archived（已升格为 SKILL，离开必读层，归并到 archived 语义）
 *
 * active 不会进入过滤，返回 null。
 */
export function lifecycleStatusToFilteredReason(
  status: MemoryLifecycleStatus,
): FilteredReason | null {
  switch (status) {
    case "revoked":
      return "lifecycle_revoked";
    case "superseded":
      return "lifecycle_superseded";
    case "archived":
      return "lifecycle_archived";
    case "promoted":
      return "lifecycle_archived";
    case "active":
    default:
      return null;
  }
}

/**
 * AgentTaskContextRequest: Agent 快路径请求
 */
export interface AgentTaskContextRequest {
  scope: MemoryScopeInput;
  task: string;
  intent?: "chat" | "research" | "writing" | "ops" | "customer_support" | "workflow" | "unknown";
  constraints?: string[];
  tokenBudget?: number;
  latencyBudgetMs?: number;
}

/**
 * ContextFastResponse: memory_context_fast 响应
 */
export interface ContextFastResponse {
  scope: MemoryScope;
  slots: {
    profile?: SlotContextBlock;
    task_context?: SlotContextBlock;
    rules?: SlotContextBlock;
    experience?: SlotContextBlock;
    resource?: SlotContextBlock;
  };
  /** 拼装后的 prompt 注入文本（已转义） */
  content: string;
  /** 任务相关的额外提示 */
  taskHints?: Array<{
    kind: "rule" | "experience" | "resource" | "warning";
    text: string;
    evidenceIds: string[];
  }>;
  /** 可触发的下钻 action */
  actions?: Array<{
    type: "lookup" | "drill_down" | "open_resource";
    label: string;
    input: Record<string, unknown>;
  }>;
  freshness?: {
    slotSnapshotAt?: number;
    staleSlots: string[];
  };
  warnings?: string[];
  /** 被过滤记忆的逐条解释（可为空数组），plan §5.2.0 */
  filtered?: FilteredEntry[];
  /** 按 reason 聚合的过滤计数，便于 UI / eval 快速汇总 */
  filteredSummary?: Array<{ reason: FilteredReason; count: number }>;
  telemetry: {
    latencyMs: number;
    nodesUsed: number;
    cacheHit: boolean;
    tokenEstimate?: number;
  };
}

/**
 * 5 问题对应的固定文本（中文）
 */
export const FIVE_QUESTIONS: Record<MemorySemanticType, string> = {
  profile: "Q1: 我为谁工作？",
  task_context: "Q2: 我在做什么？",
  rules: "Q3: 什么不能做？",
  experience: "Q4: 之前怎么做过？",
  resource: "Q5: 有什么可用资源？",
};
