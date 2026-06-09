# OpenClaw 内存插件 v2.1 使用指南

## v4.0 记忆中间件能力预览

当前代码已开始从单一 OpenClaw 插件演进为可复用的 memory middleware：

- `MemoryService`：OpenClaw、REST、MCP、SDK 共用的核心服务边界。
- 本机 REST server：`ltm serve` 启动后提供 `/v1/health`、`/v1/memories`、`/v1/recall`、`/v1/context`。
- MCP/JS SDK：非 OpenClaw 产品可以通过 MCP tools 或 `sdk/js` client 接入。
- Ingestion Pipeline：`memory_scan_directory` 和 `ltm scan` 走 deterministic chunk + job queue，返回 `Jobs queued`、`Chunks admitted`、`Chunks dropped`。
- 混合检索基础：BM25 text index、RRF fusion、Context Packer，支持 provenance 和 prompt-safe context。
- 结构化图谱与记忆树基础：规则抽取 entity/relation、graph query、source/topic/global tree buffer 与 digest。
- Web Console：`/console` 提供 Overview、Quick Lookup、Graph、Jobs 基础界面。

本阶段保持旧 `memory_store`、`memory_recall`、`memory_scan_directory`、`memory_cleanup` 参数兼容。v4 新 schema 的持久化迁移仍按 `ltm migrate --to-schema v4 --dry-run` 先做估算和灰度规划。

## v2.1 新功能概览

v2.1 版本引入了**多存储分类架构**、**增强型 CLI 命令**、**元数据自动丰富**和**配置扩展**四大核心升级：

### 核心升级

1. **多存储分类架构**（用户友好的名称）
   - `核心记忆`：存储对话记忆（用户偏好、决策、实体信息等）
   - `知识库`：存储文档知识（扫描的 Markdown 文件、技术文档等）
   - 支持跨分类搜索和隔离查询

2. **增强型 CLI 命令**
   - `ltm tables` - 列出所有可用的存储分类
   - `ltm query` - 高级 JSON 过滤查询
   - `ltm export` - 导出数据为 JSON/CSV 格式
   - 现有命令增强：`ltm search`、`ltm stats`、`ltm cleanup` 支持分类参数

3. **元数据自动丰富**
   - 自动捕获 OpenClaw 上下文：`sessionId`、`conversationId`、`messageId`、`userId`
   - 项目和工作区信息：`projectPath`、`workspacePath`
   - Agent 信息：`agentId`、`agentName`
   - 群组信息：`groupId`、`groupName`
   - 用户信息：`userName`、`userEmail`
   - 技术元数据：`embeddingModel`、`pluginVersion`、`language`、`source`

4. **配置选项扩展**
   - `scanner.targetTable` - 指定扫描目标存储分类
   - `scanner.autoEnrichMetadata` - 自动丰富元数据
   - `tables` - 表级配置（启用/自动索引）

## 概述
这是一个功能强大的长期内存插件，支持本地 LanceDB 存储和云端 Supabase 存储，提供自动记忆捕获、自动召回和知识库扫描功能。

## 功能特性
- 🔄 **多存储模式**：支持纯本地 LanceDB、纯云端 Supabase、混合模式三种存储方式
- 📚 **知识库扫描**：自动扫描目录下的 Markdown 文件，构建本地知识库
- ⚡ **高性能向量化**：批量向量化、并发控制、自动重试，大幅提升处理效率
- 🔍 **智能查询**：支持元数据过滤、数据类型隔离，查询结果更精准
- 🧹 **数据管理**：灵活的数据清理工具，支持按类型、时间、条件清理
- 🤖 **自动记忆**：自动捕获对话中的重要信息，无需手动存储
- 🔒 **安全可靠**：内置 prompt 注入检测，内容自动转义

## 快速开始

### 1. 基础配置（原有功能，兼容旧版本）
```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "dbPath": "~/.openclaw/memory/autodb",
  "autoCapture": true,
  "autoRecall": true
}
```

### 2. 使用 Supabase 云端存储
```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "dbType": "supabase",
  "supabase": {
    "url": "${SUPABASE_URL}",
    "serviceKey": "${SUPABASE_SERVICE_KEY}"
  },
  "autoCapture": true,
  "autoRecall": true
}
```

### 3. 使用混合模式（推荐）
向量数据存在本地 LanceDB 保证搜索速度，文本和元数据存在 Supabase 保证云端持久化
```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "dbType": "lancedb",
  "dbPath": "~/.openclaw/memory/autodb",
  "supabase": {
    "url": "${SUPABASE_URL}",
    "serviceKey": "${SUPABASE_SERVICE_KEY}"
  },
  "autoCapture": true,
  "autoRecall": true
}
```

