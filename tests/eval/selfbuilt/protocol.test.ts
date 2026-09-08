import { describe, expect, test } from "vitest";

import {
  parseSelfBuiltEvalCaseV1,
  type SelfBuiltEvalCaseV1,
} from "./protocol.js";

const scope = {
  tenantId: "tenant-selfbuilt", appId: "codex", userId: "user-1",
  projectId: "project-1", agentId: "agent-1", namespace: "memories",
  workspaceId: "workspace-1", sessionId: "session-1", visibility: "private" as const,
};

function validCase(): SelfBuiltEvalCaseV1 {
  return {
    schemaVersion: "1", id: "selfbuilt-case-1", track: "selfbuilt",
    datasetId: "mengshu-selfbuilt-v1", datasetVersion: "template-v1",
    split: "test", language: "zh",
    capability: "temporal-update-conflict", scenario: "temporal-update",
    memoryStream: [
      {
        eventId: "old", evidenceRef: "evidence-old",
        occurredAt: "2026-01-01T00:00:00.000Z", validFrom: "2026-01-01T00:00:00.000Z",
        validTo: "2026-01-02T00:00:00.000Z", scope,
        text: "部署窗口是周一", semanticType: "task_context", kind: "fact",
        lifecycleStatus: "superseded", admissionRoute: "active", sourceClass: "session",
      },
      {
        eventId: "current", evidenceRef: "evidence-current",
        occurredAt: "2026-01-02T00:00:00.000Z", validFrom: "2026-01-02T00:00:00.000Z",
        scope, text: "部署窗口是周三", semanticType: "task_context", kind: "fact",
        lifecycleStatus: "active", admissionRoute: "active", sourceClass: "document",
      },
    ],
    query: {
      text: "部署窗口是哪天", scope, occurredAt: "2026-01-03T00:00:00.000Z",
      expectedMode: "answer", topK: 2,
    },
    gold: {
      requiredEvidenceRefs: ["evidence-current"],
      forbiddenEvidenceRefs: ["evidence-old"],
    },
  };
}

describe("self-built evaluation protocol", () => {
  test("strictly parses and deep-freezes a governed temporal case", () => {
    const parsed = parseSelfBuiltEvalCaseV1(validCase());

    expect(parsed.gold.requiredEvidenceRefs).toEqual(["evidence-current"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.memoryStream[0]?.scope)).toBe(true);
  });

  test("rejects missing evidence, invalid validity windows, duplicate ids, and unknown fields", () => {
    expect(() => parseSelfBuiltEvalCaseV1({
      ...validCase(), gold: { requiredEvidenceRefs: ["missing"], forbiddenEvidenceRefs: [] },
    })).toThrow(/evidence/i);
    expect(() => parseSelfBuiltEvalCaseV1({
      ...validCase(), memoryStream: [{
        ...validCase().memoryStream[0]!, validFrom: "2026-01-03T00:00:00.000Z",
        validTo: "2026-01-02T00:00:00.000Z",
      }],
    })).toThrow(/valid/i);
    expect(() => parseSelfBuiltEvalCaseV1({
      ...validCase(), memoryStream: [validCase().memoryStream[0]!, validCase().memoryStream[0]!],
    })).toThrow(/duplicate|unique/i);
    expect(() => parseSelfBuiltEvalCaseV1({ ...validCase(), unexpected: true })).toThrow(/unknown/i);
  });

  test("abstention cases require no positive evidence and at least one forbidden witness", () => {
    expect(() => parseSelfBuiltEvalCaseV1({
      ...validCase(), query: { ...validCase().query, expectedMode: "abstain" },
    })).toThrow(/abstain/i);
  });
});
