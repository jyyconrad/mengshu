# 系统架构

> **状态**: 架构演进记录（2026-07-12 运行态校准）
> **当前版本**: v1.0.7（算法资产较完整，生产主链升级中；不可按 P0-P4 全量运行态理解）
> **单一事实来源**: 算法层设计见 [memory-system-unified-design.md](../design/memory-system-unified-design.md) (v2.0)
> **架构路线**: 本文只描述当前公开边界；未接入生产主链的能力不按已交付计算

本文描述 mengshu 当前代码架构与实施状态。表中的“代码资产”表示模块和测试已经存在，不等于所有入口已经在生产 RuntimeHost 中调用。当前默认 production `ms serve` 只有在注入同一 PostgreSQL provider 的 native fenced job capability 后才允许监听；默认组合缺少该能力时会 fail-closed。

## 总体结构

### 1.1 当前实施状态对照

| Phase | 范围 | 当前状态 | 说明 |
|-------|------|------------|------|
| Phase 0 | 架构收口与兼容契约 | ✅ 已实施 | `packages/core/src/service/memory-service.ts`、`packages/core/src/domain/scope.ts`、`packages/core/src/storage/legacy-database-adapter.ts` |
| Phase 1 | Server + REST + MCP | ✅ PostgreSQL 安全组合 | RuntimeHost 使用 provider-owned durable capability；缺失时在监听前 fail-closed |
| Phase 2 | Scope/Namespace/Pipeline | ✅ 合同与迁移工具 | AuthorityScope 已接主要入口；scope/semantic type 迁移均为 dry-run 优先并支持 quarantine |
| Phase 3 | 混合检索 | ✅ governed 主链 | vector/BM25/graph/tree 候选统一经过 hard filter 和 6 因子 receipt |
| Phase 4 | 图谱与生命周期 | ✅ native durable 组合 | Write Kernel、candidate、active derivation、Entity/Work Memory Graph 和 evidence link 已接线 |
| Phase 5 | Memory Tree 与上下文装配 | ✅ 渐进披露与 private overlay | source/topic/global、SlotSnapshotV2、R0-R4、private Asset/Loadout 和 durable invalidation 已接线 |
| Phase 6 | 产品化与团队部署 | 📋 规划中 | Python SDK、多租户、Connector sync（未启动） |

LLM 结构化提取、11 闸门 validator、4 套评分、语义去重、L0-L3 树摘要、6 因子召回和 5 槽位注入均有代码资产；其运行态接入程度不同。算法规格见 [memory-system-unified-design.md](../design/memory-system-unified-design.md)（D-01~D-23 决策）。

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
| Embedded OpenClaw plugin | ✅ 代码入口 | `index.ts` 注册工具、钩子和 CLI（`ms` 命令组） |
| 本机 server | 🚧 fail-closed | RuntimeHost/HTTP daemon 已实现；默认 production 组合缺少 native fenced handlers 时不启动 listener |
| MCP facade | ✅ 代码入口 | 提供 stdio MCP Server（`packages/mcp/src/stdio-server.ts`） |
| JS SDK | ✅ baseline | 面向 REST API 的 client（`packages/api/src/sdk/client.ts`，`adapters/sdk/*`、`sdk/js/*` 兼容旧路径） |
| Remote/backend-proxy | 📋 规划 | 配置类型已保留（Phase 6），完整实现待 v0.5+ |

## 核心链路（代码资产与运行态边界）

### 保存记忆（目标链路，接入中）

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

validator、准入和语义去重已有实现，但历史兼容入口和 provider transaction 尚未全部收敛到一套 Write Kernel。判断某入口是否安全时，应以该入口的真实调用链和测试为准，不能仅以模块存在为准。

### 召回记忆（目标链路，接入中）

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

混合检索模块已实现；真实入口仍需逐一验证是否实例化 orchestrator、是否执行 authority/scope 与 embedding-space guard。

### Agent 快路径（5 槽位与渐进披露）

