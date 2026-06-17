# 数据库 Schema

本文区分两层 schema：已经由 legacy provider 使用的 `memories` / `knowledge` 表，以及 v4 中间件的结构化 schema 草案。

## 后端状态

| 后端 | 状态 | 说明 |
|------|------|------|
| LanceDB | 已支持 | 默认本地向量存储，路径由 `dbPath` 决定 |
| Supabase | 已支持 | PostgreSQL + pgvector，需要 `SUPABASE_URL` 和 `SUPABASE_SERVICE_KEY` |
| Postgres | 已支持 | provider 已存在，适合 server 部署 |
| In-memory | 已支持 | 中间件 contract baseline 和测试 |

## Legacy 表

| 表名 | 用途 | 默认数据类型 |
|------|------|--------------|
| `memories` | 对话记忆、用户偏好、事实、决策 | `memory` |
| `knowledge` | 扫描文档和知识条目 | `knowledge` / `document` |

### `memories`

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.7,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'memory',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

### `knowledge`

```sql
CREATE TABLE knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.5,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'knowledge',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID/string | 主键，具体格式由 provider 决定 |
| `text` | text | 记忆或知识片段正文 |
| `content_hash` | text | 内容去重 hash |
| `vector` | vector | embedding 向量，维度必须和模型一致 |
| `importance` | float | 重要性，范围 0-1 |
| `category` | text | legacy 分类 |
| `data_type` | text | `memory`、`document`、`knowledge` |
| `metadata` | json | OpenClaw 上下文、文件路径、用户自定义信息 |
| `created_at` | timestamp/number | 创建时间 |

## Legacy 索引

```sql
CREATE INDEX memories_vector_idx
ON memories USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

CREATE UNIQUE INDEX memories_content_hash_idx
ON memories (content_hash);

CREATE INDEX memories_data_type_idx
ON memories (data_type);

CREATE INDEX memories_created_at_idx
ON memories (created_at DESC);
```

```sql
CREATE INDEX knowledge_vector_idx
ON knowledge USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

CREATE UNIQUE INDEX knowledge_content_hash_idx
ON knowledge (content_hash);

CREATE INDEX knowledge_data_type_idx
ON knowledge (data_type);

CREATE INDEX knowledge_created_at_idx
ON knowledge (created_at DESC);
```

## Supabase RPC

Supabase provider 使用 `match_memories` 和 `match_knowledge` 做向量搜索。仓库根目录保留两份脚本：

| 脚本 | 说明 |
|------|------|
| [supabase-rpc-functions.sql](../../supabase-rpc-functions.sql) | 1536 维默认脚本 |
| [supabase-rpc-functions-1024.sql](../../supabase-rpc-functions-1024.sql) | 1024 维模型脚本 |

维度必须和 embedding 模型一致。

## 向量维度

常用模型维度见 [技术栈](../03-architecture/technology-stack.md)。更换模型时需要同时处理：

1. provider 表结构或 LanceDB schema。
2. Supabase RPC 函数参数维度。
3. 已有向量数据的迁移或重建。

## v4 中间件 schema 草案

v4 在 legacy 表之上新增结构化数据模型。当前代码已提供 in-memory contract baseline；持久化 provider 后续按下表落地。

| 表名 | 作用 |
|------|------|
| `documents` | source/document 元数据 |
| `chunks` | deterministic chunk，graph/tree/vector/text 的 evidence 单位 |
| `jobs` | embed/extract/seal/digest 等后台任务 |
| `audit` | store/forget/migrate/retention/rebuild 审计 |
| `entities` | 结构化实体 |
| `relations` | 带 evidence 的关系 |
| `tree_buffers` | source/topic/global L0 buffer |
| `summary_nodes` | sealed source/topic/global summary |

核心约束：

- 所有新表必须包含 `scope_key`，或包含可稳定派生 `scope_key` 的 `scope` 字段。
- server/remote 模式不得绕过 scope filter 查询。
- graph/tree/summary 必须保留 evidence id，不能只有模型生成文本。
- L0 evidence 不应因摘要折叠被系统主动删除；删除属于治理操作，应写 audit。

建议索引：

```sql
CREATE INDEX chunks_scope_source_idx
ON chunks(scope_key, source_id, created_at DESC);

