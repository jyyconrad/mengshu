import { randomUUID } from "node:crypto";
import pg from "pg";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableName, TableStats, KnowledgeBaseConfig } from "../types";
import { vectorDimsForModel } from "../../../../../config.js";

const { Pool } = pg;

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];

/**
 * PostgreSQL + pgvector 数据库提供者实现
 * 使用原生 pg 库（Pool）进行连接管理
 */
export class PostgresProvider implements DatabaseProvider {
  private pool: pg.Pool | null = null;
  private readonly vectorDim: number;
  private extendedTables: TableName[] = [];

  constructor(
    private readonly pgConfig: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      ssl?: boolean | object;
    },
    private readonly embeddingModel: string,
    private readonly knowledgeBases?: KnowledgeBaseConfig,
  ) {
    this.vectorDim = vectorDimsForModel(embeddingModel);
    if (knowledgeBases?.enabled && knowledgeBases.builtinCategories) {
      const extended = knowledgeBases.builtinCategories.map((cat: string) => `knowledge_${cat}`);
      if (knowledgeBases.customCategories) {
        extended.push(...knowledgeBases.customCategories.map((cat: string) => `knowledge_${cat}`));
      }
      this.extendedTables = extended as TableName[];
    }
  }

  async initialize(): Promise<void> {
    if (this.pool) {
      return;
    }

    this.pool = new Pool({
      host: this.pgConfig.host,
      port: this.pgConfig.port,
      database: this.pgConfig.database,
      user: this.pgConfig.user,
      password: this.pgConfig.password,
      ssl: this.pgConfig.ssl || undefined,
    });

    // 启用 pgvector 扩展
    await this.pool.query("CREATE EXTENSION IF NOT EXISTS vector");

    // 创建默认表
    for (const tableName of DEFAULT_TABLES) {
      await this.createTableIfNotExists(tableName);
    }

    // 创建扩展知识库表
    if (this.knowledgeBases?.enabled && this.knowledgeBases.autoCreateTables) {
      for (const tableName of this.extendedTables) {
        await this.createTableIfNotExists(tableName);
      }
    }
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
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

    for (const [tableName, tableEntries] of entriesByTable.entries()) {
      await this.insertEntries(tableName, tableEntries);
    }
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    await this.initialize();

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

      allResults.sort((a, b) => b.score - a.score);
      if (options.limit) {
        return allResults.slice(0, options.limit);
      }
      return allResults;
    }

    const tableName = options.tableName ?? this.getDefaultTableName(options.dataTypes?.[0]);
    return this.queryFromTable(tableName, options);
  }

  async delete(ids: string[]): Promise<void> {
    await this.initialize();

    if (ids.length === 0) return;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    await this.pool!.query(
      `DELETE FROM memories WHERE id IN (${placeholders})`,
      ids,
    );
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    await this.initialize();

    const tableName = filter.tableName as TableName | undefined;
    const tables = tableName ? [tableName] : DEFAULT_TABLES;

    let totalDeleted = 0;

    for (const table of tables) {
      const { conditions, params } = this.buildFilterConditions(filter, ["tableName"]);

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const result = await this.pool!.query(
        `DELETE FROM ${this.escapeIdentifier(table)} ${whereClause}`,
        params,
      );

      totalDeleted += result.rowCount ?? 0;
    }

    return totalDeleted;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    await this.initialize();

    if (contentHashes.length === 0) return [];

    const existingHashes: string[] = [];

    for (const table of DEFAULT_TABLES) {
      const placeholders = contentHashes.map((_, i) => `$${i + 1}`).join(", ");
      const { rows } = await this.pool!.query(
        `SELECT content_hash FROM ${this.escapeIdentifier(table)} WHERE content_hash IN (${placeholders})`,
        contentHashes,
      );

      for (const row of rows) {
        if (!existingHashes.includes(row.content_hash)) {
          existingHashes.push(row.content_hash);
        }
      }
    }

    return existingHashes;
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    await this.initialize();

    if (filter?.tableName) {
      return this.countByTable(filter.tableName as TableName, filter);
    }

    let total = 0;
    for (const table of DEFAULT_TABLES) {
      total += await this.countByTable(table, filter);
    }
    return total;
  }

  async getTableNames(): Promise<TableName[]> {
    return [...DEFAULT_TABLES, ...this.extendedTables];
  }

  async ensureTable(tableName: TableName): Promise<void> {
    await this.createTableIfNotExists(tableName);
  }

  async getTableStats(): Promise<TableStats[]> {
    const stats: TableStats[] = [];
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

  // ============================================================================
  // 私有方法
  // ============================================================================

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
   * 转义 SQL 标识符，防止注入
   * 只允许字母、数字、下划线
   */
  private escapeIdentifier(name: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
      throw new Error(`Invalid identifier: ${name}`);
    }
    return `"${name}"`;
  }

  private async createTableIfNotExists(tableName: TableName): Promise<void> {
    const escaped = this.escapeIdentifier(tableName);
    const defaultImportance = tableName === "memories" ? "0.7" : "0.5";
    const defaultDataType = tableName === "memories" ? "memory" : "knowledge";

    await this.pool!.query(`
      CREATE TABLE IF NOT EXISTS ${escaped} (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        text TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        vector vector(${this.vectorDim}) NOT NULL,
        importance FLOAT NOT NULL DEFAULT ${defaultImportance},
        category TEXT NOT NULL DEFAULT 'other',
        data_type TEXT NOT NULL DEFAULT '${defaultDataType}',
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);

    // 创建索引（忽略已存在错误）
    const indexQueries = [
      `CREATE INDEX IF NOT EXISTS ${tableName}_vector_idx ON ${escaped} USING ivfflat (vector vector_cosine_ops) WITH (lists = 100)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${tableName}_content_hash_idx ON ${escaped} (content_hash)`,
      `CREATE INDEX IF NOT EXISTS ${tableName}_data_type_idx ON ${escaped} (data_type)`,
      `CREATE INDEX IF NOT EXISTS ${tableName}_created_at_idx ON ${escaped} (created_at DESC)`,
    ];

    for (const sql of indexQueries) {
      try {
        await this.pool!.query(sql);
      } catch (err: any) {
        // ivfflat 索引在表为空时可能无法创建，忽略此错误
        if (!err.message?.includes("already exists")) {
          console.warn(`Index creation warning for ${tableName}:`, err.message);
        }
      }
    }
  }

  private async insertEntries(tableName: TableName, entries: MemoryEntry[]): Promise<void> {
    const escaped = this.escapeIdentifier(tableName);

    for (const entry of entries) {
      const id = entry.id || randomUUID();
      const vectorStr = `[${entry.vector.join(",")}]`;
      const createdAt = new Date(entry.createdAt || Date.now()).toISOString();

      await this.pool!.query(
        `INSERT INTO ${escaped} (id, text, content_hash, vector, importance, category, data_type, metadata, created_at)
         VALUES ($1, $2, $3, $4::vector, $5, $6, $7, $8::jsonb, $9)
         ON CONFLICT (content_hash) DO NOTHING`,
        [
          id,
          entry.text,
          entry.contentHash,
          vectorStr,
          entry.importance,
          entry.category,
          entry.dataType,
          JSON.stringify(entry.metadata),
          createdAt,
        ],
      );
    }
  }

  private async queryFromTable(
    tableName: TableName,
    options: MemoryQueryOptions,
  ): Promise<(MemoryEntry & { score: number })[]> {
    const escaped = this.escapeIdentifier(tableName);

    if (options.vector) {
      return this.queryWithVector(escaped, tableName, options);
    }

    // 非向量查询
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (options.dataTypes && options.dataTypes.length > 0) {
      const placeholders = options.dataTypes.map((_, i) => `$${paramIdx + i}`).join(", ");
      conditions.push(`data_type IN (${placeholders})`);
      params.push(...options.dataTypes);
      paramIdx += options.dataTypes.length;
    }

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          conditions.push(`metadata->>'${key}' = $${paramIdx}`);
          params.push(String(value));
          paramIdx++;
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = options.limit ? `LIMIT $${paramIdx}` : "";
    if (options.limit) params.push(options.limit);

    const { rows } = await this.pool!.query(
      `SELECT * FROM ${escaped} ${whereClause} ORDER BY created_at DESC ${limitClause}`,
      params,
    );

    return rows.map((row) => this.rowToEntry(row, 0));
  }

  private async queryWithVector(
    escapedTable: string,
    _tableName: TableName,
    options: MemoryQueryOptions,
  ): Promise<(MemoryEntry & { score: number })[]> {
    const vectorStr = `[${options.vector!.join(",")}]`;
    const conditions: string[] = [];
    const params: unknown[] = [vectorStr];
    let paramIdx = 2;

    if (options.dataTypes && options.dataTypes.length > 0) {
      const placeholders = options.dataTypes.map((_, i) => `$${paramIdx + i}`).join(", ");
      conditions.push(`data_type IN (${placeholders})`);
      params.push(...options.dataTypes);
      paramIdx += options.dataTypes.length;
    }

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          conditions.push(`metadata->>'${key}' = $${paramIdx}`);
          params.push(String(value));
          paramIdx++;
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = options.limit ?? 5;
    params.push(limit);

    const { rows } = await this.pool!.query(
      `SELECT *, 1 - (vector <=> $1::vector) AS similarity
       FROM ${escapedTable}
       ${whereClause}
       ORDER BY vector <=> $1::vector
       LIMIT $${paramIdx}`,
      params,
    );

    const minScore = options.minScore ?? 0;
    return rows
      .map((row) => this.rowToEntry(row, row.similarity))
      .filter((entry) => entry.score >= minScore);
  }

  private rowToEntry(row: any, score: number): MemoryEntry & { score: number } {
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
      score,
    };
  }

  /**
   * 构建过滤条件（用于 deleteByFilter）
   */
  private buildFilterConditions(
    filter: Record<string, unknown>,
    skipKeys: string[],
  ): { conditions: string[]; params: unknown[] } {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const [key, value] of Object.entries(filter)) {
      if (skipKeys.includes(key)) continue;

      if (key === "dataType") {
        conditions.push(`data_type = $${paramIdx}`);
        params.push(value);
        paramIdx++;
      } else if (key === "createdAt" && typeof value === "object" && value !== null) {
        for (const [op, val] of Object.entries(value as Record<string, number>)) {
          const date = new Date(val).toISOString();
          switch (op) {
            case "$gt":
              conditions.push(`created_at > $${paramIdx}`);
              break;
            case "$gte":
              conditions.push(`created_at >= $${paramIdx}`);
              break;
            case "$lt":
              conditions.push(`created_at < $${paramIdx}`);
              break;
            case "$lte":
              conditions.push(`created_at <= $${paramIdx}`);
              break;
            case "$eq":
              conditions.push(`created_at = $${paramIdx}`);
              break;
            default:
              continue;
          }
          params.push(date);
          paramIdx++;
        }
      } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        conditions.push(`${this.escapeIdentifier(key)} = $${paramIdx}`);
        params.push(value);
        paramIdx++;
      }
    }

    return { conditions, params };
  }

  private async countByTable(tableName: TableName, filter?: Record<string, unknown>): Promise<number> {
    const escaped = this.escapeIdentifier(tableName);
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === "tableName") continue;
        if (key === "dataType") {
          conditions.push(`data_type = $${paramIdx}`);
          params.push(value);
          paramIdx++;
        } else if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          conditions.push(`${this.escapeIdentifier(key)} = $${paramIdx}`);
          params.push(value);
          paramIdx++;
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.pool!.query(
      `SELECT COUNT(*)::int AS count FROM ${escaped} ${whereClause}`,
      params,
    );

    return rows[0]?.count ?? 0;
  }
}
