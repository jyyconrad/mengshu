# 结构化知识图谱与记忆树详细设计

> 版本：v4.0 Detail  
> 日期：2026-05-30  
> 状态：设计方案  
> 关联架构：[memory-middleware-architecture.md](../../03-architecture/memory-middleware-architecture.md)

---

## 1. 设计目标

memory-autodb 的“结构化知识图谱”不应只是一组 `entities` / `relations` 表。参考 OpenHuman Memory Tree 后，更合适的设计是：

1. **底层是可追溯的内容叶子**：所有事实、实体、关系和摘要都能追溯到 source、document、chunk、observation。
2. **中层是结构化实体图谱**：用 Entity / Relation 表表达“谁和谁有什么关系”，关系必须带 evidence。
3. **上层是三类记忆树**：source tree、topic tree、global tree，用摘要树解决压缩、导航和时间维度问题。
4. **检索统一编排**：查询可以走向量、关键词、图谱、source tree、topic tree、global digest，并合并结果。
5. **写入热路径轻量**：ingest 时只做 canonicalize、chunk、fast-score、persist、enqueue；实体抽取、图谱构建、seal summary 在后台执行。

最终能力：

| 问题 | 目标能力 |
|------|----------|
| “这个项目最近有什么变化？” | topic tree + global digest + recent chunks |
| “某个文件过去踩过什么坑？” | source/file facet + graph relation + chunk provenance |
| “A 和 B 有什么关系？” | entity graph traversal + evidence chunks |
| “今天发生了什么？” | global daily digest |
| “为什么召回这条记忆？” | score breakdown + source/chunk/document provenance |

---

## 2. 总体模型

```text
SourceEvent / Document / Observation
        │
        ▼
Canonical Markdown
        │
        ▼
ChunkRecord (deterministic id, lifecycle)
        │
        ├──────────────► Vector/Text Index
        │
        ├──────────────► Entity / Relation Extraction
        │                         │
        │                         ▼
        │                  Knowledge Graph
        │                         │
        ▼                         ▼
Memory Tree Leaves ─────► Source Tree / Topic Tree / Global Tree
        │                         │
        ▼                         ▼
Retrieval Orchestrator ◄── summaries / graph paths / chunks
```

三个核心原则：

1. **Chunk 是图谱和树的最小 evidence 单位**。Entity、Relation、SummaryNode 都不能只有模型生成文本，必须保留 `evidenceChunkIds`。
2. **Graph 负责结构关系，Tree 负责压缩和导航**。Graph 回答关系，Tree 回答“范围内的状态和摘要”。
3. **Tree 不是替代向量索引**。向量索引仍保留，Tree 是向量检索之上的记忆结构层。

---

## 3. 数据结构

### 3.1 ChunkRecord

```typescript
interface ChunkRecord {
  id: string;
  scope: MemoryScope;
  sourceId: string;
  documentId?: string;
  observationId?: string;
  text: string;
  canonicalMarkdown: string;
  contentHash: string;
  tokenCount: number;
  orderIndex: number;
  timeRange?: { startAt?: number; endAt?: number };
  lifecycle: "pending_extraction" | "admitted" | "buffered" | "sealed" | "dropped";
  fastScore: number;
  deepScore?: number;
  vectorStatus: "pending" | "ready" | "failed" | "skipped";
  graphStatus: "pending" | "ready" | "failed" | "skipped";
  treeStatus: "pending" | "buffered" | "sealed" | "skipped";
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}
```

`id` 建议：

```text
chunk_${sha256(scopeKey + sourceId + contentHash + orderIndex).slice(0, 24)}
```

### 3.2 EntityRecord

```typescript
interface EntityRecord {
  id: string;
  scope: MemoryScope;
  canonicalName: string;
  displayName: string;
  type: "person" | "organization" | "project" | "repo" | "file" | "topic" | "tool" | "task" | "concept" | "other";
  aliases: string[];
  mentionCount: number;
  mentionCount30d: number;
  distinctSourceCount: number;
  lastSeenAt?: number;
  hotness: number;
  graphCentrality?: number;
  queryHits30d: number;
  status: "active" | "archived" | "merged";
  mergedInto?: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}
```

