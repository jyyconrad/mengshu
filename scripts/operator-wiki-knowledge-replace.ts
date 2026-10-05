/**
 * wiki-knowledge-governance operator 工具。
 *
 * 命令：
 *   verify / regroup / apply —— 既有命令（apply 已修复 Embeddings 配置类型与 provenance 合同）
 *   freeze    —— 冻结输入：run 目录、输入哈希、source-manifest.jsonl、inputs-diff、旧运行证据
 *   baseline  —— PostgreSQL 只读基线 + embedding 模型/维度（维度必须带出处，禁止无出处硬编码）
 *   audit     —— 逐行流式审计旧 analysis（一行坏 JSON 只登记该行，不丢整批）
 *   merge     —— 合并 reused 与各 read 运行目录 JSONL（拒绝重复/未知/跨 scope/hash 漂移）
 *   preflight —— 页面/embedding/数据库只读预检（绝不写数据库）
 *
 * 铁律：校验核心保持纯函数；脚本自身不发起 LLM 调用（apply 的 embedding 向量化是
 * 向量服务调用，不是 LLM，且仅在带确认 token 的 apply 中发生）；所有产物经临时文件 +
 * 原子 rename 落盘；任何输出不携带 apiKey、数据库密码、host、用户名。
 */
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { vectorDimsForModel } from "../config.js";
import { Embeddings } from "../packages/core/src/runtime/llm/embeddings.js";

const TOKEN = "APPLY-WIKI-KNOWLEDGE-REPLACE";
const SPACE_ID = /^embedding-space:v1:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OLD_RUN_WF_ID = "wf_01a10234494d711087a165cd94916fca";

export interface AnalysisRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly excerpt: string;
  readonly path: string;
}

export interface WikiPage {
  readonly path: string;
  readonly scopeKey: string;
  readonly text: string;
  readonly semanticType: string;
  readonly memoryForm: string;
  readonly treeType: string;
  readonly sourceIds: readonly string[];
}

/** source-manifest.jsonl 的单行（freeze 生成，audit/merge/preflight 消费）。 */
export interface SourceManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly sourceRoot: string;
  readonly scopeKey: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly batchFile: string;
}

/** audit 之后的 reused 记录 = 原始 analysis 记录 + 冻结证据字段。 */
export interface ReusedAnalysisRecord {
  readonly id: string;
  readonly scopeKey: string;
  readonly excerpt: string;
  readonly path: string;
  readonly sourceSha256: string;
  readonly batchFile: string;
  readonly [key: string]: unknown;
}

export function extractWorksetBody(markdown: string): string {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return text.trim();
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return text.trim();
  return text.slice(end + 5).replace(/^<!-- mengshu-content-preview-bytes: \d+ -->\n/, "").trim();
}

export function excerptMatches(body: string, excerpt: string): boolean {
  const sample = excerpt.trim();
  const source = body.trim();
  // 空/超短正文(<12 字符)没有可截取的片段:唯一真实摘录是全文本身,必须逐字相等。
  if (source.length < 12) return sample === source;
  if (sample.length < 12) return false;
  return source.includes(sample);
}

export function coverageReport(
  expectedIds: readonly string[],
  claims: readonly AnalysisRecord[],
): { missing: string[]; duplicate: string[] } {
  const seen = new Set<string>();
  const duplicate: string[] = [];
  for (const claim of claims) {
    if (seen.has(claim.id)) duplicate.push(claim.id);
    seen.add(claim.id);
  }
  const missing = expectedIds.filter((id) => !seen.has(id));
  return { missing, duplicate };
}

function fail(message: string): never {
  throw new Error(message);
}

function resolveEnv(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("config value is empty");
  const resolved = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_all, name: string) => {
    const env = process.env[name];
    if (!env) fail(`unresolved config placeholder ${name}`);
    return env;
  });
  if (resolved.includes("${") || resolved.includes("}")) fail("config placeholder was not resolved");
  return resolved;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function arg(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) fail(`missing ${name}`);
  return value;
}

