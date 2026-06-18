import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableName, TableStats, KnowledgeBaseConfig } from "../types";
import { vectorDimsForModel } from "../../../../../config.js";

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];

/**
 * 允许在 DDL 中拼接的表名白名单（含前缀模式）。
 *
 * 安全约束：`ensureTableExists` 会把表名直接拼进 CREATE TABLE / CREATE INDEX
 * 语句，TS 类型层面虽然有 TableName 限制，但运行时若调用方传入未净化的字符串
 * （例如带分号、空格或 SQL 关键字），仍可能造成 SQL 注入。这里在运行时通过严格
 * 正则白名单进行二次校验：
 *   - 固定表名：memories / knowledge / documents
 *   - 动态知识库表：以 knowledge_ 为前缀，后缀只允许 [a-z][a-z0-9_]{0,63}
 * 任何不匹配的表名都会立即抛错并阻止 DDL 执行。
 */
export const ALLOWED_TABLE_NAME_RE = /^(memories|knowledge|documents|knowledge_[a-z][a-z0-9_]{0,63})$/;

/**
 * 校验表名是否符合白名单。校验失败时抛错（不静默通过），调用方负责捕获。
 *
 * @internal 仅供 SupabaseProvider 内部及单元测试使用。
 */
export function assertSafeTableName(tableName: string): void {
  if (typeof tableName !== "string" || !ALLOWED_TABLE_NAME_RE.test(tableName)) {
    throw new Error(`Invalid table name: ${tableName}`);
  }
}

/**
 * 扩展的知识库表（由配置文件动态指定）
 */
let EXTENDED_KNOWLEDGE_TABLES: string[] = [];

/**
 * Supabase 数据库提供者实现
 * 支持向量和文本数据全量存储在 Supabase
 */
export class SupabaseProvider implements DatabaseProvider {
  private client: SupabaseClient | null = null;
  private vectorDim: number;
  private extendedTables: TableName[] = [];

  constructor(
    private readonly supabaseUrl: string,
    private readonly supabaseServiceKey: string,
    private readonly embeddingModel: string,
    private readonly knowledgeBases?: KnowledgeBaseConfig,
  ) {
    this.vectorDim = vectorDimsForModel(embeddingModel);
    // 初始化扩展表列表
    if (knowledgeBases?.enabled && knowledgeBases.builtinCategories) {
      EXTENDED_KNOWLEDGE_TABLES = knowledgeBases.builtinCategories.map((cat: string) => `knowledge_${cat}`);
      if (knowledgeBases.customCategories) {
        EXTENDED_KNOWLEDGE_TABLES.push(...knowledgeBases.customCategories.map((cat: string) => `knowledge_${cat}`));
      }
      this.extendedTables = EXTENDED_KNOWLEDGE_TABLES as TableName[];
    }
  }

