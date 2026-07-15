import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import type { MemoryConfig } from "../config.js";
import {
  createEmbeddingSpace,
  type EmbeddingSpaceFingerprintInput,
  type KnownEmbeddingSpace,
} from "../packages/core/src/domain/embedding-space.js";
import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import { Embeddings } from "../packages/core/src/runtime/llm/embeddings.js";

export const OPERATOR_EMBEDDING_APPLY_TOKEN =
  "APPLY-MENGSHU-EMBEDDING-V12" as const;
const TARGET_MODEL = "Qwen/Qwen3-Embedding-0.6B";
const TARGET_DIMENSIONS = 1024;
const REQUIRED_CENTROID_MARGIN = 0.1;
const TABLES = ["memories", "knowledge"] as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const LEGACY_CONTENT_HASH_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
/** RFC 4122/RFC 9562 UUID v1-v8，且 variant 必须为 10xx。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMBEDDING_SPACE_ID_PATTERN = /^embedding-space:v1:[0-9a-f]{64}$/;

type MigrationTable = (typeof TABLES)[number];
type MigrationOperation = "validated" | "reembed";
type ReceiptOperation = "validated" | "applied";

export class OperatorEmbeddingMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OperatorEmbeddingMigrationError";
  }
}

export interface OperatorEmbeddingManifest {
  readonly version: 1;
  readonly expected: {
    readonly total: number;
    readonly validated: number;
    readonly reembed: number;
    readonly memories: number;
    readonly knowledge: number;
  };
  readonly expectedCurrentSpaceId: string;
  readonly target: EmbeddingSpaceFingerprintInput;
  readonly centroidMargin: 0.1;
  /** PostgreSQL keyset page / bulk transaction size. */
  readonly scanBatchSize: number;
  /** Remote OpenAI-compatible request size; hard capped at 20. */
  readonly apiBatchSize: number;
}

export interface LoadedOperatorEmbeddingManifest {
  readonly manifest: OperatorEmbeddingManifest;
  readonly sha256: string;
}

export interface OperatorEmbeddingRow {
  readonly table: MigrationTable;
  readonly id: string;
  readonly text: string;
  readonly contentHash: string;
  vector: number[];
  metadata: Record<string, unknown>;
  embeddingSpaceId: string | null;
  embeddingSpaceState: string | null;
  readonly receiptOperation: ReceiptOperation | null;
}

export interface OperatorEmbeddingClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: Row[]; readonly rowCount?: number | null }>;
}

export interface OperatorEmbeddingBatchProvider {
  readonly target: EmbeddingSpaceFingerprintInput;
  embedBatch(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
}

export interface OperatorEmbeddingSwitchInput {
  readonly targetSpace: KnownEmbeddingSpace;
  readonly maintenance: true;
  readonly quiescenceConfirmed: true;
  readonly manifestSha256: string;
}

export interface OperatorEmbeddingApplyOptions {
  readonly mode: "apply";
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly confirmationToken: string;
  readonly expectedManifestSha256: string;
  readonly embedder: OperatorEmbeddingBatchProvider;
  /**
   * 显式的最后一步 capability。调用方应在这里委托
   * PostgresProvider.switchActiveEmbeddingSpace；runner 不直接改配置或 singleton。
   */
  readonly switchActive?: (input: OperatorEmbeddingSwitchInput) => Promise<void>;
}

export interface OperatorEmbeddingDryRunOptions {
  readonly mode?: "dry-run";
}

export interface OperatorEmbeddingMigrationReport {
  readonly mode: "dry-run" | "apply";
  readonly total: number;
  readonly validated: number;
  readonly reembed: number;
  readonly alreadyMigrated: number;
  readonly shadowCaptured: number;
  readonly updated: number;
  readonly activeSwitch: "pending" | "completed";
}

interface Centroids {
  readonly qwen: readonly number[];
  readonly bge: readonly number[];
}

interface Classification {
  readonly operation: MigrationOperation;
  readonly reason:
    | "memory-qwen-model"
    | "memory-non-qwen-model"
    | "knowledge-qwen-model"
    | "knowledge-non-openai-model"
    | "knowledge-centroid-qwen"
    | "knowledge-centroid-ambiguous"
    | "knowledge-centroid-unavailable"
    | "existing-validated-receipt"
    | "existing-applied-receipt";
}

interface ScanSummary {
  total: number;
  validated: number;
  reembed: number;
  alreadyMigrated: number;
  memories: number;
  knowledge: number;
}

interface MutableCentroid {
  sum: number[];
  count: number;
}

function fail(code: string, message: string): never {
  throw new OperatorEmbeddingMigrationError(code, message);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_MANIFEST", `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredInteger(
  record: Record<string, unknown>,
  field: string,
  minimum = 0,
): number {
  const value = record[field];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("INVALID_MANIFEST", `${field} must be an integer >= ${minimum}`);
  }
  return value as number;
}

function assertExactKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedSet.has(key))) {
    fail("INVALID_MANIFEST", `${field} contains unsupported fields`);
  }
}

export function loadOperatorEmbeddingManifest(
  text: string,
): LoadedOperatorEmbeddingManifest {
  const sha256 = createHash("sha256").update(text, "utf8").digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("INVALID_MANIFEST", "embedding migration manifest is not valid JSON");
  }
  const root = asRecord(parsed, "manifest");
  assertExactKeys(
    root,
    [
      "version", "expected", "expectedCurrentSpaceId", "target", "centroidMargin",
      "scanBatchSize", "apiBatchSize",
    ],
    "manifest",
  );
  if (root.version !== 1) fail("INVALID_MANIFEST", "manifest.version must be 1");

  const expected = asRecord(root.expected, "manifest.expected");
  assertExactKeys(
    expected,
    ["total", "validated", "reembed", "memories", "knowledge"],
    "manifest.expected",
  );
  const normalizedExpected = {
    total: requiredInteger(expected, "total"),
    validated: requiredInteger(expected, "validated"),
    reembed: requiredInteger(expected, "reembed"),
    memories: requiredInteger(expected, "memories"),
    knowledge: requiredInteger(expected, "knowledge"),
  };
  if (
    normalizedExpected.validated + normalizedExpected.reembed !== normalizedExpected.total ||
    normalizedExpected.memories + normalizedExpected.knowledge !== normalizedExpected.total
  ) {
    fail("INVALID_MANIFEST", "manifest expected counts are internally inconsistent");
  }
  if (
    typeof root.expectedCurrentSpaceId !== "string" ||
    !EMBEDDING_SPACE_ID_PATTERN.test(root.expectedCurrentSpaceId)
  ) {
    fail("INVALID_MANIFEST", "manifest expectedCurrentSpaceId must be a canonical embedding space ID");
  }

  const targetInput = asRecord(root.target, "manifest.target");
  assertExactKeys(targetInput, ["provider", "baseURL", "model", "dim", "normalization"], "manifest.target");
  let target: KnownEmbeddingSpace;
  try {
    target = createEmbeddingSpace(targetInput as unknown as EmbeddingSpaceFingerprintInput);
  } catch {
    fail("INVALID_MANIFEST", "manifest target embedding fingerprint is invalid");
  }
  if (
    target.fingerprint.provider !== "openai" ||
    target.fingerprint.model !== TARGET_MODEL ||
    target.fingerprint.dim !== TARGET_DIMENSIONS
  ) {
    fail(
      "INVALID_MANIFEST",
      `target must use OpenAI-compatible ${TARGET_MODEL} with ${TARGET_DIMENSIONS} dimensions`,
    );
  }
  if (root.centroidMargin !== REQUIRED_CENTROID_MARGIN) {
    fail("INVALID_MANIFEST", "manifest centroidMargin must be exactly 0.1");
  }
  const scanBatchSize = requiredInteger(root, "scanBatchSize", 1);
  const apiBatchSize = requiredInteger(root, "apiBatchSize", 1);
  if (scanBatchSize > 1_000) {
    fail("INVALID_MANIFEST", "manifest scanBatchSize must not exceed 1000");
  }
  if (apiBatchSize > 20) {
    fail("INVALID_MANIFEST", "manifest apiBatchSize must not exceed 20");
  }

  return Object.freeze({
    manifest: Object.freeze({
      version: 1,
      expected: Object.freeze(normalizedExpected),
      expectedCurrentSpaceId: root.expectedCurrentSpaceId,
      target: target.fingerprint,
      centroidMargin: REQUIRED_CENTROID_MARGIN,
      scanBatchSize,
      apiBatchSize,
    }),
    sha256,
  });
}

