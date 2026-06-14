# 全局配置目录升级方案

> 状态：升级设计稿  
> 适用范围：memory-autodb 从 OpenClaw 插件路径演进为独立本地优先记忆中间件后的全局目录、配置、密钥和项目 registry 约定。  
> 当前代码仍存在 `~/.openclaw/` 兼容路径；本文定义下一阶段目标路径和迁移规则。

## 1. 背景

memory-autodb 的产品定位已经从“OpenClaw 的长期记忆插件”升级为“面向 Agent 应用的本地优先记忆中间件”。因此全局文件不应继续挂在 `~/.openclaw/` 下面，否则会带来三个问题：

1. **产品边界不清**：Codex、Claude、OpenClaw 等客户端接入时，看起来像是在复用 OpenClaw 私有状态。
2. **迁移和备份困难**：配置、密钥、项目 registry、向量库和可读导出分散在 OpenClaw 目录中。
3. **跨产品 Working Context 不自然**：Project Memory Workspace 是用户工作上下文，不是某个产品的 workspace。

升级后，memory-autodb 拥有独立全局目录：

```text
~/.memory-autodb/
```

## 2. 目标目录结构

```text
~/.memory-autodb/
  config.json                 # 全局运行配置，不直接保存密钥明文
  .env                        # 本机密钥和敏感环境变量
  registry.json               # 本机 workspace/project registry 快速索引
  memory/
    lancedb/                  # 默认本地 LanceDB 数据库
  projects/
    <projectId>/
      manifest.json           # 项目完整 manifest，长期 identity 真源
      evidence/               # 原始证据指针、canonical source 或快照
      indexes/                # 可重建索引状态、manifest diff、content hash
      exports/                # 可读导出、备份、迁移包
      tree/                   # source/topic/global tree 的持久状态
      audit/                  # 项目级审计、commit、refresh 记录
  logs/
  backups/
```

项目目录本身只保存轻量指针：

```text
/path/to/project/
  .memory-autodb.json
```

这条规则很重要：**项目仓库不默认保存用户长期记忆数据**，只保存 project pointer 和可审查声明，避免把私人记忆误提交到 git。

## 3. 全局配置文件

### 3.1 `~/.memory-autodb/config.json`

`config.json` 是 memory-autodb 的全局运行配置。它应该可提交到本机备份，但不应包含密钥明文。

推荐最小配置：

```json
{
  "version": 1,
  "homeDir": "~/.memory-autodb",
  "dbType": "lancedb",
  "dbPath": "~/.memory-autodb/memory/lancedb",
  "embedding": {
    "apiKey": "${MEMORY_AUTODB_EMBEDDING_API_KEY}",
    "baseURL": "${MEMORY_AUTODB_EMBEDDING_BASE_URL}",
    "model": "${MEMORY_AUTODB_EMBEDDING_MODEL}"
  },
  "autoCapture": true,
  "autoRecall": true,
  "scanner": {
    "targetTable": "knowledge",
    "autoEnrichMetadata": true
  },
  "tables": {
    "memories": { "enabled": true },
    "knowledge": { "enabled": true }
  },
  "projects": {
    "rootDir": "~/.memory-autodb/projects"
  }
}
```

配置原则：

1. `config.json` 只保存稳定运行策略，不保存 secret 明文。
2. 所有 `${...}` 占位符从 `~/.memory-autodb/.env` 解析。
3. `dbPath` 默认指向 `~/.memory-autodb/memory/lancedb`。
4. `projects.rootDir` 默认指向 `~/.memory-autodb/projects`。
5. OpenClaw、Codex、Claude 等客户端都应引用同一个 `config.json`，避免多套记忆库分裂。

### 3.2 `~/.memory-autodb/.env`

`.env` 只保存本机密钥和敏感配置，不纳入版本管理。

示例：

```bash
MEMORY_AUTODB_EMBEDDING_API_KEY=sk-xxx
MEMORY_AUTODB_EMBEDDING_BASE_URL=https://api.siliconflow.cn/v1/
MEMORY_AUTODB_EMBEDDING_MODEL=BAAI/bge-m3

# 可选：本地 OpenAI-compatible embedding
# MEMORY_AUTODB_EMBEDDING_API_KEY=ollama
# MEMORY_AUTODB_EMBEDDING_BASE_URL=http://127.0.0.1:11434/v1
# MEMORY_AUTODB_EMBEDDING_MODEL=modelscope.cn/Qwen/Qwen3-Embedding-0.6B-GGUF:latest

NO_PROXY=127.0.0.1,localhost,::1
no_proxy=127.0.0.1,localhost,::1
```

密钥规则：

1. `.env` 权限建议为 `0600`。
2. GUI 客户端通常不继承 shell 环境，MCP 启动脚本必须显式加载该文件。
3. 对本地服务地址必须设置 `NO_PROXY/no_proxy`，避免 localhost 请求被系统代理转发。

## 4. 全局项目目录

每个 Project Memory Workspace 在全局目录下有一个独立项目目录：

```text
~/.memory-autodb/projects/<projectId>/
```

