import { randomUUID } from "node:crypto";
import type * as LanceDB from "@lancedb/lancedb";
import type { DatabaseProvider, MemoryEntry, MemoryQueryOptions, TableName, TableStats, KnowledgeBaseConfig } from "../types";
import { vectorDimsForModel } from "../../../../../config.js";

/**
 * Scope 维度列（D-25 / T3）的 sentinel 值。
 *
 * LanceDB Node SDK 通过种子记录推断 Arrow schema，nullable Utf8 列使用空串
 * 作为 sentinel（与 `metadata: ""` 一致）。写入时把 undefined/null 归一成 ""，
 * 读回时再把 "" 还原成 undefined，保持 MemoryEntry 上层语义。
 */
const SCOPE_NULL_SENTINEL = "";

const escapeSqlString = (value: string): string => value.replace(/'/g, "''");

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

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];

/**
 * LanceDB 数据库提供者实现。
 *
 * Scope 维度列（D-25 / T3）支持：
 * - project_name / app_name / user_id / agent_id / workspace_id 以独立 Utf8
 *   列存储，替代「全部塞 metadata.*」的旧路径，让项目/产品维度过滤走列查询。
 * - 写入时把 MemoryEntry 上的 scope 字段映射为列；undefined/null 走
 *   SCOPE_NULL_SENTINEL（空串）保持 schema 兼容。
 * - 读回时通过 denormalizeScopeValue 把空串还原成 undefined。
 * - query 方法支持 projectName/appName 精确过滤与 projectPattern LIKE 相似检索。
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
    };
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
        const table = await this.db.createTable(tableName, [this.buildSchemaSeed(vectorDim, "memory")]);
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
          const table = await this.db.createTable(tableName, [this.buildSchemaSeed(vectorDim, "knowledge")]);
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
    const table = await this.db!.createTable(targetTable, [this.buildSchemaSeed(vectorDim, "memory")]);
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
        // 移除 tableName 字段（仅运行时路由用），并把 entry 上的 scope 字段
        // 显式映射为列；这些字段不会进入 metadata JSON。
        const {
          tableName: _tableName,
          projectName,
          appName,
          userId,
          agentId,
          workspaceId,
          ...entryData
        } = entry;
        return {
          ...entryData,
          id: entry.id || randomUUID(),
          createdAt: entry.createdAt || Date.now(),
          metadata: JSON.stringify(entry.metadata || {}),  // 将 metadata 序列化为 JSON 字符串
          // Scope 维度列（D-25 / T3）
          project_name: normalizeScopeValue(projectName),
          app_name: normalizeScopeValue(appName),
          user_id: normalizeScopeValue(userId),
          agent_id: normalizeScopeValue(agentId),
          workspace_id: normalizeScopeValue(workspaceId),
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

    // 构造 scope 维度列过滤条件（D-25 / T3）。
    // projectName/appName 走精确等值；projectPattern 走 LIKE 模糊匹配，
    // 与 filterProject 互斥（由上层 service 决定，这里只透传）。
    const scopeFilters: string[] = [];
    if (typeof options.projectName === "string" && options.projectName) {
      scopeFilters.push(`project_name = '${escapeSqlString(options.projectName)}'`);
    }
    if (typeof options.appName === "string" && options.appName) {
      scopeFilters.push(`app_name = '${escapeSqlString(options.appName)}'`);
    }
    if (typeof options.projectPattern === "string" && options.projectPattern) {
      scopeFilters.push(`project_name LIKE '${escapeSqlString(options.projectPattern)}'`);
    }

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

      // Scope 维度列过滤（独立列，不走 metadata.*）
      filters.push(...scopeFilters);

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

      // Scope 维度列过滤（独立列，不走 metadata.*）
      filters.push(...scopeFilters);

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
        // Scope 维度列还原（空串视作未设置）
        projectName: denormalizeScopeValue(row.project_name),
        appName: denormalizeScopeValue(row.app_name),
        userId: denormalizeScopeValue(row.user_id),
        agentId: denormalizeScopeValue(row.agent_id),
        workspaceId: denormalizeScopeValue(row.workspace_id),
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
          const table = await this.db!.createTable(tableName, [this.buildSchemaSeed(vectorDim, "knowledge")]);
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
