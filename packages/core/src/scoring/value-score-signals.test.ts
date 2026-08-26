import { describe, expect, test } from "vitest";

import type { ValidatedCandidate } from "../lifecycle/candidate-validator.js";
import {
  ValueScoreSignalError,
  deriveValueScoreSignalsWithProvenance,
} from "./value-score-signals.js";

const candidate: ValidatedCandidate = {
  rejected: false,
  text: "All commits must pass CI in scripts/check.sh",
  semanticType: "rules",
  salience: 0.9,
  temporality: "persistent",
  crossContextual: true,
  targetScope: "project",
  evidence: { quote: "All commits must pass CI", eventIds: ["event-1"] },
  riskFlags: [],
  evidenceOnly: false,
};

describe("deriveValueScoreSignalsWithProvenance", () => {
  test("maps authoritative sourceKind and semantic maxSimilarity into raw evidence/novelty", () => {
    const result = deriveValueScoreSignalsWithProvenance(candidate, {
      intent: "auto",
      valueSignals: {
        mode: "authoritative",
        sourceKind: "rule_file",
        maxSimilarity: 0.25,
      },
    });

    expect(result.signals).toMatchObject({ evidence: 1, novelty: 0.75 });
    expect(result.provenance).toEqual({
      mode: "authoritative",
      evidence: "source_authority",
      novelty: "semantic_max_similarity",
      sourceKind: "rule_file",
      maxSimilarity: 0.25,
    });
  });

  test("missing authoritative facts are explicit legacy_unknown and conservatively score zero", () => {
    const result = deriveValueScoreSignalsWithProvenance(candidate, { intent: "auto" });

    expect(result.signals).toMatchObject({ evidence: 0, novelty: 0 });
    expect(result.provenance).toEqual({
      mode: "legacy_unknown",
      evidence: "unknown",
      novelty: "unknown",
    });
  });

  test.each([-0.01, 1.01, Number.NaN, Number.POSITIVE_INFINITY])(
    "invalid maxSimilarity=%s fails closed",
    (maxSimilarity) => {
      expect(() => deriveValueScoreSignalsWithProvenance(candidate, {
        valueSignals: {
          mode: "authoritative",
          sourceKind: "session_user",
          maxSimilarity,
        },
      })).toThrow(ValueScoreSignalError);
    },
  );
});
