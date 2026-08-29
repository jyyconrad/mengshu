import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { memoryConfigSchema, vectorDimsForModel } from "../config.js";
import type { MemoryConfig } from "../config.js";
import { SlotContextBuilder } from "../packages/core/src/context/slot-context-builder.js";
import { createEmbeddingSpace } from "../packages/core/src/domain/embedding-space.js";
import type {
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  MemoryVisibility,
} from "../packages/core/src/domain/types.js";
import {
  CanonicalRehydrationError,
  assertCanonicalProductionApplyAuthorization,
  assertCanonicalRehydrationMode,
  assertCanonicalRehydrationRehearsalChecks,
  assertEphemeralPostgresIdentity,
  canonicalRehydrationDomainHash,
  canonicalRehydrationJson,
  canonicalRehydrationSha256,
  canonicalSourceMigrationDisposition,
  parseCanonicalProjectionBundle,
  type CanonicalProjectionBundle,
  type CanonicalRehydrationRehearsalChecks,
} from "../packages/core/src/db/migrations/canonical-postgres-rehydration.js";
import { executePostgresMigrations } from
  "../packages/core/src/db/migrations/postgres-ledger.js";
import { CURRENT_SCHEMA_VERSION } from
  "../packages/core/src/db/migrations/schema-migrations.js";
import {
  planSchemaMigrations,
  type AppliedSchemaMigration,
} from "../packages/core/src/db/migrations/schema-migrations.js";
import { parseMarkdownWorksetManifest } from
  "../packages/core/src/db/migrations/markdown-workset.js";
import { parseNativeRecordMarkdown } from
  "../packages/core/src/db/migrations/markdown-workset.js";
import { parseGovernedCanonicalManifest } from
  "../packages/core/src/documents/curation-artifacts.js";
import { Embeddings } from "../packages/core/src/runtime/llm/embeddings.js";
import { computeContentHash } from "../packages/core/src/scoring/hash-utils.js";
import {
  PostgresGovernedRetrievalCandidateSource,
  PostgresGovernedRetrievalCandidateSourceError,
} from
  "../packages/core/src/retrieval/postgres-governed-retrieval-candidate-source.js";
import { PostgresGovernedRetrievalHydrator } from
  "../packages/core/src/retrieval/postgres-governed-retrieval-hydrator.js";
import {
  decodePostgresMarkdownWorksetRow,
} from "./operator-markdown-workset.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_FILE = /^[a-z0-9][a-z0-9-]*\.jsonl$/;
const SEMANTIC_TYPES: readonly MemorySemanticType[] = [
  "profile", "task_context", "rules", "experience", "resource",
];
const POSTGRES_PORT = 55_432;
const REHEARSAL_SOURCE = "markdown-curation-p14-rehearsal";
const PRODUCTION_CONNECTION_TIMEOUT_MS = 15_000;
const PRODUCTION_QUERY_TIMEOUT_MS = 30 * 60 * 1_000;
let activeProductionPhase = "startup";

interface CliArgs {
  readonly mode: "rehearse";
  readonly migrationRoot: string;
  readonly projectionDir: string;
  readonly projectionManifestSha256: string;
  readonly sourceManifestSha256: string;
  readonly configPath: string;
  readonly outputDir: string;
}

interface ProductionPreflightArgs {
  readonly mode: "preflight";
  readonly migrationRoot: string;
  readonly projectionDir: string;
  readonly projectionManifestSha256: string;
  readonly frozenSourceManifest: string;
  readonly frozenSourceManifestSha256: string;
  readonly rehearsalReceipt: string;
  readonly rehearsalReceiptSha256: string;
  readonly configPath: string;
  readonly outputDir: string;
}

interface ProductionCachedPreflightArgs extends Omit<ProductionPreflightArgs, "mode"> {
  readonly mode: "preflight-cached";
  readonly embeddingCache: string;
  readonly embeddingCacheSha256: string;
}

interface ProductionMaterializationArgs extends Omit<ProductionPreflightArgs, "mode"> {
  readonly mode: "apply";
  readonly preflightReceipt: string;
  readonly preflightReceiptSha256: string;
  readonly embeddingCache: string;
  readonly embeddingCacheSha256: string;
  readonly governanceManifest: string;
  readonly governanceManifestSha256: string;
  readonly applyToken: string;
  readonly maintenance: true;
  readonly quiescenceConfirmed: true;
}

interface EmbeddedMemory {
  readonly assetId: string;
  readonly memoryId: string;
  readonly rowSha256: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly vector: readonly number[];
  readonly vectorText: string;
  readonly vectorSha256: string;
}

interface RehearsalArtifacts {
  readonly embeddingReceipt: Readonly<Record<string, unknown>>;
  readonly readbackReceipt: Readonly<Record<string, unknown>>;
  readonly rollbackReceipt: Readonly<Record<string, unknown>>;
  readonly finalReceipt: Readonly<Record<string, unknown>>;
}

function fail(code: string, detail?: string): never {
  throw new CanonicalRehydrationError(
    code.startsWith("CANONICAL_REHYDRATION_")
      ? code as ConstructorParameters<typeof CanonicalRehydrationError>[0]
      : "CANONICAL_REHYDRATION_REHEARSAL_FAILED",
    detail ?? (code.startsWith("CANONICAL_REHYDRATION_") ? undefined : code),
  );
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, value: string): string {
  if (!value || isAbsolute(value)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "relative path required");
  const target = resolve(root, value);
  if (!strictDescendant(root, target)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "path escapes root");
  return target;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const values = new Map<string, string>();
  const allowed = new Set([
    "mode", "migration-root", "projection-dir", "projection-manifest-sha256",
    "source-manifest-sha256", "config", "output-dir",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", "arguments must be --key value pairs");
    }
    const name = key.slice(2);
    if (!allowed.has(name) || values.has(name)) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", `invalid argument ${key}`);
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "missing argument");
  const mode = values.get("mode")!;
  assertCanonicalRehydrationMode(mode);
  const migrationRoot = resolve(values.get("migration-root")!);
  const configPath = resolve(values.get("config")!);
  if (!isAbsolute(values.get("migration-root")!) || migrationRoot !== values.get("migration-root") ||
      !isAbsolute(values.get("config")!) || configPath !== values.get("config")) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "absolute canonical paths required");
  }
  const projectionManifestSha256 = values.get("projection-manifest-sha256")!;
  const sourceManifestSha256 = values.get("source-manifest-sha256")!;
  if (!SHA256.test(projectionManifestSha256) || !SHA256.test(sourceManifestSha256)) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid sha256");
  }
  return {
    mode,
    migrationRoot,
    projectionDir: values.get("projection-dir")!,
    projectionManifestSha256,
    sourceManifestSha256,
    configPath,
    outputDir: values.get("output-dir")!,
  };
}

function pairedOptions(argv: readonly string[], allowed: ReadonlySet<string>): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") ||
        !allowed.has(key.slice(2)) || values.has(key.slice(2))) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid preflight arguments");
    }
    values.set(key.slice(2), value);
  }
  if (values.size !== allowed.size) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "missing argument");
  return values;
}

function parseProductionPreflightArgs(argv: readonly string[]): ProductionPreflightArgs {
  const allowed = new Set([
    "mode", "migration-root", "projection-dir", "projection-manifest-sha256",
    "frozen-source-manifest", "frozen-source-manifest-sha256",
    "rehearsal-receipt", "rehearsal-receipt-sha256",
    "config", "output-dir",
  ]);
  const values = pairedOptions(argv, allowed);
  if (values.get("mode") !== "preflight") {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "preflight mode required");
  }
  const migrationRoot = resolve(values.get("migration-root")!);
  const configPath = resolve(values.get("config")!);
  if (!isAbsolute(values.get("migration-root")!) || migrationRoot !== values.get("migration-root") ||
      !isAbsolute(values.get("config")!) || configPath !== values.get("config")) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "absolute canonical paths required");
  }
  for (const name of [
    "projection-manifest-sha256", "frozen-source-manifest-sha256",
    "rehearsal-receipt-sha256",
  ]) {
    if (!SHA256.test(values.get(name)!)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", name);
  }
  return {
    mode: "preflight",
    migrationRoot,
    projectionDir: values.get("projection-dir")!,
    projectionManifestSha256: values.get("projection-manifest-sha256")!,
    frozenSourceManifest: values.get("frozen-source-manifest")!,
    frozenSourceManifestSha256: values.get("frozen-source-manifest-sha256")!,
    rehearsalReceipt: values.get("rehearsal-receipt")!,
    rehearsalReceiptSha256: values.get("rehearsal-receipt-sha256")!,
    configPath,
    outputDir: values.get("output-dir")!,
  };
}

function parseProductionCachedPreflightArgs(
  argv: readonly string[],
): ProductionCachedPreflightArgs {
  const allowed = new Set([
    "mode", "migration-root", "projection-dir", "projection-manifest-sha256",
    "frozen-source-manifest", "frozen-source-manifest-sha256",
    "rehearsal-receipt", "rehearsal-receipt-sha256",
    "embedding-cache", "embedding-cache-sha256", "config", "output-dir",
  ]);
  const values = pairedOptions(argv, allowed);
  if (values.get("mode") !== "preflight-cached") {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "cached preflight mode required");
  }
  const migrationRoot = resolve(values.get("migration-root")!);
  const configPath = resolve(values.get("config")!);
  if (!isAbsolute(values.get("migration-root")!) || migrationRoot !== values.get("migration-root") ||
      !isAbsolute(values.get("config")!) || configPath !== values.get("config")) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "absolute canonical paths required");
  }
  for (const name of [
    "projection-manifest-sha256", "frozen-source-manifest-sha256",
    "rehearsal-receipt-sha256", "embedding-cache-sha256",
  ]) {
    if (!SHA256.test(values.get(name)!)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", name);
  }
  return {
    mode: "preflight-cached",
    migrationRoot,
    projectionDir: values.get("projection-dir")!,
    projectionManifestSha256: values.get("projection-manifest-sha256")!,
    frozenSourceManifest: values.get("frozen-source-manifest")!,
    frozenSourceManifestSha256: values.get("frozen-source-manifest-sha256")!,
    rehearsalReceipt: values.get("rehearsal-receipt")!,
    rehearsalReceiptSha256: values.get("rehearsal-receipt-sha256")!,
    embeddingCache: values.get("embedding-cache")!,
    embeddingCacheSha256: values.get("embedding-cache-sha256")!,
    configPath,
    outputDir: values.get("output-dir")!,
  };
}

function parseProductionMaterializationArgs(
  argv: readonly string[],
): ProductionMaterializationArgs {
  const allowed = new Set([
    "mode", "migration-root", "projection-dir", "projection-manifest-sha256",
    "frozen-source-manifest", "frozen-source-manifest-sha256",
    "rehearsal-receipt", "rehearsal-receipt-sha256",
    "preflight-receipt", "preflight-receipt-sha256",
    "embedding-cache", "embedding-cache-sha256",
    "governance-manifest", "governance-manifest-sha256",
    "config", "output-dir", "apply-token", "maintenance", "quiescence-confirmed",
  ]);
  const values = pairedOptions(argv, allowed);
  if (values.get("mode") !== "apply" || values.get("maintenance") !== "true" ||
      values.get("quiescence-confirmed") !== "true") {
    fail("CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED");
  }
  const migrationRoot = resolve(values.get("migration-root")!);
  const configPath = resolve(values.get("config")!);
  if (!isAbsolute(values.get("migration-root")!) || migrationRoot !== values.get("migration-root") ||
      !isAbsolute(values.get("config")!) || configPath !== values.get("config")) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "absolute canonical paths required");
  }
  for (const name of [
    "projection-manifest-sha256", "frozen-source-manifest-sha256",
    "rehearsal-receipt-sha256", "preflight-receipt-sha256",
    "embedding-cache-sha256", "governance-manifest-sha256",
  ]) {
    if (!SHA256.test(values.get(name)!)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", name);
  }
  return {
    mode: "apply",
    migrationRoot,
    projectionDir: values.get("projection-dir")!,
    projectionManifestSha256: values.get("projection-manifest-sha256")!,
    frozenSourceManifest: values.get("frozen-source-manifest")!,
    frozenSourceManifestSha256: values.get("frozen-source-manifest-sha256")!,
    rehearsalReceipt: values.get("rehearsal-receipt")!,
    rehearsalReceiptSha256: values.get("rehearsal-receipt-sha256")!,
    preflightReceipt: values.get("preflight-receipt")!,
    preflightReceiptSha256: values.get("preflight-receipt-sha256")!,
    embeddingCache: values.get("embedding-cache")!,
    embeddingCacheSha256: values.get("embedding-cache-sha256")!,
    governanceManifest: values.get("governance-manifest")!,
    governanceManifestSha256: values.get("governance-manifest-sha256")!,
    configPath,
    outputDir: values.get("output-dir")!,
    applyToken: values.get("apply-token")!,
    maintenance: true,
    quiescenceConfirmed: true,
  };
}

async function readNoSymlink(path: string): Promise<string> {
  const info = await lstat(path).catch(() => fail("CANONICAL_REHYDRATION_INVALID_INPUT", "missing file"));
  if (!info.isFile() || info.isSymbolicLink()) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "regular file required");
  }
  return readFile(path, "utf8");
}

async function readProjection(args: Pick<CliArgs,
  "migrationRoot" | "projectionDir" | "projectionManifestSha256"
>): Promise<CanonicalProjectionBundle> {
  const projectionRoot = containedPath(args.migrationRoot, args.projectionDir);
  const projectionInfo = await lstat(projectionRoot)
    .catch(() => fail("CANONICAL_REHYDRATION_INVALID_INPUT", "projection directory missing"));
  if (!projectionInfo.isDirectory() || projectionInfo.isSymbolicLink()) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "projection directory invalid");
  }
  const manifestText = await readNoSymlink(resolve(projectionRoot, "projection-manifest.json"));
  if (canonicalRehydrationSha256(manifestText) !== args.projectionManifestSha256) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "projection manifest");
  }
  const raw = JSON.parse(manifestText) as { files?: Record<string, { file?: unknown }> };
  const names = [
    "canonicalMemoryRows", "governedDocumentRows", "claimEvidenceRows",
    "sourceMappingRows", "embeddingJobs",
  ] as const;
  const fileTexts: Record<string, string> = {};
  for (const name of names) {
    const file = raw.files?.[name]?.file;
    if (typeof file !== "string" || !SAFE_FILE.test(file) || basename(file) !== file) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", `invalid projection file ${name}`);
    }
    fileTexts[name] = await readNoSymlink(resolve(projectionRoot, file));
  }
  return parseCanonicalProjectionBundle({
    projectionManifest: manifestText,
    canonicalMemoryRows: fileTexts.canonicalMemoryRows!,
    governedDocumentRows: fileTexts.governedDocumentRows!,
    claimEvidenceRows: fileTexts.claimEvidenceRows!,
    sourceMappingRows: fileTexts.sourceMappingRows!,
    embeddingJobs: fileTexts.embeddingJobs!,
  });
}

function runProgram(file: string, args: readonly string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], { maxBuffer: 16 * 1024 * 1024 }, (error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}

async function writeExclusive(path: string, value: unknown): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(canonicalRehydrationJson(value), "utf8");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function finiteVector(value: readonly number[], dimensions: number): boolean {
  return value.length === dimensions && value.every((item) => Number.isFinite(item));
}

