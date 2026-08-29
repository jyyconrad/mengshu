import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { HistoricalSourceDisposition } from "./history-curation.js";

export const MARKDOWN_WORKSET_SCHEMA = "mengshu.native-record-markdown/v1" as const;
export const MARKDOWN_WORKSET_MANIFEST_SCHEMA = "mengshu.markdown-workset-manifest/v1" as const;

export type MarkdownWorksetPhase = "source" | "governed";
export type MarkdownWorksetSourceTable = "memories" | "knowledge";

export interface MarkdownWorksetNativeRecord {
  readonly id: string;
  readonly sourceTable: MarkdownWorksetSourceTable;
  readonly text: string;
  readonly contentHash: string;
  readonly vector: readonly number[];
  readonly importance: number | null;
  readonly category: string;
  /** 原样保存 legacy PostgreSQL data_type；正式 runtime DataType 不因此扩宽。 */
  readonly dataType: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly projectName?: string;
  readonly appName?: string;
  readonly userId?: string;
  readonly agentId?: string;
  readonly workspaceId?: string;
  readonly tenantId?: string;
  readonly canonicalProjectId?: string;
  readonly productId?: string;
  readonly producerId?: string;
  readonly namespace?: string;
  readonly visibility?: "private" | "workspace" | "team" | "public";
  readonly lifecycleStatus?: "active" | "archived" | "revoked" | "superseded" | "promoted";
  readonly embeddingSpaceId?: string;
  readonly embeddingSpaceState?: string;
  readonly legacyQuarantineReason?: string;
  readonly scopeKey?: string;
}

export interface MarkdownWorksetRecord {
  readonly schema: typeof MARKDOWN_WORKSET_SCHEMA;
  readonly phase: MarkdownWorksetPhase;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly scopeFingerprint?: string;
  readonly disposition?: HistoricalSourceDisposition;
  readonly canonicalTargetRef?: string;
  readonly mergedFrom: readonly string[];
  readonly policyVersion?: string;
  readonly record: MarkdownWorksetNativeRecord;
}

export interface CreateMarkdownWorksetRecordInput {
  readonly phase: MarkdownWorksetPhase;
  readonly scopeFingerprint?: string;
  readonly disposition?: HistoricalSourceDisposition;
  readonly canonicalTargetRef?: string;
  readonly mergedFrom?: readonly string[];
  readonly policyVersion?: string;
  readonly record: MarkdownWorksetNativeRecord;
}

export interface MarkdownWorksetFileInput {
  readonly relativePath: string;
  readonly markdown: string;
}

export interface MarkdownWorksetManifestFile {
  readonly relativePath: string;
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly markdownSha256: string;
}

export interface MarkdownWorksetManifest {
  readonly schema: typeof MARKDOWN_WORKSET_MANIFEST_SCHEMA;
  readonly migrationRunId: string;
  readonly phase: MarkdownWorksetPhase;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceCount: number;
  readonly snapshotSha256: string;
  readonly files: readonly MarkdownWorksetManifestFile[];
}

export interface CreateMarkdownWorksetManifestInput {
  readonly migrationRunId: string;
  readonly phase: MarkdownWorksetPhase;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly files: readonly MarkdownWorksetFileInput[];
}

export type MarkdownWorksetErrorCode =
  | "MARKDOWN_WORKSET_INVALID_INPUT"
  | "MARKDOWN_WORKSET_INVALID_MARKDOWN"
  | "MARKDOWN_WORKSET_CONTENT_DRIFT"
  | "MARKDOWN_WORKSET_DUPLICATE_SOURCE_REF"
  | "MARKDOWN_WORKSET_MANIFEST_DRIFT";

const ERROR_MESSAGES: Record<MarkdownWorksetErrorCode, string> = {
  MARKDOWN_WORKSET_INVALID_INPUT: "Markdown workset input is invalid",
  MARKDOWN_WORKSET_INVALID_MARKDOWN: "Markdown workset file is invalid",
  MARKDOWN_WORKSET_CONTENT_DRIFT: "Markdown workset content drifted from its envelope",
  MARKDOWN_WORKSET_DUPLICATE_SOURCE_REF: "Markdown workset source reference is duplicated",
  MARKDOWN_WORKSET_MANIFEST_DRIFT: "Markdown workset manifest drifted from its files",
};

