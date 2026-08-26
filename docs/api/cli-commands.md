# CLI 命令

`ms` 是 mengshu 的管理命令组。当前全局 CLI 入口是 [bin/ms.ts](../../bin/ms.ts)，主实现位于 [packages/api/src/cli/ms.ts](../../packages/api/src/cli/ms.ts)；OpenClaw 插件内的 CLI 注册实现位于 [plugins/openclaw/src/cli/](../../plugins/openclaw/src/cli)，旧 [adapters/openclaw/cli.ts](../../adapters/openclaw/cli.ts) 仅作为兼容转发。

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
| `ms migrate-openclaw-plugin-id` | 迁移 OpenClaw memory 插件 id 到 `mengshu-openclaw` |
| `ms serve` | 启动本机 REST server 和 `/console` |
| `ms mcp` | 启动 stdio MCP server，供 Claude Desktop / Cursor 等客户端接入 |
| `ms status` | 输出中间件状态 |
| `ms health` | 输出 `MemoryService.health()` JSON |
| `ms cost` | 查询本地 append-only runtime 成本账本；支持 date/window/JSON |
| `ms migrate` | 检查或执行当前 v24 PostgreSQL schema/canonical scope cutover |
| `ms migrate-semantic-types` | 以漏斗方式整理历史 MemoryKind 和 5 type；默认 dry-run |
| `ms migrate-topic-tree` | 以 mapped/orphan/ambiguous 漏斗整理历史 Topic Tree；默认 dry-run |
| `ms migrate-history` | 准备/规划/验证/执行/回滚 manifest 固定的 v24 history rebuild |
| `ms migrate-history-worker` | 消费 exact migration identity 的 fenced history tree cohort |
| `ms asset list` | 列出当前 exact scope 下可发现的 private `memory_view` 资产 |
| `ms asset explain <assetId>` | 查看资产版本、底层记忆/树/evidence 引用和实时 stale 状态 |
| `ms asset deprecate <assetId>` | 通过 CAS 和幂等键追加 deprecated 版本 |
| `ms asset revoke <assetId>` | 通过 CAS 和幂等键追加 revoked 版本并触发上下文失效 |
| `ms session explain <sessionId>` | 读取当前 exact private session 的最新上下文装配 receipt（PostgreSQL v22） |
| **`ms why <id>`** | **查看记忆评分明细与来源追溯（v1.0.2 P1）** |
| **`ms recall --explain`** | **召回并显示 importance 4 项 breakdown + filteredReason（v1.0.2 P1）** |
| **`ms forget <id>`** | **撤回/归档/纠错/回滚合并记忆（v1.0.2 P1）** |
| **`ms project ingest-history --dry-run`** | **预览 Codex / Claude Code / OpenClaw agent history 导入（只读，不写库）** |
| **`ms project ingest-history --apply`** | **对采样历史执行真实抽取 + 校验 + 召回链路并落盘验证产物（不写入生产记忆库）** |

## `ms project ingest-history`

```bash
ms project ingest-history --from codex --dry-run
ms project ingest-history --from codex,claude-code --since 90d --dry-run
ms project ingest-history --from openclaw --source-root /path/to/history --dry-run
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--from <providers>` | 否 | 逗号分隔的来源：`codex`、`claude-code`、`openclaw`，默认 `codex` |
| `--since <window>` | 否 | 只包含该时间窗之后的事件，如 `30d`、`12h` |
| `--source-root <path>` | 否 | 覆盖所选来源的根路径 |
| `--max-files <n>` | 否 | 每个来源最多扫描的文件数 |
| `--dry-run` | 否 | 预览模式（默认开启） |
| `--apply` | 否 | 对采样历史执行真实抽取 + 校验 + 召回链路，并落盘验证产物 |

### `--dry-run`（默认）

扫描来源文件、解析 canonical events、统计 session / chunk 预估、脱敏命中和坏行，不调用 embedding，也不写入 MemoryService。

### `--apply`

对采样到的历史文本执行真实链路：LLM 抽取候选 → validator 校验 → 召回与上下文构建，并把每一阶段的过程产物（manifest、候选、校验决策、召回排序、问答与分析）落盘到 `~/.mengshu/eval-corpus/` 下的验证目录，便于回放与复盘。

注意：`--apply` 用于验证导入链路质量，不会把记忆写入你的生产记忆库。

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

## `ms migrate-openclaw-plugin-id`

**用途**：将 OpenClaw memory slot 插件 id 从旧的 `memory-autodb` / `mengshu` 迁移到 `mengshu-openclaw`。