/** 收集一个可重复出现的 flag 的全部取值（merge --inputs）。 */
function args(name: string): string[] {
  const values: string[] = [];
  for (let index = process.argv.indexOf(name); index >= 0; index = process.argv.indexOf(name, index + 1)) {
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for ${name}`);
    values.push(value);
    index += 1;
  }
  if (values.length === 0) fail(`missing ${name}`);
  return values;
}

function optionalArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

/** lstat walk：符号链接一律拒绝（不跟随、不收录）；目录递归，文件按后缀收集。 */
function walk(dir: string, suffix: string, into: string[]): void {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) fail(`analysis entry is a symlink: ${path}`);
    if (stats.isDirectory()) walk(path, suffix, into);
    else if (stats.isFile() && name.endsWith(suffix)) into.push(path);
  }
}

export function parseAnalysisLine(line: string): AnalysisRecord {
  const value = JSON.parse(line) as Partial<AnalysisRecord>;
  if (typeof value.id !== "string" || !UUID.test(value.id)) fail("analysis id is invalid");
  if (typeof value.scopeKey !== "string" || value.scopeKey.length === 0) fail("analysis scope is empty");
  if (typeof value.excerpt !== "string") fail("analysis excerpt is missing");
  if (typeof value.path !== "string" || value.path.length === 0) fail("analysis path is missing");
  return { id: value.id, scopeKey: value.scopeKey, excerpt: value.excerpt, path: value.path };
}

/**
 * verify 阶段的路径 containment：claim.path 必须是绝对路径且不含 "." / ".." 段；
 * 提供冻结 manifest 时进一步要求与该 id 的冻结路径完全一致——冻结路径已在 freeze
 * 阶段通过双根 containment 与 lstat 校验，等价于拒绝读取任意未声明的绝对路径。
 */
export function claimPathViolation(
  claim: AnalysisRecord,
  manifestById: ReadonlyMap<string, SourceManifestEntry> | null,
): string | null {
  if (!isAbsolute(claim.path)) return "path-not-absolute";
  const segments = claim.path.split("/");
  if (segments.includes("..") || segments.includes(".")) return "path-escape";
  if (!manifestById) return null;
  const entry = manifestById.get(claim.id);
  if (!entry) return "unknown-id";
  if (claim.path !== entry.path) return "path-mismatch";
  return null;
}

const SEMANTIC_TYPES = new Set(["profile", "task_context", "rules", "experience", "resource", "unclassified"]);
const MEMORY_FORMS = new Set(["event", "fact", "semantic", "procedural", "unknown"]);
/** 最终 wiki 页面只允许 source/topic/global；读取阶段额外允许 "none"（见 TREE_TYPES_READ）。 */
const TREE_TYPES = new Set(["source", "topic", "global"]);
const TREE_TYPES_READ = new Set(["source", "topic", "global", "none"]);

const BATCH_FILE_RE = /^batch-(\d{4})-n(\d+)\.txt$/;
const PART_DIR_RE = /^part-\d{3,}$/;
const PAGE_ENTRY_RE = /^page-\d{3,}\.(md|sources)$/;

// ---------------------------------------------------------------------------
// 纯校验函数（离线可测）
// ---------------------------------------------------------------------------

/** "batch-0336-n60.txt" -> { index: 336, expected: 60 }；不合法返回 null。 */
export function parseBatchFileName(name: string): { index: number; expected: number } | null {
  const match = BATCH_FILE_RE.exec(name);
  if (!match) return null;
  return { index: Number(match[1]), expected: Number(match[2]) };
}

/** 词法 containment：path 必须位于 root 目录内（不含 root 自身）。 */
export function containsPath(path: string, root: string): boolean {
  return path.startsWith(`${root}/`);
}

/** audit 阶段摘录最小长度：12 个字符（verify 阶段沿用旧的 >=8）。 */
export function checkExcerptQuality(excerpt: string): boolean {
  return excerpt.trim().length >= 12;
}

export interface AuditRuleContext {
  readonly canonicalScopes: ReadonlySet<string>;
  readonly beforeIds: ReadonlySet<string>;
  readonly manifest: ReadonlyMap<string, SourceManifestEntry>;
  /** 当前 analysis 文件对应的批次名（"batch-0000-n60.txt"）；无法解析时为 null。 */
  readonly analysisBatchFile: string | null;
}

/**
 * 对单条已 JSON.parse 成功的记录做全部纯校验；返回失败原因或 null。
 * 文件系统相关的校验（符号链接、源 hash、excerpt 回读）由 runAudit 补充。
 */
export function auditRecordReason(
  record: Record<string, unknown>,
  ctx: AuditRuleContext,
): string | null {
  const id = record.id;
  if (typeof id !== "string" || !UUID.test(id)) return "invalid-uuid";
  if (!ctx.beforeIds.has(id)) return "id-not-in-before-ids";
  const entry = ctx.manifest.get(id);
  if (!entry) return "unknown-id";
  if (typeof record.scopeKey !== "string") return "invalid-scope";
  // 典型案例：'knowledge-legacy-tech- writer'（带空格 typo）不在 21 个 canonical scope 内。
  if (!ctx.canonicalScopes.has(record.scopeKey)) return "unknown-scope";
  if (record.scopeKey !== entry.scopeKey) return "scope-mismatch";
  if (typeof record.path !== "string" || record.path !== entry.path) return "path-mismatch";
  if (typeof record.semanticType !== "string" || !SEMANTIC_TYPES.has(record.semanticType)) return "semantic-type";
  if (typeof record.memoryForm !== "string" || !MEMORY_FORMS.has(record.memoryForm)) return "memory-form";
  // 读取阶段允许 "none"；最终页面由 parseWikiPage 用 TREE_TYPES（无 none）拒绝。
  if (typeof record.treeType !== "string" || !TREE_TYPES_READ.has(record.treeType)) return "tree-type";
  if (typeof record.excerpt !== "string") return "invalid-excerpt";
  // 摘录长度不再在此纯校验:空/超短正文(<12)的合法摘录就是全文本身,
  // 由正文感知的 excerptMatches(runAudit/runMerge/verify 共用)逐字裁决。
  if (ctx.analysisBatchFile === null) return "unknown-analysis-file";
  if (ctx.analysisBatchFile !== entry.batchFile) return "batch-mismatch";
  return null;
}

export interface PageHashEntry {
  readonly textHash: string;
  readonly scopeKey: string;
  readonly page: string;
}

export interface ContentHashConflict {
  readonly textHash: string;
  readonly scopes: string[];
  readonly pages: string[];
}

/** 跨 scope 的同文冲突：同一正文 hash 出现在 >=2 个不同 scope。同 scope 重复不算冲突（apply 会去重）。 */
export function detectContentHashConflicts(entries: readonly PageHashEntry[]): ContentHashConflict[] {
  const byHash = new Map<string, Map<string, string[]>>();
  for (const entry of entries) {
    const scopes = byHash.get(entry.textHash) ?? new Map<string, string[]>();
    const pages = scopes.get(entry.scopeKey) ?? [];
    pages.push(entry.page);
    scopes.set(entry.scopeKey, pages);
    byHash.set(entry.textHash, scopes);
  }
  const conflicts: ContentHashConflict[] = [];
  for (const [textHash, scopes] of byHash) {
    if (scopes.size < 2) continue;
    conflicts.push({
      textHash,
      scopes: [...scopes.keys()].sort(),
      pages: [...scopes.values()].flat().sort(),
    });
  }
  return conflicts.sort((left, right) => left.textHash.localeCompare(right.textHash));
}

/**
 * 同 scope 同文页去重：幸存页合并全部 sourceIds（保序去重）。apply 的 coverage 在
 * 去重前的全量页上计算，若不合并 sourceIds，被丢弃页的 source id 会被 coverage
 * 视为已覆盖却不在任何入库行的 metadata.sourceIds 中——provenance 链断裂。
 */
export function dedupeWikiPages(pages: readonly WikiPage[]): WikiPage[] {
  const byKey = new Map<string, WikiPage>();
  for (const page of pages) {
    const key = `${page.scopeKey}\n${page.text}`;
    const survivor = byKey.get(key);
    if (!survivor) {
      byKey.set(key, page);
      continue;
    }
    byKey.set(key, { ...survivor, sourceIds: [...new Set([...survivor.sourceIds, ...page.sourceIds])] });
  }
  return [...byKey.values()];
}

export interface EmbeddingDimsCandidate {
  readonly dims: number;
  readonly source: string;
}

export interface ResolvedEmbeddingDims {
  readonly dims: number;
  readonly source: string;
  readonly candidates: readonly EmbeddingDimsCandidate[];
}

/**
 * 维度必须有出处：PostgreSQL embedding-space registry（mengshu_active_embedding_space）
 * 与 config.ts 的 vectorDimsForModel(model) 模型表。两源都缺失时拒绝执行，
 * 绝不无出处地默认 1024；两源冲突同样拒绝。
 */
export function resolveEmbeddingDims(input: {
  registry?: { dims: number | null } | null;
  configModel: string;
}): ResolvedEmbeddingDims {
  const candidates: EmbeddingDimsCandidate[] = [];
  const registryDims = input.registry?.dims;
  if (typeof registryDims === "number" && Number.isSafeInteger(registryDims) && registryDims > 0) {
    candidates.push({ dims: registryDims, source: "postgres:mengshu_active_embedding_space.dimensions" });
  }
  let modelTableDims: number | null = null;
  try {
    modelTableDims = vectorDimsForModel(input.configModel);
  } catch {
    modelTableDims = null;
  }
  if (modelTableDims !== null) {
    candidates.push({ dims: modelTableDims, source: `config:vectorDimsForModel(model=${input.configModel})` });
  }
  if (candidates.length === 0) {
    fail(`embedding dims could not be sourced (model=${input.configModel}); refusing to default`);
  }
  const dims = candidates[0]!.dims;
  if (candidates.some((candidate) => candidate.dims !== dims)) {
    fail(`embedding dims conflict: ${candidates.map((c) => `${c.source}=${c.dims}`).join(", ")}`);
  }
  return { dims, source: candidates[0]!.source, candidates };
}

/** 旧 manifest.txt 是 "key=value" 行（source=.../files=47963/batchSize=25/batches=1919）。 */
export function parseManifestTxt(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    fields[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return fields;
}

export interface FreezeManifestJson {
  readonly files: number;
  readonly batches: number;
  readonly fullBatchSize: number;
  readonly lastBatchSize: number;
  readonly scopes: number;
}

export interface InputsDiffEntry {
  readonly field: string;
  readonly manifestTxt: string | number | null;
  readonly manifestJson: string | number | null;
  readonly note?: string;
}

export interface InputsDiffReceipt {
  readonly manifestTxt: Record<string, string> | null;
  readonly manifestJson: FreezeManifestJson;
  readonly differences: readonly InputsDiffEntry[];
  readonly decision: string;
}

/** 对比旧 manifest.txt（47963/25/1919）与新冻结的 manifest.json（49509/826/60/9/21）。 */
export function buildInputsDiff(
  manifestTxt: Record<string, string> | null,
  manifestJson: FreezeManifestJson,
): InputsDiffReceipt {
  const differences: InputsDiffEntry[] = [];
  if (manifestTxt) {
    const oldFiles = Number(manifestTxt.files);
    if (Number.isSafeInteger(oldFiles) && oldFiles !== manifestJson.files) {
      differences.push({ field: "files", manifestTxt: oldFiles, manifestJson: manifestJson.files, note: `delta=${manifestJson.files - oldFiles}` });
    }
    const oldBatches = Number(manifestTxt.batches);
    if (Number.isSafeInteger(oldBatches) && oldBatches !== manifestJson.batches) {
      differences.push({ field: "batches", manifestTxt: oldBatches, manifestJson: manifestJson.batches });
    }
    const oldBatchSize = Number(manifestTxt.batchSize);
    if (Number.isSafeInteger(oldBatchSize) && oldBatchSize !== manifestJson.fullBatchSize) {
      differences.push({ field: "batchSize", manifestTxt: oldBatchSize, manifestJson: manifestJson.fullBatchSize, note: "manifest.json renames this to fullBatchSize" });
    }
    if (manifestTxt.source) {
      differences.push({ field: "source", manifestTxt: manifestTxt.source, manifestJson: null, note: "source root is only declared in manifest.txt" });
    }
  }
  return {
    manifestTxt,
    manifestJson,
    differences,
    decision: "rerun trusts hashed manifest.json + batches/*.txt only; manifest.txt stats are not mixed in",
  };
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let value = from; value <= to; value += 1) out.push(value);
  return out;
}

export interface KnownIssuesInput {
  readonly malformedLines: ReadonlyArray<{ file: string; line: number }>;
  readonly batchValid: ReadonlyMap<string, number>;
  readonly expectedBatches: readonly string[];
  readonly excerptMisses: number;
  readonly unknownScopeRecords: number;
  readonly nonCanonicalScopes: readonly string[];
  readonly distinctAnalysisScopes: number;
  readonly templateScopeCount: number;
}

/**
 * 核实计划点名的问题（纯函数，观察值由 runAudit 统计）：
 * batch-0336-n60.txt.jsonl:55 拼接 JSON、缺批次 440 与 448-825（379 个）、
 * 约 1117 条 excerpt miss、scope typo、22 个 analysis scope 对 21 个模板。
 */
export function evaluateKnownIssues(input: KnownIssuesInput) {
  const batch0336 = input.malformedLines.some(
    (item) => item.file.endsWith("batch-0336-n60.txt.jsonl") && item.line === 55,
  );
  const missingBatchNumbers = input.expectedBatches
    .filter((name) => (input.batchValid.get(name) ?? 0) === 0)
    .map((name) => parseBatchFileName(name)?.index)
    .filter((index): index is number => index !== null && index !== undefined)
    .sort((left, right) => left - right);
  const claimedMissing = [440, ...range(448, 825)];
  const missingConfirmed = claimedMissing.every((index) => missingBatchNumbers.includes(index));
  return {
    batch0336ConcatenatedJson: {
      expected: { file: "batch-0336-n60.txt.jsonl", line: 55 },
      confirmed: batch0336,
      malformedLineCount: input.malformedLines.length,
    },
    missingBatches: {
      claimedBatchNumbers: claimedMissing,
      claimedCount: claimedMissing.length,
      confirmed: missingConfirmed,
      actualMissingCount: missingBatchNumbers.length,
      actualMissingBatchNumbers: missingBatchNumbers,
    },
    excerptMisses: {
      claimedApprox: 1117,
      confirmed: input.excerptMisses > 0,
      actual: input.excerptMisses,
    },
    scopeTypo: {
      claimed: "knowledge-legacy-tech- writer (space instead of hyphen)",
      confirmed: input.unknownScopeRecords > 0,
      unknownScopeRecords: input.unknownScopeRecords,
      nonCanonicalScopes: [...input.nonCanonicalScopes].sort(),
    },
    scopeCountMismatch: {
      claimed: "22 analysis scopes vs 21 templates",
      confirmed: input.distinctAnalysisScopes > input.templateScopeCount,
      analysisScopes: input.distinctAnalysisScopes,
      templateScopes: input.templateScopeCount,
    },
  };
}

/** merge 阶段单条记录对冻结 manifest 与协议枚举的纯校验；excerpt 回读由 runMerge 的来源重读步骤补充。 */
export function mergeRecordError(
  record: Record<string, unknown>,
  entry: SourceManifestEntry,
): string | null {
  if (record.id !== entry.id) return "id-mismatch";
  if (record.scopeKey !== entry.scopeKey) return "cross-scope-record";
  if (record.path !== entry.path) return "path-drift";
  if (record.sourceSha256 !== entry.sha256) return "source-hash-drift";
  if (record.batchFile !== entry.batchFile) return "batch-drift";
  if (typeof record.excerpt !== "string") return "invalid-excerpt";
  if (typeof record.semanticType !== "string" || !SEMANTIC_TYPES.has(record.semanticType)) return "semantic-type";
  if (typeof record.memoryForm !== "string" || !MEMORY_FORMS.has(record.memoryForm)) return "memory-form";
  // 读取阶段允许 "none"；最终页面由 parseWikiPage 用 TREE_TYPES（无 none）拒绝。
  if (typeof record.treeType !== "string" || !TREE_TYPES_READ.has(record.treeType)) return "tree-type";
  return null;
}

// ---------------------------------------------------------------------------
// 文件系统辅助（lstat containment、流式哈希、原子写）
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 流式 SHA-256：49,509 个源文件哈希走这里，恒定内存。 */
function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function atomicWrite(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await writeFile(tmp, data, "utf8");
  await rename(tmp, path);
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 只用 lstat 收集 JSONL：符号链接既不跟随也不收录。 */
function collectJsonlFiles(dir: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stats = lstatSync(path);
      if (stats.isDirectory()) stack.push(path);
      else if (stats.isFile() && name.endsWith(".jsonl")) out.push(path);
    }
  }
  return out.sort();
}

export interface WikiScan {
  /** 全部 page-NNN.md 的绝对路径（已配对同名 .sources）。 */
  readonly pages: string[];
  readonly violations: readonly string[];
}

/**
 * wiki root 的严格 containment 扫描：只接受 part-NNN/page-NNN.md 与同名 page-NNN.sources。
 * 拒绝：根级/多余的 .md、符号链接、嵌套目录、未配对的 .sources、任何其他条目。
 */
export function scanWikiRoot(root: string): WikiScan {
  const violations: string[] = [];
  const pages: string[] = [];
  const rootStats = lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    return { pages, violations: [`wiki root is not a plain directory: ${root}`] };
  }
  for (const part of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const partPath = join(root, part.name);
    if (part.isSymbolicLink()) {
      violations.push(`symlink entry in wiki root: ${partPath}`);
      continue;
    }
    if (part.isFile()) {
      violations.push(`unexpected file in wiki root (only part-NNN dirs allowed): ${partPath}`);
      continue;
    }
    if (!part.isDirectory() || !PART_DIR_RE.test(part.name)) {
      violations.push(`unexpected entry in wiki root: ${partPath}`);
      continue;
    }
    const mdStems = new Set<string>();
    const sourceStems = new Set<string>();
    for (const entry of readdirSync(partPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const entryPath = join(partPath, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push(`symlink wiki entry: ${entryPath}`);
        continue;
      }
      if (!entry.isFile()) {
        violations.push(`unexpected non-file wiki entry: ${entryPath}`);
        continue;
      }
      if (!PAGE_ENTRY_RE.test(entry.name)) {
        violations.push(`undeclared wiki file (only page-NNN.md/.sources allowed): ${entryPath}`);
        continue;
      }
      if (entry.name.endsWith(".md")) {
        mdStems.add(entry.name.slice(0, -3));
        pages.push(entryPath);
      } else {
        sourceStems.add(entry.name.slice(0, -8));
      }
    }
    for (const stem of mdStems) {
      if (!sourceStems.has(stem)) violations.push(`missing paired .sources: ${join(partPath, `${stem}.md`)}`);
    }
    for (const stem of sourceStems) {
      if (!mdStems.has(stem)) violations.push(`orphan .sources without page: ${join(partPath, `${stem}.sources`)}`);
    }
  }
  if (pages.length === 0) violations.push(`wiki root has no pages: ${root}`);
  return { pages: pages.sort(), violations };
}

function readIdList(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
}

function loadTemplates(path: string): { canonicalScopes: Set<string>; templates: unknown[] } {
  const raw = readJson(path) as unknown;
  if (!Array.isArray(raw)) fail(`scope templates must be an array: ${path}`);
  const scopes = new Set<string>();
  for (const item of raw) {
    const scopeKey = (item as { scopeKey?: unknown } | null)?.scopeKey;
    if (typeof scopeKey !== "string" || scopeKey.length === 0) fail(`scope template entry has no scopeKey: ${path}`);
    scopes.add(scopeKey);
  }
  return { canonicalScopes: scopes, templates: raw };
}

function loadSourceManifest(path: string): Map<string, SourceManifestEntry> {
  const manifest = new Map<string, SourceManifestEntry>();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    const value = JSON.parse(line) as Partial<SourceManifestEntry>;
    if (typeof value.id !== "string" || typeof value.path !== "string" || typeof value.sha256 !== "string") {
      fail(`source manifest line is invalid: ${path}`);
    }
    manifest.set(value.id, {
      id: value.id,
      path: value.path,
      sourceRoot: value.sourceRoot ?? "",
      scopeKey: value.scopeKey ?? "",
      bytes: value.bytes ?? 0,
      sha256: value.sha256,
      batchFile: value.batchFile ?? "",
    });
  }
  return manifest;
}

interface GlobalConfig {
  readonly embedding: { readonly apiKey: string; readonly baseURL: string; readonly model: string };
  readonly postgres: Record<string, unknown>;
}

function loadGlobalConfig(configPath: string): GlobalConfig {
  const raw = readJson(configPath) as {
    embedding?: { apiKey?: unknown; baseURL?: unknown; model?: unknown };
    postgres?: Record<string, unknown>;
  };
  if (!raw.embedding || !raw.postgres) fail(`config is missing embedding or postgres: ${configPath}`);
  const model = typeof raw.embedding.model === "string" ? raw.embedding.model : "text-embedding-3-small";
  return {
    embedding: {
      apiKey: resolveEnv(raw.embedding.apiKey),
      baseURL: resolveEnv(raw.embedding.baseURL),
      model,
    },
    postgres: raw.postgres,
  };
}

function postgresPool(postgres: Record<string, unknown>): pg.Pool {
  return new pg.Pool({
    host: resolveEnv(postgres.host),
    port: Number(postgres.port),
    database: resolveEnv(postgres.database),
    user: resolveEnv(postgres.user),
    password: resolveEnv(postgres.password),
    ssl: postgres.ssl as boolean | object | undefined,
    max: 1,
  });
}

// 与 packages/core/src/db/providers/postgres-embedding-space-registry.ts 的
// READ_ACTIVE_EMBEDDING_SPACE_SQL 保持同一只读语义。
const ACTIVE_EMBEDDING_SPACE_SQL = `SELECT
  s.embedding_space_id, s.provider, s.model, s.dimensions, s.state
FROM mengshu_active_embedding_space a
JOIN mengshu_embedding_spaces s ON s.embedding_space_id = a.embedding_space_id
WHERE a.singleton_key = 'active'`;

interface EmbeddingSpaceRow {
  readonly embeddingSpaceId: string;
  readonly model: string | null;
  readonly dims: number | null;
  readonly state: string | null;
}

/**
 * 区分 registry 查询失败的两类场景：42P01（表不存在，旧库）允许降级为 null，
 * 维度出处转由 config 模型表提供；其余错误（连接中断、权限、超时等）必须上抛，
 * 不得把 registry/config 双源交叉验证静默降级为 config 单源。
 */
export function embeddingSpaceQueryFallback(error: unknown): "no-registry" | "rethrow" {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "42P01" ? "no-registry" : "rethrow";
}

async function queryActiveEmbeddingSpace(client: pg.PoolClient): Promise<EmbeddingSpaceRow | null> {
  try {
    const result = await client.query<{
      embedding_space_id: string;
      model: string | null;
      dimensions: number | null;
      state: string | null;
    }>(ACTIVE_EMBEDDING_SPACE_SQL);
    const row = result.rows[0];
    if (!row) return null;
    return {
      embeddingSpaceId: row.embedding_space_id,
      model: row.model,
      dims: typeof row.dimensions === "number" ? row.dimensions : null,
      state: row.state,
    };
  } catch (error) {
    // 仅 registry 表不存在（42P01，旧库）降级为 null；其余错误上抛（见 embeddingSpaceQueryFallback）。
    if (embeddingSpaceQueryFallback(error) === "no-registry") return null;
    throw error;
  }
}

/** 在 ~/.grok 下尽力定位旧运行 wf_* 的 state/journal 证据；找不到如实记 not-found。 */
export function searchOldRunEvidence(homeDir: string, wfId: string): {
  wfId: string;
  status: "found" | "not-found";
  searchedRoots: string[];
  evidencePaths: string[];
} {
  const grok = join(homeDir, ".grok");
  const relativeRoots = ["sessions", "workflows", "logs", "long-running-background-tasks", "worktrees", "memory", "memory-v2", "grove"];
  const jsonFiles = ["campaigns_state.json", "active_sessions.json"];
  const searchedRoots: string[] = [];
  const evidencePaths: string[] = [];
  if (!existsSync(grok)) {
    return { wfId, status: "not-found", searchedRoots: [grok], evidencePaths };
  }
  const walkBounded = (dir: string, depth: number): void => {
    if (depth <= 0) return;
    let names: string[] = [];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      if (name.includes(wfId)) evidencePaths.push(path);
      try {
        if (lstatSync(path).isDirectory()) walkBounded(path, depth - 1);
      } catch {
        // 不可读条目跳过：best-effort 搜索。
      }
    }
  };
  for (const relativeRoot of relativeRoots) {
    const root = join(grok, relativeRoot);
    searchedRoots.push(root);
    if (existsSync(root)) walkBounded(root, 3);
  }
  for (const jsonFile of jsonFiles) {
    const path = join(grok, jsonFile);
    searchedRoots.push(path);
    if (!existsSync(path)) continue;
    try {
      if (lstatSync(path).size < 10 * 1024 * 1024 && readFileSync(path, "utf8").includes(wfId)) {
        evidencePaths.push(path);
      }
    } catch {
      // 读取失败按未命中处理。
    }
  }
  return {
    wfId,
    status: evidencePaths.length > 0 ? "found" : "not-found",
    searchedRoots,
    evidencePaths: [...new Set(evidencePaths)].sort(),
  };
}

function commonRoot(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  let current = dirname(paths[0]!);
  for (const path of paths.slice(1)) {
    while (!containsPath(path, current) && current !== dirname(current)) {
      current = dirname(current);
    }
  }
  return current;
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
  if (!isAbsolute(path)) fail(`${label} is not absolute: ${path}`);
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) fail(`${label} is a symlink: ${path}`);
  if (!stats.isDirectory()) fail(`${label} is not a directory: ${path}`);
}

/**
 * 严格 root containment：root 到 path 的每个中间目录必须 lstat 为真实目录。
 * 只 lstat 最终组件无法发现「声明根内部的符号链接目录」——源文件物理上可位于
 * 声明根之外却通过词法 containment，此处逐级拒绝。
 */
async function assertNoSymlinkAncestors(root: string, path: string): Promise<void> {
  if (!containsPath(path, root)) fail(`path is outside the declared root: ${path}`);
  const segments = path.slice(root.length + 1).split("/");
  let current = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index]!);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) fail(`symlink directory inside the declared root: ${current}`);
    if (!stats.isDirectory()) fail(`non-directory inside the declared root: ${current}`);
  }
}

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------

export interface FreezeSummary {
  readonly manifestFiles: number;
  readonly beforeIds: number;
  readonly uniqueBeforeIds: number;
  readonly batches: number;
}

interface BatchLineEntry {
  readonly id: string;
  readonly path: string;
  readonly scopeKey: string;
  readonly batchFile: string;
}

/**
 * freeze --base --run：
 * 1. 创建 run 根下 read、merged、by-scope、wiki/final、receipts、failures；
 * 2. 复制 manifest.json、before-ids.txt、scope-templates.json 并写 input-sha256.txt；
 * 3. 以 batches/*.txt 为唯一真源生成 source-manifest.jsonl（id/path/sourceRoot/scopeKey/bytes/sha256），
 *    只允许「旧 source/knowledge 树」与「<base>/delta」两个来源根，lstat 拒绝符号链接与越界路径；
 * 4. 写 receipts/inputs-diff.json 与 receipts/old-run-evidence.json。
 */
export async function runFreeze(
  baseDir: string,
  runDir: string,
  options: { homeDir?: string; concurrency?: number } = {},
): Promise<FreezeSummary> {
  const concurrency = options.concurrency ?? 16;
  for (const subdir of ["read", "merged", "by-scope", "wiki/final", "receipts", "failures"]) {
    await mkdir(join(runDir, subdir), { recursive: true });
  }
  const copiedHashes: Record<string, string> = {};
  const shaLines: string[] = [];
  for (const name of ["manifest.json", "before-ids.txt", "scope-templates.json"]) {
    await copyFile(join(baseDir, name), join(runDir, name));
    const digest = sha256Hex(await readFile(join(runDir, name)));
    copiedHashes[name] = digest;
    shaLines.push(`${digest}  ${name}`);
  }
  await atomicWrite(join(runDir, "input-sha256.txt"), `${shaLines.join("\n")}\n`);

  const manifestRaw = readJson(join(runDir, "manifest.json")) as Partial<FreezeManifestJson>;
  const manifestJson: FreezeManifestJson = {
    files: manifestRaw.files ?? fail("manifest.json is missing files"),
    batches: manifestRaw.batches ?? fail("manifest.json is missing batches"),
    fullBatchSize: manifestRaw.fullBatchSize ?? fail("manifest.json is missing fullBatchSize"),
    lastBatchSize: manifestRaw.lastBatchSize ?? fail("manifest.json is missing lastBatchSize"),
    scopes: manifestRaw.scopes ?? fail("manifest.json is missing scopes"),
  };
  for (const [key, value] of Object.entries(manifestJson)) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`manifest.json ${key} is not a positive integer`);
  }
  const { canonicalScopes } = loadTemplates(join(runDir, "scope-templates.json"));
  if (canonicalScopes.size !== manifestJson.scopes) {
    fail(`scope template count ${canonicalScopes.size} != manifest.json scopes ${manifestJson.scopes}`);
  }

  const manifestTxtPath = join(baseDir, "manifest.txt");
  const manifestTxt = existsSync(manifestTxtPath) ? parseManifestTxt(readFileSync(manifestTxtPath, "utf8")) : null;

  const batchesDir = join(baseDir, "batches");
  const batchNames = readdirSync(batchesDir).filter((name) => BATCH_FILE_RE.test(name)).sort();
  if (batchNames.length !== manifestJson.batches) {
    fail(`batch file count ${batchNames.length} != manifest.json batches ${manifestJson.batches}`);
  }

  const entries: BatchLineEntry[] = [];
  const violations: string[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  batchNames.forEach((name, position) => {
    const parsed = parseBatchFileName(name)!;
    const expectedSize = position === batchNames.length - 1 ? manifestJson.lastBatchSize : manifestJson.fullBatchSize;
    if (parsed.expected !== expectedSize) {
      violations.push(`${name}: declared batch size ${parsed.expected} != manifest expected ${expectedSize}`);
    }
    const lines = readFileSync(join(batchesDir, name), "utf8").split("\n").filter((line) => line.trim().length > 0);
    if (lines.length !== parsed.expected) {
      violations.push(`${name}: ${lines.length} lines != declared ${parsed.expected}`);
    }
    for (const line of lines) {
      const tab = line.indexOf("\t");
      if (tab <= 0) {
        violations.push(`${name}: line is not path<TAB>scope: ${line.slice(0, 80)}`);
        continue;
      }
      const rawPath = line.slice(0, tab);
      const scopeKey = line.slice(tab + 1).trim();
      if (!isAbsolute(rawPath)) {
        violations.push(`${name}: path is not absolute: ${rawPath}`);
        continue;
      }
      const path = normalize(rawPath);
      if (path.includes("..")) {
        violations.push(`${name}: path escapes via ..: ${rawPath}`);
        continue;
      }
      const id = basename(path, ".md");
      if (!UUID.test(id)) violations.push(`${name}: file id is not a uuid: ${id}`);
      if (seenIds.has(id)) violations.push(`duplicate id: ${id}`);
      if (seenPaths.has(path)) violations.push(`duplicate path: ${path}`);
      seenIds.add(id);
      seenPaths.add(path);
      if (!canonicalScopes.has(scopeKey)) violations.push(`unknown scope for ${id}: ${scopeKey}`);
      entries.push({ id, path, scopeKey, batchFile: name });
    }
  });

  // 两个来源根：旧 source/knowledge 树（manifest.txt 声明，或从实际路径推导）与 <base>/delta。
  const deltaRoot = resolve(baseDir, "delta");
  const candidateKnowledgePaths = entries.map((entry) => entry.path).filter((path) => !containsPath(path, deltaRoot));
  let knowledgeRoot: string | null = null;
  let knowledgeRootSource = "derived-common-prefix";
  if (manifestTxt?.source && isAbsolute(manifestTxt.source)) {
    knowledgeRoot = normalize(manifestTxt.source);
    knowledgeRootSource = "manifest.txt:source";
  } else if (candidateKnowledgePaths.length > 0) {
    knowledgeRoot = commonRoot(candidateKnowledgePaths);
  }
  if (!knowledgeRoot) fail("could not derive the knowledge source root from batches");
  await assertPlainDirectory(knowledgeRoot, "knowledge source root");
  await assertPlainDirectory(deltaRoot, "delta source root");
  for (const entry of entries) {
    const inKnowledge = containsPath(entry.path, knowledgeRoot!);
    const inDelta = containsPath(entry.path, deltaRoot);
    if (inKnowledge === inDelta) {
      violations.push(`path is outside both declared source roots: ${entry.path}`);
    }
  }
  if (entries.length !== manifestJson.files) {
    violations.push(`source file count ${entries.length} != manifest.json files ${manifestJson.files}`);
  }
  const distinctScopes = new Set(entries.map((entry) => entry.scopeKey));
  if (distinctScopes.size !== manifestJson.scopes) {
    violations.push(`distinct batch scopes ${distinctScopes.size} != manifest.json scopes ${manifestJson.scopes}`);
  }

  const beforeIds = readIdList(join(runDir, "before-ids.txt"));
  const uniqueBeforeIds = new Set(beforeIds);
  if (beforeIds.length !== manifestJson.files) {
    violations.push(`before-ids count ${beforeIds.length} != manifest.json files ${manifestJson.files}`);
  }
  if (uniqueBeforeIds.size !== beforeIds.length) {
    violations.push(`before-ids has ${beforeIds.length - uniqueBeforeIds.size} duplicate entries`);
  }
  const idSetMismatch = [...uniqueBeforeIds].filter((id) => !seenIds.has(id));
  const manifestOnly = [...seenIds].filter((id) => !uniqueBeforeIds.has(id));
  if (idSetMismatch.length > 0 || manifestOnly.length > 0) {
    violations.push(
      `before-ids and batch ids differ: beforeOnly=${idSetMismatch.length} batchOnly=${manifestOnly.length}` +
        ` samples=${idSetMismatch.slice(0, 3).join(",")}/${manifestOnly.slice(0, 3).join(",")}`,
    );
  }
  if (violations.length > 0) {
    fail(`freeze input violations (${violations.length}): ${violations.slice(0, 10).join(" | ")}`);
  }

  const hashed = await mapPool(entries, concurrency, async (entry) => {
    // 逐级 lstat：声明根内部的符号链接目录（源文件物理位于根外）在此拒绝。
    const declaredRoot = containsPath(entry.path, deltaRoot) ? deltaRoot : knowledgeRoot!;
    await assertNoSymlinkAncestors(declaredRoot, entry.path);
    const stats = await lstat(entry.path);
    if (stats.isSymbolicLink()) fail(`source is a symlink: ${entry.path}`);
    if (!stats.isFile()) fail(`source is not a regular file: ${entry.path}`);
    const digest = await sha256File(entry.path);
    return { ...entry, bytes: stats.size, sha256: digest };
  });

  const manifestLines = hashed
    .map((entry) => JSON.stringify({
      id: entry.id,
      path: entry.path,
      sourceRoot: containsPath(entry.path, deltaRoot) ? deltaRoot : knowledgeRoot!,
      scopeKey: entry.scopeKey,
      bytes: entry.bytes,
      sha256: entry.sha256,
      batchFile: entry.batchFile,
    }))
    .join("\n");
  await atomicWrite(join(runDir, "source-manifest.jsonl"), `${manifestLines}\n`);

  const inputsDiff = buildInputsDiff(manifestTxt, manifestJson);
  await atomicWriteJson(join(runDir, "receipts", "inputs-diff.json"), {
    ...inputsDiff,
    manifestTxtPath,
    manifestJsonPath: join(runDir, "manifest.json"),
    inputSha256: copiedHashes,
    sourceRoots: { knowledgeRoot, knowledgeRootSource, deltaRoot },
  });
  await atomicWriteJson(
    join(runDir, "receipts", "old-run-evidence.json"),
    searchOldRunEvidence(options.homeDir ?? homedir(), OLD_RUN_WF_ID),
  );

  return {
    manifestFiles: hashed.length,
    beforeIds: beforeIds.length,
    uniqueBeforeIds: uniqueBeforeIds.size,
    batches: batchNames.length,
  };
}

// ---------------------------------------------------------------------------
// baseline
// ---------------------------------------------------------------------------

export interface BaselineSummary {
  readonly knowledgeCount: number;
  readonly beforeIdHits: number;
  readonly memoriesCount: number;
  readonly embeddingModel: string;
  readonly embeddingDims: number;
  readonly embeddingDimsSource: string;
}

/** baseline 回执只允许白名单字段：计数、模型名、维度、维度出处、路径。 */
export function buildBaselineReceipt(summary: BaselineSummary, paths: {
  configPath: string;
  beforeIdsPath: string;
  templatesPath: string;
  beforeIds: number;
  scopeTemplates: number;
  activeEmbeddingSpace: { embeddingSpaceId: string; state: string | null } | null;
}): Record<string, unknown> {
  return {
    generatedAt: new Date().toISOString(),
    configPath: paths.configPath,
    beforeIdsPath: paths.beforeIdsPath,
    templatesPath: paths.templatesPath,
    beforeIds: paths.beforeIds,
    scopeTemplates: paths.scopeTemplates,
    knowledgeCount: summary.knowledgeCount,
    beforeIdHits: summary.beforeIdHits,
    memoriesCount: summary.memoriesCount,
    embeddingModel: summary.embeddingModel,
    embeddingDims: summary.embeddingDims,
    embeddingDimsSource: summary.embeddingDimsSource,
    activeEmbeddingSpace: paths.activeEmbeddingSpace,
  };
}

async function countRows(client: pg.PoolClient, sql: string, params?: unknown[]): Promise<number> {
  const result = await client.query<{ n: number }>(sql, params);
  const value = result.rows[0]?.n;
  if (typeof value !== "number") fail(`count query returned no row: ${sql.slice(0, 60)}`);
  return value;
}

export async function runBaseline(
  runDir: string,
  configPath: string,
  beforeIdsPath: string,
  templatesPath: string,
): Promise<BaselineSummary> {
  const config = loadGlobalConfig(configPath);
  const beforeIds = readIdList(beforeIdsPath);
  const { canonicalScopes } = loadTemplates(templatesPath);
  const pool = postgresPool(config.postgres);
  const client = await pool.connect();
  let registry: EmbeddingSpaceRow | null = null;
  let knowledgeCount = 0;
  let beforeIdHits = 0;
  let memoriesCount = 0;
  try {
    knowledgeCount = await countRows(client, "SELECT count(*)::int AS n FROM knowledge");
    memoriesCount = await countRows(client, "SELECT count(*)::int AS n FROM memories");
    beforeIdHits = await countRows(client, "SELECT count(*)::int AS n FROM knowledge WHERE id = ANY($1::uuid[])", [beforeIds]);
    registry = await queryActiveEmbeddingSpace(client);
  } finally {
    client.release();
    await pool.end();
  }
  if (registry?.model && registry.model !== config.embedding.model) {
    fail(`embedding model conflict: config=${config.embedding.model} registry=${registry.model}`);
  }
  const dims = resolveEmbeddingDims({ registry, configModel: config.embedding.model });
  const summary: BaselineSummary = {
    knowledgeCount,
    beforeIdHits,
    memoriesCount,
    embeddingModel: config.embedding.model,
    embeddingDims: dims.dims,
    embeddingDimsSource: dims.source,
  };
  const receipt = buildBaselineReceipt(summary, {
    configPath,
    beforeIdsPath,
    templatesPath,
    beforeIds: beforeIds.length,
    scopeTemplates: canonicalScopes.size,
    activeEmbeddingSpace: registry ? { embeddingSpaceId: registry.embeddingSpaceId, state: registry.state } : null,
  });
  await atomicWriteJson(join(runDir, "receipts", "db-before.json"), receipt);
  return summary;
}

// ---------------------------------------------------------------------------
// audit
// ---------------------------------------------------------------------------

export interface AuditSummary {
  readonly files: number;
  readonly claims: number;
  readonly valid: number;
  readonly invalid: number;
  readonly missingIds: number;
  readonly retryBatches: number;
}

interface ClaimTask {
  readonly file: string;
  readonly fileName: string;
  readonly line: number;
  readonly raw: string;
  readonly batchFile: string | null;
}

interface ClaimOutcome {
  readonly ok: boolean;
  readonly reason?: string | null;
  readonly detail?: string;
  readonly id?: string;
  readonly record?: ReusedAnalysisRecord;
}

/**
 * audit --analysis --manifest --before-ids --templates --out：
 * 逐行流式解析旧 analysis；一行坏 JSON 只登记该行（file:line+原因），不丢整批。
 * 纯校验见 auditRecordReason；文件系统校验（符号链接、源 hash、excerpt 回读）在此补充。
 */
export async function runAudit(
  analysisDir: string,
  manifestPath: string,
  beforeIdsPath: string,
  templatesPath: string,
  outDir: string,
  options: { concurrency?: number } = {},
): Promise<AuditSummary> {
  const concurrency = options.concurrency ?? 16;
  const manifest = loadSourceManifest(manifestPath);
  const beforeIds = new Set(readIdList(beforeIdsPath));
  const { canonicalScopes } = loadTemplates(templatesPath);

  const files = collectJsonlFiles(analysisDir);
  const tasks: ClaimTask[] = [];
  for (const file of files) {
    const fileName = basename(file);
    const batchBase = fileName.endsWith(".jsonl") ? fileName.slice(0, -6) : fileName;
    const batchFile = parseBatchFileName(batchBase) ? batchBase : null;
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    let line = 0;
    for await (const raw of reader) {
      line += 1;
      if (raw.trim().length === 0) continue;
      tasks.push({ file, fileName, line, raw, batchFile });
    }
  }

  const outcomes = await mapPool(tasks, concurrency, async (task): Promise<ClaimOutcome> => {
    let value: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(task.raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return { ok: false, reason: "malformed-json", detail: "line is not a JSON object" };
      }
      value = parsed as Record<string, unknown>;
    } catch (error) {
      // batch-0336-n60.txt.jsonl:55 的拼接 JSON 走这里：只登记该行。
      return {
        ok: false,
        reason: "malformed-json",
        detail: error instanceof Error ? error.message.slice(0, 160) : "JSON.parse failed",
      };
    }
    // 非 batch 命名文件（merged.jsonl / reused.jsonl）信任记录自带的 batchFile 字段，
    // 但它仍必须与冻结 manifest 的 batchFile 完全一致（auditRecordReason 的 batch-mismatch），
    // 使增强 audit 可以直接跑在合并产物上（计划批次 4 的 verify 门禁）。
    let effectiveBatch = task.batchFile;
    if (effectiveBatch === null && typeof value.batchFile === "string" && parseBatchFileName(value.batchFile)) {
      effectiveBatch = value.batchFile;
    }
    const ctx: AuditRuleContext = { canonicalScopes, beforeIds, manifest, analysisBatchFile: effectiveBatch };
    const reason = auditRecordReason(value, ctx);
    if (reason) return { ok: false, reason, id: typeof value.id === "string" ? value.id : undefined };
    const entry = manifest.get(value.id as string)!;
    try {
      // 逐级 lstat：声明根内部的符号链接目录在此拒绝（词法 containment 无法发现）。
      if (entry.sourceRoot && containsPath(entry.path, entry.sourceRoot)) {
        await assertNoSymlinkAncestors(entry.sourceRoot, entry.path);
      }
      const stats = await lstat(entry.path);
      if (stats.isSymbolicLink()) return { ok: false, reason: "source-symlink", id: entry.id };
      if (!stats.isFile()) return { ok: false, reason: "source-not-regular", id: entry.id };
      const bytes = await readFile(entry.path);
      const digest = sha256Hex(bytes);
      if (digest !== entry.sha256) return { ok: false, reason: "source-hash-drift", id: entry.id };
      // 正文语义：frontmatter 与 preview marker 之外的内容；摘录必须是正文原文子串。
      const body = extractWorksetBody(bytes.toString("utf8"));
      if (!excerptMatches(body, value.excerpt as string)) {
        return { ok: false, reason: "excerpt-miss", id: entry.id };
      }
    } catch (error) {
      return {
        ok: false,
        reason: "source-read-failed",
        id: entry.id,
        detail: error instanceof Error ? error.message.slice(0, 120) : "read failed",
      };
    }
    const reused: ReusedAnalysisRecord = {
      ...value,
      id: entry.id,
      scopeKey: entry.scopeKey,
      path: entry.path,
      excerpt: value.excerpt as string,
      sourceSha256: entry.sha256,
      batchFile: entry.batchFile,
    };
    return { ok: true, record: reused, id: entry.id };
  });

  // 顺序 fold：首个有效记录保留，后续同 id 一律判 duplicate-id 进 retry。
  const reusedRecords: ReusedAnalysisRecord[] = [];
  const retryRecords: Array<Record<string, unknown>> = [];
  const reasonCounts = new Map<string, number>();
  const validIds = new Set<string>();
  const batchValid = new Map<string, number>();
  const malformedLines: Array<{ file: string; line: number }> = [];
  const analysisScopes = new Set<string>();
  const nonCanonicalScopes = new Set<string>();
  let excerptMisses = 0;
  let unknownScopeRecords = 0;
  let invalid = 0;
  const bump = (reason: string): void => {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  };
  tasks.forEach((task, index) => {
    const outcome = outcomes[index]!;
    if (!outcome.ok) {
      invalid += 1;
      bump(outcome.reason ?? "unknown");
      retryRecords.push({
        file: task.file,
        line: task.line,
        id: outcome.id,
        reason: outcome.reason,
        ...(outcome.detail ? { detail: outcome.detail } : {}),
      });
      if (outcome.reason === "malformed-json") malformedLines.push({ file: task.file, line: task.line });
      if (outcome.reason === "excerpt-miss") excerptMisses += 1;
      if (outcome.reason === "unknown-scope") {
        unknownScopeRecords += 1;
        const scope = JSON.parse(task.raw) as { scopeKey?: unknown };
        if (typeof scope.scopeKey === "string") nonCanonicalScopes.add(scope.scopeKey);
      }
      return;
    }
    const record = outcome.record!;
    if (validIds.has(record.id)) {
      invalid += 1;
      bump("duplicate-id");
      retryRecords.push({ file: task.file, line: task.line, id: record.id, reason: "duplicate-id" });
      return;
    }
    validIds.add(record.id);
    batchValid.set(record.batchFile, (batchValid.get(record.batchFile) ?? 0) + 1);
    reusedRecords.push(record);
  });
  // distinct analysis scopes 需要包含未过校验的行（22 vs 21 的观察口径）。
  for (const task of tasks) {
    const tab = task.raw.indexOf('"scopeKey"');
    if (tab < 0) continue;
    const match = /"scopeKey"\s*:\s*"([^"]*)"/.exec(task.raw);
    if (match?.[1]) analysisScopes.add(match[1]);
  }

  const expectedBatches = [...new Set([...manifest.values()].map((entry) => entry.batchFile))].sort();
  const retryBatchLines: string[] = [];
  let retryBatches = 0;
  for (const batchFile of expectedBatches) {
    const expected = parseBatchFileName(batchFile)?.expected ?? 0;
    const valid = batchValid.get(batchFile) ?? 0;
    if (valid < expected) {
      retryBatches += 1;
      retryBatchLines.push(`${batchFile}\tvalid=${valid}\texpected=${expected}`);
    }
  }

  const knownIssues = evaluateKnownIssues({
    malformedLines,
    batchValid,
    expectedBatches,
    excerptMisses,
    unknownScopeRecords,
    nonCanonicalScopes: [...nonCanonicalScopes],
    distinctAnalysisScopes: analysisScopes.size,
    templateScopeCount: canonicalScopes.size,
  });

  await atomicWrite(
    join(outDir, "read", "reused.jsonl"),
    reusedRecords.length > 0 ? `${reusedRecords.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
  );
  await atomicWrite(
    join(outDir, "failures", "retry-records.jsonl"),
    retryRecords.length > 0 ? `${retryRecords.map((record) => JSON.stringify(record)).join("\n")}\n` : "",
  );
  await atomicWrite(
    join(outDir, "failures", "retry-batches.txt"),
    retryBatchLines.length > 0 ? `${retryBatchLines.join("\n")}\n` : "",
  );
  await atomicWriteJson(join(outDir, "read", "audit-summary.json"), {
    generatedAt: new Date().toISOString(),
    analysisDir,
    manifestPath,
    files: files.length,
    claims: tasks.length,
    valid: reusedRecords.length,
    invalid,
    missingIds: beforeIds.size - validIds.size,
    retryBatches,
    reasons: Object.fromEntries([...reasonCounts.entries()].sort()),
    knownIssues,
  });

  return {
    files: files.length,
    claims: tasks.length,
    valid: reusedRecords.length,
    invalid,
    missingIds: beforeIds.size - validIds.size,
    retryBatches,
  };
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

export interface MergeSummary {
  readonly records: number;
  readonly inputs: number;
  readonly mergedManifestHash: string;
}

/** merge --inputs（可重复）--manifest --before-ids --out：拒绝重复/未知/跨 scope/hash 漂移/坏枚举/摘录无法回读。 */
export async function runMerge(
  inputPaths: readonly string[],
  manifestPath: string,
  beforeIdsPath: string,
  outDir: string,
  options: { concurrency?: number } = {},
): Promise<MergeSummary> {
  const concurrency = options.concurrency ?? 16;
  const manifest = loadSourceManifest(manifestPath);
  const beforeIds = new Set(readIdList(beforeIdsPath));
  const expanded: string[] = [];
  for (const input of inputPaths) {
    const stats = await lstat(input).catch(() => fail(`merge input does not exist: ${input}`));
    if (stats.isFile()) expanded.push(input);
    else if (stats.isDirectory()) expanded.push(...collectJsonlFiles(input));
    else fail(`merge input is neither file nor directory: ${input}`);
  }
  if (expanded.length === 0) fail("merge has no input jsonl files");

  const errors: string[] = [];
  const seen = new Set<string>();
  const collected: ReusedAnalysisRecord[] = [];
  const inputStats: Array<{ path: string; records: number; sha256: string }> = [];
  for (const file of expanded.sort()) {
    const content = await readFile(file, "utf8");
    let count = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
        value = parsed as Record<string, unknown>;
      } catch {
        errors.push(`${file}: malformed jsonl line`);
        continue;
      }
      const id = value.id;
      if (typeof id !== "string" || !UUID.test(id)) {
        errors.push(`${file}: record id is invalid`);
        continue;
      }
      if (!beforeIds.has(id) || !manifest.has(id)) {
        errors.push(`${file}: unknown id ${id}`);
        continue;
      }
      if (seen.has(id)) {
        errors.push(`${file}: duplicate id ${id}`);
        continue;
      }
      const error = mergeRecordError(value, manifest.get(id)!);
      if (error) {
        errors.push(`${file}: ${error} for ${id}`);
        continue;
      }
      seen.add(id);
      count += 1;
      collected.push(value as ReusedAnalysisRecord);
    }
    inputStats.push({ path: file, records: count, sha256: sha256Hex(content) });
  }
  // 来源重读复核：当前文件内容 hash 必须仍等于冻结值（merge 只信 manifest 的声明 hash
  // 不够——audit 之后、merge 之前文件可能被改动），且 excerpt 必须能在正文中回读。
  const recheck = await mapPool(collected, concurrency, async (record) => {
    const entry = manifest.get(record.id)!;
    try {
      if (entry.sourceRoot && containsPath(entry.path, entry.sourceRoot)) {
        await assertNoSymlinkAncestors(entry.sourceRoot, entry.path);
      }
      const stats = await lstat(entry.path);
      if (stats.isSymbolicLink() || !stats.isFile()) return `${record.id}: source-not-regular`;
      const bytes = await readFile(entry.path);
      if (sha256Hex(bytes) !== entry.sha256) return `${record.id}: source-hash-drift`;
      const body = extractWorksetBody(bytes.toString("utf8"));
      if (typeof record.excerpt !== "string" || !excerptMatches(body, record.excerpt)) {
        return `${record.id}: excerpt-miss`;
      }
      return null;
    } catch (error) {
      return `${record.id}: source-read-failed (${error instanceof Error ? error.message.slice(0, 120) : "error"})`;
    }
  });
  for (const problem of recheck) {
    if (problem !== null) errors.push(`manifest recheck: ${problem}`);
  }
  if (errors.length > 0) {
    fail(`merge rejected ${errors.length} record(s): ${errors.slice(0, 10).join(" | ")}`);
  }
  collected.sort((left, right) => left.id.localeCompare(right.id));
  const mergedContent = collected.length > 0
    ? `${collected.map((record) => JSON.stringify(record)).join("\n")}\n`
    : "";
  const mergedManifestHash = sha256Hex(mergedContent);
  await atomicWrite(join(outDir, "merged", "analysis", "merged.jsonl"), mergedContent);
  await atomicWriteJson(join(outDir, "merged", "manifest.json"), {
    generatedAt: new Date().toISOString(),
    records: collected.length,
    manifestPath,
    inputs: inputStats,
    mergedManifestHash,
  });
  return { records: collected.length, inputs: expanded.length, mergedManifestHash };
}

