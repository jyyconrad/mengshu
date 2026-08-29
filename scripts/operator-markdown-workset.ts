import { constants as fsConstants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { types as nodeUtilTypes } from "node:util";

import { authorityScopeFingerprint } from
  "../packages/core/src/domain/authority-scope-fingerprint.js";
import {
  exportMarkdownWorkset,
  type ExportMarkdownWorksetResult,
  type MarkdownWorksetSnapshotCounts,
  type MarkdownWorksetSnapshotPage,
  type MarkdownWorksetSnapshotRead,
  type MarkdownWorksetSnapshotRow,
  type MarkdownWorksetSnapshotSession,
} from "../packages/core/src/db/migrations/markdown-workset-exporter.js";
import {
  governMarkdownWorkset,
} from "../packages/core/src/db/migrations/markdown-workset-governor.js";
import {
  markdownWorksetManifestSha256,
  parseMarkdownWorksetManifest,
  serializeMarkdownWorksetManifest,
  verifyMarkdownWorksetManifest,
  type MarkdownWorksetFileInput,
  type MarkdownWorksetManifest,
  type MarkdownWorksetNativeRecord,
  type MarkdownWorksetSourceTable,
} from "../packages/core/src/db/migrations/markdown-workset.js";

export interface MarkdownWorksetPostgresQueryResult {
  readonly rows: readonly unknown[];
}

export interface MarkdownWorksetPostgresQueryClient {
  query(
    sql: string,
    params?: readonly unknown[],
  ): Promise<MarkdownWorksetPostgresQueryResult>;
}

export interface DecodedPostgresMarkdownWorksetRow extends MarkdownWorksetSnapshotRow {
  readonly record: MarkdownWorksetNativeRecord;
  readonly scopeFingerprint?: string;
}

export interface RunPostgresMarkdownWorksetExportInput {
  readonly client: MarkdownWorksetPostgresQueryClient;
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly migrationRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly pageSize?: number;
  readonly writeConcurrency?: number;
}

export interface LoadedMarkdownWorksetBundle {
  readonly directory: string;
  readonly manifestPath: string;
  readonly manifestSha256: string;
  readonly manifest: MarkdownWorksetManifest;
  readonly files: readonly MarkdownWorksetFileInput[];
}

export interface WriteGovernedMarkdownWorksetInput {
  readonly source: LoadedMarkdownWorksetBundle;
  readonly containmentRoot: string;
  readonly outputDirectory: string;
  readonly policyVersion: string;
}

export type MarkdownWorksetOperatorErrorCode =
  | "MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT"
  | "MARKDOWN_WORKSET_OPERATOR_INVALID_ROW"
  | "MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT"
  | "MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE"
  | "MARKDOWN_WORKSET_OPERATOR_SYMLINK"
  | "MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT"
  | "MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS"
  | "MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR";

const ERROR_MESSAGES: Record<MarkdownWorksetOperatorErrorCode, string> = {
  MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT: "Markdown workset operator input is invalid",
  MARKDOWN_WORKSET_OPERATOR_INVALID_ROW: "PostgreSQL Markdown workset row or vector is invalid",
  MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT: "PostgreSQL Markdown workset count is invalid",
  MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE: "Markdown workset path escaped containment",
  MARKDOWN_WORKSET_OPERATOR_SYMLINK: "Markdown workset symlink is forbidden",
  MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT: "Markdown workset bundle or hash drifted",
  MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS: "Markdown workset output already exists",
  MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR: "Markdown workset filesystem operation failed",
};

export class MarkdownWorksetOperatorError extends Error {
  constructor(readonly code: MarkdownWorksetOperatorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownWorksetOperatorError";
  }
}

const SOURCE_TABLES = new Set<MarkdownWorksetSourceTable>(["memories", "knowledge"]);
const VISIBILITIES = new Set(["private", "workspace", "team", "public"] as const);
const LIFECYCLE_STATUSES = new Set([
  "active", "archived", "revoked", "superseded", "promoted",
] as const);
const MAX_PAGE_SIZE = 10_000;

const COUNTS_SQL = `SELECT
  (SELECT COUNT(*)::text FROM memories) AS memories_count,
  (SELECT COUNT(*)::text FROM knowledge) AS knowledge_count`;

const SELECT_COLUMNS = `id::text AS id, text, content_hash,
  vector::text AS vector_text, importance, category, data_type, metadata, created_at,
  project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
  canonical_project_id, product_id, producer_id, namespace, visibility,
  lifecycle_status, embedding_space_id, embedding_space_state,
  legacy_quarantine_reason, scope_key`;

function pageSql(sourceTable: MarkdownWorksetSourceTable): string {
  switch (sourceTable) {
    case "memories":
      return `SELECT ${SELECT_COLUMNS}
FROM memories
WHERE ($1::text IS NULL OR id::text COLLATE "C" > $1::text COLLATE "C")
ORDER BY id::text COLLATE "C" ASC
LIMIT $2`;
    case "knowledge":
      return `SELECT ${SELECT_COLUMNS}
FROM knowledge
WHERE ($1::text IS NULL OR id::text COLLATE "C" > $1::text COLLATE "C")
ORDER BY id::text COLLATE "C" ASC
LIMIT $2`;
  }
}

function fail(code: MarkdownWorksetOperatorErrorCode): never {
  throw new MarkdownWorksetOperatorError(code);
}

function errorCode(value: unknown): string | undefined {
  return value && typeof value === "object" && "code" in value &&
    typeof value.code === "string" ? value.code : undefined;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() ||
      value !== value.normalize("NFC") || /[\u0000-\u001f\u007f]/.test(value)) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }
  return value;
}

