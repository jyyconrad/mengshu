# Memory API

本页记录 mengshu 记忆中间件的完整 API 接口，涵盖四个接入层：

1. **OpenClaw 工具** — 插件宿主内直接调用
2. **REST API** — 本机 HTTP 服务（`ms serve`）
3. **MCP facade** — MCP stdio proxy 与 RuntimeHost 动态工具表
4. **JavaScript SDK** — 通过 REST API 的编程客户端

参数以源码为准：[index.ts](../../index.ts)、[packages/api/src/rest/router.ts](../../packages/api/src/rest/router.ts)、[packages/mcp/src/tools.ts](../../packages/mcp/src/tools.ts)、[packages/api/src/sdk/client.ts](../../packages/api/src/sdk/client.ts)。旧路径 `adapters/rest/*`、`adapters/mcp/*`、`adapters/sdk/*` 仅保留兼容 re-export。

## 架构概述

```text
OpenClaw / MCP / REST / SDK / Console / CLI
                  │
       adapter / RuntimeClient proxy
                  │
              RuntimeHost
                  │
  Write Kernel / Governed Recall / Context Engine
                  │
 PostgreSQL native capability bundle
```

RuntimeHost 是 provider、worker、cache 与 capability 的单一 owner。默认 `ms mcp` 通过 loopback HTTP 或 owner-only Unix socket 转发 RuntimeHost 的动态 MCP 工具表；OpenClaw embedded 模式可在宿主内创建 Runtime。核心服务合同位于 `packages/core/src/domain/service-types.ts`。

Project Memory Workspace 与 Runtime authority 相互独立：`ms init` 只创建共享的
`workspaceId/projectId`；OpenClaw、Codex 或其他 Agent 产品在调用本 API 时提供自己的
tenant/user/app/agent/namespace。客户端请求不能覆盖 tenant/user。详见
[项目身份与运行时 Authority](../guides/authority-and-project-scope.md)。

## Project Workspace 初始化合同

`@mengshu/core/api` 导出产品无关的 `registerProjectCliCommands` 和
`ProjectIdentityResolver`：

```typescript
type ProjectIdentityResolver = (request: {
  dir: string;
  requested: Partial<{
    workspaceId: string;
    projectId: string;
    defaultVisibility: "private" | "workspace" | "team" | "public";
  }>;
  suggested: {
    workspaceId: string;
    projectId: string;
    defaultVisibility: "private" | "workspace" | "team" | "public";
  };
}) => ProjectIdentity | Promise<ProjectIdentity>;
```

`resolveProjectIdentity` 只决定本地项目 identity，不是授权接口。访问记忆库时，产品必须
另外注入 `resolveMemoryScope(manifest)`，用认证后的 authority 组合完整 `MemoryScope`。

## OpenClaw 工具

| 工具 | 作用 |
|------|------|
| `memory_store` | 保存一条长期记忆 |
| `memory_recall` | 召回相关记忆 |
| `memory_forget` | 按 ID、查询或过滤条件删除记忆 |
| `memory_scan_directory` | 扫描 Markdown 目录并写入 ingestion pipeline |
| `memory_cleanup` | 按数据类型、时间或过滤条件清理数据 |
| `memory_context_fast` | Agent 启动快路径，返回 5 槽位上下文 |

### `memory_store`

