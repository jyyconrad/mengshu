/**
 * wiki-slim —— wiki 正式化计划批次 C「源件瘦身」operator 工具。
 *
 * 计划：work/tasks/2026-10-09-wiki-promotion/plan.md（批次 C、失败恢复）。
 * 背景实测：1.2GB 原件中 frontmatter 占 97%，主体是每文件一行
 * mengshu_envelope（base64url-json，约 24KB，含旧向量 + 旧原文 + 旧行元数据）；
 * 正文仅 34.3MB。瘦身 = 删信封、留正文、抽字段留证、全量对账。
 *
 * 子命令：
 *   extract --source <source根> --delta <delta根> --out <legacy-row-meta.jsonl> [--expect-files N]
 *     逐文件解析 frontmatter 的 mengshu_envelope，抽取 9 个留证字段写一行 JSON
 *     （id/createdAt/importance/category/contentHash/dataType/producerId/namespace/scopeKey）；
 *     无 envelope 的文件写 {id, envelope:'absent'}。stdout 末行 JSON：
 *     {files,extracted,noEnvelope}。--expect-files 提供时文件数不符即整体失败
 *     （真实树门禁值：49,509 = source/knowledge 47,963 + delta 1,546）。
 *
 *   slim --source <source根> --delta <delta根> --evidence <legacy-row-meta.jsonl>
 *     --manifest <slimming-manifest.jsonl> [--expect-files N]
 *     逐文件原子重写为最小 frontmatter（id、scope_key、mengshu_source_hash[旧值存在才写]、
 *     duplicate_of[已有则保留，保证与 dupes 可组合且可重复执行]）+ 原正文；
 *     正文提取语义唯一复用 operator-wiki-knowledge-replace.ts 的 extractWorksetBody
 *     （import，不重实现）。每个文件先写同目录临时文件 → 重读校验正文哈希一致 →
 *     原子 rename；任一文件校验失败立即停止重写（fail-stop，已写文件以 manifest 对账）。
 *     C1 顺序铁律（先归档留证 → 再重写）的工具层强制：--evidence 必须指向 extract
 *     产出的留证 JSONL，且其 id 集合与待重写文件逐 id 双向覆盖（行数 = id 数、无重复
 *     id），任一不满足则在重写任何文件之前整体失败——乱序（先 slim 后归档）会不可逆
 *     丢失 envelope 的 9 个留证字段。
 *     manifest 每文件一行 {id,path,oldBytes,newBytes,bodySha256}。stdout 末行 JSON：
 *     {files,rewritten,bodyMismatches,bytesBefore,bytesAfter}；bodyMismatches>0 时
 *     进程退出码非 0。
 *
 *   dupes --source <source根> --delta <delta根> --report <dup-report.jsonl> [--expect-files N]
 *     按 bodySha256（= sha256(extractWorksetBody(全文))，与 slim manifest 同源）分组；
 *     空正文文件只计数不标记（emptyBodyFiles）；非空且成员 ≥2 的组取最小组员 id 为代表，
 *     其余文件在 frontmatter 增加/更新 duplicate_of: <代表id>（原子重写，正文逐字节不变，
 *     重命名前在临时文件上重读校验）。report 每组一行 {bodySha256,size,representative,
 *     members:[{id,path,marked}]}。stdout 末行 JSON：
 *     {nonEmptyDupGroups,marked,emptyBodyFiles}。
 *
 * 铁律（与计划全局约束一致）：
 *   - 先校验后写：所有落盘走 临时文件 → 重读校验 → 原子 rename，绝不原地覆写；
 *     临时文件数据 fsync 落盘后再 rename、rename 后对目录 best-effort fsync——
 *     rename(2) 本身不同步文件数据，断电时 rename 可能先于数据持久化而留下撕裂件，
 *     rename 前的重读校验命中页缓存、拦不住该窗口；
 *   - 正文零变化：以 extractWorksetBody 的正文语义做重写前后哈希对账（该函数是
 *     rerun 管道消费正文的同一实现；真实两树全量 LF，无 CRLF 漂移）；
 *   - manifest/report 是对账证据；slim 失败停止时仍持久化已重写文件的 manifest 行；
 *   - 不写凭据：工具只读写本地文件路径，不触碰数据库、不发网络请求；
 *   - 解析边界与 extractWorksetBody 同源：首行 '---'、随后首个 '---' 行闭合；
 *     '---' 开头但永不闭合的文件一律报错拒写，绝不把 frontmatter 误当正文。
 *     splitFrontmatter 认为已闭合、但闭合行无法被 extractWorksetBody 的 "\n---\n"
 *     形态识别（闭合 --- 位于 EOF 且无行尾换行、或以裸 \r 收尾）时，两个解析器对
 *     边界的认知分叉——extractWorksetBody 会把整个文件（含旧 frontmatter 与
 *     envelope）当正文，重写将产出损坏件且重读自校验用同一提取器、必然漏检；
 *     此分叉态（frontmatterCloseDiverges）同样一律报错拒写（fail-stop）。
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, mkdir, open } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { extractWorksetBody } from "./operator-wiki-knowledge-replace.js";

/** 留证字段（顺序即 JSONL 行内字段顺序）。 */
const EVIDENCE_FIELDS = [
  "id",
  "createdAt",
  "importance",
  "category",
  "contentHash",
  "dataType",
  "producerId",
  "namespace",
  "scopeKey",
] as const;

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const FM_KEY_RE = /^([A-Za-z][A-Za-z0-9_-]*):(?:[ ](.*))?$/;
const MARKER_KEY = "duplicate_of";