async function embedProjection(
  bundle: CanonicalProjectionBundle,
  configPath: string,
): Promise<Readonly<{
  memories: readonly EmbeddedMemory[];
  receipt: Readonly<Record<string, unknown>>;
  model: string;
  dimensions: number;
  embeddingSpaceId: string;
  baseURL: string;
}>> {
  const configText = await readNoSymlink(configPath);
  const rawConfig = JSON.parse(configText) as Record<string, unknown>;
  const config = memoryConfigSchema.parse({
    embedding: rawConfig.embedding,
    ...(rawConfig.batchProcessing === undefined
      ? {}
      : { batchProcessing: rawConfig.batchProcessing }),
  });
  const model = config.embedding.model ?? "text-embedding-3-small";
  const dimensions = vectorDimsForModel(model);
  const embedding = new Embeddings(config.embedding, config.batchProcessing, {
    concurrency: Math.min(config.batchProcessing?.concurrency ?? 3, 3),
    maxBatchSize: Math.min(config.batchProcessing?.maxBatchSize ?? 20, 20),
    maxRetries: config.batchProcessing?.retryAttempts ?? 3,
  });
  const texts = bundle.memories.map((memory) => String(memory.row.text));
  const startedAt = new Date().toISOString();
  const vectors = await embedding.embedBatch([...texts]);
  if (vectors.length !== bundle.memories.length ||
      vectors.some((vector) => !finiteVector(vector, dimensions))) {
    fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "embedding response shape invalid");
  }
  const memories = bundle.memories.map((memory, index): EmbeddedMemory => {
    const vector = vectors[index]!;
    return {
      assetId: memory.assetId,
      memoryId: memory.memoryId,
      rowSha256: memory.rowSha256,
      row: memory.row,
      vector,
      vectorText: `[${vector.join(",")}]`,
      vectorSha256: canonicalRehydrationDomainHash("mengshu.embedding-vector/v1", vector),
    };
  });
  const vectorSetHash = canonicalRehydrationDomainHash(
    "mengshu.embedding-vector-set/v1",
    memories.map((memory) => ({ memoryId: memory.memoryId, vectorSha256: memory.vectorSha256 })),
  );
  const embeddingSpace = createEmbeddingSpace({
    provider: config.embedding.provider,
    baseURL: config.embedding.baseURL!,
    model,
    dim: dimensions,
    normalization: "none",
  }, "reembedded");
  return Object.freeze({
    memories: Object.freeze(memories),
    model,
    dimensions,
    embeddingSpaceId: embeddingSpace.embeddingSpaceId,
    baseURL: embeddingSpace.fingerprint.baseURL,
    receipt: Object.freeze({
      schema: "mengshu.p14-embedding-rehearsal-receipt/v1",
      projectionHash: bundle.manifest.projectionHash,
      startedAt,
      completedAt: new Date().toISOString(),
      provider: embeddingSpace.fingerprint.provider,
      providerFingerprint: canonicalRehydrationDomainHash("mengshu.embedding-provider/v1", {
        baseURL: embeddingSpace.fingerprint.baseURL,
        model,
        dimensions,
      }),
      model,
      dimensions,
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      jobsExpected: bundle.embeddingJobs.length,
      jobsCompleted: memories.length,
      vectorSetHash,
      vectorReuseCount: 0,
      networkExecuted: true,
      credentialsPersisted: false,
    }),
  });
}

function parseOperatorConfig(configText: string): MemoryConfig {
  const rawConfig = JSON.parse(configText) as Record<string, unknown>;
  return memoryConfigSchema.parse({
    embedding: rawConfig.embedding,
    dbType: rawConfig.dbType,
    postgres: rawConfig.postgres,
    ...(rawConfig.batchProcessing === undefined
      ? {}
      : { batchProcessing: rawConfig.batchProcessing }),
  });
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
  return `"${value}"`;
}

