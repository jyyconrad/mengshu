#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import { computeContentHash } from "../packages/core/src/scoring/hash-utils.js";
import {
  REGISTRY_VERSION,
  serializeRegistry,
  type MemoryAutodbRegistry,
  type RegistryProjectAlias,
} from "../packages/core/src/runtime/registry.js";

export const OPERATOR_SCOPE_STAGE_APPLY_TOKEN =
  "APPLY-MENGSHU-OPERATOR-SCOPE-STAGE-V1";

export type OperatorScopeStageTable = "memories" | "knowledge";
export type OperatorScopeStageMode = "dry-run" | "apply";

interface CanonicalScopeDefaults {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly visibility: "private" | "workspace" | "team" | "public";
}

interface ProducerDefaults {
  readonly productId: string;
  readonly producerId: string;
}

interface TableDefaults {
  readonly namespace: string;
  readonly productId?: string;
  readonly producerId?: string;
  readonly defaultProjectId?: string;
}

export interface OperatorScopeSourceRoot {
  readonly root: string;
  readonly projectId: string;
}

export interface OperatorScopeRegistryProject {
  readonly workspaceId: string;
  readonly manifestPath?: string;
  readonly displayName?: string;
  readonly aliases?: readonly string[];
}

export interface OperatorScopeStageManifest {
  readonly version: 1;
  readonly defaults: {
    readonly scope: CanonicalScopeDefaults;
    readonly producer: ProducerDefaults;
  };
  readonly tables: Record<OperatorScopeStageTable, TableDefaults>;
  readonly legacyUserAliases: Readonly<Record<string, string>>;
  readonly projectNameAliases: Readonly<Record<string, string>>;
  readonly sourceRoots: readonly OperatorScopeSourceRoot[];
  /** 可选显式 registry 元信息；缺省 workspaceId=projectId。 */
  readonly registryProjects?: Readonly<Record<string, OperatorScopeRegistryProject>>;
  readonly unmatched: "quarantine";
}

export interface OperatorScopeStageRow {
  readonly id: string;
  readonly text: string;
  readonly contentHash: string | null;
  readonly metadata: unknown;
  readonly projectName: string | null;
  readonly appName: string | null;
  readonly userId: string | null;
  readonly agentId: string | null;
  readonly workspaceId: string | null;
}

export interface OperatorScopeFields {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: "private" | "workspace" | "team" | "public";
  readonly productId: string;
  readonly producerId: string;
  readonly projectId: string;
}

interface StageAuditMarker {
  readonly version: "operator-scope-stage-v1";
  readonly manifestSha256: string;
  readonly originalMetadataHash: string;
  /** v5 NULL 必须保留明确 sentinel，禁止伪造成有效 hash。 */
  readonly originalContentHash: string;
  readonly stagedContentHash: string;
  readonly auditHash: string;
}

export type OperatorScopeStagePlan =
  | {
      readonly status: "staged";
      readonly fields: OperatorScopeFields;
      readonly repairedContentHash: boolean;
      readonly metadata: Record<string, unknown> & { operatorScopeStage: StageAuditMarker };
    }
  | {
      readonly status: "already-staged";
      readonly fields: OperatorScopeFields;
      readonly repairedContentHash: boolean;
    }
  | {
      readonly status: "unmatched";
      readonly reason: "unmapped-user" | "unmapped-project" | "conflicting-evidence";
    };

export interface OperatorScopeStageClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: Row[]; readonly rowCount?: number | null }>;
}

export interface OperatorPostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl?: boolean;
}

export interface RunOperatorScopeStageOptions {
  readonly mode?: OperatorScopeStageMode;
  readonly maintenance?: boolean;
  readonly quiescenceConfirmed?: boolean;
  readonly confirmationToken?: string;
  readonly expectedManifestSha256?: string;
  readonly batchSize?: number;
}

export interface OperatorScopeStageTableResult {
  readonly table: OperatorScopeStageTable;
  readonly scanned: number;
  readonly staged: number;
  readonly unmatched: number;
  readonly alreadyStaged: number;
  readonly updated: number;
  readonly repairedContentHashes: number;
}

export interface OperatorScopeStageResult {
  readonly mode: OperatorScopeStageMode;
  readonly manifestSha256: string;
  readonly scanned: number;
  readonly staged: number;
  readonly unmatched: number;
  readonly alreadyStaged: number;
  readonly updated: number;
  readonly repairedContentHashes: number;
  readonly tables: readonly OperatorScopeStageTableResult[];
}