Entity ID 建议：

```text
ent_${sha256(scopeKey + type + normalizedCanonicalName).slice(0, 24)}
```

### 3.3 RelationRecord

```typescript
interface RelationRecord {
  id: string;
  scope: MemoryScope;
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
  evidenceChunkIds: string[];
  evidenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  status: "active" | "weak" | "contradicted" | "archived";
  sourceKinds: string[];
  metadata: Record<string, unknown>;
}
```

Relation ID 建议：

```text
rel_${sha256(scopeKey + subjectId + predicate + objectId).slice(0, 24)}
```

关系类型初始 allowlist：

| Predicate | 说明 |
|-----------|------|
| `mentions` | 文档/对话提到实体 |
| `works_on` | 人/agent 正在处理项目或任务 |
| `uses` | 项目/用户使用工具、框架、技术 |
| `owns` | 用户/团队拥有资源 |
| `depends_on` | 项目/模块依赖另一个实体 |
| `decided` | 用户/团队做出决策 |
| `prefers` | 用户偏好 |
| `blocked_by` | 任务被阻塞 |
| `fixed_by` | 问题由某改动修复 |
| `supersedes` | 新事实替代旧事实 |
| `related_to` | 弱相关，低权重 |

### 3.4 TreeLeaf

TreeLeaf 是进入三类树的 admitted chunk 引用，不复制全文。

```typescript
interface TreeLeaf {
  id: string;
  scope: MemoryScope;
  chunkId: string;
  sourceId: string;
  entityIds: string[];
  importance: number;
  eventAt: number;
  createdAt: number;
}
```

### 3.5 SummaryNode

```typescript
interface SummaryNode {
  id: string;
  scope: MemoryScope;
  treeType: "source" | "topic" | "global";
  treeKey: string;           // sourceId | entityId | yyyy-mm-dd
  level: number;             // L1/L2/L3...
  title: string;
  summary: string;
  childNodeIds: string[];
  leafIds: string[];
  evidenceChunkIds: string[];
  entityIds: string[];
  relationIds: string[];
  tokenCount: number;
  timeRange: { startAt: number; endAt: number };
  status: "open" | "sealed" | "stale" | "archived";
  createdAt: number;
  sealedAt?: number;
  metadata: Record<string, unknown>;
}
```

### 3.6 TreeBuffer

```typescript
interface TreeBuffer {
  id: string;
  scope: MemoryScope;
  treeType: "source" | "topic" | "global";
  treeKey: string;
  level: number;             // 通常 L0 buffer
  leafIds: string[];
  childNodeIds: string[];
  tokenCount: number;
  openedAt: number;
  updatedAt: number;
  sealAfterAt?: number;
}
```

---

## 4. 三类记忆树

### 4.1 Source Tree

Source Tree 按来源维护滚动摘要。

适用来源：

| sourceType | sourceId 示例 |
|------------|---------------|
| `file` | `file:/repo/docs/README.md` |
| `openclaw-session` | `session:<sessionId>` |
| `project` | `project:<workspaceHash>` |
| `connector` | `gmail:<label>`、`slack:<channel>` |

流程：

```text
admitted chunk
  -> append source L0 buffer
  -> if buffer full or stale
      -> seal L0 into L1 SummaryNode
      -> append L1 node to parent buffer
      -> cascade if parent full
```

Source Tree 解决：

1. 按文件/会话/连接器追溯。
2. “这个来源最近发生什么”。
3. 检索结果回跳原文。

### 4.2 Topic Tree

Topic Tree 按实体/主题懒构建。不是每个实体都建树，只有 hotness 达标才建。

Hotness 参考 OpenHuman 的确定性公式：

```typescript
hotness =
  ln(mentionCount30d + 1) +
  0.5 * distinctSourceCount +
  recencyDecay(lastSeenAt) +
  graphCentrality +
  2.0 * queryHits30d
```

Recency decay：

| age | decay |
|-----|-------|
| <= 1 天 | 1.0 |
| 1-7 天 | 1.0 -> 0.5 |
| 7-30 天 | 0.5 -> 0 |
| > 30 天 | 0 |

建议阈值：

