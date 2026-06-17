/**
 * admission-decision.ts — 候选准入路由决策（P1-Q4）
 *
 * 用途：基于 valueScore 8 维加权公式（§4.1）和准入阈值带（§6.2 D-02），
 * 将候选路由到 AdmissionRoute（drop / candidate_low_priority / candidate / active /
 * lookup_only / evidence_only），替换旧的 confidence-based decideAdmission。
 *
 * 核心设计：
 * - 计算 valueScore（8 维加权，processing/value-score.ts）
 * - 按阈值带路由（§6.2 决策树）：
 *   - < 0.40 → drop
 *   - 0.40–0.55 → candidate_low_priority（TTL=30d）
 *   - 0.55–0.88 → candidate（TTL=90d）
 *   - >= 0.88 且无冲突且高显式度 → active
 * - 特殊快速通道：explicitSave=true / sourceKind=rule_file → 即时晋升 active
 * - 安全降级：prompt_injection → evidence_only
 *
 * 设计依据：docs/04-design/04.2-detail/memory-system-unified-design.md §6.2
 * 替换对象：lifecycle/candidate-types.ts decideAdmission（旧 confidence 逻辑）
 */

import type { AdmissionRoute } from "../core/types.js";
import type { ValidatedCandidate } from "./candidate-validator.js";
import { computeValueScore, computeValueScoreWithBreakdown } from "../processing/value-score.js";
import { deriveValueScoreSignals } from "../processing/value-score-signals.js";

/**
 * 准入阈值带（§6.2 D-02 定稿，v1.0）
 *
 * 变更需经 ADR 批准，与候选区容量约束（maxCandidatesPerSession=50 / TTL）配套。
 */
export const ADMISSION_THRESHOLDS = {
  /** valueScore < DROP_THRESHOLD → 不值得记，drop 不入库 */
  DROP_THRESHOLD: 0.4,
  /** valueScore >= LOW_PRIORITY_THRESHOLD → candidate_low_priority（TTL=30d） */
  LOW_PRIORITY_THRESHOLD: 0.4,
  /** valueScore >= CANDIDATE_THRESHOLD → candidate（TTL=90d） */
  CANDIDATE_THRESHOLD: 0.55,
  /** valueScore >= ACTIVE_THRESHOLD 且满足快速通道条件 → active */
  ACTIVE_THRESHOLD: 0.88,
  /** explicitness >= EXPLICITNESS_THRESHOLD 作为 active 快速通道条件之一 */
  EXPLICITNESS_THRESHOLD: 0.8,
} as const;

/**
 * 准入决策上下文（调用方提供的外部信号）
 */
export interface AdmissionContext {
  /** 抽取意图（remember=显式保存，auto=自动抽取） */
  intent?: string;
  /** 来源类型（rule_file 快速通道） */
  sourceKind?: "rule_file" | "session_user" | "work_log" | "document" | "tool_result" | "agent_output";
  /** 是否检测到冲突（冲突时阻止自动晋升 active） */
  hasConflict?: boolean;
}

/**
 * 准入决策结果（含路由 + 可解释性字段）
 */
export interface AdmissionDecisionResult {
  /** 路由结果（drop/candidate_low_priority/candidate/active/evidence_only） */
  route: AdmissionRoute;
  /** valueScore 综合分 [0,1] */
  valueScore: number;
  /** 路由原因（可追溯） */
  reason: string;
  /**
   * valueScore 8 维明细（可选，用于 explain/eval）
   * 仅在调用 decideAdmissionWithBreakdown 时提供。
   */
  breakdown?: Record<string, number>;
}

/**
 * 候选准入路由决策（P1-Q4 核心入口）
 *
 * 决策树（§6.2）：
 * ```
 * input → validator pass → valueScore 计算
 *   if prompt_injection 命中           → evidence_only（不执行指令）
 *   if valueScore < 0.40               → drop
 *   if explicitSave=true
 *    OR sourceKind=rule_file           → active（快速通道）
 *   if valueScore >= 0.88
 *    AND !conflict
 *    AND explicitness > 0.80           → active
 *   if 0.55 <= valueScore < 0.88       → candidate（pending）
 *   if 0.40 <= valueScore < 0.55       → candidate_low_priority（pending, low_priority）
 * ```
 *
 * @param candidate validator 裁决后的候选（含 salience/temporality/targetScope/riskFlags）
 * @param context 准入上下文（intent/sourceKind/hasConflict）
 * @returns 路由结果 + valueScore + 原因
 */
