# OpenClaw 插件设计

本文描述 OpenClaw 插件层的职责。中间件核心服务见 [系统架构](../../03-architecture/system-architecture.md)。

## 模块职责

`index.ts` 是 OpenClaw 插件注册入口，负责把配置、provider、embedding、service、pipeline 和 adapter 装配起来，并向 OpenClaw 暴露工具、钩子和 CLI。

插件层只做三类事情：

1. 注册 OpenClaw 能识别的工具、hooks 和 `ltm` 命令。
2. 将 OpenClaw 参数映射到 core service、legacy provider 或 ingestion pipeline。
3. 保持旧工具和旧配置兼容。

## 初始化流程

```text
memoryConfigSchema.parse(api.pluginConfig)
  -> api.resolvePath(dbPath)
  -> DatabaseFactory.createProvider()
  -> new Embeddings()
  -> new LegacyDatabaseAdapter()
  -> new DefaultMemoryService()
  -> new InMemoryMemoryStore()
  -> new IngestionPipeline()
  -> register tools / hooks / CLI
```

## 工具

| 工具 | Handler | 说明 |
|------|---------|------|
| `memory_store` | `handleMemoryStore()` | 生成 embedding、hash、metadata，写入 service/provider |
| `memory_recall` | `handleMemoryRecall()` | 查询 core service |
| `memory_forget` | `handleMemoryForget()` | 删除指定记忆 |
| `memory_scan_directory` | `handleMemoryScanDirectory()` | 扫描文件并进入 ingestion pipeline |
| `memory_cleanup` | `handleMemoryCleanup()` | 按条件清理数据 |
| `memory_context_fast` | `handleMemoryContextFast()` | Agent 快路径 5 槽位上下文 |

参数和示例见 [Memory API](../../05-api/memory-api.md)。

## Hooks

| Hook | Handler | 开关 | 说明 |
|------|---------|------|------|
| `before_agent_start` | `handleBeforeAgentStartRecall()` | `autoRecall` | 根据当前消息召回相关记忆并注入上下文 |
| `agent_end` | `handleAgentEndCapture()` | `autoCapture` | 根据触发规则捕获用户表达的稳定记忆 |

自动捕获会跳过过短、过长、疑似系统生成、emoji 过多、注入风险和已召回上下文内容。

## CLI

`ltm` 命令分两部分注册：

- `index.ts` 注册 legacy 命令：`list`、`stats`、`tables`、`search`、`query`、`scan`、`cleanup`、`export`、`kb:list`。
- `adapters/openclaw/cli.ts` 注册中间件命令：`serve`、`status`、`health`、`migrate`。

完整说明见 [CLI 命令](../../05-api/cli-commands.md)。

## 错误和安全边界

| 风险 | 当前处理 |
|------|----------|
| Prompt 注入 | `retrieval/prompt-safety.ts` 检测和转义 |
| 空/异常输入 | handler 层校验必填字段 |
| 删除误操作 | `memory_cleanup` 要求至少一个过滤条件 |
| REST 暴露 | `ltm serve` 默认 loopback，secret 可选 |
| embedding 失败 | 由 embedding port/provider 抛出错误，调用侧返回失败 |

## 已知边界

- MCP 当前是 facade，不负责启动 stdio/http transport。
- `memory_scan_directory` 当前重点是 ingestion pipeline 基线，完整持久化和回放治理按阶段推进。
- `memory_context_fast` 是 Agent 语义视图；无法映射到 5 type 的记录仍保留在通用检索链路中。
