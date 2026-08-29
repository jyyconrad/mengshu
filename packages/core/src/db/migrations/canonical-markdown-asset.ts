import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemorySemanticType } from "../../domain/types.js";

export const CANONICAL_MARKDOWN_ASSET_SCHEMA =
  "mengshu.canonical-markdown-asset/v1" as const;
export const CANONICAL_MARKDOWN_ASSET_MANIFEST_SCHEMA =
  "mengshu.canonical-markdown-asset-manifest/v1" as const;

export type CanonicalMarkdownAssetKind = "memory" | "knowledge";
export type CanonicalMarkdownAssetRecordKind = "record" | "chunk";

export interface CanonicalMarkdownAssetRevision {
  readonly id: string;
  readonly order: number;
}

export interface CanonicalMarkdownAssetRecord {
  readonly recordId: string;
  readonly recordKind: CanonicalMarkdownAssetRecordKind;
  readonly text: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface CanonicalMarkdownSourceBinding {
  readonly sourceRef: string;
  readonly sourceHash: string;
}

export interface CanonicalMarkdownAsset {
  readonly schema: typeof CANONICAL_MARKDOWN_ASSET_SCHEMA;
  readonly assetId: string;
  readonly kind: CanonicalMarkdownAssetKind;
  readonly scopeFingerprint: string;
  readonly semanticType?: MemorySemanticType;
  readonly logicalSource?: string;
  readonly revision?: CanonicalMarkdownAssetRevision;
  readonly sourceBindings: readonly CanonicalMarkdownSourceBinding[];
  readonly policyVersion: string;
  readonly contentHash: string;
  readonly records: readonly CanonicalMarkdownAssetRecord[];
}

export interface CreateCanonicalMarkdownAssetInput {
  readonly kind: CanonicalMarkdownAssetKind;
  readonly scopeFingerprint: string;
  readonly semanticType?: MemorySemanticType;
  readonly logicalSource?: string;
  readonly revision?: CanonicalMarkdownAssetRevision;
  readonly sourceBindings: readonly CanonicalMarkdownSourceBinding[];
  readonly policyVersion: string;
  readonly records: readonly CanonicalMarkdownAssetRecord[];
}

export interface CanonicalMarkdownAssetFileInput {
  readonly relativePath: string;
  readonly markdown: string;
}

export interface CanonicalMarkdownAssetManifestFile {
  readonly relativePath: string;
  readonly assetId: string;
  readonly kind: CanonicalMarkdownAssetKind;
  readonly scopeFingerprint: string;
  readonly contentHash: string;
  readonly sourceBindings: readonly CanonicalMarkdownSourceBinding[];
  readonly markdownSha256: string;
}

export interface CanonicalMarkdownAssetManifest {
  readonly schema: typeof CANONICAL_MARKDOWN_ASSET_MANIFEST_SCHEMA;
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceCount: number;
  readonly mappedCount: number;
  readonly assetCount: number;
  readonly archiveCount: number;
  readonly quarantineCount: number;
  readonly sourceSnapshotSha256: string;
  readonly files: readonly CanonicalMarkdownAssetManifestFile[];
}

export interface CreateCanonicalMarkdownAssetManifestInput {
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceCount: number;
  readonly archiveCount: number;
  readonly quarantineCount: number;
  readonly sourceSnapshotSha256: string;
  readonly files: readonly CanonicalMarkdownAssetFileInput[];
}

export type CanonicalMarkdownAssetErrorCode =
  | "CANONICAL_MARKDOWN_ASSET_INVALID_INPUT"
  | "CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN"
  | "CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT"
  | "CANONICAL_MARKDOWN_ASSET_HASH_DRIFT"
  | "CANONICAL_MARKDOWN_ASSET_CONTENT_DRIFT"
  | "CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT";

const ERROR_MESSAGES: Record<CanonicalMarkdownAssetErrorCode, string> = {
  CANONICAL_MARKDOWN_ASSET_INVALID_INPUT: "Canonical Markdown asset input is invalid",
  CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN: "Canonical Markdown asset is invalid",
  CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT: "Canonical Markdown asset envelope drifted",
  CANONICAL_MARKDOWN_ASSET_HASH_DRIFT: "Canonical Markdown asset identity or hash drifted",
  CANONICAL_MARKDOWN_ASSET_CONTENT_DRIFT: "Canonical Markdown asset readable content drifted",
  CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT: "Canonical Markdown asset manifest drifted",
};

export class CanonicalMarkdownAssetError extends Error {
  constructor(readonly code: CanonicalMarkdownAssetErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "CanonicalMarkdownAssetError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const ASSET_ID = /^canonical_(?:memory|knowledge)_[0-9a-f]{32}$/;
const SAFE_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,1022}[^\s\p{Cc}])?$/u;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)[^\u0000-\u001f\u007f]{1,4096}\.md$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const ASSET_KINDS = new Set<CanonicalMarkdownAssetKind>(["memory", "knowledge"]);
const RECORD_KINDS = new Set<CanonicalMarkdownAssetRecordKind>(["record", "chunk"]);
const ASSET_INPUT_KEYS = [
  "kind", "scopeFingerprint", "semanticType", "logicalSource", "revision",
  "sourceBindings", "policyVersion", "records",
] as const;
const ASSET_KEYS = [
  "schema", "assetId", "kind", "scopeFingerprint", "semanticType", "logicalSource",
  "revision", "sourceBindings", "policyVersion", "contentHash", "records",
] as const;
const HEADERS = [
  "mengshu_asset_schema", "mengshu_asset_kind", "mengshu_asset_id",
  "mengshu_scope_fingerprint", "mengshu_semantic_type", "mengshu_logical_source",
  "mengshu_revision", "mengshu_source_bindings",
  "mengshu_policy_version", "mengshu_content_hash", "mengshu_envelope_encoding",
  "mengshu_envelope",
] as const;

