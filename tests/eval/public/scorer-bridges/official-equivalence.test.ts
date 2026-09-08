import { describe, expect, test } from "vitest";

import {
  scoreLongMemEvalRetrieval,
} from "./longmemeval.js";
import {
  scoreMemoryAgentAnswer,
} from "./memoryagentbench.js";

describe("official scorer bridges", () => {
  test("LongMemEval retrieval bridge matches official recall_any/recall_all/nDCG", () => {
    const score = scoreLongMemEvalRetrieval({
      rankedIds: ["wrong", "answer-1", "answer-2"],
      correctIds: ["answer-1", "answer-2"],
      corpusIds: ["wrong", "answer-1", "answer-2"],
      k: 2,
    });
    expect(score.recallAny).toBe(1);
    expect(score.recallAll).toBe(0);
    expect(score.ndcg).toBeCloseTo(1 / (1 + 1 / Math.log2(2)), 8);
  });

  test("MemoryAgentBench bridge matches official normalization and max-over-gold F1", () => {
    const score = scoreMemoryAgentAnswer("Answer: The Normandy, France", ["France", "French Republic"]);
    expect(score.substringExactMatch).toBe(1);
    expect(score.f1).toBeGreaterThan(0);
    expect(score.exactMatch).toBe(0);
  });
});
