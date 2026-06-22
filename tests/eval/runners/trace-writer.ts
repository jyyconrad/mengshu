/**
 * Eval validation trace writer（P0-3）。
 *
 * 本文件做什么：
 *   - 为 `ms project ingest-history --eval-run` 提供完整 5 阶段 trace 落盘能力。
 *   - 定义 manifest.json 与各阶段 jsonl/json 的稳定 schema。
 *   - 提供 `--replay-from` 所需的读取能力：从已落盘 trace 读回结构化数据，
 *     供 grader 重放（不调 LLM / embedding）。
 *
 * 目录结构（validation-runs/<runId>/）：
 *   manifest.json                         运行级元数据（runId / gitSha / models / redactionMapVersion）
 *   phase-2-ingest/
 *     ingest-trace.jsonl                  候选区处理流程（每条候选一行）
 *     llm-requests.jsonl                  LLM raw request/response（向量/长文本截断）
 *     validator-decisions.jsonl           11 闸门决策 trace
 *   phase-3-recall/
 *     recall-trace.jsonl                  召回结果（保持既有 schema，向后兼容）
 *     embedding-requests.jsonl            embedding 请求/响应（向量截断前 8 维 + 维度数）
 *     ranking-breakdown.jsonl             importance 4 项明细
 *   phase-4-qa/
 *     qa-trace.jsonl                      slot context 注入 + QA 答案
 *     citation-verification.jsonl         引用验证
 *   phase-5-analysis/
 *     failures.jsonl                      失败 case
 *     performance.json                    性能统计
 *     coverage-report.json                evidence:missing 计数等覆盖率
 *
 * 关键边界：
 *   - 不破坏既有 --eval-run 最小可行实现：phase-3-recall/recall-trace.jsonl
 *     的 schema 保持兼容（topResults[].breakdown 字段名不变）。
 *   - trace 数据量控制：LLM/embedding 向量只存前 8 维 + 维度数，长文本截断。
 *   - 本模块只做 IO 与 schema 定义，不发起任何 LLM/embedding 调用。
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// ===== 数据量控制常量 =====

/** 向量预览只保留前 N 维（控制 trace 体积）。 */
export const EMBEDDING_PREVIEW_DIMS = 8;
/** LLM raw 文本截断长度（请求/响应各自上限）。 */
export const RAW_TEXT_MAX_CHARS = 2000;

// ===== manifest schema =====

/** 运行级元数据，落盘为 manifest.json。 */
export interface TraceManifest {
  /** run 唯一标识（与目录名一致，如 2026-06-19T14-49-32）。 */
  runId: string;
  /** 触发本次运行的 CLI 命令行。 */
  cli: string;
  /** 当前 git short SHA（无法获取时为 "unknown"）。 */
  gitSha: string;
  /** 脱敏规则版本（REDACTION_MAP_VERSION）。 */
  redactionMapVersion: string;
  /** 使用的模型信息。 */
  models: {
    embedding?: string;
    llm?: string;
    [key: string]: string | undefined;
  };
  /** 是否为 replay 运行（--replay-from 触发）。 */
  replay?: {
    /** 被重放的源 runId。 */
    fromRunId: string;
  };
  /** 创建时间（ISO8601）。 */
  createdAt: string;
}

// ===== phase-2-ingest schema =====

/** 候选区处理流程 trace（每条候选一行）。 */
export interface IngestTraceEntry {
  /** 候选稳定 id。 */
  candidateId: string;
  /** 来源文件路径。 */
  sourceFile?: string;
  /** 候选正文（截断）。 */
  text: string;
  /** 推断的语义类型（profile / task_context / rules / experience / resource）。 */
  semanticType?: string;
  /** valueScore（准入决策分）。 */
  valueScore?: number;
  /** 准入路由（drop / low / pending / active）。 */
  admissionRoute?: string;
  /** 脱敏命中次数。 */
  redactedCount?: number;
  /** 任意扩展元数据。 */
  metadata?: Record<string, unknown>;
}

/** LLM raw request/response trace（向量/长文本截断）。 */
export interface LlmRequestEntry {
  /** 关联候选/case id。 */
  refId: string;
  /** 调用阶段（extract / summarize / judge 等）。 */
  stage: string;
  /** 模型名。 */
  model?: string;
  /** prompt 文本（截断到 RAW_TEXT_MAX_CHARS）。 */
  requestPreview: string;
  /** 响应文本（截断到 RAW_TEXT_MAX_CHARS）。 */
  responsePreview: string;
  /** 调用耗时（毫秒）。 */
  latencyMs?: number;
  /** token 用量（如有）。 */
  tokenUsage?: { prompt?: number; completion?: number; total?: number };
}

