import { describe, expect, test } from "vitest";

import {
  createBaselineMetrics,
  createMetric,
  evaluateSuiteGate,
  findUnsupportedExpectedFields,
  isProductionReleaseEligible,
  sameCompleteRecallBreakdowns,
} from "./eval-metrics.js";
import type { EvalExecutionMetadata, SuiteSummary } from "./types.js";

function completeRecallBreakdown() {
  return {
    score: 0.5,
    weights: {
      relevance: 0.4, scopeFit: 0.2, importance: 0.15,
      confidence: 0.1, evidenceWeight: 0.1, recency: 0.05,
    },
    factors: {
      relevance: 0.5, scopeFit: 0.5, importance: 0.5,
      confidence: 0.5, evidenceWeight: 0.5, recency: 0.5,
    },
    contributions: {
      relevance: 0.2, scopeFit: 0.1, importance: 0.075,
      confidence: 0.05, evidenceWeight: 0.05, recency: 0.025,
    },
    importanceBreakdown: null,
    matchedBy: ["vector"] as const,
    sourceSignals: { vector: 0.5 },
    scopeFit: 0.5,
    composite: 0.5,
  };
}

function execution(
  overrides: Partial<EvalExecutionMetadata> = {},
): EvalExecutionMetadata {
  return {
    runMode: "offline-component",
    provider: null,
    model: null,
    prompt: null,
    version: "test-v1",
    fallback: false,
    degraded: false,
    ...overrides,
  };
}

