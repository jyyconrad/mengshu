import { describe, expect, test } from "vitest";

import type { RagMultiCorpusQuery } from "../adapters/rag-multi-corpus.js";
import {
  buildReport,
  selectQueries,
  sourcePathFromRecord,
  type MengshuKbPilotCaseResult,
} from "./mengshu-e2e.js";

function query(id: string, sourceStatus: RagMultiCorpusQuery["sourceStatus"] = "complete"): RagMultiCorpusQuery {
  return {
    schemaVersion: "1",
    id,
    enterpriseName: "ZX Bank",
    queryType: "Descriptive",
    query: `Question ${id}`,
    sourceRowCount: 1,
    supportingFacts: [{ filename: "a.md", text: "fact" }],
    evidenceDocumentPaths: sourceStatus === "complete" ? ["datasets/ZX Bank/md/a.md"] : [],
    missingEvidenceFiles: sourceStatus === "complete" ? [] : ["missing.md"],
    sourceStatus,
  };
}

function result(
  id: string,
  status: MengshuKbPilotCaseResult["judgment"]["status"],
  sourceStatus: RagMultiCorpusQuery["sourceStatus"] = "complete",
): MengshuKbPilotCaseResult {
  return {
    caseId: id,
    enterpriseName: "ZX Bank",
    queryType: "Descriptive",
    sourceStatus,
    output: {
      caseId: id,
      system: "mengshu",
      answer: "answer",
      evidence: [],
      abstained: status === "grounded_abstain",
      runtime: { latencyMs: 10, inputTokens: 8, outputTokens: 2, modelCalls: 2 },
      error: null,
    },
    retrievedSourcePaths: [],
    retrievalLatencyMs: 2,
    evidenceRecallAny: sourceStatus === "complete" ? 1 : null,
    evidenceRecallAll: sourceStatus === "complete" ? 1 : null,
    judgment: {
      status,
      unsupportedAnswer: status === "unsupported_answer",
      fabricatedEvidenceCount: 0,
      reason: "test",
    },
  };
}

describe("kb-pilot Mengshu E2E report", () => {
  test("maps the new ingestion pipeline nested provenance sourceId back to the corpus path", () => {
    const sourcePath = "datasets/ZX Bank/md/Business Loan.md";
    expect(sourcePathFromRecord({
      metadata: {
        provenance: {
          source: "scan",
          sourceId: `${process.cwd()}/tests/eval/public/kb-pilot/data/rag-multi-corpus-v1/corpus/${sourcePath}`,
        },
      },
    }, new Set([sourcePath]))).toBe(sourcePath);
  });

  test("deterministically partitions 902 valid cases into 100 smoke and 802 holdout", () => {
    const queries = [
      ...Array.from({ length: 902 }, (_, index) => query(`case-${index}`)),
      ...Array.from({ length: 5 }, (_, index) => query(`invalid-${index}`, "invalid-missing-document")),
    ];
    const smoke = selectQueries(queries, "smoke");
    const holdout = selectQueries(queries, "holdout");

    expect(smoke.filter((item) => item.sourceStatus === "complete")).toHaveLength(100);
    expect(holdout.filter((item) => item.sourceStatus === "complete")).toHaveLength(802);
    expect(smoke.filter((item) => item.sourceStatus !== "complete")).toHaveLength(5);
    expect(holdout.filter((item) => item.sourceStatus !== "complete")).toHaveLength(5);
    expect(new Set([...smoke, ...holdout].filter((item) => item.sourceStatus === "complete").map((item) => item.id)))
      .toHaveLength(902);
  });

  test("strict success excludes invalid cases and remains diagnostic", () => {
    const report = buildReport({
      manifest: {
        datasetId: "rag-multi-corpus-kb-pilot-v1",
        formalScoreEligible: false,
        caseCount: 907,
        completeCaseCount: 902,
        invalidMissingDocumentCaseCount: 5,
        documentCount: 236,
        queriesSha256: "a".repeat(64),
        corpusManifestSha256: "b".repeat(64),
      },
      options: {
        split: "all",
        concurrency: 1,
        topK: 6,
        timeoutMs: 30_000,
        outputDir: "/tmp/eval",
        resume: false,
        skipIngest: false,
      },
      scope: {
        tenantId: "local", appId: "mengshu-eval", userId: "eval",
        projectId: "kb", agentId: "runner", namespace: "knowledge", visibility: "private",
      },
      model: "reader",
      configFingerprint: "c".repeat(64),
      initialization: {},
      results: [result("pass", "pass"), result("fail", "fail"),
        result("invalid", "grounded_abstain", "invalid-missing-document")],
    });

    expect(report).toMatchObject({
      scoreAuthority: "diagnostic",
      formalScoreEligible: false,
      metrics: {
        validCases: 2,
        strictPass: 1,
        fail: 1,
        e2eStrictSuccessRate: 0.5,
        unsupportedAnswers: 0,
        unsupportedAnswerRate: 0,
        invalidCases: 1,
        invalidGroundedAbstention: 1,
        invalidFabricatedEvidence: 0,
      },
    });
  });
});
