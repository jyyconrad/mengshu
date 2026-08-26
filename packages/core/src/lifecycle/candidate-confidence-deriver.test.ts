import { describe, expect, test } from "vitest";

import { computeConfidenceWithBreakdown } from "../scoring/confidence-score.js";
import {
  deriveCandidateConfidence,
  type AuthoritativeCandidateEvidenceFact,
} from "./candidate-confidence-deriver.js";

const facts: readonly AuthoritativeCandidateEvidenceFact[] = [
  { evidenceId: "event-user", sourceKind: "session_user" },
  { evidenceId: "event-rule", sourceKind: "rule_file" },
];

describe("deriveCandidateConfidence", () => {
  test("只按候选 eventIds 选择权威 evidence facts，并保留逐证据解释", () => {
    const result = deriveCandidateConfidence({
      semanticType: "rules",
      eventIds: ["event-user"],
      evidenceFacts: facts,
    });
    const expected = computeConfidenceWithBreakdown("rules", [
      { sourceKind: "session_user" },
    ]);

    expect(result).toEqual({
      score: expected.score,
      baseConfidence: expected.baseConfidence,
      evidences: [
        {
          evidenceId: "event-user",
          sourceKind: "session_user",
          reliability: expected.evidenceReliabilities[0],
        },
      ],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.evidences)).toBe(true);
  });

  test.each([
    undefined,
    [],
    [{ evidenceId: "other", sourceKind: "session_user" }],
    [{ evidenceId: "event-user", sourceKind: "unknown" }],
    [
      { evidenceId: "event-user", sourceKind: "session_user" },
      { evidenceId: "event-user", sourceKind: "rule_file" },
    ],
  ])("facts 缺失、错配、非法或重复时 fail-closed：%j", (evidenceFacts) => {
    expect(deriveCandidateConfidence({
      semanticType: "rules",
      eventIds: ["event-user"],
      evidenceFacts: evidenceFacts as readonly AuthoritativeCandidateEvidenceFact[] | undefined,
    })).toBeUndefined();
  });

  test("候选 eventIds 为空或重复时 fail-closed", () => {
    expect(deriveCandidateConfidence({
      semanticType: "rules",
      eventIds: [],
      evidenceFacts: facts,
    })).toBeUndefined();
    expect(deriveCandidateConfidence({
      semanticType: "rules",
      eventIds: ["event-user", "event-user"],
      evidenceFacts: facts,
    })).toBeUndefined();
  });
});