CREATE INDEX entities_scope_hotness_idx
ON entities(scope_key, hotness DESC);

CREATE INDEX relations_subject_idx
ON relations(scope_key, subject_id, predicate);

CREATE INDEX relations_object_idx
ON relations(scope_key, object_id, predicate);

CREATE INDEX summary_tree_idx
ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);
```

### documents 表

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'file'|'conversation'|'api'|'scan'
  file_path TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  size_bytes INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX documents_scope_source_idx
ON documents(scope_key, source_id);

CREATE UNIQUE INDEX documents_content_hash_idx
ON documents(content_hash);
```

### chunks 表

```sql
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536),
  token_count INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX chunks_scope_source_idx
ON chunks(scope_key, source_id, chunk_index);

CREATE INDEX chunks_document_idx
ON chunks(document_id, chunk_index);

CREATE UNIQUE INDEX chunks_content_hash_idx
ON chunks(content_hash);

CREATE INDEX chunks_vector_idx
ON chunks USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);
```

### jobs 表

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  job_type TEXT NOT NULL, -- 'embed'|'extract'|'seal'|'digest'|'rebuild'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'completed'|'failed'
  target_id TEXT,
  progress FLOAT DEFAULT 0.0,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX jobs_scope_status_idx
ON jobs(scope_key, status, created_at DESC);

CREATE INDEX jobs_type_status_idx
ON jobs(job_type, status, created_at DESC);
```

### audit 表

```sql
CREATE TABLE audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'store'|'forget'|'migrate'|'retention'|'rebuild'
  target_type TEXT NOT NULL, -- 'memory'|'document'|'chunk'|'entity'|'relation'
  target_id TEXT NOT NULL,
  actor TEXT, -- 'system'|'user:{id}'|'plugin'
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_scope_operation_idx
ON audit(scope_key, operation, created_at DESC);

CREATE INDEX audit_target_idx
ON audit(target_type, target_id, created_at DESC);
```

### entities 表

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  hotness FLOAT DEFAULT 0.0,
  first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scope_key, name, entity_type)
);

CREATE INDEX entities_scope_hotness_idx
ON entities(scope_key, hotness DESC);

CREATE INDEX entities_scope_type_idx
ON entities(scope_key, entity_type);
```

### relations 表

```sql
CREATE TABLE relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  subject_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  evidence_ids TEXT[] NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scope_key, subject_id, predicate, object_id)
);

CREATE INDEX relations_subject_idx
ON relations(scope_key, subject_id, predicate);

CREATE INDEX relations_object_idx
ON relations(scope_key, object_id, predicate);
```

### tree_buffers 表

```sql
CREATE TABLE tree_buffers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL, -- 'source'|'topic'|'global'
  tree_key TEXT NOT NULL,
  chunk_ids TEXT[] NOT NULL,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(scope_key, tree_type, tree_key)
);

CREATE INDEX tree_buffers_scope_type_idx
ON tree_buffers(scope_key, tree_type, tree_key);
```

### summary_nodes 表

```sql
CREATE TABLE summary_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  summary TEXT NOT NULL,
  evidence_ids TEXT[] NOT NULL,
  token_count INTEGER DEFAULT 0,
  vector vector(1536),
  sealed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX summary_tree_idx
ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);

CREATE INDEX summary_vector_idx
ON summary_nodes USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);
```

## 架构特性与算法实现

v4 schema 设计支持以下核心特性：

### 1. scope_key 隔离

所有表包含 `scope_key` 字段，用于多租户/多用户数据隔离：

- 本地模式：默认 `scope_key = "default"`
- server/remote 模式：从认证 token 提取 `user_id` 或 `org_id`，自动派生 `scope_key`
- 所有查询必须携带 scope filter，provider 层强制校验

### 2. deterministic chunk

`chunks` 表设计原则：