```typescript
const TOPIC_CREATION_THRESHOLD = 6.0;
const TOPIC_ARCHIVE_THRESHOLD = 2.0;
const TOPIC_RECHECK_EVERY_MENTIONS = 5;
```

Topic Tree 解决：

1. “某人/项目/文件/技术最近状态”。
2. 高热实体自动形成可导航摘要。
3. 召回时避免只拿零散 chunk。

### 4.3 Global Tree

Global Tree 按时间建立全局 digest。

初始粒度：

| 层级 | treeKey | 说明 |
|------|---------|------|
| Daily | `2026-05-30` | 每日全局摘要 |
| Weekly | `2026-W22` | 周摘要，后续阶段 |
| Monthly | `2026-05` | 月摘要，后续阶段 |

调度：

```text
00:00 local or UTC
  -> enqueue digest_daily(yesterday)
  -> enqueue flush_stale(all open buffers)
```

Global Tree 解决：

1. “今天/昨天/这周发生什么”。
2. 无 query 时的主动上下文。
3. 给产品 UI 做时间线、日报、回顾。

---

## 5. 写入与后台任务

### 5.1 热路径

```text
ingest(input)
  -> resolve scope
  -> source adapter canonicalize
  -> chunk deterministic
  -> fast score
  -> transaction:
       upsert document/observation
       upsert chunks(lifecycle=pending_extraction)
       enqueue extract_chunk jobs
       enqueue embed_chunk jobs
  -> return chunk ids + job ids
```

热路径禁止：

1. 调 LLM。
2. 等待 embedding。
3. 做跨大量历史数据的图谱遍历。

### 5.2 Job 类型

| Job | 输入 | 输出 |
|-----|------|------|
| `embed_chunk` | chunkId | vector index ready |
| `extract_chunk` | chunkId | entity/relation/deepScore |
| `admit_chunk` | chunkId + deepScore | admitted/dropped |
| `append_source_buffer` | leafId + sourceId | source buffer updated |
| `topic_route` | leafId + entityIds | topic buffer updated/skipped |
| `seal_buffer` | treeType/treeKey/level | SummaryNode |
| `digest_daily` | date | global SummaryNode |
| `flush_stale` | scope | stale buffers sealed |
| `recompute_hotness` | entityId | entity.hotness |
| `retention_sweep` | scope | archived/expired memories |

### 5.3 Job 幂等与租约

```typescript
interface JobRecord {
  id: string;
  scope: MemoryScope;
  kind: string;
  payload: Record<string, unknown>;
  dedupeKey: string;
  status: "pending" | "leased" | "done" | "failed" | "dead";
  attempts: number;
  maxAttempts: number;
  runAfter: number;
  leasedBy?: string;
  leaseExpiresAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}
```

规则：

1. `dedupeKey` 唯一，重复 enqueue 返回已有 job。
2. worker 启动时释放过期 lease。
3. `seal_buffer` 必须检查 buffer 当前版本，避免重复 seal。
4. job 失败指数退避，超过上限转 `dead` 并进入 health 告警。

---

## 6. 抽取与归一化

### 6.1 抽取策略

第一阶段使用规则 + 轻量模型可选：

| 能力 | 默认 | 可选增强 |
|------|------|----------|
| Entity extraction | 正则/规则/文件路径/标题 | LLM extractor |
| Relation extraction | allowlist predicate + 规则 | LLM JSON/XML extractor |
| Preference/decision | 现有分类规则扩展 | LLM classifier |
| Deep score | 启发式 | LLM scorer |

不要让 LLM 直接写最终图谱。LLM 产物必须经过：

1. schema parse。
2. predicate allowlist。
3. entity type 校验。
4. evidence chunk 对齐。
5. confidence 阈值。

### 6.2 Entity 归一化

```text
raw mention
  -> trim/control char cleanup
  -> alias lookup
  -> type-specific normalize
  -> canonical id
  -> merge candidate check
```

示例：

| raw | type | canonical |
|-----|------|-----------|
| `src/index.ts` | file | `/abs/project/src/index.ts` |
| `OpenClaw` | project/tool | `openclaw` |
| `memory-autodb` | project | `memory-autodb` |
| `Postgres` / `PostgreSQL` | concept | `postgresql` |