export class MarkdownWorksetError extends Error {
  constructor(readonly code: MarkdownWorksetErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "MarkdownWorksetError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,4096}\.md$/;
const SOURCE_TABLES = new Set<MarkdownWorksetSourceTable>(["memories", "knowledge"]);
const PHASES = new Set<MarkdownWorksetPhase>(["source", "governed"]);
const VISIBILITIES = new Set(["private", "workspace", "team", "public"]);
const LIFECYCLE_STATUSES = new Set(["active", "archived", "revoked", "superseded", "promoted"]);
const DISPOSITIONS = new Set<HistoricalSourceDisposition>([
  "canonical_keep",
  "merge_exact",
  "merge_semantic",
  "supersede",
  "archive_stale",
  "lookup_only",
  "quarantine",
  "distinct_keep",
]);
const PREVIEW_MARKER = /^<!-- mengshu-content-preview-bytes: ([0-9]+) -->\n/;

function fail(code: MarkdownWorksetErrorCode): never {
  throw new MarkdownWorksetError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value === value.trim() &&
    value === value.normalize("NFC") && SAFE_TEXT.test(value);
}

function optionalSafeText(value: unknown): value is string | undefined {
  return value === undefined || value === "" || safeText(value);
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("MARKDOWN_WORKSET_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("MARKDOWN_WORKSET_INVALID_INPUT");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("MARKDOWN_WORKSET_INVALID_INPUT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("MARKDOWN_WORKSET_INVALID_INPUT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizePreview(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function validateNativeRecord(value: unknown): asserts value is MarkdownWorksetNativeRecord {
  if (!plainRecord(value) || !safeText(value.id) ||
      typeof value.sourceTable !== "string" ||
      !SOURCE_TABLES.has(value.sourceTable as MarkdownWorksetSourceTable) ||
      typeof value.text !== "string" || !safeText(value.contentHash) ||
      !Array.isArray(value.vector) || nodeUtilTypes.isProxy(value.vector) || value.vector.length === 0 ||
      value.vector.some((item) => typeof item !== "number" || !Number.isFinite(item)) ||
      (value.importance !== null &&
        (typeof value.importance !== "number" || !Number.isFinite(value.importance) ||
          value.importance < 0 || value.importance > 1)) || !safeText(value.category) ||
      !safeText(value.dataType) ||
      !plainRecord(value.metadata) || !validIso(value.createdAt)) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  stableJson(value.metadata);
  const optional = ["projectName", "appName", "userId", "agentId", "workspaceId",
    "tenantId", "canonicalProjectId", "productId", "producerId", "namespace",
    "embeddingSpaceId", "embeddingSpaceState", "legacyQuarantineReason", "scopeKey"];
  if (optional.some((field) => !optionalSafeText(value[field]))) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  if (value.visibility !== undefined &&
      (typeof value.visibility !== "string" || !VISIBILITIES.has(value.visibility))) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  if (value.lifecycleStatus !== undefined &&
      (typeof value.lifecycleStatus !== "string" || !LIFECYCLE_STATUSES.has(value.lifecycleStatus))) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
}

function sourceRef(record: MarkdownWorksetNativeRecord): string {
  return `${record.sourceTable}:${record.id}`;
}

function normalizeRefs(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      value.some((item) => !safeText(item)) || new Set(value).size !== value.length) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  return Object.freeze([...value].sort((left, right) => left.localeCompare(right)));
}

export function createMarkdownWorksetRecord(
  input: CreateMarkdownWorksetRecordInput,
): MarkdownWorksetRecord {
  if (!plainRecord(input) || typeof input.phase !== "string" ||
      !PHASES.has(input.phase as MarkdownWorksetPhase)) fail("MARKDOWN_WORKSET_INVALID_INPUT");
  validateNativeRecord(input.record);
  if (input.scopeFingerprint !== undefined &&
      (typeof input.scopeFingerprint !== "string" || !SHA256.test(input.scopeFingerprint))) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  const governedFields = input.disposition !== undefined || input.canonicalTargetRef !== undefined ||
    input.policyVersion !== undefined || (input.mergedFrom?.length ?? 0) > 0;
  if (input.phase === "source" && governedFields) fail("MARKDOWN_WORKSET_INVALID_INPUT");
  if (input.phase === "governed" &&
      (typeof input.disposition !== "string" || !DISPOSITIONS.has(input.disposition) ||
        !safeText(input.policyVersion))) fail("MARKDOWN_WORKSET_INVALID_INPUT");
  if (!optionalSafeText(input.canonicalTargetRef)) fail("MARKDOWN_WORKSET_INVALID_INPUT");

  const record = stableValue(input.record) as MarkdownWorksetNativeRecord;
  return Object.freeze({
    schema: MARKDOWN_WORKSET_SCHEMA,
    phase: input.phase,
    sourceRef: sourceRef(record),
    sourceHash: sha256(stableJson(record)),
    ...(input.scopeFingerprint ? { scopeFingerprint: input.scopeFingerprint } : {}),
    ...(input.disposition ? { disposition: input.disposition } : {}),
    ...(input.canonicalTargetRef ? { canonicalTargetRef: input.canonicalTargetRef } : {}),
    mergedFrom: normalizeRefs(input.mergedFrom),
    ...(input.policyVersion ? { policyVersion: input.policyVersion } : {}),
    record,
  });
}

function headerValue(value: string | undefined): string {
  return value ?? "none";
}

export function renderNativeRecordMarkdown(value: MarkdownWorksetRecord): string {
  const record = createMarkdownWorksetRecord({
    phase: value.phase,
    scopeFingerprint: value.scopeFingerprint,
    disposition: value.disposition,
    canonicalTargetRef: value.canonicalTargetRef,
    mergedFrom: value.mergedFrom,
    policyVersion: value.policyVersion,
    record: value.record,
  });
  if (record.sourceHash !== value.sourceHash || record.sourceRef !== value.sourceRef) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  const envelope = Buffer.from(stableJson(record.record), "utf8").toString("base64url");
  const preview = normalizePreview(record.record.text);
  const previewBytes = Buffer.byteLength(preview, "utf8");
  return [
    "---",
    `mengshu_workset_schema: ${record.schema}`,
    `mengshu_phase: ${record.phase}`,
    `mengshu_source_ref: ${record.sourceRef}`,
    `mengshu_source_hash: ${record.sourceHash}`,
    `mengshu_scope_fingerprint: ${headerValue(record.scopeFingerprint)}`,
    `mengshu_disposition: ${headerValue(record.disposition)}`,
    `mengshu_canonical_target_ref: ${headerValue(record.canonicalTargetRef)}`,
    `mengshu_policy_version: ${headerValue(record.policyVersion)}`,
    `mengshu_merged_from: ${Buffer.from(stableJson(record.mergedFrom), "utf8").toString("base64url")}`,
    "mengshu_envelope_encoding: base64url-json",
    `mengshu_envelope: ${envelope}`,
    "---",
    `<!-- mengshu-content-preview-bytes: ${previewBytes} -->`,
    preview,
  ].join("\n");
}

function parseHeaders(markdown: string): { headers: Readonly<Record<string, string>>; body: string } {
  if (!markdown.startsWith("---\n")) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  const headers: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
    const key = line.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(headers, key)) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
    headers[key] = line.slice(separator + 2);
  }
  return { headers: Object.freeze(headers), body: markdown.slice(end + 5) };
}

function optionalHeader(value: string | undefined): string | undefined {
  if (value === undefined) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  return value === "none" ? undefined : value;
}

export function parseNativeRecordMarkdown(markdown: string): MarkdownWorksetRecord {
  if (typeof markdown !== "string") fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  const { headers, body } = parseHeaders(markdown);
  const required = ["mengshu_workset_schema", "mengshu_phase", "mengshu_source_ref",
    "mengshu_source_hash", "mengshu_scope_fingerprint", "mengshu_disposition",
    "mengshu_canonical_target_ref", "mengshu_policy_version", "mengshu_merged_from",
    "mengshu_envelope_encoding", "mengshu_envelope"];
  if (Object.keys(headers).length !== required.length ||
      required.some((key) => !Object.prototype.hasOwnProperty.call(headers, key)) ||
      headers.mengshu_workset_schema !== MARKDOWN_WORKSET_SCHEMA ||
      headers.mengshu_envelope_encoding !== "base64url-json") {
    fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  }
  let record: unknown;
  let mergedFrom: unknown;
  try {
    record = JSON.parse(Buffer.from(headers.mengshu_envelope!, "base64url").toString("utf8"));
    mergedFrom = JSON.parse(Buffer.from(headers.mengshu_merged_from!, "base64url").toString("utf8"));
  } catch {
    fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  }
  if (!Array.isArray(mergedFrom)) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  const parsed = createMarkdownWorksetRecord({
    phase: headers.mengshu_phase as MarkdownWorksetPhase,
    scopeFingerprint: optionalHeader(headers.mengshu_scope_fingerprint),
    disposition: optionalHeader(headers.mengshu_disposition) as HistoricalSourceDisposition | undefined,
    canonicalTargetRef: optionalHeader(headers.mengshu_canonical_target_ref),
    policyVersion: optionalHeader(headers.mengshu_policy_version),
    mergedFrom: mergedFrom as string[],
    record: record as MarkdownWorksetNativeRecord,
  });
  if (headers.mengshu_source_ref !== parsed.sourceRef ||
      headers.mengshu_source_hash !== parsed.sourceHash) fail("MARKDOWN_WORKSET_CONTENT_DRIFT");

  const marker = PREVIEW_MARKER.exec(body);
  if (!marker) fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  const expectedLength = Number(marker[1]);
  if (!Number.isSafeInteger(expectedLength) || expectedLength < 0) {
    fail("MARKDOWN_WORKSET_INVALID_MARKDOWN");
  }
  const prefixBytes = Buffer.byteLength(marker[0], "utf8");
  const bodyBuffer = Buffer.from(body, "utf8");
  const previewBuffer = bodyBuffer.subarray(prefixBytes, prefixBytes + expectedLength);
  if (previewBuffer.length !== expectedLength || prefixBytes + expectedLength !== bodyBuffer.length ||
      previewBuffer.toString("utf8") !== normalizePreview(parsed.record.text)) {
    fail("MARKDOWN_WORKSET_CONTENT_DRIFT");
  }
  return parsed;
}

export function markdownWorksetSnapshotSha256(
  records: readonly MarkdownWorksetRecord[],
): string {
  if (!Array.isArray(records) || nodeUtilTypes.isProxy(records)) fail("MARKDOWN_WORKSET_INVALID_INPUT");
  const seen = new Set<string>();
  const lines = records.map((record) => {
    const parsed = parseNativeRecordMarkdown(renderNativeRecordMarkdown(record));
    if (seen.has(parsed.sourceRef)) fail("MARKDOWN_WORKSET_DUPLICATE_SOURCE_REF");
    seen.add(parsed.sourceRef);
    return `${parsed.sourceRef}\u001f${parsed.sourceHash}`;
  }).sort((left, right) => left.localeCompare(right));
  return sha256(lines.join("\n"));
}

function validateManifestIdentity(value: unknown): value is string {
  return safeText(value);
}

export function createMarkdownWorksetManifest(
  input: CreateMarkdownWorksetManifestInput,
): MarkdownWorksetManifest {
  if (!plainRecord(input) || !validateManifestIdentity(input.migrationRunId) ||
      typeof input.phase !== "string" || !PHASES.has(input.phase as MarkdownWorksetPhase) ||
      !validateManifestIdentity(input.policyVersion) || !validIso(input.createdAt) ||
      !Array.isArray(input.files) || nodeUtilTypes.isProxy(input.files)) {
    fail("MARKDOWN_WORKSET_INVALID_INPUT");
  }
  const paths = new Set<string>();
  const records: MarkdownWorksetRecord[] = [];
  const files = input.files.map((file): MarkdownWorksetManifestFile => {
    if (!plainRecord(file) || typeof file.relativePath !== "string" ||
        !SAFE_PATH.test(file.relativePath) || paths.has(file.relativePath) ||
        typeof file.markdown !== "string") fail("MARKDOWN_WORKSET_INVALID_INPUT");
    paths.add(file.relativePath);
    const record = parseNativeRecordMarkdown(file.markdown);
    if (record.phase !== input.phase) fail("MARKDOWN_WORKSET_INVALID_INPUT");
    records.push(record);
    return Object.freeze({
      relativePath: file.relativePath,
      sourceRef: record.sourceRef,
      sourceHash: record.sourceHash,
      markdownSha256: sha256(file.markdown),
    });
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return Object.freeze({
    schema: MARKDOWN_WORKSET_MANIFEST_SCHEMA,
    migrationRunId: input.migrationRunId,
    phase: input.phase,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    sourceCount: records.length,
    snapshotSha256: markdownWorksetSnapshotSha256(records),
    files: Object.freeze(files),
  });
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index]);
}

function snapshotSha256FromManifestFiles(
  files: readonly Pick<MarkdownWorksetManifestFile, "sourceRef" | "sourceHash">[],
): string {
  const seen = new Set<string>();
  const lines = files.map((file) => {
    if (seen.has(file.sourceRef)) fail("MARKDOWN_WORKSET_DUPLICATE_SOURCE_REF");
    seen.add(file.sourceRef);
    return `${file.sourceRef}\u001f${file.sourceHash}`;
  }).sort((left, right) => left.localeCompare(right));
  return sha256(lines.join("\n"));
}

function validateManifestShape(value: unknown): asserts value is MarkdownWorksetManifest {
  if (!plainRecord(value) || !exactKeys(value, [
    "schema", "migrationRunId", "phase", "policyVersion", "createdAt",
    "sourceCount", "snapshotSha256", "files",
  ]) || value.schema !== MARKDOWN_WORKSET_MANIFEST_SCHEMA ||
      !validateManifestIdentity(value.migrationRunId) ||
      typeof value.phase !== "string" || !PHASES.has(value.phase as MarkdownWorksetPhase) ||
      !validateManifestIdentity(value.policyVersion) || !validIso(value.createdAt) ||
      !Number.isSafeInteger(value.sourceCount) || (value.sourceCount as number) < 0 ||
      typeof value.snapshotSha256 !== "string" || !SHA256.test(value.snapshotSha256) ||
      !Array.isArray(value.files) || nodeUtilTypes.isProxy(value.files) ||
      value.files.length !== value.sourceCount) {
    fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  }
  const paths = new Set<string>();
  let previousPath: string | undefined;
  for (const file of value.files) {
    if (!plainRecord(file) || !exactKeys(file, [
      "relativePath", "sourceRef", "sourceHash", "markdownSha256",
    ]) || typeof file.relativePath !== "string" || !SAFE_PATH.test(file.relativePath) ||
        paths.has(file.relativePath) || !safeText(file.sourceRef) ||
        typeof file.sourceHash !== "string" || !SHA256.test(file.sourceHash) ||
        typeof file.markdownSha256 !== "string" || !SHA256.test(file.markdownSha256) ||
        previousPath !== undefined && previousPath.localeCompare(file.relativePath) >= 0) {
      fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
    }
    paths.add(file.relativePath);
    previousPath = file.relativePath;
  }
  let snapshot: string;
  try {
    snapshot = snapshotSha256FromManifestFiles(value.files);
  } catch {
    fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  }
  if (snapshot !== value.snapshotSha256) fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
}

export function serializeMarkdownWorksetManifest(
  manifest: MarkdownWorksetManifest,
): string {
  validateManifestShape(manifest);
  return `${JSON.stringify(stableValue(manifest), null, 2)}\n`;
}

export function parseMarkdownWorksetManifest(serialized: string): MarkdownWorksetManifest {
  if (typeof serialized !== "string") fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  }
  validateManifestShape(value);
  return stableValue(value) as MarkdownWorksetManifest;
}