function eligibleExecution(
  overrides: Partial<EvalExecutionMetadata> = {},
): EvalExecutionMetadata {
  return execution({
    runMode: "runtime-e2e",
    provider: "openai",
    model: "gpt-test",
    prompt: "prompt-v1",
    productionStageEvidence: {
      write_observe: {
        executed: true, receiptIds: ["trace-1", "storage-1", "evidence-1"], traceId: "trace-1",
        storageKey: "storage-1", evidenceId: "evidence-1", activeMemoryId: "active-1",
      },
      candidate: {
        executed: true,
        receiptIds: ["candidate-job-1", "extract_candidate.persist.v1", "evidence-1", "active-1"],
        jobId: "candidate-job-1",
        effectKey: "extract_candidate.persist.v1", evidenceId: "evidence-1",
        activeMemoryId: "active-1",
        memoryKind: "other", semanticType: "rules", admissionRoute: "active", lifecycleStatus: "active",
        contextEligible: true, valueScore: 0.9, importance: 0.8, confidence: 0.85,
        validatorAudit: {
          semanticType: "rules", admission: "active", valueScore: 0.9,
          confidenceBreakdown: { score: 0.85 },
        },
        dedupTrace: {
          created: 1, duplicateCount: 0, capacityRejectedCount: 0, droppedCount: 0,
          candidateIds: [], memoryIds: ["active-1"], activeMemoryIds: ["active-1"],
        },
        pending: pendingReceipt(),
      },
      graph: {
        executed: true,
        receiptIds: [
          "graph-job-1", "extract_graph.persist.v1", "evidence-1", "active-1",
          "entity-1", "relation-1", "memory-link-1", "entity-link-1", "relation-link-1",
          "work-node-memory-1", "work-node-evidence-1", "work-edge-1",
        ],
        jobId: "graph-job-1",
        effectKey: "extract_graph.persist.v1", evidenceId: "evidence-1",
        activeMemoryId: "active-1", entityIds: ["entity-1"], relationIds: ["relation-1"],
        memoryEvidenceLinkIds: ["memory-link-1"],
        entityEvidenceLinkIds: ["entity-link-1"],
        relationEvidenceLinkIds: ["relation-link-1"],
        memoryEvidenceBindings: [{
          linkId: "memory-link-1", targetId: "active-1", evidenceId: "evidence-1",
        }],
        entityEvidenceBindings: [{
          linkId: "entity-link-1", targetId: "entity-1", evidenceId: "evidence-1",
        }],
        relationEvidenceBindings: [{
          linkId: "relation-link-1", targetId: "relation-1", evidenceId: "evidence-1",
        }],
        workMemoryNodeIds: ["work-node-memory-1", "work-node-evidence-1"],
        workMemoryActiveNodeId: "work-node-memory-1",
        workMemoryEvidenceNodeId: "work-node-evidence-1",
        workMemoryEdgeIds: ["work-edge-1"],
        workMemoryEdgeBindings: [{
          edgeId: "work-edge-1", predicate: "grounded_by", sourceId: "work-node-memory-1",
          targetId: "work-node-evidence-1", evidenceChunkIds: ["evidence-1"],
        }],
      },
      tree: {
        executed: true, receiptIds: [
          "build_tree.persist.v1", "source-job-1", "global-job-1", "topic-job-1", "active-1",
          "source-buffer-1", "global-buffer-1", "topic-buffer-1",
        ],
        effectKey: "build_tree.persist.v1",
        evidenceId: "evidence-1", activeMemoryId: "active-1",
        expectedTreeTypes: ["source", "global", "topic"],
        sourceJobId: "source-job-1", globalJobId: "global-job-1",
        sourceTreeKey: "session-1",
        sourceLeafId: "active-1", globalLeafId: "active-1",
        topicJobIds: ["topic-job-1"], topicLeafIds: ["active-1"],
        topicTreeKeys: ["postgresql-validation"], coldTopicJobIds: [], coldTopicBufferIds: [],
        bufferBindings: [
          { jobId: "source-job-1", treeType: "source", treeKey: "session-1",
            bufferId: "source-buffer-1", leafId: "active-1" },
          { jobId: "global-job-1", treeType: "global", treeKey: "2026-08-13",
            bufferId: "global-buffer-1", leafId: "active-1" },
          { jobId: "topic-job-1", treeType: "topic", treeKey: "postgresql-validation",
            bufferId: "topic-buffer-1", leafId: "active-1" },
        ],
        hotness: {
          topicEntityId: "topic-entity-1", threshold: 6,
          beforeRecall: {
            mentionCount30d: 1, distinctSourceCount: 1, lastSeenAt: 1,
            recencyDecay: 1, graphCentrality: 0, queryHits30d: 1,
            score: Math.log(2) + 0.5 + 1 + 2,
          },
          afterRecall: {
            mentionCount30d: 1, distinctSourceCount: 1, lastSeenAt: 1,
            recencyDecay: 1, graphCentrality: 0, queryHits30d: 3,
            score: Math.log(2) + 0.5 + 1 + 6,
          },
        },
        sealedSummary: sealedSummaryReceipt(),
      },
      context_recall: {
        executed: true, receiptIds: [
          "active-1", "slot-profile-1", "slot-task-1", "slot-rules-1",
          "slot-experience-1", "slot-resource-1",
        ], evidenceId: "evidence-1",
        activeMemoryId: "active-1", contextSourceIds: [
          "active-1", "slot-profile-1", "slot-task-1", "slot-rules-1",
          "slot-experience-1", "slot-resource-1",
        ],
        lookupHitIds: ["active-1"], recallHitIds: ["active-1"],
        contextScoreBreakdown: completeRecallBreakdown(),
        lookupScoreBreakdown: completeRecallBreakdown(),
        recallScoreBreakdown: completeRecallBreakdown(),
        slotActiveMemoryIds: {
          profile: "slot-profile-1", task_context: "slot-task-1", rules: "slot-rules-1",
          experience: "slot-experience-1", resource: "slot-resource-1",
        },
        slotSourceIds: {
          profile: ["slot-profile-1"], task_context: ["slot-task-1"],
          rules: ["active-1", "slot-rules-1"], experience: ["slot-experience-1"],
          resource: ["slot-resource-1"],
        },
        slotScoreBreakdowns: {
          profile: completeRecallBreakdown(), task_context: completeRecallBreakdown(),
          rules: completeRecallBreakdown(), experience: completeRecallBreakdown(),
          resource: completeRecallBreakdown(),
        },
      },
    },
    productionRestartReplayEvidence: {
      restarted: true,
      replayedCandidateJobId: "candidate-job-1",
      effectReceiptIdsBeforeRestart: [
        "candidate-job-1:extract_candidate.persist.v1",
        "graph-job-1:extract_graph.persist.v1",
        "source-job-1:build_tree.persist.v1",
        "global-job-1:build_tree.persist.v1",
        "topic-job-1:build_tree.persist.v1",
      ],
      effectReceiptIdsAfterRestart: [
        "candidate-job-1:extract_candidate.persist.v1",
        "graph-job-1:extract_graph.persist.v1",
        "source-job-1:build_tree.persist.v1",
        "global-job-1:build_tree.persist.v1",
        "topic-job-1:build_tree.persist.v1",
      ],
      ledgerIdsBeforeRestart: [
        "storage-1", "memory-link-1", "entity-link-1", "relation-link-1",
        "work-node-memory-1", "work-node-evidence-1", "work-edge-1",
      ],
      ledgerIdsAfterRestart: [
        "storage-1", "memory-link-1", "entity-link-1", "relation-link-1",
        "work-node-memory-1", "work-node-evidence-1", "work-edge-1",
      ],
      effectReceiptCountBeforeRestart: 5,
      effectReceiptCountAfterRestart: 5,
      ledgerCountBeforeRestart: 7,
      ledgerCountAfterRestart: 7,
      contextSourceIdsBeforeRestart: [
        "active-1", "slot-profile-1", "slot-task-1", "slot-rules-1",
        "slot-experience-1", "slot-resource-1",
      ],
      contextSourceIdsAfterRestart: [
        "active-1", "slot-profile-1", "slot-task-1", "slot-rules-1",
        "slot-experience-1", "slot-resource-1",
      ],
      lookupHitIdsBeforeRestart: ["active-1"], lookupHitIdsAfterRestart: ["active-1"],
      recallHitIdsBeforeRestart: ["active-1"], recallHitIdsAfterRestart: ["active-1"],
      slotSourceIdsBeforeRestart: {
        profile: ["slot-profile-1"], task_context: ["slot-task-1"],
        rules: ["active-1", "slot-rules-1"], experience: ["slot-experience-1"],
        resource: ["slot-resource-1"],
      },
      slotSourceIdsAfterRestart: {
        profile: ["slot-profile-1"], task_context: ["slot-task-1"],
        rules: ["active-1", "slot-rules-1"], experience: ["slot-experience-1"],
        resource: ["slot-resource-1"],
      },
      contextScoreBreakdownBeforeRestart: completeRecallBreakdown(),
      contextScoreBreakdownAfterRestart: completeRecallBreakdown(),
      lookupScoreBreakdownBeforeRestart: completeRecallBreakdown(),
      lookupScoreBreakdownAfterRestart: completeRecallBreakdown(),
      recallScoreBreakdownBeforeRestart: completeRecallBreakdown(),
      recallScoreBreakdownAfterRestart: completeRecallBreakdown(),
      pending: {
        replayedCandidateJobId: "pending-job-1",
        candidateBeforeRestart: pendingReceipt().candidate,
        candidateAfterRestart: pendingReceipt().candidate,
        effectTraceBeforeRestart: pendingReceipt().effectTrace,
        effectTraceAfterRestart: pendingReceipt().effectTrace,
        proposalReceiptsBeforeRestart: pendingReceipt().proposalReceipts,
        proposalReceiptsAfterRestart: pendingReceipt().proposalReceipts,
        derivationCountsBeforeRestart: pendingReceipt().derivationCounts,
        derivationCountsAfterRestart: pendingReceipt().derivationCounts,
        visibilityBeforeRestart: pendingReceipt().visibility,
        visibilityAfterRestart: pendingReceipt().visibility,
      },
      sealedSummaryBeforeRestart: sealedSummaryReceipt(),
      sealedSummaryAfterRestart: sealedSummaryReceipt(),
      sealedSummaryAttemptsBeforeRestart: 1,
      sealedSummaryAttemptsAfterRestart: 2,
    },
    ...overrides,
  });
}