```bash
ms migrate-openclaw-plugin-id
ms migrate-openclaw-plugin-id --execute
```

选项：

- `--execute`：执行迁移；默认只预览。
- `--config <path>`：指定单个 OpenClaw 配置文件；默认同时处理 `~/.openclaw/openclaw.json` 与 `~/.openclaw/conf/plugins.json`。
- `--no-backup`：执行时不备份配置文件。
- `--keep-legacy-entry`：保留旧 entry 并置为 disabled；默认删除旧 entry，避免 OpenClaw stale config warning。

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

输出不依赖 scope authority 的 host readiness JSON，适合主机探针和脚本化检查。健康时退出码为 0；服务返回 `ok: false` 时 REST `/v1/health` 使用 HTTP 503。需要访问具体 scope 的状态、迁移或 session 时仍必须配置 host-owned authority。

## `ms migrate`

```bash
ms migrate --to-schema v24 --dry-run
ms migrate --to-schema v24 --apply \
  --maintenance --quiescence-confirmed \
  --confirm '<dry-run 输出的确认令牌>' \
  --allow-quarantine 0
```

该命令只用于 PostgreSQL schema 与 canonical scope cutover。默认 target 为当前 `v24`，默认只读检查；`--apply` 必须同时提供维护窗口、旧 writer 已静默、dry-run 返回的精确确认令牌，以及本次明确接受的 quarantine 数量。任一条件或 live 数据前提漂移都会 fail-closed。

它会执行 provider-owned schema/backfill contract，不再根据 `service.health().records` 伪造迁移计划。生产执行前仍需独立数据库备份，并在隔离环境演练恢复。

## `ms migrate-semantic-types`

该命令用于整理 PostgreSQL 中的历史记忆分类。默认仅扫描和报告，不写数据库：

```bash
ms migrate-semantic-types --manifest ./semantic-type-manifest.json
```

执行迁移必须同时显式确认维护窗口和写入静默：

```bash
ms migrate-semantic-types \
  --manifest ./semantic-type-manifest.json \
  --apply --maintenance --quiescence-confirmed
```

迁移按以下漏斗处理历史行：

1. scope 未完成规范化或处于 quarantine 的记录不参与迁移。
2. 保留通用 `MemoryKind`；只有显式合法或高置信确定性映射才写入 5 type。
3. 无法确定类型的记录保持 kind-only/lookup-only，不进入 5 槽位。
4. governed 记录同时维护 `metadata.semanticType` 与 `metadata.governance.native.semanticType`。
5. shadow、receipt 和 checkpoint 支持续跑、校验和受控回滚；live metadata 漂移会使校验失败。

manifest 与 migration id 会固定本次执行身份，续跑时不允许更换 manifest。回滚同样要求维护窗口与写入静默，发现并发漂移时拒绝部分恢复。

## `ms migrate-topic-tree`

```bash
ms migrate-topic-tree --migration-id topic-tree-v1
ms migrate-topic-tree --migration-id topic-tree-v1 --verify
ms migrate-topic-tree --migration-id topic-tree-v1 --apply \
  --maintenance --quiescence-confirmed \
  --confirmation-token APPLY:topic-tree-v1
```

默认操作是只读 dry-run。写入、回滚和归档必须提供与操作及 migration id
匹配的 confirmation token；operator 以 mapped/orphan/ambiguous 分流，并保存
receipt/checkpoint 支持续跑、parity verify 和数量守恒回滚。

## `ms migrate-history`

历史重建采用固定 manifest、逐 scope checkpoint、模型预算回执和 fenced tree cohort。不要并行启动相同 migration identity 的多个 apply。

先从生产快照只读生成 per-scope v2 tree policy bundle 和审计报告：

```bash
ms migrate-history \
  --generate-tree-policy ./history-tree-policy-bundle.json \
  --audit-report ./history-tree-policy-audit.json
```

生成器使用 `REPEATABLE READ READ ONLY`，不会调用模型或写数据库，并拒绝覆盖已有输出文件。审核后计算 bundle 原始文件的 SHA-256。bundle 必须覆盖 manifest 中的全部 scope，固定 taxonomy alias、topic 最小支持度/singleton downgrade 和可审计 source identity；缺 scope、重复 scope 或 hash 漂移都会 fail-closed。

随后从 PostgreSQL 生成不含密钥的冻结 v24 manifest，并固定预算、远端外发策略及 bundle hash：

