import { describe, expect, test } from "vitest";

import { parseEvalCaseV2 } from "./protocol.js";

describe("EvalCaseV2 protocol", () => {
  test("accepts an evidence-preserving general-track case", () => {
    const parsed = parseEvalCaseV2({
      schemaVersion: "2",
      id: "case-1",
      track: "general",
      benchmarkId: "longmemeval",
      datasetVersion: "oracle@sha256:abc",
      split: "test",
      capability: "knowledge-update",
      memoryStream: [{
        eventId: "session-1",
        occurredAt: "2026-08-01T00:00:00.000Z",
        payload: { messages: [] },
        evidenceRef: "session-1",
      }],
      query: { text: "What changed?", expectedMode: "answer" },
      gold: { answer: "new value", requiredEvidenceRefs: ["session-1"] },
      protocol: {
        ingestMode: "incremental",
        topK: 10,
        contextTokenBudget: 8_192,
        officialScorer: "longmemeval/evaluate_qa.py@9e0b455",
      },
    });

    expect(parsed.gold.requiredEvidenceRefs).toEqual(["session-1"]);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("rejects private test cases without verified/deployed provenance", () => {
    expect(() => parseEvalCaseV2({
      schemaVersion: "2",
      id: "private-1",
      track: "private",
      benchmarkId: "mengshu-private-v1",
      datasetVersion: "collecting",
      split: "test",
      capability: "current-fact",
      privateCohort: "fresh-holdout",
      governanceProvenance: {
        governanceRunId: "run-1",
        governanceState: "provisional",
        policyVersion: "policy-v1",
        sourceSnapshotSha256: "a".repeat(64),
        cutoffAt: "2026-08-30T00:00:00.000Z",
      },
      memoryStream: [],
      query: { text: "q", expectedMode: "abstain" },
      gold: { requiredEvidenceRefs: [] },
      protocol: { ingestMode: "incremental", topK: 5, contextTokenBudget: 1024 },
    })).toThrow(/private test case requires verified or deployed governance/);
  });

  test("rejects gold evidence refs that do not exist in the memory stream", () => {
    expect(() => parseEvalCaseV2({
      schemaVersion: "2",
      id: "case-2",
      track: "general",
      benchmarkId: "locomo",
      datasetVersion: "3eb6f2c",
      split: "test",
      capability: "multi-hop",
      memoryStream: [],
      query: { text: "q", expectedMode: "answer" },
      gold: { answer: "a", requiredEvidenceRefs: ["D1:3"] },
      protocol: { ingestMode: "batch", topK: 10, contextTokenBudget: 4096 },
    })).toThrow(/required evidence ref 'D1:3' is missing/);
  });
});
