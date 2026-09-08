import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import OpenAI from "openai";

import { memoryConfigSchema, type MemoryConfig } from "../../../../config.js";
import { createMengshuRuntime } from "../../../../runtime.js";
import { ingestMarkdownDirectory } from "../../../../packages/core/src/ingest/adapters/file-system.js";
import type { RecallHit, MemoryScope } from "../../../../packages/core/src/domain/types.js";
import type { RagMultiCorpusQuery } from "../adapters/rag-multi-corpus.js";

const DATASET_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "data/rag-multi-corpus-v1",
);
const CORPUS_ROOT = path.join(DATASET_ROOT, "corpus");
const CORPUS_DATASETS = path.join(CORPUS_ROOT, "datasets");
const QUERIES_FILE = path.join(DATASET_ROOT, "queries.jsonl");
const MANIFEST_FILE = path.join(DATASET_ROOT, "manifest.json");
const CORPUS_MANIFEST_FILE = path.join(DATASET_ROOT, "corpus-manifest.json");

const READER_PROMPT_VERSION = "mengshu.kb-pilot-reader/v1";
const JUDGE_PROMPT_VERSION = "mengshu.kb-pilot-judge/v1";
const READER_SYSTEM_PROMPT = `You answer enterprise knowledge-base questions using only the supplied evidence.
Return JSON with exactly these fields: answer (string), evidenceSourcePaths (string array), abstained (boolean).
Use only source paths listed in the evidence. Include every fact needed by the question, but do not add unsupported facts.
If the evidence is insufficient, set abstained=true and explain the insufficiency briefly in answer.`;
const JUDGE_SYSTEM_PROMPT = `You are a strict, evidence-grounded evaluator.
Return JSON with exactly these fields: status (pass|partial|fail), unsupportedAnswer (boolean), reason (string).
pass: the answer is correct and sufficiently complete, all key facts are supported, and there is no material error.
partial: the core direction is correct but required information is missing or a non-critical error exists.
fail: the answer is wrong, has a critical omission, abstains despite sufficient evidence, contains an unsupported key fact, or has no usable answer.
Numbers, dates, names, enumerations, comparison sides, boolean explanations, and procedures must match the reference facts strictly.`;

interface DatasetManifest {
  readonly datasetId: string;
  readonly formalScoreEligible: false;
  readonly caseCount: number;
  readonly completeCaseCount: number;
  readonly invalidMissingDocumentCaseCount: number;
  readonly documentCount: number;
  readonly queriesSha256: string;
  readonly corpusManifestSha256: string;
}

interface CorpusManifest {
  readonly documentCount: number;
  readonly documents: readonly { readonly path: string; readonly sha256: string }[];
}

export interface EvidenceRef {
  readonly sourcePath: string;
  readonly locator?: string;
}

export interface UnifiedSystemOutput {
  readonly caseId: string;
  readonly system: "mengshu";
  readonly answer: string;
  readonly evidence: readonly EvidenceRef[];
  readonly abstained: boolean;
  readonly runtime: {
    readonly latencyMs: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly modelCalls: number;
  };
  readonly error: string | null;
}

export interface MengshuKbPilotCaseResult {
  readonly caseId: string;
  readonly enterpriseName: string;
  readonly queryType: string;
  readonly sourceStatus: RagMultiCorpusQuery["sourceStatus"];
  readonly output: UnifiedSystemOutput;
  readonly retrievedSourcePaths: readonly string[];
  readonly retrievalLatencyMs: number;
  readonly evidenceRecallAny: number | null;
  readonly evidenceRecallAll: number | null;
  readonly judgment: {
    readonly status: "pass" | "partial" | "fail" | "grounded_abstain" |
      "unsupported_answer" | "fabricated_evidence";
    readonly unsupportedAnswer: boolean;
    readonly fabricatedEvidenceCount: number;
    readonly reason: string;
  };
}

interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

interface ReaderResponse {
  readonly answer: string;
  readonly evidenceSourcePaths: readonly string[];
  readonly abstained: boolean;
}

