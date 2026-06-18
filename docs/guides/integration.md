# 集成指南

## OpenClaw 插件集成

mengshu / memory-autodb 现在以 OpenClaw memory slot 插件形态集成。插件包位于 `plugins/openclaw`，canonical id 为 `mengshu-openclaw`，旧 id `memory-autodb` 和 `mengshu` 通过 `legacyPluginIds` 兼容。

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
      }
    }
  }
}
```

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
codex plugin marketplace add .agents/plugins
codex plugin add mengshu-memory@mengshu-local
```

首期 Codex MCP 启动器会调用全局 `ms mcp`，因此需要先确保 `ms --help` 可执行、`ms doctor` 通过。插件默认同样使用 `~/.mengshu`。

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
        "MENGSHU_HOME": "~/.mengshu"
      }
    }
  }
}
```

## REST API 集成

### 启动 HTTP Server

```bash
ms serve --port 8080
```

### API 端点

```http
POST /v1/memories
GET /v1/memories/recall
DELETE /v1/memories/:id
```

详见 [Memory API 文档](../api/memory-api.md)。

## 直接代码集成

### 安装依赖

```bash
npm install mengshu
```

### 初始化服务

```typescript
import { MemoryService } from 'mengshu';

const memory = new MemoryService({
  llm: {
    apiKey: process.env.OPENAI_API_KEY,
    extractionModel: 'gpt-4o-mini'
  },
  embedding: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small'
  },
  dbType: 'postgres',
  postgres: {
    host: process.env.PG_HOST,
    port: 5432,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD
  }
});

await memory.initialize();
```

### 存储记忆

```typescript
await memory.store({
  text: '用户喜欢使用 TypeScript',
  semanticType: 'profile',
  targetScope: 'project',
  metadata: {
    source: 'user-preference',
    timestamp: Date.now()
  }
});
```

### 召回记忆

```typescript
const result = await memory.recall({
  query: '编程语言偏好',
  limit: 5,
  minImportance: 0.7,
  scope: 'project'
});

console.log(result.memories); // 召回的记忆列表
console.log(result.context);  // 格式化后的上下文
```

### 查询记忆详情

```typescript
const detail = await memory.getMemoryDetail(memoryId);

console.log(detail.valueScore);     // 准入评分
console.log(detail.importance);     // 召回排序评分
console.log(detail.confidence);     // 去重治理评分
console.log(detail.importanceBreakdown); // 评分明细
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

```typescript
import { importAgentHistory } from 'mengshu/ingest/agent-history';

await importAgentHistory({
  filePath: './history.jsonl',
  redact: true,
  scope: 'project'
});
```

## 下一步

- [最佳实践](best-practices.md)
- [CLI 命令参考](../api/cli-commands.md)
