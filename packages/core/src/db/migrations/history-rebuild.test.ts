import { describe, expect, test } from "vitest";

import {
  planHistoryRebuild,
  planHistoryRebuildExhaustedModelAttempts,
  summarizeHistoryRebuildPlans,
  type HistoryRebuildModelClassification,
  type HistoryRebuildScanRow,
} from "./history-rebuild.js";

const HASH_A = "a".repeat(64);

function row(overrides: Partial<HistoryRebuildScanRow> = {}): HistoryRebuildScanRow {
  return {
    sourceTable: "memories",
    recordId: "00000000-0000-4000-8000-000000000001",
    sourceHash: HASH_A,
    text: "生产发布前必须完成回归测试",
    kind: "decision",
    metadata: {},
    scope: {
      tenantId: "tenant-a",
      userId: "user-a",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "working-context",
      visibility: "private",
      workspaceId: "workspace-a",
      sessionId: "session-a",
    },
    lifecycleStatus: "active",
    evidenceIds: ["00000000-0000-4000-8000-000000000099"],
    ...overrides,
  };
}

function model(
  overrides: Partial<HistoryRebuildModelClassification> = {},
): HistoryRebuildModelClassification {
  return {
    recordId: "00000000-0000-4000-8000-000000000001",
    sourceHash: HASH_A,
    semanticType: "experience",
    topicLabels: ["PostgreSQL Migration"],
    confidence: 0.92,
    ...overrides,
  };
}

