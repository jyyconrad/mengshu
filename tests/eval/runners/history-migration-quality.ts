import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCHEMA_VERSION = "mengshu-history-migration-quality/v1" as const;
const SEMANTIC_TYPES = [
  "profile",
  "rules",
  "experience",
  "resource",
  "task_context",
] as const;
const DISPOSITIONS = [
  "context",
  "lookup_only",
  "legacy_quarantine",
  "new_quarantine",
] as const;
const CONFLICT_STATES = ["present", "absent", "not_applicable"] as const;
const SCENARIOS = ["conflict", "cross_scope"] as const;
const REQUIRED_COVERAGE = [
  ...SEMANTIC_TYPES.map((value) => `semantic:${value}`),
  "disposition:lookup_only",
  "disposition:legacy_quarantine",
  "disposition:new_quarantine",
  "scenario:conflict",
  "scenario:cross_scope",
] as const;
const THRESHOLD_NAMES = [
  "classificationMacroPrecision",
  "classificationMacroRecall",
  "dispositionAccuracy",
  "topicPrecision",
  "topicRecall",
  "topicExactMatchRate",
  "conflictAccuracy",
  "wrongInjectionRate",
] as const;

export type HistorySemanticType = typeof SEMANTIC_TYPES[number];
export type HistoryQualityDisposition = typeof DISPOSITIONS[number];
export type HistoryConflictState = typeof CONFLICT_STATES[number];
export type HistoryQualityScenario = typeof SCENARIOS[number];
export type HistoryQualityThresholdName = typeof THRESHOLD_NAMES[number];
export type HistoryQualityIssueCode =
  | "semantic_type_mismatch"
  | "disposition_mismatch"
  | "topic_false_positive"
  | "topic_false_negative"
  | "conflict_mismatch"
  | "wrong_scope_injection";

export interface HistoryQualityThresholds {
  classificationMacroPrecision: number;
  classificationMacroRecall: number;
  dispositionAccuracy: number;
  topicPrecision: number;
  topicRecall: number;
  topicExactMatchRate: number;
  conflictAccuracy: number;
  wrongInjectionRate: number;
}

export interface HistoryMigrationQualityManifest {
  recordType: "manifest";
  schemaVersion: typeof SCHEMA_VERSION;
  datasetId: string;
  sampleSource: "synthetic" | "redacted_production_sample";
  redaction: {
    status: "verified";
    containsSourceText: false;
  };
  thresholds: HistoryQualityThresholds;
}

export interface HistoryQualityTrace {
  policyVersion: string;
  promptVersion: string;
  taxonomyVersion: string;
}

export interface HistoryQualityExpected {
  semanticType: HistorySemanticType | null;
  disposition: HistoryQualityDisposition;
  topics: string[];
  conflict: HistoryConflictState;
  allowedInjectionScopeIds: string[];
}

export interface HistoryQualityActual {
  semanticType: HistorySemanticType | null;
  disposition: HistoryQualityDisposition;
  topics: string[];
  conflict: HistoryConflictState;
  injectedScopeIds: string[];
}

export interface HistoryMigrationQualitySample {
  recordType: "sample";
  sampleId: string;
  scenarios: HistoryQualityScenario[];
  scopeProbe: {
    originScopeId: string;
    evaluatedScopeIds: string[];
  };
  expected: HistoryQualityExpected;
  actual: HistoryQualityActual;
  trace: HistoryQualityTrace;
}

export interface HistoryMigrationQualityDataset {
  manifest: HistoryMigrationQualityManifest;
  samples: HistoryMigrationQualitySample[];
}

export interface HistoryQualityIssue {
  sampleId: string;
  code: HistoryQualityIssueCode;
  trace: HistoryQualityTrace;
  expected: string[];
  actual: string[];
}