function optionalString(
  row: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = row[key];
  if (value === undefined || value === null) return undefined;
  if (value === "") return "";
  return requiredString(row, key);
}

function vector(value: unknown): readonly number[] {
  if (typeof value !== "string") fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }
  if (!Array.isArray(parsed) || nodeUtilTypes.isProxy(parsed) || parsed.length === 0 ||
      parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }
  return Object.freeze([...parsed]);
}

function isoTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : undefined;
  if (!date || !Number.isFinite(date.getTime())) fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  return date.toISOString();
}

function numericScore(value: unknown): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0(?:\.\d+)?|1(?:\.0+)?)$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }
  return parsed;
}

function parsedMetadata(value: unknown): Readonly<Record<string, unknown>> {
  if (!plainRecord(value)) fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  return value;
}

function scopeFingerprint(
  record: MarkdownWorksetNativeRecord,
): string | undefined {
  const required = [
    record.tenantId,
    record.userId,
    record.canonicalProjectId,
    record.productId,
    record.producerId,
    record.namespace,
    record.visibility,
  ];
  if (required.some((value) => value === undefined || value === "")) return undefined;
  try {
    return authorityScopeFingerprint({
      tenantId: record.tenantId!,
      userId: record.userId!,
      projectId: record.canonicalProjectId!,
      appId: record.productId!,
      agentId: record.producerId!,
      namespace: record.namespace!,
      visibility: record.visibility!,
      workspaceId: record.workspaceId || undefined,
    });
  } catch {
    return undefined;
  }
}

