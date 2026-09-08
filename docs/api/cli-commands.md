# CLI 命令

`ms` 是 mengshu 的管理命令组。当前全局 CLI 入口是 [bin/ms.ts](../../bin/ms.ts)，主实现位于 [packages/api/src/cli/ms.ts](../../packages/api/src/cli/ms.ts)。产品无关的 Project Workspace 入口从 [packages/api/src/cli/project.ts](../../packages/api/src/cli/project.ts) 导出；OpenClaw 下的历史路径只保留兼容。OpenClaw 专属 server/hook/tool 命令仍位于 [plugins/openclaw/src/cli/](../../plugins/openclaw/src/cli)。

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
| `ms evolve inventory/scan` | host-bound 批次的预览、隔离提案与受控门禁，默认预览 |
| `ms evolve status/resume <batch-id>` | 查询批次或显式开启一个有限恢复段 |
| `ms evolve control/undo-preview/undo-approve` | 独立 owner 的来源对账、支持关系撤销与精确治理撤销 |
| `ms cleanup` | 按数据类型、时间或分类清理数据 |
| `ms kb:list` | 列出 `knowledge*` 知识库表 |
| `ms setup` | 交互式配置 LLM、Embedding 和数据库 |
| `ms init [dir]` | 初始化产品无关的项目指针和全局 manifest，不要求 authority |
| `ms project status [dir]` | 读取本地项目 identity，不访问记忆库 |
| `ms project context/lookup` | 在 Agent 产品提供的可信 scope 内访问项目记忆 |
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
ms init --workspace-id workspace-acme --project-id project-api
ms init --force
```

**用途**：初始化产品无关的 Project Memory Workspace。该命令只写本地项目元数据，
不读取 runtime 配置、不连接数据库，也不要求 OpenClaw authority。

**行为**：
1. 使用 Agent 产品 resolver、显式参数或目录派生结果确定 `projectId/workspaceId`
2. 写入项目指针 `.mengshu.json`（version: "0.2"）
3. 创建全局项目目录 `~/.mengshu/projects/<projectId>/`
4. 写入完整 `manifest.json`
5. 自动注册到 `~/.mengshu/registry.json`

**选项**：
- `[directory]`：目标项目目录（默认当前目录）
- `--workspace-id <id>`：Agent 产品确定的 workspace id
- `--project-id <id>`：Agent 产品确定的 project id
- `--visibility <level>`：`private/workspace/team/public`
- `--force`：强制覆盖已存在的指针文件

**幂等性**：重复 `init` 会更新 registry 的 `lastOpenedAt`，不会修改已存在的 `projectId`。

`tenantId/userId/appId/agentId/namespace` 不属于项目初始化参数，由 Codex、OpenClaw 或其他
Agent 产品的可信运行时提供。`--user-id` 会被拒绝。标识不能包含路径分隔符。详见
[项目身份与运行时 Authority](../guides/authority-and-project-scope.md)。

## `ms setup`

```bash
ms setup
```

交互式写入 `~/.mengshu/config.json` 和 `~/.mengshu/.env`。它只负责模型与存储配置，
不创建项目 identity，也不生成产品 authority。首次直接运行 `ms init` 且全局配置不存在时，
CLI 会先进入同一个 setup 向导，再继续项目初始化。

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
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms serve
ms serve --host 127.0.0.1 --port 3847
```

默认监听 `127.0.0.1:3847`。启动后可访问：

```text
http://127.0.0.1:3847/v1/health
http://127.0.0.1:3847/console
```

安全默认值：

- 必须由 Agent 产品提供 `authority/defaultScope`；`ms init` 不负责生成或扩大它。
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

## `ms evolve`

通过 RuntimeClient 调用共享 RuntimeHost，不在 CLI 中创建独立 provider/worker。进化批次要求操作者开启 `features.continuousMemoryEvolution` 且 host 注册对应 native PostgreSQL capability；v36 为批次基础，治理扩展使用 v37。CLI 存在不代表已连接的服务端支持相应控制能力。

```bash
ms evolve inventory --selection baseline --dry-run \
  --max-records 20 --idempotency-key inventory-preview-001
ms evolve scan --source-id project-notes --propose \
  --max-files 5 --max-llm-calls 2 --idempotency-key notes-propose-001
ms evolve inventory --selection baseline --propose \
  --max-records 20 --idempotency-key inventory-cli-propose-001
ms evolve status <batch-id>
ms evolve resume <batch-id>
```