function metadataModel(metadata: Record<string, unknown>): string | null {
  const candidates = ["embeddingModel", "embedding_model", "model", "modelName"];
  const values = new Set<string>();
  for (const key of candidates) {
    const descriptor = Object.getOwnPropertyDescriptor(metadata, key);
    if (!descriptor || !("value" in descriptor)) continue;
    if (typeof descriptor.value === "string" && descriptor.value.trim()) {
      values.add(descriptor.value.trim());
    }
  }
  if (values.size !== 1) return null;
  return [...values][0] ?? null;
}

function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length || left.length === 0) return Number.NaN;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let i = 0; i < left.length; i += 1) {
    const a = left[i]!;
    const b = right[i]!;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (leftNorm === 0 || rightNorm === 0) return Number.NaN;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

export function classifyEmbeddingRow(
  row: OperatorEmbeddingRow,
  centroids: Centroids | null,
  centroidMargin: number,
): Classification {
  if (row.receiptOperation === "validated") {
    return { operation: "validated", reason: "existing-validated-receipt" };
  }
  if (row.receiptOperation === "applied") {
    return { operation: "reembed", reason: "existing-applied-receipt" };
  }
  const model = metadataModel(row.metadata)?.toLowerCase() ?? "";
  const qwenModel = model.includes("qwen");
  if (row.table === "memories") {
    return qwenModel
      ? { operation: "validated", reason: "memory-qwen-model" }
      : { operation: "reembed", reason: "memory-non-qwen-model" };
  }
  if (qwenModel) {
    return { operation: "validated", reason: "knowledge-qwen-model" };
  }
  if (!/openai|text-embedding/i.test(model)) {
    return { operation: "reembed", reason: "knowledge-non-openai-model" };
  }
  if (!centroids) {
    return { operation: "reembed", reason: "knowledge-centroid-unavailable" };
  }
  const qwenSimilarity = cosine(row.vector, centroids.qwen);
  const bgeSimilarity = cosine(row.vector, centroids.bge);
  if (!Number.isFinite(qwenSimilarity) || !Number.isFinite(bgeSimilarity)) {
    return { operation: "reembed", reason: "knowledge-centroid-unavailable" };
  }
  const difference = qwenSimilarity - bgeSimilarity;
  if (difference <= 0 || Math.abs(difference) < centroidMargin) {
    return { operation: "reembed", reason: "knowledge-centroid-ambiguous" };
  }
  return { operation: "validated", reason: "knowledge-centroid-qwen" };
}

function parseVector(value: unknown): number[] {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail("INVALID_ROW", "persisted embedding vector is malformed");
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== TARGET_DIMENSIONS ||
    parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    fail("INVALID_ROW", `persisted embedding vector must have ${TARGET_DIMENSIONS} finite dimensions`);
  }
  return parsed as number[];
}

function requiredRowString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_ROW", `persisted migration row has invalid ${key}`);
  }
  return value;
}

function requiredRowText(row: Record<string, unknown>): string {
  const value = row.text;
  if (typeof value !== "string") {
    fail("INVALID_ROW", "persisted migration row has invalid text");
  }
  return value;
}

function decodeRow(table: MigrationTable, row: Record<string, unknown>): OperatorEmbeddingRow {
  const id = requiredRowString(row, "id");
  const contentHash = requiredRowString(row, "content_hash");
  if (!UUID_PATTERN.test(id) || !LEGACY_CONTENT_HASH_PATTERN.test(contentHash)) {
    fail("INVALID_ROW", "persisted migration row identity is invalid");
  }
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("INVALID_ROW", "persisted migration metadata is invalid");
  }
  const receipt = row.receipt_operation;
  if (receipt !== null && receipt !== undefined && receipt !== "validated" && receipt !== "applied") {
    fail("INVALID_ROW", "persisted migration receipt is invalid");
  }
  return {
    table,
    id,
    // DocumentRepository 历史合同允许 title 缺失时以空串生成合法 embedding。
    // 空串必须保留并送往相同 provider；仅 null/非字符串 fail-closed。
    text: requiredRowText(row),
    contentHash,
    vector: parseVector(row.vector),
    metadata: metadata as Record<string, unknown>,
    embeddingSpaceId: typeof row.embedding_space_id === "string" ? row.embedding_space_id : null,
    embeddingSpaceState: typeof row.embedding_space_state === "string" ? row.embedding_space_state : null,
    receiptOperation: (receipt ?? null) as ReceiptOperation | null,
  };
}

function tableSql(table: MigrationTable): string {
  if (!TABLES.includes(table)) fail("INVALID_TABLE", "unsupported migration table");
  return `"${table}"`;
}

function modelLateralSql(rowAlias: string): string {
  return `CROSS JOIN LATERAL (
  SELECT CASE WHEN COUNT(DISTINCT candidate.value) = 1
              THEN MIN(candidate.value) ELSE NULL END AS model
  FROM (VALUES
    (CASE WHEN jsonb_typeof(${rowAlias}.source_metadata->'embeddingModel') = 'string'
          THEN BTRIM(${rowAlias}.source_metadata->>'embeddingModel') END),
    (CASE WHEN jsonb_typeof(${rowAlias}.source_metadata->'embedding_model') = 'string'
          THEN BTRIM(${rowAlias}.source_metadata->>'embedding_model') END),
    (CASE WHEN jsonb_typeof(${rowAlias}.source_metadata->'model') = 'string'
          THEN BTRIM(${rowAlias}.source_metadata->>'model') END),
    (CASE WHEN jsonb_typeof(${rowAlias}.source_metadata->'modelName') = 'string'
          THEN BTRIM(${rowAlias}.source_metadata->>'modelName') END)
  ) AS candidate(value)
  WHERE candidate.value IS NOT NULL AND candidate.value <> ''
) detected_model`;
}

