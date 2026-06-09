# memory-autodb v3.0 技术升级方案

> **版本**: v3.0 Technical Plan | **日期**: 2026-03-19
> **项目**: memory-autodb (OpenClaw 长期记忆插件)
> **状态**: 技术方案

---

## 一、现有架构分析

### 1.1 当前代码结构

```
memory-autodb/
├── index.ts                    # 插件主入口，注册工具和生命周期
├── config.ts                  # 配置定义与验证
├── db/
│   ├── factory.ts             # DatabaseFactory: 根据配置创建 Provider
│   ├── types.ts               # DatabaseProvider 接口定义
│   └── providers/
│       ├── lancedb.ts         # LanceDBProvider 实现
│       ├── supabase.ts        # SupabaseProvider 实现
│       └── hybrid.ts          # HybridProvider (LanceDB + Supabase)
├── routing/
│   ├── index.ts               # 路由模块导出
│   └── rules.ts               # RoutingEngine: 知识库路由规则
├── processing/
│   ├── embeddings.ts          # 向量化处理
│   └── hash-utils.ts          # 哈希工具
├── scanner/
│   └── scanner-coordinator.ts # 目录扫描协调器
└── docs/
    └── UPGRADE-v3.0-graph-requirements.md  # 升级需求
```

### 1.2 核心接口设计

#### DatabaseProvider 接口 (db/types.ts:85-145)

```typescript
export interface DatabaseProvider {
  initialize(): Promise<void>;
  close(): Promise<void>;
  store(entries: MemoryEntry[]): Promise<void>;
  query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]>;
  delete(ids: string[]): Promise<void>;
  deleteByFilter(filter: Record<string, unknown>): Promise<number>;
  existsByContentHash(contentHashes: string[]): Promise<string[]>;
  count(filter?: Record<string, unknown>): Promise<number>;
  getTableNames?(): Promise<TableName[]>;
  ensureTable?(tableName: TableName): Promise<void>;
  getTableStats?(): Promise<TableStats[]>;
}
```

#### MemoryEntry 结构 (db/types.ts:45-65)

```typescript
export interface MemoryEntry {
  id: string;
  text: string;
  contentHash: string;
  vector: number[];
  importance: number;
  category: MemoryCategory;
  dataType: DataType;
  tableName?: TableName;
  metadata: MemoryMetadata;
  createdAt: number;
}
```

### 1.3 数据流分析

```
用户请求 (memory_store/recall/forget)
         │
         ▼
   ┌─────────────┐
   │  index.ts   │  ← 解析参数、路由决策
   │  Tool Handler│
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │ Embeddings  │  ← 向量化 (openai)
   │   Service   │
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐
   │  Database   │  ← LanceDB / Supabase / Hybrid
   │  Factory    │
   └──────┬──────┘
          │
    ┌─────┴─────┐
    ▼           ▼
 LanceDB    Supabase
 (本地)      (云端)
```

### 1.4 路由逻辑

- **RoutingEngine** (routing/rules.ts): 根据内容匹配规则，路由到 `knowledge_personal`、`knowledge_work` 等表
- **默认规则**: `personal` → `knowledge_personal`, `work` → `knowledge_work`
- 支持启用/禁用、动态添加/删除规则

---

## 二、目标架构设计

### 2.1 三引擎混合存储架构

```
┌─────────────────────────────────────────────────────────────────┐
│                      memory-autodb v3.0                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    API Layer (index.ts)                   │  │
│  │   memory_store | memory_recall | memory_forget            │  │
│  │   mem0_store | mem0_recall | cognee_* | hybrid_recall     │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                      │
│  ┌─────────────────────────▼─────────────────────────────────┐  │
│  │              Hybrid Retrieval Engine (new)                 │  │
│  │   ┌─────────────────────────────────────────────────────┐ │  │
│  │   │           Query Orchestrator                         │ │  │
│  │   │  - Result merging & deduplication                   │ │  │
│  │   │  - Weighted scoring                                 │ │  │
│  │   │  - Cross-engine entity resolution                   │ │  │
│  │   └─────────────────────────────────────────────────────┘ │  │
│  └─────────────────────────┬─────────────────────────────────┘  │
│                            │                                      │
│    ┌───────────────────────┼───────────────────────┐            │
│    ▼                       ▼                       ▼            │
│ ┌──────────┐      ┌──────────────┐      ┌──────────────┐       │
│ │ LanceDB  │      │    Mem0      │      │   Cognee    │       │
│ │ Provider │      │   Provider   │      │   Provider   │       │
│ └────┬─────┘      └──────┬───────┘      └──────┬───────┘       │
│      │                   │                      │                │
│  本地向量存储      语义记忆存储             知识图谱              │
│  (高性能检索)      (用户级关联)           (实体关系)            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 新增 Provider 设计

#### 2.2.1 Mem0Provider

位置: `db/providers/mem0.ts`

```typescript
export class Mem0Provider implements DatabaseProvider {
  private client: Memory | null = null;
  private config: Mem0Config;

