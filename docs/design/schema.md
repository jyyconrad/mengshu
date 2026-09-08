# 数据库 Schema

本文区分两层 schema：已经由 legacy provider 使用的 `memories` / `knowledge` 表，以及 v4 中间件的结构化 schema 草案。

PostgreSQL 实际结构以 [migration registry](../../packages/core/src/db/migrations/schema-migrations.ts) 为准。下述 v36/v37 为持续进化的批次和治理数据合同；后文 legacy/v4 SQL 不可作为当前库的完整建库或迁移脚本。部署库是否具备相应版本须核对其 ledger，文档中的版本号不表示已执行生产迁移。

## v36 持续记忆进化

`add-memory-evolution-batches` 为 additive migration，复用既有候选区与治理写入链，不创建完整会话副本库。

| 表/存储位置 | 身份与约束 | 内容 |
|-------------|------------|------|
| `mengshu_evolution_batches` | 主键 `(scope_fingerprint, id)`；同 scope 的 `idempotency_key` 唯一；版本 CAS、lease owner、fencing token、到期时间 | 有界请求、配置指纹、checkpoint、状态与累计/segment usage；JSON body 上限 262144 字节，不保存输入全文 |
| `mengshu_evolution_apply_receipts` | 主键 `(scope_fingerprint, proposal_id)`；外键指向同 scope batch | 不可变的 applied/noop 提交证明与 request hash；receipt JSON 上限 16384 字节，不保存来源正文 |
| `mengshu_evolution_processed_inputs` | 主键 `(scope_fingerprint, input_fingerprint, action)`；action 为 `propose/apply_allowed` | 每个处理指纹和动作的一条结果指针，不是逐轮扫描日志，不保存正文 |
| `mengshu_candidates.metadata.evolution` | 使用既有 exact-scope 候选身份 | 提案、必要 staged quote/span、来源指纹与 `expiresAt`，不作为有效 canonical support |

候选 metadata/body 受 repository 的 256 KiB JSON 限制，单 quote 最长 8192 字符。staged TTL 默认 7 天，repository 上限 30 天；不是 `evolution.sources` 的可配置字段。过期提案不能应用，TTL 字段不等于自动删除任务。默认 Runtime 已接入 maintenance 批次释放租约前的有界 retention，但维护缺省关闭，当前 PG 剩余空间未知会阻止自动准入，不能据此推断清理已经发生。apply receipt 不随提案到期自动消失，避免清理候选后失去幂等真源。

v36 同时增加进化候选 batch 查询索引和库存 keyset 索引。baseline 使用 `(created_at, id)` 全序与冻结上界；这些索引不提供 changed outbox 或 due 复核水位。

库存计量包含 lookahead 与原始证据返回行，`maxBytes` 按有界 SQL 行结果的 JSON 序列化大小做读后检查；索引、行数边界和该预算不构成数据库磁盘/网络硬配额，batch usage 也不是 provider 精确 I/O 统计。

治理控制复用同一 batch 存储、durable job 与 lease，不新增另一套队列或迁移版本。请求以 `input.mode=control/action=execute_control` 绑定三种 work（source_reconcile/source_revoke/undo_governance）、幂等键和 request hash；公开请求只有四项 I/O 限额，持久化时三项模型预算固定为零，恢复时重新核验并要求 owner。报告的 work.kind/有限 result 与 usageAccounting=budget_reservation 不构成精确数据库 I/O 或计费账单。

目录输入的 related targets 由 native provider 根据有效来源关联或精确 hash 发现，不生成作者证明或目标修改权。提案可选 `directoryLocator` 保存来源配置指纹、受限相对路径、文件快照与片段定位，不保存全文或信任声明；持久 envelope 保留定位并纳入 request hash，新 reader 实例在原 binding 内精确重读，有定位时失败不退回扫描或信任 staged quote。单条重读不确认整页 manifest，这也不是实际系统恢复演练的证明。