// ---------------------------------------------------------------------------
// preflight
// ---------------------------------------------------------------------------

export interface PreflightSummary {
  readonly status: "ready" | "blocked";
  readonly pages: number;
  readonly sources: number;
  readonly violations: number;
  readonly conflicts: number;
  readonly missing: number;
  readonly duplicate: number;
  readonly embeddingModel: string;
  readonly embeddingDims: number;
  readonly embeddingDimsSource: string;
}

/**
 * preflight --wiki --analysis --config --templates --before-ids（可选 --manifest 补 batch 链、
 * --out 写回执、--offline 跳过数据库只读核对）。绝不写数据库。
 */
export async function runPreflight(input: {
  wikiRoot: string;
  analysisDir: string;
  configPath: string;
  templatesPath: string;
  beforeIdsPath: string;
  manifestPath?: string;
  outPath?: string;
  offline?: boolean;
}): Promise<PreflightSummary> {
  const config = loadGlobalConfig(input.configPath);
  const { canonicalScopes, templates } = loadTemplates(input.templatesPath);
  const beforeIds = readIdList(input.beforeIdsPath);

  const scan = scanWikiRoot(input.wikiRoot);
  const violations = [...scan.violations];
  const pages: WikiPage[] = [];
  for (const file of scan.pages) {
    try {
      pages.push(parseWikiPage(file, await readFile(file, "utf8")));
    } catch (error) {
      violations.push(error instanceof Error ? error.message : `page parse failed: ${file}`);
    }
  }

  // analysis 索引（merged 目录应为每 id 恰好一行）。
  const analysisById = new Map<string, AnalysisRecord>();
  for (const file of collectJsonlFiles(input.analysisDir)) {
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      try {
        const record = parseAnalysisLine(line);
        if (analysisById.has(record.id)) violations.push(`duplicate analysis id ${record.id} in ${file}`);
        else analysisById.set(record.id, record);
      } catch (error) {
        violations.push(error instanceof Error ? error.message : `analysis line invalid: ${file}`);
      }
    }
  }
  const manifestById = input.manifestPath ? loadSourceManifest(input.manifestPath) : null;

  // page → source → analysis → batch 的 scope 链 + 每个 source id 只出现在其原始 scope。
  const idScope = new Map<string, string>();
  const claims: AnalysisRecord[] = [];
  for (const page of pages) {
    if (!canonicalScopes.has(page.scopeKey)) violations.push(`page scope is not canonical: ${page.path} ${page.scopeKey}`);
    for (const id of page.sourceIds) {
      claims.push({ id, scopeKey: page.scopeKey, excerpt: "preflight", path: page.path });
      const previous = idScope.get(id);
      if (previous === undefined) idScope.set(id, page.scopeKey);
      else if (previous !== page.scopeKey) violations.push(`source id ${id} appears across scopes: ${previous} vs ${page.scopeKey}`);
      const record = analysisById.get(id);
      if (!record) {
        violations.push(`source id ${id} has no merged analysis record (page ${page.path})`);
        continue;
      }
      if (record.scopeKey !== page.scopeKey) {
        violations.push(`scope chain broken at analysis for ${id}: page=${page.scopeKey} analysis=${record.scopeKey}`);
      }
      const manifestEntry = manifestById?.get(id);
      if (manifestById && !manifestEntry) violations.push(`source id ${id} missing from frozen manifest`);
      if (manifestEntry && manifestEntry.scopeKey !== page.scopeKey) {
        violations.push(`scope chain broken at batch for ${id}: page=${page.scopeKey} batch=${manifestEntry.scopeKey}`);
      }
    }
  }
  const coverage = coverageReport(beforeIds, claims);

  // 跨 scope 同文 content_hash 冲突。
  const conflicts = detectContentHashConflicts(
    pages.map((page) => ({ textHash: sha256Hex(page.text), scopeKey: page.scopeKey, page: basename(page.path) })),
  );

  // embedding space/model/维度：与全局配置一致；模板 embeddingSpaceId 必须合法。
  const templateSpaceIds = new Set<string>();
  for (const item of templates as Array<{ embeddingSpaceId?: unknown }>) {
    const spaceId = item.embeddingSpaceId;
    if (typeof spaceId !== "string" || !SPACE_ID.test(spaceId)) {
      violations.push("scope template has invalid embeddingSpaceId");
      continue;
    }
    templateSpaceIds.add(spaceId);
  }
  let registry: EmbeddingSpaceRow | null = null;
  if (!input.offline) {
    const pool = postgresPool(config.postgres);
    const client = await pool.connect();
    try {
      registry = await queryActiveEmbeddingSpace(client);
      const knowledgeCount = await countRows(client, "SELECT count(*)::int AS n FROM knowledge");
      const beforeIdHits = await countRows(client, "SELECT count(*)::int AS n FROM knowledge WHERE id = ANY($1::uuid[])", [beforeIds]);
      const memoriesCount = await countRows(client, "SELECT count(*)::int AS n FROM memories");
      if (knowledgeCount !== beforeIds.length) {
        violations.push(`knowledge count drifted: db=${knowledgeCount} beforeIds=${beforeIds.length}`);
      }
      if (beforeIdHits !== beforeIds.length) {
        violations.push(`before-ids coverage in db drifted: hits=${beforeIdHits} expected=${beforeIds.length}`);
      }
      if (registry && !templateSpaceIds.has(registry.embeddingSpaceId)) {
        violations.push("active embedding space is not declared by any scope template");
      }
      if (input.outPath) {
        const dbBeforePath = join(dirname(input.outPath), "db-before.json");
        if (existsSync(dbBeforePath)) {
          const before = readJson(dbBeforePath) as { memoriesCount?: unknown; knowledgeCount?: unknown };
          if (before.memoriesCount !== memoriesCount) violations.push("memories count drifted since db-before.json");
          if (before.knowledgeCount !== knowledgeCount) violations.push("knowledge count drifted since db-before.json");
        }
      }
    } finally {
      client.release();
      await pool.end();
    }
  }
  const dims = resolveEmbeddingDims({ registry, configModel: config.embedding.model });

  const blocked = violations.length > 0 || coverage.missing.length > 0 || coverage.duplicate.length > 0 || conflicts.length > 0;
  const summary: PreflightSummary = {
    status: blocked ? "blocked" : "ready",
    pages: pages.length,
    sources: claims.length,
    violations: violations.length,
    conflicts: conflicts.length,
    missing: coverage.missing.length,
    duplicate: coverage.duplicate.length,
    embeddingModel: config.embedding.model,
    embeddingDims: dims.dims,
    embeddingDimsSource: input.offline && !registry ? `${dims.source} (offline: db registry not probed)` : dims.source,
  };
  const receipt = {
    generatedAt: new Date().toISOString(),
    ...summary,
    offline: input.offline === true,
    violationDetails: violations.slice(0, 100),
    conflictDetails: conflicts,
    coverageMissingSamples: coverage.missing.slice(0, 20),
    coverageDuplicateSamples: coverage.duplicate.slice(0, 20),
    templateSpaceIds: [...templateSpaceIds].sort(),
    activeEmbeddingSpace: registry ? { embeddingSpaceId: registry.embeddingSpaceId, state: registry.state } : null,
  };
  if (input.outPath) await atomicWriteJson(input.outPath, receipt);
  return summary;
}

