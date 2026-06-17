# CLI 命令

`ms` 是 mengshu 的管理命令组。命令由 OpenClaw 插件注册，当前代码入口在 [index.ts](../../index.ts) 和 [adapters/openclaw/cli.ts](../../adapters/openclaw/cli.ts)。

## 命令总览

| 命令 | 作用 |
|------|------|
| `ms list` | 输出总数、用户记忆数和文档记忆数 |
| `ms stats` | 输出数据库类型、表级统计和存储路径 |
| `ms tables` | 列出 provider 支持的表 |
| `ms search <query>` | 生成 embedding 并做向量搜索 |
| `ms query` | 用 JSON filter 做高级查询 |
| `ms export` | 导出 JSON 或 CSV |
| `ms scan <directory>` | 扫描 Markdown 目录并进入 ingestion pipeline |
| `ms cleanup` | 按数据类型、时间或分类清理数据 |
| `ms kb:list` | 列出 `knowledge*` 知识库表 |
| `ms init` | 初始化项目指针和全局 manifest（v0.1.2+） |
| `ms migrate-home` | 迁移 `~/.openclaw/` 到 `~/.mengshu/`（v0.1.2+） |
| `ms serve` | 启动本机 REST server 和 `/console` |
| `ms mcp` | 启动 stdio MCP server，供 Claude Desktop / Cursor 等客户端接入 |
| `ms status` | 输出中间件状态 |
| `ms health` | 输出 `MemoryService.health()` JSON |
| `ms migrate` | 估算 v4 schema 迁移 |
| **`ms why <id>`** | **查看记忆评分明细与来源追溯（v1.0.2 P1）** |
| **`ms recall --explain`** | **召回并显示 importance 4 项 breakdown + filteredReason（v1.0.2 P1）** |
| **`ms forget <id>`** | **撤回/归档/纠错/回滚合并记忆（v1.0.2 P1）** |

## `ms stats`

```bash
ms stats
```

输出包含：

- 总记录数
- 用户记忆数
- 扫描文档数
- `dbType`
- provider 支持时的表级统计
- LanceDB 路径或 Supabase URL

## `ms tables`

```bash
ms tables
```

provider 支持 `getTableNames()` 时输出所有表和记录数；不支持时输出明确提示。

## `ms search`

```bash
ms search "配置数据库" --limit 10
ms search "React 组件" --category 知识库 --limit 5
ms search "用户偏好" --search-all --limit 20
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `<query>` | 是 | 搜索查询 |
| `--limit <n>` | 否 | 返回数量，默认 `5` |
| `--include-documents` | 否 | 同时搜索文档和知识数据 |
| `--category <name>` | 否 | 存储分类，如 `核心记忆` 或 `知识库` |
| `--search-all` | 否 | 跨分类搜索 |

注意：当前命令没有短参数别名。

## `ms query`

```bash
ms query --category 核心记忆 --filter '{"category":"preference"}' --limit 20
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--category <name>` | 否 | 存储分类 |
| `--filter <json>` | 否 | JSON 过滤条件 |
| `--limit <n>` | 否 | 返回数量，默认 `100` |

`ms query` 当前不生成 embedding，也没有 `--vector` 参数。需要语义搜索时使用 `ms search`。

## `ms export`

```bash
ms export --category 核心记忆 --format json --output memories.json
ms export --category 知识库 --format csv --output knowledge.csv
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--category <name>` | 否 | 存储分类 |
| `--format <format>` | 否 | `json` 或 `csv`，默认 `json` |
| `--output <file>` | 否 | 输出文件；省略时打印到 stdout |

当前导出命令不支持 `--filter`。需要过滤时先用 `ms query` 检查条件，再扩展导出能力。

## `ms scan`

```bash
ms scan ./docs --ignore node_modules dist
ms scan ./notes --category 核心记忆
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

## `ms cleanup`

```bash
ms cleanup --data-type document --older-than 30
ms cleanup --category 知识库 --older-than 90
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--data-type <type>` | 否 | `memory`、`document` 或 provider 支持的数据类型 |
| `--older-than <days>` | 否 | 删除 N 天前数据 |
| `--category <name>` | 否 | 存储分类 |

至少指定一个过滤条件，否则命令会拒绝执行。

## `ms kb:list`

```bash
ms kb:list
```

列出所有表名以 `knowledge` 开头的知识库表。该命令依赖 provider 的 `getTableStats()`。

## `ms init`

```bash
ms init [directory]
ms init --force
```

**用途**：初始化项目记忆工作区（v0.1.2+）。

**行为**：
1. 生成或复用 `projectId/workspaceId`
2. 写入项目指针 `.mengshu.json`（version: "0.2"）
3. 创建全局项目目录 `~/.mengshu/projects/<projectId>/`
4. 写入完整 `manifest.json`
5. 自动注册到 `~/.mengshu/registry.json`

**选项**：
- `[directory]`：目标项目目录（默认当前目录）
- `--force`：强制覆盖已存在的指针文件

**幂等性**：重复 `init` 会更新 registry 的 `lastOpenedAt`，不会修改已存在的 `projectId`。

## `ms migrate-home`

**用途**：将 `~/.openclaw/` 迁移到 `~/.mengshu/`（v0.1.2+）。

**用法**：
```bash
ms migrate-home [options]
```

