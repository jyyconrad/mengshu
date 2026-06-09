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

## 迁移

当前迁移命令：

```bash
ltm migrate --to-schema v4 --dry-run
```

该命令当前提供迁移估算，不执行真实数据迁移。真实迁移需要按表、namespace、scope 分批执行，并保留旧表回滚窗口。
