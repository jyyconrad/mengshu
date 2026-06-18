/**
 * confidence 多证据累积公式（§4.3 贝叶斯更新）
 *
 * `confidence` 表示"系统对记忆为真的把握"，随证据累积上升
 * （Clark & Brennan 1991 common ground 的工程化：反复确认建立共识）。
 *
 * 公式（§4.3）：
 * ```
 * confidence(n) = 1 - (1 - base_type) * Π_{i=1..n}(1 - reliability_i)
 *   base_type:      该 type 的先验置信（typeBaseConfidence）
 *   reliability_i = sourceAuthority(evidence_i) * 0.6
 * ```
 *
 * 直觉：单条 evidence 给中等置信，多条独立来源的相同结论快速逼近 1.0。
 * 这是独立事件"都不发生"概率连乘的贝叶斯更新形式——每条 evidence 把
 * "记忆为假"的剩余概率按 (1 - reliability_i) 衰减。
 *
 * 事实来源：docs/04-design/04.2-detail/memory-system-unified-design.md §4.3
 * 权重固化：processing/scoring-weights.ts SCORING_WEIGHTS_V1
 *
 * 适用范围：memory candidate 的 confidence 用本式（可复现、可单测）。
 * LLM 路径的 relation.confidence 仍由 LLM 给出（保留现状，§4.3 说明）。
 */

import { SCORING_WEIGHTS_V1 } from "./scoring-weights.js";
import { getSourceAuthority, type SourceKind } from "./importance-score.js";
import type { MemorySemanticType } from "../core/types.js";

/**
 * reliability 折扣系数：reliability_i = sourceAuthority * RELIABILITY_FACTOR。
 *
 * §4.3 固定为 0.6——即使最权威来源（rule_file=1.0）单条 evidence 的
 * reliability 也只有 0.6，确保单次提及不直接拉满，需多条印证才逼近 1.0。
 */
export const RELIABILITY_FACTOR = 0.6;

/**
 * confidence 累积的单条证据。
 *
 * 仅需 sourceKind 即可推导 reliability；具体引用文本/事件 id 的溯源
 * 由 CandidateEvidence 负责，二者职责分离。
 */
export interface ConfidenceEvidence {
  /** 证据来源类别，映射到 sourceAuthority（6 档）。 */
  sourceKind: SourceKind;
}

/** 辅助：将值约束到 [0,1]。 */
function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * 获取某 type 的基础置信（confidence 累积起点，§4.3）。
 */
export function getTypeBaseConfidence(semanticType: MemorySemanticType): number {
  return SCORING_WEIGHTS_V1.typeBaseConfidence[semanticType];
}

/**
 * 单条证据的 reliability（§4.3）：
 * ```
 * reliability_i = sourceAuthority(evidence_i) * RELIABILITY_FACTOR
 * ```
 */
export function evidenceReliability(evidence: ConfidenceEvidence): number {
  return getSourceAuthority(evidence.sourceKind) * RELIABILITY_FACTOR;
}

/**
 * 计算 confidence（多证据贝叶斯累积，§4.3）。
 *
 * ```
 * pNotTrue = 1 - base_type
 * for each evidence:
 *   pNotTrue *= (1 - reliability_i)
 * confidence = clamp(0, 1, 1 - pNotTrue)
 * ```
 *
 * 性质：
 * - 无证据时 confidence = base_type（先验）。
 * - 单调非降：每增加一条 reliability > 0 的证据，confidence 不降。
 * - 收敛：多条独立证据令 pNotTrue 连乘趋 0，confidence 逼近 1.0。
 *
 * @param semanticType 记忆语义类型（决定 base_type 先验）
 * @param evidences 证据列表（顺序无关，可为空）
 * @returns confidence ∈ [0,1]
 */
export function computeConfidence(
  semanticType: MemorySemanticType,
  evidences: readonly ConfidenceEvidence[],
): number {
  const base = getTypeBaseConfidence(semanticType);

  let pNotTrue = 1 - base;
  for (const evidence of evidences) {
    const reliability = clamp01(evidenceReliability(evidence));
    pNotTrue *= 1 - reliability;
  }

  return clamp01(1 - pNotTrue);
}

/**
 * 计算 confidence 并返回明细（用于可解释性 / explain / eval）。
 *
 * @returns
 * - score: 最终 confidence
 * - baseConfidence: type 先验起点
 * - evidenceReliabilities: 每条证据的 reliability（与输入顺序对应）
 */
export function computeConfidenceWithBreakdown(
  semanticType: MemorySemanticType,
  evidences: readonly ConfidenceEvidence[],
): {
  score: number;
  baseConfidence: number;
  evidenceReliabilities: number[];
} {
  const base = getTypeBaseConfidence(semanticType);

  const evidenceReliabilities: number[] = [];
  let pNotTrue = 1 - base;
  for (const evidence of evidences) {
    const reliability = clamp01(evidenceReliability(evidence));
    evidenceReliabilities.push(reliability);
    pNotTrue *= 1 - reliability;
  }

  return {
    score: clamp01(1 - pNotTrue),
    baseConfidence: base,
    evidenceReliabilities,
  };
}