function sourceRowsSql(
  cteName: string,
  table: MigrationTable,
  migrationParameter: string,
): string {
  return `${cteName} AS MATERIALIZED (
  SELECT
    r.id,
    COALESCE(s.old_vector, r.vector) AS source_vector,
    COALESCE(s.old_metadata, r.metadata) AS source_metadata,
    (
      SELECT receipt.operation
      FROM mengshu_embedding_reembed_receipts receipt
      WHERE receipt.migration_id = ${migrationParameter}
        AND receipt.table_name = '${table}'
        AND receipt.record_id = r.id
        AND receipt.operation IN ('validated', 'applied')
      ORDER BY receipt.created_at DESC
      LIMIT 1
    ) AS receipt_operation
  FROM ${tableSql(table)} r
  LEFT JOIN mengshu_embedding_reembed_shadow s
    ON s.migration_id = ${migrationParameter}
   AND s.table_name = '${table}'
   AND s.record_id = r.id
)`;
}

async function inspect(
  client: OperatorEmbeddingClient,
  manifest: OperatorEmbeddingManifest,
  migrationId: string,
): Promise<{ summary: ScanSummary }> {
  const summary: ScanSummary = {
    total: 0,
    validated: 0,
    reembed: 0,
    alreadyMigrated: 0,
    memories: 0,
    knowledge: 0,
  };
  const sql = `/* embedding-migrate:classify */
WITH
${sourceRowsSql("memories_source", "memories", "$1")},
memory_models AS MATERIALIZED (
  SELECT source.*, LOWER(COALESCE(detected_model.model, '')) AS model
  FROM memories_source source
  ${modelLateralSql("source")}
),
centroids AS MATERIALIZED (
  SELECT
    AVG(source_vector) FILTER (WHERE model LIKE '%qwen%') AS qwen_centroid,
    AVG(source_vector) FILTER (WHERE model LIKE '%bge%') AS bge_centroid
  FROM memory_models
),
memory_classified AS (
  SELECT 'memories'::text AS table_name, receipt_operation,
    CASE
      WHEN receipt_operation = 'validated' THEN 'validated'
      WHEN receipt_operation = 'applied' THEN 'reembed'
      WHEN model LIKE '%qwen%' THEN 'validated'
      ELSE 'reembed'
    END AS operation
  FROM memory_models
),
${sourceRowsSql("knowledge_source", "knowledge", "$1")},
knowledge_models AS MATERIALIZED (
  SELECT source.*, LOWER(COALESCE(detected_model.model, '')) AS model
  FROM knowledge_source source
  ${modelLateralSql("source")}
),
knowledge_classified AS (
  SELECT 'knowledge'::text AS table_name, source.receipt_operation,
    CASE
      WHEN source.receipt_operation = 'validated' THEN 'validated'
      WHEN source.receipt_operation = 'applied' THEN 'reembed'
      WHEN source.model LIKE '%qwen%' THEN 'validated'
      WHEN source.model !~ '(openai|text-embedding)' THEN 'reembed'
      WHEN centroids.qwen_centroid IS NULL OR centroids.bge_centroid IS NULL THEN 'reembed'
      WHEN (source.source_vector <=> centroids.bge_centroid) -
           (source.source_vector <=> centroids.qwen_centroid) >= $2 THEN 'validated'
      ELSE 'reembed'
    END AS operation
  FROM knowledge_models source
  CROSS JOIN centroids
),
all_classified AS (
  SELECT * FROM memory_classified
  UNION ALL
  SELECT * FROM knowledge_classified
)
SELECT
  table_name,
  COUNT(*) AS total_count,
  COUNT(*) FILTER (WHERE operation = 'validated') AS validated_count,
  COUNT(*) FILTER (WHERE operation = 'reembed') AS reembed_count,
  COUNT(*) FILTER (WHERE receipt_operation IS NOT NULL) AS already_migrated_count
FROM all_classified
GROUP BY table_name
ORDER BY table_name`;
  const result = await client.query(sql, [migrationId, manifest.centroidMargin]);
  for (const row of result.rows) {
    const table = row.table_name;
    if (table !== "memories" && table !== "knowledge") {
      fail("INVALID_ROW", "server classification returned an invalid table");
    }
    const total = persistedCount(row.total_count);
    summary[table] = total;
    summary.total += total;
    summary.validated += persistedCount(row.validated_count);
    summary.reembed += persistedCount(row.reembed_count);
    summary.alreadyMigrated += persistedCount(row.already_migrated_count);
  }
  return { summary };
}

function assertExpected(summary: ScanSummary, expected: OperatorEmbeddingManifest["expected"]): void {
  if (
    summary.total !== expected.total ||
    summary.validated !== expected.validated ||
    summary.reembed !== expected.reembed ||
    summary.memories !== expected.memories ||
    summary.knowledge !== expected.knowledge
  ) {
    fail("EXPECTED_COUNTS_MISMATCH", "embedding migration actual counts do not match manifest");
  }
}

