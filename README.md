# memory-autodb

memory-autodb 是 OpenClaw 的长期记忆插件，也正在演进为可复用的本机记忆中间件。它用 LanceDB、Supabase 或 Postgres 保存对话记忆和文档知识，提供自动捕获、自动召回、目录扫描、CLI、REST、MCP facade、JS SDK 和 Web Console 基线能力。

当前代码同时保留两条边界：

- **OpenClaw 插件兼容层**：`memory_store`、`memory_recall`、`memory_scan_directory`、`memory_cleanup`、自动捕获和自动召回继续可用。
- **memory middleware 基线**：`MemoryService`、REST `/v1/*`、MCP tool adapter、JS SDK、ingestion pipeline、BM25/RRF/context packer、graph/tree/console 的 in-memory baseline 已落地。

## 快速开始

### 安装依赖

```bash
npm install
```

### 配置嵌入模型

最小配置示例：

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "dbType": "lancedb",
  "dbPath": "~/.openclaw/memory/lancedb",
  "autoCapture": true,
  "autoRecall": true
}
```

支持 OpenAI-compatible embedding endpoint。模型维度由 [config.ts](./config.ts) 中的 `vectorDimsForModel()` 校验；更换模型前先确认数据库向量维度一致。

### 运行测试

```bash
npm test
npx tsc --noEmit
```

`npm test` 包含若干本机 embedding 集成测试；如果本机没有启动对应服务，可能出现环境性的连接失败。更稳定的回归命令见 [测试文档](./docs/07-test/plugin-test.md)。

## 主要能力

| 能力 | 当前入口 | 说明 |
|------|----------|------|
| 保存记忆 | `memory_store`、`POST /v1/memories`、MCP `memory_save` | 保存用户偏好、事实、决策、任务和知识条目 |
| 召回记忆 | `memory_recall`、`POST /v1/recall`、MCP `memory_recall` | 支持向量检索、过滤、跨分类搜索 |
| 构建上下文 | `POST /v1/context`、MCP `memory_context` | 输出 prompt-safe context block |
| Agent 快路径 | `memory_context_fast`、`POST /v1/agent/context` | 返回 5 槽位任务上下文 |
| 扫描目录 | `memory_scan_directory`、`ltm scan` | 扫描 Markdown 文件并进入 ingestion pipeline |
| 管理数据 | `ltm stats/tables/query/export/cleanup/migrate` | 统计、查询、导出、清理和迁移估算 |
| 本机服务 | `ltm serve` | 启动 REST server 和 `/console` 静态页面 |

## CLI 示例

```bash
# 查看统计
ltm stats

# 搜索核心记忆
ltm search "用户偏好" --limit 5

# 扫描 Markdown 目录到知识库
ltm scan ./docs --category 知识库 --ignore node_modules dist

# 启动本机 REST server，默认 127.0.0.1:3847
ltm serve
```

完整命令说明见 [CLI 命令](./docs/05-api/cli-commands.md)。

## REST 示例

启动服务：

```bash
ltm serve --host 127.0.0.1 --port 3847
```

健康检查：

```bash
curl http://127.0.0.1:3847/v1/health
```

构建上下文：

```bash
curl -X POST http://127.0.0.1:3847/v1/context \
  -H "Content-Type: application/json" \
  -d '{"query":"当前项目的记忆架构是什么","limit":5}'
```

更多接口见 [Memory API](./docs/05-api/memory-api.md)。

## 文档入口

| 读者目标 | 文档 |
|----------|------|
| 快速了解文档结构 | [docs/README.md](./docs/README.md) |
| 使用 CLI、REST、OpenClaw 工具 | [docs/05-api](./docs/05-api/README.md) |
| 理解当前中间件架构 | [memory-middleware-architecture.md](./docs/03-architecture/memory-middleware-architecture.md) |
| 理解长期深层优化方案 | [memory-autodb-deep-optimization-architecture.md](./docs/03-architecture/memory-autodb-deep-optimization-architecture.md) |
| 查看数据模型和 schema | [docs/06-database/schema.md](./docs/06-database/schema.md) |
| 查看测试和验证命令 | [docs/07-test/plugin-test.md](./docs/07-test/plugin-test.md) |
| 查看版本变更 | [docs/09-changelog](./docs/09-changelog/README.md) |

`docs/03-architecture/copy-from-mate/` 是外部 Banto/iFlyMate 记忆系统材料，用于架构参考，不是 memory-autodb 当前实现承诺。

## 项目结构

```text
.
├── index.ts                 # OpenClaw 插件注册入口
├── config.ts                # 配置 schema、默认值、模型维度
├── core/                    # MemoryService、scope、核心领域类型
├── adapters/                # OpenClaw 与 MCP adapter
├── api/rest/                # REST router、鉴权和契约类型
├── server/                  # Node HTTP daemon
├── ingest/                  # canonicalize、chunk、job pipeline
├── retrieval/               # prompt safety、RRF、context packer
├── graph/                   # in-memory graph baseline
├── tree/                    # source/topic/global tree baseline
├── console/                 # Console API 和静态页面
├── storage/                 # legacy adapter、in-memory repo 和索引
├── db/providers/            # LanceDB、Supabase、Postgres provider
└── docs/                    # 长期维护文档
```

## 状态说明

| 版本线 | 状态 |
|--------|------|
| v2.1 | OpenClaw 插件、多表存储、CLI、扫描、自动捕获/召回的兼容能力 |
| v3.0 | 5 问题语义协议、Agent 快路径、候选区和 Slot Context Builder |
| v4.0 | MemoryService、REST/MCP/SDK/ingestion/retrieval/graph/tree/console 的中间件基线 |
| vNext | 深层优化方案，包含更完整的本地可回放、SlotSnapshot、治理、图谱和记忆树路线 |

发布和变更记录以 [docs/09-changelog](./docs/09-changelog/README.md) 为准。
