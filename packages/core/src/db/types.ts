// 从 config 导入并重导出类型
import { types as nodeUtilTypes } from "node:util";
export type { RoutingRule, KnowledgeBaseConfig } from "../../../../config.js";
import type { MemoryCategory } from "../../../../config.js";
import type { KnownEmbeddingSpace } from "../domain/embedding-space.js";

/**
 * 数据类型区分：
 * - memory: 用户对话产生的关键记忆
 * - document: 目录扫描产生的文档数据
 * - knowledge: 知识库数据（独立表存储）
 */
export type DataType = "memory" | "document" | "knowledge";

/**
 * 表名称类型
 * 支持动态扩展的知识库表名：knowledge_{category}
 */
export type TableName = "memories" | "knowledge" | "documents" | `knowledge_${string}`;

/**
 * 向量 provider 在 core 六因子评分前最多返回的候选数。
 *
 * 这是检索成本护栏，不是用户可见的最终 recall limit。最终 minScore/limit
 * 必须在治理硬过滤与六因子评分之后由 core 应用。
 */
export const DEFAULT_VECTOR_CANDIDATE_LIMIT = 100;

/**
 * 知识条目（用于独立的知识库表）
 */
export interface KnowledgeEntry {
  /** 唯一 ID */
  id: string;
  /** 内容文本 */
  text: string;
  /** 内容哈希（MD5），用于重复检测 */
  contentHash: string;
  /** 向量数据 */
  vector: number[];
  /** 重要性评分 (0-1) */
  importance: number;
  /** 知识分类 */
  category: MemoryCategory;
  /** 元数据 */
  metadata: MemoryMetadata;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 记忆条目元数据
 */
export interface MemoryMetadata {
  // 基础字段
  /** 文件路径（仅文档类型） */
  filePath?: string;
  /** Agent 名称 */
  agentName?: string;
  /** 会话 ID */
  sessionId?: string;
  /** 分类标签 */
  tags?: string[];
  /** 创建时间 */
  createdAt?: number;
  /** 更新时间 */
  updatedAt?: number;

  // OpenClaw 上下文信息
  /** 对话 ID（从 OpenClaw 获取） */
  conversationId?: string;
  /** 消息 ID */
  messageId?: string;
  /** 用户 ID */
  userId?: string;
  /** 项目路径 */
  projectPath?: string;

  // 数据来源信息
  /** 数据来源 */
  source?: "user" | "agent" | "system" | "scan";
  /** 内容语言 */
  language?: string;
  /** Token 数量 */
  tokenCount?: number;

  // 技术元数据
  /** 使用的嵌入模型 */
  embeddingModel?: string;
  /** 插件版本 */
  pluginVersion?: string;
  /** 文件修改时间（仅文档类型） */
  fileModifiedAt?: number;
  /** 目录结构信息（仅文档类型） */
  directoryPath?: string;

  // 自定义扩展
  [key: string]: unknown;
}

/**
 * 记忆条目
 *
 * 新增 scope 维度列支持，修复项目/产品维度过滤功能（D-25）
 */
export interface MemoryEntry {
  /** 唯一 ID */
  id: string;
  /** 内容文本 */
  text: string;
  /** 内容哈希（MD5），用于重复检测 */
  contentHash: string;
  /** 向量数据 */
  vector: number[];
  /** 重要性评分 (0-1) */
  importance: number;
  /** 记忆分类 */
  category: MemoryCategory;
  /** 数据类型 */
  dataType: DataType;
  /** 目标表名（可选，默认根据 dataType 决定） */
  tableName?: TableName;
  /** 元数据 */
  metadata: MemoryMetadata;
  /** 创建时间戳 */
  createdAt: number;

  // Scope 维度字段（D-25：独立列存储，支持项目/产品过滤）
  /** 项目名称/标识（对应 scope.projectId） */
  projectName?: string;
  /** 产品/应用名称（对应 scope.appId） */
  appName?: string;
  /** 用户标识（对应 scope.userId） */
  userId?: string;
  /** Agent 标识（对应 scope.agentId） */
  agentId?: string;
  /** 工作区标识（对应 scope.workspaceId） */
  workspaceId?: string;

