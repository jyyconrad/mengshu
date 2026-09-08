# 系统架构

> 当前版本：v1.0.7
> 代码快照：2026-08-31
> 算法规格：[记忆系统统一设计](../design/memory-system-unified-design.md)（D-01~D-23）
> 状态口径：本文只把已接入当前运行组合且有测试覆盖的能力标为“运行态”；仅有类型、模块或迁移脚本的能力不自动视为已启用

mengshu 是面向多产品 Agent Runtime 的本地优先记忆中间件。当前代码已从单一 OpenClaw 插件演进为“共享 RuntimeHost + 多协议薄适配器 + PostgreSQL 治理主链”的结构，同时保留 LanceDB、Supabase 和根目录旧导入路径的兼容能力。

## 1. 总体拓扑

```text
OpenClaw / Codex / Claude Code / CLI / REST / JS SDK / Web Console
                           │
              adapter / RuntimeClient / MCP proxy
                           │
              RuntimeHost（单一 owner + generation）
                           │
       ┌───────────────────┼────────────────────┐
       │                   │                    │
 Memory Write Kernel  Governed Retrieval   Context Engine
       │                   │                    │
 authority → validate  multi-route → filter  5 slots + R0-R4
 → score → dedup       → hydrate → rerank    + Asset/Knowledge
 → admission           → receipt             + assembly receipt
       │                   │                    │
       └───────────────────┼────────────────────┘
                           │
 PostgreSQL durable repositories / outbox / worker / audit
                           │
 temporal / working set / tree / graph / skill / policy / documents
```

默认 `ms mcp` 不创建第二套数据库、缓存或 worker，而是通过 loopback HTTP 或 owner-only Unix socket 连接共享 RuntimeHost。Codex 打包插件显式设置 `MENGSHU_MCP_MODE=standalone`，使插件在没有单独托管 `ms serve` 时也能启动 MCP；该模式创建进程内 Runtime，但不取得 RuntimeHost durable worker ownership。旧的 `MENGSHU_MCP_DIRECT_DIAGNOSTIC=1` 继续作为 `standalone` 的兼容别名。

### 1.1 Project Identity 与产品 Authority

Project Memory Workspace 是跨产品共享的本地上下文容器。`ms init` 只根据目录、显式参数
或 Agent 产品注入的 project resolver 固化 `workspaceId/projectId`；该过程不创建 Runtime，
不读取 provider，也不要求 OpenClaw authority。

Codex、OpenClaw、Claude Code 等产品在访问记忆库时，把这个 project identity 与自己的
可信 `tenantId/userId/appId/agentId/namespace` 组合成完整 scope。项目 manifest 不能覆盖
产品身份，客户端 scope 也不能扩大 server authority。这样同一项目可被多个授权产品复用，
同时保留来源产品与 Agent 的审计信息。

## 2. 包与职责边界

| 边界 | 主要职责 | Canonical 路径 |
|------|----------|----------------|
| Core domain | scope、authority、状态、语义类型、服务合同 | `packages/core/src/domain/` |
| Core service | `MemoryService`、Write Kernel、forget 与事务合同 | `packages/core/src/service/` |
| Runtime composition | provider、embedding registry、worker、能力装配和生命周期 | `runtime.ts`、`server/runtime-host-factory.ts`、`packages/core/src/runtime/` |
| Retrieval | governed retrieval、候选源、RRF、6 因子评分、prompt safety | `packages/core/src/retrieval/` |
| Context | 5 槽位、SlotSnapshotV2、Loadout、装配回执 | `packages/core/src/context/`、`packages/core/src/loadout/` |
| Lifecycle | validator、准入、候选、去重、晋升、撤回 | `packages/core/src/lifecycle/` |
| Knowledge structures | Entity/Work Memory Graph、source/topic/global tree | `packages/core/src/graph/`、`packages/core/src/tree/` |
| Durable extensions | temporal、working set、skill artifact、policy overlay | `packages/core/src/temporal/`、`working-set/`、`skills/`、`policy/` |
| File-native layer | canonical Markdown、curation artifact、Vault 安全边界 | `packages/core/src/documents/`、`packages/core/src/vault/` |
| Storage | provider contract、PostgreSQL/LanceDB/Supabase、migration、repository | `packages/core/src/db/`、`packages/core/src/storage/` |
| Public adapters | REST、SDK、RuntimeClient、MCP、Web Console | `packages/api/src/`、`packages/mcp/src/`、`packages/ui/src/` |
| Project workspace | 产品无关 init/status、manifest/registry 与产品 resolver contract | `packages/api/src/cli/project.ts`、`packages/core/src/runtime/registry.ts`、`plugins/openclaw/src/manifest.ts`（兼容位置） |
| Product plugins | OpenClaw、Codex、Claude Code source adapter | `plugins/` |

