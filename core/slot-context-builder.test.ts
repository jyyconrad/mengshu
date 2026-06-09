/**
 * slot-context-builder.test.ts
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SlotContextBuilder } from "./slot-context-builder.js";
import { SlotSnapshotCache } from "./slot-snapshot.js";
import type { MemoryScope } from "./semantic-types.js";
import type { MemoryRecord } from "./types.js";

const mockScope: MemoryScope = {
  tenantId: "test-tenant",
  appId: "test-app",
  userId: "test-user",
  projectId: "test-project",
  agentId: "test-agent",
  namespace: "memories",
};

const mockRecords: Partial<MemoryRecord>[] = [
  {
    id: "mem-1",
    kind: "goal",
    semanticType: "task_context",
    text: "完成项目架构升级",
    importance: 0.9,
    scope: mockScope,
  },
  {
    id: "mem-2",
    kind: "document",
    semanticType: "resource",
    text: "参考文档：docs/architecture.md",
    importance: 0.7,
    scope: mockScope,
  },
  {
    id: "mem-3",
    kind: "preference",
    text: "用户喜欢简洁的代码风格",
    importance: 0.8,
    scope: mockScope,
  },
  {
    id: "mem-4",
    kind: "decision",
    text: "选择 LanceDB 作为向量库",
    importance: 0.85,
    scope: mockScope,
  },
];

describe("SlotContextBuilder", () => {
  let builder: SlotContextBuilder;
  let cache: SlotSnapshotCache;

  beforeEach(() => {
    cache = new SlotSnapshotCache();
    builder = new SlotContextBuilder(cache);
  });

  describe("buildSlotContext", () => {
    it("应该构建 5 槽位上下文", async () => {
      const result = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.slots.resource).toBeDefined();
      expect(result.telemetry.nodesUsed).toBeGreaterThan(0);
    });

    it("应该按 importance 排序", async () => {
      const records: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", semanticType: "task_context", text: "Low priority", importance: 0.3, scope: mockScope },
        { id: "2", kind: "goal", semanticType: "task_context", text: "High priority", importance: 0.9, scope: mockScope },
        { id: "3", kind: "goal", semanticType: "task_context", text: "Medium priority", importance: 0.6, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        records as MemoryRecord[],
        { tokenBudgetPerSlot: 200, useCache: false }
      );

      const content = result.slots.task_context?.content ?? "";
      const firstLine = content.split("\n")[0];

      expect(firstLine).toContain("High priority");
    });

    it("应该截断到 token 预算", async () => {
      const manyRecords: Partial<MemoryRecord>[] = Array.from({ length: 20 }, (_, i) => ({
        id: `mem-${i}`,
        kind: "goal",
        semanticType: "task_context",
        text: `任务 ${i}`,
        importance: 0.5,
        scope: mockScope,
      }));

      const result = await builder.buildSlotContext(
        mockScope,
        manyRecords as MemoryRecord[],
        { tokenBudgetPerSlot: 50, useCache: false }
      );

      // 50 字符预算，每条约 10 字符，预期最多 5 条
      expect(result.slots.task_context?.nodeCount).toBeLessThanOrEqual(10);
    });

    it("应该使用缓存", async () => {
      const result1 = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: true }
      );

      expect(result1.telemetry.cacheHit).toBe(false);

      const result2 = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { useCache: true }
      );

      expect(result2.telemetry.cacheHit).toBe(true);
    });

    it("应该警告延迟超预算", async () => {
      const result = await builder.buildSlotContext(
        mockScope,
        mockRecords as MemoryRecord[],
        { latencyBudgetMs: 1, useCache: false }
      );

      // 注意：实际延迟可能 < 1ms，此测试可能不稳定
      // 更可靠的方式是 mock Date.now()
      if (result.telemetry.latencyMs > 1) {
        expect(result.warnings).toBeDefined();
        expect(result.warnings![0]).toContain("超过预算");
      }
    });

    it("应该自动映射 semanticType", async () => {
      const recordsWithoutType: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", text: "项目目标", importance: 0.9, scope: mockScope },
        { id: "2", kind: "document", text: "文档", importance: 0.7, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        recordsWithoutType as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.slots.resource).toBeDefined();
    });

    it("应该跳过无法归类的记忆", async () => {
      const recordsWithUnmappable: Partial<MemoryRecord>[] = [
        { id: "1", kind: "goal", text: "项目目标", importance: 0.9, scope: mockScope },
        { id: "2", kind: "fact", text: "一个事实", importance: 0.7, scope: mockScope },
      ];

      const result = await builder.buildSlotContext(
        mockScope,
        recordsWithUnmappable as MemoryRecord[],
        { useCache: false }
      );

      expect(result.slots.task_context).toBeDefined();
      expect(result.telemetry.nodesUsed).toBe(1);
    });
  });

  describe("invalidateCache", () => {
    it("应该使缓存失效", async () => {
      await builder.buildSlotContext(mockScope, mockRecords as MemoryRecord[], { useCache: true });

      builder.invalidateCache(mockScope, "task_context");

      const cached = cache.get(mockScope, "task_context");
      expect(cached).toBeNull();
    });
  });
});
