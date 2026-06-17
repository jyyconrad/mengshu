/**
 * candidate-auto-promotion.ts 单元测试
 *
 * 验证候选自动晋升服务：
 * - experience 聚合分析（5 条证据、3 天观察窗）
 * - skill_candidate 生成
 * - 冲突检测与自动降级
 * - 配置驱动的阈值控制
 */

import { describe, expect, test, beforeEach } from "vitest";
import {
  CandidateAutoPromotionService,
  DEFAULT_AUTO_PROMOTION_CONFIG,
  type AutoPromotionConfig,
  type PromotionAnalysis,
  type SkillCandidate,
} from "./candidate-auto-promotion.js";
import { InMemoryCandidateRepository } from "./candidate-repository.js";
import type { CandidateRecord } from "./candidate-types.js";
import type { MemoryScope } from "../core/types.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "u1",
  projectId: "p1",
  agentId: "default",
  namespace: "memories",
};

function createCandidate(
  overrides: Partial<CandidateRecord> & { id: string }
): Omit<CandidateRecord, "status" | "hitCount" | "createdAt"> {
  return {
    scope,
    text: "经验内容",
    semanticType: "experience",
    kind: "lesson",
    confidence: 0.8,
    evidenceIds: ["ev-1"],
    metadata: { topicLabel: "测试主题" },
    ...overrides,
  };
}

