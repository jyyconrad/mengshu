/**
 * Supabase 数据库提供者实现。
 *
 * D-25 scope 维度列支持（v1.0.3）：
 * - 表新增独立列 tenant_id / project_name / app_name / user_id / agent_id / workspace_id，
 *   把 scope 维度真正落库，使项目/产品特有记忆与通用记忆可区分。
 * - store 写入时把 MemoryEntry 的 scope 维度映射到对应列。
 * - query（向量搜索）通过 match_* RPC 的 filter_project_name / filter_app_name
 *   参数下推硬过滤；读回路径把列值还原到 MemoryEntry。
 * - legacy scope 列可为 NULL；tenant_id/user_id 为 NULL 的历史记录在 authority recall
 *   中 fail-closed 不可见，不允许回填成当前调用方。
 *
 * RPC 与建表 SQL 见 scripts/sql/migrate-scope-columns-supabase.sql，
 * 需在 Supabase Dashboard 手动执行。
 */
import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type {
  DatabaseProvider,
  DatabaseStoreRecordResult,
  DatabaseStoreResult,
  MemoryEntry,
  MemoryQueryOptions,
  TableName,
  TableStats,
  KnowledgeBaseConfig,
} from "../types.js";
import { vectorDimsForModel } from "../../../../../config.js";
import { assertSafeLegacyDeleteFilter } from "./legacy-delete-filter-guard.js";

const DEFAULT_TABLES: TableName[] = ["memories", "knowledge"];
const SAFE_AUTHORITY_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;

class SupabaseStoreError extends Error {
  constructor(
    readonly code: "SUPABASE_STORE_FAILED" | "SCHEMA_CONTRACT_PENDING" | "STORE_OUTCOME_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "SupabaseStoreError";
  }
}

function requireStoreScope(entry: MemoryEntry): void {
  for (const [field, value] of Object.entries({
    tenantId: entry.tenantId,
    userId: entry.userId,
    canonicalProjectId: entry.canonicalProjectId,
    productId: entry.productId,
    producerId: entry.producerId,
    namespace: entry.namespace,
    visibility: entry.visibility,
  })) {
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new SupabaseStoreError("STORE_OUTCOME_INVALID", `Supabase store scope field is invalid: ${field}`);
    }
  }
}

type RecallAuthority = Readonly<{ tenantId: string; userId: string }>;

function recallAuthority(options: MemoryQueryOptions): RecallAuthority | undefined {
  const hasTenant = options.tenantId !== undefined;
  const hasUser = options.userId !== undefined;
  if (hasTenant !== hasUser) {
    throw new Error("Supabase recall tenant/user authority must be provided together");
  }
  if (!hasTenant) return undefined;
  if (!SAFE_AUTHORITY_IDENTIFIER.test(options.tenantId!) ||
      !SAFE_AUTHORITY_IDENTIFIER.test(options.userId!)) {
    throw new Error("Supabase recall authority identifier is invalid");
  }
  return Object.freeze({ tenantId: options.tenantId!, userId: options.userId! });
}

function exactAuthorityRows<T extends MemoryEntry & { score: number }>(
  rows: readonly T[],
  authority: RecallAuthority | undefined,
  limit?: number,
): T[] {
  const authorized = authority
    ? rows.filter((row) => row.tenantId === authority.tenantId && row.userId === authority.userId)
    : [...rows];
  return limit === undefined ? authorized : authorized.slice(0, limit);
}

/**
 * Supabase memories/knowledge 表行结构。
 *
 * 新增 scope 维度列（nullable，NULL 表示全局/通用记忆）。
 */
interface SupabaseMemoryRow {
  id: string;
  text: string;
  content_hash: string;
  vector: number[];
  importance: number;
  category: string;
  data_type: string;
  metadata: Record<string, unknown>;
  created_at: string;
  // scope 维度列（D-25）
  project_name?: string | null;
  app_name?: string | null;
  user_id?: string | null;
  agent_id?: string | null;
  workspace_id?: string | null;
  tenant_id?: string | null;
  canonical_project_id?: string | null;
  product_id?: string | null;
  producer_id?: string | null;
  namespace?: string | null;
  visibility?: MemoryEntry["visibility"] | null;
  lifecycle_status?: MemoryEntry["lifecycleStatus"] | null;
}

