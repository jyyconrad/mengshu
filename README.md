# mengshu（梦枢）

> 面向多产品 Agent Runtime 的本地优先记忆中间件

mengshu 用于在 OpenClaw、Codex、Claude Code、MCP 客户端、REST 服务和本地 CLI 之间共享长期工作记忆。它可以保存用户偏好、项目约束、架构决策、可复用经验和资源线索，并在后续任务中按需召回。

当前版本：**v1.0.7**

## 核心能力

- **少重复交代背景**：把用户偏好、项目约束、架构决策和常用资源沉淀下来，新的 Agent 会话也能接上上下文。
- **更快进入任务状态**：在开始编码、写文档或排查问题前，自动取回相关经验、规则和历史决策，减少来回确认。
- **跨工具连续工作**：OpenClaw、Codex、Claude Code、MCP、REST、Web Console 和 CLI 可以共用同一套记忆库。
- **降低重复踩坑**：把问题根因、修复经验和最佳实践变成可召回资产，下次遇到相似任务时直接复用。
- **可追溯、可治理**：能解释记忆为什么被召回，也能撤回、归档、纠错或恢复不再适用的记忆。
- **把记忆分门别类**：自动区分“用户是谁、正在做什么、必须遵守什么、以前怎么做过、有哪些资源”，让 Agent 知道每条记忆该怎么用。
- **自动过滤无效记忆**：临时闲聊、低价值片段和风险内容不会轻易进入长期记忆，避免记忆库越用越脏。
- **召回结果更可靠**：写入、排序、置信度和热度分别评分，避免只靠相似度把“看起来相关但不该用”的内容塞进上下文。
- **跨项目不串场**：通用偏好和经验可以复用，具体任务状态和项目资源保持隔离。
- **把经验沉淀成方法**：反复验证有效的做法会变成可复用经验，帮助 Agent 在相似任务中直接走成熟路径。

## 快速开始

### 安装

```bash
npm install -g @mengshu/core
```

该包会提供 `ms` 和 `mengshu` 两个命令。

### 全局配置与项目初始化

```bash
# 配置 LLM、Embedding 和数据库
ms setup

# 在当前目录建立产品无关的 Project Memory Workspace
ms init
```

`ms setup` 写入 `~/.mengshu/config.json`；`ms init` 只创建当前项目的
`.mengshu.json`、全局 project manifest 和 registry，不要求 OpenClaw authority，也不访问
记忆库。Codex、OpenClaw 和其他 Agent 产品各自提供可信运行时身份，并复用同一项目
`workspaceId/projectId`。

### 健康检查

```bash
ms doctor
```

### 召回与管理

```bash
# 召回相关记忆
ms recall "用户的沟通偏好"

# 查看召回原因和评分明细
ms why <memory-id>

# 撤回、归档、纠错或恢复记忆
ms forget <memory-id>
```

完整流程见 [快速开始](docs/guides/getting-started.md)。

## 集成方式

### OpenClaw 插件

```bash
openclaw plugin add ./plugins/openclaw
```

当前 OpenClaw 插件 id 为 `mengshu-openclaw`。

### MCP Server

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms mcp
```

MCP Server 暴露 `memory_recall`、`memory_lookup`、`memory_context_fast`、`memory_navigate`、`memory_evidence_read`、`memory_asset_search`、`memory_session_explain`、`memory_save`、`memory_observe_light`、`memory_forget` 等工具。Asset 与 session receipt 工具只在对应 PostgreSQL capability 就绪时注册。

### REST API 与 Web Console

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms serve --port 3847
```

REST 接口见 [Memory API](docs/api/memory-api.md)。

### CLI

```bash
ms doctor
ms recall "deployment notes" --explain
ms project ingest-history --from codex --dry-run
ms migrate-topic-tree --migration-id topic-tree-v1
ms asset list
ms asset explain <asset-id>
ms session explain <session-id>
ms loadout current
ms loadout unbind <loadout-id> <asset-id> --slot rules --expected-version 1 --idempotency-key <key>
ms loadout pause <loadout-id> --expected-version 2 --idempotency-key <key>
ms mcp
ms serve
```

完整命令见 [CLI 命令](docs/api/cli-commands.md)。

## 配置

mengshu 按三层加载配置：

1. 全局配置：`~/.mengshu/config.json`
2. 项目配置：`$PROJECT/.mengshu/config.json`
3. 环境变量覆盖

示例：

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "extractionModel": "gpt-4o-mini",
    "summarizationModel": "gpt-4o-mini",
    "reasoningModel": "gpt-4o"
  },
  "dbType": "postgres",
  "postgres": {
    "host": "${PG_HOST}",
    "port": 5432,
    "database": "${PG_DATABASE}",
    "user": "${PG_USER}",
    "password": "${PG_PASSWORD}",
    "ssl": false
  },
  "autoCapture": true,
  "autoRecall": true
}
```

完整配置见 [配置说明](docs/guides/configuration.md)。

## 文档导航

| 文档 | 说明 |
|------|------|
| [快速开始](docs/guides/getting-started.md) | 安装、初始化和第一次召回 |
| [配置说明](docs/guides/configuration.md) | 配置文件、模型、数据库和环境变量 |
| [项目身份与 Authority](docs/guides/authority-and-project-scope.md) | 产品无关项目初始化与各 Agent 的可信运行时边界 |
| [集成指南](docs/guides/integration.md) | OpenClaw、MCP、REST、SDK 和 Agent 集成 |
| [最佳实践](docs/guides/best-practices.md) | 记忆治理、scope 设计和使用建议 |
| [CLI 命令](docs/api/cli-commands.md) | `ms` 命令完整参考 |
| [Memory API](docs/api/memory-api.md) | REST API 参考 |
| [系统架构](docs/architecture/system-architecture.md) | 系统组成和模块职责 |
| [技术栈](docs/architecture/technology-stack.md) | 运行时、存储、模型和 UI 技术选择 |
| [统一记忆设计](docs/design/memory-system-unified-design.md) | 记忆模型、评分和召回设计 |
| [数据模型](docs/design/schema.md) | 公开数据结构参考 |

## 开发

```bash
npm test
npx -y -p typescript tsc --noEmit
npm run eval:quick
```

主要目录：

| 路径 | 说明 |
|------|------|
| `packages/core/` | 记忆领域模型、服务、评分、召回、摄入、存储和上下文构建 |
| `packages/mcp/` | MCP 工具适配和 stdio server |
| `packages/api/` | CLI、REST、SDK 和 Agent 快速上下文接口 |
| `packages/ui/` | Web Console |
| `plugins/openclaw/` | OpenClaw 插件 |
| `plugins/codex/` | Codex 插件包 |
| `plugins/claude-code/` | Claude Code source adapter |
| `docs/` | 对外文档 |

## 许可

MIT License
