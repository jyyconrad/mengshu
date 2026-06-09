# memory-autodb 记忆中间件开发计划

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** 将 memory-autodb 从 OpenClaw 单插件演进为可被 OpenClaw、MCP、REST、SDK 和 Web Console 复用的记忆中间件。

**Architecture:** 先抽出兼容旧行为的 `MemoryService` 和 `MemoryScope`，让 OpenClaw 插件只作为 adapter；再补本机 server、REST/MCP/API、通用 ingestion、混合检索、结构化图谱/记忆树、Web Console。每个阶段都保持旧 `memory_store` / `memory_recall` / `memory_scan_directory` / `memory_cleanup` 可用。

**Tech Stack:** TypeScript ESM、Vitest、Node.js 18+、现有 LanceDB/Supabase/Postgres Provider、OpenClaw Plugin SDK；后续可选 Node HTTP server、轻量 MCP server、Vite/React 或静态 TS Web Console。

---

## 0. 开发原则

1. **先兼容，再扩展**：任何阶段都不能破坏当前 OpenClaw 工具、配置和 CLI。
2. **TDD 优先**：每个核心模块先写 contract/unit tests，再实现。
3. **小步提交**：每个任务独立提交，避免一次性重构。
4. **边界清晰**：`index.ts` 最终只保留 OpenClaw adapter；业务逻辑迁到 `core/`、`ingest/`、`retrieval/`、`storage/` 等模块。
5. **Scope 强制**：新 API、新 Repository、新检索路径必须带 `MemoryScope` 或 `scopeKey`。
6. **热路径无 LLM**：ingest 热路径只做 canonicalize、chunk、hash、persist、enqueue。
7. **可解释召回**：新 recall/context 返回 provenance 和 score breakdown。
8. **安全默认**：prompt 注入隔离、private 内容过滤、REST bearer/loopback guard 必须早期落地。

---

## 1. 里程碑概览

| 里程碑 | 目标 | 交付物 | 验收 |
|--------|------|--------|------|
| M0 | 建立测试护栏和核心类型 | core types、scope resolver、legacy mapping tests | `npm test` 通过，旧测试不变 |
| M1 | 抽出 MemoryService | `core/memory-service.ts`、OpenClaw adapter 调用 service | 旧工具行为兼容 |
| M2 | 本机 server 与 REST 最小面 | `/v1/health`、`/v1/memories`、`/v1/recall`、`/v1/context` | 可用 HTTP 调用 store/recall/context |
| M3 | MCP/SDK/CLI 基础入口 | MCP core tools、JS client、serve/status 命令 | 非 OpenClaw 产品可接入 |
| M4 | Scope + Ingestion Pipeline | documents/chunks/jobs/audit、file-system ingest | scan 走新 pipeline，旧接口兼容 |
| M5 | 混合检索与 Context Packer | BM25/FTS、RRF、provenance、token budget | recall explain 可解释 |
| M6 | 图谱与记忆树 | entities/relations/source/topic/global tree | 支持 graph query 和 tree drilldown |
| M7 | Web Console MVP | Overview、Quick Lookup、Graph、Jobs | `/console` 可用，基础速查可追溯 |
| M8 | 迁移、治理、发布 | migrate/export/import、retention、docs | 可灰度开启 v4 |

推荐按 M0-M3 作为第一期，M4-M5 作为第二期，M6-M7 作为第三期，M8 作为收口期。

---

## 2. 当前代码基线

当前关键文件：

| 文件 | 当前职责 | 计划变化 |
|------|----------|----------|
| `index.ts` | 插件注册、工具处理、钩子、CLI、分类映射、安全格式化 | 拆成 OpenClaw adapter，只调用 `MemoryService` |
| `config.ts` | 配置 schema、embedding 维度、routing 配置 | 增加 middleware/server/features/storage 配置并保持旧配置兼容 |
| `db/types.ts` | `MemoryEntry`、`DatabaseProvider` | 保留 legacy 类型，新增 core domain types |
| `db/factory.ts` | 创建 LanceDB/Supabase/Postgres/Hybrid Provider | 保留，后续被 `LegacyDatabaseAdapter` 使用 |
| `scanner/*` | 文件扫描、Markdown 处理 | 后续被 `ingest/adapters/file-system.ts` 包装 |
| `processing/*` | embedding、splitter、hash | 复用到 core/ingest/retrieval |
| `routing/*` | 知识库路由规则 | 后续接入 SourceAdapter / NamespaceResolver |
| `index.test.ts` | 插件注册、配置、capture、routing 等测试 | 扩展为兼容测试，不删除 |

