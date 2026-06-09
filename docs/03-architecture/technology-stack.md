# 技术栈

本文按当前 `package.json` 和 `config.ts` 记录真实依赖与运行时约束。

## 运行时

| 项 | 当前值 | 说明 |
|----|--------|------|
| 语言 | TypeScript | ESM 项目，`package.json` 设置 `"type": "module"` |
| Node.js | 18+ | 代码使用 Node HTTP、fs/promises、URL 等标准能力 |
| 测试 | Vitest `^4.0.18` | `npm test` 执行 `vitest run` |
| 类型检查 | TypeScript | 使用 `npx tsc --noEmit` |

## 主要依赖

| 依赖 | 当前版本范围 | 用途 |
|------|--------------|------|
| `@lancedb/lancedb` | `^0.26.2` | 本地向量数据库 |
| `@supabase/supabase-js` | `^2.45.0` | Supabase provider |
| `pg` | `^8.16.0` | Postgres provider |
| `openai` | `^6.22.0` | OpenAI-compatible embedding client |
| `@sinclair/typebox` | `0.34.48` | OpenClaw config/tool schema |
| `front-matter` | `^4.0.2` | Markdown front matter 解析 |
| `glob` | `^10.4.5` | 文件扫描 |
| `ignore` | `^5.3.2` | ignore 规则处理 |
| `langchain` | `^0.2.0` | 兼容旧处理链路 |
| `md5` | `^2.3.0` | legacy 哈希依赖 |
| `p-limit` | `^6.1.0` | 并发控制 |
| `p-retry` | `^6.2.0` | 重试 |

## 存储后端

| 后端 | 状态 | 说明 |
|------|------|------|
| LanceDB | 当前支持 | 默认本地向量存储 |
| Supabase | 当前支持 | PostgreSQL + pgvector，依赖 service key |
| Postgres | 当前支持 | provider 已存在，适合服务端部署 |
| Hybrid | 当前支持 | 本地向量索引 + 云端持久化路径 |
| In-memory repository | 当前支持 | 中间件 contract baseline 和测试 |

## 嵌入模型

`config.ts` 中的 `vectorDimsForModel()` 校验模型维度。当前内置维度包括：

| 模型 | 维度 |
|------|------|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `BAAI/bge-m3` | 1024 |
| `nomic-embed-text`、`nomic-embed-text:v1.5` | 768 |
| `mxbai-embed-large`、`mxbai-embed-large:v1` | 1024 |
| `all-minilm`、`all-minilm:v6`、`all-minilm:v6.5` | 384 |
| `snowflake-arctic-embed:l` | 1024 |
| `snowflake-arctic-embed:m` | 768 |
| `snowflake-arctic-embed:s` | 512 |
| `modelscope.cn/Qwen/Qwen3-Embedding-0.6B-GGUF:latest` | 1024 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 |

更换 embedding 模型前必须确认现有表的向量维度。维度不一致时，需要迁移或重建索引。

## 配置文件

| 文件 | 用途 |
|------|------|
| [config.example.json](../../config.example.json) | 基础配置示例 |
| [config/ollama.example.json](../../config/ollama.example.json) | Ollama/OpenAI-compatible 示例 |
| [config/routing-rules.example.json](../../config/routing-rules.example.json) | 多知识库路由规则示例 |
| [openclaw.plugin.json](../../openclaw.plugin.json) | OpenClaw 插件 manifest |

## 验证命令

```bash
npm test
npx tsc --noEmit
```

稳定回归命令见 [测试文档](../07-test/plugin-test.md)。