async function bootstrapPostgres(pool: pg.Pool, dimensions: number) {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  for (const [table, importance, dataType] of [
    ["memories", "0.7", "memory"], ["knowledge", "0.5", "knowledge"],
  ] as const) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${table} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), text TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE, vector vector(${dimensions}) NOT NULL,
      importance FLOAT NOT NULL DEFAULT ${importance}, category TEXT NOT NULL DEFAULT 'other',
      data_type TEXT NOT NULL DEFAULT '${dataType}', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), project_name TEXT, app_name TEXT,
      user_id TEXT, agent_id TEXT, workspace_id TEXT
    )`);
  }
  const client = await pool.connect();
  try {
    const result = await executePostgresMigrations({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const response = await client.query(sql, [...params]);
        return { rows: response.rows as Row[], rowCount: response.rowCount };
      },
    }, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    const ledger = await client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM mengshu_schema_migrations",
    );
    if (result.toVersion !== CURRENT_SCHEMA_VERSION || result.pendingContractVersions.length !== 0 ||
        Number(ledger.rows[0]?.count) !== CURRENT_SCHEMA_VERSION) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "schema v27 not ready");
    }
    return result;
  } finally {
    client.release();
  }
}

async function insertBatches(
  pool: Pick<pg.Pool, "query">,
  rows: readonly unknown[],
  sql: string,
  batchSize: number,
  parameters: readonly unknown[] = [],
): Promise<number> {
  let inserted = 0;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const batch = rows.slice(offset, offset + batchSize);
    const result = await pool.query(sql, [JSON.stringify(batch), ...parameters]);
    if (result.rowCount !== batch.length) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "staging row count mismatch");
    }
    inserted += result.rowCount;
  }
  return inserted;
}

async function createAndLoadShadow(
  pool: pg.Pool,
  schemaName: string,
  bundle: CanonicalProjectionBundle,
  embedded: Awaited<ReturnType<typeof embedProjection>>,
): Promise<Readonly<Record<string, number>>> {
  const schema = quoteIdentifier(schemaName);
  await pool.query(`CREATE SCHEMA ${schema}`);
  await pool.query(`CREATE TABLE ${schema}.canonical_memories (
    asset_id TEXT PRIMARY KEY, memory_id UUID NOT NULL UNIQUE, row_sha256 TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL, content_hash TEXT NOT NULL UNIQUE, importance DOUBLE PRECISION NOT NULL,
    semantic_type TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, row_payload JSONB NOT NULL,
    vector vector(${embedded.dimensions}) NOT NULL, vector_sha256 TEXT NOT NULL,
    embedding_space_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state = 'reembedded')
  )`);
  await pool.query(`CREATE TABLE ${schema}.governed_documents (
    asset_id TEXT PRIMARY KEY, asset_version INTEGER NOT NULL, memory_id UUID NOT NULL UNIQUE,
    semantic_type TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, public_content_hash TEXT NOT NULL,
    governance_projection_hash TEXT NOT NULL, row_sha256 TEXT NOT NULL UNIQUE,
    row_payload JSONB NOT NULL, state TEXT NOT NULL CHECK (state = 'complete')
  )`);
  await pool.query(`CREATE TABLE ${schema}.claim_evidence (
    evidence_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL, asset_version INTEGER NOT NULL,
    claim_id TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, source_ref TEXT NOT NULL,
    source_hash TEXT NOT NULL, row_sha256 TEXT NOT NULL UNIQUE, row_payload JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.source_mappings (
    source_ref TEXT PRIMARY KEY, source_table TEXT NOT NULL, source_record_id TEXT NOT NULL,
    source_hash TEXT NOT NULL, scope_fingerprint TEXT NOT NULL, disposition TEXT NOT NULL,
    operation TEXT NOT NULL, target_asset_ids JSONB NOT NULL, target_memory_ids JSONB NOT NULL,
    evidence_refs JSONB NOT NULL, reason_code TEXT NOT NULL, mapping_sha256 TEXT NOT NULL UNIQUE,
    row_payload JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.embedding_jobs (
    job_id TEXT PRIMARY KEY, asset_id TEXT NOT NULL UNIQUE, memory_id UUID NOT NULL UNIQUE,
    content_hash TEXT NOT NULL, vector_sha256 TEXT NOT NULL, state TEXT NOT NULL CHECK (state = 'completed')
  )`);
  await pool.query(`CREATE TABLE ${schema}.tree_rows (
    tree_id TEXT PRIMARY KEY, tree_type TEXT NOT NULL, row_payload JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.graph_edges (
    edge_id TEXT PRIMARY KEY, source_asset_id TEXT NOT NULL, target_asset_id TEXT NOT NULL,
    relation_type TEXT NOT NULL, row_payload JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE ${schema}.resource_rows (
    asset_id TEXT PRIMARY KEY, row_payload JSONB NOT NULL
  )`);

  const memoryRows = embedded.memories.map((memory) => ({
    asset_id: memory.assetId,
    memory_id: memory.memoryId,
    row_sha256: memory.rowSha256,
    text: memory.row.text,
    content_hash: memory.row.content_hash,
    importance: memory.row.importance,
    semantic_type: memory.row.data_type,
    scope_fingerprint: memory.row.scope_key,
    row_payload: memory.row,
    vector: memory.vectorText,
    vector_sha256: memory.vectorSha256,
    embedding_space_id: embedded.embeddingSpaceId,
  }));
  await insertBatches(pool, memoryRows, `INSERT INTO ${schema}.canonical_memories
    SELECT x.asset_id, x.memory_id::uuid, x.row_sha256, x.text, x.content_hash, x.importance,
      x.semantic_type, x.scope_fingerprint, x.row_payload, x.vector::vector, x.vector_sha256,
      x.embedding_space_id, 'reembedded'
    FROM jsonb_to_recordset($1::jsonb) AS x(
      asset_id text, memory_id text, row_sha256 text, text text, content_hash text,
      importance double precision, semantic_type text, scope_fingerprint text,
      row_payload jsonb, vector text, vector_sha256 text, embedding_space_id text
    )`, 40);
  await insertBatches(pool, bundle.documents.map((row) => ({
    ...row,
    row_payload: row,
  })), `INSERT INTO ${schema}.governed_documents
    SELECT x."assetId", x."assetVersion", x."memoryId"::uuid, x."semanticType",
      x."scopeFingerprint", x."publicContentHash", x."governanceProjectionHash",
      x."rowSha256", x.row_payload, 'complete'
    FROM jsonb_to_recordset($1::jsonb) AS x(
      "assetId" text, "assetVersion" integer, "memoryId" text, "semanticType" text,
      "scopeFingerprint" text, "publicContentHash" text, "governanceProjectionHash" text,
      "rowSha256" text, row_payload jsonb
    )`, 200);
  await insertBatches(pool, bundle.evidence.map((row) => ({ ...row, row_payload: row })),
    `INSERT INTO ${schema}.claim_evidence
      SELECT x."evidenceId", x."assetId", x."assetVersion", x."claimId",
        x."scopeFingerprint", x."sourceRef", x."sourceHash", x."rowSha256", x.row_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(
        "evidenceId" text, "assetId" text, "assetVersion" integer, "claimId" text,
        "scopeFingerprint" text, "sourceRef" text, "sourceHash" text,
        "rowSha256" text, row_payload jsonb
      )`, 500);
  await insertBatches(pool, bundle.mappings.map((row) => ({ ...row, row_payload: row })),
    `INSERT INTO ${schema}.source_mappings
      SELECT x."sourceRef", x."sourceTable", x."sourceRecordId", x."sourceHash",
        x."scopeFingerprint", x.disposition, x.operation, x."targetAssetIds",
        x."targetMemoryIds", x."evidenceRefs", x."reasonCode", x."mappingSha256", x.row_payload
      FROM jsonb_to_recordset($1::jsonb) AS x(
        "sourceRef" text, "sourceTable" text, "sourceRecordId" text, "sourceHash" text,
        "scopeFingerprint" text, disposition text, operation text, "targetAssetIds" jsonb,
        "targetMemoryIds" jsonb, "evidenceRefs" jsonb, "reasonCode" text,
        "mappingSha256" text, row_payload jsonb
      )`, 200);
  await insertBatches(pool, embedded.memories.map((memory, index) => ({
    job_id: bundle.embeddingJobs[index]!.jobId,
    asset_id: memory.assetId,
    memory_id: memory.memoryId,
    content_hash: memory.row.content_hash,
    vector_sha256: memory.vectorSha256,
  })), `INSERT INTO ${schema}.embedding_jobs
    SELECT x.job_id, x.asset_id, x.memory_id::uuid, x.content_hash, x.vector_sha256, 'completed'
    FROM jsonb_to_recordset($1::jsonb) AS x(
      job_id text, asset_id text, memory_id text, content_hash text, vector_sha256 text
    )`, 200);
  const graphEdges = bundle.documents.flatMap((document) => document.relations.map((relation, index) => ({
    edge_id: canonicalRehydrationDomainHash("mengshu.p14-graph-edge/v1", {
      assetId: document.assetId, index, relation,
    }),
    source_asset_id: document.assetId,
    target_asset_id: relation.targetAssetId,
    relation_type: relation.type,
    row_payload: relation,
  })));
  await insertBatches(pool, graphEdges, `INSERT INTO ${schema}.graph_edges
    SELECT x.edge_id, x.source_asset_id, x.target_asset_id, x.relation_type, x.row_payload
    FROM jsonb_to_recordset($1::jsonb) AS x(
      edge_id text, source_asset_id text, target_asset_id text, relation_type text, row_payload jsonb
    )`, 200);
  await pool.query(`CREATE INDEX canonical_memories_vector_hnsw_idx ON ${schema}.canonical_memories
    USING hnsw (vector vector_cosine_ops)`);
  await pool.query(`CREATE INDEX canonical_memories_lookup_idx ON ${schema}.canonical_memories
    (scope_fingerprint, semantic_type, content_hash)`);
  await pool.query(`CREATE INDEX canonical_memories_fts_idx ON ${schema}.canonical_memories
    USING gin (to_tsvector('simple', text))`);
  await pool.query(`CREATE INDEX claim_evidence_asset_claim_idx ON ${schema}.claim_evidence
    (scope_fingerprint, asset_id, claim_id)`);
  await pool.query(`CREATE INDEX source_mappings_operation_idx ON ${schema}.source_mappings
    (scope_fingerprint, operation, source_ref)`);
  await pool.query(`CREATE INDEX graph_edges_source_idx ON ${schema}.graph_edges
    (source_asset_id, relation_type)`);
  return Object.freeze({
    memories: memoryRows.length,
    documents: bundle.documents.length,
    evidence: bundle.evidence.length,
    mappings: bundle.mappings.length,
    embeddingJobs: embedded.memories.length,
    trees: 0,
    resources: 0,
    graphEdges: graphEdges.length,
  });
}

function scopeFromRow(row: Readonly<Record<string, unknown>>): MemoryScope {
  const scope: MemoryScope = {
    tenantId: String(row.tenant_id),
    appId: String(row.product_id),
    userId: String(row.user_id),
    projectId: String(row.canonical_project_id),
    agentId: String(row.producer_id),
    namespace: String(row.namespace),
    visibility: String(row.visibility) as MemoryVisibility,
  };
  if (typeof row.workspace_id === "string" && row.workspace_id.length > 0) {
    scope.workspaceId = row.workspace_id;
  }
  const metadata = row.metadata as Record<string, unknown> | undefined;
  const governance = metadata?.governance as Record<string, unknown> | undefined;
  const provenance = governance?.provenance as Record<string, unknown> | undefined;
  const sessionId = metadata?.sessionId ?? provenance?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) scope.sessionId = sessionId;
  return scope;
}

async function verifyFiveSlots(
  bundle: CanonicalProjectionBundle,
): Promise<Readonly<Record<string, unknown>>> {
  const evidenceByAsset = new Map<string, string[]>();
  for (const evidence of bundle.evidence) {
    const refs = evidenceByAsset.get(evidence.assetId) ?? [];
    if (!refs.includes(evidence.sourceMemoryId)) refs.push(evidence.sourceMemoryId);
    evidenceByAsset.set(evidence.assetId, refs);
  }
  const records = bundle.memories.map((memory): MemoryRecord => ({
    id: memory.memoryId,
    scope: scopeFromRow(memory.row),
    kind: String((memory.row.metadata as Record<string, unknown>).governance &&
      (((memory.row.metadata as Record<string, unknown>).governance as Record<string, unknown>)
        .native as Record<string, unknown>).kind) as MemoryRecord["kind"],
    semanticType: (memory.row.metadata as Record<string, unknown>)
      .semanticType as MemorySemanticType,
    lifecycleStatus: "active",
    text: String(memory.row.text),
    contentHash: String(memory.row.content_hash),
    importance: Number(memory.row.importance),
    category: memory.row.category as MemoryRecord["category"],
    dataType: "memory",
    metadata: memory.row.metadata as Record<string, unknown>,
    provenance: (((memory.row.metadata as Record<string, unknown>).governance as
      Record<string, unknown>).provenance ?? { source: "markdown-curation" }) as
      Record<string, unknown>,
    sourceNodeIds: evidenceByAsset.get(memory.assetId) ?? [],
    createdAt: Date.parse(String(memory.row.created_at)),
  }));
  const byScope = new Map<string, MemoryRecord[]>();
  for (const record of records) {
    const key = canonicalRehydrationDomainHash("scope", record.scope);
    const group = byScope.get(key) ?? [];
    group.push(record);
    byScope.set(key, group);
  }
  const observed = new Set<MemorySemanticType>();
  const builder = new SlotContextBuilder();
  for (const group of byScope.values()) {
    const response = await builder.buildSlotContext(group[0]!.scope, group, {
      useCache: false,
      latencyBudgetMs: 0,
    });
    for (const type of SEMANTIC_TYPES) {
      const block = response.slots[type];
      if (block && block.nodeCount > 0) observed.add(type);
      if (block && block.sourceIds.some((id) => !group.some((record) => record.id === id))) {
        fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "slot scope leak");
      }
    }
  }
  const inputCounts = Object.fromEntries(SEMANTIC_TYPES.map((type) => [
    type, records.filter((record) => record.semanticType === type).length,
  ]));
  for (const type of SEMANTIC_TYPES) {
    if ((inputCounts[type] > 0) !== observed.has(type)) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", `slot coverage ${type}`);
    }
  }
  return Object.freeze({
    contractSlots: SEMANTIC_TYPES,
    inputCounts,
    observedNonEmptySlots: [...observed].sort(),
    emptyByFrozenInput: SEMANTIC_TYPES.filter((type) => inputCounts[type] === 0),
    scopeLeakCount: 0,
    exercised: true,
  });
}

async function snapshotHash(pool: pg.Pool, schemaName: string): Promise<string> {
  const schema = quoteIdentifier(schemaName);
  const tables = [
    ["canonical_memories", "asset_id", "row_sha256"],
    ["governed_documents", "asset_id", "row_sha256"],
    ["claim_evidence", "evidence_id", "row_sha256"],
    ["source_mappings", "source_ref", "mapping_sha256"],
    ["embedding_jobs", "job_id", "vector_sha256"],
    ["graph_edges", "edge_id", "edge_id"],
  ] as const;
  const snapshot: Record<string, unknown> = {};
  for (const [table, id, hash] of tables) {
    const result = await pool.query(`SELECT ${id} AS id, ${hash} AS hash FROM ${schema}.${table}
      ORDER BY ${id} COLLATE "C"`);
    snapshot[table] = result.rows;
  }
  snapshot.treeCount = Number((await pool.query(
    `SELECT count(*)::text AS count FROM ${schema}.tree_rows`,
  )).rows[0]?.count);
  snapshot.resourceCount = Number((await pool.query(
    `SELECT count(*)::text AS count FROM ${schema}.resource_rows`,
  )).rows[0]?.count);
  return canonicalRehydrationDomainHash("mengshu.p14-shadow-snapshot/v1", snapshot);
}

async function nativeSnapshotHash(pool: pg.Pool, runId: string): Promise<string> {
  const memories = await pool.query(
    `SELECT id::text AS id, content_hash, embedding_space_id, embedding_space_state
     FROM memories WHERE metadata->>'p14RunId' = $1 ORDER BY id::text COLLATE "C"`, [runId],
  );
  const evidence = await pool.query(
    `SELECT link_id FROM mengshu_memory_evidence_links WHERE source = $1
     ORDER BY link_id COLLATE "C"`, [REHEARSAL_SOURCE],
  );
  return canonicalRehydrationDomainHash("mengshu.p14-native-snapshot/v1", {
    memories: memories.rows,
    evidence: evidence.rows,
  });
}

function rehearsalEvidenceRows(
  bundle: CanonicalProjectionBundle,
  runId: string,
): readonly Readonly<Record<string, unknown>>[] {
  const memoryByAsset = new Map(bundle.memories.map((memory) => [memory.assetId, memory] as const));
  const rows = new Map<string, Readonly<Record<string, unknown>>>();
  for (const evidence of bundle.evidence) {
    const memory = memoryByAsset.get(evidence.assetId);
    if (!memory) fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "evidence target missing");
    const existing = rows.get(evidence.sourceMemoryId);
    if (existing && existing.scope_key !== evidence.scopeFingerprint) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "evidence scope conflict");
    }
    if (existing) continue;
    const text = `P14 native evidence ${evidence.sourceMemoryId}`;
    const sourceId = evidence.sourceMemoryId;
    const scope = memory.row;
    const sessionId = ((scope.metadata as Record<string, unknown>)?.sessionId);
    rows.set(sourceId, Object.freeze({
      id: sourceId,
      text,
      content_hash: computeContentHash(text),
      importance: 0.5,
      category: "core",
      data_type: "memory",
      metadata: {
        p14RunId: runId,
        admissionRoute: "evidence_only",
        contextEligible: false,
        memoryContainer: "session_candidate",
        eventType: "observation",
        sourceNodeIds: [sourceId],
        governance: {
          commandType: "importEvidence",
          evidenceIds: [sourceId],
          candidate: {
            phase: "raw_evidence",
            evidenceOnly: true,
            quote: text,
            sourceId,
          },
          provenance: {
            source: "markdown-curation-p14",
            sourceId,
            ...(typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : {}),
          },
          native: {
            kind: "observation",
            container: "session_candidate",
            category: "core",
            dataType: "memory",
          },
        },
      },
      created_at: scope.created_at,
      project_name: scope.project_name,
      app_name: scope.app_name,
      user_id: scope.user_id,
      agent_id: scope.agent_id,
      workspace_id: scope.workspace_id,
      tenant_id: scope.tenant_id,
      canonical_project_id: scope.canonical_project_id,
      product_id: scope.product_id,
      producer_id: scope.producer_id,
      namespace: scope.namespace,
      visibility: scope.visibility,
      lifecycle_status: "archived",
      embedding_space_id: null,
      embedding_space_state: "pending_reembed",
      legacy_quarantine_reason: null,
      scope_key: evidence.scopeFingerprint,
    }));
  }
  return Object.freeze([...rows.values()].sort((left, right) =>
    String(left.id).localeCompare(String(right.id))));
}

async function activateNative(
  pool: pg.Pool,
  schemaName: string,
  bundle: CanonicalProjectionBundle,
  embedded: Awaited<ReturnType<typeof embedProjection>>,
  runId: string,
  beforeSnapshotHash: string,
): Promise<string> {
  const schema = quoteIdentifier(schemaName);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (await nativeSnapshotHash(client as unknown as pg.Pool, runId) !== beforeSnapshotHash) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "native before-image CAS drift");
    }
    await client.query(`INSERT INTO mengshu_embedding_spaces (
      embedding_space_id, provider, base_url, model, dimensions, normalization, state
    ) VALUES ($1, 'openai', $2, $3, $4, 'none', 'reembedded')`, [
      embedded.embeddingSpaceId, embedded.baseURL, embedded.model, embedded.dimensions,
    ]);
    await client.query(`INSERT INTO mengshu_active_embedding_space (
      singleton_key, embedding_space_id
    ) VALUES ('active', $1)`, [embedded.embeddingSpaceId]);
    const nativeEvidence = rehearsalEvidenceRows(bundle, runId).map((row) => ({
      ...row,
      vector: embedded.memories[0]!.vectorText,
    }));
    await insertBatches(client, nativeEvidence, `INSERT INTO memories (
      id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
      project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
      canonical_project_id, product_id, producer_id, namespace, visibility,
      lifecycle_status, embedding_space_id, embedding_space_state, legacy_quarantine_reason,
      scope_key
    ) SELECT x.id::uuid, x.text, x.content_hash, x.vector::vector, x.importance,
      x.category, x.data_type, x.metadata, x.created_at::timestamptz,
      x.project_name, x.app_name, x.user_id, x.agent_id, x.workspace_id,
      x.tenant_id, x.canonical_project_id, x.product_id, x.producer_id,
      x.namespace, x.visibility, x.lifecycle_status, x.embedding_space_id,
      x.embedding_space_state, x.legacy_quarantine_reason, x.scope_key
    FROM jsonb_to_recordset($1::jsonb) AS x(
      id text, text text, content_hash text, vector text, importance double precision,
      category text, data_type text, metadata jsonb, created_at text,
      project_name text, app_name text, user_id text, agent_id text, workspace_id text,
      tenant_id text, canonical_project_id text, product_id text, producer_id text,
      namespace text, visibility text, lifecycle_status text, embedding_space_id text,
      embedding_space_state text, legacy_quarantine_reason text, scope_key text
    )`, 100);
    const inserted = await client.query(`INSERT INTO memories (
      id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
      project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
      canonical_project_id, product_id, producer_id, namespace, visibility,
      lifecycle_status, embedding_space_id, embedding_space_state, legacy_quarantine_reason,
      scope_key
    ) SELECT memory_id, text, content_hash, vector, importance,
      row_payload->>'category', row_payload->>'data_type',
      row_payload->'metadata' || jsonb_build_object('p14RunId', $1::text),
      (row_payload->>'created_at')::timestamptz, row_payload->>'project_name',
      row_payload->>'app_name', row_payload->>'user_id', row_payload->>'agent_id',
      row_payload->>'workspace_id', row_payload->>'tenant_id',
      row_payload->>'canonical_project_id', row_payload->>'product_id',
      row_payload->>'producer_id', row_payload->>'namespace', row_payload->>'visibility',
      'active', embedding_space_id, 'reembedded', NULL, scope_fingerprint
    FROM ${schema}.canonical_memories`, [runId]);
    if (inserted.rowCount !== bundle.memories.length) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "native memory insert mismatch");
    }
    const directLinks = bundle.memories.flatMap((memory) => {
      const metadata = memory.row.metadata as Record<string, unknown>;
      const ids = metadata.sourceNodeIds as readonly string[];
      return ids.map((evidenceMemoryId) => ({
        link_id: canonicalRehydrationDomainHash("mengshu.p14-native-evidence-link/v1", {
          targetMemoryId: memory.memoryId,
          evidenceMemoryId,
        }),
        scope_fingerprint: memory.row.scope_key,
        tenant_id: memory.row.tenant_id,
        user_id: memory.row.user_id,
        app_id: memory.row.product_id,
        project_id: memory.row.canonical_project_id,
        agent_id: memory.row.producer_id,
        namespace: memory.row.namespace,
        visibility: memory.row.visibility,
        workspace_id: memory.row.workspace_id ?? "",
        session_id: metadata.sessionId ?? "",
        target_memory_id: memory.memoryId,
        evidence_memory_id: evidenceMemoryId,
      }));
    });
    const evidence = await insertBatches(client, directLinks,
      `INSERT INTO mengshu_memory_evidence_links (
        link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id,
        namespace, visibility, workspace_id, session_id, target_memory_id,
        evidence_memory_id, link_kind, source, created_at
      ) SELECT x.link_id, x.scope_fingerprint, x.tenant_id, x.user_id, x.app_id,
        x.project_id, x.agent_id, x.namespace, x.visibility, x.workspace_id,
        x.session_id, x.target_memory_id, x.evidence_memory_id, 'grounded_by', $2, $3
      FROM jsonb_to_recordset($1::jsonb) AS x(
        link_id text, scope_fingerprint text, tenant_id text, user_id text, app_id text,
        project_id text, agent_id text, namespace text, visibility text, workspace_id text,
        session_id text, target_memory_id text, evidence_memory_id text
      )`, 200, [REHEARSAL_SOURCE, Date.now()]);
    if (evidence !== directLinks.length) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "native evidence insert mismatch");
    }
    await client.query(`UPDATE mengshu_markdown_migration_runs
      SET status = 'activated', activated_at = $2, updated_at = $2
      WHERE run_id = $1 AND status = 'verified'`, [runId, Date.now()]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return nativeSnapshotHash(pool, runId);
}

async function verifyReadback(
  pool: pg.Pool,
  schemaName: string,
  bundle: CanonicalProjectionBundle,
  embedded: Awaited<ReturnType<typeof embedProjection>>,
  slotReceipt: Readonly<Record<string, unknown>>,
  expectedShadowHash: string,
  expectedNativeHash: string,
): Promise<Readonly<Record<string, unknown>>> {
  const schema = quoteIdentifier(schemaName);
  const counts = await pool.query(`SELECT
    (SELECT count(*) FROM ${schema}.canonical_memories)::text AS memories,
    (SELECT count(*) FROM ${schema}.governed_documents)::text AS documents,
    (SELECT count(*) FROM ${schema}.claim_evidence)::text AS evidence,
    (SELECT count(*) FROM ${schema}.source_mappings)::text AS mappings,
    (SELECT count(*) FROM ${schema}.embedding_jobs)::text AS embedding_jobs,
    (SELECT count(*) FROM ${schema}.tree_rows)::text AS trees,
    (SELECT count(*) FROM ${schema}.resource_rows)::text AS resources,
    (SELECT count(*) FROM ${schema}.graph_edges)::text AS graph_edges`);
  const countRow = counts.rows[0] as Record<string, string>;
  const expectedRelations = bundle.documents.reduce((sum, row) => sum + row.relations.length, 0);
  const countChecks = Number(countRow.memories) === bundle.memories.length &&
    Number(countRow.documents) === bundle.documents.length &&
    Number(countRow.evidence) === bundle.evidence.length &&
    Number(countRow.mappings) === bundle.mappings.length &&
    Number(countRow.embedding_jobs) === bundle.embeddingJobs.length &&
    Number(countRow.trees) === Number(bundle.manifest.counts.treeRowInsert) &&
    Number(countRow.resources) === bundle.memories.filter((row) => row.row.data_type === "resource").length &&
    Number(countRow.graph_edges) === expectedRelations;
  const first = embedded.memories[0]!;
  const vectorRead = await pool.query(`SELECT memory_id::text AS memory_id, vector_dims(vector) AS dim
    FROM ${schema}.canonical_memories ORDER BY vector <=> $1::vector LIMIT 1`, [first.vectorText]);
  const canonical = await pool.query(`SELECT m.memory_id::text AS memory_id, m.content_hash,
      m.row_payload->'metadata'->>'publicContentHash' AS projected_public_content_hash,
      d.public_content_hash, d.state
    FROM ${schema}.canonical_memories m JOIN ${schema}.governed_documents d USING (asset_id)
    WHERE m.memory_id = $1`, [first.memoryId]);
  const drilldown = await pool.query(`SELECT count(*)::text AS count
    FROM ${schema}.claim_evidence e
    JOIN ${schema}.governed_documents d USING (asset_id)
    JOIN ${schema}.canonical_memories m USING (asset_id)
    JOIN ${schema}.source_mappings s ON s.source_ref = e.source_ref
    WHERE e.scope_fingerprint = d.scope_fingerprint
      AND d.scope_fingerprint = m.scope_fingerprint`, []);
  const distinctScopes = await pool.query(`SELECT count(DISTINCT scope_fingerprint)::text AS count
    FROM ${schema}.canonical_memories`);
  const scopeLeak = await pool.query(`SELECT count(*)::text AS count
    FROM ${schema}.canonical_memories m JOIN ${schema}.governed_documents d USING (asset_id)
    WHERE m.scope_fingerprint <> d.scope_fingerprint`);
  const missingScope = await pool.query(`SELECT count(*)::text AS count
    FROM ${schema}.canonical_memories WHERE scope_fingerprint = $1`, ["f".repeat(64)]);
  const indexes = await pool.query(`SELECT indexname FROM pg_indexes
    WHERE schemaname = $1 ORDER BY indexname`, [schemaName]);
  const indexNames = new Set(indexes.rows.map((row) => String(row.indexname)));
  const lookup = await pool.query(`SELECT count(*)::text AS count FROM ${schema}.canonical_memories
    WHERE content_hash = $1`, [first.row.content_hash]);
  const shadowHash = await snapshotHash(pool, schemaName);
  const nativeHash = await nativeSnapshotHash(pool, bundle.manifest.governanceRunId + "-p14");
  const nativeReadClient = {
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const result = await pool.query(sql, [...params]);
      return { rows: result.rows as Row[], rowCount: result.rowCount };
    },
  };
  const candidateSource = new PostgresGovernedRetrievalCandidateSource(nativeReadClient);
  const hydrator = new PostgresGovernedRetrievalHydrator(nativeReadClient);
  const representativeByScope = new Map<string, EmbeddedMemory>();
  for (const memory of embedded.memories) {
    representativeByScope.set(String(memory.row.scope_key),
      representativeByScope.get(String(memory.row.scope_key)) ?? memory);
  }
  let nativeCandidateCount = 0;
  let nativeHydrationCount = 0;
  let nativeEvidenceCount = 0;
  for (const memory of representativeByScope.values()) {
    const scope = scopeFromRow(memory.row);
    let candidates;
    try {
      candidates = await candidateSource.search({
        query: String(memory.row.text).slice(0, 9_000),
        scope,
        limit: 500,
      });
    } catch (error) {
      if (error instanceof PostgresGovernedRetrievalCandidateSourceError) {
        fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", `native candidate ${error.reason}`);
      }
      throw error;
    }
    const matching = candidates.filter((candidate) =>
      candidate.authoritativeRecordId === memory.memoryId);
    if (matching.length === 0) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "native candidate lookup failed");
    }
    nativeCandidateCount += matching.length;
    const hydrated = await hydrator.hydrate({
      scope,
      authoritativeRecordId: memory.memoryId,
      candidates: matching,
    });
    const expectedEvidence = ((memory.row.metadata as Record<string, unknown>)
      .sourceNodeIds as readonly string[]);
    if (!hydrated || hydrated.record.id !== memory.memoryId ||
        hydrated.record.text !== memory.row.text ||
        hydrated.record.contentHash !== memory.row.content_hash ||
        hydrated.record.semanticType !==
          (memory.row.metadata as Record<string, unknown>).semanticType ||
        JSON.stringify(hydrated.evidenceIds) !== JSON.stringify(expectedEvidence)) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "native hydration failed");
    }
    nativeHydrationCount += 1;
    nativeEvidenceCount += hydrated.evidenceIds.length;
  }
  const nativeRuntime = Object.freeze({
    scopesExpected: representativeByScope.size,
    scopesHydrated: nativeHydrationCount,
    candidateCount: nativeCandidateCount,
    evidenceRowsHydrated: nativeEvidenceCount,
    candidateSource: true,
    hydrator: true,
  });
  const slotInputCounts = slotReceipt.inputCounts as Record<string, number>;
  const checks: CanonicalRehydrationRehearsalChecks = {
    schema: countChecks,
    embedding: vectorRead.rows[0]?.memory_id === first.memoryId &&
      Number(vectorRead.rows[0]?.dim) === embedded.dimensions &&
      indexNames.has("canonical_memories_vector_hnsw_idx"),
    canonicalRead: canonical.rowCount === 1 && canonical.rows[0]?.projected_public_content_hash ===
      canonical.rows[0]?.public_content_hash && canonical.rows[0]?.state === "complete",
    evidenceDrilldown: Number(drilldown.rows[0]?.count) === bundle.evidence.length &&
      nativeEvidenceCount > 0,
    fiveSlotRecall: slotReceipt.exercised === true && slotReceipt.scopeLeakCount === 0 &&
      nativeHydrationCount === representativeByScope.size,
    disclosureR0R4: bundle.memories.length === 363 && bundle.evidence.length === 3773 &&
      Number(bundle.manifest.counts.treeRowInsert) === 0,
    lookup: Number(lookup.rows[0]?.count) === 1 &&
      indexNames.has("canonical_memories_lookup_idx") &&
      indexNames.has("canonical_memories_fts_idx"),
    resource: embedded.memories.filter((memory) =>
      (memory.row.metadata as Record<string, unknown>).semanticType === "resource").length ===
      (slotInputCounts.resource ?? -1),
    tree: Number(countRow.trees) === 0,
    graph: Number(countRow.graph_edges) === expectedRelations &&
      indexNames.has("graph_edges_source_idx"),
    scopeIsolation: Number(distinctScopes.rows[0]?.count) === 24 &&
      Number(scopeLeak.rows[0]?.count) === 0 && Number(missingScope.rows[0]?.count) === 0,
    restartConsistency: shadowHash === expectedShadowHash && nativeHash === expectedNativeHash,
    rollbackRestore: true,
  };
  assertCanonicalRehydrationRehearsalChecks(checks);
  return Object.freeze({
    schema: "mengshu.p14-readback-receipt/v1",
    projectionHash: bundle.manifest.projectionHash,
    verifiedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(countRow).map(([key, value]) => [key, Number(value)])),
    distinctScopes: Number(distinctScopes.rows[0]?.count),
    slotReceipt,
    nativeRuntime,
    disclosureCounts: { R0: bundle.memories.length, R1: 0, R2: 0, R3: 0, R4: bundle.evidence.length },
    shadowSnapshotHash: shadowHash,
    nativeSnapshotHash: nativeHash,
    indexNames: [...indexNames].sort(),
    checks,
  });
}

async function rollbackNative(
  pool: pg.Pool,
  schemaName: string,
  runId: string,
  expectedAfterHash: string,
  expectedBeforeHash: string,
): Promise<Readonly<Record<string, unknown>>> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (await nativeSnapshotHash(client as unknown as pg.Pool, runId) !== expectedAfterHash) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "rollback CAS drift");
    }
    await client.query("DELETE FROM mengshu_memory_evidence_links WHERE source = $1", [REHEARSAL_SOURCE]);
    await client.query("DELETE FROM memories WHERE metadata->>'p14RunId' = $1", [runId]);
    await client.query("DELETE FROM mengshu_active_embedding_space WHERE singleton_key = 'active'");
    await client.query("DELETE FROM mengshu_embedding_spaces WHERE embedding_space_id LIKE 'embedding-space:v1:%'");
    await client.query(`UPDATE mengshu_markdown_migration_runs
      SET status = 'rolled_back', rolled_back_at = $2, updated_at = $2
      WHERE run_id = $1 AND status = 'activated'`, [runId, Date.now()]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  const restoredHash = await nativeSnapshotHash(pool, runId);
  if (restoredHash !== expectedBeforeHash) {
    fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "before image not restored");
  }
  await pool.query(`DROP SCHEMA ${quoteIdentifier(schemaName)} CASCADE`);
  const removed = await pool.query("SELECT to_regnamespace($1)::text AS namespace", [schemaName]);
  if (removed.rows[0]?.namespace !== null) {
    fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "shadow schema rollback failed");
  }
  return Object.freeze({
    schema: "mengshu.p14-rollback-rehearsal-receipt/v1",
    runId,
    rolledBackAt: new Date().toISOString(),
    expectedAfterSnapshotHash: expectedAfterHash,
    expectedBeforeSnapshotHash: expectedBeforeHash,
    restoredSnapshotHash: restoredHash,
    shadowSchemaRemoved: true,
    productionTouched: false,
  });
}

async function prepareRunLedger(
  pool: pg.Pool,
  bundle: CanonicalProjectionBundle,
  args: CliArgs,
  runId: string,
): Promise<void> {
  const preconditions = bundle.manifest.preconditions;
  const inputs = bundle.manifest.inputs;
  const sourceSnapshot = preconditions.sourceSnapshotSha256;
  const governedManifest = inputs.canonicalManifestSha256;
  const governedSnapshot = preconditions.canonicalArtifactSetHash;
  const verification = inputs.finalAcceptanceSha256;
  if (![sourceSnapshot, governedManifest, governedSnapshot, verification]
    .every((value) => typeof value === "string" && SHA256.test(value))) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "ledger hashes unavailable");
  }
  await pool.query(`INSERT INTO mengshu_markdown_migration_runs (
    run_id, source_manifest_sha256, source_snapshot_sha256, governed_manifest_sha256,
    governed_snapshot_sha256, verification_sha256, policy_version, status,
    source_count, mapped_count, staged_live_count, prepared_at, updated_at
  ) VALUES ($1, $2, $3, $4, $5, $6, 'canonical-rehydration-p14/v1', 'staging',
    $7, 0, 0, $8, $8)`, [
    runId,
    args.sourceManifestSha256,
    sourceSnapshot,
    governedManifest,
    governedSnapshot,
    verification,
    bundle.mappings.length,
    Date.now(),
  ]);
}

async function runRehearsal(args: CliArgs): Promise<RehearsalArtifacts> {
  const bundle = await readProjection(args);
  const embedded = await embedProjection(bundle, args.configPath);
  const slotReceipt = await verifyFiveSlots(bundle);
  const tempRoot = await mkdtemp(join(tmpdir(), "mengshu-p14-postgres-"));
  const dataDir = resolve(tempRoot, "data");
  const socketDir = resolve(tempRoot, "socket");
  const logPath = resolve(tempRoot, "postgres.log");
  await mkdir(socketDir, { mode: 0o700 });
  let pool: pg.Pool | undefined;
  let started = false;
  try {
    await runProgram("/opt/homebrew/bin/initdb", [
      "-D", dataDir, "--no-locale", "--encoding=UTF8", "--auth=trust",
      "--username", userInfo().username,
    ]);
    await runProgram("/opt/homebrew/bin/pg_ctl", [
      "-D", dataDir, "-l", logPath, "-o",
      `-k ${socketDir} -p ${POSTGRES_PORT} -c listen_addresses=''`, "-w", "start",
    ]);
    started = true;
    pool = new pg.Pool({
      host: socketDir,
      port: POSTGRES_PORT,
      database: "postgres",
      user: userInfo().username,
      max: 4,
    });
    const identity = await pool.query(`SELECT inet_server_addr()::text AS inet_server_address,
      current_setting('data_directory') AS data_directory, current_database() AS current_database`);
    const actualDataDir = await realpath(String(identity.rows[0]?.data_directory));
    assertEphemeralPostgresIdentity({
      inetServerAddress: identity.rows[0]?.inet_server_address ?? null,
      actualDataDirectory: actualDataDir,
      expectedDataDirectory: await realpath(dataDir),
      currentDatabase: String(identity.rows[0]?.current_database),
    });
    const migration = await bootstrapPostgres(pool, embedded.dimensions);
    const runId = `${bundle.manifest.governanceRunId}-p14`;
    await prepareRunLedger(pool, bundle, args, runId);
    const schemaName = `p14_${bundle.manifest.projectionHash.slice(0, 16)}`;
    const stagedCounts = await createAndLoadShadow(pool, schemaName, bundle, embedded);
    const shadowHash = await snapshotHash(pool, schemaName);
    await pool.query(`UPDATE mengshu_markdown_migration_runs
      SET status = 'verified', mapped_count = $2, staged_live_count = $3, updated_at = $4
      WHERE run_id = $1 AND status = 'staging'`, [
      runId, bundle.mappings.length, bundle.memories.length, Date.now(),
    ]);
    const beforeHash = await nativeSnapshotHash(pool, runId);
    const emptyHash = canonicalRehydrationDomainHash("mengshu.p14-native-snapshot/v1", {
      memories: [], evidence: [],
    });
    if (beforeHash !== emptyHash) fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "before image not empty");
    const afterHash = await activateNative(
      pool, schemaName, bundle, embedded, runId, beforeHash,
    );
    await pool.end();
    pool = undefined;
    await runProgram("/opt/homebrew/bin/pg_ctl", [
      "-D", dataDir, "-l", logPath, "-m", "fast", "-w", "restart",
    ]);
    pool = new pg.Pool({
      host: socketDir,
      port: POSTGRES_PORT,
      database: "postgres",
      user: userInfo().username,
      max: 4,
    });
    const readbackReceipt = await verifyReadback(
      pool, schemaName, bundle, embedded, slotReceipt, shadowHash, afterHash,
    );
    const rollbackReceipt = await rollbackNative(pool, schemaName, runId, afterHash, beforeHash);
    const checks = (readbackReceipt.checks as CanonicalRehydrationRehearsalChecks);
    assertCanonicalRehydrationRehearsalChecks({ ...checks, rollbackRestore: true });
    const finalReceipt = Object.freeze({
      schema: "mengshu.p14-postgres-rehydration-rehearsal-receipt/v1",
      runId,
      governanceRunId: bundle.manifest.governanceRunId,
      projectionHash: bundle.manifest.projectionHash,
      projectionManifestSha256: args.projectionManifestSha256,
      sourceManifestSha256: args.sourceManifestSha256,
      createdAt: new Date().toISOString(),
      targetSchemaVersion: CURRENT_SCHEMA_VERSION,
      schemaMigration: {
        fromVersion: migration.fromVersion,
        toVersion: migration.toVersion,
        appliedVersions: migration.appliedVersions,
        pendingContractVersions: migration.pendingContractVersions,
      },
      stagedCounts,
      embeddingReceiptSha256: canonicalRehydrationSha256(
        canonicalRehydrationJson(embedded.receipt),
      ),
      readbackReceiptSha256: canonicalRehydrationSha256(
        canonicalRehydrationJson(readbackReceipt),
      ),
      rollbackReceiptSha256: canonicalRehydrationSha256(
        canonicalRehydrationJson(rollbackReceipt),
      ),
      checks: { ...checks, rollbackRestore: true },
      accepted: true,
      guards: {
        rehearsalOnly: true,
        ephemeralUnixSocket: true,
        temporaryDataDirectory: true,
        productionConfigReadForPostgres: false,
        productionConnectionOpened: false,
        productionDdlCount: 0,
        productionDmlCount: 0,
        productionActivationCount: 0,
        productionApplyTokenIncluded: false,
        p15IndependentAuthorizationRequired: true,
      },
    });
    return {
      embeddingReceipt: embedded.receipt,
      readbackReceipt,
      rollbackReceipt,
      finalReceipt,
    };
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    if (started) {
      await runProgram("/opt/homebrew/bin/pg_ctl", [
        "-D", dataDir, "-m", "fast", "-w", "stop",
      ]).catch(() => undefined);
    }
    if (tempRoot.startsWith(join(tmpdir(), "mengshu-p14-postgres-"))) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function sourceRecordFingerprint(
  record: ReturnType<typeof parseNativeRecordMarkdown>["record"],
  vectorSha256: string,
  textSha256 = canonicalRehydrationSha256(record.text),
): string {
  const { vector: _vector, text: _text, ...scalars } = record;
  return canonicalRehydrationDomainHash("mengshu.p15-source-row-fingerprint/v1", {
    ...scalars,
    textSha256,
    vectorSha256,
  });
}

function postgresVectorBinarySha256(vector: readonly number[]): string {
  if (vector.length > 65_535 || vector.some((value) => !Number.isFinite(value))) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid frozen vector");
  }
  const binary = Buffer.allocUnsafe(4 + vector.length * 4);
  binary.writeUInt16BE(vector.length, 0);
  binary.writeUInt16BE(0, 2);
  vector.forEach((value, index) => binary.writeFloatBE(Math.fround(value), 4 + index * 4));
  return canonicalRehydrationSha256(binary);
}

async function loadFrozenSourceFingerprints(
  manifestPath: string,
  manifestSha256: string,
): Promise<Readonly<{
  manifest: ReturnType<typeof parseMarkdownWorksetManifest>;
  fingerprints: ReadonlyMap<string, string>;
  fingerprintSetHash: string;
}>> {
  const manifestText = await readNoSymlink(manifestPath);
  if (canonicalRehydrationSha256(manifestText) !== manifestSha256) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "frozen source manifest");
  }
  const manifest = parseMarkdownWorksetManifest(manifestText);
  const root = resolve(manifestPath, "..");
  const fingerprints = new Map<string, string>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < manifest.files.length) {
      const index = cursor++;
      const entry = manifest.files[index]!;
      const path = containedPath(root, entry.relativePath);
      let current = root;
      for (const part of entry.relativePath.split("/")) {
        current = resolve(current, part);
        const info = await lstat(current)
          .catch(() => fail("CANONICAL_REHYDRATION_HASH_DRIFT", entry.sourceRef));
        if (info.isSymbolicLink()) {
          fail("CANONICAL_REHYDRATION_HASH_DRIFT", entry.sourceRef);
        }
      }
      const markdown = await readNoSymlink(path);
      if (canonicalRehydrationSha256(markdown) !== entry.markdownSha256) {
        fail("CANONICAL_REHYDRATION_HASH_DRIFT", entry.sourceRef);
      }
      const row = parseNativeRecordMarkdown(markdown);
      if (row.sourceRef !== entry.sourceRef || row.sourceHash !== entry.sourceHash ||
          fingerprints.has(row.sourceRef)) {
        fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", row.sourceRef);
      }
      const vectorSha256 = postgresVectorBinarySha256(row.record.vector);
      fingerprints.set(row.sourceRef, sourceRecordFingerprint(row.record, vectorSha256));
    }
  };
  await Promise.all(Array.from({ length: 64 }, worker));
  const fingerprintSetHash = canonicalRehydrationDomainHash(
    "mengshu.p15-source-fingerprint-set/v1",
    [...fingerprints.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return Object.freeze({
    manifest,
    fingerprints,
    fingerprintSetHash,
  });
}

async function verifyLiveSourceFingerprints(
  client: pg.PoolClient,
  expected: ReadonlyMap<string, string>,
): Promise<Readonly<{ count: number; fingerprintSetHash: string }>> {
  const columns = `id::text AS id, 'x'::text AS text,
    encode(sha256(convert_to(text, 'UTF8')), 'hex') AS text_sha256,
    content_hash, '[0]'::text AS vector_text,
    encode(sha256(vector_send(vector)), 'hex') AS vector_sha256,
    importance, category, data_type, metadata, created_at,
    project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
    canonical_project_id, product_id, producer_id, namespace, visibility,
    lifecycle_status, embedding_space_id, embedding_space_state,
    legacy_quarantine_reason, scope_key`;
  const result = await client.query(`
    SELECT 'memories'::text AS source_table, ${columns} FROM memories
    UNION ALL
    SELECT 'knowledge'::text AS source_table, ${columns} FROM knowledge`);
  if (result.rows.length !== expected.size) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "live source count");
  }
  const actual = new Map<string, string>();
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const sourceTable = raw.source_table;
    const vectorSha256 = raw.vector_sha256;
    const textSha256 = raw.text_sha256;
    if ((sourceTable !== "memories" && sourceTable !== "knowledge") ||
        typeof vectorSha256 !== "string" || !SHA256.test(vectorSha256) ||
        typeof textSha256 !== "string" || !SHA256.test(textSha256)) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", "live source row");
    }
    const decoded = decodePostgresMarkdownWorksetRow(sourceTable, raw);
    const sourceRef = `${sourceTable}:${decoded.record.id}`;
    const fingerprint = sourceRecordFingerprint(decoded.record, vectorSha256, textSha256);
    if (actual.has(sourceRef) || expected.get(sourceRef) !== fingerprint) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", sourceRef);
    }
    actual.set(sourceRef, fingerprint);
  }
  if (actual.size !== expected.size) fail("CANONICAL_REHYDRATION_HASH_DRIFT", "source coverage");
  const fingerprintSetHash = canonicalRehydrationDomainHash(
    "mengshu.p15-source-fingerprint-set/v1",
    [...actual.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
  return Object.freeze({ count: actual.size, fingerprintSetHash });
}

async function readSourceMutationWitness(
  client: Pick<pg.Pool, "query">,
): Promise<Readonly<{ count: number; witnessHash: string }>> {
  const result = await client.query(`SELECT count(*)::text AS count,
    encode(sha256(convert_to(COALESCE(string_agg(
      concat_ws(chr(31), source_table, record_id, row_sha256), chr(30)
      ORDER BY source_table COLLATE "C", record_id COLLATE "C"
    ), ''), 'UTF8')), 'hex') AS witness_hash
  FROM (
    SELECT 'memories'::text AS source_table, id::text AS record_id,
      encode(sha256(convert_to(to_jsonb(memories.*)::text, 'UTF8')), 'hex') AS row_sha256
    FROM memories
    UNION ALL
    SELECT 'knowledge'::text, id::text,
      encode(sha256(convert_to(to_jsonb(knowledge.*)::text, 'UTF8')), 'hex')
    FROM knowledge
  ) source_rows`);
  const count = Number(result.rows[0]?.count);
  const witnessHash = result.rows[0]?.witness_hash;
  if (!Number.isSafeInteger(count) || count < 0 || typeof witnessHash !== "string" ||
      !SHA256.test(witnessHash)) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "source mutation witness");
  }
  return Object.freeze({ count, witnessHash });
}

async function runProductionPreflight(
  args: ProductionPreflightArgs | ProductionCachedPreflightArgs,
): Promise<Readonly<{
  readonly receipt: Readonly<Record<string, unknown>>;
  readonly vectorCache: Readonly<Record<string, unknown>>;
}>> {
  const bundle = await readProjection(args);
  const frozenManifestPath = containedPath(args.migrationRoot, args.frozenSourceManifest);
  const rehearsalReceiptPath = containedPath(args.migrationRoot, args.rehearsalReceipt);
  const cachedEmbeddingPath = args.mode === "preflight-cached"
    ? containedPath(args.migrationRoot, args.embeddingCache) : undefined;
  const [frozenText, rehearsalText, configText, frozenSource, cachedEmbeddingText] =
    await Promise.all([
    readNoSymlink(frozenManifestPath),
    readNoSymlink(rehearsalReceiptPath),
    readNoSymlink(args.configPath),
    loadFrozenSourceFingerprints(frozenManifestPath, args.frozenSourceManifestSha256),
    cachedEmbeddingPath ? readNoSymlink(cachedEmbeddingPath) : Promise.resolve(undefined),
    ]);
  if (canonicalRehydrationSha256(frozenText) !== args.frozenSourceManifestSha256 ||
      canonicalRehydrationSha256(rehearsalText) !== args.rehearsalReceiptSha256) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "preflight artifact");
  }
  const frozenManifest = parseMarkdownWorksetManifest(frozenText);
  const rehearsal = JSON.parse(rehearsalText) as Record<string, unknown>;
  if (frozenManifest.snapshotSha256 !== bundle.manifest.preconditions.sourceSnapshotSha256 ||
      frozenManifest.sourceCount !== bundle.mappings.length ||
      frozenSource.fingerprintSetHash.length !== 64 ||
      rehearsal.schema !== "mengshu.p14-postgres-rehydration-rehearsal-receipt/v1" ||
      rehearsal.accepted !== true || rehearsal.projectionHash !== bundle.manifest.projectionHash) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "source snapshot or rehearsal");
  }
  const config = parseOperatorConfig(configText);
  if (config.dbType !== "postgres" || !config.postgres) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "PostgreSQL config required");
  }
  if (args.mode === "preflight-cached" &&
      (cachedEmbeddingText === undefined ||
        canonicalRehydrationSha256(cachedEmbeddingText) !== args.embeddingCacheSha256)) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "cached embedding artifact");
  }
  const pool = new pg.Pool({
    ...config.postgres,
    max: 1,
    connectionTimeoutMillis: PRODUCTION_CONNECTION_TIMEOUT_MS,
    query_timeout: PRODUCTION_QUERY_TIMEOUT_MS,
  });
  let databaseReceipt: Readonly<Record<string, unknown>>;
  const client = await pool.connect();
  try {
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const readonly = await client.query(`SELECT current_setting('transaction_read_only') AS value,
      current_database() AS database_name, inet_server_addr()::text AS server_address,
      inet_server_port()::text AS server_port, pg_backend_pid()::text AS backend_pid`);
    if (readonly.rows[0]?.value !== "on") {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "production preflight is not read-only");
    }
    const ledgerExists = await client.query(
      "SELECT to_regclass('public.mengshu_schema_migrations')::text AS relation",
    );
    if (ledgerExists.rows[0]?.relation !== "mengshu_schema_migrations") {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "schema ledger missing");
    }
    const ledger = await client.query<AppliedSchemaMigration>(
      "SELECT version, name, checksum FROM mengshu_schema_migrations ORDER BY version",
    );
    const migrationPlan = planSchemaMigrations(ledger.rows);
    if (migrationPlan.fromVersion > CURRENT_SCHEMA_VERSION ||
        migrationPlan.toVersion !== CURRENT_SCHEMA_VERSION) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "unsupported production schema");
    }
    const counts = await client.query(`SELECT
      (SELECT count(*)::text FROM memories) AS memories,
      (SELECT count(*)::text FROM knowledge) AS knowledge`);
    if (Number(counts.rows[0]?.memories) + Number(counts.rows[0]?.knowledge) !==
        frozenManifest.sourceCount) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production source count");
    }
    const liveSource = await verifyLiveSourceFingerprints(client, frozenSource.fingerprints);
    if (liveSource.fingerprintSetHash !== frozenSource.fingerprintSetHash ||
        liveSource.count !== frozenManifest.sourceCount) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production source fingerprint set");
    }
    const sourceWitness = await readSourceMutationWitness(client);
    if (sourceWitness.count !== frozenManifest.sourceCount) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production source witness count");
    }
    const lifecycle = await client.query(`SELECT source_table, lifecycle_status, count(*)::text
      FROM (
        SELECT 'memories'::text AS source_table, COALESCE(lifecycle_status, '<null>') AS lifecycle_status
        FROM memories
        UNION ALL
        SELECT 'knowledge'::text AS source_table, COALESCE(lifecycle_status, '<null>') AS lifecycle_status
        FROM knowledge
      ) rows GROUP BY source_table, lifecycle_status ORDER BY source_table, lifecycle_status`);
    const activity = await client.query(`SELECT
      count(*) FILTER (WHERE state = 'idle')::text AS idle,
      count(*) FILTER (WHERE state <> 'idle')::text AS non_idle,
      count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction
      FROM pg_stat_activity
      WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    const nonIdle = Number(activity.rows[0]?.non_idle);
    const idleInTransaction = Number(activity.rows[0]?.idle_in_transaction);
    if (nonIdle !== 0 || idleInTransaction !== 0) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "production writers are not quiescent");
    }
    databaseReceipt = Object.freeze({
      endpointFingerprint: canonicalRehydrationDomainHash("mengshu.postgres-endpoint/v1", {
        host: config.postgres.host,
        port: config.postgres.port,
        database: config.postgres.database,
        user: config.postgres.user,
        ssl: config.postgres.ssl === true,
      }),
      serverIdentityHash: canonicalRehydrationDomainHash("mengshu.postgres-server/v1", {
        database: readonly.rows[0]?.database_name,
        address: readonly.rows[0]?.server_address,
        port: readonly.rows[0]?.server_port,
      }),
      transactionReadOnly: true,
      currentSchemaVersion: migrationPlan.fromVersion,
      targetSchemaVersion: migrationPlan.toVersion,
      pendingMigrations: migrationPlan.pending.map((migration) => ({
        version: migration.version,
        name: migration.name,
        kind: migration.kind,
        checksum: migration.checksum,
      })),
      counts: {
        memories: Number(counts.rows[0]?.memories),
        knowledge: Number(counts.rows[0]?.knowledge),
      },
      liveSource: {
        count: liveSource.count,
        fingerprintSetHash: liveSource.fingerprintSetHash,
        frozenFingerprintSetHash: frozenSource.fingerprintSetHash,
        parity: true,
      },
      sourceWitness,
      lifecycle: lifecycle.rows,
      activity: {
        idle: Number(activity.rows[0]?.idle),
        nonIdle,
        idleInTransaction,
      },
    });
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }

  const embedded = cachedEmbeddingText === undefined
    ? await embedProjection(bundle, args.configPath)
    : validateCachedEmbeddings(cachedEmbeddingText, bundle, config);
  const vectors = embedded.memories.map((memory) => ({
    schema: "mengshu.canonical-embedding-vector/v1",
    assetId: memory.assetId,
    memoryId: memory.memoryId,
    contentHash: memory.row.content_hash,
    embeddingSpaceId: embedded.embeddingSpaceId,
    vectorSha256: memory.vectorSha256,
    vector: memory.vector,
  }));
  const vectorCache = Object.freeze({
    schema: "mengshu.p15-canonical-embedding-cache/v1",
    projectionHash: bundle.manifest.projectionHash,
    model: embedded.model,
    dimensions: embedded.dimensions,
    embeddingSpaceId: embedded.embeddingSpaceId,
    vectorSetHash: embedded.receipt.vectorSetHash,
    count: vectors.length,
    vectors,
  });
  const vectorCacheText = canonicalRehydrationJson(vectorCache);
  const operationCounts = bundle.manifest.counts;
  const payload = Object.freeze({
    schema: "mengshu.p15-production-preflight-receipt/v1",
    runId: bundle.manifest.governanceRunId,
    projectionHash: bundle.manifest.projectionHash,
    projectionManifestSha256: args.projectionManifestSha256,
    frozenSourceManifestSha256: args.frozenSourceManifestSha256,
    sourceSnapshotSha256: frozenManifest.snapshotSha256,
    sourceCount: frozenManifest.sourceCount,
    rehearsalReceiptSha256: args.rehearsalReceiptSha256,
    database: databaseReceipt,
    embedding: {
      cacheFile: "embedding-vectors.json",
      cacheSha256: canonicalRehydrationSha256(vectorCacheText),
      vectorSetHash: embedded.receipt.vectorSetHash,
      model: embedded.model,
      dimensions: embedded.dimensions,
      count: vectors.length,
      vectorReuseCount: cachedEmbeddingText === undefined ? 0 : vectors.length,
      networkExecuted: cachedEmbeddingText === undefined,
    },
    operations: operationCounts,
    quarantineAccepted: Number(operationCounts.quarantine),
    beforeImage: {
      manifest: args.frozenSourceManifest,
      manifestSha256: args.frozenSourceManifestSha256,
      snapshotSha256: frozenManifest.snapshotSha256,
      sourceFingerprintSetHash: frozenSource.fingerprintSetHash,
      liveParityVerified: true,
      completeRowPayloads: true,
    },
    guards: {
      productionReadOnlyConnectionOpened: true,
      productionDdlCount: 0,
      productionDmlCount: 0,
      maintenanceRequired: true,
      quiescenceRequired: true,
      exactApplyTokenRequired: true,
      materializationOnly: true,
      activationSeparateTokenRequired: true,
      archiveAuthorized: false,
      physicalPurgeAuthorized: false,
    },
  });
  const preflightHash = canonicalRehydrationDomainHash(
    "mengshu.p15-production-preflight/v1", payload,
  );
  const applyToken = `P15_APPLY:${bundle.manifest.governanceRunId}:${preflightHash}`;
  return Object.freeze({
    vectorCache,
    receipt: Object.freeze({ ...payload, preflightHash, applyToken }),
  });
}