  // P0-B canonical scope 双写字段。旧记录可缺失；新 MemoryRecord 映射必须完整提供。
  tenantId?: string;
  canonicalProjectId?: string;
  productId?: string;
  producerId?: string;
  namespace?: string;
  visibility?: "private" | "workspace" | "team" | "public";
  lifecycleStatus?: "active" | "archived" | "revoked" | "superseded" | "promoted";
}

/**
 * 记忆查询选项
 */
export interface MemoryQueryOptions {
  /** 查询文本 */
  query?: string;
  /** 查询向量（可选，提供则不重新计算） */
  vector?: number[];
  /**
   * 最大返回结果数（legacy provider 调用兼容项）。
   * 向量查询只在候选取回后应用，不得作为 ANN 候选池上限。
   */
  limit?: number;
  /**
   * legacy provider 相似度阈值 (0-1)。core 六因子最终阈值不得下推到这里。
   */
  minScore?: number;
  /**
   * core 评分前的 ANN 候选池上限；与最终 limit 独立，缺省为
   * DEFAULT_VECTOR_CANDIDATE_LIMIT。
   */
  candidateLimit?: number;
  /** 包含的数据类型 */
  dataTypes?: DataType[];
  /** 元数据过滤条件 */
  filter?: Record<string, unknown>;
  /** 查询的表名（可选，默认查询 memories 表） */
  tableName?: TableName;
  /** 是否跨所有表搜索 */
  searchAll?: boolean;

  // Server-owned authority boundary. Providers must bind these to dedicated
  // columns before LIMIT; they are never metadata filters or soft ranking hints.
  /** Exact tenant authority filter (tenant_id). */
  tenantId?: string;
  /** Exact user authority filter (user_id). */
  userId?: string;

  // Scope 维度列过滤（D-25 / T0：前置到 T0 以便 T1-T3 编译通过）
  /** 项目名称精确过滤（对应 project_name 列） */
  projectName?: string;
  /** 产品/应用名称精确过滤（对应 app_name 列） */
  appName?: string;
  /** 项目相似检索 LIKE pattern（如 "openclaw%"） */
  projectPattern?: string;
}

/** 解析并校验 provider-owned ANN 候选池上限。 */
export function resolveVectorCandidateLimit(
  options: Pick<MemoryQueryOptions, "candidateLimit">,
): number {
  const limit = options.candidateLimit ?? DEFAULT_VECTOR_CANDIDATE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("vector candidateLimit must be a positive safe integer");
  }
  return limit;
}

/**
 * 表统计信息
 */
export interface TableStats {
  /** 表名 */
  name: TableName;
  /** 记录数量 */
  count: number;
  /** 数据类型 */
  dataType?: DataType;
}

/** 单条 durable write 的真实落库结果。 */
export interface DatabaseStoreRecordResult {
  /** 调用方本次生成的 ID。 */
  requestedId: string;
  /** 数据库中最终持久化记录的 ID；幂等命中时可能与 requestedId 不同。 */
  persistedId: string;
  /** true 表示本次插入；false 表示命中同 authority 的既有记录。 */
  stored: boolean;
}

/** 支持 provider 将幂等 no-op 明确传回 service，避免虚报 stored。 */
export interface DatabaseStoreResult {
  inserted: number;
  duplicates: number;
  records: DatabaseStoreRecordResult[];
  cleanup?: DatabaseStoreCleanupMetadata;
}

export const DATABASE_STORE_CLEANUP_WARNING = "database_store_cleanup_failed" as const;

export interface DatabaseStoreCleanupMetadata {
  cleanupFailed: true;
  operationStatus: "completed" | "partial";
  warning: typeof DATABASE_STORE_CLEANUP_WARNING;
}

function isSafeStoreId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function readExactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return undefined;
  const strings = ownKeys as string[];
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (strings.length < requiredKeys.length || strings.some((key) => !allowed.has(key)) ||
      requiredKeys.some((key) => !strings.includes(key))) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of strings) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function readExactDataArray(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value)) return undefined;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
      !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0 ||
      lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined) {
    return undefined;
  }
  const length = Number(lengthDescriptor.value);
  const ownKeys = Reflect.ownKeys(value);
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (ownKeys.some((key) => typeof key !== "string" || !expected.has(key)) ||
      ownKeys.length !== expected.size) {
    return undefined;
  }
  const snapshot: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    snapshot.push(descriptor.value);
  }
  return Object.freeze(snapshot);
}