export function decodePostgresMarkdownWorksetRow(
  sourceTable: MarkdownWorksetSourceTable,
  raw: unknown,
): DecodedPostgresMarkdownWorksetRow {
  if (!SOURCE_TABLES.has(sourceTable) || !plainRecord(raw)) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }
  const importance = numericScore(raw.importance);
  const dataType = requiredString(raw, "data_type");
  const visibility = raw.visibility;
  const lifecycleStatus = raw.lifecycle_status;
  if (visibility !== undefined && visibility !== null &&
        (typeof visibility !== "string" ||
          !VISIBILITIES.has(visibility as "private" | "workspace" | "team" | "public")) ||
      lifecycleStatus !== undefined && lifecycleStatus !== null &&
        (typeof lifecycleStatus !== "string" ||
          !LIFECYCLE_STATUSES.has(lifecycleStatus as
            "active" | "archived" | "revoked" | "superseded" | "promoted"))) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW");
  }

  const projectName = optionalString(raw, "project_name");
  const appName = optionalString(raw, "app_name");
  const userId = optionalString(raw, "user_id");
  const agentId = optionalString(raw, "agent_id");
  const workspaceId = optionalString(raw, "workspace_id");
  const tenantId = optionalString(raw, "tenant_id");
  const canonicalProjectId = optionalString(raw, "canonical_project_id");
  const productId = optionalString(raw, "product_id");
  const producerId = optionalString(raw, "producer_id");
  const namespace = optionalString(raw, "namespace");
  const embeddingSpaceId = optionalString(raw, "embedding_space_id");
  const embeddingSpaceState = optionalString(raw, "embedding_space_state");
  const legacyQuarantineReason = optionalString(raw, "legacy_quarantine_reason");
  const scopeKey = optionalString(raw, "scope_key");
  const record: MarkdownWorksetNativeRecord = Object.freeze({
    id: requiredString(raw, "id"),
    sourceTable,
    text: typeof raw.text === "string" ? raw.text : fail("MARKDOWN_WORKSET_OPERATOR_INVALID_ROW"),
    contentHash: requiredString(raw, "content_hash"),
    vector: vector(raw.vector_text),
    importance,
    category: requiredString(raw, "category"),
    dataType,
    metadata: parsedMetadata(raw.metadata),
    createdAt: isoTimestamp(raw.created_at),
    ...(projectName !== undefined ? { projectName } : {}),
    ...(appName !== undefined ? { appName } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(canonicalProjectId !== undefined ? { canonicalProjectId } : {}),
    ...(productId !== undefined ? { productId } : {}),
    ...(producerId !== undefined ? { producerId } : {}),
    ...(namespace !== undefined ? { namespace } : {}),
    ...(visibility ? { visibility: visibility as "private" | "workspace" | "team" | "public" } : {}),
    ...(lifecycleStatus ? { lifecycleStatus: lifecycleStatus as
      "active" | "archived" | "revoked" | "superseded" | "promoted" } : {}),
    ...(embeddingSpaceId !== undefined ? { embeddingSpaceId } : {}),
    ...(embeddingSpaceState !== undefined ? { embeddingSpaceState } : {}),
    ...(legacyQuarantineReason !== undefined ? { legacyQuarantineReason } : {}),
    ...(scopeKey !== undefined ? { scopeKey } : {}),
  });
  const fingerprint = scopeFingerprint(record);
  return Object.freeze({
    record,
    ...(fingerprint ? { scopeFingerprint: fingerprint } : {}),
  });
}

function count(value: unknown): number {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail("MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT");
  return parsed;
}

function queryRows(value: unknown): readonly unknown[] {
  if (!plainRecord(value) || !Array.isArray(value.rows) || nodeUtilTypes.isProxy(value.rows)) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  }
  return value.rows;
}

export class PostgresMarkdownWorksetSnapshotSession implements MarkdownWorksetSnapshotSession {
  constructor(private readonly client: MarkdownWorksetPostgresQueryClient) {
    if (!client || typeof client.query !== "function") {
      fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
    }
  }

  async getSourceCounts(): Promise<MarkdownWorksetSnapshotCounts> {
    const result = await this.client.query(COUNTS_SQL);
    const rows = queryRows(result);
    const first = rows[0];
    if (rows.length !== 1 || !plainRecord(first)) {
      fail("MARKDOWN_WORKSET_OPERATOR_INVALID_COUNT");
    }
    return Object.freeze({
      memories: count(first.memories_count),
      knowledge: count(first.knowledge_count),
    });
  }

  async readPage(input: MarkdownWorksetSnapshotRead): Promise<MarkdownWorksetSnapshotPage> {
    if (!input || typeof input !== "object" || !SOURCE_TABLES.has(input.sourceTable) ||
        input.afterId !== undefined && (typeof input.afterId !== "string" || input.afterId.length === 0) ||
        !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > MAX_PAGE_SIZE) {
      fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
    }
    const result = await this.client.query(
      pageSql(input.sourceTable),
      [input.afterId ?? null, input.limit + 1],
    );
    const rawRows = queryRows(result);
    if (rawRows.length > input.limit + 1) fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
    const done = rawRows.length <= input.limit;
    const rows = Object.freeze(rawRows.slice(0, input.limit).map((raw) =>
      decodePostgresMarkdownWorksetRow(input.sourceTable, raw)));
    const nextAfterId = rows.at(-1)?.record.id;
    return Object.freeze({
      rows,
      done,
      ...(nextAfterId ? { nextAfterId } : {}),
    });
  }
}