```bash
ms migrate-history \
  --prepare-manifest ./history-manifest.json \
  --migration-id history-20260816 \
  --max-records 50000 \
  --max-model-calls 1000 \
  --max-input-tokens 2000000 \
  --max-output-tokens 500000 \
  --max-cost-minor-units 10000 \
  --currency CNY \
  --pricing-snapshot-version pricing-20260816 \
  --input-cost-per-million-tokens 100 \
  --output-cost-per-million-tokens 400 \
  --remote-egress redacted-only \
  --tree-policy-version history-tree-routing/v2 \
  --topic-label-version scope-topic-taxonomy/v1 \
  --tree-policy-bundle-sha256 '<bundle 文件的 64 位 sha256>'
```

随后使用 manifest 文件的 SHA-256 做只读 plan/verify。只有未能由确定性规则分类的记录才允许在显式 `--live-model` 下外发：

```bash
ms migrate-history \
  --manifest ./history-manifest.json \
  --tree-policy-bundle ./history-tree-policy-bundle.json \
  --plan
ms migrate-history \
  --manifest ./history-manifest.json \
  --tree-policy-bundle ./history-tree-policy-bundle.json \
  --verify
```

写入必须固定 manifest hash 和 migration id，并给出所有维护门禁：

```bash
ms migrate-history \
  --manifest ./history-manifest.json \
  --tree-policy-bundle ./history-tree-policy-bundle.json \
  --manifest-sha256 '<64 位 sha256>' \
  --apply --live-model \
  --maintenance --quiescence-confirmed \
  --confirmation-token APPLY:history-20260816
```

`--drain-trees` 会按 `apply -> fenced history worker -> verify` 串行编排；它要求 model-assisted apply 和全部写门禁，不能与 `--plan`、`--verify`、`--rollback` 混用。worker 参数可用 `--tree-worker-id`、`--tree-lease-ms`、`--tree-heartbeat-ms`、`--tree-poll-ms`、`--tree-stall-timeout-ms`、`--tree-concurrency`、`--tree-timeout-ms` 固定。合法的零 tree-job migration 会跳过 worker，直接进入 strict verify。

```bash
ms migrate-history \
  --manifest ./history-manifest.json \
  --tree-policy-bundle ./history-tree-policy-bundle.json \
  --manifest-sha256 '<64 位 sha256>' \
  --apply --live-model --drain-trees \
  --maintenance --quiescence-confirmed \
  --confirmation-token APPLY:history-20260816
```

回滚使用同一 manifest 和 identity：

```bash
ms migrate-history \
  --manifest ./history-manifest.json \
  --tree-policy-bundle ./history-tree-policy-bundle.json \
  --manifest-sha256 '<64 位 sha256>' \
  --rollback --maintenance --quiescence-confirmed \
  --confirmation-token ROLLBACK:history-20260816
```

一旦该 migration 的 tree job 已开始，内置 rollback 会拒绝继续，避免误删被其他 cohort 或在线运行复用的 leaf/node/effect。此时必须使用事前演练过的数据库 restore 或专门的补偿迁移，不能放宽 preflight。

当前 strict `--verify` 以 manifest 为根，按 scope fingerprint 对照 bundle policy hash，并核对全部 scope、source/plan/apply/model receipt、metadata、inventory、scoring basis、队列和 sealed tree artifact。它仍是迁移一致性验收，不替代 production RuntimeHost gate 或备份恢复演练。

## `ms migrate-history-worker`

该命令只消费一个已完成 history migration 的精确 tree cohort，普通在线 worker 会排除 `history-job:`：

```bash
ms migrate-history-worker \
  --migration-id history-20260816 \
  --manifest-sha256 '<64 位 sha256>' \
  --expected-scopes 41 \
  --worker-id history-tree-01 \
  --lease-ms 60000 \
  --heartbeat-ms 20000 \
  --poll-ms 100 \
  --stall-timeout-ms 60000 \
  --concurrency 4 \
  --timeout-ms 21600000 \
  --max-jobs 6081 \
  --maintenance --quiescence-confirmed
```

`--heartbeat-ms` 必须小于 lease，`--stall-timeout-ms` 不能超过总 timeout，并发度上限为 64。worker 按 scope 有界并行，持续输出包含 completed、remaining、throughput 和 ETA 的 NDJSON 进度；配置窗口内没有 completed 增长会 fail-closed。migration id、manifest hash 和 scope 总数任一漂移都会拒绝消费。不要用它绕过 `migrate-history --drain-trees` 的身份与验收门禁，也不要在旧 topic/source policy 尚未修正时排空已知错误 cohort。