export function parseDatabaseStoreResult(value: unknown): DatabaseStoreResult | undefined {
  const top = readExactDataObject(value, ["inserted", "duplicates", "records"], ["cleanup"]);
  if (!top) return undefined;
  const insertedValue = top.inserted;
  const duplicatesValue = top.duplicates;
  const rawRecords = readExactDataArray(top.records);
  if (!Number.isSafeInteger(insertedValue) || Number(insertedValue) < 0 ||
      !Number.isSafeInteger(duplicatesValue) || Number(duplicatesValue) < 0 || !rawRecords ||
      Number(insertedValue) + Number(duplicatesValue) !== rawRecords.length) {
    return undefined;
  }

  let inserted = 0;
  let duplicates = 0;
  const requestedIds = new Set<string>();
  const records: DatabaseStoreRecordResult[] = [];
  for (const rawRecord of rawRecords) {
    const record = readExactDataObject(rawRecord, ["requestedId", "persistedId", "stored"]);
    if (!record || !isSafeStoreId(record.requestedId) || !isSafeStoreId(record.persistedId) ||
        typeof record.stored !== "boolean" || requestedIds.has(record.requestedId)) {
      return undefined;
    }
    requestedIds.add(record.requestedId);
    if (record.stored) inserted += 1;
    else duplicates += 1;
    records.push(Object.freeze({
      requestedId: record.requestedId,
      persistedId: record.persistedId,
      stored: record.stored,
    }));
  }
  if (inserted !== insertedValue || duplicates !== duplicatesValue) return undefined;

  let cleanup: DatabaseStoreCleanupMetadata | undefined;
  if (Object.prototype.hasOwnProperty.call(top, "cleanup")) {
    const parsedCleanup = readExactDataObject(
      top.cleanup,
      ["cleanupFailed", "operationStatus", "warning"],
    );
    if (!parsedCleanup || parsedCleanup.cleanupFailed !== true ||
        (parsedCleanup.operationStatus !== "completed" && parsedCleanup.operationStatus !== "partial") ||
        parsedCleanup.warning !== DATABASE_STORE_CLEANUP_WARNING) {
      return undefined;
    }
    cleanup = Object.freeze({
      cleanupFailed: true,
      operationStatus: parsedCleanup.operationStatus,
      warning: DATABASE_STORE_CLEANUP_WARNING,
    });
  }

  return Object.freeze({
    inserted,
    duplicates,
    records: Object.freeze(records) as DatabaseStoreRecordResult[],
    ...(cleanup ? { cleanup } : {}),
  });
}

export function isDatabaseStoreResult(value: unknown): value is DatabaseStoreResult {
  return parseDatabaseStoreResult(value) !== undefined;
}

export class DatabaseStoreCleanupError extends Error {
  readonly #contractBrand = true;
  readonly code = "DATABASE_STORE_CLEANUP_FAILED" as const;
  readonly cleanupFailed = true;
  readonly warning = DATABASE_STORE_CLEANUP_WARNING;

  readonly receipt: DatabaseStoreResult;
  readonly operationStatus: "completed" | "partial";

  constructor(receipt: DatabaseStoreResult, operationStatus: "completed" | "partial") {
    super(operationStatus === "completed"
      ? "Database store completed but cleanup failed"
      : "Database store partially completed and cleanup failed");
    this.name = "DatabaseStoreCleanupError";
    const normalized = parseDatabaseStoreResult(receipt);
    if (!normalized ||
        (operationStatus === "completed" && normalized.cleanup?.operationStatus === "partial")) {
      throw new Error("Database store cleanup receipt is invalid");
    }
    this.receipt = normalized;
    this.operationStatus = operationStatus;
    Object.defineProperties(this, {
      code: { writable: false, configurable: false },
      cleanupFailed: { writable: false, configurable: false },
      warning: { writable: false, configurable: false },
      receipt: { writable: false, configurable: false },
      operationStatus: { writable: false, configurable: false },
    });
  }

  static hasContractBrand(error: unknown): error is DatabaseStoreCleanupError {
    return typeof error === "object" && error !== null && #contractBrand in error;
  }
}