function sealedSummaryReceipt() {
  const leafIds = Array.from({ length: 20 }, (_, index) => `sealed-active-${index + 1}`);
  const evidenceChunkIds = Array.from({ length: 20 }, (_, index) => `sealed-evidence-${index + 1}`);
  return {
    executed: true as const,
    jobId: "sealed-source-job-1",
    effectKey: "build_tree.persist.v1" as const,
    requestFingerprint: "d".repeat(64),
    leaseGeneration: 1,
    committedAt: 100,
    nodeId: "sealed-source-node-1",
    treeType: "source" as const,
    treeKey: "sealed-session-1",
    level: 1 as const,
    status: "sealed" as const,
    leafIds,
    evidenceChunkIds,
    leafEvidenceBindings: leafIds.map((leafId, index) => ({
      leafId,
      evidenceChunkId: evidenceChunkIds[index]!,
      activeLifecycleStatus: "active" as const,
      activeAdmissionRoute: "active" as const,
      evidenceLifecycleStatus: "archived" as const,
      evidenceAdmissionRoute: "evidence_only" as const,
      evidenceCommandType: "importEvidence" as const,
    })),
    summaryCount: 1 as const,
    leafCount: 20 as const,
    sourceBufferCount: 0 as const,
    effectResult: {
      leafId: leafIds.at(-1)!, sealed: true as const, bufferId: null,
      nodeId: "sealed-source-node-1", foldedNodeIds: [],
    },
  };
}