function fail(code: CanonicalMarkdownAssetErrorCode): never {
  throw new CanonicalMarkdownAssetError(code);
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactAllowedKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  required: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) &&
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value === value.normalize("NFC") && SAFE_TEXT.test(value);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") {
      fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
    }
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

function normalizedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function normalizedStrings(
  value: unknown,
  validator: (item: unknown) => item is string,
  unique: boolean,
): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.some((item) => !validator(item)) || unique && new Set(value).size !== value.length) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  return Object.freeze([...value].sort((left, right) => left.localeCompare(right)));
}

function normalizeSourceBindings(value: unknown): readonly CanonicalMarkdownSourceBinding[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  const refs = new Set<string>();
  const bindings = value.map((item): CanonicalMarkdownSourceBinding => {
    if (!plainRecord(item) || !exactKeys(item, ["sourceRef", "sourceHash"]) ||
        !safeText(item.sourceRef) || typeof item.sourceHash !== "string" ||
        !SHA256.test(item.sourceHash) || refs.has(item.sourceRef)) {
      fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
    }
    refs.add(item.sourceRef);
    return Object.freeze({ sourceRef: item.sourceRef, sourceHash: item.sourceHash });
  });
  return Object.freeze(bindings.sort((left, right) => left.sourceRef.localeCompare(right.sourceRef)));
}

function normalizeRevision(value: unknown): CanonicalMarkdownAssetRevision | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value) || !exactKeys(value, ["id", "order"]) || !safeText(value.id) ||
      !Number.isSafeInteger(value.order) || (value.order as number) < 0) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  return Object.freeze({ id: value.id, order: value.order as number });
}

function normalizeRecords(value: unknown): readonly CanonicalMarkdownAssetRecord[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  const seen = new Set<string>();
  const records = value.map((item): CanonicalMarkdownAssetRecord => {
    if (!plainRecord(item) || !exactKeys(item, ["recordId", "recordKind", "text", "metadata"]) ||
        !safeText(item.recordId) || typeof item.recordKind !== "string" ||
        !RECORD_KINDS.has(item.recordKind as CanonicalMarkdownAssetRecordKind) ||
        !plainRecord(item.metadata) || seen.has(item.recordId)) {
      fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
    }
    seen.add(item.recordId);
    return Object.freeze({
      recordId: item.recordId,
      recordKind: item.recordKind as CanonicalMarkdownAssetRecordKind,
      text: normalizedText(item.text),
      metadata: stableValue(item.metadata) as Readonly<Record<string, unknown>>,
    });
  });
  return Object.freeze(records.sort((left, right) => left.recordId.localeCompare(right.recordId)));
}