## 高级配置

### 批量处理配置
```json
{
  "batchProcessing": {
    "maxBatchSize": 20,      // 每批最多处理 20 个文本
    "concurrency": 3,        // 最多 3 个并发请求
    "retryAttempts": 3       // 请求失败最多重试 3 次
  }
}
```

### 目录扫描配置
```json
{
  "scanner": {
    "defaultIgnorePaths": ["node_modules", ".git", "dist"],
    "customIgnoreRules": ["*.log", "*.tmp"],
    "targetTable": "knowledge",        // v2.1 新增：指定扫描目标表（默认：knowledge）
    "autoEnrichMetadata": true         // v2.1 新增：自动丰富元数据（默认：true）
  }
}
```

### 表配置（v2.1 新增）
```json
{
  "tables": {
    "memories": {
      "enabled": true,      // 启用 memories 表
      "autoIndex": true     // 自动创建索引
    },
    "knowledge": {
      "enabled": true,      // 启用 knowledge 表
      "autoIndex": true     // 自动创建索引
    }
  }
}
```

### 自动召回包含文档数据
```json
{
  "recallIncludeDocuments": true
}
```

## 工具使用

### 1. 扫描目录构建知识库

#### 基础用法（存储到 `知识库`）
```typescript
// 工具调用
{
  "name": "memory_scan_directory",
  "parameters": {
    "directory": "/path/to/your/docs",
    "ignorePaths": ["node_modules", "dist"],
    "ignoreRules": ["*.test.md"]
  }
}

// 返回结果
{
  "content": [
    {
      "type": "text",
      "text": "Directory scan completed:\n- Scanned directory: /path/to/your/docs\n- Total files found: 156\n- Processed successfully: 152\n- Failed: 4\n- Total chunks: 892\n- Stored new chunks: 821\n- Duplicate chunks skipped: 71"
    }
  ]
}
```

#### v2.1 新增参数
```typescript
// 自定义存储分类和元数据
{
  "name": "memory_scan_directory",
  "parameters": {
    "directory": "/path/to/your/docs",
    "category": "知识库",              // 存储分类：核心记忆 | 知识库
    "autoEnrichMetadata": true         // 自动丰富元数据：添加 filePath 等
  }
}
```

### 2. 搜索记忆（包含文档数据）

#### 基础查询
```typescript
// 工具调用
{
  "name": "memory_recall",
  "parameters": {
    "query": "如何配置数据库连接",
    "limit": 5,
    "includeDocuments": true,
    "filter": { "filePath": "/docs/database" }
  }
}
```

#### v2.1 新增参数
```typescript
// 指定存储分类查询
{
  "name": "memory_recall",
  "parameters": {
    "query": "React 组件优化",
    "category": "知识库",              // 存储分类：核心记忆 | 知识库
    "limit": 10
  }
}

// 跨分类搜索
{
  "name": "memory_recall",
  "parameters": {
    "query": "用户偏好设置",
    "searchAll": true,                 // 搜索所有分类
    "limit": 15
  }
}
```

### 3. 存储记忆带自定义元数据

#### 基础用法
```typescript
// 工具调用
{
  "name": "memory_store",
  "parameters": {
    "text": "数据库连接超时时间设置为 30 秒",
    "importance": 0.8,
    "category": "fact",
    "metadata": { "project": "my-app", "author": "john" }
  }
}
```

#### v2.1 新增参数

**存储到核心记忆（默认）：**
```typescript
{
  "name": "memory_store",
  "parameters": {
    "text": "用户偏好使用深色模式",
    "storageCategory": "核心记忆",      // 存储分类：核心记忆 | 用户偏好 | 事实 | 决策 | 定时任务 | 长期规划 | 知识库（默认：核心记忆）
    "importance": 0.7,
    "category": "preference",
    "metadata": { "tag": "ui-preference" }
  }
}
```

**存储到知识库：**
```typescript
{
  "name": "memory_store",
  "parameters": {
    "text": "React 19 发布了新的编译器",
    "storageCategory": "知识库",         // 指定存储到知识库
    "importance": 0.6,
    "category": "fact",
    "metadata": { "source": "tech-news", "date": "2025-03-10" }
  }
}
```

