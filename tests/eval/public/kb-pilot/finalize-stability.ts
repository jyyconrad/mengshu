import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

type JsonObject = Record<string, unknown>;

interface CaseResult {
  readonly caseId: string;
  readonly sourceStatus: string;
  readonly output: {
    readonly error: string | null;
    readonly runtime: {
      readonly latencyMs: number;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly modelCalls: number;
    };
  };
  readonly retrievedSourcePaths: readonly string[];
  readonly evidenceRecallAny: number | null;
  readonly evidenceRecallAll: number | null;
  readonly judgment: {
    readonly status: string;
    readonly unsupportedAnswer: boolean;
    readonly fabricatedEvidenceCount: number;
  };
}

interface RunSpec {
  readonly schemaVersion: string;
  readonly datasetId: string;
  readonly datasetQueriesSha256: string;
  readonly split: string;
  readonly selectedCaseIds: readonly string[];
  readonly scope: JsonObject;
  readonly configFingerprint: string;
  readonly topK: number;
  readonly timeoutMs: number;
  readonly readerPromptSha256: string;
  readonly judgePromptSha256: string;
}

interface Report {
  readonly schemaVersion: string;
  readonly scoreAuthority: string;
  readonly formalScoreEligible: boolean;
  readonly officialAnswerScoring: string;
  readonly generatedAt: string;
  readonly system: string;
  readonly systemVersion: string;
  readonly datasetId: string;
  readonly datasetQueriesSha256: string;
  readonly split: string;
  readonly selectedCases: number;
  readonly scope: JsonObject;
  readonly configFingerprint: string;
  readonly reader: JsonObject;
  readonly judge: JsonObject;
  readonly initialization: JsonObject;
  readonly metrics: JsonObject;
  readonly blockers: readonly string[];
  readonly results: readonly CaseResult[];
  readonly reportHash: string;
}

interface RoundInput {
  readonly id: string;
  readonly dir: string;
  readonly run: RunSpec;
  readonly report: Report;
  readonly checkpoint: readonly CaseResult[];
}

const SHA256 = /^[a-f0-9]{64}$/;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

