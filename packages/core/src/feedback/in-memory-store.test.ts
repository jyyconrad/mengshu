/**
 * InMemoryFeedbackStore 单元测试
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryFeedbackStore } from "./in-memory-store.js";
import type { MemoryScope } from "../core/types.js";
import type { FeedbackSignal } from "./types.js";

describe("InMemoryFeedbackStore", () => {
  let store: InMemoryFeedbackStore;
  let testScope: MemoryScope;

  beforeEach(async () => {
    store = new InMemoryFeedbackStore();
    await store.initialize();

    testScope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };
  });

  describe("storeSignals", () => {
    it("应该存储反馈信号", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          recallScore: 0.8,
          recallRank: 1,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const result = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("signal-1");
    });

    it("应该自动更新统计", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "adoption",
          strength: 1.0,
          adoptionType: "direct_use",
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.recallCount).toBe(1);
      expect(stats!.adoptionCount).toBe(1);
      expect(stats!.adoptionRate).toBe(1.0);
    });
  });

  describe("querySignals", () => {
    beforeEach(async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          recallScore: 0.8,
          recallRank: 1,
          sessionId: "session-1",
          createdAt: Date.now() - 1000,
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "adoption",
          strength: 1.0,
          adoptionType: "direct_use",
          sessionId: "session-1",
          createdAt: Date.now(),
        },
        {
          id: "signal-3",
          memoryId: "memory-2",
          scope: testScope,
          signalType: "recall",
          strength: 0.7,
          recallScore: 0.7,
          recallRank: 2,
          sessionId: "session-2",
          createdAt: Date.now() - 2000,
        },
      ];

      await store.storeSignals(signals);
    });

    it("应该按记忆ID过滤", async () => {
      const results = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.memoryId === "memory-1")).toBe(true);
    });

    it("应该按信号类型过滤", async () => {
      const results = await store.querySignals({
        signalTypes: ["recall"],
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.signalType === "recall")).toBe(true);
    });

    it("应该按会话ID过滤", async () => {
      const results = await store.querySignals({
        sessionId: "session-1",
      });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.sessionId === "session-1")).toBe(true);
    });

    it("应该按时间范围过滤", async () => {
      const now = Date.now();
      const results = await store.querySignals({
        startTime: now - 1500,
        endTime: now,
      });

      expect(results).toHaveLength(2);
    });

    it("应该支持排序", async () => {
      const results = await store.querySignals({
        sortBy: "createdAt",
        sortOrder: "asc",
      });

      expect(results[0].id).toBe("signal-3");
      expect(results[results.length - 1].id).toBe("signal-2");
    });

    it("应该支持限制数量", async () => {
      const results = await store.querySignals({
        limit: 2,
      });

      expect(results).toHaveLength(2);
    });

    it("应该支持组合过滤", async () => {
      const results = await store.querySignals({
        memoryIds: ["memory-1"],
        signalTypes: ["recall"],
        sessionId: "session-1",
      });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("signal-1");
    });
  });

  describe("getStats", () => {
    it("应该计算召回统计", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.recallCount).toBe(2);
    });

    it("应该计算采纳率", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: Date.now(),
        },
        {
          id: "signal-3",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "adoption",
          strength: 1.0,
          adoptionType: "direct_use",
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.recallCount).toBe(2);
      expect(stats!.adoptionCount).toBe(1);
      expect(stats!.adoptionRate).toBe(0.5); // 50%
    });

    it("应该计算平均停留时长", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "dwelling",
          strength: 0.5,
          dwellingDuration: 60000, // 1 分钟
          contextSlot: "task_context",
          sessionId: "session-1",
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "dwelling",
          strength: 0.8,
          dwellingDuration: 120000, // 2 分钟
          contextSlot: "task_context",
          sessionId: "session-2",
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.avgDwellingDuration).toBe(90000); // 平均 1.5 分钟
    });

    it("应该计算加权分数", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "adoption",
          strength: 1.0,
          adoptionType: "direct_use",
          createdAt: Date.now(),
        },
        {
          id: "signal-3",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "explicit_feedback",
          strength: 1.0,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.weightedScore).toBeGreaterThan(0);
    });

    it("应该处理负面反馈", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "rejection",
          strength: -0.5,
          adoptionType: "reject",
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const stats = await store.getStats("memory-1", testScope, 30);

      expect(stats).toBeDefined();
      expect(stats!.rejectionCount).toBe(1);
      expect(stats!.adoptionRate).toBe(0); // 0% 采纳率
    });
  });

  describe("getBatchStats", () => {
    it("应该批量获取统计", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-2",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      const statsList = await store.getBatchStats(
        ["memory-1", "memory-2"],
        testScope,
        30
      );

      expect(statsList).toHaveLength(2);
      expect(statsList.every((s) => s.recallCount === 1)).toBe(true);
    });
  });

  describe("queryStats", () => {
    beforeEach(async () => {
      const signals: FeedbackSignal[] = [
        // memory-1: 高采纳率
        {
          id: "s1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "s2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "adoption",
          strength: 1.0,
          adoptionType: "direct_use",
          createdAt: Date.now(),
        },
        // memory-2: 低采纳率
        {
          id: "s3",
          memoryId: "memory-2",
          scope: testScope,
          signalType: "recall",
          strength: 0.7,
          createdAt: Date.now(),
        },
        {
          id: "s4",
          memoryId: "memory-2",
          scope: testScope,
          signalType: "recall",
          strength: 0.6,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);
    });

    it("应该按最小召回次数过滤", async () => {
      const results = await store.queryStats({
        minRecallCount: 2,
      });

      expect(results).toHaveLength(1);
      expect(results[0].memoryId).toBe("memory-2");
    });

    it("应该按最小采纳率过滤", async () => {
      const results = await store.queryStats({
        minAdoptionRate: 0.5,
      });

      expect(results).toHaveLength(1);
      expect(results[0].memoryId).toBe("memory-1");
    });

    it("应该支持排序", async () => {
      const results = await store.queryStats({
        sortBy: "adoptionRate",
        sortOrder: "desc",
      });

      expect(results[0].memoryId).toBe("memory-1");
      expect(results[results.length - 1].memoryId).toBe("memory-2");
    });
  });

  describe("getAggregation", () => {
    it("应该获取聚合数据和趋势", async () => {
      const now = Date.now();
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.5,
          createdAt: now - 20 * 24 * 60 * 60 * 1000, // 20 天前
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: now, // 今天
        },
      ];

      await store.storeSignals(signals);

      const aggregation = await store.getAggregation("memory-1", testScope, 30);

      expect(aggregation).toBeDefined();
      expect(aggregation!.stats.recallCount).toBe(2);
      expect(aggregation!.trend).toBe("growing");
      expect(aggregation!.recentSignals).toBeDefined();
    });

    it("应该检测下降趋势", async () => {
      const now = Date.now();
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: now - 20 * 24 * 60 * 60 * 1000, // 20 天前
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.3,
          createdAt: now, // 今天
        },
      ];

      await store.storeSignals(signals);

      const aggregation = await store.getAggregation("memory-1", testScope, 30);

      expect(aggregation).toBeDefined();
      expect(aggregation!.trend).toBe("declining");
    });
  });

  describe("cleanupExpiredSignals", () => {
    it("应该清理过期信号", async () => {
      const now = Date.now();
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: now - 40 * 24 * 60 * 60 * 1000, // 40 天前
        },
        {
          id: "signal-2",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: now, // 今天
        },
      ];

      await store.storeSignals(signals);

      const deletedCount = await store.cleanupExpiredSignals(30);

      expect(deletedCount).toBe(1);

      const remaining = await store.querySignals({});
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("signal-2");
    });
  });

  describe("rebuildStats", () => {
    it("应该重建单个记忆的统计", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      await store.rebuildStats("memory-1");

      const stats = await store.getStats("memory-1", testScope, 30);
      expect(stats).toBeDefined();
      expect(stats!.recallCount).toBe(1);
    });

    it("应该重建所有统计", async () => {
      const signals: FeedbackSignal[] = [
        {
          id: "signal-1",
          memoryId: "memory-1",
          scope: testScope,
          signalType: "recall",
          strength: 0.8,
          createdAt: Date.now(),
        },
        {
          id: "signal-2",
          memoryId: "memory-2",
          scope: testScope,
          signalType: "recall",
          strength: 0.9,
          createdAt: Date.now(),
        },
      ];

      await store.storeSignals(signals);

      await store.rebuildStats();

      const statsList = await store.queryStats({});
      expect(statsList.length).toBeGreaterThanOrEqual(2);
    });
  });
});
