/**
 * eval/runners/quick-eval — 黄金集快速评测 runner。
 *
 * 本文件做什么：
 *   1) 从 eval/goldens/<suite>.jsonl 加载 GoldenCase。
 *   2) 对每条 case：
 *      - normalize 请求 scope；
 *      - 把 seedMemories 转成 MemoryRecord，过敏感过滤、记录 sensitiveBlockedIds；
 *      - 应用 visibility 过滤、scope 复用过滤、lifecycle 过滤；
 *      - 调 SlotContextBuilder 生成 5 槽位上下文；
 *      - 收集 injectedMemoryIds + filledSlots；
 *      - 调 defaultJudge 判定，产出 CaseResult。
 *   3) 汇总 SuiteSummary，写 markdown 报告到 eval/results/<timestamp>/report.md。
 *
 * 核心流程（CLI）：
 *   tsx eval/runners/quick-eval.ts <suite> [--out <dir>]
 *   suite: 黄金集名（默认 mengshu-v0.1）
 *
 * 关键边界：
 *   - 不调任何 LLM、不连任何向量库；输入只看 seedMemories 和 expected。
 *   - 评测目的是验证 slot-context-builder + scope-policy + sensitive-filter 的集成
 *     语义正确性，不是完整 retrieval pipeline 的端到端。
 *   - release gate：safety 套件 wrong_injection_rate 必须为 0。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeScope } from "../../core/scope.js";
import { SlotContextBuilder } from "../../core/slot-context-builder.js";
import { SlotSnapshotCache } from "../../core/slot-snapshot.js";
import {
  applyScopeReusePolicy,
  applyVisibilityFilter,
} from "../../core/scope-policy.js";
import { isSensitive } from "../../lifecycle/sensitive-filter.js";
import type {
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
} from "../../core/types.js";

import { loadGoldenJsonl } from "./load-jsonl.js";
import { defaultJudge, summarizeSuite } from "./judge.js";
import type {
  CaseResult,
  EvalReport,
  GoldenCase,
  SeedMemorySpec,
  SuiteSummary,
} from "./types.js";

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

  return defaultJudge({
    goldenCase,
    injectedMemoryIds,
    filledSlots,
    content: response.content,
    latencyMs,
    tokenEstimate: response.telemetry.tokenEstimate ?? 0,
    sensitiveBlockedIds,
  });
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
  const summary = summarizeSuite(
    cases[0]?.suite ?? path.basename(suiteFile, ".jsonl"),
    cases,
    results,
  );
  return { cases, results, summary };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

/** 把一个 suite 的报告渲染成 markdown 文本。 */
export function renderReport(report: EvalReport): string {
  const lines: string[] = [];
  lines.push(`# mengshu 评测报告`);
  lines.push("");
  lines.push(`- 生成时间：${report.generatedAt}`);
  lines.push(`- 总 case 数：${report.totalCases}`);
  lines.push(`- 通过：${report.totalPassed}`);
  lines.push(`- 失败：${report.totalFailed}`);
  lines.push(
    `- release gate：${report.releaseGatePassed ? "通过" : "未通过"}`,
  );
  lines.push("");

  for (const suite of report.suites) {
    lines.push(`## suite: ${suite.suite}`);
    lines.push("");
    lines.push(`- 总数：${suite.total}`);
    lines.push(`- 通过：${suite.passed}`);
    lines.push(`- 失败：${suite.failed}`);
    lines.push(`- pass rate：${formatPercent(suite.passRate)}`);
    lines.push(
      `- slot recall pass rate：${formatPercent(suite.slotRecallPassRate)}`,
    );
    lines.push(
      `- wrong injection rate：${formatPercent(suite.wrongInjectionRate)}`,
    );
    lines.push(`- latency P50：${suite.latencyP50Ms} ms`);
    lines.push(`- latency P95：${suite.latencyP95Ms} ms`);
    lines.push("");

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
): EvalReport {
  const totalCases = summaries.reduce((sum, s) => sum + s.total, 0);
  const totalPassed = summaries.reduce((sum, s) => sum + s.passed, 0);
  const totalFailed = summaries.reduce((sum, s) => sum + s.failed, 0);

  // release gate：safety 套件 wrong_injection_rate 必须为 0；
  // 其他套件 pass rate 必须 >= 80%。
  const safetySuite = summaries.find((s) =>
    s.suite.includes("safety"),
  );
  const safetyOk = safetySuite ? safetySuite.wrongInjectionRate === 0 : true;
  const overallOk = summaries.every((s) =>
    s.suite.includes("safety") ? true : s.passRate >= 0.8,
  );

  return {
    generatedAt: new Date().toISOString(),
    suites: summaries,
    totalCases,
    totalPassed,
    totalFailed,
    releaseGatePassed: safetyOk && overallOk,
    notes,
  };
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
  const suiteName = args[0] ?? "mengshu-v0.1";

  // 简易参数解析
  let outDir = path.join(resultsDir, timestampDir());
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--out" && args[i + 1]) {
      outDir = args[i + 1];
      i++;
    }
  }

  const suiteFile = path.join(goldensDir, `${suiteName}.jsonl`);
  // 跑单 suite，但若用户传 "all"，就把全部 jsonl 都跑
  const summaries: SuiteSummary[] = [];
  if (suiteName === "all") {
    const allFiles = ["mengshu-v0.1", "mengshu-safety"];
    for (const name of allFiles) {
      const file = path.join(goldensDir, `${name}.jsonl`);
      const { summary } = await runSuite(file);
      summaries.push(summary);
    }
  } else {
    const { summary } = await runSuite(suiteFile);
    summaries.push(summary);
  }

  const report = buildReport(summaries);
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
    console.log(
      `  ${s.suite}: ${s.passed}/${s.total} (${formatPercent(
        s.passRate,
      )}), wrong_injection_rate=${formatPercent(
        s.wrongInjectionRate,
      )}, P95=${s.latencyP95Ms}ms`,
    );
  }
  console.log(
    `  release gate: ${report.releaseGatePassed ? "PASS" : "FAIL"}`,
  );
  console.log(`  report → ${path.relative(process.cwd(), outDir)}`);

  if (!report.releaseGatePassed) {
    process.exitCode = 1;
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
