/**
 * 反馈采集系统类型定义
 *
 * 采集隐式反馈信号：
 * - 采纳率（用户是否使用召回的记忆）
 * - 停留时间（记忆在上下文中的有效时长）
 * - 二次召回（同一记忆被多次召回）
 * - 用户交互（显式反馈、编辑、删除等）
 */

import type { MemoryScope } from "../index.js";

/**
 * 反馈信号类型
 */
export type FeedbackSignalType =
  | "recall" // 召回事件
  | "adoption" // 采纳事件（用户使用了召回的记忆）
  | "rejection" // 拒绝事件（用户忽略或删除召回的记忆）
  | "dwelling" // 停留事件（记忆在上下文中保持）
  | "edit" // 编辑事件（用户修改记忆）
  | "explicit_feedback" // 显式反馈（点赞/踩）
  | "query_hit" // 查询命中（记忆被搜索命中）
  | "context_injection"; // 上下文注入（记忆被注入到 agent 上下文）

/**
 * 采纳类型
 */
export type AdoptionType =
  | "direct_use" // 直接使用（复制粘贴、引用等）
  | "indirect_use" // 间接使用（基于记忆做决策）
  | "confirm" // 确认（用户确认记忆正确）
  | "extend" // 扩展（用户基于记忆补充信息）
  | "reject" // 拒绝（用户明确表示不使用）
  | "ignore"; // 忽略（用户未使用）

/**
 * 反馈信号权重配置
 */
export interface FeedbackWeights {
  /** 召回事件权重 */
  recall: number;
  /** 采纳事件权重 */
  adoption: number;
  /** 拒绝事件权重（负值） */
  rejection: number;
  /** 停留事件权重 */
  dwelling: number;
  /** 编辑事件权重 */
  edit: number;
  /** 显式反馈权重 */
  explicitFeedback: number;
  /** 查询命中权重 */
  queryHit: number;
  /** 上下文注入权重 */
  contextInjection: number;
}

/**
 * 反馈信号记录
 */