- 每个 chunk 有稳定的 `content_hash`，同内容去重
- `chunk_index` 标识在 source 中的顺序
- `vector` 字段可选，支持延迟向量化
- chunk 不可变，修改 source 时创建新 chunk 并更新 document 关联

### 3. evidence 链

graph/tree/summary 必须保留 evidence：

- `relations.evidence_ids` 数组指向 `chunks.id`
- `summary_nodes.evidence_ids` 数组指向 `chunks.id` 或 `tree_buffers.id`
- 支持溯源到 L0 文本，保证可解释性

### 4. 后台任务队列

`jobs` 表实现异步任务：

```typescript
// 创建 embedding 任务
await db.createJob({
  scope_key: 'default',
  job_type: 'embed',
  target_id: document.id,
  metadata: { chunk_count: 10 }
});

// worker 拉取任务
const job = await db.pullJob({ job_type: 'embed', status: 'pending' });
await db.updateJob(job.id, { status: 'running', started_at: new Date() });

// 完成任务
await db.updateJob(job.id, {
  status: 'completed',
  progress: 1.0,
  completed_at: new Date()
});
```

### 5. 审计日志

所有删除、迁移、重建操作必须写 `audit` 表：

```typescript
await db.audit({
  scope_key: 'default',
  operation: 'forget',
  target_type: 'memory',
  target_id: entry.id,
  actor: 'user:123',
  metadata: { reason: 'user_request' }
});
```

### 6. tree buffer 机制

`tree_buffers` 表支持 3 种树类型：

- `source` tree：每个 file/conversation 一棵树
- `topic` tree：按主题聚合跨 source 的 chunk
- `global` tree：全局时间线 buffer

buffer 累积 chunk_ids，达到阈值触发 seal 任务：

```typescript
// 添加 chunk 到 buffer
await db.addToTreeBuffer({
  scope_key: 'default',
  tree_type: 'source',
  tree_key: 'doc-123',
  chunk_ids: ['chunk-1', 'chunk-2']
});

// buffer 满时创建 seal 任务
if (buffer.token_count > threshold) {
  await db.createJob({
    job_type: 'seal',
    target_id: buffer.id
  });
}
```

### 7. summary 分层

`summary_nodes` 表支持多层摘要：

- level 0：L0 chunk 直接摘要（对应 source/topic 层级）
- level 1+：摘要的摘要

每个 summary node 记录：

- `evidence_ids`：引用的下层 chunk/summary id
- `vector`：摘要向量，支持语义搜索
- `sealed_at`：封存时间，用于增量更新

### 8. graph 热度衰减

`entities` 表记录 `hotness` 分数：

- 初始值：从 extraction confidence 计算
- 衰减：定期运行 decay 任务，`hotness *= 0.9`
- 每次引用时刷新 `last_seen`，hotness 增加

`relations` 表类似机制，支持过期边清理。

### 9. 向量索引策略

- `chunks.vector`：核心检索，必须索引
- `summary_nodes.vector`：摘要检索，建议索引
- 其他表（entities/relations）：按需索引

### 10. 批量操作支持

schema 设计支持批量写入：

```typescript
await db.batchInsertChunks(chunks); // 单次最多 100 条
await db.batchEmbedChunks(chunk_ids); // 批量向量化
await db.batchUpdateEntityHotness(updates); // 批量更新热度
```

## CLI 命令参考

v4 schema 提供以下 CLI 命令：

### 查询命令

```bash
# 查看所有表统计
ms tables

# 查询 documents
ms query documents --scope default --limit 10

# 查询 chunks（支持 source 过滤）
ms query chunks --source-id doc-123 --limit 20

# 查询 jobs（支持状态过滤）
ms query jobs --status pending --job-type embed

# 查询 audit 日志
ms query audit --operation forget --target-type memory

# 查询 entities（支持热度排序）
ms query entities --scope default --sort hotness --limit 50

# 查询 relations（支持主谓宾过滤）
ms query relations --subject-id entity-123 --predicate "works_at"

# 查询 tree buffers
ms query tree_buffers --tree-type source --tree-key doc-123

# 查询 summary nodes
ms query summary_nodes --tree-type topic --level 0
```

### 管理命令