export function decideAdmission(
  candidate: ValidatedCandidate,
  context: AdmissionContext = {},
): AdmissionDecisionResult {
  // 安全优先：prompt_injection 标记的候选降级为 evidence_only（§6.2 / §4.7）
  if (candidate.riskFlags.includes("prompt_injection")) {
    return {
      route: "evidence_only",
      valueScore: 0,
      reason: "prompt_injection_detected",
    };
  }

  // 已被 validator 降级 evidence-only 的候选（闸门 8/9 泛词过滤）
  if (candidate.evidenceOnly) {
    return {
      route: "evidence_only",
      valueScore: 0,
      reason: "evidence_only_by_validator",
    };
  }

  // 计算 valueScore（8 维加权）
  const signals = deriveValueScoreSignals(candidate, context);
  const valueScore = computeValueScore(signals);

  // 阈值路由：< 0.40 → drop
  if (valueScore < ADMISSION_THRESHOLDS.DROP_THRESHOLD) {
    return {
      route: "drop",
      valueScore,
      reason: "value_score_below_threshold",
    };
  }

  // 快速通道 1：显式保存（memory_store 工具 intent=remember）
  if (context.intent === "remember") {
    return {
      route: "active",
      valueScore,
      reason: "explicit_save_fast_track",
    };
  }

  // 快速通道 2：rule_file 来源（高权威，直接晋升）
  if (context.sourceKind === "rule_file") {
    return {
      route: "active",
      valueScore,
      reason: "rule_file_fast_track",
    };
  }

  // 高置信自动晋升：valueScore >= 0.88 且无冲突且高显式度
  if (
    valueScore >= ADMISSION_THRESHOLDS.ACTIVE_THRESHOLD &&
    !context.hasConflict &&
    signals.explicitness >= ADMISSION_THRESHOLDS.EXPLICITNESS_THRESHOLD
  ) {
    return {
      route: "active",
      valueScore,
      reason: "high_value_score_auto_promote",
    };
  }

  // 普通候选：0.55–0.88 → candidate
  if (valueScore >= ADMISSION_THRESHOLDS.CANDIDATE_THRESHOLD) {
    return {
      route: "candidate",
      valueScore,
      reason: "medium_value_score",
    };
  }

  // 低优先候选：0.40–0.55 → candidate_low_priority
  return {
    route: "candidate_low_priority",
    valueScore,
    reason: "low_priority_value_score",
  };
}

/**
 * 候选准入路由决策（含 valueScore 8 维明细，用于 explain/eval）
 *
 * 与 decideAdmission 同算法，额外输出 8 维 breakdown（explicitness/durability/
 * actionability/specificity/evidence/scopeFit/novelty/riskPenalty），便于追溯打分来源。
 *
 * @param candidate validator 裁决后的候选
 * @param context 准入上下文
 * @returns 路由结果 + valueScore + 8 维明细 + 原因
 */
export function decideAdmissionWithBreakdown(
  candidate: ValidatedCandidate,
  context: AdmissionContext = {},
): AdmissionDecisionResult {
  // 安全优先：prompt_injection / evidence-only 快速返回
  if (candidate.riskFlags.includes("prompt_injection")) {
    return {
      route: "evidence_only",
      valueScore: 0,
      reason: "prompt_injection_detected",
      breakdown: {},
    };
  }

  if (candidate.evidenceOnly) {
    return {
      route: "evidence_only",
      valueScore: 0,
      reason: "evidence_only_by_validator",
      breakdown: {},
    };
  }

  // 计算 valueScore + 8 维明细
  const signals = deriveValueScoreSignals(candidate, context);
  const { score: valueScore, breakdown } = computeValueScoreWithBreakdown(signals);

  // 复用 decideAdmission 的路由逻辑（避免代码重复）
  const baseResult = decideAdmission(candidate, context);

  return {
    ...baseResult,
    valueScore,
    breakdown,
  };
}