  async initialize(): Promise<void> {
    this.client = new Memory({
      embedder: this.config.embedder,
      vectorStore: this.config.vectorStore,
      llm: this.config.llm,
    });
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    // 转换格式并存储到 Mem0
    const memories = entries.map(e => ({
      text: e.text,
      user_id: e.metadata?.sessionId || 'default',
      metadata: e.metadata,
    }));
    await this.client!.add(memories);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const results = await this.client!.search(options.query || '', {
      user_id: options.filter?.sessionId as string || 'default',
      limit: options.limit,
      filters: options.filter,
    });
    return results.map(r => this.convertToMemoryEntry(r));
  }

  // ... 其他接口方法
}
```

#### 2.2.2 CogneeProvider

位置: `db/providers/cognee.ts`

```typescript
export class CogneeProvider implements DatabaseProvider {
  private client: CogneeClient | null = null;
  private config: CogneeConfig;

  async initialize(): Promise<void> {
    this.client = new CogneeClient({
      baseURL: this.config.baseURL,
      apiKey: this.config.apiKey,
    });
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    // 添加到图谱（异步构建）
    const texts = entries.map(e => e.text);
    const result = await this.client!.add(texts, {
      nodeSet: this.config.defaultNodeSet,
    });
    // 触发图谱构建
    await this.client!.cognify(result.taskId);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const results = await this.client!.search(options.query || '', {
      nodeSet: this.config.defaultNodeSet,
      limit: options.limit,
    });
    return results.map(r => this.convertToMemoryEntry(r));
  }

  // 实体查询方法
  async getEntities(nodeSet?: string): Promise<GraphEntity[]> {
    return this.client!.getEntities({ nodeSet });
  }

  // 关系查询方法
  async getRelations(nodeSet?: string): Promise<GraphRelation[]> {
    return this.client!.getRelations({ nodeSet });
  }
}
```

#### 2.2.3 HybridProvider v3.0 升级

位置: `db/providers/hybrid.ts` (修改现有文件)

```typescript
export class HybridProvider implements DatabaseProvider {
  private lancedb: LanceDBProvider;
  private mem0: Mem0Provider | null = null;
  private cognee: CogneeProvider | null = null;
  private config: HybridConfig;

  constructor(
    lancedb: LanceDBProvider,
    mem0: Mem0Provider | null,
    cognee: CogneeProvider | null,
    config: HybridConfig
  ) { ... }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    const results: HybridResult[] = [];

    // 并行执行三引擎查询
    const promises: Promise<void>[] = [];

    // LanceDB 向量搜索
    if (this.config.weights.vector > 0) {
      promises.push(
        this.lancedb.query(options).then(r => 
          results.push(...r.map(item => ({ ...item, source: 'vector', weight: this.config.weights.vector })))
        )
      );
    }

    // Mem0 语义搜索
    if (this.mem0 && this.config.weights.mem0 > 0) {
      promises.push(
        this.mem0.query(options).then(r =>
          results.push(...r.map(item => ({ ...item, source: 'mem0', weight: this.config.weights.mem0 })))
        )
      );
    }

    // Cognee 图谱搜索
    if (this.cognee && this.config.weights.graph > 0) {
      promises.push(
        this.cognee.query(options).then(r =>
          results.push(...r.map(item => ({ ...item, source: 'graph', weight: this.config.weights.graph })))
        )
      );
    }

    await Promise.all(promises);

