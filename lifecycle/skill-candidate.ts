/**
 * Experience -> SkillCandidate 聚合功能导出
 *
 * 按照设计文档 §8 实现：
 * - D-05: skill_candidate 使用独立 schema，不混入 MemoryKind
 * - §8.2: 触发条件（≥5 条 experience、≥3 天、平均相似度 ≥0.78、≥2 个成功 outcome）
 * - §8.3: LLM 驱动的结构化提取（message-based + structured outputs）
 * - §8.4: 运行边界（只产候选，不自动执行）
 */

export type {
  SkillCandidate,
  SkillCandidateStatus,
  SkillCandidateExtractionOutput,
  GeneralizationTrigger,
  GeneralizationAnalysis,
  SkillCandidateRepository,
} from "./skill-candidate-types.js";

export {
  DEFAULT_GENERALIZATION_TRIGGER,
  SKILL_CANDIDATE_BOUNDARIES,
} from "./skill-candidate-types.js";

export { SkillCandidateAggregator } from "./skill-candidate-aggregator.js";

export { InMemorySkillCandidateRepository } from "./skill-candidate-repository.js";
