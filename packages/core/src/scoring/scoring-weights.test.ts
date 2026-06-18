import { describe, it, expect } from "vitest";
import { SCORING_WEIGHTS_V1 } from "./scoring-weights";

// 四套评分体系权重固化测试（D-10/D-11）
// 事实来源：docs/04-design/04.2-detail/memory-system-unified-design.md §4.6
// 断言权重与设计 §4.6 代码块逐字段完全一致。

describe("SCORING_WEIGHTS_V1", () => {
  it("version 固定为 v1.0", () => {
    expect(SCORING_WEIGHTS_V1.version).toBe("v1.0");
  });

  describe("valueScore（8 维加权，§4.1/§4.6）", () => {
    const valueScoreCases: ReadonlyArray<[string, number]> = [
      ["explicitness", 0.18],
      ["durability", 0.17],
      ["actionability", 0.17],
      ["specificity", 0.14],
      ["evidence", 0.12],
      ["scopeFit", 0.1],
      ["novelty", 0.07],
      ["riskPenalty", 0.15], // D-01：常量存 0.15，消费方取负 -0.15
    ];

    it.each(valueScoreCases)("%s = %f", (key, expected) => {
      expect(
        SCORING_WEIGHTS_V1.valueScore[key as keyof typeof SCORING_WEIGHTS_V1.valueScore],
      ).toBe(expected);
    });

    it("7 个正向维度权重和 = 0.95（不含 riskPenalty）", () => {
      const v = SCORING_WEIGHTS_V1.valueScore;
      const sum =
        v.explicitness +
        v.durability +
        v.actionability +
        v.specificity +
        v.evidence +
        v.scopeFit +
        v.novelty;
      expect(sum).toBeCloseTo(0.95, 10);
    });
  });

  describe("importance（4 项加权，§4.2/§4.6）", () => {
    const importanceCases: ReadonlyArray<[string, number]> = [
      ["w1_salience", 0.45],
      ["w2_authority", 0.2],
      ["w3_explicit", 0.2],
      ["w4_type", 0.15],
    ];

    it.each(importanceCases)("%s = %f", (key, expected) => {
      expect(
        SCORING_WEIGHTS_V1.importance[key as keyof typeof SCORING_WEIGHTS_V1.importance],
      ).toBe(expected);
    });

    it("4 项权重和 = 1.0", () => {
      const i = SCORING_WEIGHTS_V1.importance;
      const sum = i.w1_salience + i.w2_authority + i.w3_explicit + i.w4_type;
      expect(sum).toBeCloseTo(1.0, 10);
    });
  });

  describe("sourceAuthority（6 档，§4.2/§4.6）", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["rule_file", 1.0],
      ["session_user", 0.8],
      ["work_log", 0.6],
      ["document", 0.5],
      ["tool_result", 0.4],
      ["agent_output", 0.3],
    ];

    it.each(cases)("%s = %f", (key, expected) => {
      expect(
        SCORING_WEIGHTS_V1.sourceAuthority[
          key as keyof typeof SCORING_WEIGHTS_V1.sourceAuthority
        ],
      ).toBe(expected);
    });
  });

  describe("typePrior（5 type，§4.2/§4.6）", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["rules", 1.0],
      ["profile", 0.9],
      ["task_context", 0.7],
      ["resource", 0.6],
      ["experience", 0.5],
    ];

    it.each(cases)("%s = %f", (key, expected) => {
      expect(
        SCORING_WEIGHTS_V1.typePrior[key as keyof typeof SCORING_WEIGHTS_V1.typePrior],
      ).toBe(expected);
    });
  });

  describe("typeBaseConfidence（5 type，§4.3/§4.6）", () => {
    const cases: ReadonlyArray<[string, number]> = [
      ["rules", 0.5],
      ["profile", 0.45],
      ["task_context", 0.4],
      ["resource", 0.4],
      ["experience", 0.4],
    ];

    it.each(cases)("%s = %f", (key, expected) => {
      expect(
        SCORING_WEIGHTS_V1.typeBaseConfidence[
          key as keyof typeof SCORING_WEIGHTS_V1.typeBaseConfidence
        ],
      ).toBe(expected);
    });
  });

  describe("hotness（5 项，§4.4/§4.6）", () => {
    it("各系数与 §4.6 一致", () => {
      const h = SCORING_WEIGHTS_V1.hotness;
      expect(h.ln_mention_coeff).toBe(1.0);
      expect(h.distinct_source_coeff).toBe(0.5);
      expect(h.centrality_coeff).toBe(1.0);
      expect(h.query_hits_coeff).toBe(2.0);
    });

    it("recency_decay_buckets 分段与 §4.4 遗忘曲线一致", () => {
      expect(SCORING_WEIGHTS_V1.hotness.recency_decay_buckets).toEqual([
        [1, 1.0],
        [7, 0.5],
        [30, 0.0],
      ]);
    });
  });
});