export function parseDatabaseStoreCleanupError(error: unknown): Readonly<{
  receipt: DatabaseStoreResult;
  operationStatus: "completed" | "partial";
  cleanupFailed: true;
  warning: typeof DATABASE_STORE_CLEANUP_WARNING;
}> | undefined {
  if (!error || typeof error !== "object" || nodeUtilTypes.isProxy(error)) return undefined;
  if (!DatabaseStoreCleanupError.hasContractBrand(error)) return undefined;
  const readContractField = (key: "code" | "cleanupFailed" | "warning" | "operationStatus" | "receipt") => {
    const descriptor = Object.getOwnPropertyDescriptor(error, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    return descriptor.value;
  };
  const code = readContractField("code");
  const cleanupFailed = readContractField("cleanupFailed");
  const warning = readContractField("warning");
  const operationStatus = readContractField("operationStatus");
  const receipt = parseDatabaseStoreResult(readContractField("receipt"));
  if (code !== "DATABASE_STORE_CLEANUP_FAILED" || cleanupFailed !== true ||
      warning !== DATABASE_STORE_CLEANUP_WARNING ||
      (operationStatus !== "completed" && operationStatus !== "partial") || !receipt) {
    return undefined;
  }
  return Object.freeze({ receipt, operationStatus, cleanupFailed: true, warning });
}

export function isDatabaseStoreCleanupError(error: unknown): error is DatabaseStoreCleanupError {
  return parseDatabaseStoreCleanupError(error) !== undefined;
}

/**
 * 数据库提供者接口
 * 所有数据库实现都需要实现这个接口
 */
export interface DatabaseProvider {
  /**
   * 初始化数据库连接
   */
  initialize(): Promise<void>;

  /**
   * 关闭数据库连接
   */
  close(): Promise<void>;

  /**
   * 存储记忆条目
   * @param entries 要存储的记忆条目数组
   */
  store(entries: MemoryEntry[]): Promise<DatabaseStoreResult | void>;

  /**
   * 查询相关记忆
   * @param options 查询选项
   */
  query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]>;

  /**
   * 根据 ID 删除记忆
   * @param ids 要删除的记忆 ID 数组
   */
  delete(ids: string[]): Promise<void>;

  /**
   * 按条件删除记忆
   * @param filter 删除条件
   */
  deleteByFilter(filter: Record<string, unknown>): Promise<number>;

  /**
   * 根据内容哈希检查是否已存在
   * @param contentHashes 内容哈希数组
   * @returns 已存在的哈希数组
   */
  existsByContentHash(contentHashes: string[]): Promise<string[]>;

  /**
   * 统计记录数量
   * @param filter 统计条件
   */
  count(filter?: Record<string, unknown>): Promise<number>;

  // ============================================================================
  // 多表支持方法（可选实现）
  // ============================================================================

  /**
   * 获取所有表名
   */
  getTableNames?(): Promise<TableName[]>;

  /**
   * 确保表存在
   * @param tableName 表名
   */
  ensureTable?(tableName: TableName): Promise<void>;

  /**
   * 获取表统计信息
   */
  getTableStats?(): Promise<TableStats[]>;

  /** Postgres persisted active embedding registry capability. */
  getActiveEmbeddingSpace?(): Promise<KnownEmbeddingSpace | null>;

  /** Explicit operator transition: first registration wins; mismatch fails closed. */
  registerActiveEmbeddingSpace?(space: KnownEmbeddingSpace): Promise<KnownEmbeddingSpace>;

  /**
   * 按 id 更新记录的 metadata（jsonb merge，仅部分后端实现）。
   *
   * 与 `store` 不同：`store` 在 content_hash 冲突时 DO NOTHING，
   * 无法更新已存在记录的 metadata。本方法用 `metadata || $patch::jsonb`
   * 做增量合并（不覆盖整个 metadata，仅 patch 指定字段）。
   *
   * @param id 记录 id
   * @param metadataPatch 要 merge 进 metadata 的字段
   * @param tableName 表名（默认 memories）
   * @returns 是否有记录被更新（affected rows > 0）
   */
  updateMetadata?(
    id: string,
    metadataPatch: Record<string, unknown>,
    tableName?: TableName,
  ): Promise<boolean>;
}