**存储定时任务：**
```typescript
{
  "name": "memory_store",
  "parameters": {
    "text": "每天上午 10 点执行数据备份任务",
    "storageCategory": "定时任务",       // 定时任务分类
    "importance": 0.9,
    "category": "task",
    "metadata": { "schedule": "0 10 * * *", "type": "backup" }
  }
}
```

**存储长期规划：**
```typescript
{
  "name": "memory_store",
  "parameters": {
    "text": "Q2 季度完成微服务架构迁移",
    "storageCategory": "长期规划",       // 长期规划分类
    "importance": 0.8,
    "category": "plan",
    "metadata": { "quarter": "Q2", "year": "2025" }
  }
}
```

存储后的元数据将自动包含：
- `sessionId`: 会话 ID
- `conversationId`: 对话 ID
- `messageId`: 消息 ID
- `userId`: 用户 ID
- `projectPath`: 项目路径
- `workspacePath`: 工作区路径
- `agentId`: Agent ID
- `agentName`: Agent 名称
- `groupId`: 群组 ID
- `groupName`: 群组名称
- `userName`: 用户名称
- `userEmail`: 用户邮箱
- `source`: 数据来源 ("user" | "agent" | "system" | "scan")
- `createdAt`: 创建时间戳

### 4. 清理旧数据
```typescript
// 工具调用
{
  "name": "memory_cleanup",
  "parameters": {
    "dataType": "document",
    "olderThanDays": 30,
    "filter": { "project": "old-project" }
  }
}
```

## CLI 命令

### 查看内存统计
```bash
ltm stats
```
输出：
```
Memory Statistics:
- Total entries: 1256
- User memories: 256
- Scanned documents: 1000
- Database type: hybrid

Storage Categories:
- 核心记忆 (memories): 256 entries
- 知识库 (knowledge): 1000 entries

- Supabase URL: https://your-project.supabase.co
- LanceDB path: ~/.openclaw/memory/autodb
```

### 列出所有存储分类（v2.1 新增）
```bash
ltm tables
```
输出：
```
Available tables:
- memories: 256 entries
- knowledge: 1000 entries
```

### 扫描目录
```bash
# 扫描到知识库（默认）
ltm scan /path/to/docs --ignore node_modules --ignore dist

# 扫描到核心记忆
ltm scan /path/to/notes --category 核心记忆
```

### 搜索记忆
```bash
# 基础搜索
ltm search "配置数据库" --limit 10 --include-documents

# 指定分类搜索（v2.1 新增）
ltm search "React 组件" --category 知识库 --limit 5

# 跨分类搜索（v2.1 新增）
ltm search "用户偏好" --search-all --limit 20
```

### 高级查询（v2.1 新增）
```bash
# 使用 JSON 过滤器查询
ltm query --category 核心记忆 --filter '{"category": "preference", "source": "user"}'

# 结合向量搜索
ltm query --category 知识库 --vector "数据库配置" --limit 10 --filter '{"dataType": "document"}'
```

### 导出数据（v2.1 新增）
```bash
# 导出核心记忆为 JSON
ltm export --category 核心记忆 --format json --output memories.json

# 导出知识库为 CSV
ltm export --category 知识库 --format csv --output knowledge.csv

# 导出过滤后的数据
ltm export --category 核心记忆 --filter '{"category": "decision"}' --format json
```

### 清理数据
```bash
# 清理 30 天以上的文档数据
ltm cleanup --data-type document --older-than 30

# 清理所有测试相关的记忆
ltm cleanup --filter '{"tag": "test"}'

# 清理指定分类的数据（v2.1 新增）
ltm cleanup --category 知识库 --older-than 90
```

## Supabase 表结构

### 自动初始化（推荐）

插件会在启动时自动创建所需的表和索引，无需手动执行 SQL。

**注意**：自动创建表需要 Supabase 的 `exec_sql` RPC 函数权限。

### 检查 exec_sql 权限

运行以下诊断 SQL 检查你的 Supabase 实例是否有 `exec_sql` 权限：

```bash
# 在 Supabase 控制台执行
npx supabase sql push --file check-supabase-permissions.sql
```

或者在 Supabase 控制台的 **SQL Editor** 中执行 `check-supabase-permissions.sql` 文件中的内容。

**判断标准：**
- 如果 `has_function_privilege` 返回 `true` → 有权限，插件可以自动创建表
- 如果返回 `false` 或函数不存在 → 需要手动创建表

### 手动创建表（无 exec_sql 权限时）

如果 `exec_sql` 不可用，可以在 Supabase 控制台执行以下 SQL：