export async function runPostgresMarkdownWorksetExport(
  input: RunPostgresMarkdownWorksetExportInput,
): Promise<ExportMarkdownWorksetResult> {
  if (!input || typeof input !== "object" || !input.client ||
      typeof input.client.query !== "function") fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  let result: ExportMarkdownWorksetResult | undefined;
  let failure: unknown;
  try {
    await input.client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    result = await exportMarkdownWorkset({
      containmentRoot: input.containmentRoot,
      outputDirectory: input.outputDirectory,
      migrationRunId: input.migrationRunId,
      policyVersion: input.policyVersion,
      createdAt: input.createdAt,
      pageSize: input.pageSize,
      writeConcurrency: input.writeConcurrency,
      snapshotSession: new PostgresMarkdownWorksetSnapshotSession(input.client),
    });
  } catch (error) {
    failure = error;
  }
  try {
    await input.client.query("ROLLBACK");
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  if (!result) fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  return result;
}

function strictDescendant(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

async function readRegularFileNoFollow(path: string): Promise<string> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
    return await handle.readFile("utf8");
  } catch (error) {
    if (error instanceof MarkdownWorksetOperatorError) throw error;
    if (["ELOOP", "EMLINK"].includes(errorCode(error) ?? "")) {
      fail("MARKDOWN_WORKSET_OPERATOR_SYMLINK");
    }
    fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  } finally {
    await handle?.close().catch(() => undefined);
  }
  return fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
}

async function assertNoSymlinkChain(root: string, relativePath: string): Promise<void> {
  let current = root;
  const parts = relativePath.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = resolve(current, parts[index]!);
    if (!strictDescendant(root, current)) fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
    let info;
    try {
      info = await lstat(current);
    } catch {
      fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
    }
    if (info.isSymbolicLink()) fail("MARKDOWN_WORKSET_OPERATOR_SYMLINK");
    if (index < parts.length - 1 && !info.isDirectory()) {
      fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
    }
  }
}

export async function loadMarkdownWorksetBundle(
  manifestPath: string,
  expectedManifestSha256?: string,
): Promise<LoadedMarkdownWorksetBundle> {
  if (typeof manifestPath !== "string" || !isAbsolute(manifestPath) ||
      resolve(manifestPath) !== manifestPath || dirname(manifestPath) === manifestPath ||
      expectedManifestSha256 !== undefined &&
        !/^[0-9a-f]{64}$/.test(expectedManifestSha256)) {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  }
  const directory = dirname(manifestPath);
  let directoryInfo;
  try {
    directoryInfo = await lstat(directory);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  }
  if (!directoryInfo.isDirectory()) fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  if (directoryInfo.isSymbolicLink()) fail("MARKDOWN_WORKSET_OPERATOR_SYMLINK");
  await assertNoSymlinkChain(directory, relative(directory, manifestPath));

  const serialized = await readRegularFileNoFollow(manifestPath);
  let manifest: MarkdownWorksetManifest;
  let manifestSha256: string;
  try {
    manifest = parseMarkdownWorksetManifest(serialized);
    manifestSha256 = markdownWorksetManifestSha256(serialized);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  }
  if (expectedManifestSha256 && manifestSha256 !== expectedManifestSha256) {
    fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  }

  const portablePaths = new Set<string>();
  const files: MarkdownWorksetFileInput[] = [];
  for (const entry of manifest.files) {
    const portablePath = entry.relativePath.normalize("NFC").toLowerCase();
    if (portablePaths.has(portablePath)) fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
    portablePaths.add(portablePath);
    const absolutePath = resolve(directory, entry.relativePath);
    if (!strictDescendant(directory, absolutePath)) fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
    await assertNoSymlinkChain(directory, entry.relativePath);
    const markdown = await readRegularFileNoFollow(absolutePath);
    files.push(Object.freeze({ relativePath: entry.relativePath, markdown }));
  }
  try {
    verifyMarkdownWorksetManifest(manifest, files);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_BUNDLE_DRIFT");
  }
  return Object.freeze({
    directory,
    manifestPath,
    manifestSha256,
    manifest,
    files: Object.freeze(files),
  });
}

