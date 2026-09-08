import { describe, expect, test } from "vitest";

import {
  comparePairedEffectRuns,
  createEvalRunSpec,
  fingerprintEvalRunSpec,
} from "./evaluation-protocol.js";

function runSpec() {
  return {
    candidateVersion: "mengshu@1.1.0+candidate",
    baselineVersion: "mengshu@1.0.7+baseline",
    datasetVersions: { "longmemeval-cleaned": "2026-08-30" },
    governanceSnapshot: null,
    configFingerprint: "config-v1",
    dbSchemaVersion: "v22",
    embeddingModel: "text-embedding-3-small",
    readerModel: "reader-v1",
    judgeModel: "judge-v1",
    promptHashes: { reader: "a".repeat(64) },
    randomSeed: 42,
    contextTokenBudget: 8192,
    topK: 10,
    cacheMode: "cold" as const,
  };
}

describe("evaluation protocol v2 M0", () => {
  test("RunSpec 被规范化、深冻结并生成稳定复现指纹", () => {
    const first = createEvalRunSpec(runSpec());
    const reordered = createEvalRunSpec({
      ...runSpec(),
      datasetVersions: { "longmemeval-cleaned": "2026-08-30" },
      promptHashes: { reader: "a".repeat(64) },
    });

    expect(first).toEqual(reordered);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.datasetVersions)).toBe(true);
    expect(fingerprintEvalRunSpec(first)).toBe(fingerprintEvalRunSpec(reordered));
    expect(fingerprintEvalRunSpec(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  test("RunSpec 缺复现字段或候选与基线相同时 fail-closed", () => {
    expect(() => createEvalRunSpec({ ...runSpec(), readerModel: "" })).toThrow(/readerModel/);
    expect(() => createEvalRunSpec({
      ...runSpec(),
      candidateVersion: runSpec().baselineVersion,
    })).toThrow(/candidateVersion|baselineVersion/);
  });

  test("G/P effect case 按相同 case id 配对并保留 capability 切片", () => {
    const comparison = comparePairedEffectRuns({
      track: "general",
      datasetVersion: "g0-v1",
      baselineVersion: "1.0.7",
      candidateVersion: "1.1.0",
      regressionTolerance: -1,
      baseline: [
        { caseId: "a", capability: "update", score: 70 },
        { caseId: "b", capability: "retrieval", score: 80 },
      ],
      candidate: [
        { caseId: "a", capability: "update", score: 74 },
        { caseId: "b", capability: "retrieval", score: 79.5 },
      ],
    });

    expect(comparison.scoreName).toBe("GMS");
    expect(comparison.baselineScore).toBe(75);
    expect(comparison.candidateScore).toBe(76.75);
    expect(comparison.delta).toBe(1.75);
    expect(comparison.confidenceInterval).toMatchObject({
      samples: 10_000,
      confidenceLevel: 0.95,
    });
    expect(comparison.gatePassed).toBe(true);
    expect(comparison.byCapability).toEqual([
      expect.objectContaining({ capability: "retrieval", delta: -0.5 }),
      expect.objectContaining({ capability: "update", delta: 4 }),
    ]);
  });

  test("paired bootstrap 对相同 case 的零差异给出稳定的 [0,0] 区间", () => {
    const comparison = comparePairedEffectRuns({
      track: "private",
      datasetVersion: "private-v1",
      baselineVersion: "1.0.7",
      candidateVersion: "1.1.0",
      regressionTolerance: -1,
      capabilityRegressionTolerance: -2,
      randomSeed: 42,
      baseline: [
        { caseId: "a", capability: "update", score: 70 },
        { caseId: "b", capability: "update", score: 80 },
      ],
      candidate: [
        { caseId: "a", capability: "update", score: 70 },
        { caseId: "b", capability: "update", score: 80 },
      ],
    });
    expect(comparison.confidenceInterval).toMatchObject({ lower: 0, upper: 0 });
    expect(comparison.byCapability[0]!.confidenceInterval).toMatchObject({ lower: 0, upper: 0 });
    expect(comparison.gatePassed).toBe(true);
  });

  test("Q 轨不得伪装成效果分，case 缺配对或 capability 漂移也拒绝", () => {
    const base = {
      datasetVersion: "v1",
      baselineVersion: "1.0.7",
      candidateVersion: "1.1.0",
      regressionTolerance: -1,
      baseline: [{ caseId: "a", capability: "update", score: 70 }],
      candidate: [{ caseId: "a", capability: "update", score: 72 }],
    };
    expect(() => comparePairedEffectRuns({ ...base, track: "quality" as const }))
      .toThrow(/quality|effect/i);
    expect(() => comparePairedEffectRuns({
      ...base,
      track: "private" as const,
      candidate: [{ caseId: "b", capability: "update", score: 72 }],
    })).toThrow(/paired|case/i);
    expect(() => comparePairedEffectRuns({
      ...base,
      track: "private" as const,
      candidate: [{ caseId: "a", capability: "retrieval", score: 72 }],
    })).toThrow(/capability/i);
  });
});