describe("history rebuild pure planner", () => {
  test("preserves a valid explicit 5-type and keeps traceable active data tree eligible", () => {
    expect(planHistoryRebuild(row({
      metadata: { semanticType: "rules" },
      topicLabels: ["Release Safety"],
    }))).toMatchObject({
      disposition: "preserve",
      semanticType: "rules",
      topicLabels: ["release-safety"],
      contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "valid_explicit_semantic_type",
    });
  });

  test("backfills only a deterministic high-confidence kind mapping", () => {
    expect(planHistoryRebuild(row())).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      contextEligible: true,
      treeEligibility: { source: true, topic: false, global: false },
      reason: "deterministic_kind_mapping",
    });
  });

  test("keeps knowledge rows as resource evidence without promoting them into context or trees", () => {
    expect(planHistoryRebuild(row({
      sourceTable: "knowledge",
      kind: "knowledge",
      metadata: {},
      evidenceIds: [],
    }))).toMatchObject({
      disposition: "preserve",
      semanticType: "resource",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "knowledge_resource_only",
    });
  });

  test("plans a deterministic evidence mirror for active historical memories without evidence ids", () => {
    expect(planHistoryRebuild({
      ...row({ evidenceIds: [] }),
      canCreateEvidenceMirror: true,
      valueScore: 0.7,
      importance: 0.8,
    } as HistoryRebuildScanRow)).toMatchObject({
      contextEligible: true,
      treeEligibility: { source: true, topic: false, global: false },
    });
  });

  test("enforces D-03 value score and profile routing before topic eligibility", () => {
    expect(planHistoryRebuild({
      ...row({ metadata: { semanticType: "rules" }, topicLabels: ["Release Safety"] }),
      valueScore: 0.69,
      importance: 0.9,
    } as HistoryRebuildScanRow)).toMatchObject({
      treeEligibility: { source: true, topic: false, global: false },
    });
    expect(planHistoryRebuild({
      ...row({ metadata: { semanticType: "profile" }, topicLabels: ["User Profile"] }),
      valueScore: 0.95,
      importance: 0.9,
    } as HistoryRebuildScanRow)).toMatchObject({
      treeEligibility: { source: true, topic: false, global: false },
    });
  });

  test("routes an unmappable record to pending model classification without guessing", () => {
    expect(planHistoryRebuild(row({ kind: "fact" }))).toMatchObject({
      disposition: "model_classify",
      semanticType: undefined,
      topicLabels: [],
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "model_classification_required",
    });
  });

  test("treats a string legacy semantic type as migration input instead of corrupt explicit 5-type", () => {
    expect(planHistoryRebuild(row({
      kind: "fact",
      metadata: { semanticType: "runtime_validation" },
    }))).toMatchObject({
      disposition: "model_classify",
      semanticType: undefined,
      reason: "model_classification_required",
    });
    expect(planHistoryRebuild(row({
      kind: "decision",
      metadata: { semanticType: "project_decision" },
    }))).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      reason: "deterministic_kind_mapping",
    });
  });

  test("accepts an exact, identity-bound high-confidence model result and canonicalizes topics", () => {
    expect(planHistoryRebuild(
      row({ kind: "fact" }),
      model({ topicLabels: [" PostgreSQL Migration ", "postgresql-migration", "发布/回滚"] }),
    )).toMatchObject({
      disposition: "model_classify",
      semanticType: "experience",
      topicLabels: ["postgresql-migration", "发布-回滚"],
      contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "model_classification_accepted",
    });
  });

  test("demotes a well-formed but low-confidence model result to lookup-only", () => {
    expect(planHistoryRebuild(
      row({ kind: "fact" }),
      model({ confidence: 0.84 }),
    )).toMatchObject({
      disposition: "lookup_only",
      semanticType: undefined,
      topicLabels: [],
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "model_confidence_below_threshold",
    });
  });

  test("preserves an auditable prior history lookup-only decision across a new cohort", () => {
    expect(planHistoryRebuild(row({
      kind: "decision",
      metadata: {
        admissionRoute: "lookup_only",
        contextEligible: false,
        memoryContainer: "session_candidate",
        historyRebuild: {
          runId: "history-rebuild-v1",
          sourceHash: "b".repeat(64),
          disposition: "lookup_only",
          planReceiptHash: "c".repeat(64),
        },
        governance: { native: { container: "session_candidate" } },
      },
    }))).toMatchObject({
      disposition: "lookup_only",
      semanticType: undefined,
      topicLabels: [],
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "prior_history_lookup_only",
    });
  });

  test("fails closed when prior history lookup-only audit markers are contradictory", () => {
    expect(planHistoryRebuild(row({
      metadata: {
        admissionRoute: "lookup_only",
        contextEligible: true,
        memoryContainer: "session_candidate",
        historyRebuild: {
          runId: "history-rebuild-v1",
          sourceHash: "b".repeat(64),
          disposition: "lookup_only",
          planReceiptHash: "c".repeat(64),
        },
        governance: { native: { container: "session_candidate" } },
      },
    }))).toMatchObject({
      disposition: "quarantine",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "invalid_prior_history_lookup_only",
    });
  });

  test.each([
    ["ordinary active", row()],
    ["explicitly corrected", row({
      metadata: {
        admissionRoute: "active",
        contextEligible: true,
        memoryContainer: "project",
        historyRebuild: {
          runId: "history-rebuild-v1",
          sourceHash: "b".repeat(64),
          disposition: "lookup_only",
          planReceiptHash: "c".repeat(64),
        },
      },
    })],
    ["revoked", row({
      lifecycleStatus: "revoked",
      metadata: {
        admissionRoute: "lookup_only",
        contextEligible: false,
        memoryContainer: "session_candidate",
        historyRebuild: {
          runId: "history-rebuild-v1",
          sourceHash: "b".repeat(64),
          disposition: "lookup_only",
          planReceiptHash: "c".repeat(64),
        },
        governance: { native: { container: "session_candidate" } },
      },
    })],
  ])("does not inherit prior lookup-only for %s records", (_label, source) => {
    expect(planHistoryRebuild(source)).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      contextEligible: _label === "revoked" ? false : true,
      treeEligibility: _label === "revoked"
        ? { source: false, topic: false, global: false }
        : { source: true, topic: false, global: false },
      reason: "deterministic_kind_mapping",
    });
  });

  test.each([
    ["record id mismatch", model({ recordId: "00000000-0000-4000-8000-000000000002" })],
    ["source hash mismatch", model({ sourceHash: "b".repeat(64) })],
    ["invalid 5-type", model({ semanticType: "instruction" as "rules" })],
    ["invalid topic", model({ topicLabels: ["---"] })],
    ["invalid confidence", model({ confidence: Number.NaN })],
    ["extra own key", { ...model(), sql: "UPDATE memories" }],
  ])("quarantines a model result with %s", (_label, classification) => {
    expect(planHistoryRebuild(row({ kind: "fact" }), classification)).toMatchObject({
      disposition: "quarantine",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "invalid_model_classification",
    });
  });

  test("rejects accessor-backed model data before reading attacker-controlled fields", () => {
    const classification = model() as unknown as Record<string, unknown>;
    Object.defineProperty(classification, "confidence", {
      enumerable: true,
      get: () => 1,
    });
    expect(planHistoryRebuild(row({ kind: "fact" }), classification)).toMatchObject({
      disposition: "quarantine",
      reason: "invalid_model_classification",
    });
  });

  test.each([
    ["invalid explicit shape", row({ metadata: { semanticType: 42 } })],
    ["conflicting explicit", row({
      metadata: { semanticType: "rules", governance: { native: { semanticType: "profile" } } },
    })],
    ["classification conflict", row({ classificationConflict: true })],
    ["scope conflict", row({ scopeConflict: true })],
    ["invalid scope", row({ scope: { ...row().scope, projectId: "" } })],
    ["legacy quarantine", row({ legacyQuarantineReason: "unmapped-project" })],
  ])("fails closed for %s", (_label, source) => {
    expect(planHistoryRebuild(source)).toMatchObject({
      disposition: "quarantine",
      semanticType: undefined,
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
    });
  });

  test("preserves classification but disables context and trees for inactive or untraceable rows", () => {
    expect(planHistoryRebuild(row({ lifecycleStatus: "archived" }))).toMatchObject({
      disposition: "backfill",
      semanticType: "rules",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
    });
    expect(planHistoryRebuild(row({ evidenceIds: [], canCreateEvidenceMirror: false }))).toMatchObject({
      disposition: "backfill",
      contextEligible: true,
      treeEligibility: { source: false, topic: false, global: false },
    });
  });

  test("falls back to lookup-only when every model attempt identity is exhausted", () => {
    expect(planHistoryRebuildExhaustedModelAttempts(row({ kind: "fact" }))).toMatchObject({
      disposition: "lookup_only",
      semanticType: undefined,
      topicLabels: [],
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "model_attempts_exhausted",
    });
    expect(planHistoryRebuildExhaustedModelAttempts(row({ kind: "task" }))).toMatchObject({
      disposition: "backfill",
      semanticType: "task_context",
      reason: "deterministic_kind_mapping",
    });
  });

  test("produces deterministic receipt hashes independent of object and topic ordering", () => {
    const first = planHistoryRebuild(
      row({ kind: "fact", metadata: { b: 2, a: 1 } }),
      model({ topicLabels: ["Beta", "Alpha"] }),
    );
    const replay = planHistoryRebuild(
      row({ kind: "fact", metadata: { a: 1, b: 2 } }),
      model({ topicLabels: ["alpha", "beta"] }),
    );
    expect(first.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(replay.receiptHash).toBe(first.receiptHash);
  });

  test("summarizes every record into exactly one conserved funnel bucket", () => {
    const plans = [
      planHistoryRebuild(row({ metadata: { semanticType: "rules" } })),
      planHistoryRebuild(row({ recordId: "b", sourceHash: "b".repeat(64), kind: "task" })),
      planHistoryRebuild(row({ recordId: "c", sourceHash: "c".repeat(64), kind: "fact" })),
      planHistoryRebuild(
        row({ recordId: "d", sourceHash: "d".repeat(64), kind: "fact" }),
        model({ recordId: "d", sourceHash: "d".repeat(64), confidence: 0.1 }),
      ),
      planHistoryRebuild(row({ recordId: "e", sourceHash: "e".repeat(64), scopeConflict: true })),
    ];

    expect(summarizeHistoryRebuildPlans(plans)).toEqual({
      total: 5,
      preserve: 1,
      backfill: 1,
      modelClassify: 1,
      lookupOnly: 1,
      quarantine: 1,
      classified: 2,
      contextEligible: 2,
      sourceTreeEligible: 2,
      topicTreeEligible: 0,
      receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });
});