function sourceOnlyExecution(): EvalExecutionMetadata {
  const result = eligibleExecution();
  const candidate = result.productionStageEvidence!.candidate!;
  candidate.semanticType = "experience" as never;
  candidate.valueScore = 0.629;
  (candidate.validatorAudit as Record<string, unknown>).semanticType = "experience";
  (candidate.validatorAudit as Record<string, unknown>).valueScore = 0.629;

  const tree = result.productionStageEvidence!.tree!;
  tree.expectedTreeTypes = ["source"] as never;
  tree.globalJobId = null as never;
  tree.globalLeafId = null as never;
  tree.topicJobIds = [];
  tree.topicLeafIds = [];
  tree.topicTreeKeys = [];
  tree.bufferBindings = tree.bufferBindings.filter(({ treeType }) => treeType === "source");
  tree.receiptIds = [
    "build_tree.persist.v1", "source-job-1", "active-1", "source-buffer-1",
  ];

  const restart = result.productionRestartReplayEvidence!;
  const effectReceiptIds = [
    "candidate-job-1:extract_candidate.persist.v1",
    "graph-job-1:extract_graph.persist.v1",
    "source-job-1:build_tree.persist.v1",
  ];
  restart.effectReceiptIdsBeforeRestart = [...effectReceiptIds];
  restart.effectReceiptIdsAfterRestart = [...effectReceiptIds];
  restart.effectReceiptCountBeforeRestart = effectReceiptIds.length;
  restart.effectReceiptCountAfterRestart = effectReceiptIds.length;
  return result;
}

function pendingReceipt() {
  const validationReceipt = {
    version: 1 as const,
    policyVersion: "candidate-validator-v1" as const,
    candidateOrdinal: 0,
    proposalHash: "a".repeat(64),
    evidenceIds: ["pending-evidence-1"],
    outcome: "accepted" as const,
    gates: Array.from({ length: 11 }, (_, index) => ({
      gateId: `G${String(index + 1).padStart(2, "0")}` as
        `G${"01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11"}`,
      status: "passed" as const,
      reasonCode: "passed",
      policyVersion: "candidate-validator-v1" as const,
    })),
  };
  const candidate = {
    candidateId: "pending-1",
    scope: {
      tenantId: "tenant-1", userId: "user-1", appId: "app-1", projectId: "project-1",
      agentId: "agent-1", namespace: "namespace-1", visibility: "private" as const,
      workspaceId: "workspace-1", sessionId: "session-1",
    },
    status: "pending" as const,
    promotedToMemoryId: null,
    contentHash: "b".repeat(64),
    activeContentHash: "b".repeat(64),
    evidenceIds: ["pending-evidence-1"],
    memoryKind: "other" as const,
    semanticType: "rules" as const,
    admissionRoute: "candidate" as const,
    valueScore: 0.687,
    importance: 0.7,
    confidence: 0.75,
    validationReceipt,
  };
  return {
    executed: true as const,
    receiptIds: ["pending-job-1", "extract_candidate.persist.v1", "pending-evidence-1", "pending-1"],
    jobId: "pending-job-1",
    effectKey: "extract_candidate.persist.v1" as const,
    evidenceId: "pending-evidence-1",
    candidate,
    effectTrace: {
      created: 1 as const, duplicateCount: 0 as const, capacityRejectedCount: 0 as const,
      droppedCount: 0 as const, candidateIds: ["pending-1"], memoryIds: [], activeMemoryIds: [],
    },
    proposalReceipts: [{
      version: 1 as const, candidateOrdinal: 0, outcome: "accepted" as const,
      validation: validationReceipt,
      admission: {
        version: 1 as const, outcome: "accepted" as const, route: "candidate" as const,
        valueScore: 0.687, reason: "fixture pending route", breakdown: { explicitness: 0.7 },
      },
    }],
    derivationCounts: {
      memories: 0 as const, graphJobs: 0 as const, treeJobs: 0 as const,
      treeBuffers: 0 as const, workMemoryNodes: 0 as const, workMemoryEdges: 0 as const,
      evidenceLinks: 0 as const,
    },
    visibility: { contextSourceIds: [], lookupHitIds: [], recallHitIds: [] },
  };
}

function summary(overrides: Partial<SuiteSummary> = {}): SuiteSummary {
  return {
    suite: "extension-suite",
    total: 10,
    passed: 10,
    failed: 0,
    passRate: 1,
    slotRecallPassRate: 1,
    wrongInjectionRate: 0,
    latencyP50Ms: 1,
    latencyP95Ms: 2,
    failedCases: [],
    metrics: [],
    execution: execution(),
    ...overrides,
  };
}