`propose` 不修改 canonical head、confidence、有效 evidence links 或正常 lookup/context。普通候选批准/晋升拒绝带进化标记的候选。受控应用需要在 provider-owned 事务中核验 lease、目标 CAS、撤销状态、来源有效性，并提交对应治理数据与 receipt；默认 Runtime 已接入预算约束下的 host attestation 及同事务撤销复核，不仅在提案读取时验签。来源 manifest 只能在数据库提交证明之后推进。

物化 raw evidence、迁移成功或取得数据库 receipt 都不单独证明内容作者/目标授权。未持有可靠证明的 legacy raw evidence 与目录证据按 untrusted 处理；专用 owner 审阅不会把原始作者改成可信主体。内容变更仍要求来源、授权、撤销与 writer 的事务门禁，不能靠改 metadata 或普通候选批准绕过。

源不可用与显式遗忘不同，来源变化检测不代表旧支持关系已自动退役。读取和保留边界见[持续记忆进化指南](../guides/continuous-memory-evolution.md)。

## v37 治理与宿主状态

`add-evolution-governance-and-maintenance` 为追加扩展，不重写 v36 迁移。以下表格概括数据库约束，应用层可以进一步收窄大小和有效期：

| 表/扩展 | 关键合同 |
|---------|----------|
| `mengshu_evolution_reviews` | `(scope_fingerprint, review_id)` 主键；绑定 proposal/request/binding hash；保存 reviewer、approve/reject、expiry、撤销和消费状态；review JSON 最大 196608 字节、receipt 最大 32768 字节；同 scope/proposal 同时只允许一个未撤销决定 |
| `memories` | 增加 `evolution_review_due_at`、`evolution_disputed`、`evolution_alias_of` 及 due 索引；标记不代替读端生命周期/风险/授权检查 |
| `mengshu_write_outbox` / `mengshu_memory_version_outbox` | 增加 `evolution_consumed_at`、`evolution_origin` 和未消费外部事件索引；进化自身事件不作为外部 changed 输入 |
| `mengshu_memory_evidence_links` | 增加 relation_state、独立证据根、source/revision/hash、文件/片段/continuity 身份及 retired_at；保留来源与支持关系追溯 |
| `mengshu_evolution_source_dispositions` | `(scope_fingerprint, source_id, logical_file_id)` 主键；current/unavailable/superseded/revoked 与精确 revision/hash、治理 receipt |
| `mengshu_evolution_operation_receipts` | `(scope_fingerprint, idempotency_key)` 主键；request hash、operation、最大 32768 字节 receipt；不同于内容 apply receipt |
| `mengshu_evolution_budget_reservations` | `(owner_key, day_key, reservation_id)` 主键，跨 batch/scope 共享 owner/day 预算；记录 reserved/actual token、cost_micros 及 reserved/settled/released 状态；未知金额不能当成零成本 |
| `mengshu_evolution_host_state` | `(owner_key, scope_fingerprint, kind, entry_id)` 主键；revision CAS、value hash、expiry/revocation；value 最大 32768 字节，不存凭据、私钥或完整历史库 |
| `mengshu_evolution_host_receipts` | `(owner_key, scope_fingerprint, kind, idempotency_key)` 主键；同 scope receipt ID 唯一；request hash、最大 32768 字节 receipt、成对 consumed_by/consumed_at |

支持关系的 `relation_state` 为 `staged/effective/reviewed_reference/contradicting/superseded/revoked`。行政批准的引用与独立有效支持分开，只有通过信任和独立证据根核验的 effective 支持可参与对应置信度计算；相同证据的复制或改名不增加独立性。

changed/due 按 scope 和冻结目标 revision/hash 读取有限集合。checkpoint 按实际序列化大小收窄，未纳入的事件保留；preview 不确认，非预览确认必须引用已持久化的处理结果。due 的推进使用目标 CAS，不是任意更新时间订阅，也不单独启动定时 worker。