// ---------------------------------------------------------------------------
// 纯函数（离线可测）
// ---------------------------------------------------------------------------

function stripCr(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** frontmatter 切分结果：与 extractWorksetBody 的边界语义一致（首行 --- / 首个 --- 闭合）。 */
export interface FrontmatterSplit {
  /** 文件以 --- 开头且找到闭合行。 */
  readonly hasFrontmatter: boolean;
  /** 文件以 --- 开头但永不闭合（危险态，调用方必须报错拒写）。 */
  readonly unterminated: boolean;
  /** frontmatter 原始行（已去尾部 \r，供 dupes 原样保留重建）。 */
  readonly lines: readonly string[];
  /** key → value（首个出现生效；value 已 trim）。非 key:value 形态的行不进 map 但保留在 lines。 */
  readonly keys: ReadonlyMap<string, string>;
  /** 闭合行之后的原始正文（逐字节保留，含 \r 与空行）。无 frontmatter 时为整个文件。 */
  readonly bodyRaw: string;
}

export function splitFrontmatter(raw: string): FrontmatterSplit {
  const lines = raw.split("\n");
  if (lines.length === 0 || stripCr(lines[0]!) !== "---") {
    return { hasFrontmatter: false, unterminated: false, lines: [], keys: new Map(), bodyRaw: raw };
  }
  let close = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (stripCr(lines[index]!) === "---") {
      close = index;
      break;
    }
  }
  if (close < 0) {
    return { hasFrontmatter: false, unterminated: true, lines: [], keys: new Map(), bodyRaw: raw };
  }
  const fmLines = lines.slice(1, close).map(stripCr);
  const keys = new Map<string, string>();
  for (const line of fmLines) {
    const match = FM_KEY_RE.exec(line);
    if (match && !keys.has(match[1]!)) keys.set(match[1]!, (match[2] ?? "").trim());
  }
  return {
    hasFrontmatter: true,
    unterminated: false,
    lines: fmLines,
    keys,
    bodyRaw: lines.slice(close + 1).join("\n"),
  };
}

/**
 * splitFrontmatter 与 extractWorksetBody 的 frontmatter 边界分叉判定：
 * splitFrontmatter 按行识别闭合（stripCr 后等于 '---' 即闭合），extractWorksetBody
 * 只识别归一化文本中的 "\n---\n"（闭合行之后必须还有换行）。当 splitFrontmatter
 * 认为已闭合而 extractWorksetBody 的搜索落空（end<0，会把整个文件当正文）时返回
 * true——slim/dupes 对此类文件必须报错拒写，否则 slim 会写出「新 frontmatter +
 * 整个原文件」的损坏件，且重读自校验因用同一提取器而必然漏检（fail-unsafe 边界）。
 * 未闭合/无 frontmatter 的文件不在此判定范围内（由 unterminated / hasFrontmatter
 * 语义各自处理）。
 */
