/**
 * FeedbackCollector 单元测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { FeedbackCollector } from "./collector.js";
import { InMemoryFeedbackStore } from "./in-memory-store.js";
import type { MemoryScope } from "../core/types.js";

describe("FeedbackCollector", () => {
  let collector: FeedbackCollector;
  let store: InMemoryFeedbackStore;
  let testScope: MemoryScope;

  beforeEach(async () => {
    store = new InMemoryFeedbackStore();
    collector = new FeedbackCollector(store, {
      enabled: true,
      batchSize: 5,
      batchIntervalMs: 100,
    });

    testScope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };

    await collector.initialize();
  });

  afterEach(async () => {
    await collector.close();
  });

  describe("recordRecall", () => {
    it("应该记录召回事件", async () => {
      await collector.recordRecall("memory-1", testScope, {
        queryText: "test query",
        recallScore: 0.85,
        recallRank: 1,
        sessionId: "session-1",
      });

      // 等待批量刷新
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("recall");
      expect(signals[0].queryText).toBe("test query");
      expect(signals[0].recallScore).toBe(0.85);
      expect(signals[0].recallRank).toBe(1);
    });

    it("应该计算召回强度（考虑排名）", async () => {
      // 第一名
      await collector.recordRecall("memory-1", testScope, {
        recallScore: 0.9,
        recallRank: 1,
      });

      // 第十名
      await collector.recordRecall("memory-2", testScope, {
        recallScore: 0.9,
        recallRank: 10,
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({});
      const signal1 = signals.find((s) => s.memoryId === "memory-1");
      const signal2 = signals.find((s) => s.memoryId === "memory-2");

      expect(signal1!.strength).toBeGreaterThan(signal2!.strength);
    });
  });

  describe("recordAdoption", () => {
    it("应该记录采纳事件", async () => {
      await collector.recordAdoption("memory-1", testScope, {
        adoptionType: "direct_use",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("adoption");
      expect(signals[0].adoptionType).toBe("direct_use");
      expect(signals[0].strength).toBe(1.0);
    });

    it("应该记录拒绝事件", async () => {
      await collector.recordAdoption("memory-1", testScope, {
        adoptionType: "reject",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("rejection");
      expect(signals[0].adoptionType).toBe("reject");
      expect(signals[0].strength).toBe(-0.5);
    });

    it("应该区分不同采纳类型的强度", async () => {
      await collector.recordAdoption("memory-1", testScope, {
        adoptionType: "direct_use",
      });
      await collector.recordAdoption("memory-2", testScope, {
        adoptionType: "confirm",
      });
      await collector.recordAdoption("memory-3", testScope, {
        adoptionType: "indirect_use",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({});
      const directUse = signals.find((s) => s.memoryId === "memory-1");
      const confirm = signals.find((s) => s.memoryId === "memory-2");
      const indirectUse = signals.find((s) => s.memoryId === "memory-3");

      expect(directUse!.strength).toBeGreaterThan(confirm!.strength);
      expect(confirm!.strength).toBeGreaterThan(indirectUse!.strength);
    });
  });

  describe("recordDwelling", () => {
    it("应该记录停留事件", async () => {
      await collector.recordDwelling("memory-1", testScope, {
        dwellingDuration: 60000, // 1 分钟
        contextSlot: "task_context",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("dwelling");
      expect(signals[0].dwellingDuration).toBe(60000);
      expect(signals[0].contextSlot).toBe("task_context");
    });

    it("应该忽略低于阈值的停留", async () => {
      await collector.recordDwelling("memory-1", testScope, {
        dwellingDuration: 10000, // 10 秒，低于默认阈值 30 秒
        contextSlot: "task_context",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(0);
    });

    it("应该计算停留强度（对数函数）", async () => {
      await collector.recordDwelling("memory-1", testScope, {
        dwellingDuration: 60000, // 1 分钟
        contextSlot: "task_context",
        sessionId: "session-1",
      });

      await collector.recordDwelling("memory-2", testScope, {
        dwellingDuration: 300000, // 5 分钟
        contextSlot: "task_context",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({});
      const signal1 = signals.find((s) => s.memoryId === "memory-1");
      const signal2 = signals.find((s) => s.memoryId === "memory-2");

      expect(signal2!.strength).toBeGreaterThan(signal1!.strength);
      expect(signal2!.strength).toBeLessThanOrEqual(1.0);
    });
  });

  describe("recordEdit", () => {
    it("应该记录编辑事件", async () => {
      await collector.recordEdit("memory-1", testScope, {
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("edit");
      expect(signals[0].strength).toBe(1.0);
    });
  });

  describe("recordExplicitFeedback", () => {
    it("应该记录正面反馈", async () => {
      await collector.recordExplicitFeedback("memory-1", testScope, {
        positive: true,
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("explicit_feedback");
      expect(signals[0].strength).toBe(1.0);
    });

    it("应该记录负面反馈", async () => {
      await collector.recordExplicitFeedback("memory-1", testScope, {
        positive: false,
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("explicit_feedback");
      expect(signals[0].strength).toBe(-1.0);
    });
  });

  describe("recordQueryHit", () => {
    it("应该记录查询命中", async () => {
      await collector.recordQueryHit("memory-1", testScope, {
        queryText: "search term",
        recallScore: 0.75,
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("query_hit");
      expect(signals[0].queryText).toBe("search term");
      expect(signals[0].recallScore).toBe(0.75);
    });
  });

  describe("recordContextInjection", () => {
    it("应该记录上下文注入", async () => {
      await collector.recordContextInjection("memory-1", testScope, {
        contextSlot: "rules",
        sessionId: "session-1",
      });

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: ["memory-1"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].signalType).toBe("context_injection");
      expect(signals[0].contextSlot).toBe("rules");
    });
  });

  describe("停留追踪", () => {
    it("应该追踪停留时间", async () => {
      const memoryId = "memory-1";
      const sessionId = "session-1";

      // 开始追踪
      collector.startDwellingTracking(memoryId, "task_context", sessionId);

      // 模拟 2 分钟后结束
      vi.useFakeTimers();
      vi.advanceTimersByTime(120000);

      // 结束追踪
      await collector.endDwellingTracking(memoryId, testScope, sessionId);

      vi.useRealTimers();

      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({
        memoryIds: [memoryId],
        signalTypes: ["dwelling"],
      });

      expect(signals).toHaveLength(1);
      expect(signals[0].dwellingDuration).toBeGreaterThan(0);
    });
  });

  describe("批量写入", () => {
    it("应该在达到批量大小时自动刷新", async () => {
      // 批量大小设为 5，记录 6 条
      for (let i = 0; i < 6; i++) {
        await collector.recordRecall(`memory-${i}`, testScope, {
          recallScore: 0.8,
          recallRank: i,
        });
      }

      // 等待一下（前 5 条应该已经刷新）
      await new Promise((resolve) => setTimeout(resolve, 50));

      const signals = await store.querySignals({});
      expect(signals.length).toBeGreaterThanOrEqual(5);
    });

    it("应该在定时器触发时刷新", async () => {
      // 记录少于批量大小的数据
      await collector.recordRecall("memory-1", testScope, {
        recallScore: 0.8,
        recallRank: 1,
      });

      // 等待定时器触发
      await new Promise((resolve) => setTimeout(resolve, 150));

      const signals = await store.querySignals({});
      expect(signals.length).toBeGreaterThanOrEqual(1);
    });

    it("应该在关闭时刷新剩余批次", async () => {
      await collector.recordRecall("memory-1", testScope, {
        recallScore: 0.8,
        recallRank: 1,
      });

      // 立即关闭（不等定时器）
      await collector.close();

      const signals = await store.querySignals({});
      expect(signals).toHaveLength(1);
    });
  });

  describe("采纳检测", () => {
    it("应该检测未采纳的召回", async () => {
      // 自定义配置：采纳窗口为 100ms
      const shortWindowCollector = new FeedbackCollector(store, {
        enabled: true,
        adoptionWindowMs: 100,
      });
      await shortWindowCollector.initialize();

      await shortWindowCollector.recordRecall("memory-1", testScope, {
        recallScore: 0.8,
        recallRank: 1,
        sessionId: "session-1",
      });

      // 等待超过采纳窗口
      await new Promise((resolve) => setTimeout(resolve, 150));

      const unadopted = await shortWindowCollector.detectUnadoptedRecalls("session-1");
      expect(unadopted).toContain("memory-1");

      await shortWindowCollector.close();
    });
  });

  describe("统计查询", () => {
    it("应该获取单个记忆的统计", async () => {
      const memoryId = "memory-1";

      // 记录多个事件
      await collector.recordRecall(memoryId, testScope, {
        recallScore: 0.8,
        recallRank: 1,
      });
      await collector.recordAdoption(memoryId, testScope, {
        adoptionType: "direct_use",
      });
      await collector.recordEdit(memoryId, testScope, {});

      await new Promise((resolve) => setTimeout(resolve, 150));

      const stats = await collector.getStats(memoryId, testScope);

      expect(stats).toBeDefined();
      expect(stats.recallCount).toBe(1);
      expect(stats.adoptionCount).toBe(1);
      expect(stats.editCount).toBe(1);
      expect(stats.adoptionRate).toBe(1.0); // 100% 采纳率
    });

    it("应该批量获取统计", async () => {
      const memoryIds = ["memory-1", "memory-2", "memory-3"];

      for (const memoryId of memoryIds) {
        await collector.recordRecall(memoryId, testScope, {
          recallScore: 0.8,
          recallRank: 1,
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 150));

      const statsList = await collector.getBatchStats(memoryIds, testScope);

      expect(statsList).toHaveLength(3);
      expect(statsList.every((s) => s.recallCount === 1)).toBe(true);
    });
  });
});