这个设计参考 Claude Code 的本地项目状态管理思路：项目目录保存完整的长期状态，源项目只保存轻量指针。

### 4.1 项目目录职责

| 路径 | 职责 | 是否可重建 |
|------|------|------------|
| `manifest.json` | 项目 identity、workspaceId、projectId、scope、source roots、策略 | 否，长期真源 |
| `evidence/` | 原始来源指针、canonical markdown、必要快照 | 部分可重建 |
| `indexes/` | 向量/BM25/manifest diff/content hash 等索引状态 | 是 |
| `tree/` | source/topic/global tree buffer 与 summary 节点 | 部分可重建 |
| `audit/` | init、refresh、session commit、promotion、delete 记录 | 否，追溯真源 |
| `exports/` | 用户可读导出、迁移包、备份 | 是 |

### 4.2 项目指针 `.memory-autodb.json`

项目目录里的 `.memory-autodb.json` 只保存足够找到全局项目目录的信息：

```json
{
  "version": "0.2",
  "projectId": "proj-xxxx",
  "workspaceId": "ws-xxxx",
  "globalManifest": "~/.memory-autodb/projects/proj-xxxx/manifest.json",
  "createdAt": 1780000000000
}
```

指针规则：

1. `projectId` 一旦生成就不应随目录移动而变化。
2. 目录移动时，只要 `.memory-autodb.json` 随目录保留，就继续复用原长期记忆。
3. 指针文件默认可进入 git，但团队共享前应确认不泄露本机路径或用户 id。
4. 完整 `sourceRoots`、ingest policy、审计和索引状态放在全局项目目录，不放在项目仓库。

### 4.3 `manifest.json`

全局项目 manifest 是长期 identity 真源：

```json
{
  "version": "0.2",
  "projectId": "proj-xxxx",
  "workspaceId": "ws-xxxx",
  "displayName": "memory-autodb",
  "rootHints": [
    "/Users/user/develop/code/work_code/openclaw_plugins/memory-autodb"
  ],
  "scopeDefaults": {
    "tenantId": "local",
    "userId": "default",
    "visibility": "workspace"
  },
  "slotReusePolicy": {
    "profile": "workspace",
    "rules": "workspace",
    "task_context": "project",
    "experience": "project",
    "resource": "project"
  },
  "sourceRoots": [
    {
      "id": "src-project-root",
      "path": "/Users/user/develop/code/work_code/openclaw_plugins/memory-autodb",
      "role": "project_root",
      "include": ["**/*.md", "**/*.ts", "package.json"],
      "exclude": [".git/**", "node_modules/**", "dist/**", ".codegraph/**"],
      "lastIndexedAt": null
    }
  ],
  "createdAt": 1780000000000,
  "updatedAt": 1780000000000
}
```

## 5. 客户端接入配置

所有 MCP 客户端应统一指向同一启动脚本、同一配置文件和同一 `.env`。

### 5.1 Codex

```toml
[mcp_servers.memory_autodb]
command = "/path/to/memory-autodb/node_modules/.bin/tsx"
args = ["/path/to/memory-autodb/scripts/memory-autodb-mcp.ts"]

[mcp_servers.memory_autodb.env]
MEMORY_AUTODB_CONFIG = "/Users/<user>/.memory-autodb/config.json"
MEMORY_AUTODB_ENV = "/Users/<user>/.memory-autodb/.env"
NO_PROXY = "127.0.0.1,localhost,::1"
no_proxy = "127.0.0.1,localhost,::1"
```

### 5.2 Claude Code / Claude Desktop

```json
{
  "mcpServers": {
    "memory-autodb": {
      "command": "/path/to/memory-autodb/node_modules/.bin/tsx",
      "args": ["/path/to/memory-autodb/scripts/memory-autodb-mcp.ts"],
      "env": {
        "MEMORY_AUTODB_CONFIG": "/Users/<user>/.memory-autodb/config.json",
        "MEMORY_AUTODB_ENV": "/Users/<user>/.memory-autodb/.env",
        "NO_PROXY": "127.0.0.1,localhost,::1",
        "no_proxy": "127.0.0.1,localhost,::1"
      }
    }
  }
}
```

### 5.3 OpenClaw

OpenClaw 仍可通过插件 slot 接入，但插件配置应引用独立目录，而不是把 memory-autodb 状态放在 `~/.openclaw/`：

```json
{
  "slots": {
    "memory": "memory-autodb"
  },
  "entries": {
    "memory-autodb": {
      "enabled": true,
      "configPath": "~/.memory-autodb/config.json",
      "envPath": "~/.memory-autodb/.env"
    }
  }
}
```

兼容期内也可以继续内联 `config`，但新文档和新安装流程应优先使用 `configPath/envPath`。

## 6. 初始化和迁移流程

### 6.1 新安装

```bash
mkdir -p ~/.memory-autodb/{memory/lancedb,projects,logs,backups}
chmod 700 ~/.memory-autodb
touch ~/.memory-autodb/.env
chmod 600 ~/.memory-autodb/.env
```