type OperatorScopeStageErrorCode =
  | "INVALID_ARGUMENTS"
  | "INVALID_CONFIG"
  | "INVALID_MANIFEST"
  | "APPLY_GATE_REQUIRED"
  | "MANIFEST_SHA_MISMATCH"
  | "INVALID_DATABASE_RESULT"
  | "CONCURRENT_ROW_DRIFT"
  | "DATABASE_OPERATION_FAILED"
  | "REGISTRY_WRITE_FAILED";

const ERROR_MESSAGES: Record<OperatorScopeStageErrorCode, string> = {
  INVALID_ARGUMENTS: "Operator scope staging arguments are invalid",
  INVALID_CONFIG: "Operator scope staging PostgreSQL config is invalid",
  INVALID_MANIFEST: "Operator scope staging manifest is invalid",
  APPLY_GATE_REQUIRED:
    "Operator scope staging apply requires maintenance, quiescence and exact confirmation token",
  MANIFEST_SHA_MISMATCH: "Operator scope staging manifest SHA-256 does not match",
  INVALID_DATABASE_RESULT: "Operator scope staging database result is invalid",
  CONCURRENT_ROW_DRIFT: "Operator scope staging detected concurrent row drift",
  DATABASE_OPERATION_FAILED: "Operator scope staging database operation failed",
  REGISTRY_WRITE_FAILED: "Operator scope staging registry write failed",
};

export class OperatorScopeStageError extends Error {
  constructor(readonly code: OperatorScopeStageErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "OperatorScopeStageError";
  }
}

const TABLES = ["memories", "knowledge"] as const;
// Legacy rows use UUID v1-v5; current ingest uses deterministic RFC 9562 UUIDv8.
// Variant remains the canonical 10xx form ([89ab]).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{32,128}$/i;
const LEGACY_UUID_CONTENT_HASH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const CANONICAL_VALUE = /^[^\s\u0000-\u001f\u007f]{1,256}$/u;
const PATH_FIELDS = ["projectRoot", "projectPath", "cwd", "filePath", "sourcePath"] as const;
const DEFAULT_BATCH_SIZE = 500;
const LEGACY_NULL_CONTENT_HASH = "legacy-null";

function fail(code: OperatorScopeStageErrorCode): never {
  throw new OperatorScopeStageError(code);
}