## `ms asset`

资产是 active memory、tree 和 evidence 的版本化治理投影，不是新的事实源。首版只支持 exact private scope 下的 `memory_view`。

```bash
ms asset list
ms asset explain asset-rules
ms asset deprecate asset-rules \
  --expected-version 2 --idempotency-key deprecate-asset-rules-v2
ms asset revoke asset-rules \
  --expected-version 3 --idempotency-key revoke-asset-rules-v3
```

`deprecate` 和 `revoke` 不会原地修改历史版本。命令要求当前最新版本号用于 CAS，并要求稳定幂等键；成功后版本、receipt、audit 和 outbox 在同一 PostgreSQL 事务中写入。底层记忆被撤回、归档或重新划分 scope 后，`explain` 会实时报告资产为 stale。

未使用 PostgreSQL v20 Asset/Loadout overlay 时，`ms asset` 会明确拒绝执行；原生 5 槽位召回不受影响。

## `ms loadout`

```bash
ms loadout current
ms loadout explain loadout-default
ms loadout unbind loadout-default asset-rules --slot rules \
  --expected-version 2 --idempotency-key unbind-rules-v2
ms loadout pause loadout-default \
  --expected-version 3 --idempotency-key pause-loadout-v3
```

`unbind` 和 `pause` 都保留旧版本，并通过 CAS、幂等 receipt、audit/outbox
追加一个新版本。全局紧急停用可将 `features.assetInjection` 设为 `false`；该开关默认关闭。

## `ms session explain`

```bash
ms session explain session-20260813-001
```

返回该 session 最近一次持久化 `ContextAssemblyReceipt`，包括最终 5 槽位 plan、Loadout/binding、denied/degraded 原因、memory/tree/asset/evidence 引用、warning、stable/dynamic hash 和过期时间。

该命令要求 PostgreSQL schema v22 和 host-owned exact private scope。参数只接受 1-256 个字符、NFKC 规范化且不含空白、控制字符或路径分隔符的 `sessionId`；不能用 CLI 参数覆盖 tenant/user/scope。session 不匹配、receipt 不存在或 capability 未就绪时会明确失败，不回退到跨 scope 查询。

## `ms cost`

```bash
ms cost
ms cost --date 2026-08-16
ms cost --window 7d
ms cost --window 7d --json
```

默认读取 `~/.mengshu/audit/runtime-cost.jsonl`，无需创建 runtime 或读取 provider 凭据。`--date` 使用本地日历日期；`--window Nd` 是截至当前时刻的滚动窗口，两者不能同时使用。输出按 `native_memory`、`asset_promotion`、`prewarm`、`asset_tool`、`operator`、`unknown` 聚合事件、provider attempt、retry、token/embedding units 和估算金额。

账本只接受固定字段，不保存 prompt、正文、API key 或 tenant/user 明文；scope 只记录 `sha256:<64hex>` fingerprint。文件损坏时按行 fail-closed，不跳过坏记录。金额基于事件固定的本地 `llm.pricing.version` 快照，仅用于估算，不是 provider 账单；未知 provider/model 或缺少 token usage 时显示 unpriced，不伪装为零成本。

当前实现已覆盖默认 runtime 的 LLM complete/summarize/extractStructured 与 embedding provider attempt。BudgetPolicy、economy/balanced/quality mode、gate rejection/subbudget，以及部分 operator/asset/prewarm 绕行入口仍由 MG-014 跟踪。

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
| `memory_navigate` | 在 slot/source/topic/global 之间渐进导航 |
| `memory_evidence_read` | 读取 authority-scoped L0 evidence 以核验来源 |
| `memory_asset_list` | 列出 exact scope 下可发现的 private 资产 |
| `memory_asset_read` | 读取资产描述和实时 stale 状态 |
| `memory_asset_explain` | 解释资产版本、底层引用和 evidence |
| `memory_asset_search` | 按 `query` 搜索 exact private scope 的资产，可选 `limit` 和 `semanticType` |
| `memory_session_explain` | 仅按 `sessionId` 读取 server-owned exact private session 的最新装配 receipt |

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

注意：stdio 模式下进程状态信息走 stderr，stdout 专用于 JSON-RPC 流。生产模式使用 host-owned AuthorityScope；客户端 scope 只能在允许范围内继续收窄，不能覆盖 tenant/user。`memory_asset_search` 只接受 `query/limit/semanticType`，`memory_session_explain` 只接受 `sessionId`。MCP 资产工具保持只读，撤回和弃用使用 `ms asset` 用户控制面。

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
