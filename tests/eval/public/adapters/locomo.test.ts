import { describe, expect, test } from "vitest";

import { adaptLoCoMoSample } from "./locomo.js";

describe("LoCoMo adapter", () => {
  test("expands each QA item and preserves dialogue-level evidence refs", () => {
    const cases = adaptLoCoMoSample({
      sample_id: "conv-1",
      conversation: {
        speaker_a: "A",
        speaker_b: "B",
        session_1_date_time: "1:56 pm on 8 May, 2023",
        session_1: [
          { speaker: "A", dia_id: "D1:1", text: "hello" },
          { speaker: "B", dia_id: "D1:2", text: "the answer" },
        ],
      },
      qa: [{ question: "what?", answer: "the answer", evidence: ["D1:2"], category: 2 }],
    }, { datasetVersion: "3eb6f2c" });

    expect(cases).toHaveLength(1);
    expect(cases[0]!.memoryStream[0]!.evidenceRef).toBe("D1:1");
    expect(cases[0]!.gold.requiredEvidenceRefs).toEqual(["D1:2"]);
    expect(cases[0]!.capability).toBe("temporal-reasoning");
  });
});