function isSupportedLegacyContentHash(value: string): boolean {
  return HEX_HASH.test(value) || LEGACY_UUID_CONTENT_HASH.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function explicit(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function assertCanonical(value: unknown): asserts value is string {
  if (typeof value !== "string" || !CANONICAL_VALUE.test(value)) {
    fail("INVALID_MANIFEST");
  }
}

function stableValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(stableValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return { type: typeof value };
}

function hash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0${JSON.stringify(stableValue(value))}`)
    .digest("hex");
}

function assertRecordOfCanonicalStrings(value: unknown): asserts value is Record<string, string> {
  if (!isRecord(value)) fail("INVALID_MANIFEST");
  for (const [key, mapped] of Object.entries(value)) {
    assertCanonical(key);
    assertCanonical(mapped);
  }
}

function resolvePostgresConfigString(
  value: unknown,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (typeof value !== "string") fail("INVALID_CONFIG");
  let invalid = false;
  const resolved = value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_match, name: string) => {
    const replacement = env[name];
    if (typeof replacement !== "string" || replacement.length === 0) {
      invalid = true;
      return "";
    }
    return replacement;
  });
  // 拒绝非法/未闭合 placeholder；固定错误不包含变量名或实际值。
  if (invalid || resolved.includes("${") || resolved.length === 0 || resolved.length > 4_096 ||
      /[\u0000-\u001f\u007f]/u.test(resolved)) {
    fail("INVALID_CONFIG");
  }
  return resolved;
}

/**
 * Operator migration 只读取 PostgreSQL 连接合同。embedding/llm 等 runtime 配置
 * 与 metadata staging 无关，即使包含未设置 placeholder 也不得阻断迁移。
 */
export function parseOperatorPostgresConfig(
  raw: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): OperatorPostgresConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("INVALID_CONFIG");
  }
  if (!isRecord(parsed) || parsed.dbType !== "postgres" || !isRecord(parsed.postgres)) {
    fail("INVALID_CONFIG");
  }
  const postgres = parsed.postgres;
  const allowed = new Set(["host", "port", "database", "user", "password", "ssl"]);
  if (Object.keys(postgres).some((key) => !allowed.has(key))) fail("INVALID_CONFIG");
  const host = resolvePostgresConfigString(postgres.host, env);
  const database = resolvePostgresConfigString(postgres.database, env);
  const user = resolvePostgresConfigString(postgres.user, env);
  const password = resolvePostgresConfigString(postgres.password, env);
  const rawPort = typeof postgres.port === "number"
    ? postgres.port
    : Number(resolvePostgresConfigString(postgres.port, env));
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) fail("INVALID_CONFIG");
  let ssl: boolean | undefined;
  if (postgres.ssl !== undefined) {
    if (typeof postgres.ssl === "boolean") {
      ssl = postgres.ssl;
    } else {
      const value = resolvePostgresConfigString(postgres.ssl, env);
      if (value !== "true" && value !== "false") fail("INVALID_CONFIG");
      ssl = value === "true";
    }
  }
  return { host, port: rawPort, database, user, password, ssl };
}

function validateManifest(value: unknown): OperatorScopeStageManifest {
  if (!isRecord(value) || value.version !== 1 || value.unmatched !== "quarantine" ||
      !isRecord(value.defaults) || !isRecord(value.defaults.scope) ||
      !isRecord(value.defaults.producer) || !isRecord(value.tables) ||
      !isRecord(value.tables.memories) || !isRecord(value.tables.knowledge) ||
      !Array.isArray(value.sourceRoots)) {
    fail("INVALID_MANIFEST");
  }
  const scope = value.defaults.scope;
  for (const field of ["tenantId", "userId", "appId", "agentId"] as const) {
    assertCanonical(scope[field]);
  }
  if (!["private", "workspace", "team", "public"].includes(String(scope.visibility))) {
    fail("INVALID_MANIFEST");
  }
  for (const field of ["productId", "producerId"] as const) {
    assertCanonical(value.defaults.producer[field]);
  }
  for (const table of TABLES) {
    const tableDefaults = value.tables[table] as Record<string, unknown>;
    assertCanonical(tableDefaults.namespace);
    for (const field of ["productId", "producerId", "defaultProjectId"] as const) {
      if (tableDefaults[field] !== undefined) assertCanonical(tableDefaults[field]);
    }
  }
  assertRecordOfCanonicalStrings(value.legacyUserAliases);
  assertRecordOfCanonicalStrings(value.projectNameAliases);

  const roots = new Map<string, string>();
  const projectRoots = new Map<string, string>();
  for (const item of value.sourceRoots) {
    if (!isRecord(item) || typeof item.root !== "string" || !isAbsolute(item.root)) {
      fail("INVALID_MANIFEST");
    }
    assertCanonical(item.projectId);
    const root = normalize(item.root);
    const previous = roots.get(root);
    if (previous && previous !== item.projectId) fail("INVALID_MANIFEST");
    const previousProjectRoot = projectRoots.get(item.projectId);
    if (previousProjectRoot && previousProjectRoot !== root) fail("INVALID_MANIFEST");
    roots.set(root, item.projectId);
    projectRoots.set(item.projectId, root);
  }

  const knownProjects = new Set([
    ...Object.values(value.projectNameAliases),
    ...value.sourceRoots.map((item) => item.projectId),
    ...TABLES.flatMap((table) => {
      const projectId = (value.tables as Record<string, Record<string, unknown>>)[table]?.defaultProjectId;
      return typeof projectId === "string" ? [projectId] : [];
    }),
  ]);
  if (value.registryProjects !== undefined) {
    if (!isRecord(value.registryProjects)) fail("INVALID_MANIFEST");
    for (const [projectId, entry] of Object.entries(value.registryProjects)) {
      assertCanonical(projectId);
      if (!knownProjects.has(projectId) || !isRecord(entry)) fail("INVALID_MANIFEST");
      assertCanonical(entry.workspaceId);
      if (entry.manifestPath !== undefined && typeof entry.manifestPath !== "string") {
        fail("INVALID_MANIFEST");
      }
      if (entry.aliases !== undefined &&
          (!Array.isArray(entry.aliases) || entry.aliases.some((alias) => typeof alias !== "string"))) {
        fail("INVALID_MANIFEST");
      }
    }
  }
  return value as unknown as OperatorScopeStageManifest;
}

export function loadOperatorScopeManifest(raw: string): {
  readonly manifest: OperatorScopeStageManifest;
  readonly sha256: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("INVALID_MANIFEST");
  }
  return {
    manifest: validateManifest(parsed),
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function pathBelongsToRoot(candidate: string, root: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`));
}

function pathEvidence(metadata: Record<string, unknown>): string[] {
  const provenance = isRecord(metadata.provenance) ? metadata.provenance : {};
  return [...PATH_FIELDS.flatMap((field) => [metadata[field], provenance[field]])]
    .map(explicit)
    .filter((value): value is string => value !== undefined);
}