### 6.3 Relation 校验

Predicate 要约束 subject/object 类型：

| Predicate | Subject | Object |
|-----------|---------|--------|
| `works_on` | person/agent | project/task |
| `uses` | user/project | tool/concept |
| `depends_on` | project/repo/file | project/repo/file/concept |
| `prefers` | user | concept/tool |
| `fixed_by` | task/concept | file/chunk/memory |
| `mentions` | chunk/document | entity |

不满足约束的关系丢弃或降级为 `related_to`，且不参与高权重检索。

---

## 7. Seal Summary 设计

### 7.1 触发条件

一个 buffer 满足任一条件时进入 seal：

| 条件 | 默认 |
|------|------|
| leaf 数量达到阈值 | 20 |
| token 数达到阈值 | 6000 |
| stale 时间超过阈值 | 24 小时 |
| 用户手动 flush | 立即 |

### 7.2 Summary 输入

seal 不直接拿所有原始文档，而是拿：

1. leaf 对应 chunk 摘要/正文片段。
2. 关联实体和关系。
3. 时间范围。
4. source/topic/global tree 上下文。

### 7.3 Summary 输出 Schema

```typescript
interface SummaryDraft {
  title: string;
  summary: string;
  keyFacts: string[];
  decisions: string[];
  openQuestions: string[];
  entityMentions: string[];
  relationMentions: Array<{
    subject: string;
    predicate: string;
    object: string;
    confidence: number;
  }>;
}
```

输出落库时：

1. `summary` 写入 `SummaryNode.summary`。
2. `keyFacts/decisions` 可生成候选 `MemoryRecord`。
3. `relationMentions` 进入 Relation 校验流程。
4. 所有内容继承 source chunk provenance。

### 7.4 LLM 失败回退

若 summary model 不可用：

1. 使用 extractive summary：按 `deepScore + recency + importance` 取 top chunks。
2. SummaryNode 标记 `metadata.summaryMode = "extractive"`.
3. 后续 job 可重新 seal 为 abstractive summary。

---

## 8. 检索设计

### 8.1 查询类型识别

```typescript
type QueryIntent =
  | "semantic_search"
  | "entity_relation"
  | "topic_status"
  | "source_drilldown"
  | "time_digest"
  | "recent_context";
```

意图路由：

| 信号 | Intent |
|------|--------|
| 包含实体名 + “关系/为什么/依赖” | `entity_relation` |
| 包含“最近/当前/状态/进展” | `topic_status` |
| 包含文件路径/sourceId | `source_drilldown` |
| 包含“今天/昨天/本周” | `time_digest` |
| query 为空 | `recent_context` |
| 其他 | `semantic_search` |

### 8.2 Graph + Tree 检索路径

```text
query
  -> entity linker
  -> if entity_relation:
       graph BFS depth 1-2
       fetch relation evidence chunks
       fetch topic summary nodes
  -> if topic_status:
       topic tree latest sealed nodes
       recent admitted chunks
       high confidence relations
  -> if source_drilldown:
       source tree walk
       source chunks by time/filter
  -> if time_digest:
       global tree node by date/range
  -> merge with vector/BM25 results
```

### 8.3 Tree Walk

Tree walk 从高层 summary 开始，必要时 drill down：

```text
summary node match
  -> if enough detail: return summary + provenance
  -> else expand child nodes
  -> if still insufficient: fetch leaf chunks
```

控制参数：

```typescript
interface TreeQueryOptions {
  maxDepth: number;          // default 3
  maxNodes: number;          // default 12
  maxLeafChunks: number;     // default 20
  minSummaryScore: number;   // default 0.2
}
```

### 8.4 结果格式

```typescript
interface StructuredRecallHit {
  id: string;
  kind: "memory" | "chunk" | "entity" | "relation" | "summary";
  text: string;
  score: number;
  scoreBreakdown: {
    vector?: number;
    bm25?: number;
    graph?: number;
    tree?: number;
    freshness?: number;
    confidence?: number;
  };
  provenance: {
    sourceId?: string;
    documentId?: string;
    chunkIds: string[];
    relationIds?: string[];
    summaryNodeIds?: string[];
  };
  scope: MemoryScope;
  createdAt?: number;
  updatedAt?: number;
}
```

