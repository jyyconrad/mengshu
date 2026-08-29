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
import { isAbsolute, relative, resolve, sep } from "node:path";

import pg from "pg";

import { memoryConfigSchema } from "../config.js";
import {
  canonicalRehydrationDomainHash,
  canonicalRehydrationJson,
  canonicalRehydrationSha256,
} from "../packages/core/src/db/migrations/canonical-postgres-rehydration.js";
import { executePostgresMigrations } from
  "../packages/core/src/db/migrations/postgres-ledger.js";
import {
  CURRENT_SCHEMA_VERSION,
  planSchemaMigrations,
  SCHEMA_MIGRATIONS,
  type AppliedSchemaMigration,
} from "../packages/core/src/db/migrations/schema-migrations.js";
import {
  parseMarkdownWorksetManifest,
  parseNativeRecordMarkdown,
} from "../packages/core/src/db/migrations/markdown-workset.js";

const SHA256 = /^[0-9a-f]{64}$/;
const REHEARSAL_SCHEMA_VERSION = 24;
const POSTGRES_PORT = 55_433;
let activePhase = "startup";

interface Args {
  readonly migrationRoot: string;
  readonly projectionDir: string;
  readonly projectionManifestSha256: string;
  readonly frozenSourceManifest: string;
  readonly frozenSourceManifestSha256: string;
  readonly rehearsalReceipt: string;
  readonly rehearsalReceiptSha256: string;
  readonly preflightReceipt: string;
  readonly preflightReceiptSha256: string;
  readonly embeddingCache: string;
  readonly embeddingCacheSha256: string;
  readonly governanceManifest: string;
  readonly governanceManifestSha256: string;
  readonly productionConfigPath: string;
  readonly outputDir: string;
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) &&
    !isAbsolute(child);
}

function containedPath(root: string, value: string): string {
  if (!value || isAbsolute(value)) throw new Error("relative path required");
  const target = resolve(root, value);
  if (!strictDescendant(root, target)) throw new Error("path escapes migration root");
  return target;
}