> **重要**：向量维度必须与你的嵌入模型匹配！
> - `text-embedding-3-small`: 1536 维
> - `text-embedding-3-large`: 3072 维
> - `BAAI/bge-m3`: 1024 维
>
> 请根据你的模型选择正确的 SQL 脚本：
> - **1024 维用户**：使用 `supabase-rpc-functions-1024.sql`
> - **1536 维用户**：使用 `supabase-rpc-functions.sql`（见下方）

### 核心记忆表（memories）
```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL, -- 1536 是 text-embedding-3-small 的维度
  importance FLOAT NOT NULL DEFAULT 0.7,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'memory',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX memories_vector_idx ON memories USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
CREATE UNIQUE INDEX memories_content_hash_idx ON memories (content_hash);
CREATE INDEX memories_data_type_idx ON memories (data_type);
CREATE INDEX memories_created_at_idx ON memories (created_at DESC);
```

### 知识库表（knowledge）
```sql
CREATE TABLE knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.5,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'knowledge',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- 创建索引
CREATE INDEX knowledge_vector_idx ON knowledge USING ivfflat (vector vector_cosine_ops) WITH (lists = 100);
CREATE UNIQUE INDEX knowledge_content_hash_idx ON knowledge (content_hash);
CREATE INDEX knowledge_data_type_idx ON knowledge (data_type);
CREATE INDEX knowledge_created_at_idx ON knowledge (created_at DESC);
```

### 向量搜索 RPC 函数（强烈推荐）

> **重要提示**：如果遇到 "URI too long" 错误，请优先创建以下 RPC 函数。
> 虽然插件已内置多层回退方案，但 RPC 函数是性能最好、最稳定的解决方案。

#### 快速检查和创建 RPC 函数

在 Supabase 控制台执行以下 SQL 检查函数是否存在：

```sql
-- 检查函数是否存在
SELECT routine_name
FROM information_schema.routines
WHERE routine_name IN ('match_memories', 'match_knowledge');
```

如果返回空结果，说明需要创建 RPC 函数。

#### 1. 核心记忆表的向量搜索函数
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

#### 2. 知识库表的向量搜索函数
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

#### 故障排查

如果创建 RPC 函数后仍然遇到 "URI too long" 错误，请检查：

1. **函数名称是否正确**：必须是 `match_memories` 和 `match_knowledge`
2. **向量维度是否匹配**：如果你的嵌入模型是 `text-embedding-3-small`，向量维度应为 1536
3. **权限问题**：确保使用 service role key 执行 SQL

#### 插件内置的回退策略

如果 RPC 函数不可用，插件会自动尝试以下方案：

1. **压缩向量精度**：将 1536 维向量压缩到 3 位小数，减少 URL 长度
2. **内存计算相似度**：先获取候选数据，再在内存中计算余弦相似度

但这些回退方案性能不如 RPC 函数，建议优先创建 RPC 函数。

## 常见问题

### Q: 如何从旧版本升级？
A: 直接安装新版本，原有配置完全兼容，不需要修改任何配置即可正常使用。新功能需要手动添加配置开启。

### Q: 混合模式下数据会同步吗？
A: 是的，存储时会同时写入 LanceDB 和 Supabase，查询时使用 LanceDB 快速搜索，再从 Supabase 获取完整数据。

### Q: 扫描大量文档会有性能问题吗？
A: 插件内置了批量处理和并发控制，支持扫描上万级别的文档，会自动处理速率限制和错误重试。

### Q: 可以自定义文本切片大小吗？
A: 目前默认切片大小是 1000 字符，重叠 200 字符，后续版本会开放配置选项。

### Q: 支持其他嵌入模型吗？
A: 目前支持 OpenAI 的嵌入模型和 BAAI/bge-m3，后续会扩展更多模型支持。

### Q: 存储分类和表是什么关系？
A: 存储分类是用户友好的名称，内部会映射到实际的表：
   - `核心记忆` → `memories` 表
   - `知识库` → `knowledge` 表
   你只需要记住友好的分类名称即可，无需关心内部表结构。

### Q: 元数据自动丰富会泄露隐私吗？
A: 不会。所有元数据都存储在本地或你的 Supabase 实例中，不会上传到第三方。可以通过配置关闭自动丰富功能。

### Q: 如何获取群组名称、用户名称等信息？
A: 这些信息需要从 OpenClaw 的 event 对象中提取。如果当前版本的 OpenClaw 不支持这些字段，元数据中对应的值将为 `undefined`。随着 OpenClaw 的更新，插件会自动获取更多的上下文信息。
