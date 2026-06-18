/**
 * 候选自动晋升服务
 *
 * 实现设计文档 §11.1 和 §13：
 * - experience 聚合：相同 topic 的 experience 达到 5 条证据、3 天观察窗、平均相似度 ≥0.78 时生成 skill_candidate
 * - 冲突检测：检测到语义冲突时自动降级为 lookup_only 或建立 contradicts 关系
 * - 配置驱动：通过 .mengshu/config.json 覆盖默认阈值
 *
 * 核心流程：
 * 1. 定期扫描 pending 状态的 experience 类型候选
 * 2. 按 topic-label 分组，计算每组的证据数、时间跨度、语义相似度
 * 3. 达到晋升阈值时生成 skill_candidate
 * 4. 检测冲突时标记并降级
 */

import type { CandidateRecord, CandidateRepository } from "./candidate-types.js";
import type { MemoryScope } from "../core/types.js";

/**
 * 自动晋升配置
 */
export interface AutoPromotionConfig {
  /** 最少证据数（默认 5） */
  minEvidenceCount: number;
  /** 最少观察时间跨度（天，默认 3） */
  minTimeSpanDays: number;
  /** 泛化阈值：达到此阈值才聚合（默认 5） */
  generalizeThreshold: number;
  /** 语义相似度阈值（默认 0.78） */
  minSimilarity: number;
  /** 是否启用自动晋升 */
  enabled: boolean;
}

export const DEFAULT_AUTO_PROMOTION_CONFIG: AutoPromotionConfig = {
  minEvidenceCount: 5,
  minTimeSpanDays: 3,
  generalizeThreshold: 5,
  minSimilarity: 0.78,
  enabled: true,
};

/**
 * Skill Candidate Schema（§11.2）
 */
export interface SkillCandidate {
  id: string;
  title: string;
  topicLabel: string;
  triggerConditions: string[];
  preconditions: string[];
  steps: string[];
  successSignals: string[];
  antiPatterns: string[];
  riskBoundaries: string[];
  highRisk: boolean;
  evidenceMemoryIds: string[];
  evidenceChunkIds: string[];
  confidence: number;
  status: "pending" | "active" | "archived" | "rejected";
  createdAt: number;
  scope: MemoryScope;
}

/**
 * 晋升分析结果
 */
export interface PromotionAnalysis {
  topicLabel: string;
  candidateIds: string[];
  evidenceCount: number;
  timeSpanDays: number;
  avgSimilarity: number;
  meetsThreshold: boolean;
  reason: string;
}

/**
 * 冲突检测结果
 */
export interface ConflictDetectionResult {
  conflictingPairs: Array<{
    candidateA: string;
    candidateB: string;
    conflictType: "contradiction" | "supersedes" | "incompatible";
    confidence: number;
  }>;
  suggestedActions: Array<{
    candidateId: string;
    action: "downgrade_to_lookup" | "mark_superseded" | "create_conflict_edge";
    reason: string;
  }>;
}

/**
 * 候选自动晋升服务
 */
export class CandidateAutoPromotionService {
  private repository: CandidateRepository;
  private config: AutoPromotionConfig;
  private now: () => number;

  constructor(deps: {
    repository: CandidateRepository;
    config?: Partial<AutoPromotionConfig>;
    now?: () => number;
  }) {
    this.repository = deps.repository;
    this.config = { ...DEFAULT_AUTO_PROMOTION_CONFIG, ...deps.config };
    this.now = deps.now ?? Date.now;
  }

  /**
   * 扫描所有 pending 的 experience 候选，分析是否达到晋升条件
   */
  async analyzeExperienceClusters(
    scope?: MemoryScope
  ): Promise<PromotionAnalysis[]> {
    if (!this.config.enabled) {
      return [];
    }

    // 获取所有 pending 的 experience 候选
    const candidates = await this.repository.list({
      scope,
      status: "pending",
      semanticType: "experience",
    });

    if (candidates.length === 0) {
      return [];
    }

    // 按 topicLabel 分组
    const groupedByTopic = this.groupByTopic(candidates);

    // 分析每组
    const analyses: PromotionAnalysis[] = [];
    for (const [topicLabel, group] of Object.entries(groupedByTopic)) {
      const analysis = this.analyzeGroup(topicLabel, group);
      analyses.push(analysis);
    }

    return analyses;
  }