  async initialize(): Promise<void> {
    if (this.client) {
      return;
    }

    this.client = createClient(this.supabaseUrl, this.supabaseServiceKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    // 确保所有默认表都存在
    for (const tableName of DEFAULT_TABLES) {
      await this.ensureTableExists(tableName);
    }

    // 确保所有扩展知识库表都存在（如果启用了知识库功能）
    if (this.knowledgeBases?.enabled && this.knowledgeBases.autoCreateTables) {
      for (const tableName of this.extendedTables) {
        await this.ensureTableExists(tableName);
      }
    }
  }

  /**
   * 动态扩展知识库表
   * @param categories 知识分类名称数组
   */
  async extendKnowledgeTables(categories: string[]): Promise<void> {
    for (const category of categories) {
      const tableName = `knowledge_${category}`;
      // 添加到扩展表列表
      if (!this.extendedTables.includes(tableName as TableName)) {
        this.extendedTables.push(tableName as TableName);
      }
      await this.ensureTableExists(tableName as TableName);
    }
  }

  /**
   * 获取默认表名（根据 dataType 决定）
   */
  private getDefaultTableName(dataType?: string): TableName {
    switch (dataType) {
      case "knowledge":
      case "document":
        return "knowledge";
      case "memory":
      default:
        return "memories";
    }
  }

  /**
   * 确保表存在
   */
  async ensureTable(tableName: TableName): Promise<void> {
    await this.ensureTableExists(tableName);
  }

  private async ensureTableExists(tableName: TableName): Promise<void> {
    // 安全校验：阻止任何不在白名单内的表名进入 DDL，防止 SQL 注入。
    assertSafeTableName(tableName);
    try {
      const { error } = await this.client!.rpc('exec_sql', {
        sql: `
          CREATE TABLE IF NOT EXISTS ${tableName} (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            text TEXT NOT NULL,
            content_hash TEXT NOT NULL UNIQUE,
            vector vector(${this.vectorDim}) NOT NULL,
            importance FLOAT NOT NULL DEFAULT ${tableName === 'memories' ? '0.7' : '0.5'},
            category TEXT NOT NULL DEFAULT 'other',
            data_type TEXT NOT NULL DEFAULT '${tableName === 'memories' ? 'memory' : 'knowledge'}',
            metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
          );

          -- 向量搜索索引
          CREATE INDEX IF NOT EXISTS ${tableName}_vector_idx ON ${tableName}
          USING ivfflat (vector vector_cosine_ops)
          WITH (lists = 100);

          -- content_hash 唯一索引
          CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_content_hash_idx ON ${tableName} (content_hash);

          -- data_type 索引
          CREATE INDEX IF NOT EXISTS ${tableName}_data_type_idx ON ${tableName} (data_type);

          -- created_at 索引
          CREATE INDEX IF NOT EXISTS ${tableName}_created_at_idx ON ${tableName} (created_at DESC);
        `
      });

      if (error && !error.message.includes('already exists')) {
        // 如果 exec_sql 函数不存在，说明没有权限或者需要手动创建表
        console.warn(`Could not auto-create table ${tableName}. Please create it manually in Supabase console.`);
      }
    } catch (err) {
      // 忽略表已存在的错误
      console.warn('Table initialization warning:', err);
    }
  }

  async close(): Promise<void> {
    this.client = null;
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    await this.initialize();

    // 按表名分组
    const entriesByTable = new Map<TableName, MemoryEntry[]>();
    for (const entry of entries) {
      const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
      const existing = entriesByTable.get(tableName) || [];
      existing.push(entry);
      entriesByTable.set(tableName, existing);
    }

    // 分别存储到各表
    for (const [tableName, tableEntries] of entriesByTable.entries()) {
      const entriesToInsert = tableEntries.map(entry => ({
        id: entry.id || randomUUID(),
        text: entry.text,
        content_hash: entry.contentHash,
        vector: entry.vector,
        importance: entry.importance,
        category: entry.category,
        data_type: entry.dataType,
        metadata: entry.metadata,
        created_at: new Date(entry.createdAt || Date.now()).toISOString(),
      }));

      const { error } = await this.client!
        .from(tableName)
        .upsert(entriesToInsert, {
          onConflict: 'content_hash',
          ignoreDuplicates: true,
        });

      if (error) {
        console.error(`Failed to store entries to ${tableName}:`, error.message);
      }
    }
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    await this.initialize();

    // 跨所有表搜索
    if (options.searchAll) {
      const allResults: Array<MemoryEntry & { score: number }> = [];

      for (const tableName of DEFAULT_TABLES) {
        try {
          const results = await this.queryFromTable(tableName, options);
          allResults.push(...results);
        } catch (err) {
          console.warn(`Query failed on table ${tableName}:`, err);
        }
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
    // 向量搜索 - 使用 Supabase RPC 方式避免 URL 过长
    if (options.vector) {
      return this.queryWithVector(tableName, options);
    }

    // 非向量查询（仅过滤）
    let query = this.client!.from(tableName).select('*');

    // 数据类型过滤
    if (options.dataTypes && options.dataTypes.length > 0) {
      query = query.in('data_type', options.dataTypes);
    }

    // 元数据过滤
    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          query = query.eq(`metadata->>${key}`, value);
        }
      }
    }

    // 限制结果数量
    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to query entries: ${error.message}`);
    }

    return data.map(row => ({
      id: row.id,
      text: row.text,
      contentHash: row.content_hash,
      vector: row.vector,
      importance: row.importance,
      category: row.category,
      dataType: row.data_type,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).getTime(),
      score: 0, // 非向量查询没有相似度分数
    }));
  }

  /**
   * 使用向量进行搜索（通过 Supabase RPC）
   */
  private async queryWithVector(tableName: TableName, options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    // 使用 Supabase 的 rpc 方法进行向量搜索，避免 URL 过长
    const { data, error } = await this.client!.rpc(`match_${tableName}`, {
      query_embedding: options.vector,
      match_count: options.limit ?? 5,
      min_similarity: options.minScore ?? 0.1,
      filter_data_type: options.dataTypes && options.dataTypes.length > 0 ? options.dataTypes : null,
    });

    if (error) {
      console.warn(`RPC function match_${tableName} failed:`, error.message, '- falling back to direct query');
      // 任何错误都回退到直接查询（不仅是 function/RPC 错误）
      return this.queryWithVectorFallback(tableName, options);
    }

    return (data || []).map((row: any) => ({
      id: row.id,
      text: row.text,
      contentHash: row.content_hash,
      vector: row.vector,
      importance: row.importance,
      category: row.category,
      dataType: row.data_type,
      metadata: row.metadata,
      createdAt: new Date(row.created_at).getTime(),
      score: row.similarity,
    }));
  }

  /**
   * 向量搜索回退方案（当 RPC 函数不存在时使用）
   * 使用 Supabase 的 vector 操作符，通过降低精度和分段查询减少 URL 长度
   */
  private async queryWithVectorFallback(tableName: TableName, options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    if (!options.vector) {
      return [];
    }

    // 大幅降低向量精度以减少 URL 长度（保留 3 位小数）
    const compressedVector = options.vector.map((v: number) => Number(v.toFixed(3)));
    const vectorString = JSON.stringify(compressedVector);

    try {
      // 尝试直接使用向量比较操作符
      const query = this.client!
        .from(tableName)
        .select(`*, 1 - (vector <=> '${vectorString}')::float as similarity`);

      // 数据类型过滤
      if (options.dataTypes && options.dataTypes.length > 0) {
        const { data: filterData, error: filterError } = await query.in('data_type', options.dataTypes);
        if (filterError) {
          throw new Error(`Failed to query entries: ${filterError.message}`);
        }
        // @ts-ignore - Supabase TypeScript limitation for computed fields
        var data = filterData;
        var error = null;
      } else {
        const { data: d, error: e } = await query;
        // @ts-ignore - Supabase TypeScript limitation for computed fields
        var data = d;
        // @ts-ignore
        var error = e;
      }

      if (error) {
        throw new Error(`Failed to query entries: ${error.message}`);
      }

      return (data || []).map((row: any) => ({
        id: row.id,
        text: row.text,
        contentHash: row.content_hash,
        vector: row.vector,
        importance: row.importance,
        category: row.category,
        dataType: row.data_type,
        metadata: row.metadata,
        createdAt: new Date(row.created_at).getTime(),
        score: row.similarity ?? 0,
      }));
    } catch (err: any) {
      // 如果还是 URL 太长，尝试先获取候选 ID 再计算相似度
      console.warn('Fallback query also failed URL too long, trying alternative approach:', err.message);
      return this.queryWithVectorAlternative(tableName, options);
    }
  }

  /**
   * 向量搜索备选方案：先获取候选记录，再在内存中计算相似度
   * 适用于向量维度非常高导致 URL 超限的情况
   */
  private async queryWithVectorAlternative(tableName: TableName, options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    if (!options.vector) {
      return [];
    }

    // 第一步：先获取一批候选记录（不带相似度计算）
    let baseQuery = this.client!.from(tableName).select('*');

    if (options.dataTypes && options.dataTypes.length > 0) {
      baseQuery = baseQuery.in('data_type', options.dataTypes);
    }

    const { data: candidates, error: candidatesError } = await baseQuery;

    if (candidatesError) {
      throw new Error(`Failed to fetch candidates: ${candidatesError.message}`);
    }

    if (!candidates || candidates.length === 0) {
      return [];
    }

    // 第二步：在内存中计算相似度并排序
    const resultsWithScore = candidates.map((row: any) => {
      const similarity = this.cosineSimilarity(options.vector!, row.vector);
      return {
        id: row.id,
        text: row.text,
        contentHash: row.content_hash,
        vector: row.vector,
        importance: row.importance,
        category: row.category,
        dataType: row.data_type,
        metadata: row.metadata,
        createdAt: new Date(row.created_at).getTime(),
        score: similarity,
      };
    });

    // 按相似度排序并返回前 N 条
    resultsWithScore.sort((a, b) => b.score - a.score);
    const limit = options.limit ?? 5;
    return resultsWithScore.slice(0, limit);
  }

  /**
   * 计算两个向量的余弦相似度
   */
  private cosineSimilarity(vecA: number[], vecB: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  async delete(ids: string[]): Promise<void> {
    await this.initialize();

    // 默认从 memories 表删除
    const { error } = await this.client!
      .from('memories')
      .delete()
      .in('id', ids);

    if (error) {
      throw new Error(`Failed to delete entries: ${error.message}`);
    }
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    await this.initialize();

    // 确定要操作的表
    const tableName = filter.tableName as TableName | undefined;
    const tables = tableName ? [tableName] : DEFAULT_TABLES;

    let totalDeleted = 0;

    for (const table of tables) {
      let query = this.client!.from(table).delete();

      // 应用过滤条件
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'tableName') {
          continue;
        } else if (key === 'dataType') {
          query = query.eq('data_type', value);
        } else if (key === 'createdAt' && typeof value === 'object' && value !== null) {
          // 支持时间范围过滤
          const opFilters = Object.entries(value as Record<string, number>);
          for (const [op, val] of opFilters) {
            const date = new Date(val).toISOString();
            switch (op) {
              case '$gt':
                query = query.gt('created_at', date);
                break;
              case '$gte':
                query = query.gte('created_at', date);
                break;
              case '$lt':
                query = query.lt('created_at', date);
                break;
              case '$lte':
                query = query.lte('created_at', date);
                break;
              case '$eq':
                query = query.eq('created_at', date);
                break;
            }
          }
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          query = query.eq(key, value);
        }
      }

      const { error, count } = await query;

      if (error) {
        console.error(`Failed to delete from ${table}:`, error.message);
        continue;
      }

      totalDeleted += count ?? 0;
    }

    return totalDeleted;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    await this.initialize();

    if (contentHashes.length === 0) {
      return [];
    }

    const existingHashes: string[] = [];

    // 在所有表中查找
    for (const table of DEFAULT_TABLES) {
      const { data, error } = await this.client!
        .from(table)
        .select('content_hash')
        .in('content_hash', contentHashes);

      if (error) {
        console.warn(`Failed to check hashes in ${table}:`, error.message);
        continue;
      }

      for (const row of data) {
        const hash = row.content_hash;
        if (!existingHashes.includes(hash)) {
          existingHashes.push(hash);
        }
      }
    }

    return existingHashes;
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    await this.initialize();

    // 指定了表名
    if (filter?.tableName) {
      const tableName = filter.tableName as TableName;
      return this.countByTable(tableName, filter);
    }

    // 所有表总计
    let totalCount = 0;
    for (const table of DEFAULT_TABLES) {
      totalCount += await this.countByTable(table, filter);
    }
    return totalCount;
  }

  /**
   * 按表统计数量
   */
  private async countByTable(tableName: TableName, filter?: Record<string, unknown>): Promise<number> {
    let query = this.client!.from(tableName).select('*', { count: 'exact', head: true });

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'tableName') {
          continue;
        } else if (key === 'dataType') {
          query = query.eq('data_type', value);
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          query = query.eq(key, value);
        }
      }
    }

    const { count, error } = await query;

    if (error) {
      console.warn(`Failed to count ${tableName}:`, error.message);
      return 0;
    }

    return count ?? 0;
  }

  async getTableNames(): Promise<TableName[]> {
    return [...DEFAULT_TABLES, ...this.extendedTables];
  }

  async getTableStats(): Promise<TableStats[]> {
    const stats: TableStats[] = [];

    // 统计所有表（包括扩展表）
    const allTables = [...DEFAULT_TABLES, ...this.extendedTables];
    for (const tableName of allTables) {
      const count = await this.count({ tableName });
      stats.push({
        name: tableName,
        count,
        dataType: tableName === "memories" ? "memory" : "knowledge",
      });
    }

    return stats;
  }
}
