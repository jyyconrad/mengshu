-- ============================================================
-- Supabase Scope 维度列迁移脚本（D-25 项目/产品维度软过滤）
-- ============================================================
-- 用途：为 memories/knowledge 表添加 scope 维度独立列，
--       并升级 match_memories/match_knowledge RPC 支持按项目/产品过滤。
--
-- 关联设计文档：
--   .memory-docs/original-docs/04-design/04.2-detail/scope-project-product-filtering-design.md
--   （第 7.3 节 Supabase 适配、第 8.5 节 RPC 改造）
--
-- 执行方式：在 Supabase Dashboard → SQL Editor 中手动执行。
--           psql 执行时 \set 生效；Dashboard 执行需手动把 :VECTOR_DIM 替换为实际维度。
-- ============================================================
-- 向量维度（请根据嵌入模型调整，与 supabase-rpc-functions.sql 保持一致）：
--   - text-embedding-3-small: 1536
--   - text-embedding-3-large: 3072
--   - BAAI/bge-m3: 1024
--   - Qwen/Qwen3-Embedding-0.6B: 1024
-- ============================================================
-- pgvector 版本说明：
--   本脚本 RETURNS TABLE 中的 vector 列使用 vector(:VECTOR_DIM) 明确维度，
--   与现有 supabase-rpc-functions.sql 保持一致，兼容 pgvector 全版本。
-- ============================================================

\set VECTOR_DIM 1024

-- ============================================================
-- 步骤 1: 为 memories 表添加 scope 维度列 + 索引
-- ============================================================
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS project_name TEXT,
  ADD COLUMN IF NOT EXISTS app_name TEXT,
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS agent_id TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_project_name ON memories(project_name);
CREATE INDEX IF NOT EXISTS idx_memories_app_name ON memories(app_name);
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON memories(user_id);

COMMENT ON COLUMN memories.project_name IS '项目名称（scope.projectId），NULL=全局/通用记忆';
COMMENT ON COLUMN memories.app_name IS '产品名称（scope.appId），如 codex/claude-code/openclaw';
COMMENT ON COLUMN memories.user_id IS '用户标识（scope.userId）';
COMMENT ON COLUMN memories.agent_id IS 'Agent 标识（scope.agentId）';
COMMENT ON COLUMN memories.workspace_id IS '工作空间 ID（scope.workspaceId）';

-- ============================================================
-- 步骤 2: 为 knowledge 表添加 scope 维度列 + 索引
-- ============================================================
ALTER TABLE knowledge
  ADD COLUMN IF NOT EXISTS project_name TEXT,
  ADD COLUMN IF NOT EXISTS app_name TEXT,
  ADD COLUMN IF NOT EXISTS user_id TEXT,
  ADD COLUMN IF NOT EXISTS agent_id TEXT,
  ADD COLUMN IF NOT EXISTS workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_knowledge_project_name ON knowledge(project_name);
CREATE INDEX IF NOT EXISTS idx_knowledge_app_name ON knowledge(app_name);
CREATE INDEX IF NOT EXISTS idx_knowledge_user_id ON knowledge(user_id);

