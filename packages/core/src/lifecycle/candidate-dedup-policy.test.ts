import { describe, expect, test } from "vitest";

import type { MemoryKind, MemorySemanticType } from "../domain/types.js";
import {
  computeCandidateMaximumSimilarity,
  CANDIDATE_DEDUP_THRESHOLDS,
  canonicalCandidateText,
  candidateLexicalSimilarity,
  evaluateCandidateDedup,
  selectCandidateLexicalThreshold,
  type CandidateDedupComparable,
  type CandidateDedupInput,
} from "./candidate-dedup-policy.js";

function candidate(
  overrides: Partial<CandidateDedupInput["candidate"]> = {},
): CandidateDedupInput["candidate"] {
  return Object.freeze({
    text: "必须运行完整测试",
    vector: Object.freeze([1, 0]),
    salience: 0.8,
    kind: "decision" as MemoryKind,
    semanticType: "experience" as MemorySemanticType,
    ...overrides,
  });
}

function existing(
  id: string,
  overrides: Partial<CandidateDedupComparable> = {},
): CandidateDedupComparable {
  return Object.freeze({
    id,
    text: "默认使用 TypeScript 编写核心模块并运行完整测试",
    vector: Object.freeze([0, 1]),
    kind: "decision" as MemoryKind,
    semanticType: "experience" as MemorySemanticType,
    ...overrides,
  });
}

function evaluate(
  overrides: Partial<CandidateDedupInput> = {},
) {
  return evaluateCandidateDedup({
    candidate: candidate(),
    existingRecords: Object.freeze([]),
    batchRecords: Object.freeze([]),
    ...overrides,
  });
}

function vectorAt(similarity: number): readonly number[] {
  return Object.freeze([similarity, Math.sqrt(1 - similarity ** 2)]);
}

