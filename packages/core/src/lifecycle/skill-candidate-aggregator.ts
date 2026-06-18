/**
 * Experience → SkillCandidate 聚合器（§8）
 *
 * 实现设计文档 §8.2-§8.4：
 * - 按 topic-label 聚合 experience 候选
 * - 触发条件：≥5 条 experience、≥3 天时间跨度、平均相似度 ≥0.78
 * - 调用 LLM 进行结构化提取（message-based + structured outputs）
 * - 只产出候选，不自动创建可执行 skill
 */

import type { CandidateRecord, CandidateRepository } from "./candidate-types.js";
import type {
  SkillCandidate,
  SkillCandidateExtractionOutput,
  GeneralizationTrigger,
  GeneralizationAnalysis,
  SkillCandidateRepository,
} from "./skill-candidate-types.js";
import { DEFAULT_GENERALIZATION_TRIGGER } from "./skill-candidate-types.js";
import type { MemoryScope } from "../domain/types.js";
import type { LlmClient } from "../runtime/llm/llm-client.js";

/**
 * SkillCandidate 聚合器
 */
export class SkillCandidateAggregator {
  private candidateRepo: CandidateRepository;
  private skillRepo: SkillCandidateRepository;
  private llmClient?: LlmClient;
  private trigger: GeneralizationTrigger;
  private now: () => number;

  constructor(deps: {
    candidateRepository: CandidateRepository;
    skillCandidateRepository: SkillCandidateRepository;
    llmClient?: LlmClient;
    trigger?: Partial<GeneralizationTrigger>;
    now?: () => number;
  }) {
    this.candidateRepo = deps.candidateRepository;
    this.skillRepo = deps.skillCandidateRepository;
    this.llmClient = deps.llmClient;
    this.trigger = { ...DEFAULT_GENERALIZATION_TRIGGER, ...deps.trigger };
    this.now = deps.now ?? Date.now;
  }

  /**
   * 分析 experience 候选，返回可升格的分组（§8.2）
   */
  async analyzeExperienceClusters(
    scope?: MemoryScope
  ): Promise<GeneralizationAnalysis[]> {
    // 获取所有 pending 的 experience 候选
    const experiences = await this.candidateRepo.list({
      scope,
      status: "pending",
      semanticType: "experience",
    });

    if (experiences.length === 0) {
      return [];
    }

    // 按 topic-label 分组
    const grouped = this.groupByTopic(experiences);

    // 分析每组
    const analyses: GeneralizationAnalysis[] = [];
    for (const [topicLabel, group] of Object.entries(grouped)) {
      const analysis = await this.analyzeGroup(topicLabel, group);
      analyses.push(analysis);
    }

    return analyses;
  }

  /**
   * 按 topic-label 分组
   */
  private groupByTopic(
    experiences: CandidateRecord[]
  ): Record<string, CandidateRecord[]> {
    const groups: Record<string, CandidateRecord[]> = {};

    for (const exp of experiences) {
      const topicLabel = this.extractTopicLabel(exp);
      if (!topicLabel) {
        continue;
      }

      if (!groups[topicLabel]) {
        groups[topicLabel] = [];
      }
      groups[topicLabel].push(exp);
    }

    return groups;
  }