interface JudgeResponse {
  readonly status: "pass" | "partial" | "fail";
  readonly unsupportedAnswer: boolean;
  readonly reason: string;
}

interface RunOptions {
  readonly split: "smoke" | "holdout" | "all";
  readonly caseId?: string;
  readonly limit?: number;
  readonly concurrency: number;
  readonly topK: number;
  readonly timeoutMs: number;
  readonly outputDir: string;
  readonly resume: boolean;
  readonly skipIngest: boolean;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function positiveInteger(name: string, fallback: number): number {
  const raw = argument(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function parseOptions(): RunOptions {
  const rawSplit = argument("--split") ?? "all";
  if (rawSplit !== "smoke" && rawSplit !== "holdout" && rawSplit !== "all") {
    throw new Error("--split must be smoke, holdout, or all");
  }
  const rawLimit = argument("--limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const resumeDir = argument("--resume");
  const defaultOutput = path.join(
    os.homedir(),
    ".mengshu",
    "eval-results",
    "kb-pilot-mengshu-v1",
    new Date().toISOString().replace(/[:.]/g, "-"),
  );
  return {
    split: rawSplit,
    caseId: argument("--case-id"),
    limit,
    concurrency: positiveInteger("--concurrency", 3),
    topK: positiveInteger("--top-k", 6),
    timeoutMs: positiveInteger("--timeout-ms", 30_000),
    outputDir: path.resolve(resumeDir ?? argument("--output") ?? defaultOutput),
    resume: resumeDir !== undefined,
    skipIngest: process.argv.includes("--skip-ingest") || resumeDir !== undefined,
  };
}

export function selectQueries(
  queries: readonly RagMultiCorpusQuery[],
  split: RunOptions["split"],
  limit?: number,
  caseId?: string,
): RagMultiCorpusQuery[] {
  if (caseId !== undefined) {
    const selected = queries.find((query) => query.id === caseId);
    if (!selected) throw new Error(`unknown kb-pilot case id: ${caseId}`);
    return [selected];
  }
  const valid = queries.filter((query) => query.sourceStatus === "complete");
  const invalid = queries.filter((query) => query.sourceStatus !== "complete");
  const smokeIds = new Set([...valid]
    .sort((left, right) => sha256(left.id).localeCompare(sha256(right.id)))
    .slice(0, 100)
    .map((query) => query.id));
  const selectedValid = split === "all"
    ? valid
    : valid.filter((query) => split === "smoke" ? smokeIds.has(query.id) : !smokeIds.has(query.id));
  const selected = [...selectedValid, ...invalid];
  return limit === undefined ? selected : selected.slice(0, limit);
}

function percentile(values: readonly number[], probability: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)]!;
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function readJsonLines<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || process.env[key] !== undefined) continue;
    let value = line.slice(index + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function loadConfig(): MemoryConfig {
  loadDotEnv(path.join(os.homedir(), ".mengshu", ".env"));
  const file = path.join(os.homedir(), ".mengshu", "config.json");
  return memoryConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

function loadDataset(): {
  readonly manifest: DatasetManifest;
  readonly corpusManifest: CorpusManifest;
  readonly queries: RagMultiCorpusQuery[];
} {
  const manifestBytes = readFileSync(MANIFEST_FILE);
  const corpusManifestBytes = readFileSync(CORPUS_MANIFEST_FILE);
  const queryBytes = readFileSync(QUERIES_FILE);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as DatasetManifest;
  const corpusManifest = JSON.parse(corpusManifestBytes.toString("utf8")) as CorpusManifest;
  const queries = queryBytes.toString("utf8").trim().split("\n")
    .map((line) => JSON.parse(line) as RagMultiCorpusQuery);
  if (sha256(queryBytes) !== manifest.queriesSha256 ||
      sha256(corpusManifestBytes) !== manifest.corpusManifestSha256 ||
      queries.length !== manifest.caseCount ||
      corpusManifest.documentCount !== manifest.documentCount) {
    throw new Error("kb-pilot dataset identity mismatch");
  }
  return { manifest, corpusManifest, queries };
}

function evaluationScope(manifest: DatasetManifest): MemoryScope {
  return Object.freeze({
    tenantId: "local",
    appId: "mengshu-eval",
    userId: "kb-pilot-eval",
    projectId: `kb-pilot-${manifest.queriesSha256.slice(0, 12)}`,
    agentId: "e2e-runner",
    namespace: "knowledge",
    visibility: "private" as const,
  });
}

function normalizeSourcePath(value: unknown, knownPaths: ReadonlySet<string>): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const candidate = path.isAbsolute(value)
    ? path.relative(CORPUS_ROOT, value)
    : value.replace(/^corpus[\\/]/, "");
  const normalized = candidate.split(path.sep).join("/");
  return knownPaths.has(normalized) ? normalized : undefined;
}

export function sourcePathFromRecord(
  record: { metadata?: Record<string, unknown>; provenance?: Record<string, unknown> },
  knownPaths: ReadonlySet<string>,
): string | undefined {
  const nestedProvenance = record.metadata?.provenance;
  const nested = nestedProvenance && typeof nestedProvenance === "object" &&
      !Array.isArray(nestedProvenance)
    ? nestedProvenance as Record<string, unknown>
    : undefined;
  return normalizeSourcePath(
    record.metadata?.filePath ?? record.provenance?.filePath ?? record.metadata?.sourceId ??
      nested?.filePath ?? nested?.sourceId,
    knownPaths,
  );
}

function hitSourcePath(hit: RecallHit, knownPaths: ReadonlySet<string>): string | undefined {
  return sourcePathFromRecord(
    hit.record as { metadata?: Record<string, unknown>; provenance?: Record<string, unknown> },
    knownPaths,
  );
}

function hitText(hit: RecallHit): string {
  const record = hit.record as { text?: unknown };
  return typeof record.text === "string" ? record.text : "";
}

function buildEvidenceContext(
  hits: readonly RecallHit[],
  knownPaths: ReadonlySet<string>,
): { readonly sourcePaths: string[]; readonly text: string; readonly byPath: ReadonlyMap<string, string> } {
  const byPath = new Map<string, string>();
  for (const hit of hits) {
    const sourcePath = hitSourcePath(hit, knownPaths);
    if (!sourcePath) continue;
    const text = hitText(hit).trim();
    if (!text) continue;
    const existing = byPath.get(sourcePath);
    byPath.set(sourcePath, existing ? `${existing}\n\n${text}` : text);
  }
  const sourcePaths = [...byPath.keys()];
  return {
    sourcePaths,
    byPath,
    text: sourcePaths.map((sourcePath, index) =>
      `[S${index + 1}] ${sourcePath}\n${byPath.get(sourcePath)}`).join("\n\n"),
  };
}

function jsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model response did not contain a JSON object");
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("model response JSON must be an object");
  }
  return value as Record<string, unknown>;
}

function parseReader(text: string): ReaderResponse {
  const value = jsonObject(text);
  if (typeof value.answer !== "string" || typeof value.abstained !== "boolean" ||
      !Array.isArray(value.evidenceSourcePaths) ||
      value.evidenceSourcePaths.some((item) => typeof item !== "string")) {
    throw new Error("reader response schema mismatch");
  }
  return {
    answer: value.answer,
    abstained: value.abstained,
    evidenceSourcePaths: value.evidenceSourcePaths as string[],
  };
}

function parseJudge(text: string): JudgeResponse {
  const value = jsonObject(text);
  if ((value.status !== "pass" && value.status !== "partial" && value.status !== "fail") ||
      typeof value.unsupportedAnswer !== "boolean" || typeof value.reason !== "string") {
    throw new Error("judge response schema mismatch");
  }
  return value as unknown as JudgeResponse;
}

class ModelInvocationError extends Error {
  constructor(
    message: string,
    readonly usage: CompletionUsage,
    readonly modelCalls: number,
  ) {
    super(message);
  }
}

async function completionOnce(
  client: OpenAI,
  model: string,
  system: string,
  user: string,
  timeoutMs: number,
  maxTokens: number,
): Promise<{ readonly text: string; readonly usage: CompletionUsage }> {
  const response = await client.chat.completions.create({
    model,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    temperature: 0,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
  }, { signal: AbortSignal.timeout(timeoutMs) });
  const choice = response.choices[0];
  const text = choice?.message.content;
  if (!text) {
    throw new Error(`model returned an empty response (finish_reason=${choice?.finish_reason ?? "missing"})`);
  }
  return {
    text,
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
    },
  };
}