现有验证命令：

```bash
npm test
npx tsc --noEmit
```

如果本仓库 `tsconfig` 或依赖状态导致 `npx tsc --noEmit` 失败，应先记录现有失败，再保证新增代码不扩大失败面。

---

## 3. M0：测试护栏与核心类型

### Task 0.1：建立 core domain types

**Files:**
- Create: `core/types.ts`
- Create: `core/scope.ts`
- Test: `core/scope.test.ts`

**步骤:**

1. 编写 `MemoryScope`、`MemoryRecord`、`ObservationRecord`、`DocumentRecord`、`ChunkRecord`、`EntityRecord`、`RelationRecord`、`SummaryNode`、`ContextBlock`、`RecallResult` 类型。
2. 实现 `normalizeScope(input)`、`scopeToKey(scope)`。
3. 测试 scope key 稳定、缺省值、字段顺序不影响结果。

**测试要点:**

```typescript
expect(scopeToKey({ appId: "openclaw", namespace: "memories" }))
  .toBe("local:openclaw:default:default:default:memories");
```

**验证:**

```bash
npx vitest run core/scope.test.ts
npm test
```

**提交:**

```bash
git add core/types.ts core/scope.ts core/scope.test.ts
git commit -m "feat: add memory core domain types"
```

### Task 0.2：抽出 legacy mapping

**Files:**
- Create: `core/legacy-mapping.ts`
- Test: `core/legacy-mapping.test.ts`
- Read: `db/types.ts`
- Read: `config.ts`

**步骤:**

1. 实现 `memoryEntryToRecord(entry, defaults)`。
2. 实现 `recordToMemoryEntry(record, vector?)`。
3. 实现 `categoryToKind(category)`、`tableNameToNamespace(tableName)`。
4. 保持 `MemoryEntry` 旧字段不变。

**测试要点:**

- `tableName: "knowledge"` 映射到 `namespace: "knowledge"`。
- `metadata.userId/sessionId/projectPath/agentName` 提升到 scope。
- 转回 `MemoryEntry` 时 `text/category/dataType/tableName/metadata` 不丢。

**验证:**

```bash
npx vitest run core/legacy-mapping.test.ts
npm test
```

**提交:**

```bash
git add core/legacy-mapping.ts core/legacy-mapping.test.ts
git commit -m "feat: map legacy memory entries to core records"
```

### Task 0.3：迁出 prompt safety helper

**Files:**
- Create: `retrieval/prompt-safety.ts`
- Test: `retrieval/prompt-safety.test.ts`
- Modify: `index.ts`
- Test: `index.test.ts`

**步骤:**

1. 从 `index.ts` 移出 `looksLikePromptInjection`、`escapeMemoryForPrompt`、`formatRelevantMemoriesContext`。
2. 从 `index.ts` 重新 export，保持现有测试 import 兼容。
3. 新增 `formatContextBlock()` 支持 provenance 占位，但不改变旧 `formatRelevantMemoriesContext` 输出。

**验证:**

```bash
npx vitest run retrieval/prompt-safety.test.ts index.test.ts
npm test
```

**提交:**

```bash
git add retrieval/prompt-safety.ts retrieval/prompt-safety.test.ts index.ts index.test.ts
git commit -m "refactor: move prompt safety helpers out of plugin entry"
```

---

## 4. M1：MemoryService 与 OpenClaw Adapter

### Task 1.1：定义 MemoryService 接口

**Files:**
- Create: `core/memory-service.ts`
- Create: `core/service-types.ts`
- Test: `core/memory-service.test.ts`

**接口:**

```typescript
export interface MemoryService {
  storeMemory(input: StoreMemoryInput): Promise<StoreMemoryResult>;
  recall(input: RecallInput): Promise<RecallResult>;
  buildContext(input: BuildContextInput): Promise<ContextBlock>;
  delete(input: DeleteMemoryInput): Promise<DeleteMemoryResult>;
  health(): Promise<HealthSnapshot>;
}
```

**步骤:**

1. 先用 fake repository / fake embeddings 写 failing tests。
2. 实现最小 `DefaultMemoryService`，内部先调用 legacy db provider。
3. 不引入新 schema，不改变存储格式。

