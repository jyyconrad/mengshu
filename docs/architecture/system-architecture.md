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
| Phase 0 | 架构收口与兼容契约 | ✅ 已实施 | `packages/core/src/service/memory-service.ts`、`packages/core/src/domain/scope.ts`、`packages/core/src/storage/legacy-database-adapter.ts` |
| Phase 1 | Server + REST + MCP | ✅ 已实施 | `ms serve`、REST API、MCP Server 已可用 |
| Phase 2 | Scope/Namespace/Pipeline | ✅ 已实施 | `MemoryScope`、`ingest/pipeline.ts`、`ingest/agent-history/` |
| Phase 3 | 混合检索 | ✅ 已实施 | `packages/core/src/retrieval/orchestrator.ts`、`packages/core/src/retrieval/fusion.ts`、BM25/vector 融合 |
| Phase 4 | 图谱与生命周期 | ✅ 已实施 | `graph/llm-extractor.ts`、`lifecycle/candidate-validator.ts`（11 闸门）、`lifecycle/semantic-dedup.ts` |
| Phase 5 | Memory Tree | 🚧 baseline | `tree/build-tree-handler.ts`、L0-L3 摘要（已有 baseline，待完整 seal/routing） |
| Phase 6 | 产品化与团队部署 | 📋 规划中 | Python SDK、多租户、Connector sync（未启动） |

v1.0.2 已完成 P0-P4 核心算法层交付（LLM 结构化提取 → 11 闸门 validator → 4 套评分 → 语义去重 → L0-L3 树摘要 → 6 因子召回 → 5 槽位注入），算法层设计见 [memory-system-unified-design.md](../04-design/04.2-detail/memory-system-unified-design.md)（v2.0，D-01~D-23 决策）。

### 1.2 当前目录结构

```text
OpenClaw Plugin
  index.ts
    ├─ plugins/openclaw/         # OpenClaw memory slot 插件
    ├─ plugins/codex/            # Codex MCP + skill 插件
    ├─ adapters/openclaw/        # OpenClaw 旧路径兼容层
    ├─ core/                     # 根层旧路径兼容 facade
    ├─ packages/core/src/domain/ # types/scope/service contract/recall-scoring/semantic/profile 等领域能力
    ├─ packages/core/src/service/ # MemoryService
    ├─ packages/core/src/context/ # slot-context-builder / prompt packer / snapshot
    ├─ packages/core/src/runtime/ # paths / registry
    ├─ packages/core/src/scoring/ # value/importance/confidence/scoring weights/hash/text splitter
    ├─ packages/core/src/runtime/llm/ # LLM client、embeddings、extraction rules
    ├─ processing/               # 旧路径兼容 facade
    ├─ packages/core/src/lifecycle/ # 候选区 validator（11 闸门）、语义去重、遗忘、晋升、skill 聚合
    ├─ lifecycle/                # 旧路径兼容 facade
    ├─ packages/core/src/graph/  # LLM 图谱抽取、entity 三级匹配、centrality、schema
    ├─ graph/                    # 旧路径兼容 facade
    ├─ packages/core/src/tree/   # L0-L3 树摘要、leaf 路由、buffer、faithfulness
    ├─ tree/                     # 旧路径兼容 facade
    ├─ packages/core/src/retrieval/ # 召回编排、融合排序（RRF）、prompt 注入防护、上下文打包
    ├─ retrieval/                # 旧路径兼容 facade
    ├─ packages/core/src/ingest/ # 摄入管线、chunker、scanner、agent-history 导入（含 redaction）
    ├─ ingest/ / scanner/        # 旧路径兼容 facade
    ├─ packages/core/src/storage/ # LegacyDatabaseAdapter、repositories/、indexes/
    ├─ storage/                  # 旧路径兼容 facade
    ├─ packages/core/src/db/      # LanceDB、Supabase、Postgres provider
    ├─ db/                       # 旧路径兼容 facade
    ├─ packages/core/src/routing/ # 路由规则引擎
    ├─ packages/core/src/feedback/ # 反馈闭环（collector、in-memory-store）
    ├─ packages/api/src/ + server/ # REST router、SDK、agent-fast-path、Node HTTP daemon
    ├─ packages/mcp/src/          # MCP Server（stdio/transport-agnostic facade）
    ├─ packages/ui/src/console/   # Console 聚合 API（console/* 为兼容 re-export）
    ├─ packages/ui/src/web/       # Web Console 静态前端
    └─ tests/eval/                # Golden set 评估框架（runners/goldens/fixtures）
```