根目录的 `core/`、`processing/`、`retrieval/`、`db/`、`storage/`、`ingest/`、`scanner/`、`lifecycle/`、`graph/`、`tree/`、`feedback/`、`routing/` 和 `adapters/` 主要是旧路径兼容 facade。新代码应从 `packages/*` 或 `plugins/*` 的 canonical 路径导入。

## 3. 运行模式

| 模式 | 当前行为 | 适用场景 |
|------|----------|----------|
| Embedded | 宿主进程创建 Runtime 并直接调用 service | OpenClaw 插件、单进程嵌入 |
| Server | `ms serve` 持有 RuntimeHost、listener、worker 和 generation | 本机共享服务、REST、Web Console |
| MCP proxy | `ms mcp` 通过 RuntimeClient 转发工具表与调用 | Codex、Claude Code、MCP 客户端 |
| MCP standalone | `MENGSHU_MCP_MODE=standalone` 创建进程内 Runtime，不持有 durable worker | 自包含 Codex 插件、隔离诊断 |
| SDK/client | REST client 或 Unix/HTTP RuntimeClient | 自定义应用集成 |

RuntimeHost 的 readiness 与 listener 绑定：host 未 ready、embedding registry 不可验证或所需 PostgreSQL capability 不完整时，服务保持 fail-closed，而不是用降级状态伪装为可用。

## 4. 核心运行链路

### 4.1 写入与纠错

```text
memory_save / memory_observe_light / REST / OpenClaw hook
  -> server-owned authority resolution
  -> normalize + prompt/sensitive risk detection
  -> embedding-space write guard
  -> deterministic candidate validator
  -> valueScore + importance
  -> exact / lexical / semantic dedup
  -> admission route
  -> provider-owned transaction
       record or candidate + audit + outbox + idempotency receipt
  -> post-commit warm derivation
       graph / tree / slot invalidation / temporal / skill aggregation
```

`MemoryWriteKernel` 负责顺序和 fail-closed 分支，具体策略与持久化能力通过显式依赖注入。自动观察即使达到 active 阈值也先进入 candidate；`intent=ignore` 返回非持久化结果。显式保存允许保留只有 `MemoryKind` 的记录，但没有可靠 `semanticType` 的记录不会进入 5 槽位。

PostgreSQL 运行组合通过 provider-owned transaction 保证 canonical record/candidate、audit、outbox 和幂等 receipt 同一提交。非 PostgreSQL provider 继续提供兼容存取，但不宣称具备相同的 durable job、fencing 和扩展仓库能力。

### 4.2 Governed Recall

```text
query
  -> embedding registry read guard
  -> provider vector candidates
  -> PostgreSQL supplemental candidates（BM25 / graph / tree 等）
  -> tenant/user authority hard filter
  -> scope / lifecycle / visibility / risk / embedding-space filter
  -> authoritative hydration
  -> 6 因子评分与解释
  -> minScore
  -> limit
  -> RecallResult + filtered reasons
```