**验证:**

```bash
npx vitest run core/memory-service.test.ts
npm test
```

**提交:**

```bash
git add core/memory-service.ts core/service-types.ts core/memory-service.test.ts
git commit -m "feat: add default memory service"
```

### Task 1.2：封装 LegacyDatabaseAdapter

**Files:**
- Create: `storage/legacy-database-adapter.ts`
- Test: `storage/legacy-database-adapter.test.ts`
- Read: `db/types.ts`

**职责:**

1. 将 `DatabaseProvider` 包装成 `MemoryRepository` + `VectorIndex` 的子集。
2. 暴露 `storeLegacyEntries()`、`queryLegacyEntries()`、`deleteLegacyEntries()`、`stats()`。
3. 处理 `tableName`、`dataTypes`、`searchAll` 兼容。

**验证:**

```bash
npx vitest run storage/legacy-database-adapter.test.ts
npm test
```

**提交:**

```bash
git add storage/legacy-database-adapter.ts storage/legacy-database-adapter.test.ts
git commit -m "feat: wrap database provider for memory service"
```

### Task 1.3：OpenClaw 工具转调 MemoryService

**Files:**
- Create: `adapters/openclaw/scope.ts`
- Create: `adapters/openclaw/tools.ts`
- Create: `adapters/openclaw/hooks.ts`
- Modify: `index.ts`
- Test: `index.test.ts`
- Test: `adapters/openclaw/*.test.ts`

**步骤:**

1. `index.ts` 中保留插件 metadata、config parse、service 构造、register 调用。
2. 将 `memory_store`、`memory_recall`、`memory_cleanup` 的处理逻辑迁到 `adapters/openclaw/tools.ts`。
3. 将 `before_agent_start`、`agent_end` 的逻辑迁到 `adapters/openclaw/hooks.ts`。
4. 保持工具参数和文本响应兼容。

**验收:**

- 旧 `index.test.ts` 全部通过。
- 新 adapter tests 覆盖 category/tableName/searchAll/includeDocuments。

**验证:**

```bash
npx vitest run index.test.ts adapters/openclaw
npm test
```

**提交:**

```bash
git add index.ts adapters/openclaw index.test.ts
git commit -m "refactor: route openclaw plugin through memory service"
```

---

## 5. M2：本机 Server 与 REST 最小面

### Task 2.1：扩展配置 schema

**Files:**
- Modify: `config.ts`
- Test: `index.test.ts`
- Create: `config.middleware.test.ts`

**新增配置:**

```typescript
server?: {
  enabled?: boolean;
  host?: string;
  port?: number;
  secret?: string;
  requireHttps?: boolean;
}
mode?: "embedded" | "server" | "remote" | "backend-proxy"
features?: {
  bm25?: boolean;
  graph?: boolean;
  summaryTree?: boolean;
  webConsole?: boolean;
}
```

**要求:**

1. 旧配置不加新字段也能 parse。
2. 未知字段继续拒绝。
3. 默认 `mode="embedded"`，`server.host="127.0.0.1"`。

**验证:**

```bash
npx vitest run config.middleware.test.ts index.test.ts
```

**提交:**

```bash
git add config.ts config.middleware.test.ts index.test.ts
git commit -m "feat: add middleware server config"
```

### Task 2.2：实现 REST router 与 auth guard

**Files:**
- Create: `api/rest/types.ts`
- Create: `api/rest/auth.ts`
- Create: `api/rest/router.ts`
- Test: `api/rest/auth.test.ts`
- Test: `api/rest/router.test.ts`

**接口:**

| 方法 | 路径 |
|------|------|
| `GET` | `/v1/health` |
| `POST` | `/v1/memories` |
| `POST` | `/v1/recall` |
| `POST` | `/v1/context` |

**安全:**

1. 无 secret 时仅允许 loopback。
2. 有 secret 时验证 `Authorization: Bearer <secret>`。
3. 非 loopback + plaintext + bearer 默认拒绝或警告，取决于配置。

**验证:**

```bash
npx vitest run api/rest
```

**提交:**

```bash
git add api/rest
git commit -m "feat: add rest api router and auth guard"
```

### Task 2.3：实现 Node HTTP daemon

**Files:**
- Create: `server/daemon.ts`
- Create: `server/health.ts`
- Test: `server/daemon.test.ts`
- Modify: `package.json`

