# Memory API

本页记录当前代码中可调用的 OpenClaw 工具、REST API 和 MCP facade。参数以 [index.ts](../../index.ts)、[api/rest/router.ts](../../api/rest/router.ts) 和 [adapters/mcp/tools.ts](../../adapters/mcp/tools.ts) 为准。

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
  "task": "整理 memory-autodb 文档",
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

本机 server 由 `ltm serve` 启动，默认监听 `127.0.0.1:3847`。

安全默认值：

- 没有 `server.secret` 时，只允许 loopback 请求。
- 配置 `server.secret` 后，需要 `Authorization: Bearer <secret>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/health` | 服务健康和记录数 |
| `POST` | `/v1/memories` | 写入 `MemoryRecord` |
| `POST` | `/v1/recall` | 召回记忆 |
| `POST` | `/v1/context` | 召回并打包 prompt-safe context |
| `POST` | `/v1/graph/query` | 可选图谱查询 |
| `POST` | `/v1/console/overview` | Web Console 总览 |
| `POST` | `/v1/console/lookup` | Web Console 速查 |
| `POST` | `/v1/console/graph` | Web Console 图查询 |
| `GET` | `/v1/console/jobs` | Job 队列状态 |
| `POST` | `/v1/agent/context` | Agent 快路径上下文 |
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
    "text": "memory-autodb 默认使用本机 LanceDB",
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

[adapters/mcp/server.ts](../../adapters/mcp/server.ts) 当前是 transport-agnostic facade，不直接启动 stdio 或 HTTP MCP transport。

| MCP tool | 状态 | 说明 |
|----------|------|------|
| `memory_save` | 可用 | 转调 `MemoryService.storeMemory()` |
| `memory_recall` | 可用 | 转调 `MemoryService.recall()` |
| `memory_context` | 可用 | 转调 `MemoryService.buildContext()` |
| `memory_observe` | 可用 | 当前同样转调 `storeMemory()` |
| `memory_ingest` | 占位 | 返回未实现提示 |
| `memory_namespaces` | 可用 | 返回静态 namespace 列表 |
| `memory_forget` | 可用 | 转调 `MemoryService.delete()` |
| `memory_health` | 可用 | 转调 `MemoryService.health()` |

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