```bash
# 创建 job
ms create-job embed --target-id doc-123 --scope default

# 更新 job 状态
ms update-job job-456 --status completed --progress 1.0

# 审计记录
ms audit forget memory entry-789 --actor user:123 --reason "user_request"

# 清理过期数据
ms cleanup --older-than 90 --target-type chunk --dry-run

# 重建索引
ms rebuild-index --table chunks --scope default

# 导出数据
ms export documents --scope default --format json --output docs.json
```

### 迁移命令

```bash
# 从 legacy 表迁移到 v4
ms migrate --to-schema v4 --dry-run

# 分批迁移
ms migrate --to-schema v4 --batch-size 100 --scope default

# 验证迁移结果
ms migrate --verify --scope default
```

### 监控命令

```bash
# 查看 job 队列状态
ms jobs status

# 查看 scope 统计
ms stats --scope default --breakdown

# 查看 entity 热度分布
ms stats entities --scope default

# 查看 tree buffer 状态
ms stats tree-buffers --tree-type source
```

## 测试覆盖

v4 schema 测试要求：

### 单元测试

| 测试文件 | 覆盖范围 |
|---------|---------|
| `db/providers/postgres-v4.test.ts` | documents/chunks/jobs CRUD |
| `db/providers/supabase-v4.test.ts` | Supabase v4 provider 实现 |
| `graph/entity-resolver.test.ts` | entity/relation 创建和查询 |
| `tree/buffer-manager.test.ts` | tree buffer 累积和 seal 触发 |
| `tree/summary-builder.test.ts` | summary node 生成和分层 |

### 集成测试

| 测试场景 | 预期行为 |
|---------|---------|
| scope 隔离 | scope A 无法访问 scope B 的数据 |
| evidence 链 | relation/summary 必须引用有效 chunk id |
| job 队列 | worker 拉取、更新、完成流程正确 |
| audit 记录 | 删除操作必须写 audit 表 |
| batch 操作 | 批量写入 100 条 chunk 无错误 |

### E2E 测试

```bash
# 完整导入流程
ms scan /path/to/docs --target-table knowledge
ms query chunks --source-id doc-123 --limit 10

# graph 提取流程
ms extract-graph --source-id doc-123
ms query entities --scope default --limit 20
ms query relations --subject-id entity-456

# tree 构建流程
ms build-tree --tree-type source --source-id doc-123
ms query summary_nodes --tree-type source --tree-key doc-123
```

覆盖率目标：80%+

## 迁移

当前迁移命令：

```bash
ms migrate --to-schema v4 --dry-run
```

该命令当前提供迁移估算，不执行真实数据迁移。真实迁移需要按表、namespace、scope 分批执行，并保留旧表回滚窗口。

### 迁移策略

1. **分阶段迁移**

   - 阶段 1：创建 v4 表结构，不影响 legacy 表
   - 阶段 2：增量写入双写（同时写 legacy 和 v4）
   - 阶段 3：历史数据批量迁移
   - 阶段 4：切换读取为 v4 优先
   - 阶段 5：legacy 表只读或归档

2. **数据映射**

   | Legacy 表 | V4 表 | 映射规则 |
   |----------|-------|---------|
   | `memories` | `chunks` | `data_type='memory'` → 创建 virtual document + chunk |
   | `knowledge` | `documents` + `chunks` | 按 `metadata.filePath` 分组为 document |

3. **回滚机制**

   ```bash
   # 回滚到 legacy 模式
   ms rollback --to-schema legacy --scope default
   
   # 验证 legacy 数据完整性
   ms verify --schema legacy --scope default
   ```

4. **性能优化**

   - 批量迁移：每批 100 条，避免长事务
   - 并发控制：最多 3 个并发 worker
   - 增量同步：定期运行，追平双写期间的数据

5. **监控指标**

   ```bash
   # 查看迁移进度
   ms migrate --status --scope default
   
   # 输出示例
   # Migration Progress:
   #   documents: 1000/1200 (83%)
   #   chunks: 4500/5000 (90%)
   #   jobs: 50/50 (100%)
   #   entities: 200/250 (80%)
   ```
