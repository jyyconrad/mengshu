import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableName, TableStats, KnowledgeBaseConfig } from "../types";
import { vectorDimsForModel } from "../../config";

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

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];

/**
 * LanceDB 数据库提供者实现
 */
export class LanceDBProvider implements DatabaseProvider {
  private db: LanceDB.Connection | null = null;
  private tables: Map<TableName, LanceDB.Table> = new Map();
  private initPromise: Promise<void> | null = null;
  private extendedTables: TableName[] = [];

  constructor(
    private readonly dbPath: string,
    private readonly embeddingModel: string,
    private readonly knowledgeBases?: KnowledgeBaseConfig,
  ) {
    // 初始化扩展表列表
    if (knowledgeBases?.enabled && knowledgeBases.builtinCategories) {
      this.extendedTables = knowledgeBases.builtinCategories.map((cat: string) => `knowledge_${cat}` as TableName);
      if (knowledgeBases.customCategories) {
        this.extendedTables.push(...knowledgeBases.customCategories.map((cat: string) => `knowledge_${cat}` as TableName));
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.tables.size > 0) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const lancedb = await loadLanceDB();
    const vectorDim = vectorDimsForModel(this.embeddingModel);

    this.db = await lancedb.connect(this.dbPath);
    const existingTables = await this.db.tableNames();

    // 初始化默认表
    for (const tableName of DEFAULT_TABLES) {
      if (existingTables.includes(tableName)) {
        const table = await this.db.openTable(tableName);
        this.tables.set(tableName, table);
      } else {
        const table = await this.db.createTable(tableName, [
          {
            id: "__schema__",
            text: "",
            contentHash: "",
            vector: Array.from({ length: vectorDim }).fill(0),
            importance: 0,
            category: "other",
            dataType: "memory",
            metadata: "",  // 使用空字符串而非空对象，让 LanceDB 推断为字符串类型
            createdAt: 0,
          },
        ]);
        await table.delete('id = "__schema__"');
        this.tables.set(tableName, table);
      }
    }

    // 初始化扩展知识库表（如果启用了知识库功能）
    if (this.knowledgeBases?.enabled && this.knowledgeBases.autoCreateTables) {
      for (const tableName of this.extendedTables) {
        if (existingTables.includes(tableName)) {
          const table = await this.db.openTable(tableName);
          this.tables.set(tableName, table);
        } else {
          const table = await this.db.createTable(tableName, [
            {
              id: "__schema__",
              text: "",
              contentHash: "",
              vector: Array.from({ length: vectorDim }).fill(0),
              importance: 0,
              category: "other",
              dataType: "knowledge",
              metadata: "",  // 使用空字符串而非空对象
              createdAt: 0,
            },
          ]);
          await table.delete('id = "__schema__"');
          this.tables.set(tableName, table);
        }
      }
    }
  }

  async close(): Promise<void> {
    // LanceDB doesn't require explicit closing
    this.db = null;
    this.tables.clear();
    this.initPromise = null;
  }

  /**
   * 获取默认表名（根据 dataType 决定）
   */
  private getDefaultTableName(dataType?: string): TableName {
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

  /**
   * 获取或创建表
   */
  private async getTable(tableName?: TableName): Promise<LanceDB.Table> {
    await this.initialize();
    const targetTable = tableName || "memories";

    if (this.tables.has(targetTable)) {
      return this.tables.get(targetTable)!;
    }

    // 表不存在，创建新表
    const lancedb = await loadLanceDB();
    const vectorDim = vectorDimsForModel(this.embeddingModel);
    const table = await this.db!.createTable(targetTable, [
      {
        id: "__schema__",
        text: "",
        contentHash: "",
        vector: Array.from({ length: vectorDim }).fill(0),
        importance: 0,
        category: "other",
        dataType: "memory",
        metadata: "",  // 使用空字符串而非空对象
        createdAt: 0,
      },
    ]);
    await table.delete('id = "__schema__"');
    this.tables.set(targetTable, table);
    return table;
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
    const storePromises = Array.from(entriesByTable.entries()).map(async ([tableName, tableEntries]) => {
      const table = await this.getTable(tableName);
      const entriesWithId = tableEntries.map(entry => {
        const { tableName: _tableName, ...entryData } = entry;  // 移除 tableName 字段
        return {
          ...entryData,
          id: entry.id || randomUUID(),
          createdAt: entry.createdAt || Date.now(),
          metadata: JSON.stringify(entry.metadata || {}),  // 将 metadata 序列化为 JSON 字符串
        };
      });
      await table.add(entriesWithId);
    });

    await Promise.all(storePromises);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    await this.initialize();

    // 跨所有表搜索
    if (options.searchAll) {
      const allResults: Array<MemoryEntry & { score: number }> = [];
      const tableNames = await this.getTableNames();

      for (const tableName of tableNames) {
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
    const table = await this.getTable(tableName);
    let results: any[];

    // 向量搜索
    if (options.vector) {
      let vectorQuery = table.vectorSearch(options.vector);

      // 过滤条件
      const filters: string[] = [];

      // 数据类型过滤
      if (options.dataTypes && options.dataTypes.length > 0) {
        const dataTypeFilters = options.dataTypes.map(dt => `dataType = '${dt}'`);
        filters.push(`(${dataTypeFilters.join(" OR ")})`);
      }

      // 元数据过滤
      if (options.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          if (typeof value === "string") {
            filters.push(`metadata.${key} = '${value.replace(/'/g, "''")}'`);
          } else if (typeof value === "number" || typeof value === "boolean") {
            filters.push(`metadata.${key} = ${value}`);
          }
        }
      }

      if (filters.length > 0) {
        vectorQuery = vectorQuery.filter(filters.join(" AND "));
      }

      // 限制结果数量
      if (options.limit) {
        vectorQuery = vectorQuery.limit(options.limit);
      }

      results = await vectorQuery.toArray();
    } else {
      // 非向量搜索
      let queryBuilder = table.query();

      // 过滤条件
      const filters: string[] = [];

      // 数据类型过滤
      if (options.dataTypes && options.dataTypes.length > 0) {
        const dataTypeFilters = options.dataTypes.map(dt => `dataType = '${dt}'`);
        filters.push(`(${dataTypeFilters.join(" OR ")})`);
      }

      // 元数据过滤
      if (options.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          if (typeof value === "string") {
            filters.push(`metadata.${key} = '${value.replace(/'/g, "''")}'`);
          } else if (typeof value === "number" || typeof value === "boolean") {
            filters.push(`metadata.${key} = ${value}`);
          }
        }
      }

      if (filters.length > 0) {
        queryBuilder = queryBuilder.filter(filters.join(" AND "));
      }

      // 限制结果数量
      if (options.limit) {
        queryBuilder = queryBuilder.limit(options.limit);
      }

      results = await queryBuilder.toArray();
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
        score,
      };
    });

    // 应用最小分数过滤
    const minScore = options.minScore ?? 0;
    return mapped.filter((r) => r.score >= minScore);
  }