---

## 9. 数据库 Schema 草案

### 9.1 SQL 表

```sql
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  source_id TEXT NOT NULL,
  document_id TEXT,
  observation_id TEXT,
  text TEXT NOT NULL,
  canonical_markdown TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  token_count INTEGER NOT NULL,
  order_index INTEGER NOT NULL,
  lifecycle TEXT NOT NULL,
  fast_score REAL NOT NULL,
  deep_score REAL,
  vector_status TEXT NOT NULL,
  graph_status TEXT NOT NULL,
  tree_status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(scope_key, source_id, content_hash, order_index)
);

CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  type TEXT NOT NULL,
  aliases JSONB NOT NULL DEFAULT '[]',
  mention_count INTEGER NOT NULL DEFAULT 0,
  mention_count_30d INTEGER NOT NULL DEFAULT 0,
  distinct_source_count INTEGER NOT NULL DEFAULT 0,
  last_seen_at BIGINT,
  hotness REAL NOT NULL DEFAULT 0,
  graph_centrality REAL,
  query_hits_30d INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  merged_into TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(scope_key, type, canonical_name)
);

CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  evidence_chunk_ids JSONB NOT NULL DEFAULT '[]',
  evidence_count INTEGER NOT NULL,
  first_seen_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  source_kinds JSONB NOT NULL DEFAULT '[]',
  metadata JSONB NOT NULL DEFAULT '{}',
  UNIQUE(scope_key, subject_id, predicate, object_id)
);

CREATE TABLE tree_buffers (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  leaf_ids JSONB NOT NULL DEFAULT '[]',
  child_node_ids JSONB NOT NULL DEFAULT '[]',
  token_count INTEGER NOT NULL DEFAULT 0,
  opened_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  seal_after_at BIGINT,
  UNIQUE(scope_key, tree_type, tree_key, level)
);

CREATE TABLE summary_nodes (
  id TEXT PRIMARY KEY,
  scope_key TEXT NOT NULL,
  tree_type TEXT NOT NULL,
  tree_key TEXT NOT NULL,
  level INTEGER NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  child_node_ids JSONB NOT NULL DEFAULT '[]',
  leaf_ids JSONB NOT NULL DEFAULT '[]',
  evidence_chunk_ids JSONB NOT NULL DEFAULT '[]',
  entity_ids JSONB NOT NULL DEFAULT '[]',
  relation_ids JSONB NOT NULL DEFAULT '[]',
  token_count INTEGER NOT NULL,
  time_start BIGINT NOT NULL,
  time_end BIGINT NOT NULL,
  status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  sealed_at BIGINT
);
```

### 9.2 索引

```sql
CREATE INDEX chunks_scope_source_idx ON chunks(scope_key, source_id, created_at DESC);
CREATE INDEX chunks_lifecycle_idx ON chunks(scope_key, lifecycle);
CREATE INDEX entities_scope_hotness_idx ON entities(scope_key, hotness DESC);
CREATE INDEX entities_name_idx ON entities(scope_key, canonical_name);
CREATE INDEX relations_subject_idx ON relations(scope_key, subject_id, predicate);
CREATE INDEX relations_object_idx ON relations(scope_key, object_id, predicate);
CREATE INDEX summary_tree_idx ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC);
```

LanceDB / pgvector 保留 chunk vector：

```text
vector_id = chunk.id
metadata = { scopeKey, sourceId, entityIds, lifecycle, createdAt }
```

---

## 10. 与现有 memory-autodb 的集成

### 10.1 与 `memory_scan_directory`

当前 `memory_scan_directory`：

```text
directory -> file scanner -> markdown processor -> chunks -> embeddings -> db.store
```

目标：

```text
directory -> file-system source adapter -> canonical document -> ingest pipeline
```

兼容要求：

1. 现有参数保留。
2. 默认 `targetTable=knowledge` 映射到 `scope.namespace=knowledge`。
3. 返回原统计字段，同时追加 `jobsQueued`、`chunksAdmitted`、`chunksDropped`。

### 10.2 与 `memory_recall`

当前 `memory_recall` 增加可选参数：

