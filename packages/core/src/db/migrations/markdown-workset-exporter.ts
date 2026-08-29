import { createHash } from "node:crypto";
import { lstat, link, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  createMarkdownWorksetManifest,
  createMarkdownWorksetRecord,
  markdownWorksetManifestSha256,
  renderNativeRecordMarkdown,
  serializeMarkdownWorksetManifest,
  type MarkdownWorksetManifest,
  type MarkdownWorksetManifestFile,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetSourceTable,
} from "./markdown-workset.js";

const SOURCE_TABLES: readonly MarkdownWorksetSourceTable[] = ["memories", "knowledge"];
const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{1,199}$/;
const DEFAULT_PAGE_SIZE = 500;
const MAX_PAGE_SIZE = 10_000;
const DEFAULT_WRITE_CONCURRENCY = 16;
const MAX_WRITE_CONCURRENCY = 64;

export interface MarkdownWorksetSnapshotRead {
  readonly sourceTable: MarkdownWorksetSourceTable;
  readonly afterId: string | undefined;
  readonly limit: number;
}

export interface MarkdownWorksetSnapshotRow {
  /** 适配器必须在这里完整映射原表列，并将 vector 解码为 number[]。 */
  readonly record: MarkdownWorksetNativeRecord;
  readonly scopeFingerprint?: string;
}

export interface MarkdownWorksetSnapshotPage {
  readonly rows: readonly MarkdownWorksetSnapshotRow[];
  readonly done: boolean;
  /** 非末页必须等于 rows 的最后一个 id。 */
  readonly nextAfterId?: string;
}

export interface MarkdownWorksetSnapshotCounts {
  readonly memories: number;
  readonly knowledge: number;
}

/**
 * 调用方负责在调用 exportMarkdownWorkset 前开启并固定同一个 snapshot session。
 * PostgreSQL 脚本层应使用 REPEATABLE READ READ ONLY，并在调用返回后自行结束事务。
 */
export interface MarkdownWorksetSnapshotSession {
  getSourceCounts(): Promise<MarkdownWorksetSnapshotCounts>;
  readPage(input: MarkdownWorksetSnapshotRead): Promise<MarkdownWorksetSnapshotPage>;
}

export interface ExportMarkdownWorksetInput {
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly migrationRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly pageSize?: number;
  readonly writeConcurrency?: number;
  readonly snapshotSession: MarkdownWorksetSnapshotSession;
}

export interface ExportMarkdownWorksetResult {
  readonly outputDirectory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: MarkdownWorksetManifest;
}

export type MarkdownWorksetExportErrorCode =
  | "MARKDOWN_WORKSET_EXPORT_INVALID_INPUT"
  | "MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE"
  | "MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS"
  | "MARKDOWN_WORKSET_EXPORT_SESSION_ERROR"
  | "MARKDOWN_WORKSET_EXPORT_INVALID_PAGE"
  | "MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED"
  | "MARKDOWN_WORKSET_EXPORT_DUPLICATE_SOURCE"
  | "MARKDOWN_WORKSET_EXPORT_DUPLICATE_PATH"
  | "MARKDOWN_WORKSET_EXPORT_INVALID_ROW"
  | "MARKDOWN_WORKSET_EXPORT_SNAPSHOT_DRIFT"
  | "MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR";

const ERROR_MESSAGES: Record<MarkdownWorksetExportErrorCode, string> = {
  MARKDOWN_WORKSET_EXPORT_INVALID_INPUT: "Markdown workset export input is invalid",
  MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE: "Markdown workset export path escaped containment",
  MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS: "Markdown workset export output already exists",
  MARKDOWN_WORKSET_EXPORT_SESSION_ERROR: "Markdown workset snapshot session failed",
  MARKDOWN_WORKSET_EXPORT_INVALID_PAGE: "Markdown workset snapshot page is invalid",
  MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED: "Markdown workset snapshot cursor did not advance",
  MARKDOWN_WORKSET_EXPORT_DUPLICATE_SOURCE: "Markdown workset source id is duplicated",
  MARKDOWN_WORKSET_EXPORT_DUPLICATE_PATH: "Markdown workset output path is duplicated",
  MARKDOWN_WORKSET_EXPORT_INVALID_ROW: "Markdown workset snapshot row is invalid",
  MARKDOWN_WORKSET_EXPORT_SNAPSHOT_DRIFT: "Markdown workset snapshot count drifted",
  MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR: "Markdown workset export filesystem operation failed",
};

