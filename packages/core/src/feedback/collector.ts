/**
 * FeedbackCollector: 反馈信号采集器
 *
 * 负责采集和存储各类隐式反馈信号，支持：
 * 1. 召回事件追踪
 * 2. 采纳率检测
 * 3. 停留时间统计
 * 4. 二次召回检测
 * 5. 显式反馈记录
 * 6. 批量写入优化
 */

import { nanoid } from "nanoid";
import type { MemoryScope } from "../core/types.js";
import type {
  FeedbackSignal,
  FeedbackSignalType,
  AdoptionType,
  FeedbackCollectorConfig,
  AdoptionDetectionContext,
  DwellingDetectionContext,
  FeedbackQueryOptions,
  FeedbackBatchItem,
} from "./types.js";
import type { FeedbackStore } from "./store.js";

/**
 * 默认配置
 */
const DEFAULT_CONFIG: FeedbackCollectorConfig = {
  enabled: true,
  adoptionWindowMs: 5 * 60 * 1000, // 5 分钟
  dwellingThresholdMs: 30 * 1000, // 30 秒
  aggregationWindowDays: 30,
  batchSize: 50,
  batchIntervalMs: 5000, // 5 秒
  weights: {
    recall: 0.1,
    adoption: 1.0,
    rejection: -0.5,
    dwelling: 0.3,
    edit: 0.8,
    explicitFeedback: 1.5,
    queryHit: 0.2,
    contextInjection: 0.15,
  },
  recordDetailedMetadata: true,
};

/**
 * FeedbackCollector 实现
 */
export class FeedbackCollector {
  private config: FeedbackCollectorConfig;
  private store: FeedbackStore;
  private batchQueue: FeedbackBatchItem[] = [];
  private batchTimer?: NodeJS.Timeout;
  private adoptionContexts: Map<string, AdoptionDetectionContext[]> = new Map();
  private dwellingContexts: Map<string, DwellingDetectionContext> = new Map();