生成：

```text
~/.memory-autodb/config.json
~/.memory-autodb/.env
```

然后配置 Codex、Claude、OpenClaw 指向这两个文件。

### 6.2 从 `~/.openclaw/` 迁移

旧路径：

```text
~/.openclaw/memory-autodb-mcp.json
~/.openclaw/.env
~/.openclaw/memory/lancedb
~/.openclaw/conf/plugins.json
```

目标路径：

```text
~/.memory-autodb/config.json
~/.memory-autodb/.env
~/.memory-autodb/memory/lancedb
~/.memory-autodb/projects/<projectId>/
```

建议迁移步骤：

1. 创建 `~/.memory-autodb/` 目录并设置权限。
2. 将旧 `~/.openclaw/memory-autodb-mcp.json` 转换为 `~/.memory-autodb/config.json`。
3. 将 memory-autodb 相关密钥从 `~/.openclaw/.env` 拆到 `~/.memory-autodb/.env`。
4. 将 `~/.openclaw/memory/lancedb` 迁移或复制到 `~/.memory-autodb/memory/lancedb`。
5. 更新 Codex、Claude、OpenClaw 的 MCP/plugin 配置。
6. 运行 `memory_health`，再做一次 `memory_observe_light -> memory_lookup` 烟测。
7. 保留旧目录备份一段时间，确认无回退需求后再清理。

### 6.3 项目初始化

目标命令行为：

```bash
cd /path/to/project
ltm init
```

应完成：

1. 生成或复用 `projectId/workspaceId`。
2. 写入项目指针 `/path/to/project/.memory-autodb.json`。
3. 创建全局项目目录 `~/.memory-autodb/projects/<projectId>/`。
4. 写入完整 `manifest.json`。
5. 更新 `~/.memory-autodb/registry.json`。

## 7. Registry 设计

`~/.memory-autodb/registry.json` 是本机项目快速索引，不是长期唯一真源；长期真源仍是每个项目的 `manifest.json`。

示例：

```json
{
  "version": 1,
  "projects": {
    "proj-xxxx": {
      "workspaceId": "ws-xxxx",
      "displayName": "memory-autodb",
      "manifestPath": "~/.memory-autodb/projects/proj-xxxx/manifest.json",
      "lastSeenRoot": "/Users/user/develop/code/work_code/openclaw_plugins/memory-autodb",
      "lastOpenedAt": 1780000000000
    }
  },
  "workspaces": {
    "ws-xxxx": {
      "projectIds": ["proj-xxxx"]
    }
  }
}
```

registry 用途：

1. 快速列出本机项目。
2. 支持项目目录移动后的重新绑定。
3. 支持 Web Console 的整体预览。
4. 支持后续清理孤儿项目、备份和导出。

## 8. 兼容策略

短期兼容顺序：

1. 如果显式传入 `MEMORY_AUTODB_CONFIG`，优先使用它。
2. 否则读取 `~/.memory-autodb/config.json`。
3. 若不存在，再兼容读取 `~/.openclaw/memory-autodb-mcp.json` 或 `~/.openclaw/conf/plugins.json`。
4. 读取旧路径时应输出 warning，提示用户迁移。

项目 manifest 兼容：

1. v0.1 `.memory-autodb.json` 直接包含较多字段；v0.2 指针化后应支持自动升级。
2. 如果项目目录只有旧 `.memory-autodb.json`，`ltm init` 不应覆盖 identity，而应创建全局项目目录并回填指针。
3. 如果 `~/.memory-autodb/projects/<projectId>/manifest.json` 缺失，应允许从项目指针做恢复，但要标记为 degraded。

## 9. 验收标准

升级完成后应满足：

1. `~/.memory-autodb/config.json` 和 `~/.memory-autodb/.env` 是全局配置和密钥真源。
2. Codex、Claude、OpenClaw 都指向同一套 memory-autodb 全局配置。
3. 每个 Project Memory Workspace 都有 `~/.memory-autodb/projects/<projectId>/manifest.json`。
4. 项目目录只保存轻量 `.memory-autodb.json` 指针。
5. `memory_health` 可用。
6. embedding 可用时，`memory_observe_light -> memory_lookup` 可完成端到端烟测。
7. 旧 `~/.openclaw/` 路径仍能在兼容期读取，但不会作为新安装默认路径。

## 10. 后续实现任务

1. 更新 `scripts/memory-autodb-mcp.ts` 默认路径：`~/.memory-autodb/config.json` 与 `~/.memory-autodb/.env`。
2. 扩展配置解析：支持 `configPath/envPath`，保留旧 `config` 内联模式。
3. 修改 `ltm init`：同时写项目指针和全局 `projects/<projectId>/manifest.json`。
4. 新增 `registry.json` 读写模块。
5. 新增迁移命令：`ltm migrate-home --from ~/.openclaw --to ~/.memory-autodb --dry-run`。
6. 更新 Codex、Claude、OpenClaw 配置示例。
7. 增加迁移测试：旧路径读取、新路径优先、项目指针升级、registry 回填。
