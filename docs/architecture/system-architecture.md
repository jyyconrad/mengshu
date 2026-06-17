# 系统架构

> **状态**: 架构演进记录（2026-05-30 v4 方案 + v1.0.2 实施状态）  
> **当前版本**: v1.0.2（P0-P4 算法层已交付）  
> **单一事实来源**: 算法层设计见 [memory-system-unified-design.md](../04-design/04.2-detail/memory-system-unified-design.md) (v2.0)  
> **架构方案**: 中间件化路线见 [memory-middleware-architecture.md](./memory-middleware-architecture.md) (v4)

本文描述 mengshu 当前代码架构与实施状态。v4 架构方案（2026-05-30）已在 v1.0.2 中部分实施（见 §1.1 实施对照表），未来规划 Phase 见 memory-middleware-architecture.md。

## 总体结构

### 1.1 v1.0.2 实施状态对照

| Phase | 范围 | v1.0.2 状态 | 说明 |
|-------|------|------------|------|
| Phase 0 | 架构收口与兼容契约 | ✅ 已实施 | `core/memory-service.ts`、`core/scope.ts`、`storage/legacy-database-adapter.ts` |
| Phase 1 | Server + REST + MCP | ✅ 已实施 | `ms serve`、REST API、MCP Server 已可用 |
| Phase 2 | Scope/Namespace/Pipeline | ✅ 已实施 | `MemoryScope`、`ingest/pipeline.ts`、`ingest/agent-history/` |
| Phase 3 | 混合检索 | ✅ 已实施 | `retrieval/orchestrator.ts`、`retrieval/fusion.ts`、BM25/vector 融合 |
| Phase 4 | 图谱与生命周期 | ✅ 已实施 | `graph/llm-extractor.ts`、`lifecycle/candidate-validator.ts`（11 闸门）、`lifecycle/semantic-dedup.ts` |
| Phase 5 | Memory Tree | 🚧 baseline | `tree/build-tree-handler.ts`、L0-L3 摘要（已有 baseline，待完整 seal/routing） |
| Phase 6 | 产品化与团队部署 | 📋 规划中 | Python SDK、多租户、Connector sync（未启动） |

v1.0.2 已完成 P0-P4 核心算法层交付（LLM 结构化提取 → 11 闸门 validator → 4 套评分 → 语义去重 → L0-L3 树摘要 → 6 因子召回 → 5 槽位注入），算法层设计见 [memory-system-unified-design.md](../04-design/04.2-detail/memory-system-unified-design.md)（v2.0，D-01~D-23 决策）。

### 1.2 当前目录结构

```text
OpenClaw Plugin
  index.ts
    ├─ adapters/openclaw/        # OpenClaw tools、hooks、CLI adapter (ms 命令组)
    ├─ core/                     # MemoryService、scope、领域类型、profile 分层、recall-scoring
    ├─ processing/               # 4 套评分（value/importance/confidence/hotness）、LLM 客户端、extraction rules
    ├─ lifecycle/                # 候选区 validator（11 闸门）、语义去重、遗忘、晋升、skill 聚合
    ├─ graph/                    # LLM 图谱抽取、entity 三级匹配、centrality、schema
    ├─ tree/                     # L0-L3 树摘要、leaf 路由、buffer、faithfulness
    ├─ retrieval/                # 召回编排、融合排序（RRF）、prompt 注入防护、上下文打包
    ├─ ingest/                   # 摄入管线、chunker、agent-history 导入（含 redaction）
    ├─ storage/                  # LegacyDatabaseAdapter、repositories/、indexes/
    ├─ db/providers/             # LanceDB、Supabase、Postgres provider
    ├─ routing/                  # 路由规则引擎
    ├─ feedback/                 # 反馈闭环（collector、in-memory-store）
    ├─ api/rest/ + server/       # REST router、Node HTTP daemon、agent-fast-path
    ├─ adapters/mcp/             # MCP Server（stdio/transport-agnostic facade）
    ├─ sdk/js/                   # JS client
    ├─ console/                  # Web Console API（Overview/Lookup/Graph/Jobs baseline）
    └─ eval/                     # Golden set 评估框架（runners/goldens/fixtures）
```

