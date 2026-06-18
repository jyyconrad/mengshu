/**
 * FeedbackCollector 集成示例
 *
 * 展示如何将反馈采集器集成到记忆系统的各个环节
 */

import { FeedbackCollector, InMemoryFeedbackStore } from "./index.js";
import type { MemoryScope } from "../core/types.js";

/**
 * 反馈集成示例类
 *
 * 演示如何在记忆系统的关键点集成反馈采集
 */
export class FeedbackIntegrationExample {
  private collector: FeedbackCollector;

  constructor(collector: FeedbackCollector) {
    this.collector = collector;
  }

  /**
   * 示例 1: 在记忆召回时记录反馈
   */
  async onMemoryRecall(params: {
    memoryId: string;
    scope: MemoryScope;
    query: string;
    score: number;
    rank: number;
    sessionId: string;
    conversationId?: string;
  }): Promise<void> {
    await this.collector.recordRecall(params.memoryId, params.scope, {
      queryText: params.query,
      recallScore: params.score,
      recallRank: params.rank,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
    });
  }

  /**
   * 示例 2: 检测用户采纳行为
   *
   * 可以通过以下信号判断采纳：
   * - 用户在响应中引用了记忆内容
   * - 用户复制了记忆内容
   * - 用户基于记忆做出决策
   * - 用户明确确认记忆正确
   */
  async detectAdoption(params: {
    memoryId: string;
    scope: MemoryScope;
    userMessage: string;
    assistantResponse: string;
    recalledMemoryText: string;
    sessionId: string;
  }): Promise<void> {
    // 简单的采纳检测逻辑（实际应更复杂）
    const userMentioned = params.userMessage
      .toLowerCase()
      .includes(params.recalledMemoryText.toLowerCase().substring(0, 20));

    const assistantUsed = params.assistantResponse
      .toLowerCase()
      .includes(params.recalledMemoryText.toLowerCase().substring(0, 20));

    if (userMentioned || assistantUsed) {
      await this.collector.recordAdoption(params.memoryId, params.scope, {
        adoptionType: userMentioned ? "direct_use" : "indirect_use",
        sessionId: params.sessionId,
        metadata: {
          userMentioned,
          assistantUsed,
        },
      });
    } else {
      // 在采纳窗口后检测是否未被采纳
      // 实际应由定时任务处理
    }
  }

  /**
   * 示例 3: 追踪记忆在上下文中的停留
   *
   * 当记忆被注入到 agent 上下文时开始追踪，
   * 当记忆从上下文移除或会话结束时结束追踪
   */
  async onContextInjection(params: {
    memoryId: string;
    scope: MemoryScope;
    contextSlot: "profile" | "task_context" | "rules" | "experience" | "resource";
    sessionId: string;
    conversationId?: string;
  }): Promise<void> {
    // 记录上下文注入事件
    await this.collector.recordContextInjection(params.memoryId, params.scope, {
      contextSlot: params.contextSlot,
      sessionId: params.sessionId,
      conversationId: params.conversationId,
    });

    // 开始停留追踪
    this.collector.startDwellingTracking(
      params.memoryId,
      params.contextSlot,
      params.sessionId
    );
  }

  /**
   * 示例 4: 会话结束时处理停留追踪
   */
  async onSessionEnd(params: {
    sessionId: string;
    scope: MemoryScope;
    injectedMemories: string[];
  }): Promise<void> {
    // 结束所有该会话的停留追踪
    for (const memoryId of params.injectedMemories) {
      await this.collector.endDwellingTracking(memoryId, params.scope, params.sessionId);
    }

    // 检测未采纳的召回
    const unadoptedMemoryIds = await this.collector.detectUnadoptedRecalls(
      params.sessionId
    );

    // 可以对未采纳的记忆进行处理
    if (unadoptedMemoryIds.length > 0) {
      console.log(
        `会话 ${params.sessionId} 中有 ${unadoptedMemoryIds.length} 条记忆未被采纳`,
        unadoptedMemoryIds
      );
    }
  }

  /**
   * 示例 5: 用户编辑记忆时记录反馈
   */
  async onMemoryEdit(params: {
    memoryId: string;
    scope: MemoryScope;
    sessionId?: string;
    conversationId?: string;
  }): Promise<void> {
    await this.collector.recordEdit(params.memoryId, params.scope, {
      sessionId: params.sessionId,
      conversationId: params.conversationId,
    });
  }

