import { describe, expect, it } from "vitest";
import { historyNativeProjection } from "../../../../../tests/fixtures/evolution-history/native-projection.js";
import { historyFixture } from "../../../../../tests/fixtures/evolution-history/fixture.js";
import { validateCandidate } from "../../lifecycle/candidate-validator.js";

describe("native PG fixture uses real projection/document/candidate contracts offline", () => {
  it("validates the frozen P13 inputs and candidate without a DB, model or fake parser", () => {
    const f = historyNativeProjection(historyFixture().scope, "10000000-0000-4000-a000-000000000001", "10000000-0000-4000-a000-000000000002");
    expect(f.bundle.memories).toHaveLength(1); expect(f.bundle.evidence).toHaveLength(1);
    expect(validateCandidate({ text: f.text, semanticType: "resource", salience: 0.8, temporality: "persistent", crossContextual: false, targetScope: "project", evidence: { quote: f.text, eventIds: ["fixture"] } }, { text: f.sourceText, scope: "project", eventIds: ["fixture"] })).toMatchObject({ rejected: false, evidenceOnly: false });
  });
});
