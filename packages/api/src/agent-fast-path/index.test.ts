/**
 * agent-fast-path.test.ts
 *
 * Agent 快路径服务的端到端测试。
 * 覆盖 context_fast / observe_light / lookup / session_commit 四个时点。
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { AgentFastPathService } from "./index.js";
import { DATABASE_STORE_CLEANUP_WARNING } from "../../../core/src/db/types.js";
import type {
  MemoryRecord,
  MemoryScope,
  RecallResult,
} from "../../../../core/types.js";
import { computeRecallScoreBreakdown } from "../../../core/src/domain/recall-scoring.js";
import type {
  AgentLoadout,
  LoadoutAssetCandidate,
} from "../../../core/src/loadout/types.js";
import type { ContextAssemblyReceiptRepository } from
  "../../../core/src/context/assembly-receipt.js";

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
          .map((record) => {
            const scoreBreakdown = computeRecallScoreBreakdown(
              record,
              { relevance: 0.9, scopeFit: 1 },
              ["text"],
              { text: 0.9 },
            );
            return {
              record,
              score: scoreBreakdown.score,
              source: "text" as const,
              scoreBreakdown,
            };
          }),
      })),
      storeObservation: vi.fn().mockResolvedValue({ id: "obs-1", stored: true }),
      enqueueJob: vi.fn().mockResolvedValue("job-1"),
    });
  });

  describe("context()", () => {
    it("把当前 task 原样传给 production governed recall loader", async () => {
      const loadRecallHitsForScope = vi.fn(async () => []);
      const governedService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecallHitsForScope,
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
      });

      await governedService.context({
        scope: baseScope,
        task: "PostgreSQL 验证 Mengshu 运行态升级发布规则",
      });

      expect(loadRecallHitsForScope).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: baseScope.tenantId,
          userId: baseScope.userId,
        }),
        "PostgreSQL 验证 Mengshu 运行态升级发布规则",
      );
    });

    it("F3: Loadout native policy filters R0 types, applies slot budgets, and caps tree depth", async () => {
      const scope = { ...baseScope, visibility: "private" as const, sessionId: "policy-session" };
      const rule = { ...records.find((record) => record.id === "rule-1")!, scope,
        sourceNodeIds: ["evidence-policy"] };
      const experience = makeRecord({ id: "experience-policy", scope, semanticType: "experience",
        text: "experience must remain lookup-only under this Loadout", sourceNodeIds: ["evidence-exp"] });
      const hit = (record: MemoryRecord) => {
        const scoreBreakdown = computeRecallScoreBreakdown(
          record, { relevance: 1, scopeFit: 1 }, ["vector"], { vector: 1 },
        );
        return { record, score: scoreBreakdown.score, source: "vector" as const, scoreBreakdown };
      };
      const tree = (treeType: "source" | "topic") => ({
        id: `${treeType}-policy`, scope, treeType, treeKey: `${treeType}-key`,
        level: treeType === "source" ? 1 : 2, title: `${treeType} policy`, summary: "summary",
        childNodeIds: [], leafIds: [rule.id], evidenceChunkIds: ["evidence-policy"],
        entityIds: [], relationIds: [], tokenCount: 10,
        timeRange: { startAt: 1, endAt: 2 }, status: "sealed" as const,
        createdAt: 1, sealedAt: 2, metadata: { summaryMode: "extractive" },
      });
      const loadout: AgentLoadout = {
        id: "loadout-policy", scope, appId: scope.appId, agentId: scope.agentId,
        projectId: scope.projectId, version: 1, visibility: "private", slotBindings: [],
        nativeMemoryPolicy: {
          semanticTypes: ["rules"], scopeReuse: "project_only", treeDepth: "source",
          tokenBudgets: { profile: 100, task_context: 100, rules: 100,
            experience: 100, resource: 100 },
        },
        createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
      };
      const service = new AgentFastPathService({
        defaultScope: scope,
        loadRecallHitsForScope: async () => [hit(rule), hit(experience)],
        recall: async () => ({ scope, query: "", hits: [] }),
        resolveLoadout: async () => loadout,
        resolveLoadoutAssetCandidates: async () => [],
        loadTreeSummaries: async () => [tree("source"), tree("topic")],
        contextAssemblyReceipts: { append: async (_scope, receipt) => receipt, getLatest: vi.fn() },
      });

      const response = await service.context({ scope, task: "policy" });

      expect(response.slots.rules).toBeDefined();
      expect(response.slots.experience).toBeUndefined();
      expect(response.filtered).toContainEqual(expect.objectContaining({
        recordId: "experience-policy", reason: "loadout_policy_excluded",
      }));
      expect(response.assemblyPlan?.slots.rules?.tokenBudget).toBe(100);
      expect(response.assemblyPlan?.slots.rules?.navigation).toContainEqual(
        expect.objectContaining({ ref: "source-policy", kind: "source_tree", level: "R1" }),
      );
      expect(response.assemblyPlan?.slots.rules?.navigation).not.toContainEqual(
        expect.objectContaining({ ref: "topic-policy" }),
      );
    });

    it("F1: persists the final governed assembly receipt after actions and Loadout assembly", async () => {
      const scope = {
        ...baseScope,
        visibility: "private",
        sessionId: "session-receipt-1",
      } satisfies MemoryScope & { readonly visibility: "private" };
      const ruleRecord = {
        ...records.find((record) => record.id === "rule-1")!,
        scope,
        sourceNodeIds: ["evidence-receipt-1"],
      };
      const scoreBreakdown = computeRecallScoreBreakdown(
        ruleRecord,
        { relevance: 1, scopeFit: 1 },
        ["vector"],
        { vector: 1 },
      );
      const loadout: AgentLoadout = {
        id: "loadout-receipt", scope,
        appId: scope.appId, agentId: scope.agentId, projectId: scope.projectId,
        version: 3, visibility: "private",
        slotBindings: [{ assetId: "asset-receipt", slot: "rules", disclosureMode: "must_read",
          priority: 20, required: true }],
        nativeMemoryPolicy: {
          semanticTypes: ["rules"], scopeReuse: "project_only", treeDepth: "topic",
          tokenBudgets: { profile: 500, task_context: 500, rules: 500,
            experience: 500, resource: 500 },
        },
        createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
      };
      const append = vi.fn<ContextAssemblyReceiptRepository["append"]>(async (_scope, receipt) =>
        receipt);
      const governed = new AgentFastPathService({
        defaultScope: scope,
        loadRecallHitsForScope: async () => [{
          record: ruleRecord, score: scoreBreakdown.score,
          source: "vector", scoreBreakdown,
        }],
        recall: async () => ({ scope, query: "", hits: [] }),
        resolveLoadout: async () => loadout,
        resolveLoadoutAssetCandidates: async () => [{
          assetId: "asset-receipt", assetVersion: 7, assetKind: "memory_view",
          status: "published", contentValidity: "current", scope,
          semanticTypes: ["rules"], recordId: ruleRecord.id, content: "receipt rule",
          evidenceRefs: ["evidence-receipt-1"], lifecycleEligible: true,
          riskBlocked: false, conflictUnresolved: false, score: scoreBreakdown.score,
          scoreBreakdown, recallSource: "vector", tokenEstimate: 10,
        }],
        contextAssemblyReceipts: { append, getLatest: vi.fn() },
      });

      const response = await governed.context({ scope, task: "upgrade" });

      expect(append).toHaveBeenCalledOnce();
      const [persistedScope, receipt] = append.mock.calls[0]!;
      expect(persistedScope).toEqual(scope);
      expect(receipt.sessionId).toBe("session-receipt-1");
      expect(receipt.loadout).toEqual({ id: "loadout-receipt", version: 3 });
      expect(receipt.assetRefs).toContainEqual({ assetId: "asset-receipt", version: 7 });
      expect(receipt.evidenceRefs).toContain("evidence-receipt-1");
      expect(receipt.plan).toEqual(response.assemblyPlan);
      expect(response.actions?.length).toBeGreaterThan(0);
      expect(response.warnings ?? []).not.toContain("context_receipt_unavailable");
    });

    it.each(["missing", "failed"])(
      "F1: %s receipt capability preserves native context and returns a stable warning",
      async (mode) => {
        const scope: MemoryScope = {
          ...baseScope,
          visibility: "private",
          sessionId: `session-receipt-${mode}`,
        };
        const governed = new AgentFastPathService({
          defaultScope: scope,
          loadRecallHitsForScope: async () => [],
          recall: async () => ({ scope, query: "", hits: [] }),
          ...(mode === "failed"
            ? {
                contextAssemblyReceipts: {
                  append: vi.fn(async () => { throw new Error("schema unavailable"); }),
                  getLatest: vi.fn(),
                } satisfies ContextAssemblyReceiptRepository,
              }
            : {}),
        });

        const response = await governed.context({ scope, task: "upgrade" });

        expect(response.content).toContain("<relevant-memories>");
        expect(response.assemblyPlan?.sessionId).toBe(scope.sessionId);
        expect(response.warnings).toContain("context_receipt_unavailable");
      },
    );

    it("F3: optional Loadout assembly augments governed slots after native context", async () => {
      const ruleRecord = { ...records.find((record) => record.id === "rule-1")!,
        sourceNodeIds: ["evidence-real-1"] };
      const scoreBreakdown = computeRecallScoreBreakdown(
        ruleRecord,
        { relevance: 1, scopeFit: 1 },
        ["vector"],
        { vector: 1 },
      );
      const loadout: AgentLoadout = {
        id: "loadout-1", scope: { ...baseScope, visibility: "private" },
        appId: baseScope.appId, agentId: baseScope.agentId, projectId: baseScope.projectId,
        version: 1, visibility: "private",
        slotBindings: [{ assetId: "asset-1", slot: "rules", disclosureMode: "must_read",
          priority: 10, required: true }],
        nativeMemoryPolicy: {
          semanticTypes: ["profile", "task_context", "rules", "experience", "resource"],
          scopeReuse: "project_only", treeDepth: "topic",
          tokenBudgets: { profile: 500, task_context: 500, rules: 500, experience: 500, resource: 500 },
        },
        createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
      };
      const candidate: LoadoutAssetCandidate = {
        assetId: "asset-1", assetVersion: 1, assetKind: "memory_view", status: "published",
        contentValidity: "current", scope: { ...baseScope, visibility: "private" },
        semanticTypes: ["rules"], recordId: ruleRecord.id, content: "固定安全规则",
        evidenceRefs: ["evidence-real-1"], lifecycleEligible: true, riskBlocked: false,
        conflictUnresolved: false, score: scoreBreakdown.score, scoreBreakdown,
        recallSource: "vector", tokenEstimate: 20,
      };
      const governed = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecallHitsForScope: async () => [{ record: ruleRecord, score: scoreBreakdown.score,
          source: "vector", scoreBreakdown }],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        resolveLoadout: async () => loadout,
        resolveLoadoutAssetCandidates: async (_scope, resolved, hits) => {
          expect(resolved).toBe(loadout);
          expect(hits).toHaveLength(1);
          return [candidate];
        },
      });

      const response = await governed.context({ scope: baseScope, task: "upgrade" });

      expect(response.slots.rules?.sourceIds).toContain("asset:asset-1@1");
      expect(response.content).toContain("固定安全规则");
      expect(response.assemblyPlan?.versions.loadout).toBe(1);
    });

    it("F3: asset enhancement failure degrades to native slots when no binding is required", async () => {
      const governed = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecallHitsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        resolveLoadout: async () => ({
          id: "loadout-optional", scope: { ...baseScope, visibility: "private" },
          appId: baseScope.appId, agentId: baseScope.agentId, projectId: baseScope.projectId,
          version: 1, visibility: "private", slotBindings: [],
          nativeMemoryPolicy: {
            semanticTypes: [], scopeReuse: "project_only", treeDepth: "source",
            tokenBudgets: { profile: 0, task_context: 0, rules: 0, experience: 0, resource: 0 },
          },
          createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
        }),
        resolveLoadoutAssetCandidates: async () => { throw new Error("asset unavailable"); },
      });

      const response = await governed.context({ scope: baseScope, task: "upgrade" });
      expect(response.warnings).toContain("asset_enhancement_disabled: asset unavailable");
      expect(response.assemblyPlan?.versions.loadout).toBeUndefined();
    });

    it.each(["loadout lookup", "required binding"])(
      "F3: %s failure preserves native five-slot context",
      async (failure) => {
        const requiredLoadout: AgentLoadout = {
          id: "loadout-required", scope: { ...baseScope, visibility: "private" },
          appId: baseScope.appId, agentId: baseScope.agentId, projectId: baseScope.projectId,
          version: 1, visibility: "private",
          slotBindings: [{ assetId: "asset-revoked", slot: "rules", disclosureMode: "must_read",
            priority: 10, required: true }],
          nativeMemoryPolicy: {
            semanticTypes: ["rules"], scopeReuse: "project_only", treeDepth: "source",
            tokenBudgets: { profile: 500, task_context: 500, rules: 500,
              experience: 500, resource: 500 },
          },
          createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z",
        };
        const governed = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecallHitsForScope: async () => [],
          recall: async () => ({ scope: baseScope, query: "", hits: [] }),
          resolveLoadout: failure === "loadout lookup"
            ? async () => { throw new Error("loadout unavailable"); }
            : async () => requiredLoadout,
          resolveLoadoutAssetCandidates: async () => [],
        });

        const response = await governed.context({ scope: baseScope, task: "upgrade" });

        expect(response.content).toContain("<relevant-memories>");
        expect(response.assemblyPlan?.versions.loadout).toBeUndefined();
        expect(response.warnings?.some((warning) =>
          warning.startsWith("asset_enhancement_disabled:"))).toBe(true);
      },
    );

    it("F1: assembly plan and drill-down actions use real evidence refs instead of memory ids", async () => {
      const ruleRecord = records.find((record) => record.id === "rule-1")!;
      const scoreBreakdown = computeRecallScoreBreakdown(
        ruleRecord,
        { relevance: 0.9, scopeFit: 1 },
        ["text"],
        { text: 0.9 },
      );
      const governed = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecallHitsForScope: async () => [{
          record: { ...ruleRecord, sourceNodeIds: ["evidence-real-1"] },
          score: scoreBreakdown.score,
          source: "text",
          scoreBreakdown,
        }],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
      });

      const response = await governed.context({ scope: baseScope, task: "upgrade" });

      expect(response.slots.rules?.sourceIds).toEqual(["rule-1"]);
      expect(response.slots.rules?.evidenceRefs).toEqual(["evidence-real-1"]);
      expect(response.taskHints?.[0]?.evidenceIds).toEqual(["evidence-real-1"]);
      expect(response.assemblyPlan?.slots.rules?.mustRead[0]?.evidenceRefs)
        .toEqual(["evidence-real-1"]);
      expect(response.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "drill_down",
          input: expect.objectContaining({ ref: "evidence-real-1", level: "R4" }),
        }),
      ]));
    });

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

    it("taskHints 只来自最终槽位，revoked 与 session_candidate 不能旁路注入", async () => {
      const activeRule = makeRecord({
        id: "active-rule",
        semanticType: "rules",
        text: "最终槽位里的规则",
        lifecycleStatus: "active",
      });
      const revokedExperience = makeRecord({
        id: "revoked-experience",
        semanticType: "experience",
        text: "task revoked experience",
        lifecycleStatus: "revoked",
      });
      const candidateExperience = makeRecord({
        id: "candidate-experience",
        semanticType: "experience",
        text: "task candidate experience",
        container: "session_candidate",
      });
      const hits = [activeRule, revokedExperience, candidateExperience].map((record) => {
        const scoreBreakdown = computeRecallScoreBreakdown(
          record,
          { relevance: 1, scopeFit: 1 },
          ["vector"],
          { vector: 1 },
        );
        return { record, score: scoreBreakdown.score, source: "vector" as const, scoreBreakdown };
      });
      const governedService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecallHitsForScope: async () => hits,
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
      });

      const response = await governedService.context({ scope: baseScope, task: "task" });

      expect(response.taskHints).toEqual([
        expect.objectContaining({ kind: "rule", text: "最终槽位里的规则" }),
      ]);
      expect(JSON.stringify(response.taskHints)).not.toContain("revoked experience");
      expect(JSON.stringify(response.taskHints)).not.toContain("candidate experience");
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

    it("intent=ignore 返回明确 ignored ack，且不写入或入队", async () => {
      const storeObservation = vi.fn().mockResolvedValue({ id: "must-not-store", stored: true });
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const ignoreService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation,
        enqueueJob,
      });

      const response = await ignoreService.observeLight({
        scope: baseScope,
        eventType: "system_event",
        text: "ephemeral noise",
        intent: "ignore",
      });

      expect(response).toMatchObject({
        ack: true,
        ignored: true,
        queuedJobs: [],
      });
      expect(storeObservation).not.toHaveBeenCalled();
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it.each(["remember", "auto"] as const)("intent=%s 的原始 evidence 只入队 extract_candidate", async (intent) => {
      const storeObservation = vi.fn().mockResolvedValue({
        id: `obs-${intent}`,
        stored: true,
        recordType: "memory" as const,
        admissionRoute: "evidence_only" as const,
      });
      const enqueueJob = vi.fn().mockResolvedValue("job-x");
      const durableService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation,
        enqueueJob,
      });

      const response = await durableService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: `${intent} this`,
        intent,
      });

      expect(response.ignored).not.toBe(true);
      expect(response).toMatchObject({
        persistedId: `obs-${intent}`,
        stored: true,
        duplicate: false,
      });
      expect(storeObservation).toHaveBeenCalledTimes(1);
      expect(enqueueJob).toHaveBeenCalledTimes(1);
      const callsByType = Object.fromEntries(enqueueJob.mock.calls.map(([input]) => [input.type, input.payload]));
      expect(callsByType.extract_candidate).toMatchObject({ traceId: `obs-${intent}` });
      expect(callsByType).not.toHaveProperty("build_tree");
      expect(callsByType).not.toHaveProperty("extract_graph");
    });

    it.each(["candidate", "candidate_low_priority"] as const)(
      "%s 写入只返回治理记录，不触发派生任务",
      async (admissionRoute) => {
        const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
        const candidateService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: async () => ({ scope: baseScope, query: "", hits: [] }),
          storeObservation: async () => ({
            id: "candidate-1",
            stored: true,
            recordType: "candidate" as const,
            admissionRoute,
          }),
          enqueueJob,
        });

        await expect(candidateService.observeLight({
          scope: baseScope,
          eventType: "user_input",
          text: "该观察经过准入后仍处于候选状态",
          intent: "auto",
          idempotencyKey: "request-1",
        })).resolves.toMatchObject({
          ack: true,
          persistedId: "candidate-1",
          recordType: "candidate",
          admissionRoute,
          stored: true,
          duplicate: false,
          queuedJobs: [],
        });
        expect(enqueueJob).not.toHaveBeenCalled();
      },
    );

    it("lookup_only memory 不触发 candidate/tree/graph 派生任务", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const lookupOnlyService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "lookup-only-1",
          stored: true,
          recordType: "memory" as const,
          admissionRoute: "lookup_only" as const,
        }),
        enqueueJob,
      });

      await expect(lookupOnlyService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: "只允许按需查找的受控记忆",
        idempotencyKey: "lookup-only-request-1",
      })).resolves.toMatchObject({
        persistedId: "lookup-only-1",
        recordType: "memory",
        admissionRoute: "lookup_only",
        queuedJobs: [],
      });
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("drop 不是可持久化回执，严格拒绝且不触发派生任务", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const droppedService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "dropped-1",
          stored: false,
          recordType: "memory",
          admissionRoute: "drop",
        } as never),
        enqueueJob,
      });

      await expect(droppedService.observeLight({
        scope: baseScope,
        eventType: "system_event",
        text: "应由 admission drop 的噪声",
      })).resolves.toMatchObject({
        persistedId: undefined,
        queuedJobs: [],
        warnings: ["observation_store_outcome_invalid"],
      });
      expect(enqueueJob).not.toHaveBeenCalled();
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
      expect(response.queuedJobs).toEqual([]);
    });

    it("F0：active transport receipt 不自行构造 graph/tree，统一等待 committed-active 派生", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("job-x");
      const treeService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "persisted-tree-id",
          stored: true,
          recordType: "memory" as const,
          admissionRoute: "active" as const,
        }),
        enqueueJob,
      });

      await treeService.observeLight({
        scope: { ...baseScope, sessionId: "s-1" },
        eventType: "user_input",
        text: "禁止删除生产库",
      });

      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("100 persistent duplicates return explicit duplicate ack and enqueue no dangling side effects", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      let sequence = 0;
      const duplicateService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: `persisted-existing-${++sequence}`,
          stored: false,
        }),
        enqueueJob,
      });

      const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
        duplicateService.observeLight({
          scope: baseScope,
          eventType: "user_input",
          text: `duplicate-${index}`,
        })));

      expect(results).toHaveLength(100);
      results.forEach((result, index) => {
        expect(result).toMatchObject({
          ack: true,
          duplicate: true,
          stored: false,
          persistedId: `persisted-existing-${index + 1}`,
          queuedJobs: [],
        });
      });
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("continues all derived jobs for stored cleanup receipt and returns only the fixed warning", async () => {
      const enqueueJob = vi.fn(async ({ type }: { type: string }) => `${type}-job`);
      const cleanupService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "persisted-cleanup-id",
          stored: true,
          warnings: [DATABASE_STORE_CLEANUP_WARNING],
        }),
        enqueueJob,
      });

      await expect(cleanupService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: "stored despite cleanup failure",
      })).resolves.toMatchObject({
        persistedId: "persisted-cleanup-id",
        stored: true,
        duplicate: false,
        queuedJobs: ["extract_candidate-job"],
        warnings: [DATABASE_STORE_CLEANUP_WARNING],
      });
      expect(enqueueJob).toHaveBeenCalledTimes(1);
    });

    it("does not enqueue jobs for duplicate cleanup receipt and keeps the fixed warning", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const cleanupService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "persisted-existing-id",
          stored: false,
          warnings: [DATABASE_STORE_CLEANUP_WARNING],
        }),
        enqueueJob,
      });

      await expect(cleanupService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: "duplicate cleanup receipt",
      })).resolves.toMatchObject({
        persistedId: "persisted-existing-id",
        stored: false,
        duplicate: true,
        queuedJobs: [],
        warnings: [DATABASE_STORE_CLEANUP_WARNING],
      });
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("rejects forged cleanup warnings as an invalid store outcome", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const cleanupService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => ({
          id: "persisted-forged-id",
          stored: true,
          warnings: ["raw provider detail"] as never,
        }),
        enqueueJob,
      });

      const result = await cleanupService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: "forged cleanup warning",
      });
      expect(result.queuedJobs).toEqual([]);
      expect(result.warnings).toContain("observation_store_outcome_invalid");
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("100 concurrent new observations bind every candidate payload to the persisted evidence ID", async () => {
      const enqueueJob = vi.fn(async ({ type, payload }: { type: string; payload: Record<string, unknown> }) =>
        `${type}:${String(payload.traceId)}`);
      const concurrentService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async ({ text }) => ({ id: `persisted-${text}`, stored: true }),
        enqueueJob,
      });

      const results = await Promise.all(Array.from({ length: 100 }, (_, index) =>
        concurrentService.observeLight({
          scope: baseScope,
          eventType: "tool_result",
          text: `observation-${index}`,
        })));

      expect(results).toHaveLength(100);
      expect(enqueueJob).toHaveBeenCalledTimes(100);
      for (const [{ type, payload }] of enqueueJob.mock.calls) {
        expect(type).toBe("extract_candidate");
        const persistedId = String(payload.traceId);
        expect(persistedId).toMatch(/^persisted-observation-/);
      }
    });

    it("100 malformed or unavailable store outcomes never create dangling jobs", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const malformed = Array.from({ length: 100 }, (_, index) => {
        if (index % 4 === 0) return { id: "", stored: true };
        if (index % 4 === 1) return { id: ` bad-${index}`, stored: true };
        if (index % 4 === 2) return { id: `bad-${index}\n`, stored: true };
        return { id: `bad-${index}`, stored: "yes" };
      });
      let cursor = 0;
      const malformedService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => malformed[cursor++] as never,
        enqueueJob,
      });

      const results = [];
      for (let index = 0; index < malformed.length; index += 1) {
        results.push(await malformedService.observeLight({
          scope: baseScope,
          eventType: "system_event",
          text: `malformed-${index}`,
        }));
      }

      expect(results.every((result) => result.queuedJobs.length === 0)).toBe(true);
      expect(results.every((result) => result.warnings?.includes("observation_store_outcome_invalid"))).toBe(true);
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it("rejects proxy, getter and symbol-extended outcomes without reading attacker fields", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      let proxyDescriptorReads = 0;
      let getterReads = 0;
      const outcomes: unknown[] = [
        new Proxy({ id: "proxy-id", stored: true }, {
          getOwnPropertyDescriptor(target, key) {
            proxyDescriptorReads += 1;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }),
        Object.defineProperties({}, {
          id: { enumerable: true, get: () => { getterReads += 1; return "getter-id"; } },
          stored: { enumerable: true, value: true },
        }),
        Object.assign({ id: "symbol-id", stored: true }, { [Symbol("extra")]: true }),
      ];
      let cursor = 0;
      const strictService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        storeObservation: async () => outcomes[cursor++] as never,
        enqueueJob,
      });

      for (const text of ["proxy", "getter", "symbol"]) {
        const result = await strictService.observeLight({
          scope: baseScope,
          eventType: "system_event",
          text,
        });
        expect(result.queuedJobs).toEqual([]);
        expect(result.warnings).toContain("observation_store_outcome_invalid");
      }
      expect(proxyDescriptorReads).toBe(0);
      expect(getterReads).toBe(0);
      expect(enqueueJob).not.toHaveBeenCalled();
    });

    it.each([
      {
        admissionRoute: "evidence_only" as const,
        recordType: "memory" as const,
        expectedTypes: ["extract_candidate"],
      },
      {
        admissionRoute: "active" as const,
        recordType: "memory" as const,
        expectedTypes: [],
      },
      {
        admissionRoute: "lookup_only" as const,
        recordType: "memory" as const,
        expectedTypes: [],
      },
      {
        admissionRoute: "candidate" as const,
        recordType: "candidate" as const,
        expectedTypes: [],
      },
      {
        admissionRoute: "candidate_low_priority" as const,
        recordType: "candidate" as const,
        expectedTypes: [],
      },
    ])(
      "同幂等键 $admissionRoute replay/ensure 只保持路由对应 job 集合",
      async ({ admissionRoute, recordType, expectedTypes }) => {
        const enqueueJob = vi.fn().mockResolvedValue("generic-must-not-run");
        const ensureJob = vi.fn(async ({ type }: { type: string }) => `ensured-${type}`);
        const repairService = new AgentFastPathService({
          defaultScope: baseScope,
          loadRecordsForScope: async () => [],
          recall: async () => ({ scope: baseScope, query: "", hits: [] }),
          storeObservation: async ({ idempotencyKey }) => {
            expect(idempotencyKey).toBe("stable-replay-key");
            return {
              id: `persisted-${admissionRoute}`,
              stored: false,
              recordType,
              admissionRoute,
            };
          },
          enqueueJob,
          ensureJob,
        });

        await expect(repairService.observeLight({
          scope: baseScope,
          eventType: "user_input",
          text: "repair only route-owned jobs",
          idempotencyKey: "stable-replay-key",
        })).resolves.toMatchObject({
          persistedId: `persisted-${admissionRoute}`,
          admissionRoute,
          duplicate: true,
          queuedJobs: expectedTypes.map((type) => `ensured-${type}`),
        });
        expect(ensureJob.mock.calls.map(([input]) => input.type)).toEqual(expectedTypes);
        expect(enqueueJob).not.toHaveBeenCalled();
      },
    );

    it("missing storeObservation dependency does not enqueue jobs with an unpersisted traceId", async () => {
      const enqueueJob = vi.fn().mockResolvedValue("must-not-enqueue");
      const noStoreService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        enqueueJob,
      });

      const response = await noStoreService.observeLight({
        scope: baseScope,
        eventType: "user_input",
        text: "not persisted",
      });

      expect(response).toMatchObject({ queuedJobs: [] });
      expect(response.warnings).toContain("observation_store_unavailable");
      expect(enqueueJob).not.toHaveBeenCalled();
    });
  });

  describe("lookup()", () => {
    it("F1: lookup hydrates real evidence previews and advertises drill-down only when available", async () => {
      const record = { ...records[0]!, sourceNodeIds: ["evidence-real-1"] };
      const scoreBreakdown = computeRecallScoreBreakdown(
        record,
        { relevance: 0.9, scopeFit: 1 },
        ["text"],
        { text: 0.9 },
      );
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        recall: async () => ({
          scope: baseScope,
          query: "upgrade",
          hits: [{ record, score: scoreBreakdown.score, source: "text", scoreBreakdown }],
        }),
        readEvidence: async (_scope, refs) => refs.map((ref) => ({
          ref,
          preview: "original evidence",
          source: "memory",
        })),
      });

      const response = await testService.lookup({ scope: baseScope, query: "upgrade" });

      expect(response.hits[0]?.evidence).toEqual([
        { id: "evidence-real-1", preview: "original evidence" },
      ]);
      expect(response.hits[0]?.actions).toContain("drill_down");
    });

    it("F1: memory_navigate and evidence_read stay inside normalized authority scope", async () => {
      const navigate = vi.fn(async (_scope: MemoryScope) => [{
        ref: "evidence-real-1",
        kind: "evidence" as const,
        level: "R4" as const,
        title: "Evidence",
      }]);
      const readEvidence = vi.fn(async (_scope: MemoryScope) => [{
        ref: "evidence-real-1",
        preview: "original evidence",
        source: "memory" as const,
      }]);
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        navigate,
        readEvidence,
      });

      await expect(testService.navigate({
        scope: { appId: baseScope.appId, projectId: baseScope.projectId },
        ref: "goal-1",
        level: "R0",
      })).resolves.toMatchObject({ items: [{ ref: "evidence-real-1", level: "R4" }] });
      await expect(testService.evidenceRead({
        scope: { appId: baseScope.appId, projectId: baseScope.projectId },
        refs: ["evidence-real-1"],
      })).resolves.toMatchObject({ evidence: [{ ref: "evidence-real-1" }] });
      expect(navigate.mock.calls[0]?.[0]).toEqual(baseScope);
      expect(readEvidence.mock.calls[0]?.[0]).toEqual(baseScope);
    });

    it("返回符合 query 的 hits", async () => {
      const response = await service.lookup({
        scope: baseScope,
        query: "LanceDB",
      });

      expect(response.hits.length).toBeGreaterThan(0);
      expect(response.hits[0].preview).toContain("LanceDB");
    });

    it("缺少唯一六因子回执时 lookup fail-closed", async () => {
      const invalidService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({
          scope: baseScope,
          query: "invalid",
          hits: [{ record: records[0], score: 0.9, source: "vector" }],
        }),
      });

      await expect(invalidService.lookup({ scope: baseScope, query: "invalid" }))
        .rejects.toThrow("RECALL_SCORE_BREAKDOWN_REQUIRED");
    });

    it("原样透传 governed retrieval filteredReason", async () => {
      const filtered = [{
        candidateId: "tree:blocked",
        authoritativeRecordId: "memory-blocked",
        source: "tree" as const,
        filteredReason: "risk_blocked" as const,
      }];
      const lookupService = new AgentFastPathService({
        defaultScope: baseScope,
        loadRecordsForScope: async () => [],
        recall: async () => ({ scope: baseScope, query: "blocked", hits: [], filtered }),
      });

      const response = await lookupService.lookup({ scope: baseScope, query: "blocked" });

      expect(response.filtered).toBe(filtered);
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

    it("F0：裸 tree summary 缺少六因子回执时不进入 lookup，并明确降级", async () => {
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

      expect(response.hits.find((h) => h.source === "tree:source")).toBeUndefined();
      expect(response.warnings).toContain("tree_recall_breakdown_unavailable");
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
    it("同步失效 slot cache，并且只入队有 consumer 的 extract job", async () => {
      const invalidateCache = vi.fn();
      const enqueueJob = vi.fn().mockResolvedValue("job-extract");
      const testService = new AgentFastPathService({
        defaultScope: baseScope,
        recall: async () => ({ scope: baseScope, query: "", hits: [] }),
        enqueueJob,
        builder: {
          buildSlotContext: vi.fn(),
          buildSlotContextFromRecallHits: vi.fn(),
          invalidateCache,
        } as unknown as ConstructorParameters<typeof AgentFastPathService>[0]["builder"],
      });
      const response = await service.sessionCommit({
        scope: baseScope,
        summary: "today we upgraded the schema",
      });

      expect(response.ack).toBe(true);
      expect(response.jobs).toEqual(["job-1"]);

      const explicit = await testService.sessionCommit({
        scope: baseScope,
        summary: "today we upgraded the schema",
      });
      expect(explicit.jobs).toEqual(["job-extract"]);
      expect(invalidateCache).toHaveBeenCalledWith(baseScope);
      expect(enqueueJob).toHaveBeenCalledOnce();
      expect(enqueueJob.mock.calls[0]?.[0]).toMatchObject({ type: "extract_candidate" });
    });
  });
});