function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", label);
  }
  return value as Record<string, unknown>;
}

function validateCachedEmbeddings(
  text: string,
  bundle: CanonicalProjectionBundle,
  config: MemoryConfig,
): Awaited<ReturnType<typeof embedProjection>> {
  const cache = jsonObject(JSON.parse(text), "embedding cache");
  const vectors = cache.vectors;
  if (cache.schema !== "mengshu.p15-canonical-embedding-cache/v1" ||
      cache.projectionHash !== bundle.manifest.projectionHash || !Array.isArray(vectors) ||
      !Number.isSafeInteger(cache.dimensions) || Number(cache.dimensions) <= 0 ||
      typeof cache.model !== "string" || typeof cache.embeddingSpaceId !== "string" ||
      typeof cache.vectorSetHash !== "string" || !SHA256.test(cache.vectorSetHash) ||
      cache.count !== bundle.memories.length || vectors.length !== bundle.memories.length) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "embedding cache");
  }
  const model = config.embedding.model ?? "text-embedding-3-small";
  const dimensions = vectorDimsForModel(model);
  const embeddingSpace = createEmbeddingSpace({
    provider: config.embedding.provider,
    baseURL: config.embedding.baseURL!,
    model,
    dim: dimensions,
    normalization: "none",
  }, "reembedded");
  if (cache.model !== model || cache.dimensions !== dimensions ||
      cache.embeddingSpaceId !== embeddingSpace.embeddingSpaceId) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "embedding space");
  }
  const memoryById = new Map(bundle.memories.map((memory) => [memory.memoryId, memory] as const));
  const embedded = vectors.map((value): EmbeddedMemory => {
    const item = jsonObject(value, "embedding vector");
    const vector = item.vector;
    const memory = memoryById.get(String(item.memoryId));
    if (item.schema !== "mengshu.canonical-embedding-vector/v1" || !memory ||
        item.assetId !== memory.assetId || item.contentHash !== memory.row.content_hash ||
        item.embeddingSpaceId !== embeddingSpace.embeddingSpaceId ||
        typeof item.vectorSha256 !== "string" || !SHA256.test(item.vectorSha256) ||
        !Array.isArray(vector) || !finiteVector(vector as number[], dimensions) ||
        canonicalRehydrationDomainHash("mengshu.embedding-vector/v1", vector) !==
          item.vectorSha256) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "embedding vector");
    }
    return Object.freeze({
      assetId: memory.assetId,
      memoryId: memory.memoryId,
      rowSha256: memory.rowSha256,
      row: memory.row,
      vector: Object.freeze([...(vector as number[])]),
      vectorText: `[${(vector as number[]).join(",")}]`,
      vectorSha256: item.vectorSha256,
    });
  });
  const vectorSetHash = canonicalRehydrationDomainHash(
    "mengshu.embedding-vector-set/v1",
    embedded.map((memory) => ({ memoryId: memory.memoryId, vectorSha256: memory.vectorSha256 })),
  );
  if (vectorSetHash !== cache.vectorSetHash || new Set(embedded.map((row) => row.memoryId)).size !==
      bundle.memories.length) fail("CANONICAL_REHYDRATION_HASH_DRIFT", "embedding vector set");
  return Object.freeze({
    memories: Object.freeze(embedded),
    model,
    dimensions,
    embeddingSpaceId: embeddingSpace.embeddingSpaceId,
    baseURL: embeddingSpace.fingerprint.baseURL,
    receipt: Object.freeze({
      schema: "mengshu.p15-cached-embedding-receipt/v1",
      projectionHash: bundle.manifest.projectionHash,
      model,
      dimensions,
      embeddingSpaceId: embeddingSpace.embeddingSpaceId,
      vectorSetHash,
      vectorReuseCount: 0,
      networkExecuted: false,
    }),
  });
}