```text
memory_context_fast / POST /v1/agent/context
  -> packages/api/src/agent-fast-path/index.ts
  -> packages/core/src/context/slot-context-builder.ts（5 问题语义协议）
  -> packages/core/src/context/slot-snapshot.ts（SlotSnapshotV2）
  -> exact-scope AgentLoadout + private memory_view（可选增强）
  -> 5 slot context（profile/task_context/rules/experience/resource）
  -> source/topic/global navigation -> L0 evidence
```

5 type 是面向 Agent 上下文的语义视图，不能替代通用 MemoryKind。历史数据只有显式合法或高置信映射才进入 5 槽位；其余记录保留为 kind-only/lookup-only。Asset/Loadout 是可独立关闭的增强层，不能越过 scope、lifecycle、risk/conflict、召回门槛和 token budget。

上下文采用 R0-R4 渐进披露：R0 为 5 槽位必读，R1/R2 为 source/topic/global 与资产导航，R3 为受控资源读取，R4 回到原始 evidence。Asset/Loadout 版本变更通过 durable outbox 按 scope fingerprint 失效缓存，读取时仍再次校验 revoked/stale 状态。

最终装配按槽位累计消费预算：先扣除原生正文，再按 6 因子分数选择 Asset；binding priority 仅用于同分排序，超预算内容降级为导航引用。每个 slot 的历史内容通过统一 prompt safety 转义，并声明为不可信数据，不能构造 developer/assistant/tool 指令。

PostgreSQL v22 将最终 `ContextAssemblyReceipt` 持久化，记录 plan、Loadout/binding、过滤与降级、memory/tree/asset/evidence 引用、warning、稳定/动态 hash 和 expiry。CLI/MCP 只能在 host-owned exact private session 读取；receipt 缺失或写失败不阻断原生 5 槽位，只返回显式 warning。

Tree 到 Asset 的晋升继续执行 D-07：extractive 摘要受 500 token deterministic gate 限制，高风险 abstractive 摘要必须已有 faithfulness 验证，旧节点缺证明时 fail-closed。

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

已实现 agent-history source adapter 骨架与 dry-run 预览；正式 apply 写库留给后续 evidence 导入阶段。

### LLM 图谱抽取（代码资产）

```text
会话事件流 / document
  -> packages/core/src/runtime/llm/llm-client.ts.extractStructured()
  -> graph/llm-extractor.ts（entity + relation + attribute 三元组）
  -> graph/extraction-validator.ts（schema 校验）
  -> graph/entity-resolver.ts（三级匹配：exact / fuzzy / semantic）
  -> graph/centrality-calculator.ts（hotness 计算）
  -> graph/schema.ts（entity types / relation allowlist）
```

LLM 结构化图谱抽取采用 JSON Schema 约束输出 + 三级实体匹配；默认 production RuntimeHost 尚未注册其 native fenced handler。

## 存储层（当前状态）

| 层 | 文件 | 说明 |
|----|------|------|
| Provider contract | `packages/core/src/db/types.ts` | `MemoryEntry` 和 `DatabaseProvider` 契约（legacy 兼容） |
| Provider factory | `packages/core/src/db/factory.ts` | 根据配置创建 LanceDB、Supabase、Postgres 或 hybrid provider |
| Legacy adapter | `packages/core/src/storage/legacy-database-adapter.ts` | 将 legacy provider 暴露为 core repository（兼容层） |
| In-memory baseline | `packages/core/src/storage/repositories/in-memory.ts` | 中间件 contract 测试和 baseline |
| Text index | `packages/core/src/storage/indexes/in-memory-bm25.ts` | BM25/文本检索 baseline（Phase 3） |
| Candidate store | `packages/core/src/lifecycle/candidate-types.ts` | 候选区状态机（11 闸门 + TTL 30d） |
| Job queue | `packages/core/src/storage/repositories/job-v2.ts`、`postgres-job-v2.ts`、`server/workers-v2.ts` | durable job v2、lease/fencing/DLQ 已实现；native effect handlers 尚未完成生产组合 |

存储层保留 legacy provider（LanceDB/Supabase/Postgres）作为向量存储后端，中间件能力（候选区/去重/图谱/树）通过 adapter + baseline 增量落地；PostgreSQL 是 durable jobs/effect fencing 的参考实现。