export function frontmatterCloseDiverges(raw: string): boolean {
  if (!splitFrontmatter(raw).hasFrontmatter) return false;
  const normalized = raw.replace(/\r\n/g, "\n");
  return normalized.indexOf("\n---\n", 4) < 0;
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** base64url-json 信封解码；字符集与 JSON 双重校验，坏信封抛错（不静默当 absent）。 */
export function decodeEnvelope(encoded: string): unknown {
  const value = encoded.trim();
  if (!BASE64URL_RE.test(value)) throw new Error("envelope is not base64url");
  const json = Buffer.from(value, "base64url").toString("utf8");
  return JSON.parse(json) as unknown;
}

function envelopeField(envelope: unknown, field: string): unknown {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) return undefined;
  return (envelope as Record<string, unknown>)[field];
}

/**
 * id 解析（slim/dupes/extract-absent 共用）：frontmatter id → source_id →
 * mengshu_source_ref 尾段 → 文件名 stem。真实两树已实测四者与 envelope.id
 * 完全一致（47,963 + 1,546 全量比对 0 差异），故 slim/dupes 无需解信封即可
 * 拿到与 extract 相同的 id。
 */
export function resolveFileId(input: {
  readonly keys: ReadonlyMap<string, string>;
  readonly filenameStem: string;
}): string {
  const sourceRef = input.keys.get("mengshu_source_ref");
  const sourceRefTail = sourceRef !== undefined && sourceRef.length > 0
    ? sourceRef.split(":").slice(-1)[0]!
    : "";
  const candidates = [
    input.keys.get("id") ?? "",
    input.keys.get("source_id") ?? "",
    sourceRefTail,
    input.filenameStem,
  ];
  const found = candidates.find((candidate) => candidate.length > 0);
  return found ?? "";
}

/** extract 的留证行：envelope 内 9 字段按序输出；字段缺失则省略，null 原样保留。 */
export function buildEvidenceLine(envelope: unknown, fallbackId: string): Record<string, unknown> {
  const line: Record<string, unknown> = {};
  for (const field of EVIDENCE_FIELDS) {
    if (field === "id") {
      const envelopeId = envelopeField(envelope, "id");
      line.id = typeof envelopeId === "string" && envelopeId.length > 0 ? envelopeId : fallbackId;
      continue;
    }
    const value = envelopeField(envelope, field);
    if (value === undefined) continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
      line[field] = value;
    } else {
      line[field] = JSON.stringify(value);
    }
  }
  return line;
}

/** slim 的最小 frontmatter + 正文。键序固定，重跑幂等（同输入同输出字节）。 */
export function buildSlimmedMarkdown(input: {
  readonly id: string;
  readonly scopeKey: string | null;
  readonly sourceHash: string | null;
  readonly duplicateOf: string | null;
  readonly body: string;
}): string {
  const lines = ["---", `id: ${input.id}`];
  if (input.scopeKey !== null && input.scopeKey.length > 0) {
    lines.push(`scope_key: ${input.scopeKey}`);
  }
  if (input.sourceHash !== null && input.sourceHash.length > 0) {
    lines.push(`mengshu_source_hash: ${input.sourceHash}`);
  }
  if (input.duplicateOf !== null && input.duplicateOf.length > 0) {
    lines.push(`${MARKER_KEY}: ${input.duplicateOf}`);
  }
  lines.push("---");
  const frontmatter = `${lines.join("\n")}\n`;
  return input.body.length > 0 ? `${frontmatter}${input.body}\n` : frontmatter;
}

/** dupes 的标记重写：frontmatter 行原样保留（仅替换/追加 duplicate_of），正文逐字节不动。 */
export function buildMarkedMarkdown(split: FrontmatterSplit, representativeId: string): string {
  const marker = `${MARKER_KEY}: ${representativeId}`;
  const lines = [...split.lines];
  const existing = lines.findIndex((line) => FM_KEY_RE.exec(line)?.[1] === MARKER_KEY);
  if (existing >= 0) lines[existing] = marker;
  else lines.push(marker);
  if (split.hasFrontmatter) {
    return `---\n${lines.join("\n")}\n---\n${split.bodyRaw}`;
  }
  return `---\n${marker}\n---\n${split.bodyRaw}`;
}

// ---------------------------------------------------------------------------
// 文件遍历与原子落盘
// ---------------------------------------------------------------------------

function walkMarkdown(root: string, into: string[]): void {
  const stats = lstatSync(root);
  if (!stats.isDirectory()) throw new Error(`root is not a directory: ${root}`);
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) throw new Error(`symlink entry rejected: ${path}`);
    if (entry.isDirectory()) walkMarkdown(path, into);
    else if (entry.isFile() && name.endsWith(".md")) into.push(path);
  }
}