host-state 适配器只接受固定类型：source_attestation/source_revocation、governance_undo、reuse_grants、target_profile、compatibility_binding、paired_evaluation、skill_draft_gate、paired_holdout。owner 状态更新需独立认证、幂等与 revision CAS；holdout 由受控评测任务原子占用。证据签名使用 allowlist Ed25519 issuer，行政审阅不能替代作者证明。holdout 的单用约束跨同 owner 的别名与计划生效，客户端不能通过改名重复使用。

公共控制面提供专用来源 attest/revoke-attestation、复用 status/grants/evaluate，以及 control/run、control/undo-preview、control/undo-approve，没有通用 host-state put。source/revoke-attestation 的 host receipt 绑定精确 sourceRevision 与 operationIdempotencyKey，只改变信任资格并批准后续 source_revoke；canonical evidence/links 的治理提交另由操作 receipt 证明。undo 预览原操作对应的当前状态，批准将 operationReceiptId/currentStateHash 与操作幂等键绑定到 governance_undo 状态；执行事务重验并消费精确行政批准，不能将批准回执当作撤销完成。

source_reconcile 先提交数据库操作 receipt 再确认来源 manifest。扫描不完整或提交后 manifest 确认失败均可返回 partial；有限 result 区分 sourceManifestConfirmed 和已提交 receipt，未知影响列表不补成空数组。此时不能宣称完全未写、全量来源已对账或恢复已验收。精确治理 undo 不等同 schema 降级、备份恢复或完整原生 PG/生产闭环通过。

复用 grants 为目标 host scope 下的完整替换，来源 scope 只能在同 owner authority 内收窄。兼容性 binding 和 paired report 需要目标指纹、有效授权、真实 artifact 与单用 holdout 对应；默认 evaluator 仅覆盖注册的合成任务，不自动发布/执行 Skill。数据库表与 Skill draft gate 不提供完整 E3 所缺的独立 outcome 证明，默认受治理经验聚合仍缺合格 ExperienceSource。

host-state 应用层单值限制为 16384 字节，读入 receipt 限制为 8192 字节，严于 DDL 上限；过期或撤销立即影响资格，不等于数据库已物理清理。具体可用入口与默认组装边界见 [API](../api/memory-api.md)及[配置](../guides/configuration.md)。

## 升级与回退

迁移按版本和 checksum ledger 校验。关闭 feature、取消批次或暂停后台均不撤销 schema 或已提交数据；旧 runtime 若不认识新增 ledger 会拒绝启动，仅恢复旧 npm 包不构成数据库回退。

回退需使用兼容当前 ledger 的已验证 runtime，或在独立授权、维护静默和可恢复备份条件下执行完整数据恢复。禁止删除 ledger、篡改 checksum 或直接改状态假装降级。迁移 registry、包契约与源码测试不证明某个安装实例已完成升级或恢复。

## 后端状态

| 后端 | 状态 | 说明 |
|------|------|------|
| LanceDB | 已支持 | 可选本地向量存储，路径由 `dbPath` 决定 |
| Supabase | 已支持 | PostgreSQL + pgvector，需要 `SUPABASE_URL` 和 `SUPABASE_SERVICE_KEY` |
| Postgres | 已支持 | 当前推荐共享后端，适合 OpenClaw/Codex/Claude Code 共用 |
| In-memory | 已支持 | 中间件 contract baseline 和测试 |

## Legacy 表

| 表名 | 用途 | 默认数据类型 |
|------|------|--------------|
| `memories` | 对话记忆、用户偏好、事实、决策 | `memory` |
| `knowledge` | 扫描文档和知识条目 | `knowledge` / `document` |

### `memories`

```sql
CREATE TABLE memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.7,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'memory',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

### `knowledge`

```sql
CREATE TABLE knowledge (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536) NOT NULL,
  importance FLOAT NOT NULL DEFAULT 0.5,
  category TEXT NOT NULL DEFAULT 'other',
  data_type TEXT NOT NULL DEFAULT 'knowledge',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