// ---------------------------------------------------------------------------
// wiki 页面解析（最终页面：tree_type 只允许 source/topic/global）
// ---------------------------------------------------------------------------

function frontmatterBlock(markdown: string): string {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) fail("wiki page is missing frontmatter");
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) fail("wiki page frontmatter is not closed");
  return text.slice(4, end);
}

function header(markdown: string, key: string): string {
  const match = frontmatterBlock(markdown).match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match?.[1]) fail(`wiki page is missing ${key}`);
  return match[1].trim().replace(/^["']|["']$/g, "");
}

export function parseWikiPage(path: string, markdown: string): WikiPage {
  const text = extractWorksetBody(markdown);
  const scopeKey = header(markdown, "scope_key");
  const semanticType = header(markdown, "semantic_type");
  const memoryForm = header(markdown, "memory_form");
  // 最终页面 tree_type 只允许 source/topic/global；读取阶段的 "none" 在 audit 放行、此处拒绝。
  const treeType = header(markdown, "tree_type");
  const sourcesPath = path.replace(/\.md$/, ".sources");
  const sourceIds = readFileSync(sourcesPath, "utf8").split("\n").map((item) => item.trim()).filter(Boolean);
  if (sourceIds.some((id) => !UUID.test(id))) fail(`invalid source id in ${sourcesPath}`);
  if (!SEMANTIC_TYPES.has(semanticType)) fail(`wiki semantic type is invalid: ${path}`);
  if (!MEMORY_FORMS.has(memoryForm)) fail(`wiki memory form is invalid: ${path}`);
  if (!TREE_TYPES.has(treeType)) fail(`wiki tree type is invalid (final pages allow source/topic/global only): ${path}`);
  if (text.length < 20) fail(`wiki page is too short: ${path}`);
  return { path, scopeKey, text, semanticType, memoryForm, treeType, sourceIds };
}

// ---------------------------------------------------------------------------
// verify / regroup（保持既有命令行兼容）
// ---------------------------------------------------------------------------

async function verify(argv: readonly string[]): Promise<void> {
  const analysisDir = resolve(arg("--analysis"));
  const beforePath = resolve(arg("--before-ids"));
  // --manifest（冻结 source-manifest.jsonl）提供严格 containment：claim.path 必须与
  // 冻结路径逐 id 相等；不给 manifest 时仍强制绝对路径 + 拒绝 "." / ".." 段。
  const manifestArg = optionalArg("--manifest");
  const manifestById = manifestArg ? loadSourceManifest(resolve(manifestArg)) : null;
  const files: string[] = [];
  walk(analysisDir, ".jsonl", files);
  const claims: AnalysisRecord[] = [];
  let excerptMisses = 0;
  let pathViolations = 0;
  for (const file of files.sort()) {
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const claim = parseAnalysisLine(line);
      claims.push(claim);
      if (claimPathViolation(claim, manifestById) !== null) {
        pathViolations += 1;
        continue;
      }
      try {
        // 来源本身也拒绝符号链接（不跟随到声明根之外）。
        const stats = lstatSync(claim.path);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          pathViolations += 1;
          continue;
        }
        const body = extractWorksetBody(await readFile(claim.path, "utf8"));
        if (!excerptMatches(body, claim.excerpt)) excerptMisses += 1;
      } catch {
        pathViolations += 1;
      }
    }
  }
  const expected = (await readFile(beforePath, "utf8")).split("\n").map((item) => item.trim()).filter(Boolean);
  const report = coverageReport(expected, claims);
  const result = {
    files: files.length,
    claims: claims.length,
    expected: expected.length,
    missing: report.missing.length,
    duplicate: report.duplicate.length,
    excerptMisses,
    pathViolations,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (report.missing.length > 0 || report.duplicate.length > 0 || excerptMisses > 0 || pathViolations > 0) {
    process.exitCode = 1;
  }
}