function resolveUser(
  row: OperatorScopeStageRow,
  manifest: OperatorScopeStageManifest,
): string | null {
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  const evidence = [explicit(row.userId), explicit(metadata.userId)]
    .filter((value): value is string => value !== undefined);
  if (evidence.length === 0) return manifest.defaults.scope.userId;
  const mapped = evidence.map((value) => manifest.legacyUserAliases[value]);
  if (mapped.some((value) => value === undefined)) return null;
  return new Set(mapped).size === 1 ? mapped[0]! : null;
}

function longestRootProject(
  paths: readonly string[],
  manifest: OperatorScopeStageManifest,
): { projectId?: string; conflict: boolean; hasAbsolutePath: boolean } {
  const matches = new Set<string>();
  let hasAbsolutePath = false;
  for (const rawPath of paths) {
    if (!isAbsolute(rawPath)) continue;
    hasAbsolutePath = true;
    const candidate = normalize(rawPath);
    const roots = manifest.sourceRoots
      .map((item) => ({ ...item, root: normalize(item.root) }))
      .filter((item) => pathBelongsToRoot(candidate, item.root))
      .sort((left, right) => right.root.length - left.root.length);
    if (roots.length > 0) matches.add(roots[0]!.projectId);
    else matches.add("__unmapped__");
  }
  return {
    projectId: matches.size === 1 && !matches.has("__unmapped__")
      ? [...matches][0]
      : undefined,
    conflict: matches.size > 1 || matches.has("__unmapped__"),
    hasAbsolutePath,
  };
}

function resolveProject(
  table: OperatorScopeStageTable,
  row: OperatorScopeStageRow,
  metadata: Record<string, unknown>,
  manifest: OperatorScopeStageManifest,
): { projectId?: string; conflict: boolean } {
  const alias = explicit(row.projectName);
  const aliasProject = alias ? manifest.projectNameAliases[alias] : undefined;
  const workspacePath = explicit(row.workspaceId);
  const pathProject = longestRootProject([
    ...pathEvidence(metadata),
    ...(workspacePath ? [workspacePath] : []),
  ], manifest);
  if ((alias && !aliasProject) || pathProject.conflict ||
      (aliasProject && pathProject.projectId && aliasProject !== pathProject.projectId)) {
    return { conflict: true };
  }
  const projectId = aliasProject ?? pathProject.projectId ??
    (!alias && !pathProject.hasAbsolutePath ? manifest.tables[table].defaultProjectId : undefined);
  return { projectId, conflict: false };
}

function stripPlannerPaths(metadata: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...metadata };
  for (const field of PATH_FIELDS) {
    delete cleaned[field];
  }
  if (isRecord(cleaned.provenance)) {
    const provenance = { ...cleaned.provenance };
    for (const field of PATH_FIELDS) {
      delete provenance[field];
    }
    cleaned.provenance = provenance;
  }
  return cleaned;
}

function auditHash(
  table: OperatorScopeStageTable,
  row: OperatorScopeStageRow,
  manifestSha256: string,
  originalMetadataHash: string,
  originalContentHash: string,
  stagedContentHash: string,
  fields: OperatorScopeFields,
): string {
  return hash("operator-scope-stage-audit-v1", {
    table,
    id: row.id,
    originalContentHash,
    stagedContentHash,
    manifestSha256,
    originalMetadataHash,
    fields,
  });
}

function stagedFieldsFromMetadata(metadata: Record<string, unknown>): OperatorScopeFields {
  const names = [
    "tenantId", "userId", "appId", "agentId", "namespace",
    "visibility", "productId", "producerId", "projectId",
  ] as const;
  for (const name of names) {
    if (typeof metadata[name] !== "string" || !CANONICAL_VALUE.test(metadata[name])) {
      fail("INVALID_DATABASE_RESULT");
    }
  }
  if (!["private", "workspace", "team", "public"].includes(metadata.visibility as string)) {
    fail("INVALID_DATABASE_RESULT");
  }
  return {
    tenantId: metadata.tenantId as string,
    userId: metadata.userId as string,
    appId: metadata.appId as string,
    agentId: metadata.agentId as string,
    namespace: metadata.namespace as string,
    visibility: metadata.visibility as OperatorScopeFields["visibility"],
    productId: metadata.productId as string,
    producerId: metadata.producerId as string,
    projectId: metadata.projectId as string,
  };
}

