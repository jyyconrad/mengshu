/**
 * valueScore 8 维加权公式单元测试（§4.1）
 *
 * 覆盖：
 * - 权重从 SCORING_WEIGHTS_V1 正确读取
 * - 8 维独立加权计算正确
 * - riskPenalty 取负号（D-01）
 * - 归一化到 [0,1]
 * - breakdown 明细计算
 */

import { describe, it, expect } from "vitest";
import {
  computeValueScore,
  computeValueScoreWithBreakdown,
  type ValueScoreSignals,
} from "./value-score";
import { SCORING_WEIGHTS_V1 } from "./scoring-weights";

describe("valueScore 8 维加权（§4.1）", () => {
  it("全 1 信号应得最高分（不含 riskPenalty）", () => {
    const signals: ValueScoreSignals = {
      explicitness: 1,
      durability: 1,
      actionability: 1,
      specificity: 1,
      evidence: 1,
      scopeFit: 1,
      novelty: 1,
      riskPenalty: 0, // 无风险
    };

    const score = computeValueScore(signals);
    // 7 个正向维度权重和 = 1.05（包含所有正向权重）
    // 实际 explicitness~novelty 权重和 = 0.95（D-01 说明）
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("riskPenalty 应作为负贡献（D-01：-0.15）", () => {
    const noRisk: ValueScoreSignals = {
      explicitness: 0.5,
      durability: 0.5,
      actionability: 0.5,
      specificity: 0.5,
      evidence: 0.5,
      scopeFit: 0.5,
      novelty: 0.5,
      riskPenalty: 0,
    };

    const highRisk: ValueScoreSignals = {
      ...noRisk,
      riskPenalty: 1.0, // 最高风险
    };

    const scoreNoRisk = computeValueScore(noRisk);
    const scoreHighRisk = computeValueScore(highRisk);

    // riskPenalty = 1.0 应减少 0.15 分
    expect(scoreNoRisk - scoreHighRisk).toBeCloseTo(0.15, 2);
  });

  it("explicitness 权重最高（0.18）", () => {
    expect(SCORING_WEIGHTS_V1.valueScore.explicitness).toBe(0.18);

    const onlyExplicit: ValueScoreSignals = {
      explicitness: 1,
      durability: 0,
      actionability: 0,
      specificity: 0,
      evidence: 0,
      scopeFit: 0,
      novelty: 0,
      riskPenalty: 0,
    };

    const score = computeValueScore(onlyExplicit);
    expect(score).toBeCloseTo(0.18, 6);
  });

  it("各维度权重与 SCORING_WEIGHTS_V1 一致", () => {
    const w = SCORING_WEIGHTS_V1.valueScore;
    expect(w.explicitness).toBe(0.18);
    expect(w.durability).toBe(0.17);
    expect(w.actionability).toBe(0.17);
    expect(w.specificity).toBe(0.14);
    expect(w.evidence).toBe(0.12);
    expect(w.scopeFit).toBe(0.1);
    expect(w.novelty).toBe(0.07);
    expect(w.riskPenalty).toBe(0.15); // 常量存正值，消费时取负
  });

  it("超出 [0,1] 的信号应被 clamp", () => {
    const overRange: ValueScoreSignals = {
      explicitness: 5, // 超范围
      durability: 1,
      actionability: 1,
      specificity: 1,
      evidence: 1,
      scopeFit: 1,
      novelty: 1,
      riskPenalty: 0,
    };

    const score = computeValueScore(overRange);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("breakdown 明细各维度贡献和应等于 score", () => {
    const signals: ValueScoreSignals = {
      explicitness: 0.8,
      durability: 0.6,
      actionability: 0.7,
      specificity: 0.5,
      evidence: 0.9,
      scopeFit: 0.4,
      novelty: 0.3,
      riskPenalty: 0.2,
    };

    const { score, breakdown } = computeValueScoreWithBreakdown(signals);

    const sumBreakdown =
      breakdown.explicitness +
      breakdown.durability +
      breakdown.actionability +
      breakdown.specificity +
      breakdown.evidence +
      breakdown.scopeFit +
      breakdown.novelty +
      breakdown.riskPenalty; // 已是负值

    expect(score).toBeCloseTo(Math.max(0, Math.min(1, sumBreakdown)), 6);
  });

  it("breakdown 中 riskPenalty 应为负值", () => {
    const signals: ValueScoreSignals = {
      explicitness: 0.5,
      durability: 0.5,
      actionability: 0.5,
      specificity: 0.5,
      evidence: 0.5,
      scopeFit: 0.5,
      novelty: 0.5,
      riskPenalty: 0.5,
    };

    const { breakdown } = computeValueScoreWithBreakdown(signals);

    expect(breakdown.riskPenalty).toBeLessThan(0);
    expect(breakdown.riskPenalty).toBeCloseTo(-0.15 * 0.5, 6);
  });

  it("全 0 信号应得 0 分", () => {
    const allZero: ValueScoreSignals = {
      explicitness: 0,
      durability: 0,
      actionability: 0,
      specificity: 0,
      evidence: 0,
      scopeFit: 0,
      novelty: 0,
      riskPenalty: 0,
    };

    const score = computeValueScore(allZero);
    expect(score).toBe(0);
  });

  it("7 个正向维度权重和应为 0.95（不含 riskPenalty）", () => {
    const w = SCORING_WEIGHTS_V1.valueScore;
    const sum =
      w.explicitness +
      w.durability +
      w.actionability +
      w.specificity +
      w.evidence +
      w.scopeFit +
      w.novelty;

    expect(sum).toBeCloseTo(0.95, 10);
  });
});
