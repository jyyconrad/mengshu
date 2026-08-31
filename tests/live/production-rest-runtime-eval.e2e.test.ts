import path from "node:path";

import { describe, expect, test } from "vitest";

import { vectorDimsForModel } from "../../config.js";
import { createEmbeddingSpace } from
  "../../packages/core/src/domain/embedding-space.js";
import { PostgresProvider } from "../../packages/core/src/db/providers/postgres.js";
import { loadEvalManifest, selectEvalSuites } from "../eval/runners/eval-manifest.js";
import {
  buildReport,
  describeProductionGateFailures,
} from "../eval/runners/quick-eval.js";
import {
  createRuntimeE2eProgressReporter,
  runProductionRestRuntimeE2eSuite,
} from "../eval/runners/runtime-e2e.js";
import { findProductionTreeReceiptIssues } from "../eval/runners/eval-metrics.js";
import {
  loadGlobalMengshuConfig,
  provisionGlobalPostgresTestSchema,
} from "./global-postgres-config.js";

const liveEnabled = process.env.MENGSHU_RUN_LIVE_TESTS === "1";
const manifestPath = path.resolve(import.meta.dirname, "../eval/runtime-e2e/manifest.json");

describe.skipIf(!liveEnabled)("production REST RuntimeHost eval live e2e", () => {
  test("真实 production composition 的五阶段 receipts 与 restart replay 齐全后才通过 gate", async () => {
    const global = loadGlobalMengshuConfig();
    if (!global.config.llm) {
      throw new Error("production runtime-e2e requires the global Mengshu LLM configuration");
    }
    const embeddingModel = global.config.embedding.model ?? "text-embedding-3-small";
    const extractionModel = global.config.llm.extractionModel ?? global.config.llm.model;
    const isolated = await provisionGlobalPostgresTestSchema("production_runtime");
    const provider = new PostgresProvider(isolated.postgres, embeddingModel);
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(manifest, "mengshu-runtime-rest", manifestPath)[0]!;
    expect(plan.runMode).toBe("runtime-e2e");
    try {
      await provider.initialize();
      await provider.applyScopeContentHashDedupeContract({
        maintenance: true,
        quiescenceConfirmed: true,
      });
      await provider.registerActiveEmbeddingSpace(createEmbeddingSpace({
        provider: global.config.embedding.provider,
        baseURL: global.config.embedding.baseURL!,
        model: embeddingModel,
        dim: vectorDimsForModel(embeddingModel),
        normalization: "none",
      }));

      const run = await runProductionRestRuntimeE2eSuite(plan.filePath, {
        postgres: isolated.postgres,
        configPath: global.configPath,
        embeddingModel,
        extractionModel,
        projectRoot: path.resolve(import.meta.dirname, "../.."),
        timeoutMs: 90_000,
        onProgress: createRuntimeE2eProgressReporter((line) => console.error(line)),
      });
      const report = buildReport([run.summary], [], [plan]);

      expect(run.results).toEqual([
        expect.objectContaining({
          caseId: "runtime-rest-001",
          passed: true,
          failures: [],
          filledSlots: ["experience", "profile", "resource", "rules", "task_context"],
          hitRequired: expect.arrayContaining([
            expect.stringMatching(/^[0-9a-f-]{36}$/),
          ]),
        }),
      ]);
      expect(report.releaseGatePassed).toBe(true);
      expect(
        report.productionReleaseGatePassed,
        [
          ...describeProductionGateFailures(report),
          ...findProductionTreeReceiptIssues(run.summary.execution?.productionStageEvidence?.tree)
            .map((issue) => `tree:${issue}`),
        ].join("; "),
      ).toBe(true);
      expect(report.suites[0]).toMatchObject({
        gatePassed: true,
        execution: {
          runMode: "runtime-e2e",
          provider: "postgresql-pgvector+operator-configured-openai-compatible",
          model: `${embeddingModel}+${extractionModel}`,
          version: "production-rest-runtime-host-v3",
          fallback: false,
          degraded: false,
          productionStageEvidence: {
            write_observe: { executed: true, evidenceId: expect.any(String) },
            candidate: {
              executed: true,
              effectKey: "extract_candidate.persist.v1",
              activeMemoryId: expect.any(String),
              memoryKind: expect.stringMatching(
                /^(preference|decision|entity|fact|task|plan|goal|document|knowledge|observation|other)$/,
              ),
              dedupTrace: expect.objectContaining({
                created: 1,
                duplicateCount: 0,
                capacityRejectedCount: 0,
                droppedCount: 0,
                candidateIds: [],
              }),
              pending: {
                executed: true,
                effectKey: "extract_candidate.persist.v1",
                candidate: expect.objectContaining({
                  candidateId: expect.any(String),
                  scope: expect.objectContaining({
                    tenantId: expect.any(String), userId: expect.any(String),
                    appId: expect.any(String), projectId: expect.any(String),
                    agentId: expect.any(String), namespace: expect.any(String),
                    visibility: "private", workspaceId: expect.any(String), sessionId: expect.any(String),
                  }),
                  status: "pending", promotedToMemoryId: null,
                  contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                  activeContentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
                  evidenceIds: expect.arrayContaining([expect.any(String)]),
                  admissionRoute: expect.stringMatching(/^candidate(?:_low_priority)?$/),
                  validationReceipt: expect.objectContaining({
                    policyVersion: "candidate-validator-v1", outcome: "accepted",
                    gates: expect.arrayContaining([
                      expect.objectContaining({ gateId: "G01" }),
                      expect.objectContaining({ gateId: "G11" }),
                    ]),
                  }),
                }),
                effectTrace: {
                  created: 1, duplicateCount: 0, capacityRejectedCount: 0, droppedCount: 0,
                  candidateIds: expect.arrayContaining([expect.any(String)]),
                  memoryIds: [], activeMemoryIds: [],
                },
                derivationCounts: {
                  memories: 0, graphJobs: 0, treeJobs: 0, treeBuffers: 0,
                  workMemoryNodes: 0, workMemoryEdges: 0, evidenceLinks: 0,
                },
                visibility: expect.objectContaining({
                  contextSourceIds: expect.any(Array), lookupHitIds: expect.any(Array),
                  recallHitIds: expect.any(Array),
                }),
                proposalReceipts: expect.arrayContaining([expect.objectContaining({
                  outcome: "accepted",
                  admission: expect.objectContaining({
                    route: expect.stringMatching(/^candidate(?:_low_priority)?$/),
                  }),
                })]),
              },
            },
            graph: {
              executed: true,
              effectKey: "extract_graph.persist.v1",
              entityIds: expect.arrayContaining([expect.any(String)]),
              relationIds: expect.arrayContaining([expect.any(String)]),
              memoryEvidenceLinkIds: expect.arrayContaining([expect.any(String)]),
              entityEvidenceLinkIds: expect.arrayContaining([expect.any(String)]),
              relationEvidenceLinkIds: expect.arrayContaining([expect.any(String)]),
              memoryEvidenceBindings: expect.arrayContaining([
                expect.objectContaining({ linkId: expect.any(String), targetId: expect.any(String) }),
              ]),
              entityEvidenceBindings: expect.arrayContaining([
                expect.objectContaining({ linkId: expect.any(String), targetId: expect.any(String) }),
              ]),
              relationEvidenceBindings: expect.arrayContaining([
                expect.objectContaining({ linkId: expect.any(String), targetId: expect.any(String) }),
              ]),
              workMemoryNodeIds: expect.arrayContaining([expect.any(String)]),
              workMemoryEdgeIds: expect.arrayContaining([expect.any(String)]),
              workMemoryEdgeBindings: expect.arrayContaining([expect.objectContaining({
                edgeId: expect.any(String), predicate: "grounded_by",
                sourceId: expect.any(String), targetId: expect.any(String),
                evidenceChunkIds: expect.arrayContaining([expect.any(String)]),
              })]),
            },
            tree: {
              executed: true,
              effectKey: "build_tree.persist.v1",
              expectedTreeTypes: expect.arrayContaining(["source"]),
              sourceJobId: expect.any(String),
              sourceTreeKey: expect.any(String),
              topicJobIds: expect.any(Array),
              topicLeafIds: expect.any(Array),
              bufferBindings: expect.arrayContaining([
                expect.objectContaining({
                  jobId: expect.any(String), bufferId: expect.any(String), leafId: expect.any(String),
                }),
              ]),
              sealedSummary: expect.objectContaining({
                executed: true, treeType: "source", level: 1, status: "sealed",
                leafCount: 20, summaryCount: 1, sourceBufferCount: 0,
                leafIds: expect.arrayContaining([expect.any(String)]),
                evidenceChunkIds: expect.arrayContaining([expect.any(String)]),
              }),
            },
            context_recall: {
              executed: true,
              contextSourceIds: expect.arrayContaining([expect.any(String)]),
              lookupHitIds: expect.arrayContaining([expect.any(String)]),
              recallHitIds: expect.arrayContaining([expect.any(String)]),
              contextScoreBreakdown: expect.objectContaining({ weights: expect.any(Object) }),
              lookupScoreBreakdown: expect.objectContaining({ weights: expect.any(Object) }),
              recallScoreBreakdown: expect.objectContaining({ weights: expect.any(Object) }),
              slotActiveMemoryIds: {
                profile: expect.any(String), task_context: expect.any(String),
                rules: expect.any(String), experience: expect.any(String), resource: expect.any(String),
              },
              slotSourceIds: {
                profile: expect.arrayContaining([expect.any(String)]),
                task_context: expect.arrayContaining([expect.any(String)]),
                rules: expect.arrayContaining([expect.any(String)]),
                experience: expect.arrayContaining([expect.any(String)]),
                resource: expect.arrayContaining([expect.any(String)]),
              },
              slotScoreBreakdowns: {
                profile: expect.objectContaining({ weights: expect.any(Object) }),
                task_context: expect.objectContaining({ weights: expect.any(Object) }),
                rules: expect.objectContaining({ weights: expect.any(Object) }),
                experience: expect.objectContaining({ weights: expect.any(Object) }),
                resource: expect.objectContaining({ weights: expect.any(Object) }),
              },
            },
          },
          productionRestartReplayEvidence: {
            restarted: true,
            replayedCandidateJobId: expect.any(String),
            effectReceiptIdsBeforeRestart: expect.arrayContaining([
              expect.stringContaining(":extract_candidate.persist.v1"),
              expect.stringContaining(":extract_graph.persist.v1"),
              expect.stringContaining(":build_tree.persist.v1"),
            ]),
            pending: expect.objectContaining({
              replayedCandidateJobId: expect.any(String),
              candidateBeforeRestart: expect.objectContaining({ status: "pending" }),
              candidateAfterRestart: expect.objectContaining({ status: "pending" }),
              derivationCountsAfterRestart: {
                memories: 0, graphJobs: 0, treeJobs: 0, treeBuffers: 0,
                workMemoryNodes: 0, workMemoryEdges: 0, evidenceLinks: 0,
              },
            }),
            sealedSummaryBeforeRestart: expect.objectContaining({
              treeType: "source", level: 1, status: "sealed", leafCount: 20,
            }),
            sealedSummaryAfterRestart: expect.objectContaining({
              treeType: "source", level: 1, status: "sealed", leafCount: 20,
            }),
            sealedSummaryAttemptsBeforeRestart: expect.any(Number),
            sealedSummaryAttemptsAfterRestart: expect.any(Number),
          },
        },
      });
    } finally {
      await provider.close();
      await isolated.dispose();
    }
  }, 600_000);
});
