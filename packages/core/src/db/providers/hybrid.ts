import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableName, TableStats } from "../types";
import { LanceDBProvider } from "./lancedb";
import { SupabaseProvider } from "./supabase";

/**
 * 混合模式数据库提供者
 * 向量数据存储在 LanceDB（本地，高性能搜索）
 * 文本和元数据存储在 Supabase（云端，持久化）
 */
export class HybridProvider implements DatabaseProvider {
  constructor(
    private readonly lanceDbProvider: LanceDBProvider,
    private readonly supabaseProvider: SupabaseProvider,
  ) {}

  async initialize(): Promise<void> {
    await Promise.all([
      this.lanceDbProvider.initialize(),
      this.supabaseProvider.initialize(),
    ]);
  }

  async close(): Promise<void> {
    await Promise.all([
      this.lanceDbProvider.close(),
      this.supabaseProvider.close(),
    ]);
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    // 同时存储到两个数据库
    await Promise.all([
      this.lanceDbProvider.store(entries),
      this.supabaseProvider.store(entries),
    ]);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    // 先使用 LanceDB 进行快速向量搜索，获取 ID 和分数
    const lanceResults = await this.lanceDbProvider.query({
      ...options,
      // 只需要 ID 和分数，不需要其他字段
    });

    if (lanceResults.length === 0) {
      return [];
    }

    // 从 Supabase 获取完整的元数据和文本内容
    const ids = lanceResults.map(r => r.id);
    const supabaseResults = await this.supabaseProvider.query({
      ...options,
      filter: { id: ids },
      vector: undefined, // 不需要再次向量搜索
      limit: undefined, // 不需要限制，因为已经从 LanceDB 获取了结果
    });

    // 合并结果，保留 LanceDB 的分数
    const resultMap = new Map(supabaseResults.map(r => [r.id, r]));
    return lanceResults
      .map(lanceResult => {
        const supabaseResult = resultMap.get(lanceResult.id);
        if (!supabaseResult) {
          return null;
        }
        return {
          ...supabaseResult,
          score: lanceResult.score,
        };
      })
      .filter((r): r is MemoryEntry & { score: number } => r !== null);
  }

  async delete(ids: string[]): Promise<void> {
    await Promise.all([
      this.lanceDbProvider.delete(ids),
      this.supabaseProvider.delete(ids),
    ]);
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    // 先从 Supabase 获取要删除的 ID
    // 这里简化实现，实际可以优化
    const count = await this.supabaseProvider.deleteByFilter(filter);
    // 同步删除 LanceDB 中的数据
    await this.lanceDbProvider.deleteByFilter(filter);
    return count;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    // 只需要检查 Supabase 即可，因为数据是同步的
    return this.supabaseProvider.existsByContentHash(contentHashes);
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    return this.supabaseProvider.count(filter);
  }

  async getTableNames(): Promise<TableName[]> {
    // LanceDB 和 Supabase 都支持多表，返回 LanceDB 的表名
    return this.lanceDbProvider.getTableNames();
  }

  async ensureTable(tableName: TableName): Promise<void> {
    await Promise.all([
      this.lanceDbProvider.ensureTable(tableName),
      this.supabaseProvider.ensureTable(tableName),
    ]);
  }

  async getTableStats(): Promise<TableStats[]> {
    // 返回 Supabase 的统计信息（作为主要数据源）
    return this.supabaseProvider.getTableStats();
  }
}