async function regroup(): Promise<void> {
  const analysisDir = resolve(arg("--analysis"));
  const outDir = resolve(arg("--out"));
  await mkdir(outDir, { recursive: true });
  const files: string[] = [];
  walk(analysisDir, ".jsonl", files);
  const groups = new Map<string, string[]>();
  for (const file of files.sort()) {
    const lines = (await readFile(file, "utf8")).split("\n").filter((line) => line.trim().length > 0);
    for (const line of lines) {
      const claim = parseAnalysisLine(line);
      const bucket = groups.get(claim.scopeKey) ?? [];
      bucket.push(line);
      groups.set(claim.scopeKey, bucket);
    }
  }
  const parts: Array<{ file: string; scopeKey: string; lines: number }> = [];
  let index = 0;
  for (const [scopeKey, lines] of [...groups.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    for (let offset = 0; offset < lines.length; offset += 400) {
      const slice = lines.slice(offset, offset + 400);
      const name = `scope-${index.toString().padStart(3, "0")}.jsonl`;
      // 临时文件 + 原子 rename：中断不留下截断的分片或 parts.json（脚本头部合同）。
      await atomicWrite(join(outDir, name), `${slice.join("\n")}\n`);
      await atomicWrite(join(outDir, name.replace(/\.jsonl$/, ".scope")), `${scopeKey}\n`);
      parts.push({ file: join(outDir, name), scopeKey, lines: slice.length });
      index += 1;
    }
  }
  await atomicWrite(join(outDir, "parts.json"), `${JSON.stringify(parts)}\n`);
  process.stdout.write(`${JSON.stringify({ scopes: groups.size, parts: parts.length })}\n`);
}

// ---------------------------------------------------------------------------
// apply（已修复 Embeddings 配置类型与 provenance 合同）
// ---------------------------------------------------------------------------

async function apply(): Promise<void> {
  if (arg("--confirmation-token") !== TOKEN) fail("confirmation token was not accepted");
  const configPath = resolve(arg("--config"));
  const wikiRoot = resolve(arg("--wiki"));
  const templatesPath = resolve(arg("--templates"));
  const beforePath = resolve(arg("--before-ids"));
  const expectedCount = Number(arg("--expected-count"));
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) fail("expected count is invalid");
  // provenance 合同：必须提供 merged manifest 以写入 mergedManifestHash。
  const mergedManifestPath = optionalArg("--merged-manifest");
  if (!mergedManifestPath) fail("apply requires --merged-manifest (provenance contract: merged manifest hash)");

  const config = loadGlobalConfig(configPath);
  const templates = readJson(templatesPath) as ScopeTemplate[];
  const byScope = new Map(templates.map((item) => [item.scopeKey, item]));

  const scan = scanWikiRoot(wikiRoot);
  if (scan.violations.length > 0) {
    fail(`wiki root containment violations: ${scan.violations.slice(0, 5).join(" | ")}`);
  }
  const pages: WikiPage[] = [];
  for (const file of scan.pages) pages.push(parseWikiPage(file, await readFile(file, "utf8")));

  const expectedIds = readIdList(beforePath);
  const claims = pages.flatMap((page) => page.sourceIds.map((id) => ({
    id, scopeKey: page.scopeKey, excerpt: "verified-by-page", path: page.path,
  })));
  const report = coverageReport(expectedIds, claims);
  if (pages.length === 0 || report.missing.length > 0 || report.duplicate.length > 0) {
    fail(`wiki coverage is incomplete: pages=${pages.length} missing=${report.missing.length} duplicate=${report.duplicate.length}`);
  }
  // 计划批次 7：跨 scope 同文 content_hash 冲突禁止留给数据库事务试错——apply 内硬拦截，
  // 不依赖调用者先跑 preflight 的纪律（同 scope 同文走 dedupeWikiPages，不算冲突）。
  const conflicts = detectContentHashConflicts(
    pages.map((page) => ({ textHash: sha256Hex(page.text), scopeKey: page.scopeKey, page: basename(page.path) })),
  );
  if (conflicts.length > 0) {
    fail(`cross-scope content hash conflicts must be resolved before apply: ${conflicts.length} (scopes=${conflicts.slice(0, 3).map((item) => item.scopes.join("|")).join("; ")})`);
  }
  for (const page of pages) {
    const template = byScope.get(page.scopeKey);
    if (!template || !SPACE_ID.test(template.embeddingSpaceId)) fail(`missing scope template for ${page.scopeKey}`);
  }
  // 同 scope 同文页去重并合并 sourceIds：coverage 在全量页上已判重通过，
  // 去重后每个 source id 仍必须落在某一行 metadata.sourceIds 中（provenance 合同）。
  const uniquePages = dedupeWikiPages(pages);

  // 维度必须带出处：registry（只读）+ 全局配置模型表交叉验证，禁止硬编码。
  const pool = postgresPool(config.postgres);
  try {
    let registry: EmbeddingSpaceRow | null = null;
    const probe = await pool.connect();
    try {
      registry = await queryActiveEmbeddingSpace(probe);
    } finally {
      // registry 查询后立即归还连接；embedding 向量化走独立 HTTP 客户端。
      probe.release();
    }
    if (registry?.model && registry.model !== config.embedding.model) {
      fail(`embedding model conflict: config=${config.embedding.model} registry=${registry.model}`);
    }
    await applyWithPool(pool, {
      config,
      templates,
      pages: uniquePages,
      totalPages: pages.length,
      expectedIds,
      expectedCount,
      registry,
      mergedManifestPath,
    });
  } finally {
    await pool.end();
  }
}