export interface FeedbackSignal {
  /** 信号 ID */
  id: string;
  /** 记忆 ID */
  memoryId: string;
  /** 作用域 */
  scope: MemoryScope;
  /** 信号类型 */
  signalType: FeedbackSignalType;
  /** 信号强度 (0-1) */
  strength: number;
  /** 采纳类型（仅 adoption/rejection 类型有效） */
  adoptionType?: AdoptionType;
  /** 停留时长（毫秒，仅 dwelling 类型有效） */
  dwellingDuration?: number;
  /** 查询文本（仅 recall/query_hit 类型有效） */
  queryText?: string;
  /** 召回分数（仅 recall/query_hit 类型有效） */
  recallScore?: number;
  /** 召回排名（仅 recall 类型有效） */
  recallRank?: number;
  /** 上下文位置（仅 context_injection 类型有效） */
  contextSlot?: "profile" | "task_context" | "rules" | "experience" | "resource";
  /** 会话 ID */
  sessionId?: string;
  /** 对话 ID */
  conversationId?: string;
  /** 消息 ID */
  messageId?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 反馈统计
 */
export interface FeedbackStats {
  /** 记忆 ID */
  memoryId: string;
  /** 作用域 */
  scope: MemoryScope;
  /** 召回次数 */
  recallCount: number;
  /** 采纳次数 */
  adoptionCount: number;
  /** 拒绝次数 */
  rejectionCount: number;
  /** 平均停留时长（毫秒） */
  avgDwellingDuration: number;
  /** 编辑次数 */
  editCount: number;
  /** 显式正面反馈次数 */
  positiveFeedbackCount: number;
  /** 显式负面反馈次数 */
  negativeFeedbackCount: number;
  /** 查询命中次数 */
  queryHitCount: number;
  /** 上下文注入次数 */
  contextInjectionCount: number;
  /** 采纳率 (0-1) */
  adoptionRate: number;
  /** 加权反馈分数 */
  weightedScore: number;
  /** 最后召回时间 */
  lastRecallAt?: number;
  /** 最后采纳时间 */
  lastAdoptionAt?: number;
  /** 统计周期开始时间 */
  periodStart: number;
  /** 统计周期结束时间 */
  periodEnd: number;
  /** 更新时间 */
  updatedAt: number;
}

/**
 * 反馈聚合结果
 */
export interface FeedbackAggregation {
  /** 记忆 ID */
  memoryId: string;
  /** 作用域 */
  scope: MemoryScope;
  /** 时间窗口（天） */
  windowDays: number;
  /** 统计数据 */
  stats: FeedbackStats;
  /** 趋势（正增长/负增长/稳定） */
  trend: "growing" | "declining" | "stable";
  /** 信号明细（最近 N 条） */
  recentSignals?: FeedbackSignal[];
}

/**
 * 反馈采集配置
 */
export interface FeedbackCollectorConfig {
  /** 是否启用反馈采集 */
  enabled: boolean;
  /** 采纳检测窗口（毫秒），默认 5 分钟 */
  adoptionWindowMs: number;
  /** 停留检测阈值（毫秒），默认 30 秒 */
  dwellingThresholdMs: number;
  /** 统计聚合窗口（天），默认 30 天 */
  aggregationWindowDays: number;
  /** 批量写入大小 */
  batchSize: number;
  /** 批量写入间隔（毫秒） */
  batchIntervalMs: number;
  /** 信号权重配置 */
  weights: FeedbackWeights;
  /** 是否记录详细元数据 */
  recordDetailedMetadata: boolean;
}

/**
 * 采纳检测上下文
 */
export interface AdoptionDetectionContext {
  /** 记忆 ID */
  memoryId: string;
  /** 召回时间 */
  recallTime: number;
  /** 召回分数 */
  recallScore: number;
  /** 召回排名 */
  recallRank: number;
  /** 查询文本 */
  queryText?: string;
  /** 上下文槽位 */
  contextSlot?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 对话 ID */
  conversationId?: string;
}

/**
 * 停留检测上下文
 */
export interface DwellingDetectionContext {
  /** 记忆 ID */
  memoryId: string;
  /** 注入时间 */
  injectionTime: number;
  /** 上下文槽位 */
  contextSlot: string;
  /** 会话 ID */
  sessionId: string;
}

/**
 * 反馈查询选项
 */
export interface FeedbackQueryOptions {
  /** 记忆 ID 列表 */
  memoryIds?: string[];
  /** 作用域过滤 */
  scope?: Partial<MemoryScope>;
  /** 信号类型过滤 */
  signalTypes?: FeedbackSignalType[];
  /** 时间范围开始 */
  startTime?: number;
  /** 时间范围结束 */
  endTime?: number;
  /** 会话 ID */
  sessionId?: string;
  /** 对话 ID */
  conversationId?: string;
  /** 最大返回数量 */
  limit?: number;
  /** 排序字段 */
  sortBy?: "createdAt" | "strength" | "recallScore";
  /** 排序方向 */
  sortOrder?: "asc" | "desc";
}

/**
 * 反馈统计查询选项
 */
export interface FeedbackStatsQueryOptions {
  /** 记忆 ID 列表 */
  memoryIds?: string[];
  /** 作用域过滤 */
  scope?: Partial<MemoryScope>;
  /** 统计周期（天） */
  periodDays?: number;
  /** 最小召回次数 */
  minRecallCount?: number;
  /** 最小采纳率 */
  minAdoptionRate?: number;
  /** 排序字段 */
  sortBy?: "adoptionRate" | "weightedScore" | "recallCount";
  /** 排序方向 */
  sortOrder?: "asc" | "desc";
  /** 最大返回数量 */
  limit?: number;
}

/**
 * 反馈批量写入项
 */
export interface FeedbackBatchItem {
  signal: Omit<FeedbackSignal, "id" | "createdAt">;
  timestamp: number;
}