**建议:**

1. 第一阶段使用 `node:http`，避免引入 Express。
2. 增加脚本：`"serve": "tsx server/daemon.ts"` 前需新增 dev dependency `tsx`；若不希望新增依赖，则先只导出 `startMemoryServer()`，CLI 后续接入。
3. daemon 接受已构造的 `MemoryService`，不要在 server 内重复解析 OpenClaw API。

**验证:**

```bash
npx vitest run server/daemon.test.ts api/rest/router.test.ts
```

**提交:**

```bash
git add server package.json package-lock.json
git commit -m "feat: add local memory server daemon"
```

---

## 6. M3：MCP、SDK 与 CLI 入口

### Task 3.1：JS client SDK

**Files:**
- Create: `sdk/js/client.ts`
- Create: `sdk/js/types.ts`
- Test: `sdk/js/client.test.ts`

**能力:**

1. `health()`
2. `storeMemory()`
3. `recall()`
4. `buildContext()`
5. bearer header 注入
6. timeout 和错误包装

**验证:**

```bash
npx vitest run sdk/js
```

**提交:**

```bash
git add sdk/js
git commit -m "feat: add javascript memory client"
```

### Task 3.2：MCP core tools

**Files:**
- Create: `adapters/mcp/server.ts`
- Create: `adapters/mcp/tools.ts`
- Test: `adapters/mcp/tools.test.ts`

**工具:**

1. `memory_save`
2. `memory_recall`
3. `memory_context`
4. `memory_observe`
5. `memory_ingest`
6. `memory_namespaces`
7. `memory_forget`
8. `memory_health`

**策略:**

- 如果引入 MCP SDK，单独提交依赖。
- 第一阶段可以实现 REST proxy 版 MCP，降低与 core 的耦合。

**验证:**

```bash
npx vitest run adapters/mcp
```

**提交:**

```bash
git add adapters/mcp package.json package-lock.json
git commit -m "feat: expose core memory tools over mcp"
```

### Task 3.3：CLI/ltm serve/status

**Files:**
- Modify: `index.ts` 或 Create: `adapters/openclaw/cli.ts`
- Test: `adapters/openclaw/cli.test.ts`

**命令:**

1. `ltm serve`
2. `ltm status`
3. `ltm health`

**验收:**

- 不破坏现有 `ltm stats/tables/search/query/export/scan/cleanup`。
- `ltm status` 能显示 server URL、dbType、table stats。

**验证:**

```bash
npx vitest run adapters/openclaw/cli.test.ts index.test.ts
```

**提交:**

```bash
git add adapters/openclaw/cli.ts index.ts
git commit -m "feat: add memory server cli commands"
```

---

## 7. M4：Scope、Ingestion Pipeline 与新基础表

### Task 4.1：Repository 接口拆分

**Files:**
- Create: `storage/repositories/types.ts`
- Create: `storage/repositories/in-memory.ts`
- Test: `storage/repositories/*.test.ts`

**接口:**

1. `MemoryRepository`
2. `DocumentRepository`
3. `ChunkRepository`
4. `JobRepository`
5. `AuditRepository`

**目的:**

先用 in-memory 实现跑通 core tests，再接 Postgres/Supabase/LanceDB。

**提交:**

```bash
git add storage/repositories
git commit -m "feat: define storage repository contracts"
```

### Task 4.2：Ingestion Pipeline 骨架

**Files:**
- Create: `ingest/pipeline.ts`
- Create: `ingest/types.ts`
- Create: `ingest/chunker.ts`
- Create: `ingest/canonicalize.ts`
- Test: `ingest/*.test.ts`

**能力:**

1. `canonicalize(input)` 输出 Markdown + metadata。
2. `chunkMarkdown(markdown)` 输出 deterministic chunks。
3. `ingest(input)` 写 document/chunks/jobs。
4. 热路径不调用 embeddings。

**验证:**

```bash
npx vitest run ingest
```

**提交:**

```bash
git add ingest
git commit -m "feat: add deterministic ingestion pipeline"
```

### Task 4.3：File-system adapter 包装 scanner

**Files:**
- Create: `ingest/adapters/file-system.ts`
- Test: `ingest/adapters/file-system.test.ts`
- Modify: `scanner/scanner-coordinator.ts` 如需暴露更细粒度接口
- Modify: `adapters/openclaw/tools.ts`

