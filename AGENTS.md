# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## 项目概述

这是一个 OpenClaw 长期内存插件（v2.1），使用 LanceDB 向量数据库存储对话记忆，支持 Supabase 云端存储和混合模式，提供自动记忆捕获、自动召回和知识库扫描功能。

### v2.1 核心升级

1. **多表存储架构**：`memories` 表（对话记忆）和 `knowledge` 表（文档知识）分离存储
2. **增强型 CLI 命令**：新增 `ltm tables`、`ltm query`、`ltm export` 命令
3. **元数据自动丰富**：自动捕获 OpenClaw 上下文（sessionId、conversationId 等）
4. **配置扩展**：支持表级配置、扫描目标表配置

## 常用命令

### 开发
```bash
# 运行测试
npm test
# 运行测试并观察变化
npm test -- --watch
# 类型检查
npx tsc
# 运行单个测试文件
npx vitest run index.test.ts
```

### CLI 命令
```bash
# 查看统计
ltm stats

# 列出所有表
ltm tables

# 搜索记忆
ltm search "查询内容" --limit 10

# 高级查询
ltm query --table memories --filter '{"category": "preference"}'

# 导出数据
ltm export --table knowledge --format json --output knowledge.json

# 扫描目录
ltm scan /path/to/docs --target-table knowledge

# 清理数据
ltm cleanup --older-than 30 --table knowledge
```

## 配置

插件配置在 `openclaw.plugin.json` 中定义：

### 基础配置
```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "dbType": "lancedb",
  "dbPath": "~/.openclaw/memory/autodb",
  "autoCapture": true,
  "autoRecall": true
}
```

### 混合模式配置
```json
{
  "embedding": { /* ... */ },
  "dbType": "lancedb",
  "dbPath": "~/.openclaw/memory/autodb",
  "supabase": {
    "url": "${SUPABASE_URL}",
    "serviceKey": "${SUPABASE_SERVICE_KEY}"
  },
  "scanner": {
    "targetTable": "knowledge",
    "autoEnrichMetadata": true
  },
  "tables": {
    "memories": { "enabled": true },
    "knowledge": { "enabled": true }
  }
}
```

## 代码架构

### 核心文件

- **`index.ts`**: 主入口文件
  - 插件注册逻辑
  - 核心工具：`memory_recall`、`memory_store`、`memory_scan_directory`、`memory_cleanup`
  - 生命周期钩子：`before_agent_start`（自动召回）、`agent_end`（自动捕获）
  - CLI 命令注册（`ltm` 命令组）
  - 安全过滤：prompt 注入检测、内容转义
  - 元数据自动丰富逻辑

- **`config.ts`**: 配置管理
  - 配置 schema 解析和验证
  - 嵌入模型维度映射
  - 环境变量解析
  - 新增配置：`scanner.targetTable`、`scanner.autoEnrichMetadata`、`tables`

- **`db/types.ts`**: 类型定义
  - `MemoryEntry`、`MemoryMetadata` 接口
  - `TableName` 类型：`"memories" | "knowledge" | "documents"`
  - `DataType` 类型：`"memory" | "document" | "knowledge"`
  - `DatabaseProvider` 接口

- **`db/providers/`**: 数据库提供者实现
  - `lancedb.ts`：LanceDB 本地向量数据库
  - `supabase.ts`：Supabase PostgreSQL + pgvector
  - `hybrid.ts`：混合模式（LanceDB + Supabase）

- **`scanner/`**: 目录扫描模块
  - `scanner-coordinator.ts`：扫描协调器
  - `file-scanner.ts`：文件扫描器
  - `markdown-processor.ts`：Markdown 处理器

- **`processing/`**: 数据处理模块
  - `embeddings.ts`：嵌入生成
  - `text-splitter.ts`：文本切分器
  - `hash-utils.ts`：哈希工具

- **`index.test.ts`**: 测试文件
  - 单元测试：配置解析、捕获规则、分类逻辑等
  - 端到端测试：完整的存储/检索流程

## 核心概念

1. **多表存储**
   - `memories` 表：对话记忆（用户偏好、决策、实体信息）
   - `knowledge` 表：文档知识（扫描的 Markdown 文件）
   - 支持表隔离查询和跨表搜索

2. **元数据自动丰富**
   - OpenClaw 上下文：`sessionId`、`conversationId`、`messageId`、`userId`
   - 文档元数据：`filePath`、`fileModifiedAt`、`directoryPath`、`tokenCount`
   - 技术元数据：`embeddingModel`、`pluginVersion`、`language`、`source`

3. **混合存储模式**
   - LanceDB：本地向量索引，快速搜索
   - Supabase：云端持久化，完整元数据
   - 查询时：LanceDB 搜索 → Supabase 获取完整数据

4. **批量处理优化**
   - 批量向量化：每批最多 20 个文本
   - 并发控制：最多 3 个并发请求
   - 自动重试：最多 3 次重试

## 开发注意事项

- 所有代码使用 TypeScript，严格类型检查
- 测试覆盖率目标：80%+
- 新功能需要添加对应的单元测试
- 涉及用户输入的地方需要进行安全校验
- 记忆内容在注入上下文时会自动进行 HTML 转义
- 多表操作时注意指定正确的 `tableName`
- 元数据丰富时注意隐私保护（不上传第三方）
