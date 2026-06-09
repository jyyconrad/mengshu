# memory-autodb 记忆中间件架构设计

> 版本：v4.0 架构方案  
> 日期：2026-05-30  
> 状态：设计方案  
> 目标：将 memory-autodb 从 OpenClaw 插件扩展为可服务多产品的记忆中间件系统

---

## 1. 背景与结论

memory-autodb 当前已经具备长期记忆插件的核心能力：OpenClaw 工具注册、自动捕获/召回、目录扫描、LanceDB/Supabase/Hybrid 存储、多表 `memories` / `knowledge` 隔离，以及基础元数据丰富。但它的系统边界仍然是“OpenClaw 插件”，主要入口集中在 `index.ts`，其他产品难以稳定复用。

调研 `rohitg00/agentmemory` 与 `tinyhumansai/openhuman` 后，新的方向不应只是继续给插件增加表、命令或数据库 Provider，而是把 memory-autodb 抽象成一个独立的记忆中间件：

1. **OpenClaw 变成一个 Adapter**：保留现有工具和生命周期钩子，但内部调用统一的 `MemoryService`。
2. **提供多入口协议**：REST、MCP、SDK、CLI、Webhook/Hook Adapter 共用同一套核心服务。
3. **建立标准记忆域模型**：区分 Observation、Memory、Document、Chunk、Entity、Relation、SummaryNode、Namespace、Source、Job、AuditLog。
4. **从单向量检索升级为混合检索**：BM25/FTS + Vector + Graph + Summary Tree，统一由 Retrieval Orchestrator 合并、去重、重排和裁剪 token。
5. **引入异步 ingestion/lifecycle**：写入热路径保持快、确定、事务化；嵌入、实体抽取、图谱、摘要、过期清理在后台 job 中执行。
6. **默认本地优先，可远程部署**：保留 LanceDB 本地能力，补齐服务端认证、租户隔离、审计、备份、导入导出和观测。

关键判断：不要把 v3.0 直接变成 “LanceDB + Mem0 + Cognee 三引擎堆叠”。agentmemory 和 OpenHuman 的共同经验是先稳定**记忆域模型、生命周期、检索编排和协议面**，外部引擎应作为可插拔 Provider，而不是核心架构前提。

结构化知识图谱需要和记忆树一起设计：Graph 负责实体关系，Tree 负责压缩、导航和时间/来源/主题维度。详细设计见 [结构化知识图谱与记忆树详细设计](../04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md)。

---

## 2. 调研摘要

### 2.1 agentmemory 的启发

agentmemory 的定位是“多编码智能体共享的记忆服务”，不是单一插件。它的关键设计点：

| 维度 | 设计 | 对 memory-autodb 的启发 |
|------|------|--------------------------|
| 系统形态 | 常驻 server，默认 REST 端口，另有 MCP/Hook/Viewer | memory-autodb 需要 `embedded` 和 `server` 两种运行模式 |
| 多产品入口 | 支持 Claude Code、Codex、Cursor、OpenClaw、OpenHuman、MCP 客户端 | OpenClaw 不应是核心边界，只是适配器 |
| 捕获链路 | Hook 捕获 session、prompt、tool use、error、stop/session_end | 把自动捕获抽象成 Observation API 和 Capture Adapter |
| 记忆层次 | Working、Episodic、Semantic、Procedural 四层 | 当前 `MemoryEntry` 需要升级为生命周期模型 |
| 检索 | BM25 + Vector + Graph，RRF 融合，可按 agent/project 过滤 | 当前纯向量检索需要 Retrieval Orchestrator |
| 记忆演化 | version、supersedes、strength、TTL、auto-forget、audit | 需要治理、遗忘、替换、追溯能力 |
| 安全 | Bearer secret、loopback 默认、敏感信息过滤、prompt 注入隔离 | 中间件必须有认证、隔离和 prompt-safe formatter |
| 可观测 | health、viewer、trace、audit、diagnose | 中间件需要管理面，不只是存取 API |

agentmemory 不一定适合作为直接依赖：它绑定 iii engine 和自己的运行时假设。但它证明了“记忆能力要产品化，必须有独立 server + 多协议 + 观测治理 + 自动捕获”。

### 2.2 OpenHuman 的启发

OpenHuman 的记忆体系核心是 Memory Tree + Obsidian Wiki，而不是薄向量库封装。它的关键设计点：

