import { describe, expect, it } from "vitest";
import { explainAdmissionCandidate } from "./admission-explain.js";

describe("explainAdmissionCandidate", () => {
  it("rejects unknown semantic routing via validator gates with reasonCodes", () => {
    // too-short text should hit text_too_short
    const result = explainAdmissionCandidate({
      text: "short",
      semanticType: "rules",
    });
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reasonCodes.some((c) => c.includes("text_too_short") || c === "text_too_short")).toBe(true);
      expect(result.reasonCodes.some((c) => c.startsWith("semanticType_gate:"))).toBe(true);
    }
  });

  it("routes a well-formed rules candidate and returns admission reason", () => {
    const text = "在这个仓库里合并前必须先跑完整 vitest，不要跳过。";
    const result = explainAdmissionCandidate({
      text,
      semanticType: "rules",
      salience: 0.9,
      crossContextual: true,
      temporality: "persistent",
      intent: "remember",
      sourceText: text,
    });
    expect(result.outcome).toBe("routed");
    if (result.outcome === "routed") {
      expect(result.semanticType).toBe("rules");
      expect(result.admission.route).toBeTruthy();
      expect(result.reasonCodes.some((c) => c.startsWith("route:"))).toBe(true);
    }
  });
});
