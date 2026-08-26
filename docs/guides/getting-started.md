# 快速开始

## 安装

```bash
npm install -g @mengshu/core
# 或者
pnpm add @mengshu/core
```

全局安装会提供 `ms` 和 `mengshu` 两个命令；项目内安装可用于 REST SDK 或 MCP/OpenClaw 入口集成。

## 初始化配置

运行交互式配置向导：

```bash
ms init
```

这将引导你完成：
1. LLM 配置（API key、model）
2. Embedding 配置
3. 数据库类型选择（LanceDB / PostgreSQL / Supabase）

配置文件生成位置：
- 全局配置：`~/.mengshu/config.json`
- 项目配置：`$PROJECT/.mengshu/config.json`

## 基本使用

### 自动捕获记忆

在代码中调用本机 REST 服务：

```bash
ms serve --port 3847
```

```typescript
import { MemoryClient } from "@mengshu/core/api";

const memory = new MemoryClient({
  baseUrl: "http://127.0.0.1:3847"
});

const record = {
  id: "mem_1",
  scope: {
    tenantId: "local",
    appId: "codex",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "memories"
  },
  kind: "preference" as const,
  text: "用户偏好使用 TypeScript",
  contentHash: "mem_1",
  importance: 0.8,
  category: "preference" as const,
  dataType: "memory" as const,
  metadata: {},
  provenance: { source: "user" },
  createdAt: Date.now()
};

await memory.storeMemory({ record });
```

### 手动存储记忆

```typescript
await memory.storeMemory({ record });
```

### 召回记忆

```typescript
const memories = await memory.recall({
  query: "用户的编程语言偏好",
  limit: 5
});
```

## 命令行工具

```bash
# 诊断配置
ms doctor

# 查看记忆评分明细
ms why <记忆ID>

# 召回并解释
ms recall "查询内容" --explain

# 删除/归档记忆
ms forget <记忆ID>

# 导入 agent history
ms project ingest-history --from codex --dry-run

# 查看当前 scope 下的治理资产及其 evidence
ms asset list
ms asset explain <asset-id>
```

## 下一步

- [配置详解](configuration.md)
- [集成指南](integration.md)
- [CLI 命令参考](../api/cli-commands.md)