export class MarkdownWorksetExportError extends Error {
  constructor(readonly code: MarkdownWorksetExportErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownWorksetExportError";
  }
}

interface PreparedRecord {
  readonly id: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly directoryParts: readonly string[];
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly markdown: string;
}

function fail(code: MarkdownWorksetExportErrorCode): never {
  throw new MarkdownWorksetExportError(code);
}

function errorCode(value: unknown): string | undefined {
  return value && typeof value === "object" && "code" in value &&
    typeof value.code === "string" ? value.code : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function assertFreshContainedOutput(
  containmentRoot: string,
  outputDirectory: string,
): Promise<void> {
  if (!isAbsolute(containmentRoot) || !isAbsolute(outputDirectory) ||
      resolve(containmentRoot) !== containmentRoot || resolve(outputDirectory) !== outputDirectory ||
      !strictDescendant(containmentRoot, outputDirectory)) {
    fail("MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE");
  }

  let rootInfo;
  let parentInfo;
  try {
    rootInfo = await lstat(containmentRoot);
    parentInfo = await lstat(dirname(outputDirectory));
  } catch {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail("MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE");
  }

  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([
      realpath(containmentRoot),
      realpath(dirname(outputDirectory)),
    ]);
  } catch {
    fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
  }
  if (realParent !== realRoot && !strictDescendant(realRoot, realParent)) {
    fail("MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE");
  }

  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
  }
  fail("MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS");
}