## 运行模式

| 模式 | 状态 | 说明 |
|------|------|------|
| Embedded OpenClaw plugin | ✅ v1.0.2 | `index.ts` 注册工具、钩子和 CLI（`ms` 命令组） |
| 本机 server | ✅ v1.0.2 | `ms serve` 启动 Node HTTP server，默认 `127.0.0.1:3847` |
| MCP facade | ✅ v1.0.2 | 提供 stdio MCP Server（`packages/mcp/src/stdio-server.ts`） |
| JS SDK | ✅ v1.0.2 | 面向 REST API 的 client（`packages/api/src/sdk/client.ts`，`adapters/sdk/*`、`sdk/js/*` 兼容旧路径） |
| Remote/backend-proxy | 📋 规划 | 配置类型已保留（Phase 6），完整实现待 v0.5+ |

## 核心链路（v1.0.2 实施状态）

### 保存记忆（已实施）

```text
memory_store / REST / MCP
  -> DefaultMemoryService.storeMemory()
  -> lifecycle/candidate-validator.ts（11 闸门）
  -> packages/core/src/scoring/value-score.ts（准入决策）
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
  -> packages/core/src/retrieval/orchestrator.ts
  -> 并行查询：vector + BM25 + recent + graph
  -> packages/core/src/retrieval/fusion.ts（RRF 融合）
  -> packages/core/src/domain/recall-scoring.ts（6 因子重排）
  -> packages/core/src/retrieval/context-packer.ts（token budget + provenance）
  -> RecallResult
```

v1.0.2 已从纯向量检索升级为混合检索（Phase 3）。

### Agent 快路径（已实施 5 槽位注入）

```text
memory_context_fast / POST /v1/agent/context
  -> packages/api/src/agent-fast-path/index.ts
  -> packages/core/src/context/slot-context-builder.ts（5 问题语义协议）
  -> packages/core/src/context/slot-snapshot.ts
  -> 5 slot context（profile/task_context/rules/experience/resource）+ telemetry
```

v1.0.2 已实现 5 问题语义协议（MemorySemanticType）的快路径注入。

### 目录扫描与 agent-history 预览

```text
memory_scan_directory / ms scan
  -> ingest/adapters/file-system.ts
  -> ingest/canonicalize.ts
  -> ingest/chunker.ts（deterministic chunk ID）
  -> ingest/pipeline.ts
  -> documents / chunks / jobs / audit baseline

ms project ingest-history --dry-run
  -> ingest/agent-history/
  -> redaction.ts（敏感信息过滤）
  -> packages/core/src/ingest/sources/jsonl-parser.ts（通用 JSONL 解析）
  -> plugins/{codex,claude-code,openclaw}/sources（产品来源适配）
  -> dry-run 报告（不写库）
```

v1.0.2 已实现 agent-history source adapter 骨架与 dry-run 预览；正式 apply 写库留给后续 evidence 导入阶段。

### LLM 图谱抽取（已实施）