```

### 字段说明

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | UUID/string | 主键，具体格式由 provider 决定 |
| `text` | text | 记忆或知识片段正文 |
| `content_hash` | text | 内容去重 hash |
| `vector` | vector | embedding 向量，维度必须和模型一致 |
| `importance` | float | 重要性，范围 0-1 |
| `category` | text | legacy 分类 |
| `data_type` | text | `memory`、`document`、`knowledge` |
| `metadata` | json | OpenClaw 上下文、文件路径、用户自定义信息 |
| `created_at` | timestamp/number | 创建时间 |

## Legacy 索引

```sql
CREATE INDEX memories_vector_idx
ON memories USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

CREATE UNIQUE INDEX memories_content_hash_idx
ON memories (content_hash);

CREATE INDEX memories_data_type_idx
ON memories (data_type);

CREATE INDEX memories_created_at_idx
ON memories (created_at DESC);
```

```sql
CREATE INDEX knowledge_vector_idx
ON knowledge USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);

CREATE UNIQUE INDEX knowledge_content_hash_idx
ON knowledge (content_hash);

CREATE INDEX knowledge_data_type_idx
ON knowledge (data_type);

CREATE INDEX knowledge_created_at_idx
ON knowledge (created_at DESC);
```

## Supabase RPC

Supabase provider 使用 `match_memories` 和 `match_knowledge` 做向量搜索。仓库 `scripts/sql/` 下保留两份脚本：

| 脚本 | 说明 |
|------|------|
| [supabase-rpc-functions.sql](../../scripts/sql/supabase-rpc-functions.sql) | 1536 维默认脚本 |
| [supabase-rpc-functions-1024.sql](../../scripts/sql/supabase-rpc-functions-1024.sql) | 1024 维模型脚本 |

维度必须和 embedding 模型一致。

## 向量维度

常用模型维度见 [技术栈](../architecture/technology-stack.md)。更换模型时需要同时处理：

1. provider 表结构或 LanceDB schema。
2. Supabase RPC 函数参数维度。
3. 已有向量数据的迁移或重建。

## v4 中间件 schema 草案

v4 在 legacy 表之上新增结构化数据模型。当前代码已提供 in-memory contract baseline；持久化 provider 后续按下表落地。

| 表名 | 作用 |
|------|------|
| `documents` | source/document 元数据 |
| `chunks` | deterministic chunk，graph/tree/vector/text 的 evidence 单位 |
| `jobs` | embed/extract/seal/digest 等后台任务 |
| `audit` | store/forget/migrate/retention/rebuild 审计 |
| `entities` | 结构化实体 |
| `relations` | 带 evidence 的关系 |
| `tree_buffers` | source/topic/global L0 buffer |
| `summary_nodes` | sealed source/topic/global summary |

核心约束：

- 所有新表必须包含 `scope_key`，或包含可稳定派生 `scope_key` 的 `scope` 字段。
- server/remote 模式不得绕过 scope filter 查询。
- graph/tree/summary 必须保留 evidence id，不能只有模型生成文本。
- L0 evidence 不应因摘要折叠被系统主动删除；删除属于治理操作，应写 audit。

建议索引：

```sql
CREATE INDEX chunks_scope_source_idx
ON chunks(scope_key, source_id, created_at DESC);

CREATE INDEX entities_scope_hotness_idx
ON entities(scope_key, hotness DESC);

CREATE INDEX relations_subject_idx
ON relations(scope_key, subject_id, predicate);

CREATE INDEX relations_object_idx
ON relations(scope_key, object_id, predicate);

CREATE INDEX summary_tree_idx
ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);
```

### documents 表

```sql
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_type TEXT NOT NULL, -- 'file'|'conversation'|'api'|'scan'
  file_path TEXT,
  content_hash TEXT NOT NULL UNIQUE,
  size_bytes INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  indexed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX documents_scope_source_idx
ON documents(scope_key, source_id);

CREATE UNIQUE INDEX documents_content_hash_idx
ON documents(content_hash);
```

### chunks 表

```sql
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  text TEXT NOT NULL,
  content_hash TEXT NOT NULL UNIQUE,
  vector vector(1536),
  token_count INTEGER,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX chunks_scope_source_idx
