# Memory API

本页记录 mengshu 记忆中间件的完整 API 接口，涵盖四个接入层：

1. **OpenClaw 工具** — 插件宿主内直接调用
2. **REST API** — 本机 HTTP 服务（`ms serve`）
3. **MCP facade** — MCP 协议工具（stdio/HTTP transport）
4. **JavaScript SDK** — 通过 REST API 的编程客户端

参数以源码为准：[index.ts](../../index.ts)、[packages/api/src/rest/router.ts](../../packages/api/src/rest/router.ts)、[packages/mcp/src/tools.ts](../../packages/mcp/src/tools.ts)、[packages/api/src/sdk/client.ts](../../packages/api/src/sdk/client.ts)。旧路径 `adapters/rest/*`、`adapters/mcp/*`、`adapters/sdk/*` 仅保留兼容 re-export。

## 架构概述

```
┌─────────────────────────────────────────────────────────┐
│                     调用方                               │
│  OpenClaw Agent │ MCP Client │ REST Client │ JS SDK     │
└────────┬────────────┬──────────────┬───────────┬────────┘
         │            │              │           │
    ┌────▼────┐  ┌────▼────┐  ┌─────▼────┐ ┌───▼────┐
    │ OpenClaw│  │  MCP    │  │  REST    │ │  SDK   │
    │ Adapter │  │ Facade  │  │  Router  │ │ Client │
    └────┬────┘  └────┬────┘  └─────┬────┘ └───┬────┘
         │            │              │           │
         └────────────┴──────┬───────┴───────────┘
                             │
                    ┌────────▼────────┐
                    │  MemoryService  │
                    │  (core/types)   │
                    └────────┬────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
         ┌────▼────┐  ┌─────▼─────┐  ┌────▼────┐
         │ LanceDB │  │  Supabase │  │  Hybrid │
         └─────────┘  └───────────┘  └─────────┘
```

所有接入层最终都调用 `MemoryService` 接口（定义在 `core/service-types.ts`），保证行为一致。

## OpenClaw 工具

| 工具 | 作用 |
|------|------|
| `memory_store` | 保存一条长期记忆 |
| `memory_recall` | 召回相关记忆 |
| `memory_forget` | 按 ID、查询或过滤条件删除记忆 |
| `memory_scan_directory` | 扫描 Markdown 目录并写入 ingestion pipeline |
| `memory_cleanup` | 按数据类型、时间或过滤条件清理数据 |
| `memory_context_fast` | Agent 启动快路径，返回 5 槽位上下文 |

### `memory_store`