`scan` 只接受 host 预先注册的 `--source-id`，不接受位置目录参数或客户端 path/scope/model/authority。`inventory` 的 `--selection` 默认 `baseline`；native v37 provider 已组装 `changed/due` 选择与逐项确认，其他 host 需提供同一组合。changed 使用外部语义 outbox，due 使用到期复核字段，不以访问热度判断变化；preview 不消费事件。冻结批次完成不等于全库增量已处理。

| 参数 | 说明 |
|------|------|
| `--dry-run` | `preview`，也是未指定动作时的默认值；无 LLM/embedding/canonical 写入，可保存批次报告 |
| `--propose` | 生成隔离提案与必要证据，不改当前 head、confidence 或正常召回 |
| `--apply-allowed` | 进入专用治理门；无合格 host attestation 的库存/目录证据仍 untrusted，不是直接内容更新或批准候选的命令 |
| `--idempotency-key <key>` | 1-128 字符安全标识；省略时生成新键，同请求重试应复用原键 |
| `--max-records <count>` / `--max-files <count>` | 记录/证据与文件读取预算，包括必要复核 |
| `--max-bytes <count>` | 应用层字节预算；目录计入来源 hash 重读，库存为有界 SQL 结果返回后的保护，不是数据库磁盘/网络硬配额 |
| `--max-llm-calls <count>` | 模型调用预算 |
| `--max-input-tokens <count>` / `--max-output-tokens <count>` | 模型 token 预算 |
| `--max-duration-ms <count>` | 单执行段总时长上限，毫秒 |

inventory/scan 的三个动作互斥，上表预算 flags 只接受正整数，并同时受 CLI 上限与服务端 schema 校验约束；省略值由服务端补齐，默认值见[进化指南](../guides/continuous-memory-evolution.md)。下述治理控制使用独立 JSON 合同，不使用这些动作和预算 flags。`status/resume` 只接受 batch ID，不接受更换动作、limits 或 checkpoint。

库存已计入 lookahead 与原始证据返回行；`usage.records/bytes` 描述应用层预算工作量，不是 provider 的精确线上 I/O。`maxBytes` 超限检查发生在有界结果返回之后，不能用该 flag 限定数据库实际磁盘扫描或网络传输字节。

输出为 JSON 批次报告；关注 `status/reasons/resumable`、累计 `usage` 和 `counts`，不把命令返回视作 canonical 应用成功。显式 resume 新开有限 segment，累计 usage 不清零；幂等请求重试、后台 job retry 不增加新额度。目录来源不因注册获得信任，高影响操作保留审阅，普通候选批准不能绕过进化门禁。默认 related-target 查找仅发现审阅对象，不授予修改权；目录持久定位已接入新 reader 实例的精确重读，复核失败不以 staged quote 替代当前来源，单条重读不确认整页 manifest，也不代表实际系统恢复演练已完成。完整适用边界见[进化指南](../guides/continuous-memory-evolution.md)，传输合同见 [Memory API](memory-api.md)。

库存 legacy raw evidence 与目录不因 MCP/user 通道名或 remember intent 获得作者/目标授权证明。可信 issuer 签名与事务内复核另有 host 合同，`--apply-allowed` 和普通候选审批不是授权补齐方式。专用审阅绑定具体提案与版本，且只有 host 注册真实 review capability 后才提供服务。缺少能力时返回 `EVOLUTION_CONTROL_UNAVAILABLE`，不降级为直接写入。

### 后台控制

```bash
ms evolve background
ms evolve maintenance
ms evolve background --mode paused --expected-revision <revision>
ms evolve background --mode evolution_only --batch-id <batch-id> --expected-revision <revision>
```

不带参数时读取状态；修改要求独立 ownerSecret 和读取到的当前 revision。`evolution_only` 的 `--batch-id` 可重复，最多 100 个不重复 ID；`all/paused` 不接批次白名单。响应包含 `mode/revision/state/active/allowedBatchIds`。切换后的 `draining` 需要等待至 `active=0`，不表示当前事务已回滚。读服务继续可用，但显式前台写入不受此后台门禁止。

`maintenance` 仅 GET 查询低频维护快照，不触发任务，也不接受 `--enable` 或预算参数。快照含 `enabled/status/reasons/updatedAt/budgetReserved/localFreeBytes/databaseFreeBytes`，可带 batchId/jobId。默认 driver 已接入原 scheduler，维护缺省关闭且自动仅 `due + propose`；当前数据库剩余空间未知（`databaseFreeBytes=null`）会阻断自动维护。本地磁盘样本不代表 PG 剩余空间，状态也不是清理完成或实际费用结算证明。