function assertApplyGate(
  manifest: OperatorEmbeddingManifest,
  manifestSha256: string,
  options: OperatorEmbeddingApplyOptions,
): KnownEmbeddingSpace {
  if (
    options.maintenance !== true ||
    options.quiescenceConfirmed !== true ||
    options.confirmationToken !== OPERATOR_EMBEDDING_APPLY_TOKEN ||
    options.expectedManifestSha256 !== manifestSha256 ||
    !SHA256_PATTERN.test(manifestSha256)
  ) {
    fail("APPLY_GATE_REJECTED", "embedding migration apply gate rejected");
  }
  let target: KnownEmbeddingSpace;
  let embedderTarget: KnownEmbeddingSpace;
  try {
    target = createEmbeddingSpace(manifest.target);
    embedderTarget = createEmbeddingSpace(options.embedder.target);
  } catch {
    fail("EMBEDDER_TARGET_MISMATCH", "configured embedding provider target is invalid");
  }
  if (target.embeddingSpaceId !== embedderTarget.embeddingSpaceId) {
    fail("EMBEDDER_TARGET_MISMATCH", "configured embedding provider does not match manifest target");
  }
  return target;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function vectorHash(vector: readonly number[]): string {
  return sha256(JSON.stringify(vector));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

async function insertTargetDescriptor(
  client: OperatorEmbeddingClient,
  target: KnownEmbeddingSpace,
): Promise<void> {
  const result = await client.query(`/* embedding-migrate:descriptor */
WITH inserted AS (
  INSERT INTO mengshu_embedding_spaces (
    embedding_space_id, provider, base_url, model, dimensions, normalization, state, queryability_state
  ) VALUES ($1, $2, $3, $4, $5, $6, 'known-queryable', 'known-queryable')
  ON CONFLICT (embedding_space_id) DO NOTHING
  RETURNING embedding_space_id, provider, base_url, model, dimensions, normalization, state
)
SELECT * FROM inserted
UNION ALL
SELECT embedding_space_id, provider, base_url, model, dimensions, normalization, state
FROM mengshu_embedding_spaces
WHERE embedding_space_id = $1
LIMIT 1`, [
    target.embeddingSpaceId,
    target.fingerprint.provider,
    target.fingerprint.baseURL,
    target.fingerprint.model,
    target.fingerprint.dim,
    target.fingerprint.normalization,
  ]);
  if (result.rows.length !== 1) fail("TARGET_DESCRIPTOR_MISMATCH", "target descriptor could not be verified");
  const row = result.rows[0]!;
  if (
    row.embedding_space_id !== target.embeddingSpaceId ||
    row.provider !== target.fingerprint.provider ||
    row.base_url !== target.fingerprint.baseURL ||
    row.model !== target.fingerprint.model ||
    row.dimensions !== target.fingerprint.dim ||
    row.normalization !== target.fingerprint.normalization ||
    row.state !== "known-queryable"
  ) {
    fail("TARGET_DESCRIPTOR_MISMATCH", "persisted target descriptor conflicts with manifest");
  }
}

async function captureTableShadow(
  client: OperatorEmbeddingClient,
  table: MigrationTable,
  migrationId: string,
  expected: number,
): Promise<number> {
  const result = await client.query(`/* embedding-migrate:shadow */
WITH inserted AS (
  INSERT INTO mengshu_embedding_reembed_shadow (
    migration_id, table_name, record_id, source_content_hash, old_vector,
    old_embedding_space_id, old_embedding_space_state, old_metadata
  )
  SELECT $1, $2, r.id, r.content_hash, r.vector,
         r.embedding_space_id, r.embedding_space_state, r.metadata
  FROM ${tableSql(table)} r
  ON CONFLICT (migration_id, table_name, record_id) DO NOTHING
  RETURNING record_id
), captured AS (
  SELECT COUNT(*)::integer AS count
  FROM ${tableSql(table)} r
  JOIN mengshu_embedding_reembed_shadow s
    ON s.migration_id = $1 AND s.table_name = $2 AND s.record_id = r.id
)
SELECT
  (SELECT COUNT(*)::integer FROM inserted) AS inserted_count,
  ((SELECT count FROM captured) + (SELECT COUNT(*)::integer FROM inserted)) AS captured_count,
  (SELECT COUNT(*)::integer FROM ${tableSql(table)}) AS total_count`, [migrationId, table]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 ||
    row?.captured_count !== expected ||
    row?.total_count !== expected ||
    !Number.isSafeInteger(row?.inserted_count)
  ) {
    fail("SHADOW_CAPTURE_FAILED", "embedding migration shadow capture is incomplete");
  }
  return row.inserted_count as number;
}

function classificationCtesForTable(
  table: MigrationTable,
  migrationParameter = "$1",
  marginParameter = "$2",
): string {
  const memory = `${sourceRowsSql("memories_source", "memories", migrationParameter)},
memory_models AS MATERIALIZED (
  SELECT source.*, LOWER(COALESCE(detected_model.model, '')) AS model
  FROM memories_source source
  ${modelLateralSql("source")}
),
centroids AS MATERIALIZED (
  SELECT
    AVG(source_vector) FILTER (WHERE model LIKE '%qwen%') AS qwen_centroid,
    AVG(source_vector) FILTER (WHERE model LIKE '%bge%') AS bge_centroid
  FROM memory_models
),
operator_margin AS MATERIALIZED (
  SELECT ${marginParameter}::double precision AS value
)`;
  if (table === "memories") {
    return `${memory},
classified AS MATERIALIZED (
  SELECT id, receipt_operation,
    CASE
      WHEN receipt_operation = 'validated' THEN 'validated'
      WHEN receipt_operation = 'applied' THEN 'reembed'
      WHEN model LIKE '%qwen%' THEN 'validated'
      ELSE 'reembed'
    END AS operation
  FROM memory_models
)`;
  }
  return `${memory},
${sourceRowsSql("target_source", "knowledge", migrationParameter)},
target_models AS MATERIALIZED (
  SELECT source.*, LOWER(COALESCE(detected_model.model, '')) AS model
  FROM target_source source
  ${modelLateralSql("source")}
),
classified AS MATERIALIZED (
  SELECT source.id, source.receipt_operation,
    CASE
      WHEN source.receipt_operation = 'validated' THEN 'validated'
      WHEN source.receipt_operation = 'applied' THEN 'reembed'
      WHEN source.model LIKE '%qwen%' THEN 'validated'
      WHEN source.model !~ '(openai|text-embedding)' THEN 'reembed'
      WHEN centroids.qwen_centroid IS NULL OR centroids.bge_centroid IS NULL THEN 'reembed'
      WHEN (source.source_vector <=> centroids.bge_centroid) -
           (source.source_vector <=> centroids.qwen_centroid) >= ${marginParameter}
        THEN 'validated'
      ELSE 'reembed'
    END AS operation
  FROM target_models source
  CROSS JOIN centroids
)`;
}

function sourceSnapshotShaSql(shadowAlias: string, table: MigrationTable): string {
  return `encode(sha256(convert_to(jsonb_build_object(
    'table', '${table}',
    'id', ${shadowAlias}.record_id::text,
    'contentHash', ${shadowAlias}.source_content_hash,
    'vector', ${shadowAlias}.old_vector::text,
    'embeddingSpaceId', ${shadowAlias}.old_embedding_space_id,
    'embeddingSpaceState', ${shadowAlias}.old_embedding_space_state,
    'metadata', ${shadowAlias}.old_metadata
  )::text, 'UTF8')), 'hex')`;
}

async function applyValidatedBulk(
  client: OperatorEmbeddingClient,
  table: MigrationTable,
  manifest: OperatorEmbeddingManifest,
  migrationId: string,
  target: KnownEmbeddingSpace,
): Promise<number> {
  const snapshotSha = sourceSnapshotShaSql("shadow", table);
  await client.query("BEGIN");
  try {
    const result = await client.query(`/* embedding-migrate:validated-bulk */
WITH
${classificationCtesForTable(table)},
eligible AS MATERIALIZED (
  SELECT
    classified.id,
    shadow.source_content_hash,
    shadow.old_vector,
    shadow.old_metadata,
    shadow.old_embedding_space_id,
    shadow.old_embedding_space_state,
    ${snapshotSha} AS source_snapshot_sha256
  FROM classified
  JOIN mengshu_embedding_reembed_shadow shadow
    ON shadow.migration_id = $1
   AND shadow.table_name = '${table}'
   AND shadow.record_id = classified.id
  WHERE classified.receipt_operation IS NULL
    AND classified.operation = 'validated'
),
updated AS (
  UPDATE ${tableSql(table)} record
  SET embedding_space_id = $3::text,
      embedding_space_state = 'known-queryable',
      metadata = record.metadata || jsonb_build_object(
        'embeddingSpaceId', $3::text,
        'embeddingSpaceState', 'known-queryable',
        'embedding_space_id', $3::text,
        'embedding_space_state', 'known-queryable',
        'operatorEmbeddingMigration', jsonb_build_object(
          'version', 'operator-embedding-v12',
          'manifestSha256', $4::text,
          'operation', 'validated',
          'targetEmbeddingSpaceId', $3::text,
          'sourceSnapshotSha256', eligible.source_snapshot_sha256,
          'auditHash', encode(sha256(convert_to(
            $4::text || ':${table}:' || record.id::text || ':validated:' ||
            eligible.source_snapshot_sha256, 'UTF8')), 'hex')
        )
      )
  FROM eligible
  WHERE record.id = eligible.id
    AND record.content_hash = eligible.source_content_hash
    AND record.vector = eligible.old_vector
    AND record.metadata = eligible.old_metadata
    AND record.embedding_space_id IS NOT DISTINCT FROM eligible.old_embedding_space_id
    AND record.embedding_space_state IS NOT DISTINCT FROM eligible.old_embedding_space_state
  RETURNING record.id
),
inserted_receipts AS (
  INSERT INTO mengshu_embedding_reembed_receipts (
    receipt_id, migration_id, table_name, record_id, operation,
    target_embedding_space_id, target_vector_sha256, source_snapshot_sha256
  )
  SELECT
    encode(sha256(convert_to($1 || ':${table}:' || updated.id::text || ':validated', 'UTF8')), 'hex'),
    $1, '${table}', updated.id, 'validated', $3::text,
    encode(sha256(convert_to(record.vector::text, 'UTF8')), 'hex'),
    ${sourceSnapshotShaSql("shadow", table)}
  FROM updated
  JOIN ${tableSql(table)} record ON record.id = updated.id
  JOIN mengshu_embedding_reembed_shadow shadow
    ON shadow.migration_id = $1
   AND shadow.table_name = '${table}'
   AND shadow.record_id = updated.id
  ON CONFLICT (migration_id, table_name, record_id, operation) DO NOTHING
  RETURNING record_id
)
SELECT
  (SELECT COUNT(*)::integer FROM eligible) AS eligible_count,
  (SELECT COUNT(*)::integer FROM updated) AS updated_count,
  (SELECT COUNT(*)::integer FROM inserted_receipts) AS receipt_count`, [
      migrationId,
      manifest.centroidMargin,
      target.embeddingSpaceId,
      migrationId,
    ]);
    const row = result.rows[0];
    const eligible = persistedCount(row?.eligible_count);
    const updated = persistedCount(row?.updated_count);
    if (
      result.rows.length !== 1 ||
      updated !== eligible ||
      persistedCount(row?.receipt_count) !== updated
    ) {
      fail("SOURCE_DRIFT", "validated bulk source drift or receipt mismatch detected");
    }
    await client.query("COMMIT");
    return updated;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      fail("ROLLBACK_FAILED", "validated bulk rollback failed");
    }
    throw error;
  }
}

async function* scanReembedRows(
  client: OperatorEmbeddingClient,
  table: MigrationTable,
  manifest: OperatorEmbeddingManifest,
  migrationId: string,
): AsyncGenerator<OperatorEmbeddingRow[]> {
  let afterId: string | null = null;
  for (;;) {
    const result: { readonly rows: Record<string, unknown>[]; readonly rowCount?: number | null } =
      await client.query(`/* embedding-migrate:reembed-scan */
WITH
${classificationCtesForTable(table)}
SELECT
  record.id::text AS id,
  record.text,
  shadow.source_content_hash AS content_hash,
  shadow.old_vector::text AS vector,
  shadow.old_metadata AS metadata,
  shadow.old_embedding_space_id AS embedding_space_id,
  shadow.old_embedding_space_state AS embedding_space_state,
  NULL::text AS receipt_operation
FROM classified
JOIN ${tableSql(table)} record ON record.id = classified.id
JOIN mengshu_embedding_reembed_shadow shadow
  ON shadow.migration_id = $1
 AND shadow.table_name = '${table}'
 AND shadow.record_id = record.id
WHERE classified.receipt_operation IS NULL
  AND classified.operation = 'reembed'
  AND ($3::uuid IS NULL OR record.id > $3::uuid)
ORDER BY record.id
LIMIT $4`, [migrationId, manifest.centroidMargin, afterId, manifest.scanBatchSize]);
    const rows: OperatorEmbeddingRow[] = result.rows.map((row: Record<string, unknown>) =>
      decodeRow(table, row));
    if (rows.length === 0) return;
    yield rows;
    afterId = rows.at(-1)!.id;
    if (rows.length < manifest.scanBatchSize) return;
  }
}

function stampMetadata(
  row: OperatorEmbeddingRow,
  target: KnownEmbeddingSpace,
): Record<string, unknown> {
  return {
    ...row.metadata,
    embeddingSpaceId: target.embeddingSpaceId,
    embeddingSpaceState: "known-queryable",
    embedding_space_id: target.embeddingSpaceId,
    embedding_space_state: "known-queryable",
  };
}

interface PlannedUpdate {
  readonly row: OperatorEmbeddingRow;
  readonly operation: ReceiptOperation;
  readonly vector: readonly number[] | null;
  readonly metadata: Record<string, unknown>;
}

async function applyBatch(
  client: OperatorEmbeddingClient,
  table: MigrationTable,
  migrationId: string,
  target: KnownEmbeddingSpace,
  manifestSha256: string,
  rows: readonly OperatorEmbeddingRow[],
  classifications: readonly Classification[],
  embedder: OperatorEmbeddingBatchProvider,
  apiBatchSize: number,
): Promise<number> {
  const reembedRows = rows.filter((_, index) => classifications[index]!.operation === "reembed");
  const embedded: (readonly number[])[] = [];
  for (let offset = 0; offset < reembedRows.length; offset += apiBatchSize) {
    const apiRows = reembedRows.slice(offset, offset + apiBatchSize);
    const vectors = await embedder.embedBatch(apiRows.map((row) => row.text));
    if (vectors.length !== apiRows.length) {
      fail("EMBEDDING_BATCH_INVALID", "configured embedding provider returned an invalid batch size");
    }
    embedded.push(...vectors);
  }
  if (embedded.length !== reembedRows.length) {
    fail("EMBEDDING_BATCH_INVALID", "configured embedding provider returned an invalid batch size");
  }
  const vectorsById = new Map<string, readonly number[]>();
  for (let index = 0; index < reembedRows.length; index += 1) {
    // pgvector stores float4. Hash and write the exact float32 values so receipt
    // evidence describes the persisted vector rather than pre-coercion JS doubles.
    const vector = parseVector(embedded[index]).map((value) => Math.fround(value));
    if (vector.some((value) => !Number.isFinite(value))) {
      fail("EMBEDDING_BATCH_INVALID", "configured embedding provider returned out-of-range values");
    }
    vectorsById.set(reembedRows[index]!.id, vector);
  }
  const updates: PlannedUpdate[] = rows.map((row, index) => {
    const operation: ReceiptOperation = classifications[index]!.operation === "validated"
      ? "validated"
      : "applied";
    const vector = operation === "applied" ? vectorsById.get(row.id) ?? null : null;
    return {
      row,
      operation,
      vector,
      metadata: stampMetadata(row, target),
    };
  });
  const idsJson = JSON.stringify(updates.map(({ row }) => ({ id: row.id })));
  await client.query("BEGIN");
  try {
    const locked = await client.query(`/* embedding-migrate:lock */
SELECT
  r.id::text AS id,
  r.content_hash,
  r.vector::text AS vector,
  r.metadata,
  r.embedding_space_id,
  r.embedding_space_state
FROM ${tableSql(table)} r
JOIN jsonb_to_recordset($2::jsonb) AS input(id uuid) ON input.id = r.id
WHERE $1::text = '${table}'
ORDER BY r.id
FOR UPDATE OF r`, [table, idsJson]);
    const lockedById = new Map(locked.rows.map((item) => [item.id, item]));
    for (const update of updates) {
      const current = lockedById.get(update.row.id);
      if (
        !current ||
        current.content_hash !== update.row.contentHash ||
        vectorHash(parseVector(current.vector)) !== vectorHash(update.row.vector) ||
        canonicalJson(current.metadata) !== canonicalJson(update.row.metadata) ||
        (current.embedding_space_id ?? null) !== update.row.embeddingSpaceId ||
        (current.embedding_space_state ?? null) !== update.row.embeddingSpaceState
      ) {
        fail("SOURCE_DRIFT", "embedding migration source drift detected");
      }
    }
    const updateJson = JSON.stringify(updates.map((item) => ({
      id: item.row.id,
      operation: item.operation,
      vector: item.vector ? JSON.stringify(item.vector) : null,
      embedding_space_id: target.embeddingSpaceId,
      embedding_space_state: "known-queryable",
      metadata: item.metadata,
    })));
    const updated = await client.query(`/* embedding-migrate:update */
WITH input AS (
  SELECT * FROM jsonb_to_recordset($2::jsonb) AS decoded(
  id uuid, operation text, vector text, embedding_space_id text,
  embedding_space_state text, metadata jsonb
  )
), evidence AS (
  SELECT input.*, ${sourceSnapshotShaSql("shadow", table)} AS source_snapshot_sha256
  FROM input
  JOIN mengshu_embedding_reembed_shadow shadow
    ON shadow.migration_id = $3
   AND shadow.table_name = '${table}'
   AND shadow.record_id = input.id
)
UPDATE ${tableSql(table)} record
SET vector = evidence.vector::vector,
    embedding_space_id = evidence.embedding_space_id,
    embedding_space_state = evidence.embedding_space_state,
    metadata = evidence.metadata || jsonb_build_object(
      'operatorEmbeddingMigration', jsonb_build_object(
        'version', 'operator-embedding-v12',
        'manifestSha256', $4::text,
        'operation', evidence.operation,
        'targetEmbeddingSpaceId', $5::text,
        'sourceSnapshotSha256', evidence.source_snapshot_sha256,
        'auditHash', encode(sha256(convert_to(
          $4::text || ':${table}:' || record.id::text || ':' || evidence.operation || ':' ||
          evidence.source_snapshot_sha256, 'UTF8')), 'hex')
      )
    )
FROM evidence
WHERE record.id = evidence.id
  AND $1::text = '${table}'
RETURNING record.id::text AS id`, [
      table, updateJson, migrationId, manifestSha256, target.embeddingSpaceId,
    ]);
    if (updated.rowCount !== updates.length) {
      fail("BULK_UPDATE_FAILED", "embedding migration bulk update was incomplete");
    }
    const receiptJson = JSON.stringify(updates.map((item) => ({
      record_id: item.row.id,
      operation: item.operation,
    })));
    const receipts = await client.query(`/* embedding-migrate:receipt */
INSERT INTO mengshu_embedding_reembed_receipts (
  receipt_id, migration_id, table_name, record_id, operation,
  target_embedding_space_id, target_vector_sha256, source_snapshot_sha256
)
SELECT
  encode(sha256(convert_to($3 || ':${table}:' || input.record_id::text || ':' || input.operation, 'UTF8')), 'hex'),
  $3, '${table}', input.record_id, input.operation, $4,
  encode(sha256(convert_to(record.vector::text, 'UTF8')), 'hex'),
  ${sourceSnapshotShaSql("shadow", table)}
FROM jsonb_to_recordset($2::jsonb) AS input(record_id uuid, operation text)
JOIN ${tableSql(table)} record ON record.id = input.record_id
JOIN mengshu_embedding_reembed_shadow shadow
  ON shadow.migration_id = $3
 AND shadow.table_name = '${table}'
 AND shadow.record_id = input.record_id
WHERE $1::text = '${table}'
ON CONFLICT (migration_id, table_name, record_id, operation) DO NOTHING
RETURNING record_id`, [table, receiptJson, migrationId, target.embeddingSpaceId]);
    if (receipts.rowCount !== updates.length) {
      fail("RECEIPT_WRITE_FAILED", "embedding migration receipt write was incomplete");
    }
    await client.query("COMMIT");
    return updates.length;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      fail("ROLLBACK_FAILED", "embedding migration rollback failed");
    }
    throw error;
  }
}