export interface HistoryMigrationQualityReport {
  schemaVersion: typeof SCHEMA_VERSION;
  datasetId: string;
  sampleCount: number;
  passed: boolean;
  coverage: {
    present: string[];
    missing: string[];
  };
  metrics: {
    classification: {
      macroPrecision: number;
      macroRecall: number;
      byType: Record<HistorySemanticType, {
        truePositive: number;
        falsePositive: number;
        falseNegative: number;
        precision: number;
        recall: number;
      }>;
    };
    disposition: { correct: number; total: number; accuracy: number };
    topic: {
      truePositive: number;
      predicted: number;
      expected: number;
      precision: number;
      recall: number;
      exactMatches: number;
      evaluatedSamples: number;
      exactMatchRate: number;
    };
    conflict: { correct: number; total: number; accuracy: number };
    injection: {
      wrong: number;
      forbiddenOpportunities: number;
      wrongInjectionRate: number;
    };
  };
  issues: HistoryQualityIssue[];
  failuresByVersion: Array<HistoryQualityTrace & {
    issueCodes: HistoryQualityIssueCode[];
    sampleIds: string[];
  }>;
  gateFailures: Array<{
    metric: HistoryQualityThresholdName;
    actual: number;
    threshold: number;
    direction: "min" | "max";
  }>;
  evidenceBoundary: {
    sampleSource: HistoryMigrationQualityManifest["sampleSource"];
    realSampleEvaluated: boolean;
    defectVerificationEligible: boolean;
    claim:
      | "implementation_verified_with_synthetic_fixture_only"
      | "real_sample_gate_passed_pending_human_acceptance"
      | "real_sample_gate_failed";
  };
}

interface CliIo {
  writeLine(line: string): void;
}

type PlainRecord = Record<string, unknown>;

function contractError(line: number, pathName: string, message: string): never {
  throw new Error(`[history-migration-quality] line=${line} ${pathName}: ${message}`);
}

function plainRecord(value: unknown, line: number, pathName: string): PlainRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    contractError(line, pathName, "必须为对象");
  }
  return value as PlainRecord;
}

function exactKeys(
  value: PlainRecord,
  allowed: readonly string[],
  line: number,
  pathName: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    contractError(line, pathName, `包含未知字段 ${unknown.sort().join(",")}`);
  }
  const missing = allowed.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    contractError(line, pathName, `缺少字段 ${missing.join(",")}`);
  }
}

function nonEmptyString(value: unknown, line: number, pathName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    contractError(line, pathName, "必须为非空字符串");
  }
  return value;
}

function safeOpaqueId(value: unknown, line: number, pathName: string): string {
  const parsed = nonEmptyString(value, line, pathName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(parsed)) {
    contractError(line, pathName, "必须为无空白、控制字符或路径分隔符的安全标识");
  }
  return parsed;
}

function scopeFingerprint(value: unknown, line: number, pathName: string): string {
  const parsed = nonEmptyString(value, line, pathName);
  if (!/^sha256:[a-f0-9]{64}$/.test(parsed)) {
    contractError(line, pathName, "必须为不可逆 sha256:<64 lowercase hex> fingerprint");
  }
  return parsed;
}

function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  line: number,
  pathName: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    contractError(line, pathName, "枚举值非法");
  }
  return value as T;
}

function uniqueSafeIds(value: unknown, line: number, pathName: string): string[] {
  if (!Array.isArray(value)) contractError(line, pathName, "必须为数组");
  const result = value.map((item, index) =>
    safeOpaqueId(item, line, `${pathName}[${index}]`));
  if (new Set(result).size !== result.length) {
    contractError(line, pathName, "不得包含重复值");
  }
  return result;
}

function uniqueScopeFingerprints(value: unknown, line: number, pathName: string): string[] {
  if (!Array.isArray(value)) contractError(line, pathName, "必须为数组");
  const result = value.map((item, index) =>
    scopeFingerprint(item, line, `${pathName}[${index}]`));
  if (new Set(result).size !== result.length) {
    contractError(line, pathName, "不得包含重复值");
  }
  return result;
}

function stringSetEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function parseThresholds(value: unknown, line: number): HistoryQualityThresholds {
  const record = plainRecord(value, line, "thresholds");
  exactKeys(record, THRESHOLD_NAMES, line, "thresholds");
  const parsed = {} as HistoryQualityThresholds;
  for (const name of THRESHOLD_NAMES) {
    const threshold = record[name];
    if (typeof threshold !== "number" || !Number.isFinite(threshold) ||
        threshold < 0 || threshold > 1) {
      contractError(line, `thresholds.${name}`, "必须为 0..1 有限数值");
    }
    parsed[name] = threshold;
  }
  return parsed;
}

function parseManifest(value: unknown, line: number): HistoryMigrationQualityManifest {
  const record = plainRecord(value, line, "manifest");
  exactKeys(record, [
    "recordType", "schemaVersion", "datasetId", "sampleSource", "redaction", "thresholds",
  ], line, "manifest");
  if (record.recordType !== "manifest") contractError(line, "recordType", "首条必须为 manifest");
  if (record.schemaVersion !== SCHEMA_VERSION) contractError(line, "schemaVersion", `必须为 ${SCHEMA_VERSION}`);
  const redaction = plainRecord(record.redaction, line, "redaction");
  exactKeys(redaction, ["status", "containsSourceText"], line, "redaction");
  if (redaction.status !== "verified") contractError(line, "redaction.status", "必须为 verified");
  if (redaction.containsSourceText !== false) {
    contractError(line, "redaction.containsSourceText", "必须为 false");
  }
  return {
    recordType: "manifest",
    schemaVersion: SCHEMA_VERSION,
    datasetId: safeOpaqueId(record.datasetId, line, "datasetId"),
    sampleSource: enumValue(
      record.sampleSource,
      ["synthetic", "redacted_production_sample"] as const,
      line,
      "sampleSource",
    ),
    redaction: { status: "verified", containsSourceText: false },
    thresholds: parseThresholds(record.thresholds, line),
  };
}

function parseTrace(value: unknown, line: number): HistoryQualityTrace {
  const record = plainRecord(value, line, "trace");
  exactKeys(record, ["policyVersion", "promptVersion", "taxonomyVersion"], line, "trace");
  return {
    policyVersion: safeOpaqueId(record.policyVersion, line, "trace.policyVersion"),
    promptVersion: safeOpaqueId(record.promptVersion, line, "trace.promptVersion"),
    taxonomyVersion: safeOpaqueId(record.taxonomyVersion, line, "trace.taxonomyVersion"),
  };
}

function parseSemanticType(
  value: unknown,
  line: number,
  pathName: string,
): HistorySemanticType | null {
  return value === null ? null : enumValue(value, SEMANTIC_TYPES, line, pathName);
}

function parseExpected(value: unknown, line: number): HistoryQualityExpected {
  const record = plainRecord(value, line, "expected");
  exactKeys(record, [
    "semanticType", "disposition", "topics", "conflict", "allowedInjectionScopeIds",
  ], line, "expected");
  return {
    semanticType: parseSemanticType(record.semanticType, line, "expected.semanticType"),
    disposition: enumValue(record.disposition, DISPOSITIONS, line, "expected.disposition"),
    topics: uniqueSafeIds(record.topics, line, "expected.topics"),
    conflict: enumValue(record.conflict, CONFLICT_STATES, line, "expected.conflict"),
    allowedInjectionScopeIds: uniqueScopeFingerprints(
      record.allowedInjectionScopeIds,
      line,
      "expected.allowedInjectionScopeIds",
    ),
  };
}

function parseActual(value: unknown, line: number): HistoryQualityActual {
  const record = plainRecord(value, line, "actual");
  exactKeys(record, [
    "semanticType", "disposition", "topics", "conflict", "injectedScopeIds",
  ], line, "actual");
  return {
    semanticType: parseSemanticType(record.semanticType, line, "actual.semanticType"),
    disposition: enumValue(record.disposition, DISPOSITIONS, line, "actual.disposition"),
    topics: uniqueSafeIds(record.topics, line, "actual.topics"),
    conflict: enumValue(record.conflict, CONFLICT_STATES, line, "actual.conflict"),
    injectedScopeIds: uniqueScopeFingerprints(
      record.injectedScopeIds,
      line,
      "actual.injectedScopeIds",
    ),
  };
}