    // 去重 + 加权排序
    return this.mergeAndRankResults(results, options.limit);
  }

  private mergeAndRankResults(results: HybridResult[], limit?: number): (MemoryEntry & { score: number })[] {
    // 按 ID 去重，保留最高分
    const deduped = new Map<string, HybridResult>();
    for (const r of results) {
      const existing = deduped.get(r.id);
      if (!existing || r.finalScore > existing.finalScore) {
        deduped.set(r.id, r);
      }
    }

    // 加权计算最终分数
    const scored = Array.from(deduped.values()).map(r => ({
      ...r,
      finalScore: r.score * r.weight,
    }));

    // 按分数排序
    scored.sort((a, b) => b.finalScore - a.finalScore);

    return scored.slice(0, limit).map(r => {
      const { source, weight, finalScore, ...entry } = r;
      return { ...entry, score: finalScore };
    });
  }
}
```

### 2.3 配置扩展

位置: `config.ts` (新增配置项)

```typescript
interface Mem0Config {
  enabled: boolean;
  provider: 'openai' | 'azure' | 'ollama';
  embedder: {
    provider: string;
    model: string;
    apiKey?: string;
    baseURL?: string;
  };
  vectorStore: {
    provider: 'memory' | 'lancedb' | 'supabase';
    config: {
      collectionName?: string;
      dimension?: number;
      dbPath?: string;
      supabaseUrl?: string;
      supabaseKey?: string;
    };
  };
  llm?: {
    provider: string;
    model: string;
    apiKey?: string;
  };
}

interface CogneeConfig {
  enabled: boolean;
  baseURL: string;
  apiKey?: string;
  defaultNodeSet?: string;
}

interface HybridConfig {
  enabled: boolean;
  weights: {
    vector: number;   // LanceDB 权重
    mem0: number;    // Mem0 权重
    graph: number;    // Cognee 权重
  };
}

interface MemoryConfig {
  // 现有配置...
  mem0?: Mem0Config;
  cognee?: CogneeConfig;
  hybrid?: HybridConfig;
}
```

---

## 三、接口兼容性方案

### 3.1 现有 API 保持不变

| 现有工具 | 行为 | 兼容性 |
|----------|------|--------|
| `memory_store` | 继续写入 LanceDB/Supabase，新增可选写入 Mem0/Cognee | ✅ 完全兼容 |
| `memory_recall` | 继续从 LanceDB/Supabase 检索，新增可选混合检索 | ✅ 完全兼容 |
| `memory_forget` | 继续删除 LanceDB/Supabase 数据 | ✅ 完全兼容 |
| `memory_scan_directory` | 行为不变 | ✅ 完全兼容 |
| `memory_cleanup` | 行为不变 | ✅ 完全兼容 |

### 3.2 新增 API

| 新增工具 | 功能 | 位置 |
|----------|------|------|
| `mem0_store` | Mem0 语义存储 | index.ts |
| `mem0_recall` | Mem0 语义检索 | index.ts |
| `cognee_add` | 添加到知识图谱 | index.ts |
| `cognee_build` | 构建图谱 | index.ts |
| `cognee_search` | 图谱搜索 | index.ts |
| `cognee_entities` | 查询实体 | index.ts |
| `cognee_relations` | 查询关系 | index.ts |
| `hybrid_recall` | 混合检索 | index.ts |

### 3.3 兼容性实现策略

```typescript
// index.ts 修改示例
async execute(_toolCallId, params) {
  // 根据配置决定使用哪个引擎
  if (cfg.hybrid?.enabled) {
    // 使用混合检索
    return await hybridProvider.query(options);
  } else if (cfg.dbType === 'hybrid') {
    // 使用原有 HybridProvider (LanceDB + Supabase)
    return await db.query(options);
  } else {
    // 使用单一 Provider
    return await db.query(options);
  }
}
```

---

## 四、分阶段实施计划

### 4.1 阶段 1: 基础架构搭建

**预估时间**: 2h

#### 4.1.1 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 新建 | `db/providers/mem0.ts` | Mem0Provider 实现 |
| 新建 | `db/providers/cognee.ts` | CogneeProvider 实现 |
| 修改 | `db/types.ts` | 新增 Mem0Result, CogneeResult, HybridResult 类型 |
| 修改 | `config.ts` | 新增 mem0, cognee, hybrid 配置项 |
| 修改 | `db/factory.ts` | 扩展工厂支持创建 Mem0/Cognee Provider |

#### 4.1.2 具体变更

**db/types.ts** - 新增类型定义:
```typescript
// 搜索结果来源
export type ResultSource = 'vector' | 'mem0' | 'graph';

// 混合检索结果
export interface HybridResult extends MemoryEntry {
  score: number;
  source: ResultSource;
  weight: number;
  finalScore?: number;
}