function validatedExistingStage(
  table: OperatorScopeStageTable,
  row: OperatorScopeStageRow,
  metadata: Record<string, unknown>,
  manifestSha256: string,
): OperatorScopeStagePlan | undefined {
  if (metadata.operatorScopeStage === undefined) return undefined;
  const marker = metadata.operatorScopeStage;
  if (!isRecord(marker) || marker.version !== "operator-scope-stage-v1" ||
      marker.manifestSha256 !== manifestSha256 ||
      typeof marker.originalMetadataHash !== "string" ||
      !SHA256.test(marker.originalMetadataHash) ||
      typeof marker.originalContentHash !== "string" ||
      (marker.originalContentHash !== LEGACY_NULL_CONTENT_HASH &&
        !isSupportedLegacyContentHash(marker.originalContentHash)) ||
      typeof marker.stagedContentHash !== "string" ||
      !isSupportedLegacyContentHash(marker.stagedContentHash) ||
      typeof marker.auditHash !== "string" || !SHA256.test(marker.auditHash)) {
    fail("INVALID_DATABASE_RESULT");
  }
  const fields = stagedFieldsFromMetadata(metadata);
  const expectedAudit = auditHash(
    table,
    row,
    manifestSha256,
    marker.originalMetadataHash,
    marker.originalContentHash,
    marker.stagedContentHash,
    fields,
  );
  if (row.contentHash !== marker.stagedContentHash || marker.auditHash !== expectedAudit) {
    fail("INVALID_DATABASE_RESULT");
  }
  return {
    status: "already-staged",
    fields,
    repairedContentHash: marker.originalContentHash === LEGACY_NULL_CONTENT_HASH,
  };
}

export function planOperatorScopeRow(
  table: OperatorScopeStageTable,
  row: OperatorScopeStageRow,
  manifest: OperatorScopeStageManifest,
  manifestSha256: string,
): OperatorScopeStagePlan {
  if (!TABLES.includes(table) || !UUID.test(row.id) || typeof row.text !== "string" ||
      (row.contentHash !== null && !isSupportedLegacyContentHash(row.contentHash)) ||
      !isRecord(row.metadata) || !SHA256.test(manifestSha256)) {
    fail("INVALID_DATABASE_RESULT");
  }
  const currentMetadata = row.metadata;
  // Core backfill 会重写 legacy app_name/agent_id/workspace_id，并增加 nested
  // scope/producer。已有 operator marker 的身份真源是已签名 flat fields，必须在
  // 任何 legacy evidence 解析前验证并返回，避免 mutable columns 破坏幂等性。
  const existingStage = validatedExistingStage(
    table,
    row,
    currentMetadata,
    manifestSha256,
  );
  if (existingStage) return existingStage;
  const userId = resolveUser(row, manifest);
  if (!userId) return { status: "unmatched", reason: "unmapped-user" };
  const project = resolveProject(table, row, currentMetadata, manifest);
  if (project.conflict) return { status: "unmatched", reason: "conflicting-evidence" };
  if (!project.projectId) return { status: "unmatched", reason: "unmapped-project" };

  const tableDefaults = manifest.tables[table];
  const productEvidence = tableDefaults.productId === undefined
    ? explicit(row.appName) ?? explicit(currentMetadata.appName) ?? explicit(currentMetadata.productId)
    : tableDefaults.productId;
  const producerEvidence = tableDefaults.producerId === undefined
    ? explicit(row.agentId) ?? explicit(currentMetadata.agentName) ?? explicit(currentMetadata.producerId)
    : tableDefaults.producerId;
  const fields: OperatorScopeFields = {
    ...manifest.defaults.scope,
    namespace: tableDefaults.namespace,
    productId: productEvidence ?? manifest.defaults.producer.productId,
    producerId: producerEvidence ?? manifest.defaults.producer.producerId,
    projectId: project.projectId,
  };
  for (const value of Object.values(fields)) assertCanonical(value);
  const originalContentHash = row.contentHash ?? LEGACY_NULL_CONTENT_HASH;
  const stagedContentHash = row.contentHash ?? computeContentHash(row.text);

  const originalMetadataHash = hash("operator-scope-stage-original-metadata-v1", currentMetadata);
  const audit = auditHash(
    table, row, manifestSha256, originalMetadataHash,
    originalContentHash, stagedContentHash, fields,
  );
  const metadata = {
    ...stripPlannerPaths(currentMetadata),
    ...fields,
    operatorScopeStage: {
      version: "operator-scope-stage-v1" as const,
      manifestSha256,
      originalMetadataHash,
      originalContentHash,
      stagedContentHash,
      auditHash: audit,
    },
  };
  return {
    status: "staged",
    fields,
    repairedContentHash: row.contentHash === null,
    metadata,
  };
}

interface RawRow extends Record<string, unknown> {
  id: unknown;
  text: unknown;
  content_hash: unknown;
  metadata: unknown;
  project_name: unknown;
  app_name: unknown;
  user_id: unknown;
  agent_id: unknown;
  workspace_id: unknown;
}