  /**
   * 按 topic-label 分组候选
   */
  private groupByTopic(
    candidates: CandidateRecord[]
  ): Record<string, CandidateRecord[]> {
    const groups: Record<string, CandidateRecord[]> = {};

    for (const candidate of candidates) {
      // 从 metadata 中提取 topicLabel
      const topicLabel = this.extractTopicLabel(candidate);
      if (!topicLabel) {
        continue;
      }

      if (!groups[topicLabel]) {
        groups[topicLabel] = [];
      }
      groups[topicLabel].push(candidate);
    }

    return groups;
  }

  /**
   * 提取候选的 topic-label
   */
  private extractTopicLabel(candidate: CandidateRecord): string | null {
    // 优先使用 metadata.topicLabel
    if (candidate.metadata.topicLabel) {
      return String(candidate.metadata.topicLabel);
    }

    // 回退：从文本中提取关键词作为 topic
    // 这里使用简单的启发式规则，实际可以接入 LLM 或 NLP
    const text = candidate.text.toLowerCase();

    // 匹配常见模式
    const patterns = [
      /(?:关于|about)\s+([^\s,，。.]+)/i,
      /([^\s,，。.]+)\s+(?:问题|issue|bug)/i,
      /(?:处理|handle|fix)\s+([^\s,，。.]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match && match[1]) {
        return this.normalizeTopicLabel(match[1]);
      }
    }

    return null;
  }