**目标:**

`memory_scan_directory` 走 `IngestionPipeline`，但返回旧统计字段。

**兼容响应新增字段:**

```text
- Jobs queued: N
- Chunks admitted: N
- Chunks dropped: N
```

**验证:**

```bash
npx vitest run ingest/adapters/file-system.test.ts index.test.ts
```

**提交:**

```bash
git add ingest/adapters/file-system.ts scanner adapters/openclaw
git commit -m "feat: route directory scanning through ingestion pipeline"
```

### Task 4.4：Job worker 最小实现

**Files:**
- Create: `ingest/jobs.ts`
- Create: `server/workers.ts`
- Test: `ingest/jobs.test.ts`
- Test: `server/workers.test.ts`

**能力:**

1. enqueue with dedupe key。
2. lease / complete / fail。
3. 过期 lease 恢复。
4. retry backoff。

**验证:**

```bash
npx vitest run ingest/jobs.test.ts server/workers.test.ts
```

**提交:**

```bash
git add ingest/jobs.ts server/workers.ts
git commit -m "feat: add durable job queue semantics"
```

---

## 8. M5：混合检索与 Context Packer

### Task 5.1：TextIndex/BM25 初版

**Files:**
- Create: `storage/indexes/text-index.ts`
- Create: `storage/indexes/in-memory-bm25.ts`
- Test: `storage/indexes/in-memory-bm25.test.ts`

**能力:**

1. index memory/chunk text。
2. keyword search。
3. CJK 初期可按字符 bigram fallback，后续接分词。

**提交:**

```bash
git add storage/indexes
git commit -m "feat: add text index for hybrid retrieval"
```

### Task 5.2：Retrieval Orchestrator

**Files:**
- Create: `retrieval/orchestrator.ts`
- Create: `retrieval/fusion.ts`
- Test: `retrieval/orchestrator.test.ts`
- Test: `retrieval/fusion.test.ts`

**能力:**

1. 并行调用 vector + text + recent。
2. RRF 融合。
3. scope filter。
4. dedupe by source/provenance。
5. 输出 score breakdown。

**验证:**

```bash
npx vitest run retrieval
```

**提交:**

```bash
git add retrieval/orchestrator.ts retrieval/fusion.ts retrieval/*.test.ts
git commit -m "feat: add hybrid retrieval orchestrator"
```

### Task 5.3：Context Packer

**Files:**
- Create: `retrieval/context-packer.ts`
- Test: `retrieval/context-packer.test.ts`
- Modify: `core/memory-service.ts`

**能力:**

1. token budget 粗估。
2. provenance 注入。
3. prompt-safe escape。
4. private content 过滤。

**验证:**

```bash
npx vitest run retrieval/context-packer.test.ts core/memory-service.test.ts
```

**提交:**

```bash
git add retrieval/context-packer.ts core/memory-service.ts
git commit -m "feat: pack retrieved memories into safe context"
```

---

## 9. M6：结构化知识图谱与记忆树

### Task 6.1：Graph domain 与规则抽取

**Files:**
- Create: `graph/types.ts`
- Create: `graph/extractor.ts`
- Create: `graph/repository.ts`
- Test: `graph/extractor.test.ts`
- Test: `graph/repository.test.ts`

**能力:**

1. entity normalize。
2. relation allowlist。
3. evidence chunk 绑定。
4. confidence 阈值。

**提交:**

```bash
git add graph
git commit -m "feat: add structured graph extraction"
```

### Task 6.2：Graph query

**Files:**
- Create: `graph/query.ts`
- Test: `graph/query.test.ts`
- Modify: `core/memory-service.ts`
- Modify: `api/rest/router.ts`

**能力:**

1. entity lookup。
2. BFS depth 1-2。
3. relation evidence fetch。
4. `/v1/graph/query`。

**提交:**

```bash
git add graph/query.ts core/memory-service.ts api/rest/router.ts
git commit -m "feat: query graph relations with evidence"
```

### Task 6.3：Memory Tree buffer/seal

**Files:**
- Create: `tree/types.ts`
- Create: `tree/buffer.ts`
- Create: `tree/seal.ts`
- Test: `tree/buffer.test.ts`
- Test: `tree/seal.test.ts`

**能力:**

1. Source Tree L0 buffer。
2. seal 条件：leaf count/token/stale/manual。
3. extractive summary fallback。
4. summary node evidence。