function parseSample(value: unknown, line: number): HistoryMigrationQualitySample {
  const record = plainRecord(value, line, "sample");
  exactKeys(record, [
    "recordType", "sampleId", "scenarios", "scopeProbe", "expected", "actual", "trace",
  ], line, "sample");
  if (record.recordType !== "sample") contractError(line, "recordType", "必须为 sample");
  if (!Array.isArray(record.scenarios)) contractError(line, "scenarios", "必须为数组");
  const scenarios = record.scenarios.map((item, index) =>
    enumValue(item, SCENARIOS, line, `scenarios[${index}]`));
  if (new Set(scenarios).size !== scenarios.length) {
    contractError(line, "scenarios", "不得包含重复值");
  }
  const scopeProbe = plainRecord(record.scopeProbe, line, "scopeProbe");
  exactKeys(scopeProbe, ["originScopeId", "evaluatedScopeIds"], line, "scopeProbe");
  const originScopeId = scopeFingerprint(
    scopeProbe.originScopeId,
    line,
    "scopeProbe.originScopeId",
  );
  const evaluatedScopeIds = uniqueScopeFingerprints(
    scopeProbe.evaluatedScopeIds,
    line,
    "scopeProbe.evaluatedScopeIds",
  );
  if (!evaluatedScopeIds.includes(originScopeId)) {
    contractError(line, "scopeProbe", "evaluatedScopeIds 必须包含 originScopeId");
  }
  if (scenarios.includes("cross_scope") &&
      !evaluatedScopeIds.some((scopeId) => scopeId !== originScopeId)) {
    contractError(line, "scenarios.cross_scope", "必须实际探测至少一个外部 scope");
  }
  const expected = parseExpected(record.expected, line);
  const actual = parseActual(record.actual, line);
  if (expected.disposition === "context" && expected.semanticType === null) {
    contractError(line, "expected.semanticType", "context disposition 必须有 semanticType");
  }
  if (expected.disposition !== "context" && expected.semanticType !== null) {
    contractError(line, "expected.semanticType", "非 context disposition 必须为 null");
  }
  if (expected.disposition !== "context" && expected.allowedInjectionScopeIds.length > 0) {
    contractError(line, "expected.allowedInjectionScopeIds", "非 context disposition 必须为空");
  }
  for (const scopeId of expected.allowedInjectionScopeIds) {
    if (!evaluatedScopeIds.includes(scopeId)) {
      contractError(line, "expected.allowedInjectionScopeIds", "必须是 evaluatedScopeIds 子集");
    }
  }
  for (const scopeId of actual.injectedScopeIds) {
    if (!evaluatedScopeIds.includes(scopeId)) {
      contractError(line, "actual.injectedScopeIds", "必须是 evaluatedScopeIds 子集");
    }
  }
  if (scenarios.includes("conflict") && expected.conflict === "not_applicable") {
    contractError(line, "expected.conflict", "conflict scenario 必须有标注");
  }
  return {
    recordType: "sample",
    sampleId: safeOpaqueId(record.sampleId, line, "sampleId"),
    scenarios,
    scopeProbe: { originScopeId, evaluatedScopeIds },
    expected,
    actual,
    trace: parseTrace(record.trace, line),
  };
}

function coverageOf(samples: readonly HistoryMigrationQualitySample[]): string[] {
  const present = new Set<string>();
  for (const sample of samples) {
    if (sample.expected.semanticType) present.add(`semantic:${sample.expected.semanticType}`);
    if (sample.expected.disposition !== "context") {
      present.add(`disposition:${sample.expected.disposition}`);
    }
    for (const scenario of sample.scenarios) present.add(`scenario:${scenario}`);
  }
  return REQUIRED_COVERAGE.filter((value) => present.has(value));
}

