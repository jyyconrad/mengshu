/**
 * recall-scoring 单元测试。
 *
 * 覆盖：显式评分权重常量、computeNodeScore 的 6 因子加权、缺失字段默认值、
 * 归一化（importance/confidence clamp、evidence/recency 饱和），以及默认权重下
 * 与原 importance 主导排序的一致性。
 */

import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope } from "./types.js";
import {
  DEFAULT_RECALL_WEIGHTS,
  computeNodeScore,
  computeNodeScoreWithBreakdown,
  sortByNodeScore,
  computeImportanceForRecord,
  computeImportanceForRecordWithBreakdown,
  type ImportanceMetadata,
} from "./recall-scoring.js";

const scope: MemoryScope = {
  tenantId: "t",
  appId: "a",
  userId: "u",
  projectId: "p",
  agentId: "ag",
  namespace: "memories",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? "rec",
    scope,
    kind: overrides.kind ?? "goal",
    text: overrides.text ?? "demo",
    contentHash: "hash",
    importance: overrides.importance ?? 0.5,
    category: "core",
    dataType: "memory",
    metadata: {},
    provenance: { source: "user" },
    createdAt: 0,
    ...overrides,
  };
}

describe("DEFAULT_RECALL_WEIGHTS", () => {
  test("six factors sum to 1.0", () => {
    const w = DEFAULT_RECALL_WEIGHTS;
    const sum =
      w.relevance + w.scopeFit + w.importance + w.confidence + w.evidenceWeight + w.recency;
    expect(sum).toBeCloseTo(1.0, 6);
  });

  test("relevance is the dominant factor", () => {
    const w = DEFAULT_RECALL_WEIGHTS;
    expect(w.relevance).toBeGreaterThan(w.scopeFit);
    expect(w.scopeFit).toBeGreaterThan(w.importance);
  });
});