**选项**：
- `--execute`：执行迁移（默认 dry-run）
- `--backup`：迁移前备份旧目录
- `--force`：覆盖已存在的目标文件

**迁移清单**：
1. `~/.openclaw/.env` → `~/.mengshu/.env`
2. `~/.openclaw/mengshu-mcp.json` → `~/.mengshu/config.json`
3. `~/.openclaw/memory/` → `~/.mengshu/memory/`（递归复制）
4. `~/.openclaw/conf/plugins.json` 中的内联配置 → 提示手工迁移

**示例**：
```bash
# 预览迁移计划（不执行）
ms migrate-home

# 执行迁移并备份
ms migrate-home --execute --backup

# 执行迁移并强制覆盖冲突文件
ms migrate-home --execute --force
```

**注意**：
- 默认为 dry-run 模式，需显式 `--execute` 才会修改文件。
- 迁移后旧 `~/.openclaw/` 仍会保留，可手动删除。
- 如果检测到项目指针 `.mengshu.json`，会提示重新运行 `ms init` 更新 registry。
- 迁移后请更新客户端配置（Codex/Claude Desktop/OpenClaw）指向新路径。

## `ms serve`

```bash
ms serve
ms serve --host 127.0.0.1 --port 3847
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

## `ms status`

```bash
ms status
```

输出 server URL、数据库类型、数据库路径、健康状态、记录数和表级统计。

## `ms health`

```bash
ms health
```

输出 `MemoryService.health()` 的 JSON 结果，适合脚本化检查。

## `ms migrate`

```bash
ms migrate --to-schema v4 --dry-run
```

当前只支持 `--to-schema v4`。命令根据当前 `service.health().records` 估算迁移计划；它不是实际数据迁移执行器。

## `ms mcp`

```bash
ms mcp
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
    "mengshu": {
      "command": "npx",
      "args": ["openclaw", "ms", "mcp"]
    }
  }
}
```

注意：stdio 模式下进程状态信息走 stderr，stdout 专用于 JSON-RPC 流。scope 由客户端在工具入参中传入，本命令层不做鉴权。

---

## `ms why`（v1.0.2 P1 新增）

```bash
ms why <记忆ID>
ms why <记忆ID> --verbose
```

**用途**：查看一条记忆的评分明细、来源追溯和生命周期信息。

**输出包含**：

- **基础信息**：text、semanticType、kind、targetScope、profileDimension
- **评分明细**：valueScore 8 维（explicitness/durability/actionability/specificity/evidence/scopeFit/novelty/riskPenalty）
- **importance breakdown**：salience_llm / sourceAuthority / explicitnessBonus / typePrior（4 项加权，按 SCORING_WEIGHTS_V1）
- **confidence**：多证据累积分数 + 证据列表（source/count/timestamps）
- **hotness**：mention + source + recency + centrality + queryHits（5 项求和）
- **来源追溯**：sourceId / sessionId / createdAt / mergedFrom / riskFlags
- **生命周期**：AdmissionRoute → CandidateStatus → MemoryLifecycleStatus → UserVisibleStatus（四套状态映射）

**选项**：
- `--verbose`：输出原始 JSON（含 evidence.quote、merge 记录、audit 日志引用）

## `ms recall`（v1.0.2 P1 新增 --explain）

```bash
ms recall "当前项目架构" --explain
ms recall "代码规范" --explain --limit 10
```

**用途**：召回记忆并附带评分解释，方便理解为什么某条记忆被选中或被过滤。

**输出包含**：

- **召回结果**：按 6 因子评分排序（relevance/scopeFit/importance/confidence/evidenceWeight/recency）
- **每条记忆的 score breakdown**：importance 4 项明细 + 最终分权重构成
- **被过滤条目的 filteredReason**：例如 `scope_mismatch`、`salience_below_threshold`、`merged_to_xxx`

**选项**：
- `--explain`：启用评分解释（默认不输出明细）
- `--limit <n>`：返回数量，默认 5
- `--scope <scope>`：限定 scope（session/project/workspace/app/user/global）

## `ms forget`（v1.0.2 P1 新增）

```bash
ms forget <记忆ID>                        # 撤销记忆（revoke）
ms forget <记忆ID> --archive              # 归档记忆
ms forget <记忆ID> --correct "纠正后的文本"  # 纠错
ms forget <记忆ID> --rollback-merge       # 回滚合并操作
```

**用途**：管理记忆生命周期。支持四种操作模式：

| 操作 | 效果 | 可回滚 |
|------|------|--------|
| **revoke**（默认） | 标记记忆为 `revoked`，不再召回 | ✅ 7 天内可 undo |
| **archive** | 标记记忆为 `archived`，降低优先级 | ✅ 可恢复 |
| **correct** | 替换记忆文本，保留原始 evidence 和 merge 记录 | ✅ 保留原版本 |
| **rollback-merge** | 回滚一次合并操作，恢复被合并的独立记忆 | ✅ 原子回滚 |

**审计**：
- 所有 forget 操作写入 `forgetLog`（actor + timestamp + operation + targetId）
- revoke 操作保留 7 天 undo 窗口
- correct 操作保留原文本作为历史版本

**选项**：
- `--archive`：归档模式
- `--correct <text>`：纠错模式，传入正确文本
- `--rollback-merge`：回滚合并模式
- `--reason <text>`：操作原因（写入 audit 日志）
