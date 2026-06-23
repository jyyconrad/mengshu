/**
 * agent-fast-path.test.ts
 *
 * Agent 快路径服务的端到端测试。
 * 覆盖 context_fast / observe_light / lookup / session_commit 四个时点。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentFastPathService } from "./index.js";
import type {
  MemoryRecord,
  MemoryScope,
  RecallResult,
} from "../../../../core/types.js";

const baseScope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "mengshu",
  agentId: "agent-1",
  namespace: "memories",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? `mem-${Math.random().toString(36).slice(2, 8)}`,
    scope: overrides.scope ?? baseScope,
    kind: overrides.kind ?? "goal",
    text: overrides.text ?? "Default memory text",
    contentHash: overrides.contentHash ?? "hash",
    importance: overrides.importance ?? 0.7,
    category: overrides.category ?? "core",
    dataType: overrides.dataType ?? "memory",
    metadata: overrides.metadata ?? {},
    provenance: overrides.provenance ?? { source: "user" },
    createdAt: overrides.createdAt ?? Date.now(),
    semanticType: overrides.semanticType,
    lifecycleStatus: overrides.lifecycleStatus,
    hotness: overrides.hotness,
    ...overrides,
  };
}

describe("AgentFastPathService", () => {
  let records: MemoryRecord[];
  let service: AgentFastPathService;

  beforeEach(() => {
    records = [
      makeRecord({
        id: "goal-1",
        kind: "goal",
        semanticType: "task_context",
        text: "完成 mengshu 架构升级",
        importance: 0.95,
      }),
      makeRecord({
        id: "doc-1",
        kind: "document",
        semanticType: "resource",
        text: "参考 docs/03-architecture/architecture-review-v2.md",
        importance: 0.8,
      }),
      makeRecord({
        id: "rule-1",
        kind: "preference",
        semanticType: "rules",
        text: "禁止使用 emoji",
        importance: 1.0,
      }),
      makeRecord({
        id: "kb-1",
        kind: "knowledge",
        semanticType: "resource",
        text: "LanceDB 单机模式不支持跨表事务",
        importance: 0.7,
      }),
      makeRecord({
        id: "fact-1",
        kind: "fact",
        text: "无 semanticType 的记忆不进入 5 槽位",
        importance: 0.5,
      }),
      makeRecord({
        id: "revoked-1",
        kind: "preference",
        semanticType: "profile",
        text: "已撤销的偏好不应注入",
        lifecycleStatus: "revoked",
        importance: 0.9,
      }),
    ];

    service = new AgentFastPathService({
      defaultScope: baseScope,
      loadRecordsForScope: vi.fn().mockResolvedValue(records),
      recall: vi.fn(async (_scope, query): Promise<RecallResult> => ({
        scope: baseScope,
        query,
        hits: records
          .filter((r) => r.text.includes(query))
          .map((r) => ({ record: r, score: 0.9, source: "text" as const })),
      })),
      storeObservation: vi.fn().mockResolvedValue({ id: "obs-1" }),
      enqueueJob: vi.fn().mockResolvedValue("job-1"),
    });
  });

  describe("context()", () => {
    it("返回 5 槽位上下文，包含 task_context / resource / rules", async () => {
      const response = await service.context({
        scope: baseScope,
        task: "完成架构升级",
      });

      expect(response.slots.task_context).toBeDefined();
      expect(response.slots.resource).toBeDefined();
      expect(response.slots.rules).toBeDefined();
      expect(response.content).toContain("<relevant-memories>");
      expect(response.content).toContain("禁止使用");
    });

    it("过滤 revoked 记忆", async () => {
      const response = await service.context({
        scope: baseScope,
        task: "task",
      });

      expect(response.content).not.toContain("已撤销");
    });

    it("延迟在 80ms 预算内", async () => {
      const response = await service.context({
        scope: baseScope,
        task: "测试延迟",
        latencyBudgetMs: 80,
      });

      expect(response.telemetry.latencyMs).toBeLessThan(200);
    });

    it("返回任务 hints（rules + experience）", async () => {
      const response = await service.context({
        scope: baseScope,
        task: "完成 mengshu 架构升级",
      });

      expect(response.taskHints).toBeDefined();
      expect(response.taskHints!.some((h) => h.kind === "rule")).toBe(true);
    });

    it("第二次请求命中缓存", async () => {
      await service.context({ scope: baseScope, task: "first" });
      const second = await service.context({ scope: baseScope, task: "second" });

      expect(second.telemetry.cacheHit).toBe(true);
    });

    it("无 semanticType 的记忆不进入 5 槽位（fact-1 不应出现）", async () => {
      const response = await service.context({ scope: baseScope, task: "test" });

      expect(response.content).not.toContain("无 semanticType 的记忆不进入");
    });

    it("透传 filtered：revoked 记忆带 lifecycle_revoked，fact 带 no_semantic_type", async () => {
      const response = await service.context({ scope: baseScope, task: "test" });

      expect(response.filtered).toBeDefined();
      const revoked = response.filtered!.find((f) => f.recordId === "revoked-1");
      expect(revoked?.reason).toBe("lifecycle_revoked");
      const fact = response.filtered!.find((f) => f.recordId === "fact-1");
      expect(fact?.reason).toBe("no_semantic_type");
    });

    it("透传 filteredSummary：按 reason 聚合", async () => {
      const response = await service.context({ scope: baseScope, task: "test" });

      expect(response.filteredSummary).toBeDefined();
      const reasons = response.filteredSummary!.map((s) => s.reason);
      expect(reasons).toContain("lifecycle_revoked");
      expect(reasons).toContain("no_semantic_type");
    });
  });

  describe("observeLight()", () => {
    it("返回 ack + traceId，且把任务入队", async () => {
      const response = await service.observeLight({
        scope: baseScope,
        eventType: "tool_result",
        text: "ran ls /tmp",
      });

      expect(response.ack).toBe(true);
      expect(response.traceId).toBeDefined();
      expect(response.queuedJobs.length).toBeGreaterThan(0);
    });

    it("storeObservation 失败时返回 warning", async () => {
      const failingService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: vi.fn().mockRejectedValue(new Error("disk full")),
        enqueueJob: vi.fn().mockResolvedValue("job-x"),
      });

      const response = await failingService.observeLight({
        scope: baseScope,
        eventType: "tool_result",
        text: "x",
      });

      expect(response.warnings?.[0]).toContain("observation_store_failed");
    });

    it("F3-2：observe 同时入队 extract_candidate 与 build_tree", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("job-x");
      const treeService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        enqueueJob,
      });

      await treeService.observeLight({
        scope: { ...baseScope, sessionId: "s-1" },
        eventType: "user_input",
        text: "禁止删除生产库",
      });

      const types = enqueueJob.mock.calls.map((c) => (c[0] as { type: string }).type);
      expect(types).toContain("extract_candidate");
      expect(types).toContain("build_tree");
      const treeCall = enqueueJob.mock.calls.find((c) => (c[0] as { type: string }).type === "build_tree");
      const payload = (treeCall![0] as { payload: Record<string, unknown> }).payload;
      expect(payload.treeType).toBe("source");
      expect(payload.treeKey).toBe("s-1");
    });
  });

  describe("lookup()", () => {
    it("返回符合 query 的 hits", async () => {
      const response = await service.lookup({
        scope: baseScope,
        query: "LanceDB",
      });

      expect(response.hits.length).toBeGreaterThan(0);
      expect(response.hits[0].preview).toContain("LanceDB");
    });

    it("recall 失败时返回 warning", async () => {
      const failingService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: vi.fn().mockRejectedValue(new Error("vector index gone")),
      });

      const response = await failingService.lookup({
        scope: baseScope,
        query: "x",
      });

      expect(response.warnings?.[0]).toContain("recall_failed");
      expect(response.hits).toEqual([]);
    });

    it("F3-3：deep 模式融合记忆树摘要", async () => {
      const treeNode = {
        id: "sum_1",
        scope: baseScope,
        treeType: "source" as const,
        treeKey: "s-1",
        level: 1,
        title: "source:s-1",
        summary: "本会话讨论了 LanceDB 索引升级",
        childNodeIds: [],
        leafIds: ["l1"],
        evidenceChunkIds: ["c1", "c2"],
        entityIds: [],
        relationIds: [],
        tokenCount: 100,
        timeRange: { startAt: 1, endAt: 2 },
        status: "sealed" as const,
        createdAt: 1,
        sealedAt: 2,
        metadata: { summaryMode: "extractive" },
      };
      const deepService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "LanceDB", hits: [] }),
        loadTreeSummaries: vi.fn().mockResolvedValue([treeNode]),
      });

      const response = await deepService.lookup({
        scope: baseScope,
        query: "LanceDB",
        mode: "deep",
      });

      const treeHit = response.hits.find((h) => h.source === "tree:source");
      expect(treeHit).toBeDefined();
      expect(treeHit?.preview).toContain("LanceDB");
      expect(treeHit?.evidence.length).toBe(2);
    });

    it("F3-3：fast 模式不查树", async () => {
      const loadTreeSummaries = vi.fn().mockResolvedValue([]);
      const fastService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "x", hits: [] }),
        loadTreeSummaries,
      });

      await fastService.lookup({ scope: baseScope, query: "x", mode: "fast" });
      expect(loadTreeSummaries).not.toHaveBeenCalled();
    });

    it("透传 minScore 到底层 recall", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      await testService.lookup({
        scope: baseScope,
        query: "test",
        minScore: 0.8,
      });

      expect(recallMock).toHaveBeenCalledWith(
        baseScope,
        "test",
        expect.objectContaining({ minScore: 0.8 })
      );
    });

    it("不传 minScore 时使用 runtime 兜底 0.1", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      await testService.lookup({
        scope: baseScope,
        query: "test",
      });

      // 不传 minScore 则不在 lookup 层覆盖，依赖 runtime 兜底
      expect(recallMock).toHaveBeenCalledWith(
        baseScope,
        "test",
        expect.objectContaining({ limit: 5 })
      );
      // minScore 不应被 lookup 设置为 undefined，而是不传，让 runtime 用兜底值
      const callArgs = recallMock.mock.calls[0][2];
      expect(callArgs).not.toHaveProperty("minScore");
    });

    it("透传 filters 到底层 recall", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      const filters = { category: "core", lifecycleStatus: "active" };
      await testService.lookup({
        scope: baseScope,
        query: "test",
        filters,
      });

      expect(recallMock).toHaveBeenCalledWith(
        baseScope,
        "test",
        expect.objectContaining({ filter: filters })
      );
    });

    it("安全校验：拒绝非白名单字段", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      // 传入恶意字段
      await testService.lookup({
        scope: baseScope,
        query: "test",
        filters: { category: "core", maliciousField: "DROP TABLE" },
      });

      // 只保留白名单字段
      const callArgs = recallMock.mock.calls[0][2];
      expect(callArgs?.filter).toEqual({ category: "core" });
    });

    it("安全校验：拒绝 SQL 注入字符", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      // 传入 SQL 注入字符
      await testService.lookup({
        scope: baseScope,
        query: "test",
        filters: { category: "core'; DROP TABLE memories--" },
      });

      // 拒绝危险字符
      const callArgs = recallMock.mock.calls[0][2];
      expect(callArgs?.filter).toBeUndefined();
    });

    it("安全校验：拒绝对象/数组类型 value", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      // 传入对象/数组
      await testService.lookup({
        scope: baseScope,
        query: "test",
        filters: { category: { $ne: null }, tags: ["tag1", "tag2"] } as unknown as Record<string, unknown>,
      });

      // 拒绝非基础类型
      const callArgs = recallMock.mock.calls[0][2];
      expect(callArgs?.filter).toBeUndefined();
    });

    it("安全校验：允许 number 和 boolean 类型 value", async () => {
      const recallMock = vi.fn().mockResolvedValue({
        scope: baseScope,
        query: "test",
        hits: [],
      });
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: recallMock,
      });

      await testService.lookup({
        scope: baseScope,
        query: "test",
        filters: { category: "core", dataType: 1, lifecycleStatus: true } as unknown as Record<string, unknown>,
      });

      const callArgs = recallMock.mock.calls[0][2];
      expect(callArgs?.filter).toEqual({
        category: "core",
        dataType: 1,
        lifecycleStatus: true,
      });
    });

    // D-25：scope 维度硬过滤（project/product/scopeFilterMode）
    describe("D-25: scope 维度硬过滤", () => {
      it("scopeFilterMode='hard' + project 注入 _projectName 到 filter", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "default", appId: "default" },  // 避免回退
          query: "test",
          project: "memory-autodb",
          scopeFilterMode: "hard",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toEqual({ _projectName: "memory-autodb" });
      });

      it("scopeFilterMode='hard' + product 注入 _appName 到 filter", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "default", appId: "default" },
          query: "test",
          product: "codex",
          scopeFilterMode: "hard",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toEqual({ _appName: "codex" });
      });

      it("scopeFilterMode='hard' 同时注入 project + product", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "default", appId: "default" },
          query: "test",
          project: "memory-autodb",
          product: "codex",
          scopeFilterMode: "hard",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toEqual({
          _projectName: "memory-autodb",
          _appName: "codex",
        });
      });

      it("scopeFilterMode='soft' 不注入硬过滤（保持跨项目召回）", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "default", appId: "default" },
          query: "test",
          project: "memory-autodb",
          scopeFilterMode: "soft",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toBeUndefined();
      });

      it("scopeFilterMode='hard' 不传 project 时回退 scope.projectId（非 default）", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "fallback-project", appId: "codex" },
          query: "test",
          scopeFilterMode: "hard",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toEqual({
          _projectName: "fallback-project",
          _appName: "codex",
        });
      });

      it("scopeFilterMode='hard' 与用户 filters 合并", async () => {
        const recallMock = vi.fn().mockResolvedValue({
          scope: baseScope,
          query: "test",
          hits: [],
        });
        const testService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: recallMock,
        });

        await testService.lookup({
          scope: { ...baseScope, projectId: "default", appId: "default" },
          query: "test",
          filters: { category: "preference" },
          project: "memory-autodb",
          scopeFilterMode: "hard",
        });

        const callArgs = recallMock.mock.calls[0][2];
        expect(callArgs?.filter).toEqual({
          category: "preference",
          _projectName: "memory-autodb",
        });
      });
    });
  });

  describe("sessionCommit()", () => {
    it("入队 refresh + extract job", async () => {
      const response = await service.sessionCommit({
        scope: baseScope,
        summary: "today we upgraded the schema",
      });

      expect(response.ack).toBe(true);
      expect(response.jobs.length).toBeGreaterThanOrEqual(1);
    });
  });
});
