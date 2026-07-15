import { randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { isAbsolute, join, parse, resolve, sep } from "node:path";
import type * as LanceDB from "@lancedb/lancedb";
import type {
  DataType,
  DatabaseProvider,
  DatabaseStoreResult,
  MemoryEntry,
  MemoryQueryOptions,
  TableName,
  TableStats,
  KnowledgeBaseConfig,
} from "../types.js";
import {
  DatabaseStoreCleanupError,
  parseDatabaseStoreResult,
} from "../types.js";
import { vectorDimsForModel } from "../../../../../config.js";
import { assertSafeLegacyDeleteFilter } from "./legacy-delete-filter-guard.js";

/**
 * Scope 维度列（D-25 / T3）的 sentinel 值。
 *
 * LanceDB Node SDK 通过种子记录推断 Arrow schema，nullable Utf8 列使用空串
 * 作为 sentinel（与 `metadata: ""` 一致）。写入时把 undefined/null 归一成 ""，
 * 读回时再把 "" 还原成 undefined，保持 MemoryEntry 上层语义。
 */
const SCOPE_NULL_SENTINEL = "";

const escapeSqlString = (value: string): string => value.replace(/'/g, "''");

// Lance SQL expression builder has no parameter API. Authority identifiers are
// therefore constrained to the same conservative identifier alphabet used by
// server authority, then escaped again before interpolation (defence in depth).
const SAFE_AUTHORITY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
const SAFE_METADATA_FILTER_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SAFE_KNOWLEDGE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const DATA_TYPES = new Set<DataType>(["memory", "document", "knowledge"]);
const CANONICAL_STORE_SCOPE_FIELDS = [
  "tenantId",
  "userId",
  "canonicalProjectId",
  "productId",
  "producerId",
  "namespace",
  "visibility",
] as const satisfies readonly (keyof MemoryEntry)[];

function validateCanonicalStoreScope(entry: MemoryEntry): void {
  for (const field of CANONICAL_STORE_SCOPE_FIELDS) {
    const value = entry[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`LanceDB new write requires canonical scope field: ${field}`);
    }
  }
}

function assertSafeMetadataFilterKey(key: string): void {
  if (!SAFE_METADATA_FILTER_KEY.test(key) ||
      key === "__proto__" || key === "prototype" || key === "constructor") {
    throw new Error("LanceDB metadata filter key is unsafe");
  }
}

function validateAuthorityOptions(options: MemoryQueryOptions): void {
  const hasTenant = options.tenantId !== undefined;
  const hasUser = options.userId !== undefined;
  if (hasTenant !== hasUser) {
    throw new Error("LanceDB recall tenant/user authority must be provided together");
  }
  if (hasTenant &&
      (!SAFE_AUTHORITY_IDENTIFIER.test(options.tenantId!) ||
       !SAFE_AUTHORITY_IDENTIFIER.test(options.userId!))) {
    throw new Error("LanceDB recall authority identifier is invalid");
  }
}

function validateDataTypes(dataTypes: unknown): asserts dataTypes is DataType[] | undefined {
  if (dataTypes === undefined) return;
  if (!Array.isArray(dataTypes) || dataTypes.some((value) => !DATA_TYPES.has(value as DataType))) {
    throw new Error("LanceDB dataTypes contains an unsupported value");
  }
}

function dataTypeFilterExpression(dataType: DataType): string {
  switch (dataType) {
    case "memory":
      return "dataType = 'memory'";
    case "document":
      return "dataType = 'document'";
    case "knowledge":
      return "dataType = 'knowledge'";
  }
}

const normalizeScopeValue = (value: string | null | undefined): string => {
  if (typeof value !== "string") return SCOPE_NULL_SENTINEL;
  return value;
};

const denormalizeScopeValue = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value === SCOPE_NULL_SENTINEL) return undefined;
  return value;
};

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null = null;
const loadLanceDB = async (): Promise<typeof import("@lancedb/lancedb")> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    // Common on macOS today: upstream package may not ship darwin native bindings.
    throw new Error(`mengshu: failed to load LanceDB. ${String(err)}`, { cause: err });
  }
};

const DEFAULT_TABLES: readonly TableName[] = ["memories", "knowledge"];
const WRITE_LOCK_FILENAME = ".mengshu-write.lock";
const RECOVERY_GUARD_FILENAME = ".mengshu-write-recovery.guard";
const MAX_LOCK_OWNER_BYTES = 4_096;
const SAFE_LOCK_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LanceDBProviderOptions {
  writeLockTimeoutMs?: number;
  writeLockRetryMs?: number;
  /** Compatibility knob only; automatic stale-owner removal is disabled. */
  writeLockStaleMs?: number;
}

export interface LanceDBWriteLockInspection {
  status: "unlocked" | "locked-valid" | "locked-invalid" | "recovery-blocked";
  recoveryGuardStatus: "absent" | "valid" | "invalid";
  onlineSafe: false;
  requiredPrecondition: "global-quiescence";
  token?: string;
  ownerPid?: number;
  ownerDefinitelyDead?: boolean;
}

export interface LanceDBWriteLockRecoveryInput {
  confirmQuiescent: true;
  expectedToken: string;
}

export interface LanceDBWriteLockRecoveryResult {
  recovered: true;
  token: string;
  onlineSafe: false;
  requiredPrecondition: "global-quiescence-confirmed";
}

interface ResolvedWriteLockOptions {
  timeoutMs: number;
  retryMs: number;
  staleMs: number;
}

interface WriteLockOwner {
  version: 1;
  token: string;
  pid: number;
  createdMonotonicNs: string;
  processStartMonotonicNs: string;
}

interface WriteLockHandle {
  release(): Promise<void>;
}

interface FileIdentity {
  dev: number;
  ino: number;
}

const DEFAULT_WRITE_LOCK_OPTIONS: ResolvedWriteLockOptions = {
  timeoutMs: 5_000,
  retryMs: 25,
  staleMs: 30_000,
};

function resolveWriteLockOptions(options?: LanceDBProviderOptions): ResolvedWriteLockOptions {
  const timeoutMs = options?.writeLockTimeoutMs ?? DEFAULT_WRITE_LOCK_OPTIONS.timeoutMs;
  const retryMs = options?.writeLockRetryMs ?? DEFAULT_WRITE_LOCK_OPTIONS.retryMs;
  const staleMs = options?.writeLockStaleMs ?? DEFAULT_WRITE_LOCK_OPTIONS.staleMs;
  for (const [name, value] of Object.entries({ timeoutMs, retryMs, staleMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`LanceDB ${name} must be a positive safe integer`);
    }
  }
  if (retryMs > timeoutMs) {
    throw new Error("LanceDB write lock retry interval cannot exceed timeout");
  }
  return { timeoutMs, retryMs, staleMs };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

const delay = async (milliseconds: number): Promise<void> => {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
};

const PROCESS_START_MONOTONIC_NS = process.hrtime.bigint() -
  BigInt(Math.max(0, Math.floor(process.uptime() * 1_000_000_000)));

function assertSupportedLockPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("LanceDB write locking requires a supported POSIX platform");
  }
  if (typeof process.getuid !== "function" ||
      !Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) {
    throw new Error("LanceDB write locking requires getuid and O_NOFOLLOW");
  }
}