| 维度 | 设计 | 对 memory-autodb 的启发 |
|------|------|--------------------------|
| 本地优先 | SQLite + 本机 Markdown vault | memory-autodb 应保留本地可控、可导出的形态 |
| Ingest 管线 | source adapter -> canonical markdown -> chunk -> content store -> score -> job queue | 目录扫描应升级为通用 ingest pipeline |
| Chunk 策略 | deterministic ID、bounded chunks、provenance | 需要稳定 chunk ID 和来源追踪，避免重复/不可回放 |
| Tree 结构 | source tree、topic tree、global tree | 解决“今天发生什么”“某实体最新情况”“按来源追溯”等非相似度问题 |
| 后台任务 | 嵌入、实体抽取、seal summary、digest 在 worker 中运行 | 写入热路径不应等待 LLM/embedding |
| Namespace API | `put_doc`、`put_doc_light`、`ingest_doc`、`query_namespace`、`graph_query` | 需要区分轻量写入、可检索写入、同步完整 ingest |
| 外部后端 | 可选代理到 agentmemory | memory-autodb 也应定义 backend/provider contract，允许外部记忆后端 |
| 自动拉取 | 20 分钟 tick，按 connection 维护 cursor/budget/dedup | 未来 connector/sync 需要 per-source 状态，而不是一次性扫描 |

OpenHuman 的经验说明：长期记忆不能只回答“和 query 相似的片段是什么”，还要回答时间、来源、实体、主题、全局摘要和可人工编辑/导出的可控性。

### 2.3 当前 memory-autodb 的差距

| 能力 | 当前状态 | 中间件化缺口 |
|------|----------|--------------|
| 入口 | OpenClaw Plugin Tool/Hook/CLI | 缺 REST/MCP/SDK/remote client |
| 核心边界 | `index.ts` 直接组织业务 | 缺独立 `MemoryService` 与 adapter 层 |
| 数据模型 | `MemoryEntry` + metadata | 缺 Observation、Chunk、Entity、Relation、Summary、Job、Audit |
| 检索 | 向量检索为主 | 缺 BM25/FTS、图谱、摘要树、融合重排 |
| Ingestion | 目录扫描 + markdown processor | 缺 source adapter、canonical markdown、job queue、状态机 |
| 多产品隔离 | OpenClaw 上下文元数据 | 缺 tenant/app/user/workspace/project/agent 明确 scope |
| 生命周期 | hash 去重 + cleanup | 缺 supersession、strength、TTL、访问增强、遗忘审计 |
| 安全 | prompt injection 检测和 HTML escape | 缺 API 认证、RBAC、敏感信息过滤、租户隔离、审计 |
| 运维 | CLI stats/tables/export | 缺 health、metrics、job 状态、备份/恢复、管理面 |

---

## 3. 目标架构

### 3.1 总体架构

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Product Layer                                  │
│ OpenClaw Plugin | MCP Client | REST Client | Web Console | CLI | Connectors  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                              Adapter Layer                                  │
│ adapters/openclaw | adapters/mcp | api/rest | console | sdk/js/python | hooks│
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                              Core Service                                   │
│ MemoryService                                                               │
│ - storeMemory / recall / query / delete / export                            │
│ - observe / startSession / endSession / buildContext                         │
│ - ingestSource / listNamespaces / graphQuery / health                        │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────────────┐
│                         Orchestration Layer                                 │
│ Ingestion Pipeline | Retrieval Orchestrator | Lifecycle Engine               │
│ Namespace Resolver | Security Guard | Context Packer | Job Scheduler         │
└───────────────┬───────────────────────┬───────────────────────┬─────────────┘
                │                       │                       │