**提交:**

```bash
git add tree
git commit -m "feat: add memory tree buffering and sealing"
```

### Task 6.4：Topic hotness 与 routing

**Files:**
- Create: `tree/topic.ts`
- Test: `tree/topic.test.ts`
- Modify: `graph/repository.ts`

**能力:**

1. hotness 公式。
2. topic creation/archive threshold。
3. query hit 反馈。
4. topic_route job。

**提交:**

```bash
git add tree/topic.ts tree/topic.test.ts graph/repository.ts
git commit -m "feat: route hot entities into topic trees"
```

### Task 6.5：Global daily digest

**Files:**
- Create: `tree/global.ts`
- Test: `tree/global.test.ts`
- Modify: `server/workers.ts`

**能力:**

1. daily digest job。
2. stale buffer flush。
3. time range query。

**提交:**

```bash
git add tree/global.ts tree/global.test.ts server/workers.ts
git commit -m "feat: build global memory tree digests"
```

---

## 10. M7：Web Console MVP

### Task 7.1：Console REST API

**Files:**
- Create: `console/api.ts`
- Create: `console/types.ts`
- Test: `console/api.test.ts`
- Modify: `api/rest/router.ts`

**Endpoints:**

1. `GET /v1/console/overview`
2. `POST /v1/console/lookup`
3. `GET /v1/console/graph`
4. `GET /v1/console/jobs`

**验收:**

- 所有 endpoint 强制 scope filter。
- private raw content 不返回。

**提交:**

```bash
git add console api/rest/router.ts
git commit -m "feat: add console aggregation api"
```

### Task 7.2：Web Console 静态应用骨架

**Files:**
- Create: `console/web/index.html`
- Create: `console/web/src/main.ts`
- Create: `console/web/src/api.ts`
- Create: `console/web/src/styles.css`
- Modify: `server/daemon.ts`
- Test: `console/web-smoke.test.ts`

**页面:**

1. Overview。
2. Quick Lookup。
3. Graph。
4. Jobs。

**前端策略:**

- 第一版可使用原生 TS + CSS，避免过早引入重框架。
- 如果需要 React/Vite，单独任务引入依赖。

**验证:**

```bash
npx vitest run console
```

**提交:**

```bash
git add console/web server/daemon.ts
git commit -m "feat: serve local web console"
```

### Task 7.3：Quick Lookup 与 Evidence Panel

**Files:**
- Modify: `console/web/src/main.ts`
- Modify: `console/web/src/api.ts`
- Modify: `console/web/src/styles.css`
- Test: `console/web-smoke.test.ts`

**验收:**

1. 输入 query 可调用 `/v1/console/lookup`。
2. 结果显示 score、kind、source、namespace。
3. 点击结果显示 evidence、raw chunk、graph/tree path。
4. raw private 内容不展示。

**提交:**

```bash
git add console/web
git commit -m "feat: add quick lookup console view"
```

---

## 11. M8：迁移、治理与发布收口

### Task 8.1：旧数据迁移工具

**Files:**
- Create: `migration/v4.ts`
- Test: `migration/v4.test.ts`
- Modify: `adapters/openclaw/cli.ts`

**命令:**

```bash
ltm migrate --to-schema v4 --dry-run
ltm migrate --to-schema v4
```

**验收:**

- dry-run 输出 records/chunks/entities/jobs 预计数量。
- 迁移幂等。
- 可按 namespace/table 迁移。

**提交:**

```bash
git add migration adapters/openclaw/cli.ts
git commit -m "feat: add v4 migration command"
```

### Task 8.2：治理操作与审计

**Files:**
- Create: `lifecycle/audit.ts`
- Create: `lifecycle/retention.ts`
- Test: `lifecycle/*.test.ts`
- Modify: `core/memory-service.ts`

**能力:**

1. forget by id/scope/source/session。
2. archive source。
3. TTL/retention sweep。
4. audit logs。

**提交:**

```bash
git add lifecycle core/memory-service.ts
git commit -m "feat: add memory governance and audit"
```

### Task 8.3：文档和发布检查

**Files:**
- Modify: `README.md`
- Modify: `docs/05-api/memory-api.md`
- Modify: `docs/05-api/cli-commands.md`
- Modify: `docs/06-database/schema.md`
- Modify: `docs/07-test/plugin-test.md`
- Modify: `docs/09-changelog/v4.0.0.md`

