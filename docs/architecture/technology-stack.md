# 技术栈

> **版本**: v2.0 (2026-06-16)
> **代码规模**: 246 个 TypeScript 文件 (不含 node_modules)
> **单一事实来源**: `package.json` + `config.ts`

本文记录 mengshu v1.0.2 (P0-P4 已交付) 的真实依赖与运行时约束。

## 运行时

| 项 | 当前值 | 说明 |
|----|--------|------|
| 语言 | TypeScript (ESM) | `package.json` 设置 `"type": "module"` |
| Node.js | 18+ | 代码使用 Node HTTP、fs/promises、URL 等标准能力 |
| 测试框架 | Vitest `^4.0.18` | `npm test` 执行 `vitest run`，覆盖 100 文件 / 1101 测试 |
| 类型检查 | TypeScript Strict | 使用 `npx tsc --noEmit`，CI 强制 exit 0 |
| CLI 执行器 | tsx `^4.22.4` | 直接运行 TS 文件（如 `bin/ms.ts`） |

## 核心依赖（按用途分类）

### 协议层 / 适配器

| 依赖 | 当前版本 | 用途 |
|------|----------|------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | **MCP Server 适配**（`packages/mcp/src/`），支持 stdio/SSE 双通道 |
| `@sinclair/typebox` | `0.34.48` | **OpenClaw 插件 schema**（`openclaw.plugin.json`），config/tool 验证 |
| `openclaw` | `*` (devDep) | OpenClaw Runtime 类型定义（仅编译时依赖） |

### LLM / Embedding

| 依赖 | 当前版本 | 用途 |
|------|----------|------|
| `openai` | `^6.22.0` | **OpenAI SDK**（`processing/llm-client.ts` / `processing/embeddings.ts`），支持 OpenAI-compatible 端点（Ollama、通义千问等） |
| `langchain` | `^0.2.0` | 兼容旧处理链路（legacy，待逐步移除） |

### 存储 / 数据库

| 依赖 | 当前版本 | 用途 |
|------|----------|------|
| `@lancedb/lancedb` | `^0.26.2` | **可选本地向量数据库**（`storage/providers/lancedb.ts`），仅 `dbType=lancedb` 时使用 |
| `@supabase/supabase-js` | `^2.45.0` | **Supabase 云端存储**（`storage/providers/supabase.ts`），需 service key |
| `pg` | `^8.16.0` | **Postgres provider**（`storage/providers/postgres.ts`），当前推荐的跨产品共享后端 |

### 工具库

| 依赖 | 当前版本 | 用途 |
|------|----------|------|
| `front-matter` | `^4.0.2` | Markdown front matter 解析（`ingest/chunker.ts`） |
| `glob` | `^10.4.5` | 文件扫描（`ingest/agent-history/`） |
| `ignore` | `^5.3.2` | `.gitignore` 规则处理 |
| `md5` | `^2.3.0` | legacy 哈希依赖（待逐步移除） |
| `p-limit` | `^6.1.0` | **并发控制**（批量 embedding / LLM 调用） |
| `p-retry` | `^6.2.0` | **重试机制**（LLM/embedding 容错） |

## 可选依赖（跨平台构建）

| 依赖 | 用途 |
|------|------|
| `@rolldown/binding-*` (5 平台) | Rolldown bundler 原生绑定（darwin-arm64/x64, linux-arm64/x64, win32-x64） |

## 开发依赖

| 依赖 | 用途 |
|------|------|
| `@types/node` / `@types/pg` | TypeScript 类型定义 |
| `@vitest/coverage-v8` | 测试覆盖率报告（目标 80%+） |
| `dotenv` | 本地开发环境变量加载 |

## 存储后端（多 provider 架构）

| 后端 | 实施状态 | 代码路径 | 说明 |
|------|----------|----------|------|
| **LanceDB** | ✅ 已完成 | `storage/providers/lancedb.ts` | 可选本地向量存储，显式 `dbType=lancedb` 时使用 |
| **Supabase** | ✅ 已完成 | `storage/providers/supabase.ts` | PostgreSQL + pgvector，需 service key |
| **Postgres** | ✅ 已完成 | `storage/providers/postgres.ts` | 当前推荐共享后端，适合 OpenClaw/Codex/Claude Code 共用 |
| **Hybrid** | ✅ 已完成 | `storage/providers/hybrid.ts` | 本地向量索引 + 云端持久化路径 |
| **In-memory** | ✅ 已完成 (测试用) | `storage/repositories/in-memory-*.ts` | 中间件 contract baseline 和单元测试 |