describe("computeNodeScore", () => {
  test("higher importance yields higher score when other factors equal", () => {
    const high = makeRecord({ id: "h", importance: 0.9 });
    const low = makeRecord({ id: "l", importance: 0.3 });
    expect(computeNodeScore(high)).toBeGreaterThan(computeNodeScore(low));
  });

  test("missing confidence defaults to 1 (full)", () => {
    const withConf = makeRecord({ confidence: 1 });
    const noConf = makeRecord({ confidence: undefined });
    expect(computeNodeScore(noConf)).toBeCloseTo(computeNodeScore(withConf), 6);
  });

  test("more evidence raises the score", () => {
    const rich = makeRecord({ id: "r", sourceNodeIds: ["e1", "e2", "e3"] });
    const poor = makeRecord({ id: "p", sourceNodeIds: [] });
    expect(computeNodeScore(rich)).toBeGreaterThan(computeNodeScore(poor));
  });

  test("higher hotness raises recency factor", () => {
    const hot = makeRecord({ id: "hot", hotness: 10 });
    const cold = makeRecord({ id: "cold", hotness: 0 });
    expect(computeNodeScore(hot)).toBeGreaterThan(computeNodeScore(cold));
  });

  test("optional relevance signal overrides neutral default", () => {
    const record = makeRecord();
    const relevant = computeNodeScore(record, DEFAULT_RECALL_WEIGHTS, { relevance: 1 });
    const irrelevant = computeNodeScore(record, DEFAULT_RECALL_WEIGHTS, { relevance: 0 });
    expect(relevant).toBeGreaterThan(irrelevant);
  });

  test("clamps out-of-range importance to [0,1]", () => {
    const over = makeRecord({ importance: 5 });
    const at1 = makeRecord({ importance: 1 });
    expect(computeNodeScore(over)).toBeCloseTo(computeNodeScore(at1), 6);
  });

  test("score stays within [0,1]", () => {
    const max = makeRecord({
      importance: 1,
      confidence: 1,
      hotness: 999,
      sourceNodeIds: ["a", "b", "c", "d", "e"],
    });
    const score = computeNodeScore(max, DEFAULT_RECALL_WEIGHTS, { relevance: 1, scopeFit: 1 });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe("sortByNodeScore", () => {
  test("sorts descending by score, importance-dominant when other factors equal", () => {
    const records = [
      makeRecord({ id: "low", importance: 0.3 }),
      makeRecord({ id: "high", importance: 0.9 }),
      makeRecord({ id: "mid", importance: 0.6 }),
    ];
    const sorted = sortByNodeScore(records);
    expect(sorted.map((r) => r.id)).toEqual(["high", "mid", "low"]);
  });

  test("does not mutate the input array", () => {
    const records = [makeRecord({ id: "a", importance: 0.1 }), makeRecord({ id: "b", importance: 0.9 })];
    const snapshot = [...records];
    sortByNodeScore(records);
    expect(records).toEqual(snapshot);
  });
});

describe("computeImportanceForRecord (v0.2)", () => {
  test("从元数据正确计算 importance（4 项加权）", () => {
    const meta: ImportanceMetadata = {
      salience: 0.8,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "rules",
    };

    const importance = computeImportanceForRecord(meta);
    // w1*0.8 + w2*1.0 + w3*1.0 + w4*1.0
    // = 0.45*0.8 + 0.2*1.0 + 0.2*1.0 + 0.15*1.0
    // = 0.36 + 0.2 + 0.2 + 0.15 = 0.91
    expect(importance).toBeCloseTo(0.91, 2);
  });

  test("缺失必要字段时返回中性默认 0.5", () => {
    const incompleteMeta: ImportanceMetadata = {
      salience: 0.8,
      // 缺少 sourceKind 和 semanticType
    };

    const importance = computeImportanceForRecord(incompleteMeta);
    expect(importance).toBe(0.5);
  });

  test("explicitSave=false 应降低分数", () => {
    const withExplicit: ImportanceMetadata = {
      salience: 0.5,
      sourceKind: "session_user",
      explicitSave: true,
      semanticType: "profile",
    };

    const withoutExplicit: ImportanceMetadata = {
      ...withExplicit,
      explicitSave: false,
    };

    const scoreWith = computeImportanceForRecord(withExplicit);
    const scoreWithout = computeImportanceForRecord(withoutExplicit);

    expect(scoreWith).toBeGreaterThan(scoreWithout);
    // 差值应为 w3_explicit = 0.2
    expect(scoreWith - scoreWithout).toBeCloseTo(0.2, 6);
  });
});

describe("computeNodeScore with importanceMeta (v0.2)", () => {
  test("record.importance 优先于 importanceMeta", () => {
    const record = makeRecord({ importance: 0.7 });
    const meta: ImportanceMetadata = {
      salience: 0.1,
      sourceKind: "agent_output",
      explicitSave: false,
      semanticType: "experience",
    };

    // 即使 meta 会算出很低的 importance，record.importance 优先
    const score = computeNodeScore(record, DEFAULT_RECALL_WEIGHTS, {}, meta);
    const scoreOnlyRecord = computeNodeScore(record);

    expect(score).toBeCloseTo(scoreOnlyRecord, 6);
  });

  test("缺少 record.importance 时使用 importanceMeta 计算", () => {
    const record = makeRecord({ importance: undefined });
    const meta: ImportanceMetadata = {
      salience: 0.9,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "rules",
    };

    const scoreWithMeta = computeNodeScore(record, DEFAULT_RECALL_WEIGHTS, {}, meta);
    const scoreDefault = computeNodeScore(record); // 默认 0.5

    expect(scoreWithMeta).toBeGreaterThan(scoreDefault);
  });

  test("既无 record.importance 也无 importanceMeta 时使用默认 0.5", () => {
    const record = makeRecord({ importance: undefined });

    const score = computeNodeScore(record);
    // importance 因子贡献 = 0.15 * 0.5 = 0.075
    // 其他因子：relevance=0.4*0.5, scopeFit=0.2*0.5, confidence=0.1*1, evidence=0, recency=0
    // = 0.2 + 0.1 + 0.1 + 0.075 + 0 + 0 = 0.475
    expect(score).toBeCloseTo(0.475, 3);
  });
});

describe("computeImportanceForRecordWithBreakdown", () => {
  test("返回 importance 与 4 项明细，且明细相加≈importance", () => {
    const meta: ImportanceMetadata = {
      salience: 0.8,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "rules",
    };

    const { importance, breakdown } = computeImportanceForRecordWithBreakdown(meta);

    expect(breakdown).not.toBeNull();
    expect(importance).toBeCloseTo(0.91, 2);

    const sum =
      breakdown!.salience_llm +
      breakdown!.sourceAuthority +
      breakdown!.explicitnessBonus +
      breakdown!.typePrior;
    expect(sum).toBeCloseTo(importance, 6);
  });

  test("4 项明细与 importance（无明细）数值一致", () => {
    const meta: ImportanceMetadata = {
      salience: 0.6,
      sourceKind: "session_user",
      explicitSave: false,
      semanticType: "profile",
    };

    const { importance } = computeImportanceForRecordWithBreakdown(meta);
    expect(importance).toBeCloseTo(computeImportanceForRecord(meta), 6);
  });

  test("explicitSave=false 时 explicitnessBonus 贡献为 0", () => {
    const meta: ImportanceMetadata = {
      salience: 0.5,
      sourceKind: "session_user",
      explicitSave: false,
      semanticType: "profile",
    };

    const { breakdown } = computeImportanceForRecordWithBreakdown(meta);
    expect(breakdown!.explicitnessBonus).toBe(0);
  });

  test("缺失必要字段时 importance=0.5 且 breakdown=null", () => {
    const meta: ImportanceMetadata = { salience: 0.8 };

    const { importance, breakdown } = computeImportanceForRecordWithBreakdown(meta);
    expect(importance).toBe(0.5);
    expect(breakdown).toBeNull();
  });
});

describe("computeNodeScoreWithBreakdown", () => {
  test("score 与 computeNodeScore 完全一致", () => {
    const record = makeRecord({ importance: 0.7, hotness: 4, sourceNodeIds: ["a", "b"] });
    const signals = { relevance: 0.9, scopeFit: 0.3 };

    const breakdown = computeNodeScoreWithBreakdown(record, DEFAULT_RECALL_WEIGHTS, signals);
    const plain = computeNodeScore(record, DEFAULT_RECALL_WEIGHTS, signals);

    expect(breakdown.score).toBeCloseTo(plain, 6);
  });

  test("6 项贡献相加≈score（未 clamp 情况）", () => {
    const record = makeRecord({ importance: 0.5 });
    const { score, contributions } = computeNodeScoreWithBreakdown(record);

    const sum =
      contributions.relevance +
      contributions.scopeFit +
      contributions.importance +
      contributions.confidence +
      contributions.evidenceWeight +
      contributions.recency;
    expect(sum).toBeCloseTo(score, 6);
  });

  test("通过 importanceMeta 重算时暴露 4 项明细", () => {
    const record = makeRecord({ importance: 0.5 }); // 评分使用此权威值
    const meta: ImportanceMetadata = {
      salience: 0.9,
      sourceKind: "rule_file",
      explicitSave: true,
      semanticType: "rules",
    };

    const { importanceBreakdown, factors } = computeNodeScoreWithBreakdown(
      record,
      DEFAULT_RECALL_WEIGHTS,
      {},
      meta,
    );

    expect(importanceBreakdown).not.toBeNull();
    const sum =
      importanceBreakdown!.salience_llm +
      importanceBreakdown!.sourceAuthority +
      importanceBreakdown!.explicitnessBonus +
      importanceBreakdown!.typePrior;

    // P1-Q4 修复：评分使用 record.importance（权威值 0.5），
    // 但明细基于 importanceMeta 重算（用于 explain 追溯）。
    // 两者可能不同（时间差/权重版本差），这是预期行为。
    expect(factors.importance).toBe(0.5); // 评分用权威值
    expect(sum).toBeCloseTo(0.955, 2); // 明细反映元数据重算结果
  });

  test("使用 record.importance 时无法反推明细，importanceBreakdown=null", () => {
    const record = makeRecord({ importance: 0.7 });
    const { importanceBreakdown } = computeNodeScoreWithBreakdown(record);
    expect(importanceBreakdown).toBeNull();
  });

  test("既无 record.importance 也无 meta 时 importanceBreakdown=null", () => {
    const record = makeRecord({ importance: undefined });
    const { importanceBreakdown, factors } = computeNodeScoreWithBreakdown(record);
    expect(importanceBreakdown).toBeNull();
    expect(factors.importance).toBe(0.5);
  });
});
