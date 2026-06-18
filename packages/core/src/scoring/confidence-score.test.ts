/**
 * confidence 多证据贝叶斯累积公式单元测试（§4.3）
 *
 * 覆盖：
 * - 无证据时退化为 type 先验 base_type
 * - 单条证据 reliability = sourceAuthority * 0.6
 * - 多证据连乘逼近 1.0（贝叶斯更新）
 * - 单调非降性质
 * - 顺序无关
 * - 归一化到 [0,1]
 * - breakdown 明细
 * - 与 §4.3 参考实现逐位一致
 */

import { describe, it, expect } from "vitest";
import {
  computeConfidence,
  computeConfidenceWithBreakdown,
  getTypeBaseConfidence,
  evidenceReliability,
  RELIABILITY_FACTOR,
  type ConfidenceEvidence,
} from "./confidence-score";
import { SCORING_WEIGHTS_V1 } from "./scoring-weights";
import { getSourceAuthority } from "./importance-score";
import type { MemorySemanticType } from "../domain/types";

/** §4.3 参考实现（独立复现，用于交叉验证） */
function referenceConfidence(
  type: MemorySemanticType,
  evidences: readonly ConfidenceEvidence[],
): number {
  const base = SCORING_WEIGHTS_V1.typeBaseConfidence[type];
  let pNotTrue = 1 - base;
  for (const e of evidences) {
    pNotTrue *= 1 - getSourceAuthority(e.sourceKind) * 0.6;
  }
  return Math.min(1, Math.max(0, 1 - pNotTrue));
}

describe("confidence 多证据累积（§4.3）", () => {
  it("RELIABILITY_FACTOR 应为 0.6", () => {
    expect(RELIABILITY_FACTOR).toBe(0.6);
  });

  it("无证据时退化为 type 先验 base_type", () => {
    const types: MemorySemanticType[] = [
      "rules",
      "profile",
      "task_context",
      "resource",
      "experience",
    ];
    for (const type of types) {
      expect(computeConfidence(type, [])).toBeCloseTo(getTypeBaseConfidence(type), 10);
    }
  });

  it("rules 基础置信为 0.5", () => {
    expect(getTypeBaseConfidence("rules")).toBe(0.5);
  });

  it("单条证据 reliability = sourceAuthority * 0.6", () => {
    // rule_file authority=1.0 -> reliability=0.6
    expect(evidenceReliability({ sourceKind: "rule_file" })).toBeCloseTo(0.6, 10);
    // session_user authority=0.8 -> reliability=0.48
    expect(evidenceReliability({ sourceKind: "session_user" })).toBeCloseTo(0.48, 10);
    // agent_output authority=0.3 -> reliability=0.18
    expect(evidenceReliability({ sourceKind: "agent_output" })).toBeCloseTo(0.18, 10);
  });

  it("单条权威证据：base=0.5，reliability=0.6 -> 1-(1-0.5)(1-0.6)=0.8", () => {
    const score = computeConfidence("rules", [{ sourceKind: "rule_file" }]);
    expect(score).toBeCloseTo(0.8, 10);
  });

  it("多条独立证据快速逼近 1.0（贝叶斯连乘）", () => {
    const single = computeConfidence("rules", [{ sourceKind: "rule_file" }]);
    const triple = computeConfidence("rules", [
      { sourceKind: "rule_file" },
      { sourceKind: "rule_file" },
      { sourceKind: "rule_file" },
    ]);
    // 1-(0.5)(0.4)^3 = 1 - 0.032 = 0.968
    expect(triple).toBeCloseTo(0.968, 10);
    expect(triple).toBeGreaterThan(single);
    expect(triple).toBeLessThan(1.0);
  });

  it("增加一条 reliability>0 的证据 confidence 单调非降", () => {
    const evidences: ConfidenceEvidence[] = [];
    let prev = computeConfidence("experience", evidences);
    for (const sourceKind of ["agent_output", "tool_result", "document", "session_user"] as const) {
      evidences.push({ sourceKind });
      const next = computeConfidence("experience", evidences);
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
  });

  it("证据顺序无关（连乘可交换）", () => {
    const a = computeConfidence("profile", [
      { sourceKind: "rule_file" },
      { sourceKind: "agent_output" },
      { sourceKind: "document" },
    ]);
    const b = computeConfidence("profile", [
      { sourceKind: "document" },
      { sourceKind: "rule_file" },
      { sourceKind: "agent_output" },
    ]);
    expect(a).toBeCloseTo(b, 12);
  });

  it("结果始终落在 [0,1]", () => {
    const many: ConfidenceEvidence[] = Array.from({ length: 50 }, () => ({
      sourceKind: "rule_file" as const,
    }));
    const score = computeConfidence("rules", many);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it("与 §4.3 参考实现逐位一致", () => {
    const cases: Array<[MemorySemanticType, ConfidenceEvidence[]]> = [
      ["rules", []],
      ["profile", [{ sourceKind: "session_user" }]],
      ["task_context", [{ sourceKind: "work_log" }, { sourceKind: "tool_result" }]],
      [
        "resource",
        [{ sourceKind: "document" }, { sourceKind: "document" }, { sourceKind: "agent_output" }],
      ],
      ["experience", [{ sourceKind: "rule_file" }, { sourceKind: "session_user" }]],
    ];
    for (const [type, evidences] of cases) {
      expect(computeConfidence(type, evidences)).toBeCloseTo(
        referenceConfidence(type, evidences),
        12,
      );
    }
  });

  describe("breakdown 明细", () => {
    it("无证据时 baseConfidence = score = 先验", () => {
      const { score, baseConfidence, evidenceReliabilities } = computeConfidenceWithBreakdown(
        "resource",
        [],
      );
      expect(baseConfidence).toBe(0.4);
      expect(score).toBeCloseTo(0.4, 10);
      expect(evidenceReliabilities).toEqual([]);
    });

    it("evidenceReliabilities 与输入顺序对应", () => {
      const { evidenceReliabilities } = computeConfidenceWithBreakdown("rules", [
        { sourceKind: "rule_file" },
        { sourceKind: "agent_output" },
      ]);
      expect(evidenceReliabilities).toHaveLength(2);
      expect(evidenceReliabilities[0]).toBeCloseTo(0.6, 10);
      expect(evidenceReliabilities[1]).toBeCloseTo(0.18, 10);
    });

    it("breakdown.score 与 computeConfidence 一致", () => {
      const evidences: ConfidenceEvidence[] = [
        { sourceKind: "session_user" },
        { sourceKind: "document" },
      ];
      const { score } = computeConfidenceWithBreakdown("profile", evidences);
      expect(score).toBeCloseTo(computeConfidence("profile", evidences), 12);
    });
  });
});