async function assertFreshContainedOutput(
  containmentRoot: string,
  outputDirectory: string,
): Promise<void> {
  if (!isAbsolute(containmentRoot) || !isAbsolute(outputDirectory) ||
      resolve(containmentRoot) !== containmentRoot || resolve(outputDirectory) !== outputDirectory ||
      !strictDescendant(containmentRoot, outputDirectory)) {
    fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
  }
  let rootInfo;
  let parentInfo;
  try {
    [rootInfo, parentInfo] = await Promise.all([
      lstat(containmentRoot), lstat(dirname(outputDirectory)),
    ]);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() ||
      !parentInfo.isDirectory() || parentInfo.isSymbolicLink()) {
    fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
  }
  let realRoot: string;
  let realParent: string;
  try {
    [realRoot, realParent] = await Promise.all([
      realpath(containmentRoot), realpath(dirname(outputDirectory)),
    ]);
  } catch {
    fail("MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR");
  }
  if (realParent !== realRoot && !strictDescendant(realRoot, realParent)) {
    fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
  }
  try {
    await lstat(outputDirectory);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    fail("MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR");
  }
  fail("MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS");
}

async function createPrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
    await chmod(path, 0o700);
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS");
    fail("MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR");
  }
}

async function ensurePrivateDirectories(
  outputDirectory: string,
  relativePath: string,
  known: Set<string>,
): Promise<void> {
  let current = outputDirectory;
  const parts = dirname(relativePath).split("/").filter((part) => part !== ".");
  for (const part of parts) {
    current = resolve(current, part);
    if (!strictDescendant(outputDirectory, current)) fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
    if (known.has(current)) continue;
    await createPrivateDirectory(current);
    known.add(current);
  }
}

async function writeExclusivePrivate(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.chmod(0o600);
    await handle.sync();
  } catch (error) {
    if (errorCode(error) === "EEXIST") fail("MARKDOWN_WORKSET_OPERATOR_OUTPUT_EXISTS");
    if (error instanceof MarkdownWorksetOperatorError) throw error;
    fail("MARKDOWN_WORKSET_OPERATOR_FILESYSTEM_ERROR");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeGovernedMarkdownWorkset(
  input: WriteGovernedMarkdownWorksetInput,
): Promise<ExportMarkdownWorksetResult> {
  if (!input || typeof input !== "object" || !input.source ||
      typeof input.policyVersion !== "string") fail("MARKDOWN_WORKSET_OPERATOR_INVALID_INPUT");
  const source = await loadMarkdownWorksetBundle(
    input.source.manifestPath,
    input.source.manifestSha256,
  );
  if (input.outputDirectory === source.directory ||
      strictDescendant(source.directory, input.outputDirectory) ||
      strictDescendant(input.outputDirectory, source.directory)) {
    fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
  }
  const governed = governMarkdownWorkset({
    sourceManifest: source.manifest,
    sourceFiles: source.files,
    policyVersion: input.policyVersion,
  });
  await assertFreshContainedOutput(input.containmentRoot, input.outputDirectory);
  await createPrivateDirectory(input.outputDirectory);
  const known = new Set<string>([input.outputDirectory]);
  for (const file of governed.governedFiles) {
    await ensurePrivateDirectories(input.outputDirectory, file.relativePath, known);
    const absolutePath = resolve(input.outputDirectory, file.relativePath);
    if (!strictDescendant(input.outputDirectory, absolutePath)) {
      fail("MARKDOWN_WORKSET_OPERATOR_PATH_ESCAPE");
    }
    await writeExclusivePrivate(absolutePath, file.markdown);
  }
  const serialized = serializeMarkdownWorksetManifest(governed.governedManifest);
  const manifestPath = resolve(input.outputDirectory, "manifest.json");
  await writeExclusivePrivate(manifestPath, serialized);
  return Object.freeze({
    outputDirectory: input.outputDirectory,
    manifestPath,
    manifestSha256: markdownWorksetManifestSha256(serialized),
    manifest: governed.governedManifest,
  });
}
