/**
 * Skill Candidate 类型定义（§8，D-05）
 *
 * skill_candidate 是 experience 聚合的产物，使用独立 schema，
 * 不混入 MemoryKind 枚举（D-05）。
 *
 * 核心原则：
 * - 只产出候选，不自动创建可执行 skill
 * - 所有内容必须可追溯到 experience evidence
 * - 高风险操作必须标记 highRisk=true
 */

import type { MemoryScope } from "../core/types.js";

/**
 * SkillCandidate Schema（§8.2，独立于 MemoryKind）
 */
export interface SkillCandidate {
  id: string;
  /** 候选标题 ≤ 80 字 */
  title: string;
  /** 归一化的主题标签（topic-label） */
  topicLabel: string;
  /** 适用场景描述 */
  applicability?: string;
  /** 触发条件（自然语言） */
  triggerConditions: string[];
  /** 前置条件 ≤ 8 条 */
  preconditions: string[];
  /** 操作步骤 ≤ 12 步 */
  steps: string[];
  /** 成功信号 ≤ 8 条 */
  successSignals: string[];
  /** 反模式（应避免的做法） */
  antiPatterns: string[];
  /** 风险边界 ≤ 8 条 */
  riskBoundaries: string[];
  /** 是否包含高风险操作（删除/付费/外部不可逆） */
  highRisk: boolean;
  /** 来源 experience 记忆 IDs */
  evidenceMemoryIds: string[];
  /** 来源 evidence chunk IDs */
  evidenceChunkIds: string[];
  /** 置信度 0-1 */
  confidence: number;
  /** 状态 */
  status: SkillCandidateStatus;
  /** 升格理由 */
  reason?: string;
  /** 所属 scope */
  scope: MemoryScope;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt?: number;
}

/**
 * SkillCandidate 状态机
 */
export type SkillCandidateStatus =
  | "pending"    // 待审核
  | "active"     // 已激活（可在召回时作为建议）
  | "archived"   // 已归档
  | "rejected";  // 已拒绝

/**
 * LLM 升格输出 schema（§8.3）
 */
export interface SkillCandidateExtractionOutput {
  /** 是否可泛化为 skill_candidate */
  generalizable: boolean;
  /** 候选类型（固定值） */
  candidateType: "skill_candidate";
  /** 标题 ≤ 80 字 */
  title: string;
  /** 主题标签 */
  topicLabel: string;
  /** 适用场景描述 */
  applicability: string;
  /** 前置条件 ≤ 8 条 */
  preconditions: string[];
  /** 操作步骤 ≤ 12 步 */
  steps: string[];
  /** 成功信号 ≤ 8 条 */
  successSignals: string[];
  /** 风险边界 ≤ 8 条 */
  riskBoundaries: string[];
  /** 是否高风险 */
  highRisk: boolean;
  /** 来源证据 IDs */
  sourceEvidenceIds: string[];
  /** 理由 ≤ 200 字 */
  reason: string;
}

/**
 * 升格触发条件（§8.2）
 */
export interface GeneralizationTrigger {
  /** 最少 experience 数量（v1 保守值：5） */
  minExperienceCount: number;
  /** 平均 embedding 相似度阈值（v1: 0.78） */
  minAvgSimilarity: number;
  /** 最少时间跨度（天）（v1: 3） */
  minTimeSpanDays: number;
  /** 最少成功 outcome 数（v1: 2） */
  minSuccessOutcomes: number;
  /** 是否允许包含高风险动作 */
  allowHighRisk: boolean;
}

export const DEFAULT_GENERALIZATION_TRIGGER: GeneralizationTrigger = {
  minExperienceCount: 5,
  minAvgSimilarity: 0.78,
  minTimeSpanDays: 3,
  minSuccessOutcomes: 2,
  allowHighRisk: false,
};

/**
 * 升格分析结果
 */
export interface GeneralizationAnalysis {
  /** 主题标签 */
  topicLabel: string;
  /** 候选 experience IDs */
  experienceIds: string[];
  /** 证据数量 */
  evidenceCount: number;
  /** 时间跨度（天） */
  timeSpanDays: number;
  /** 平均相似度 */
  avgSimilarity: number;
  /** 成功 outcome 数量 */
  successOutcomeCount: number;
  /** 是否达到阈值 */
  meetsThreshold: boolean;
  /** 不满足原因（若 meetsThreshold=false） */
  reason: string;
}

/**
 * SkillCandidate Repository 接口
 */
export interface SkillCandidateRepository {
  /** 创建 skill_candidate */
  create(candidate: Omit<SkillCandidate, "id" | "createdAt"> & {
    id?: string;
  }): Promise<SkillCandidate>;

  /** 查询单个 */
  get(id: string): Promise<SkillCandidate | undefined>;

  /** 列表查询 */
  list(filter?: {
    scope?: MemoryScope;
    status?: SkillCandidateStatus;
    topicLabel?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SkillCandidate[]>;

  /** 更新状态 */
  updateStatus(
    id: string,
    status: SkillCandidateStatus,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /** 删除 */
  delete(id: string): Promise<void>;

  /** 按 topic 查询 */
  findByTopic(topicLabel: string, scope?: MemoryScope): Promise<SkillCandidate[]>;
}

/**
 * 运行边界约束（§8.4）
 */
export const SKILL_CANDIDATE_BOUNDARIES = {
  /** 允许：生成 skill_candidate */
  canGenerate: true,
  /** 禁止：自动创建可执行 skill */
  canAutoExecute: false,
  /** 允许：引用 evidence memory */
  canReferenceEvidence: true,
  /** 禁止：引入 evidence 中没有的步骤 */
  canExtrapolate: false,
  /** 允许：管理界面展示候选 */
  canShowInUI: true,
  /** 禁止：自动写入用户全局规则 */
  canAutoWriteGlobalRules: false,
  /** 允许：召回时作为建议 */
  canSuggestOnRecall: true,
  /** 禁止：自动执行外部不可逆动作 */
  canAutoExecuteExternalActions: false,
} as const;