export function loadHistoryMigrationQualityDataset(
  filePath: string,
): HistoryMigrationQualityDataset {
  const raw = readFileSync(path.resolve(filePath), "utf8");
  const parsedLines: Array<{ line: number; value: unknown }> = [];
  for (const [index, text] of raw.split(/\r?\n/).entries()) {
    if (text.trim().length === 0) continue;
    try {
      parsedLines.push({ line: index + 1, value: JSON.parse(text) as unknown });
    } catch {
      contractError(index + 1, "json", "JSON 解析失败");
    }
  }
  if (parsedLines.length < 2) contractError(1, "dataset", "必须包含 manifest 和 sample");
  const manifest = parseManifest(parsedLines[0].value, parsedLines[0].line);
  const samples = parsedLines.slice(1).map(({ line, value }) => parseSample(value, line));
  const sampleIds = new Set<string>();
  for (const [index, sample] of samples.entries()) {
    if (sampleIds.has(sample.sampleId)) {
      contractError(parsedLines[index + 1].line, "sampleId", "不得重复");
    }
    sampleIds.add(sample.sampleId);
  }
  const present = coverageOf(samples);
  const missing = REQUIRED_COVERAGE.filter((value) => !present.includes(value));
  if (missing.length > 0) contractError(1, "coverage", `缺少强制覆盖 ${missing.join(",")}`);
  if (!samples.some((sample) => sample.expected.topics.length > 0)) {
    contractError(1, "coverage", "至少需要一条 topic 标注样本");
  }
  return { manifest, samples };
}

function issue(
  sample: HistoryMigrationQualitySample,
  code: HistoryQualityIssueCode,
  expected: readonly string[],
  actual: readonly string[],
): HistoryQualityIssue {
  return {
    sampleId: sample.sampleId,
    code,
    trace: { ...sample.trace },
    expected: [...expected],
    actual: [...actual],
  };
}

function groupFailuresByVersion(
  issues: readonly HistoryQualityIssue[],
): HistoryMigrationQualityReport["failuresByVersion"] {
  const groups = new Map<string, HistoryMigrationQualityReport["failuresByVersion"][number]>();
  for (const item of issues) {
    const key = [
      item.trace.policyVersion,
      item.trace.promptVersion,
      item.trace.taxonomyVersion,
    ].join("\u0000");
    const current = groups.get(key) ?? {
      ...item.trace,
      issueCodes: [],
      sampleIds: [],
    };
    if (!current.issueCodes.includes(item.code)) current.issueCodes.push(item.code);
    if (!current.sampleIds.includes(item.sampleId)) current.sampleIds.push(item.sampleId);
    groups.set(key, current);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      issueCodes: group.issueCodes.sort(),
      sampleIds: group.sampleIds.sort(),
    }))
    .sort((left, right) =>
      `${left.policyVersion}\u0000${left.promptVersion}\u0000${left.taxonomyVersion}`.localeCompare(
        `${right.policyVersion}\u0000${right.promptVersion}\u0000${right.taxonomyVersion}`,
      ));
}