describe("eval metric protocol", () => {
  test.each([
    ["min", 8, 10, 0.8, true],
    ["min", 7, 10, 0.8, false],
    ["max", 1, 10, 0.1, true],
    ["max", 2, 10, 0.1, false],
    ["exact", 0, 10, 0, true],
    ["exact", 1, 10, 0, false],
  ] as const)(
    "%s gate 使用 numerator/denominator 计算并判定",
    (direction, numerator, denominator, threshold, passed) => {
      const metric = createMetric({
        name: "metric",
        numerator,
        denominator,
        direction,
        threshold,
      });

      expect(metric.value).toBe(numerator / denominator);
      expect(metric.passed).toBe(passed);
    },
  );

  test("denominator=0 必须 fail-closed", () => {
    const metric = createMetric({
      name: "breakdown_output_rate",
      numerator: 0,
      denominator: 0,
      direction: "exact",
      threshold: 1,
    });

    expect(metric.passed).toBe(false);
    expect(metric.failure).toMatch(/denominator=0/);
  });

  test("denominator<0 不能被 manifest gate 重新判为通过", () => {
    const metric = createMetric({
      name: "wrong_injection",
      numerator: 0,
      denominator: -1,
      direction: "exact",
      threshold: 0,
    });
    const result = evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["wrong_injection"],
      gate: { wrong_injection: 0 },
    });

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/denominator=-1/);
  });

  test("manifest 声明 metric 缺失时即使 extension passRate=100% 也失败", () => {
    const result = evaluateSuiteGate(
      summary({ passRate: 1, metrics: [] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("manifest metric 'type_precision' 未产出");
  });

  test("既无声明也无输出 metric 时 fail-closed", () => {
    const result = evaluateSuiteGate(summary({ metrics: [] }), {
      kind: "extension",
      metrics: [],
      gate: {},
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("suite 未声明且未产出任何 metric");
  });

  test("同名 metric 重复产出时 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(summary({ metrics: [metric, metric] }), {
      kind: "extension",
      metrics: ["type_precision"],
      gate: { type_precision: 0.85 },
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain("metric 'type_precision' 重复产出");
  });

  test("manifest 重复 metric、额外 gate 或 malformed contract 均 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });

    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["type_precision", "type_precision"],
      gate: { type_precision: 0.85 },
    }).passed).toBe(false);
    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: ["type_precision"],
      gate: { type_precision: 0.85, undeclared: 1 },
    }).passed).toBe(false);
    expect(evaluateSuiteGate(summary({ metrics: [metric] }), {
      kind: "extension",
      metrics: "malformed",
      gate: "malformed",
    }).passed).toBe(false);
  });

  test("extension 只按声明 metric 判定，不回退通用 80% pass rate", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 9,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(
      summary({ passRate: 0.2, metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(result.passed).toBe(true);
  });

  test("metric 通过但 summary.failed>0 时通用 quality gate 仍 fail-closed", () => {
    const metric = createMetric({
      name: "type_precision",
      numerator: 10,
      denominator: 10,
      direction: "min",
      threshold: 0.85,
    });
    const result = evaluateSuiteGate(
      summary({ total: 10, passed: 9, failed: 1, passRate: 0.9, metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["type_precision"],
        gate: { type_precision: 0.85 },
      },
    );

    expect(metric.passed).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/1.*失败 case|失败 case.*1/i);
  });

  test("runner metric threshold 或 direction 与 manifest 协议不一致时失败", () => {
    const metric = createMetric({
      name: "over_capture",
      numerator: 0,
      denominator: 10,
      direction: "min",
      threshold: 0.2,
    });
    const result = evaluateSuiteGate(
      summary({ metrics: [metric] }),
      {
        kind: "extension",
        metrics: ["over_capture"],
        gate: { over_capture: 0.1 },
      },
    );

    expect(result.passed).toBe(false);
    expect(result.failures.join("\n")).toMatch(/direction.*max/);
    expect(result.failures.join("\n")).toMatch(/threshold.*0.1/);
  });

  test("未知 expected 字段必须显式报告，不允许空断言通过", () => {
    expect(
      findUnsupportedExpectedFields(
        { requiredMemoryIds: ["m1"], conflict_detected: true },
        new Set(["requiredMemoryIds"]),
      ),
    ).toEqual(["conflict_detected"]);
  });

  test("slot_recall 只统计有 requiredMemoryIds 的 applicable cases", () => {
    const cases = [
      { expected: { requiredMemoryIds: ["m1"] } },
      { expected: { requiredMemoryIds: ["m2"] } },
      { expected: { forbiddenMemoryIds: ["m3"] } },
    ] as never[];
    const results = [
      { missedRequired: [], injectedForbidden: [], failures: [] },
      { missedRequired: ["m2"], injectedForbidden: [], failures: ["slot_recall: miss"] },
      { missedRequired: [], injectedForbidden: [], failures: [] },
    ] as never[];
    const metrics = createBaselineMetrics(cases, results, summary({
      suite: "mengshu-v0.1",
      total: 3,
      passed: 2,
      failed: 1,
    }));

    expect(metrics.find((metric) => metric.name === "slot_recall")).toMatchObject({
      numerator: 1,
      denominator: 2,
      value: 0.5,
      passed: false,
    });
  });

  test("无 applicable slot case 与 cases/results 缺项都 fail-closed", () => {
    const negativeCases = [{ expected: { forbiddenMemoryIds: ["m1"] } }] as never[];
    const results = [{ missedRequired: [], injectedForbidden: [], failures: [] }] as never[];
    const metrics = createBaselineMetrics(negativeCases, results, summary({
      suite: "mengshu-v0.1",
      total: 1,
      passed: 1,
      failed: 0,
    }));

    expect(metrics.find((metric) => metric.name === "slot_recall")).toMatchObject({
      denominator: 0,
      passed: false,
    });
    expect(() => createBaselineMetrics(negativeCases, [], summary({
      suite: "mengshu-safety",
      total: 1,
      passed: 0,
      failed: 1,
    }))).toThrow(/cases.*results|数量/i);
  });
});

