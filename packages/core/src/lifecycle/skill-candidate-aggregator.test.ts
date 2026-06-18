/**
 * SkillCandidate 聚合器测试
 *
 * 测试 experience -> skill_candidate 聚合功能（§8）
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SkillCandidateAggregator } from "./skill-candidate-aggregator.js";
import { InMemorySkillCandidateRepository } from "./skill-candidate-repository.js";
import type { CandidateRepository, CandidateRecord } from "./candidate-types.js";
import type { MemoryScope } from "../domain/types.js";
import type { LlmClient } from "../runtime/llm/llm-client.js";

/**
 * Mock CandidateRepository
 */
class MockCandidateRepository implements CandidateRepository {
  private store: Map<string, CandidateRecord> = new Map();

  async enqueue(
    record: Omit<CandidateRecord, "id" | "status" | "hitCount" | "createdAt"> & {
      id?: string;
      status?: any;
      createdAt?: number;
    }
  ): Promise<CandidateRecord> {
    const id = record.id ?? `cand-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const candidate: CandidateRecord = {
      ...record,
      id,
      status: record.status ?? "pending",
      hitCount: 0,
      createdAt: record.createdAt ?? Date.now(),
    };
    this.store.set(id, candidate);
    return candidate;
  }

  async get(id: string): Promise<CandidateRecord | undefined> {
    return this.store.get(id);
  }

  async list(filter?: any): Promise<CandidateRecord[]> {
    let results = Array.from(this.store.values());

    if (filter) {
      if (filter.status) {
        results = results.filter((c) => c.status === filter.status);
      }
      if (filter.semanticType) {
        results = results.filter((c) => c.semanticType === filter.semanticType);
      }
    }

    return results;
  }

  async setStatus(id: string, status: any, metadata?: any): Promise<void> {
    const record = this.store.get(id);
    if (record) {
      record.status = status;
      if (metadata) {
        record.metadata = { ...record.metadata, ...metadata };
      }
    }
  }

  async touchHit(id: string, now?: number): Promise<void> {
    const record = this.store.get(id);
    if (record) {
      record.lastHitAt = now ?? Date.now();
      record.hitCount++;
    }
  }

  async count(filter?: any): Promise<number> {
    const list = await this.list(filter);
    return list.length;
  }

  async deleteByIds(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.store.delete(id)) {
        deleted++;
      }
    }
    return deleted;
  }

  clear() {
    this.store.clear();
  }
}

describe("SkillCandidateAggregator", () => {
  let aggregator: SkillCandidateAggregator;
  let candidateRepo: MockCandidateRepository;
  let skillRepo: InMemorySkillCandidateRepository;
  let mockScope: MemoryScope;
  let mockNow: number;

  beforeEach(() => {
    candidateRepo = new MockCandidateRepository();
    skillRepo = new InMemorySkillCandidateRepository();
    mockNow = Date.now();

    mockScope = {
      tenantId: "test-tenant",
      appId: "test-app",
      userId: "test-user",
      projectId: "test-project",
      agentId: "test-agent",
      namespace: "default",
    };

    aggregator = new SkillCandidateAggregator({
      candidateRepository: candidateRepo,
      skillCandidateRepository: skillRepo,
      now: () => mockNow,
    });
  });

  describe("analyzeExperienceClusters", () => {
    it("should return empty array when no experiences", async () => {
      const analyses = await aggregator.analyzeExperienceClusters(mockScope);
      expect(analyses).toEqual([]);
    });

    it("should group experiences by topic-label", async () => {
      // 添加同 topic 的多个 experience
      await candidateRepo.enqueue({
        scope: mockScope,
        text: "遇到数据库连接失败时，先检查网络，然后重启服务",
        semanticType: "experience",
        kind: "lesson",
        confidence: 0.8,
        evidenceIds: ["ev1"],
        metadata: { topicLabel: "database-connection", hasOutcome: true },
      });

      await candidateRepo.enqueue({
        scope: mockScope,
        text: "数据库连接问题：增加连接超时时间成功解决",
        semanticType: "experience",
        kind: "lesson",
        confidence: 0.85,
        evidenceIds: ["ev2"],
        metadata: { topicLabel: "database-connection", hasOutcome: true },
      });

      const analyses = await aggregator.analyzeExperienceClusters(mockScope);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].topicLabel).toBe("database-connection");
      expect(analyses[0].evidenceCount).toBe(2);
    });

    it("should check time span threshold", async () => {
      const baseTime = Date.now();

      // 添加时间跨度不足 3 天的 experiences
      for (let i = 0; i < 5; i++) {
        await candidateRepo.enqueue({
          scope: mockScope,
          text: `Experience ${i} about testing`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "testing", hasOutcome: true },
          createdAt: baseTime + i * 3600 * 1000, // 每小时一个
        });
      }

      const analyses = await aggregator.analyzeExperienceClusters(mockScope);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].meetsThreshold).toBe(false);
      expect(analyses[0].reason).toContain("time_span");
    });

    it("should validate evidence count threshold", async () => {
      // 只添加 3 个 experiences（低于阈值 5）
      for (let i = 0; i < 3; i++) {
        await candidateRepo.enqueue({
          scope: mockScope,
          text: `Experience ${i} about deployment`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "deployment", hasOutcome: true },
        });
      }

      const analyses = await aggregator.analyzeExperienceClusters(mockScope);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].meetsThreshold).toBe(false);
      expect(analyses[0].reason).toContain("evidence_count");
    });

    it("should validate success outcome threshold", async () => {
      const baseTime = Date.now();

      // 添加 5 个 experiences，但只有 1 个成功 outcome
      for (let i = 0; i < 5; i++) {
        const candidate = await candidateRepo.enqueue({
          scope: mockScope,
          text: `Experience ${i} about testing`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: {
            topicLabel: "testing",
            hasOutcome: i === 0, // 只有第一个有 outcome
          },
        });

        // 手动设置 createdAt 以确保时间跨度足够
        candidate.createdAt = baseTime + i * 86400000; // 每天一个
      }

      const analyses = await aggregator.analyzeExperienceClusters(mockScope);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].meetsThreshold).toBe(false);
      expect(analyses[0].reason).toContain("success_outcomes");
    });

    it("should pass all thresholds when criteria met", async () => {
      const baseTime = Date.now();

      // 添加满足所有条件的 experiences
      for (let i = 0; i < 5; i++) {
        const candidate = await candidateRepo.enqueue({
          scope: mockScope,
          text: `当遇到部署失败时，先检查配置文件，然后重新构建。最终成功部署。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "deployment", hasOutcome: true },
        });

        // 手动设置 createdAt 以确保时间跨度足够
        candidate.createdAt = baseTime + i * 86400000; // 每天一个，跨度 4 天
      }

      const analyses = await aggregator.analyzeExperienceClusters(mockScope);

      expect(analyses).toHaveLength(1);
      expect(analyses[0].meetsThreshold).toBe(true);
      expect(analyses[0].reason).toBe("meets_all_thresholds");
      expect(analyses[0].evidenceCount).toBe(5);
      expect(analyses[0].timeSpanDays).toBeGreaterThanOrEqual(3);
      expect(analyses[0].successOutcomeCount).toBeGreaterThanOrEqual(2);
    });
  });

  describe("generateSkillCandidate", () => {
    it("should return null when threshold not met", async () => {
      const analysis = {
        topicLabel: "test-topic",
        experienceIds: ["exp1", "exp2"],
        evidenceCount: 2,
        timeSpanDays: 1,
        avgSimilarity: 0.6,
        successOutcomeCount: 0,
        meetsThreshold: false,
        reason: "evidence_count too low",
      };

      const result = await aggregator.generateSkillCandidate(analysis);

      expect(result).toBeNull();
    });

    it("should generate skill_candidate with heuristics when LLM unavailable", async () => {
      const baseTime = Date.now();

      // 添加 experiences
      const expIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const exp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `先检查日志，然后定位问题，最后修复代码。成功解决。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "debugging", hasOutcome: true },
        });

        // 手动设置 createdAt
        exp.createdAt = baseTime + i * 86400000;
        expIds.push(exp.id);
      }

      const analysis = {
        topicLabel: "debugging",
        experienceIds: expIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.8,
        successOutcomeCount: 5,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await aggregator.generateSkillCandidate(analysis);

      expect(skillCandidate).not.toBeNull();
      expect(skillCandidate!.title).toContain("debugging");
      expect(skillCandidate!.topicLabel).toBe("debugging");
      expect(skillCandidate!.status).toBe("pending");
      expect(skillCandidate!.evidenceMemoryIds).toEqual(expIds);
      expect(skillCandidate!.confidence).toBe(0.8);
      expect(skillCandidate!.steps.length).toBeGreaterThan(0);
    });

    it("should detect high risk operations", async () => {
      const baseTime = Date.now();

      // 添加包含高风险操作的 experiences
      const expIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const exp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `需要删除旧数据时，先备份，然后执行 DROP TABLE 命令。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "data-cleanup", hasOutcome: true },
        });

        exp.createdAt = baseTime + i * 86400000;
        expIds.push(exp.id);
      }

      const analysis = {
        topicLabel: "data-cleanup",
        experienceIds: expIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.8,
        successOutcomeCount: 5,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await aggregator.generateSkillCandidate(analysis);

      expect(skillCandidate).not.toBeNull();
      expect(skillCandidate!.highRisk).toBe(true);
      expect(skillCandidate!.riskBoundaries.length).toBeGreaterThan(0);
    });

    it("should persist skill_candidate to repository", async () => {
      const baseTime = Date.now();

      const expIds: string[] = [];
      for (let i = 0; i < 5; i++) {
        const exp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `Experience ${i}: 处理测试失败的步骤`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "testing", hasOutcome: true },
        });

        exp.createdAt = baseTime + i * 86400000;
        expIds.push(exp.id);
      }

      const analysis = {
        topicLabel: "testing",
        experienceIds: expIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.8,
        successOutcomeCount: 5,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await aggregator.generateSkillCandidate(analysis);

      expect(skillCandidate).not.toBeNull();

      // 验证已持久化
      const retrieved = await skillRepo.get(skillCandidate!.id);
      expect(retrieved).not.toBeUndefined();
      expect(retrieved!.topicLabel).toBe("testing");
    });
  });

  describe("runAggregation", () => {
    it("should complete full aggregation workflow", async () => {
      const baseTime = Date.now();

      // 添加两个不同 topic 的 experience 组
      for (let i = 0; i < 5; i++) {
        const deployExp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `部署经验 ${i}：先测试，然后部署。成功上线。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`deploy-ev${i}`],
          metadata: { topicLabel: "deployment", hasOutcome: true },
        });
        deployExp.createdAt = baseTime + i * 86400000;

        const debugExp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `调试经验 ${i}：先查日志，然后定位。成功修复。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`debug-ev${i}`],
          metadata: { topicLabel: "debugging", hasOutcome: true },
        });
        debugExp.createdAt = baseTime + i * 86400000;
      }

      const result = await aggregator.runAggregation(mockScope);

      expect(result.errors).toEqual([]);
      expect(result.skillCandidates.length).toBe(2);
      expect(result.analyses.length).toBe(2);

      const topics = result.skillCandidates.map((s) => s.topicLabel).sort();
      expect(topics).toEqual(["debugging", "deployment"]);

      // 验证所有 skill_candidate 都已持久化
      for (const skill of result.skillCandidates) {
        const retrieved = await skillRepo.get(skill.id);
        expect(retrieved).not.toBeUndefined();
      }
    });

    it("should handle partial failures gracefully", async () => {
      const baseTime = Date.now();

      // 添加一组满足条件，一组不满足
      for (let i = 0; i < 5; i++) {
        const validExp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `合格经验 ${i}：完整的操作步骤。成功。`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`valid-ev${i}`],
          metadata: { topicLabel: "valid-topic", hasOutcome: true },
        });
        validExp.createdAt = baseTime + i * 86400000;
      }

      for (let i = 0; i < 2; i++) {
        const invalidExp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `不足经验 ${i}`,
          semanticType: "experience",
          kind: "lesson",
          confidence: 0.8,
          evidenceIds: [`invalid-ev${i}`],
          metadata: { topicLabel: "invalid-topic", hasOutcome: false },
        });
        invalidExp.createdAt = baseTime + i * 3600000; // 时间跨度不足
      }

      const result = await aggregator.runAggregation(mockScope);

      expect(result.skillCandidates.length).toBe(1);
      expect(result.skillCandidates[0].topicLabel).toBe("valid-topic");
      expect(result.analyses.length).toBe(2);
    });
  });

  describe("D-05 compliance", () => {
    it("should NOT mix skill_candidate into MemoryKind enum", async () => {
      // 这个测试确保 skill_candidate 是独立 schema，不在 MemoryKind 中

      const baseTime = Date.now();
      const expIds: string[] = [];

      for (let i = 0; i < 5; i++) {
        const exp = await candidateRepo.enqueue({
          scope: mockScope,
          text: `Experience ${i}`,
          semanticType: "experience",
          kind: "lesson", // MemoryKind 值
          confidence: 0.8,
          evidenceIds: [`ev${i}`],
          metadata: { topicLabel: "test", hasOutcome: true },
        });
        exp.createdAt = baseTime + i * 86400000;
        expIds.push(exp.id);
      }

      const analysis = {
        topicLabel: "test",
        experienceIds: expIds,
        evidenceCount: 5,
        timeSpanDays: 4,
        avgSimilarity: 0.8,
        successOutcomeCount: 5,
        meetsThreshold: true,
        reason: "meets_all_thresholds",
      };

      const skillCandidate = await aggregator.generateSkillCandidate(analysis);

      expect(skillCandidate).not.toBeNull();

      // skill_candidate 没有 kind 字段（不使用 MemoryKind）
      expect((skillCandidate as any).kind).toBeUndefined();

      // 有自己的状态字段
      expect(skillCandidate!.status).toBe("pending");

      // 有独立的结构字段
      expect(skillCandidate!.steps).toBeDefined();
      expect(skillCandidate!.preconditions).toBeDefined();
      expect(skillCandidate!.successSignals).toBeDefined();
    });
  });
});