interface ApplyPoolInput {
  readonly config: GlobalConfig;
  readonly templates: ScopeTemplate[];
  readonly pages: WikiPage[];
  readonly totalPages: number;
  readonly expectedIds: string[];
  readonly expectedCount: number;
  readonly registry: EmbeddingSpaceRow | null;
  readonly mergedManifestPath: string;
}

async function applyWithPool(pool: pg.Pool, input: ApplyPoolInput): Promise<void> {
  const { config, templates, pages, totalPages, expectedIds, expectedCount, registry, mergedManifestPath } = input;
  const byScope = new Map(templates.map((item) => [item.scopeKey, item]));
  const dims = resolveEmbeddingDims({ registry, configModel: config.embedding.model });

  // Embeddings 构造参数与 MemoryConfig["embedding"] 对齐：provider 必填 "openai"。
  const embedder = new Embeddings(
    {
      provider: "openai",
      apiKey: config.embedding.apiKey,
      baseURL: config.embedding.baseURL,
      model: config.embedding.model,
    },
    undefined,
    { concurrency: 3, maxBatchSize: 16 },
  );
  // 去重已在 apply() 完成（dedupeWikiPages 合并 sourceIds），此处直接向量化。
  const uniquePages = pages;
  const vectors = await embedder.embedBatch(uniquePages.map((page) => page.text));
  if (vectors.length !== uniquePages.length || vectors.some((vector) => vector.length !== dims.dims)) {
    fail(`embedding dimension mismatch: expected ${dims.dims} (source=${dims.source})`);
  }

  let mergedManifestHash: string;
  try {
    const mergedManifestRaw = await readFile(mergedManifestPath, "utf8");
    const parsed = JSON.parse(mergedManifestRaw) as { mergedManifestHash?: unknown };
    mergedManifestHash = typeof parsed.mergedManifestHash === "string"
      ? parsed.mergedManifestHash
      : sha256Hex(mergedManifestRaw);
  } catch (error) {
    fail(`merged manifest is unreadable: ${mergedManifestPath} (${error instanceof Error ? error.message : "error"})`);
  }

  const txClient = await pool.connect();
  try {
    await txClient.query("BEGIN");
    const current = await txClient.query<{ n: number }>("SELECT count(*)::int AS n FROM knowledge");
    if (current.rows[0]?.n !== expectedCount) fail("knowledge count changed before replacement");
    await txClient.query("DELETE FROM knowledge WHERE id = ANY($1::uuid[])", [expectedIds]);
    for (let index = 0; index < uniquePages.length; index += 1) {
      const page = uniquePages[index]!;
      const storedScope = page.scopeKey === "__unscoped__" ? null : page.scopeKey;
      const template = byScope.get(page.scopeKey);
      if (!template || !SPACE_ID.test(template.embeddingSpaceId)) fail(`missing scope template for ${page.scopeKey}`);
      const vector = `[${vectors[index]!.join(",")}]`;
      await txClient.query(
        `INSERT INTO knowledge (
          id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
          project_name, app_name, user_id, agent_id, workspace_id, tenant_id, canonical_project_id,
          product_id, producer_id, namespace, visibility, lifecycle_status, embedding_space_id,
          embedding_space_state, scope_key
        ) VALUES (
          $1, $2, $3, $4::vector, 0.5, $5, 'knowledge', $6::jsonb, now(),
          $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL, $18, $19, $20
        )`,
        [
          randomUUID(),
          page.text,
          createHash("sha256").update(page.text).digest("hex"),
          vector,
          page.semanticType,
          JSON.stringify({
            wikiGovernance: "2026-10-03",
            semanticType: page.semanticType,
            memoryForm: page.memoryForm,
            treeType: page.treeType,
            // provenance 合同：完整 source ID 集合 + merged manifest hash + scope + wiki path。
            sourceIds: [...page.sourceIds],
            sourceCount: page.sourceIds.length,
            mergedManifestHash,
            scopeKey: page.scopeKey,
            wikiPath: page.path,
          }),
          template.projectName,
          template.appName,
          template.userId,
          template.agentId,
          template.workspaceId,
          template.tenantId,
          template.canonicalProjectId,
          template.productId,
          template.producerId,
          template.namespace,
          template.visibility ?? "private",
          template.embeddingSpaceId,
          template.embeddingSpaceState ?? "known-queryable",
          storedScope,
        ],
      );
    }
    const after = await txClient.query<{ n: number }>("SELECT count(*)::int AS n FROM knowledge");
    if (after.rows[0]?.n !== uniquePages.length) fail("replacement count does not match wiki pages");
    await txClient.query("COMMIT");
    process.stdout.write(`${JSON.stringify({
      status: "applied",
      deleted: expectedIds.length,
      inserted: uniquePages.length,
      deduped: totalPages - uniquePages.length,
    })}\n`);
  } catch (error) {
    await txClient.query("ROLLBACK");
    throw error;
  } finally {
    txClient.release();
  }
}

