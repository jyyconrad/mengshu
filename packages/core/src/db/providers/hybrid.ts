import type {
  DatabaseProvider,
  DatabaseStoreResult,
  MemoryEntry,
  MemoryQueryOptions,
  TableName,
  TableStats,
} from "../types.js";
import { LanceDBProvider } from "./lancedb.js";
import { SupabaseProvider } from "./supabase.js";
import { assertSafeLegacyDeleteFilter } from "./legacy-delete-filter-guard.js";

const SAFE_AUTHORITY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

class HybridRecallAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HybridRecallAuthorityError";
  }
}

class HybridStoreError extends Error {
  constructor(
    readonly code: "HYBRID_STORE_FAILED" | "HYBRID_STORE_DIVERGED",
    message: string,
  ) {
    super(message);
    this.name = "HybridStoreError";
  }
}

function sameStoreOutcome(left: DatabaseStoreResult, right: DatabaseStoreResult): boolean {
  return left.inserted === right.inserted && left.duplicates === right.duplicates &&
    left.records.length === right.records.length && left.records.every((record, index) => {
      const other = right.records[index];
      return other !== undefined && record.requestedId === other.requestedId &&
        record.persistedId === other.persistedId && record.stored === other.stored;
    });
}

function requiredAuthority(options: MemoryQueryOptions): Readonly<{ tenantId: string; userId: string }> {
  if (typeof options.tenantId !== "string" || typeof options.userId !== "string" ||
      !SAFE_AUTHORITY_IDENTIFIER.test(options.tenantId) ||
      !SAFE_AUTHORITY_IDENTIFIER.test(options.userId)) {
    throw new HybridRecallAuthorityError("Hybrid recall authority is required and invalid");
  }
  return Object.freeze({ tenantId: options.tenantId, userId: options.userId });
}

function assertAuthorityRows(
  rows: readonly (MemoryEntry & { score: number })[],
  authority: Readonly<{ tenantId: string; userId: string }>,
): void {
  if (rows.some((row) => row.tenantId !== authority.tenantId || row.userId !== authority.userId)) {
    throw new HybridRecallAuthorityError("Hybrid recall backend violated authority contract");
  }
}

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

  async store(entries: MemoryEntry[]): Promise<DatabaseStoreResult> {
    let outcomes: [DatabaseStoreResult | void, DatabaseStoreResult | void];
    try {
      outcomes = await Promise.all([
        this.lanceDbProvider.store(entries),
        this.supabaseProvider.store(entries),
      ]);
    } catch {
      // Hybrid 无跨后端 transaction；错误必须诚实暴露且不能泄露 provider 原始信息。
      throw new HybridStoreError("HYBRID_STORE_FAILED", "Hybrid durable store backend failed");
    }
    const [lanceOutcome, supabaseOutcome] = outcomes;
    if (!lanceOutcome || !supabaseOutcome) {
      throw new HybridStoreError("HYBRID_STORE_FAILED", "Hybrid store outcome is unavailable");
    }
    if (!sameStoreOutcome(lanceOutcome, supabaseOutcome)) {
      throw new HybridStoreError("HYBRID_STORE_DIVERGED", "Hybrid store backends returned divergent outcomes");
    }
    return lanceOutcome;
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const authority = requiredAuthority(options);
    // 先使用 LanceDB 进行快速向量搜索，获取 ID 和分数
    let lanceResults: Array<MemoryEntry & { score: number }>;
    try {
      lanceResults = await this.lanceDbProvider.query({ ...options, ...authority });
    } catch {
      throw new HybridRecallAuthorityError("Hybrid recall backend unavailable");
    }
    assertAuthorityRows(lanceResults, authority);

    if (lanceResults.length === 0) {
      return [];
    }

    // 从 Supabase 获取完整的元数据和文本内容
    const ids = lanceResults.map(r => r.id);
    let supabaseResults: Array<MemoryEntry & { score: number }>;
    try {
      supabaseResults = await this.supabaseProvider.query({
        ...options,
        ...authority,
        filter: { ...(options.filter ?? {}), id: ids },
        vector: undefined, // 不需要再次向量搜索
        limit: undefined, // 不需要限制，因为已经从 LanceDB 获取了结果
      });
    } catch {
      throw new HybridRecallAuthorityError("Hybrid recall backend unavailable");
    }
    assertAuthorityRows(supabaseResults, authority);
    const requestedIds = new Set(ids);
    if (supabaseResults.some((row) => !requestedIds.has(row.id))) {
      throw new HybridRecallAuthorityError("Hybrid recall backend violated authority contract");
    }

    // 合并结果，保留 LanceDB 的分数
    const resultMap = new Map(supabaseResults.map(r => [r.id, r]));
    const merged = lanceResults
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
    assertAuthorityRows(merged, authority);
    return options.limit === undefined ? merged : merged.slice(0, options.limit);
  }

  async delete(ids: string[]): Promise<void> {
    await Promise.all([
      this.lanceDbProvider.delete(ids),
      this.supabaseProvider.delete(ids),
    ]);
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    // Hybrid must use the strictest shared denominator: LanceDB ignores dataType.
    assertSafeLegacyDeleteFilter(filter);
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