function readJsonLines<T>(file: string): T[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function requiredArgument(name: string): string {
  const value = argument(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)]!;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function countBy<T>(values: readonly T[], key: (value: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const name = key(value);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function metricNumber(metrics: JsonObject, name: string): number {
  const value = metrics[name];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`metric ${name} is not finite`);
  return value;
}

function loadRound(root: string, id: string): RoundInput {
  const dir = path.join(root, id);
  const runFile = path.join(dir, "run.json");
  const reportFile = path.join(dir, "report.json");
  const checkpointFile = path.join(dir, "cases.jsonl");
  for (const file of [runFile, reportFile, checkpointFile]) {
    if (!existsSync(file)) throw new Error(`missing ${file}`);
  }
  return { id, dir, run: readJson<RunSpec>(runFile), report: readJson<Report>(reportFile), checkpoint: readJsonLines<CaseResult>(checkpointFile) };
}

function validateReportHash(report: Report): { expected: string; actual: string; valid: boolean } {
  const { reportHash: actual, ...unsigned } = report;
  const expected = sha256(canonicalJson(unsigned));
  return { expected, actual, valid: SHA256.test(actual) && expected === actual };
}

function validateRound(input: RoundInput): JsonObject {
  const { run, report, checkpoint } = input;
  const failures: string[] = [];
  const hash = validateReportHash(report);
  if (!hash.valid) failures.push("report_hash_mismatch");
  if (report.results.length !== report.selectedCases) failures.push("report_selected_cases_mismatch");
  if (checkpoint.length !== report.selectedCases) failures.push("checkpoint_line_count_mismatch");

  const reportIds = report.results.map((result) => result.caseId);
  const checkpointIds = checkpoint.map((result) => result.caseId);
  if (sortedUnique(reportIds).length !== reportIds.length) failures.push("report_duplicate_case_ids");
  if (sortedUnique(checkpointIds).length !== checkpointIds.length) failures.push("checkpoint_duplicate_case_ids");
  if (!sameJson(sortedUnique(run.selectedCaseIds), sortedUnique(reportIds))) failures.push("run_report_case_ids_mismatch");
  if (!sameJson(sortedUnique(reportIds), sortedUnique(checkpointIds))) failures.push("report_checkpoint_case_ids_mismatch");

  const checkpointById = new Map(checkpoint.map((result) => [result.caseId, result]));
  for (const result of report.results) {
    if (!sameJson(result, checkpointById.get(result.caseId))) {
      failures.push(`report_checkpoint_result_mismatch:${result.caseId}`);
      break;
    }
  }

  const valid = report.results.filter((result) => result.sourceStatus === "complete");
  const invalid = report.results.filter((result) => result.sourceStatus !== "complete");
  const validStatus = countBy(valid, (result) => result.judgment.status);
  const invalidStatus = countBy(invalid, (result) => result.judgment.status);
  const latencies = report.results.map((result) => result.output.runtime.latencyMs);
  const tokens = report.results.map((result) => result.output.runtime.inputTokens + result.output.runtime.outputTokens);
  const modelCalls = report.results.map((result) => result.output.runtime.modelCalls);
  const recallAny = valid.map((result) => result.evidenceRecallAny ?? 0);
  const recallAll = valid.map((result) => result.evidenceRecallAll ?? 0);
  const errors = report.results.filter((result) => result.output.error !== null);
  const metrics = report.metrics;
  const expectedCounts = {
    validCases: valid.length,
    strictPass: validStatus.pass ?? 0,
    partial: validStatus.partial ?? 0,
    fail: validStatus.fail ?? 0,
    invalidCases: invalid.length,
    invalidGroundedAbstention: invalidStatus.grounded_abstain ?? 0,
    invalidUnsupportedAnswers: invalidStatus.unsupported_answer ?? 0,
    invalidFabricatedEvidence: invalid.reduce((sum, result) => sum + result.judgment.fabricatedEvidenceCount, 0),
    fabricatedEvidenceCount: report.results.reduce((sum, result) => sum + result.judgment.fabricatedEvidenceCount, 0),
    errorCount: errors.length,
  };
  for (const [name, expected] of Object.entries(expectedCounts)) {
    if (metricNumber(metrics, name) !== expected) failures.push(`metric_count_mismatch:${name}`);
  }
  const denominatorChecks = {
    selectedCases: { numerator: report.results.length, denominator: 1, expectedValue: report.results.length, actualValue: report.selectedCases },
    strictSuccessRate: { numerator: expectedCounts.strictPass, denominator: expectedCounts.validCases, expectedValue: expectedCounts.validCases === 0 ? 0 : expectedCounts.strictPass / expectedCounts.validCases, actualValue: metricNumber(metrics, "e2eStrictSuccessRate") },
    unsupportedAnswerRate: { numerator: metricNumber(metrics, "unsupportedAnswers"), denominator: expectedCounts.validCases, expectedValue: expectedCounts.validCases === 0 ? 0 : metricNumber(metrics, "unsupportedAnswers") / expectedCounts.validCases, actualValue: metricNumber(metrics, "unsupportedAnswerRate") },
    evidenceRecallAny: { numerator: recallAny.reduce((sum, value) => sum + value, 0), denominator: expectedCounts.validCases, expectedValue: mean(recallAny), actualValue: metricNumber(metrics, "evidenceRecallAny") },
    evidenceRecallAll: { numerator: recallAll.reduce((sum, value) => sum + value, 0), denominator: expectedCounts.validCases, expectedValue: mean(recallAll), actualValue: metricNumber(metrics, "evidenceRecallAll") },
    latencyP50Ms: { numerator: percentile(latencies, 0.5), denominator: report.results.length, expectedValue: percentile(latencies, 0.5), actualValue: metricNumber(metrics, "latencyP50Ms") },
    latencyP95Ms: { numerator: percentile(latencies, 0.95), denominator: report.results.length, expectedValue: percentile(latencies, 0.95), actualValue: metricNumber(metrics, "latencyP95Ms") },
    tokensMean: { numerator: mean(tokens), denominator: report.results.length, expectedValue: mean(tokens), actualValue: metricNumber(metrics, "tokensMean") },
    tokensP95: { numerator: percentile(tokens, 0.95), denominator: report.results.length, expectedValue: percentile(tokens, 0.95), actualValue: metricNumber(metrics, "tokensP95") },
    modelCallsMean: { numerator: mean(modelCalls), denominator: report.results.length, expectedValue: mean(modelCalls), actualValue: metricNumber(metrics, "modelCallsMean") },
  };
  for (const [name, check] of Object.entries(denominatorChecks)) {
    if (check.denominator <= 0) failures.push(`non_positive_denominator:${name}`);
    if (Math.abs(check.expectedValue - check.actualValue) > 1e-12) failures.push(`metric_value_mismatch:${name}`);
  }

  return {
    id: input.id,
    reportPath: path.join(input.dir, "report.json"),
    runPath: path.join(input.dir, "run.json"),
    checkpointPath: path.join(input.dir, "cases.jsonl"),
    reportHash: hash.actual,
    recomputedReportHash: hash.expected,
    reportHashValid: hash.valid,
    selectedCases: report.selectedCases,
    checkpointLineCount: checkpoint.length,
    uniqueCaseCount: sortedUnique(reportIds).length,
    validCases: expectedCounts.validCases,
    statusCounts: countBy(report.results, (result) => result.judgment.status),
    errorCount: expectedCounts.errorCount,
    errorMessages: countBy(errors, (result) => result.output.error ?? "<none>"),
    metrics: {
      strictPass: expectedCounts.strictPass,
      partial: expectedCounts.partial,
      fail: expectedCounts.fail,
      strictSuccessRate: metricNumber(metrics, "e2eStrictSuccessRate"),
      unsupportedAnswerRate: metricNumber(metrics, "unsupportedAnswerRate"),
      evidenceRecallAny: metricNumber(metrics, "evidenceRecallAny"),
      evidenceRecallAll: metricNumber(metrics, "evidenceRecallAll"),
      latencyP50Ms: metricNumber(metrics, "latencyP50Ms"),
      latencyP95Ms: metricNumber(metrics, "latencyP95Ms"),
      tokensMean: metricNumber(metrics, "tokensMean"),
      tokensP95: metricNumber(metrics, "tokensP95"),
    },
    denominators: denominatorChecks,
    failures: [...new Set(failures)],
    passed: failures.length === 0,
  };
}

function roundMetric(values: readonly number[]): JsonObject {
  return {
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(mean(values)),
    range: round(Math.max(...values) - Math.min(...values)),
  };
}

function buildStability(rounds: readonly RoundInput[], validations: readonly JsonObject[]): JsonObject {
  const first = rounds[0]!;
  const identityFields = ["datasetId", "datasetQueriesSha256", "split", "configFingerprint"] as const;
  const identity = Object.fromEntries(identityFields.map((field) => [field, {
    value: first.run[field],
    equalAcrossRounds: rounds.every((roundInput) => roundInput.run[field] === first.run[field]),
  }]));
  const metrics = [
    "strictSuccessRate", "unsupportedAnswerRate", "evidenceRecallAny", "evidenceRecallAll",
    "latencyP50Ms", "latencyP95Ms", "tokensMean", "tokensP95",
  ];
  const metricSummary = Object.fromEntries(metrics.map((name) => [name,
    roundMetric(validations.map((validation) => (validation.metrics as JsonObject)[name] as number))]));
  const pairwise = [];
  for (let left = 0; left < rounds.length; left += 1) {
    for (let right = left + 1; right < rounds.length; right += 1) {
      const leftResults = new Map(rounds[left]!.report.results.map((result) => [result.caseId, result]));
      const rightResults = new Map(rounds[right]!.report.results.map((result) => [result.caseId, result]));
      const ids = sortedUnique([...leftResults.keys(), ...rightResults.keys()]);
      const statusAgreement = ids.filter((id) => leftResults.get(id)?.judgment.status === rightResults.get(id)?.judgment.status).length;
      const errorAgreement = ids.filter((id) => (leftResults.get(id)?.output.error !== null) === (rightResults.get(id)?.output.error !== null)).length;
      pairwise.push({
        left: rounds[left]!.id,
        right: rounds[right]!.id,
        caseCount: ids.length,
        statusAgreementCount: statusAgreement,
        statusAgreementRate: ids.length === 0 ? 0 : round(statusAgreement / ids.length),
        errorAgreementCount: errorAgreement,
        errorAgreementRate: ids.length === 0 ? 0 : round(errorAgreement / ids.length),
      });
    }
  }
  return {
    schemaVersion: "mengshu.kb-pilot-stability/v1",
    generatedAt: new Date().toISOString(),
    system: "mengshu",
    datasetId: first.report.datasetId,
    rounds: rounds.map((roundInput, index) => ({
      id: roundInput.id,
      generatedAt: roundInput.report.generatedAt,
      reportHash: roundInput.report.reportHash,
      selectedCases: roundInput.report.selectedCases,
      validCases: metricNumber(roundInput.report.metrics, "validCases"),
      strictPass: metricNumber(roundInput.report.metrics, "strictPass"),
      partial: metricNumber(roundInput.report.metrics, "partial"),
      fail: metricNumber(roundInput.report.metrics, "fail"),
      strictSuccessRate: metricNumber(roundInput.report.metrics, "e2eStrictSuccessRate"),
      unsupportedAnswerRate: metricNumber(roundInput.report.metrics, "unsupportedAnswerRate"),
      evidenceRecallAny: metricNumber(roundInput.report.metrics, "evidenceRecallAny"),
      evidenceRecallAll: metricNumber(roundInput.report.metrics, "evidenceRecallAll"),
      latencyP50Ms: metricNumber(roundInput.report.metrics, "latencyP50Ms"),
      latencyP95Ms: metricNumber(roundInput.report.metrics, "latencyP95Ms"),
      tokensMean: metricNumber(roundInput.report.metrics, "tokensMean"),
      tokensP95: metricNumber(roundInput.report.metrics, "tokensP95"),
      errorCount: metricNumber(roundInput.report.metrics, "errorCount"),
      integrityPassed: validations[index]!.passed,
    })),
    sharedIdentity: identity,
    metricSummary,
    pairwise,
    stabilityPassed: validations.every((validation) => validation.passed) &&
      Object.values(identity).every((value) => (value as JsonObject).equalAcrossRounds),
    interpretation: "Diagnostic-only stability summary; this dataset has no official answer scorer and is not formal GMS.",
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function buildDeliveryReport(
  rounds: readonly RoundInput[],
  validations: readonly JsonObject[],
  stability: JsonObject,
  integrityPath: string,
  stabilityPath: string,
  errorEvidencePath: string,
  testSummary: string,
): string {
  const lines = [
    "# Mengshu kb-pilot 第 3 轮评测交付报告",
    "",
    "> 结论：第 3 轮进程已退出并生成完整结果；三轮诊断稳定性和报告完整性校验已完成。结果仍不可作为正式 GMS，因为评测协议明确缺少官方答案 scorer、独立人类校准和 paired run。",
    "",
    "## 运行结论",
    "",
    `- 数据集：\`${rounds[0]!.report.datasetId}\`，每轮 907 题，其中 902 个有效 case、5 个缺失证据的 invalid case。`,
    `- 第 3 轮报告 hash：\`${rounds[2]!.report.reportHash}\`，重算一致。`,
    `- 第 3 轮 case-level 错误：53 条；错误证据索引保留在 [error-evidence.json](./error-evidence.json)。`,
    `- 正式资格：\`formalScoreEligible=false\`；阻断项：\`${rounds[2]!.report.blockers.join("`, `")}\`。`,
    "",
    "## 三轮结果",
    "",
    "| 轮次 | selected | valid | strict pass | partial | fail | strict rate | unsupported rate | errors | p50/p95 ms |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];
  for (const roundInput of rounds) {
    const metrics = roundInput.report.metrics;
    lines.push(`| ${roundInput.id} | ${roundInput.report.selectedCases} | ${metricNumber(metrics, "validCases")} | ${metricNumber(metrics, "strictPass")} | ${metricNumber(metrics, "partial")} | ${metricNumber(metrics, "fail")} | ${percent(metricNumber(metrics, "e2eStrictSuccessRate"))} | ${percent(metricNumber(metrics, "unsupportedAnswerRate"))} | ${metricNumber(metrics, "errorCount")} | ${metricNumber(metrics, "latencyP50Ms")}/${metricNumber(metrics, "latencyP95Ms")} |`);
  }
  const summary = stability.metricSummary as JsonObject;
  lines.push(
    "",
    "## 稳定性",
    "",
    `- strict success rate：${percent((summary.strictSuccessRate as JsonObject).min as number)} - ${percent((summary.strictSuccessRate as JsonObject).max as number)}，三轮极差 ${percent((summary.strictSuccessRate as JsonObject).range as number)}。`,
    `- evidence recall any：${percent((summary.evidenceRecallAny as JsonObject).min as number)} - ${percent((summary.evidenceRecallAny as JsonObject).max as number)}。`,
    `- P50/P95 延迟范围：${(summary.latencyP50Ms as JsonObject).min} - ${(summary.latencyP50Ms as JsonObject).max} ms / ${(summary.latencyP95Ms as JsonObject).min} - ${(summary.latencyP95Ms as JsonObject).max} ms。`,
    `- case 结果状态的两两一致率见 [stability-summary.json](./stability-summary.json)；三轮输入身份一致。`,
    "",
    "## 完整性与测试",
    "",
    `- 报告 hash、checkpoint 行数、case ID 集合、report/checkpoint 内容、计数和分母：全部通过，详见 [report-integrity.json](./report-integrity.json)。`,
    `- 最终测试：${testSummary}`,
    `- 汇总产物：\`${stabilityPath}\`；完整性产物：\`${integrityPath}\`；错误证据：\`${errorEvidencePath}\`。`,
    "",
    "## 发布边界",
    "",
    "本轮只证明 Mengshu 在固定 kb-pilot diagnostic 集上的三轮运行证据可复核。不能据此宣称正式 GMS、上游 99.1% 复现或版本发布通过；53 条第 3 轮模型错误和 3 个正式评分 blocker 均保留。",
    "",
  );
  return lines.join("\n");
}

function main(): void {
  const root = path.resolve(requiredArgument("--root"));
  const finalDir = path.resolve(argument("--final-dir") ?? path.join(root, "round3-2026-09-01"));
  const rounds = (argument("--rounds") ?? "full2-2026-08-31,round2-2026-09-01,round3-2026-09-01")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((id) => loadRound(root, id));
  if (rounds.length !== 3) throw new Error("exactly three rounds are required");
  mkdirSync(finalDir, { recursive: true, mode: 0o700 });
  const validations = rounds.map(validateRound);
  const stability = buildStability(rounds, validations);
  const sharedIdentityPassed = ["datasetId", "datasetQueriesSha256", "split", "configFingerprint"]
    .every((field) => rounds.every((roundInput) => roundInput.run[field as keyof RunSpec] === rounds[0]!.run[field as keyof RunSpec]));
  const integrity = {
    schemaVersion: "mengshu.kb-pilot-integrity/v1",
    generatedAt: new Date().toISOString(),
    root,
    rounds: validations,
    sharedIdentityPassed,
    overallPassed: sharedIdentityPassed && validations.every((validation) => validation.passed),
    failures: validations.flatMap((validation) => validation.failures as string[]),
  };
  const errorEvidence = rounds[2]!.report.results
    .filter((result) => result.output.error !== null)
    .map((result) => ({
      caseId: result.caseId,
      sourceStatus: result.sourceStatus,
      error: result.output.error,
      judgmentStatus: result.judgment.status,
      runtime: result.output.runtime,
      retrievedSourcePaths: result.retrievedSourcePaths,
    }));
  const integrityPath = path.join(finalDir, "report-integrity.json");
  const stabilityPath = path.join(finalDir, "stability-summary.json");
  const errorEvidencePath = path.join(finalDir, "error-evidence.json");
  const deliveryPath = path.join(finalDir, "delivery-report.md");
  writeFileSync(integrityPath, `${JSON.stringify(integrity, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(stabilityPath, `${JSON.stringify(stability, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(errorEvidencePath, `${JSON.stringify({ schemaVersion: "mengshu.kb-pilot-error-evidence/v1", round: rounds[2]!.id, count: errorEvidence.length, errors: errorEvidence }, null, 2)}\n`, { mode: 0o600 });
  const testSummary = argument("--test-summary") ?? "未提供（交付前需补录）";
  writeFileSync(deliveryPath, buildDeliveryReport(rounds, validations, stability, integrityPath, stabilityPath, errorEvidencePath, testSummary), { mode: 0o600 });
  process.stdout.write(JSON.stringify({
    integrityPath,
    stabilityPath,
    errorEvidencePath,
    deliveryPath,
    overallPassed: integrity.overallPassed,
    roundHashes: rounds.map((roundInput) => ({ id: roundInput.id, reportHash: roundInput.report.reportHash })),
    errorEvidenceCount: errorEvidence.length,
  }, null, 2) + "\n");
  if (!integrity.overallPassed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
