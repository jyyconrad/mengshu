/**
 * MemoryService 的输入输出契约。
 *
 * 这些 DTO 是 REST/MCP/SDK/OpenClaw adapter 共用的服务边界，避免上层直接依赖
 * 旧 `DatabaseProvider` 或具体向量库实现。
 */

import type { DataType, TableName } from "../db/types.js";
import type { ContextBlock, MemoryRecord, MemoryScope, MemoryScopeInput, RecallResult } from "./types.js";

export type { RecallResult } from "./types.js";

export interface StoreMemoryInput {
  record: MemoryRecord;
}

export interface StoreMemoryResult {
  id: string;
  stored: boolean;
}

export interface RecallInput {
  query: string;
  scope?: MemoryScopeInput;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  tableName?: TableName;
  dataTypes?: DataType[];
  searchAll?: boolean;

  // D-25：项目/产品维度过滤（默认软过滤，按需硬过滤）
  /** 按项目精确筛选（硬过滤，对应 project_name 列）。不传则跨项目软召回。 */
  filterProject?: string;
  /** 按产品精确筛选（硬过滤，对应 app_name 列）。 */
  filterProduct?: string;
  /** 筛选模式。"soft"=仅 scopeFit 排序（默认），"hard"=精确过滤。 */
  scopeFilterMode?: "soft" | "hard";
  /** 项目相似检索（LIKE pattern，如 "openclaw%"）。与 filterProject 互斥。 */
  projectPattern?: string;
}

export interface BuildContextInput extends RecallInput {
  title?: string;
}

export interface DeleteMemoryInput {
  ids?: string[];
  filter?: Record<string, unknown>;
}

export interface DeleteMemoryResult {
  deleted: number;
}

export interface HealthSnapshot {
  ok: boolean;
  records?: number;
  error?: string;
}

export interface MemoryService {
  storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  buildContext(input: BuildContextInput): Promise<ContextBlock>;
  delete(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  health(): Promise<HealthSnapshot>;
}

export interface MemoryRepositoryQuery {
  query: string;
  vector?: number[];
  scope: MemoryScope;
  limit?: number;
  minScore?: number;
  filter?: Record<string, unknown>;
  tableName?: TableName;
  dataTypes?: DataType[];
  searchAll?: boolean;
  // 注意：scope 维度硬过滤通过 filter 的内部 key 传递（_projectName/_appName/_projectPattern），
  // adapter.toLegacyQueryOptions 提取后映射到 MemoryQueryOptions.projectName 等。
}

export interface MemoryRepository {
  store(records: MemoryRecord[]): Promise<void>;
  query(input: MemoryRepositoryQuery): Promise<Array<MemoryRecord & { score: number }>>;
  delete(ids: string[]): Promise<void>;
  deleteByFilter(filter: Record<string, unknown>): Promise<number>;
  count(filter?: Record<string, unknown>): Promise<number>;
}

export interface EmbeddingPort {
  embed(text: string): Promise<number[]>;
}