┌───────────────▼──────────────┐ ┌──────▼──────────────┐ ┌─────▼─────────────┐
│      Storage Providers        │ │    Index Providers  │ │   External Backends │
│ LanceDB | Supabase | Postgres │ │ BM25/FTS | Vector   │ │ agentmemory | Mem0  │
│ SQLite(local future)          │ │ Graph | SummaryTree │ │ Cognee | custom     │
└───────────────────────────────┘ └─────────────────────┘ └───────────────────┘
```

### 3.2 运行模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| `embedded` | 和 OpenClaw 插件同进程运行，不启动 HTTP server | 兼容当前插件、最低迁移成本 |
| `server` | 启动独立 daemon，REST/MCP/CLI/Adapter 访问同一服务 | 多产品共享、本机中间件 |
| `remote` | 只运行 client adapter，连接远程 memory-autodb server | 团队共享、云端部署 |
| `backend-proxy` | memory-autodb 代理到 agentmemory/Mem0/Cognee 等外部后端 | 兼容已有记忆系统 |

第一阶段必须实现 `embedded` 与 `server` 的同构：OpenClaw 插件使用同一套 `MemoryService`，只是调用方式不同。

---

## 4. 核心领域模型

### 4.1 Scope 是第一等概念

多产品复用的前提是明确隔离边界。所有写入和查询都必须带规范化 scope。

```typescript
interface MemoryScope {
  tenantId?: string;      // SaaS/团队部署时使用
  appId: string;          // openclaw | openhuman | custom-app
  userId?: string;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  namespace: string;      // global | conversations | knowledge | skill-gmail ...
  visibility?: "private" | "workspace" | "team" | "public";
}
```

默认映射：

| 当前字段 | 新 scope 字段 |
|----------|----------------|
| `metadata.userId` | `scope.userId` |
| `metadata.projectPath` | `scope.projectId` 或 `scope.workspaceId` |
| `metadata.agentName` / `agentId` | `scope.agentId` |
| `metadata.sessionId` | `scope.sessionId` |
| `tableName` / `category` | `scope.namespace` + `memory.kind` |

### 4.2 标准实体

```typescript
interface MemoryRecord {
  id: string;
  scope: MemoryScope;
  kind: "fact" | "preference" | "decision" | "task" | "plan" | "workflow" | "profile" | "other";
  content: string;
  title?: string;
  concepts: string[];
  files: string[];
  sourceIds: string[];
  confidence: number;
  importance: number;
  strength: number;
  version: number;
  supersedes?: string[];
  expiresAt?: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

interface ObservationRecord {
  id: string;
  scope: MemoryScope;
  type: "prompt" | "assistant" | "tool_use" | "tool_result" | "error" | "session_summary" | "event" | "other";
  raw: unknown;
  text: string;
  privacyLevel: "normal" | "sensitive" | "private";
  contentHash: string;
  createdAt: number;
  metadata: Record<string, unknown>;
}

interface DocumentRecord {
  id: string;
  scope: MemoryScope;
  sourceId: string;
  sourceType: "file" | "chat" | "email" | "web" | "integration" | "manual";
  title: string;
  canonicalMarkdown: string;
  contentHash: string;
  uri?: string;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

interface ChunkRecord {
  id: string;             // deterministic: hash(scope + source + order + content)
  documentId: string;
  scope: MemoryScope;
  text: string;
  tokenCount: number;
  orderIndex: number;
  lifecycle: "pending" | "admitted" | "buffered" | "sealed" | "dropped";
  vector?: number[];
  score?: number;
  entityIds: string[];
  createdAt: number;
  metadata: Record<string, unknown>;
}

interface EntityRecord {
  id: string;
  scope: MemoryScope;
  name: string;
  type: "person" | "org" | "project" | "repo" | "file" | "topic" | "tool" | "other";
  aliases: string[];
  hotness: number;
  createdAt: number;
  updatedAt: number;
}

interface RelationRecord {
  id: string;
  scope: MemoryScope;
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence: number;
  evidenceChunkIds: string[];
  createdAt: number;
}

interface SummaryNode {
  id: string;
  scope: MemoryScope;
  treeType: "source" | "topic" | "global";
  treeKey: string;        // sourceId | entityId | yyyy-mm-dd
  level: number;          // L0 leaf buffer -> L1/L2...
  content: string;
  childIds: string[];
  sourceChunkIds: string[];
  createdAt: number;
  sealedAt?: number;
}
```

### 4.3 与现有 `MemoryEntry` 的兼容

当前 `MemoryEntry` 不立即删除。第一阶段新增转换层：

```typescript
function toMemoryRecord(entry: MemoryEntry): MemoryRecord
function fromMemoryRecord(record: MemoryRecord): MemoryEntry
```

兼容规则：

1. `entry.text` 映射到 `record.content`。
2. `entry.category` 映射到 `record.kind`。
3. `entry.metadata` 中的 OpenClaw 字段提升到 `record.scope`。
4. `entry.tableName === "knowledge"` 映射到 `namespace = "knowledge"`。
5. 旧表继续可读，新表/新字段逐步迁移。

---

## 5. 核心服务接口

### 5.1 MemoryService

```typescript
interface MemoryService {
  storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  observe(input: ObserveInput): Promise<ObserveResult>;
  ingest(input: IngestInput): Promise<IngestResult>;
  buildContext(input: BuildContextInput): Promise<ContextBlock>;
  listNamespaces(scope: Partial<MemoryScope>): Promise<NamespaceSummary[]>;
  delete(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  export(input: ExportInput): Promise<ExportResult>;
  health(): Promise<HealthSnapshot>;
}
```

### 5.2 REST API 草案

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/health` | 健康检查 |
| `POST` | `/v1/sessions/start` | 开始会话并返回上下文 |
| `POST` | `/v1/sessions/end` | 结束会话，触发摘要/抽取 |
| `POST` | `/v1/observations` | 捕获原始观察 |
| `POST` | `/v1/memories` | 存储结构化记忆 |
| `POST` | `/v1/recall` | 混合检索 |
| `POST` | `/v1/context` | 生成 prompt-safe context block |
| `POST` | `/v1/ingest` | 摄取文档/聊天/集成数据 |
| `GET` | `/v1/namespaces` | 列出 namespace |
| `POST` | `/v1/graph/query` | 图谱查询 |
| `GET` | `/v1/jobs` | 查看后台任务 |
| `GET` | `/v1/audit` | 审计日志 |
| `POST` | `/v1/export` | 导出记忆 |
| `POST` | `/v1/import` | 导入记忆 |

Web Console 使用 `/v1/console/*` 只读/运维 API 提供知识速查、整体预览、图谱/记忆树浏览和任务健康视图；详细设计见 [Web Console Design](../04-design/04.1-overview/web-console-design.md)。

### 5.3 MCP Tool 草案

第一阶段只暴露核心 8 个工具，避免一次性复制 agentmemory 的大型工具面。

| Tool | 说明 |
|------|------|
| `memory_save` | 保存长期记忆 |
| `memory_recall` | 检索相关记忆 |
| `memory_context` | 生成可注入上下文 |
| `memory_observe` | 捕获事件/工具结果 |
| `memory_ingest` | 摄取文档或来源 |
| `memory_namespaces` | 列出 namespace |
| `memory_forget` | 删除/遗忘 |
| `memory_health` | 健康检查 |

OpenClaw 现有 `memory_store`、`memory_recall`、`memory_scan_directory`、`memory_cleanup` 保持不变，只是转调这些核心接口。

---

## 6. Ingestion Pipeline

### 6.1 目标

将当前 `memory_scan_directory` 扩展为通用 ingestion：

```text
source adapter
  -> canonicalize
  -> deterministic chunk
  -> content hash / dedup
  -> fast score / admission
  -> transactional persist
  -> enqueue background jobs
  -> embeddings / entity extraction / relations / summary tree / index
```

### 6.2 热路径与后台路径

热路径必须满足：

1. 不调用 LLM。
2. 不等待慢 embedding。
3. 使用确定性 ID 和 hash 去重。
4. 在一次事务中写入 document/chunk/job。
5. 失败时不留下半成品。

后台 job 负责：

| Job | 说明 |
|-----|------|
| `embed_chunk` | 生成 chunk 向量 |
| `extract_entities` | 抽取实体和关系 |
| `append_source_buffer` | 追加到 source tree L0 |
| `route_topic` | 按实体 hotness 路由到 topic tree |
| `seal_summary` | 压缩 buffer 到 summary node |
| `build_daily_digest` | 生成 global tree 日摘要 |
| `retention_sweep` | 衰减、过期、自动遗忘 |
| `export_vault` | 同步 Markdown vault |

### 6.3 Source Adapter

初始支持：

| Adapter | 输入 | 输出 |
|---------|------|------|
| `file-system` | 目录/文件路径 | DocumentRecord |
| `openclaw-chat` | OpenClaw 会话上下文 | ObservationRecord / DocumentRecord |
| `manual` | API 提交文本 | DocumentRecord |
| `import-json` | 导入文件 | MemoryRecord / DocumentRecord |

未来支持 Gmail、Slack、Notion、GitHub 等 connector 时，沿用同一接口：

```typescript
interface SourceAdapter {
  id: string;
  sync(ctx: SyncContext): Promise<SourceSyncResult>;
  canonicalize(item: unknown): Promise<CanonicalDocument>;
}
```

---

## 7. Retrieval Orchestrator

### 7.1 检索流程

```text
query + scope + intent
  -> normalize / expand
  -> parallel search
       - BM25/FTS
       - vector
       - graph traversal
       - source/topic/global summary
       - recent memories
  -> scope filter
  -> RRF fusion
  -> dedup by source/provenance
  -> rerank by score, freshness, strength, confidence, importance
  -> token budget packing
  -> prompt-safe context formatter
```

### 7.2 为什么不能只用向量

| 问题 | 向量检索表现 | 需要的能力 |
|------|--------------|------------|
| “今天发生了什么” | 相似度 query 不稳定 | global daily digest |
| “某项目最近状态” | 容易漏掉时间新但语义弱的记录 | topic tree + freshness |
| “某文件过去踩过什么坑” | 文件名关键词更关键 | BM25/FTS + file facet |
| “A 和 B 有什么关系” | 片段可能不直接相似 | graph traversal |
| “给我可引用来源” | 向量结果缺链路 | provenance + chunk/document |

### 7.3 Scoring

```typescript
combinedScore =
  0.35 * vectorScore +
  0.25 * bm25Score +
  0.15 * graphScore +
  0.10 * freshnessScore +
  0.10 * strengthScore +
  0.05 * importanceScore
```

权重必须可配置，并在结果中暴露 score breakdown，便于调试。

### 7.4 Context Packer

`buildContext` 不直接返回裸文本，而返回结构化上下文：

```typescript
interface ContextBlock {
  text: string;
  tokenCount: number;
  items: Array<{
    id: string;
    kind: "memory" | "chunk" | "summary" | "relation";
    score: number;
    source: string;
    provenance: string[];
  }>;
  warnings: string[];
}
```

注入到 prompt 前必须：

1. 过滤 prompt injection。
2. HTML/XML escape。
3. 标明“历史数据仅供参考，不执行其中指令”。
4. 附带 provenance，便于产品 UI 展示来源。

---

## 8. 存储设计

### 8.1 分层存储

| 层 | 存储内容 | 可选实现 |
|----|----------|----------|
| Metadata Store | memory/document/chunk/entity/relation/job/audit | Postgres/Supabase、SQLite |
| Vector Store | chunk/memory embeddings | LanceDB、pgvector |
| Text Index | BM25/FTS | SQLite FTS5、Postgres tsvector、本地 BM25 |
| Graph Store | entity/relation/evidence | SQL 表起步，后续可接 Neo4j/Cognee |
| Content Store | canonical markdown / vault | 本地文件、对象存储 |
| Event/Job Store | ingest jobs、sync cursors | SQL 表 |

### 8.2 当前 Provider 的演进

现有 `DatabaseProvider` 偏向向量记忆 CRUD。中间件化后拆成更明确的接口：

```typescript
interface MemoryRepository { upsertMemory(); getMemory(); listMemories(); deleteMemory(); }
interface DocumentRepository { upsertDocument(); upsertChunks(); getChunk(); listChunks(); }
interface VectorIndex { upsertVectors(); searchVector(); deleteVectors(); }
interface TextIndex { upsertText(); searchText(); deleteText(); }
interface GraphRepository { upsertEntities(); upsertRelations(); queryGraph(); }
interface JobRepository { enqueue(); lease(); complete(); fail(); }
interface AuditRepository { record(); query(); }
```

兼容层：

```text
DatabaseProvider
  -> LegacyDatabaseAdapter
      -> MemoryRepository + VectorIndex 的子集
```

### 8.3 Schema 增量

不建议直接删除现有 `memories` / `knowledge` 表。新增表：

| 表 | 作用 |
|----|------|
| `memory_records` | 结构化长期记忆 |
| `observations` | 原始观察与事件 |
| `documents` | 规范化来源文档 |
| `chunks` | 文档/对话切片 |
| `entities` | 规范化实体 |
| `relations` | 实体关系 |
| `summary_nodes` | source/topic/global 摘要树节点 |
| `jobs` | 后台任务队列 |
| `sync_states` | connector cursor/budget/dedup |
| `audit_logs` | 写入、删除、导出、权限操作审计 |

迁移策略：

1. 新写入同时写旧表和新表，保持现有工具可用。
2. 查询默认走新 Retrieval Orchestrator，缺索引时 fallback 到旧向量查询。
3. 提供 `ltm migrate --to-schema v4` 将旧记录回填到新模型。
4. 两个小版本后再考虑停止双写。

---

## 9. 安全与治理

### 9.1 认证与传输

| 场景 | 策略 |
|------|------|
| 本机 loopback server | 可允许无认证开发模式，但默认生成 secret 并提示 |
| 非 loopback HTTP | 禁止发送 bearer，除非显式 `allowInsecureRemote=true` |
| HTTPS remote | Bearer/JWT/API Key |
| 团队部署 | tenant + RBAC + audit |

### 9.2 数据隔离

所有 Repository 查询必须带 scope filter。禁止只按 `namespace` 或 `project` 粗过滤。

最低隔离键：

```text
tenantId + appId + userId + workspaceId + namespace
```

OpenClaw 单机默认：

```text
tenantId = "local"
appId = "openclaw"
userId = metadata.userId ?? "default"
workspaceId = hash(projectPath or cwd)
namespace = memories | knowledge | custom
```

### 9.3 隐私与 prompt 安全

必须内置：

1. secret/API key/token 正则过滤。
2. `<private>...</private>` 或 metadata `privacyLevel=private` 不进入自动召回。
3. prompt injection 检测保留并前移到 ingest/observe 阶段。
4. context formatter 对所有记忆文本 escape。
5. export/import 默认脱敏，可配置保留原文。

### 9.4 记忆治理

| 能力 | 说明 |
|------|------|
| Forget | 按 id、namespace、source、session、scope 删除 |
| Retention | TTL、strength 衰减、访问增强 |
| Supersession | 相似/冲突记忆生成新版本，旧版本标记非 latest |
| Audit | store/delete/export/import/permission 全记录 |
| Provenance | Memory 可追溯到 observation/chunk/document/source |

---

## 10. 模块落地建议

### 10.1 目标目录

```text
memory-autodb/
├── adapters/
│   ├── openclaw/          # 当前 index.ts 拆出的 OpenClaw 适配器
│   ├── mcp/               # MCP server/tools
│   └── rest-client/       # remote mode client
├── api/
│   └── rest/              # HTTP routes + auth middleware
├── console/
│   ├── api.ts             # console 聚合查询 API
│   └── web/               # 内置静态 Web Console
├── core/
│   ├── memory-service.ts
│   ├── scope.ts
│   ├── types.ts
│   └── errors.ts
├── ingest/
│   ├── pipeline.ts
│   ├── canonicalize.ts
│   ├── chunker.ts
│   ├── adapters/
│   └── jobs.ts
├── retrieval/
│   ├── orchestrator.ts
│   ├── fusion.ts
│   ├── context-packer.ts
│   └── prompt-safety.ts
├── lifecycle/
│   ├── retention.ts
│   ├── supersession.ts
│   └── audit.ts
├── storage/
│   ├── repositories/
│   ├── indexes/
│   └── providers/
├── graph/
│   ├── extractor.ts
│   └── repository.ts
├── server/
│   ├── daemon.ts
│   └── health.ts
└── sdk/
    ├── js/
    └── python/
```

### 10.2 `index.ts` 的新职责

当前 `index.ts` 职责过重。目标状态：

```text
index.ts
  -> parse OpenClaw config
  -> create MemoryService
  -> register OpenClaw tools
  -> register OpenClaw hooks
  -> map OpenClaw context to MemoryScope
```

所有存储、检索、ingest、生命周期逻辑都应迁出。

### 10.3 配置演进

新增配置草案：

```typescript
interface MiddlewareConfig {
  mode: "embedded" | "server" | "remote" | "backend-proxy";
  server?: {
    host: string;          // default 127.0.0.1
    port: number;          // default 3111 or project-specific
    secret?: string;
    requireHttps?: boolean;
  };
  defaultScope?: Partial<MemoryScope>;
  features?: {
    bm25?: boolean;
    graph?: boolean;
    summaryTree?: boolean;
    vaultExport?: boolean;
    lifecycle?: boolean;
  };
  storage: {
    metadata: "legacy" | "sqlite" | "postgres" | "supabase";
    vector: "lancedb" | "pgvector" | "none";
    textIndex: "memory" | "sqlite-fts" | "postgres-fts";
    contentStore?: "filesystem" | "none";
  };
  backendProxy?: {
    type: "agentmemory" | "mem0" | "cognee" | "custom";
    baseURL?: string;
    apiKey?: string;
  };
}
```

旧配置继续有效，并自动映射：

```text
dbType=lancedb + dbPath -> storage.vector=lancedb, metadata=legacy
supabase -> metadata=supabase, vector=pgvector or hybrid
autoCapture/autoRecall -> adapter.openclaw.autoCapture/autoRecall
scanner -> ingest.fileSystem
```

---

## 11. 分阶段路线

### Phase 0：架构收口与兼容契约

目标：不改行为，先建立边界。

- 新增 `core/types.ts`、`core/scope.ts`、`core/memory-service.ts`。
- 用 `LegacyDatabaseAdapter` 包装当前 `DatabaseProvider`。
- OpenClaw 工具改为调用 `MemoryService`，参数和返回保持兼容。
- 增加 contract tests，固定 `store/recall/scan/cleanup` 行为。

### Phase 1：Server + REST + MCP 最小面

目标：让其他产品可以调用 memory-autodb。

- 增加本地 daemon：`ltm serve` 或 `memory-autodb serve`。
- 实现 `/v1/health`、`/v1/memories`、`/v1/recall`、`/v1/context`。
- 实现 8 个 MCP core tools。
- 增加 bearer auth 和 loopback/HTTPS guard。
- 提供 JS SDK。

### Phase 2：Scope、Namespace 与 Ingestion Pipeline

目标：多产品隔离和通用数据摄取。

- 引入 `MemoryScope`，所有存取强制 scope。
- 把 `memory_scan_directory` 改造成 `ingest(file-system)` 的一个入口。
- 增加 `documents`、`chunks`、`jobs`、`audit_logs` 表。
- 实现 deterministic chunk ID、job queue、ingestion status。
- 增加 `put_doc_light` / `put_doc` / `ingest_doc` 三类写入语义。

### Phase 3：混合检索

目标：从纯向量搜索升级为中间件级检索。

- 增加 TextIndex/BM25 或 FTS。
- Retrieval Orchestrator 并行查询 vector + text + recent。
- 实现 RRF 融合、去重、score breakdown。
- 实现 Context Packer，支持 token budget 和 provenance。
- 建立小型检索评测集，覆盖中文、英文、代码项目、文档知识。

### Phase 4：实体图谱与生命周期

目标：支持实体关系、记忆演化和治理。

- 增加 entities/relations。
- 初期用规则/正则 + 可选 LLM extractor，后续可接 Cognee。
- 增加 supersession、strength、access tracking、TTL、auto-forget。
- 增加 graph query 和 provenance verify。
- 图谱 schema、relation allowlist、entity hotness 与 evidence 规则见 [结构化知识图谱与记忆树详细设计](../04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md)。

### Phase 5：Memory Tree 与 Vault

目标：支持 OpenHuman 式摘要树和人工可编辑知识库。

- 实现 source tree、topic tree、global daily digest。
- 增加 `summary_nodes` 表。
- 增加 Markdown vault export/import。
- 支持“今天发生什么”“某实体最新情况”“按来源 drill down”。
- Source Tree、Topic Tree、Global Tree、seal buffer、daily digest 的细化见 [结构化知识图谱与记忆树详细设计](../04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md)。

### Phase 6：产品化与团队部署

目标：成为真正中间件。

- Python SDK。
- Web Console：基础知识速查、整体预览、graph/tree/source/jobs/audit 视图。详见 [Web Console Design](../04-design/04.1-overview/web-console-design.md)。
- 远程部署模板：Docker、systemd、Fly/Render。
- 多租户/RBAC。
- Connector sync framework。

---

## 12. 关键架构决策

### 决策 1：先抽 Core，不先堆外部引擎

- 背景：已有 v3.0 文档倾向 Mem0 + Cognee + LanceDB 三引擎。
- 决策：先建立 MemoryService、Scope、Ingestion、Retrieval、Lifecycle，再把 Mem0/Cognee/agentmemory 作为 backend/provider。
- 理由：外部引擎可以替换，但中间件自己的 API、隔离、治理和数据模型必须稳定。

### 决策 2：OpenClaw Adapter 兼容优先

- 背景：当前用户价值来自 OpenClaw 插件。
- 决策：现有工具名、参数、CLI 命令保持兼容。
- 理由：中间件化不能破坏当前可用性。内部抽象先双写/双读，外部接口渐进扩展。

### 决策 3：Scope 强制化

- 背景：多产品共享记忆最容易出错的是跨用户/跨项目污染。
- 决策：所有 API 都必须解析出 scope；缺省 scope 只能用于本机单用户开发。
- 理由：后补权限模型成本高，必须从核心数据模型开始。

### 决策 4：热路径无 LLM

- 背景：文档/connector ingest 可能高频，LLM/embedding 会造成阻塞和失败放大。
- 决策：热路径只做 canonicalize、chunk、hash、fast-score、persist、enqueue。
- 理由：性能、可恢复性和成本可控。

### 决策 5：检索结果必须可解释

- 背景：中间件给多个产品提供上下文，必须能解释“为什么召回这条”。
- 决策：RecallResult 返回 score breakdown、source、provenance、scope。
- 理由：便于 UI 展示、调试、评测和安全审计。

---

## 13. 风险与控制

| 风险 | 影响 | 控制 |
|------|------|------|
| 一次性改造过大 | 破坏现有插件 | Phase 0/1 只抽边界和兼容 API |
| 多存储一致性复杂 | 双写失败、数据不一致 | job/outbox、幂等 ID、迁移工具 |
| Scope 设计不严 | 跨产品记忆污染 | 强制 scope resolver + repository guard tests |
| LLM 抽取成本高 | ingest 慢、费用不可控 | 热路径无 LLM，功能 flag，后台限流 |
| 图谱质量不稳定 | 误召回 | 初期只做 provenance-backed relation，低置信度不注入 |
| Prompt injection | 召回内容污染 agent | ingest 检测 + context escape + 安全提示 |
| 远程部署泄露 secret | 数据风险 | HTTPS guard、bearer、RBAC、audit |

---

## 14. 测试策略

| 层级 | 测试 |
|------|------|
| Core contract | `MemoryService` store/recall/delete/export 行为 |
| Scope isolation | 不同 app/user/workspace/agent 互不可见 |
| Adapter compatibility | OpenClaw 现有工具参数和响应保持兼容 |
| Ingestion | deterministic chunk、重复 ingest、失败恢复 |
| Retrieval | BM25/vector/RRF 排序、中文/CJK、metadata filter |
| Security | prompt injection、secret redaction、auth、HTTPS guard |
| Migration | 旧 `memories` / `knowledge` 到新模型回填 |
| E2E | embedded OpenClaw、local server REST、MCP client |

评测指标：

1. Recall@5 / Precision@5。
2. p50/p95 recall latency。
3. ingest 热路径延迟。
4. context token 压缩率。
5. scope isolation 漏召回为 0。

---

## 15. 建议的第一轮实施范围

第一轮不要直接做图谱、Memory Tree 或多 connector。建议只做以下闭环：

1. 新增 `core/MemoryService`，现有 OpenClaw 工具全部转调。
2. 新增 `MemoryScope` 与 OpenClaw scope resolver。
3. 新增本机 REST server 最小接口：health、store、recall、context。
4. 新增 MCP core tools：save、recall、context、health。
5. 新增 contract tests，保证旧 API 不变。
6. 编写迁移设计，但暂不迁移数据。

完成后，memory-autodb 就从“OpenClaw 插件”变成“OpenClaw 可嵌入使用的记忆核心 + 可被其他产品调用的本机服务”。后续再按 Phase 2-5 扩展 ingestion、混合检索、图谱和摘要树。

---

## 16. 参考来源

- agentmemory 仓库：<https://github.com/rohitg00/agentmemory>
- agentmemory README 中的多 agent、REST/MCP、记忆生命周期和检索说明
- agentmemory 源码中的 `src/types.ts`、`src/functions/remember.ts`、`src/functions/smart-search.ts`、`src/triggers/api.ts`
- OpenHuman 仓库：<https://github.com/tinyhumansai/openhuman>
- OpenHuman Memory Tree 文档：`gitbooks/features/obsidian-wiki/memory-tree.md`
- OpenHuman agentmemory backend 文档：`gitbooks/features/obsidian-wiki/agentmemory-backend.md`
- OpenHuman memory 模块文档：`src/openhuman/memory/README.md`、`src/openhuman/memory/traits.rs`、`src/openhuman/memory/ingestion/README.md`
- 当前 memory-autodb 文档与代码：`index.ts`、`config.ts`、`db/types.ts`、`docs/03-architecture/system-architecture.md`、`docs/04-design/04.1-overview/memory-plugin-design.md`
- 结构化知识图谱与记忆树详细设计：`docs/04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md`
- Web Console 设计：`docs/04-design/04.1-overview/web-console-design.md`

---

## 创建信息

- 创建日期：2026-05-30
- 最后更新：2026-05-30