```text
会话事件流 / document
  -> packages/core/src/runtime/llm/llm-client.ts.extractStructured()
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
| Provider contract | `packages/core/src/db/types.ts` | `MemoryEntry` 和 `DatabaseProvider` 契约（legacy 兼容） |
| Provider factory | `packages/core/src/db/factory.ts` | 根据配置创建 LanceDB、Supabase、Postgres 或 hybrid provider |
| Legacy adapter | `packages/core/src/storage/legacy-database-adapter.ts` | 将 legacy provider 暴露为 core repository（兼容层） |
| In-memory baseline | `packages/core/src/storage/repositories/in-memory.ts` | 中间件 contract 测试和 baseline |
| Text index | `packages/core/src/storage/indexes/in-memory-bm25.ts` | BM25/文本检索 baseline（Phase 3） |
| Candidate store | `packages/core/src/lifecycle/candidate-types.ts` | 候选区状态机（11 闸门 + TTL 30d） |
| Job queue | `packages/core/src/ingest/pipeline.ts` | 异步 embedding/抽取/摘要任务队列 |

v1.0.2 存储层保留 legacy provider（LanceDB/Supabase/Postgres）作为向量存储后端，中间件能力（候选区/去重/图谱/树）通过 adapter + in-memory baseline 增量落地。

## 对外接口（v1.0.2 状态）

| 接口 | 文件 | 状态 |
|------|------|------|
| OpenClaw tools | `plugins/openclaw/src/tools.ts` | ✅ 可用（memory_store/recall/scan/cleanup/context_fast；`adapters/openclaw/tools.ts` 兼容转发） |
| OpenClaw hooks | `plugins/openclaw/src/hooks.ts` | ✅ 自动召回和自动捕获（autoRecall/autoCapture；`adapters/openclaw/hooks.ts` 兼容转发） |
| CLI（`ms` 命令组） | `packages/api/src/cli/ms.ts`、`plugins/openclaw/src/cli/*` | ✅ 可用（init/doctor/why/recall/forget/project ingest-history/stats/search/scan/serve/mcp；`adapters/openclaw/cli-*` 兼容转发） |
| REST API | `packages/api/src/rest/router.ts`、`server/daemon.ts` | ✅ 可用（/v1/health、/v1/memories、/v1/recall、/v1/context） |
| MCP Server | `packages/mcp/src/server.ts`、`packages/mcp/src/stdio-server.ts`、`packages/mcp/src/tools.ts` | ✅ stdio 可用（8 个核心工具） |
| JS SDK | `packages/api/src/sdk/client.ts` | ✅ REST client baseline（`adapters/sdk/*`、`sdk/js/*` 兼容旧路径） |
| Web Console | `packages/ui/src/console/api.ts`、`packages/ui/src/web/` | ✅ baseline（Overview/Lookup/Graph/Jobs 4 个视图） |
| Eval 框架 | `tests/eval/runners/`、`tests/eval/goldens/` | ✅ golden set 评估（6 套 suite：extraction/scoring/recall/dedup/tree/injection） |

v1.0.2 CLI 升级为 `ms` 命令组（与 `mengshu` 别名），支持交互式配置向导（`ms init`）、诊断（`ms doctor`）、评分追溯（`ms why`）、召回解释（`ms recall --explain`）、agent-history dry-run 预览（`ms project ingest-history`）和项目管理（`ms project`）。

## 架构决策（v1.0.2 确认状态）

### 1. OpenClaw 只是 adapter（✅ 已落地）

业务逻辑已迁入 `packages/core/src/{domain,service,context,runtime,scoring,retrieval,db,storage,ingest,lifecycle,graph,tree}`。根 `core/`、`processing/`、`retrieval/`、`db/`、`storage/`、`ingest/`、`scanner/`、`lifecycle/`、`graph/`、`tree/` 和 `index.ts` 保留兼容入口，不再包含对应核心业务逻辑。

### 2. 保留 legacy provider（✅ 已确认）

LanceDB、Supabase、Postgres provider 继续作为向量存储后端。中间件能力（候选区/去重/图谱/树/4 套评分）通过 `LegacyDatabaseAdapter` 和新模块增量落地，不重写存储层。

### 3. Scope 是新 API 的强边界（✅ 已强制）

REST、MCP、SDK、console 和 graph/tree 查询都使用 `MemoryScope` 或可规范化的 scope input（`packages/core/src/domain/scope.ts`，`core/scope.ts` 为旧路径兼容转发）。所有 API 必须解析出 scope，server/remote 模式不得绕过 scope filter。

### 4. 快路径不等待重语义处理（✅ 已分离）

Agent 启动上下文优先走缓存和轻量构建（`packages/api/src/agent-fast-path/index.ts`）；embedding、抽取、graph/tree、summary 等重处理放到 warm/cold path（后台 job 队列）。

### 5. LLM 可以建议，不可单独裁决（✅ 算法层铁律）

所有入库动作必须经过 deterministic validator（`lifecycle/candidate-validator.ts` 11 闸门）。所有记忆必须有 evidence。摘要节点不能创造事实（`tree/faithfulness.ts`）。冲突比合并更重要（`lifecycle/semantic-dedup.ts` 冲突检测）。

### 6. 四套评分分工明确（✅ 已落地 D-01~D-03）

- **valueScore**（`packages/core/src/scoring/value-score.ts`）：准入决策（<0.40 drop / 0.40-0.55 low / 0.55-0.88 pending / ≥0.88 active）
- **importance**（`packages/core/src/scoring/importance-score.ts`）：召回排序 + score breakdown（4 项：salience_llm 0.45 + sourceAuthority 0.20 + explicitnessBonus 0.20 + typePrior 0.15）
- **confidence**（`packages/core/src/scoring/confidence-score.ts`）：去重治理 + 证据晋升（多证据贝叶斯累积）
- **hotness**（`packages/core/src/graph/query-hits-tracker.ts`）：topic tree 路由 + 归档（5 项：mention + source + recency + centrality + queryHits）

权重配置统一在 `packages/core/src/scoring/scoring-weights.ts`（SCORING_WEIGHTS_V1），不分散到各模块。

### 7. Profile 三层分层（✅ 已落地 D-04/D-13）

`project → app → global` 三层分层（`packages/core/src/domain/profile-layer.ts`，`core/profile-layer.ts` 为旧路径兼容转发），召回优先级由近及远。避免项目偏好污染全局画像，`targetScope` 包含 `app` 层（6 档：message/turn/session/project/app/global）。

---

## v1.0.2 核心能力总结

### 已交付（P0-P4 算法层）

1. **LLM 结构化提取**：`extractStructured` 支持 JSON Schema 约束输出（`packages/core/src/runtime/llm/llm-client.ts`），图谱抽取 entity + relation + attribute 三元组（`packages/core/src/graph/llm-extractor.ts`）
2. **11 闸门 validator**：`packages/core/src/lifecycle/candidate-validator.ts`，所有入库动作经 deterministic 校验（铁律：LLM 可以建议，不可单独裁决）
3. **4 套评分体系**：value（准入）/importance（召回）/confidence（去重）/hotness（树路由），权重统一在 `packages/core/src/scoring/scoring-weights.ts`（SCORING_WEIGHTS_V1）
4. **语义去重**：`packages/core/src/lifecycle/semantic-dedup.ts`，embedding 阈值 0.90/0.82（合并/judge），冲突检测优于盲目合并
5. **L0-L3 树摘要**：`packages/core/src/tree/build-tree-handler.ts`、`packages/core/src/tree/seal.ts`、`packages/core/src/tree/leaf-routing.ts`，source/topic/global 三类树（baseline，待完整 seal/routing）
6. **6 因子召回**：`packages/core/src/domain/recall-scoring.ts`，混合检索（vector + BM25 + recent + graph）+ RRF 融合（`packages/core/src/retrieval/fusion.ts`）+ 6 因子重排
7. **5 槽位注入**：`packages/core/src/context/slot-context-builder.ts`，5 问题语义协议（profile/task_context/rules/experience/resource）快路径注入（`packages/api/src/agent-fast-path/index.ts`）
8. **Scope 隔离**：`packages/core/src/domain/scope.ts`，6 档 targetScope（message/turn/session/project/app/global），运行时按 scope 策略过滤
9. **Agent-history 导入**：`packages/core/src/ingest/agent-history/`，含 redaction（`redaction.ts`）和批量去重
10. **Eval 评估体系**：`tests/eval/runners/`、`tests/eval/goldens/`，golden set 驱动，6 类场景覆盖（extraction/scoring/recall/dedup/tree/injection）

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