function decodeRows(result: { rows: RawRow[]; rowCount?: number | null }): OperatorScopeStageRow[] {
  if (!Array.isArray(result.rows) || !Number.isInteger(result.rowCount) ||
      result.rowCount !== result.rows.length) fail("INVALID_DATABASE_RESULT");
  return result.rows.map((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || typeof row.text !== "string" ||
        (row.content_hash !== null && typeof row.content_hash !== "string") ||
        !isRecord(row.metadata)) fail("INVALID_DATABASE_RESULT");
    for (const field of ["project_name", "app_name", "user_id", "agent_id", "workspace_id"] as const) {
      if (row[field] !== null && typeof row[field] !== "string") fail("INVALID_DATABASE_RESULT");
    }
    return {
      id: row.id,
      text: row.text,
      contentHash: row.content_hash as string | null,
      metadata: row.metadata,
      projectName: row.project_name as string | null,
      appName: row.app_name as string | null,
      userId: row.user_id as string | null,
      agentId: row.agent_id as string | null,
      workspaceId: row.workspace_id as string | null,
    };
  });
}

function selectSql(table: OperatorScopeStageTable): string {
  return `SELECT id::text AS id, CASE WHEN content_hash IS NULL THEN text ELSE '' END AS text, content_hash, metadata, project_name, app_name, user_id, agent_id, workspace_id FROM "${table}" WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id ASC LIMIT $2`;
}

function bulkUpdateSql(table: OperatorScopeStageTable): string {
  return `UPDATE "${table}" AS target SET metadata = staged.new_metadata, content_hash = staged.new_content_hash FROM jsonb_to_recordset($1::jsonb) AS staged(id uuid, old_content_hash text, new_content_hash text, old_metadata jsonb, new_metadata jsonb) WHERE target.id = staged.id AND target.content_hash IS NOT DISTINCT FROM staged.old_content_hash AND target.metadata IS NOT DISTINCT FROM staged.old_metadata RETURNING target.id::text AS id`;
}

function assertApplyGate(
  manifestSha256: string,
  options: RunOperatorScopeStageOptions,
): void {
  if (options.mode !== "apply") return;
  if (options.maintenance !== true || options.quiescenceConfirmed !== true ||
      options.confirmationToken !== OPERATOR_SCOPE_STAGE_APPLY_TOKEN) {
    fail("APPLY_GATE_REQUIRED");
  }
  if (options.expectedManifestSha256 !== manifestSha256) {
    fail("MANIFEST_SHA_MISMATCH");
  }
}

export async function runOperatorScopeStage(
  client: OperatorScopeStageClient,
  manifest: OperatorScopeStageManifest,
  manifestSha256: string,
  options: RunOperatorScopeStageOptions = {},
): Promise<OperatorScopeStageResult> {
  const mode = options.mode ?? "dry-run";
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  if ((mode !== "dry-run" && mode !== "apply") || !Number.isInteger(batchSize) ||
      batchSize < 1 || batchSize > 10_000 || !SHA256.test(manifestSha256)) {
    fail("INVALID_ARGUMENTS");
  }
  assertApplyGate(manifestSha256, { ...options, mode });
  const tableResults: OperatorScopeStageTableResult[] = [];

  try {
    for (const table of TABLES) {
      const stats = {
        table, scanned: 0, staged: 0, unmatched: 0, alreadyStaged: 0,
        updated: 0, repairedContentHashes: 0,
      };
      let cursor: string | null = null;
      while (true) {
        const result = await client.query<RawRow>(selectSql(table), [cursor, batchSize]);
        const rows = decodeRows(result);
        if (rows.length === 0) break;
        if (rows.some((item, index) => item.id <= (index === 0 ? cursor ?? "" : rows[index - 1]!.id))) {
          fail("INVALID_DATABASE_RESULT");
        }
        if (mode === "apply") await client.query("BEGIN");
        try {
          const pendingUpdates: Array<{
            id: string;
            old_content_hash: string | null;
            new_content_hash: string;
            old_metadata: Record<string, unknown>;
            new_metadata: Record<string, unknown>;
          }> = [];
          for (const row of rows) {
            stats.scanned += 1;
            const plan = planOperatorScopeRow(table, row, manifest, manifestSha256);
            if (plan.status === "unmatched") {
              stats.unmatched += 1;
            } else if (plan.status === "already-staged") {
              stats.alreadyStaged += 1;
            } else {
              stats.staged += 1;
              if (plan.repairedContentHash) stats.repairedContentHashes += 1;
              if (mode === "apply") {
                pendingUpdates.push({
                  id: row.id,
                  old_content_hash: row.contentHash,
                  new_content_hash: plan.metadata.operatorScopeStage.stagedContentHash,
                  old_metadata: row.metadata as Record<string, unknown>,
                  new_metadata: plan.metadata,
                });
              }
            }
          }
          if (mode === "apply" && pendingUpdates.length > 0) {
            const updated = await client.query<{ id: unknown }>(bulkUpdateSql(table), [
              JSON.stringify(pendingUpdates),
            ]);
            const expectedIds = new Set(pendingUpdates.map((item) => item.id));
            const actualIds = new Set(updated.rows.map((item) => item.id));
            if (updated.rowCount !== pendingUpdates.length ||
                updated.rows.length !== pendingUpdates.length ||
                actualIds.size !== expectedIds.size ||
                [...actualIds].some((id) => typeof id !== "string" || !expectedIds.has(id))) {
              fail("CONCURRENT_ROW_DRIFT");
            }
            stats.updated += pendingUpdates.length;
          }
          if (mode === "apply") await client.query("COMMIT");
        } catch (error) {
          if (mode === "apply") {
            try { await client.query("ROLLBACK"); } catch { /* fixed outer error */ }
          }
          throw error;
        }
        cursor = rows.at(-1)!.id;
      }
      tableResults.push(stats);
    }
  } catch (error) {
    if (error instanceof OperatorScopeStageError) throw error;
    fail("DATABASE_OPERATION_FAILED");
  }
  const sum = (field: keyof Omit<OperatorScopeStageTableResult, "table">): number =>
    tableResults.reduce((total, item) => total + item[field], 0);
  return {
    mode,
    manifestSha256,
    scanned: sum("scanned"),
    staged: sum("staged"),
    unmatched: sum("unmatched"),
    alreadyStaged: sum("alreadyStaged"),
    updated: sum("updated"),
    repairedContentHashes: sum("repairedContentHashes"),
    tables: tableResults,
  };
}

