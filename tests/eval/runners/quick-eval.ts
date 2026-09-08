/**
 * tests/eval/runners/quick-eval — 黄金集快速评测 runner。
 *
 * 本文件做什么：
 *   1) 从 tests/eval/goldens/<suite>.jsonl 加载 GoldenCase。
 *   2) 对每条 case：
 *      - normalize 请求 scope；
 *      - 把 seedMemories 转成 MemoryRecord，过敏感过滤、记录 sensitiveBlockedIds；
 *      - 应用 visibility 过滤、scope 复用过滤、lifecycle 过滤；
 *      - 调 SlotContextBuilder 生成 5 槽位上下文；
 *      - 收集 injectedMemoryIds + filledSlots；
 *      - 调 defaultJudge 判定，产出 CaseResult。
 *   3) 汇总 SuiteSummary，写 markdown 报告到 tests/eval/results/<timestamp>/report.md。
 *
 * 核心流程（CLI）：
 *   tsx tests/eval/runners/quick-eval.ts <suite> [--out <dir>]
 *   suite: 黄金集名（默认 mengshu-v0.1）
 *
 * 关键边界：
 *   - 不调任何 LLM、不连任何向量库；输入只看 seedMemories 和 expected。
 *   - 评测目的是验证 slot-context-builder + scope-policy + sensitive-filter 的集成
 *     语义正确性，不是完整 retrieval pipeline 的端到端。
 *   - quality gate：逐项执行 manifest metric；unsupported expected fail-closed。
 *   - production gate：仅 runtime-e2e 且无 fallback/degraded 才可能通过。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeScope } from "../../../core/scope.js";
import { SlotContextBuilder } from "../../../core/slot-context-builder.js";
import { SlotSnapshotCache } from "../../../core/slot-snapshot.js";
import {
  applyScopeReusePolicy,
  applyVisibilityFilter,
} from "../../../core/scope-policy.js";
import { isSensitive } from "../../../lifecycle/sensitive-filter.js";
import type {
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
} from "../../../core/types.js";

import { loadGoldenJsonl } from "./load-jsonl.js";
import {
  assertRegisteredRunners,
  loadEvalManifest,
  selectEvalSuites,
} from "./eval-manifest.js";
import type { EvalSuitePlan } from "./eval-manifest.js";
import {
  createBaselineMetrics,
  evaluateSuiteGate,
  findMissingProductionStageEvidence,
  findUnsupportedExpectedFields,
  hasValidProductionRestartReplayEvidence,
  isProductionReleaseEligible,
  offlineSlotContextExecution,
} from "./eval-metrics.js";
import { defaultJudge, summarizeSuite } from "./judge.js";
import {
  EXTENSION_RUNNER_REGISTRY,
  type QuickEvalRunner,
} from "./extension-runner-adapters.js";
import type {
  CaseResult,
  EvalReport,
  GoldenCase,
  SeedMemorySpec,
  SuiteSummary,
} from "./types.js";

/** slot-context-v1 确实消费的 expected 字段；其他字段必须显式失败。 */
const SLOT_CONTEXT_SUPPORTED_EXPECTED_FIELDS = new Set([
  "requiredMemoryIds",
  "forbiddenMemoryIds",
  "requiredSlots",
  "answerMustContain",
  "mustEscape",
  "mustEscapeMaxCount",
  "expectSensitiveBlocked",
  "answerMustNotContain",
  "forbiddenBodyPatterns",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 把 seedMemories spec 转换为 MemoryRecord（不含向量；slot builder 不需要向量）。 */
function buildSeedRecord(
  seed: SeedMemorySpec,
  caseScope: MemoryScope,
  createdAt: number,
): MemoryRecord {
  const scope: MemoryScope = seed.scope
    ? normalizeScope(seed.scope, caseScope)
    : caseScope;
  return {
    id: seed.id,
    scope,
    kind: seed.kind,
    semanticType: seed.semanticType,
    text: seed.body,
    contentHash: `sha-${seed.id}`,
    importance: seed.importance ?? 0.7,
    category: "preference",
    dataType: "memory",
    tableName: "memories",
    metadata: seed.metadata ?? {},
    provenance: { source: "user", createdAt },
    lifecycleStatus: seed.lifecycleStatus ?? "active",
    container: seed.container ?? "project",
    createdAt,
  };
}

/**
 * 跑一条 case，返回 (CaseResult, 上下文文本, 注入 id)。
 * 不在这里抛错；任何异常都被吞进 failures。
 */
async function runCase(
  goldenCase: GoldenCase,
  builder: SlotContextBuilder,
): Promise<CaseResult> {
  const start = Date.now();
  const requestScope = normalizeScope(goldenCase.scope);

  // 1) seed → MemoryRecord，敏感属性写入时拦截
  const sensitiveBlockedIds: string[] = [];
  const allRecords: MemoryRecord[] = [];
  for (const seed of goldenCase.seedMemories) {
    if (isSensitive(seed.body)) {
      sensitiveBlockedIds.push(seed.id);
      continue;
    }
    allRecords.push(buildSeedRecord(seed, requestScope, start));
  }

  // 2) 可见性过滤（private + userId 不同 → 过滤）
  const visibilityResult = applyVisibilityFilter(allRecords, requestScope);

  // 3) 复用策略过滤（workspace 级 / project 级）
  const reuseResult = applyScopeReusePolicy(
    visibilityResult.visible,
    requestScope,
  );

  // 4) 调 SlotContextBuilder（含生命周期 active 过滤、semanticType enrich）
  const response = await builder.buildSlotContext(
    requestScope,
    reuseResult.reusable,
    {
      task: goldenCase.task,
      useCache: false,
    },
  );

  const filledSlots: MemorySemanticType[] = [];
  const injectedMemoryIds: string[] = [];
  for (const key of Object.keys(response.slots) as MemorySemanticType[]) {
    const block = response.slots[key];
    if (!block || block.nodeCount === 0) continue;
    filledSlots.push(key);
    injectedMemoryIds.push(...block.sourceIds);
  }

  const latencyMs = Date.now() - start;

  const result = defaultJudge({
    goldenCase,
    injectedMemoryIds,
    filledSlots,
    content: response.content,
    latencyMs,
    tokenEstimate: response.telemetry.tokenEstimate ?? 0,
    sensitiveBlockedIds,
  });
  const unsupported = findUnsupportedExpectedFields(
    goldenCase.expected as unknown as Record<string, unknown>,
    SLOT_CONTEXT_SUPPORTED_EXPECTED_FIELDS,
  );
  if (unsupported.length === 0) return result;
  const failures = [
    ...result.failures,
    ...unsupported.map((field) => `unsupported expected field: ${field}`),
  ];
  return { ...result, passed: false, failures };
}

/** 一次跑完一个 suite。 */
export async function runSuite(suiteFile: string): Promise<{
  cases: GoldenCase[];
  results: CaseResult[];
  summary: SuiteSummary;
}> {
  const cases = loadGoldenJsonl(suiteFile);
  const builder = new SlotContextBuilder(new SlotSnapshotCache());
  const results: CaseResult[] = [];
  for (const goldenCase of cases) {
    const result = await runCase(goldenCase, builder);
    results.push(result);
  }
  const baseSummary = summarizeSuite(
    cases[0]?.suite ?? path.basename(suiteFile, ".jsonl"),
    cases,
    results,
  );
  const summary: SuiteSummary = {
    ...baseSummary,
    metrics: createBaselineMetrics(cases, results, baseSummary),
    execution: offlineSlotContextExecution(),
  };
  return { cases, results, summary };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * 给 production gate 的布尔值补上可审计原因。
 * quality gate 和 production gate 是两层不同契约：offline component 可以让前者
 * 通过，但只有无 fallback/degraded 的 runtime-e2e 执行才允许后者通过。
 */
export function describeProductionGateFailures(report: EvalReport): string[] {
  if (report.productionReleaseGatePassed) return [];
  const failures: string[] = [];
  if (!report.releaseGatePassed) failures.push("quality release gate failed");
  const nonRuntimeSuites = new Map<string, string[]>();
  for (const suite of report.suites) {
    const execution = suite.execution;
    if (!execution) {
      failures.push(`${suite.suite}: missing execution metadata`);
      continue;
    }
    if (execution.runMode !== "runtime-e2e") {
      const names = nonRuntimeSuites.get(execution.runMode) ?? [];
      names.push(suite.suite);
      nonRuntimeSuites.set(execution.runMode, names);
      continue;
    }
    if (!execution.provider) failures.push(`${suite.suite}: missing provider`);
    if (!execution.model) failures.push(`${suite.suite}: missing model`);
    if (!execution.prompt) failures.push(`${suite.suite}: missing prompt`);
    if (!execution.version) failures.push(`${suite.suite}: missing version`);
    if (execution.fallback) failures.push(`${suite.suite}: fallback=true`);
    if (execution.degraded) failures.push(`${suite.suite}: degraded=true`);
    for (const stage of findMissingProductionStageEvidence(execution.productionStageEvidence)) {
      failures.push(`${suite.suite}: missing production stage evidence '${stage}'`);
    }
    if (!hasValidProductionRestartReplayEvidence(suite)) {
      failures.push(`${suite.suite}: invalid production restart replay evidence`);
    }
  }
  for (const [runMode, suites] of nonRuntimeSuites) {
    failures.push(`runMode=${runMode} suites=${suites.join(",")}`);
  }
  return failures;
}

/** 把一个 suite 的报告渲染成 markdown 文本。 */
export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# mengshu 评测报告`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- manifest schema：${report.manifest.schemaVersion}`);
  lines.push(`- manifest version：${report.manifest.version ?? "-"}`);
  lines.push(`- 总 case 数：${report.totalCases}`);
  lines.push(`- 通过：${report.totalPassed}`);
  lines.push(`- 失败：${report.totalFailed}`);
  lines.push(`- GMS：${report.tracks.general.effectScore ?? "未运行"}`);
  lines.push(`- PMS：${report.tracks.private.effectScore ?? "未运行"}`);
  lines.push(
    `- Q 轨 quality gate：${report.qualityGatePassed ? "通过" : "未通过"}`,
  );
  lines.push(
    `- 版本发布门禁：${report.versionReleaseGatePassed ? "通过" : "未通过（G/P 未完成）"}`,
  );
  lines.push(
    `- release gate（兼容字段，等同 Q 轨）：${report.releaseGatePassed ? "通过" : "未通过"}`,
  );
  lines.push(
    `- production release gate：${report.productionReleaseGatePassed ? "通过" : "未通过"}`,
  );
  for (const failure of describeProductionGateFailures(report)) {
    lines.push(`- production gate reason：${failure}`);
  }
  lines.push("");

  for (const suite of report.suites) {
    const manifestSuite = report.manifest.suites.find((item) => item.name === suite.suite)!;
    lines.push(`## suite: ${suite.suite}`);
    lines.push("");
    lines.push(`- 总数：${suite.total}`);
    lines.push(`- 通过：${suite.passed}`);
    lines.push(`- 失败：${suite.failed}`);
    lines.push(`- pass rate：${formatPercent(suite.passRate)}`);
    if (manifestSuite.kind === "baseline") {
      lines.push(
        `- slot recall pass rate：${formatPercent(suite.slotRecallPassRate)}`,
      );
      lines.push(
        `- wrong injection rate：${formatPercent(suite.wrongInjectionRate)}`,
      );
      lines.push(`- latency P50：${suite.latencyP50Ms} ms`);
      lines.push(`- latency P95：${suite.latencyP95Ms} ms`);
    }
    lines.push(`- suite gate：${suite.gatePassed ? "通过" : "未通过"}`);
    lines.push(`- runner：${manifestSuite.runner}`);
    lines.push(`- fixture sha256：${manifestSuite.fixtureSha256}`);
    lines.push(`- gate identity：${manifestSuite.gateIdentity}`);
    const execution = suite.execution ?? offlineSlotContextExecution();
    lines.push(`- run mode：${execution.runMode}`);
    lines.push(`- provider：${execution.provider ?? "-"}`);
    lines.push(`- model：${execution.model ?? "-"}`);
    lines.push(`- prompt：${execution.prompt ?? "-"}`);
    lines.push(`- version：${execution.version}`);
    lines.push(`- fallback：${execution.fallback}`);
    lines.push(`- degraded：${execution.degraded}`);
    lines.push("");

    if ((suite.metrics?.length ?? 0) > 0) {
      lines.push(`### Metrics`);
      lines.push("");
      for (const metric of suite.metrics ?? []) {
        lines.push(
          `- ${metric.name}: numerator=${metric.numerator}, denominator=${metric.denominator}, value=${metric.value}, direction=${metric.direction}, threshold=${metric.threshold}, passed=${metric.passed}`,
        );
      }
      lines.push("");
    }

    if ((suite.gateFailures?.length ?? 0) > 0) {
      lines.push(`### Gate failures`);
      lines.push("");
      for (const failure of suite.gateFailures ?? []) {
        lines.push(`- ${failure}`);
      }
      lines.push("");
    }

    if ((suite.contractIssues?.length ?? 0) > 0) {
      lines.push(`### Contract issues`);
      lines.push("");
      for (const issue of suite.contractIssues ?? []) {
        lines.push(
          `- ${issue.code}: suite=${issue.suite}, case=${issue.caseId ?? "-"}, path=${issue.path}, message=${issue.message}`,
        );
      }
      lines.push("");
    }

    if (suite.failedCases.length > 0) {
      lines.push(`### 失败 case`);
      lines.push("");
      for (const fc of suite.failedCases) {
        lines.push(`- **${fc.caseId}**`);
        for (const f of fc.failures) {
          lines.push(`  - ${f}`);
        }
      }
      lines.push("");
    }
  }

  if (report.notes && report.notes.length > 0) {
    lines.push(`## 备注`);
    lines.push("");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n") + "\n";
}

/** 把多个 suite 合并成一个 EvalReport。 */
export function buildReport(
  summaries: SuiteSummary[],
  notes: string[] = [],
  suitePlans?: ReadonlyArray<
    Pick<
      EvalSuitePlan,
      | "name"
      | "track"
      | "datasetVersion"
      | "kind"
      | "runner"
      | "caseCount"
      | "sha256"
      | "metrics"
      | "gate"
      | "requiredProductionStages"
      | "manifestSchemaVersion"
      | "manifestVersion"
    >
  >,
): EvalReport {
  if (!suitePlans || suitePlans.length === 0 || summaries.length === 0) {
    throw new Error("buildReport requires non-empty manifest suitePlans and summaries");
  }
  assertUniqueNames(summaries.map((summary) => summary.suite), "summary suite");
  assertUniqueNames(suitePlans.map((plan) => plan.name), "manifest suite plan");
  const summaryNames = new Set(summaries.map((summary) => summary.suite));
  const planNames = new Set(suitePlans.map((plan) => plan.name));
  const missingPlans = [...summaryNames].filter((name) => !planNames.has(name));
  const extraPlans = [...planNames].filter((name) => !summaryNames.has(name));
  if (missingPlans.length > 0 || extraPlans.length > 0) {
    throw new Error(
      `manifest suitePlans 与 summaries 必须一一对应；missing=${missingPlans.join(",")}; extra=${extraPlans.join(",")}`,
    );
  }
  const planByName = new Map(suitePlans.map((plan) => [plan.name, plan]));
  const evaluated = summaries.map((summary) => {
    const metrics = summary.metrics ?? [];
    const execution = summary.execution ?? offlineSlotContextExecution();
    const plan = planByName.get(summary.suite);
    if (!plan) throw new Error(`summary suite '${summary.suite}' 缺少 manifest plan`);
    assertSummaryIntegrity(summary, plan.caseCount);
    const contract = { kind: plan.kind, metrics: plan.metrics, gate: plan.gate };
    const gate = evaluateSuiteGate(
      { ...summary, metrics, execution },
      contract,
    );
    const contractIssueFailures = (summary.contractIssues ?? []).map(
      (issue) =>
        `contract issue '${issue.code}' at ${issue.caseId ?? issue.suite}:${issue.path}`,
    );
    const gateFailures = [...new Set([
      ...(summary.gateFailures ?? []),
      ...contractIssueFailures,
      ...gate.failures,
    ])];
    return {
      ...summary,
      metrics,
      execution,
      gatePassed: summary.failed === 0 && gate.passed && gateFailures.length === 0,
      gateFailures,
    };
  });

  const totalCases = evaluated.reduce((sum, s) => sum + s.total, 0);
  const totalPassed = evaluated.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = evaluated.reduce((sum, s) => sum + s.failed, 0);
  const qualitySuites = evaluated.filter((suite) =>
    planByName.get(suite.suite)?.track === "quality");
  const qualityGatePassed = qualitySuites.length > 0 &&
    qualitySuites.every((suite) => suite.gatePassed);
  const releaseGatePassed = qualityGatePassed;
  const productionReleaseGatePassed =
    qualityGatePassed && qualitySuites.length === evaluated.length &&
    isProductionReleaseEligible(qualitySuites);
  const manifestSchemaVersions = new Set(
    suitePlans.map((plan) => plan.manifestSchemaVersion),
  );
  const manifestVersions = new Set(suitePlans.map((plan) => plan.manifestVersion));
  if (manifestSchemaVersions.size !== 1 || manifestVersions.size !== 1) {
    throw new Error("suite plans 来自不一致的 manifest identity");
  }
  const manifestSuites = summaries.map((summary) => {
    const plan = planByName.get(summary.suite)!;
    const gate = plan.gate ?? null;
    const requiredProductionStages = plan.requiredProductionStages ?? null;
    const gateIdentity = createHash("sha256").update(JSON.stringify({
      track: plan.track,
      datasetVersion: plan.datasetVersion,
      kind: plan.kind,
      metrics: plan.metrics,
      gate,
      requiredProductionStages,
    })).digest("hex");
    return {
      name: plan.name,
      track: plan.track,
      datasetVersion: plan.datasetVersion,
      kind: plan.kind,
      runner: plan.runner,
      fixtureCaseCount: plan.caseCount,
      fixtureSha256: plan.sha256,
      metrics: [...plan.metrics],
      gate,
      requiredProductionStages,
      gateIdentity,
    };
  });

  const trackSummary = (
    track: "general" | "private" | "quality",
  ) => {
    const members = evaluated.filter((suite) => planByName.get(suite.suite)?.track === track);
    return Object.freeze({
      track,
      suiteCount: members.length,
      totalCases: members.reduce((sum, suite) => sum + suite.total, 0),
      totalPassed: members.reduce((sum, suite) => sum + suite.passed, 0),
      totalFailed: members.reduce((sum, suite) => sum + suite.failed, 0),
      scoreName: track === "general" ? "GMS" as const
        : track === "private" ? "PMS" as const
          : null,
      effectScore: null,
      gatePassed: track === "quality" ? qualityGatePassed : null,
    });
  };
  const tracks = Object.freeze({
    general: trackSummary("general"),
    private: trackSummary("private"),
    quality: trackSummary("quality"),
  });

  return {
    generatedAt: new Date().toISOString(),
    manifest: {
      schemaVersion: [...manifestSchemaVersions][0]!,
      version: [...manifestVersions][0]!,
      suites: manifestSuites,
    },
    suites: evaluated,
    totalCases,
    totalPassed,
    totalFailed,
    tracks,
    qualityGatePassed,
    versionReleaseGatePassed: false,
    releaseGatePassed,
    productionReleaseGatePassed,
    notes,
  };
}

function assertUniqueNames(names: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) throw new Error(`${label} '${name}' 重复`);
    seen.add(name);
  }
}

function assertSummaryIntegrity(summary: SuiteSummary, manifestCaseCount: number): void {
  if (!Number.isInteger(summary.total) || summary.total <= 0 ||
      !Number.isInteger(summary.passed) || summary.passed < 0 ||
      !Number.isInteger(summary.failed) || summary.failed < 0 ||
      summary.total !== summary.passed + summary.failed) {
    throw new Error(`suite '${summary.suite}' summary total/passed/failed 不一致`);
  }
  if (summary.total !== manifestCaseCount) {
    throw new Error(`suite '${summary.suite}' summary total 与 manifest caseCount 不一致`);
  }
  const expectedPassRate = summary.passed / summary.total;
  if (!Number.isFinite(summary.passRate) || summary.passRate !== expectedPassRate) {
    throw new Error(`suite '${summary.suite}' summary passRate 不一致`);
  }
  if (!Array.isArray(summary.failedCases) || summary.failedCases.length !== summary.failed) {
    throw new Error(`suite '${summary.suite}' summary failedCases 不一致`);
  }
  const failedIds = summary.failedCases.map((result) => result.caseId);
  assertUniqueNames(failedIds, `suite '${summary.suite}' failed case`);
  if (summary.failedCases.some((result) => result.suite !== summary.suite || result.passed)) {
    throw new Error(`suite '${summary.suite}' summary failedCases 内容非法`);
  }
}

function timestampDir(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, "-");
}