export function evaluateHistoryMigrationQuality(
  dataset: HistoryMigrationQualityDataset,
): HistoryMigrationQualityReport {
  const issues: HistoryQualityIssue[] = [];
  const byType = {} as HistoryMigrationQualityReport["metrics"]["classification"]["byType"];
  for (const semanticType of SEMANTIC_TYPES) {
    let truePositive = 0;
    let falsePositive = 0;
    let falseNegative = 0;
    for (const sample of dataset.samples) {
      if (sample.expected.semanticType === semanticType && sample.actual.semanticType === semanticType) {
        truePositive++;
      } else {
        if (sample.actual.semanticType === semanticType) falsePositive++;
        if (sample.expected.semanticType === semanticType) falseNegative++;
      }
    }
    byType[semanticType] = {
      truePositive,
      falsePositive,
      falseNegative,
      precision: ratio(truePositive, truePositive + falsePositive),
      recall: ratio(truePositive, truePositive + falseNegative),
    };
  }

  let dispositionCorrect = 0;
  let topicTruePositive = 0;
  let topicPredicted = 0;
  let topicExpected = 0;
  let topicExactMatches = 0;
  let topicEvaluatedSamples = 0;
  let conflictCorrect = 0;
  let conflictTotal = 0;
  let wrongInjections = 0;
  let forbiddenOpportunities = 0;

  for (const sample of dataset.samples) {
    if (sample.expected.semanticType !== sample.actual.semanticType) {
      issues.push(issue(
        sample,
        "semantic_type_mismatch",
        [sample.expected.semanticType ?? "null"],
        [sample.actual.semanticType ?? "null"],
      ));
    }
    if (sample.expected.disposition === sample.actual.disposition) dispositionCorrect++;
    else issues.push(issue(
      sample,
      "disposition_mismatch",
      [sample.expected.disposition],
      [sample.actual.disposition],
    ));

    const expectedTopics = new Set(sample.expected.topics);
    const actualTopics = new Set(sample.actual.topics);
    if (expectedTopics.size > 0 || actualTopics.size > 0) {
      topicEvaluatedSamples++;
      topicPredicted += actualTopics.size;
      topicExpected += expectedTopics.size;
      const falsePositive = [...actualTopics].filter((value) => !expectedTopics.has(value));
      const falseNegative = [...expectedTopics].filter((value) => !actualTopics.has(value));
      topicTruePositive += [...actualTopics].filter((value) => expectedTopics.has(value)).length;
      if (falsePositive.length > 0) {
        issues.push(issue(sample, "topic_false_positive", [], falsePositive));
      }
      if (falseNegative.length > 0) {
        issues.push(issue(sample, "topic_false_negative", falseNegative, []));
      }
      if (stringSetEqual(sample.expected.topics, sample.actual.topics)) topicExactMatches++;
    }

    if (sample.expected.conflict !== "not_applicable") {
      conflictTotal++;
      if (sample.expected.conflict === sample.actual.conflict) conflictCorrect++;
      else issues.push(issue(
        sample,
        "conflict_mismatch",
        [sample.expected.conflict],
        [sample.actual.conflict],
      ));
    }

    const allowedScopes = new Set(sample.expected.allowedInjectionScopeIds);
    const forbiddenScopes = sample.scopeProbe.evaluatedScopeIds.filter(
      (scopeId) => !allowedScopes.has(scopeId),
    );
    forbiddenOpportunities += forbiddenScopes.length;
    const actualScopes = new Set(sample.actual.injectedScopeIds);
    const wrongScopes = forbiddenScopes.filter((scopeId) => actualScopes.has(scopeId));
    wrongInjections += wrongScopes.length;
    if (wrongScopes.length > 0) {
      issues.push(issue(sample, "wrong_scope_injection", [], wrongScopes));
    }
  }

  const typeMetrics = SEMANTIC_TYPES.map((semanticType) => byType[semanticType]);
  const macroPrecision = typeMetrics.reduce((sum, item) => sum + item.precision, 0) /
    typeMetrics.length;
  const macroRecall = typeMetrics.reduce((sum, item) => sum + item.recall, 0) /
    typeMetrics.length;
  const dispositionAccuracy = ratio(dispositionCorrect, dataset.samples.length);
  const topicPrecision = ratio(topicTruePositive, topicPredicted);
  const topicRecall = ratio(topicTruePositive, topicExpected);
  const topicExactMatchRate = ratio(topicExactMatches, topicEvaluatedSamples);
  const conflictAccuracy = ratio(conflictCorrect, conflictTotal);
  const wrongInjectionRate = ratio(wrongInjections, forbiddenOpportunities);
  const metricValues: Record<HistoryQualityThresholdName, number> = {
    classificationMacroPrecision: macroPrecision,
    classificationMacroRecall: macroRecall,
    dispositionAccuracy,
    topicPrecision,
    topicRecall,
    topicExactMatchRate,
    conflictAccuracy,
    wrongInjectionRate,
  };
  const gateFailures: HistoryMigrationQualityReport["gateFailures"] = [];
  for (const metric of THRESHOLD_NAMES) {
    const direction = metric === "wrongInjectionRate" ? "max" : "min";
    const actual = metricValues[metric];
    const threshold = dataset.manifest.thresholds[metric];
    if ((direction === "min" && actual < threshold) ||
        (direction === "max" && actual > threshold)) {
      gateFailures.push({ metric, actual, threshold, direction });
    }
  }
  const passed = gateFailures.length === 0;
  const realSampleEvaluated = dataset.manifest.sampleSource === "redacted_production_sample";
  const claim = !realSampleEvaluated
    ? "implementation_verified_with_synthetic_fixture_only"
    : passed
      ? "real_sample_gate_passed_pending_human_acceptance"
      : "real_sample_gate_failed";
  return {
    schemaVersion: SCHEMA_VERSION,
    datasetId: dataset.manifest.datasetId,
    sampleCount: dataset.samples.length,
    passed,
    coverage: {
      present: coverageOf(dataset.samples),
      missing: REQUIRED_COVERAGE.filter((value) => !coverageOf(dataset.samples).includes(value)),
    },
    metrics: {
      classification: { macroPrecision, macroRecall, byType },
      disposition: {
        correct: dispositionCorrect,
        total: dataset.samples.length,
        accuracy: dispositionAccuracy,
      },
      topic: {
        truePositive: topicTruePositive,
        predicted: topicPredicted,
        expected: topicExpected,
        precision: topicPrecision,
        recall: topicRecall,
        exactMatches: topicExactMatches,
        evaluatedSamples: topicEvaluatedSamples,
        exactMatchRate: topicExactMatchRate,
      },
      conflict: { correct: conflictCorrect, total: conflictTotal, accuracy: conflictAccuracy },
      injection: {
        wrong: wrongInjections,
        forbiddenOpportunities,
        wrongInjectionRate,
      },
    },
    issues,
    failuresByVersion: groupFailuresByVersion(issues),
    gateFailures,
    evidenceBoundary: {
      sampleSource: dataset.manifest.sampleSource,
      realSampleEvaluated,
      defectVerificationEligible: realSampleEvaluated && passed,
      claim,
    },
  };
}