## 对外接口（当前状态）

| 接口 | 文件 | 状态 |
|------|------|------|
| OpenClaw tools | `plugins/openclaw/src/tools.ts` | ✅ 可用（memory_store/recall/scan/cleanup/context_fast；`adapters/openclaw/tools.ts` 兼容转发） |
| OpenClaw hooks | `plugins/openclaw/src/hooks.ts` | ✅ 自动召回和自动捕获（autoRecall/autoCapture；`adapters/openclaw/hooks.ts` 兼容转发） |
| CLI（`ms` 命令组） | `packages/api/src/cli/ms.ts`、`plugins/openclaw/src/cli/*` | 部分可用；短命令有生命周期清理，production `serve` 受 native capability 门禁保护 |
| REST API | `packages/api/src/rest/router.ts`、`server/daemon.ts` | router/daemon 已实现；是否可监听取决于 RuntimeHost 安全组合 |
| MCP Server | `packages/mcp/src/server.ts`、`packages/mcp/src/stdio-server.ts`、`packages/mcp/src/tools.ts` | ✅ stdio 可用，含 5 槽位、tree/evidence 导航和只读 Asset 工具 |
| JS SDK | `packages/api/src/sdk/client.ts` | ✅ REST client baseline（`adapters/sdk/*`、`sdk/js/*` 兼容旧路径） |
| Web Console | `packages/ui/src/console/api.ts`、`packages/ui/src/web/` | ✅ baseline（Overview/Lookup/Graph/Jobs 4 个视图） |
| Eval 框架 | `tests/eval/runners/`、`tests/eval/goldens/` | 11 套 deterministic suite 已登记；离线 release gate 通过不代表 production gate 已验收 |

CLI 使用 `ms` 命令组（与 `mengshu` 别名），支持配置向导、诊断、评分追溯、召回解释、agent-history dry-run、历史 5 type 漏斗迁移，以及 private Asset 的 list/explain/deprecate/revoke；具体命令以 `ms --help` 为准。

## 架构决策（当前确认状态）

### 1. OpenClaw 只是 adapter（✅ 已落地）

业务逻辑已迁入 `packages/core/src/{domain,service,context,runtime,scoring,retrieval,db,storage,ingest,lifecycle,graph,tree}`。根 `core/`、`processing/`、`retrieval/`、`db/`、`storage/`、`ingest/`、`scanner/`、`lifecycle/`、`graph/`、`tree/` 和 `index.ts` 保留兼容入口，不再包含对应核心业务逻辑。

### 2. 保留 legacy provider（✅ 已确认）

LanceDB、Supabase、Postgres provider 继续作为向量存储后端。中间件能力（候选区/去重/图谱/树/4 套评分）通过 `LegacyDatabaseAdapter` 和新模块增量落地，不重写存储层。

### 3. Scope 是新 API 的强边界（合同已定义，入口持续收敛）

REST、MCP、SDK、console 和 graph/tree 查询应使用 `MemoryScope` 或可规范化的 scope input（`packages/core/src/domain/scope.ts`，`core/scope.ts` 为旧路径兼容转发）。目标合同要求所有 API 解析 scope，server/remote 模式不得绕过 scope filter；历史入口仍需按真实调用链验收。

### 4. 快路径不等待重语义处理（✅ 已分离）

Agent 启动上下文优先走缓存和轻量构建（`packages/api/src/agent-fast-path/index.ts`）；embedding、抽取、graph/tree、summary 等重处理放到 warm/cold path（后台 job 队列）。

### 5. LLM 可以建议，不可单独裁决（算法层铁律，入口持续收敛）

目标合同要求所有入库动作经过 deterministic validator（`lifecycle/candidate-validator.ts` 11 闸门），记忆具有 evidence，摘要节点不能创造事实（`tree/faithfulness.ts`），并优先检测冲突而非盲目合并。当前仍在把历史入口收敛到这一合同。

### 6. 四套评分分工明确（✅ 已落地 D-01~D-03）