async function applyRows(
  client: OperatorEmbeddingClient,
  manifest: OperatorEmbeddingManifest,
  manifestSha256: string,
  target: KnownEmbeddingSpace,
  embedder: OperatorEmbeddingBatchProvider,
): Promise<number> {
  let updated = 0;
  for (const table of TABLES) {
    for await (const pending of scanReembedRows(
      client, table, manifest, manifestSha256,
    )) {
      if (pending.length === 0) continue;
      const classifications: Classification[] = pending.map(() => ({
        operation: "reembed",
        reason: "memory-non-qwen-model",
      }));
      updated += await applyBatch(
        client,
        table,
        manifestSha256,
        target,
        manifestSha256,
        pending,
        classifications,
        embedder,
        manifest.apiBatchSize,
      );
    }
  }
  return updated;
}

function persistedCount(value: unknown): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 0) {
    fail("POST_APPLY_VERIFICATION_FAILED", "post-apply verification returned an invalid count");
  }
  return parsed as number;
}

async function verifyPostApply(
  client: OperatorEmbeddingClient,
  manifest: OperatorEmbeddingManifest,
  migrationId: string,
  target: KnownEmbeddingSpace,
): Promise<void> {
  let validated = 0;
  let applied = 0;
  for (const table of TABLES) {
    const result = await client.query(`/* embedding-migrate:verify */
SELECT
  COUNT(*) AS total_count,
  COUNT(*) FILTER (WHERE
    r.embedding_space_id = $3
    AND r.embedding_space_state = 'known-queryable'
    AND r.metadata->>'embeddingSpaceId' = $3
    AND r.metadata->>'embeddingSpaceState' = 'known-queryable'
  ) AS stamped_count,
  COUNT(*) FILTER (WHERE
    receipts.receipt_count = 1
    AND receipts.target_count = 1
    AND receipts.checksum_count = 1
  )
    AS exact_receipt_rows,
  COALESCE(SUM(receipts.validated_count), 0) AS validated_count,
  COALESCE(SUM(receipts.applied_count), 0) AS applied_count
FROM ${tableSql(table)} r
JOIN mengshu_embedding_reembed_shadow shadow
  ON shadow.migration_id = $2
 AND shadow.table_name = $1
 AND shadow.record_id = r.id
CROSS JOIN LATERAL (
  SELECT
    COUNT(*) AS receipt_count,
    COUNT(*) FILTER (WHERE target_embedding_space_id = $3) AS target_count,
    COUNT(*) FILTER (WHERE
      target_vector_sha256 = encode(sha256(convert_to(r.vector::text, 'UTF8')), 'hex')
      AND source_snapshot_sha256 = ${sourceSnapshotShaSql("shadow", table)}
    ) AS checksum_count,
    COUNT(*) FILTER (WHERE operation = 'validated') AS validated_count,
    COUNT(*) FILTER (WHERE operation = 'applied') AS applied_count
  FROM mengshu_embedding_reembed_receipts receipt
  WHERE receipt.migration_id = $2
    AND receipt.table_name = $1
    AND receipt.record_id = r.id
) receipts`, [table, migrationId, target.embeddingSpaceId]);
    if (result.rows.length !== 1) {
      fail("POST_APPLY_VERIFICATION_FAILED", "post-apply verification did not return one aggregate row");
    }
    const row = result.rows[0]!;
    const expectedTable = manifest.expected[table];
    if (
      persistedCount(row.total_count) !== expectedTable ||
      persistedCount(row.stamped_count) !== expectedTable ||
      persistedCount(row.exact_receipt_rows) !== expectedTable
    ) {
      fail("POST_APPLY_VERIFICATION_FAILED", "post-apply table verification failed");
    }
    validated += persistedCount(row.validated_count);
    applied += persistedCount(row.applied_count);
  }
  if (validated !== manifest.expected.validated || applied !== manifest.expected.reembed) {
    fail("POST_APPLY_VERIFICATION_FAILED", "post-apply operation totals do not match manifest");
  }
}