**内容:**

1. 新配置说明。
2. REST/MCP/SDK 示例。
3. Console 使用说明。
4. migration 指南。
5. 安全部署建议。

**验证:**

```bash
npm test
npx tsc --noEmit
```

**提交:**

```bash
git add README.md docs
git commit -m "docs: document memory middleware v4"
```

---

## 12. 测试矩阵

| 模块 | 必须测试 |
|------|----------|
| core | scope normalization、legacy mapping、store/recall/context/delete |
| adapters/openclaw | 旧工具参数、响应文案、hook capture/recall |
| api/rest | auth、schema validation、错误格式、loopback guard |
| sdk/js | headers、timeout、错误包装 |
| ingest | deterministic chunk、dedupe、job enqueue、scan 兼容 |
| storage | repository contract、scope isolation、legacy adapter |
| retrieval | BM25/vector/RRF、private filter、provenance |
| graph | entity normalize、relation allowlist、BFS evidence |
| tree | buffer/seal、hotness、source/topic/global query |
| console | API contract、scope filter、private raw 隐藏、UI smoke |
| migration | dry-run、幂等、旧表兼容 |

每个里程碑结束必须跑：

```bash
npm test
npx tsc --noEmit
```

如 `npx tsc --noEmit` 因现有问题失败，需要在提交说明或 PR 描述中记录当前失败原因和新增代码是否相关。

---

## 13. 提交拆分建议

建议提交顺序：

1. `feat: add memory core domain types`
2. `feat: map legacy memory entries to core records`
3. `refactor: move prompt safety helpers out of plugin entry`
4. `feat: add default memory service`
5. `feat: wrap database provider for memory service`
6. `refactor: route openclaw plugin through memory service`
7. `feat: add middleware server config`
8. `feat: add rest api router and auth guard`
9. `feat: add local memory server daemon`
10. `feat: add javascript memory client`
11. `feat: expose core memory tools over mcp`
12. `feat: define storage repository contracts`
13. `feat: add deterministic ingestion pipeline`
14. `feat: route directory scanning through ingestion pipeline`
15. `feat: add hybrid retrieval orchestrator`
16. `feat: add structured graph extraction`
17. `feat: add memory tree buffering and sealing`
18. `feat: add console aggregation api`
19. `feat: serve local web console`
20. `docs: document memory middleware v4`

文档类提交可以单独保留，避免和实现混在一起。

---

## 14. 第一阶段推荐执行范围

如果只启动第一轮开发，建议只做 M0-M2：

1. `MemoryScope`、core types、legacy mapping。
2. `MemoryService` 包装现有 `DatabaseProvider` 和 `Embeddings`。
3. OpenClaw 工具转调 service，旧行为不变。
4. REST 最小接口和本机 daemon。
5. 基础 auth guard。

第一轮不做：

1. 新 schema。
2. 图谱。
3. Memory Tree。
4. Web Console。
5. 外部 connector。

这样能先验证中间件边界，不把后续复杂能力和兼容性重构绑在一次改动里。

---

## 15. 验收标准

整体完成标准：

1. 现有 OpenClaw 插件工具完全兼容。
2. 本机 server 可通过 REST 完成 store/recall/context。
3. MCP/SDK 至少能调用核心记忆能力。
4. ingestion 支持 deterministic chunk 和后台 job。
5. recall 支持 hybrid explain 和 provenance。
6. graph/tree 能回答实体关系、source drilldown、topic status、daily digest。
7. Web Console 能完成基础知识速查和整体预览。
8. 所有新路径强制 scope filter。
9. private/prompt injection 内容不会进入未保护 context。
10. `npm test` 通过；`npx tsc --noEmit` 通过或有明确现有失败记录。

---

## 16. 参考文档

- [memory-middleware-architecture.md](../../03-architecture/memory-middleware-architecture.md)
- [structured-knowledge-graph-memory-tree-detail.md](structured-knowledge-graph-memory-tree-detail.md)
- [web-console-design.md](../04.1-overview/web-console-design.md)
- [memory-plugin-design.md](../04.1-overview/memory-plugin-design.md)
- [memory-api.md](../../05-api/memory-api.md)
- [schema.md](../../06-database/schema.md)

---

## 创建信息

- 创建日期：2026-05-31
- 最后更新：2026-05-31