/**
 * Freeze a filesystem identity at construction time. Existing symlink ancestors
 * are resolved immediately (for example macOS /tmp -> /private/tmp); a missing
 * suffix is appended to that real ancestor and later created one component at a
 * time without following newly injected symlinks.
 */
function canonicalizeDatabasePath(input: string): string {
  const absolutePath = resolve(input);
  const { root } = parse(absolutePath);
  const parts = absolutePath.slice(root.length).split(sep).filter(Boolean);
  let current = realpathSync(root);

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = join(current, parts[index]!);
    try {
      const stats = lstatSync(candidate);
      current = stats.isSymbolicLink() ? realpathSync(candidate) : candidate;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw new Error("LanceDB database path cannot be canonicalized");
      }
      return join(current, ...parts.slice(index));
    }
  }
  return realpathSync(current);
}

export class LanceDBPartialStoreError extends Error {
  constructor(readonly receipt: DatabaseStoreResult) {
    super("LanceDB store partially completed");
    this.name = "LanceDBPartialStoreError";
  }
}

export class LanceDBStoreCleanupError extends DatabaseStoreCleanupError {
  constructor(
    receipt: DatabaseStoreResult,
    operationStatus: "completed" | "partial",
  ) {
    super(receipt, operationStatus);
    this.name = "LanceDBStoreCleanupError";
    this.message = operationStatus === "completed"
      ? "LanceDB store completed but write lock cleanup failed"
      : "LanceDB store partially completed and write lock cleanup failed";
  }
}

interface PreparedStoreEntry {
  requestedId: string;
  tableName: TableName;
  dedupeKey: string;
  row: Record<string, unknown>;
}

interface StoreResolution {
  persistedId: string;
  source: "existing" | "planned";
  ownerIndex?: number;
}

/**
 * LanceDB 数据库提供者实现。
 *
 * Scope 维度列（D-25 / T3）支持：
 * - legacy scope 与 canonical authority scope 均以独立 Utf8 列存储，替代
 *   「全部塞 metadata.*」的旧路径；tenant_id/user_id 用于 recall 铁隔离。
 * - 写入时把 MemoryEntry 上的 scope 字段映射为列；undefined/null 走
 *   SCOPE_NULL_SENTINEL（空串）保持 schema 兼容。
 * - 读回时通过 denormalizeScopeValue 把空串还原成 undefined。
 * - query 方法先按 tenant/user authority 精确过滤，再支持 projectName/appName
 *   精确过滤与 projectPattern LIKE 相似检索。
 */
export class LanceDBProvider implements DatabaseProvider {
  private db: LanceDB.Connection | null = null;
  private tables: Map<TableName, LanceDB.Table> = new Map();
  private initPromise: Promise<void> | null = null;
  private initialized = false;
  private initializationFailed = false;
  private storeTail: Promise<void> = Promise.resolve();
  private extendedTables: TableName[] = [];
  private readonly allowedTables = new Set<TableName>(DEFAULT_TABLES);
  private readonly writeLockOptions: ResolvedWriteLockOptions;
  private readonly resolvedDbPath: string;
  private databaseIdentity: FileIdentity | undefined;

  constructor(
    dbPath: string,
    private readonly embeddingModel: string,
    private readonly knowledgeBases?: KnowledgeBaseConfig,
    writeLockOptions?: LanceDBProviderOptions,
  ) {
    assertSupportedLockPlatform();
    if (dbPath.includes("\0")) {
      throw new Error("LanceDB database path is invalid");
    }
    this.resolvedDbPath = canonicalizeDatabasePath(dbPath);
    try {
      const stats = lstatSync(this.resolvedDbPath);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        this.databaseIdentity = { dev: stats.dev, ino: stats.ino };
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw new Error("LanceDB database path identity cannot be captured");
      }
    }
    this.writeLockOptions = resolveWriteLockOptions(writeLockOptions);
    if (!knowledgeBases?.enabled) return;

    const builtinCategories = knowledgeBases.builtinCategories;
    const customCategories = knowledgeBases.customCategories;
    if ((builtinCategories !== undefined && !Array.isArray(builtinCategories)) ||
        (customCategories !== undefined && !Array.isArray(customCategories))) {
      throw new Error("LanceDB knowledge-base categories must be arrays");
    }