  /**
   * 示例 6: 用户显式反馈时记录
   */
  async onUserFeedback(params: {
    memoryId: string;
    scope: MemoryScope;
    positive: boolean;
    sessionId?: string;
  }): Promise<void> {
    await this.collector.recordExplicitFeedback(params.memoryId, params.scope, {
      positive: params.positive,
      sessionId: params.sessionId,
    });
  }

  /**
   * 示例 7: 基于反馈调整记忆重要性
   *
   * 定期任务，根据反馈统计调整记忆的重要性评分
   */
  async adjustImportanceBasedOnFeedback(
    memoryId: string,
    scope: MemoryScope,
    currentImportance: number
  ): Promise<number> {
    const stats = await this.collector.getStats(memoryId, scope, 30);

    if (!stats) {
      return currentImportance;
    }

    let adjustment = 0;

    // 高采纳率加分
    if (stats.adoptionRate > 0.8 && stats.recallCount >= 3) {
      adjustment += 0.1;
    }

    // 低采纳率减分
    if (stats.adoptionRate < 0.2 && stats.recallCount >= 5) {
      adjustment -= 0.1;
    }

    // 高加权分数加分
    if (stats.weightedScore > 10) {
      adjustment += 0.05;
    }

    // 有编辑行为加分（说明用户关注）
    if (stats.editCount > 0) {
      adjustment += 0.05;
    }

    // 有正面显式反馈加分
    if (stats.positiveFeedbackCount > 0) {
      adjustment += 0.1;
    }

    // 有负面显式反馈减分
    if (stats.negativeFeedbackCount > 0) {
      adjustment -= 0.15;
    }

    const newImportance = Math.max(0, Math.min(1, currentImportance + adjustment));

    return newImportance;
  }

  /**
   * 示例 8: 基于反馈计算热度（hotness）
   *
   * 根据算法设计文档 § 8.5 的公式计算
   */
  async calculateHotness(memoryId: string, scope: MemoryScope): Promise<number> {
    const stats = await this.collector.getStats(memoryId, scope, 30);

    if (!stats) {
      return 0;
    }

    // hotness = ln(mentionCount30d + 1) + 0.5 * distinctSourceCount
    //           + recencyDecay(now, lastSeenAt) + graphCentrality + 2.0 * queryHits30d

    const mentionCount = stats.recallCount + stats.contextInjectionCount;
    const queryHits = stats.queryHitCount;

    let hotness = Math.log(mentionCount + 1);
    hotness += 2.0 * queryHits;

    // 近期性衰减
    if (stats.lastRecallAt) {
      const daysSinceRecall =
        (Date.now() - stats.lastRecallAt) / (24 * 60 * 60 * 1000);

      if (daysSinceRecall <= 1) {
        hotness += 1.0;
      } else if (daysSinceRecall <= 7) {
        hotness += 0.5;
      } else if (daysSinceRecall <= 30) {
        hotness += 0.2;
      }
    }

    // 质量加成（采纳率）
    if (stats.adoptionRate > 0.5) {
      hotness *= 1 + stats.adoptionRate * 0.5;
    }

    return hotness;
  }