function contentHash(records: readonly CanonicalMarkdownAssetRecord[]): string {
  return sha256(`mengshu.canonical-markdown-asset-content/v1\0${stableJson(records)}`);
}

function assetId(
  value: Omit<CanonicalMarkdownAsset, "schema" | "assetId">,
): string {
  const digest = sha256(`mengshu.canonical-markdown-asset-identity/v1\0${stableJson(value)}`);
  return `canonical_${value.kind}_${digest.slice(0, 32)}`;
}

export function createCanonicalMarkdownAsset(
  input: CreateCanonicalMarkdownAssetInput,
): CanonicalMarkdownAsset {
  if (!plainRecord(input) || !exactAllowedKeys(input, ASSET_INPUT_KEYS, [
    "kind", "scopeFingerprint", "sourceBindings", "policyVersion", "records",
  ]) || typeof input.kind !== "string" ||
      !ASSET_KINDS.has(input.kind as CanonicalMarkdownAssetKind) ||
      typeof input.scopeFingerprint !== "string" || !SHA256.test(input.scopeFingerprint) ||
      !safeText(input.policyVersion) ||
      input.semanticType !== undefined &&
        (typeof input.semanticType !== "string" ||
          !SEMANTIC_TYPES.has(input.semanticType as MemorySemanticType)) ||
      input.logicalSource !== undefined && !safeText(input.logicalSource)) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  if (input.kind === "memory" && (!input.semanticType || input.logicalSource !== undefined ||
      input.revision !== undefined)) fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  if (input.kind === "knowledge" &&
      (input.logicalSource === undefined) !== (input.revision === undefined)) {
    fail("CANONICAL_MARKDOWN_ASSET_INVALID_INPUT");
  }
  const revision = normalizeRevision(input.revision);
  const sourceBindings = normalizeSourceBindings(input.sourceBindings);
  const records = normalizeRecords(input.records);
  const hash = contentHash(records);
  const identity = Object.freeze({
    kind: input.kind as CanonicalMarkdownAssetKind,
    scopeFingerprint: input.scopeFingerprint,
    ...(input.semanticType ? { semanticType: input.semanticType } : {}),
    ...(input.logicalSource ? { logicalSource: input.logicalSource } : {}),
    ...(revision ? { revision } : {}),
    sourceBindings,
    policyVersion: input.policyVersion,
    contentHash: hash,
    records,
  });
  return Object.freeze({
    schema: CANONICAL_MARKDOWN_ASSET_SCHEMA,
    assetId: assetId(identity),
    ...identity,
  });
}

function validateAsset(value: CanonicalMarkdownAsset): CanonicalMarkdownAsset {
  const rebuilt = createCanonicalMarkdownAsset({
    kind: value.kind,
    scopeFingerprint: value.scopeFingerprint,
    semanticType: value.semanticType,
    logicalSource: value.logicalSource,
    revision: value.revision,
    sourceBindings: value.sourceBindings,
    policyVersion: value.policyVersion,
    records: value.records,
  });
  if (value.schema !== rebuilt.schema || value.assetId !== rebuilt.assetId ||
      value.contentHash !== rebuilt.contentHash || stableJson(value) !== stableJson(rebuilt)) {
    fail("CANONICAL_MARKDOWN_ASSET_HASH_DRIFT");
  }
  return rebuilt;
}

function encodedJson(value: unknown): string {
  return Buffer.from(stableJson(value), "utf8").toString("base64url");
}

function readableBody(asset: CanonicalMarkdownAsset): string {
  const lines = [
    `# Canonical ${asset.kind === "memory" ? "Memory" : "Knowledge"} Asset`,
    "",
    `- Asset ID: ${asset.assetId}`,
    `- Scope: ${asset.scopeFingerprint}`,
    `- Sources: ${asset.sourceBindings.length}`,
  ];
  if (asset.semanticType) lines.push(`- Semantic Type: ${asset.semanticType}`);
  if (asset.logicalSource) lines.push(`- Logical Source: ${asset.logicalSource}`);
  for (const record of asset.records) {
    lines.push(
      "",
      `## ${record.recordKind}: ${record.recordId}`,
      `<!-- mengshu-record-text-bytes: ${Buffer.byteLength(record.text, "utf8")} -->`,
      record.text,
    );
  }
  return lines.join("\n");
}