  async getTableNames(): Promise<TableName[]> {
    await this.initialize();
    return Array.from(this.tables.keys());
  }

  async ensureTable(tableName: TableName): Promise<void> {
    await this.getTable(tableName);
  }

  async getTableStats(): Promise<TableStats[]> {
    await this.initialize();
    const stats: TableStats[] = [];

    for (const [tableName, table] of this.tables.entries()) {
      const count = await table.countRows();
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
    const lancedb = await loadLanceDB();
    const vectorDim = vectorDimsForModel(this.embeddingModel);

    for (const category of categories) {
      const tableName = `knowledge_${category}` as TableName;
      // 添加到扩展表列表
      if (!this.extendedTables.includes(tableName)) {
        this.extendedTables.push(tableName);
      }

      // 如果表不存在，创建它
      if (!this.tables.has(tableName)) {
        const existingTables = await this.db!.tableNames();
        if (existingTables.includes(tableName)) {
          const table = await this.db!.openTable(tableName);
          this.tables.set(tableName, table);
        } else {
          const table = await this.db!.createTable(tableName, [
            {
              id: "__schema__",
              text: "",
              contentHash: "",
              vector: Array.from({ length: vectorDim }).fill(0),
              importance: 0,
              category: "other",
              dataType: "knowledge",
              metadata: {},
              createdAt: 0,
            },
          ]);
          await table.delete('id = "__schema__"');
          this.tables.set(tableName, table);
        }
      }
    }
  }

  async delete(ids: string[]): Promise<void> {
    await this.initialize();

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
      const table = await this.getTable(tableName);
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const validIds = tableIds.filter(id => uuidRegex.test(id));

      if (validIds.length === 0) {
        continue;
      }

      const idFilters = validIds.map(id => `id = '${id}'`);
      await table.delete(idFilters.join(" OR "));
    }
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    await this.initialize();

    // 确定要操作的表
    const tableName = filter.tableName as TableName | undefined;
    const tables = tableName ? [await this.getTable(tableName)] : Array.from(this.tables.values());

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
      await table.delete(filters.join(" AND "));
      totalDeleted += countBefore;
    }

    return totalDeleted;
  }

  /**
   * 按表统计过滤后的数量
   */
  private async countByTable(table: LanceDB.Table, filter?: Record<string, unknown>): Promise<number> {
    if (!filter || Object.keys(filter).length === 0) {
      return table.countRows();
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

    const results = await queryBuilder.select("id").toArray();
    return results.length;
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    await this.initialize();

    if (contentHashes.length === 0) {
      return [];
    }

    const existingHashes: string[] = [];

    // 在所有表中查找
    for (const table of this.tables.values()) {
      const hashFilters = contentHashes.map(hash => `contentHash = '${hash.replace(/'/g, "''")}'`);
      const results = await table
        .query()
        .filter(hashFilters.join(" OR "))
        .select("contentHash")
        .toArray();

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
    await this.initialize();

    // 指定了表名
    if (filter?.tableName) {
      const tableName = filter.tableName as TableName;
      const table = await this.getTable(tableName);
      return this.countByTable(table, filter);
    }

    // 所有表总计
    let totalCount = 0;
    for (const table of this.tables.values()) {
      totalCount += await this.countByTable(table, filter);
    }
    return totalCount;
  }
}