  /**
   * 提取 topic-label
   */
  private extractTopicLabel(candidate: CandidateRecord): string | null {
    // 优先使用 metadata.topicLabel
    if (candidate.metadata.topicLabel) {
      return this.normalizeTopicLabel(String(candidate.metadata.topicLabel));
    }

    // 回退：从文本提取（简单启发式）
    const text = candidate.text.toLowerCase();
    const patterns = [
      /(?:关于|about)\s+([^\s,，。.]+)/i,
      /([^\s,，。.]+)\s+(?:问题|issue|bug)/i,
      /(?:处理|解决|handle|fix)\s+([^\s,，。.]+)/i,
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
   * 归一化 topic-label（§7.4）
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
   * 分析单个分组
   */
  private async analyzeGroup(
    topicLabel: string,
    experiences: CandidateRecord[]
  ): Promise<GeneralizationAnalysis> {
    const evidenceCount = experiences.length;
    const timeSpanDays = this.calculateTimeSpan(experiences);
    const avgSimilarity = this.estimateSimilarity(experiences);
    const successOutcomeCount = this.countSuccessOutcomes(experiences);

    const meetsCount = evidenceCount >= this.trigger.minExperienceCount;
    const meetsTimeSpan = timeSpanDays >= this.trigger.minTimeSpanDays;
    const meetsSimilarity = avgSimilarity >= this.trigger.minAvgSimilarity;
    const meetsSuccess = successOutcomeCount >= this.trigger.minSuccessOutcomes;

    const meetsThreshold = meetsCount && meetsTimeSpan && meetsSimilarity && meetsSuccess;

    let reason = "";
    if (!meetsCount) {
      reason = `evidence_count=${evidenceCount} < ${this.trigger.minExperienceCount}`;
    } else if (!meetsTimeSpan) {
      reason = `time_span=${timeSpanDays.toFixed(1)}d < ${this.trigger.minTimeSpanDays}d`;
    } else if (!meetsSimilarity) {
      reason = `avg_similarity=${avgSimilarity.toFixed(2)} < ${this.trigger.minAvgSimilarity}`;
    } else if (!meetsSuccess) {
      reason = `success_outcomes=${successOutcomeCount} < ${this.trigger.minSuccessOutcomes}`;
    } else {
      reason = "meets_all_thresholds";
    }

    return {
      topicLabel,
      experienceIds: experiences.map((e) => e.id),
      evidenceCount,
      timeSpanDays,
      avgSimilarity,
      successOutcomeCount,
      meetsThreshold,
      reason,
    };
  }

  /**
   * 计算时间跨度（天）
   */
  private calculateTimeSpan(experiences: CandidateRecord[]): number {
    if (experiences.length === 0) return 0;

    const timestamps = experiences.map((e) => e.createdAt).sort((a, b) => a - b);
    const earliest = timestamps[0];
    const latest = timestamps[timestamps.length - 1];

    return (latest - earliest) / (24 * 60 * 60 * 1000);
  }

  /**
   * 估算相似度（简化版本，实际应使用 embedding）
   */
  private estimateSimilarity(experiences: CandidateRecord[]): number {
    if (experiences.length <= 1) return 1.0;

    const texts = experiences.map((e) => e.text.toLowerCase());
    let totalSim = 0;
    let pairCount = 0;

    for (let i = 0; i < texts.length; i++) {
      for (let j = i + 1; j < texts.length; j++) {
        totalSim += this.jaccardSimilarity(texts[i], texts[j]);
        pairCount++;
      }
    }

    // 同 topic 基础相似度 0.7 + 计算相似度权重 0.3
    const baseSim = 0.7;
    const calcSim = pairCount > 0 ? totalSim / pairCount : 0;
    return baseSim + calcSim * 0.3;
  }

  /**
   * Jaccard 相似度（基于词集）
   */
  private jaccardSimilarity(textA: string, textB: string): number {
    const wordsA = new Set(textA.split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(textB.split(/\s+/).filter((w) => w.length > 2));

    if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * 统计成功 outcome 数量
   */
  private countSuccessOutcomes(experiences: CandidateRecord[]): number {
    let count = 0;

    for (const exp of experiences) {
      const text = exp.text.toLowerCase();
      const hasOutcome = exp.metadata.hasOutcome === true;
      const hasSuccessSignal = /成功|完成|解决|通过|success|resolved|fixed|passed/i.test(
        text
      );

      if (hasOutcome || hasSuccessSignal) {
        count++;
      }
    }

    return count;
  }

  /**
   * 生成 skill_candidate（调用 LLM，§8.3）
   */
  async generateSkillCandidate(
    analysis: GeneralizationAnalysis
  ): Promise<SkillCandidate | null> {
    if (!analysis.meetsThreshold) {
      return null;
    }

    // 获取完整的 experience 记录
    const experiences: CandidateRecord[] = [];
    for (const id of analysis.experienceIds) {
      const exp = await this.candidateRepo.get(id);
      if (exp) {
        experiences.push(exp);
      }
    }

    if (experiences.length === 0) {
      return null;
    }

    // 如果有 LLM，使用 LLM 提取；否则使用启发式
    let extraction: SkillCandidateExtractionOutput | null = null;

    if (this.llmClient) {
      extraction = await this.extractWithLLM(analysis.topicLabel, experiences);
    }

    // LLM 失败或不可用，使用启发式降级
    if (!extraction || !extraction.generalizable) {
      extraction = this.extractWithHeuristics(analysis.topicLabel, experiences);
    }

    if (!extraction.generalizable) {
      return null;
    }

    // 构建 SkillCandidate
    const skillCandidate: SkillCandidate = {
      id: `skill-${this.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title: extraction.title,
      topicLabel: extraction.topicLabel,
      applicability: extraction.applicability,
      triggerConditions: this.extractTriggers(experiences),
      preconditions: extraction.preconditions.slice(0, 8),
      steps: extraction.steps.slice(0, 12),
      successSignals: extraction.successSignals.slice(0, 8),
      antiPatterns: this.extractAntiPatterns(experiences),
      riskBoundaries: extraction.riskBoundaries.slice(0, 8),
      highRisk: extraction.highRisk,
      evidenceMemoryIds: analysis.experienceIds,
      evidenceChunkIds: experiences.flatMap((e) => e.evidenceIds),
      confidence: analysis.avgSimilarity,
      status: "pending",
      reason: extraction.reason,
      scope: experiences[0].scope,
      metadata: {
        analysisTimeSpanDays: analysis.timeSpanDays,
        successOutcomeCount: analysis.successOutcomeCount,
      },
      createdAt: this.now(),
    };

    // 持久化
    return await this.skillRepo.create(skillCandidate);
  }

  /**
   * 使用 LLM 提取（§8.3）
   */
  private async extractWithLLM(
    topicLabel: string,
    experiences: CandidateRecord[]
  ): Promise<SkillCandidateExtractionOutput | null> {
    if (!this.llmClient || !this.llmClient.extractStructured) {
      return null;
    }

    // System message（§8.3）
    const systemMessage = `你是 mengshu 经验升格器。给定多条情景经验，判断它们是否共同指向一个可复用的 agent 操作模式，并在适用时生成 skill_candidate。你只产出候选，不创建可执行 skill。

严格要求：
- 不得引入片段中没有的信息（禁止外推）。
- 必须说明适用场景、前置条件、步骤、成功信号和风险边界。
- 如果只是用户偏好或单条规则，不要升格为 skill_candidate。
- 如果需要真实凭证、删除数据、付费操作或外部不可逆动作，标 highRisk=true。
- 输出语言与原文一致。`;

    // User message
    const experienceTexts = experiences
      .map((e, i) => `[Experience ${i + 1}]\nID: ${e.id}\nText: ${e.text}`)
      .join("\n\n");

    const userMessage = `# 主题标签
${topicLabel}

# 待聚合的 Experience 记录
${experienceTexts}

请判断这些经验是否可以升格为 skill_candidate。`;

    try {
      const output = await this.llmClient.extractStructured<SkillCandidateExtractionOutput>(
        [
          { role: "system", content: systemMessage },
          { role: "user", content: userMessage },
        ],
        this.getExtractionSchema(),
        {
          maxTokens: 2000,
          modelType: "extraction",
        }
      );

      return output;
    } catch (err) {
      console.error("LLM extraction failed:", err);
      return null;
    }
  }

  /**
   * LLM 提取 schema（§8.3）
   */
  private getExtractionSchema() {
    return {
      $schema: "http://json-schema.org/draft-07/schema#",
      title: "SkillCandidateExtraction",
      type: "object",
      additionalProperties: false,
      required: [
        "generalizable",
        "candidateType",
        "title",
        "topicLabel",
        "applicability",
        "preconditions",
        "steps",
        "successSignals",
        "riskBoundaries",
        "highRisk",
        "sourceEvidenceIds",
        "reason",
      ],
      properties: {
        generalizable: { type: "boolean" },
        candidateType: { type: "string", enum: ["skill_candidate"] },
        title: { type: "string", minLength: 1, maxLength: 80 },
        topicLabel: { type: "string", minLength: 1, maxLength: 80 },
        applicability: { type: "string", minLength: 1, maxLength: 200 },
        preconditions: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
        },
        steps: {
          type: "array",
          items: { type: "string" },
          maxItems: 12,
        },
        successSignals: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
        },
        riskBoundaries: {
          type: "array",
          items: { type: "string" },
          maxItems: 8,
        },
        highRisk: { type: "boolean" },
        sourceEvidenceIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
        reason: { type: "string", minLength: 1, maxLength: 200 },
      },
    };
  }

  /**
   * 启发式提取（LLM 降级）
   */
  private extractWithHeuristics(
    topicLabel: string,
    experiences: CandidateRecord[]
  ): SkillCandidateExtractionOutput {
    const allTexts = experiences.map((e) => e.text).join(" ");
    const hasHighRisk = /删除|强制|清空|覆盖|付费|delete|force|drop|truncate|payment/i.test(
      allTexts
    );

    // 简单提取步骤
    const steps = experiences
      .filter((e) => /先|然后|接着|首先|最后|step|then/i.test(e.text))
      .map((e) => e.text.slice(0, 100));

    const successSignals = experiences
      .filter((e) => /成功|完成|解决|通过|success|resolved|fixed|passed/i.test(e.text))
      .map((e) => e.text.slice(0, 100));

    // 如果没有明确的步骤标记，将所有 experience 作为步骤
    const finalSteps =
      steps.length > 0 ? steps : experiences.map((e) => e.text.slice(0, 100));

    // 降低门槛：只要有多个 experience，就认为可以泛化
    const generalizable = experiences.length >= 3;

    return {
      generalizable,
      candidateType: "skill_candidate",
      title: `经验候选：${topicLabel}`,
      topicLabel,
      applicability: `适用于处理与 ${topicLabel} 相关的场景`,
      preconditions: ["根据具体情况判断"],
      steps: finalSteps,
      successSignals: successSignals.length > 0 ? successSignals : ["操作完成"],
      riskBoundaries: hasHighRisk ? ["包含高风险操作，需人工审核"] : [],
      highRisk: hasHighRisk,
      sourceEvidenceIds: experiences.map((e) => e.id),
      reason: generalizable
        ? "启发式提取（LLM 不可用）"
        : `experience 数量不足（${experiences.length} < 3）`,
    };
  }

  /**
   * 提取触发条件
   */
  private extractTriggers(experiences: CandidateRecord[]): string[] {
    const triggers: string[] = [];

    for (const exp of experiences) {
      const text = exp.text;
      if (/当|如果|遇到|发现|when|if|encounter/i.test(text)) {
        triggers.push(text.slice(0, 100));
      }
    }

    return Array.from(new Set(triggers)).slice(0, 8);
  }

  /**
   * 提取反模式
   */
  private extractAntiPatterns(experiences: CandidateRecord[]): string[] {
    const antiPatterns: string[] = [];

    for (const exp of experiences) {
      const text = exp.text;
      if (/不要|避免|禁止|切勿|never|avoid|don't|do not/i.test(text)) {
        antiPatterns.push(text.slice(0, 100));
      }
    }

    return Array.from(new Set(antiPatterns)).slice(0, 8);
  }

  /**
   * 完整的聚合流程
   */
  async runAggregation(scope?: MemoryScope): Promise<{
    skillCandidates: SkillCandidate[];
    analyses: GeneralizationAnalysis[];
    errors: string[];
  }> {
    const skillCandidates: SkillCandidate[] = [];
    const errors: string[] = [];

    try {
      // 1. 分析聚合
      const analyses = await this.analyzeExperienceClusters(scope);

      // 2. 生成 skill_candidate
      for (const analysis of analyses) {
        if (analysis.meetsThreshold) {
          try {
            const skillCandidate = await this.generateSkillCandidate(analysis);
            if (skillCandidate) {
              skillCandidates.push(skillCandidate);
            }
          } catch (err) {
            errors.push(
              `Failed to generate skill for topic ${analysis.topicLabel}: ${(err as Error).message}`
            );
          }
        }
      }

      return { skillCandidates, analyses, errors };
    } catch (err) {
      errors.push(`Aggregation failed: ${(err as Error).message}`);
      return { skillCandidates: [], analyses: [], errors };
    }
  }
}