async function readProductionMaterializationInput(args: ProductionMaterializationArgs) {
  const bundle = await readProjection(args);
  const paths = {
    frozen: containedPath(args.migrationRoot, args.frozenSourceManifest),
    rehearsal: containedPath(args.migrationRoot, args.rehearsalReceipt),
    preflight: containedPath(args.migrationRoot, args.preflightReceipt),
    cache: containedPath(args.migrationRoot, args.embeddingCache),
    governance: containedPath(args.migrationRoot, args.governanceManifest),
  };
  const [frozenText, rehearsalText, preflightText, cacheText, governanceText, configText] =
    await Promise.all([
    readNoSymlink(paths.frozen), readNoSymlink(paths.rehearsal), readNoSymlink(paths.preflight),
    readNoSymlink(paths.cache), readNoSymlink(paths.governance), readNoSymlink(args.configPath),
    ]);
  for (const [text, expected, label] of [
    [frozenText, args.frozenSourceManifestSha256, "frozen source"],
    [rehearsalText, args.rehearsalReceiptSha256, "rehearsal receipt"],
    [preflightText, args.preflightReceiptSha256, "preflight receipt"],
    [cacheText, args.embeddingCacheSha256, "embedding cache"],
    [governanceText, args.governanceManifestSha256, "governance manifest"],
  ] as const) {
    if (canonicalRehydrationSha256(text) !== expected) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", label);
    }
  }
  const preflight = jsonObject(JSON.parse(preflightText), "preflight receipt");
  const preflightPayload = { ...preflight };
  delete preflightPayload.preflightHash;
  delete preflightPayload.applyToken;
  const expectedPreflightHash = canonicalRehydrationDomainHash(
    "mengshu.p15-production-preflight/v1", preflightPayload,
  );
  const guards = jsonObject(preflight.guards, "preflight guards");
  const database = jsonObject(preflight.database, "preflight database");
  const embedding = jsonObject(preflight.embedding, "preflight embedding");
  const liveSource = jsonObject(database.liveSource, "preflight live source");
  const sourceWitness = jsonObject(database.sourceWitness, "preflight source witness");
  const frozenManifest = parseMarkdownWorksetManifest(frozenText);
  if (preflight.schema !== "mengshu.p15-production-preflight-receipt/v1" ||
      preflight.runId !== bundle.manifest.governanceRunId ||
      preflight.projectionHash !== bundle.manifest.projectionHash ||
      preflight.projectionManifestSha256 !== args.projectionManifestSha256 ||
      preflight.frozenSourceManifestSha256 !== args.frozenSourceManifestSha256 ||
      preflight.rehearsalReceiptSha256 !== args.rehearsalReceiptSha256 ||
      preflight.preflightHash !== expectedPreflightHash ||
      embedding.cacheSha256 !== args.embeddingCacheSha256 ||
      guards.materializationOnly !== true || guards.activationSeparateTokenRequired !== true ||
      guards.archiveAuthorized !== false || guards.physicalPurgeAuthorized !== false ||
      guards.productionDdlCount !== 0 || guards.productionDmlCount !== 0 ||
      frozenManifest.sourceCount !== bundle.mappings.length ||
      frozenManifest.snapshotSha256 !== bundle.manifest.preconditions.sourceSnapshotSha256 ||
      liveSource.count !== bundle.mappings.length || liveSource.parity !== true ||
      liveSource.frozenFingerprintSetHash !== liveSource.fingerprintSetHash ||
      sourceWitness.count !== bundle.mappings.length ||
      typeof sourceWitness.witnessHash !== "string" ||
      !SHA256.test(sourceWitness.witnessHash)) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "preflight binding");
  }
  assertCanonicalProductionApplyAuthorization({
    mode: args.mode,
    runId: bundle.manifest.governanceRunId,
    projectionHash: bundle.manifest.projectionHash,
    expectedProjectionHash: String(preflight.projectionHash),
    preflightHash: String(preflight.preflightHash),
    applyToken: args.applyToken,
    receiptApplyToken: String(preflight.applyToken),
    maintenance: args.maintenance,
    quiescenceConfirmed: args.quiescenceConfirmed,
    physicalPurgeAuthorized: false,
  });
  const rehearsal = jsonObject(JSON.parse(rehearsalText), "rehearsal receipt");
  if (rehearsal.schema !== "mengshu.p14-postgres-rehydration-rehearsal-receipt/v1" ||
      rehearsal.accepted !== true || rehearsal.projectionHash !== bundle.manifest.projectionHash ||
      rehearsal.targetSchemaVersion !== CURRENT_SCHEMA_VERSION) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "rehearsal binding");
  }
  const governance = parseGovernedCanonicalManifest(governanceText);
  if (governance.governanceRunId !== bundle.manifest.governanceRunId ||
      governance.artifactSetHash !== bundle.manifest.preconditions.canonicalArtifactSetHash ||
      args.governanceManifestSha256 !== bundle.manifest.inputs.canonicalManifestSha256 ||
      governance.assetCount !== bundle.documents.length) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "governance binding");
  }
  const config = parseOperatorConfig(configText);
  if (config.dbType !== "postgres" || !config.postgres) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "PostgreSQL config required");
  }
  const endpointFingerprint = canonicalRehydrationDomainHash("mengshu.postgres-endpoint/v1", {
    host: config.postgres.host,
    port: config.postgres.port,
    database: config.postgres.database,
    user: config.postgres.user,
    ssl: config.postgres.ssl === true,
  });
  if (database.endpointFingerprint !== endpointFingerprint) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production endpoint or source");
  }
  const embedded = validateCachedEmbeddings(cacheText, bundle, config);
  return Object.freeze({
    bundle, sourceWitness: Object.freeze({
      count: Number(sourceWitness.count),
      witnessHash: String(sourceWitness.witnessHash),
    }), preflight, governance, config, embedded, endpointFingerprint,
  });
}

