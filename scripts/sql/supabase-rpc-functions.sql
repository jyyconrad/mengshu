-- ============================================================
-- Supabase RPC 函数安装脚本
-- 用于修复 "URI too long" 错误
-- ============================================================
-- 注意：请根据你的嵌入模型调整向量维度
-- - text-embedding-3-small: 1536
-- - text-embedding-3-large: 3072
-- - BAAI/bge-m3: 1024
-- ============================================================

-- 定义向量维度变量（请根据实际情况修改）
\set VECTOR_DIM 1024

-- 步骤 0: 诊断 - 检查当前 Supabase 环境中的表和函数
-- ------------------------------------------------------------

-- 检查有哪些表
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;

-- 检查向量维度（从现有表中获取）
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'memories'
  AND column_name = 'vector';

-- 检查有哪些向量相关的函数
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND (routine_name LIKE 'match_%' OR routine_name = 'vector')
ORDER BY routine_name;

-- 检查 memories 表结构
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'memories'
ORDER BY ordinal_position;

-- 检查 knowledge 表结构
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'knowledge'
ORDER BY ordinal_position;

-- ============================================================
-- 步骤 1: 如果上面检查发现没有 memories/knowledge 表，先创建表
-- ============================================================

-- 创建 memories 表（如果不存在）
CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(:VECTOR_DIM) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.7,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'memory',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 创建 knowledge 表（如果不存在）
CREATE TABLE IF NOT EXISTS knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(:VECTOR_DIM) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.5,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'knowledge',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX IF NOT EXISTS memories_vector_idx ON memories USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
CREATE UNIQUE INDEX IF NOT EXISTS memories_content_hash_idx ON memories (content_hash);
CREATE INDEX IF NOT EXISTS memories_data_type_idx ON memories (data_type);
CREATE INDEX IF NOT EXISTS memories_created_at_idx ON memories (created_at DESC);

CREATE INDEX IF NOT EXISTS knowledge_vector_idx ON knowledge USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_content_hash_idx ON knowledge (content_hash);
CREATE INDEX IF NOT EXISTS knowledge_data_type_idx ON knowledge (data_type);
CREATE INDEX IF NOT EXISTS knowledge_created_at_idx ON knowledge (created_at DESC);

-- ============================================================
-- 步骤 2: 创建 RPC 函数（无论表是否已存在）
-- ============================================================

-- 创建核心记忆表的向量搜索函数
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(:VECTOR_DIM),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  content_hash TEXT,
  vector vector(:VECTOR_DIM),
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

-- 创建知识库表的向量搜索函数
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(:VECTOR_DIM),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  text TEXT,
  content_hash TEXT,
  vector vector(:VECTOR_DIM),
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

-- ============================================================
-- 步骤 3: 验证 - 确认函数创建成功
-- ============================================================
SELECT routine_name
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN ('match_memories', 'match_knowledge');

-- 应该返回两行：match_memories 和 match_knowledge
