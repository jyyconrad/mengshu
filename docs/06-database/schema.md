# 数据库 Schema

## 概述

本插件使用多表存储架构，支持两种数据库后端：
- **LanceDB**: 本地向量数据库
- **Supabase**: PostgreSQL + pgvector

## 表列表

| 表名 | 用途 | 数据前缀 |
|------|------|----------|
| `memories` | 对话记忆 | `mem_` |
| `knowledge` | 文档知识 | `know_` |

## v4 Middleware Schema 草案

v4 在保留 `memories` / `knowledge` legacy 表的基础上，新增 middleware 结构化表。第一阶段代码已提供 in-memory contract baseline，持久化 provider 后续按以下 schema 落地。

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

核心索引建议：

```sql
CREATE INDEX chunks_scope_source_idx ON chunks(scope_key, source_id, created_at DESC);
CREATE INDEX entities_scope_hotness_idx ON entities(scope_key, hotness DESC);
CREATE INDEX relations_subject_idx ON relations(scope_key, subject_id, predicate);
CREATE INDEX relations_object_idx ON relations(scope_key, object_id, predicate);
CREATE INDEX summary_tree_idx ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);
```

所有新表必须包含 `scope_key` 或可从 `scope` 派生的等价字段；server/remote 模式不得绕过 scope filter 查询。

## 表结构

### memories 表

存储对话记忆（用户偏好、决策、实体信息等）

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

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `text` | TEXT | 文本内容 |
| `content_hash` | TEXT | SHA256 哈希（去重） |
| `vector` | vector(1536) | 嵌入向量 |
| `importance` | FLOAT | 重要性 (0-1) |
| `category` | TEXT | 分类 |
| `data_type` | TEXT | 数据类型 |
| `metadata` | JSONB | 元数据 |
| `created_at` | TIMESTAMP | 创建时间 |

### knowledge 表

存储文档知识（扫描的 Markdown 文件）

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

**字段说明**:

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID | 主键 |
| `text` | TEXT | 文本内容 |
| `content_hash` | TEXT | SHA256 哈希（去重） |
| `vector` | vector(1536) | 嵌入向量 |
| `importance` | FLOAT | 重要性 (0-1) |
| `category` | TEXT | 分类 |
| `data_type` | TEXT | 数据类型 |
| `metadata` | JSONB | 元数据 |
| `created_at` | TIMESTAMP | 创建时间 |

## 索引设计

### memories 表索引

```sql
-- 向量索引（IVFFlat 算法）
CREATE INDEX memories_vector_idx
ON memories USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

-- 唯一哈希索引
CREATE UNIQUE INDEX memories_content_hash_idx
ON memories (content_hash);

-- 数据类型索引
CREATE INDEX memories_data_type_idx
ON memories (data_type);

-- 时间索引（倒序）
CREATE INDEX memories_created_at_idx
ON memories (created_at DESC);
```

### knowledge 表索引

```sql
-- 向量索引（IVFFlat 算法）
CREATE INDEX knowledge_vector_idx
ON knowledge USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

-- 唯一哈希索引
CREATE UNIQUE INDEX knowledge_content_hash_idx
ON knowledge (content_hash);

-- 数据类型索引
CREATE INDEX knowledge_data_type_idx
ON knowledge (data_type);

-- 时间索引（倒序）
CREATE INDEX knowledge_created_at_idx
ON knowledge (created_at DESC);
```

## 表关系

```
memories          knowledge
    │                 │
    │                 │
    └────────┬────────┘
             │
    共享相同的 Schema 结构
    独立的数据和索引
```

## 向量维度

**重要**: 向量维度必须与嵌入模型匹配！

| 模型 | 维度 |
|------|------|
| text-embedding-3-small | 1536 |
| text-embedding-3-large | 3072 |
| BAAI/bge-m3 | 1024 |

修改向量维度需要：
1. 删除现有表
2. 修改 SQL 脚本中的维度
3. 重新创建表

## RPC 函数

### match_memories

用于向量搜索的存储过程：

```sql
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  content_hash TEXT,
  vector vector(1536),
  importance FLOAT,
  category TEXT,
  data_type TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    m.id,
    m.text,
    m.content_hash,
    m.vector,
    m.importance,
    m.category,
    m.data_type,
    m.metadata,
    m.created_at,
    (1 - (m.vector <=> query_embedding)) AS similarity
  FROM memories m
  WHERE (1 - (m.vector <=> query_embedding)) >= min_similarity
    AND (filter_data_type IS NULL OR m.data_type = ANY(filter_data_type))
  ORDER BY m.vector <=> query_embedding
  LIMIT match_count;
END;
$$;
```

### match_knowledge

```sql
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(1536),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  content_hash TEXT,
  vector vector(1536),
  importance FLOAT,
  category TEXT,
  data_type TEXT,
  metadata JSONB,
  created_at TIMESTAMP WITH TIME ZONE,
  similarity FLOAT
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    k.id,
    k.text,
    k.content_hash,
    k.vector,
    k.importance,
    k.category,
    k.data_type,
    k.metadata,
    k.created_at,
    (1 - (k.vector <=> query_embedding)) AS similarity
  FROM knowledge k
  WHERE (1 - (k.vector <=> query_embedding)) >= min_similarity
    AND (filter_data_type IS NULL OR k.data_type = ANY(filter_data_type))
  ORDER BY k.vector <=> query_embedding
  LIMIT match_count;
END;
$$;
```

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