// 图谱实体
export interface GraphEntity {
  id: string;
  name: string;
  type: string;
  nodeSet?: string;
  metadata?: Record<string, unknown>;
}

// 图谱关系
export interface GraphRelation {
  id: string;
  source: string;
  target: string;
  type: string;
  nodeSet?: string;
}
```

**config.ts** - 新增配置验证:
```typescript
// 在 memoryConfigSchema.parse 中添加验证
assertAllowedKeys(cfg, [
  // ... 现有字段
  'mem0', 'cognee', 'hybrid'
], 'memory config');

// 验证 mem0 配置
const mem0 = cfg.mem0 as Record<string, unknown> | undefined;
if (mem0) {
  assertAllowedKeys(mem0, ['enabled', 'provider', 'embedder', 'vectorStore', 'llm'], 'mem0 config');
  // ... 详细验证
}
```

**db/factory.ts** - 扩展工厂:
```typescript
export class DatabaseFactory {
  static createProvider(config: MemoryConfig, resolvedDbPath: string): DatabaseProvider {
    // ... 现有逻辑

    // 新增: 创建 Mem0Provider
    let mem0Provider: Mem0Provider | null = null;
    if (config.mem0?.enabled) {
      mem0Provider = new Mem0Provider(config.mem0);
    }

    // 新增: 创建 CogneeProvider
    let cogneeProvider: CogneeProvider | null = null;
    if (config.cognee?.enabled) {
      cogneeProvider = new CogneeProvider(config.cognee);
    }

    // 新增: 如果启用了混合模式
    if (config.hybrid?.enabled && (mem0Provider || cogneeProvider)) {
      return new HybridProvider(
        lancedbProvider,
        mem0Provider,
        cogneeProvider,
        config.hybrid
      );
    }

    // ... 返回现有 Provider
  }
}
```

### 4.2 阶段 2: Mem0 集成

**预估时间**: 3h

#### 4.2.1 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 安装依赖 | - | `npm install mem0ai` |
| 新建 | `db/providers/mem0.ts` | 实现 Mem0Provider (如尚未创建) |
| 修改 | `index.ts` | 注册 mem0_store, mem0_recall 工具 |
| 修改 | `openclaw.plugin.json` | 更新依赖 |

#### 4.2.2 具体变更

**db/providers/mem0.ts** - 完整实现:
```typescript
import { Memory } from 'mem0ai';

export class Mem0Provider implements DatabaseProvider {
  private client: Memory | null = null;
  private config: Mem0Config;

  constructor(config: Mem0Config) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.config.enabled && !this.client) {
      this.client = new Memory({
        embedder: this.config.embedder,
        vectorStore: this.config.vectorStore,
        llm: this.config.llm,
      });
    }
  }

  async close(): Promise<void> {
    this.client = null;
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    await this.initialize();
    const memories = entries.map(e => ({
      text: e.text,
      user_id: e.metadata?.sessionId || 'default',
      metadata: {
        ...e.metadata,
        category: e.category,
        importance: e.importance,
      },
    }));
    await this.client!.add(memories);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    await this.initialize();
    const results = await this.client!.search(options.query || '', {
      user_id: options.filter?.sessionId as string || 'default',
      limit: options.limit,
    });
    return results.map(r => this.convertToMemoryEntry(r));
  }

  async delete(ids: string[]): Promise<void> {
    // Mem0 不支持按 ID 删除，需要实现过滤器
    // 暂时不支持，抛出异常
    throw new Error('Mem0 does not support delete by ID');
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    // Mem0 不支持按过滤器删除
    throw new Error('Mem0 does not support delete by filter');
  }

  async existsByContentHash(contentHashes: string[]): Promise<string[]> {
    // Mem0 不支持按哈希检查
    return [];
  }

  async count(filter?: Record<string, unknown>): Promise<number> {
    // Mem0 不支持计数
    return 0;
  }

  private convertToMemoryEntry(result: any): MemoryEntry & { score: number } {
    return {
      id: result.id || randomUUID(),
      text: result.text || result.memory || '',
      contentHash: '', // Mem0 不返回哈希
      vector: [], // Mem0 不暴露向量
      importance: result.metadata?.importance ?? 0.7,
      category: result.metadata?.category || 'other',
      dataType: 'memory',
      metadata: result.metadata || {},
      createdAt: result.created_at ? new Date(result.created_at).getTime() : Date.now(),
      score: result.score || 0,
    };
  }
}
```

**index.ts** - 注册 Mem0 工具:
```typescript
// 在 register() 方法中添加
api.registerTool({
  name: 'mem0_store',
  label: 'Mem0 Store',
  description: 'Store memory using Mem0 semantic memory',
  parameters: Type.Object({
    text: Type.String(),
    userId: Type.Optional(Type.String()),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unsafe<unknown>())),
  }),
  async execute(_toolCallId, params) {
    const { text, userId, metadata } = params;
    const mem0Provider = (db as any).getMem0Provider?.();
    if (!mem0Provider) {
      throw new Error('Mem0 provider not configured');
    }
    const entries: MemoryEntry[] = [{
      id: randomUUID(),
      text,
      contentHash: computeContentHash(text),
      vector: await embeddings.embed(text),
      importance: 0.7,
      category: 'other',
      dataType: 'memory',
      metadata: { ...metadata, sessionId: userId },
      createdAt: Date.now(),
    }];
    await mem0Provider.store(entries);
    return { content: [{ type: 'text', text: `Stored to Mem0: ${text.slice(0, 50)}...` }] };
  },
}, { name: 'mem0_store' });