`minScore` 与 `limit` 只在治理过滤和最终评分后生效。PostgreSQL Runtime 注入 `GovernedRetrievalEngine` 与多路候选源；兼容 provider 使用同一 authority、lifecycle 和 6 因子基础合同，但候选路线较少。召回结果保留 source signal、score breakdown、provenance 和过滤原因，供 `ms why`、`--explain` 与装配回执复用。

### 4.3 Agent Context

```text
memory_context_fast / POST /v1/agent/context
  -> governed recall（context intent）
  -> SlotContextBuilder
  -> profile / task_context / rules / experience / resource
  -> R0-R4 progressive disclosure
  -> optional Asset / Knowledge / Loadout augmentation
  -> prompt-safe packing + token budget
  -> ContextAssemblyReceipt（capability 可用时）
```

5 槽位是 Agent 上下文视图，不替代通用 `MemoryKind`。Asset、Knowledge resource 和 Loadout 只能在原生 scope、lifecycle、risk、conflict、召回门槛和预算之后增强上下文。它们不可用时，原生 5 槽位仍可独立工作。

### 4.4 异步增强

RuntimeHost 持有 durable job v2 supervisor。PostgreSQL 参考组合使用 lease、fencing token、retry、DLQ 和 authoritative handler registry；MCP proxy 不取得 worker ownership。已提交的主记录不会因 post-commit 图谱或树增强失败而回滚，但失败会进入可观测的 job/audit 路径。

## 5. 增量能力层

这些能力由 `features.*` 与运行 capability 共同控制，默认不因模块存在而自动启用。

| 能力 | 实现边界 | 当前约束 |
|------|----------|----------|
| Temporal Memory | 版本链、evolve/correct/restore、as-of recall、expire/revoke/purge | PostgreSQL durable repository；历史索引为 BM25 |
| Continuous Memory Evolution | 两入口预览/隔离提案、no-op 与保守治理底座 | 默认关闭；RuntimeHost + PostgreSQL v36 capability；内容应用缺通用授权闭环 |
| Session Working Set | session ingest、outline、assemble、payload read、close、retention | 受预算和保留期控制，不替代长期记忆 |
| Skill Artifact | propose/import/review/publish/read/search/explain/revoke | v1 仅 `suggest_only`，不允许可执行资源 |
| Memory Policy Overlay | scoped version append 与 effective policy resolve | 只能收窄/叠加治理，不得扩大 authority |
| Memory Asset/Loadout | immutable asset version、binding、deprecate/revoke、slot 注入 | exact private scope；`assetInjection` 默认关闭 |
| Knowledge Resource | revision-pinned search/read | 只读、exact-scope、预算与 prompt safety 约束 |
| Canonical Markdown/Vault | 受治理的文档导出、审阅、回灌和 Vault 放置 | PostgreSQL 保留 canonical 治理真源；文件路径经过安全校验 |
| Runtime Cost | append-only token/金额估算账本 | 价格缺失时明确标为 `unpriced` |

Team ACL、任意可执行 Skill 和可选 Proxy 不属于 v1.0.7 的公开运行边界。

### 5.1 持续记忆进化边界

持续进化只接收已有记忆和 host 预先注册的目录来源。CLI、REST、MCP、SDK 使用同一批次协议，客户端不能选择任意服务器路径、模型或 authority；模型由可信全局配置解析，来源必须与批次 scope 精确匹配。它不引入在线会话 hook、文件 watcher 或自动长期调度。

输入读取与来源指纹复核、模型提案、确定性门禁、provider-owned 治理提交相互分离。模型不持有数据库事务；`preview` 无模型/embedding/canonical 写入，`propose` 只保存隔离候选和必要片段。允许的应用仍复用 Write Kernel、validator、temporal、CAS、lease/fencing 与提交 receipt，不能由普通候选审核取代专用门禁。显式恢复开新有限 segment，累计 usage 不清零；调用/token 预算为保守预留而非实际账单。