function governedScopeRunId(runId: string, scopeFingerprint: string): string {
  return `governance_${canonicalRehydrationDomainHash(
    "mengshu.p15-governance-scope-run/v1", { runId, scopeFingerprint },
  ).slice(0, 48)}`;
}

async function verifyProductionMaterialization(
  pool: Pick<pg.Pool, "query">,
  runId: string,
  expected: Readonly<{
    source: number;
    memories: number;
    documents: number;
    evidence: number;
    mappings: number;
    scopes: number;
    evidenceLinks: number;
  }>,
): Promise<Readonly<Record<string, unknown>>> {
  const result = await pool.query(`SELECT
    (SELECT count(*)::text FROM mengshu_markdown_migration_before_rows
      WHERE run_id = $1) AS before_rows,
    (SELECT count(*)::text FROM mengshu_markdown_migration_staged_rows
      WHERE run_id = $1) AS staged_rows,
    (SELECT count(*)::text FROM mengshu_markdown_migration_mappings
      WHERE run_id = $1) AS mappings,
    (SELECT count(*)::text FROM memories WHERE metadata->>'p15RunId' = $1) AS memories,
    (SELECT count(*)::text FROM memories
      WHERE metadata->>'p15RunId' = $1 AND lifecycle_status = 'pending') AS pending_memories,
    (SELECT count(*)::text FROM mengshu_governed_document_bindings
      WHERE governance_descriptor->>'p15RunId' = $1) AS documents,
    (SELECT count(*)::text FROM mengshu_governed_document_bindings
      WHERE governance_descriptor->>'p15RunId' = $1
        AND lifecycle_state = 'review' AND sync_state = 'sync_pending'
        AND last_complete_version IS NULL AND synced_at IS NULL) AS pending_documents,
    (SELECT count(*)::text FROM mengshu_asset_versions
      WHERE descriptor->>'p15RunId' = $1 AND status = 'review'
        AND visibility = 'private') AS asset_versions,
    (SELECT count(*)::text FROM mengshu_asset_heads head
      JOIN mengshu_asset_versions version
        ON version.scope_fingerprint = head.scope_fingerprint
        AND version.asset_id = head.asset_id AND version.version = head.latest_version
      WHERE version.descriptor->>'p15RunId' = $1) AS asset_heads,
    (SELECT count(*)::text FROM mengshu_governed_document_sync_receipts receipt
      JOIN mengshu_governed_document_bindings binding
        USING (scope_fingerprint, vault_id, asset_id, asset_version)
      WHERE binding.governance_descriptor->>'p15RunId' = $1
        AND receipt.disposition = 'pending') AS pending_sync_receipts,
    (SELECT count(*)::text FROM mengshu_governed_document_complete_heads head
      JOIN mengshu_governed_document_bindings binding
        ON binding.scope_fingerprint = head.scope_fingerprint
        AND binding.vault_id = head.vault_id AND binding.asset_id = head.asset_id
        AND binding.asset_version = head.complete_version
      WHERE binding.governance_descriptor->>'p15RunId' = $1) AS complete_heads,
    (SELECT COALESCE(sum(jsonb_array_length(
      governance_descriptor->'claimEvidenceBindings')), 0)::text
      FROM mengshu_governed_document_bindings
      WHERE governance_descriptor->>'p15RunId' = $1) AS claim_evidence,
    (SELECT count(*)::text FROM mengshu_information_dispositions disposition
      JOIN mengshu_document_governance_runs governance_run
        USING (governance_run_id, scope_fingerprint)
      WHERE governance_run.resolution_hash = $2) AS information_dispositions,
    (SELECT count(*)::text FROM mengshu_document_governance_runs
      WHERE resolution_hash = $2) AS governance_scopes,
    (SELECT count(*)::text FROM mengshu_memory_evidence_links
      WHERE source = $3) AS evidence_links`, [
    runId,
    canonicalRehydrationDomainHash("mengshu.p15-governance-resolution/v1", runId),
    `markdown-curation-p15:${runId}`,
  ]);
  const row = result.rows[0] as Record<string, string>;
  const counts = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
  if (counts.before_rows !== expected.source || counts.staged_rows !== expected.memories ||
      counts.mappings !== expected.mappings || counts.memories !== expected.memories ||
      counts.pending_memories !== expected.memories || counts.documents !== expected.documents ||
      counts.pending_documents !== expected.documents ||
      counts.asset_versions !== expected.documents || counts.asset_heads !== 0 ||
      counts.pending_sync_receipts !== expected.documents || counts.complete_heads !== 0 ||
      counts.claim_evidence !== expected.evidence ||
      counts.information_dispositions !== expected.mappings ||
      counts.governance_scopes !== expected.scopes ||
      counts.evidence_links !== expected.evidenceLinks) {
    fail("CANONICAL_REHYDRATION_COUNT_MISMATCH", "production materialization readback");
  }
  const unchanged = await pool.query(`WITH before_source AS MATERIALIZED (
      SELECT source_table, record_id, row_sha256
      FROM mengshu_markdown_migration_before_rows WHERE run_id = $1
    ), current_source AS MATERIALIZED (
      SELECT before_row.source_table, before_row.record_id,
        encode(sha256(convert_to(to_jsonb(memory.*)::text, 'UTF8')), 'hex') AS row_sha256
      FROM before_source before_row
      JOIN memories memory ON before_row.source_table = 'memories'
        AND memory.id::text = before_row.record_id
      UNION ALL
      SELECT before_row.source_table, before_row.record_id,
        encode(sha256(convert_to(to_jsonb(knowledge.*)::text, 'UTF8')), 'hex')
      FROM before_source before_row
      JOIN knowledge knowledge ON before_row.source_table = 'knowledge'
        AND knowledge.id::text = before_row.record_id
    ) SELECT
      (SELECT count(*)::text FROM before_source) AS before_count,
      (SELECT count(*)::text FROM current_source) AS current_count,
      (SELECT encode(sha256(convert_to(COALESCE(string_agg(
        concat_ws(chr(31), source_table, record_id, row_sha256), chr(30)
        ORDER BY source_table COLLATE "C", record_id COLLATE "C"
      ), ''), 'UTF8')), 'hex') FROM before_source) AS before_witness_hash,
      (SELECT encode(sha256(convert_to(COALESCE(string_agg(
        concat_ws(chr(31), source_table, record_id, row_sha256), chr(30)
        ORDER BY source_table COLLATE "C", record_id COLLATE "C"
      ), ''), 'UTF8')), 'hex') FROM current_source) AS current_witness_hash`, [runId]);
  const sourceReadback = unchanged.rows[0] as Record<string, string>;
  if (Number(sourceReadback.before_count) !== expected.source ||
      Number(sourceReadback.current_count) !== expected.source ||
      sourceReadback.before_witness_hash !== sourceReadback.current_witness_hash) {
    fail("CANONICAL_REHYDRATION_HASH_DRIFT", "legacy source changed during materialization");
  }
  return Object.freeze({
    counts,
    legacySourceMismatchCount: 0,
    legacySourceWitnessHash: sourceReadback.current_witness_hash,
  });
}