describe("production release eligibility", () => {
  test("只有 runtime-e2e、非 fallback/degraded 且五阶段证据齐全才具备 production release 资格", () => {
    const eligible = summary({ execution: eligibleExecution() });
    const offline = summary({ execution: execution() });
    const degraded = summary({
      execution: execution({ runMode: "runtime-e2e", degraded: true }),
    });
    const fallback = summary({
      execution: execution({ runMode: "runtime-e2e", fallback: true }),
    });

    expect(isProductionReleaseEligible([eligible])).toBe(true);
    expect(isProductionReleaseEligible([offline])).toBe(false);
    expect(isProductionReleaseEligible([degraded])).toBe(false);
    expect(isProductionReleaseEligible([fallback])).toBe(false);
  });

  test.each([
    "write_observe",
    "candidate",
    "graph",
    "tree",
    "context_recall",
  ] as const)("缺少 %s 阶段真实 receipt 时 fail-closed", (missingStage) => {
    const productionStageEvidence = eligibleExecution().productionStageEvidence!;
    delete productionStageEvidence[missingStage];
    const invalid = summary({
      execution: execution({
        runMode: "runtime-e2e",
        provider: "openai",
        model: "gpt-test",
        prompt: "prompt-v1",
        productionStageEvidence,
        productionRestartReplayEvidence: eligibleExecution().productionRestartReplayEvidence,
      }),
    });

    expect(isProductionReleaseEligible([invalid])).toBe(false);
  });

  test("五个阶段只有任意字符串 receipt，或缺少 restart replay，仍必须 fail-closed", () => {
    const arbitrary = summary({
      execution: execution({
        runMode: "runtime-e2e", provider: "openai", model: "gpt-test", prompt: "prompt-v1",
        productionStageEvidence: {
          write_observe: { executed: true, receiptIds: ["write-1"] },
          candidate: { executed: true, receiptIds: ["candidate-1"] },
          graph: { executed: true, receiptIds: ["graph-1"] },
          tree: { executed: true, receiptIds: ["tree-1"] },
          context_recall: { executed: true, receiptIds: ["context-1"] },
        } as never,
      }),
    });
    const noReplay = summary({ execution: eligibleExecution({ productionRestartReplayEvidence: undefined }) });

    expect(isProductionReleaseEligible([arbitrary])).toBe(false);
    expect(isProductionReleaseEligible([noReplay])).toBe(false);
  });

  test.each(["memoryKind", "created"] as const)(
    "candidate receipt 缺少原生 %s 时 fail-closed",
    (field) => {
      const invalidExecution = eligibleExecution();
      const candidate = invalidExecution.productionStageEvidence!.candidate! as unknown as
        Record<string, unknown>;
      if (field === "memoryKind") delete candidate.memoryKind;
      else delete (candidate.dedupTrace as Record<string, unknown>).created;

      expect(isProductionReleaseEligible([
        summary({ execution: invalidExecution }),
      ])).toBe(false);
    },
  );

  test.each([
    ["duplicateCount", 1],
    ["capacityRejectedCount", 1],
    ["droppedCount", 1],
  ] as const)("candidate receipt 的 %s 非零时 fail-closed", (field, value) => {
    const invalidExecution = eligibleExecution();
    const dedup = invalidExecution.productionStageEvidence!.candidate!.dedupTrace as unknown as
      Record<string, unknown>;
    dedup[field] = value;

    expect(isProductionReleaseEligible([
      summary({ execution: invalidExecution }),
    ])).toBe(false);
  });

  test("candidate receipt 含额外 memoryIds 时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    const dedup = invalidExecution.productionStageEvidence!.candidate!.dedupTrace as unknown as {
      memoryIds: string[];
    };
    dedup.memoryIds = ["active-1", "unexpected-active-2"];

    expect(isProductionReleaseEligible([
      summary({ execution: invalidExecution }),
    ])).toBe(false);
  });

  test("active 五阶段 receipt 缺少 pending candidate 证据时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    delete (invalidExecution.productionStageEvidence!.candidate as unknown as
      Record<string, unknown>).pending;

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("pending 错误晋升为 active route 或产生 active memory 时 fail-closed", () => {
    const wrongRoute = eligibleExecution();
    (wrongRoute.productionStageEvidence!.candidate!.pending!.candidate as unknown as
      Record<string, unknown>).admissionRoute = "active";
    expect(isProductionReleaseEligible([summary({ execution: wrongRoute })])).toBe(false);

    const createdActive = eligibleExecution();
    createdActive.productionStageEvidence!.candidate!.pending!.effectTrace.memoryIds.push("active-2");
    createdActive.productionStageEvidence!.candidate!.pending!.effectTrace.activeMemoryIds.push("active-2");
    expect(isProductionReleaseEligible([summary({ execution: createdActive })])).toBe(false);
  });

  test.each([
    "graphJobs", "treeJobs", "treeBuffers", "workMemoryNodes", "workMemoryEdges", "evidenceLinks",
  ] as const)("pending 产生 %s 下游派生时 fail-closed", (field) => {
    const invalidExecution = eligibleExecution();
    (invalidExecution.productionStageEvidence!.candidate!.pending!.derivationCounts as unknown as
      Record<string, number>)[field] = 1;

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("pending candidate 出现在 context/lookup/recall 任一路径时 fail-closed", () => {
    for (const field of ["contextSourceIds", "lookupHitIds", "recallHitIds"] as const) {
      const invalidExecution = eligibleExecution();
      invalidExecution.productionStageEvidence!.candidate!.pending!.visibility[field].push("pending-1");
      expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
    }
  });

  test("pending candidate 或 effect/governance/零派生在 restart 后漂移时 fail-closed", () => {
    const candidateDrift = eligibleExecution();
    candidateDrift.productionRestartReplayEvidence!.pending!.candidateAfterRestart.activeContentHash =
      "c".repeat(64);
    expect(isProductionReleaseEligible([summary({ execution: candidateDrift })])).toBe(false);

    const derivationDrift = eligibleExecution();
    (derivationDrift.productionRestartReplayEvidence!.pending!.derivationCountsAfterRestart as unknown as
      Record<string, number>).treeJobs = 1;
    expect(isProductionReleaseEligible([summary({ execution: derivationDrift })])).toBe(false);
  });

  test("graph evidence binding target 不属于当前 receipt 时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionStageEvidence!.graph!.entityEvidenceBindings = [{
      linkId: "entity-link-1", targetId: "unrelated-entity", evidenceId: "evidence-1",
    }];
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("Work Memory grounded_by binding 方向、predicate 或 evidence 漂移时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionStageEvidence!.graph!.workMemoryEdgeBindings![0]!.targetId =
      "work-node-memory-1";
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("tree receipt 缺少任一 job 对应 buffer binding 时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionStageEvidence!.tree!.bufferBindings.pop();
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("tree receipt 的 bufferBindings 非数组时必须 fail-closed 而不是抛错", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionStageEvidence!.tree!.bufferBindings = null as never;
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("D-03 source-only receipt 不要求 global/topic 也具备 production 资格", () => {
    expect(isProductionReleaseEligible([
      summary({ execution: sourceOnlyExecution() }),
    ])).toBe(true);
  });

  test("expected global 时缺少 global job/leaf/binding 必须 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    const tree = invalidExecution.productionStageEvidence!.tree!;
    tree.expectedTreeTypes = ["source", "global", "topic"] as never;
    tree.globalJobId = null as never;
    tree.globalLeafId = null as never;
    tree.bufferBindings = tree.bufferBindings.filter(({ treeType }) => treeType !== "global");

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("expected 不含 global 时出现 global job/leaf/binding 必须 fail-closed", () => {
    const invalidExecution = sourceOnlyExecution();
    const tree = invalidExecution.productionStageEvidence!.tree!;
    tree.globalJobId = "global-job-1" as never;
    tree.globalLeafId = "active-1" as never;
    tree.bufferBindings.push({
      jobId: "global-job-1", treeType: "global", treeKey: "2026-08-13",
      bufferId: "global-buffer-1", leafId: "active-1",
    });

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("expected topic 时缺少 topic arrays/binding 必须 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    const tree = invalidExecution.productionStageEvidence!.tree!;
    tree.expectedTreeTypes = ["source", "global", "topic"] as never;
    tree.topicJobIds = [];
    tree.topicLeafIds = [];
    tree.topicTreeKeys = [];
    tree.bufferBindings = tree.bufferBindings.filter(({ treeType }) => treeType !== "topic");

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("active candidate semanticType 接受任一合法类型且必须与 validator audit 一致", () => {
    expect(isProductionReleaseEligible([
      summary({ execution: sourceOnlyExecution() }),
    ])).toBe(true);

    const mismatched = sourceOnlyExecution();
    (mismatched.productionStageEvidence!.candidate!.validatorAudit as
      Record<string, unknown>).semanticType = "rules";
    expect(isProductionReleaseEligible([summary({ execution: mismatched })])).toBe(false);
  });

  test.each([
    ["missing", (receipt: Record<string, unknown>) => { delete receipt.sealedSummary; }],
    ["leaf-count", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { leafIds: string[] }).leafIds.pop();
    }],
    ["node-mismatch", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { effectResult: { nodeId: string } }).effectResult.nodeId = "other-node";
    }],
    ["unexpected-fold", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { effectResult: { foldedNodeIds: string[] } })
        .effectResult.foldedNodeIds.push("unexpected-l2-node");
    }],
    ["evidence-mismatch", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { evidenceChunkIds: string[] }).evidenceChunkIds[0] = "other-evidence";
    }],
    ["active-lifecycle", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { leafEvidenceBindings: Array<Record<string, unknown>> })
        .leafEvidenceBindings[0]!.activeLifecycleStatus = "archived";
    }],
    ["buffer-remains", (receipt: Record<string, unknown>) => {
      (receipt.sealedSummary as { sourceBufferCount: number }).sourceBufferCount = 1;
    }],
  ] as const)("sealed source summary %s 时 fail-closed", (_caseName, mutate) => {
    const invalidExecution = eligibleExecution();
    mutate(invalidExecution.productionStageEvidence!.tree! as unknown as Record<string, unknown>);
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("sealed source summary 在 restart 后漂移时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionRestartReplayEvidence!.sealedSummaryAfterRestart.nodeId =
      "drifted-summary-node";
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("sealed source summary 没有真实增加 job attempt 时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionRestartReplayEvidence!.sealedSummaryAttemptsAfterRestart =
      invalidExecution.productionRestartReplayEvidence!.sealedSummaryAttemptsBeforeRestart;
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("context receipt 的五槽 active ID 复用或串槽时 fail-closed", () => {
    const duplicateId = eligibleExecution();
    duplicateId.productionStageEvidence!.context_recall!.slotActiveMemoryIds.resource =
      "slot-profile-1";
    expect(isProductionReleaseEligible([summary({ execution: duplicateId })])).toBe(false);

    const crossedSlot = eligibleExecution();
    crossedSlot.productionStageEvidence!.context_recall!.slotSourceIds.profile.push("slot-task-1");
    expect(isProductionReleaseEligible([summary({ execution: crossedSlot })])).toBe(false);
  });

  test("context receipt 缺少 canonical slot breakdown 时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    const contextReceipt = invalidExecution.productionStageEvidence!.context_recall!;
    delete (contextReceipt.slotScoreBreakdowns as
      Partial<typeof contextReceipt.slotScoreBreakdowns>).resource;
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("context/lookup/recall breakdown 必须完全一致", () => {
    const invalidExecution = eligibleExecution();
    const contextReceipt = invalidExecution.productionStageEvidence!.context_recall!;
    contextReceipt.lookupScoreBreakdown = {
      ...contextReceipt.lookupScoreBreakdown,
      sourceSignals: { ...contextReceipt.lookupScoreBreakdown.sourceSignals, vector: 0.75 },
    };

    expect(sameCompleteRecallBreakdowns([
      completeRecallBreakdown(), completeRecallBreakdown(),
    ])).toBe(true);
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("restart effect/ledger 未变但五槽 sourceIds 漂移时仍 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    invalidExecution.productionRestartReplayEvidence!.slotSourceIdsAfterRestart.profile = [
      "slot-profile-1", "slot-task-1",
    ];
    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("restart 前后任一六因子 breakdown 漂移时 fail-closed", () => {
    const invalidExecution = eligibleExecution();
    const restart = invalidExecution.productionRestartReplayEvidence!;
    restart.recallScoreBreakdownAfterRestart = {
      ...restart.recallScoreBreakdownAfterRestart,
      sourceSignals: { ...restart.recallScoreBreakdownAfterRestart.sourceSignals, vector: 0.75 },
    };

    expect(isProductionReleaseEligible([summary({ execution: invalidExecution })])).toBe(false);
  });

  test("runtime-e2e 缺 provider/model/prompt/version 不能进入 production", () => {
    for (const field of ["provider", "model", "prompt", "version"] as const) {
      const invalid = summary({
        execution: execution({
          runMode: "runtime-e2e",
          provider: "openai",
          model: "gpt-test",
          prompt: "prompt-v1",
          [field]: field === "version" ? " " : null,
        }),
      });
      expect(isProductionReleaseEligible([invalid])).toBe(false);
    }
  });
});