// 类似添加 mem0_recall
```

### 4.3 阶段 3: Cognee 集成

**预估时间**: 3h

#### 4.3.1 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 安装依赖 | - | `npm install @lineai/cognee-api` |
| 新建 | `db/providers/cognee.ts` | 实现 CogneeProvider |
| 修改 | `index.ts` | 注册 cognee_* 工具 |

#### 4.3.2 具体变更

**db/providers/cognee.ts** - 完整实现:
```typescript
import { CogneeClient } from '@lineai/cognee-api';

export class CogneeProvider implements DatabaseProvider {
  private client: CogneeClient | null = null;
  private config: CogneeConfig;

  constructor(config: CogneeConfig) {
    this.config = config;
  }

  async initialize(): Promise<void> {
    if (this.config.enabled && !this.client) {
      this.client = new CogneeClient({
        baseURL: this.config.baseURL,
        apiKey: this.config.apiKey,
      });
    }
  }

  async close(): Promise<void> {
    this.client = null;
  }

  async store(entries: MemoryEntry[]): Promise<void> {
    await this.initialize();
    const texts = entries.map(e => e.text);
    const result = await this.client!.add(texts, {
      nodeSet: this.config.defaultNodeSet || 'openclaw',
    });
    // 自动触发图谱构建
    await this.client!.cognify(result.taskId);
  }

  async query(options: MemoryQueryOptions): Promise<(MemoryEntry & { score: number })[]> {
    await this.initialize();
    const results = await this.client!.search(options.query || '', {
      nodeSet: this.config.defaultNodeSet,
      limit: options.limit,
    });
    return results.map(r => this.convertToMemoryEntry(r));
  }

  async getEntities(nodeSet?: string): Promise<GraphEntity[]> {
    await this.initialize();
    return this.client!.getEntities({ nodeSet: nodeSet || this.config.defaultNodeSet });
  }

  async getRelations(nodeSet?: string): Promise<GraphRelation[]> {
    await this.initialize();
    return this.client!.getRelations({ nodeSet: nodeSet || this.config.defaultNodeSet });
  }

  // DatabaseProvider 接口的其他方法
  async delete(ids: string[]): Promise<void> { /* 暂不支持 */ }
  async deleteByFilter(filter: Record<string, unknown>): Promise<number> { return 0; }
  async existsByContentHash(contentHashes: string[]): Promise<string[]> { return []; }
  async count(filter?: Record<string, unknown>): Promise<number> { return 0; }

