/**
 * valueScore 准入决策 8 维加权公式（§4.1）
 *
 * 决定一条候选"是否值得记"，是准入闸门的核心输入。
 * 8 个可解释维度：explicitness / durability / actionability / specificity /
 * evidence / scopeFit / novelty / riskPenalty（D-01：-0.15 惩罚项）。
 *
 * 事实来源：docs/04-design/04.2-detail/memory-system-unified-design.md §4.1
 * 权重固化：processing/scoring-weights.ts SCORING_WEIGHTS_V1
 */

import { SCORING_WEIGHTS_V1 } from "./scoring-weights.js";

/** valueScore 各维度原始信号 */
export interface ValueScoreSignals {
  /** 用户是否明确要求记住（0/1） */
  explicitness: number;
  /** 未来是否仍可能有效（0-1，由 durability 字段映射） */
  durability: number;
  /** 是否能改变 agent 后续行为（0-1，由 typePrior 推导） */
  actionability: number;
  /** 是否具体可执行（0-1，含文件/工具/命令/数值） */
  specificity: number;
  /** 是否有清楚来源（0-1，由 sourceAuthority 映射） */
  evidence: number;
  /** 是否能归入明确 scope（0-1） */
  scopeFit: number;
  /** 是否非已有记忆重复（0-1，去重阶段 1 - maxSimilarity） */
  novelty: number;
  /** 隐私/安全/污染风险（0-1，命中风险词或 riskFlags） */
  riskPenalty: number;
}

/** 辅助：将值约束到 [0,1] */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 计算 valueScore（准入决策用）
 *
 * 公式（D-01 定稿，riskPenalty = -0.15）：
 * ```
 * valueScore = clamp(0, 1,
 *     0.18 * explicitness
 *   + 0.17 * durability
 *   + 0.17 * actionability
 *   + 0.14 * specificity
 *   + 0.12 * evidence
 *   + 0.10 * scopeFit
 *   + 0.07 * novelty
 *   - 0.15 * riskPenalty
 * )
 * ```
 *
 * @param signals 8 维原始信号（调用方负责归一化到 [0,1]）
 * @returns valueScore ∈ [0,1]
 */
export function computeValueScore(signals: ValueScoreSignals): number {
  const w = SCORING_WEIGHTS_V1.valueScore;

  // 7 个正向维度 + 1 个惩罚项（D-01：riskPenalty 消费方取负）
  const score =
    w.explicitness * clamp01(signals.explicitness) +
    w.durability * clamp01(signals.durability) +
    w.actionability * clamp01(signals.actionability) +
    w.specificity * clamp01(signals.specificity) +
    w.evidence * clamp01(signals.evidence) +
    w.scopeFit * clamp01(signals.scopeFit) +
    w.novelty * clamp01(signals.novelty) -
    w.riskPenalty * clamp01(signals.riskPenalty); // 取负号

  return clamp01(score);
}

/**
 * 计算 valueScore 并返回明细（用于可解释性 / explain / eval）
 *
 * @returns { score: number, breakdown: Record<维度, 贡献值> }
 */
export function computeValueScoreWithBreakdown(signals: ValueScoreSignals): {
  score: number;
  breakdown: Record<keyof ValueScoreSignals, number>;
} {
  const w = SCORING_WEIGHTS_V1.valueScore;

  const breakdown = {
    explicitness: w.explicitness * clamp01(signals.explicitness),
    durability: w.durability * clamp01(signals.durability),
    actionability: w.actionability * clamp01(signals.actionability),
    specificity: w.specificity * clamp01(signals.specificity),
    evidence: w.evidence * clamp01(signals.evidence),
    scopeFit: w.scopeFit * clamp01(signals.scopeFit),
    novelty: w.novelty * clamp01(signals.novelty),
    riskPenalty: -w.riskPenalty * clamp01(signals.riskPenalty), // 负贡献
  };

  const score = clamp01(
    breakdown.explicitness +
      breakdown.durability +
      breakdown.actionability +
      breakdown.specificity +
      breakdown.evidence +
      breakdown.scopeFit +
      breakdown.novelty +
      breakdown.riskPenalty,
  );

  return { score, breakdown };
}