```json
{
  "text": "用户偏好使用 TypeScript",
  "importance": 0.8,
  "category": "preference",
  "metadata": {
    "source": "manual"
  },
  "storageCategory": "核心记忆"
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `text` | 是 | - | 要保存的文本 |
| `importance` | 否 | `0.7` | 重要性，范围 0-1 |
| `category` | 否 | 自动分类或 `other` | `core`、`preference`、`fact`、`entity`、`decision`、`task`、`plan`、`goal`、`other` |
| `metadata` | 否 | `{}` | 自定义元数据 |
| `storageCategory` | 否 | `核心记忆` | 用户友好分类，映射到底层表 |

### `memory_recall`

```json
{
  "query": "用户喜欢什么代码风格",
  "limit": 5,
  "minScore": 0.1,
  "includeDocuments": false,
  "filter": {
    "category": "preference"
  },
  "category": "核心记忆",
  "searchAll": false
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `query` | 是 | - | 检索查询 |
| `limit` | 否 | `5` | 返回数量 |
| `minScore` | 否 | `0.1` | 最低相似度 |
| `includeDocuments` | 否 | `false` | 是否包含扫描文档数据 |
| `filter` | 否 | - | 元数据过滤条件 |
| `category` | 否 | - | 存储分类 |
| `searchAll` | 否 | `false` | 跨分类搜索 |
| `knowledgeBase` | 否 | - | 指定 `knowledge_*` 表 |

### `memory_forget`

```json
{
  "memoryId": "mem_123"
}
```

也可以传入：

```json
{
  "query": "旧的数据库方案"
}
```

或：

```json
{
  "filter": {
    "category": "obsolete"
  }
}
```

### `memory_scan_directory`

```json
{
  "directory": "./docs",
  "ignorePaths": ["node_modules", "dist"],
  "ignoreRules": ["*.draft.md"],
  "targetTable": "knowledge",
  "autoEnrichMetadata": true
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `directory` | 是 | - | 要扫描的目录 |
| `ignorePaths` | 否 | `[]` | 额外忽略路径 |
| `ignoreRules` | 否 | `[]` | gitignore 风格规则 |
| `targetTable` | 否 | `knowledge` | 目标表 |
| `autoEnrichMetadata` | 否 | `true` | 是否补充文件路径、更新时间等元数据 |

### `memory_cleanup`

```json
{
  "dataType": "document",
  "olderThanDays": 30,
  "filter": {
    "source": "scan"
  }
}
```

### `memory_context_fast`

```json
{
  "task": "整理 mengshu 文档",
  "tokenBudget": 4000,
  "latencyBudgetMs": 80
}
```

返回结构包含：

- `slots.profile`
- `slots.task_context`
- `slots.rules`
- `slots.experience`
- `slots.resource`
- `content`
- `taskHints`
- `actions`
- `freshness`
- `warnings`
- `telemetry`

## REST API

本机 server 由 `ms serve` 启动，默认监听 `127.0.0.1:3847`。

安全默认值：

- 没有 `server.secret` 时，只允许 loopback 请求。
- 配置 `server.secret` 后，需要 `Authorization: Bearer <secret>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/health` | 服务健康和记录数 |
| `POST` | `/v1/memories` | 写入 `MemoryRecord` |
| `POST` | `/v1/recall` | 召回记忆 |
| `POST` | `/v1/context` | 召回并打包 prompt-safe context |
| `POST` | `/v1/graph/query` | 可选图谱查询（需注入 graph 模块） |
| `POST` | `/v1/console/overview` | Web Console 总览 |
| `POST` | `/v1/console/lookup` | Web Console 速查 |
| `POST` | `/v1/console/graph` | Web Console 图查询 |
| `GET` | `/v1/console/jobs` | Job 队列状态 |
| `POST` | `/v1/console/candidates` | 候选区列表 |
| `POST` | `/v1/console/candidates/review` | 候选记忆审核（approve/reject） |
| `POST` | `/v1/agent/context` | Agent 快路径上下文（5-slot） |
| `POST` | `/v1/agent/observe` | Agent 运行中轻量 observation |
| `POST` | `/v1/agent/lookup` | Agent 运行中速查 |
| `POST` | `/v1/agent/session/commit` | Agent 会话结束提交 |

### `GET /v1/health`

```bash
curl http://127.0.0.1:3847/v1/health
```

响应：

```json
{
  "ok": true,
  "records": 42
}
```

### `POST /v1/memories`

```json
{
  "record": {
    "id": "mem_1",
    "scope": {
      "tenantId": "local",
      "appId": "openclaw",
      "userId": "default",
      "projectId": "default",
      "agentId": "default",
      "namespace": "memories"
    },
    "kind": "fact",
    "text": "mengshu 默认使用本机 LanceDB",
    "contentHash": "hash_1",
    "importance": 0.7,
    "category": "fact",
    "dataType": "memory",
    "tableName": "memories",
    "metadata": {},
    "provenance": {
      "source": "user"
    },
    "createdAt": 1760000000000
  }
}
```

### `POST /v1/recall`

```json
{
  "query": "默认数据库是什么",
  "limit": 5,
  "scope": {
    "appId": "openclaw",
    "namespace": "memories"
  }
}
```

### `POST /v1/context`

```json
{
  "query": "整理项目文档",
  "limit": 5,
  "title": "Retrieved Context"
}
```

### `POST /v1/agent/context`

```json
{
  "scope": {
    "appId": "openclaw",
    "namespace": "memories"
  },
  "task": "准备一次架构评审",
  "intent": "writing",
  "constraints": ["只使用当前仓库文档"],
  "tokenBudget": 4000,
  "latencyBudgetMs": 80
}
```

### `POST /v1/console/lookup`

```json
{
  "scope": {
    "tenantId": "local",
    "appId": "openclaw",
    "userId": "default",
    "projectId": "default",
    "agentId": "default",
    "namespace": "knowledge"
  },
  "query": "memory tree",
  "limit": 10
}
```

private 内容不会返回 raw，只显示 `[private]` 预览。

## MCP facade

[packages/mcp/src/server.ts](../../packages/mcp/src/server.ts) 当前是 transport-agnostic facade，不直接启动 stdio 或 HTTP MCP transport。工具注册表定义在 [packages/mcp/src/tools.ts](../../packages/mcp/src/tools.ts)。

### 基础工具（8 个，始终可用）

| MCP tool | 说明 |
|----------|------|
| `memory_save` | 写入一条记忆记录 → `MemoryService.storeMemory()` |
| `memory_recall` | 向量召回相关记忆 → `MemoryService.recall()` |
| `memory_context` | 召回并打包 prompt-safe context → `MemoryService.buildContext()` |
| `memory_observe` | 观察并保存记忆（当前等同 `memory_save`） → `MemoryService.storeMemory()` |
| `memory_ingest` | 批量导入外部源 [Roadmap] — 返回未实现提示 |
| `memory_namespaces` | 返回已注册的 namespace 列表 |
| `memory_forget` | 按 ids 或 filter 删除记忆 → `MemoryService.delete()` |
| `memory_health` | 服务健康状态 → `MemoryService.health()` |

### 快路径工具（3 个，注入 AgentFastPathService 后可用）

| MCP tool | 说明 |
|----------|------|
| `memory_context_fast` | 5-slot Agent 任务上下文 → `AgentFastPathService.context()` |
| `memory_observe_light` | 运行中轻量观察提交 → `AgentFastPathService.observeLight()` |
| `memory_lookup` | 运行中按需速查 → `AgentFastPathService.lookup()` |

## JavaScript SDK

SDK 位于 `packages/api/src/sdk/`，通过 REST API 访问 MemoryService。不依赖 OpenClaw，也不直接访问本地数据库。`adapters/sdk/` 与 `sdk/js/` 保留为旧 deep import 的兼容 re-export。

### 初始化

```typescript
import { MemoryClient } from "mengshu/sdk/js/client";

const client = new MemoryClient({
  baseUrl: "http://127.0.0.1:3847",
  token: "your-server-secret",  // 可选，与 server.secret 对应
  timeoutMs: 30_000,            // 可选，默认 30s
});
```

### 方法列表

| 方法 | 对应端点 | 说明 |
|------|----------|------|
| `client.health()` | `GET /v1/health` | 返回 `HealthSnapshot` |
| `client.storeMemory(input)` | `POST /v1/memories` | 写入记忆，返回 `StoreMemoryResult` |
| `client.recall(input)` | `POST /v1/recall` | 召回记忆，返回 `RecallResult` |
| `client.buildContext(input)` | `POST /v1/context` | 打包 prompt-safe context，返回 `ContextBlock` |

### 错误处理

SDK 抛出 `MemoryClientError`：

```typescript
try {
  await client.recall({ query: "test" });
} catch (e) {
  if (e instanceof MemoryClientError) {
    console.error(e.status, e.code, e.message);
  }
}
```

| 属性 | 类型 | 说明 |
|------|------|------|
| `status` | `number?` | HTTP 状态码 |
| `code` | `string?` | 错误代码：`timeout`、`request_failed` |
| `body` | `unknown?` | 原始响应体 |

## CLI 命令总览

CLI 入口为 `ms`（全局安装后可用），命令注册在 `bin/ms.ts`。

| 命令 | 说明 |
|------|------|
| `ms` (无参数) | 启动 MCP stdio server（首次使用自动引导配置） |
| `ms init` | 交互式初始化配置 |
| `ms stats` | 显示记忆统计（总数、memories、documents、表级统计） |
| `ms search <query>` | 搜索记忆（支持 `--limit`、`--min-score`） |
| `ms doctor` | 诊断配置和服务健康状态 |
| `ms mcp` | MCP 相关子命令 |
| `ms serve` | 启动 REST server |
| `ms project` | 项目级操作 |
| `ms why <query>` | 解释为什么某条记忆被召回 |
| `ms forget` | 交互式删除记忆 |
| `ms recall <query>` | 快速召回并显示结果 |
| `ms migrate-home` | 迁移旧版 home 目录到新路径 |

## 错误格式

OpenClaw 工具返回 tool content 文本；REST API 返回 JSON：

```json
{
  "error": "query is required"
}
```

常见 HTTP 状态：

| 状态码 | 说明 |
|--------|------|
| `400` | 请求体缺失或字段类型错误 |
| `401` | Bearer token 缺失或不匹配 |
| `403` | 非 loopback、非 HTTPS 或路径访问被拒绝 |
| `404` | 路由不存在或可选模块未注入 |
| `405` | HTTP 方法不允许 |
| `500` | 服务内部错误 |
