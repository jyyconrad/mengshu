import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadEvalManifest, selectEvalSuites } from "./eval-manifest.js";
import { buildReport, describeProductionGateFailures } from "./quick-eval.js";
import {
  canonicalTopicKeysSettled,
  createRuntimeE2eProgressReporter,
  expectedRuntimeTreeTypes,
  parseRuntimeRestFixture,
  PRODUCTION_BUILD_TREE_REPLAY_SQL,
  PRODUCTION_CANDIDATE_REPLAY_SQL,
  PRODUCTION_GRAPH_REPLAY_SQL,
  RUNTIME_E2E_PROGRESS_STAGES,
  selectColdHotnessWitness,
  selectHotMultisourceWitness,
} from "./runtime-e2e.js";
import type { SuiteSummary } from "./types.js";

const manifestPath = path.resolve(
  import.meta.dirname,
  "../runtime-e2e/manifest.json",
);

describe("production runtime-e2e eval contract", () => {
  test("runtime gate 复用 D-03：0.629 experience 只要求 source tree", () => {
    expect(expectedRuntimeTreeTypes({
      valueScore: 0.629,
      importance: 0.9,
      semanticType: "experience",
      scopeVisibility: "project",
      riskFlags: [],
      explicitGlobal: false,
      isWorkspaceRule: false,
    }, false)).toEqual(["source"]);
  });

  test("runtime gate 对高 importance global 和 D-21 eligible topic 保持 fail-closed 预期", () => {
    const routing = {
      valueScore: 0.9,
      importance: 0.9,
      semanticType: "rules" as const,
      scopeVisibility: "workspace" as const,
      riskFlags: [] as string[],
      explicitGlobal: false,
      isWorkspaceRule: true,
    };

    expect(expectedRuntimeTreeTypes(routing, false)).toEqual(["global", "source"]);
    expect(expectedRuntimeTreeTypes(routing, true)).toEqual(["global", "source", "topic"]);
  });

  test("独立 manifest 明确声明真实 RuntimeHost + REST suite", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;

    expect(plan).toMatchObject({
      kind: "extension",
      runner: "production-rest-runtime-host-v3",
      runMode: "runtime-e2e",
      liveGate: "MENGSHU_RUN_LIVE_TESTS=1",
      transport: "rest-http",
      composition: "ms-serve-runtime-host",
      metrics: ["case_pass_rate"],
      gate: { case_pass_rate: 1 },
      caseCount: 1,
      requiredProductionStages: [
        "write_observe",
        "candidate",
        "graph",
        "tree",
        "context_recall",
      ],
    });
  });

  test("fixture bytes/hash 与 parser 合同使用 active、pending 和 20 条 sealed source 输入", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(manifest, "mengshu-runtime-rest", manifestPath)[0]!;
    const bytes = fs.readFileSync(plan.filePath);
    const fixture = parseRuntimeRestFixture(plan.filePath);

    expect(bytes.byteLength).toBe(manifest.suites[plan.name]!.bytes);
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe(manifest.suites[plan.name]!.sha256);
    expect(fixture.input.observations).toHaveLength(2);
    expect(fixture.input.observations[0].idempotencyKey)
      .not.toBe(fixture.input.observations[1].idempotencyKey);
    expect(fixture.input.pendingObservation).toMatchObject({
      text: expect.stringContaining("REVIEW_WINDOW_1"),
      idempotencyKey: expect.any(String),
    });
    expect(fixture.input.observations.map(({ idempotencyKey }) => idempotencyKey))
      .not.toContain(fixture.input.pendingObservation.idempotencyKey);
    expect(fixture.input.pendingQuery).toContain("REVIEW_WINDOW_1");
    expect(fixture.input.sealedSourceMemories).toHaveLength(20);
    expect(new Set(fixture.input.sealedSourceMemories.map(({ text }) => text)).size).toBe(20);
    expect(new Set(fixture.input.sealedSourceMemories.map(({ idempotencyKey }) => idempotencyKey)))
      .toHaveProperty("size", 20);
    expect(fixture.input.sealedSourceMemories.every(({ metadata }) => metadata.salience === 0.3))
      .toBe(true);
    expect(fixture.expected).not.toHaveProperty("treeTypes");
  });

  test("fixture sealed source 不是恰好 20 条 distinct 显式记忆时 parser fail-closed", () => {
    const fixture = JSON.parse(fs.readFileSync(
      selectEvalSuites(loadEvalManifest(manifestPath), "mengshu-runtime-rest", manifestPath)[0]!.filePath,
      "utf8",
    )) as { input: { sealedSourceMemories: unknown[] } };
    fixture.input.sealedSourceMemories.pop();
    const tempPath = path.resolve(import.meta.dirname, `runtime-e2e-invalid-${randomUUID()}.jsonl`);
    fs.writeFileSync(tempPath, `${JSON.stringify(fixture)}\n`);
    try {
      expect(() => parseRuntimeRestFixture(tempPath)).toThrow(/fixture contract is invalid/);
    } finally {
      fs.unlinkSync(tempPath);
    }
  });

  test("D-21 hotness witness 来自同一 cold graph receipt，且 canonical name 可回到 observation", () => {
    const snapshot = (topicEntityId: string, canonicalName: string, score: number) => ({
      topicEntityId, canonicalName, mentionCount30d: 1, distinctSourceCount: 1,
      lastSeenAt: 1, recencyDecay: 1, graphCentrality: 0, queryHits30d: 0, score,
    });
    const witness = selectColdHotnessWitness([
      snapshot("chunk-evidence-a", "evidence-a", 5.9),
      snapshot("first-only", "PostgreSQL 验证", 5.8),
      snapshot("shared-mengshu", "mengshu", 4.2),
    ], ["first-only", "shared-mengshu"],
    "PostgreSQL 验证是 Mengshu 的真实发布门禁。",
    );

    expect(witness?.topicEntityId).toBe("first-only");
    expect(selectColdHotnessWitness([
      snapshot("chunk-evidence-a", "evidence-a", 5.9),
    ], ["chunk-evidence-a"], "第一条 observation")).toBeUndefined();
  });

  test("canonical topic 只有全部 expected keys 完成后才算收敛", () => {
    expect(canonicalTopicKeysSettled(
      ["postgresql-validation"],
      ["mengshu", "postgresql-validation"],
    )).toBe(false);
    expect(canonicalTopicKeysSettled(
      ["postgresql-validation", "mengshu"],
      ["mengshu", "postgresql-validation"],
    )).toBe(true);
    expect(canonicalTopicKeysSettled(
      ["postgresql-validation", "mengshu", "unexpected"],
      ["mengshu", "postgresql-validation"],
    )).toBe(false);
  });

  test("multisource witness 必须绑定实际升温并落到 canonical topic tree 的实体", () => {
    const hotTopic = {
      topicEntityId: "hot-topic", canonicalName: "PostgreSQL 验证",
      mentionCount30d: 1, distinctSourceCount: 1, lastSeenAt: 1,
      recencyDecay: 1, graphCentrality: 0, queryHits30d: 3, score: 8,
    };

    expect(selectHotMultisourceWitness(hotTopic, ["postgresql-验证"]))
      .toEqual(hotTopic);
    expect(selectHotMultisourceWitness(hotTopic, ["mengshu"]))
      .toBeUndefined();
  });

  test("context_recall 使用同一 shared query 生成 IDs 与 breakdown", () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, "runtime-e2e.ts"), "utf8");

    expect(runner).toContain("const sharedRecallQuery =");
    expect(runner).toContain(
      "baseUrl, isolation.scope, sharedRecallQuery, slotActiveMemoryIds, timeoutMs",
    );
    expect(runner).toContain("query: sharedRecallQuery, minScore: 0, limit: 10");
    expect(runner).not.toMatch(/multisource(?:Context|Lookup|Recall)/);
  });

  test("D-21 只通过原 graph job replay 重跑 production post-projection", () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, "runtime-e2e.ts"), "utf8");
    expect(PRODUCTION_GRAPH_REPLAY_SQL).toContain("type = 'extract_graph'");
    expect(PRODUCTION_GRAPH_REPLAY_SQL).toContain("status = 'completed'");
    expect(PRODUCTION_GRAPH_REPLAY_SQL).toContain("payload->>'activeMemoryId' = $13");
    expect(PRODUCTION_GRAPH_REPLAY_SQL).toContain("payload->>'evidenceId' = $14");
    expect(PRODUCTION_GRAPH_REPLAY_SQL).not.toMatch(/INSERT|DELETE|mengshu_tree_buffers/i);
    expect(runner).toContain("coldChain.graphAttempts + 1");
  });

  test("production replay 只重置执行状态，不得篡改 durable command 身份", () => {
    for (const replaySql of [
      PRODUCTION_CANDIDATE_REPLAY_SQL,
      PRODUCTION_GRAPH_REPLAY_SQL,
      PRODUCTION_BUILD_TREE_REPLAY_SQL,
    ]) {
      const updateClause = replaySql.split(/\bWHERE\b/i)[0] ?? replaySql;
      expect(updateClause).not.toMatch(
        /\b(?:type|payload|dedupe_key|scoped_dedupe_key|max_attempts|tenant_id|user_id|app_id|project_id|agent_id|namespace|visibility)\s*=/i,
      );
      expect(replaySql).toContain("status = 'retry_wait'");
      expect(replaySql).toContain("next_attempt_at = $2");
      expect(replaySql).toContain("attempts < max_attempts");
    }
  });

  test("五槽显式保存按确定顺序执行，并在失败时保留具体 slot 身份", () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, "runtime-e2e.ts"), "utf8");

    expect(runner).toContain("for (const slotMemory of goldenCase.input.slotMemories)");
    expect(runner).toContain("production ${slotMemory.semanticType} slot save failed");
    expect(runner).not.toContain(
      "Promise.all(goldenCase.input.slotMemories.map",
    );
  });

  test("production timeout 进度只输出固定阶段名与脱敏计数", () => {
    const lines: string[] = [];
    const report = createRuntimeE2eProgressReporter((line) => lines.push(line));

    report({ stage: "slot_save", completed: 3, total: 5 });

    expect(RUNTIME_E2E_PROGRESS_STAGES).toEqual([
      "initial_graph_tree",
      "slot_save",
      "seal_save",
      "sealed_summary_ready",
      "restart_replay",
    ]);
    expect(lines).toEqual(["[runtime-e2e-progress] slot_save 3/5"]);
    expect(lines[0]).not.toMatch(/scope|text|token|password|provider|payload|secret/i);
  });

  test("production timeout 进度拒绝额外字段、未知阶段与非法计数且不输出", () => {
    const lines: string[] = [];
    const report = createRuntimeE2eProgressReporter((line) => lines.push(line));

    expect(() => report({
      stage: "slot_save",
      completed: 1,
      total: 5,
      payload: { secret: "must-not-leak" },
    } as never)).toThrow(/progress evidence is invalid/);
    expect(() => report({ stage: "provider_payload", completed: 1, total: 1 } as never))
      .toThrow(/progress evidence is invalid/);
    expect(() => report({ stage: "seal_save", completed: 21, total: 20 }))
      .toThrow(/progress evidence is invalid/);
    expect(lines).toEqual([]);
  });

  test("runner 在长等待前发阶段起点，并对五槽与二十条 seal 保存逐条递增", () => {
    const runner = fs.readFileSync(path.resolve(import.meta.dirname, "runtime-e2e.ts"), "utf8");

    for (const stage of RUNTIME_E2E_PROGRESS_STAGES) {
      expect(runner).toContain(`progress(options, "${stage}"`);
    }
    expect(runner).toContain("progress(options, \"slot_save\", slotSaveResponses.length, 5)");
    expect(runner).toContain("progress(options, \"seal_save\", sealSaveResponses.length, 20)");
    expect(runner).toContain("progress(options, \"restart_replay\", 2, 3)");
    expect(runner).toContain("progress(options, \"restart_replay\", 3, 3)");
  });

  test("每次运行必须使用唯一 scope/namespace，且无安全清理能力时 fail-closed", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "runtime-e2e.ts"), "utf8");

    expect(source).toContain("isolation.scope");
    expect(source).not.toMatch(/const scope\s*=|MENGSHU_HOME|DROP\s+SCHEMA|resetDatabase/);
    expect(() => parseRuntimeRestFixture(manifestPath)).toThrow();
    expect(randomUUID()).not.toBe(randomUUID());
  });

  test("单一预置 build_tree receipt 不具备 production release 资格", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;
    const summary: SuiteSummary = {
      suite: plan.name,
      total: 1,
      passed: 1,
      failed: 0,
      passRate: 1,
      slotRecallPassRate: 0,
      wrongInjectionRate: 0,
      latencyP50Ms: 1,
      latencyP95Ms: 1,
      failedCases: [],
      metrics: [{
        name: "case_pass_rate",
        numerator: 1,
        denominator: 1,
        value: 1,
        direction: "min",
        threshold: 1,
        passed: true,
      }],
      execution: {
        runMode: "runtime-e2e",
        provider: "postgresql-pgvector",
        model: "not-applicable-runtime-contract",
        prompt: "not-applicable-runtime-contract",
        version: "production-rest-runtime-host-v1",
        fallback: false,
        degraded: false,
        productionStageEvidence: {
          tree: {
            executed: true,
            receiptIds: ["eval-runtime-build-tree-001"],
            effectKey: "build_tree.persist.v1",
            evidenceId: "eval-runtime-leaf-001",
            activeMemoryId: "eval-runtime-leaf-001",
            sourceJobId: "eval-runtime-build-tree-001",
            globalJobId: "missing-global-tree-job",
            sourceLeafId: "eval-runtime-leaf-001",
            globalLeafId: "missing-global-tree-leaf",
          } as never,
        },
      },
    };

    const report = buildReport([summary], [], [plan]);

    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(describeProductionGateFailures(report)).toEqual([
      "mengshu-runtime-rest: missing production stage evidence 'write_observe'",
      "mengshu-runtime-rest: missing production stage evidence 'candidate'",
      "mengshu-runtime-rest: missing production stage evidence 'graph'",
      "mengshu-runtime-rest: missing production stage evidence 'tree'",
      "mengshu-runtime-rest: missing production stage evidence 'context_recall'",
      "mengshu-runtime-rest: invalid production restart replay evidence",
    ]);
  });

  test("未执行 live suite 时 production gate 不能因 skip 假绿", () => {
    const manifest = loadEvalManifest(manifestPath);
    const plan = selectEvalSuites(
      manifest,
      "mengshu-runtime-rest",
      manifestPath,
    )[0]!;
    const failedCase = {
      caseId: "runtime-rest-001",
      suite: plan.name,
      passed: false,
      failures: ["live runtime evidence missing"],
      hitRequired: [],
      missedRequired: [],
      injectedForbidden: [],
      filledSlots: [],
      latencyMs: 0,
      tokenEstimate: 0,
    };
    const summary: SuiteSummary = {
      suite: plan.name,
      total: 1,
      passed: 0,
      failed: 1,
      passRate: 0,
      slotRecallPassRate: 0,
      wrongInjectionRate: 0,
      latencyP50Ms: 0,
      latencyP95Ms: 0,
      failedCases: [failedCase],
      metrics: [{
        name: "case_pass_rate",
        numerator: 0,
        denominator: 1,
        value: 0,
        direction: "min",
        threshold: 1,
        passed: false,
      }],
      execution: {
        runMode: "runtime-e2e",
        provider: null,
        model: null,
        prompt: null,
        version: "not-executed",
        fallback: false,
        degraded: true,
      },
      gateFailures: ["live runtime evidence missing"],
    };

    const report = buildReport([summary], [], [plan]);
    expect(report.releaseGatePassed).toBe(false);
    expect(report.productionReleaseGatePassed).toBe(false);
  });
});
