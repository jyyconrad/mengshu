import { describe, expect, test } from "vitest";

import { kindToSemanticType } from "./semantic-type-mapper.js";
import { SCORING_WEIGHTS_V1 } from "../scoring/scoring-weights.js";
import {
  EVIDENCE_GRADES,
  isEvidenceGrade,
  isMemoryForm,
  MEMORY_FORMS,
  type MemoryRecord,
} from "./types.js";

describe("wiki memory form contract", () => {
  test("memoryForm 与 evidence grade 是附加字段，fact 不会被改成 experience", () => {
    expect(MEMORY_FORMS).toEqual([
      "event/episodic",
      "fact/claim",
      "semantic",
      "procedural",
    ]);
    expect(EVIDENCE_GRADES).toEqual(["primary", "governed", "inferred", "snapshot"]);
    expect(isMemoryForm("fact/claim")).toBe(true);
    expect(isMemoryForm("experience")).toBe(false);
    expect(isEvidenceGrade("inferred")).toBe(true);
    expect(isEvidenceGrade("primary-source")).toBe(false);

    const record = {
      kind: "fact",
      memoryForm: "fact/claim",
      evidenceGrade: "primary",
    } as Pick<MemoryRecord, "kind" | "memoryForm" | "evidenceGrade">;
    expect(kindToSemanticType(record.kind).semanticType).toBeNull();
    expect(record.memoryForm).not.toBe("procedural");
    expect(SCORING_WEIGHTS_V1.valueScore.riskPenalty).toBe(0.15);
    expect(SCORING_WEIGHTS_V1.importance).toEqual({
      w1_salience: 0.45,
      w2_authority: 0.2,
      w3_explicit: 0.2,
      w4_type: 0.15,
    });
  });
});