ON chunks(scope_key, source_id, chunk_index);

CREATE INDEX chunks_document_idx
ON chunks(document_id, chunk_index);

CREATE UNIQUE INDEX chunks_content_hash_idx
ON chunks(content_hash);

CREATE INDEX chunks_vector_idx
ON chunks USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);
```

### jobs 表

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  job_type TEXT NOT NULL, -- 'embed'|'extract'|'seal'|'digest'|'rebuild'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending'|'running'|'completed'|'failed'
  target_id TEXT,
  progress FLOAT DEFAULT 0.0,
  error TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  started_at TIMESTAMP WITH TIME ZONE,
  completed_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX jobs_scope_status_idx
ON jobs(scope_key, status, created_at DESC);

CREATE INDEX jobs_type_status_idx
ON jobs(job_type, status, created_at DESC);
```

### audit 表

```sql
CREATE TABLE audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  operation TEXT NOT NULL, -- 'store'|'forget'|'migrate'|'retention'|'rebuild'
  target_type TEXT NOT NULL, -- 'memory'|'document'|'chunk'|'entity'|'relation'
  target_id TEXT NOT NULL,
  actor TEXT, -- 'system'|'user:{id}'|'plugin'
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX audit_scope_operation_idx
ON audit(scope_key, operation, created_at DESC);

CREATE INDEX audit_target_idx
ON audit(target_type, target_id, created_at DESC);
```

### entities 表

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  hotness FLOAT DEFAULT 0.0,
  first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scope_key, name, entity_type)
);

CREATE INDEX entities_scope_hotness_idx
ON entities(scope_key, hotness DESC);

CREATE INDEX entities_scope_type_idx
ON entities(scope_key, entity_type);
```

### relations 表

```sql
CREATE TABLE relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  subject_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_id UUID REFERENCES entities(id) ON DELETE CASCADE,
  evidence_ids TEXT[] NOT NULL,
  confidence FLOAT DEFAULT 0.5,
  first_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scope_key, subject_id, predicate, object_id)
);

CREATE INDEX relations_subject_idx
ON relations(scope_key, subject_id, predicate);

CREATE INDEX relations_object_idx
ON relations(scope_key, object_id, predicate);
```

### tree_buffers 表

```sql
CREATE TABLE tree_buffers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL, -- 'source'|'topic'|'global'
  tree_key TEXT NOT NULL,
  chunk_ids TEXT[] NOT NULL,
  token_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  UNIQUE(scope_key, tree_type, tree_key)
);

CREATE INDEX tree_buffers_scope_type_idx
ON tree_buffers(scope_key, tree_type, tree_key);
```

### summary_nodes 表

```sql
CREATE TABLE summary_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  summary TEXT NOT NULL,
  evidence_ids TEXT[] NOT NULL,
  token_count INTEGER DEFAULT 0,
  vector vector(1536),
  sealed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'
);

CREATE INDEX summary_tree_idx
ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);

CREATE INDEX summary_vector_idx
ON summary_nodes USING ivfflat (vector vector_cosine_ops)
WITH (lists = 100);
```

## 架构特性与算法实现

v4 schema 设计支持以下核心特性：

### 1. scope_key 隔离

所有表包含 `scope_key` 字段，用于多租户/多用户数据隔离：

- 本地模式：默认 `scope_key = "default"`
- server/remote 模式：从认证 token 提取 `user_id` 或 `org_id`，自动派生 `scope_key`
- 所有查询必须携带 scope filter，provider 层强制校验

### 2. deterministic chunk

`chunks` 表设计原则：

- 每个 chunk 有稳定的 `content_hash`，同内容去重
- `chunk_index` 标识在 source 中的顺序
- `vector` 字段可选，支持延迟向量化
- chunk 不可变，修改 source 时创建新 chunk 并更新 document 关联

### 3. evidence 链

graph/tree/summary 必须保留 evidence：

- `relations.evidence_ids` 数组指向 `chunks.id`
- `summary_nodes.evidence_ids` 数组指向 `chunks.id` 或 `tree_buffers.id`
- 支持溯源到 L0 文本，保证可解释性

### 4. 后台任务队列

`jobs` 表实现异步任务：

```typescript
// 创建 embedding 任务
await db.createJob({
  scope_key: 'default',
  job_type: 'embed',
  target_id: document.id,
  metadata: { chunk_count: 10 }
});