async function structuredCompletion<T>(input: {
  readonly client: OpenAI;
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly parse: (text: string) => T;
}): Promise<{ readonly value: T; readonly usage: CompletionUsage; readonly modelCalls: number }> {
  let usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const completion = await completionOnce(
        input.client,
        input.model,
        input.system,
        attempt === 1
          ? input.user
          : `${input.user}\n\nThe previous response was invalid. Return only the required JSON object.`,
        input.timeoutMs,
        input.maxTokens,
      );
      usage = {
        inputTokens: usage.inputTokens + completion.usage.inputTokens,
        outputTokens: usage.outputTokens + completion.usage.outputTokens,
      };
      return { value: input.parse(completion.text), usage, modelCalls: attempt };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
  throw new ModelInvocationError(
    lastError instanceof Error ? lastError.message : String(lastError),
    usage,
    3,
  );
}

async function runCase(input: {
  readonly query: RagMultiCorpusQuery;
  readonly recall: (query: string) => Promise<readonly RecallHit[]>;
  readonly client: OpenAI;
  readonly model: string;
  readonly timeoutMs: number;
  readonly knownPaths: ReadonlySet<string>;
}): Promise<MengshuKbPilotCaseResult> {
  const startedAt = Date.now();
  const retrievalStartedAt = Date.now();
  const hits = await input.recall(input.query.query);
  const retrievalLatencyMs = Date.now() - retrievalStartedAt;
  const evidence = buildEvidenceContext(hits, input.knownPaths);
  let readerUsage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
  let judgeUsage: CompletionUsage = { inputTokens: 0, outputTokens: 0 };
  let modelCalls = 0;
  try {
    const readerCompletion = await structuredCompletion({
      client: input.client,
      model: input.model,
      system: READER_SYSTEM_PROMPT,
      user: `Question: ${input.query.query}\n\nEvidence:\n${evidence.text || "(no evidence retrieved)"}`,
      timeoutMs: input.timeoutMs,
      maxTokens: 2_400,
      parse: parseReader,
    });
    modelCalls += readerCompletion.modelCalls;
    readerUsage = readerCompletion.usage;
    const reader = readerCompletion.value;
    const fabricatedPaths = reader.evidenceSourcePaths.filter((sourcePath) =>
      !evidence.sourcePaths.includes(sourcePath) || !input.knownPaths.has(sourcePath));
    const output: UnifiedSystemOutput = {
      caseId: input.query.id,
      system: "mengshu",
      answer: reader.answer,
      evidence: reader.evidenceSourcePaths.map((sourcePath) => ({ sourcePath })),
      abstained: reader.abstained,
      runtime: {
        latencyMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        modelCalls: 0,
      },
      error: null,
    };
    let judgment: MengshuKbPilotCaseResult["judgment"];
    if (input.query.sourceStatus !== "complete") {
      judgment = fabricatedPaths.length > 0
        ? {
            status: "fabricated_evidence",
            unsupportedAnswer: true,
            fabricatedEvidenceCount: fabricatedPaths.length,
            reason: "Invalid case cited a source path not present in retrieved corpus evidence.",
          }
        : reader.abstained
          ? {
              status: "grounded_abstain",
              unsupportedAnswer: false,
              fabricatedEvidenceCount: 0,
              reason: "System abstained because the referenced source document is absent.",
            }
          : {
              status: "unsupported_answer",
              unsupportedAnswer: true,
              fabricatedEvidenceCount: 0,
              reason: "System answered an invalid case whose required source document is absent.",
            };
    } else if (fabricatedPaths.length > 0) {
      judgment = {
        status: "fail",
        unsupportedAnswer: true,
        fabricatedEvidenceCount: fabricatedPaths.length,
        reason: "The answer cited evidence outside the retrieved corpus allowlist.",
      };
    } else {
      const selectedEvidence = reader.evidenceSourcePaths.map((sourcePath) => ({
        sourcePath,
        content: evidence.byPath.get(sourcePath) ?? "",
      }));
      const judgeCompletion = await structuredCompletion({
        client: input.client,
        model: input.model,
        system: JUDGE_SYSTEM_PROMPT,
        user: JSON.stringify({
          question: input.query.query,
          queryType: input.query.queryType,
          referenceSupportingFacts: input.query.supportingFacts,
          answer: reader.answer,
          abstained: reader.abstained,
          selectedEvidence,
        }),
        timeoutMs: input.timeoutMs,
        maxTokens: 1_600,
        parse: parseJudge,
      });
      modelCalls += judgeCompletion.modelCalls;
      judgeUsage = judgeCompletion.usage;
      const judged = judgeCompletion.value;
      judgment = {
        ...judged,
        fabricatedEvidenceCount: 0,
      };
    }
    const selected = new Set(evidence.sourcePaths);
    const required = input.query.evidenceDocumentPaths;
    const valid = input.query.sourceStatus === "complete";
    const completedOutput: UnifiedSystemOutput = {
      ...output,
      runtime: {
        latencyMs: Date.now() - startedAt,
        inputTokens: readerUsage.inputTokens + judgeUsage.inputTokens,
        outputTokens: readerUsage.outputTokens + judgeUsage.outputTokens,
        modelCalls,
      },
    };
    return {
      caseId: input.query.id,
      enterpriseName: input.query.enterpriseName,
      queryType: input.query.queryType,
      sourceStatus: input.query.sourceStatus,
      output: completedOutput,
      retrievedSourcePaths: evidence.sourcePaths,
      retrievalLatencyMs,
      evidenceRecallAny: valid ? Number(required.some((sourcePath) => selected.has(sourcePath))) : null,
      evidenceRecallAll: valid ? Number(required.every((sourcePath) => selected.has(sourcePath))) : null,
      judgment,
    };
  } catch (error) {
    if (error instanceof ModelInvocationError) {
      modelCalls += error.modelCalls;
      readerUsage = {
        inputTokens: readerUsage.inputTokens + error.usage.inputTokens,
        outputTokens: readerUsage.outputTokens + error.usage.outputTokens,
      };
    }
    return {
      caseId: input.query.id,
      enterpriseName: input.query.enterpriseName,
      queryType: input.query.queryType,
      sourceStatus: input.query.sourceStatus,
      output: {
        caseId: input.query.id,
        system: "mengshu",
        answer: "",
        evidence: [],
        abstained: false,
        runtime: {
          latencyMs: Date.now() - startedAt,
          inputTokens: readerUsage.inputTokens + judgeUsage.inputTokens,
          outputTokens: readerUsage.outputTokens + judgeUsage.outputTokens,
          modelCalls,
        },
        error: error instanceof Error ? error.message : String(error),
      },
      retrievedSourcePaths: evidence.sourcePaths,
      retrievalLatencyMs,
      evidenceRecallAny: input.query.sourceStatus === "complete" ? 0 : null,
      evidenceRecallAll: input.query.sourceStatus === "complete" ? 0 : null,
      judgment: {
        status: input.query.sourceStatus === "complete" ? "fail" : "unsupported_answer",
        unsupportedAnswer: false,
        fabricatedEvidenceCount: 0,
        reason: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function buildReport(input: {
  readonly manifest: DatasetManifest;
  readonly options: RunOptions;
  readonly scope: MemoryScope;
  readonly model: string;
  readonly configFingerprint: string;
  readonly initialization: unknown;
  readonly results: readonly MengshuKbPilotCaseResult[];
}): Record<string, unknown> {
  const valid = input.results.filter((result) => result.sourceStatus === "complete");
  const invalid = input.results.filter((result) => result.sourceStatus !== "complete");
  const validUnsupported = valid.filter((result) => result.judgment.unsupportedAnswer).length;
  const statuses = (status: MengshuKbPilotCaseResult["judgment"]["status"]) =>
    input.results.filter((result) => result.judgment.status === status).length;
  const latencies = input.results.map((result) => result.output.runtime.latencyMs);
  const tokens = input.results.map((result) =>
    result.output.runtime.inputTokens + result.output.runtime.outputTokens);
  const base = {
    schemaVersion: "mengshu.kb-pilot-e2e-report/v1",
    scoreAuthority: "diagnostic",
    formalScoreEligible: false,
    officialAnswerScoring: "not_run",
    generatedAt: new Date().toISOString(),
    system: "mengshu",
    systemVersion: JSON.parse(readFileSync(path.resolve("package.json"), "utf8")).version,
    datasetId: input.manifest.datasetId,
    datasetQueriesSha256: input.manifest.queriesSha256,
    split: input.options.split,
    selectedCases: input.results.length,
    scope: input.scope,
    configFingerprint: input.configFingerprint,
    reader: { model: input.model, promptVersion: READER_PROMPT_VERSION, promptSha256: sha256(READER_SYSTEM_PROMPT) },
    judge: { model: input.model, promptVersion: JUDGE_PROMPT_VERSION, promptSha256: sha256(JUDGE_SYSTEM_PROMPT), calibrated: false },
    initialization: input.initialization,
    metrics: {
      validCases: valid.length,
      strictPass: statuses("pass"),
      partial: statuses("partial"),
      fail: statuses("fail"),
      e2eStrictSuccessRate: valid.length === 0 ? 0 : statuses("pass") / valid.length,
      unsupportedAnswers: validUnsupported,
      unsupportedAnswerRate: valid.length === 0 ? 0 : validUnsupported / valid.length,
      fabricatedEvidenceCount: input.results.reduce((sum, result) =>
        sum + result.judgment.fabricatedEvidenceCount, 0),
      invalidCases: invalid.length,
      invalidGroundedAbstention: statuses("grounded_abstain"),
      invalidUnsupportedAnswers: statuses("unsupported_answer"),
      invalidFabricatedEvidence: invalid.reduce((sum, result) =>
        sum + result.judgment.fabricatedEvidenceCount, 0),
      evidenceRecallAny: mean(valid.map((result) => result.evidenceRecallAny ?? 0)),
      evidenceRecallAll: mean(valid.map((result) => result.evidenceRecallAll ?? 0)),
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      tokensMean: mean(tokens),
      tokensP95: percentile(tokens, 0.95),
      modelCallsMean: mean(input.results.map((result) => result.output.runtime.modelCalls)),
      errorCount: input.results.filter((result) => result.output.error !== null).length,
    },
    blockers: [
      "judge_human_calibration_missing",
      "kb_pilot_paired_run_missing",
      "official_reference_answers_absent",
    ],
    results: input.results,
  };
  return { ...base, reportHash: sha256(canonicalJson(base)) };
}

async function main(): Promise<void> {
  const options = parseOptions();
  const { manifest, corpusManifest, queries } = loadDataset();
  const selected = selectQueries(queries, options.split, options.limit, options.caseId);
  const scope = evaluationScope(manifest);
  const config = loadConfig();
  if (!config.llm) throw new Error("Mengshu LLM config is required for end-to-end evaluation");
  const configFingerprint = sha256(canonicalJson({
    dbType: config.dbType,
    embedding: { provider: config.embedding.provider, baseURL: config.embedding.baseURL, model: config.embedding.model },
    llm: { provider: config.llm.provider, baseURL: config.llm.baseURL, model: config.llm.model },
    batchProcessing: config.batchProcessing,
  }));
  mkdirSync(options.outputDir, { recursive: true, mode: 0o700 });
  const checkpointFile = path.join(options.outputDir, "cases.jsonl");
  const runFile = path.join(options.outputDir, "run.json");
  const runIdentity = {
    schemaVersion: "mengshu.kb-pilot-e2e-run/v1",
    datasetId: manifest.datasetId,
    datasetQueriesSha256: manifest.queriesSha256,
    split: options.split,
    selectedCaseIds: selected.map((query) => query.id),
    scope,
    configFingerprint,
    topK: options.topK,
    timeoutMs: options.timeoutMs,
    readerPromptSha256: sha256(READER_SYSTEM_PROMPT),
    judgePromptSha256: sha256(JUDGE_SYSTEM_PROMPT),
  };
  if (options.resume) {
    const existing = JSON.parse(readFileSync(runFile, "utf8")) as unknown;
    if (canonicalJson(existing) !== canonicalJson(runIdentity)) throw new Error("resume run identity mismatch");
  } else {
    if (existsSync(checkpointFile)) throw new Error("output directory already contains checkpoints");
    writeFileSync(runFile, `${JSON.stringify(runIdentity, null, 2)}\n`, { mode: 0o600 });
  }

  const runtime = createMengshuRuntime({ config, resolvedDbPath: "", appId: scope.appId, defaultScope: scope });
  await runtime.start();
  try {
    const initializationStartedAt = Date.now();
    let initialization: Record<string, unknown>;
    if (options.skipIngest) {
      initialization = { skipped: true, reason: options.resume ? "resume" : "explicit", latencyMs: 0 };
    } else {
      const ingestion = await ingestMarkdownDirectory({
        directory: CORPUS_DATASETS,
        scope,
        pipeline: runtime.ingestionPipeline,
        targetTable: "knowledge",
        autoEnrichMetadata: true,
      });
      if (ingestion.totalFiles !== manifest.documentCount || ingestion.failedFiles > 0) {
        throw new Error(
          `kb-pilot ingestion failed: files=${ingestion.totalFiles}/${manifest.documentCount}, ` +
          `failed=${ingestion.failedFiles}`,
        );
      }
      initialization = {
        skipped: false,
        ...ingestion,
        latencyMs: Date.now() - initializationStartedAt,
      };
    }
    const knownPaths = new Set(corpusManifest.documents.map((document) => document.path));
    const client = new OpenAI({ apiKey: config.llm.apiKey, baseURL: config.llm.baseURL });
    const existing = readJsonLines<MengshuKbPilotCaseResult>(checkpointFile);
    const byId = new Map(existing.map((result) => [result.caseId, result]));
    const pending = selected.filter((query) => !byId.has(query.id));
    let completed = existing.length;
    process.stdout.write(JSON.stringify({ outputDir: options.outputDir, selected: selected.length,
      resumed: existing.length, pending: pending.length, initialization }, null, 2) + "\n");

    let cursor = 0;
    const workers = Array.from({ length: Math.min(options.concurrency, pending.length) }, async () => {
      while (cursor < pending.length) {
        const index = cursor++;
        const query = pending[index]!;
        const result = await runCase({
          query,
          client,
          model: config.llm!.model,
          timeoutMs: options.timeoutMs,
          knownPaths,
          recall: async (question) => (await runtime.memoryService.recall({
            query: question,
            scope,
            limit: options.topK,
            minScore: 0,
            tableName: "knowledge",
            dataTypes: ["document", "knowledge"],
          })).hits,
        });
        byId.set(query.id, result);
        appendFileSync(checkpointFile, `${JSON.stringify(result)}\n`, { mode: 0o600 });
        completed += 1;
        if (completed % 10 === 0 || completed === selected.length) {
          process.stdout.write(`[kb-pilot-e2e] ${completed}/${selected.length}\n`);
        }
      }
    });
    await Promise.all(workers);
    const results = selected.map((query) => byId.get(query.id)!);
    const report = buildReport({
      manifest,
      options,
      scope,
      model: config.llm.model,
      configFingerprint,
      initialization,
      results,
    });
    writeFileSync(path.join(options.outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ outputDir: options.outputDir, metrics: report.metrics,
      blockers: report.blockers, reportHash: report.reportHash }, null, 2)}\n`);
  } finally {
    await runtime.stop();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  });
}