async function runProductionMaterialization(
  args: ProductionMaterializationArgs,
): Promise<Readonly<Record<string, unknown>>> {
  activeProductionPhase = "validate-materialization-input";
  const input = await readProductionMaterializationInput(args);
  const { bundle, embedded, config, governance, sourceWitness, preflight } = input;
  const runId = bundle.manifest.governanceRunId;
  const pool = new pg.Pool({
    ...config.postgres!,
    max: 1,
    connectionTimeoutMillis: PRODUCTION_CONNECTION_TIMEOUT_MS,
    query_timeout: PRODUCTION_QUERY_TIMEOUT_MS,
  });
  const client = await pool.connect();
  let sessionLock = false;
  let dataTransactionStarted = false;
  let commitAttempted = false;
  let commitConfirmed = false;
  let schemaMigration: Awaited<ReturnType<typeof executePostgresMigrations>> | undefined;
  try {
    activeProductionPhase = "acquire-operator-lock";
    const lock = await client.query(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      ["mengshu:p15:production-materialization"],
    );
    sessionLock = lock.rows[0]?.locked === true;
    if (!sessionLock) fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "operator lock busy");
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '30min'");
    const preflightDatabase = jsonObject(preflight.database, "preflight database");
    const identity = await client.query(`SELECT current_database() AS database_name,
      inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port`);
    const serverIdentityHash = canonicalRehydrationDomainHash("mengshu.postgres-server/v1", {
      database: identity.rows[0]?.database_name,
      address: identity.rows[0]?.server_address,
      port: identity.rows[0]?.server_port,
    });
    if (preflightDatabase.serverIdentityHash !== serverIdentityHash) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production server identity");
    }
    const ledger = await client.query<AppliedSchemaMigration>(
      "SELECT version, name, checksum FROM mengshu_schema_migrations ORDER BY version",
    );
    const migrationPlan = planSchemaMigrations(ledger.rows);
    const expectedPending = preflightDatabase.pendingMigrations;
    if (preflightDatabase.currentSchemaVersion !== migrationPlan.fromVersion ||
        !Array.isArray(expectedPending) || JSON.stringify(expectedPending) !== JSON.stringify(
          migrationPlan.pending.map((migration) => ({
            checksum: migration.checksum,
            kind: migration.kind,
            name: migration.name,
            version: migration.version,
          })),
        )) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "production schema plan");
    }
    const activity = await client.query(`SELECT count(*) FILTER (
      WHERE state <> 'idle')::text AS non_idle,
      count(*) FILTER (WHERE state = 'idle in transaction')::text AS idle_in_transaction
      FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
    if (Number(activity.rows[0]?.non_idle) !== 0 ||
        Number(activity.rows[0]?.idle_in_transaction) !== 0) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "production is not quiescent");
    }
    activeProductionPhase = "pre-migration-source-cas";
    const preMigrationLive = await readSourceMutationWitness(client);
    if (preMigrationLive.witnessHash !== sourceWitness.witnessHash ||
        preMigrationLive.count !== sourceWitness.count) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", "pre-migration production source");
    }
    const existingAssets = await client.query(`SELECT count(*)::text AS count
      FROM mengshu_asset_versions version
      JOIN jsonb_to_recordset($1::jsonb) expected(
        scope_fingerprint text, asset_id text
      ) ON expected.scope_fingerprint = version.scope_fingerprint
        AND expected.asset_id = version.asset_id`, [JSON.stringify(
      bundle.documents.map((document) => ({
        scope_fingerprint: document.scopeFingerprint,
        asset_id: document.assetId,
      })),
    )]);
    if (Number(existingAssets.rows[0]?.count) !== 0) {
      fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", "pre-existing canonical asset");
    }
    activeProductionPhase = "migrate-schema-v24-v27";
    schemaMigration = await executePostgresMigrations({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    }, {
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    if (schemaMigration.toVersion !== CURRENT_SCHEMA_VERSION ||
        schemaMigration.pendingContractVersions.length !== 0) {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "schema v27 not ready");
    }
    await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    dataTransactionStarted = true;
    try {
      activeProductionPhase = "lock-materialization-tables";
      await client.query("SET LOCAL lock_timeout = '10s'");
      await client.query("SET LOCAL statement_timeout = '30min'");
      await client.query(`LOCK TABLE
        memories, knowledge,
        mengshu_markdown_migration_runs,
        mengshu_markdown_migration_before_rows,
        mengshu_markdown_migration_staged_rows,
        mengshu_markdown_migration_mappings,
        mengshu_document_governance_runs,
        mengshu_information_dispositions,
        mengshu_vaults,
        mengshu_asset_versions,
        mengshu_governed_document_bindings,
        mengshu_governed_document_sync_receipts,
        mengshu_embedding_spaces
        IN SHARE ROW EXCLUSIVE MODE NOWAIT`);
      const existing = await client.query(
        "SELECT status FROM mengshu_markdown_migration_runs WHERE run_id = $1",
        [runId],
      );
      if (existing.rowCount !== 0) {
        fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", "migration run already exists");
      }
      const live = await readSourceMutationWitness(client);
      if (live.witnessHash !== sourceWitness.witnessHash || live.count !== sourceWitness.count) {
        fail("CANONICAL_REHYDRATION_HASH_DRIFT", "locked production source");
      }
      const now = Date.now();
      const inputs = bundle.manifest.inputs;
      activeProductionPhase = "write-run-and-before-image";
      await client.query(`INSERT INTO mengshu_markdown_migration_runs (
        run_id, source_manifest_sha256, source_snapshot_sha256, governed_manifest_sha256,
        governed_snapshot_sha256, verification_sha256, policy_version, status,
        source_count, mapped_count, staged_live_count, prepared_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'staging', $8, 0, 0, $9, $9)`, [
        runId, args.frozenSourceManifestSha256,
        bundle.manifest.preconditions.sourceSnapshotSha256,
        args.governanceManifestSha256,
        bundle.manifest.preconditions.canonicalArtifactSetHash,
        inputs.finalAcceptanceSha256,
        governance.policyVersion,
        bundle.mappings.length,
        now,
      ]);
      const before = await client.query(`INSERT INTO mengshu_markdown_migration_before_rows (
        run_id, source_table, record_id, row_sha256, row_payload, captured_at
      ) SELECT $1, source_table, record_id,
        encode(sha256(convert_to(row_payload::text, 'UTF8')), 'hex'), row_payload, $2
      FROM (
        SELECT 'memories'::text AS source_table, id::text AS record_id,
          to_jsonb(memories.*) AS row_payload FROM memories
        UNION ALL
        SELECT 'knowledge'::text, id::text, to_jsonb(knowledge.*) FROM knowledge
      ) source_rows`, [runId, now]);
      if (before.rowCount !== bundle.mappings.length) {
        fail("CANONICAL_REHYDRATION_COUNT_MISMATCH", "before image");
      }

      const stagedRows = embedded.memories.map((memory) => ({
        run_id: runId,
        source_table: "memories",
        record_id: memory.memoryId,
        source_ref: `canonical:${memory.assetId}`,
        source_hash: memory.rowSha256,
        row_sha256: canonicalRehydrationDomainHash("mengshu.p15-staged-memory/v1", {
          rowSha256: memory.rowSha256,
          vectorSha256: memory.vectorSha256,
        }),
        row_payload: {
          ...memory.row,
          vector: memory.vectorText,
          embedding_space_id: embedded.embeddingSpaceId,
          embedding_space_state: "known-queryable",
          metadata: {
            ...(memory.row.metadata as Record<string, unknown>),
            embeddingSpaceId: embedded.embeddingSpaceId,
            embeddingSpaceState: "known-queryable",
          },
          lifecycle_status: "pending",
        },
        created_at: now,
      }));
      activeProductionPhase = "write-staged-memories";
      await insertBatches(client, stagedRows, `INSERT INTO mengshu_markdown_migration_staged_rows
        SELECT x.run_id, x.source_table, x.record_id, x.source_ref, x.source_hash,
          x.row_sha256, x.row_payload, x.created_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          run_id text, source_table text, record_id text, source_ref text, source_hash text,
          row_sha256 text, row_payload jsonb, created_at bigint
        )`, 100);

      const scopeRunIds = new Map<string, string>();
      for (const mapping of bundle.mappings) {
        scopeRunIds.set(mapping.scopeFingerprint,
          governedScopeRunId(runId, mapping.scopeFingerprint));
      }
      const mappingRows = bundle.mappings.map((mapping) => {
        const dispositions = canonicalSourceMigrationDisposition(mapping);
        return {
          run_id: runId,
          source_ref: mapping.sourceRef,
          source_hash: mapping.sourceHash,
          scope_fingerprint: mapping.scopeFingerprint,
          disposition: dispositions.migrationDisposition,
          canonical_target_ref: mapping.targetMemoryIds[0] === undefined
            ? null : `memories:${mapping.targetMemoryIds[0]}`,
          reason_code: mapping.reasonCode,
          mapping_sha256: mapping.mappingSha256,
          created_at: now,
          governance_run_id: scopeRunIds.get(mapping.scopeFingerprint),
          governance_disposition: dispositions.governanceDisposition,
          source_kind: mapping.sourceTable === "knowledge" ? "knowledge" : "system_event",
          target_asset_ids: mapping.targetAssetIds,
        };
      });
      activeProductionPhase = "write-source-mappings";
      await insertBatches(client, mappingRows, `INSERT INTO mengshu_markdown_migration_mappings
        SELECT x.run_id, x.source_ref, x.source_hash, x.scope_fingerprint, x.disposition,
          x.canonical_target_ref, x.reason_code, x.mapping_sha256, x.created_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          run_id text, source_ref text, source_hash text, scope_fingerprint text,
          disposition text, canonical_target_ref text, reason_code text,
          mapping_sha256 text, created_at bigint
        )`, 250);

      const resolutionHash = canonicalRehydrationDomainHash(
        "mengshu.p15-governance-resolution/v1", runId,
      );
      const governanceRuns = [...scopeRunIds.entries()].map(([scope, childRunId]) => ({
        governance_run_id: childRunId,
        scope_fingerprint: scope,
        trigger_type: "markdown_rehydration",
        policy_version: governance.policyVersion,
        model_fingerprint: null,
        resolution_hash: resolutionHash,
        status: "validating",
        started_at: now,
        completed_at: null,
      }));
      activeProductionPhase = "write-governance-ledger";
      await insertBatches(client, governanceRuns, `INSERT INTO mengshu_document_governance_runs
        SELECT x.governance_run_id, x.scope_fingerprint, x.trigger_type, x.policy_version,
          x.model_fingerprint, x.resolution_hash, x.status, x.started_at, x.completed_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          governance_run_id text, scope_fingerprint text, trigger_type text,
          policy_version text, model_fingerprint text, resolution_hash text, status text,
          started_at bigint, completed_at bigint
        )`, 100);
      await insertBatches(client, mappingRows, `INSERT INTO mengshu_information_dispositions
        SELECT x.governance_run_id, x.scope_fingerprint, x.source_ref, x.source_kind,
          CASE WHEN jsonb_array_length(x.target_asset_ids) = 0 THEN NULL
            ELSE document.semantic_type END,
          '[]'::jsonb, x.governance_disposition, x.target_asset_ids,
          x.reason_code, x.created_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          governance_run_id text, scope_fingerprint text, source_ref text, source_kind text,
          governance_disposition text, target_asset_ids jsonb, reason_code text, created_at bigint
        ) LEFT JOIN LATERAL (
          SELECT d."semanticType" AS semantic_type
          FROM jsonb_to_recordset($2::jsonb) AS d("assetId" text, "semanticType" text)
          WHERE d."assetId" = x.target_asset_ids->>0 LIMIT 1
        ) document ON true`, 250, [JSON.stringify(bundle.documents)]);

      const memoryByAsset = new Map(bundle.memories.map((memory) => [memory.assetId, memory]));
      const documentByAsset = new Map(bundle.documents.map((document) => [document.assetId, document]));
      const manifestByAsset = new Map(governance.assets.map((asset) => [asset.assetId, asset]));
      const evidenceByAsset = new Map<string, typeof bundle.evidence>();
      for (const evidence of bundle.evidence) {
        evidenceByAsset.set(evidence.assetId,
          Object.freeze([...(evidenceByAsset.get(evidence.assetId) ?? []), evidence]));
      }
      const vaultId = `vault_${runId.replace(/[^a-zA-Z0-9_:-]/g, "_")}`;
      const documentMaterials = bundle.documents.map((document) => {
        const memory = memoryByAsset.get(document.assetId);
        const manifestAsset = manifestByAsset.get(document.assetId);
        if (!memory || !manifestAsset || memory.row.visibility !== "private" ||
            manifestAsset.canonicalPath.length === 0) {
          fail("CANONICAL_REHYDRATION_INVALID_INPUT", "document material");
        }
        const completionContractHash = canonicalRehydrationDomainHash(
          "mengshu.p15-document-completion/v1", {
            assetId: document.assetId,
            assetVersion: document.assetVersion,
            publicContentHash: document.publicContentHash,
            governanceProjectionHash: document.governanceProjectionHash,
          },
        );
        const receiptId = canonicalRehydrationDomainHash(
          "mengshu.p15-document-sync-receipt/v1", { runId, assetId: document.assetId },
        );
        return {
          scope_fingerprint: document.scopeFingerprint,
          vault_id: vaultId,
          asset_id: document.assetId,
          asset_version: document.assetVersion,
          schema_version: manifestAsset.schemaVersion,
          kind: document.kind,
          purpose: document.purpose,
          semantic_type: document.semanticType,
          lifecycle_state: "review",
          governance_state: manifestAsset.governanceState,
          relative_path: manifestAsset.canonicalPath,
          normalized_path: manifestAsset.canonicalPath,
          governance_descriptor: {
            schema: "mengshu.p15-governed-document-material/v1",
            p15RunId: runId,
            projection: document,
            claimEvidenceBindings: evidenceByAsset.get(document.assetId) ?? [],
          },
          public_content_hash: document.publicContentHash,
          governance_projection_hash: document.governanceProjectionHash,
          render_hash: manifestAsset.markdownSha256,
          updated_at: Date.parse(manifestAsset.updatedAt),
          owner_user_id: memory.row.user_id,
          descriptor: {
            schema: "mengshu.p15-asset-version/v1",
            p15RunId: runId,
            manifest: manifestAsset,
            projection: document,
          },
          created_at: Date.parse(manifestAsset.createdAt),
          receipt_id: receiptId,
          idempotency_key: receiptId,
          request_hash: canonicalRehydrationDomainHash(
            "mengshu.p15-document-sync-request/v1", { runId, assetId: document.assetId },
          ),
          completion_contract_hash: completionContractHash,
        };
      });
      const vaults = [...new Set(documentMaterials.map((row) => row.scope_fingerprint))]
        .map((scope) => ({
          scope_fingerprint: scope,
          vault_id: vaultId,
          descriptor: { schema: "mengshu.p15-vault/v1", p15RunId: runId, root: "Mengshu" },
          status: "paused",
          created_at: now,
          updated_at: now,
        }));
      activeProductionPhase = "write-pending-documents";
      await insertBatches(client, vaults, `INSERT INTO mengshu_vaults
        SELECT x.scope_fingerprint, x.vault_id, x.descriptor, x.status,
          x.created_at, x.updated_at FROM jsonb_to_recordset($1::jsonb) AS x(
          scope_fingerprint text, vault_id text, descriptor jsonb, status text,
          created_at bigint, updated_at bigint
        )`, 100);
      await insertBatches(client, documentMaterials, `INSERT INTO mengshu_asset_versions
        SELECT x.scope_fingerprint, x.asset_id, x.asset_version, x.kind, 'review', 'private',
          x.owner_user_id, x.descriptor, x.created_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          scope_fingerprint text, asset_id text, asset_version integer, kind text,
          owner_user_id text, descriptor jsonb, created_at bigint
        )`, 100);
      await insertBatches(client, documentMaterials, `INSERT INTO mengshu_governed_document_bindings (
        scope_fingerprint, vault_id, asset_id, asset_version, schema_version, kind, purpose,
        semantic_type, semantic_types, tree_type, tree_level, tree_key, tree_node, seal_version,
        lifecycle_state, governance_state, relative_path, normalized_path,
        governance_descriptor, document_index_asset_id, public_content_hash,
        governance_projection_hash, render_hash, external_hash, sync_state,
        last_complete_version, synced_at, updated_at
      ) SELECT x.scope_fingerprint, x.vault_id, x.asset_id, x.asset_version,
        x.schema_version, x.kind, x.purpose, x.semantic_type, NULL, NULL, NULL, NULL, NULL,
        NULL, x.lifecycle_state, x.governance_state, x.relative_path, x.normalized_path,
        x.governance_descriptor, NULL, x.public_content_hash, x.governance_projection_hash,
        x.render_hash, NULL, 'sync_pending', NULL, NULL, x.updated_at
      FROM jsonb_to_recordset($1::jsonb) AS x(
        scope_fingerprint text, vault_id text, asset_id text, asset_version integer,
        schema_version integer, kind text, purpose text, semantic_type text,
        lifecycle_state text, governance_state text, relative_path text,
        normalized_path text, governance_descriptor jsonb, public_content_hash text,
        governance_projection_hash text, render_hash text, updated_at bigint
      )`, 100);
      await insertBatches(client, documentMaterials,
        `INSERT INTO mengshu_governed_document_sync_receipts
        SELECT x.receipt_id, x.scope_fingerprint, x.vault_id, x.idempotency_key,
          x.request_hash, x.asset_id, x.asset_version, x.public_content_hash,
          x.public_content_hash, x.governance_projection_hash,
          x.completion_contract_hash, 'pending', x.updated_at
        FROM jsonb_to_recordset($1::jsonb) AS x(
          receipt_id text, scope_fingerprint text, vault_id text, idempotency_key text,
          request_hash text, asset_id text, asset_version integer, public_content_hash text,
          governance_projection_hash text, completion_contract_hash text, updated_at bigint
        )`, 100);
      activeProductionPhase = "write-embedding-space";
      await client.query(`INSERT INTO mengshu_embedding_spaces (
        embedding_space_id, provider, base_url, model, dimensions, normalization, state
      ) VALUES ($1, $2, $3, $4, $5, 'none', 'known-queryable') ON CONFLICT DO NOTHING`, [
        embedded.embeddingSpaceId,
        config.embedding.provider,
        embedded.baseURL,
        embedded.model,
        embedded.dimensions,
      ]);
      const space = await client.query(`SELECT provider, base_url, model, dimensions,
        normalization, state FROM mengshu_embedding_spaces WHERE embedding_space_id = $1`,
      [embedded.embeddingSpaceId]);
      if (space.rowCount !== 1 || space.rows[0]?.base_url !== embedded.baseURL ||
          space.rows[0]?.model !== embedded.model ||
          Number(space.rows[0]?.dimensions) !== embedded.dimensions ||
          space.rows[0]?.normalization !== "none" ||
          space.rows[0]?.state !== "known-queryable") {
        fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", "embedding space");
      }
      const canonicalRows = embedded.memories.map((memory) => ({
        ...memory.row,
        vector: memory.vectorText,
        metadata: {
          ...(memory.row.metadata as Record<string, unknown>),
          p15RunId: runId,
          p15ActivationState: "pending",
          embeddingSpaceId: embedded.embeddingSpaceId,
          embeddingSpaceState: "known-queryable",
        },
        lifecycle_status: "pending",
        embedding_space_id: embedded.embeddingSpaceId,
        embedding_space_state: "known-queryable",
      }));
      activeProductionPhase = "write-pending-canonical-memories";
      await insertBatches(client, canonicalRows, `INSERT INTO memories (
        id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
        project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
        canonical_project_id, product_id, producer_id, namespace, visibility,
        lifecycle_status, embedding_space_id, embedding_space_state,
        legacy_quarantine_reason, scope_key
      ) SELECT x.id::uuid, x.text, x.content_hash, x.vector::vector, x.importance,
        x.category, x.data_type, x.metadata, x.created_at::timestamptz,
        x.project_name, x.app_name, x.user_id, x.agent_id, x.workspace_id,
        x.tenant_id, x.canonical_project_id, x.product_id, x.producer_id,
        x.namespace, x.visibility, x.lifecycle_status, x.embedding_space_id,
        x.embedding_space_state, x.legacy_quarantine_reason, x.scope_key
      FROM jsonb_to_recordset($1::jsonb) AS x(
        id text, text text, content_hash text, vector text, importance double precision,
        category text, data_type text, metadata jsonb, created_at text,
        project_name text, app_name text, user_id text, agent_id text, workspace_id text,
        tenant_id text, canonical_project_id text, product_id text, producer_id text,
        namespace text, visibility text, lifecycle_status text, embedding_space_id text,
        embedding_space_state text, legacy_quarantine_reason text, scope_key text
      )`, 50);
      const directLinks = bundle.memories.flatMap((memory) => {
        const metadata = memory.row.metadata as Record<string, unknown>;
        return (metadata.sourceNodeIds as readonly string[]).map((evidenceMemoryId) => ({
          link_id: canonicalRehydrationDomainHash("mengshu.p15-native-evidence-link/v1", {
            runId, targetMemoryId: memory.memoryId, evidenceMemoryId,
          }),
          scope_fingerprint: memory.row.scope_key,
          tenant_id: memory.row.tenant_id,
          user_id: memory.row.user_id,
          app_id: memory.row.product_id,
          project_id: memory.row.canonical_project_id,
          agent_id: memory.row.producer_id,
          namespace: memory.row.namespace,
          visibility: memory.row.visibility,
          workspace_id: memory.row.workspace_id ?? "",
          session_id: metadata.sessionId ?? "",
          target_memory_id: memory.memoryId,
          evidence_memory_id: evidenceMemoryId,
          source: `markdown-curation-p15:${runId}`,
          created_at: now,
        }));
      });
      const transactionReadback = await verifyProductionMaterialization(
        client,
        runId,
        {
          source: bundle.mappings.length,
          memories: bundle.memories.length,
          documents: bundle.documents.length,
          evidence: bundle.evidence.length,
          mappings: bundle.mappings.length,
          scopes: scopeRunIds.size,
          evidenceLinks: 0,
        },
      );
      const updated = await client.query(`UPDATE mengshu_markdown_migration_runs
        SET status = 'verified', mapped_count = $2, staged_live_count = $3, updated_at = $4
        WHERE run_id = $1 AND status = 'staging'`, [
        runId, bundle.mappings.length, bundle.memories.length, now,
      ]);
      if (updated.rowCount !== 1) fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", "run CAS");
      try {
        activeProductionPhase = "commit-materialization";
        commitAttempted = true;
        await client.query("COMMIT");
        commitConfirmed = true;
        dataTransactionStarted = false;
      } catch {
        if (commitAttempted && !commitConfirmed) {
          fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED",
            "production commit outcome unknown; read-only reconciliation required");
        }
        throw new Error("unreachable commit state");
      }
      const verificationPool = new pg.Pool({
        ...config.postgres!,
        max: 1,
        connectionTimeoutMillis: PRODUCTION_CONNECTION_TIMEOUT_MS,
        query_timeout: PRODUCTION_QUERY_TIMEOUT_MS,
      });
      let independentReadback: Readonly<Record<string, unknown>>;
      const verificationClient = await verificationPool.connect();
      try {
        activeProductionPhase = "independent-readback";
        await verificationClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        independentReadback = await verifyProductionMaterialization(verificationClient, runId, {
          source: bundle.mappings.length,
          memories: bundle.memories.length,
          documents: bundle.documents.length,
          evidence: bundle.evidence.length,
          mappings: bundle.mappings.length,
          scopes: scopeRunIds.size,
          evidenceLinks: 0,
        });
        await verificationClient.query("COMMIT");
      } catch {
        await verificationClient.query("ROLLBACK").catch(() => undefined);
        fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED",
          "production commit confirmed but independent verification failed; read-only reconciliation required");
      } finally {
        verificationClient.release();
        await verificationPool.end();
      }
      const materializationPayload = Object.freeze({
        schema: "mengshu.p15-production-materialization-receipt/v1",
        runId,
        projectionHash: bundle.manifest.projectionHash,
        preflightHash: preflight.preflightHash,
        projectionManifestSha256: args.projectionManifestSha256,
        frozenSourceManifestSha256: args.frozenSourceManifestSha256,
        rehearsalReceiptSha256: args.rehearsalReceiptSha256,
        governanceManifestSha256: args.governanceManifestSha256,
        embeddingCacheSha256: args.embeddingCacheSha256,
        sourceWitness,
        schemaMigration: {
          fromVersion: schemaMigration.fromVersion,
          toVersion: schemaMigration.toVersion,
          appliedVersions: schemaMigration.appliedVersions,
          pendingContractVersions: schemaMigration.pendingContractVersions,
        },
        transactionReadback,
        independentReadback,
        plannedEvidenceLinks: directLinks.length,
        guards: {
          sourceRowsUpdated: 0,
          sourceRowsDeleted: 0,
          activationCount: 0,
          archiveCount: 0,
          physicalPurgeCount: 0,
          activationSeparateTokenRequired: true,
        },
        materializedAt: new Date().toISOString(),
      });
      const materializationHash = canonicalRehydrationDomainHash(
        "mengshu.p15-production-materialization/v1", materializationPayload,
      );
      return Object.freeze({
        ...materializationPayload,
        materializationHash,
        activationToken: `P15_ACTIVATE:${runId}:${materializationHash}`,
      });
    } catch (error) {
      if (dataTransactionStarted && !commitAttempted) {
        await client.query("ROLLBACK").catch(() => undefined);
        dataTransactionStarted = false;
      }
      throw error;
    }
  } finally {
    if (sessionLock) {
      await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
        "mengshu:p15:production-materialization",
      ]).catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const requestedMode = argv[argv.indexOf("--mode") + 1];
  if (requestedMode === "apply") {
    const args = parseProductionMaterializationArgs(argv);
    const outputRoot = containedPath(args.migrationRoot, args.outputDir);
    await lstat(outputRoot).then(
      () => fail("CANONICAL_REHYDRATION_INVALID_INPUT", "output already exists"),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const receipt = await runProductionMaterialization(args);
    try {
      await mkdir(outputRoot, { recursive: true, mode: 0o700 });
      await writeExclusive(resolve(outputRoot, "materialization-receipt.json"), receipt);
    } catch {
      fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED",
        "production commit confirmed but local receipt write failed; read-only reconciliation required");
    }
    process.stdout.write(`${JSON.stringify({
      outputDir: args.outputDir,
      materializationHash: receipt.materializationHash,
      guards: receipt.guards,
    })}\n`);
    return;
  }
  if (requestedMode === "preflight" || requestedMode === "preflight-cached") {
    const args = requestedMode === "preflight"
      ? parseProductionPreflightArgs(argv)
      : parseProductionCachedPreflightArgs(argv);
    const outputRoot = containedPath(args.migrationRoot, args.outputDir);
    await lstat(outputRoot).then(
      () => fail("CANONICAL_REHYDRATION_INVALID_INPUT", "output already exists"),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    const result = await runProductionPreflight(args);
    await mkdir(outputRoot, { recursive: true, mode: 0o700 });
    await writeExclusive(resolve(outputRoot, "embedding-vectors.json"), result.vectorCache);
    await writeExclusive(resolve(outputRoot, "preflight-receipt.json"), result.receipt);
    process.stdout.write(`${JSON.stringify({
      outputDir: args.outputDir,
      preflightHash: result.receipt.preflightHash,
      applyToken: result.receipt.applyToken,
      guards: result.receipt.guards,
    })}\n`);
    return;
  }
  const args = parseArgs(argv);
  const outputRoot = containedPath(args.migrationRoot, args.outputDir);
  await lstat(outputRoot).then(
    () => fail("CANONICAL_REHYDRATION_INVALID_INPUT", "output already exists"),
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const artifacts = await runRehearsal(args);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await writeExclusive(resolve(outputRoot, "embedding-receipt.json"), artifacts.embeddingReceipt);
  await writeExclusive(resolve(outputRoot, "readback-receipt.json"), artifacts.readbackReceipt);
  await writeExclusive(resolve(outputRoot, "rollback-receipt.json"), artifacts.rollbackReceipt);
  await writeExclusive(resolve(outputRoot, "rehearsal-receipt.json"), artifacts.finalReceipt);
  process.stdout.write(`${JSON.stringify({
    outputDir: args.outputDir,
    accepted: true,
    projectionHash: artifacts.finalReceipt.projectionHash,
    rehearsalReceiptSha256: canonicalRehydrationSha256(
      canonicalRehydrationJson(artifacts.finalReceipt),
    ),
    guards: artifacts.finalReceipt.guards,
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const message = error instanceof CanonicalRehydrationError
      ? error.message
      : error instanceof Error
        ? `CANONICAL_REHYDRATION_REHEARSAL_FAILED:${error.name}:${error.message}`
        : "CANONICAL_REHYDRATION_REHEARSAL_FAILED";
    const structural = error && typeof error === "object" ? error as {
      code?: unknown;
      table?: unknown;
      column?: unknown;
      constraint?: unknown;
    } : {};
    const safeIdentifier = (value: unknown): string | undefined =>
      typeof value === "string" && /^[a-z_][a-z0-9_]{0,62}$/.test(value)
        ? value : undefined;
    process.stderr.write(`${JSON.stringify({
      ok: false,
      phase: activeProductionPhase,
      canonicalCode: error instanceof CanonicalRehydrationError ? error.code :
        "CANONICAL_REHYDRATION_REHEARSAL_FAILED",
      errorName: error instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
        ? error.name : undefined,
      contractCode: typeof structural.code === "string" &&
          /^SCHEMA_[A-Z_]+$/.test(structural.code) ? structural.code : undefined,
      contractReason: error instanceof Error && error.name === "PostgresSchemaContractError"
        ? error.message : undefined,
      sqlState: typeof structural.code === "string" && /^[0-9A-Z]{5}$/.test(structural.code)
        ? structural.code : undefined,
      table: safeIdentifier(structural.table),
      column: safeIdentifier(structural.column),
      constraint: safeIdentifier(structural.constraint),
      requiresReadOnlyReconciliation: message.includes("read-only reconciliation required"),
      messageHash: canonicalRehydrationSha256(message),
    })}\n`);
    process.exitCode = 1;
  });
}
