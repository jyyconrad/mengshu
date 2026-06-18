/**
 * InMemoryFeedbackStore: 内存反馈存储实现
 *
 * 用于测试和简单场景，数据存储在内存中
 */

import type { MemoryScope } from "../core/types.js";
import type {
  FeedbackSignal,
  FeedbackStats,
  FeedbackQueryOptions,
  FeedbackStatsQueryOptions,
  FeedbackAggregation,
  FeedbackWeights,
} from "./types.js";
import type { FeedbackStore } from "./store.js";

/**
 * 内存反馈存储
 */
export class InMemoryFeedbackStore implements FeedbackStore {
  private signals: Map<string, FeedbackSignal> = new Map();
  private stats: Map<string, FeedbackStats> = new Map();
  private weights: FeedbackWeights;

  constructor(weights?: FeedbackWeights) {
    this.weights = weights || {
      recall: 0.1,
      adoption: 1.0,
      rejection: -0.5,
      dwelling: 0.3,
      edit: 0.8,
      explicitFeedback: 1.5,
      queryHit: 0.2,
      contextInjection: 0.15,
    };
  }

  async initialize(): Promise<void> {
    // 内存实现无需初始化
  }

  async close(): Promise<void> {
    this.signals.clear();
    this.stats.clear();
  }

  async storeSignals(signals: FeedbackSignal[]): Promise<void> {
    for (const signal of signals) {
      this.signals.set(signal.id, signal);
    }

    // 异步更新统计（不阻塞写入）
    const memoryIds = new Set(signals.map((s) => s.memoryId));
    for (const memoryId of memoryIds) {
      const scope = signals.find((s) => s.memoryId === memoryId)?.scope;
      if (scope) {
        await this.updateStats(memoryId, scope);
      }
    }
  }