export async function runOperatorEmbeddingMigration(
  client: OperatorEmbeddingClient,
  manifest: OperatorEmbeddingManifest,
  manifestSha256: string,
  options: OperatorEmbeddingDryRunOptions | OperatorEmbeddingApplyOptions = {},
): Promise<OperatorEmbeddingMigrationReport> {
  try {
    // Re-normalize caller-created objects through the same fail-closed manifest parser.
    const normalized = loadOperatorEmbeddingManifest(JSON.stringify(manifest)).manifest;
    if (!SHA256_PATTERN.test(manifestSha256)) {
      fail("INVALID_MANIFEST_SHA", "embedding migration manifest SHA must be 64 lowercase hex characters");
    }
    const apply = options.mode === "apply" ? options : null;
    const target = apply ? assertApplyGate(normalized, manifestSha256, apply) : null;
    const inspected = await inspect(client, normalized, manifestSha256);
    assertExpected(inspected.summary, normalized.expected);
    if (!apply || !target) {
      return {
        mode: "dry-run",
        total: inspected.summary.total,
        validated: inspected.summary.validated,
        reembed: inspected.summary.reembed,
        alreadyMigrated: inspected.summary.alreadyMigrated,
        shadowCaptured: 0,
        updated: 0,
        activeSwitch: "pending",
      };
    }

    await client.query("BEGIN");
    let shadowCaptured = 0;
    try {
      await insertTargetDescriptor(client, target);
      shadowCaptured += await captureTableShadow(
        client, "memories", manifestSha256, normalized.expected.memories,
      );
      shadowCaptured += await captureTableShadow(
        client, "knowledge", manifestSha256, normalized.expected.knowledge,
      );
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        fail("ROLLBACK_FAILED", "embedding migration bootstrap rollback failed");
      }
      throw error;
    }

    const capturedInspection = await inspect(client, normalized, manifestSha256);
    assertExpected(capturedInspection.summary, normalized.expected);

    let updated = 0;
    for (const table of TABLES) {
      updated += await applyValidatedBulk(
        client, table, normalized, manifestSha256, target,
      );
    }
    updated += await applyRows(
      client,
      normalized,
      manifestSha256,
      target,
      apply.embedder,
    );
    await verifyPostApply(client, normalized, manifestSha256, target);
    let activeSwitch: "pending" | "completed" = "pending";
    if (apply.switchActive) {
      await apply.switchActive({
        targetSpace: target,
        maintenance: true,
        quiescenceConfirmed: true,
        manifestSha256,
      });
      activeSwitch = "completed";
    }
    return {
      mode: "apply",
      total: inspected.summary.total,
      validated: inspected.summary.validated,
      reembed: inspected.summary.reembed,
      alreadyMigrated: inspected.summary.alreadyMigrated,
      shadowCaptured,
      updated,
      activeSwitch,
    };
  } catch (error) {
    if (error instanceof OperatorEmbeddingMigrationError) throw error;
    throw new OperatorEmbeddingMigrationError(
      "MIGRATION_FAILED",
      "embedding migration failed without exposing record or connection data",
    );
  }
}