// worker 拉取任务
const job = await db.pullJob({ job_type: 'embed', status: 'pending' });
await db.updateJob(job.id, { status: 'running', started_at: new Date() });

// 完成任务
await db.updateJob(job.id, {
  status: 'completed',
  progress: 1.0,
  completed_at: new Date()
});
```

### 5. 审计日志

所有删除、迁移、重建操作必须写 `audit` 表：

```typescript
await db.audit({
  scope_key: 'default',
  operation: 'forget',
  target_type: 'memory',
  target_id: entry.id,
  actor: 'user:123',
  metadata: { reason: 'user_request' }
});
```

### 6. tree buffer 机制

`tree_buffers` 表支持 3 种树类型：

- `source` tree：每个 file/conversation 一棵树
- `topic` tree：按主题聚合跨 source 的 chunk
- `global` tree：全局时间线 buffer

buffer 累积 chunk_ids，达到阈值触发 seal 任务：

```typescript
// 添加 chunk 到 buffer
await db.addToTreeBuffer({
  scope_key: 'default',
  tree_type: 'source',
  tree_key: 'doc-123',
  chunk_ids: ['chunk-1', 'chunk-2']
});

// buffer 满时创建 seal 任务
if (buffer.token_count > threshold) {
  await db.createJob({
    job_type: 'seal',
    target_id: buffer.id
  });
}
```

### 7. summary 分层

`summary_nodes` 表支持多层摘要：

- level 0：L0 chunk 直接摘要（对应 source/topic 层级）
- level 1+：摘要的摘要

每个 summary node 记录：

- `evidence_ids`：引用的下层 chunk/summary id
- `vector`：摘要向量，支持语义搜索
- `sealed_at`：封存时间，用于增量更新

### 8. graph 热度衰减

`entities` 表记录 `hotness` 分数：

- 初始值：从 extraction confidence 计算
- 衰减：定期运行 decay 任务，`hotness *= 0.9`
- 每次引用时刷新 `last_seen`，hotness 增加

`relations` 表类似机制，支持过期边清理。

### 9. 向量索引策略

- `chunks.vector`：核心检索，必须索引
- `summary_nodes.vector`：摘要检索，建议索引
- 其他表（entities/relations）：按需索引

### 10. 批量操作支持

schema 设计支持批量写入：

```typescript
await db.batchInsertChunks(chunks); // 单次最多 100 条
await db.batchEmbedChunks(chunk_ids); // 批量向量化
await db.batchUpdateEntityHotness(updates); // 批量更新热度
```

## CLI 命令参考

v4 schema 提供以下 CLI 命令：

### 查询命令

```bash
# 查看所有表统计
ms tables

# 查询 documents
ms query documents --scope default --limit 10

# 查询 chunks（支持 source 过滤）
ms query chunks --source-id doc-123 --limit 20

# 查询 jobs（支持状态过滤）
ms query jobs --status pending --job-type embed

# 查询 audit 日志
ms query audit --operation forget --target-type memory

# 查询 entities（支持热度排序）
ms query entities --scope default --sort hotness --limit 50

# 查询 relations（支持主谓宾过滤）
ms query relations --subject-id entity-123 --predicate "works_at"

# 查询 tree buffers
ms query tree_buffers --tree-type source --tree-key doc-123

# 查询 summary nodes
ms query summary_nodes --tree-type topic --level 0
```

### 管理命令

```bash
# 创建 job
ms create-job embed --target-id doc-123 --scope default

# 更新 job 状态
ms update-job job-456 --status completed --progress 1.0

