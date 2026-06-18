// 从 config 导入并重导出类型
export type { RoutingRule, KnowledgeBaseConfig } from "../../../../config.js";
import type { MemoryCategory } from "../../../../config.js";

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
}

/**
 * 记忆查询选项
 */
export interface MemoryQueryOptions {
  /** 查询文本 */
  query?: string;
  /** 查询向量（可选，提供则不重新计算） */
  vector?: number[];
  /** 最大返回结果数 */
  limit?: number;
  /** 最小相似度阈值 (0-1) */
  minScore?: number;
  /** 包含的数据类型 */
  dataTypes?: DataType[];
  /** 元数据过滤条件 */
  filter?: Record<string, unknown>;
  /** 查询的表名（可选，默认查询 memories 表） */
  tableName?: TableName;
  /** 是否跨所有表搜索 */
  searchAll?: boolean;
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
  store(entries: MemoryEntry[]): Promise<void>;

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
}
