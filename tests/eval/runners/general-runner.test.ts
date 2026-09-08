import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { parseEvalCaseV2 } from "../public/protocol.js";
import { compareGeneralDiagnosticRounds } from "./compare-runner.js";
import { createEvalRunSpec } from "./evaluation-protocol.js";
import { evaluateReleaseGate } from "./gate-runner.js";
import {
  assertGeneralEvaluationReportIntegrity,
  runGeneralEvaluation,
} from "./general-runner.js";
import {
  createBudgetedFullContextEngine,
  createLexicalDiagnosticEngine,
  createNoMemoryEngine,
} from "./offline-retrieval-engines.js";

function runSpec(cacheMode: "cold" | "warm") {
  return createEvalRunSpec({
    candidateVersion: "mengshu@1.0.7+candidate",
    baselineVersion: "diagnostic-no-memory/v1",
    datasetVersions: { fixture: "v1" }, governanceSnapshot: null,
    configFingerprint: `fixture-${cacheMode}`, dbSchemaVersion: "v32",
    embeddingModel: "not-run", readerModel: "not-run", judgeModel: "not-run",
    promptHashes: { retrieval: "a".repeat(64) }, randomSeed: 42,
    contextTokenBudget: 1024, topK: 1, cacheMode,
  });
}

const evalCase = parseEvalCaseV2({
  schemaVersion: "2", id: "case-1", track: "general", benchmarkId: "fixture",
  datasetVersion: "v1", split: "test", capability: "retrieval",
  memoryStream: [
    { eventId: "noise", occurredAt: "2026-01-01T00:00:00.000Z", payload: "weather" },
    { eventId: "answer", occurredAt: "2026-01-02T00:00:00.000Z",
      payload: "release requires green ci", evidenceRef: "answer" },
  ],
  query: { text: "What does release require?", expectedMode: "answer" },
  gold: { answer: "green ci", requiredEvidenceRefs: ["answer"] },
  protocol: { ingestMode: "incremental", topK: 1, contextTokenBudget: 1024 },
});

async function report(cacheMode: "cold" | "warm", generatedAt: string) {
  return runGeneralEvaluation({
    tier: "G0", generatedAt, runSpec: runSpec(cacheMode), datasetId: "fixture",
    datasetSha256: createHash("sha256").update("fixture").digest("hex"),
    cases: [evalCase],
    engines: [createNoMemoryEngine(), createBudgetedFullContextEngine(),
      createLexicalDiagnosticEngine({ cacheMode, cases: [evalCase] })],
  });
}

describe("formal general diagnostic runner", () => {
  test("scores evidence without claiming an official answer score", async () => {
    const result = await report("cold", "2026-08-30T00:00:00.000Z");
    expect(result).toMatchObject({
      formalScoreEligible: false,
      scoreAuthority: "diagnostic",
      officialAnswerScoring: "not_run",
    });
    expect(result.variants.find((variant) => variant.role === "no-memory")?.diagnosticScore).toBe(0);
    expect(result.variants.find((variant) => variant.role === "full-context")?.diagnosticScore).toBe(100);
    expect(result.variants.find((variant) => variant.role === "diagnostic")?.diagnosticScore).toBe(100);
    expect(result.blockers).toEqual(expect.arrayContaining([
      "required_control_missing:vector-only",
      "required_control_missing:previous-release",
      "required_control_missing:candidate-release",
      "official_answer_scorer_not_run",
    ]));
    expect(result.reportHash).toMatch(/^[0-9a-f]{64}$/);
    expect(() => assertGeneralEvaluationReportIntegrity(result)).not.toThrow();
    expect(() => assertGeneralEvaluationReportIntegrity({
      ...result,
      caseCount: result.caseCount + 1,
    })).toThrow(/integrity/i);
  });

  test("two rounds compare by identical case ids with 10k bootstrap; release stays blocked", async () => {
    const cold = await report("cold", "2026-08-30T00:00:00.000Z");
    const warm = await report("warm", "2026-08-30T00:01:00.000Z");
    const comparison = compareGeneralDiagnosticRounds({
      baseline: cold, candidate: warm,
      baselineVariantId: "lexical-diagnostic-bm25/v1",
      candidateVariantId: "lexical-diagnostic-bm25/v1",
    });
    expect(comparison).toMatchObject({
      delta: 0,
      confidenceInterval: { lower: 0, upper: 0, samples: 10_000 },
    });
    expect(evaluateReleaseGate({
      qualityPassed: true, integrityPassed: true, generalRun: warm,
      generalComparison: comparison, privateFreshCaseCount: 0,
    })).toMatchObject({
      decision: "blocked",
      blockers: expect.arrayContaining([
        "formal_general_score_missing",
        "private_paired_gate_missing_or_failed",
        "private_fresh_quota_not_met",
      ]),
    });
  });
});