退出维护只有在操作者完成回执、预算与后验检查后，以新的 revision 显式选择 `--mode all`；该变更不持久化到启动配置，重启后必须重新读取状态。

### 专用审阅合同

native RuntimeHost 已组装以下 review/cancel 服务；连接其他或旧 host 时仍须检查 capability。操作者凭据来自可信配置 `evolution.control.ownerSecret`，不放在 flag 中，批准不是跳过 writer 门禁的保证。

| 命令形式 | 参数/意义 |
|----------|-----------|
| `ms evolve proposals` | 可选 `--batch-id <id>`、`--status <status>`、`--limit <count>`、`--cursor <cursor>`；默认 20、最多 50 项，status 为 staged/rejected/review/applied/noop，cursor 仅使用响应中的 nextCursor |
| `ms evolve proposal <proposal-id>` | 提案详情、必要证据与可选审阅回执摘要；不是完整原始来源导出 |
| `ms evolve review <proposal-id>` | 读取精确 diff、来源、目标和 bindingHash；不是批量候选自动批准 |
| `ms evolve review-status <review-id>` | 读取同 scope 的审阅项状态 |
| `ms evolve approve <review-id>` / `reject <review-id>` | 必须传 `--binding-hash <hash>`、`--idempotency-key <key>`，可传 `--reason <reason>`；批准并不改写来源作者 |
| `ms evolve apply <approval-receipt-id>` | 使用批准回执准备受治理应用，仍需重读来源、目标 CAS、有效期与唯一 durable job |
| `ms evolve cancel <batch-id>` | 请求取消；不当作已提交内容的 rollback |

`reviewId/proposalId/approvalReceiptId` 必须来自相应真实响应，不从本地文件或 ID 猜测构造；`bindingHash` 必须原样使用当前审阅值，不能把旧 diff 批准套到新状态。审阅与应用返回、错误和可用性见 [Memory API](memory-api.md)。

以下参数占位必须替换为本次响应值；批准前读取完整 review。`--binding-hash` 为 64 位小写十六进制，`--reason` 最多 512 字符。

```bash
ms evolve proposals --batch-id <batch-id> --limit 20
ms evolve proposal <proposal-id>
ms evolve review <proposal-id>
ms evolve approve <review-id> --binding-hash <binding-hash> --idempotency-key owner-decision-001
ms evolve apply <approval-receipt-id>
```

`apply` 返回批次报告，后续用 `status` 和提交 receipt 核对；不能用 decision receipt 当作已提交证明。默认 Runtime 已接入输入预算和 writer 同事务 attestation/revocation 复核，未通过来源重读、目标 CAS、有效期或撤销检查时仍会阻断。没有通用 host-state put 或历史 continuation 子命令。

### 来源与复用控制