function parseArgs(argv: readonly string[]): Args {
  const allowed = new Set([
    "migration-root", "projection-dir", "projection-manifest-sha256",
    "frozen-source-manifest", "frozen-source-manifest-sha256",
    "rehearsal-receipt", "rehearsal-receipt-sha256",
    "preflight-receipt", "preflight-receipt-sha256",
    "embedding-cache", "embedding-cache-sha256",
    "governance-manifest", "governance-manifest-sha256",
    "production-config", "output-dir",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    const name = option?.startsWith("--") ? option.slice(2) : "";
    if (!option?.startsWith("--") || !value || value.startsWith("--") ||
        !allowed.has(name) || values.has(name)) {
      throw new Error("invalid rehearsal arguments");
    }
    values.set(name, value);
  }
  if (values.size !== allowed.size) throw new Error("missing rehearsal argument");
  const migrationRoot = resolve(values.get("migration-root")!);
  const productionConfigPath = resolve(values.get("production-config")!);
  if (migrationRoot !== values.get("migration-root") ||
      productionConfigPath !== values.get("production-config")) {
    throw new Error("canonical absolute paths required");
  }
  for (const name of [...allowed].filter((name) => name.endsWith("sha256"))) {
    if (!SHA256.test(values.get(name)!)) throw new Error(`invalid ${name}`);
  }
  return {
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
    productionConfigPath,
    outputDir: values.get("output-dir")!,
  };
}

function runProgram(
  file: string,
  args: readonly string[],
  options: Readonly<{ cwd?: string }> = {},
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(file, [...args], {
      cwd: options.cwd,
      maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const diagnostic = typeof stderr === "string" && stderr.trim().startsWith("{")
          ? JSON.parse(stderr.trim()) as unknown : undefined;
        if (diagnostic && typeof diagnostic === "object") {
          Object.assign(error, { childDiagnostic: diagnostic });
        }
        reject(error);
      }
      else resolvePromise(stdout);
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

async function assertFileSha(path: string, expected: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("regular artifact required");
  const text = await readFile(path, "utf8");
  if (canonicalRehydrationSha256(text) !== expected) throw new Error(`artifact drift: ${path}`);
  return text;
}

async function bootstrapV24(pool: pg.Pool, dimensions: number): Promise<void> {
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  for (const [table, importance, dataType] of [
    ["memories", "0.7", "memory"], ["knowledge", "0.5", "knowledge"],
  ] as const) {
    await pool.query(`CREATE TABLE ${table} (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(), text TEXT NOT NULL,
      content_hash TEXT NOT NULL UNIQUE, vector vector(${dimensions}) NOT NULL,
      importance FLOAT DEFAULT ${importance}, category TEXT NOT NULL DEFAULT 'other',
      data_type TEXT NOT NULL DEFAULT '${dataType}', metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), project_name TEXT, app_name TEXT,
      user_id TEXT, agent_id TEXT, workspace_id TEXT
    )`);
  }
  const client = await pool.connect();
  try {
    const migration = await executePostgresMigrations({
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params: readonly unknown[] = [],
      ) => {
        const result = await client.query(sql, [...params]);
        return { rows: result.rows as Row[], rowCount: result.rowCount };
      },
    }, {
      migrations: SCHEMA_MIGRATIONS.slice(0, REHEARSAL_SCHEMA_VERSION),
      currentSchemaVersion: REHEARSAL_SCHEMA_VERSION,
      contractMigration: { mode: "apply", maintenance: true, quiescenceConfirmed: true },
    });
    if (migration.fromVersion !== 0 || migration.toVersion !== REHEARSAL_SCHEMA_VERSION ||
        migration.pendingContractVersions.length !== 0) {
      throw new Error("temporary v24 bootstrap failed");
    }
  } finally {
    client.release();
  }
}

function sourcePayload(markdown: string): Readonly<Record<string, unknown>> {
  const { record } = parseNativeRecordMarkdown(markdown);
  return Object.freeze({
    id: record.id,
    text: record.text,
    content_hash: record.contentHash,
    vector: `[${record.vector.join(",")}]`,
    importance: record.importance,
    category: record.category,
    data_type: record.dataType,
    metadata: record.metadata,
    created_at: record.createdAt,
    project_name: record.projectName ?? null,
    app_name: record.appName ?? null,
    user_id: record.userId ?? null,
    agent_id: record.agentId ?? null,
    workspace_id: record.workspaceId ?? null,
    tenant_id: record.tenantId ?? null,
    canonical_project_id: record.canonicalProjectId ?? null,
    product_id: record.productId ?? null,
    producer_id: record.producerId ?? null,
    namespace: record.namespace ?? null,
    visibility: record.visibility ?? null,
    lifecycle_status: record.lifecycleStatus ?? null,
    embedding_space_id: record.embeddingSpaceId ?? null,
    embedding_space_state: record.embeddingSpaceState ?? null,
    legacy_quarantine_reason: record.legacyQuarantineReason ?? null,
    scope_key: record.scopeKey ?? null,
  });
}

async function insertSourceBatch(
  pool: pg.Pool,
  table: "memories" | "knowledge",
  rows: readonly Readonly<Record<string, unknown>>[],
): Promise<void> {
  if (rows.length === 0) return;
  const result = await pool.query(`INSERT INTO ${table} (
    id, text, content_hash, vector, importance, category, data_type, metadata, created_at,
    project_name, app_name, user_id, agent_id, workspace_id, tenant_id,
    canonical_project_id, product_id, producer_id, namespace, visibility,
    lifecycle_status, embedding_space_id, embedding_space_state,
    legacy_quarantine_reason, scope_key
  ) SELECT x.id::uuid, x.text, x.content_hash, x.vector::vector, x.importance,
    x.category, x.data_type, x.metadata, x.created_at::timestamptz,
    x.project_name, x.app_name, x.user_id, x.agent_id, x.workspace_id, x.tenant_id,
    x.canonical_project_id, x.product_id, x.producer_id, x.namespace, x.visibility,
    x.lifecycle_status, x.embedding_space_id, x.embedding_space_state,
    x.legacy_quarantine_reason, x.scope_key
  FROM jsonb_to_recordset($1::jsonb) AS x(
    id text, text text, content_hash text, vector text, importance double precision,
    category text, data_type text, metadata jsonb, created_at text,
    project_name text, app_name text, user_id text, agent_id text, workspace_id text,
    tenant_id text, canonical_project_id text, product_id text, producer_id text,
    namespace text, visibility text, lifecycle_status text, embedding_space_id text,
    embedding_space_state text, legacy_quarantine_reason text, scope_key text
  )`, [JSON.stringify(rows)]);
  if (result.rowCount !== rows.length) throw new Error(`source seed mismatch: ${table}`);
}

async function readSourceMutationWitness(
  pool: pg.Pool,
): Promise<Readonly<{ count: number; witnessHash: string }>> {
  const result = await pool.query(`SELECT count(*)::text AS count,
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
  return Object.freeze({
    count: Number(result.rows[0]?.count),
    witnessHash: String(result.rows[0]?.witness_hash),
  });
}

async function seedFrozenSource(
  pool: pg.Pool,
  manifestPath: string,
  manifestSha256: string,
): Promise<Readonly<{ memories: number; knowledge: number }>> {
  const manifestText = await assertFileSha(manifestPath, manifestSha256);
  const manifest = parseMarkdownWorksetManifest(manifestText);
  const root = resolve(manifestPath, "..");
  const batches = { memories: [] as Readonly<Record<string, unknown>>[],
    knowledge: [] as Readonly<Record<string, unknown>>[] };
  const counts = { memories: 0, knowledge: 0 };
  for (const entry of manifest.files) {
    const table = entry.sourceRef.startsWith("memories:") ? "memories" :
      entry.sourceRef.startsWith("knowledge:") ? "knowledge" : undefined;
    if (!table) throw new Error("unsupported source reference");
    const path = containedPath(root, entry.relativePath);
    const markdown = await assertFileSha(path, entry.markdownSha256);
    const parsed = parseNativeRecordMarkdown(markdown);
    if (parsed.sourceRef !== entry.sourceRef || parsed.sourceHash !== entry.sourceHash) {
      throw new Error(`frozen source identity drift: ${entry.sourceRef}`);
    }
    batches[table].push(sourcePayload(markdown));
    counts[table] += 1;
    if (batches[table].length === 25) {
      await insertSourceBatch(pool, table, batches[table]);
      batches[table] = [];
    }
  }
  await insertSourceBatch(pool, "memories", batches.memories);
  await insertSourceBatch(pool, "knowledge", batches.knowledge);
  return Object.freeze(counts);
}

async function main(): Promise<void> {
  activePhase = "parse-and-validate-input";
  const args = parseArgs(process.argv.slice(2));
  const outputRoot = containedPath(args.migrationRoot, args.outputDir);
  await lstat(outputRoot).then(
    () => { throw new Error("rehearsal output already exists"); },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const artifactPaths = {
    projection: containedPath(args.migrationRoot,
      `${args.projectionDir}/projection-manifest.json`),
    frozen: containedPath(args.migrationRoot, args.frozenSourceManifest),
    rehearsal: containedPath(args.migrationRoot, args.rehearsalReceipt),
    preflight: containedPath(args.migrationRoot, args.preflightReceipt),
    cache: containedPath(args.migrationRoot, args.embeddingCache),
    governance: containedPath(args.migrationRoot, args.governanceManifest),
  };
  const [productionConfigText, productionPreflightText, , , , embeddingCacheText] =
    await Promise.all([
    readFile(args.productionConfigPath, "utf8"),
    assertFileSha(artifactPaths.preflight, args.preflightReceiptSha256),
    assertFileSha(artifactPaths.projection, args.projectionManifestSha256),
    assertFileSha(artifactPaths.frozen, args.frozenSourceManifestSha256),
    assertFileSha(artifactPaths.rehearsal, args.rehearsalReceiptSha256),
    assertFileSha(artifactPaths.cache, args.embeddingCacheSha256),
    assertFileSha(artifactPaths.governance, args.governanceManifestSha256),
    ]);
  const rawConfig = JSON.parse(productionConfigText) as Record<string, unknown>;
  const config = memoryConfigSchema.parse({
    embedding: rawConfig.embedding,
    dbType: rawConfig.dbType,
    postgres: rawConfig.postgres,
  });
  const productionPreflight = JSON.parse(productionPreflightText) as Record<string, unknown>;
  const embeddingCache = JSON.parse(embeddingCacheText) as Record<string, unknown>;
  const tempRoot = await mkdtemp(resolve(tmpdir(), "ms-p15-"));
  const dataDir = resolve(tempRoot, "d");
  const socketDir = resolve(tempRoot, "s");
  const logPath = resolve(tempRoot, "pg.log");
  const tempConfigPath = resolve(tempRoot, "config.json");
  const ephemeralDirName = `.p15-materialization-rehearsal-${process.pid}`;
  const ephemeralRoot = containedPath(args.migrationRoot, ephemeralDirName);
  const tempPreflightRelative = `${ephemeralDirName}/preflight-receipt.json`;
  const tempApplyOutputRelative = `${ephemeralDirName}/apply-output`;
  let pool: pg.Pool | undefined;
  let started = false;
  let acceptedReceipt: Readonly<Record<string, unknown>> | undefined;
  try {
    activePhase = "initialize-temporary-postgres";
    await mkdir(socketDir, { mode: 0o700 });
    await mkdir(ephemeralRoot, { mode: 0o700 });
    activePhase = "initdb";
    await runProgram("/opt/homebrew/bin/initdb", [
      "-D", dataDir, "--no-locale", "--encoding=UTF8", "--auth=trust",
      "--username", userInfo().username,
    ]);
    activePhase = "start-temporary-postgres";
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
      max: 1,
    });
    activePhase = "verify-temporary-postgres-identity";
    const identity = await pool.query(`SELECT current_database() AS database_name,
      inet_server_addr()::text AS server_address, inet_server_port()::text AS server_port,
      current_setting('data_directory') AS data_directory`);
    if (await realpath(String(identity.rows[0]?.data_directory)) !== await realpath(dataDir)) {
      throw new Error("temporary PostgreSQL identity mismatch");
    }
    activePhase = "bootstrap-v24";
    const dimensions = Number((productionPreflight.embedding as Record<string, unknown>)?.dimensions);
    await bootstrapV24(pool, dimensions);
    const embeddingSpaceId = String(embeddingCache.embeddingSpaceId);
    await pool.query(`INSERT INTO mengshu_embedding_spaces (
      embedding_space_id, provider, base_url, model, dimensions, normalization, state
    ) VALUES ($1, $2, $3, $4, $5, 'none', 'known-queryable')`, [
      embeddingSpaceId,
      config.embedding.provider,
      config.embedding.baseURL,
      embeddingCache.model,
      embeddingCache.dimensions,
    ]);
    await pool.query(`INSERT INTO mengshu_active_embedding_space (
      singleton_key, embedding_space_id
    ) VALUES ('active', $1)`, [embeddingSpaceId]);
    activePhase = "seed-frozen-source";
    const seeded = await seedFrozenSource(
      pool,
      artifactPaths.frozen,
      args.frozenSourceManifestSha256,
    );
    if (seeded.memories + seeded.knowledge !== 49_465) {
      throw new Error("frozen source rehearsal coverage mismatch");
    }
    const ledger = await pool.query<AppliedSchemaMigration>(
      "SELECT version, name, checksum FROM mengshu_schema_migrations ORDER BY version",
    );
    const plan = planSchemaMigrations(ledger.rows);
    if (plan.fromVersion !== REHEARSAL_SCHEMA_VERSION ||
        plan.toVersion !== CURRENT_SCHEMA_VERSION) {
      throw new Error("temporary migration plan mismatch");
    }
    const sourceWitness = await readSourceMutationWitness(pool);
    if (sourceWitness.count !== seeded.memories + seeded.knowledge ||
        !SHA256.test(sourceWitness.witnessHash)) {
      throw new Error("temporary source witness mismatch");
    }
    const endpointFingerprint = canonicalRehydrationDomainHash("mengshu.postgres-endpoint/v1", {
      host: socketDir,
      port: POSTGRES_PORT,
      database: "postgres",
      user: userInfo().username,
      ssl: false,
    });
    const serverIdentityHash = canonicalRehydrationDomainHash("mengshu.postgres-server/v1", {
      database: identity.rows[0]?.database_name,
      address: identity.rows[0]?.server_address,
      port: identity.rows[0]?.server_port,
    });
    const originalDatabase = productionPreflight.database as Record<string, unknown>;
    const preflightPayload = {
      ...productionPreflight,
      database: {
        ...originalDatabase,
        activity: { idle: 0, idleInTransaction: 0, nonIdle: 0 },
        counts: seeded,
        currentSchemaVersion: REHEARSAL_SCHEMA_VERSION,
        endpointFingerprint,
        pendingMigrations: plan.pending.map((migration) => ({
          checksum: migration.checksum,
          kind: migration.kind,
          name: migration.name,
          version: migration.version,
        })),
        serverIdentityHash,
        sourceWitness,
        targetSchemaVersion: CURRENT_SCHEMA_VERSION,
        transactionReadOnly: true,
      },
    };
    delete (preflightPayload as Record<string, unknown>).preflightHash;
    delete (preflightPayload as Record<string, unknown>).applyToken;
    const preflightHash = canonicalRehydrationDomainHash(
      "mengshu.p15-production-preflight/v1",
      preflightPayload,
    );
    const runId = String(productionPreflight.runId);
    const tempPreflight = {
      ...preflightPayload,
      preflightHash,
      applyToken: `P15_APPLY:${runId}:${preflightHash}`,
    };
    const tempPreflightPath = containedPath(args.migrationRoot, tempPreflightRelative);
    activePhase = "write-temporary-authorization";
    await writeExclusive(tempPreflightPath, tempPreflight);
    const tempPreflightSha256 = canonicalRehydrationSha256(
      canonicalRehydrationJson(tempPreflight),
    );
    const tempConfig = {
      embedding: {
        provider: config.embedding.provider,
        apiKey: "rehearsal-unused",
        baseURL: config.embedding.baseURL,
        model: config.embedding.model,
      },
      dbType: "postgres",
      postgres: {
        host: socketDir,
        port: POSTGRES_PORT,
        database: "postgres",
        user: userInfo().username,
        password: "rehearsal-unused",
        ssl: false,
      },
    };
    await writeExclusive(tempConfigPath, tempConfig);
    await pool.end();
    pool = undefined;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 1_000));
    activePhase = "execute-materialization";
    await runProgram(resolve("node_modules/.bin/tsx"), [
      "scripts/postgres-canonical-rehydration.ts",
      "--mode", "apply",
      "--migration-root", args.migrationRoot,
      "--projection-dir", args.projectionDir,
      "--projection-manifest-sha256", args.projectionManifestSha256,
      "--frozen-source-manifest", args.frozenSourceManifest,
      "--frozen-source-manifest-sha256", args.frozenSourceManifestSha256,
      "--rehearsal-receipt", args.rehearsalReceipt,
      "--rehearsal-receipt-sha256", args.rehearsalReceiptSha256,
      "--preflight-receipt", tempPreflightRelative,
      "--preflight-receipt-sha256", tempPreflightSha256,
      "--embedding-cache", args.embeddingCache,
      "--embedding-cache-sha256", args.embeddingCacheSha256,
      "--governance-manifest", args.governanceManifest,
      "--governance-manifest-sha256", args.governanceManifestSha256,
      "--config", tempConfigPath,
      "--output-dir", tempApplyOutputRelative,
      "--apply-token", String(tempPreflight.applyToken),
      "--maintenance", "true",
      "--quiescence-confirmed", "true",
    ], { cwd: resolve(".") });
    const tempReceiptPath = containedPath(
      args.migrationRoot,
      `${tempApplyOutputRelative}/materialization-receipt.json`,
    );
    const tempReceiptText = await readFile(tempReceiptPath, "utf8");
    const tempReceipt = JSON.parse(tempReceiptText) as Record<string, unknown>;
    const guards = tempReceipt.guards as Record<string, unknown>;
    if (guards?.sourceRowsUpdated !== 0 || guards?.sourceRowsDeleted !== 0 ||
        guards?.activationCount !== 0 || guards?.archiveCount !== 0 ||
        guards?.physicalPurgeCount !== 0 ||
        guards?.activationSeparateTokenRequired !== true) {
      throw new Error("temporary materialization guard mismatch");
    }
    activePhase = "restart-and-verify";
    await runProgram("/opt/homebrew/bin/pg_ctl", [
      "-D", dataDir, "-l", logPath, "-m", "fast", "-w", "restart",
    ]);
    pool = new pg.Pool({
      host: socketDir,
      port: POSTGRES_PORT,
      database: "postgres",
      user: userInfo().username,
      max: 1,
    });
    const postRestart = await pool.query(`SELECT
      (SELECT count(*)::text FROM memories) AS memories,
      (SELECT count(*)::text FROM knowledge) AS knowledge,
      (SELECT count(*)::text FROM memories WHERE metadata->>'p15RunId' = $1
        AND lifecycle_status = 'pending') AS pending,
      (SELECT status FROM mengshu_markdown_migration_runs WHERE run_id = $1) AS run_status,
      (SELECT max(version)::text FROM mengshu_schema_migrations) AS schema_version,
      (SELECT embedding_space_id FROM mengshu_active_embedding_space
        WHERE singleton_key = 'active') AS active_embedding_space,
      (SELECT state FROM mengshu_embedding_spaces WHERE embedding_space_id = $2)
        AS embedding_space_state`, [runId, embeddingSpaceId]);
    const row = postRestart.rows[0] as Record<string, string>;
    if (Number(row.memories) !== seeded.memories + 363 ||
        Number(row.knowledge) !== seeded.knowledge || Number(row.pending) !== 363 ||
        row.run_status !== "verified" || Number(row.schema_version) !== CURRENT_SCHEMA_VERSION ||
        row.active_embedding_space !== embeddingSpaceId ||
        row.embedding_space_state !== "known-queryable") {
      throw new Error("post-restart materialization verification failed");
    }
    acceptedReceipt = Object.freeze({
      schema: "mengshu.p15-production-materialization-rehearsal/v1",
      accepted: true,
      runId,
      projectionHash: productionPreflight.projectionHash,
      productionPreflightHash: productionPreflight.preflightHash,
      sourceCounts: seeded,
      sourceTotal: seeded.memories + seeded.knowledge,
      schemaMigration: tempReceipt.schemaMigration,
      materializationHash: tempReceipt.materializationHash,
      transactionReadback: tempReceipt.transactionReadback,
      independentReadback: tempReceipt.independentReadback,
      postRestart: {
        memories: Number(row.memories),
        knowledge: Number(row.knowledge),
        pending: Number(row.pending),
        runStatus: row.run_status,
        schemaVersion: Number(row.schema_version),
        activeEmbeddingSpaceUnchanged: true,
        embeddingSpaceState: row.embedding_space_state,
      },
      guards: {
        ...guards,
        productionConnectionOpened: false,
        productionDdlCount: 0,
        productionDmlCount: 0,
        temporaryApplyReceiptRetained: false,
        temporaryApplyTokenRetained: false,
        temporaryActivationTokenRetained: false,
      },
      completedAt: new Date().toISOString(),
    });
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    if (started) {
      await runProgram("/opt/homebrew/bin/pg_ctl", [
        "-D", dataDir, "-m", "fast", "-w", "stop",
      ]).catch(() => undefined);
    }
    if (strictDescendant(args.migrationRoot, ephemeralRoot)) {
      await rm(ephemeralRoot, { recursive: true, force: true });
    }
    if (tempRoot.startsWith(resolve(tmpdir(), "ms-p15-"))) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
  if (!acceptedReceipt) throw new Error("materialization rehearsal did not complete");
  activePhase = "write-rehearsal-receipt";
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await writeExclusive(resolve(outputRoot, "rehearsal-receipt.json"), acceptedReceipt);
  process.stdout.write(`${JSON.stringify({
    outputDir: args.outputDir,
    accepted: true,
    materializationHash: acceptedReceipt.materializationHash,
    sourceTotal: acceptedReceipt.sourceTotal,
  })}\n`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const errorHash = createHash("sha256").update(message).digest("hex");
  const code = error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" ? error.code : undefined;
  const structural = error && typeof error === "object" ? error as {
    table?: unknown;
    column?: unknown;
    constraint?: unknown;
    childDiagnostic?: unknown;
  } : {};
  process.stderr.write(`${JSON.stringify({
    ok: false,
    phase: activePhase,
    code,
    table: typeof structural.table === "string" ? structural.table : undefined,
    column: typeof structural.column === "string" ? structural.column : undefined,
    constraint: typeof structural.constraint === "string" ? structural.constraint : undefined,
    childDiagnostic: structural.childDiagnostic,
    errorHash,
  })}\n`);
  process.exitCode = 1;
});