export function renderCanonicalMarkdownAsset(value: CanonicalMarkdownAsset): string {
  const asset = validateAsset(value);
  return [
    "---",
    `mengshu_asset_schema: ${asset.schema}`,
    `mengshu_asset_kind: ${asset.kind}`,
    `mengshu_asset_id: ${asset.assetId}`,
    `mengshu_scope_fingerprint: ${asset.scopeFingerprint}`,
    `mengshu_semantic_type: ${asset.semanticType ?? "none"}`,
    `mengshu_logical_source: ${encodedJson(asset.logicalSource ?? null)}`,
    `mengshu_revision: ${encodedJson(asset.revision ?? null)}`,
    `mengshu_source_bindings: ${encodedJson(asset.sourceBindings)}`,
    `mengshu_policy_version: ${asset.policyVersion}`,
    `mengshu_content_hash: ${asset.contentHash}`,
    "mengshu_envelope_encoding: base64url-json",
    `mengshu_envelope: ${encodedJson(asset)}`,
    "---",
    readableBody(asset),
  ].join("\n");
}

function parseHeaders(markdown: string): {
  headers: Readonly<Record<string, string>>;
  body: string;
} {
  if (!markdown.startsWith("---\n")) fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
  const headers: Record<string, string> = {};
  for (const line of markdown.slice(4, end).split("\n")) {
    const separator = line.indexOf(": ");
    if (separator <= 0) fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
    const key = line.slice(0, separator);
    if (Object.prototype.hasOwnProperty.call(headers, key)) {
      fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
    }
    headers[key] = line.slice(separator + 2);
  }
  if (!exactKeys(headers, HEADERS)) fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
  return { headers: Object.freeze(headers), body: markdown.slice(end + 5) };
}

function decodeJson(value: string | undefined): unknown {
  if (!value || !BASE64URL.test(value)) fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
  try {
    const buffer = Buffer.from(value, "base64url");
    if (buffer.toString("base64url") !== value) fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (error instanceof CanonicalMarkdownAssetError) throw error;
    fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
  }
}

function assetFromEnvelope(value: unknown): CanonicalMarkdownAsset {
  if (!plainRecord(value) || !exactAllowedKeys(value, ASSET_KEYS, [
    "schema", "assetId", "kind", "scopeFingerprint", "sourceBindings",
    "policyVersion", "contentHash", "records",
  ]) || value.schema !== CANONICAL_MARKDOWN_ASSET_SCHEMA ||
      typeof value.assetId !== "string" || !ASSET_ID.test(value.assetId) ||
      typeof value.contentHash !== "string" || !SHA256.test(value.contentHash)) {
    fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
  }
  let rebuilt: CanonicalMarkdownAsset;
  try {
    rebuilt = createCanonicalMarkdownAsset({
      kind: value.kind as CanonicalMarkdownAssetKind,
      scopeFingerprint: value.scopeFingerprint as string,
      semanticType: value.semanticType as MemorySemanticType | undefined,
      logicalSource: value.logicalSource as string | undefined,
      revision: value.revision as CanonicalMarkdownAssetRevision | undefined,
      sourceBindings: value.sourceBindings as readonly CanonicalMarkdownSourceBinding[],
      policyVersion: value.policyVersion as string,
      records: value.records as readonly CanonicalMarkdownAssetRecord[],
    });
  } catch {
    fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
  }
  if (rebuilt.assetId !== value.assetId || rebuilt.contentHash !== value.contentHash ||
      stableJson(rebuilt) !== stableJson(value)) fail("CANONICAL_MARKDOWN_ASSET_HASH_DRIFT");
  return rebuilt;
}