/** CLI 主函数。 */
async function main(argv: string[]): Promise<void> {
  const goldensDir = path.resolve(__dirname, "../goldens");
  const resultsDir = path.resolve(__dirname, "../results");

  const args = argv.slice(2);
  // 默认必须覆盖 manifest 全量；extension 的真实失败必须进入统一报告，
  // 避免无参数命令只跑一套 baseline 却输出 release gate PASS。
  let suiteName = "all";
  let suiteWasSet = false;
  let outDir = path.join(resultsDir, timestampDir());
  let manifestPath = path.join(goldensDir, "manifest.json");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--suite") {
      if (!args[i + 1]) throw new Error("[quick-eval] --suite 缺少名称");
      if (suiteWasSet) throw new Error("[quick-eval] suite 只能指定一次");
      suiteName = args[i + 1];
      suiteWasSet = true;
      i++;
    } else if (args[i] === "--out") {
      if (!args[i + 1]) throw new Error("[quick-eval] --out 缺少路径");
      outDir = path.resolve(args[i + 1]);
      i++;
    } else if (args[i] === "--manifest") {
      if (!args[i + 1]) throw new Error("[quick-eval] --manifest 缺少路径");
      manifestPath = path.resolve(args[i + 1]);
      i++;
    } else if (args[i].startsWith("--")) {
      throw new Error(`[quick-eval] 未知参数 '${args[i]}'`);
    } else if (!suiteWasSet) {
      suiteName = args[i];
      suiteWasSet = true;
    } else {
      throw new Error(`[quick-eval] 多余参数 '${args[i]}'`);
    }
  }

  const runnerRegistry = new Map<string, QuickEvalRunner>([
    ["slot-context-v1", runSuite],
    ...EXTENSION_RUNNER_REGISTRY,
  ]);
  const manifest = loadEvalManifest(manifestPath);
  const selectedSuites = selectEvalSuites(manifest, suiteName, manifestPath);
  assertRegisteredRunners(selectedSuites, new Set(runnerRegistry.keys()));

  const summaries: SuiteSummary[] = [];
  for (const suite of selectedSuites) {
    const runner = runnerRegistry.get(suite.runner);
    if (!runner) {
      throw new Error(`[quick-eval] 未实现 runner '${suite.runner}'`);
    }
    const { summary } = await runner(suite.filePath);
    if (summary.suite !== suite.name) {
      throw new Error(
        `[quick-eval] fixture schema 错误：manifest suite '${suite.name}' 与 fixture suite '${summary.suite}' 不一致`,
      );
    }
    summaries.push(summary);
  }

  const report = buildReport(summaries, [], selectedSuites);
  mkdirSync(outDir, { recursive: true });

  const md = renderReport(report);
  writeFileSync(path.join(outDir, "report.md"), md, "utf-8");
  writeFileSync(
    path.join(outDir, "report.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  // 控制台简报
  console.log(`[quick-eval] suite=${suiteName}`);
  for (const s of summaries) {
    const evaluated = report.suites.find((suite) => suite.suite === s.suite)!;
    console.log(
      `  ${s.suite}: ${s.passed}/${s.total} (${formatPercent(
        s.passRate,
      )}), failed=${s.failed}, gate=${evaluated.gatePassed ? "PASS" : "FAIL"}`,
    );
    for (const failure of evaluated.gateFailures ?? []) {
      console.log(`    gate failure: ${failure}`);
    }
  }
  console.log(
    `  quality gate: ${report.qualityGatePassed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  version release gate: ${report.versionReleaseGatePassed ? "PASS" : "FAIL"}`,
  );
  console.log(
    `  production release gate: ${report.productionReleaseGatePassed ? "PASS" : "FAIL"}`,
  );
  for (const failure of describeProductionGateFailures(report)) {
    console.log(`  production gate reason: ${failure}`);
  }
  console.log(`  report → ${path.relative(process.cwd(), outDir)}`);

  if (!report.releaseGatePassed) {
    process.exitCode = 2;
  }
}

// 仅在直接执行时运行 main（避免被 vitest 加载时触发）。
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isDirectRun) {
  main(process.argv).catch((err) => {
    console.error("[quick-eval] 失败：", err);
    process.exit(2);
  });
}