/** 11 闸门 validator 决策 trace。 */
export interface ValidatorDecisionEntry {
  /** 关联候选 id。 */
  candidateId: string;
  /** 最终是否通过。 */
  passed: boolean;
  /** 各闸门决策明细（对象格式，键为闸门名称）。 */
  gates: Record<string, {
    /** 是否通过该闸门。 */
    pass: boolean;
    /** 闸门评分或阈值信息。 */
    score?: number;
    /** 失败原因。 */
    reason?: string;
  }>;
}

// ===== phase-3-recall schema =====

/**
 * 召回结果 trace（保持既有 schema，向后兼容）。
 * breakdown 字段名不可更改：relevance / scopeFit / importance / confidence /
 * evidenceWeight / recency。
 */
export interface RecallTraceEntry {
  caseId: string;
  query: string;
  topResults: Array<{
    rank: number;
    totalScore: number;
    breakdown?: {
      relevance: number;
      scopeFit: number;
      importance: number;
      confidence: number;
      evidenceWeight: number;
      recency: number;
    };
    contentPreview: string;
    memoryId?: string;
  }>;
  recalledCount?: number;
  latencyMs?: number;
}

/** embedding 请求/响应 trace（向量截断）。 */
export interface EmbeddingRequestEntry {
  /** 关联 case/query id。 */
  refId: string;
  /** 被向量化的文本（截断）。 */
  textPreview: string;
  /** 向量前 EMBEDDING_PREVIEW_DIMS 维。 */
  embeddingPreview: number[];
  /** 向量维度数。 */
  dimensions: number;
  /** 向量 hash（用于去重/复现）。 */
  embeddingHash?: string;
  model?: string;
  provider?: string;
  latencyMs?: number;
}

/** importance 4 项明细 trace。 */
export interface RankingBreakdownEntry {
  caseId: string;
  memoryId: string;
  /** 综合 importance。 */
  importance: number;
  /** 4 项明细（salience_llm / sourceAuthority / explicitnessBonus / typePrior）。 */
  breakdown: {
    salienceLlm: number;
    sourceAuthority: number;
    explicitnessBonus: number;
    typePrior: number;
  };
}

// ===== phase-4-qa schema =====

/** slot context 注入 + QA 答案 trace。 */
export interface QaTraceEntry {
  caseId: string;
  query: string;
  /** 实际填充的 5 槽位。 */
  filledSlots: string[];
  /** 注入的记忆 id（按槽位顺序）。 */
  injectedMemoryIds: string[];
  /** 注入后的 slot context（截断）。 */
  contextPreview: string;
  /** QA 答案文本（截断）。 */
  answerPreview?: string;
  tokenEstimate?: number;
  latencyMs?: number;
}

/** 引用验证 trace。 */
export interface CitationVerificationEntry {
  caseId: string;
  /** 答案中声称引用的记忆/证据 id。 */
  claimedCitations: string[];
  /** 实际可在上下文中找到支持的引用 id。 */
  verifiedCitations: string[];
  /** 找不到支持的引用（幻觉引用）。 */
  unverifiedCitations: string[];
  /** 引用验证是否通过。 */
  passed: boolean;
}

// ===== phase-5-analysis schema =====

/** 失败 case trace。 */
export interface FailureEntry {
  caseId: string;
  suite?: string;
  /** 失败原因列表。 */
  failures: string[];
  /** 漏掉的 requiredMemoryIds。 */
  missedRequired?: string[];
  /** 误注入的 forbiddenMemoryIds。 */
  injectedForbidden?: string[];
}

/** 性能统计。 */
export interface PerformanceReport {
  generatedAt: string;
  /** 总 case 数。 */
  totalCases: number;
  /** 各阶段延迟分位（毫秒）。 */
  latency: {
    ingestP50?: number;
    ingestP95?: number;
    recallP50?: number;
    recallP95?: number;
    qaP50?: number;
    qaP95?: number;
  };
  /** LLM 调用总次数。 */
  llmCalls?: number;
  /** embedding 调用总次数。 */
  embeddingCalls?: number;
}