describe("candidate dedup policy", () => {
  test("L0 对规范化文本计算 canonical hash，命中后立即返回 exact duplicate", () => {
    const input = {
      candidate: candidate({ text: "  规则：默认使用 ＴｙｐｅＳｃｒｉｐｔ\\src  " }),
      existingRecords: Object.freeze([
        existing("memory-exact", {
          text: "默认使用 typescript/src",
          vector: undefined,
        }),
      ]),
      batchRecords: Object.freeze([]),
    } satisfies CandidateDedupInput;

    expect(canonicalCandidateText(input.candidate.text)).toBe("默认使用 typescript/src");
    expect(evaluateCandidateDedup(input)).toEqual({
      duplicate: true,
      duplicateOf: "memory-exact",
      layer: "exact",
      similarity: 1,
      reason: "canonical_hash_match",
    });
  });

  test("canonicalization 稳定映射中英文标点，lexical 对单 token/空文本保守", () => {
    expect(canonicalCandidateText(" 偏好：A，B。C！D？E；F：「G」【H】…— ")).toBe(
      "a,b.c!d?e;f:gh...",
    );
    expect(candidateLexicalSimilarity("TypeScript", "typescript")).toBe(1);
    expect(candidateLexicalSimilarity("", "typescript")).toBe(0);
  });

  test("相同文本也不得跨 MemoryKind 或 semanticType 去重", () => {
    const sameText = "必须保留 evidence 追溯";
    const result = evaluate({
      candidate: candidate({ text: sameText, kind: "decision", semanticType: "rules" }),
      existingRecords: Object.freeze([
        existing("wrong-kind", { text: sameText, kind: "fact", semanticType: "rules" }),
        existing("wrong-view", { text: sameText, kind: "decision", semanticType: "task_context" }),
      ]),
    });

    expect(result).toEqual({ duplicate: false, reason: "distinct" });
  });

  test("optional semanticType 只有双方都缺失时才属于同一去重桶", () => {
    const text = "record without a slot semantic type";

    expect(evaluate({
      candidate: candidate({ text, semanticType: undefined, kind: "fact" }),
      existingRecords: Object.freeze([
        existing("kind-only", { text, semanticType: undefined, kind: "fact" }),
      ]),
    })).toMatchObject({ duplicate: true, duplicateOf: "kind-only", layer: "exact" });
  });

  test("D-06 中文短文本 lexical 使用 0.88，不按默认 0.85 误并", () => {
    const left = "一二三四五六七八九十甲乙丙丁戊己";
    const right = "一二三四五六七八九十甲乙丙丁戊庚";

    expect(selectCandidateLexicalThreshold(left)).toBe(0.88);
    expect(evaluate({
      candidate: candidate({ text: left, vector: undefined }),
      existingRecords: Object.freeze([existing("short-cjk", { text: right, vector: undefined })]),
    })).toEqual({ duplicate: false, reason: "distinct" });
  });

  test("默认 lexical 阈值为 0.85，技术词密集但无稳定分类信号时保守不降到 0.78", () => {
    const left = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda";
    const right = "alpha beta gamma delta epsilon zeta eta theta iota kappa sigma";

    expect(CANDIDATE_DEDUP_THRESHOLDS.lexicalDefault).toBe(0.85);
    expect(selectCandidateLexicalThreshold(left)).toBe(0.85);
    expect(evaluate({
      candidate: candidate({ text: left, vector: undefined }),
      existingRecords: Object.freeze([existing("technical", { text: right, vector: undefined })]),
    })).toEqual({ duplicate: false, reason: "distinct" });
  });

  test("L1 lexical 命中时不依赖 embedding", () => {
    const left = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    const right = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi sigma";

    expect(evaluate({
      candidate: candidate({ text: left, vector: undefined }),
      existingRecords: Object.freeze([existing("lexical", { text: right, vector: undefined })]),
    })).toMatchObject({
      duplicate: true,
      duplicateOf: "lexical",
      layer: "lexical",
      reason: "lexical_threshold_met",
    });
  });

  test("rules 极性不一致时即使 lexical 或 cosine 很高也保守保留", () => {
    const text = "所有发布流程必须保留完整验证记录并执行审核以及归档证据和通知负责人并确认部署窗口与回滚方案得到项目负责人批准";

    expect(evaluate({
      candidate: candidate({ text, vector: Object.freeze([1, 0]), semanticType: "rules" }),
      existingRecords: Object.freeze([
        existing("opposite-rule", {
          text: "所有发布流程不得保留完整验证记录并执行审核以及归档证据和通知负责人并确认部署窗口与回滚方案得到项目负责人批准",
          vector: Object.freeze([1, 0]),
          semanticType: "rules",
        }),
      ]),
    })).toEqual({ duplicate: false, reason: "rule_polarity_mismatch" });
  });

  test("rules 未命中 L0/L1 时不以 embedding 自动合并", () => {
    expect(evaluate({
      candidate: candidate({
        text: "发布前必须保留审计证明",
        vector: Object.freeze([1, 0]),
        semanticType: "rules",
      }),
      existingRecords: Object.freeze([
        existing("semantic-rule", {
          text: "每次上线都要完成安全复核",
          vector: Object.freeze([1, 0]),
          semanticType: "rules",
        }),
      ]),
    })).toEqual({ duplicate: false, reason: "rule_semantic_preserved" });
  });

  test("D-16 salience 低于 0.5 时不执行 L2 semantic duplicate", () => {
    expect(evaluate({
      candidate: candidate({ text: "独立文本 A", salience: 0.499, vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("semantic", { text: "完全不同的文本 B", vector: Object.freeze([1, 0]) }),
      ]),
    })).toEqual({ duplicate: false, reason: "semantic_gate_not_met" });
  });

  test("未提供 salience 时可使用 confidence 作为 L2 门控信号", () => {
    expect(evaluate({
      candidate: candidate({
        text: "独立文本 A",
        salience: undefined,
        confidence: 0.5,
        vector: Object.freeze([1, 0]),
      }),
      existingRecords: Object.freeze([
        existing("semantic", { text: "完全不同的文本 B", vector: Object.freeze([1, 0]) }),
      ]),
    })).toMatchObject({ duplicate: true, duplicateOf: "semantic", layer: "semantic" });
  });

  test.each([
    [0.9, true, "semantic_threshold_met"],
    [0.899999, false, "semantic_gray_zone_preserved"],
    [0.82, false, "semantic_gray_zone_preserved"],
    [0.819999, false, "distinct"],
  ] as const)("D-16 cosine=%s 的确定性边界", (similarity, duplicate, reason) => {
    const result = evaluate({
      candidate: candidate({ text: "独立文本 A", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("semantic", { text: "完全不同的文本 B", vector: vectorAt(similarity) }),
      ]),
    });

    expect(result.duplicate).toBe(duplicate);
    expect(result.reason).toBe(reason);
    if (duplicate) expect(result).toMatchObject({ duplicateOf: "semantic", layer: "semantic" });
  });

  test("灰区不调用 LLM，并保留最高相似度用于解释", () => {
    expect(evaluate({
      candidate: candidate({ text: "独立文本 A", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("gray-low", { text: "完全不同的文本 B", vector: vectorAt(0.83) }),
        existing("gray-high", { text: "另一条完全不同文本 C", vector: vectorAt(0.88) }),
      ]),
    })).toEqual({
      duplicate: false,
      layer: "semantic",
      similarity: expect.closeTo(0.88, 8),
      reason: "semantic_gray_zone_preserved",
    });
  });

  test("非法、零向量或维度不一致 fail-closed，不产生 duplicate", () => {
    expect(evaluate({
      candidate: candidate({ text: "独立文本 A", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("dimension", { text: "不同文本 B", vector: Object.freeze([1]) }),
        existing("zero", { text: "不同文本 C", vector: Object.freeze([0, 0]) }),
        existing("nan", { text: "不同文本 D", vector: Object.freeze([Number.NaN, 0]) }),
      ]),
    })).toEqual({ duplicate: false, reason: "invalid_vector_preserved" });
  });

  test("候选自身向量非法时立即 fail-closed", () => {
    expect(evaluate({
      candidate: candidate({ text: "独立文本 A", vector: Object.freeze([0, 0]) }),
      existingRecords: Object.freeze([
        existing("semantic", { text: "完全不同的文本 B", vector: Object.freeze([1, 0]) }),
      ]),
    })).toEqual({ duplicate: false, reason: "invalid_vector_preserved" });
  });

  test("已有记录优先、随后检查同批前序记录，并且不修改输入", () => {
    const input = Object.freeze({
      candidate: candidate({ text: "批次候选", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("stored-first", { text: "存量不同文本", vector: Object.freeze([1, 0]) }),
      ]),
      batchRecords: Object.freeze([
        existing("batch-second", { text: "同批不同文本", vector: Object.freeze([1, 0]) }),
      ]),
    }) satisfies CandidateDedupInput;
    const snapshot = JSON.stringify(input);

    const result = evaluateCandidateDedup(input);

    expect(result).toMatchObject({ duplicate: true, duplicateOf: "stored-first" });
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("maximum similarity returns the real highest cosine before admission", () => {
    const result = computeCandidateMaximumSimilarity({
      candidate: candidate({ text: "独立候选", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("low", { text: "存量 A", vector: vectorAt(0.3) }),
        existing("high", { text: "存量 B", vector: vectorAt(0.8) }),
      ]),
      batchRecords: Object.freeze([]),
    });

    expect(result).toEqual({
      known: true,
      maxSimilarity: expect.closeTo(0.8, 8),
      comparedRecords: 2,
    });
  });

  test("maximum similarity is known zero only for an empty comparable set", () => {
    expect(computeCandidateMaximumSimilarity({
      candidate: candidate(),
      existingRecords: Object.freeze([]),
      batchRecords: Object.freeze([]),
    })).toEqual({ known: true, maxSimilarity: 0, comparedRecords: 0 });

    expect(computeCandidateMaximumSimilarity({
      candidate: candidate({ vector: Object.freeze([0, 0]) }),
      existingRecords: Object.freeze([existing("existing")]),
      batchRecords: Object.freeze([]),
    })).toEqual({ known: false, reason: "invalid_candidate_vector" });
  });

  test("maximum similarity treats canonical exact as one without requiring vectors", () => {
    expect(computeCandidateMaximumSimilarity({
      candidate: candidate({ text: "规则：默认使用 TypeScript", vector: undefined }),
      existingRecords: Object.freeze([
        existing("exact", { text: "默认使用 typescript", vector: undefined }),
      ]),
      batchRecords: Object.freeze([]),
    })).toEqual({ known: true, maxSimilarity: 1, comparedRecords: 1 });
  });

  test("maximum similarity never turns an invalid comparable vector into zero similarity", () => {
    expect(computeCandidateMaximumSimilarity({
      candidate: candidate({ text: "独立候选", vector: Object.freeze([1, 0]) }),
      existingRecords: Object.freeze([
        existing("invalid", { text: "存量记录", vector: Object.freeze([Number.NaN, 0]) }),
      ]),
      batchRecords: Object.freeze([]),
    })).toEqual({ known: false, reason: "invalid_comparable_vector" });
  });
});