export function parseCanonicalMarkdownAsset(markdown: string): CanonicalMarkdownAsset {
  if (typeof markdown !== "string") fail("CANONICAL_MARKDOWN_ASSET_INVALID_MARKDOWN");
  const { headers, body } = parseHeaders(markdown);
  if (headers.mengshu_envelope_encoding !== "base64url-json") {
    fail("CANONICAL_MARKDOWN_ASSET_ENVELOPE_DRIFT");
  }
  const asset = assetFromEnvelope(decodeJson(headers.mengshu_envelope));
  if (headers.mengshu_asset_schema !== asset.schema ||
      headers.mengshu_asset_kind !== asset.kind || headers.mengshu_asset_id !== asset.assetId ||
      headers.mengshu_scope_fingerprint !== asset.scopeFingerprint ||
      headers.mengshu_semantic_type !== (asset.semanticType ?? "none") ||
      headers.mengshu_logical_source !== encodedJson(asset.logicalSource ?? null) ||
      headers.mengshu_revision !== encodedJson(asset.revision ?? null) ||
      headers.mengshu_source_bindings !== encodedJson(asset.sourceBindings) ||
      headers.mengshu_policy_version !== asset.policyVersion ||
      headers.mengshu_content_hash !== asset.contentHash) {
    fail("CANONICAL_MARKDOWN_ASSET_HASH_DRIFT");
  }
  if (body !== readableBody(asset)) fail("CANONICAL_MARKDOWN_ASSET_CONTENT_DRIFT");
  return asset;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function createCanonicalMarkdownAssetManifest(
  input: CreateCanonicalMarkdownAssetManifestInput,
): CanonicalMarkdownAssetManifest {
  if (!plainRecord(input) || !safeText(input.governanceRunId) ||
      !safeText(input.policyVersion) || !validIso(input.createdAt) ||
      !nonNegativeInteger(input.sourceCount) || !nonNegativeInteger(input.archiveCount) ||
      !nonNegativeInteger(input.quarantineCount) ||
      typeof input.sourceSnapshotSha256 !== "string" || !SHA256.test(input.sourceSnapshotSha256) ||
      !Array.isArray(input.files) || nodeUtilTypes.isProxy(input.files)) {
    fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  }
  const paths = new Set<string>();
  const assetIds = new Set<string>();
  const mappedSources = new Set<string>();
  const files = input.files.map((file): CanonicalMarkdownAssetManifestFile => {
    if (!plainRecord(file) || !exactKeys(file, ["relativePath", "markdown"]) ||
        typeof file.relativePath !== "string" || !SAFE_PATH.test(file.relativePath) ||
        typeof file.markdown !== "string") fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
    const portablePath = file.relativePath.normalize("NFC").toLowerCase();
    if (paths.has(portablePath)) fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
    paths.add(portablePath);
    const asset = parseCanonicalMarkdownAsset(file.markdown);
    if (asset.policyVersion !== input.policyVersion || assetIds.has(asset.assetId) ||
        asset.sourceBindings.some(({ sourceRef }) => mappedSources.has(sourceRef))) {
      fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
    }
    assetIds.add(asset.assetId);
    asset.sourceBindings.forEach(({ sourceRef }) => mappedSources.add(sourceRef));
    return Object.freeze({
      relativePath: file.relativePath,
      assetId: asset.assetId,
      kind: asset.kind,
      scopeFingerprint: asset.scopeFingerprint,
      contentHash: asset.contentHash,
      sourceBindings: asset.sourceBindings,
      markdownSha256: sha256(file.markdown),
    });
  }).sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const mappedCount = mappedSources.size;
  if (mappedCount + input.archiveCount + input.quarantineCount !== input.sourceCount) {
    fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  }
  return Object.freeze({
    schema: CANONICAL_MARKDOWN_ASSET_MANIFEST_SCHEMA,
    governanceRunId: input.governanceRunId,
    policyVersion: input.policyVersion,
    createdAt: input.createdAt,
    sourceCount: input.sourceCount,
    mappedCount,
    assetCount: files.length,
    archiveCount: input.archiveCount,
    quarantineCount: input.quarantineCount,
    sourceSnapshotSha256: input.sourceSnapshotSha256,
    files: Object.freeze(files),
  });
}

const MANIFEST_KEYS = [
  "schema", "governanceRunId", "policyVersion", "createdAt", "sourceCount",
  "mappedCount", "assetCount", "archiveCount", "quarantineCount",
  "sourceSnapshotSha256", "files",
] as const;
const MANIFEST_FILE_KEYS = [
  "relativePath", "assetId", "kind", "scopeFingerprint", "contentHash",
  "sourceBindings", "markdownSha256",
] as const;

function validateSortedStrings(
  value: unknown,
  validator: (item: unknown) => item is string,
  unique: boolean,
): value is readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || value.length === 0 ||
      value.some((item) => !validator(item)) || unique && new Set(value).size !== value.length) {
    return false;
  }
  return value.every((item, index) => index === 0 || value[index - 1]!.localeCompare(item) < 1);
}

