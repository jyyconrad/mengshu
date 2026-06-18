/**
 * importance 4 项加权公式单元测试（§4.2）
 *
 * 覆盖：
 * - 权重从 SCORING_WEIGHTS_V1 正确读取
 * - 4 项加权计算正确
 * - sourceAuthority 6 档映射
 * - typePrior 5 type 映射
 * - 归一化到 [0,1]
 * - breakdown 明细计算
 */

import { describe, it, expect } from "vitest";
import {
  computeImportance,
  computeImportanceWithBreakdown,
  getSourceAuthority,
  getTypePrior,
  detectExplicitSave,
  type ImportanceSignals,
} from "./importance-score";
import { SCORING_WEIGHTS_V1 } from "./scoring-weights";

describe("importance 4 项加权（§4.2）", () => {
  it("4 项权重和应为 1.0", () => {
    const w = SCORING_WEIGHTS_V1.importance;
    const sum = w.w1_salience + w.w2_authority + w.w3_explicit + w.w4_type;
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("salience 权重最高（0.45）", () => {
    expect(SCORING_WEIGHTS_V1.importance.w1_salience).toBe(0.45);
  });

  it("高 salience 应得高分", () => {
    const highSalience: ImportanceSignals = {
      salience_llm: 0.9,
      sourceKind: "session_user",
      explicitSave: false,
      semanticType: "profile",
    };

    const lowSalience: ImportanceSignals = {
      ...highSalience,
      salience_llm: 0.1,
    };

    expect(computeImportance(highSalience)).toBeGreaterThan(computeImportance(lowSalience));
  });

  it("sourceAuthority 6 档映射正确", () => {
    expect(getSourceAuthority("rule_file")).toBe(1.0);
    expect(getSourceAuthority("session_user")).toBe(0.8);
    expect(getSourceAuthority("work_log")).toBe(0.6);
    expect(getSourceAuthority("document")).toBe(0.5);
    expect(getSourceAuthority("tool_result")).toBe(0.4);
    expect(getSourceAuthority("agent_output")).toBe(0.3);
  });

  it("typePrior 5 type 映射正确", () => {
    expect(getTypePrior("rules")).toBe(1.0);
    expect(getTypePrior("profile")).toBe(0.9);
    expect(getTypePrior("task_context")).toBe(0.7);
    expect(getTypePrior("resource")).toBe(0.6);
    expect(getTypePrior("experience")).toBe(0.5);
  });

  it("explicitSave=true 应提升分数", () => {
    const withExplicit: ImportanceSignals = {
      salience_llm: 0.5,
      sourceKind: "session_user",
      explicitSave: true,
      semanticType: "profile",
    };

    const withoutExplicit: ImportanceSignals = {
      ...withExplicit,
      explicitSave: false,
    };

    const scoreWith = computeImportance(withExplicit);
    const scoreWithout = computeImportance(withoutExplicit);

    // explicit 权重是 0.20
    expect(scoreWith - scoreWithout).toBeCloseTo(0.2, 6);
  });

  it("rules type 应得最高 typePrior 加分", () => {
    const rules: ImportanceSignals = {
      salience_llm: 0.5,
      sourceKind: "session_user",
      explicitSave: false,
      semanticType: "rules",
    };

    const experience: ImportanceSignals = {
      ...rules,
      semanticType: "experience",
    };

    expect(computeImportance(rules)).toBeGreaterThan(computeImportance(experience));
  });

  it("rule_file + rules + explicitSave 应得最高分", () => {
    const maxSignals: ImportanceSignals = {
      salience_llm: 1.0,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "rules",
    };

    const score = computeImportance(maxSignals);
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("全 0 信号应得较低分（但 authority/typePrior 有最小值）", () => {
    const minSignals: ImportanceSignals = {
      salience_llm: 0,
      sourceKind: "agent_output", // 最低权威度 0.3
      explicitSave: false,
      semanticType: "experience", // 最低类型先验 0.5
    };

    const score = computeImportance(minSignals);
    // w2 * 0.3 + w4 * 0.5 = 0.2 * 0.3 + 0.15 * 0.5 = 0.06 + 0.075 = 0.135
    expect(score).toBeCloseTo(0.135, 2);
  });

  it("breakdown 明细各分量和应等于 score", () => {
    const signals: ImportanceSignals = {
      salience_llm: 0.7,
      sourceKind: "work_log",
      explicitSave: true,
      semanticType: "task_context",
    };

    const { score, breakdown } = computeImportanceWithBreakdown(signals);

    const sumBreakdown =
      breakdown.salience_llm +
      breakdown.sourceAuthority +
      breakdown.explicitnessBonus +
      breakdown.typePrior;

    expect(score).toBeCloseTo(sumBreakdown, 6);
  });

  it("breakdown 应正确反映各分量贡献", () => {
    const signals: ImportanceSignals = {
      salience_llm: 0.8,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "profile",
    };

    const { breakdown } = computeImportanceWithBreakdown(signals);
    const w = SCORING_WEIGHTS_V1.importance;

    expect(breakdown.salience_llm).toBeCloseTo(w.w1_salience * 0.8, 6);
    expect(breakdown.sourceAuthority).toBeCloseTo(w.w2_authority * 1.0, 6); // rule_file=1.0
    expect(breakdown.explicitnessBonus).toBeCloseTo(w.w3_explicit * 1.0, 6);
    expect(breakdown.typePrior).toBeCloseTo(w.w4_type * 0.9, 6); // profile=0.9
  });

  it("超出 [0,1] 的 salience 应被 clamp", () => {
    const overRange: ImportanceSignals = {
      salience_llm: 5, // 超范围
      sourceKind: "session_user",
      explicitSave: false,
      semanticType: "profile",
    };

    const score = computeImportance(overRange);
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThanOrEqual(0);
  });

  it("各权重系数与设计文档一致", () => {
    const w = SCORING_WEIGHTS_V1.importance;
    expect(w.w1_salience).toBe(0.45);
    expect(w.w2_authority).toBe(0.2);
    expect(w.w3_explicit).toBe(0.2);
    expect(w.w4_type).toBe(0.15);
  });
});

describe("detectExplicitSave 显式记忆请求检测（§4.2）", () => {
  it("命中中文'记住'", () => {
    expect(detectExplicitSave("请记住我喜欢深色主题")).toBe(true);
  });

  it("命中中文'以后都'", () => {
    expect(detectExplicitSave("以后都用 TypeScript")).toBe(true);
  });

  it("命中英文'remember'（大小写不敏感）", () => {
    expect(detectExplicitSave("Remember my API key prefix")).toBe(true);
    expect(detectExplicitSave("please remember this")).toBe(true);
  });

  it("命中'don't forget' 和 'dont forget'", () => {
    expect(detectExplicitSave("don't forget the deadline")).toBe(true);
    expect(detectExplicitSave("dont forget the deadline")).toBe(true);
  });

  it("未命中普通文本返回 false", () => {
    expect(detectExplicitSave("今天天气不错")).toBe(false);
    expect(detectExplicitSave("the build passed")).toBe(false);
  });

  it("空/缺失文本返回 false", () => {
    expect(detectExplicitSave("")).toBe(false);
    expect(detectExplicitSave(undefined)).toBe(false);
    expect(detectExplicitSave(null)).toBe(false);
  });
});
