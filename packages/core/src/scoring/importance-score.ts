/**
 * importance 召回排序 + 树路由 4 项加权公式（§4.2）
 *
 * importance 决定记忆在召回评分（权重 0.15）和 seal 摘要选取中的优先级。
 * 4 项加权：salience_llm / sourceAuthority / explicitnessBonus / typePrior
 *
 * 事实来源：docs/04-design/04.2-detail/memory-system-unified-design.md §4.2
 * 权重固化：processing/scoring-weights.ts SCORING_WEIGHTS_V1
 */

import { SCORING_WEIGHTS_V1 } from "./scoring-weights.js";
import type { MemorySemanticType } from "../domain/types.js";

/** sourceKind 映射到 sourceAuthority（6 档） */
export type SourceKind =
  | "rule_file"
  | "session_user"
  | "work_log"
  | "document"
  | "tool_result"
  | "agent_output";

/** importance 各分量原始信号 */
export interface ImportanceSignals {
  /** LLM 给的原始 salience（0-1） */
  salience_llm: number;
  /** 来源权威度（由 sourceKind 映射） */
  sourceKind: SourceKind;
  /** 是否显式记忆请求（0/1） */
  explicitSave: boolean;
  /** 记忆语义类型（5 type） */
  semanticType: MemorySemanticType;
}

/** 辅助：将值约束到 [0,1] */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 显式记忆请求检测正则（§4.2）
 *
 * 命中即视为用户明确要求记住，explicitnessBonus = 1.0，否则 0。
 * 同时覆盖中英文表达：记住 / 以后都 / remember / don't forget。
 */
export const EXPLICIT_SAVE_PATTERN = /记住|以后都|remember|don'?t forget/i;

/**
 * 从记忆文本检测 explicitnessBonus（§4.2）
 *
 * @param text 记忆原始文本（可能为空）
 * @returns 命中显式记忆请求模式返回 true
 */
export function detectExplicitSave(text: string | undefined | null): boolean {
  if (!text) return false;
  return EXPLICIT_SAVE_PATTERN.test(text);
}

/**
 * 获取来源权威度（6 档，§4.2）
 */
export function getSourceAuthority(sourceKind: SourceKind): number {
  return SCORING_WEIGHTS_V1.sourceAuthority[sourceKind];
}

/**
 * 获取类型先验（5 type，§4.2）
 */
export function getTypePrior(semanticType: MemorySemanticType): number {
  return SCORING_WEIGHTS_V1.typePrior[semanticType];
}

/**
 * 计算 importance（召回排序 + 树路由用）
 *
 * 公式（§4.2）：
 * ```
 * importance = clamp(0, 1,
 *     w1 * salience_llm
 *   + w2 * sourceAuthority
 *   + w3 * explicitnessBonus
 *   + w4 * typePrior
 * )
 * ```
 *
 * @param signals 4 项原始信号
 * @returns importance ∈ [0,1]
 */
export function computeImportance(signals: ImportanceSignals): number {
  const w = SCORING_WEIGHTS_V1.importance;

  const salience = clamp01(signals.salience_llm);
  const authority = getSourceAuthority(signals.sourceKind);
  const explicitBonus = signals.explicitSave ? 1.0 : 0.0;
  const typePrior = getTypePrior(signals.semanticType);

  const score =
    w.w1_salience * salience +
    w.w2_authority * authority +
    w.w3_explicit * explicitBonus +
    w.w4_type * typePrior;

  return clamp01(score);
}

/**
 * 计算 importance 并返回明细（用于可解释性 / explain / eval）
 *
 * @returns { score: number, breakdown: Record<分量, 贡献值> }
 */
export function computeImportanceWithBreakdown(signals: ImportanceSignals): {
  score: number;
  breakdown: {
    salience_llm: number;
    sourceAuthority: number;
    explicitnessBonus: number;
    typePrior: number;
  };
} {
  const w = SCORING_WEIGHTS_V1.importance;

  const salience = clamp01(signals.salience_llm);
  const authority = getSourceAuthority(signals.sourceKind);
  const explicitBonus = signals.explicitSave ? 1.0 : 0.0;
  const typePrior = getTypePrior(signals.semanticType);

  const breakdown = {
    salience_llm: w.w1_salience * salience,
    sourceAuthority: w.w2_authority * authority,
    explicitnessBonus: w.w3_explicit * explicitBonus,
    typePrior: w.w4_type * typePrior,
  };

  const score = clamp01(
    breakdown.salience_llm +
      breakdown.sourceAuthority +
      breakdown.explicitnessBonus +
      breakdown.typePrior,
  );

  return { score, breakdown };
}
