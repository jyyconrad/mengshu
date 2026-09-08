import { describe, expect, test } from "vitest";

import { adaptMemoryAgentBenchRow } from "./memoryagentbench.js";

describe("MemoryAgentBench adapter", () => {
  test("expands inject-once/query-many rows without losing source metadata", () => {
    const cases = adaptMemoryAgentBenchRow({
      context: "fact one\nfact two",
      questions: ["q1", "q2"],
      answers: [["a1"], ["a2", "alias"]],
      metadata: {
        source: "factconsolidation_mh_6k",
        question_ids: ["id-1", "id-2"],
        question_types: ["conflict", "conflict"],
        qa_pair_ids: ["pair-1", "pair-2"],
      },
    }, {
      benchmarkSplit: "Conflict_Resolution",
      datasetVersion: "fe1735d",
    });

    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({
      id: "id-1",
      capability: "conflict-resolution",
      gold: { answer: ["a1"] },
    });
    expect(cases[0]!.memoryStream[0]!.payload).toMatchObject({
      source: "factconsolidation_mh_6k",
      context: "fact one\nfact two",
    });
  });
});