  private convertToMemoryEntry(result: any): MemoryEntry & { score: number } {
    return {
      id: result.id || randomUUID(),
      text: result.text || '',
      contentHash: '',
      vector: [],
      importance: 0.7,
      category: 'other',
      dataType: 'knowledge',
      metadata: result.metadata || {},
      createdAt: result.created_at || Date.now(),
      score: result.similarity || 0,
    };
  }
}
```

**index.ts** - 注册 Cognee 工具:
```typescript
// 注册 cognee_add, cognee_search, cognee_entities, cognee_relations
// 实现方式类似 Mem0 工具
```

### 4.4 阶段 4: 混合检索实现

**预估时间**: 2h

#### 4.4.1 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 修改 | `db/providers/hybrid.ts` | 升级为三引擎混合检索 |
| 修改 | `index.ts` | 注册 hybrid_recall 工具 |

#### 4.4.2 具体变更

**db/providers/hybrid.ts** - 升级实现 (见 2.2.3 节)

**index.ts** - 注册混合检索工具:
```typescript
api.registerTool({
  name: 'hybrid_recall',
  label: 'Hybrid Recall',
  description: 'Search using hybrid retrieval (LanceDB + Mem0 + Cognee)',
  parameters: Type.Object({
    query: Type.String(),
    limit: Type.Optional(Type.Number()),
    weights: Type.Optional(Type.Object({
      vector: Type.Number(),
      mem0: Type.Number(),
      graph: Type.Number(),
    })),
  }),
  async execute(_toolCallId, params) {
    const { query, limit = 5, weights } = params;
    const vector = await embeddings.embed(query);
    
    const options: MemoryQueryOptions = {
      query,
      vector,
      limit,
    };

    const results = await db.query(options);
    // ... 格式化结果
  },
}, { name: 'hybrid_recall' });
```

### 4.5 阶段 5: 测试与验证

**预估时间**: 2h

#### 4.5.1 文件变更清单

| 操作 | 文件路径 | 说明 |
|------|----------|------|
| 新建 | `tests/unit/mem0-provider.test.ts` | Mem0 Provider 单元测试 |
| 新建 | `tests/unit/cognee-provider.test.ts` | Cognee Provider 单元测试 |
| 新建 | `tests/unit/hybrid-provider.test.ts` | 混合检索测试 |
| 新建 | `tests/e2e/hybrid-recall.test.ts` | 端到端测试 |

---

## 五、数据迁移方案

### 5.1 迁移策略

```typescript
// migration/v2-to-v3.ts