# 审计记录
ms audit forget memory entry-789 --actor user:123 --reason "user_request"

# 清理过期数据
ms cleanup --older-than 90 --target-type chunk --dry-run

# 重建索引
ms rebuild-index --table chunks --scope default

# 导出数据
ms export documents --scope default --format json --output docs.json
```

### 迁移命令

```bash
# 从 legacy 表迁移到 v4
ms migrate --to-schema v4 --dry-run

# 分批迁移
ms migrate --to-schema v4 --batch-size 100 --scope default

# 验证迁移结果
ms migrate --verify --scope default
```

### 监控命令

```bash
# 查看 job 队列状态
ms jobs status

# 查看 scope 统计
ms stats --scope default --breakdown

# 查看 entity 热度分布
ms stats entities --scope default

# 查看 tree buffer 状态
ms stats tree-buffers --tree-type source
```

## 测试覆盖

v4 schema 测试要求：

### 单元测试

| 测试文件 | 覆盖范围 |
|---------|---------|
| `db/providers/postgres-v4.test.ts` | documents/chunks/jobs CRUD |
| `db/providers/supabase-v4.test.ts` | Supabase v4 provider 实现 |
| `graph/entity-resolver.test.ts` | entity/relation 创建和查询 |
| `tree/buffer-manager.test.ts` | tree buffer 累积和 seal 触发 |
| `tree/summary-builder.test.ts` | summary node 生成和分层 |

### 集成测试

| 测试场景 | 预期行为 |
|---------|---------|
| scope 隔离 | scope A 无法访问 scope B 的数据 |
| evidence 链 | relation/summary 必须引用有效 chunk id |
| job 队列 | worker 拉取、更新、完成流程正确 |
| audit 记录 | 删除操作必须写 audit 表 |
| batch 操作 | 批量写入 100 条 chunk 无错误 |

### E2E 测试

```bash
# 完整导入流程
ms scan /path/to/docs --target-table knowledge
ms query chunks --source-id doc-123 --limit 10

# graph 提取流程
ms extract-graph --source-id doc-123
ms query entities --scope default --limit 20
ms query relations --subject-id entity-456

# tree 构建流程
ms build-tree --tree-type source --source-id doc-123
ms query summary_nodes --tree-type source --tree-key doc-123
```

覆盖率目标：80%+

## 迁移

当前迁移命令：

```bash
ms migrate --to-schema v4 --dry-run
```

该命令当前提供迁移估算，不执行真实数据迁移。真实迁移需要按表、namespace、scope 分批执行，并保留旧表回滚窗口。

### 迁移策略

1. **分阶段迁移**

   - 阶段 1：创建 v4 表结构，不影响 legacy 表
   - 阶段 2：增量写入双写（同时写 legacy 和 v4）
   - 阶段 3：历史数据批量迁移
   - 阶段 4：切换读取为 v4 优先
   - 阶段 5：legacy 表只读或归档

2. **数据映射**

   | Legacy 表 | V4 表 | 映射规则 |
   |----------|-------|---------|
   | `memories` | `chunks` | `data_type='memory'` → 创建 virtual document + chunk |
   | `knowledge` | `documents` + `chunks` | 按 `metadata.filePath` 分组为 document |

3. **回滚机制**

   ```bash
   # 回滚到 legacy 模式
   ms rollback --to-schema legacy --scope default
   
   # 验证 legacy 数据完整性
   ms verify --schema legacy --scope default
   ```

4. **性能优化**

   - 批量迁移：每批 100 条，避免长事务
   - 并发控制：最多 3 个并发 worker
   - 增量同步：定期运行，追平双写期间的数据

5. **监控指标**

   ```bash
   # 查看迁移进度
   ms migrate --status --scope default
   
   # 输出示例
   # Migration Progress:
   #   documents: 1000/1200 (83%)
   #   chunks: 4500/5000 (90%)
   #   jobs: 50/50 (100%)
   #   entities: 200/250 (80%)
   ```
