/**
 * FeedbackStore: 反馈信号存储接口
 *
 * 负责持久化反馈信号和统计数据
 */

import type { MemoryScope } from "../core/types.js";
import type {
  FeedbackSignal,
  FeedbackStats,
  FeedbackQueryOptions,
  FeedbackStatsQueryOptions,
  FeedbackAggregation,
} from "./types.js";

/**
 * 反馈存储接口
 */
export interface FeedbackStore {
  /**
   * 初始化存储
   */
  initialize(): Promise<void>;

  /**
   * 关闭存储
   */
  close(): Promise<void>;

  /**
   * 批量存储反馈信号
   */
  storeSignals(signals: FeedbackSignal[]): Promise<void>;

  /**
   * 查询反馈信号
   */
  querySignals(options: FeedbackQueryOptions): Promise<FeedbackSignal[]>;

  /**
   * 删除反馈信号
   */
  deleteSignals(signalIds: string[]): Promise<void>;

  /**
   * 获取单个记忆的反馈统计
   */
  getStats(memoryId: string, scope: MemoryScope, periodDays: number): Promise<FeedbackStats | null>;

  /**
   * 批量获取反馈统计
   */
  getBatchStats(
    memoryIds: string[],
    scope: MemoryScope,
    periodDays: number
  ): Promise<FeedbackStats[]>;

  /**
   * 查询反馈统计（带过滤和排序）
   */
  queryStats(options: FeedbackStatsQueryOptions): Promise<FeedbackStats[]>;

  /**
   * 获取反馈聚合数据（包含趋势分析）
   */
  getAggregation(
    memoryId: string,
    scope: MemoryScope,
    windowDays: number
  ): Promise<FeedbackAggregation | null>;

  /**
   * 更新或创建统计数据（增量更新）
   */
  updateStats(memoryId: string, scope: MemoryScope): Promise<void>;

  /**
   * 批量更新统计数据
   */
  batchUpdateStats(memoryIds: string[], scope: MemoryScope): Promise<void>;

  /**
   * 清理过期信号（超过保留期的数据）
   */
  cleanupExpiredSignals(retentionDays: number): Promise<number>;

  /**
   * 重建统计数据（从信号重新计算）
   */
  rebuildStats(memoryId?: string): Promise<void>;
}