export function markdownWorksetManifestSha256(serialized: string): string {
  parseMarkdownWorksetManifest(serialized);
  return sha256(serialized);
}

export function verifyMarkdownWorksetManifest(
  manifest: MarkdownWorksetManifest,
  files: readonly MarkdownWorksetFileInput[],
): Readonly<{ sourceCount: number; verifiedCount: number; snapshotSha256: string }> {
  let rebuilt: MarkdownWorksetManifest;
  try {
    rebuilt = createMarkdownWorksetManifest({
      migrationRunId: manifest.migrationRunId,
      phase: manifest.phase,
      policyVersion: manifest.policyVersion,
      createdAt: manifest.createdAt,
      files,
    });
  } catch {
    fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  }
  if (manifest.schema !== MARKDOWN_WORKSET_MANIFEST_SCHEMA ||
      manifest.sourceCount !== rebuilt.sourceCount ||
      manifest.snapshotSha256 !== rebuilt.snapshotSha256 ||
      stableJson(manifest.files) !== stableJson(rebuilt.files)) {
    fail("MARKDOWN_WORKSET_MANIFEST_DRIFT");
  }
  return Object.freeze({
    sourceCount: rebuilt.sourceCount,
    verifiedCount: rebuilt.files.length,
    snapshotSha256: rebuilt.snapshotSha256,
  });
}
