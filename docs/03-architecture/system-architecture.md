# 系统架构

本文描述当前 memory-autodb 的代码架构。更完整的中间件化路线见 [memory-middleware-architecture.md](./memory-middleware-architecture.md)。

## 总体结构

```text
OpenClaw Plugin
  index.ts
    ├─ adapters/openclaw/        # OpenClaw tools、hooks、CLI adapter
    ├─ core/                     # MemoryService、scope、核心领域类型
    ├─ storage/                  # LegacyDatabaseAdapter、in-memory repository/index
    ├─ db/providers/             # LanceDB、Supabase、Postgres provider
    ├─ processing/               # embedding、hash、legacy text splitter
    ├─ ingest/                   # canonicalize、chunk、job pipeline
    ├─ retrieval/                # prompt safety、RRF、context packer
    ├─ api/rest/ + server/        # REST router 和 Node HTTP daemon
    ├─ adapters/mcp/             # transport-agnostic MCP facade
    ├─ sdk/js/                   # JS client
    ├─ graph/ + tree/             # graph/tree baseline
    └─ console/                  # console API 和静态页面
```

## 运行模式

| 模式 | 状态 | 说明 |
|------|------|------|
| Embedded OpenClaw plugin | 当前主路径 | `index.ts` 注册工具、钩子和 CLI |
| 本机 server | 已有基线 | `ltm serve` 启动 Node HTTP server，默认 `127.0.0.1:3847` |
| MCP facade | 已有基线 | 提供工具注册表和调用映射，尚不启动 transport |
| JS SDK | 已有基线 | 面向 REST API 的 client |
| Remote/backend-proxy | 方案中 | 配置类型已保留，完整实现后续推进 |

## 核心链路

### 保存记忆

```text
memory_store / REST / MCP
  -> DefaultMemoryService.storeMemory()
  -> LegacyDatabaseAdapter
  -> DatabaseProvider
  -> LanceDB / Supabase / Postgres
```

OpenClaw 工具层会在调用 service 前生成 embedding、content hash、category 和 metadata。

### 召回记忆

```text
memory_recall / REST / MCP
  -> DefaultMemoryService.recall()
  -> embeddings.embed(query)
  -> repository.query(vector + filters + scope)
  -> RecallResult
```

上下文构建再经过 `retrieval/context-packer.ts`，输出 prompt-safe context block。

### Agent 快路径

```text
memory_context_fast / POST /v1/agent/context
  -> api/agent-fast-path.ts
  -> core/slot-context-builder.ts
  -> core/slot-snapshot.ts
  -> 5 slot context + telemetry
```

5 问题语义协议是 Agent 上下文视图，不是 legacy 主表的硬约束。

### 目录扫描

```text
memory_scan_directory / ltm scan
  -> ingest/adapters/file-system.ts
  -> ingest/canonicalize.ts
  -> ingest/chunker.ts
  -> ingest/pipeline.ts
  -> documents / chunks / jobs / audit baseline
```

当前 pipeline 先建立可回放的 document/chunk/job 基线；legacy provider 写入和完整持久化迁移按阶段推进。

## 存储层

| 层 | 文件 | 说明 |
|----|------|------|
| Provider contract | `db/types.ts` | legacy `MemoryEntry` 和 `DatabaseProvider` |
| Provider factory | `db/factory.ts` | 根据配置创建 LanceDB、Supabase、Postgres 或 hybrid provider |
| Legacy adapter | `storage/legacy-database-adapter.ts` | 将 legacy provider 暴露为 core repository |
| In-memory baseline | `storage/repositories/in-memory.ts` | 中间件 contract 测试和 baseline |
| Text index | `storage/indexes/in-memory-bm25.ts` | BM25/文本检索 baseline |

## 对外接口

| 接口 | 文件 | 当前状态 |
|------|------|----------|
| OpenClaw tools | `index.ts`、`adapters/openclaw/tools.ts` | 当前可用 |
| OpenClaw hooks | `adapters/openclaw/hooks.ts` | 自动召回和自动捕获 |
| CLI | `index.ts`、`adapters/openclaw/cli.ts` | 当前可用 |
| REST | `api/rest/router.ts`、`server/daemon.ts` | 当前可用 |
| MCP facade | `adapters/mcp/server.ts`、`adapters/mcp/tools.ts` | facade 可用，transport 未绑定 |
| JS SDK | `sdk/js/client.ts` | REST client baseline |
| Console | `console/api.ts`、`console/web/` | Overview/Lookup/Graph/Jobs baseline |

## 架构决策

### 1. OpenClaw 只是 adapter

业务逻辑逐步迁入 `core/`、`ingest/`、`retrieval/`、`storage/`。`index.ts` 保留插件注册、配置装配和兼容入口。

### 2. 保留 legacy provider

LanceDB、Supabase、Postgres provider 已存在，短期不重写存储层。中间件能力通过 `LegacyDatabaseAdapter` 和新 in-memory baseline 增量落地。

### 3. Scope 是新 API 的强边界

REST、MCP、SDK、console 和 graph/tree 查询都应使用 `MemoryScope` 或可规范化的 scope input。server/remote 模式不得绕过 scope filter。

### 4. 快路径不等待重语义处理

Agent 启动上下文优先走缓存和轻量构建；embedding、抽取、graph/tree、summary 等重处理放到 warm/cold path。