  async querySignals(options: FeedbackQueryOptions): Promise<FeedbackSignal[]> {
    let results = Array.from(this.signals.values());

    // 过滤记忆 ID
    if (options.memoryIds && options.memoryIds.length > 0) {
      const memoryIdSet = new Set(options.memoryIds);
      results = results.filter((s) => memoryIdSet.has(s.memoryId));
    }

    // 过滤作用域
    if (options.scope) {
      results = results.filter((s) => this.matchScope(s.scope, options.scope!));
    }

    // 过滤信号类型
    if (options.signalTypes && options.signalTypes.length > 0) {
      const typeSet = new Set(options.signalTypes);
      results = results.filter((s) => typeSet.has(s.signalType));
    }

    // 过滤时间范围
    if (options.startTime !== undefined) {
      results = results.filter((s) => s.createdAt >= options.startTime!);
    }
    if (options.endTime !== undefined) {
      results = results.filter((s) => s.createdAt <= options.endTime!);
    }

    // 过滤会话 ID
    if (options.sessionId) {
      results = results.filter((s) => s.sessionId === options.sessionId);
    }

    // 过滤对话 ID
    if (options.conversationId) {
      results = results.filter((s) => s.conversationId === options.conversationId);
    }

    // 排序
    const sortBy = options.sortBy || "createdAt";
    const sortOrder = options.sortOrder || "desc";
    results.sort((a, b) => {
      let valueA: number;
      let valueB: number;

      switch (sortBy) {
        case "createdAt":
          valueA = a.createdAt;
          valueB = b.createdAt;
          break;
        case "strength":
          valueA = a.strength;
          valueB = b.strength;
          break;
        case "recallScore":
          valueA = a.recallScore || 0;
          valueB = b.recallScore || 0;
          break;
        default:
          valueA = a.createdAt;
          valueB = b.createdAt;
      }

      return sortOrder === "asc" ? valueA - valueB : valueB - valueA;
    });

    // 限制数量
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async deleteSignals(signalIds: string[]): Promise<void> {
    for (const id of signalIds) {
      this.signals.delete(id);
    }
  }

  async getStats(
    memoryId: string,
    scope: MemoryScope,
    periodDays: number
  ): Promise<FeedbackStats | null> {
    const key = this.getStatsKey(memoryId, scope);
    const stats = this.stats.get(key);

    if (!stats) {
      return null;
    }

    // 如果统计数据过期，重新计算
    const now = Date.now();
    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    if (now - stats.updatedAt > 60 * 60 * 1000) {
      // 1 小时未更新，重新计算
      await this.updateStats(memoryId, scope);
      return this.stats.get(key) || null;
    }

    return stats;
  }

  async getBatchStats(
    memoryIds: string[],
    scope: MemoryScope,
    periodDays: number
  ): Promise<FeedbackStats[]> {
    const results: FeedbackStats[] = [];

    for (const memoryId of memoryIds) {
      const stats = await this.getStats(memoryId, scope, periodDays);
      if (stats) {
        results.push(stats);
      }
    }

    return results;
  }

  async queryStats(options: FeedbackStatsQueryOptions): Promise<FeedbackStats[]> {
    let results = Array.from(this.stats.values());

    // 过滤记忆 ID
    if (options.memoryIds && options.memoryIds.length > 0) {
      const memoryIdSet = new Set(options.memoryIds);
      results = results.filter((s) => memoryIdSet.has(s.memoryId));
    }

    // 过滤作用域
    if (options.scope) {
      results = results.filter((s) => this.matchScope(s.scope, options.scope!));
    }

    // 过滤最小召回次数
    if (options.minRecallCount !== undefined) {
      results = results.filter((s) => s.recallCount >= options.minRecallCount!);
    }

    // 过滤最小采纳率
    if (options.minAdoptionRate !== undefined) {
      results = results.filter((s) => s.adoptionRate >= options.minAdoptionRate!);
    }

    // 排序
    const sortBy = options.sortBy || "adoptionRate";
    const sortOrder = options.sortOrder || "desc";
    results.sort((a, b) => {
      let valueA: number;
      let valueB: number;

      switch (sortBy) {
        case "adoptionRate":
          valueA = a.adoptionRate;
          valueB = b.adoptionRate;
          break;
        case "weightedScore":
          valueA = a.weightedScore;
          valueB = b.weightedScore;
          break;
        case "recallCount":
          valueA = a.recallCount;
          valueB = b.recallCount;
          break;
        default:
          valueA = a.adoptionRate;
          valueB = b.adoptionRate;
      }

      return sortOrder === "asc" ? valueA - valueB : valueB - valueA;
    });

    // 限制数量
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  async getAggregation(
    memoryId: string,
    scope: MemoryScope,
    windowDays: number
  ): Promise<FeedbackAggregation | null> {
    const stats = await this.getStats(memoryId, scope, windowDays);
    if (!stats) {
      return null;
    }

    // 计算趋势
    const trend = this.calculateTrend(memoryId, scope, windowDays);

    // 获取最近的信号
    const recentSignals = await this.querySignals({
      memoryIds: [memoryId],
      scope,
      limit: 20,
      sortBy: "createdAt",
      sortOrder: "desc",
    });

    return {
      memoryId,
      scope,
      windowDays,
      stats,
      trend,
      recentSignals,
    };
  }

  async updateStats(memoryId: string, scope: MemoryScope): Promise<void> {
    const now = Date.now();
    const periodDays = 30;
    const periodMs = periodDays * 24 * 60 * 60 * 1000;
    const periodStart = now - periodMs;

    // 获取统计周期内的所有信号
    const signals = await this.querySignals({
      memoryIds: [memoryId],
      scope,
      startTime: periodStart,
      endTime: now,
    });

    // 计算统计数据
    const stats = this.calculateStats(memoryId, scope, signals, periodStart, now);

    // 保存统计
    const key = this.getStatsKey(memoryId, scope);
    this.stats.set(key, stats);
  }

  async batchUpdateStats(memoryIds: string[], scope: MemoryScope): Promise<void> {
    for (const memoryId of memoryIds) {
      await this.updateStats(memoryId, scope);
    }
  }

  async cleanupExpiredSignals(retentionDays: number): Promise<number> {
    const cutoffTime = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const expiredIds: string[] = [];

    for (const [id, signal] of this.signals.entries()) {
      if (signal.createdAt < cutoffTime) {
        expiredIds.push(id);
      }
    }

    for (const id of expiredIds) {
      this.signals.delete(id);
    }

    return expiredIds.length;
  }

  async rebuildStats(memoryId?: string): Promise<void> {
    if (memoryId) {
      // 重建单个记忆的统计
      const signals = Array.from(this.signals.values()).filter(
        (s) => s.memoryId === memoryId
      );
      if (signals.length > 0) {
        await this.updateStats(memoryId, signals[0].scope);
      }
    } else {
      // 重建所有统计
      const memoryIds = new Set(Array.from(this.signals.values()).map((s) => s.memoryId));
      for (const id of memoryIds) {
        const signal = Array.from(this.signals.values()).find((s) => s.memoryId === id);
        if (signal) {
          await this.updateStats(id, signal.scope);
        }
      }
    }
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 计算统计数据
   */
  private calculateStats(
    memoryId: string,
    scope: MemoryScope,
    signals: FeedbackSignal[],
    periodStart: number,
    periodEnd: number
  ): FeedbackStats {
    let recallCount = 0;
    let adoptionCount = 0;
    let rejectionCount = 0;
    let totalDwellingDuration = 0;
    let dwellingCount = 0;
    let editCount = 0;
    let positiveFeedbackCount = 0;
    let negativeFeedbackCount = 0;
    let queryHitCount = 0;
    let contextInjectionCount = 0;
    let lastRecallAt: number | undefined;
    let lastAdoptionAt: number | undefined;

    for (const signal of signals) {
      switch (signal.signalType) {
        case "recall":
          recallCount++;
          if (!lastRecallAt || signal.createdAt > lastRecallAt) {
            lastRecallAt = signal.createdAt;
          }
          break;
        case "adoption":
          adoptionCount++;
          if (!lastAdoptionAt || signal.createdAt > lastAdoptionAt) {
            lastAdoptionAt = signal.createdAt;
          }
          break;
        case "rejection":
          rejectionCount++;
          break;
        case "dwelling":
          dwellingCount++;
          if (signal.dwellingDuration) {
            totalDwellingDuration += signal.dwellingDuration;
          }
          break;
        case "edit":
          editCount++;
          break;
        case "explicit_feedback":
          if (signal.strength > 0) {
            positiveFeedbackCount++;
          } else {
            negativeFeedbackCount++;
          }
          break;
        case "query_hit":
          queryHitCount++;
          break;
        case "context_injection":
          contextInjectionCount++;
          break;
      }
    }

    // 计算采纳率
    const adoptionRate =
      recallCount > 0 ? adoptionCount / recallCount : 0;

    // 计算平均停留时长
    const avgDwellingDuration =
      dwellingCount > 0 ? totalDwellingDuration / dwellingCount : 0;

    // 计算加权分数
    const weightedScore = this.calculateWeightedScore({
      recallCount,
      adoptionCount,
      rejectionCount,
      dwellingCount,
      editCount,
      positiveFeedbackCount,
      negativeFeedbackCount,
      queryHitCount,
      contextInjectionCount,
      avgDwellingDuration,
    });

    return {
      memoryId,
      scope,
      recallCount,
      adoptionCount,
      rejectionCount,
      avgDwellingDuration,
      editCount,
      positiveFeedbackCount,
      negativeFeedbackCount,
      queryHitCount,
      contextInjectionCount,
      adoptionRate,
      weightedScore,
      lastRecallAt,
      lastAdoptionAt,
      periodStart,
      periodEnd,
      updatedAt: Date.now(),
    };
  }

  /**
   * 计算加权分数
   */
  private calculateWeightedScore(counts: {
    recallCount: number;
    adoptionCount: number;
    rejectionCount: number;
    dwellingCount: number;
    editCount: number;
    positiveFeedbackCount: number;
    negativeFeedbackCount: number;
    queryHitCount: number;
    contextInjectionCount: number;
    avgDwellingDuration: number;
  }): number {
    let score = 0;

    score += counts.recallCount * this.weights.recall;
    score += counts.adoptionCount * this.weights.adoption;
    score += counts.rejectionCount * this.weights.rejection; // 负值
    score += counts.dwellingCount * this.weights.dwelling;
    score += counts.editCount * this.weights.edit;
    score += counts.positiveFeedbackCount * this.weights.explicitFeedback;
    score += counts.negativeFeedbackCount * -this.weights.explicitFeedback;
    score += counts.queryHitCount * this.weights.queryHit;
    score += counts.contextInjectionCount * this.weights.contextInjection;

    // 停留时长加成（归一化到 0-1）
    if (counts.avgDwellingDuration > 0) {
      const dwellingBonus = Math.min(1.0, counts.avgDwellingDuration / (5 * 60 * 1000)); // 5 分钟为满分
      score += dwellingBonus * this.weights.dwelling;
    }

    return Math.max(0, score);
  }

  /**
   * 计算趋势
   */
  private calculateTrend(
    memoryId: string,
    scope: MemoryScope,
    windowDays: number
  ): "growing" | "declining" | "stable" {
    const now = Date.now();
    const halfWindow = (windowDays / 2) * 24 * 60 * 60 * 1000;
    const midPoint = now - halfWindow;

    const allSignals = Array.from(this.signals.values()).filter(
      (s) => s.memoryId === memoryId && this.matchScope(s.scope, scope)
    );

    const recentSignals = allSignals.filter((s) => s.createdAt >= midPoint);
    const olderSignals = allSignals.filter((s) => s.createdAt < midPoint);

    if (recentSignals.length === 0 && olderSignals.length === 0) {
      return "stable";
    }

    const recentScore =
      recentSignals.reduce((sum, s) => sum + s.strength, 0) / Math.max(1, recentSignals.length);
    const olderScore =
      olderSignals.reduce((sum, s) => sum + s.strength, 0) / Math.max(1, olderSignals.length);

    const changeRatio = recentScore / Math.max(0.01, olderScore);

    if (changeRatio > 1.2) return "growing";
    if (changeRatio < 0.8) return "declining";
    return "stable";
  }

  /**
   * 匹配作用域
   */
  private matchScope(scope: MemoryScope, filter: Partial<MemoryScope>): boolean {
    if (filter.tenantId && scope.tenantId !== filter.tenantId) return false;
    if (filter.appId && scope.appId !== filter.appId) return false;
    if (filter.userId && scope.userId !== filter.userId) return false;
    if (filter.projectId && scope.projectId !== filter.projectId) return false;
    if (filter.agentId && scope.agentId !== filter.agentId) return false;
    if (filter.namespace && scope.namespace !== filter.namespace) return false;
    if (filter.workspaceId && scope.workspaceId !== filter.workspaceId) return false;
    if (filter.sessionId && scope.sessionId !== filter.sessionId) return false;
    return true;
  }

  /**
   * 获取统计键
   */
  private getStatsKey(memoryId: string, scope: MemoryScope): string {
    return `${scope.tenantId}:${scope.appId}:${scope.userId}:${scope.projectId}:${memoryId}`;
  }
}