  /**
   * 归一化 topic-label（§10.4）
   */
  private normalizeTopicLabel(label: string): string {
    return label
      .trim()
      .toLowerCase()
      .replace(/[`"'""'']/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  /**
   * 分析单个分组是否达到晋升条件
   */
  private analyzeGroup(
    topicLabel: string,
    candidates: CandidateRecord[]
  ): PromotionAnalysis {
    const evidenceCount = candidates.length;
    const timeSpanDays = this.calculateTimeSpan(candidates);
    const avgSimilarity = this.estimateSimilarity(candidates);

    const meetsEvidenceThreshold =
      evidenceCount >= this.config.minEvidenceCount;
    const meetsTimeThreshold = timeSpanDays >= this.config.minTimeSpanDays;
    const meetsSimilarityThreshold =
      avgSimilarity >= this.config.minSimilarity;

    const meetsThreshold =
      meetsEvidenceThreshold && meetsTimeThreshold && meetsSimilarityThreshold;

    let reason = "";
    if (!meetsEvidenceThreshold) {
      reason = `evidence_count=${evidenceCount} < ${this.config.minEvidenceCount}`;
    } else if (!meetsTimeThreshold) {
      reason = `time_span=${timeSpanDays.toFixed(1)}d < ${this.config.minTimeSpanDays}d`;
    } else if (!meetsSimilarityThreshold) {
      reason = `avg_similarity=${avgSimilarity.toFixed(2)} < ${this.config.minSimilarity}`;
    } else {
      reason = "meets_all_thresholds";
    }

    return {
      topicLabel,
      candidateIds: candidates.map((c) => c.id),
      evidenceCount,
      timeSpanDays,
      avgSimilarity,
      meetsThreshold,
      reason,
    };
  }

  /**
   * 计算时间跨度（天）
   */
  private calculateTimeSpan(candidates: CandidateRecord[]): number {
    if (candidates.length === 0) return 0;

    const timestamps = candidates.map((c) => c.createdAt).sort((a, b) => a - b);
    const earliest = timestamps[0];
    const latest = timestamps[timestamps.length - 1];

    return (latest - earliest) / (24 * 60 * 60 * 1000);
  }

  /**
   * 估算相似度（简化版本，实际应使用 embedding）
   */
  private estimateSimilarity(candidates: CandidateRecord[]): number {
    if (candidates.length <= 1) return 1.0;

    // 简化：基于文本长度和关键词重叠度估算
    // 实际实现应使用 embedding cosine similarity
    const texts = candidates.map((c) => c.text.toLowerCase());
    let totalSimilarity = 0;
    let pairCount = 0;

    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        totalSimilarity += this.simpleSimilarity(texts[i], texts[j]);
        pairCount++;
      }
    }

    // 保守估计：如果是同一 topic 的候选，基础相似度为 0.7
    // 加上实际计算的相似度权重
    const baseSimilarity = 0.7;
    const calculatedSimilarity = pairCount > 0 ? totalSimilarity / pairCount : 0;
    return baseSimilarity + calculatedSimilarity * 0.3;
  }

  /**
   * 简单文本相似度（基于单词重叠）
   */
  private simpleSimilarity(textA: string, textB: string): number {
    const wordsA = new Set(textA.split(/\s+/).filter(w => w.length > 0));
    const wordsB = new Set(textB.split(/\s+/).filter(w => w.length > 0));

    if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 生成 skill_candidate（§11.2）
   */
  async generateSkillCandidate(
    analysis: PromotionAnalysis
  ): Promise<SkillCandidate | null> {
    if (!analysis.meetsThreshold) {
      return null;
    }

    // 获取候选详情
    const candidates: CandidateRecord[] = [];
    for (const id of analysis.candidateIds) {
      const candidate = await this.repository.get(id);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // 提取共同模式
    const patterns = this.extractPatterns(candidates);

    const skillCandidate: SkillCandidate = {
      id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title: `经验候选：${analysis.topicLabel}`,
      topicLabel: analysis.topicLabel,
      triggerConditions: patterns.triggers,
      preconditions: patterns.preconditions,
      steps: patterns.steps,
      successSignals: patterns.successSignals,
      antiPatterns: patterns.antiPatterns,
      riskBoundaries: patterns.riskBoundaries,
      highRisk: patterns.hasHighRisk,
      evidenceMemoryIds: analysis.candidateIds,
      evidenceChunkIds: candidates.flatMap((c) => c.evidenceIds),
      confidence: analysis.avgSimilarity,
      status: "pending",
      createdAt: this.now(),
      scope: candidates[0].scope,
    };

    return skillCandidate;
  }

  /**
   * 从候选中提取共同模式
   */
  private extractPatterns(candidates: CandidateRecord[]): {
    triggers: string[];
    preconditions: string[];
    steps: string[];
    successSignals: string[];
    antiPatterns: string[];
    riskBoundaries: string[];
    hasHighRisk: boolean;
  } {
    // 简化实现：从候选文本中提取关键信息
    // 实际应使用 LLM 进行结构化提取

    const allTexts = candidates.map((c) => c.text);
    const triggers: string[] = [];
    const preconditions: string[] = [];
    const steps: string[] = [];
    const successSignals: string[] = [];
    const antiPatterns: string[] = [];
    const riskBoundaries: string[] = [];
    let hasHighRisk = false;

    for (const text of allTexts) {
      // 提取触发条件
      if (/当|如果|遇到|when|if/i.test(text)) {
        triggers.push(text.slice(0, 100));
      }

      // 提取步骤
      if (/先|然后|接着|首先|最后|step|then/i.test(text)) {
        steps.push(text.slice(0, 100));
      }

      // 提取成功信号
      if (/成功|完成|解决|success|resolved/i.test(text)) {
        successSignals.push(text.slice(0, 100));
      }

      // 提取反模式
      if (/不要|避免|禁止|never|avoid|don't/i.test(text)) {
        antiPatterns.push(text.slice(0, 100));
      }

      // 检测高风险操作
      if (/删除|强制|清空|覆盖|delete|force|drop|truncate/i.test(text)) {
        hasHighRisk = true;
        riskBoundaries.push(text.slice(0, 100));
      }
    }

    // 去重
    const unique = (arr: string[]) => Array.from(new Set(arr));

    return {
      triggers: unique(triggers),
      preconditions: unique(preconditions),
      steps: unique(steps),
      successSignals: unique(successSignals),
      antiPatterns: unique(antiPatterns),
      riskBoundaries: unique(riskBoundaries),
      hasHighRisk,
    };
  }

  /**
   * 检测冲突（§9.5）
   */
  async detectConflicts(
    scope?: MemoryScope
  ): Promise<ConflictDetectionResult> {
    const candidates = await this.repository.list({
      scope,
      status: "pending",
    });

    const conflictingPairs: ConflictDetectionResult["conflictingPairs"] = [];
    const suggestedActions: ConflictDetectionResult["suggestedActions"] = [];

    // 两两比较检测冲突
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const candidateA = candidates[i];
        const candidateB = candidates[j];

        // 只检测相同 semanticType 的候选
        if (candidateA.semanticType !== candidateB.semanticType) {
          continue;
        }

        const conflict = this.detectConflictPair(candidateA, candidateB);
        if (conflict) {
          conflictingPairs.push({
            candidateA: candidateA.id,
            candidateB: candidateB.id,
            conflictType: conflict.type,
            confidence: conflict.confidence,
          });

          // 生成降级建议
          const lowerConfidence =
            candidateA.confidence < candidateB.confidence
              ? candidateA
              : candidateB;

          suggestedActions.push({
            candidateId: lowerConfidence.id,
            action: "downgrade_to_lookup",
            reason: `conflict_with_${lowerConfidence === candidateA ? candidateB.id : candidateA.id}`,
          });
        }
      }
    }

    return { conflictingPairs, suggestedActions };
  }

  /**
   * 检测两个候选是否冲突
   */
  private detectConflictPair(
    a: CandidateRecord,
    b: CandidateRecord
  ): { type: "contradiction" | "supersedes" | "incompatible"; confidence: number } | null {
    const textA = a.text.toLowerCase();
    const textB = b.text.toLowerCase();

    // 检测矛盾
    const contradictionPatterns = [
      { a: /必须|一定要|always|must/, b: /不要|禁止|never|avoid/ },
      { a: /允许|可以|should|allow/, b: /不允许|禁止|must not|forbid/ },
      { a: /先|首先|before/, b: /后|最后|after/ },
    ];

    for (const pattern of contradictionPatterns) {
      if (
        (pattern.a.test(textA) && pattern.b.test(textB)) ||
        (pattern.b.test(textA) && pattern.a.test(textB))
      ) {
        return { type: "contradiction", confidence: 0.8 };
      }
    }

    // 检测时间上的替代关系
    if (a.createdAt < b.createdAt && this.simpleSimilarity(textA, textB) > 0.7) {
      return { type: "supersedes", confidence: 0.7 };
    }

    return null;
  }

  /**
   * 应用冲突降级（§9.5）
   */
  async applyConflictDowngrades(
    result: ConflictDetectionResult
  ): Promise<{ applied: number; errors: string[] }> {
    let applied = 0;
    const errors: string[] = [];

    for (const action of result.suggestedActions) {
      try {
        if (action.action === "downgrade_to_lookup") {
          // 检查候选是否存在
          const candidate = await this.repository.get(action.candidateId);
          if (!candidate) {
            continue; // 静默跳过不存在的候选
          }

          // 标记候选为 archived，并记录原因
          await this.repository.setStatus(action.candidateId, "archived", {
            reason: action.reason,
          });
          applied++;
        }
      } catch (err) {
        errors.push(
          `Failed to apply action for ${action.candidateId}: ${(err as Error).message}`
        );
      }
    }

    return { applied, errors };
  }

  /**
   * 完整的自动晋升流程
   */
  async runAutoPromotion(scope?: MemoryScope): Promise<{
    skillCandidates: SkillCandidate[];
    conflictsResolved: number;
    errors: string[];
  }> {
    const skillCandidates: SkillCandidate[] = [];
    const errors: string[] = [];
    let conflictsResolved = 0;

    try {
      // 1. 分析 experience 聚合
      const analyses = await this.analyzeExperienceClusters(scope);

      // 2. 生成 skill_candidate
      for (const analysis of analyses) {
        if (analysis.meetsThreshold) {
          const skillCandidate = await this.generateSkillCandidate(analysis);
          if (skillCandidate) {
            skillCandidates.push(skillCandidate);
          }
        }
      }

      // 3. 检测并处理冲突
      const conflicts = await this.detectConflicts(scope);
      const result = await this.applyConflictDowngrades(conflicts);
      conflictsResolved = result.applied;
      errors.push(...result.errors);
    } catch (err) {
      errors.push(`Auto-promotion failed: ${(err as Error).message}`);
    }

    return { skillCandidates, conflictsResolved, errors };
  }
}