/** DB staging 成功后才发布 registry；失败时 outputPath 完全不触碰。 */
export async function runOperatorScopeStageAndPublish(
  client: OperatorScopeStageClient,
  manifest: OperatorScopeStageManifest,
  manifestSha256: string,
  options: RunOperatorScopeStageOptions = {},
  registryOutput?: string,
): Promise<OperatorScopeStageResult> {
  const mode = options.mode ?? "dry-run";
  if (registryOutput && mode !== "apply") fail("INVALID_ARGUMENTS");
  const result = await runOperatorScopeStage(client, manifest, manifestSha256, options);
  if (registryOutput) writeOperatorScopeRegistry(manifest, registryOutput);
  return result;
}

function normalizeAlias(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/[\s_]+/g, "-").replace(/-+/g, "-");
}

/** 从同一 manifest 确定性生成 cutover planner 可直接读取的 registry v2。 */
export function registryFromOperatorScopeManifest(
  manifest: OperatorScopeStageManifest,
): MemoryAutodbRegistry {
  const rootsByProject = new Map<string, string>();
  for (const item of manifest.sourceRoots) {
    const root = normalize(item.root);
    const previous = rootsByProject.get(item.projectId);
    if (previous && previous !== root) fail("INVALID_MANIFEST");
    rootsByProject.set(item.projectId, root);
  }
  const aliasesByProject = new Map<string, Set<string>>();
  for (const [alias, projectId] of Object.entries(manifest.projectNameAliases)) {
    const aliases = aliasesByProject.get(projectId) ?? new Set<string>();
    aliases.add(alias);
    aliasesByProject.set(projectId, aliases);
  }
  const projectIds = new Set([
    ...Object.values(manifest.projectNameAliases),
    ...manifest.sourceRoots.map((item) => item.projectId),
    ...TABLES.flatMap((table) => manifest.tables[table].defaultProjectId
      ? [manifest.tables[table].defaultProjectId!] : []),
  ]);
  const projects: MemoryAutodbRegistry["projects"] = {};
  const workspaces: MemoryAutodbRegistry["workspaces"] = {};
  for (const projectId of [...projectIds].sort()) {
    const explicitEntry = manifest.registryProjects?.[projectId];
    const workspaceId = explicitEntry?.workspaceId ?? projectId;
    const root = rootsByProject.get(projectId);
    const aliasValues = new Set([
      ...(aliasesByProject.get(projectId) ?? []),
      ...(explicitEntry?.aliases ?? []),
    ]);
    const aliases: RegistryProjectAlias[] = [...aliasValues].sort().map((value) => ({
      value,
      normalized: normalizeAlias(value),
      source: "explicit",
    }));
    projects[projectId] = {
      workspaceId,
      displayName: explicitEntry?.displayName,
      manifestPath: explicitEntry?.manifestPath ?? `~/.mengshu/projects/${projectId}/manifest.json`,
      lastSeenRoot: root,
      canonicalRoot: root,
      aliases: aliases.length > 0 ? aliases : undefined,
    };
    const ids = workspaces[workspaceId]?.projectIds ?? [];
    workspaces[workspaceId] = { projectIds: [...ids, projectId].sort() };
  }
  return { version: REGISTRY_VERSION, projects, workspaces };
}