export async function migrateToV3(
  lancedb: LanceDBProvider,
  mem0: Mem0Provider | null,
  cognee: CogneeProvider | null,
  options: MigrationOptions
): Promise<MigrationResult> {
  const result: MigrationResult = {
    success: false,
    migrated: 0,
    failed: 0,
    errors: [],
  };

  // 1. 备份现有数据（保留原 LanceDB/Supabase 数据不变）
  //    方案: 不删除原有数据，新数据同时写入新旧引擎

  // 2. 获取所有现有记忆
  const allMemories = await lancedb.query({
    limit: 10000,
    dataTypes: ['memory'],
  });

  // 3. 迁移到 Mem0 (如果启用)
  if (mem0 && options.migrateToMem0) {
    for (const memory of allMemories) {
      try {
        await mem0.store([memory]);
        result.migrated++;
      } catch (error) {
        result.failed++;
        result.errors.push(`Failed to migrate memory ${memory.id}: ${error}`);
      }
    }
  }

  // 4. 迁移到 Cognee 图谱 (如果启用)
  if (cognee && options.migrateToCognee) {
    const knowledgeEntries = await lancedb.query({
      limit: 10000,
      filter: { tableName: 'knowledge' },
    });
    
    try {
      await cognee.store(knowledgeEntries);
      result.migrated += knowledgeEntries.length;
    } catch (error) {
      result.failed += knowledgeEntries.length;
      result.errors.push(`Failed to migrate to Cognee: ${error}`);
    }
  }

  result.success = result.failed === 0;
  return result;
}
```

### 5.2 迁移配置

```typescript
// config.ts
interface MigrationOptions {
  migrateToMem0: boolean;
  migrateToCognee: boolean;
  batchSize: number;
}
```

### 5.3 回滚方案

1. **配置开关回滚**: 通过设置 `mem0.enabled: false`, `cognee.enabled: false` 回退到原引擎
2. **数据不回滚**: 保留原 LanceDB/Supabase 数据，新增引擎数据可选清理
3. **渐进式启用**: 新引擎默认关闭，由用户通过配置逐步启用

---

## 六、风险评估与应对策略

### 6.1 依赖兼容性风险

| 风险 | 描述 | 应对策略 |
|------|------|----------|
| Mem0 SDK 版本变更 | mem0ai SDK API 可能变化 | 使用适配器模式封装，隔离 SDK 变更 |
| Cognee API 不稳定 | HTTP API 可能变更 | 实现重试机制 + 熔断器模式 |
| 向量维度不匹配 | 不同嵌入模型维度不同 | 配置验证 + 启动时检查 |

### 6.2 性能风险

| 风险 | 描述 | 应对策略 |
|------|------|----------|
| 混合检索延迟高 | 三引擎并行查询可能超过 2s | 实现超时控制 + 结果缓存 |
| Mem0 网络调用 | 依赖外部 API | 使用本地 Ollama 作为备选 |
| 图谱构建耗时 | Cognee cognify 是异步操作 | 改为队列模式 + Webhook 回调 |

### 6.3 数据一致性风险

| 风险 | 描述 | 应对策略 |
|------|------|----------|
| 跨引擎数据不一致 | 写入成功但查询失败 | 实现最终一致性检查脚本 |
| 重复存储 | 同一内容写入多个引擎 | 使用 contentHash 去重 |

### 6.4 回滚风险

| 风险 | 描述 | 应对策略 |
|------|------|----------|
| 升级失败导致服务不可用 | 新版本有 bug | 保留 v2.1 分支，支持 downgrade |
| 配置迁移问题 | 新配置格式不兼容 | 配置文件版本校验 + 自动降级 |

---

## 七、验收标准

### 7.1 功能验收

| 编号 | 验收项 | 验证方法 | 预期结果 |
|------|--------|----------|----------|
| F1 | Mem0 存储 | 调用 `mem0_store` 后查询 | 记忆可被检索 |
| F2 | Mem0 检索 | 调用 `mem0_recall` | 返回相关记忆 |
| F3 | Cognee 添加 | 调用 `cognee_add` | 数据进入图谱 |
| F4 | Cognee 构建 | 调用 `cognee_build` | 图谱构建完成 |
| F5 | Cognee 搜索 | 调用 `cognee_search` | 返回图谱实体 |
| F6 | 混合检索 | 调用 `hybrid_recall` | 返回三引擎结果 |
| F7 | 向后兼容 | 调用现有 API | 行为与 v2.1 一致 |
| F8 | 配置兼容 | 使用 v2.1 配置启动 | 正常运行 |

### 7.2 性能验收

| 编号 | 验收项 | 指标 | 验证方法 |
|------|--------|------|----------|
| P1 | Mem0 检索延迟 | < 500ms | 计时 100 次查询 |
| P2 | Cognee 搜索延迟 | < 1s | 计时图谱搜索 |
| P3 | 混合检索延迟 | < 1.5s | 计时混合查询 |
| P4 | 存储吞吐量 | > 10条/s | 批量存储测试 |

### 7.3 集成验收

| 编号 | 验收项 | 验证方法 |
|------|--------|----------|
| I1 | 插件正常加载 | 启动 OpenClaw，检查日志 |
| I2 | CLI 命令可用 | 运行 `ltm stats` |
| I3 | 生命周期钩子 | 触发 auto-capture/recall |

---

## 八、实施时间线

| 阶段 | 内容 | 预估时间 | 依赖 |
|------|------|----------|------|
| Phase 1 | 基础架构搭建 | 2h | - |
| Phase 2 | Mem0 集成 | 3h | Phase 1 |
| Phase 3 | Cognee 集成 | 3h | Phase 1 |
| Phase 4 | 混合检索 | 2h | Phase 2, Phase 3 |
| Phase 5 | 测试验证 | 2h | Phase 4 |
| **总计** | | **12h** | |

---

## 九、附录

### A. 依赖清单

```json
{
  "dependencies": {
    "mem0ai": "^1.0.0",
    "@lineai/cognee-api": "latest"
  }
}
```

### B. 配置示例

```json
{
  "embedding": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com"
  },
  "dbType": "lancedb",
  "dbPath": "~/.openclaw/memory/lancedb",
  "mem0": {
    "enabled": true,
    "provider": "openai",
    "embedder": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "apiKey": "${OPENAI_API_KEY}",
      "baseURL": "https://api.openai.com"
    },
    "vectorStore": {
      "provider": "lancedb",
      "config": {
        "dbPath": "~/.openclaw/memory/mem0"
      }
    }
  },
  "cognee": {
    "enabled": true,
    "baseURL": "http://localhost:8000",
    "defaultNodeSet": "openclaw"
  },
  "hybrid": {
    "enabled": true,
    "weights": {
      "vector": 0.3,
      "mem0": 0.4,
      "graph": 0.3
    }
  }
}
```

---

> **方案状态**: 技术方案完成
> **下一步**: 评审后开始实施
