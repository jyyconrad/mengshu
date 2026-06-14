# CLI 命令

`ltm` 是 memory-autodb 的管理命令组。命令由 OpenClaw 插件注册，当前代码入口在 [index.ts](../../index.ts) 和 [adapters/openclaw/cli.ts](../../adapters/openclaw/cli.ts)。

## 命令总览

| 命令 | 作用 |
|------|------|
| `ltm list` | 输出总数、用户记忆数和文档记忆数 |
| `ltm stats` | 输出数据库类型、表级统计和存储路径 |
| `ltm tables` | 列出 provider 支持的表 |
| `ltm search <query>` | 生成 embedding 并做向量搜索 |
| `ltm query` | 用 JSON filter 做高级查询 |
| `ltm export` | 导出 JSON 或 CSV |
| `ltm scan <directory>` | 扫描 Markdown 目录并进入 ingestion pipeline |
| `ltm cleanup` | 按数据类型、时间或分类清理数据 |
| `ltm kb:list` | 列出 `knowledge*` 知识库表 |
| `ltm init` | 初始化项目指针和全局 manifest（v0.1.2+） |
| `ltm migrate-home` | 迁移 `~/.openclaw/` 到 `~/.memory-autodb/`（v0.1.2+） |
| `ltm serve` | 启动本机 REST server 和 `/console` |
| `ltm mcp` | 启动 stdio MCP server，供 Claude Desktop / Cursor 等客户端接入 |
| `ltm status` | 输出中间件状态 |
| `ltm health` | 输出 `MemoryService.health()` JSON |
| `ltm migrate` | 估算 v4 schema 迁移 |

## `ltm stats`

```bash
ltm stats
```

输出包含：

- 总记录数
- 用户记忆数
- 扫描文档数
- `dbType`
- provider 支持时的表级统计
- LanceDB 路径或 Supabase URL

## `ltm tables`

```bash
ltm tables
```

provider 支持 `getTableNames()` 时输出所有表和记录数；不支持时输出明确提示。

## `ltm search`

```bash
ltm search "配置数据库" --limit 10
ltm search "React 组件" --category 知识库 --limit 5
ltm search "用户偏好" --search-all --limit 20
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<query>` | 是 | 搜索查询 |
| `--limit <n>` | 否 | 返回数量，默认 `5` |
| `--include-documents` | 否 | 同时搜索文档和知识数据 |
| `--category <name>` | 否 | 存储分类，如 `核心记忆` 或 `知识库` |
| `--search-all` | 否 | 跨分类搜索 |

注意：当前命令没有短参数别名。

## `ltm query`

```bash
ltm query --category 核心记忆 --filter '{"category":"preference"}' --limit 20
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--category <name>` | 否 | 存储分类 |
| `--filter <json>` | 否 | JSON 过滤条件 |
| `--limit <n>` | 否 | 返回数量，默认 `100` |

`ltm query` 当前不生成 embedding，也没有 `--vector` 参数。需要语义搜索时使用 `ltm search`。

## `ltm export`

```bash
ltm export --category 核心记忆 --format json --output memories.json
ltm export --category 知识库 --format csv --output knowledge.csv
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--category <name>` | 否 | 存储分类 |
| `--format <format>` | 否 | `json` 或 `csv`，默认 `json` |
| `--output <file>` | 否 | 输出文件；省略时打印到 stdout |

当前导出命令不支持 `--filter`。需要过滤时先用 `ltm query` 检查条件，再扩展导出能力。

## `ltm scan`

```bash
ltm scan ./docs --ignore node_modules dist
ltm scan ./notes --category 核心记忆
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<directory>` | 是 | 要扫描的目录 |
| `--ignore <paths...>` | 否 | 额外忽略路径 |
| `--category <name>` | 否 | 存储分类，默认 `知识库` |

扫描当前走 v4 ingestion pipeline，输出会包含 legacy 统计和新 pipeline 统计：

```text
Scan completed:
- Total files: 10
- Processed: 10
- Failed: 0
- Total chunks: 42
- Stored: 40
- Duplicates skipped: 2
- Jobs queued: 40
- Chunks admitted: 40
- Chunks dropped: 0
```

## `ltm cleanup`

```bash
ltm cleanup --data-type document --older-than 30
ltm cleanup --category 知识库 --older-than 90
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--data-type <type>` | 否 | `memory`、`document` 或 provider 支持的数据类型 |
| `--older-than <days>` | 否 | 删除 N 天前数据 |
| `--category <name>` | 否 | 存储分类 |

至少指定一个过滤条件，否则命令会拒绝执行。

## `ltm kb:list`