interface OperatorEmbeddingCliArgs {
  readonly configPath: string;
  readonly manifestPath: string;
  readonly mode: "dry-run" | "apply";
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly confirmationToken?: string;
  readonly expectedManifestSha256?: string;
}

export interface OperatorEmbeddingCliConnection {
  readonly client: OperatorEmbeddingClient;
  close(): Promise<void>;
}

export interface OperatorEmbeddingCliDependencies {
  connect(config: MemoryConfig): Promise<OperatorEmbeddingCliConnection>;
  createEmbedder(
    config: MemoryConfig,
    manifest: OperatorEmbeddingManifest,
  ): OperatorEmbeddingBatchProvider;
  switchActive(
    config: MemoryConfig,
    expectedCurrentSpaceId: string,
    targetSpace: KnownEmbeddingSpace,
  ): Promise<void>;
}

export function createOperatorEmbeddingBatchProvider(
  config: MemoryConfig,
  manifest: OperatorEmbeddingManifest,
): OperatorEmbeddingBatchProvider {
  const configuredBaseURL = config.embedding.baseURL ?? "";
  let normalizedConfiguredEndpoint: string;
  try {
    normalizedConfiguredEndpoint = createEmbeddingSpace({
      ...manifest.target,
      baseURL: configuredBaseURL,
    }).fingerprint.baseURL;
  } catch {
    fail("EMBEDDER_TARGET_MISMATCH", "configured embedding endpoint is invalid");
  }
  if (normalizedConfiguredEndpoint !== manifest.target.baseURL) {
    fail("EMBEDDER_TARGET_MISMATCH", "configured embedding endpoint does not match manifest target");
  }
  const targetConfig: MemoryConfig["embedding"] = {
    provider: manifest.target.provider as "openai",
    apiKey: config.embedding.apiKey,
    baseURL: manifest.target.baseURL,
    model: manifest.target.model,
  };
  const embeddings = new Embeddings(targetConfig, undefined, {
    maxBatchSize: Math.min(manifest.apiBatchSize, 20),
  });
  return {
    target: manifest.target,
    embedBatch: (texts) => embeddings.embedBatch([...texts]),
  };
}