/** child 是否等于 parent 或位于 parent 之内（两者均为绝对路径）。 */
function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * 收集 source 根 + delta 根的全部 .md（source 在前、各自路径排序，确定性顺序）。
 * 两根必须不相交（相等或任意方向嵌套均拒绝）：同一文件被收两次会重复重写、
 * manifest 重复记账，dupes 还可能把同一文件的两条记录放进同组、标 duplicate_of:
 * <自身 id>。
 */
export function collectMarkdownFiles(sourceRoot: string, deltaRoot: string): string[] {
  const sourceAbs = resolve(sourceRoot);
  const deltaAbs = resolve(deltaRoot);
  if (containsPath(sourceAbs, deltaAbs) || containsPath(deltaAbs, sourceAbs)) {
    throw new Error(`source and delta roots must be disjoint (overlap detected): ${sourceRoot} vs ${deltaRoot}`);
  }
  const files: string[] = [];
  walkMarkdown(sourceRoot, files);
  const sourceCount = files.length;
  walkMarkdown(deltaRoot, files);
  if (files.length - sourceCount === 0 && sourceCount === 0) {
    throw new Error("no markdown files found under source or delta roots");
  }
  return files;
}

function expectFilesGuard(files: readonly string[], expectFiles: number | undefined): void {
  if (expectFiles !== undefined && files.length !== expectFiles) {
    throw new Error(`file count mismatch: walked ${files.length}, expected ${expectFiles}`);
  }
}

/** 数据先 fsync 落盘：writeFile 后打开句柄同步，保证 rename 前数据不在页缓存里悬空。 */
async function writeDurably(path: string, data: string): Promise<void> {
  const handle = await open(path, "w");
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** rename 后对目录 best-effort fsync（部分平台不支持目录 fsync，失败不视为错误；文件数据已同步）。 */
async function syncDirectoryBestEffort(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // 平台限制（如 Windows 打开目录受限）：目录项持久化尽力而为。
  }
}

async function writeAtomic(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  await writeDurably(tmp, data);
  await rename(tmp, path);
  await syncDirectoryBestEffort(dirname(path));
}

/** rename 前重读校验不通过（正文损失风险）；与普通 I/O 错误区分，调用方分别处理。 */
class RewriteVerificationError extends Error {
  constructor(path: string) {
    super(`verification failed before rename: ${path}`);
    this.name = "RewriteVerificationError";
  }
}