```bash
ltm kb:list
```

列出所有表名以 `knowledge` 开头的知识库表。该命令依赖 provider 的 `getTableStats()`。

## `ltm init`

```bash
ltm init [directory]
ltm init --force
```

**用途**：初始化项目记忆工作区（v0.1.2+）。

**行为**：
1. 生成或复用 `projectId/workspaceId`
2. 写入项目指针 `.memory-autodb.json`（version: "0.2"）
3. 创建全局项目目录 `~/.memory-autodb/projects/<projectId>/`
4. 写入完整 `manifest.json`
5. 自动注册到 `~/.memory-autodb/registry.json`

**选项**：
- `[directory]`：目标项目目录（默认当前目录）
- `--force`：强制覆盖已存在的指针文件

**幂等性**：重复 `init` 会更新 registry 的 `lastOpenedAt`，不会修改已存在的 `projectId`。

## `ltm migrate-home`

**用途**：将 `~/.openclaw/` 迁移到 `~/.memory-autodb/`（v0.1.2+）。

**用法**：
```bash
ltm migrate-home [options]
```

**选项**：
- `--execute`：执行迁移（默认 dry-run）
- `--backup`：迁移前备份旧目录
- `--force`：覆盖已存在的目标文件

**迁移清单**：
1. `~/.openclaw/.env` → `~/.memory-autodb/.env`
2. `~/.openclaw/memory-autodb-mcp.json` → `~/.memory-autodb/config.json`
3. `~/.openclaw/memory/` → `~/.memory-autodb/memory/`（递归复制）
4. `~/.openclaw/conf/plugins.json` 中的内联配置 → 提示手工迁移

**示例**：
```bash
# 预览迁移计划（不执行）
ltm migrate-home

# 执行迁移并备份
ltm migrate-home --execute --backup

# 执行迁移并强制覆盖冲突文件
ltm migrate-home --execute --force
```

**注意**：
- 默认为 dry-run 模式，需显式 `--execute` 才会修改文件。
- 迁移后旧 `~/.openclaw/` 仍会保留，可手动删除。
- 如果检测到项目指针 `.memory-autodb.json`，会提示重新运行 `ltm init` 更新 registry。
- 迁移后请更新客户端配置（Codex/Claude Desktop/OpenClaw）指向新路径。

## `ltm serve`

```bash
ltm serve
ltm serve --host 127.0.0.1 --port 3847
```

默认监听 `127.0.0.1:3847`。启动后可访问：

```text
http://127.0.0.1:3847/v1/health
http://127.0.0.1:3847/console
```

安全默认值：

- 未配置 `server.secret` 时，只允许 loopback 请求。
- 配置 `server.secret` 后，REST 请求需要 `Authorization: Bearer <secret>`。
- `server.requireHttps` 为真时，非 HTTPS 请求会被拒绝；本机 Node daemon 当前传入协议为 `http`。

## `ltm status`

```bash
ltm status
```

输出 server URL、数据库类型、数据库路径、健康状态、记录数和表级统计。

## `ltm health`

```bash
ltm health
```

输出 `MemoryService.health()` 的 JSON 结果，适合脚本化检查。

## `ltm migrate`

```bash
ltm migrate --to-schema v4 --dry-run
```

当前只支持 `--to-schema v4`。命令根据当前 `service.health().records` 估算迁移计划；它不是实际数据迁移执行器。

## `ltm mcp`

```bash
ltm mcp
```

启动 stdio 传输的 MCP server，让本地 MCP 客户端（Claude Desktop、Cursor 等）通过标准输入输出调用长期记忆工具。

工具清单：

| 工具 | 作用 |
|------|------|
| `memory_save` | 保存一条记忆 |
| `memory_recall` | 召回相关记忆 |
| `memory_context` | 构建 prompt-safe 上下文块 |
| `memory_observe` | 观察并保存记忆 |
| `memory_namespaces` | 列出已知 namespace |
| `memory_forget` | 按 id 或 filter 删除 |
| `memory_health` | 返回服务健康状态 |
| `memory_context_fast` | （注入 agent fast-path 时）5 槽位快速上下文 |
| `memory_observe_light` | （注入 agent fast-path 时）轻量观察入队抽取 |
| `memory_lookup` | （注入 agent fast-path 时）运行中速查 |

Claude Desktop 配置示例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "memory-autodb": {
      "command": "npx",
      "args": ["openclaw", "ltm", "mcp"]
    }
  }
}
```

注意：stdio 模式下进程状态信息走 stderr，stdout 专用于 JSON-RPC 流。scope 由客户端在工具入参中传入，本命令层不做鉴权。