/** 原子写 registry；调用方必须显式给出路径，避免默认覆盖本机状态。 */
export function writeOperatorScopeRegistry(
  manifest: OperatorScopeStageManifest,
  outputPath: string,
): void {
  if (!isAbsolute(outputPath)) fail("INVALID_ARGUMENTS");
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
    const tmp = `${outputPath}.${process.pid}.tmp`;
    writeFileSync(tmp, serializeRegistry(registryFromOperatorScopeManifest(manifest)), "utf8");
    renameSync(tmp, outputPath);
  } catch {
    fail("REGISTRY_WRITE_FAILED");
  }
}

interface CliArgs {
  configPath: string;
  manifestPath: string;
  mode: OperatorScopeStageMode;
  maintenance: boolean;
  quiescenceConfirmed: boolean;
  confirmationToken?: string;
  expectedManifestSha256?: string;
  registryOutput?: string;
}

function cliArgs(argv: readonly string[]): CliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const configPath = value("--config");
  const manifestPath = value("--manifest");
  if (!configPath || !manifestPath) fail("INVALID_ARGUMENTS");
  return {
    configPath: resolve(configPath),
    manifestPath: resolve(manifestPath),
    mode: argv.includes("--apply") ? "apply" : "dry-run",
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    confirmationToken: value("--confirmation-token"),
    expectedManifestSha256: value("--manifest-sha256"),
    registryOutput: value("--registry-output"),
  };
}

export async function runOperatorScopeStageCli(argv: readonly string[]): Promise<OperatorScopeStageResult> {
  const args = cliArgs(argv);
  let postgresConfig: OperatorPostgresConfig;
  let loaded: ReturnType<typeof loadOperatorScopeManifest>;
  try {
    postgresConfig = parseOperatorPostgresConfig(readFileSync(args.configPath, "utf8"));
    loaded = loadOperatorScopeManifest(readFileSync(args.manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof OperatorScopeStageError) throw error;
    fail("INVALID_CONFIG");
  }
  assertApplyGate(loaded.sha256, {
    mode: args.mode,
    maintenance: args.maintenance,
    quiescenceConfirmed: args.quiescenceConfirmed,
    confirmationToken: args.confirmationToken,
    expectedManifestSha256: args.expectedManifestSha256,
  });
  // registry 是 cutover 的 authority 输入，不能由只读预览发布，更不能先于 DB
  // staging 成功落盘。apply 成功后才执行下方原子发布。
  if (args.registryOutput && args.mode !== "apply") fail("INVALID_ARGUMENTS");
  const pool = new pg.Pool({ ...postgresConfig, max: 1 });
  let client: pg.PoolClient | undefined;
  let result: OperatorScopeStageResult;
  try {
    client = await pool.connect();
    result = await runOperatorScopeStageAndPublish(client, loaded.manifest, loaded.sha256, {
      mode: args.mode,
      maintenance: args.maintenance,
      quiescenceConfirmed: args.quiescenceConfirmed,
      confirmationToken: args.confirmationToken,
      expectedManifestSha256: args.expectedManifestSha256,
    }, args.registryOutput ? resolve(args.registryOutput) : undefined);
  } finally {
    client?.release();
    await pool.end().catch(() => undefined);
  }
  return result;
}

export interface OperatorScopeCliTerminationPort {
  readonly write: (payload: string, completed: () => void) => void;
  readonly exit: (code: number) => void;
}

/** 先等待单行 JSON 完整写出，再显式终止 standalone operator 进程。 */
export function terminateOperatorScopeStageCli(
  payload: unknown,
  code: 0 | 1,
  port: OperatorScopeCliTerminationPort,
): void {
  port.write(`${JSON.stringify(payload)}\n`, () => port.exit(code));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorScopeStageCli(process.argv.slice(2))
    .then((result) => terminateOperatorScopeStageCli(result, 0, {
      write: (payload, completed) => process.stdout.write(payload, completed),
      exit: (code) => process.exit(code),
    }))
    .catch((error) => {
      const safe = error instanceof OperatorScopeStageError
        ? { code: error.code, message: error.message }
        : { code: "DATABASE_OPERATION_FAILED", message: ERROR_MESSAGES.DATABASE_OPERATION_FAILED };
      terminateOperatorScopeStageCli(safe, 1, {
        write: (payload, completed) => process.stderr.write(payload, completed),
        exit: (code) => process.exit(code),
      });
    });
}