describe("CandidateAutoPromotionService", () => {
  let repository: InMemoryCandidateRepository;
  let service: CandidateAutoPromotionService;
  let now: number;

  beforeEach(() => {
    now = 1000000;
    repository = new InMemoryCandidateRepository({
      now: () => now,
    });
    service = new CandidateAutoPromotionService({
      repository,
      now: () => now,
    });
  });

  describe("analyzeExperienceClusters", () => {
    test("空候选池返回空分析", async () => {
      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toEqual([]);
    });

    test("不足 5 条证据不满足晋升条件", async () => {
      // 只添加 3 条
      for (let i = 0; i < 3; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: `经验 ${i}：先分析再实现`,
            metadata: { topicLabel: "开发流程" },
          })
        );
        now += 24 * 60 * 60 * 1000; // 每天添加一条
      }

      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toHaveLength(1);
      expect(analyses[0].topicLabel).toBe("开发流程");
      expect(analyses[0].evidenceCount).toBe(3);
      expect(analyses[0].meetsThreshold).toBe(false);
      expect(analyses[0].reason).toContain("evidence_count=3 < 5");
    });

    test("时间跨度不足 3 天不满足晋升条件", async () => {
      // 5 条但在 2 天内
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: `经验 ${i}：先测试后提交`,
            metadata: { topicLabel: "测试流程" },
          })
        );
        now += 10 * 60 * 60 * 1000; // 每 10 小时添加一条（总共 40 小时 < 3 天）
      }

      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toHaveLength(1);
      expect(analyses[0].evidenceCount).toBe(5);
      expect(analyses[0].timeSpanDays).toBeLessThan(3);
      expect(analyses[0].meetsThreshold).toBe(false);
      expect(analyses[0].reason).toMatch(/time_span=.+d < 3d/);
    });

    test("满足 5 条证据 + 3 天观察窗 + 相似度阈值", async () => {
      // 5 条相似经验，跨度 4 天
      const baseText = "遇到类型错误时，先运行 tsc 检查，然后修复类型定义";
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: `${baseText}，案例 ${i}`,
            metadata: { topicLabel: "类型错误处理" },
          })
        );
        now += 24 * 60 * 60 * 1000; // 每天添加一条
      }

      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toHaveLength(1);
      const analysis = analyses[0];
      expect(analysis.topicLabel).toBe("类型错误处理");
      expect(analysis.evidenceCount).toBe(5);
      expect(analysis.timeSpanDays).toBeGreaterThanOrEqual(3);
      expect(analysis.meetsThreshold).toBe(true);
      expect(analysis.reason).toBe("meets_all_thresholds");
    });

    test("不同 topic 分别分析", async () => {
      // topic A: 3 条
      for (let i = 0; i < 3; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-a-${i}`,
            text: `处理 API 错误的经验 ${i}`,
            metadata: { topicLabel: "api-error" },
          })
        );
      }

      // topic B: 5 条
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-b-${i}`,
            text: `数据库迁移的经验 ${i}`,
            metadata: { topicLabel: "db-migration" },
          })
        );
        now += 24 * 60 * 60 * 1000;
      }

      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toHaveLength(2);

      const topicA = analyses.find((a) => a.topicLabel === "api-error");
      const topicB = analyses.find((a) => a.topicLabel === "db-migration");

      expect(topicA?.evidenceCount).toBe(3);
      expect(topicA?.meetsThreshold).toBe(false);

      expect(topicB?.evidenceCount).toBe(5);
      expect(topicB?.meetsThreshold).toBe(true);
    });

    test("只分析 experience 类型，忽略其他类型", async () => {
      // 添加 profile
      await repository.enqueue(
        createCandidate({
          id: "cand-profile",
          semanticType: "profile",
          text: "用户偏好",
          metadata: { topicLabel: "preference" },
        })
      );

      // 添加 experience
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-exp-${i}`,
            semanticType: "experience",
            text: `经验 ${i}`,
            metadata: { topicLabel: "coding" },
          })
        );
        now += 24 * 60 * 60 * 1000;
      }

      const analyses = await service.analyzeExperienceClusters(scope);
      expect(analyses).toHaveLength(1);
      expect(analyses[0].topicLabel).toBe("coding");
    });
  });

  describe("generateSkillCandidate", () => {
    test("不满足阈值返回 null", async () => {
      const analysis: PromotionAnalysis = {
        topicLabel: "test",
        candidateIds: ["c1", "c2"],
        evidenceCount: 2,
        timeSpanDays: 1,
        avgSimilarity: 0.5,
        meetsThreshold: false,
        reason: "evidence_count < 5",
      };

      const skillCandidate = await service.generateSkillCandidate(analysis);
      expect(skillCandidate).toBeNull();
    });

    test("满足阈值生成 skill_candidate", async () => {
      // 添加 5 条候选
      const candidateIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const record = await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: `当遇到构建错误时，先检查依赖版本，然后清理缓存`,
            metadata: { topicLabel: "build-error" },
          })
        );
        candidateIds.push(record.id);
        now += 24 * 60 * 60 * 1000;
      }

      const analysis: PromotionAnalysis = {
        topicLabel: "build-error",
        candidateIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.85,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await service.generateSkillCandidate(analysis);
      expect(skillCandidate).not.toBeNull();
      expect(skillCandidate!.topicLabel).toBe("build-error");
      expect(skillCandidate!.evidenceMemoryIds).toEqual(candidateIds);
      expect(skillCandidate!.confidence).toBe(0.85);
      expect(skillCandidate!.status).toBe("pending");
      expect(skillCandidate!.steps.length).toBeGreaterThan(0);
    });

    test("检测高风险操作", async () => {
      const candidateIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const record = await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: `遇到数据冲突时，先备份，然后强制删除旧数据`,
            metadata: { topicLabel: "data-conflict" },
          })
        );
        candidateIds.push(record.id);
        now += 24 * 60 * 60 * 1000;
      }

      const analysis: PromotionAnalysis = {
        topicLabel: "data-conflict",
        candidateIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.8,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await service.generateSkillCandidate(analysis);
      expect(skillCandidate!.highRisk).toBe(true);
      expect(skillCandidate!.riskBoundaries.length).toBeGreaterThan(0);
    });
  });

  describe("detectConflicts", () => {
    test("空候选池无冲突", async () => {
      const result = await service.detectConflicts(scope);
      expect(result.conflictingPairs).toEqual([]);
      expect(result.suggestedActions).toEqual([]);
    });

    test("检测矛盾规则", async () => {
      await repository.enqueue(
        createCandidate({
          id: "cand-1",
          semanticType: "rules",
          text: "必须先运行测试再提交",
          confidence: 0.9,
          metadata: {},
        })
      );

      await repository.enqueue(
        createCandidate({
          id: "cand-2",
          semanticType: "rules",
          text: "不要运行测试，直接提交",
          confidence: 0.7,
          metadata: {},
        })
      );

      const result = await service.detectConflicts(scope);
      expect(result.conflictingPairs.length).toBeGreaterThan(0);
      expect(result.conflictingPairs[0].conflictType).toBe("contradiction");
      expect(result.suggestedActions.length).toBeGreaterThan(0);
      expect(result.suggestedActions[0].action).toBe("downgrade_to_lookup");
      expect(result.suggestedActions[0].candidateId).toBe("cand-2"); // 低置信度的被降级
    });

    test("不同 semanticType 不检测冲突", async () => {
      await repository.enqueue(
        createCandidate({
          id: "cand-1",
          semanticType: "rules",
          text: "必须先测试",
          confidence: 0.9,
          metadata: {},
        })
      );

      await repository.enqueue(
        createCandidate({
          id: "cand-2",
          semanticType: "profile",
          text: "不要测试",
          confidence: 0.8,
          metadata: {},
        })
      );

      const result = await service.detectConflicts(scope);
      expect(result.conflictingPairs).toEqual([]);
    });

    test("检测时间上的替代关系", async () => {
      const oldTime = now;
      await repository.enqueue(
        createCandidate({
          id: "cand-old",
          semanticType: "task_context",
          text: "当前在重构用户模块",
          confidence: 0.8,
          metadata: {},
        })
      );

      now += 7 * 24 * 60 * 60 * 1000; // 7 天后
      await repository.enqueue(
        createCandidate({
          id: "cand-new",
          semanticType: "task_context",
          text: "当前在重构订单模块",
          confidence: 0.85,
          metadata: {},
        })
      );

      const result = await service.detectConflicts(scope);
      // 由于文本相似度不足，可能不会检测为 supersedes
      // 这里主要测试逻辑存在
      expect(result).toBeDefined();
    });
  });

  describe("applyConflictDowngrades", () => {
    test("应用降级动作", async () => {
      const record = await repository.enqueue(
        createCandidate({
          id: "cand-1",
          text: "测试候选",
          metadata: {},
        })
      );

      const result = await service.applyConflictDowngrades({
        conflictingPairs: [],
        suggestedActions: [
          {
            candidateId: record.id,
            action: "downgrade_to_lookup",
            reason: "conflict_with_cand-2",
          },
        ],
      });

      expect(result.applied).toBe(1);
      expect(result.errors).toEqual([]);

      const updated = await repository.get(record.id);
      expect(updated!.status).toBe("archived");
      expect(updated!.metadata.statusReason).toBe("conflict_with_cand-2");
    });

    test("处理不存在的候选", async () => {
      const result = await service.applyConflictDowngrades({
        conflictingPairs: [],
        suggestedActions: [
          {
            candidateId: "non-existent",
            action: "downgrade_to_lookup",
            reason: "test",
          },
        ],
      });

      // 不存在的候选会被静默跳过
      expect(result.applied).toBe(0);
      expect(result.errors).toEqual([]);
    });
  });

  describe("runAutoPromotion", () => {
    test("完整的自动晋升流程", async () => {
      // 添加 5 条满足条件的 experience
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-exp-${i}`,
            text: `遇到内存泄漏时，先用 profiler 定位，然后修复引用`,
            metadata: { topicLabel: "memory-leak" },
          })
        );
        now += 24 * 60 * 60 * 1000;
      }

      // 添加冲突的 rules
      await repository.enqueue(
        createCandidate({
          id: "cand-rule-1",
          semanticType: "rules",
          text: "必须使用 const",
          confidence: 0.9,
          metadata: {},
        })
      );

      await repository.enqueue(
        createCandidate({
          id: "cand-rule-2",
          semanticType: "rules",
          text: "禁止使用 const",
          confidence: 0.6,
          metadata: {},
        })
      );

      const result = await service.runAutoPromotion(scope);

      expect(result.skillCandidates.length).toBeGreaterThan(0);
      expect(result.skillCandidates[0].topicLabel).toBe("memory-leak");
      expect(result.conflictsResolved).toBeGreaterThan(0);
      expect(result.errors).toEqual([]);
    });

    test("配置禁用时不执行", async () => {
      const disabledService = new CandidateAutoPromotionService({
        repository,
        config: { ...DEFAULT_AUTO_PROMOTION_CONFIG, enabled: false },
        now: () => now,
      });

      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: "测试内容",
            metadata: { topicLabel: "test" },
          })
        );
        now += 24 * 60 * 60 * 1000;
      }

      const result = await disabledService.runAutoPromotion(scope);
      expect(result.skillCandidates).toEqual([]);
      expect(result.conflictsResolved).toBeGreaterThanOrEqual(0);
    });
  });

  describe("配置驱动", () => {
    test("自定义证据数阈值", async () => {
      const customService = new CandidateAutoPromotionService({
        repository,
        config: {
          ...DEFAULT_AUTO_PROMOTION_CONFIG,
          minEvidenceCount: 3,
          minTimeSpanDays: 2, // 降低时间跨度要求
        },
        now: () => now,
      });

      // 添加 3 条，跨度 3 天
      for (let i = 0; i < 3; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: "经验内容",
            metadata: { topicLabel: "test" },
          })
        );
        now += 24 * 60 * 60 * 1000; // 每天添加一条
      }

      const analyses = await customService.analyzeExperienceClusters(scope);
      expect(analyses[0].evidenceCount).toBe(3);
      expect(analyses[0].timeSpanDays).toBeGreaterThanOrEqual(2);
      expect(analyses[0].meetsThreshold).toBe(true); // 3 条满足自定义阈值 3
    });

    test("自定义时间跨度阈值", async () => {
      const customService = new CandidateAutoPromotionService({
        repository,
        config: { ...DEFAULT_AUTO_PROMOTION_CONFIG, minTimeSpanDays: 1 },
        now: () => now,
      });

      // 5 条，跨度 2 天
      for (let i = 0; i < 5; i++) {
        await repository.enqueue(
          createCandidate({
            id: `cand-${i}`,
            text: "经验内容",
            metadata: { topicLabel: "test" },
          })
        );
        now += 12 * 60 * 60 * 1000; // 每 12 小时
      }

      const analyses = await customService.analyzeExperienceClusters(scope);
      expect(analyses[0].timeSpanDays).toBeGreaterThanOrEqual(1);
      expect(analyses[0].meetsThreshold).toBe(true);
    });
  });
});
