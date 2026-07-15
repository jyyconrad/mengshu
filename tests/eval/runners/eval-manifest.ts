import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isKnownEvalMetricName } from "./eval-metrics.js";

export type EvalSuiteKind = "baseline" | "extension";

export interface EvalSuiteDefinition {
  kind: EvalSuiteKind;
  file: string;
  runner: string;
  caseCount: number;
  bytes: number;
  sha256: string;
  metrics: string[];
  gate?: Record<string, number>;
  [key: string]: unknown;
}

export interface EvalManifest {
  schemaVersion: 1;
  version?: string;
  suites: Record<string, EvalSuiteDefinition>;
  [key: string]: unknown;
}

export interface EvalSuitePlan extends EvalSuiteDefinition {
  name: string;
  filePath: string;
  manifestSchemaVersion: 1;
  manifestVersion: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(manifestPath: string, detail: string): never {
  throw new Error(`[eval manifest] ${manifestPath}: ${detail}`);
}

function requireString(
  value: unknown,
  field: string,
  manifestPath: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(manifestPath, `${field} 必须为非空字符串`);
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  manifestPath: string,
): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    fail(manifestPath, `${field} 必须为正整数`);
  }
  return value as number;
}

function requireMetrics(
  value: unknown,
  suiteName: string,
  manifestPath: string,
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(manifestPath, `suite '${suiteName}'.metrics 必须为非空数组`);
  }
  const metrics: string[] = [];
  for (const metric of value) {
    if (typeof metric !== "string" || !isKnownEvalMetricName(metric)) {
      fail(manifestPath, `suite '${suiteName}'.metrics 包含未知或非法 metric`);
    }
    if (metrics.includes(metric)) {
      fail(manifestPath, `suite '${suiteName}'.metrics 重复声明 '${metric}'`);
    }
    metrics.push(metric);
  }
  return metrics;
}

function requireGate(
  value: unknown,
  suiteName: string,
  metrics: readonly string[],
  manifestPath: string,
): Record<string, number> {
  if (!isRecord(value)) {
    fail(manifestPath, `extension suite '${suiteName}'.gate 必须为对象`);
  }
  const gate: Record<string, number> = {};
  for (const [metric, threshold] of Object.entries(value)) {
    if (!metrics.includes(metric)) {
      fail(manifestPath, `suite '${suiteName}'.gate 包含未声明 metric '${metric}'`);
    }
    if (typeof threshold !== "number" || !Number.isFinite(threshold)) {
      fail(manifestPath, `suite '${suiteName}'.gate metric '${metric}' threshold 必须为有限数值`);
    }
    gate[metric] = threshold;
  }
  for (const metric of metrics) {
    if (!(metric in gate)) {
      fail(manifestPath, `extension suite '${suiteName}'.gate 缺少 metric '${metric}'`);
    }
  }
  return gate;
}

function verifySuiteFile(
  suiteName: string,
  definition: EvalSuiteDefinition,
  manifestPath: string,
): void {
  const filePath = path.resolve(path.dirname(manifestPath), definition.file);
  let content: Buffer;
  try {
    content = readFileSync(filePath);
  } catch (error) {
    fail(
      manifestPath,
      `suite '${suiteName}' fixture 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const actualBytes = content.byteLength;
  const actualSha256 = createHash("sha256").update(content).digest("hex");
  const actualCaseCount = content
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0).length;

  if (actualBytes !== definition.bytes) {
    fail(
      manifestPath,
      `suite '${suiteName}' bytes 不匹配：manifest=${definition.bytes}, actual=${actualBytes}`,
    );
  }
  if (actualCaseCount !== definition.caseCount) {
    fail(
      manifestPath,
      `suite '${suiteName}' caseCount 不匹配：manifest=${definition.caseCount}, actual=${actualCaseCount}`,
    );
  }
  if (actualSha256 !== definition.sha256) {
    fail(
      manifestPath,
      `suite '${suiteName}' sha256 不匹配：manifest=${definition.sha256}, actual=${actualSha256}`,
    );
  }
}

export function loadEvalManifest(manifestPath: string): EvalManifest {
  const absolutePath = path.resolve(manifestPath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
  } catch (error) {
    fail(
      absolutePath,
      `JSON 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!isRecord(raw)) fail(absolutePath, "根节点必须为对象");
  if (raw.schemaVersion !== 1) {
    fail(absolutePath, "schemaVersion 必须为 1");
  }
  if (!isRecord(raw.suites) || Object.keys(raw.suites).length === 0) {
    fail(absolutePath, "suites 必须为非空对象");
  }

  const suites: Record<string, EvalSuiteDefinition> = {};
  for (const [name, value] of Object.entries(raw.suites)) {
    if (!isRecord(value)) fail(absolutePath, `suite '${name}' 必须为对象`);

    const kind = requireString(value.kind, `suite '${name}'.kind`, absolutePath);
    if (kind !== "baseline" && kind !== "extension") {
      fail(absolutePath, `suite '${name}'.kind 必须为 baseline 或 extension`);
    }
    const file = requireString(value.file, `suite '${name}'.file`, absolutePath);
    const runner = requireString(
      value.runner,
      `suite '${name}'.runner`,
      absolutePath,
    );
    const caseCount = requirePositiveInteger(
      value.caseCount,
      `suite '${name}'.caseCount`,
      absolutePath,
    );
    const bytes = requirePositiveInteger(
      value.bytes,
      `suite '${name}'.bytes`,
      absolutePath,
    );
    if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) {
      fail(absolutePath, `suite '${name}'.sha256 必须为 64 位小写十六进制`);
    }
    const metrics = requireMetrics(value.metrics, name, absolutePath);
    const gate = kind === "extension"
      ? requireGate(value.gate, name, metrics, absolutePath)
      : undefined;

    suites[name] = {
      ...value,
      kind,
      file,
      runner,
      caseCount,
      bytes,
      sha256: value.sha256,
      metrics,
      ...(gate ? { gate } : {}),
    };
    verifySuiteFile(name, suites[name], absolutePath);
  }

  return { ...raw, schemaVersion: 1, suites } as EvalManifest;
}

export function selectEvalSuites(
  manifest: EvalManifest,
  requestedSuite: string,
  manifestPath?: string,
): EvalSuitePlan[] {
  const entries =
    requestedSuite === "all"
      ? Object.entries(manifest.suites)
      : manifest.suites[requestedSuite]
        ? [[requestedSuite, manifest.suites[requestedSuite]] as const]
        : [];

  if (entries.length === 0) {
    throw new Error(`[quick-eval] 未登记 suite '${requestedSuite}'`);
  }

  const baseDir = path.dirname(path.resolve(manifestPath ?? "manifest.json"));
  return entries.map(([name, definition]) => ({
    ...definition,
    name,
    filePath: path.resolve(baseDir, definition.file),
    manifestSchemaVersion: manifest.schemaVersion,
    manifestVersion:
      typeof manifest.version === "string" && manifest.version.trim().length > 0
        ? manifest.version
        : null,
  }));
}

export function assertRegisteredRunners(
  suites: EvalSuitePlan[],
  registeredRunnerIds: ReadonlySet<string>,
): void {
  const missing = [
    ...new Set(
      suites
        .map((suite) => suite.runner)
        .filter((runner) => !registeredRunnerIds.has(runner)),
    ),
  ];
  if (missing.length > 0) {
    throw new Error(`[quick-eval] 未实现 runner: ${missing.join(", ")}`);
  }
}