- **valueScore**（`packages/core/src/scoring/value-score.ts`）：准入决策（<0.40 drop / 0.40-0.55 low / 0.55-0.88 pending / ≥0.88 active）
- **importance**（`packages/core/src/scoring/importance-score.ts`）：召回排序 + score breakdown（4 项：salience_llm 0.45 + sourceAuthority 0.20 + explicitnessBonus 0.20 + typePrior 0.15）
- **confidence**（`packages/core/src/scoring/confidence-score.ts`）：去重治理 + 证据晋升（多证据贝叶斯累积）
- **hotness**（`packages/core/src/graph/query-hits-tracker.ts`）：topic tree 路由 + 归档（5 项：mention + source + recency + centrality + queryHits）

权重配置统一在 `packages/core/src/scoring/scoring-weights.ts`（SCORING_WEIGHTS_V1），不分散到各模块。

### 7. Profile 三层分层（✅ 已落地 D-04/D-13）

`project → app → global` 三层分层（`packages/core/src/domain/profile-layer.ts`，`core/profile-layer.ts` 为旧路径兼容转发），召回优先级由近及远。避免项目偏好污染全局画像，`targetScope` 包含 `app` 层（6 档：message/turn/session/project/app/global）。

---

## 核心代码资产总结

### 已存在的算法与模块资产

1. **LLM 结构化提取**：`extractStructured` 支持 JSON Schema 约束输出（`packages/core/src/runtime/llm/llm-client.ts`），图谱抽取 entity + relation + attribute 三元组（`packages/core/src/graph/llm-extractor.ts`）
2. **11 闸门 validator**：`packages/core/src/lifecycle/candidate-validator.ts` 提供 deterministic 校验；各入口仍在收敛到统一 Write Kernel（铁律：LLM 可以建议，不可单独裁决）
3. **4 套评分体系**：value（准入）/importance（召回）/confidence（去重）/hotness（树路由），权重统一在 `packages/core/src/scoring/scoring-weights.ts`（SCORING_WEIGHTS_V1）
4. **语义去重**：`packages/core/src/lifecycle/semantic-dedup.ts`，embedding 阈值 0.90/0.82（合并/judge），冲突检测优于盲目合并
5. **L0-L3 树摘要**：`packages/core/src/tree/build-tree-handler.ts`、`packages/core/src/tree/seal.ts`、`packages/core/src/tree/leaf-routing.ts`，source/topic/global 三类树（baseline，待完整 seal/routing）
6. **6 因子召回**：`packages/core/src/domain/recall-scoring.ts`，混合检索（vector + BM25 + recent + graph）+ RRF 融合（`packages/core/src/retrieval/fusion.ts`）+ 6 因子重排
7. **5 槽位注入**：`packages/core/src/context/slot-context-builder.ts`，5 问题语义协议（profile/task_context/rules/experience/resource）快路径注入（`packages/api/src/agent-fast-path/index.ts`）
8. **Scope 隔离**：`packages/core/src/domain/scope.ts`，6 档 targetScope（message/turn/session/project/app/global），运行时按 scope 策略过滤
9. **Agent-history 导入**：`packages/core/src/ingest/agent-history/`，含 redaction（`redaction.ts`）和批量去重
10. **Eval 评估体系**：`tests/eval/runners/`、`tests/eval/goldens/` 登记 11 套 suite；当前离线 quick eval 全绿，production gate 必须显式 live opt-in，未执行时不得标为生产验收

### 未来规划（Phase 5-6）

| Phase | 范围 | 预计版本 |
|-------|------|---------|
| Phase 5 完整 | Memory Tree 完整 seal/routing/daily digest | v0.3-v0.5 |
| Phase 6 | Python SDK、多租户、Connector sync、团队部署 | v0.5+ |

### 相关文档

- **算法层单一事实来源**：[memory-system-unified-design.md](../design/memory-system-unified-design.md)（v2.0，D-01~D-23 决策）
- **技术栈**：[technology-stack.md](technology-stack.md)（TypeScript + LanceDB + OpenAI embedding）

---

**创建日期**：2026-05-30（v4 架构方案）  
**最后更新**：2026-08-16（v1.0.7 运行态校准）