## Embedding 模型支持

`config.ts` 中的 `vectorDimsForModel()` 校验模型维度。当前内置维度：

| 模型 | 维度 | 提供商 |
|------|------|--------|
| `text-embedding-3-small` | 1536 | OpenAI |
| `text-embedding-3-large` | 3072 | OpenAI |
| `BAAI/bge-m3` | 1024 | HuggingFace / Ollama |
| `nomic-embed-text` / `nomic-embed-text:v1.5` | 768 | Ollama |
| `mxbai-embed-large` / `mxbai-embed-large:v1` | 1024 | Ollama |
| `all-minilm` / `all-minilm:v6` / `all-minilm:v6.5` | 384 | Ollama |
| `snowflake-arctic-embed:l` | 1024 | Snowflake / Ollama |
| `snowflake-arctic-embed:m` | 768 | Snowflake / Ollama |
| `snowflake-arctic-embed:s` | 512 | Snowflake / Ollama |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | 阿里通义 / Ollama |
| `modelscope.cn/Qwen/Qwen3-Embedding-0.6B-GGUF:latest` | 1024 | ModelScope 镜像 |

**迁移风险提示**：更换 embedding 模型前必须确认现有表的向量维度。维度不一致时，需要迁移或重建索引。

## LLM 模型支持

通过 OpenAI SDK 支持所有 OpenAI-compatible 端点：

| 提供商 | 端点示例 | 配置路径 |
|--------|----------|----------|
| OpenAI | `https://api.openai.com/v1` | `llm.baseURL` |
| Ollama | `http://localhost:11434/v1` | `llm.baseURL` |
| 阿里通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `llm.baseURL` |
| 其他 OpenAI-compatible | 自定义 | `llm.baseURL` |

**模型分工**（`llm` 配置块）：

- `extractionModel`：结构化提取（entity/relation/attribute），推荐 `gpt-4o-mini`
- `summarizationModel`：树摘要生成，推荐 `gpt-4o-mini`
- `reasoningModel`：复杂推理任务，推荐 `gpt-4o`（可选）

## CLI 入口（bin 命令组）

| 命令 | 路径 | 用途 |
|------|------|------|
| `ms` / `mengshu` | `bin/ms.ts` | 统一 CLI 入口，子命令包括 init/doctor/why/recall/forget/import/project/stats/search/scan/serve/mcp |

## 配置文件示例

| 文件 | 用途 |
|------|------|
| [config.example.json](../../config.example.json) | OpenAI 基础配置 |
| [config/ollama.example.json](../../config/ollama.example.json) | Ollama 本地推理配置 |
| [config/routing-rules.example.json](../../config/routing-rules.example.json) | 多知识库路由规则 |
| [openclaw.plugin.json](../../openclaw.plugin.json) | OpenClaw 插件 manifest（含 tool/config schema） |

## 验证命令

```bash
# 类型检查
npx tsc --noEmit

# 单元测试（100 文件 / 1101 测试）
npm test

# 测试覆盖率（目标 80%+）
npm run test:coverage

# Golden set 评估（算法回归）
npm run eval:quick

# CLI 健康检查
ms doctor
```

稳定回归命令见 [测试文档](../07-test/plugin-test.md)。

## 技术栈演进历史

- **v1.0.0 (2025-12)**：初始版本，LanceDB + OpenAI
- **v1.0.1 (2026-01)**：新增 Supabase/Postgres provider，多后端架构成型
- **v1.0.2 (2026-03)**：P0-P4 算法层交付，MCP Server 适配完成，OpenClaw 插件正式对外
- **v2.0 (2026-06-16)**：技术栈文档首次系统化整理，反映 246 个 TS 文件规模

## 相关文档

- [系统架构](system-architecture.md) — 整体架构与模块划分
- [统一设计决策](../../docs/04-design/04.2-detail/memory-system-unified-design.md) — D-01~D-23 关键决策
- [配置管理](../05-api/config-api.md) — 三层配置加载机制