  constructor(store: FeedbackStore, config?: Partial<FeedbackCollectorConfig>) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化采集器
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // 启动批量写入定时器
    this.startBatchTimer();
  }

  /**
   * 关闭采集器
   */
  async close(): Promise<void> {
    // 停止批量写入定时器
    this.stopBatchTimer();

    // 刷新剩余批次
    await this.flushBatch();

    // 清理上下文
    this.adoptionContexts.clear();
    this.dwellingContexts.clear();
  }

  /**
   * 记录召回事件
   */
  async recordRecall(
    memoryId: string,
    scope: MemoryScope,
    context: {
      queryText?: string;
      recallScore: number;
      recallRank: number;
      sessionId?: string;
      conversationId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "recall",
      strength: this.calculateRecallStrength(context.recallScore, context.recallRank),
      queryText: context.queryText,
      recallScore: context.recallScore,
      recallRank: context.recallRank,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);

    // 记录采纳检测上下文
    this.addAdoptionContext({
      memoryId,
      recallTime: Date.now(),
      recallScore: context.recallScore,
      recallRank: context.recallRank,
      queryText: context.queryText,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
    });
  }

  /**
   * 记录采纳事件
   */
  async recordAdoption(
    memoryId: string,
    scope: MemoryScope,
    context: {
      adoptionType: AdoptionType;
      strength?: number;
      sessionId?: string;
      conversationId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: context.adoptionType === "reject" ? "rejection" : "adoption",
      strength: context.strength ?? this.getAdoptionStrength(context.adoptionType),
      adoptionType: context.adoptionType,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);

    // 清理对应的采纳检测上下文
    this.removeAdoptionContext(memoryId, context.sessionId);
  }

  /**
   * 记录停留事件
   */
  async recordDwelling(
    memoryId: string,
    scope: MemoryScope,
    context: {
      dwellingDuration: number;
      contextSlot: "profile" | "task_context" | "rules" | "experience" | "resource";
      sessionId: string;
      conversationId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // 只记录超过阈值的停留
    if (context.dwellingDuration < this.config.dwellingThresholdMs) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "dwelling",
      strength: this.calculateDwellingStrength(context.dwellingDuration),
      dwellingDuration: context.dwellingDuration,
      contextSlot: context.contextSlot,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);
  }

  /**
   * 记录编辑事件
   */
  async recordEdit(
    memoryId: string,
    scope: MemoryScope,
    context: {
      sessionId?: string;
      conversationId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "edit",
      strength: 1.0,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);
  }

  /**
   * 记录显式反馈
   */
  async recordExplicitFeedback(
    memoryId: string,
    scope: MemoryScope,
    context: {
      positive: boolean;
      strength?: number;
      sessionId?: string;
      conversationId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "explicit_feedback",
      strength: context.strength ?? (context.positive ? 1.0 : -1.0),
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      metadata: this.config.recordDetailedMetadata
        ? { ...context.metadata, positive: context.positive }
        : undefined,
    };

    await this.addToBatch(signal);
  }

  /**
   * 记录查询命中
   */
  async recordQueryHit(
    memoryId: string,
    scope: MemoryScope,
    context: {
      queryText: string;
      recallScore: number;
      sessionId?: string;
      conversationId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "query_hit",
      strength: Math.min(1.0, context.recallScore),
      queryText: context.queryText,
      recallScore: context.recallScore,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);
  }

  /**
   * 记录上下文注入
   */
  async recordContextInjection(
    memoryId: string,
    scope: MemoryScope,
    context: {
      contextSlot: "profile" | "task_context" | "rules" | "experience" | "resource";
      sessionId: string;
      conversationId?: string;
      messageId?: string;
      metadata?: Record<string, unknown>;
    }
  ): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const signal: Omit<FeedbackSignal, "id" | "createdAt"> = {
      memoryId,
      scope,
      signalType: "context_injection",
      strength: 1.0,
      contextSlot: context.contextSlot,
      sessionId: context.sessionId,
      conversationId: context.conversationId,
      messageId: context.messageId,
      metadata: this.config.recordDetailedMetadata ? context.metadata : undefined,
    };

    await this.addToBatch(signal);

    // 记录停留检测上下文
    this.addDwellingContext({
      memoryId,
      injectionTime: Date.now(),
      contextSlot: context.contextSlot,
      sessionId: context.sessionId,
    });
  }

  /**
   * 开始停留追踪（当记忆被注入上下文时）
   */
  startDwellingTracking(
    memoryId: string,
    contextSlot: string,
    sessionId: string
  ): void {
    const key = this.getDwellingKey(memoryId, sessionId);
    this.dwellingContexts.set(key, {
      memoryId,
      injectionTime: Date.now(),
      contextSlot,
      sessionId,
    });
  }

  /**
   * 结束停留追踪（当记忆从上下文移除或会话结束时）
   */
  async endDwellingTracking(
    memoryId: string,
    scope: MemoryScope,
    sessionId: string
  ): Promise<void> {
    const key = this.getDwellingKey(memoryId, sessionId);
    const context = this.dwellingContexts.get(key);

    if (!context) {
      return;
    }

    const dwellingDuration = Date.now() - context.injectionTime;

    await this.recordDwelling(memoryId, scope, {
      dwellingDuration,
      contextSlot: context.contextSlot as any,
      sessionId,
    });

    this.dwellingContexts.delete(key);
  }

  /**
   * 查询反馈信号
   */
  async querySignals(options: FeedbackQueryOptions): Promise<FeedbackSignal[]> {
    return this.store.querySignals(options);
  }

  /**
   * 获取记忆的反馈统计
   */
  async getStats(memoryId: string, scope: MemoryScope, periodDays?: number): Promise<any> {
    return this.store.getStats(memoryId, scope, periodDays ?? this.config.aggregationWindowDays);
  }

  /**
   * 批量获取反馈统计
   */
  async getBatchStats(memoryIds: string[], scope: MemoryScope, periodDays?: number): Promise<any[]> {
    return this.store.getBatchStats(memoryIds, scope, periodDays ?? this.config.aggregationWindowDays);
  }

  /**
   * 检测未采纳的召回（用于定期清理或标记）
   */
  async detectUnadoptedRecalls(sessionId?: string): Promise<string[]> {
    const now = Date.now();
    const unadoptedMemoryIds: string[] = [];

    const contexts = sessionId
      ? this.adoptionContexts.get(sessionId) || []
      : Array.from(this.adoptionContexts.values()).flat();

    for (const context of contexts) {
      const elapsed = now - context.recallTime;
      if (elapsed > this.config.adoptionWindowMs) {
        unadoptedMemoryIds.push(context.memoryId);
      }
    }

    return unadoptedMemoryIds;
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  /**
   * 添加到批量队列
   */
  private async addToBatch(signal: Omit<FeedbackSignal, "id" | "createdAt">): Promise<void> {
    this.batchQueue.push({
      signal,
      timestamp: Date.now(),
    });

    // 如果达到批量大小，立即刷新
    if (this.batchQueue.length >= this.config.batchSize) {
      await this.flushBatch();
    }
  }

  /**
   * 刷新批量队列
   */
  private async flushBatch(): Promise<void> {
    if (this.batchQueue.length === 0) {
      return;
    }

    const batch = this.batchQueue.splice(0, this.batchQueue.length);
    const signals: FeedbackSignal[] = batch.map((item) => ({
      id: nanoid(),
      ...item.signal,
      createdAt: item.timestamp,
    }));

    try {
      await this.store.storeSignals(signals);
    } catch (error) {
      console.error("[FeedbackCollector] Failed to flush batch:", error);
      // 如果写入失败，重新放回队列（保留最多 1000 条）
      if (this.batchQueue.length < 1000) {
        this.batchQueue.unshift(...batch);
      }
    }
  }

  /**
   * 启动批量写入定时器
   */
  private startBatchTimer(): void {
    this.batchTimer = setInterval(() => {
      this.flushBatch().catch((error) => {
        console.error("[FeedbackCollector] Batch timer flush failed:", error);
      });
    }, this.config.batchIntervalMs);
  }

  /**
   * 停止批量写入定时器
   */
  private stopBatchTimer(): void {
    if (this.batchTimer) {
      clearInterval(this.batchTimer);
      this.batchTimer = undefined;
    }
  }

  /**
   * 添加采纳检测上下文
   */
  private addAdoptionContext(context: AdoptionDetectionContext): void {
    const key = context.sessionId || "global";
    const contexts = this.adoptionContexts.get(key) || [];
    contexts.push(context);
    this.adoptionContexts.set(key, contexts);

    // 定期清理过期上下文（避免内存泄漏）
    setTimeout(() => {
      this.removeAdoptionContext(context.memoryId, context.sessionId);
    }, this.config.adoptionWindowMs * 2);
  }

  /**
   * 移除采纳检测上下文
   */
  private removeAdoptionContext(memoryId: string, sessionId?: string): void {
    const key = sessionId || "global";
    const contexts = this.adoptionContexts.get(key) || [];
    const filtered = contexts.filter((c) => c.memoryId !== memoryId);

    if (filtered.length === 0) {
      this.adoptionContexts.delete(key);
    } else {
      this.adoptionContexts.set(key, filtered);
    }
  }

  /**
   * 添加停留检测上下文
   */
  private addDwellingContext(context: DwellingDetectionContext): void {
    const key = this.getDwellingKey(context.memoryId, context.sessionId);
    this.dwellingContexts.set(key, context);
  }

  /**
   * 获取停留上下文键
   */
  private getDwellingKey(memoryId: string, sessionId: string): string {
    return `${memoryId}:${sessionId}`;
  }

  /**
   * 计算召回强度
   */
  private calculateRecallStrength(recallScore: number, recallRank: number): number {
    // 基础强度 = 召回分数
    const baseStrength = Math.min(1.0, recallScore);

    // 排名衰减（排名越靠前，强度越高）
    const rankDecay = Math.exp(-recallRank / 10);

    return baseStrength * (0.5 + 0.5 * rankDecay);
  }

  /**
   * 计算停留强度
   */
  private calculateDwellingStrength(dwellingDuration: number): number {
    // 使用对数函数，避免极长时间过度权重
    const normalizedDuration = dwellingDuration / this.config.dwellingThresholdMs;
    return Math.min(1.0, Math.log10(1 + normalizedDuration) / 2);
  }

  /**
   * 获取采纳强度
   */
  private getAdoptionStrength(adoptionType: AdoptionType): number {
    switch (adoptionType) {
      case "direct_use":
        return 1.0;
      case "confirm":
        return 0.9;
      case "extend":
        return 0.8;
      case "indirect_use":
        return 0.6;
      case "ignore":
        return 0.0;
      case "reject":
        return -0.5;
      default:
        return 0.5;
    }
  }
}
