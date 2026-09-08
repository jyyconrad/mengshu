# 快速开始

## 安装

```bash
npm install -g @mengshu/core
# 或者
pnpm add -g @mengshu/core
```

全局安装会提供 `ms` 和 `mengshu` 两个命令；项目内安装可用于 REST SDK 或 MCP/OpenClaw 入口集成。

## 1. 初始化全局配置

运行交互式配置向导：

```bash
ms setup
```

这将引导你完成：
1. LLM 配置（API key、model）
2. Embedding 配置
3. 数据库类型选择（LanceDB / PostgreSQL / Supabase）

配置写入 `~/.mengshu/config.json`，密钥写入权限为 `0600` 的
`~/.mengshu/.env`。该步骤不依赖 OpenClaw。

## 2. 初始化当前项目

```bash
cd /path/to/project
ms init
ms project status
```

`ms init` 创建：

- `$PROJECT/.mengshu.json`：轻量项目指针；
- `~/.mengshu/projects/<projectId>/manifest.json`：完整项目 manifest；
- `~/.mengshu/registry.json`：本机项目 registry。

该命令只初始化产品无关的 `workspaceId/projectId`，不访问数据库、不要求 OpenClaw
authority，也不从聊天消息推断 tenant/user。不同 Agent 产品在运行时提供自己的
`appId/agentId` 和可信用户身份。

## 3. 健康检查

```bash
ms doctor
```

`config`、`database` 和 `embedding` 应显示 `ok`；项目 manifest 应显示已初始化。

## 4. 选择接入方式

使用 Codex/OpenClaw 插件时，按[集成指南](integration.md)配置产品 authority。直接启动
MCP 或 REST 时，先准备 `~/.mengshu/authority.json`：

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms mcp
```

authority 的完整格式、`defaultScope` 对齐规则和多产品边界见
[项目身份与运行时 Authority](authority-and-project-scope.md)。

## 基本使用

### 自动捕获记忆

在代码中调用本机 REST 服务：

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
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
    appId: "my-agent-product",
    userId: "owner",
    projectId: "project-api",
    agentId: "main",
    namespace: "working-context"
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

- [项目身份与 Authority](authority-and-project-scope.md)
- [配置详解](configuration.md)
- [集成指南](integration.md)
- [CLI 命令参考](../api/cli-commands.md)
