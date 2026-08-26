/**
 * tests/eval/runners/quick-eval.test.ts
 *
 * 本文件做什么：
 *   把 tests/eval/goldens/*.jsonl 的每条 case 接到 vitest test.each 上，
 *   形成"每条黄金集 → 一个 vitest 用例"的回归测试。
 *
 * 核心流程：
 *   1) 从 manifest 加载已登记的 baseline suite；
 *   2) 用 quick-eval 的 runSuite 跑出 results；
 *   3) test.each 逐条断言 result.passed === true；
 *      失败时打印 case.failures 帮助定位。
 *   4) suite 级断言：
 *      - safety 套件 wrong_injection_rate 必须为 0；
 *      - v0.1 套件 pass rate 必须 >= 80%（v0.1 release gate）。
 *
 * 关键边界：
 *   - 这里依赖 SlotContextBuilder + scope-policy + sensitive-filter，
 *     不调用任何外部服务；纯本地，2 秒内能跑完。
 *   - 不依赖 LLM，不依赖向量库；判定全部基于 id 命中与字面匹配。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

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

function productionPendingReceipt() {
  const validationReceipt = {
    version: 1 as const, policyVersion: "candidate-validator-v1" as const,
    candidateOrdinal: 0, proposalHash: "a".repeat(64),
    evidenceIds: ["pending-evidence-1"], outcome: "accepted" as const,
    gates: Array.from({ length: 11 }, (_, index) => ({
      gateId: `G${String(index + 1).padStart(2, "0")}` as
        `G${"01" | "02" | "03" | "04" | "05" | "06" | "07" | "08" | "09" | "10" | "11"}`,
      status: "passed" as const, reasonCode: "passed",
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
    status: "pending" as const, promotedToMemoryId: null,
    contentHash: "b".repeat(64), activeContentHash: "b".repeat(64),
    evidenceIds: ["pending-evidence-1"], memoryKind: "other" as const,
    semanticType: "rules" as const, admissionRoute: "candidate" as const,
    valueScore: 0.687, importance: 0.7, confidence: 0.75, validationReceipt,
  };
  return {
    executed: true as const,
    receiptIds: ["pending-job-1", "extract_candidate.persist.v1", "pending-evidence-1", "pending-1"],
    jobId: "pending-job-1", effectKey: "extract_candidate.persist.v1" as const,
    evidenceId: "pending-evidence-1", candidate,
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

function productionSealedSummaryReceipt() {
  const leafIds = Array.from({ length: 20 }, (_, index) => `sealed-active-${index + 1}`);
  const evidenceChunkIds = Array.from({ length: 20 }, (_, index) => `sealed-evidence-${index + 1}`);
  return {
    executed: true as const, jobId: "sealed-source-job-1",
    effectKey: "build_tree.persist.v1" as const, requestFingerprint: "d".repeat(64),
    leaseGeneration: 1, committedAt: 100, nodeId: "sealed-source-node-1",
    treeType: "source" as const, treeKey: "sealed-session-1", level: 1 as const,
    status: "sealed" as const, leafIds, evidenceChunkIds,
    leafEvidenceBindings: leafIds.map((leafId, index) => ({
      leafId, evidenceChunkId: evidenceChunkIds[index]!,
      activeLifecycleStatus: "active" as const, activeAdmissionRoute: "active" as const,
      evidenceLifecycleStatus: "archived" as const,
      evidenceAdmissionRoute: "evidence_only" as const,
      evidenceCommandType: "importEvidence" as const,
    })),
    summaryCount: 1 as const, leafCount: 20 as const, sourceBufferCount: 0 as const,
    effectResult: {
      leafId: leafIds.at(-1)!, sealed: true as const, bufferId: null,
      nodeId: "sealed-source-node-1", foldedNodeIds: [],
    },
  };
}

import { loadEvalManifest, selectEvalSuites } from "./eval-manifest.js";
import { buildReport, renderReport, runSuite } from "./quick-eval.js";
import type { CaseResult } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const goldensDir = path.resolve(__dirname, "../goldens");
const manifestPath = path.join(goldensDir, "manifest.json");

const SUITES = selectEvalSuites(
  loadEvalManifest(manifestPath),
  "all",
  manifestPath,
).filter((suite) => suite.kind === "baseline");

for (const suite of SUITES) {
  describe(`golden suite: ${suite.name}`, async () => {
    const { results, summary } = await runSuite(suite.filePath);

    test("suite-level release gate", () => {
      expect(buildReport([summary], [], [suite]).releaseGatePassed).toBe(true);
    });

    const cases: Array<[string, CaseResult]> = results.map((r) => [r.caseId, r]);

    test.each(cases)("case %s should pass", (_caseId, result) => {
      if (!result.passed) {
        // 让失败信息可读
        // 方便直接复现：打印 caseId + failures
        console.error(
          `[${result.suite}] ${result.caseId} failed:\n  - ${result.failures.join("\n  - ")}`,
        );
      }
      expect(result.passed).toBe(true);
    });
  });
}

describe("T500-0 baseline gate 与报告兼容", async () => {
  const baselineRuns = await Promise.all(
    SUITES.map(async (suite) => ({
      plan: suite,
      result: await runSuite(suite.filePath),
    })),
  );

  test("现有两套 baseline 保持 honest green，但 offline 不能标 production release", () => {
    const report = buildReport(
      baselineRuns.map(({ result }) => result.summary),
      [],
      baselineRuns.map(({ plan }) => plan),
    );

    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(report.suites.every((suite) => suite.gatePassed === true)).toBe(true);
    expect(
      report.suites.every(
        (suite) => suite.execution?.runMode === "offline-component",
      ),
    ).toBe(true);
  });

  test("production release 必须同时满足 quality gate 与完整 runtime-e2e metadata", () => {
    const first = baselineRuns[0]!;
    const pending = productionPendingReceipt();
    const sealedSummary = productionSealedSummaryReceipt();
    const runtimeSummary = {
      ...first.result.summary,
      execution: {
        runMode: "runtime-e2e" as const,
        provider: "openai",
        model: "gpt-test",
        prompt: "slot-context-prompt-v1",
        version: "runtime-v1",
        fallback: false,
        degraded: false,
        productionStageEvidence: {
          write_observe: {
            executed: true as const, receiptIds: ["trace-1", "storage-1", "evidence-1"],
            traceId: "trace-1", storageKey: "storage-1", evidenceId: "evidence-1",
            activeMemoryId: "active-1",
          },
          candidate: {
            executed: true as const,
            receiptIds: ["candidate-job-1", "extract_candidate.persist.v1", "evidence-1", "active-1"],
            jobId: "candidate-job-1", effectKey: "extract_candidate.persist.v1" as const,
            evidenceId: "evidence-1", activeMemoryId: "active-1",
            memoryKind: "other" as const, semanticType: "rules" as const,
            admissionRoute: "active" as const,
            lifecycleStatus: "active" as const, contextEligible: true as const,
            valueScore: 0.9, importance: 0.8, confidence: 0.85,
            validatorAudit: {
              semanticType: "rules", admission: "active", valueScore: 0.9,
              confidenceBreakdown: { score: 0.85 },
            },
            dedupTrace: {
              created: 1 as const, duplicateCount: 0, capacityRejectedCount: 0, droppedCount: 0,
              candidateIds: [], memoryIds: ["active-1"], activeMemoryIds: ["active-1"],
            },
            pending,
          },
          graph: {
            executed: true as const,
            receiptIds: [
              "graph-job-1", "extract_graph.persist.v1", "evidence-1", "active-1",
              "entity-1", "relation-1", "memory-link-1", "entity-link-1", "relation-link-1",
              "work-node-memory-1", "work-node-evidence-1", "work-edge-1",
            ],
            jobId: "graph-job-1", effectKey: "extract_graph.persist.v1" as const,
            evidenceId: "evidence-1", activeMemoryId: "active-1",
            entityIds: ["entity-1"], relationIds: ["relation-1"],
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
              edgeId: "work-edge-1", predicate: "grounded_by" as const,
              sourceId: "work-node-memory-1", targetId: "work-node-evidence-1",
              evidenceChunkIds: ["evidence-1"],
            }],
          },
          tree: {
            executed: true as const,
            receiptIds: [
              "build_tree.persist.v1", "source-job-1", "global-job-1", "topic-job-1", "active-1",
              "source-buffer-1", "global-buffer-1", "topic-buffer-1",
            ],
            effectKey: "build_tree.persist.v1" as const, evidenceId: "evidence-1",
            activeMemoryId: "active-1", sourceJobId: "source-job-1",
            expectedTreeTypes: ["source", "global", "topic"] as
              ("source" | "global" | "topic")[],
            sourceTreeKey: "session-1",
            globalJobId: "global-job-1", sourceLeafId: "active-1", globalLeafId: "active-1",
            topicJobIds: ["topic-job-1"], topicLeafIds: ["active-1"],
            topicTreeKeys: ["postgresql-validation"], coldTopicJobIds: [], coldTopicBufferIds: [],
            bufferBindings: [
              { jobId: "source-job-1", treeType: "source" as const, treeKey: "session-1",
                bufferId: "source-buffer-1", leafId: "active-1" },
              { jobId: "global-job-1", treeType: "global" as const, treeKey: "2026-08-13",
                bufferId: "global-buffer-1", leafId: "active-1" },
              { jobId: "topic-job-1", treeType: "topic" as const,
                treeKey: "postgresql-validation", bufferId: "topic-buffer-1",
                leafId: "active-1" },
            ],
            hotness: {
              topicEntityId: "topic-entity-1", threshold: 6 as const,
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
            sealedSummary,
          },
          context_recall: {
            executed: true as const, receiptIds: [
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
          restarted: true as const,
          replayedCandidateJobId: "candidate-job-1",
          effectReceiptIdsBeforeRestart: [
            "candidate-job-1:extract_candidate.persist.v1", "graph-job-1:extract_graph.persist.v1",
            "source-job-1:build_tree.persist.v1", "global-job-1:build_tree.persist.v1",
            "topic-job-1:build_tree.persist.v1",
          ],
          effectReceiptIdsAfterRestart: [
            "candidate-job-1:extract_candidate.persist.v1", "graph-job-1:extract_graph.persist.v1",
            "source-job-1:build_tree.persist.v1", "global-job-1:build_tree.persist.v1",
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
            replayedCandidateJobId: pending.jobId,
            candidateBeforeRestart: pending.candidate,
            candidateAfterRestart: pending.candidate,
            effectTraceBeforeRestart: pending.effectTrace,
            effectTraceAfterRestart: pending.effectTrace,
            proposalReceiptsBeforeRestart: pending.proposalReceipts,
            proposalReceiptsAfterRestart: pending.proposalReceipts,
            derivationCountsBeforeRestart: pending.derivationCounts,
            derivationCountsAfterRestart: pending.derivationCounts,
            visibilityBeforeRestart: pending.visibility,
            visibilityAfterRestart: pending.visibility,
          },
          sealedSummaryBeforeRestart: sealedSummary,
          sealedSummaryAfterRestart: sealedSummary,
          sealedSummaryAttemptsBeforeRestart: 1,
          sealedSummaryAttemptsAfterRestart: 2,
        },
      },
    };
    const report = buildReport([runtimeSummary], [], [first.plan]);

    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(true);
  });

  test("报告写出 metric 协议与执行环境元数据", () => {
    const report = buildReport(
      baselineRuns.map(({ result }) => result.summary),
      [],
      baselineRuns.map(({ plan }) => plan),
    );
    const markdown = renderReport(report);

    expect(markdown).toContain("production release gate：未通过");
    expect(markdown).toContain("run mode：offline-component");
    expect(markdown).toContain("numerator=");
    expect(markdown).toContain("direction=");
    expect(markdown).toContain("manifest schema：1");
    expect(markdown).toContain("manifest version：v0.3-MG009");
    expect(report.manifest.suites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "mengshu-v0.1",
        runner: "slot-context-v1",
        fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        gateIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
  });

  test("buildReport 缺失、多余或重复 suite plan/summary 时 fail-closed", () => {
    const first = baselineRuns[0]!;
    const extraPlan = { ...first.plan, name: "extra-suite" };

    expect(() => buildReport([first.result.summary])).toThrow(/manifest|plan/i);
    expect(() => buildReport(
      [first.result.summary],
      [],
      [first.plan, extraPlan],
    )).toThrow(/多余|extra|一一对应|plan/i);
    expect(() => buildReport(
      [first.result.summary],
      [],
      [first.plan, first.plan],
    )).toThrow(/重复|duplicate|plan/i);
    expect(() => buildReport(
      [first.result.summary, first.result.summary],
      [],
      [first.plan],
    )).toThrow(/重复|duplicate|summary|suite/i);
  });

  test("buildReport 校验 summary totals、passRate、failedCases 与 manifest caseCount", () => {
    const first = baselineRuns[0]!;
    const base = first.result.summary;
    const invalid = [
      { ...base, total: base.total + 1 },
      { ...base, failed: 1 },
      { ...base, passRate: 0.5 },
      { ...base, failedCases: [first.result.results[0]!] },
    ];

    for (const summary of invalid) {
      expect(() => buildReport([summary], [], [first.plan])).toThrow(
        /summary|total|passed|failed|passRate|failedCases|caseCount/i,
      );
    }
  });

  test("safety 任一 case 失败时，即使 wrong injection=0 也不能通过", () => {
    const safety = baselineRuns.find(({ plan }) => plan.name === "mengshu-safety")!;
    const brokenSummary = {
      ...safety.result.summary,
      passed: safety.result.summary.passed - 1,
      failed: 1,
      passRate: (safety.result.summary.total - 1) / safety.result.summary.total,
      failedCases: [
        {
          ...safety.result.results[0],
          passed: false,
          failures: ["must_escape: synthetic failure"],
        },
      ],
    };
    const report = buildReport([brokenSummary], [], [safety.plan]);

    expect(brokenSummary.wrongInjectionRate).toBe(0);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/safety.*case/i);
  });

  test("metric PASS + case FAIL 不得 quality/release PASS", () => {
    const first = baselineRuns[0]!;
    const original = first.result.summary;
    const brokenCase = {
      ...first.result.results[0]!,
      passed: false,
      failures: ["unsupported_contract:synthetic"],
    };
    const brokenSummary = {
      ...original,
      passed: original.passed - 1,
      failed: 1,
      passRate: (original.total - 1) / original.total,
      failedCases: [brokenCase],
      execution: {
        runMode: "runtime-e2e" as const,
        provider: "openai",
        model: "gpt-test",
        prompt: "prompt-v1",
        version: "runtime-v1",
        fallback: false,
        degraded: false,
      },
    };
    expect(brokenSummary.metrics?.every((metric) => metric.passed)).toBe(true);

    const report = buildReport([brokenSummary], [], [first.plan]);

    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/1.*失败 case|失败 case.*1/i);
  });

  test("buildReport 保留并阻断 runner gateFailures，不被 manifest metric gate 覆盖", () => {
    const first = baselineRuns[0]!;
    const runnerFailure = "fixture_contract_issues:2";
    const report = buildReport([
      { ...first.result.summary, gateFailures: [runnerFailure] },
    ], [], [first.plan]);

    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.suites[0].gateFailures).toContain(runnerFailure);
    expect(report.releaseGatePassed).toBe(false);
  });

  test("buildReport 对 contractIssues 独立 fail-closed，即使 runner 漏写 gate failure", () => {
    const first = baselineRuns[0]!;
    const report = buildReport([{
      ...first.result.summary,
      contractIssues: [{
        suite: first.plan.name,
        severity: "warning",
        code: "fixture_contract_gap",
        path: "$.expected",
        message: "unsupported fixture contract",
      }],
    }], [], [first.plan]);

    expect(report.releaseGatePassed).toBe(false);
    expect(report.suites[0].gatePassed).toBe(false);
    expect(report.suites[0].gateFailures?.join("\n")).toMatch(/contract issue/i);
  });

  test("slot-context runner 遇到未支持 expected 字段时 case 明确失败", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-unsupported-expected-"));
    const fixture = path.join(dir, "unsupported.jsonl");
    writeFileSync(
      fixture,
      `${JSON.stringify({
        id: "unsupported-001",
        suite: "unsupported-suite",
        task: "禁止空断言伪绿",
        scope: { userId: "u1" },
        seedMemories: [],
        query: "test",
        expected: { conflict_detected: true },
      })}\n`,
      "utf8",
    );

    try {
      const { results } = await runSuite(fixture);
      expect(results[0].passed).toBe(false);
      expect(results[0].failures).toContain(
        "unsupported expected field: conflict_detected",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