## 运行模式

| 模式 | 状态 | 说明 |
|------|------|------|
| Embedded OpenClaw plugin | ✅ v1.0.2 | `index.ts` 注册工具、钩子和 CLI（`ms` 命令组） |
| 本机 server | ✅ v1.0.2 | `ms serve` 启动 Node HTTP server，默认 `127.0.0.1:3847` |
| MCP facade | ✅ v1.0.2 | 提供 stdio MCP Server（`adapters/mcp/stdio-server.ts`） |
| JS SDK | ✅ v1.0.2 | 面向 REST API 的 client（`sdk/js/client.ts`） |
| Remote/backend-proxy | 📋 规划 | 配置类型已保留（Phase 6），完整实现待 v0.5+ |

## 核心链路（v1.0.2 实施状态）

### 保存记忆（已实施）

```text
memory_store / REST / MCP
  -> DefaultMemoryService.storeMemory()
  -> lifecycle/candidate-validator.ts（11 闸门）
  -> processing/value-score.ts（准入决策）
  -> lifecycle/semantic-dedup.ts（去重）
  -> LegacyDatabaseAdapter
  -> DatabaseProvider
  -> LanceDB / Supabase / Postgres
```

v1.0.2 已集成候选区 validator（11 闸门）和语义去重，不再是直接写入。

### 召回记忆（已实施混合检索）

```text
memory_recall / REST / MCP
  -> DefaultMemoryService.recall()
  -> retrieval/orchestrator.ts
  -> 并行查询：vector + BM25 + recent + graph
  -> retrieval/fusion.ts（RRF 融合）
  -> core/recall-scoring.ts（6 因子重排）
  -> retrieval/context-packer.ts（token budget + provenance）
  -> RecallResult
```

v1.0.2 已从纯向量检索升级为混合检索（Phase 3）。

### Agent 快路径（已实施 5 槽位注入）

```text
memory_context_fast / POST /v1/agent/context
  -> api/agent-fast-path.ts
  -> core/slot-context-builder.ts（5 问题语义协议）
  -> core/slot-snapshot.ts
  -> 5 slot context（profile/task_context/rules/experience/resource）+ telemetry
```

v1.0.2 已实现 5 问题语义协议（MemorySemanticType）的快路径注入。

### 目录扫描（已实施 agent-history 导入）

```text
memory_scan_directory / ms scan
  -> ingest/adapters/file-system.ts
  -> ingest/canonicalize.ts
  -> ingest/chunker.ts（deterministic chunk ID）
  -> ingest/pipeline.ts
  -> documents / chunks / jobs / audit baseline

ms import <path> / agent-history 导入
  -> ingest/agent-history/
  -> redaction.ts（敏感信息过滤）
  -> 批量 ingest + 去重
```

v1.0.2 已实现 agent-history 导入（含 redaction）与 deterministic chunk ID 机制（Phase 2）。

### LLM 图谱抽取（已实施）

```text
会话事件流 / document
  -> processing/llm-client.ts.extractStructured()
  -> graph/llm-extractor.ts（entity + relation + attribute 三元组）
  -> graph/extraction-validator.ts（schema 校验）
  -> graph/entity-resolver.ts（三级匹配：exact / fuzzy / semantic）
  -> graph/centrality-calculator.ts（hotness 计算）
  -> graph/schema.ts（entity types / relation allowlist）
```

v1.0.2 已实现 LLM 结构化图谱抽取（Phase 4），采用 JSON Schema 约束输出 + 三级实体匹配。

## 存储层（v1.0.2 状态）

