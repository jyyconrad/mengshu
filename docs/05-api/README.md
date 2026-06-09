# API 文档

本目录记录 OpenClaw 工具、CLI、REST server 和 MCP facade 的调用契约。修改 `index.ts`、`api/rest/`、`adapters/openclaw/`、`adapters/mcp/` 或 `sdk/js/` 后，应同步检查这里。

## 当前文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [memory-api.md](./memory-api.md) | 当前 | OpenClaw 工具、REST `/v1/*`、Agent 快路径和 MCP facade |
| [cli-commands.md](./cli-commands.md) | 当前 | `ltm` 命令组、参数、输出和注意事项 |

## 当前入口

| 类型 | 入口 |
|------|------|
| OpenClaw 工具 | `memory_store`、`memory_recall`、`memory_forget`、`memory_scan_directory`、`memory_cleanup`、`memory_context_fast` |
| CLI | `ltm list/stats/tables/search/query/export/scan/cleanup/kb:list/serve/status/health/migrate` |
| REST | `/v1/health`、`/v1/memories`、`/v1/recall`、`/v1/context`、`/v1/agent/*`、`/v1/console/*`、`/v1/graph/query` |
| MCP facade | `memory_save`、`memory_recall`、`memory_context`、`memory_observe`、`memory_namespaces`、`memory_forget`、`memory_health` |

## 维护规则

- 参数名必须和代码一致，不写不存在的短参数。
- REST 文档必须说明鉴权默认值：无 `server.secret` 时只允许 loopback；配置 secret 后使用 Bearer token。
- 尚未实现的能力必须标注为 facade、baseline 或方案，不写成可直接使用的服务。
