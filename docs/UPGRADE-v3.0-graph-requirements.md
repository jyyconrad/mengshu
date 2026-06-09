# memory-autodb v3.0 图谱检索升级需求

> **版本**: v3.0 升级需求 | **日期**: 2026-03-18
> **项目**: memory-autodb (OpenClaw 长期记忆插件)

---

## 一、背景

现有 memory-autodb 插件 (v2.1) 已实现：
- LanceDB / Supabase 混合向量存储
- memories 表 + knowledge 表分离
- 自动记忆捕获 + 语义检索
- 目录扫描 + 知识库功能

**现有局限**：
- 纯向量搜索，无实体关系建模
- 记忆之间无关联查询能力
- 无法支持"查找与某实体相关的所有记忆"

---

## 二、升级目标

### 2.1 核心目标

1. **集成 Mem0** - 利用成熟 SDK 实现语义记忆层
2. **集成 Cognee** - 利用成熟图谱框架实现知识图谱
3. **混合存储架构** - LanceDB + Mem0 + Cognee 多引擎
4. **向后兼容** - 保障现有数据完整

### 2.2 架构设计

```
┌─────────────────────────────────────────────────────────────────┐
│                      memory-autodb v3.0                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐       │
│  │   LanceDB   │    │     Mem0     │    │   Cognee    │       │
│  │  (向量存储)  │    │  (语义记忆)   │    │  (知识图谱)  │       │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘       │
│         │                  │                  │               │
│         └──────────────────┼──────────────────┘               │
│                            │                                    │
│                    ┌───────▼───────┐                           │
│                    │  Hybrid Layer  │                           │
│                    │  (混合检索引擎)  │                           │
│                    └───────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 2.3 兼容性要求

| 需求 | 说明 |
|------|------|
| 数据兼容 | 现有 memories/knowledge 表数据完整保留 |
| API 兼容 | 现有工具调用方式不变 |
| 配置兼容 | 现有配置参数继续生效 |

---

## 三、集成方案

### 3.1 Mem0 集成

#### 3.1.1 安装依赖

```bash
npm install mem0ai
# 或使用 OSS 版本
npm install github:mem0ai/mem0
```

#### 3.1.2 配置选项

```typescript
// config.ts 新增配置
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
    provider: 'memory' | 'supabase' | 'lancedb';
    config: {
      collectionName?: string;
      dimension?: number;
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
```

#### 3.1.3 Mem0 API 封装

```typescript
// db/providers/mem0.ts
import { Memory } from 'mem0ai';

export class Mem0Provider implements DatabaseProvider {
  private client: Memory;
  
  async initialize(config: Mem0Config): Promise<void> {
    this.client = new Memory({
      embedder: config.embedder,
      vectorStore: config.vectorStore,
      llm: config.llm,
    });
  }
  
  async store(entries: MemoryEntry[]): Promise<void> {
    const memories = entries.map(e => ({
      text: e.text,
      user_id: e.metadata?.sessionId || 'default',
      metadata: e.metadata,
    }));
    await this.client.add(memories);
  }
  
  async search(query: string, options: MemoryQueryOptions): Promise<any[]> {
    return await this.client.search(query, {
      user_id: options.filter?.sessionId as string || 'default',
      limit: options.limit,
    });
  }
  
  async getAll(userId: string): Promise<any[]> {
    return await this.client.getAll({ user_id: userId });
  }
}
```

### 3.2 Cognee 集成

#### 3.2.1 安装依赖

```bash
npm install @lineai/cognee-api
# 或
npm install axios  # 用于 HTTP API 调用
```

#### 3.2.2 Cognee API 封装

```typescript
// db/providers/cognee.ts
import { CogneeClient } from '@lineai/cognee-api';

export class CogneeProvider {
  private client: CogneeClient;
  
  async initialize(config: { baseURL: string; apiKey?: string }): Promise<void> {
    this.client = new CogneeClient({
      baseURL: config.baseURL,
      apiKey: config.apiKey,
    });
  }
  
  // 添加数据到图谱
  async addData(
    data: string | string[], 
    nodeSets?: string[]
  ): Promise<{ taskId: string }> {
    return await this.client.add(data, { nodeSet: nodeSets });
  }
  
  // 构建图谱
  async cognify(taskId: string): Promise<void> {
    await this.client.cognify(taskId);
  }
  
  // 搜索图谱
  async search(query: string, options?: {
    nodeSet?: string;
    limit?: number;
  }): Promise<any[]> {
    return await this.client.search(query, options);
  }
  
  // 获取实体
  async getEntities(nodeSet?: string): Promise<GraphEntity[]> {
    return await this.client.getEntities({ nodeSet });
  }
  
  // 获取关系
  async getRelations(nodeSet?: string): Promise<GraphRelation[]> {
    return await this.client.getRelations({ nodeSet });
  }
}
```

### 3.3 混合检索层

#### 3.3.1 统一接口

```typescript
// db/hybrid.ts
export class HybridMemoryProvider {
  private lancedb: LanceDBProvider;
  private mem0: Mem0Provider;
  private cognee: CogneeProvider;
  
  async query(options: HybridQueryOptions): Promise<HybridResult[]> {
    const results: HybridResult[] = [];
    
    // 1. 向量搜索 (LanceDB)
    if (options.vectorWeight && options.vectorWeight > 0) {
      const vectorResults = await this.lancedb.query({
        query: options.query,
        limit: options.limit,
        filter: options.filter,
      });
      results.push(...vectorResults.map(r => ({
        ...r,
        source: 'vector',
        weight: options.vectorWeight,
      })));
    }
    
    // 2. 语义搜索 (Mem0)
    if (options.mem0Weight && options.mem0Weight > 0) {
      const mem0Results = await this.mem0.search(options.query, {
        limit: options.limit,
      });
      results.push(...mem0Results.map(r => ({
        id: r.id,
        text: r.text || r.memory,
        score: r.score,
        source: 'mem0',
        weight: options.mem0Weight,
      })));
    }
    
    // 3. 图谱搜索 (Cognee)
    if (options.graphWeight && options.graphWeight > 0) {
      const graphResults = await this.cognee.search(options.query, {
        limit: options.limit,
      });
      results.push(...graphResults.map(r => ({
        id: r.id,
        text: r.text,
        score: r.score,
        source: 'graph',
        weight: options.graphWeight,
      })));
    }
    
    // 4. 综合排序
    return this.rankResults(results, options.limit);
  }
  
  private rankResults(results: HybridResult[], limit: number): HybridResult[] {
    // 按加权分数排序
    return results
      .map(r => ({ ...r, finalScore: r.score * (r.weight || 1) }))
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit);
  }
}
```

---

## 四、功能需求

### 4.1 记忆存储增强

| 功能 | 描述 | 优先级 |
|------|------|--------|
| Mem0 集成 | 语义记忆存储与检索 | P0 |
| 自动实体抽取 | 使用 Mem0 内置抽取 | P0 |
| 多级记忆 | User/Session/Agent 级 | P1 |

### 4.2 知识图谱增强

| 功能 | 描述 | 优先级 |
|------|------|--------|
| Cognee 集成 | 知识图谱构建 | P0 |
| NodeSets | 按标签分组查询 | P1 |
| 图谱可视化 | 导出可视化数据 | P2 |

### 4.3 混合检索

| 功能 | 描述 | 优先级 |
|------|------|--------|
| 三引擎混合搜索 | LanceDB + Mem0 + Cognee | P0 |
| 可调权重 | 配置各引擎权重 | P1 |
| 结果去重 | 跨引擎去重 | P1 |

---

## 五、配置扩展

### 5.1 新增配置项

```typescript
// config.ts
interface PluginConfigV3 {
  // 现有配置...
  