function validateManifest(value: unknown): asserts value is CanonicalMarkdownAssetManifest {
  if (!plainRecord(value) || !exactKeys(value, MANIFEST_KEYS) ||
      value.schema !== CANONICAL_MARKDOWN_ASSET_MANIFEST_SCHEMA ||
      !safeText(value.governanceRunId) || !safeText(value.policyVersion) ||
      !validIso(value.createdAt) || !nonNegativeInteger(value.sourceCount) ||
      !nonNegativeInteger(value.mappedCount) || !nonNegativeInteger(value.assetCount) ||
      !nonNegativeInteger(value.archiveCount) || !nonNegativeInteger(value.quarantineCount) ||
      typeof value.sourceSnapshotSha256 !== "string" || !SHA256.test(value.sourceSnapshotSha256) ||
      !Array.isArray(value.files) || nodeUtilTypes.isProxy(value.files) ||
      value.files.length !== value.assetCount ||
      value.mappedCount + value.archiveCount + value.quarantineCount !== value.sourceCount) {
    fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  }
  const paths = new Set<string>();
  const assetIds = new Set<string>();
  const sources = new Set<string>();
  let previousPath: string | undefined;
  for (const file of value.files) {
    if (!plainRecord(file) || !exactKeys(file, MANIFEST_FILE_KEYS) ||
        typeof file.relativePath !== "string" || !SAFE_PATH.test(file.relativePath) ||
        typeof file.assetId !== "string" || !ASSET_ID.test(file.assetId) ||
        typeof file.kind !== "string" || !ASSET_KINDS.has(file.kind as CanonicalMarkdownAssetKind) ||
        typeof file.scopeFingerprint !== "string" || !SHA256.test(file.scopeFingerprint) ||
        typeof file.contentHash !== "string" || !SHA256.test(file.contentHash) ||
        typeof file.markdownSha256 !== "string" || !SHA256.test(file.markdownSha256) ||
        !Array.isArray(file.sourceBindings) || file.sourceBindings.length === 0 ||
        stableJson(file.sourceBindings) !== stableJson(normalizeSourceBindings(file.sourceBindings)) ||
        previousPath !== undefined && previousPath.localeCompare(file.relativePath) >= 0) {
      fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
    }
    const portablePath = file.relativePath.normalize("NFC").toLowerCase();
    if (paths.has(portablePath) || assetIds.has(file.assetId) ||
        file.sourceBindings.some(({ sourceRef }) => sources.has(sourceRef))) {
      fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
    }
    paths.add(portablePath);
    assetIds.add(file.assetId);
    file.sourceBindings.forEach(({ sourceRef }) => sources.add(sourceRef));
    previousPath = file.relativePath;
  }
  if (sources.size !== value.mappedCount) fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
}

export function serializeCanonicalMarkdownAssetManifest(
  manifest: CanonicalMarkdownAssetManifest,
): string {
  validateManifest(manifest);
  return `${JSON.stringify(stableValue(manifest), null, 2)}\n`;
}

export function parseCanonicalMarkdownAssetManifest(
  serialized: string,
): CanonicalMarkdownAssetManifest {
  if (typeof serialized !== "string") fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  let value: unknown;
  try {
    value = JSON.parse(serialized);
    validateManifest(value);
  } catch (error) {
    if (error instanceof CanonicalMarkdownAssetError) throw error;
    fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  }
  const stable = stableValue(value) as CanonicalMarkdownAssetManifest;
  const canonical = `${JSON.stringify(stable, null, 2)}\n`;
  if (serialized !== canonical) fail("CANONICAL_MARKDOWN_ASSET_MANIFEST_DRIFT");
  return stable;
}

export function canonicalMarkdownAssetManifestSha256(serialized: string): string {
  parseCanonicalMarkdownAssetManifest(serialized);
  return sha256(serialized);
}