interface ScopeTemplate {
  readonly scopeKey: string;
  readonly workspaceId: string | null;
  readonly namespace: string | null;
  readonly projectName: string | null;
  readonly appName: string | null;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly tenantId: string | null;
  readonly canonicalProjectId: string | null;
  readonly productId: string | null;
  readonly producerId: string | null;
  readonly visibility: string | null;
  readonly embeddingSpaceId: string;
  readonly embeddingSpaceState: string | null;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function freezeCli(): Promise<void> {
  const summary = await runFreeze(resolve(arg("--base")), resolve(arg("--run")));
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function baselineCli(): Promise<void> {
  const summary = await runBaseline(
    resolve(arg("--run")),
    resolve(arg("--config")),
    resolve(arg("--before-ids")),
    resolve(arg("--templates")),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function auditCli(): Promise<void> {
  const summary = await runAudit(
    resolve(arg("--analysis")),
    resolve(arg("--manifest")),
    resolve(arg("--before-ids")),
    resolve(arg("--templates")),
    resolve(arg("--out")),
  );
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function mergeCli(): Promise<void> {
  const summary = await runMerge(
    args("--inputs").map((value) => resolve(value)),
    resolve(arg("--manifest")),
    resolve(arg("--before-ids")),
    resolve(arg("--out")),
  );
  process.stdout.write(`${JSON.stringify({ records: summary.records, inputs: summary.inputs })}\n`);
}

async function preflightCli(): Promise<void> {
  const summary = await runPreflight({
    wikiRoot: resolve(arg("--wiki")),
    analysisDir: resolve(arg("--analysis")),
    configPath: resolve(arg("--config")),
    templatesPath: resolve(arg("--templates")),
    beforeIdsPath: resolve(arg("--before-ids")),
    manifestPath: optionalArg("--manifest") ? resolve(optionalArg("--manifest")!) : undefined,
    outPath: optionalArg("--out") ? resolve(optionalArg("--out")!) : undefined,
    offline: process.argv.includes("--offline"),
  });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "verify") await verify(process.argv);
  else if (command === "regroup") await regroup();
  else if (command === "apply") await apply();
  else if (command === "freeze") await freezeCli();
  else if (command === "baseline") await baselineCli();
  else if (command === "audit") await auditCli();
  else if (command === "merge") await mergeCli();
  else if (command === "preflight") await preflightCli();
  else fail("command must be verify, regroup, apply, freeze, baseline, audit, merge, or preflight");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "wiki knowledge replace failed"}\n`);
    process.exitCode = 1;
  });
}