  // Mem0 配置
  mem0?: {
    enabled: boolean;
    provider: 'openai' | 'ollama';
    embedder: {
      provider: string;
      model: string;
      apiKey?: string;
      baseURL?: string;
    };
    vectorStore: {
      provider: 'memory' | 'lancedb';
      config: any;
    };
  };
  
  // Cognee 配置
  cognee?: {
    enabled: boolean;
    baseURL: string;  // Cognee API 地址
    apiKey?: string;
    defaultNodeSet?: string;
  };
  
  // 混合检索配置
  hybrid?: {
    enabled: boolean;
    weights: {
      vector: number;    // LanceDB 权重
      mem0: number;      // Mem0 权重
      graph: number;     // Cognee 权重
    };
  };
}
```

### 5.2 配置示例

```json
{
  "mem0": {
    "enabled": true,
    "provider": "ollama",
    "embedder": {
      "provider": "ollama",
      "model": "nomic-embed-text",
      "baseURL": "http://localhost:11434"
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

## 六、工具接口

### 6.1 新增工具

| 工具 | 功能 | 引擎 |
|------|------|------|
| `mem0_store` | Mem0 语义存储 | Mem0 |
| `mem0_recall` | Mem0 语义检索 | Mem0 |
| `cognee_add` | 添加到图谱 | Cognee |
| `cognee_build` | 构建图谱 | Cognee |
| `cognee_search` | 图谱搜索 | Cognee |
| `hybrid_recall` | 混合检索 | All |

### 6.2 工具参数

```typescript
// mem0_store
{
  text: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// mem0_recall
{
  query: string;
  userId?: string;
  limit?: number;
}

// cognee_add
{
  data: string | string[];
  nodeSets?: string[];
}

// hybrid_recall
{
  query: string;
  limit?: number;
  weights?: {
    vector?: number;
    mem0?: number;
    graph?: number;
  };
}
```

---

## 七、数据迁移

### 7.1 迁移策略

```typescript
// migration/v2-to-v3.ts
async function migrateToV3() {
  // 1. 备份现有数据
  await backupExistingData();
  
  // 2. 初始化新存储
  await initializeMem0();
  await initializeCognee();
  
  // 3. 迁移现有记忆到 Mem0
  const existingMemories = await lancedb.query({ limit: 10000 });
  for (const memory of existingMemories) {
    await mem0.store({
      text: memory.text,
      userId: memory.metadata?.sessionId || 'default',
      metadata: memory.metadata,
    });
  }
  
  // 4. 迁移现有知识到 Cognee
  const existingKnowledge = await lancedb.query({
    filter: { tableName: 'knowledge' },
    limit: 10000,
  });
  await cognee.add(existingKnowledge.map(k => k.text));
  await cognee.build();
  
  // 5. 验证迁移
  await verifyMigration();
}
```

### 7.2 回滚方案

- 保留原 LanceDB 数据不变
- 新存储失败时回退到原引擎
- 配置开关控制是否启用新引擎

---

## 八、验收标准

### 8.1 功能验收

| 编号 | 验收项 | 验证方法 |
|------|--------|---------|
| F1 | Mem0 存储/检索正常 | 调用 mem0_store + mem0_recall |
| F2 | Cognee 图谱构建/查询正常 | 添加数据后构建图谱并搜索 |
| F3 | 混合检索正常 | hybrid_recall 返回三引擎结果 |
| F4 | 向后兼容 | 原有 API 继续工作 |

### 8.2 性能验收

| 编号 | 验收项 | 指标 |
|------|--------|------|
| P1 | Mem0 检索延迟 | < 500ms |
| P2 | Cognee 搜索延迟 | < 1s |
| P3 | 混合检索延迟 | < 1.5s |

---

## 九、实施计划

### Phase 1: Mem0 集成 (预估 3h)

1. 安装依赖
2. 创建 Mem0Provider
3. 封装 mem0_store / mem0_recall 工具
4. 测试验证

### Phase 2: Cognee 集成 (预估 3h)

1. 安装依赖 (@lineai/cognee-api)
2. 创建 CogneeProvider
3. 封装 cognee_add / cognee_search 工具
4. 测试验证

### Phase 3: 混合检索 (预估 2h)

1. 实现 HybridMemoryProvider
2. 实现 hybrid_recall 工具
3. 配置权重调节

### Phase 4: 集成测试 (预估 2h)

1. 端到端测试
2. 性能测试
3. 文档更新

---

## 十、附录

### A. Mem0 官方 API

```typescript
// 添加记忆
await memory.add("用户偏好深色模式", { user_id: "yayun" });

// 搜索记忆
const results = await memory.search("UI偏好", { user_id: "yayun" });

// 获取用户所有记忆
const all = await memory.getAll({ user_id: "yayun" });
```

### B. Cognee API

```typescript
// 添加数据
const task = await client.add(["文本1", "文本2"], { nodeSet: "openclaw" });

// 构建图谱
await client.cognify(task.taskId);

// 搜索
const results = await client.search("查询", { nodeSet: "openclaw" });

// 获取实体
const entities = await client.getEntities({ nodeSet: "openclaw" });
```

### C. 依赖清单

```json
{
  "dependencies": {
    "mem0ai": "^1.0.0",
    "@lineai/cognee-api": "latest"
  }
}
```

---

> 需求状态: 待评审
> 最后更新: 2026-03-19
