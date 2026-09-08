import { describe, expect, test } from "vitest";

import { buildSelfBuiltManifest, generateSelfBuiltCases, serializeSelfBuiltCases } from "./generator.js";
import {
  assertSelfBuiltReportIntegrity,
  compareSelfBuiltRounds,
  createGovernedSelfBuiltEngine,
  createLegacySelfBuiltEngine,
  runSelfBuiltEvaluation,
} from "./runner.js";

async function report(cacheMode: "cold" | "warm", generatedAt: string) {
  const allCases = generateSelfBuiltCases();
  const cases = allCases.filter((item) => item.split === "test");
  const manifest = buildSelfBuiltManifest(allCases, serializeSelfBuiltCases(allCases));
  return runSelfBuiltEvaluation({
    generatedAt, cacheMode, candidateVersion: "mengshu@selfbuilt-test",
    dbSchemaVersion: "v35", worktreeSha256: "a".repeat(64), manifest, cases,
    engines: [createLegacySelfBuiltEngine({ cacheMode, cases }),
      createGovernedSelfBuiltEngine({ cacheMode, cases })],
  });
}

describe("self-built governed retrieval runner", () => {
  test("production governance filtering improves the baseline without forbidden leakage", async () => {
    const result = await report("cold", "2026-08-30T00:00:00.000Z");
    const baseline = result.variants.find((item) => item.role === "baseline")!;
    const candidate = result.variants.find((item) => item.role === "candidate")!;

    expect(result).toMatchObject({
      schemaVersion: "mengshu.selfbuilt-eval-report/v1",
      scoreName: "SBS",
      scoreAuthority: "selfbuilt-diagnostic",
      formalReleaseEligible: false,
      caseCount: 288,
    });
    expect(candidate.macroScore).toBeGreaterThan(baseline.macroScore);
    expect(candidate.forbiddenLeakRate).toBe(0);
    expect(candidate.abstentionAccuracy).toBe(1);
    expect(candidate.cases.filter((item) => item.scenario === "hydration-fallback")
      .every((item) => item.warnings.includes("lexical_fallback_used"))).toBe(true);
    expect(() => assertSelfBuiltReportIntegrity(result)).not.toThrow();
    expect(() => assertSelfBuiltReportIntegrity({ ...result, caseCount: 1 })).toThrow(/integrity/i);
  });

  test("cold and warm rounds have identical paired scores and a verifiable comparison", async () => {
    const cold = await report("cold", "2026-08-30T00:00:00.000Z");
    const warm = await report("warm", "2026-08-30T00:01:00.000Z");
    const comparison = compareSelfBuiltRounds({ baseline: cold, candidate: warm });

    expect(comparison).toMatchObject({
      schemaVersion: "mengshu.selfbuilt-comparison/v1",
      scoreName: "SBS",
      caseCount: 288,
      delta: 0,
      changedCaseCount: 0,
      stable: true,
    });
  });
});