| 层 | 文件 | 说明 |
|----|------|------|
| Provider contract | `db/types.ts` | `MemoryEntry` 和 `DatabaseProvider` 契约（legacy 兼容） |
| Provider factory | `db/factory.ts` | 根据配置创建 LanceDB、Supabase、Postgres 或 hybrid provider |
| Legacy adapter | `storage/legacy-database-adapter.ts` | 将 legacy provider 暴露为 core repository（兼容层） |
| In-memory baseline | `storage/repositories/in-memory.ts` | 中间件 contract 测试和 baseline |
| Text index | `storage/indexes/in-memory-bm25.ts` | BM25/文本检索 baseline（Phase 3） |
| Candidate store | `lifecycle/candidate-types.ts` | 候选区状态机（11 闸门 + TTL 30d） |
| Job queue | `ingest/pipeline.ts` | 异步 embedding/抽取/摘要任务队列 |

v1.0.2 存储层保留 legacy provider（LanceDB/Supabase/Postgres）作为向量存储后端，中间件能力（候选区/去重/图谱/树）通过 adapter + in-memory baseline 增量落地。

## 对外接口（v1.0.2 状态）

| 接口 | 文件 | 状态 |
|------|------|------|
| OpenClaw tools | `index.ts`、`adapters/openclaw/tools.ts` | ✅ 可用（memory_store/recall/scan/cleanup） |
| OpenClaw hooks | `adapters/openclaw/hooks.ts` | ✅ 自动召回和自动捕获（autoRecall/autoCapture） |
| CLI（`ms` 命令组） | `index.ts`、`adapters/openclaw/cli-*.ts` | ✅ 可用（init/doctor/why/recall/forget/import/project/stats/search/scan/serve/mcp） |
| REST API | `api/rest/router.ts`、`server/daemon.ts` | ✅ 可用（/v1/health、/v1/memories、/v1/recall、/v1/context） |
| MCP Server | `adapters/mcp/server.ts`、`adapters/mcp/stdio-server.ts`、`adapters/mcp/tools.ts` | ✅ stdio 可用（8 个核心工具） |
| JS SDK | `sdk/js/client.ts` | ✅ REST client baseline |
| Web Console | `console/api.ts`、`console/web/` | ✅ baseline（Overview/Lookup/Graph/Jobs 4 个视图） |
| Eval 框架 | `eval/runners/`、`eval/goldens/` | ✅ golden set 评估（6 套 suite：extraction/scoring/recall/dedup/tree/injection） |

v1.0.2 CLI 升级为 `ms` 命令组（与 `mengshu` 别名），支持交互式配置向导（`ms init`）、诊断（`ms doctor`）、评分追溯（`ms why`）、召回解释（`ms recall --explain`）、agent-history 导入（`ms import`）和项目管理（`ms project`）。

## 架构决策（v1.0.2 确认状态）

### 1. OpenClaw 只是 adapter（✅ 已落地）

业务逻辑已迁入 `core/`、`ingest/`、`retrieval/`、`storage/`、`lifecycle/`、`graph/`、`tree/`。`index.ts` 保留插件注册、配置装配和兼容入口，不再包含核心业务逻辑。

### 2. 保留 legacy provider（✅ 已确认）

LanceDB、Supabase、Postgres provider 继续作为向量存储后端。中间件能力（候选区/去重/图谱/树/4 套评分）通过 `LegacyDatabaseAdapter` 和新模块增量落地，不重写存储层。

### 3. Scope 是新 API 的强边界（✅ 已强制）

REST、MCP、SDK、console 和 graph/tree 查询都使用 `MemoryScope` 或可规范化的 scope input（`core/scope.ts`）。所有 API 必须解析出 scope，server/remote 模式不得绕过 scope filter。

### 4. 快路径不等待重语义处理（✅ 已分离）

Agent 启动上下文优先走缓存和轻量构建（`api/agent-fast-path.ts`）；embedding、抽取、graph/tree、summary 等重处理放到 warm/cold path（后台 job 队列）。

### 5. LLM 可以建议，不可单独裁决（✅ 算法层铁律）

所有入库动作必须经过 deterministic validator（`lifecycle/candidate-validator.ts` 11 闸门）。所有记忆必须有 evidence。摘要节点不能创造事实（`tree/faithfulness.ts`）。冲突比合并更重要（`lifecycle/semantic-dedup.ts` 冲突检测）。