/** 覆盖率报告（evidence:missing 计数等）。 */
export interface CoverageReport {
  generatedAt: string;
  /** evidence 缺失的 case/claim 计数。 */
  evidenceMissingCount: number;
  /** 各 PII 类别脱敏命中数。 */
  redactionCoverage?: Record<string, number>;
  /** 候选语义类型分布。 */
  candidateDistribution?: Record<string, number>;
  /** 任意扩展覆盖率指标。 */
  metrics?: Record<string, number>;
}

// ===== 工具函数 =====

/** 截断文本到指定长度，超出追加省略号。 */
export function truncateText(text: string, maxChars: number = RAW_TEXT_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 1) + "…";
}

/** 截断向量到前 N 维，返回预览 + 维度数。 */
export function truncateEmbedding(
  embedding: number[],
  dims: number = EMBEDDING_PREVIEW_DIMS,
): { preview: number[]; dimensions: number } {
  return {
    preview: embedding.slice(0, dims),
    dimensions: embedding.length,
  };
}

/** 获取当前 git short SHA；失败时返回 "unknown"。 */
export function resolveGitSha(cwd?: string): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** 把对象数组写为 jsonl（每行一个 JSON）。空数组也会创建空文件。 */
function writeJsonl(filePath: string, rows: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n"));
}

/** 写为格式化 JSON。 */
function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

/** 读取 jsonl 为对象数组（容错跳过坏行）。文件不存在返回空数组。 */
function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const content = fs.readFileSync(filePath, "utf-8");
  const rows: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      rows.push(JSON.parse(trimmed) as T);
    } catch {
      // 跳过坏行
    }
  }
  return rows;
}