```json
{
  "text": "用户偏好使用 TypeScript",
  "importance": 0.8,
  "category": "preference",
  "metadata": {
    "source": "manual"
  },
  "storageCategory": "核心记忆"
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `text` | 是 | - | 要保存的文本 |
| `importance` | 否 | `0.7` | 重要性，范围 0-1 |
| `category` | 否 | 自动分类或 `other` | `core`、`preference`、`fact`、`entity`、`decision`、`task`、`plan`、`goal`、`other` |
| `metadata` | 否 | `{}` | 自定义元数据 |
| `storageCategory` | 否 | `核心记忆` | 用户友好分类，映射到底层表 |

### `memory_recall`

```json
{
  "query": "用户喜欢什么代码风格",
  "limit": 5,
  "minScore": 0.1,
  "includeDocuments": false,
  "filter": {
    "category": "preference"
  },
  "category": "核心记忆",
  "searchAll": false
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `query` | 是 | - | 检索查询 |
| `limit` | 否 | `5` | 返回数量 |
| `minScore` | 否 | `0.1` | 治理过滤后的最低 6 因子综合分；不是 provider 向量相似度门槛 |
| `includeDocuments` | 否 | `false` | 是否包含扫描文档数据 |
| `filter` | 否 | - | 元数据过滤条件 |
| `category` | 否 | - | 存储分类 |
| `searchAll` | 否 | `false` | 跨分类搜索 |
| `knowledgeBase` | 否 | - | 指定 `knowledge_*` 表 |

### `memory_forget`

```json
{
  "memoryId": "mem_123"
}
```

也可以传入：

```json
{
  "query": "旧的数据库方案"
}
```

或：

```json
{
  "filter": {
    "category": "obsolete"
  }
}
```

### `memory_scan_directory`

```json
{
  "directory": "./docs",
  "ignorePaths": ["node_modules", "dist"],
  "ignoreRules": ["*.draft.md"],
  "targetTable": "knowledge",
  "autoEnrichMetadata": true
}
```

| 参数 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `directory` | 是 | - | 要扫描的目录 |
| `ignorePaths` | 否 | `[]` | 额外忽略路径 |
| `ignoreRules` | 否 | `[]` | gitignore 风格规则 |
| `targetTable` | 否 | `knowledge` | 目标表 |
| `autoEnrichMetadata` | 否 | `true` | 是否补充文件路径、更新时间等元数据 |

### `memory_cleanup`

```json
{
  "dataType": "document",
  "olderThanDays": 30,
  "filter": {
    "source": "scan"
  }
}
```

### `memory_context_fast`

```json
{
  "task": "整理 mengshu 文档",
  "tokenBudget": 4000,
  "latencyBudgetMs": 80
}
```

返回结构包含：

- `slots.profile`
- `slots.task_context`
- `slots.rules`
- `slots.experience`
- `slots.resource`
- `content`
- `taskHints`
- `actions`
- `freshness`
- `warnings`
- `telemetry`

## REST API

本机 server 由 `ms serve` 启动，默认监听 `127.0.0.1:3847`。

安全默认值：

- 没有 `server.secret` 时，只允许 loopback 请求。
- 配置 `server.secret` 后，需要 `Authorization: Bearer <secret>`。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/health` | 服务健康和记录数 |
| `POST` | `/v1/memories` | 写入 `MemoryRecord` |
| `POST` | `/v1/recall` | 召回记忆 |
| `POST` | `/v1/context` | 召回并打包 prompt-safe context |
| `POST` | `/v1/evolution/run` | capability 可用时，提交 host-bound 进化批次 |
| `POST` | `/v1/evolution/status` | 仅按 batchId 查询进化批次 |
| `POST` | `/v1/evolution/resume` | 显式有限恢复，不接受新的 scope/limits |
| `POST` | `/v1/evolution/review/<operation>` | 独立 owner 认证的 list/detail/preview/status/decide/apply，详见下文 |
| `POST` | `/v1/evolution/cancel` | owner 请求取消有限批次，不回滚已提交数据 |
| `POST` | `/v1/evolution/source/attest` / `/v1/evolution/source/revoke-attestation` | owner 提交已签名的来源声明/撤销信任，不是 canonical 删除 |
| `POST` | `/v1/evolution/control/run` | owner 提交来源对账、支持关系撤销或精确治理撤销批次 |
| `POST` | `/v1/evolution/control/undo-preview` | owner 按原操作 receipt 读取精确当前状态，不执行撤销 |
| `POST` | `/v1/evolution/control/undo-approve` | owner 批准精确状态与操作幂等键，返回行政回执 |
| `POST` | `/v1/evolution/reuse/status` / `grants` / `evaluate` | owner 查询/完整替换同 owner 授权，或执行注册计划 |
| `GET` / `POST` | `/v1/runtime/background` | 读取后台门状态；owner 凭当前 revision 更新模式 |
| `GET` | `/v1/runtime/maintenance` | 低频维护快照，不触发任务或修改配置 |
| `POST` | `/v1/graph/query` | 可选图谱查询（需注入 graph 模块） |
| `POST` | `/v1/console/overview` | Web Console 总览 |
| `POST` | `/v1/console/lookup` | Web Console 速查 |
| `POST` | `/v1/console/graph` | Web Console 图查询 |
| `GET` | `/v1/console/jobs` | Job 队列状态 |
| `POST` | `/v1/console/candidates` | 候选区列表 |
| `POST` | `/v1/console/candidates/review` | 候选记忆审核（approve/reject） |
| `POST` | `/v1/agent/context` | Agent 快路径上下文（5-slot） |
| `POST` | `/v1/agent/observe` | Agent 运行中轻量 observation |
| `POST` | `/v1/agent/lookup` | Agent 运行中速查 |
| `POST` | `/v1/agent/session/commit` | Agent 会话结束提交 |
| `GET` | `/v1/runtime` | Runtime owner/home/generation/readiness 快照 |
| `GET` | `/v1/runtime/mcp-tools` | 当前 capability 对应的 MCP 工具表 |
| `POST` | `/v1/runtime/mcp-call` | RuntimeClient 转发单次 MCP 工具调用 |
| `POST` | `/v1/session/working-set/*` | Working Set ingest/assemble/read/explain/close/promote |
| `POST` | `/v1/session/task-boundary` | 记录 session task boundary |
| `POST` | `/v1/skills/*` | reviewed Skill propose/import/review/publish/version/read/search/explain/revoke |
| `POST` | `/v1/memory-policy/versions` | 追加 scoped policy version |
| `POST` | `/v1/memory-policy/resolve` | 解析 effective policy |
| `POST` | `/v1/memories/history` | 读取 temporal lineage 历史 |
| `POST` | `/v1/recall/as-of` | 按时间点召回一个 lineage |
| `POST` | `/v1/memories/evolve|correct|restore` | 以 CAS/idempotency 追加受治理版本 |
| `POST` | `/v1/memories/expire|revoke|purge` | 时间过期、撤回或显式永久清除 |

增量端点只在对应 capability 注入时存在；否则返回 `404`。Temporal、Working Set、Skill 和 Policy 当前以 PostgreSQL Runtime 为参考组合。

### `GET /v1/health`

```bash
curl http://127.0.0.1:3847/v1/health
```

响应：

```json
{
  "ok": true,
  "records": 42
}
```

### `POST /v1/memories`

```json
{
  "record": {
    "id": "mem_1",
    "scope": {
      "tenantId": "local",
      "appId": "openclaw",
      "userId": "default",
      "projectId": "default",
      "agentId": "default",
      "namespace": "memories"
    },
    "kind": "fact",
    "text": "mengshu 共享 Runtime 使用 PostgreSQL",
    "contentHash": "hash_1",
    "importance": 0.7,
    "category": "fact",
    "dataType": "memory",
    "tableName": "memories",
    "metadata": {},
    "provenance": {
      "source": "user"
    },
    "createdAt": 1760000000000
  }
}
```

### `POST /v1/recall`

```json
{
  "query": "默认数据库是什么",
  "limit": 5,
  "scope": {
    "appId": "openclaw",
    "namespace": "memories"
  }
}
```

### `POST /v1/context`

```json
{
  "query": "整理项目文档",
  "limit": 5,
  "title": "Retrieved Context"
}
```

### `POST /v1/agent/context`

```json
{
  "scope": {
    "appId": "openclaw",
    "namespace": "memories"
  },
  "task": "准备一次架构评审",
  "intent": "writing",
  "constraints": ["只使用当前仓库文档"],
  "tokenBudget": 4000,
  "latencyBudgetMs": 80
}
```

### `POST /v1/console/lookup`

```json
{
  "scope": {
    "tenantId": "local",
    "appId": "openclaw",
    "userId": "default",
    "projectId": "default",
    "agentId": "default",
    "namespace": "knowledge"
  },
  "query": "memory tree",
  "limit": 10
}
```

private 内容不会返回 raw，只显示 `[private]` 预览。

### 持续记忆进化批次

以下接口仅在 RuntimeHost 注册 `continuousMemoryEvolution` capability 时提供；`features.continuousMemoryEvolution` 默认关闭。它们与单条记忆的 temporal evolve/correct 接口不同，不接受任意客户端 scope、目录、模型或候选批准指令。普通 run 只接受 inventory/directory；control 输入使用下述独立治理路由，不扩充普通 run。前置条件与限制见[持续记忆进化指南](../guides/continuous-memory-evolution.md)。

native RuntimeHost 已组装有限批次、提案发现与专用 owner 审阅，批准 apply 进入同一 durable 队列；输入预算、host attestation 和 writer 同事务撤销复核已有默认调用。库存 legacy raw evidence 与目录证据不因通道名、role 或 remember intent 获得作者/目标授权；没有合格签名证明时保持 untrusted。owner 审阅是行政批准，不单独证明独立有效支持；来源复核、目标 CAS、授权/撤销事务门任一缺失仍会阻断，不提供默认自动内容更新承诺。

| REST | MCP | 请求 |
|------|-----|------|
| `POST /v1/evolution/run` | `memory_evolution_run` | 下述批次请求 |
| `POST /v1/evolution/status` | `memory_evolution_status` | 仅 `{ "batchId": "..." }`，使用 run 返回的真实 ID |
| `POST /v1/evolution/resume` | `memory_evolution_resume` | 同 status；不接受客户端 checkpoint 或新 limits |

`run` 请求及其嵌套对象均拒绝未知字段，请求体上限为 16384 字节：

```json
{
  "input": { "mode": "inventory", "selection": "baseline" },
  "action": "preview",
  "limits": { "maxRecords": 20 },
  "idempotencyKey": "api-inventory-preview-001"
}
```

| 字段 | 合同 |
|------|------|
| `input` | 二选一：`{ mode: "inventory", selection: "baseline" \| "changed" \| "due" }` 或 `{ mode: "directory", sourceId: string }` |
| `action` | 必填：`preview`、`propose`、`apply_allowed`；REST/MCP 无默认动作，CLI 默认预览 |
| `limits` | 可选，逐项补默认值，见下表；只接受整数 |
| `idempotencyKey` | 必填，1-256 字符，首字符为字母/数字，其余仅允许字母/数字与 `._:-`；同键不得改变请求 |
| `batchId` | status/resume 必填，1-128 字符，同样的安全字符规则；只查询 host 当前 scope |

目录 `sourceId` 必须来自 host 的来源注册表，注册标识为 1-128 字符，首字符字母/数字，其余只允许字母/数字与 `._-`，不接受冒号。native v37 库存组合提供 `changed/due` 的有限冻结与逐项确认；其他 host 需提供对应端口。preview 不消费事件，propose 的确认只证明提案已持久化；未选事件留给后续批次，不是全库水位追平承诺。

| limits 字段 | 默认值 | REST/MCP 最大值 |
|-------------|--------|-----------------|
| `maxRecords` | `100` | `1000` |
| `maxFiles` | `20` | `200` |
| `maxBytes` | `1000000` | `10000000` |
| `maxLlmCalls` | `8` | `100` |
| `maxInputTokens` | `32000` | `256000` |
| `maxOutputTokens` | `8000` | `64000` |
| `maxDurationMs` | `120000` | `600000` |

普通 run 的三项模型预算 `maxLlmCalls/maxInputTokens/maxOutputTokens` 可为 `0`，其他值最小 `1`；inventory/scan 的 CLI flags 额外限制范围且只接受正整数。token/calls 是保守预留上界，不是实际 provider 使用量；真实调用用量和金额估算在成本 ledger 中记录。治理控制的限额合同另见下文。

库存读取计入 lookahead 与原始证据行，字节量按 SQL 返回行的 JSON 序列化大小累计。`maxBytes` 在有界结果返回后检查（post-read），可在本次读取已超剩余额度后暂停；它不是 PostgreSQL 磁盘扫描或网络传输硬配额。报告中的 `usage.records/bytes` 是应用层预算计量，不是 provider 线上精确 I/O 统计。

三个接口成功传输时返回 HTTP `200` 与批次报告，应用结果须读取报告，不由 HTTP 状态码推断：

| 响应字段 | 说明 |
|----------|------|
| `batchId` / `status` / `reasons` | 批次身份、`queued/running/completed/partial/blocked/cancelled/failed` 与有界原因列表 |
| `usage` | 累计 `records/files/bytes/llmCalls/inputTokens/outputTokens/durationMs`，包含显式恢复的多个执行段；应用层预算计量，不是精确数据库 I/O |
| `usageAccounting` / `segment` | 前者为 `budget_reservation`；可选 segment 包含当前 `attempt` 和该段 `usage`，不替代 batch 累计量 |
| `counts` | `proposed/applied/rejected/review/noop/skipped`；提案数不是新增 canonical 数 |
| `checkpoint` | `cursor` 为 null 或哈希摘要，可带 `selectionEpoch`；不是客户端可恢复的目录游标，不暴露内部路径/upperKey |
| `configFingerprint` | host 冻结后的配置指纹，不包含凭据 |
| `resumable` | 是否可尝试恢复，不代表跳过配置、租约、审阅或撤销校验 |
| `work` | 可选，kind 为 memory_evolution/source_reconcile/source_revoke/undo_governance；控制 result 为下述有限提交信息，不返回来源正文 |

显式 resume 沿用原请求限额开启有限 segment，累计 usage 不清零；后台 retry 不重置限额。`propose` 的证据与候选隔离，不改变当前 head/confidence 或正常召回；`apply_allowed` 仍需来源复核、目标 CAS、确定性 validator 与原子 receipt。普通候选审核拒绝进化候选，以下专用审阅也不能绕过这些门禁。

resume body 仍只有 batchId。控制批次恢复要求独立 owner；REST 或精确 `memory_evolution_resume` MCP 调用携带 `x-mengshu-owner-token` 时严格认证并传递 owner 上下文。无 header 保留普通批次恢复兼容，但不能恢复控制批次；错误、重复或数组形式的 owner header 被拒绝，不按普通请求降级。SDK/CLI 可转发已配置的 owner 凭据，普通 run 不因此获得 owner 上下文。

传输错误：无 capability/未知路由或当前 scope 内批次不存在为 `404`，不支持的方法为 `405`；非法请求为 `400`、`{ "error": "EVOLUTION_REQUEST_INVALID" }`，批次不存在使用 `EVOLUTION_BATCH_NOT_FOUND`，配置指纹变化为 `409`、`EVOLUTION_CONFIG_CHANGED`，未处理执行错误为 `500`、`EVOLUTION_OPERATION_FAILED`。通用认证及 host readiness 错误仍遵守本页原合同；已返回报告的 blocked/partial/failed 不等同于传输失败。

### 进化提案与 Owner 审阅

以下路由只接受 POST，并额外要求 `x-mengshu-owner-token` 匹配可信配置中的 `evolution.control.ownerSecret`；普通 `server.secret` bearer、loopback 和来源标签均不能替代。凭据不放入 body。MCP proxy 仅在 owner 认证后列出对应工具，普通客户端不能让模型自行发现并批准提案。

| REST 后缀（`/v1/evolution/`） | MCP | 请求 |
|--------------------------------|-----|------|
| `review/list` | `memory_evolution_review_list` | 可选 batchId/status/limit/cursor，空对象合法 |
| `review/detail` | `memory_evolution_review_detail` | 仅 proposalId |
| `review/preview` | `memory_evolution_review_preview` | 仅 proposalId；重读来源/目标后生成审阅项 |
| `review/status` | `memory_evolution_review_status` | 仅 reviewId |
| `review/decide` | `memory_evolution_review_decide` | reviewId、expectedBindingHash、decision、idempotencyKey，可选 reason |
| `review/apply` | `memory_evolution_review_apply` | 仅 approvalReceiptId，必须来自 approve 回执 |
| `cancel` | `memory_evolution_cancel` | 仅 batchId |

list 与 decide 请求体各自上限 4096 字节，拒绝未知字段。list 默认 20、limit 为 1-50；status 为 `staged/rejected/review/applied/noop`，cursor 最长 1024 字符，只回传 host 的 nextCursor。list 的 batchId、decide 的 reviewId/idempotencyKey 为 1-256 字符安全标识；单 ID 路由为 1-128 字符。CLI 对标识额外收窄到 128 字符。

先发现提案，再读取 detail 与 preview。以下是 list 的请求示例：

```json
{ "status": "review", "limit": 20 }
```

decide 的 `decision` 为 `approve` 或 `reject`，`expectedBindingHash` 必须为 preview 返回的 64 位小写十六进制值；`reason` 若提供为 1-512 字符。同一决定重试保留幂等键，不把旧绑定用于新提案或新目标状态。

| 响应 | 关键内容 |
|------|----------|
| list | proposals 摘要含 id/batchId/status/operation、验证原因及审阅要求；可选 nextCursor，无来源正文或路径 |
| detail | 摘要、提案、必要 evidence 与可选 review 回执摘要；不是任意源文件读取 |
| preview/status | id、proposalId、bindingHash、status、createdAt/expiresAt、精确 proposal/targets/evidence；targets 和 evidence 各最多 8 项，整体不超过 128000 字节，超限拒绝而非截断 diff |
| decide | decision receipt 的 id/reviewId/bindingHash/decision/decidedAt/expiresAt，可选 reason；不是写入 receipt |
| apply/cancel | 批次报告；apply 经 durable worker 重验后执行，cancel 不撤销已提交版本 |

认证不满足为 `403 EVOLUTION_OWNER_REQUIRED`；能力缺失为 `404 EVOLUTION_CONTROL_UNAVAILABLE`；提案或审阅不存在分别为 `EVOLUTION_PROPOSAL_NOT_FOUND`、`EVOLUTION_REVIEW_NOT_FOUND`。非法请求为 `400 EVOLUTION_REQUEST_INVALID`；绑定/有效期/状态等治理冲突为 `409 EVOLUTION_*`；过大审阅响应为 `500 EVOLUTION_REVIEW_LIMIT_EXCEEDED`。HTTP 200 与 approve 都不保证后续 apply 成功。

默认目录入口已有 provider-owned related-target 查找，但来源关联不授予修改权。提案持久定位已接入新 reader 实例的精确来源重读，有定位时复核失败不退回全树扫描或信任 staged quote；单条重读不确认整页 manifest，也不证明实际系统恢复演练已完成。来源、复用与治理使用下述专用控制面，没有任意 host-state put。

### 来源证明控制

仅 POST，要求对应 sourceControl capability 和独立 `x-mengshu-owner-token`；MCP proxy 使用相同认证门。顶层及嵌套对象拒绝未知字段，每个请求上限 16384 字节。attest 接收已签名声明，不用 owner 凭据替代作者签名，也不在服务端凭来源标签生成证明。

| REST（`/v1/evolution/` 后缀） | MCP | 请求 |
|----------------------------|-----|------|
| `source/attest` | `memory_evolution_source_attest` | statement、signature、expectedRevision、idempotencyKey |
| `source/revoke-attestation` | `memory_evolution_source_revoke_attestation` | sourceId、sourceRevision、expectedRevision、idempotencyKey、operationIdempotencyKey、expiresAt |

attest 的 `statement` 合同如下；除标为可选的字段外均必填：

| 字段 | 合同 |
|------|------|
| `issuer` | host allowlist 中的 Ed25519 issuer ID |
| `scopeFingerprint` | 当前 host scope 的 64 位小写十六进制指纹；用于精确核验，不改变 scope |
| `evidenceId/sourceId/revision/rootEvidenceId` | 原始证据、来源修订与独立证据根身份，不由审阅决定或内容标签伪造 |
| `snapshotHash` | 来源快照 SHA-256，64 位小写十六进制 |
| `origin` / `trust` | origin 仅 `external`；trust 为 `user_statement/verified_document/verified_result`，仍须有效签名及来源匹配 |
| `authorId` / `occurredAt` | 可选作者 ID / Unix 毫秒时间；trust 为 user_statement 时 host 要求 authorId |
| `authorizedTargetRefs` | 必填数组，最多 8 项；每项 memoryId、expectedRevision、beforeHash；目标 ID 不重复，beforeHash 为 64 位小写十六进制 |
| `issuedAt/expiresAt` | Unix 毫秒整数；签发不得在未来、不得过期，期限最多 365 天 |

`signature` 为 86 字符无填充 base64url，host 实际核验 Ed25519 签名。控制标识使用 1-256 字符安全 ID（首字符字母/数字，其余为字母/数字及 `._:-`）；`expectedRevision` 为非负安全整数 CAS，不是来源 revision。时间同样须为非负安全整数。撤销请求的 `operationIdempotencyKey` 绑定行政操作，`idempotencyKey` 标识此次状态写入；`expiresAt` 为撤销状态期限，不是正文 TTL。

返回 `{ id, kind, entryId, operation, revision, valueHash, createdAt }` 来源信任回执，不返回全文或密钥。默认 writer 在提交事务内锁定复核证明和撤销状态，并计入输入预算；签名有效也不能绕过原文复核、目标 CAS 或确定性 validator。撤销 attestation 不等于现有 canonical evidence/links 已退役：其 kind=source_revocation、operation=put 回执可为下述 source_revoke 批次提供精确行政批准，canonical 提交仍另需操作 receipt，更不等于物理删除。

无 owner 为 `403 EVOLUTION_OWNER_REQUIRED`，缺子 capability 为 `404 EVOLUTION_CONTROL_UNAVAILABLE`，非法请求为 `400 EVOLUTION_REQUEST_INVALID`。签名、绑定、期限、状态等领域冲突返回 `409 EVOLUTION_*`；未处理执行错误为 `500 EVOLUTION_OPERATION_FAILED`。没有公共 generic state put；精确 undo 仅使用下述专用合同。

### 治理控制批次

以下三条路由仅 POST，要求 control capability 及独立 owner 认证。默认 native Runtime 已将其接入 provider-owned 治理端口；run 经原 durable 队列、lease、执行段身份与后台 allowlist，不是 HTTP 请求内的直接 SQL 写入。自动维护不发起这些操作，也不需要模型调用。

| REST（`/v1/evolution/` 后缀） | MCP | 请求 |
|----------------------------|-----|------|
| `control/run` | `memory_evolution_control_run` | input、action、idempotencyKey，可选 limits；16384 字节上限 |
| `control/undo-preview` | `memory_evolution_control_undo_preview` | 仅 operationReceiptId；4096 字节上限 |
| `control/undo-approve` | `memory_evolution_control_undo_approve` | operationReceiptId、currentStateHash、expectedRevision、idempotencyKey、operationIdempotencyKey、expiresAt；4096 字节上限 |

所有对象拒绝未知字段。MCP proxy 仅向独立 owner 注册这三条工具，直接 stdio 不暴露它们；没有通用 host state、handler、路径或 authority 输入。

control/run 的 `input` 只包含 `mode: "control"` 和 `work`，`action` 必须为 `execute_control`，不接受 preview/propose 或模型参数。work 合同如下，除 kind 外所列字段均必填：

| work.kind | 字段及绑定 |
|-----------|------------|
| `source_reconcile` | sourceId，当前 host 精确 scope 内已注册来源 |
| `source_revoke` | sourceId、expectedRevision、reviewReceiptId；expectedRevision 是原批准的 sourceRevision 字符串，不是 host 状态的整数 CAS |
| `undo_governance` | operationReceiptId、currentStateHash、reviewReceiptId；前两者必须原样来自当前 undo-preview |

sourceId 为 1-128 字符，首字符字母/数字，其余仅字母/数字及 `._-`。source revision、reviewReceiptId、两种幂等键为 1-256 字符安全 ID，允许 `._:-`；operationReceiptId/currentStateHash 为 64 位小写十六进制。批次 idempotencyKey 重试必须保持原请求，不得更换 work 或预算。

`limits` 只接受以下整数；不能传 maxLlmCalls/maxInputTokens/maxOutputTokens，即使值为零，内部会统一补为零：

| 限额 | 默认值 | 范围/归一化 |
|------|--------|-------------|
| `maxRecords` | 100 | 1-1000 |
| `maxFiles` | source_reconcile 为 20，另两种为 0 | source_reconcile 为 1-200；另两种接受 0-200 但统一归零 |
| `maxBytes` | 1000000 | 1-10000000 |
| `maxDurationMs` | 120000 | 1-600000 |

扫描、复核、manifest 与有界 SQL 共享 I/O 限额，极小值可能在执行时阻断；parser 接受不是完成保证。以下 JSON 仅展示结构，来源、回执、hash、幂等键及时间均为合成示例，不构成可执行批准或生产操作授权。

来源对账请求：

```json
{
  "input": { "mode": "control", "work": { "kind": "source_reconcile", "sourceId": "project-notes" } },
  "action": "execute_control",
  "limits": { "maxRecords": 100, "maxFiles": 20, "maxBytes": 1000000, "maxDurationMs": 120000 },
  "idempotencyKey": "source-reconcile-demo-001"
}
```

canonical 支持关系撤销分两步：先调用 source/revoke-attestation，绑定 sourceId、sourceRevision、operationIdempotencyKey 及有效期，再提交 source_revoke。批次 work.expectedRevision 必须等于批准的 sourceRevision，reviewReceiptId 使用该响应的 id，批次 idempotencyKey 必须等于批准的 operationIdempotencyKey；状态写入本身的 idempotencyKey 是另一用途。仅完成第一步不能声称 canonical 已撤销。

```json
{
  "input": { "mode": "control", "work": {
    "kind": "source_revoke", "sourceId": "project-notes", "expectedRevision": "source-revision-demo-001",
    "reviewReceiptId": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
  } },
  "action": "execute_control",
  "limits": { "maxFiles": 0 },
  "idempotencyKey": "source-revoke-demo-001"
}
```

精确 undo 分为 preview、approve、control/run 三步，仅支持原操作 `mark_disputed/revalidate/add_evidence/merge_equivalent`，不是通用历史 rollback 或 canonical 正文覆盖。preview 不写状态，返回 operationReceiptId、operation、最多 8 个 memoryIds 和 currentStateHash；目标已漂移时必须重新预览，不能沿用旧批准。

```json
{ "operationReceiptId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }
```

approve 会重读当前状态并比较 hash，再写 kind=governance_undo 的行政状态。expectedRevision 为该行政状态的非负安全整数 CAS（新建为 0），不是来源 revision 或记忆版本。两个幂等键用途分别为本次批准写入、之后的撤销批次；expiresAt 为非负安全整数 Unix 毫秒，实际必须晚于 host 当前时间且不超过 24 小时。示例时间须按实际期限替换。

```json
{
  "operationReceiptId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "currentStateHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "expectedRevision": 0,
  "idempotencyKey": "undo-approval-demo-001",
  "operationIdempotencyKey": "undo-execute-demo-001",
  "expiresAt": 1788739200000
}
```

approve 返回 `{ id, kind, entryId, operation, revision, valueHash, createdAt }`，其中 kind=governance_undo、operation=put；它不是撤销完成证明。把此 id 作为 reviewReceiptId，与相同 operationReceiptId/currentStateHash 及绑定的操作幂等键提交：

```json
{
  "input": { "mode": "control", "work": {
    "kind": "undo_governance",
    "operationReceiptId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "currentStateHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "reviewReceiptId": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
  } },
  "action": "execute_control",
  "idempotencyKey": "undo-execute-demo-001"
}
```

执行事务仍复核 lease、当前状态、批准有效期与消费绑定；不能把另一来源/版本/操作幂等键的批准用于本次请求。批次 status/resume 沿用原接口，控制批次恢复必须有 owner，不能通过 resume 重新批准或换请求。

run 返回批次报告，`work.kind` 为上述三种工作；可选 `work.result` 上限 32768 字节，只含 status（completed/partial）、receiptId，以及可选 affectedMemoryIds（最多 256 项）、sourceManifestConfirmed、sourceSnapshotHash、reasons（最多 16 项）。未知影响不补成空数组，不按 counts.applied 推断记忆总数。usageAccounting 仍为 budget_reservation，不是实际账单。

source_reconcile 在扫描不完整时可返回 partial/source_scan_partial；数据库已提交但 manifest 确认失败时，可返回 partial/source_manifest_confirmation_failed，并保留 receiptId、sourceManifestConfirmed=false。有 receipt 表示可能已有部分治理提交，不能声称完全未写或全量对账完成。

无 owner、缺 capability、非法请求分别为 `403 EVOLUTION_OWNER_REQUIRED`、`404 EVOLUTION_CONTROL_UNAVAILABLE`、`400 EVOLUTION_REQUEST_INVALID`。准备/预览/批准的状态或绑定冲突为 `409 EVOLUTION_*`，未处理执行错误为 `500 EVOLUTION_OPERATION_FAILED`；入队后的失败、阻断和部分提交通过批次报告表达。默认接线及接口验证不等于完整原生 PostgreSQL、读取/缓存传播或生产效果验收。

### 受控复用与配对评测

以下仅 POST，要求 reuse capability 和独立 owner 认证；全部请求拒绝未知字段且上限 16384 字节。默认 Runtime 已装配候选/hydration、MemoryService、引用/缓存重验与 Skill target gate，但未授予默认跨 app 共享。

| REST（`/v1/evolution/` 后缀） | MCP | 请求/响应 |
|----------------------------|-----|-----------|
| `reuse/status` | `memory_evolution_reuse_status` | 仅 `{}`；返回可选 targetFingerprint、grantsRevision、grantIds |
| `reuse/grants` | `memory_evolution_reuse_grants` | grants、expectedRevision、idempotencyKey；返回 receiptId、revision、valueHash |
| `reuse/evaluate` | `memory_evolution_reuse_evaluate` | 仅 planId；返回 blocked/rejected 或 accepted_for_review，不发布/执行 |

`grants` 是完整替换而非追加，空数组明确清空；最多 32 项且 ID 唯一。`expectedRevision` 使用当前 grantsRevision（初始为 0），idempotencyKey 与 grant id 遵循 1-256 字符安全 ID 合同。每项 grant 必含：

| 字段 | 合同 |
|------|------|
| `id` | 唯一授权标识 |
| `source` | appId、projectId、agentId、namespace、visibility 全部必填；visibility 仅 private/workspace，其余为 1-256 字符且无空白/控制字符 |
| `claimKinds` | 1-11 个不重复值：preference、decision、entity、fact、task、plan、goal、document、knowledge、observation、other |
| `notBefore/expiresAt` | 每项最多 32 字符，必须为规范 UTC ISO 时间（如 YYYY-MM-DDTHH:mm:ss.sssZ）；expiresAt 必须晚于 notBefore |

目标 scope 取当前 host，source 由同 owner authority 解析并收窄，不接受 tenantId/userId、目标 scope 或额外 authority。grant 不绕过生命周期、目标模型/工具兼容性、适用范围、有效期、撤销及引用缓存门禁；status 列表也不是每条 grant 当前有效的证明。

evaluate 请求示例中的 ID 只是格式示意，必须替换为 host 已注册的实际 planId；请求不上传文件、holdout、模型或期望成功值：

```json
{ "planId": "fact-selection-demo-v1" }
```

planId 为 1-128 字符安全 ID。计划与 holdout 由可信 `evolution.reuse.evaluations` 绑定绝对路径和文件 hash，只有显式调用才读取和运行，详见[配置](../guides/configuration.md#复用目标配置)。当前 evaluator 仅支持 `synthetic:fact-selection-v1`，用模型实际输出作配对评分；不支持泛化任意 Skill 行为验收。缺注册计划、模型、资源依赖 reader 或有效证明时 blocked。完整默认配置到配对正例及目标执行绑定仍在工程验证中，不能把接口存在或静态 profile 当作通过。

`accepted_for_review` 返回有界 validation（subject、evaluatorId、reviewReceiptId、planHash/reportHash、targetFingerprint、holdoutRef、validatedAt、quality、criticalSubclasses、costReduction），始终 `publishAllowed=false/executionAllowed=false`。单用 holdout、artifact/目标指纹、期限及撤销共同限制回执资格；不是正式 G/P 或生产效果结论，也不补齐完整 E3 所缺的原生独立 outcome 经验来源。

无 owner/缺能力/非法请求分别为 403/404/400；非法来源授权为 `400 EVOLUTION_REUSE_GRANT_INVALID`，状态冲突为 `409 EVOLUTION_REUSE_STATE_REJECTED`。HTTP 200 中的 blocked/rejected 仍是失败门禁，不当作评测通过。

### 后台运行门

`GET /v1/runtime/background` 返回 `mode/allowedBatchIds/revision/active/state`。`state` 为 `enabled/paused/controlled/draining`。`POST` 使用独立 owner 凭据和当前 revision：

```json
{
  "mode": "paused",
  "allowedBatchIds": [],
  "expectedRevision": "00000000-0000-4000-8000-000000000001"
}
```

示例 revision 是格式占位，操作时必须换成 GET 响应值。`mode` 为 `all/paused/evolution_only`；all/paused 不允许非空白名单，evolution_only 要求 1-100 个不重复的安全 batch ID，并核验当前 scope 对应执行段。该门控制同一 host 的后台 worker/维护循环，不是数据库只读开关，不禁止显式前台写入。

模式切换会请求取消活跃工作；`draining` 期间仍需等 `active=0`，并以提交 receipt 判定结果，不能假定事务即时中断。更新只改变本次 host 状态，不修改启动配置；重启后使用启动配置及新 revision。

无 capability 为 404，非法配置/revision 为 `400 BACKGROUND_CONFIG_INVALID/BACKGROUND_REVISION_INVALID`，并发 revision 或状态冲突为 `409 BACKGROUND_*`；无 owner 认证为 403，控制服务异常为 `503 BACKGROUND_CONTROL_UNAVAILABLE`。

### 低频维护状态

`GET /v1/runtime/maintenance` 只读快照，遵守通用 host 访问认证，不要求额外 ownerToken。响应为 `enabled/status/reasons/updatedAt/budgetReserved/localFreeBytes/databaseFreeBytes`，可含 batchId/jobId；无能力 404，其他方法 405。它不触发维护、修改预算或证明 cleanup/结算完成。

默认 driver 复用原 scheduler idle、批次准入和 maintenance 批次释放租约前 retention，缺省关闭、自动仅 `due + propose`。`paused/evolution_only`、前台忙/静默不足、未知价格、预算不足和空间缺失/不足均阻止自动维护。当前 `databaseFreeBytes=null`，本地 `localFreeBytes` 不能替代 PG backing-store 剩余量，因此不能由 `enabled=true` 推导自动维护已可运行。快照未必反映最新外部状态，检查 updatedAt/reasons，后台 worker 会在准入时再校验。

## MCP facade

[packages/mcp/src/tools.ts](../../packages/mcp/src/tools.ts) 根据 RuntimeHost 当前 capability 构造工具表，[packages/mcp/src/runtime-client-proxy.ts](../../packages/mcp/src/runtime-client-proxy.ts) 把该工具表桥接到 stdio MCP。不存在的 capability 不注册空壳工具。

### 基础与快路径

| 工具组 | MCP tools |
|--------|-----------|
| 基础 | `memory_save`、`memory_recall`、`memory_context`、`memory_observe`、`memory_ingest`、`memory_namespaces`、`memory_health` |
| 受权删除 | `memory_forget`（只有 authority-scoped forget capability 存在时注册） |
| Agent fast path | `memory_context_fast`、`memory_observe_light`、`memory_lookup` |
| 渐进披露 | `memory_navigate`、`memory_evidence_read` |

### 增量能力工具

| Capability | MCP tools |
|------------|-----------|
| Working Set | `memory_working_set_ingest`、`outline`、`assemble`、`payload_read`、`explain`、`close`、`promote` |
| Temporal | `memory_history`、`memory_recall_as_of`、`memory_expire`、`memory_revoke`、`memory_purge`、`memory_evolve`、`memory_correct`、`memory_restore` |
| Policy | `memory_policy_append`、`memory_policy_resolve` |
| Knowledge | `memory_knowledge_search`、`memory_knowledge_read` |
| Asset | `memory_asset_list`、`memory_asset_read`、`memory_asset_search`、`memory_asset_explain` |
| Session receipt | `memory_session_explain` |

Temporal 写入要求 lineage CAS、evidence 和 idempotency key；`memory_purge` 还要求显式 `PURGE` confirmation。Knowledge 工具只读 revision-pinned 内容。Asset 与 session receipt 使用 exact private scope，不能由客户端扩大 authority。

### memory_ingest 用法

注入 `pipeline`（`runtime.ingestionPipeline`）后启用。入参：

| 字段 | 类型 | 说明 |
|------|------|------|
| `source` | string（必填） | `sourceType=text` 时为原始文本；`sourceType=file` 时为本地文件路径 |
| `sourceType` | `"text" \| "file"` | 解释 `source` 的方式，默认 `text` |
| `scope` | object | 记忆作用域；未传字段回落 MCP server 配置的 `defaultScope` |
| `dryRun` | boolean | 为 true 时只返回 chunk 预览（`chunkCount`），不持久化 |
| `chunkSize` | number | 可选最大 chunk 字符数 |
| `sourceId` | string | 可选稳定来源标识 |

```jsonc
// 摄入原始文本
{ "source": "项目使用 pnpm workspaces", "sourceType": "text",
  "scope": { "appId": "mengshu", "projectId": "proj-1" } }
// → { "documentId": "doc:...", "chunksAdmitted": 1, "chunksDropped": 0, "jobsQueued": 1 }

// 摄入本地文件（仅允许 .txt/.md/.json）
{ "source": "/abs/path/notes.md", "sourceType": "file" }

// 预览切分，不落库
{ "source": "long body...", "dryRun": true }
// → { "dryRun": true, "chunkCount": 3 }
```

安全边界：`sourceType=file` 经 `loadFileContent` 校验——拒绝含 `..` 的路径遍历、限制扩展名白名单（.txt/.md/.json）、校验文件存在；摄入内容统一加 `[untrusted-source]` 注入防护 header。


## JavaScript SDK

SDK 位于 `packages/api/src/sdk/`，通过 REST API 访问 MemoryService。不依赖 OpenClaw，也不直接访问本地数据库。`adapters/sdk/` 与 `sdk/js/` 保留为旧 deep import 的兼容 re-export。

### 初始化

```typescript
import { MemoryClient, MemoryClientError } from "@mengshu/core/api";

const client = new MemoryClient({
  baseUrl: "http://127.0.0.1:3847",
  token: "your-server-secret",  // 可选，与 server.secret 对应
  timeoutMs: 30_000,            // 可选，默认 30s
});
```

### 方法列表

| 方法 | 对应端点 | 说明 |
|------|----------|------|
| `client.health()` | `GET /v1/health` | 返回 `HealthSnapshot` |
| `client.storeMemory(input)` | `POST /v1/memories` | 写入记忆，返回 `StoreMemoryResult` |
| `client.recall(input)` | `POST /v1/recall` | 召回记忆，返回 `RecallResult` |
| `client.buildContext(input)` | `POST /v1/context` | 打包 prompt-safe context，返回 `ContextBlock` |
| `client.evolveMemory(input)` | `POST /v1/evolution/run` | 提交 `EvolutionRunRequest`，返回批次报告 |
| `client.evolutionStatus(batchId)` | `POST /v1/evolution/status` | 查询当前 host scope 内的批次 |
| `client.resumeEvolution(batchId)` | `POST /v1/evolution/resume` | 显式有限恢复；转发可选 ownerToken，控制批次必须有 owner |
| `client.runEvolutionControl(input)` | `POST /v1/evolution/control/run` | owner 提交三种封闭治理工作之一，返回批次报告 |
| `client.previewEvolutionUndo(operationReceiptId)` | `POST /v1/evolution/control/undo-preview` | owner 读取可撤销操作的当前状态 hash |
| `client.approveEvolutionUndo(input)` | `POST /v1/evolution/control/undo-approve` | owner 批准精确状态，返回行政回执，不执行撤销 |
| `client.listEvolutionProposals(input?)` | `POST /v1/evolution/review/list` | owner 有界提案摘要列表 |
| `client.evolutionProposalDetail(proposalId)` | `POST /v1/evolution/review/detail` | owner 提案及必要证据详情 |
| `client.previewEvolutionReview(proposalId)` | `POST /v1/evolution/review/preview` | owner 重读并创建精确审阅 |
| `client.evolutionReviewStatus(reviewId)` | `POST /v1/evolution/review/status` | owner 审阅状态 |
| `client.decideEvolutionReview(input)` | `POST /v1/evolution/review/decide` | owner approve/reject，返回决定回执 |
| `client.applyEvolutionReview(approvalReceiptId)` | `POST /v1/evolution/review/apply` | owner 准备受控应用，返回批次报告 |
| `client.cancelEvolution(batchId)` | `POST /v1/evolution/cancel` | owner 请求取消 |
| `client.attestEvolutionSource(input)` | `POST /v1/evolution/source/attest` | owner 提交 issuer 已签名的精确声明 |
| `client.revokeEvolutionSourceAttestation(input)` | `POST /v1/evolution/source/revoke-attestation` | owner 撤销来源信任，不删除 canonical 支持关系 |
| `client.evolutionReuseStatus()` | `POST /v1/evolution/reuse/status` | owner 查询目标指纹与授权 revision/ID |
| `client.replaceEvolutionReuseGrants(input)` | `POST /v1/evolution/reuse/grants` | owner 以 CAS 完整替换同 owner 来源授权 |
| `client.evaluateEvolutionReuse(planId)` | `POST /v1/evolution/reuse/evaluate` | owner 显式评测已注册计划，仍 suggest-only |
| `client.backgroundWorkStatus()` | `GET /v1/runtime/background` | 读取后台状态 |
| `client.updateBackgroundWork(input)` | `POST /v1/runtime/background` | owner 凭当前 revision 更新后台门 |

操作者客户端可在构造参数中单独提供 `ownerToken`；SDK 对 owner 方法及 resume 转发已配置的 `x-mengshu-owner-token`，不会用普通 `token` 代替，普通 run/status 不携带 ownerToken。未配置 ownerToken 时普通批次恢复仍可用，控制批次恢复由服务端拒绝；带 owner 的请求禁止重定向。是否提供服务仍取决于 host capability。

### 错误处理

SDK 抛出 `MemoryClientError`：

```typescript
try {
  await client.recall({ query: "test" });
} catch (e) {
  if (e instanceof MemoryClientError) {
    console.error(e.status, e.code, e.message);
  }
}
```

| 属性 | 类型 | 说明 |
|------|------|------|
| `status` | `number?` | HTTP 状态码 |
| `code` | `string?` | 错误代码：`timeout`、`request_failed` |
| `body` | `unknown?` | 原始响应体 |

## CLI 命令总览

CLI 入口为 `ms`（全局安装后可用），命令注册在 `bin/ms.ts`。

| 命令 | 说明 |
|------|------|
| `ms` (无参数) | 首次使用完成 setup 后退出；已有配置时启动 MCP stdio server |
| `ms setup` | 交互式初始化全局模型与存储配置 |
| `ms init [dir]` | 初始化产品无关的 Project Memory Workspace，不要求 authority |
| `ms stats` | 显示记忆统计（总数、memories、documents、表级统计） |
| `ms search <query>` | 搜索记忆（支持 `--limit`、`--min-score`） |
| `ms doctor` | 诊断配置和服务健康状态 |
| `ms mcp` | MCP 相关子命令 |
| `ms serve` | 启动 REST server |
| `ms project` | 项目级操作 |
| `ms why <query>` | 解释为什么某条记忆被召回 |
| `ms forget` | 交互式删除记忆 |
| `ms recall <query>` | 快速召回并显示结果 |
| `ms migrate-home` | 迁移旧版 home 目录到新路径 |
| `ms migrate-semantic-types` | 以 dry-run 优先的漏斗迁移整理历史 5 type |
| `ms asset list/explain` | 查看当前 exact scope 的 private 治理资产 |
| `ms asset deprecate/revoke` | 以 CAS、幂等 receipt 和 outbox 追加资产状态版本 |
| `ms session explain <sessionId>` | 读取 PostgreSQL v22 中当前 exact private session 的最新装配 receipt |
| `ms evolve` | host-bound 批次、owner 审阅、来源/复用控制与后台状态；默认预览，专用控制命令及独立认证要求见 [CLI](cli-commands.md#来源与复用控制) |

## 错误格式

OpenClaw 工具返回 tool content 文本；REST API 返回 JSON：

```json
{
  "error": "query is required"
}
```

常见 HTTP 状态：

| 状态码 | 说明 |
|--------|------|
| `400` | 请求体缺失或字段类型错误 |
| `401` | Bearer token 缺失或不匹配 |
| `403` | 非 loopback、非 HTTPS 或路径访问被拒绝 |
| `404` | 路由不存在或可选模块未注入 |
| `405` | HTTP 方法不允许 |
| `500` | 服务内部错误 |
| `503` | RuntimeHost 尚未 ready 或控制面不可用 |

**最后更新**：2026-09-06（持续进化控制面与默认组装边界）