```typescript
{
  graph?: boolean;
  tree?: boolean;
  intent?: QueryIntent;
  explain?: boolean;
}
```

默认行为仍兼容旧向量检索。启用新检索后：

1. `category=知识库` 优先 source/topic/global tree。
2. `searchAll=true` 并行查 memories、knowledge、summary_nodes。
3. `explain=true` 返回 score breakdown 和 provenance。

### 10.3 与 v4 MemoryService

新增模块边界：

```text
core/MemoryService
  -> ingest/IngestionPipeline
  -> graph/StructuredGraphService
  -> tree/MemoryTreeService
  -> retrieval/RetrievalOrchestrator
```

---

## 11. 边界条件

| 场景 | 处理 |
|------|------|
| entity 抽取失败 | chunk 保留，graphStatus=failed，可重试 |
| summary 失败 | buffer 保留，job 重试；超过上限使用 extractive summary |
| LLM 不可用 | 只做规则抽取、BM25/向量检索、extractive summary |
| 重复 ingest | deterministic chunk ID + contentHash 去重 |
| entity alias 冲突 | 不自动 merge，创建 merge candidate，人工/规则确认 |
| relation 低置信度 | 保存为 weak 或丢弃，不进入高权重检索 |
| scope 缺失 | 本机默认 scope；server/remote 模式拒绝写入 |
| 删除 source | 删除/归档 chunks、relations evidence、tree leaves，并记录 audit |

---

## 12. 测试策略

| 测试 | 目标 |
|------|------|
| deterministic chunk | 同一输入多次 ingest 不重复 |
| lifecycle state | pending -> admitted -> buffered -> sealed / dropped |
| entity normalization | alias、文件路径、大小写归一 |
| relation validation | 非法 subject/object 类型被拒绝 |
| hotness math | mention/source/recency/query hit 权重稳定 |
| topic routing | 低热实体不建树，高热实体建树 |
| seal cascade | L0 -> L1 -> L2 级联正确 |
| retrieval drilldown | summary 不足时展开 child/leaf |
| provenance | 每条 relation/summary 都能追溯 chunk |
| scope isolation | 不同 scope 的 graph/tree 不互相污染 |

---

## 13. 分阶段实施

### Stage A：图谱基础

- 新增 `chunks`、`entities`、`relations`、`jobs`。
- 实现规则抽取和 relation allowlist。
- `memory_scan_directory` 接入 ingest pipeline。

### Stage B：Source Tree

- 新增 `tree_buffers`、`summary_nodes`。
- 实现 source L0 buffer、seal、stale flush。
- `memory_recall` 支持 source drilldown。

### Stage C：Topic Tree

- 实现 entity hotness。
- 实现 topic_route job。
- 支持 topic status 查询。

### Stage D：Global Tree

- 实现 daily digest。
- 支持 time digest 查询。

### Stage E：融合检索与管理面

- Retrieval Orchestrator 合并 vector/BM25/graph/tree。
- 增加 explain/provenance。
- CLI/API 增加 graph/tree health、jobs、rebuild。

---

## 14. 不做什么

第一阶段不做：

1. 不引入 Neo4j 这类重图数据库。
2. 不强依赖 Cognee/Mem0。
3. 不让 LLM 直接决定最终图谱。
4. 不做全量 connector auto-fetch。
5. 不迁移旧表为强制新 schema。

这样可以先在现有 TypeScript + LanceDB/Supabase/Postgres 体系内落地，保留后续替换外部图谱后端的空间。

---

## 15. 参考

- OpenHuman Memory Tree：`/tmp/codex-openhuman/gitbooks/features/obsidian-wiki/memory-tree.md`
- OpenHuman memory orchestration：`/tmp/codex-openhuman/src/openhuman/memory/README.md`
- OpenHuman hotness/tree policy：`/tmp/codex-openhuman/src/openhuman/memory/tree_topic/hotness.rs`、`/tmp/codex-openhuman/src/openhuman/memory/tree_policy.rs`
- 当前中间件架构文档：[memory-middleware-architecture.md](../../03-architecture/memory-middleware-architecture.md)

---

## 创建信息

- 创建日期：2026-05-30
- 最后更新：2026-05-30
