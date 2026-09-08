# 集成指南

所有产品共享同一个 Project Memory Workspace，但各自提供可信运行时身份。先在项目根目录
执行 `ms init`；该命令不依赖 OpenClaw。详细边界见
[项目身份与运行时 Authority](authority-and-project-scope.md)。

## OpenClaw 插件集成

mengshu 以 OpenClaw memory slot 插件形态集成。插件包位于 `plugins/openclaw`，canonical id 为 `mengshu-openclaw`，旧 id `memory-autodb` 和 `mengshu` 通过 `legacyPluginIds` 兼容。

### 安装插件

```bash
openclaw plugin add ./plugins/openclaw
```

### 配置

在 OpenClaw 配置中启用：

```json
{
  "plugins": {
    "load": {
      "paths": ["./plugins/openclaw"]
    },
    "slots": {
      "memory": "mengshu-openclaw"
    },
    "entries": {
      "mengshu-openclaw": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${OPENAI_API_KEY}",
            "baseURL": "https://api.openai.com/v1",
            "model": "text-embedding-3-small"
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
          "authority": {
            "tenantId": "local",
            "userId": "owner",
            "allow": {
              "appIds": ["openclaw"],
              "projectIds": ["default"],
              "agentIds": ["main", "codex"],
              "namespaces": ["default"],
              "visibilities": ["private"]
            }
          },
          "defaultAgentId": "main",
          "autoCapture": true,
          "autoRecall": true
        }
      }
    }
  }
}
```

多 Agent 配置必须显式指定 `defaultAgentId`，且它必须属于
`authority.allow.agentIds`。hook 与工具按 OpenClaw 的可信 Agent 上下文收窄；
不在 allowlist 中的 Agent 会被拒绝，不会共享默认 Agent 的私有记忆。

OpenClaw、Codex、Claude Code、CLI 和 MCP 客户端通过 `~/.mengshu/config.json` 复用同一套 PostgreSQL 后端；不要再为不同产品创建独立的本地 LanceDB 目录。`dbPath` 仅在显式选择 `dbType=lancedb` 时使用。

旧配置迁移：

```bash
ms migrate-openclaw-plugin-id          # 预览
ms migrate-openclaw-plugin-id --execute
```

该命令会把 `plugins.slots.memory` 从 `memory-autodb` 或 `mengshu` 更新为 `mengshu-openclaw`，并把旧 entry 的配置复制到新 entry。

### 使用工具

插件注册的工具：

- `memory_store` - 存储记忆
- `memory_recall` - 召回记忆
- `memory_forget` - 删除记忆
- `memory_scan_directory` - 扫描 Markdown 目录
- `memory_context_fast` - 获取 Agent 启动 5 槽位上下文

## Codex 插件集成

Codex 插件包位于 `plugins/codex`，插件名为 `mengshu-memory`。仓库级 marketplace 位于 `.agents/plugins/marketplace.json`。

```bash
ms setup
ms init /path/to/project
codex plugin marketplace add .agents/plugins
codex plugin add mengshu-memory@mengshu-local
```

Codex 不需要安装或认证 OpenClaw。插件默认从 `~/.mengshu/authority.json` 读取
Codex 自己的 authority/defaultScope；其中 `projectId` 应与当前项目 `.mengshu.json` 一致。
启动器使用当前发布包内的 `dist/bin/ms.js`，不读取 PATH 中的全局 `ms`，并在启动前校验
插件/runtime 版本一致。先运行 `ms doctor` 验证 `~/.mengshu` 配置；开发或隔离测试只有在
显式设置绝对路径 `MENGSHU_CODEX_MS_PATH` 时才覆盖包内 runtime。

## MCP Server 集成

### 启动 MCP Server

```bash
ms mcp
```

### 连接 MCP Client

```json
{
  "mcpServers": {
    "mengshu": {
      "command": "ms",
      "args": ["mcp"],
      "env": {
        "MENGSHU_HOME": "~/.mengshu",
        "MENGSHU_AUTHORITY_FILE": "/absolute/path/to/.mengshu/authority.json"
      }
    }
  }
}
```

## 自定义 Agent 产品的项目解析

自定义产品可以使用 `@mengshu/core/api` 导出的 `ProjectIdentityResolver` 决定当前项目
identity。resolver 只处理 project/workspace；tenant/user/app/agent 仍由产品认证层负责。

```typescript
import type { ProjectIdentityResolver } from "@mengshu/core/api";

export const resolveMyProductProject: ProjectIdentityResolver = ({ requested, suggested }) => ({
  workspaceId: requested.workspaceId ?? suggested.workspaceId,
  projectId: requested.projectId ?? suggested.projectId,
  defaultVisibility: requested.defaultVisibility ?? "private",
});
```

将 resolver 注入 `registerProjectCliCommands` 后，`ms init` 使用产品结果写 manifest；
`resolveMemoryScope` 是另一个独立依赖，只在 `project context/lookup` 访问记忆库时调用。

## REST API 集成

### 启动 HTTP Server

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms serve --port 8080
```

### API 端点

```http
POST /v1/memories
POST /v1/recall
POST /v1/context
GET /v1/health
```

详见 [Memory API 文档](../api/memory-api.md)。

## 直接代码集成

### 安装依赖

```bash
npm install @mengshu/core
```

### 初始化客户端

先启动本机 REST 服务：

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms serve --port 3847
```

```typescript
import { MemoryClient } from "@mengshu/core/api";

const memory = new MemoryClient({
  baseUrl: "http://127.0.0.1:3847",
  token: process.env.MENGSHU_API_TOKEN
});
```

### 存储记忆

```typescript
await memory.storeMemory({
  record: {
    id: "mem_1",
    scope: {
      tenantId: "local",
      appId: "codex",
      userId: "default",
      projectId: "default",
      agentId: "default",
      namespace: "memories"
    },
    kind: "preference",
    semanticType: "profile",
    text: "用户喜欢使用 TypeScript",
    contentHash: "mem_1",
    importance: 0.8,
    category: "preference",
    dataType: "memory",
    metadata: {
      source: "user-preference",
      timestamp: Date.now()
    },
    provenance: { source: "user" },
    createdAt: Date.now()
  }
});
```

### 召回记忆

```typescript
const result = await memory.recall({
  query: "编程语言偏好",
  limit: 5,
  minScore: 0.1,
  scope: { projectId: "default" }
});

console.log(result.hits); // 召回的记忆列表
```

### 构建上下文

```typescript
const context = await memory.buildContext({
  query: "编程语言偏好",
  title: "Relevant Memories",
  limit: 5
});

console.log(context.content);
```

## Agent History 导入

### 准备数据

Agent history 格式（JSONL）：

```jsonl
{"role":"user","content":"帮我写一个 TypeScript 项目"}
{"role":"assistant","content":"好的，我使用 TypeScript 为你创建项目"}
{"role":"user","content":"请使用 pnpm 管理依赖"}
```

### 导入

```bash
ms project ingest-history --from codex --dry-run
```

dry-run 会自动统计脱敏命中：
- 移除 API keys
- 移除敏感路径
- 移除密码

### 代码导入

```bash
ms project ingest-history --from codex --dry-run
```

## 下一步

- [最佳实践](best-practices.md)
- [CLI 命令参考](../api/cli-commands.md)