/** 临时文件写入 + 校验回调 + 原子 rename；校验失败/抛错时临时文件必然清理。 */
async function writeVerified(
  path: string,
  data: string,
  verify: (reread: string) => boolean,
): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomUUID()}`);
  try {
    await writeDurably(tmp, data);
    const reread = await readFile(tmp, "utf8");
    if (!verify(reread)) throw new RewriteVerificationError(path);
    await rename(tmp, path);
    await syncDirectoryBestEffort(dirname(path));
  } finally {
    await rm(tmp, { force: true });
  }
}

// ---------------------------------------------------------------------------
// 子命令 runner（测试可直接调用）
// ---------------------------------------------------------------------------

export interface ExtractSummary {
  readonly files: number;
  readonly extracted: number;
  readonly noEnvelope: number;
}

export async function runExtract(input: {
  readonly sourceRoot: string;
  readonly deltaRoot: string;
  readonly outPath: string;
  readonly expectFiles?: number;
}): Promise<ExtractSummary> {
  const files = collectMarkdownFiles(input.sourceRoot, input.deltaRoot);
  expectFilesGuard(files, input.expectFiles);
  const lines: string[] = [];
  let extracted = 0;
  let noEnvelope = 0;
  for (const path of files) {
    const raw = await readFile(path, "utf8");
    const split = splitFrontmatter(raw);
    if (split.unterminated) throw new Error(`frontmatter unterminated: ${path}`);
    const stem = basename(path).replace(/\.md$/, "");
    const envelopeB64 = split.keys.get("mengshu_envelope");
    if (envelopeB64 === undefined || envelopeB64.length === 0) {
      noEnvelope += 1;
      const id = resolveFileId({ keys: split.keys, filenameStem: stem });
      if (id.length === 0) throw new Error(`cannot resolve id for envelope-absent file: ${path}`);
      lines.push(JSON.stringify({ id, envelope: "absent" }));
      continue;
    }
    let envelope: unknown;
    try {
      envelope = decodeEnvelope(envelopeB64);
    } catch (cause) {
      throw new Error(`envelope undecodable: ${path}: ${String(cause)}`);
    }
    extracted += 1;
    const envelopeId = envelopeField(envelope, "id");
    const fallbackId = resolveFileId({
      keys: split.keys,
      filenameStem: typeof envelopeId === "string" && envelopeId.length > 0 ? envelopeId : stem,
    });
    if (fallbackId.length === 0) throw new Error(`cannot resolve id: ${path}`);
    lines.push(JSON.stringify(buildEvidenceLine(envelope, fallbackId)));
  }
  await writeAtomic(input.outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  return { files: files.length, extracted, noEnvelope };
}

export interface SlimManifestLine {
  readonly id: string;
  readonly path: string;
  readonly oldBytes: number;
  readonly newBytes: number;
  readonly bodySha256: string;
}

/**
 * 装载 extract 留证 JSONL 的 id 集合（slim 的 C1 前置门禁输入）：
 * 文件必须存在；每行必须是含非空 string id 的 JSON；id 重复即失败（行数 = id 数）。
 */
async function loadEvidenceIds(evidencePath: string): Promise<Set<string>> {
  let raw: string;
  try {
    raw = await readFile(evidencePath, "utf8");
  } catch {
    throw new Error(`evidence file is missing (run extract before slim): ${evidencePath}`);
  }
  const ids = new Set<string>();
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (cause) {
      throw new Error(`evidence line ${index + 1} is not valid JSON: ${String(cause)}`);
    }
    const id = (value as { id?: unknown } | null)?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`evidence line ${index + 1} has no id: ${line.slice(0, 80)}`);
    }
    if (ids.has(id)) throw new Error(`evidence has duplicate id: ${id}`);
    ids.add(id);
  }
  return ids;
}

export interface SlimSummary {
  readonly files: number;
  readonly rewritten: number;
  readonly bodyMismatches: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/** 信封 scopeKey（仅当 frontmatter 没有 scope_key 时才解码信封）。 */
function scopeKeyFrom(split: FrontmatterSplit, envelopeB64: string | undefined): string | null {
  const fmScope = split.keys.get("scope_key");
  if (fmScope !== undefined && fmScope.length > 0) return fmScope;
  if (envelopeB64 === undefined || envelopeB64.length === 0) return null;
  const scopeKey = envelopeField(decodeEnvelope(envelopeB64), "scopeKey");
  return typeof scopeKey === "string" && scopeKey.length > 0 ? scopeKey : null;
}

export async function runSlim(input: {
  readonly sourceRoot: string;
  readonly deltaRoot: string;
  /** extract 产出的留证 JSONL（C1 先留证后重写的顺序门禁，必填）。 */
  readonly evidencePath: string;
  readonly manifestPath: string;
  readonly expectFiles?: number;
}): Promise<SlimSummary> {
  const evidenceIds = await loadEvidenceIds(input.evidencePath);
  const files = collectMarkdownFiles(input.sourceRoot, input.deltaRoot);
  expectFilesGuard(files, input.expectFiles);
  // 阶段零（只读预扫描）：逐文件解析 id 并做全部边界门禁；任何文件不合格或留证未
  // 双向覆盖时，在任何重写发生之前整体失败（fail-stop，不留半程状态）。
  const fileIds: string[] = [];
  for (const path of files) {
    const raw = await readFile(path, "utf8");
    const split = splitFrontmatter(raw);
    if (split.unterminated) throw new Error(`frontmatter unterminated: ${path}`);
    if (frontmatterCloseDiverges(raw)) {
      throw new Error(`frontmatter close diverges from body extractor (closing --- not followed by newline): ${path}`);
    }
    const id = resolveFileId({ keys: split.keys, filenameStem: basename(path).replace(/\.md$/, "") });
    if (id.length === 0) throw new Error(`cannot resolve id: ${path}`);
    fileIds.push(id);
  }
  const uncovered = fileIds.filter((id) => !evidenceIds.has(id));
  if (uncovered.length > 0 || evidenceIds.size !== files.length) {
    throw new Error(
      `evidence coverage gate failed (archive/extract must precede slim): files=${files.length}` +
        ` evidenceIds=${evidenceIds.size} uncovered=${uncovered.length} samples=${uncovered.slice(0, 3).join(",")}`,
    );
  }
  const manifest: SlimManifestLine[] = [];
  let rewritten = 0;
  let bodyMismatches = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;
  try {
    for (const path of files) {
      const raw = await readFile(path, "utf8");
      const split = splitFrontmatter(raw);
      if (split.unterminated) throw new Error(`frontmatter unterminated: ${path}`);
      if (frontmatterCloseDiverges(raw)) {
        throw new Error(`frontmatter close diverges from body extractor (closing --- not followed by newline): ${path}`);
      }
      const stem = basename(path).replace(/\.md$/, "");
      const id = resolveFileId({ keys: split.keys, filenameStem: stem });
      if (id.length === 0) throw new Error(`cannot resolve id: ${path}`);
      const envelopeB64 = split.keys.get("mengshu_envelope");
      let scopeKey: string | null;
      try {
        scopeKey = scopeKeyFrom(split, envelopeB64);
      } catch (cause) {
        throw new Error(`envelope undecodable: ${path}: ${String(cause)}`);
      }
      const body = extractWorksetBody(raw);
      const bodySha256 = sha256Hex(body);
      const newContent = buildSlimmedMarkdown({
        id,
        scopeKey,
        sourceHash: split.keys.get("mengshu_source_hash") ?? null,
        duplicateOf: split.keys.get(MARKER_KEY) ?? null,
        body,
      });
      try {
        // 先校验后写：临时文件 → 重读 → 正文哈希一致 → 原子 rename。
        await writeVerified(path, newContent, (reread) => {
          return sha256Hex(extractWorksetBody(reread)) === bodySha256;
        });
      } catch (error) {
        if (!(error instanceof RewriteVerificationError)) throw error;
        // rename 前哈希不一致 = 正文损失风险：该文件保持原样，立即 fail-stop。
        bodyMismatches += 1;
        console.error(`[wiki-slim] body hash mismatch after rewrite, stopping: ${path}`);
        break;
      }
      rewritten += 1;
      bytesBefore += Buffer.byteLength(raw, "utf8");
      bytesAfter += Buffer.byteLength(newContent, "utf8");
      manifest.push({
        id,
        path,
        oldBytes: Buffer.byteLength(raw, "utf8"),
        newBytes: Buffer.byteLength(newContent, "utf8"),
        bodySha256,
      });
    }
  } finally {
    // manifest 是对账证据：即使 fail-stop / 中途抛错，也把已重写文件的行持久化（失败恢复约定）。
    await writeAtomic(
      input.manifestPath,
      manifest.length > 0 ? `${manifest.map((line) => JSON.stringify(line)).join("\n")}\n` : "",
    );
  }
  return { files: files.length, rewritten, bodyMismatches, bytesBefore, bytesAfter };
}

export interface DupesMemberLine {
  readonly id: string;
  readonly path: string;
  readonly marked: boolean;
}

export interface DupesReportGroupLine {
  readonly bodySha256: string;
  readonly size: number;
  readonly representative: string;
  readonly members: readonly DupesMemberLine[];
}

export interface DupesSummary {
  readonly nonEmptyDupGroups: number;
  readonly marked: number;
  readonly emptyBodyFiles: number;
}

interface DupesFileRecord {
  readonly path: string;
  readonly id: string;
  readonly split: FrontmatterSplit;
  readonly bodySha256: string;
  readonly emptyBody: boolean;
}

export async function runDupes(input: {
  readonly sourceRoot: string;
  readonly deltaRoot: string;
  readonly reportPath: string;
  readonly expectFiles?: number;
}): Promise<DupesSummary> {
  const files = collectMarkdownFiles(input.sourceRoot, input.deltaRoot);
  expectFilesGuard(files, input.expectFiles);
  // 阶段一：全量只读扫描（分组前不改任何文件）。
  const records: DupesFileRecord[] = [];
  let emptyBodyFiles = 0;
  for (const path of files) {
    const raw = await readFile(path, "utf8");
    const split = splitFrontmatter(raw);
    if (split.unterminated) throw new Error(`frontmatter unterminated: ${path}`);
    if (frontmatterCloseDiverges(raw)) {
      throw new Error(`frontmatter close diverges from body extractor (closing --- not followed by newline): ${path}`);
    }
    const stem = basename(path).replace(/\.md$/, "");
    const id = resolveFileId({ keys: split.keys, filenameStem: stem });
    if (id.length === 0) throw new Error(`cannot resolve id: ${path}`);
    const body = extractWorksetBody(raw);
    const emptyBody = body.length === 0;
    if (emptyBody) emptyBodyFiles += 1;
    records.push({ path, id, split, bodySha256: sha256Hex(body), emptyBody });
  }
  // 阶段二：非空重复组（≥2）标记；空正文组只统计，绝不标记。
  const groups = new Map<string, DupesFileRecord[]>();
  for (const record of records) {
    if (record.emptyBody) continue;
    const bucket = groups.get(record.bodySha256);
    if (bucket === undefined) groups.set(record.bodySha256, [record]);
    else bucket.push(record);
  }
  const reportLines: DupesReportGroupLine[] = [];
  let marked = 0;
  try {
    for (const bodySha256 of [...groups.keys()].sort()) {
      const members = groups.get(bodySha256)!;
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const representative = sorted[0]!;
      const memberLines: DupesMemberLine[] = [];
      for (const member of sorted) {
        if (member === representative) {
          memberLines.push({ id: member.id, path: member.path, marked: false });
          continue;
        }
        const alreadyMarked = member.split.keys.get(MARKER_KEY) === representative.id;
        if (alreadyMarked) {
          marked += 1;
          memberLines.push({ id: member.id, path: member.path, marked: true });
          continue;
        }
        const newContent = buildMarkedMarkdown(member.split, representative.id);
        // 原子重写 + rename 前重读校验：正文语义哈希与原始正文字节都必须与重写前一致。
        await writeVerified(member.path, newContent, (reread) => {
          const rereadSplit = splitFrontmatter(reread);
          return (
            sha256Hex(extractWorksetBody(reread)) === member.bodySha256 &&
            rereadSplit.bodyRaw === member.split.bodyRaw
          );
        });
        marked += 1;
        memberLines.push({ id: member.id, path: member.path, marked: true });
      }
      reportLines.push({
        bodySha256,
        size: sorted.length,
        representative: representative.id,
        members: memberLines,
      });
    }
  } finally {
    // report 是对账证据：中途失败也持久化已处理完成的组，且标记本身幂等可重跑。
    await writeAtomic(
      input.reportPath,
      reportLines.length > 0 ? `${reportLines.map((line) => JSON.stringify(line)).join("\n")}\n` : "",
    );
  }
  return { nonEmptyDupGroups: reportLines.length, marked, emptyBodyFiles };
}

// ---------------------------------------------------------------------------
// CLI 入口（runner 与 CLI 分离，测试只 import 纯函数、runner 与 runCli）
// ---------------------------------------------------------------------------

function argFrom(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function optionalIntArgFrom(args: readonly string[], name: string): number | undefined {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`invalid ${name}: ${value}`);
  return parsed;
}

/** CLI：stdout 末行是 JSON 摘要（extract/slim/dupes 三态见文件头注释）。 */
export async function runCli(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === "extract") {
    const summary = await runExtract({
      sourceRoot: argFrom(args, "--source"),
      deltaRoot: argFrom(args, "--delta"),
      outPath: argFrom(args, "--out"),
      expectFiles: optionalIntArgFrom(args, "--expect-files"),
    });
    console.log(JSON.stringify(summary));
    return;
  }
  if (command === "slim") {
    const summary = await runSlim({
      sourceRoot: argFrom(args, "--source"),
      deltaRoot: argFrom(args, "--delta"),
      evidencePath: argFrom(args, "--evidence"),
      manifestPath: argFrom(args, "--manifest"),
      expectFiles: optionalIntArgFrom(args, "--expect-files"),
    });
    console.log(JSON.stringify(summary));
    if (summary.bodyMismatches > 0) process.exitCode = 1;
    return;
  }
  if (command === "dupes") {
    const summary = await runDupes({
      sourceRoot: argFrom(args, "--source"),
      deltaRoot: argFrom(args, "--delta"),
      reportPath: argFrom(args, "--report"),
      expectFiles: optionalIntArgFrom(args, "--expect-files"),
    });
    console.log(JSON.stringify(summary));
    return;
  }
  throw new Error(
    "usage: wiki-slim.ts <extract|slim|dupes> --source <dir> --delta <dir> (--out|--manifest|--report) <file>" +
      " [slim 额外必填 --evidence <legacy-row-meta.jsonl>] [--expect-files N]",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