库存使用 baseline 的冻结上界和 keyset；`changed/due` 的持久增量选择不可用。库存 legacy raw evidence 与目录内容均缺可信作者/目标授权证明，当前统一为 untrusted；MCP/user 通道名、remember intent、role/frontmatter 都不能代替 host 证明。默认 Runtime 可靠范围是 preview/propose/no-op，create/correct/evolve 只有治理底座，需可靠 host 授权端口才可能应用；当前无通用 owner-approve API。

目录入口没有自动 related-target 生产 resolver，不能作为已支持的库存纠错/替代通道。补独立证据、冲突标记、完整来源支持对账与授权/治理闭环仍不提供通用自动化能力。kind-only 保持 lookup-only，高影响项仍需审阅，待审状态不表示存在可直接批准的接口。

v36 仅保存有界 batch 状态、无全文的 apply receipt/processed 索引；正文片段留候选区，候选到期不代表自动物理清理。配置与使用见[持续进化指南](../guides/continuous-memory-evolution.md)，数据合同见 [Schema](../design/schema.md)。

## 6. 存储与一致性

| 后端 | 定位 | 能力边界 |
|------|------|----------|
| PostgreSQL | 当前完整治理参考实现 | embedding registry、atomic write、durable jobs、graph/tree、asset/loadout、receipt、temporal、working set、skill、policy、documents |
| Supabase | 兼容云端 provider | 基础记忆/知识向量存取；不自动等同 PostgreSQL native capability |
| LanceDB | 本地兼容 provider | 单机向量存取与开发场景；registry 不可用时 ANN 读取 fail-closed |

Schema migration 采用 additive、checksum 固定和 dry-run 优先策略。历史导入、topic tree、temporal backfill、Markdown curation 等 operator 都要求显式计划、校验与回滚身份，不能由普通在线请求隐式触发。

## 7. 对外接口

| 接口 | 代码入口 | 说明 |
|------|----------|------|
| OpenClaw tools/hooks | `plugins/openclaw/src/` | 自动捕获/召回与 CLI 注册 |
| REST | `packages/api/src/rest/router.ts` | memory、context、temporal、working set、skill、policy、console、runtime control |
| MCP | `packages/mcp/src/` | 动态按 capability 注册工具；默认由 RuntimeClient proxy 提供 |
| JS SDK/RuntimeClient | `packages/api/src/sdk/`、`packages/api/src/runtime-client.ts` | REST client 与 loopback/Unix transport |
| Web Console | `packages/ui/src/` | Overview、Lookup、Graph、Jobs、Candidates 等聚合视图 |
| CLI | `packages/api/src/cli/ms.ts`、`plugins/openclaw/src/cli/` | `ms` / `mengshu` 命令组 |

## 8. 评测与发布口径

评测分为三个互不替代的轨道：

- G 轨：公开通用数据，产出 GMS；当前 G0 runner 的 lexical 结果仅为 diagnostic，未运行官方 answer scorer 时不具备正式分数资格。
- P 轨：本地私有冻结集，产出 PMS；需要 paired comparison 和至少 150 例 P-FRESH。
- Q 轨：contract、safety、算法与 runtime 工程门禁；`npm run eval:quick` 只运行 Q 轨。

版本发布结论要求 G/P paired gate、Q gate、报告完整性和 private fresh quota 同时满足。Q 轨全绿不能单独表述为记忆效果提升或版本可发布。

## 9. 设计原则

1. server-owned authority 是硬边界，客户端 scope 不能覆盖 tenant/user。
2. LLM 只提供候选和信号，最终准入、过滤、评分、合并与发布由确定性合同裁决。
3. active embedding space 必须可验证；未知或混合空间不执行 ANN。
4. 写入先提交 canonical 事实，再异步派生 graph/tree/asset；派生层不是事实源。
5. 兼容 facade 只服务迁移，新实现进入 canonical package。
6. 运行态能力以 composition + capability + test 为准，不以文件存在为准。

**最后更新**：2026-08-31