    const categories = [...(builtinCategories ?? []), ...(customCategories ?? [])];
    for (const category of categories) {
      if (typeof category !== "string" || !SAFE_KNOWLEDGE_CATEGORY.test(category)) {
        throw new Error("LanceDB configured knowledge-base category is invalid");
      }
      const tableName = `knowledge_${category}` as TableName;
      this.allowedTables.add(tableName);
    }
    this.extendedTables = Array.from(this.allowedTables).filter(
      (tableName) => !DEFAULT_TABLES.includes(tableName),
    );
  }

  private assertAllowedTableName(value: unknown, field = "tableName"): asserts value is TableName {
    if (typeof value !== "string" || !this.allowedTables.has(value as TableName)) {
      throw new Error(`LanceDB ${field} is not configured`);
    }
  }

  private validateQueryOptions(options: MemoryQueryOptions): void {
    validateAuthorityOptions(options);
    validateDataTypes(options.dataTypes);
    if (options.tableName !== undefined) {
      this.assertAllowedTableName(options.tableName);
    }
  }

  /**
   * 构造表的 schema 种子记录。
   *
   * LanceDB 通过首条记录推断 Arrow schema，所以这里同时声明所有 scope 维度列；
   * 创建后立即 `delete('id = "__schema__"')` 把它清掉，正式数据从空表写入。
   */
  private buildSchemaSeed(vectorDim: number, dataType: "memory" | "knowledge"): Record<string, unknown> {
    return {
      id: "__schema__",
      text: "",
      contentHash: "",
      vector: Array.from({ length: vectorDim }).fill(0),
      importance: 0,
      category: "other",
      dataType,
      // 使用空字符串而非空对象，让 LanceDB 推断为字符串类型
      metadata: "",
      createdAt: 0,
      // Scope 维度列（D-25 / T3）：使用 sentinel 让 LanceDB 推断为 Utf8。
      project_name: SCOPE_NULL_SENTINEL,
      app_name: SCOPE_NULL_SENTINEL,
      user_id: SCOPE_NULL_SENTINEL,
      agent_id: SCOPE_NULL_SENTINEL,
      workspace_id: SCOPE_NULL_SENTINEL,
      tenant_id: SCOPE_NULL_SENTINEL,
      canonical_project_id: SCOPE_NULL_SENTINEL,
      product_id: SCOPE_NULL_SENTINEL,
      producer_id: SCOPE_NULL_SENTINEL,
      namespace: SCOPE_NULL_SENTINEL,
      visibility: SCOPE_NULL_SENTINEL,
      lifecycle_status: SCOPE_NULL_SENTINEL,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.withWriteLock(async () => {
      // Another instance operation may have initialized this provider while
      // this public initialize call was queued on the cross-process lock.
      if (this.initialized) return;
      await this.initializeUnderWriteLock();
    })
      .finally(() => {
        this.initPromise = null;
      });
    return this.initPromise;
  }

  private async initializeUnderWriteLock(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.doInitialize();
      this.initialized = true;
      this.initializationFailed = false;
    } catch (error) {
      this.resetOpenState();
      this.initializationFailed = true;
      throw error;
    }
  }

  private async doInitialize(): Promise<void> {
    this.resetOpenState();
    await this.assertCanonicalDatabaseIdentity();
    const lancedb = await loadLanceDB();
    const vectorDim = vectorDimsForModel(this.embeddingModel);

    const connection = await lancedb.connect(this.resolvedDbPath);
    this.db = connection;
    const openedTables = new Map<TableName, LanceDB.Table>();
    const existingTables = await this.withDatabaseIdentityCheck(async () =>
      connection.tableNames());

    try {
      // initialize 是显式 schema operator；允许创建默认表。
      for (const tableName of DEFAULT_TABLES) {
        if (existingTables.includes(tableName)) {
          const table = await this.withDatabaseIdentityCheck(async () =>
            connection.openTable(tableName));
          openedTables.set(tableName, table);
          await this.withDatabaseIdentityCheck(async () => table.delete('id = "__schema__"'));
        } else {
          const table = await this.withDatabaseIdentityCheck(async () =>
            connection.createTable(
              tableName,
              [this.buildSchemaSeed(vectorDim, "memory")],
            ));
          openedTables.set(tableName, table);
          await this.withDatabaseIdentityCheck(async () => table.delete('id = "__schema__"'));
        }
      }

      // 配置过的扩展表始终可以打开；只有 autoCreateTables 明确开启时才在初始化阶段创建。
      if (this.knowledgeBases?.enabled) {
        for (const tableName of this.extendedTables) {
          if (existingTables.includes(tableName)) {
            const table = await this.withDatabaseIdentityCheck(async () =>
              connection.openTable(tableName));
            openedTables.set(tableName, table);
            await this.withDatabaseIdentityCheck(async () => table.delete('id = "__schema__"'));
          } else if (this.knowledgeBases.autoCreateTables) {
            const table = await this.withDatabaseIdentityCheck(async () =>
              connection.createTable(
                tableName,
                [this.buildSchemaSeed(vectorDim, "knowledge")],
              ));
            openedTables.set(tableName, table);
            await this.withDatabaseIdentityCheck(async () => table.delete('id = "__schema__"'));
          }
        }
      }
      await this.assertCanonicalDatabaseIdentity();
      this.tables = openedTables;
    } catch (error) {
      for (const table of openedTables.values()) {
        table.close();
      }
      connection.close();
      this.db = null;
      throw error;
    }
  }

  async close(): Promise<void> {
    this.resetOpenState();
    this.initPromise = null;
    this.initialized = false;
    this.initializationFailed = false;
  }

  async inspectWriteLock(): Promise<LanceDBWriteLockInspection> {
    await this.ensureSafeDatabaseDirectory();
    const guardPath = join(this.resolvedDbPath, RECOVERY_GUARD_FILENAME);
    try {
      const guardOwner = await this.readLockOwner(guardPath);
      return {
        status: "recovery-blocked",
        recoveryGuardStatus: guardOwner ? "valid" : "invalid",
        onlineSafe: false,
        requiredPrecondition: "global-quiescence",
        ...(guardOwner ? {
          token: guardOwner.token,
          ownerPid: guardOwner.pid,
          ownerDefinitelyDead: this.isOwnerDefinitelyDead(guardOwner),
        } : {}),
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        return {
          status: "recovery-blocked",
          recoveryGuardStatus: "invalid",
          onlineSafe: false,
          requiredPrecondition: "global-quiescence",
        };
      }
    }

    const lockPath = join(this.resolvedDbPath, WRITE_LOCK_FILENAME);
    let owner: WriteLockOwner | undefined;
    try {
      owner = await this.readLockOwner(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return {
          status: "unlocked",
          recoveryGuardStatus: "absent",
          onlineSafe: false,
          requiredPrecondition: "global-quiescence",
        };
      }
      return {
        status: "locked-invalid",
        recoveryGuardStatus: "absent",
        onlineSafe: false,
        requiredPrecondition: "global-quiescence",
      };
    }
    if (!owner) {
      return {
        status: "locked-invalid",
        recoveryGuardStatus: "absent",
        onlineSafe: false,
        requiredPrecondition: "global-quiescence",
      };
    }
    return {
      status: "locked-valid",
      recoveryGuardStatus: "absent",
      onlineSafe: false,
      requiredPrecondition: "global-quiescence",
      token: owner.token,
      ownerPid: owner.pid,
      ownerDefinitelyDead: this.isOwnerDefinitelyDead(owner),
    };
  }

  async recoverWriteLock(
    input: LanceDBWriteLockRecoveryInput,
  ): Promise<LanceDBWriteLockRecoveryResult> {
    if (input?.confirmQuiescent !== true) {
      throw new Error("LanceDB lock recovery requires confirmed global quiescence");
    }
    if (typeof input.expectedToken !== "string" || !SAFE_LOCK_TOKEN.test(input.expectedToken)) {
      throw new Error("LanceDB lock recovery expected token is invalid");
    }
    await this.ensureSafeDatabaseDirectory();
    const guard = await this.acquireRecoveryGuard();
    try {
      await this.assertCanonicalDatabaseIdentity();
      const lockPath = join(this.resolvedDbPath, WRITE_LOCK_FILENAME);
      const owner = await this.readLockOwner(lockPath).catch((error) => {
        if (isNodeError(error, "ENOENT")) {
          throw new Error("LanceDB lock recovery target is absent");
        }
        throw new Error("LanceDB lock recovery owner metadata is invalid");
      });
      if (!owner) {
        throw new Error("LanceDB lock recovery owner metadata is invalid");
      }
      if (owner.token !== input.expectedToken) {
        throw new Error("LanceDB lock recovery token mismatch");
      }
      if (!this.isOwnerDefinitelyDead(owner)) {
        throw new Error("LanceDB lock recovery owner death is not proven");
      }
      // Re-read immediately before removal. This operation is explicitly not
      // online-safe: confirmQuiescent is a caller-enforced global stop-the-world
      // precondition because Node has no inode-conditional rename primitive.
      const current = await this.readLockOwner(lockPath);
      if (!current || current.token !== owner.token || current.pid !== owner.pid) {
        throw new Error("LanceDB lock recovery owner changed");
      }
      if (!await this.removeOwnedLockFile(lockPath, owner.token, owner.pid)) {
        throw new Error("LanceDB lock recovery cleanup failed");
      }
      return {
        recovered: true,
        token: owner.token,
        onlineSafe: false,
        requiredPrecondition: "global-quiescence-confirmed",
      };
    } finally {
      await guard.release();
    }
  }

  private resetOpenState(): void {
    for (const table of this.tables.values()) {
      table.close();
    }
    this.tables.clear();
    this.db?.close();
    this.db = null;
    this.initialized = false;
  }

  private async getConnection(): Promise<LanceDB.Connection> {
    if (this.initializationFailed) {
      throw new Error("LanceDB initialization failed; explicit retry required");
    }
    await this.ensureSafeDatabaseDirectory();
    if (this.db?.isOpen()) {
      await this.assertCanonicalDatabaseIdentity();
      return this.db;
    }
    const lancedb = await loadLanceDB();
    this.db = await lancedb.connect(this.resolvedDbPath);
    await this.assertCanonicalDatabaseIdentity();
    return this.db;
  }

  /**
   * 获取默认表名（根据 dataType 决定）
   */
  private getDefaultTableName(dataType?: DataType): TableName {
    switch (dataType) {
      case "knowledge":
        return "knowledge";
      case "document":
        return "knowledge";
      case "memory":
      default:
        return "memories";
    }
  }

  private async getExistingTable(tableName: TableName): Promise<LanceDB.Table> {
    this.assertAllowedTableName(tableName);
    await this.ensureSafeDatabaseDirectory();
    const cached = this.tables.get(tableName);
    if (cached) {
      const isOpen = (cached as LanceDB.Table & { isOpen?: () => boolean }).isOpen;
      if (typeof isOpen !== "function" || isOpen.call(cached)) {
        await this.assertCanonicalDatabaseIdentity();
        return cached;
      }
    }

    const connection = await this.getConnection();
    const existingTables = await this.withDatabaseIdentityCheck(async () =>
      connection.tableNames());
    if (!existingTables.includes(tableName)) {
      throw new Error("LanceDB configured table is unavailable");
    }
    const table = await this.withDatabaseIdentityCheck(async () =>
      connection.openTable(tableName));
    this.tables.set(tableName, table);
    return table;
  }

  private async listExistingAllowedTables(): Promise<TableName[]> {
    const connection = await this.getConnection();
    const existingTables = new Set(await this.withDatabaseIdentityCheck(async () =>
      connection.tableNames()));
    return Array.from(this.allowedTables).filter((tableName) => existingTables.has(tableName));
  }

  private async createConfiguredTableUnderWriteLock(tableName: TableName): Promise<LanceDB.Table> {
    this.assertAllowedTableName(tableName);
    await this.assertCanonicalDatabaseIdentity();
    await this.initializeUnderWriteLock();
    const existing = this.tables.get(tableName);
    if (existing) return existing;

    const vectorDim = vectorDimsForModel(this.embeddingModel);
    const dataType = tableName === "memories" ? "memory" : "knowledge";
    const table = await this.withDatabaseIdentityCheck(async () =>
      this.db!.createTable(tableName, [this.buildSchemaSeed(vectorDim, dataType)]));
    try {
      await this.withDatabaseIdentityCheck(async () => table.delete('id = "__schema__"'));
    } catch (error) {
      table.close();
      throw error;
    }
    this.tables.set(tableName, table);
    await this.assertCanonicalDatabaseIdentity();
    return table;
  }

  async store(entries: MemoryEntry[]): Promise<DatabaseStoreResult> {
    // 全部不可信 runtime 字段必须在排队、连接或 schema side effect 前完成校验。
    for (const entry of entries) {
      validateDataTypes([entry.dataType]);
      const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
      this.assertAllowedTableName(tableName);
      validateCanonicalStoreScope(entry);
    }

    const prepared = entries.map((entry) => this.prepareStoreEntry(entry));
    const operation = this.storeTail.then(() => this.storePreparedEntries(prepared));
    this.storeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private prepareStoreEntry(entry: MemoryEntry): PreparedStoreEntry {
    const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
    const requestedId = entry.id || randomUUID();
    const tenantId = normalizeScopeValue(entry.tenantId);
    const userId = normalizeScopeValue(entry.userId);
    const canonicalProjectId = normalizeScopeValue(entry.canonicalProjectId);
    const productId = normalizeScopeValue(entry.productId);
    const producerId = normalizeScopeValue(entry.producerId);
    const namespace = normalizeScopeValue(entry.namespace);
    const visibility = normalizeScopeValue(entry.visibility);
    const {
      tableName: _tableName,
      projectName,
      appName,
      userId: _userId,
      agentId,
      workspaceId,
      tenantId: _tenantId,
      canonicalProjectId: _canonicalProjectId,
      productId: _productId,
      producerId: _producerId,
      namespace: _namespace,
      visibility: _visibility,
      lifecycleStatus,
      ...entryData
    } = entry;
    return {
      requestedId,
      tableName,
      dedupeKey: JSON.stringify([
        tableName,
        tenantId,
        userId,
        canonicalProjectId,
        productId,
        producerId,
        namespace,
        visibility,
        entry.contentHash,
      ]),
      row: {
        ...entryData,
        id: requestedId,
        createdAt: entry.createdAt || Date.now(),
        metadata: JSON.stringify(entry.metadata || {}),
        project_name: normalizeScopeValue(projectName),
        app_name: normalizeScopeValue(appName),
        user_id: userId,
        agent_id: normalizeScopeValue(agentId),
        workspace_id: normalizeScopeValue(workspaceId),
        tenant_id: tenantId,
        canonical_project_id: canonicalProjectId,
        product_id: productId,
        producer_id: producerId,
        namespace,
        visibility,
        lifecycle_status: normalizeScopeValue(lifecycleStatus),
      },
    };
  }

  private async storePreparedEntries(prepared: PreparedStoreEntry[]): Promise<DatabaseStoreResult> {
    if (prepared.length === 0) {
      return { inserted: 0, duplicates: 0, records: [] };
    }

    return this.withWriteLock(async () => this.storePreparedEntriesLocked(prepared));
  }

  private async storePreparedEntriesLocked(
    prepared: PreparedStoreEntry[],
  ): Promise<DatabaseStoreResult> {

    // 在首条数据 add 前完成全部目标表的 write/init preflight。
    const tables = new Map<TableName, LanceDB.Table>();
    for (const { tableName } of prepared) {
      if (!tables.has(tableName)) {
        const table = await this.createConfiguredTableUnderWriteLock(tableName);
        // A provider may retain a table handle opened before another process
        // committed. Refresh its MVCC view inside the cross-process lock before
        // performing the dedupe query.
        await this.withDatabaseIdentityCheck(async () => table.checkoutLatest());
        tables.set(tableName, table);
      }
    }

    // 在首条数据 add 前完成全部 authority-scoped dedupe 查询，避免查询失败造成隐式部分写。
    const resolutions = new Map<string, StoreResolution>();
    for (const [index, entry] of prepared.entries()) {
      if (resolutions.has(entry.dedupeKey)) continue;
      const existingId = await this.findExistingAuthorityHash(
        tables.get(entry.tableName)!,
        entry.row,
      );
      resolutions.set(entry.dedupeKey, existingId
        ? { persistedId: existingId, source: "existing" }
        : { persistedId: entry.requestedId, source: "planned", ownerIndex: index });
    }

    const successfulPlannedKeys = new Set<string>();
    for (const [index, entry] of prepared.entries()) {
      const resolution = resolutions.get(entry.dedupeKey)!;
      if (resolution.source !== "planned" || resolution.ownerIndex !== index) continue;
      try {
        await this.withDatabaseIdentityCheck(async () =>
          tables.get(entry.tableName)!.add([entry.row]));
      } catch {
        // Both pre-commit failures and post-commit ACK failures are resolved by
        // the exact confirmation sequence below while the write lock is held.
      }

      try {
        const requestedId = await this.findExistingAuthorityHash(
          tables.get(entry.tableName)!,
          entry.row,
          entry.requestedId,
        );
        if (requestedId === entry.requestedId) {
          successfulPlannedKeys.add(entry.dedupeKey);
          continue;
        }

        const foreignId = await this.findExistingAuthorityHash(
          tables.get(entry.tableName)!,
          entry.row,
        );
        if (foreignId && foreignId !== entry.requestedId) {
          resolutions.set(entry.dedupeKey, {
            persistedId: foreignId,
            source: "existing",
          });
          continue;
        }
      } catch {
        // Confirmation failure is ambiguous and must never be reported stored.
      }
      throw new LanceDBPartialStoreError(
        this.buildStoreReceipt(prepared, resolutions, successfulPlannedKeys),
      );
    }

    return this.buildStoreReceipt(prepared, resolutions, successfulPlannedKeys);
  }

  private async withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquireWriteLock();
    let result: T | undefined;
    let operationError: unknown;
    let operationFailed = false;
    try {
      result = await operation();
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }

    try {
      await lock.release();
    } catch {
      if (operationError instanceof LanceDBPartialStoreError) {
        throw new LanceDBStoreCleanupError(operationError.receipt, "partial");
      }
      const completedReceipt = parseDatabaseStoreResult(result);
      if (completedReceipt) {
        throw new LanceDBStoreCleanupError(completedReceipt, "completed");
      }
      if (operationFailed) throw operationError;
      throw new Error("LanceDB write lock cleanup failed");
    }

    if (operationFailed) throw operationError;
    return result as T;
  }

  private async acquireWriteLock(): Promise<WriteLockHandle> {
    await this.ensureSafeDatabaseDirectory();
    const lockPath = join(this.resolvedDbPath, WRITE_LOCK_FILENAME);
    const startedAt = process.hrtime.bigint();
    const timeoutNs = BigInt(this.writeLockOptions.timeoutMs) * 1_000_000n;

    while (true) {
      if (await this.isRecoveryGuardPresent()) {
        await this.waitForWriteLockRetry(startedAt, timeoutNs);
        continue;
      }
      const token = randomUUID();
      const candidatePath = join(
        this.resolvedDbPath,
        `.mengshu-write.lock.candidate-${token}`,
      );
      const owner: WriteLockOwner = {
        version: 1,
        token,
        pid: process.pid,
        createdMonotonicNs: process.hrtime.bigint().toString(),
        processStartMonotonicNs: PROCESS_START_MONOTONIC_NS.toString(),
      };
      try {
        try {
          await this.writeLockOwner(candidatePath, owner);
        } catch {
          // A candidate without readable ownership metadata is inert. Leave it
          // for operator inspection instead of risking deletion of a replacement.
          await this.removeOwnedLockFile(candidatePath, token).catch(() => false);
          throw new Error("LanceDB write lock initialization failed");
        }
        // A recovery can begin after the initial guard check while this writer
        // is fsyncing its candidate. Re-check immediately before publishing the
        // fixed lock name so a quiescent recovery window cannot admit a writer.
        if (await this.isRecoveryGuardPresent()) {
          if (!await this.removeOwnedLockFile(candidatePath, token, process.pid)) {
            throw new Error("LanceDB write lock initialization failed");
          }
          await this.waitForWriteLockRetry(startedAt, timeoutNs);
          continue;
        }
        await link(candidatePath, lockPath);
        try {
          if (!await this.removeOwnedLockFile(candidatePath, token, process.pid)) {
            throw new Error("candidate ownership changed");
          }
        } catch {
          await this.removeOwnedLockFile(lockPath, token, process.pid).catch(() => false);
          throw new Error("LanceDB write lock initialization failed");
        }
        try {
          await this.assertCanonicalDatabaseIdentity();
        } catch {
          await this.removeOwnedLockFile(lockPath, token, process.pid).catch(() => false);
          throw new Error("LanceDB database path identity changed");
        }
        return {
          release: async () => this.releaseWriteLock(lockPath, token),
        };
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) {
          await this.removeOwnedLockFile(candidatePath, token, process.pid)
            .catch(() => false);
          throw error;
        }
        await this.removeOwnedLockFile(candidatePath, token).catch(() => false);
      }

      // Node exposes neither openat/renameat2 conditional-on-inode nor a safe
      // cross-process compare-and-remove primitive. Automatic stale recovery is
      // intentionally disabled: a crashed owner requires explicit operator
      // removal after verifying the lock file. This prevents a recovery waiter
      // from ever renaming a newer owner's lock.
      await this.waitForWriteLockRetry(startedAt, timeoutNs);
    }
  }

  private async waitForWriteLockRetry(startedAt: bigint, timeoutNs: bigint): Promise<void> {
    const elapsedNs = process.hrtime.bigint() - startedAt;
    if (elapsedNs >= timeoutNs) {
      throw new Error("LanceDB write lock acquisition timed out");
    }
    const remainingMs = Number((timeoutNs - elapsedNs) / 1_000_000n);
    await delay(Math.max(1, Math.min(this.writeLockOptions.retryMs, remainingMs)));
  }

  private async isRecoveryGuardPresent(): Promise<boolean> {
    const guardPath = join(this.resolvedDbPath, RECOVERY_GUARD_FILENAME);
    try {
      const stats = await lstat(guardPath);
      if (!stats.isFile() || stats.isSymbolicLink() ||
          stats.uid !== process.getuid!() || (stats.mode & 0o777) !== 0o600) {
        throw new Error("LanceDB recovery guard path is unsafe");
      }
      return true;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async acquireRecoveryGuard(): Promise<WriteLockHandle> {
    const token = randomUUID();
    const guardPath = join(this.resolvedDbPath, RECOVERY_GUARD_FILENAME);
    const candidatePath = join(
      this.resolvedDbPath,
      `.mengshu-write-recovery.candidate-${token}`,
    );
    const owner: WriteLockOwner = {
      version: 1,
      token,
      pid: process.pid,
      createdMonotonicNs: process.hrtime.bigint().toString(),
      processStartMonotonicNs: PROCESS_START_MONOTONIC_NS.toString(),
    };
    try {
      await this.writeLockOwner(candidatePath, owner);
      await link(candidatePath, guardPath);
      if (!await this.removeOwnedLockFile(candidatePath, token, process.pid)) {
        throw new Error("LanceDB recovery guard candidate cleanup failed");
      }
    } catch (error) {
      await this.removeOwnedLockFile(candidatePath, token, process.pid).catch(() => false);
      if (isNodeError(error, "EEXIST")) {
        throw new Error("LanceDB lock recovery is already in progress or guard requires operator cleanup");
      }
      throw error;
    }
    return {
      release: async () => {
        if (!await this.removeOwnedLockFile(guardPath, token, process.pid)) {
          throw new Error("LanceDB recovery guard cleanup failed");
        }
      },
    };
  }

  private isOwnerDefinitelyDead(owner: WriteLockOwner): boolean {
    if (owner.pid === process.pid) return false;
    try {
      process.kill(owner.pid, 0);
      return false;
    } catch (error) {
      return isNodeError(error, "ESRCH");
    }
  }

  private async ensureSafeDatabaseDirectory(): Promise<void> {
    if (!isAbsolute(this.resolvedDbPath)) {
      throw new Error("LanceDB database path is not a safe private directory");
    }
    const { root } = parse(this.resolvedDbPath);
    const parts = this.resolvedDbPath.slice(root.length).split(sep).filter(Boolean);
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        try {
          await mkdir(current, { mode: 0o700 });
        } catch (mkdirError) {
          if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
        }
        stats = await lstat(current);
      }
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error("LanceDB database path contains an unsafe component");
      }
    }

    const stats = await lstat(this.resolvedDbPath);
    if (stats.uid !== process.getuid!() || (stats.mode & 0o777) !== 0o700) {
      throw new Error("LanceDB database path is not a safe private directory");
    }
    if (this.databaseIdentity === undefined) {
      this.databaseIdentity = { dev: stats.dev, ino: stats.ino };
    } else if (this.databaseIdentity.dev !== stats.dev ||
               this.databaseIdentity.ino !== stats.ino) {
      throw new Error("LanceDB database path identity changed");
    }
    await this.assertCanonicalDatabaseIdentity();
  }

  private async assertCanonicalDatabaseIdentity(): Promise<void> {
    const stats = await lstat(this.resolvedDbPath);
    if (!this.databaseIdentity || stats.dev !== this.databaseIdentity.dev ||
        stats.ino !== this.databaseIdentity.ino ||
        await realpath(this.resolvedDbPath) !== this.resolvedDbPath) {
      throw new Error("LanceDB database path identity changed");
    }
  }

  /**
   * Detect operator replacement around every cached connection/table operation.
   * Node does not expose dirfd/openat/renameat2 in its portable fs API, so this
   * narrows accidental/operator races but is not a same-UID adversary boundary.
   */
  private async withDatabaseIdentityCheck<T>(operation: () => Promise<T>): Promise<T> {
    await this.assertCanonicalDatabaseIdentity();
    try {
      return await operation();
    } finally {
      await this.assertCanonicalDatabaseIdentity();
    }
  }

  private async writeLockOwner(ownerPath: string, owner: WriteLockOwner): Promise<void> {
    const handle = await open(
      ownerPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    let identity: FileIdentity | undefined;
    let failure: unknown;
    try {
      const stats = await handle.stat();
      identity = { dev: stats.dev, ino: stats.ino };
      await handle.writeFile(JSON.stringify(owner), { encoding: "utf8" });
      await handle.sync();
    } catch (error) {
      failure = error;
    } finally {
      try {
        await handle.close();
      } catch (error) {
        failure ??= error;
      }
    }
    if (failure !== undefined) {
      if (identity) {
        await this.removeCandidateByIdentity(ownerPath, identity, owner.token)
          .catch(() => false);
      }
      throw new Error("LanceDB write lock candidate persistence failed");
    }
  }

  private async removeCandidateByIdentity(
    candidatePath: string,
    identity: FileIdentity,
    token: string,
  ): Promise<boolean> {
    let stats;
    try {
      stats = await lstat(candidatePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.dev !== identity.dev ||
        stats.ino !== identity.ino || stats.uid !== process.getuid!()) {
      return false;
    }
    const quarantinePath = join(
      this.resolvedDbPath,
      `.mengshu-write.lock.failed-${token}-${randomUUID()}`,
    );
    await rename(candidatePath, quarantinePath);
    const moved = await lstat(quarantinePath);
    if (!moved.isFile() || moved.dev !== identity.dev || moved.ino !== identity.ino) {
      return false;
    }
    await rm(quarantinePath, { force: false });
    return true;
  }

  private async readLockOwner(lockPath: string): Promise<WriteLockOwner | undefined> {
    const lockStats = await lstat(lockPath);
    const currentUid = process.getuid!();
    if (!lockStats.isFile() || lockStats.isSymbolicLink() ||
        lockStats.uid !== currentUid ||
        (lockStats.mode & 0o777) !== 0o600 ||
        lockStats.size > MAX_LOCK_OWNER_BYTES) {
      throw new Error("LanceDB write lock path is unsafe");
    }

    const handle = await open(
      lockPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      const ownerStats = await handle.stat();
      if (!ownerStats.isFile() || ownerStats.size > MAX_LOCK_OWNER_BYTES ||
          ownerStats.dev !== lockStats.dev || ownerStats.ino !== lockStats.ino ||
          ownerStats.uid !== currentUid ||
          (ownerStats.mode & 0o777) !== 0o600) {
        throw new Error("LanceDB write lock owner metadata is unsafe");
      }
      let parsed: Partial<WriteLockOwner>;
      try {
        parsed = JSON.parse(
          await handle.readFile({ encoding: "utf8" }),
        ) as Partial<WriteLockOwner>;
      } catch {
        return undefined;
      }
      if (parsed.version !== 1 || typeof parsed.token !== "string" ||
          !SAFE_LOCK_TOKEN.test(parsed.token) ||
          !Number.isSafeInteger(parsed.pid) || Number(parsed.pid) <= 0 ||
          typeof parsed.createdMonotonicNs !== "string" ||
          !/^[1-9][0-9]*$/.test(parsed.createdMonotonicNs) ||
          typeof parsed.processStartMonotonicNs !== "string" ||
          !/^[0-9]+$/.test(parsed.processStartMonotonicNs)) {
        return undefined;
      }
      return parsed as WriteLockOwner;
    } finally {
      await handle.close();
    }
  }

  private async releaseWriteLock(lockPath: string, token: string): Promise<void> {
    if (!await this.removeOwnedLockFile(lockPath, token, process.pid)) {
      throw new Error("LanceDB write lock ownership changed before release");
    }
  }

  private async removeOwnedLockFile(
    lockPath: string,
    token: string,
    expectedPid?: number,
  ): Promise<boolean> {
    let owner: WriteLockOwner | undefined;
    try {
      owner = await this.readLockOwner(lockPath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
    if (!owner || owner.token !== token ||
        (expectedPid !== undefined && owner.pid !== expectedPid)) {
      return false;
    }

    const quarantinePath = join(
      this.resolvedDbPath,
      `.mengshu-write.lock.release-${token}-${randomUUID()}`,
    );
    try {
      await rename(lockPath, quarantinePath);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw new Error("LanceDB write lock ownership cleanup failed");
    }
    const movedOwner = await this.readLockOwner(quarantinePath);
    if (!movedOwner || movedOwner.token !== token ||
        (expectedPid !== undefined && movedOwner.pid !== expectedPid)) {
      throw new Error("LanceDB write lock ownership changed during cleanup");
    }
    await rm(quarantinePath, { force: false });
    return true;
  }

  private async findExistingAuthorityHash(
    table: LanceDB.Table,
    row: Record<string, unknown>,
    requestedId?: string,
  ): Promise<string | undefined> {
    const predicates = [
      `tenant_id = '${escapeSqlString(String(row.tenant_id ?? SCOPE_NULL_SENTINEL))}'`,
      `user_id = '${escapeSqlString(String(row.user_id ?? SCOPE_NULL_SENTINEL))}'`,
      `canonical_project_id = '${escapeSqlString(String(row.canonical_project_id ?? SCOPE_NULL_SENTINEL))}'`,
      `product_id = '${escapeSqlString(String(row.product_id ?? SCOPE_NULL_SENTINEL))}'`,
      `producer_id = '${escapeSqlString(String(row.producer_id ?? SCOPE_NULL_SENTINEL))}'`,
      `namespace = '${escapeSqlString(String(row.namespace ?? SCOPE_NULL_SENTINEL))}'`,
      `visibility = '${escapeSqlString(String(row.visibility ?? SCOPE_NULL_SENTINEL))}'`,
      `contentHash = '${escapeSqlString(String(row.contentHash ?? ""))}'`,
    ];
    if (requestedId !== undefined) {
      predicates.push(`id = '${escapeSqlString(requestedId)}'`);
    }
    const expression = predicates.join(" AND ");
    const rows = await this.withDatabaseIdentityCheck(async () =>
      table.query().filter(expression).limit(1).select("id").toArray());
    return typeof rows[0]?.id === "string" ? rows[0].id : undefined;
  }

  private buildStoreReceipt(
    prepared: PreparedStoreEntry[],
    resolutions: Map<string, StoreResolution>,
    successfulPlannedKeys: Set<string>,
  ): DatabaseStoreResult {
    const records = prepared.flatMap((entry, index) => {
      const resolution = resolutions.get(entry.dedupeKey)!;
      if (resolution.source === "planned" && !successfulPlannedKeys.has(entry.dedupeKey)) {
        return [];
      }
      return [{
        requestedId: entry.requestedId,
        persistedId: resolution.persistedId,
        stored: resolution.source === "planned" && resolution.ownerIndex === index,
      }];
    });

    return {
      inserted: records.filter((record) => record.stored).length,
      duplicates: records.filter((record) => !record.stored).length,
      records,
    };
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    this.validateQueryOptions(options);

    // 跨所有表搜索
    if (options.searchAll) {
      const allResults: Array<MemoryEntry & { score: number }> = [];
      try {
        for (const tableName of this.allowedTables) {
          const results = await this.queryFromTable(tableName, options);
          allResults.push(...results);
        }
      } catch {
        throw new Error("LanceDB searchAll failed closed");
      }

      // 合并结果并按分数排序
      allResults.sort((a, b) => b.score - a.score);
      if (options.limit) {
        return allResults.slice(0, options.limit);
      }
      return allResults;
    }

    // 单表查询
    const tableName = options.tableName ?? this.getDefaultTableName(options.dataTypes?.[0]);
    return this.queryFromTable(tableName, options);
  }

  /**
   * 从指定表查询数据
   */
  private async queryFromTable(tableName: TableName, options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const table = await this.getExistingTable(tableName);
    let results: any[];

    // 构造 scope 维度列过滤条件（D-25 / T3）。
    // projectName/appName 走精确等值；projectPattern 走 LIKE 模糊匹配，
    // 与 filterProject 互斥（由上层 service 决定，这里只透传）。
    const filters: string[] = [];
    if (options.tenantId !== undefined && options.userId !== undefined) {
      filters.push(`tenant_id = '${escapeSqlString(options.tenantId)}'`);
      filters.push(`user_id = '${escapeSqlString(options.userId)}'`);
    }
    if (typeof options.projectName === "string" && options.projectName) {
      filters.push(`project_name = '${escapeSqlString(options.projectName)}'`);
    }
    if (typeof options.appName === "string" && options.appName) {
      filters.push(`app_name = '${escapeSqlString(options.appName)}'`);
    }
    if (typeof options.projectPattern === "string" && options.projectPattern) {
      filters.push(`project_name LIKE '${escapeSqlString(options.projectPattern)}'`);
    }

    if (options.dataTypes && options.dataTypes.length > 0) {
      const dataTypeFilters = options.dataTypes.map(dataTypeFilterExpression);
      filters.push(dataTypeFilters.length === 1
        ? dataTypeFilters[0]!
        : `(${dataTypeFilters.join(" OR ")})`);
    }

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        assertSafeMetadataFilterKey(key);
        if (typeof value === "string") {
          filters.push(`metadata.${key} = '${escapeSqlString(value)}'`);
        } else if (typeof value === "number" || typeof value === "boolean") {
          filters.push(`metadata.${key} = ${value}`);
        }
      }
    }

    // 向量搜索
    if (options.vector) {
      let vectorQuery = table.vectorSearch(options.vector);

      if (filters.length > 0) {
        vectorQuery = vectorQuery.filter(filters.join(" AND "));
      }

      // 限制结果数量
      if (options.limit) {
        vectorQuery = vectorQuery.limit(options.limit);
      }

      results = await this.withDatabaseIdentityCheck(async () => vectorQuery.toArray());
    } else {
      // 非向量搜索
      let queryBuilder = table.query();

      if (filters.length > 0) {
        queryBuilder = queryBuilder.filter(filters.join(" AND "));
      }

      // 限制结果数量
      if (options.limit) {
        queryBuilder = queryBuilder.limit(options.limit);
      }

      results = await this.withDatabaseIdentityCheck(async () => queryBuilder.toArray());
    }

    // LanceDB uses L2 distance by default; convert to similarity score
    const mapped = results.map((row) => {
      const distance = row._distance ?? 0;
      // Use inverse for a 0-1 range: sim = 1 / (1 + d)
      const score = 1 / (1 + distance);

      // 解析 metadata JSON 字符串
      let metadata = {};
      if (typeof row.metadata === 'string') {
        try {
          metadata = JSON.parse(row.metadata);
        } catch {
          metadata = {};
        }
      } else if (row.metadata && typeof row.metadata === 'object') {
        metadata = row.metadata;
      }

      return {
        id: row.id as string,
        text: row.text as string,
        contentHash: row.contentHash as string,
        vector: row.vector as number[],
        importance: row.importance as number,
        category: row.category as MemoryEntry["category"],
        dataType: row.dataType as MemoryEntry["dataType"],
        metadata,
        createdAt: row.createdAt as number,
        // Scope 维度列还原（空串视作未设置）
        projectName: denormalizeScopeValue(row.project_name),
        appName: denormalizeScopeValue(row.app_name),
        userId: denormalizeScopeValue(row.user_id),
        agentId: denormalizeScopeValue(row.agent_id),
        workspaceId: denormalizeScopeValue(row.workspace_id),
        tenantId: denormalizeScopeValue(row.tenant_id),
        canonicalProjectId: denormalizeScopeValue(row.canonical_project_id),
        productId: denormalizeScopeValue(row.product_id),
        producerId: denormalizeScopeValue(row.producer_id),
        namespace: denormalizeScopeValue(row.namespace),
        visibility: denormalizeScopeValue(row.visibility) as MemoryEntry["visibility"],
        lifecycleStatus: denormalizeScopeValue(row.lifecycle_status) as MemoryEntry["lifecycleStatus"],
        score,
      };
    });

    // 应用最小分数过滤
    const minScore = options.minScore ?? 0;
    return mapped.filter((r) => r.score >= minScore);
  }

  async getTableNames(): Promise<TableName[]> {
    return this.listExistingAllowedTables();
  }

  async ensureTable(tableName: TableName): Promise<void> {
    this.assertAllowedTableName(tableName);
    await this.withWriteLock(async () => {
      await this.createConfiguredTableUnderWriteLock(tableName);
    });
  }

  async getTableStats(): Promise<TableStats[]> {
    const stats: TableStats[] = [];

    for (const tableName of await this.listExistingAllowedTables()) {
      const table = await this.getExistingTable(tableName);
      const count = await this.withDatabaseIdentityCheck(async () => table.countRows());
      stats.push({
        name: tableName,
        count,
        dataType: tableName === "memories" ? "memory" : "knowledge",
      });
    }

    return stats;
  }

  /**
   * 动态扩展知识库表
   * @param categories 知识分类名称数组
   */
  async extendKnowledgeTables(categories: string[]): Promise<void> {
    const requestedTables = categories.map((category) => {
      if (typeof category !== "string" || !SAFE_KNOWLEDGE_CATEGORY.test(category)) {
        throw new Error("LanceDB knowledge-base category is invalid");
      }
      const tableName = `knowledge_${category}` as TableName;
      this.assertAllowedTableName(tableName, "knowledge-base table");
      return tableName;
    });

    await this.withWriteLock(async () => {
      for (const tableName of requestedTables) {
        await this.createConfiguredTableUnderWriteLock(tableName);
      }
    });
  }

  async delete(ids: string[]): Promise<void> {
    // 按表分组删除
    const idsByTable = new Map<TableName, string[]>();
    for (const id of ids) {
      // 默认从 memories 表删除
      const existing = idsByTable.get("memories") || [];
      existing.push(id);
      idsByTable.set("memories", existing);
    }

    // 从各表删除
    for (const [tableName, tableIds] of idsByTable.entries()) {
      const table = await this.getExistingTable(tableName);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validIds = tableIds.filter(id => uuidRegex.test(id));

      if (validIds.length === 0) {
        continue;
      }

      const idFilters = validIds.map(id => `id = '${id}'`);
      await this.withDatabaseIdentityCheck(async () => table.delete(idFilters.join(" OR ")));
    }
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    assertSafeLegacyDeleteFilter(filter);
    if (filter.tableName !== undefined) {
      this.assertAllowedTableName(filter.tableName);
    }

    // 确定要操作的表
    const tableName = filter.tableName as TableName | undefined;
    const tables = tableName
      ? [await this.getExistingTable(tableName)]
      : await Promise.all(
          (await this.listExistingAllowedTables()).map((name) => this.getExistingTable(name)),
        );

    let totalDeleted = 0;

    for (const table of tables) {
      const filters: string[] = [];

      for (const [key, value] of Object.entries(filter)) {
        if (key === "tableName" || key === "dataType") {
          continue; // 跳过表名和数据类型过滤
        } else if (key === "createdAt" && typeof value === "object" && value !== null) {
          // 支持时间范围过滤
          const opFilters = Object.entries(value as Record<string, number>).map(([op, val]) => {
            const mongoOpToLanceOp: Record<string, string> = {
              $gt: ">",
              $gte: ">=",
              $lt: "<",
              $lte: "<=",
              $eq: "=",
            };
            const operator = mongoOpToLanceOp[op] || "=";
            return `createdAt ${operator} ${val}`;
          });
          filters.push(...opFilters);
        } else if (typeof value === "string") {
          filters.push(`${key} = '${value.replace(/'/g, "''")}'`);
        } else if (typeof value === "number" || typeof value === "boolean") {
          filters.push(`${key} = ${value}`);
        }
      }

      if (filters.length === 0) {
        throw new Error("No filter conditions provided for delete");
      }

      // 先统计要删除的数量
      const countBefore = await this.countByTable(table, filter);
      if (countBefore === 0) {
        continue;
      }

      // 执行删除
      await this.withDatabaseIdentityCheck(async () => table.delete(filters.join(" AND ")));
      totalDeleted += countBefore;
    }

    return totalDeleted;
  }

  /**
   * 按表统计过滤后的数量
   */
  private async countByTable(table: LanceDB.Table, filter?: Record<string, unknown>): Promise<number> {
    if (!filter || Object.keys(filter).length === 0) {
      return this.withDatabaseIdentityCheck(async () => table.countRows());
    }

    let queryBuilder = table.query();
    const filters: string[] = [];

    for (const [key, value] of Object.entries(filter)) {
      if (key === "tableName" || key === "dataType") {
        continue;
      } else if (typeof value === "string") {
        filters.push(`${key} = '${value.replace(/'/g, "''")}'`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        filters.push(`${key} = ${value}`);
      }
    }

    if (filters.length > 0) {
      queryBuilder = queryBuilder.filter(filters.join(" AND "));
    }

    const results = await this.withDatabaseIdentityCheck(async () =>
      queryBuilder.select("id").toArray());
    return results.length;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    if (contentHashes.length === 0) {
      return [];
    }

    const existingHashes: string[] = [];

    // 在所有表中查找
    for (const tableName of await this.listExistingAllowedTables()) {
      const table = await this.getExistingTable(tableName);
      const hashFilters = contentHashes.map(hash => `contentHash = '${hash.replace(/'/g, "''")}'`);
      const results = await this.withDatabaseIdentityCheck(async () => table
        .query()
        .filter(hashFilters.join(" OR "))
        .select("contentHash")
        .toArray());

      for (const row of results) {
        const hash = row.contentHash as string;
        if (!existingHashes.includes(hash)) {
          existingHashes.push(hash);
        }
      }
    }

    return existingHashes;
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    if (filter?.tableName !== undefined) {
      this.assertAllowedTableName(filter.tableName);
    }
    // 指定了表名
    if (filter?.tableName) {
      const tableName = filter.tableName as TableName;
      const table = await this.getExistingTable(tableName);
      return this.countByTable(table, filter);
    }

    // 所有表总计
    let totalCount = 0;
    for (const tableName of await this.listExistingAllowedTables()) {
      const table = await this.getExistingTable(tableName);
      totalCount += await this.countByTable(table, filter);
    }
    return totalCount;
  }
}