/**
 * 允许在 DDL 中拼接的表名白名单（含前缀模式）。
 *
 * 安全约束：`ensureTableExists` 会把表名直接拼进 CREATE TABLE / CREATE INDEX
 * 语句，TS 类型层面虽然有 TableName 限制，但运行时若调用方传入未净化的字符串
 * （例如带分号、空格或 SQL 关键字），仍可能造成 SQL 注入。这里在运行时通过严格
 * 正则白名单进行二次校验：
 *   - 固定表名：memories / knowledge
 *   - 动态知识库表：以 knowledge_ 为前缀，后缀只允许 [a-z][a-z0-9_]{0,63}
 * 任何不匹配的表名都会立即抛错并阻止 DDL 执行。
 */
export const ALLOWED_TABLE_NAME_RE = /^(memories|knowledge|knowledge_[a-z][a-z0-9_]{0,63})$/;

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
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            -- scope 维度列（D-25）：NULL 表示全局/通用记忆
            project_name TEXT,
            app_name TEXT,
            user_id TEXT,
            agent_id TEXT,
            workspace_id TEXT,
            tenant_id TEXT,
            canonical_project_id TEXT,
            product_id TEXT,
            producer_id TEXT,
            namespace TEXT,
            visibility TEXT,
            lifecycle_status TEXT
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

          -- scope 维度索引（加速按项目/产品过滤）
          CREATE INDEX IF NOT EXISTS idx_${tableName}_project_name ON ${tableName} (project_name);
          CREATE INDEX IF NOT EXISTS idx_${tableName}_app_name ON ${tableName} (app_name);
          CREATE INDEX IF NOT EXISTS idx_${tableName}_tenant_user ON ${tableName} (tenant_id, user_id);
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

  async store(entries: MemoryEntry[]): Promise<DatabaseStoreResult> {
    await this.initialize();

    // 按表名分组
    const entriesByTable = new Map<TableName, MemoryEntry[]>();
    for (const entry of entries) {
      const tableName = entry.tableName ?? this.getDefaultTableName(entry.dataType);
      const existing = entriesByTable.get(tableName) || [];
      existing.push(entry);
      entriesByTable.set(tableName, existing);
    }

    for (const entry of entries) requireStoreScope(entry);

    const records: DatabaseStoreRecordResult[] = [];
    // Supabase/PostgREST 旧 schema 仍以 global content_hash 仲裁。逐条写入是为了
    // 对每个 ignore-duplicate 精确解析 persisted ID，不能把 void 当作成功。
    for (const [tableName, tableEntries] of entriesByTable.entries()) {
      for (const entry of tableEntries) {
        const requestedId = entry.id || randomUUID();
        const row = {
          id: requestedId,
          text: entry.text,
          content_hash: entry.contentHash,
          vector: entry.vector,
          importance: entry.importance,
          category: entry.category,
          data_type: entry.dataType,
          metadata: entry.metadata,
          created_at: new Date(entry.createdAt || Date.now()).toISOString(),
          project_name: entry.projectName ?? null,
          app_name: entry.appName ?? null,
          user_id: entry.userId,
          agent_id: entry.agentId ?? null,
          workspace_id: entry.workspaceId ?? null,
          tenant_id: entry.tenantId,
          canonical_project_id: entry.canonicalProjectId,
          product_id: entry.productId,
          producer_id: entry.producerId,
          namespace: entry.namespace,
          visibility: entry.visibility,
          lifecycle_status: entry.lifecycleStatus ?? null,
        };
        const { data, error } = await this.client!
          .from(tableName)
          .upsert([row], { onConflict: "content_hash", ignoreDuplicates: true })
          .select("id, content_hash");
        if (error) {
          throw new SupabaseStoreError("SUPABASE_STORE_FAILED", "Supabase durable store failed");
        }
        if (data?.length === 1 && typeof data[0]?.id === "string") {
          records.push({ requestedId, persistedId: data[0].id, stored: true });
          continue;
        }
        if (data && data.length > 0) {
          throw new SupabaseStoreError("STORE_OUTCOME_INVALID", "Supabase insert returned an invalid outcome");
        }

        const duplicate = await this.client!
          .from(tableName)
          .select("id, content_hash")
          .eq("tenant_id", entry.tenantId!)
          .eq("user_id", entry.userId!)
          .eq("canonical_project_id", entry.canonicalProjectId!)
          .eq("product_id", entry.productId!)
          .eq("producer_id", entry.producerId!)
          .eq("namespace", entry.namespace!)
          .eq("visibility", entry.visibility!)
          .eq("content_hash", entry.contentHash)
          .limit(2);
        if (duplicate.error) {
          throw new SupabaseStoreError("SUPABASE_STORE_FAILED", "Supabase duplicate resolution failed");
        }
        if (duplicate.data?.length !== 1 || typeof duplicate.data[0]?.id !== "string") {
          throw new SupabaseStoreError(
            "SCHEMA_CONTRACT_PENDING",
            "Supabase global content hash conflict is outside the requested authority",
          );
        }
        records.push({ requestedId, persistedId: duplicate.data[0].id, stored: false });
      }
    }
    const inserted = records.filter((record) => record.stored).length;
    return { inserted, duplicates: records.length - inserted, records };
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    // 纯合同验证必须在 initialize/network 之前完成。
    recallAuthority(options);
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

    const authority = recallAuthority(options);
    if (authority) {
      query = query.eq('tenant_id', authority.tenantId);
      query = query.eq('user_id', authority.userId);
    }

    // 数据类型过滤
    if (options.dataTypes && options.dataTypes.length > 0) {
      query = query.in('data_type', options.dataTypes);
    }

    // 元数据过滤
    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (key === 'id' && Array.isArray(value) && value.every((id) => typeof id === 'string')) {
          query = query.in('id', value);
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          query = query.eq(`metadata->>${key}`, value);
        }
      }
    }

    // scope 维度硬过滤（D-25）：非向量查询也支持按项目/产品精确筛选
    if (options.projectName) {
      query = query.eq('project_name', options.projectName);
    }
    if (options.appName) {
      query = query.eq('app_name', options.appName);
    }

    // 限制结果数量
    if (options.limit) {
      query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Failed to query entries: ${error.message}`);
    }

    const rows = data.map(row => ({
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
      // scope 维度读回（D-25）
      projectName: row.project_name ?? undefined,
      appName: row.app_name ?? undefined,
      userId: row.user_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      canonicalProjectId: row.canonical_project_id ?? undefined,
      productId: row.product_id ?? undefined,
      producerId: row.producer_id ?? undefined,
      namespace: row.namespace ?? undefined,
      visibility: row.visibility ?? undefined,
      lifecycleStatus: row.lifecycle_status ?? undefined,
    }));
    return exactAuthorityRows(rows, authority, options.limit);
  }

  /**
   * 使用向量进行搜索（通过 Supabase RPC）
   */
  private async queryWithVector(tableName: TableName, options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const authority = recallAuthority(options);
    // 使用 Supabase 的 rpc 方法进行向量搜索，避免 URL 过长
    const { data, error } = await this.client!.rpc(`match_${tableName}`, {
      query_embedding: options.vector,
      match_count: options.limit ?? 5,
      min_similarity: options.minScore ?? 0.1,
      filter_data_type: options.dataTypes && options.dataTypes.length > 0 ? options.dataTypes : null,
      // scope 维度过滤参数（D-25）：NULL 时不过滤，保持跨项目软召回
      filter_project_name: options.projectName ?? null,
      filter_app_name: options.appName ?? null,
      filter_tenant_id: authority?.tenantId ?? null,
      filter_user_id: authority?.userId ?? null,
    });

    if (error) {
      console.warn(`RPC function match_${tableName} failed:`, error.message, '- falling back to direct query');
      // 任何错误都回退到直接查询（不仅是 function/RPC 错误）
      return this.queryWithVectorFallback(tableName, options);
    }

    const rows = (data || []).map((row: any) => ({
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
      // scope 维度读回（D-25）：RPC 返回列已包含
      projectName: row.project_name ?? undefined,
      appName: row.app_name ?? undefined,
      userId: row.user_id ?? undefined,
      agentId: row.agent_id ?? undefined,
      workspaceId: row.workspace_id ?? undefined,
      tenantId: row.tenant_id ?? undefined,
      canonicalProjectId: row.canonical_project_id ?? undefined,
      productId: row.product_id ?? undefined,
      producerId: row.producer_id ?? undefined,
      namespace: row.namespace ?? undefined,
      visibility: row.visibility ?? undefined,
      lifecycleStatus: row.lifecycle_status ?? undefined,
    }));
    return exactAuthorityRows(rows, authority, options.limit);
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
      let query = this.client!
        .from(tableName)
        .select(`*, 1 - (vector <=> '${vectorString}')::float as similarity`);

      const authority = recallAuthority(options);
      if (authority) {
        query = query.eq('tenant_id', authority.tenantId);
        query = query.eq('user_id', authority.userId);
      }

      // 数据类型过滤
      if (options.dataTypes && options.dataTypes.length > 0) {
        query = query.in('data_type', options.dataTypes);
      }

      if (options.filter) {
        for (const [key, value] of Object.entries(options.filter)) {
          if (key === 'id' && Array.isArray(value) && value.every((id) => typeof id === 'string')) {
            query = query.in('id', value);
          } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            query = query.eq(`metadata->>${key}`, value);
          }
        }
      }

      // scope 维度硬过滤（D-25）：RPC 回退路径也需保持过滤语义一致
      if (options.projectName) {
        query = query.eq('project_name', options.projectName);
      }
      if (options.appName) {
        query = query.eq('app_name', options.appName);
      }

      query = query.limit(options.limit ?? 5);

      // @ts-ignore - Supabase TypeScript limitation for computed fields
      const { data, error } = await query;

      if (error) {
        throw new Error(`Failed to query entries: ${error.message}`);
      }

      const rows = (data || []).map((row: any) => ({
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
        // scope 维度读回（D-25）
        projectName: row.project_name ?? undefined,
        appName: row.app_name ?? undefined,
        userId: row.user_id ?? undefined,
        agentId: row.agent_id ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        canonicalProjectId: row.canonical_project_id ?? undefined,
        productId: row.product_id ?? undefined,
        producerId: row.producer_id ?? undefined,
        namespace: row.namespace ?? undefined,
        visibility: row.visibility ?? undefined,
        lifecycleStatus: row.lifecycle_status ?? undefined,
      }));
      return exactAuthorityRows(rows, authority, options.limit);
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

    const authority = recallAuthority(options);
    if (authority) {
      baseQuery = baseQuery.eq('tenant_id', authority.tenantId);
      baseQuery = baseQuery.eq('user_id', authority.userId);
    }

    if (options.dataTypes && options.dataTypes.length > 0) {
      baseQuery = baseQuery.in('data_type', options.dataTypes);
    }

    if (options.filter) {
      for (const [key, value] of Object.entries(options.filter)) {
        if (key === 'id' && Array.isArray(value) && value.every((id) => typeof id === 'string')) {
          baseQuery = baseQuery.in('id', value);
        } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          baseQuery = baseQuery.eq(`metadata->>${key}`, value);
        }
      }
    }

    // scope 维度硬过滤（D-25）：备选路径也需保持过滤语义一致
    if (options.projectName) {
      baseQuery = baseQuery.eq('project_name', options.projectName);
    }
    if (options.appName) {
      baseQuery = baseQuery.eq('app_name', options.appName);
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
        // scope 维度读回（D-25）
        projectName: row.project_name ?? undefined,
        appName: row.app_name ?? undefined,
        userId: row.user_id ?? undefined,
        agentId: row.agent_id ?? undefined,
        workspaceId: row.workspace_id ?? undefined,
        tenantId: row.tenant_id ?? undefined,
        canonicalProjectId: row.canonical_project_id ?? undefined,
        productId: row.product_id ?? undefined,
        producerId: row.producer_id ?? undefined,
        namespace: row.namespace ?? undefined,
        visibility: row.visibility ?? undefined,
        lifecycleStatus: row.lifecycle_status ?? undefined,
      };
    });

    // 按相似度排序并返回前 N 条
    resultsWithScore.sort((a, b) => b.score - a.score);
    const limit = options.limit ?? 5;
    return exactAuthorityRows(resultsWithScore, authority, limit);
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
    assertSafeLegacyDeleteFilter(filter, { consumesDataType: true });
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