  /**
   * 示例 9: 识别高价值记忆
   *
   * 找出最值得保留和优化的记忆
   */
  async identifyHighValueMemories(
    scope: MemoryScope,
    limit: number = 20
  ): Promise<Array<{ memoryId: string; score: number; reason: string }>> {
    const allStats = await this.collector
      .querySignals({ scope })
      .then((signals) => {
        const memoryIds = new Set(signals.map((s) => s.memoryId));
        return this.collector.getBatchStats(Array.from(memoryIds), scope);
      });

    const scored = allStats
      .map((stats) => {
        let score = 0;
        const reasons: string[] = [];

        // 高采纳率
        if (stats.adoptionRate > 0.7 && stats.recallCount >= 3) {
          score += 10;
          reasons.push(`高采纳率 ${(stats.adoptionRate * 100).toFixed(0)}%`);
        }

        // 频繁召回
        if (stats.recallCount >= 10) {
          score += 5;
          reasons.push(`频繁召回 ${stats.recallCount} 次`);
        }

        // 长停留时间
        if (stats.avgDwellingDuration > 120000) {
          // > 2 分钟
          score += 3;
          reasons.push(
            `长停留 ${(stats.avgDwellingDuration / 60000).toFixed(1)} 分钟`
          );
        }

        // 有用户编辑
        if (stats.editCount > 0) {
          score += 2;
          reasons.push(`用户编辑 ${stats.editCount} 次`);
        }

        // 显式正面反馈
        if (stats.positiveFeedbackCount > 0) {
          score += 5;
          reasons.push(`正面反馈 ${stats.positiveFeedbackCount} 次`);
        }

        // 加权分数高
        if (stats.weightedScore > 15) {
          score += 8;
          reasons.push(`高加权分数 ${stats.weightedScore.toFixed(1)}`);
        }

        return {
          memoryId: stats.memoryId,
          score,
          reason: reasons.join(", "),
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }

  /**
   * 示例 10: 识别低价值记忆（候选删除）
   *
   * 找出可能需要归档或删除的记忆
   */
  async identifyLowValueMemories(
    scope: MemoryScope,
    limit: number = 20
  ): Promise<Array<{ memoryId: string; score: number; reason: string }>> {
    const allStats = await this.collector
      .querySignals({ scope })
      .then((signals) => {
        const memoryIds = new Set(signals.map((s) => s.memoryId));
        return this.collector.getBatchStats(Array.from(memoryIds), scope);
      });

    const scored = allStats
      .map((stats) => {
        let score = 0;
        const reasons: string[] = [];

        // 低采纳率
        if (stats.adoptionRate < 0.2 && stats.recallCount >= 5) {
          score += 10;
          reasons.push(`低采纳率 ${(stats.adoptionRate * 100).toFixed(0)}%`);
        }

        // 多次拒绝
        if (stats.rejectionCount >= 3) {
          score += 8;
          reasons.push(`拒绝 ${stats.rejectionCount} 次`);
        }

        // 负面反馈
        if (stats.negativeFeedbackCount > 0) {
          score += 12;
          reasons.push(`负面反馈 ${stats.negativeFeedbackCount} 次`);
        }

        // 长期未召回
        if (stats.lastRecallAt) {
          const daysSinceRecall =
            (Date.now() - stats.lastRecallAt) / (24 * 60 * 60 * 1000);
          if (daysSinceRecall > 60) {
            score += 5;
            reasons.push(`${Math.floor(daysSinceRecall)} 天未召回`);
          }
        }

        // 低加权分数
        if (stats.weightedScore < 0) {
          score += 7;
          reasons.push(`负加权分数 ${stats.weightedScore.toFixed(1)}`);
        }

        return {
          memoryId: stats.memoryId,
          score,
          reason: reasons.join(", "),
        };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return scored;
  }
}

/**
 * 使用示例
 */
export async function usageExample() {
  // 1. 初始化
  const store = new InMemoryFeedbackStore();
  const collector = new FeedbackCollector(store, {
    enabled: true,
    adoptionWindowMs: 5 * 60 * 1000,
    dwellingThresholdMs: 30 * 1000,
  });

  await collector.initialize();

  const integration = new FeedbackIntegrationExample(collector);

  const testScope: MemoryScope = {
    tenantId: "tenant-1",
    appId: "app-1",
    userId: "user-1",
    projectId: "project-1",
    agentId: "agent-1",
    namespace: "default",
  };

  // 2. 记忆召回
  await integration.onMemoryRecall({
    memoryId: "memory-123",
    scope: testScope,
    query: "如何实现反馈采集",
    score: 0.85,
    rank: 1,
    sessionId: "session-456",
  });

  // 3. 上下文注入
  await integration.onContextInjection({
    memoryId: "memory-123",
    scope: testScope,
    contextSlot: "experience",
    sessionId: "session-456",
  });

  // 4. 用户采纳
  await integration.detectAdoption({
    memoryId: "memory-123",
    scope: testScope,
    userMessage: "好的，我按照这个方法实现",
    assistantResponse: "我会帮你实现反馈采集器",
    recalledMemoryText: "实现反馈采集器需要...",
    sessionId: "session-456",
  });

  // 5. 会话结束
  await integration.onSessionEnd({
    sessionId: "session-456",
    scope: testScope,
    injectedMemories: ["memory-123"],
  });

  // 6. 调整重要性
  const newImportance = await integration.adjustImportanceBasedOnFeedback(
    "memory-123",
    testScope,
    0.7
  );
  console.log("调整后的重要性:", newImportance);

  // 7. 计算热度
  const hotness = await integration.calculateHotness("memory-123", testScope);
  console.log("热度:", hotness);

  // 8. 识别高价值记忆
  const highValue = await integration.identifyHighValueMemories(testScope, 10);
  console.log("高价值记忆:", highValue);

  // 9. 识别低价值记忆
  const lowValue = await integration.identifyLowValueMemories(testScope, 10);
  console.log("低价值记忆:", lowValue);

  // 10. 清理
  await collector.close();
}