function parseCliArgs(args: readonly string[]): { input: string; out?: string } {
  let input: string | undefined;
  let out: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg !== "--input" && arg !== "--out") {
      throw new Error(`[history-migration-quality] 未知参数 '${arg}'`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`[history-migration-quality] ${arg} 缺少路径`);
    }
    if (arg === "--input") {
      if (input) throw new Error("[history-migration-quality] --input 只能指定一次");
      input = value;
    } else {
      if (out) throw new Error("[history-migration-quality] --out 只能指定一次");
      out = value;
    }
    index++;
  }
  if (!input) throw new Error("[history-migration-quality] 必须指定 --input <redacted.jsonl>");
  return { input, ...(out ? { out } : {}) };
}

export function runHistoryMigrationQualityCli(
  args: readonly string[],
  io: CliIo = { writeLine: (line) => console.log(line) },
): number {
  const options = parseCliArgs(args);
  const report = evaluateHistoryMigrationQuality(
    loadHistoryMigrationQualityDataset(options.input),
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const outputPath = path.resolve(options.out);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, serialized, "utf8");
  } else {
    io.writeLine(serialized.trimEnd());
  }
  io.writeLine(
    `[history-migration-quality] dataset=${report.datasetId} samples=${report.sampleCount} gate=${
      report.passed ? "PASS" : "FAIL"
    }`,
  );
  if (report.evidenceBoundary.sampleSource === "synthetic") {
    io.writeLine(
      "[history-migration-quality] synthetic fixture 仅验证工具实现，不能据此宣称 MG-013 verified",
    );
  } else if (report.evidenceBoundary.claim === "real_sample_gate_passed_pending_human_acceptance") {
    io.writeLine(
      "[history-migration-quality] 真实脱敏样本 gate 已通过，仍需人工验收后才能标记 verified",
    );
  }
  return report.passed ? 0 : 2;
}

const modulePath = fileURLToPath(import.meta.url);
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(modulePath).href) {
  try {
    process.exitCode = runHistoryMigrationQualityCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