/** 读取 JSON 文件；不存在返回 undefined。 */
function readJson<T>(filePath: string): T | undefined {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

// ===== TraceWriter 主类 =====

/**
 * 5 阶段 trace writer。
 * 以 validation run 根目录初始化，提供各阶段 write* 方法。
 */
export class TraceWriter {
  constructor(private readonly runDir: string) {
    fs.mkdirSync(this.runDir, { recursive: true });
  }

  /** 从目录名推断 runId。 */
  static runIdFromDir(runDir: string): string {
    return path.basename(runDir);
  }

  /** 阶段目录路径。 */
  private phaseDir(phase: string): string {
    const dir = path.join(this.runDir, phase);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  // ----- manifest -----

  /** 写 manifest.json。runId 缺省取目录名。 */
  writeManifest(input: {
    cli: string;
    redactionMapVersion: string;
    models: TraceManifest["models"];
    gitSha?: string;
    gitCwd?: string;
    replayFromRunId?: string;
  }): TraceManifest {
    const manifest: TraceManifest = {
      runId: TraceWriter.runIdFromDir(this.runDir),
      cli: input.cli,
      gitSha: input.gitSha ?? resolveGitSha(input.gitCwd),
      redactionMapVersion: input.redactionMapVersion,
      models: input.models,
      createdAt: new Date().toISOString(),
    };
    if (input.replayFromRunId) {
      manifest.replay = { fromRunId: input.replayFromRunId };
    }
    writeJson(path.join(this.runDir, "manifest.json"), manifest);
    return manifest;
  }

  // ----- phase-2-ingest -----

  writeIngestTrace(rows: IngestTraceEntry[]): void {
    writeJsonl(path.join(this.phaseDir("phase-2-ingest"), "ingest-trace.jsonl"), rows);
  }

  writeLlmRequests(rows: LlmRequestEntry[]): void {
    const truncated = rows.map((row) => ({
      ...row,
      requestPreview: truncateText(row.requestPreview),
      responsePreview: truncateText(row.responsePreview),
    }));
    writeJsonl(path.join(this.phaseDir("phase-2-ingest"), "llm-requests.jsonl"), truncated);
  }

  writeValidatorDecisions(rows: ValidatorDecisionEntry[]): void {
    writeJsonl(
      path.join(this.phaseDir("phase-2-ingest"), "validator-decisions.jsonl"),
      rows,
    );
  }

  // ----- phase-3-recall -----

  writeRecallTrace(rows: RecallTraceEntry[]): void {
    writeJsonl(path.join(this.phaseDir("phase-3-recall"), "recall-trace.jsonl"), rows);
  }

  writeEmbeddingRequests(rows: EmbeddingRequestEntry[]): void {
    const truncated = rows.map((row) => ({
      ...row,
      textPreview: truncateText(row.textPreview),
      embeddingPreview: row.embeddingPreview.slice(0, EMBEDDING_PREVIEW_DIMS),
    }));
    writeJsonl(
      path.join(this.phaseDir("phase-3-recall"), "embedding-requests.jsonl"),
      truncated,
    );
  }

  writeRankingBreakdown(rows: RankingBreakdownEntry[]): void {
    writeJsonl(
      path.join(this.phaseDir("phase-3-recall"), "ranking-breakdown.jsonl"),
      rows,
    );
  }

  // ----- phase-4-qa -----

  writeQaTrace(rows: QaTraceEntry[]): void {
    const truncated = rows.map((row) => ({
      ...row,
      contextPreview: truncateText(row.contextPreview),
      answerPreview: row.answerPreview ? truncateText(row.answerPreview) : undefined,
    }));
    writeJsonl(path.join(this.phaseDir("phase-4-qa"), "qa-trace.jsonl"), truncated);
  }

  writeCitationVerification(rows: CitationVerificationEntry[]): void {
    writeJsonl(
      path.join(this.phaseDir("phase-4-qa"), "citation-verification.jsonl"),
      rows,
    );
  }

  // ----- phase-5-analysis -----

  writeFailures(rows: FailureEntry[]): void {
    writeJsonl(path.join(this.phaseDir("phase-5-analysis"), "failures.jsonl"), rows);
  }

  writePerformance(report: PerformanceReport): void {
    writeJson(path.join(this.phaseDir("phase-5-analysis"), "performance.json"), report);
  }

  writeCoverage(report: CoverageReport): void {
    writeJson(
      path.join(this.phaseDir("phase-5-analysis"), "coverage-report.json"),
      report,
    );
  }

  /** 聚合写 phase-5-analysis 三件套。 */
  writeAnalysis(input: {
    failures: FailureEntry[];
    performance: PerformanceReport;
    coverage: CoverageReport;
  }): void {
    this.writeFailures(input.failures);
    this.writePerformance(input.performance);
    this.writeCoverage(input.coverage);
  }
}

// ===== Replay：从 trace 读回结构化数据 =====

/** 从 trace 读回的完整运行数据（供 grader 重放使用）。 */
export interface ReplayBundle {
  runDir: string;
  manifest?: TraceManifest;
  ingestTrace: IngestTraceEntry[];
  validatorDecisions: ValidatorDecisionEntry[];
  recallTrace: RecallTraceEntry[];
  rankingBreakdown: RankingBreakdownEntry[];
  qaTrace: QaTraceEntry[];
  citationVerification: CitationVerificationEntry[];
}

/**
 * 从 validation-runs/<runId>/ 读回 trace，供 grader 重放（不调 LLM / embedding）。
 * 只读取 grader 需要的阶段（ingest / recall / qa），跳过 llm/embedding raw。
 */
export function loadReplayBundle(runDir: string): ReplayBundle {
  if (!fs.existsSync(runDir)) {
    throw new Error(`replay run dir not found: ${runDir}`);
  }
  return {
    runDir,
    manifest: readJson<TraceManifest>(path.join(runDir, "manifest.json")),
    ingestTrace: readJsonl<IngestTraceEntry>(
      path.join(runDir, "phase-2-ingest", "ingest-trace.jsonl"),
    ),
    validatorDecisions: readJsonl<ValidatorDecisionEntry>(
      path.join(runDir, "phase-2-ingest", "validator-decisions.jsonl"),
    ),
    recallTrace: readJsonl<RecallTraceEntry>(
      path.join(runDir, "phase-3-recall", "recall-trace.jsonl"),
    ),
    rankingBreakdown: readJsonl<RankingBreakdownEntry>(
      path.join(runDir, "phase-3-recall", "ranking-breakdown.jsonl"),
    ),
    qaTrace: readJsonl<QaTraceEntry>(path.join(runDir, "phase-4-qa", "qa-trace.jsonl")),
    citationVerification: readJsonl<CitationVerificationEntry>(
      path.join(runDir, "phase-4-qa", "citation-verification.jsonl"),
    ),
  };
}

/**
 * 解析 runId 为绝对目录路径。
 * 支持传入完整路径或仅 runId（在 eval-corpus/<source>/validation-runs/ 下查找）。
 */
export function resolveRunDir(input: {
  runIdOrPath: string;
  evalCorpusRoot: string;
  source: string;
}): string {
  // 已是存在的绝对/相对路径
  if (fs.existsSync(input.runIdOrPath) && fs.statSync(input.runIdOrPath).isDirectory()) {
    return path.resolve(input.runIdOrPath);
  }
  return path.join(
    input.evalCorpusRoot,
    input.source,
    "validation-runs",
    input.runIdOrPath,
  );
}