### 6. 四套评分分工明确（✅ 已落地 D-01~D-03）

- **valueScore**（`processing/value-score.ts`）：准入决策（<0.40 drop / 0.40-0.55 low / 0.55-0.88 pending / ≥0.88 active）
- **importance**（`processing/importance-score.ts`）：召回排序 + score breakdown（4 项：salience_llm 0.45 + sourceAuthority 0.20 + explicitnessBonus 0.20 + typePrior 0.15）
- **confidence**（`processing/confidence-score.ts`）：去重治理 + 证据晋升（多证据贝叶斯累积）
- **hotness**（`graph/query-hits-tracker.ts`）：topic tree 路由 + 归档（5 项：mention + source + recency + centrality + queryHits）

权重配置统一在 `processing/scoring-weights.ts`（SCORING_WEIGHTS_V1），不分散到各模块。

### 7. Profile 三层分层（✅ 已落地 D-04/D-13）

`project → app → global` 三层分层（`core/profile-layer.ts`），召回优先级由近及远。避免项目偏好污染全局画像，`targetScope` 包含 `app` 层（6 档：message/turn/session/project/app/global）。

---

## v1.0.2 核心能力总结

### 已交付（P0-P4 算法层）

1. **LLM 结构化提取**：`extractStructured` 支持 JSON Schema 约束输出（`processing/llm-client.ts`），图谱抽取 entity + relation + attribute 三元组（`graph/llm-extractor.ts`）
2. **11 闸门 validator**：`lifecycle/candidate-validator.ts`，所有入库动作经 deterministic 校验（铁律：LLM 可以建议，不可单独裁决）
3. **4 套评分体系**：value（准入）/importance（召回）/confidence（去重）/hotness（树路由），权重统一在 `processing/scoring-weights.ts`（SCORING_WEIGHTS_V1）
4. **语义去重**：`lifecycle/semantic-dedup.ts`，embedding 阈值 0.90/0.82（合并/judge），冲突检测优于盲目合并
5. **L0-L3 树摘要**：`tree/build-tree-handler.ts`、`tree/seal.ts`、`tree/leaf-routing.ts`，source/topic/global 三类树（baseline，待完整 seal/routing）
6. **6 因子召回**：`core/recall-scoring.ts`，混合检索（vector + BM25 + recent + graph）+ RRF 融合（`retrieval/fusion.ts`）+ 6 因子重排
7. **5 槽位注入**：`core/slot-context-builder.ts`，5 问题语义协议（profile/task_context/rules/experience/resource）快路径注入（`api/agent-fast-path.ts`）
8. **Scope 隔离**：`core/scope.ts`，6 档 targetScope（message/turn/session/project/app/global），运行时按 scope 策略过滤
9. **Agent-history 导入**：`ingest/agent-history/`，含 redaction（`redaction.ts`）和批量去重
10. **Eval 评估体系**：`eval/runners/`、`eval/goldens/`，golden set 驱动，6 类场景覆盖（extraction/scoring/recall/dedup/tree/injection）

### 未来规划（Phase 5-6，见 memory-middleware-architecture.md）

| Phase | 范围 | 预计版本 |
|-------|------|---------|
| Phase 5 完整 | Memory Tree 完整 seal/routing/daily digest | v0.3-v0.5 |
| Phase 6 | Python SDK、多租户、Connector sync、团队部署 | v0.5+ |

### 相关文档

- **算法层单一事实来源**：[memory-system-unified-design.md](../design/memory-system-unified-design.md)（v2.0，D-01~D-23 决策）
- **架构方案**：[memory-middleware-architecture.md](memory-middleware-architecture.md)（v4，Phase 0-6 规划）
- **产品定位**：[product-positioning.md](product-positioning.md)（本地优先记忆中间件）
- **技术栈**：[technology-stack.md](technology-stack.md)（TypeScript + LanceDB + OpenAI embedding）

---

**创建日期**：2026-05-30（v4 架构方案）  
**最后更新**：2026-06-16（v1.0.2 实施状态）