-- ============================================================
-- 步骤 2.5（可选）: 动态扩展知识库表（knowledge_python 等）
-- ------------------------------------------------------------
-- 固定表 memories/knowledge 已在上方处理；扩展表由代码 ensureTableExists
-- 自动加列（新建表时）。存量的动态扩展表需手动 ALTER，下方循环兜底批处理。
-- 取消注释即可执行。
-- ------------------------------------------------------------
-- DO $$
-- DECLARE
--   t text;
-- BEGIN
--   FOR t IN
--     SELECT table_name FROM information_schema.tables
--     WHERE table_schema = 'public' AND table_name LIKE 'knowledge\_%'
--   LOOP
--     EXECUTE format('ALTER TABLE %I
--       ADD COLUMN IF NOT EXISTS project_name TEXT,
--       ADD COLUMN IF NOT EXISTS app_name TEXT,
--       ADD COLUMN IF NOT EXISTS user_id TEXT,
--       ADD COLUMN IF NOT EXISTS agent_id TEXT,
--       ADD COLUMN IF NOT EXISTS workspace_id TEXT', t);
--     EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_project_name ON %I(project_name)', t, t);
--     EXECUTE format('CREATE INDEX IF NOT EXISTS idx_%s_app_name ON %I(app_name)', t, t);
--   END LOOP;
-- END $$;

-- ============================================================
-- 步骤 3: 升级 match_memories RPC（新增项目/产品过滤参数）
-- ------------------------------------------------------------
-- 新增参数：filter_project_name / filter_app_name（NULL=不过滤，保持软召回）
-- 新增返回列：project_name / app_name / user_id / agent_id / workspace_id
-- 兼容性：新参数有 DEFAULT NULL，旧调用方（仅传 4 参）仍可用。
-- ============================================================
CREATE OR REPLACE FUNCTION match_memories(
  query_embedding vector(:VECTOR_DIM),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL,
  filter_project_name TEXT DEFAULT NULL,
  filter_app_name TEXT DEFAULT NULL
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
  project_name TEXT,
  app_name TEXT,
  user_id TEXT,
  agent_id TEXT,
  workspace_id TEXT,
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
    m.project_name,
    m.app_name,
    m.user_id,
    m.agent_id,
    m.workspace_id,
    (1 - (m.vector <=> query_embedding)) AS similarity
  FROM memories m
  WHERE (1 - (m.vector <=> query_embedding)) >= min_similarity
    AND (filter_data_type IS NULL OR m.data_type = ANY(filter_data_type))
    -- 项目硬过滤（NULL 时跳过，保持跨项目软召回）
    AND (filter_project_name IS NULL OR m.project_name = filter_project_name)
    -- 产品硬过滤
    AND (filter_app_name IS NULL OR m.app_name = filter_app_name)
  ORDER BY m.vector <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- 步骤 4: 升级 match_knowledge RPC（与 match_memories 同结构）
-- ============================================================
CREATE OR REPLACE FUNCTION match_knowledge(
  query_embedding vector(:VECTOR_DIM),
  match_count INT DEFAULT 5,
  min_similarity FLOAT DEFAULT 0.1,
  filter_data_type TEXT[] DEFAULT NULL,
  filter_project_name TEXT DEFAULT NULL,
  filter_app_name TEXT DEFAULT NULL
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
  project_name TEXT,
  app_name TEXT,
  user_id TEXT,
  agent_id TEXT,
  workspace_id TEXT,
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
    k.project_name,
    k.app_name,
    k.user_id,
    k.agent_id,
    k.workspace_id,
    (1 - (k.vector <=> query_embedding)) AS similarity
  FROM knowledge k
  WHERE (1 - (k.vector <=> query_embedding)) >= min_similarity
    AND (filter_data_type IS NULL OR k.data_type = ANY(filter_data_type))
    AND (filter_project_name IS NULL OR k.project_name = filter_project_name)
    AND (filter_app_name IS NULL OR k.app_name = filter_app_name)
  ORDER BY k.vector <=> query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- 步骤 5（可选）: 存量数据回填
-- ------------------------------------------------------------
-- 旧数据若 metadata 里存了 projectPath/userId/agentName，可回填到独立列。
-- 多数旧数据因写入路径断裂未存这些字段，回填率低，不强制。
-- ============================================================
-- UPDATE memories SET
--   project_name = metadata->>'projectPath',
--   user_id = metadata->>'userId',
--   agent_id = metadata->>'agentName'
-- WHERE metadata IS NOT NULL
--   AND (metadata ? 'projectPath' OR metadata ? 'userId' OR metadata ? 'agentName');
--
-- UPDATE knowledge SET
--   project_name = metadata->>'projectPath',
--   user_id = metadata->>'userId',
--   agent_id = metadata->>'agentName'
-- WHERE metadata IS NOT NULL
--   AND (metadata ? 'projectPath' OR metadata ? 'userId' OR metadata ? 'agentName');

-- ============================================================
-- 步骤 6: 验证
-- ============================================================
-- 确认列已添加
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'memories'
  AND column_name IN ('project_name', 'app_name', 'user_id', 'agent_id', 'workspace_id')
ORDER BY column_name;

-- 确认 RPC 函数参数数量（应为 6）
SELECT proname, pronargs
FROM pg_proc
WHERE proname IN ('match_memories', 'match_knowledge');