async function createPrivateOutput(outputDirectory: string): Promise<void> {
  try {
    await mkdir(outputDirectory, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
  }
}

async function ensurePrivateDirectories(
  outputDirectory: string,
  parts: readonly string[],
  knownDirectories: Set<string>,
): Promise<void> {
  let current = outputDirectory;
  for (const part of parts) {
    current = resolve(current, part);
    if (!strictDescendant(outputDirectory, current)) fail("MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE");
    if (knownDirectories.has(current)) continue;
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS");
      fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
    }
    knownDirectories.add(current);
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS");
    if (error instanceof MarkdownWorksetExportError) throw error;
    fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function sourceCounts(
  session: MarkdownWorksetSnapshotSession,
): Promise<MarkdownWorksetSnapshotCounts> {
  let counts: MarkdownWorksetSnapshotCounts;
  try {
    counts = await session.getSourceCounts();
  } catch {
    fail("MARKDOWN_WORKSET_EXPORT_SESSION_ERROR");
  }
  if (!counts || typeof counts !== "object" ||
      !validCount(counts.memories) || !validCount(counts.knowledge)) {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  return counts;
}

async function readSnapshotPage(
  session: MarkdownWorksetSnapshotSession,
  input: MarkdownWorksetSnapshotRead,
): Promise<MarkdownWorksetSnapshotPage> {
  try {
    return await session.readPage(input);
  } catch (error) {
    if (error instanceof MarkdownWorksetExportError) throw error;
    fail("MARKDOWN_WORKSET_EXPORT_SESSION_ERROR");
  }
}

function prepareRecord(
  row: MarkdownWorksetSnapshotRow,
  sourceTable: MarkdownWorksetSourceTable,
  outputDirectory: string,
): PreparedRecord {
  if (!row || typeof row !== "object" || !row.record || typeof row.record !== "object" ||
      row.record.sourceTable !== sourceTable || !SAFE_RECORD_ID.test(row.record.id)) {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_ROW");
  }
  let worksetRecord;
  let markdown: string;
  try {
    worksetRecord = createMarkdownWorksetRecord({
      phase: "source",
      scopeFingerprint: row.scopeFingerprint,
      record: row.record,
    });
    markdown = renderNativeRecordMarkdown(worksetRecord);
  } catch {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_ROW");
  }

  const prefix = worksetRecord.record.id.slice(0, 2);
  const directoryParts = ["source", sourceTable, prefix] as const;
  const relativePath = `${directoryParts.join("/")}/${worksetRecord.record.id}.md`;
  const absolutePath = resolve(outputDirectory, relativePath);
  if (!strictDescendant(outputDirectory, absolutePath)) fail("MARKDOWN_WORKSET_EXPORT_PATH_ESCAPE");
  return {
    id: worksetRecord.record.id,
    relativePath,
    absolutePath,
    directoryParts,
    sourceRef: worksetRecord.sourceRef,
    sourceHash: worksetRecord.sourceHash,
    markdown,
  };
}

function validateAndPreparePage(
  page: MarkdownWorksetSnapshotPage,
  sourceTable: MarkdownWorksetSourceTable,
  afterId: string | undefined,
  pageSize: number,
  outputDirectory: string,
  seenSources: Set<string>,
  seenPaths: Set<string>,
): readonly PreparedRecord[] {
  if (!page || typeof page !== "object" || !Array.isArray(page.rows) ||
      typeof page.done !== "boolean" || page.rows.length > pageSize) {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_PAGE");
  }
  const prepared = page.rows.map((row) => prepareRecord(row, sourceTable, outputDirectory));

  for (const record of prepared) {
    if (seenSources.has(record.sourceRef)) fail("MARKDOWN_WORKSET_EXPORT_DUPLICATE_SOURCE");
    const portablePath = record.relativePath.toLowerCase();
    if (seenPaths.has(portablePath)) fail("MARKDOWN_WORKSET_EXPORT_DUPLICATE_PATH");
    seenSources.add(record.sourceRef);
    seenPaths.add(portablePath);
  }

  let previous = afterId;
  for (const record of prepared) {
    if (previous !== undefined && record.id <= previous) {
      fail("MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED");
    }
    previous = record.id;
  }
  if (prepared.length === 0) {
    if (!page.done || page.nextAfterId !== undefined) {
      fail("MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED");
    }
    return prepared;
  }

  const lastId = prepared.at(-1)!.id;
  if ((!page.done && page.nextAfterId !== lastId) ||
      (page.done && page.nextAfterId !== undefined && page.nextAfterId !== lastId) ||
      (afterId !== undefined && page.nextAfterId !== undefined && page.nextAfterId <= afterId)) {
    fail("MARKDOWN_WORKSET_EXPORT_CURSOR_STALLED");
  }
  return prepared;
}

function validateInput(input: ExportMarkdownWorksetInput): {
  readonly pageSize: number;
  readonly writeConcurrency: number;
  readonly emptyManifest: MarkdownWorksetManifest;
} {
  if (!input || typeof input !== "object" ||
      !input.snapshotSession || typeof input.snapshotSession.getSourceCounts !== "function" ||
      typeof input.snapshotSession.readPage !== "function") {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  const pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  const writeConcurrency = input.writeConcurrency ?? DEFAULT_WRITE_CONCURRENCY;
  if (!Number.isSafeInteger(writeConcurrency) || writeConcurrency < 1 ||
      writeConcurrency > MAX_WRITE_CONCURRENCY) {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  let emptyManifest: MarkdownWorksetManifest;
  try {
    emptyManifest = createMarkdownWorksetManifest({
      migrationRunId: input.migrationRunId,
      phase: "source",
      policyVersion: input.policyVersion,
      createdAt: input.createdAt,
      files: [],
    });
  } catch {
    fail("MARKDOWN_WORKSET_EXPORT_INVALID_INPUT");
  }
  return { pageSize, writeConcurrency, emptyManifest };
}

async function writePreparedRecords(
  records: readonly PreparedRecord[],
  outputDirectory: string,
  knownDirectories: Set<string>,
  writeConcurrency: number,
): Promise<void> {
  for (const record of records) {
    await ensurePrivateDirectories(outputDirectory, record.directoryParts, knownDirectories);
  }
  for (let offset = 0; offset < records.length; offset += writeConcurrency) {
    await Promise.all(records.slice(offset, offset + writeConcurrency).map((record) =>
      writeExclusive(record.absolutePath, record.markdown)));
  }
}

async function publishManifest(
  outputDirectory: string,
  manifestJson: string,
): Promise<string> {
  const pendingPath = resolve(outputDirectory, ".manifest.json.pending");
  const manifestPath = resolve(outputDirectory, "manifest.json");
  await writeExclusive(pendingPath, manifestJson);
  try {
    await link(pendingPath, manifestPath);
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_EXPORT_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_EXPORT_FILESYSTEM_ERROR");
  }
  try {
    await unlink(pendingPath);
  } catch {
    // manifest 已完整、原子发布；残留 pending 文件不影响校验与恢复。
  }
  return manifestPath;
}

export async function exportMarkdownWorkset(
  input: ExportMarkdownWorksetInput,
): Promise<ExportMarkdownWorksetResult> {
  const { pageSize, writeConcurrency, emptyManifest } = validateInput(input);
  await assertFreshContainedOutput(input.containmentRoot, input.outputDirectory);
  const expectedCounts = await sourceCounts(input.snapshotSession);
  await createPrivateOutput(input.outputDirectory);

  const knownDirectories = new Set<string>([input.outputDirectory]);
  const seenSources = new Set<string>();
  const seenPaths = new Set<string>();
  const manifestFiles: MarkdownWorksetManifestFile[] = [];
  const snapshotLines: string[] = [];
  const actualCounts: Record<MarkdownWorksetSourceTable, number> = {
    memories: 0,
    knowledge: 0,
  };

  for (const sourceTable of SOURCE_TABLES) {
    let afterId: string | undefined;
    let done = false;
    while (!done) {
      const page = await readSnapshotPage(input.snapshotSession, {
        sourceTable,
        afterId,
        limit: pageSize,
      });
      const prepared = validateAndPreparePage(
        page,
        sourceTable,
        afterId,
        pageSize,
        input.outputDirectory,
        seenSources,
        seenPaths,
      );
      if (actualCounts[sourceTable] + prepared.length > expectedCounts[sourceTable]) {
        fail("MARKDOWN_WORKSET_EXPORT_SNAPSHOT_DRIFT");
      }

      await writePreparedRecords(
        prepared,
        input.outputDirectory,
        knownDirectories,
        writeConcurrency,
      );
      for (const record of prepared) {
        manifestFiles.push(Object.freeze({
          relativePath: record.relativePath,
          sourceRef: record.sourceRef,
          sourceHash: record.sourceHash,
          markdownSha256: sha256(record.markdown),
        }));
        snapshotLines.push(`${record.sourceRef}\u001f${record.sourceHash}`);
        actualCounts[sourceTable] += 1;
      }

      done = page.done;
      if (!done) afterId = page.nextAfterId;
    }
    if (actualCounts[sourceTable] !== expectedCounts[sourceTable]) {
      fail("MARKDOWN_WORKSET_EXPORT_SNAPSHOT_DRIFT");
    }
  }

  manifestFiles.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  snapshotLines.sort((left, right) => left.localeCompare(right));
  const manifest: MarkdownWorksetManifest = Object.freeze({
    ...emptyManifest,
    sourceCount: manifestFiles.length,
    snapshotSha256: sha256(snapshotLines.join("\n")),
    files: Object.freeze(manifestFiles),
  });
  const manifestJson = serializeMarkdownWorksetManifest(manifest);
  const manifestPath = await publishManifest(input.outputDirectory, manifestJson);
  return Object.freeze({
    outputDirectory: input.outputDirectory,
    manifestPath,
    manifestSha256: markdownWorksetManifestSha256(manifestJson),
    manifest,
  });
}
