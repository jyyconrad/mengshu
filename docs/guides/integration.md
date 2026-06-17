# 集成指南

## OpenClaw 插件集成

mengshu 默认作为 OpenClaw 插件运行。

### 安装插件

```bash
openclaw plugin add memory-autodb
```

### 配置

在 OpenClaw 配置中启用：

```json
{
  "plugins": [
    {
      "name": "memory-autodb",
      "enabled": true,
      "config": {
        "autoCapture": true,
        "autoRecall": true
      }
    }
  ]
}
```

### 使用工具

插件注册的工具：

- `memory_store` - 存储记忆
- `memory_recall` - 召回记忆
- `memory_search` - 搜索记忆
- `memory_forget` - 删除记忆

## MCP Server 集成

### 启动 MCP Server

```bash
ms mcp
# 或指定端口
ms mcp --port 3000
```

### 连接 MCP Client

```typescript
import { McpClient } from '@modelcontextprotocol/sdk';

const client = new McpClient({
  url: 'http://localhost:3000'
});

await client.callTool('memory_recall', {
  query: '用户偏好',
  limit: 5
});
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
  dbType: 'lancedb',
  dbPath: '~/.mengshu/memory/lancedb'
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
ms import ./agent-history.jsonl --redact
```

`--redact` 选项自动脱敏：
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