function cliArgs(argv: readonly string[]): OperatorEmbeddingCliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configPath = value("--config");
  const manifestPath = value("--manifest");
  if (!configPath || !manifestPath) {
    fail("INVALID_ARGUMENTS", "--config and --manifest are required");
  }
  return {
    configPath: resolve(configPath),
    manifestPath: resolve(manifestPath),
    mode: argv.includes("--apply") ? "apply" : "dry-run",
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    confirmationToken: value("--confirmation-token"),
    expectedManifestSha256: value("--manifest-sha256"),
  };
}

const DEFAULT_CLI_DEPENDENCIES: OperatorEmbeddingCliDependencies = {
  async connect(config): Promise<OperatorEmbeddingCliConnection> {
    if (!config.postgres) fail("INVALID_CONFIG", "Postgres configuration is required");
    const pool = new pg.Pool({ ...config.postgres, max: 1 });
    const client = await pool.connect();
    return {
      client,
      close: async () => {
        client.release();
        await pool.end();
      },
    };
  },
  createEmbedder(config, manifest): OperatorEmbeddingBatchProvider {
    return createOperatorEmbeddingBatchProvider(config, manifest);
  },
  async switchActive(config, expectedCurrentSpaceId, targetSpace): Promise<void> {
    if (!config.postgres) fail("INVALID_CONFIG", "Postgres configuration is required");
    const provider = new PostgresProvider(
      config.postgres,
      targetSpace.fingerprint.model,
      config.knowledgeBases,
    );
    try {
      const active = await provider.getActiveEmbeddingSpace();
      if (active?.embeddingSpaceId === targetSpace.embeddingSpaceId) return;
      if (!active || active.embeddingSpaceId !== expectedCurrentSpaceId) {
        fail("ACTIVE_SPACE_MISMATCH", "active embedding space does not match manifest expected-current");
      }
      await provider.switchActiveEmbeddingSpace(expectedCurrentSpaceId, targetSpace, {
        maintenance: true,
        quiescenceConfirmed: true,
      });
    } finally {
      await provider.close();
    }
  },
};

const CONFIG_ENV_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

function resolveOperatorConfigValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_CONFIG", "required operator configuration value is missing");
  }
  let unresolved = false;
  const resolved = value.replace(CONFIG_ENV_PATTERN, (_placeholder, envName: string) => {
    const replacement = process.env[envName];
    if (!replacement) {
      unresolved = true;
      return "";
    }
    return replacement;
  });
  if (unresolved || /\$\{|\}/.test(resolved) || resolved.length === 0) {
    fail("INVALID_CONFIG", "required operator configuration placeholder is unresolved");
  }
  return resolved;
}

/** 只解析迁移必需字段；不触碰 llm/server 等无关 placeholder。 */
function parseOperatorEmbeddingConfig(value: unknown): MemoryConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CONFIG", "operator config must be an object");
  }
  const root = value as Record<string, unknown>;
  if (!root.embedding || typeof root.embedding !== "object" || Array.isArray(root.embedding) ||
      !root.postgres || typeof root.postgres !== "object" || Array.isArray(root.postgres)) {
    fail("INVALID_CONFIG", "operator config requires embedding and postgres objects");
  }
  const embedding = root.embedding as Record<string, unknown>;
  const postgres = root.postgres as Record<string, unknown>;
  if (root.dbType !== "postgres") fail("INVALID_CONFIG", "dbType must be postgres");
  if (embedding.provider !== undefined && embedding.provider !== "openai") {
    fail("INVALID_CONFIG", "embedding.provider must be openai");
  }
  const port = postgres.port;
  if (!Number.isSafeInteger(port) || (port as number) < 1 || (port as number) > 65_535) {
    fail("INVALID_CONFIG", "postgres.port is invalid");
  }
  if (postgres.ssl !== undefined && typeof postgres.ssl !== "boolean") {
    fail("INVALID_CONFIG", "postgres.ssl is invalid");
  }
  return {
    dbType: "postgres",
    embedding: {
      provider: "openai",
      apiKey: resolveOperatorConfigValue(embedding.apiKey),
      baseURL: resolveOperatorConfigValue(embedding.baseURL),
      model: resolveOperatorConfigValue(embedding.model),
    },
    postgres: {
      host: resolveOperatorConfigValue(postgres.host),
      port: port as number,
      database: resolveOperatorConfigValue(postgres.database),
      user: resolveOperatorConfigValue(postgres.user),
      password: resolveOperatorConfigValue(postgres.password),
      ssl: postgres.ssl as boolean | undefined,
    },
  };
}

/**
 * 可直接执行的 operator 入口。默认在显式 READ ONLY 事务中运行 dry-run；
 * apply 只有 manifest 固定的 expected-current pointer 能触发最后的 active switch。
 */
export async function runOperatorEmbeddingMigrationCli(
  argv: readonly string[],
  dependencies: OperatorEmbeddingCliDependencies = DEFAULT_CLI_DEPENDENCIES,
): Promise<OperatorEmbeddingMigrationReport> {
  const args = cliArgs(argv);
  let loaded: LoadedOperatorEmbeddingManifest;
  let config: MemoryConfig;
  try {
    loaded = loadOperatorEmbeddingManifest(readFileSync(args.manifestPath, "utf8"));
    config = parseOperatorEmbeddingConfig(JSON.parse(readFileSync(args.configPath, "utf8")));
  } catch (error) {
    if (error instanceof OperatorEmbeddingMigrationError) throw error;
    fail("INVALID_CONFIG", "embedding migration config is invalid or has unresolved placeholders");
  }
  if (config.dbType !== "postgres" || !config.postgres) {
    fail("INVALID_CONFIG", "embedding migration requires dbType=postgres");
  }

  const connection = await dependencies.connect(config);
  try {
    if (args.mode === "dry-run") {
      await connection.client.query("BEGIN READ ONLY");
      try {
        const report = await runOperatorEmbeddingMigration(
          connection.client,
          loaded.manifest,
          loaded.sha256,
        );
        await connection.client.query("ROLLBACK");
        return report;
      } catch (error) {
        await connection.client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }

    const embedder = dependencies.createEmbedder(config, loaded.manifest);
    return await runOperatorEmbeddingMigration(
      connection.client,
      loaded.manifest,
      loaded.sha256,
      {
        mode: "apply",
        maintenance: args.maintenance,
        quiescenceConfirmed: args.quiescenceConfirmed,
        confirmationToken: args.confirmationToken ?? "",
        expectedManifestSha256: args.expectedManifestSha256 ?? "",
        embedder,
        switchActive: async ({ targetSpace }) => dependencies.switchActive(
          config,
          loaded.manifest.expectedCurrentSpaceId,
          targetSpace,
        ),
      },
    );
  } catch (error) {
    if (error instanceof OperatorEmbeddingMigrationError) throw error;
    throw new OperatorEmbeddingMigrationError(
      "MIGRATION_FAILED",
      "embedding migration CLI failed without exposing record or connection data",
    );
  } finally {
    await connection.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorEmbeddingMigrationCli(process.argv.slice(2))
    .then((report) => process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      const safe = error instanceof OperatorEmbeddingMigrationError
        ? { code: error.code, message: error.message }
        : { code: "MIGRATION_FAILED", message: "embedding migration failed" };
      process.stderr.write(`${JSON.stringify(safe)}\n`);
      process.exitCode = 1;
    });
}