以下命令已注册为专用 host proxy；`--request` 是单个 JSON 字符串，不是文件路径或任意 state 写入，原始字符串上限 16384 字节。完整请求字段见 [来源证明 API](memory-api.md#来源证明控制)和[复用 API](memory-api.md#受控复用与配对评测)。

| 命令形式 | 合同 |
|----------|------|
| `ms evolve source-attest --request <json>` | 提交可信 issuer 已签名的 statement、signature、expectedRevision、idempotencyKey；不在 CLI 中签名 |
| `ms evolve source-revoke-attestation --request <json>` | sourceId/sourceRevision、expectedRevision、idempotencyKey、operationIdempotencyKey、expiresAt；只撤销来源信任 |
| `ms evolve reuse-status` | 查询 targetFingerprint（可缺省）、grantsRevision、grantIds；列表不是实时授权成功证明 |
| `ms evolve reuse-grants --request <json>` | grants、expectedRevision、idempotencyKey；完整替换目标 scope 的同 owner 来源授权，空 grants 明确清空 |
| `ms evolve reuse-evaluate <plan-id>` | 只执行 host 注册的计划，不接受 path、model、holdout 正文或成功标记 |

CLI 启动入口为这五个专用控制命令转发可信配置 `evolution.control.ownerSecret`，使用独立 `x-mengshu-owner-token`；普通 inventory 请求不携带 owner 凭据。仍须配置有效凭据并由 host 提供对应 capability，普通 bearer 不能代替 owner 认证。

attest/revoke 返回来源信任状态回执，不证明 canonical evidence/links 已撤销或事实已遗忘；grants 返回替换回执，不绕过读取、目标兼容性、期限、撤销及引用缓存门禁。evaluate 可能调用已配置模型，当前仅注册的 `synthetic:fact-selection-v1` 适用；`accepted_for_review` 仍禁止发布/执行，不是正式 G/P 通过，也不补齐缺少独立 outcome 证明的 E3 经验来源。

### 治理控制

以下三条命令使用原 RuntimeHost durable 队列和后台门，要求独立 owner 凭据；CLI 启动入口从可信配置转发 `evolution.control.ownerSecret`，不接受凭据 flag、通用 state、path 或 authority。

| 命令形式 | 合同 |
|----------|------|
| `ms evolve control --request <json>` | 上限 16384 字节；closed input.mode=control，action=execute_control，work 仅 source_reconcile/source_revoke/undo_governance |
| `ms evolve undo-preview <receipt-id>` | 64 位小写十六进制的原操作 receipt ID，返回精确当前状态 hash；不执行撤销 |
| `ms evolve undo-approve --request <json>` | 上限 4096 字节；operationReceiptId/currentStateHash/expectedRevision/idempotencyKey/operationIdempotencyKey/expiresAt，返回行政批准而非已执行证明 |

`--request` 只能是单个 JSON 字符串，不读取请求文件。以下仅展示结构，sourceId 和幂等键为示意；`control` 会准备治理写入批次，不是 dry-run，也不是生产操作授权：

```bash
ms evolve control --request '{"input":{"mode":"control","work":{"kind":"source_reconcile","sourceId":"project-notes"}},"action":"execute_control","limits":{"maxRecords":100,"maxFiles":20,"maxBytes":1000000,"maxDurationMs":120000},"idempotencyKey":"source-reconcile-demo-001"}'
```

control 的 `limits` 仅接受四项 I/O 限额，模型/token 预算固定为零且不接受对应请求字段。source_reconcile 的 maxFiles 必须为正数；source_revoke/undo_governance 归零，允许显式 0。较小限额仍可能不足以完成一次对账或事务，不能据 parser 接受推断能完成。

source_revoke 先由 `source-revoke-attestation` 取得精确 sourceRevision 与 operationIdempotencyKey 绑定的行政批准，再以其 id 作为 reviewReceiptId 执行控制批次；前一步只撤销信任，不撤销 canonical evidence/links。undo 先 preview、approve，再提交 undo_governance，批次 idempotencyKey 必须等于批准绑定的 operationIdempotencyKey。完整 JSON 字段及有效期见[治理控制 API](memory-api.md#治理控制批次)，不能猜测回执或 hash。

控制批次仍用 `ms evolve status/resume <batch-id>`。resume 从可信配置转发可选 owner 凭据；无凭据保留普通批次恢复，但控制批次必须独立 owner 认证。报告公开 work.kind 和有限 work.result，usageAccounting 为 budget_reservation；source_reconcile 的 partial 可能已含数据库提交 receipt，不等于完全未写，manifest 确认与数据库提交须分别核对。

历史 operator 当前只支持 synthetic/loopback 隔离工程验证，不是 `ms evolve` 的生产历史入口。本指南不提供真实历史更新或恢复命令，关闭 feature 也不降级 schema。

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
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
ms mcp
```

启动 stdio 传输的 MCP server，让本地 MCP 客户端（Codex、Claude Desktop、Cursor 等）
通过标准输入输出调用长期记忆工具。启动前必须由 Agent 产品提供
`MENGSHU_AUTHORITY_FILE` 或 `MENGSHU_AUTHORITY_JSON`，两者只能设置一个。

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
| `memory_evolution_run` | capability 可用时，提交 host-bound 的 inventory/directory 批次请求 |
| `memory_evolution_status` / `memory_evolution_resume` | capability 可用时，仅按 `batchId` 查询/恢复进化批次 |
| `memory_evolution_source_attest` / `memory_evolution_source_revoke_attestation` | sourceControl 可用且 proxy 独立 owner 认证后，提交签名声明/撤销来源信任 |
| `memory_evolution_reuse_status` / `memory_evolution_reuse_grants` / `memory_evolution_reuse_evaluate` | reuse 可用且 proxy 独立 owner 认证后，查询/替换同 owner 授权或评测注册计划 |
| `memory_evolution_control_run` / `memory_evolution_control_undo_preview` / `memory_evolution_control_undo_approve` | control 可用且 proxy 独立 owner 认证后，提交治理批次或精确撤销预览/批准；直接 stdio 不暴露这三条控制工具 |

Claude Desktop 配置示例（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "mengshu": {
      "command": "ms",
      "args": ["mcp"],
      "env": {
        "MENGSHU_AUTHORITY_FILE": "/absolute/path/to/.mengshu/authority.json"
      }
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
