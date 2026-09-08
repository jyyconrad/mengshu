import { describe, expect, test } from "vitest";

import {
  adaptLongMemEvalCase,
  selectLongMemEvalStratified,
  type OfficialLongMemEvalCase,
} from "./longmemeval.js";

function raw(id: string, type: string, answerSessionIds: string[] = ["answer-a"]): OfficialLongMemEvalCase {
  return {
    question_id: id,
    question_type: type,
    question: `question ${id}`,
    answer: `answer ${id}`,
    question_date: "2026/08/30 (Sun) 12:00",
    haystack_session_ids: ["answer-a", "noans-b"],
    haystack_dates: ["2026/08/29 (Sat) 12:00", "2026/08/29 (Sat) 13:00"],
    haystack_sessions: [
      [{ role: "user", content: "evidence", has_answer: true }],
      [{ role: "assistant", content: "distractor", has_answer: false }],
    ],
    answer_session_ids: answerSessionIds,
  };
}

describe("official LongMemEval adapter", () => {
  test("preserves session ids, timestamps, evidence and official scorer identity", () => {
    const result = adaptLongMemEvalCase(raw("q-1", "knowledge-update"), {
      datasetVersion: "oracle@821a2034",
    });

    expect(result.memoryStream.map((event) => event.eventId)).toEqual(["answer-a", "noans-b"]);
    expect(result.memoryStream[0]).toMatchObject({
      occurredAt: "2026-08-29T12:00:00.000Z",
      evidenceRef: "answer-a",
    });
    expect(result.gold).toMatchObject({
      answer: "answer q-1",
      requiredEvidenceRefs: ["answer-a"],
    });
    expect(result.protocol.officialScorer).toContain("longmemeval");
  });

  test("maps _abs questions to abstention without inventing evidence", () => {
    const result = adaptLongMemEvalCase(raw("q-abs_abs", "single-session-user", []), {
      datasetVersion: "oracle@821a2034",
    });
    expect(result.query.expectedMode).toBe("abstain");
    expect(result.gold.requiredEvidenceRefs).toEqual([]);
  });

  test("selects the same stratified slice for the same seed and covers every stratum", () => {
    const cases = ["a", "b", "c"].flatMap((type) =>
      Array.from({ length: 8 }, (_, index) => raw(`${type}-${index}`, type)));
    const first = selectLongMemEvalStratified(cases, 12, 42);
    const second = selectLongMemEvalStratified([...cases].reverse(), 12, 42);

    expect(first.map((item) => item.question_id)).toEqual(second.map((item) => item.question_id));
    expect(new Set(first.map((item) => item.question_type))).toEqual(new Set(["a", "b", "c"]));
  });
});
