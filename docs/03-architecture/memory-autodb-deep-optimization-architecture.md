# memory-autodb 深层优化架构方案

> 日期：2026-06-09  
> 状态：架构方案（v2 评审修订）  
> 范围：在现有 v4 记忆中间件基线之上，吸收 `copy-from-mate/memory-system-upgrade-design.md` 的 5 问题、5 type、记忆树、图谱、升格治理思想，形成 memory-autodb 的长期优化方案。  
> 关联文档：  
> - [architecture-review-v2.md](./architecture-review-v2.md)  
> - [copy-from-mate/memory-system-upgrade-design.md](./copy-from-mate/memory-system-upgrade-design.md)  
> - [copy-from-mate/memory-system-v0.6/README.md](./copy-from-mate/memory-system-v0.6/README.md)  
> - [memory-middleware-architecture.md](./memory-middleware-architecture.md)  
> - [structured-knowledge-graph-memory-tree-detail.md](../04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md)  
> - [web-console-design.md](../04-design/04.1-overview/web-console-design.md)

---

## 1. 一句话结论

memory-autodb 的下一阶段不应只是“OpenClaw 的长期记忆插件”，也不应只是“向量库 + REST API”。但 v0.x 的默认落地范围必须收敛：**先以 LanceDB + 本地文件 + embedding API 的单机配置，做成一个快、准、可回放的本地记忆中间件**；远程同步、开放平台和复杂治理放到真实需求出现后的 v1+。

它的长期目标仍是面向多产品、多 Agent、多来源的工作记忆中间件：

1. 对 Agent，它提供的不是一堆相似片段，而是回答 5 个执行前必须知道的问题。
2. 对产品，它提供的是统一的记忆写入、召回、上下文注入、知识速查、图谱预览和治理能力。
3. 对系统，它提供的是可追溯、可折叠、可演化、可审计的记忆基础设施。

新的顶层语义主线是：

| 问题 | 标准记忆 type | 对 Agent 的作用 |
|------|---------------|----------------|
| Q1 我为谁工作？ | `profile` | 决定输出风格、详细度、风险偏好和协作方式 |
| Q2 我在做什么？ | `task_context` | 决定当前目标、阶段、优先级和项目约束 |
| Q3 什么不能做？ | `rules` | 决定行为边界、合规底线和资源使用禁区 |
| Q4 之前怎么做过？ | `experience` | 决定历史经验、决策依据、可迁移方法 |
| Q5 有什么可用资源？ | `resource` | 决定可调用的工具、文档、专家、连接器和知识库 |

v2 修订后的关键边界：5 问题/5 type 是 **Agent 上下文视图**，不是 v0.x 主库的硬约束。主库保留通用 `kind` 与原始 evidence；能归入 5 type 的节点参与 5 槽位上下文，无法稳定归类的节点仍可通过 `memory_lookup` 检索。这样既保留产品语义，又避免在编程、研究、客服等真实场景中把有价值事实强行丢弃。

---

## 2. 现有基线与缺口

当前仓库已经形成 v4 中间件雏形：

| 能力 | 当前基线 | 深层优化缺口 |
|------|----------|--------------|
| 核心服务 | `MemoryService` 已抽出，OpenClaw/REST/MCP/SDK/CLI 可共享 | 服务接口仍偏 `store/recall/context`，缺少 5 type 语义契约 |
| Scope | 已有 `tenantId/appId/userId/projectId/agentId/namespace` | v0.x 先补 workspace/project/session/local visibility；远程 team/enterprise 延后 |
| 对外协议 | 已有 REST/MCP/SDK 基础入口 | 缺少面向 Agent 的“少参数、低延迟、强约束输出”快路径契约 |
| 领域类型 | `preference/decision/fact/task/...` 通用分类 | 需要新增可选 `semanticType` 视图，而不是立刻替换主库 `kind` |
| Ingestion | 已有 canonicalize、chunk、dedupe、job 基线 | 缺少 type extractor、候选区、SlotSnapshot 刷新和 replayable 派生链路 |
| Retrieval | 已有 BM25/RRF/Context Packer 基线 | 缺少固定 5 槽位注入、任务相关层、按需下钻和 slot 预算 |
| Graph | 已有 rule-based entity/relation baseline | 需要统一 GraphRepository，避免 Entity Graph 和 Work Memory Graph 分裂存储 |
| Tree | 已有 source/topic/global baseline | v0.x 不实现 Slot Tree，先用 SlotSnapshot；source tree 可作为后续第一棵持久树 |
| Web Console | 已有 Overview/Lookup/Graph/Jobs MVP | v0.1 先收敛到 Overview + Quick Lookup，治理和可视化分阶段补 |
| 治理 | 已有 audit/retention baseline | 缺少 lifecycleStatus、候选自动淘汰、批量审核、撤销和本地审计 |
| 成本性能 | 写入和召回已有基础可用链路 | 缺少本地单机 SLO、token/LLM 预算、缓存、增量更新和降级策略 |

结论：现有 v4 是**工程骨架**。v0.x 不应一次性补完整平台能力，而应优先补齐“Agent 快路径 + 5 槽位语义视图 + SlotSnapshot + 候选门控 + 本地可观测”的闭环；远程同步、开放扩展、完整树/图可视化作为 v1+ 能力。

---

## 3. 设计原则

### 3.1 记忆不是日志

memory-autodb 不负责保存所有对话、工具调用、连接器原始响应或执行日志。它只保存对未来行为有稳定影响的信息。

| 不进长期记忆 | 应归属 |
|--------------|--------|
| 原始对话消息 | 会话日志 |
| 工具调用流水 | 执行日志 / trace |
| TODO 状态 | 任务系统 |
| 外部系统原始数据 | 连接器缓存 / 知识库 |
| 一次性情绪和临时上下文 | 当前会话上下文 |
| 未脱敏敏感数据 | 安全隔离区或直接丢弃 |

长期记忆只接收被提炼出的画像、上下文、约束、经验和资源指针。

### 3.2 先回答问题，再做相似度

传统向量检索从 query 出发，问“哪些片段相似”。深层记忆系统应先从 Agent 执行出发，问“Agent 在开始前必须知道什么”。因此召回不再是单一 ranked list，而是：

1. 必读层：固定 5 槽位，回答 Q1-Q5。
2. 任务相关层：围绕当前任务补充 rules、experience、resource。
3. 按需检索层：用户或 Agent 明确追问时下钻到原始证据、图谱路径和树节点。

### 3.3 Scope 是隔离边界，Container 是语义边界

`MemoryScope` 解决“谁的数据”，`MemoryContainer` 解决“这条记忆属于哪种工作容器”。

| 维度 | 作用 | 示例 |
|------|------|------|
| Scope | 多租户、多产品、多用户、多项目隔离 | `tenantId=local`, `appId=openclaw`, `userId=default` |
| Namespace | 产品内逻辑空间 | `memories`, `knowledge`, `skills`, `remote/team-a` |
| Container | 语义归属和生命周期 | personal, project, session_candidate, team, enterprise |
| Visibility | 可见性和权限 | private, workspace, team, public |

所有写入、查询、图谱遍历、树下钻和 Console API 都必须带 scope filter。禁止只按 namespace 粗过滤。

### 3.4 L0 永远可追溯，L1/L2 只做压缩

L0 是原始 evidence，L1/L2 是可重建摘要。系统可以重生、废弃、替代摘要，但不能因为摘要折叠而主动删除 L0。用户显式删除、合规删除和过期清理是治理操作，必须进入 audit。

### 3.5 热路径轻量，重语义异步

写入热路径只做确定性工作：

```text
normalize scope
  -> validate input
  -> canonicalize
  -> classify lightweight metadata
  -> hash / dedupe
  -> persist L0 / candidate
  -> enqueue jobs
```

LLM 抽取、embedding、图谱构建、摘要封口和 SKILL 候选都在后台任务中执行；远程同步属于 v1+ 能力，不进入 v0.x 默认后台路径。

### 3.6 对外接口优先服务 Agent 快速输入和输出

作为中间件，MCP/REST/SDK 的第一目标不是暴露所有内部概念，而是让 Agent 用最少参数完成两件事：

1. **开始任务前快速拿上下文**：传入 `scope + task + constraints`，返回可直接放入 prompt 的 5 槽位上下文、任务相关证据和警告。
2. **运行过程中低成本提交观察**：传入小段 observation、tool result 摘要或用户显式保存内容，立即得到 ack、trace id 和是否进入候选区的状态。

因此对 Agent 的接口应优先是“任务语义接口”，不是“数据库接口”。Agent 不应直接操作 candidate、tree buffer、seal job、remote sync、promotion 等内部对象。

### 3.7 实时性分层：hot / warm / cold

运行过程中要“快而准”，不能把所有处理都放到同一条链路。

| 层 | 延迟目标 | 处理内容 | Agent 是否等待 |
|----|----------|----------|----------------|
| Hot path | 10-200ms 级 | scope 校验、缓存读取、slot snapshot、BM25/轻量索引、显式保存 ack | 等待 |
| Warm path | 秒级 | embedding、候选抽取、增量索引、实体关系 baseline、slot snapshot 刷新 | 通常不等待 |
| Cold path | 分钟级或批处理 | LLM 深度抽取、summary seal、global digest、SKILL 候选 | 不等待 |

Hot path 只回答“现在能安全使用什么”。Warm/Cold path 负责“让下一次更准”。

### 3.8 成本与性能是架构约束

所有 LLM、embedding、图谱和树操作都必须进入预算系统：

1. 每次 Agent 请求有 `latencyBudgetMs` 和 `tokenBudget`。
2. 每个 scope 有每日 embedding/LLM job budget。
3. 默认优先使用已封口的 slot snapshot 和 text index。
4. 只有用户显式下钻或缓存失效时才触发更重的 graph/tree/LLM 路径。
5. 超预算时返回降级结果和 `warnings`，不能静默变慢。

### 3.9 能力成长不是堆功能

memory-autodb 的能力成长应从“可被证明更可靠”出发，而不是不断增加新工具、新表和新图谱。每个新能力必须回答四个问题：

1. 它让 Agent 在什么任务上更准？
2. 它是否能被 evidence、audit 和评测证明？
3. 它失败时是否可降级、可回放、可修正？
4. 它是否保持对外协议稳定，而不是把内部复杂度推给 Agent？

因此架构演进应遵循“先契约、再数据、再智能”的顺序：

```text
stable contract
  -> durable evidence
  -> deterministic indexes
  -> explainable retrieval
  -> async semantic enrichment
  -> governed promotion
```

如果一个能力只能靠 LLM 当场推断、没有可追溯证据、无法重放验证，它不能进入核心路径。

### 3.10 5 问题是产品语义，不是主库硬约束

5 问题和 5 type 是 Agent 工作场景下的产品语义协议，不应被包装成唯一的认知科学模型。它适合回答“Agent 开始工作前需要知道什么”，但不应替代更底层的记忆理论。

底层仍应保留更通用的理论映射：

| 理论层 | 在 memory-autodb 中的表达 |
|--------|--------------------------|
| Working memory | 当前 task context、recent observation ring、短期会话缓存 |
| Episodic memory | 带时间、来源和 evidence 的 experience / observation / session chunk |
| Semantic memory | 被抽象后的 rules、profile、resource index、topic summary |
| Procedural memory | 被升格后的 SKILL、workflow、tool usage policy |
| External memory | 知识库、文档、连接器、团队资源指针 |

5 type 是对外和召回层的组织方式；底层存储和开放扩展不能被 5 type 锁死。v0.x 应保留通用 `kind`，新增可选 `semanticType`。v0.x 不强制所有节点都有 `semanticType`；无法分类的节点仍可通过 `memory_lookup` 检索。未来如果某个产品需要新增 `workflow_policy`、`tool_affordance`、`domain_model` 等专业类型，应先保留为通用节点，再在 slot builder 中映射到 5 槽位或自定义槽位。

```typescript
interface MemoryNode {
  kind: MemoryKind;                    // 主库后备分类，兼容旧数据和真实复杂场景
  semanticType?: MemorySemanticType;   // 可选语义视图，用于 5 槽位上下文
}
```

决策规则：

1. 用户显式保存的信息必须入库，即使暂时无法归入 5 type。
2. 自动抽取的信息如果无法稳定归类，进入 candidate 或保留 `kind=other`，但不进入 5 槽位。
3. `memory_lookup` 可以检索所有合规节点；`memory_context_fast` 优先使用有 `semanticType` 的节点。
4. 当 6-12 个月真实数据证明 5 type 覆盖率足够高后，再考虑把某些路径收口为强约束。

### 3.11 可靠性优先于智能化

记忆中间件的首要风险不是“记得不够多”，而是：

1. 把错误记忆注入给 Agent。
2. 把过期规则当成当前约束。
3. 把私密数据带入上下文。
4. 因后台任务失败导致索引和主库不一致。
5. 因高成本检索拖慢 Agent 主流程。

必须建立以下架构不变量：

| 不变量 | 含义 |
|--------|------|
| Evidence first | 长期记忆、关系、摘要都必须可追溯 |
| Idempotent jobs | 后台任务至少一次执行，但结果必须幂等 |
| Read-safe degradation | 索引失效时可降级读取旧 snapshot 或 text index |
| Write-audit before enrich | 先持久化观察和审计，再异步丰富 |
| Scope mandatory | 任何读写没有 scope 就拒绝 |
| Private by default | 不确定可见性时按 private 处理 |
| Revoked wins | revoked/superseded 永远不能进入自动上下文 |
| Snapshot is versioned | slot/tree snapshot 必须有版本和生成时间 |

智能化能力只能建立在这些不变量之上。

### 3.12 开放性不是无限暴露内部

作为中间件，开放性应体现为稳定协议、可插拔后端和可迁移数据，而不是把内部所有表和 job 都开放给 Agent。

开放边界：

| 层 | 开放什么 | 不开放什么 |
|----|----------|------------|
| Protocol | REST/MCP/SDK 的稳定 facade | 内部 repository 结构 |
| Storage | Provider contract、export/import、schema version | 直接跨租户读写表 |
| Model | embedding/LLM provider 抽象 | prompt 模板随意覆写核心规则 |
| Retrieval | scorer/reranker/tree provider 插件 | 绕过 privacy/scope filter |
| Semantics | type extension registry | 修改内置 5 槽位优先级 |
| Console | 管理 API 和审核流 | Agent 自主审批和远程上传 |

真正的开放是“替换组件后核心语义和安全边界仍然成立”。

---

## 4. 顶层概念模型

### 4.1 三层产品定位

memory-autodb 应同时服务三类需求：

| 层级 | 目标 | 典型能力 |
|------|------|----------|
| 记忆基础层 | 做好当下任务 | 写入、召回、5 槽位上下文、prompt-safe 注入 |
| 记忆结构层 | 能查、能追、能概览 | 图谱、记忆树、证据链、知识速查、整体预览 |
| 记忆演化层 | 沉淀能力、优化未来 | 候选区、升格、SKILL 候选、规则冲突、远程同步、治理 |

OpenClaw 当前主要使用第一层。要服务更多产品，必须补齐第二层和第三层。

### 4.2 5 type 是中间件的语义协议

`MemoryKind` 保留为主库通用分类；`MemorySemanticType` 是面向 Agent 上下文的语义视图。v0.x 不强制所有节点都有 `semanticType`。

建议新增 canonical enum：

```typescript
type MemorySemanticType =
  | "profile"
  | "task_context"
  | "rules"
  | "experience"
  | "resource";
```

兼容映射用于 slot builder 和候选抽取，不用于强制丢弃主库数据：

| 旧分类 | 新 type | 说明 |
|--------|---------|------|
| `preference` | `profile` 或 `rules` | 偏表达和稳定协作风格归 profile，明确约束归 rules |
| `decision` | `experience` | 必须有 why 或适用边界，否则只做 fact |
| `task` / `goal` / `plan` | `task_context` | 仅当影响项目目标、阶段、范围或里程碑 |
| `document` / `knowledge` | `resource` | 默认只存资源指针，正文归知识库或 chunk |
| `fact` / `entity` | 视上下文归类 | 无法回答 Q1-Q5 时仍可保留在主库，通过 lookup 检索 |
| `other` | 不进入 5 槽位 | 可作为 fallback，避免丢失用户显式保存的有价值事实 |

### 4.3 容器层与 type 的二维矩阵

| Type | personal | project/workspace | session_candidate | team remote | enterprise remote |
|------|----------|-------------------|-------------------|-------------|-------------------|
| `profile` | 用户偏好、协作方式 | 不直接写入 | 候选画像证据 | 不使用 | 岗位、组织归属输入 |
| `task_context` | 不使用 | 项目目标、阶段、客户约束 | 临时项目上下文候选 | 不使用 | 不使用 |
| `rules` | 个人约束 | 项目约束 | 待确认纠正 | 团队规范 | 合规强约束 |
| `experience` | 个人方法论 | 项目决策依据 | 待晋升经验 | 团队最佳实践 | 企业经验库 |
| `resource` | 常用工具/文档 | 项目资源指针 | 待确认资源 | 团队资源 | 企业知识库入口 |

关键规则：

1. `profile` 默认 private，不能自动贡献到团队。
2. `task_context` 默认 project-local，不进入远程团队记忆。
3. `rules` 的优先级为 enterprise > team > project > personal。
4. `experience` 可以升格为 SKILL，但不直接上传原始记忆。
5. `resource` 只存指针和边界，不复制外部系统完整内容。

### 4.4 折叠层

| 层 | 名称 | 内容 | 生成方式 | 用途 |
|----|------|------|----------|------|
| L0 | evidence node | 原始记忆、chunk、observation 证据 | 写入热路径 | 回溯、审计、重新摘要 |
| L1 | slot snapshot | 同 type、同 scope 的 top nodes / 摘要索引 | cache refresh / TTL | 5 槽位注入 |
| L2 | tree summary | source/topic/global 的分层摘要 | 后台 seal cascade，v0.4+ | 概览、导航、时间线 |
| L3 | asset candidate | SKILL 候选、团队规范候选、洞察建议 | pattern review | 能力沉淀和治理 |

L1 回答“Agent 开始任务前要知道什么”。v0.x 的 L1 不需要完整 tree buffer/seal，只需要可重建的 `SlotSnapshot`。L2 回答“这片记忆空间整体发生了什么”，应在数据量足够后从 source tree 起步。L3 回答“哪些经验可以变成能力或组织资产”。

### 4.5 能力成熟度模型

memory-autodb 的长期成长建议按 6 个成熟度层级推进。每一级都必须保持上一层稳定，而不是用更智能的能力替代基础能力。

| 等级 | 名称 | 核心能力 | 成熟标志 |
|------|------|----------|----------|
| L0 | Durable Memory | 可持久化、可隔离、可删除 | scope 强制、legacy 兼容、audit 基线 |
| L1 | Fast Context | Agent 快速获得可用上下文 | context_fast、slot snapshot、prompt-safe |
| L2 | Explainable Retrieval | 可解释召回 | BM25/vector/tree 融合、score breakdown、provenance |
| L3 | Structured Understanding | 图谱和树结构化理解 | Entity Graph、Work Memory Graph、summary tree |
| L4 | Governed Learning | 候选、冲突、升格、用户审核 | candidates、supersession、SKILL candidate、remote readonly |
| L5 | Open Memory Platform | 多产品、多后端、多模型开放平台 | provider registry、type extension、export/import、evaluation suite |

每一级的发布门槛：

1. 有稳定 API 或 schema contract。
2. 有迁移策略。
3. 有可重复测试和回放数据。
4. 有失败降级路径。
5. 有 Console 可观测入口。

如果某项能力无法满足这些门槛，应作为实验特性隐藏在 feature flag 后，而不是进入默认路径。

### 4.6 能力飞轮

长期来看，memory-autodb 的能力提升不是靠单次大模型调用，而是靠闭环飞轮：

```text
capture evidence
  -> classify / index
  -> retrieve / inject
  -> observe outcome
  -> evaluate usefulness
  -> adjust confidence / hotness
  -> promote stable patterns
  -> improve future retrieval
```

这个飞轮要求补齐两个当前方案容易忽略的信号：

| 信号 | 来源 | 用途 |
|------|------|------|
| Outcome feedback | Agent 任务是否成功、用户是否采纳、是否被纠正 | 调整 confidence、hotness、promotion |
| Retrieval telemetry | 哪些记忆被注入、被点击、被下钻、被忽略 | 调整召回排序和 slot 内容 |

没有 outcome 和 telemetry，系统只能“越存越多”，不能证明“越用越准”。

---

## 5. 总体架构

### 5.0 默认单机部署边界

v0.x 默认部署不是云端平台，而是本地优先：

| 层 | 默认选择 | 说明 |
|----|----------|------|
| Metadata / Vector | LanceDB | 复用现有 provider，承接 memory/chunk/vector/metadata |
| Content | 本地文件 | markdown/vault export、WAL、诊断报告 |
| Embedding | 现有 embedding API | 可接 OpenAI-compatible 或本地服务 |
| Server | embedded + local-server | OpenClaw 同进程或本机 daemon |
| Console | 本机 `/console` | 不直连 DB，经 service API |
| Remote | 不启用 | v1+ 再考虑 |

这意味着 v0.x 所有设计都必须能在无 PostgreSQL、无 Redis、无远程服务的环境下跑通。

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Product / Agent Layer                                                 │
│ OpenClaw | Codex | Cursor | OpenHuman | Banto | Custom Apps | Console │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ Adapter / Protocol Layer                                              │
│ OpenClaw Adapter | REST | MCP | JS SDK | CLI | Hook Adapter | Sync API │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ Memory Gateway                                                        │
│ auth | scope resolver | schema validation | rate limit | audit guard   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ Semantic Memory Core                                                  │
│ MemoryService                                                         │
│ - observe / store / ingest / recall / buildContext                    │
│ - classifyToFiveTypes / buildFiveSlotContext                          │
│ - graphQuery / treeWalk / promoteCandidate / forget                   │
└───────────────────────────────┬──────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────┐
│ Orchestration Layer                                                   │
│ Ingestion Pipeline | Extractor | Retrieval Orchestrator | Slot Builder │
│ Graph Builder | Memory Tree Engine | Lifecycle Engine | Promotion      │
└───────────────┬────────────────────┬────────────────────┬────────────┘
                │                    │                    │
┌───────────────▼──────────────┐ ┌───▼──────────────┐ ┌───▼────────────┐
│ Durable Stores                │ │ Index Providers  │ │ External / Sync │
│ Metadata | Content | Jobs     │ │ Vector | BM25    │ │ Remote server   │
│ Audit | Vault Export          │ │ Graph | Tree     │ │ agentmemory etc.│
└───────────────────────────────┘ └──────────────────┘ └────────────────┘
```

### 5.1 与现有模块的映射

| 目标层 | 现有模块 | 优化方向 |
|--------|----------|----------|
| Gateway | `api/rest`, `adapters/mcp`, `adapters/openclaw` | 增加 schema version、scope policy、type contract |
| Semantic Core | `core/memory-service.ts`, `core/types.ts` | 引入 5 type、container、lifecycle、slot context |
| Ingestion | `ingest/*` | 增加 extractor、candidate routing、L0 evidence 写入 |
| Retrieval | `retrieval/*` | 从 ranked list 升级为 5 槽位 + 任务相关 + 下钻 |
| Graph | `graph/*` | 从实体关系 baseline 升级为工作记忆图谱 |
| Tree | `tree/*` | 增加 slot tree，与 source/topic/global tree 联动 |
| Console | `console/*` | 增加整体预览、速查、槽位预览、树下钻、候选审核 |
| Storage | `storage/*`, `db/providers/*` | 增加 durable repositories 和 migration |
| Lifecycle | `lifecycle/*` | 增加 supersession、revocation、promotion audit |

### 5.2 新增建议目录

```text
memory-autodb/
├── semantics/
│   ├── five-types.ts            # 5 type enum、维度、阈值、兼容映射
│   ├── extractor.ts             # 从 observation/chunk 中抽取 5 type 候选
│   └── classifier.ts            # 轻量分类和路由
├── slots/
│   ├── slot-builder.ts          # 5 槽位上下文组装
│   ├── slot-budget.ts           # 槽位预算策略
│   └── slot-snapshot.ts         # L1 slot snapshot repository
├── promotion/
│   ├── candidate-review.ts      # 候选区扫描和升格规则
│   ├── skill-candidate.ts       # experience -> SKILL 候选
│   └── contribution-policy.ts   # 本地到团队的非 agent 通道策略
├── sync/
│   ├── remote-cache.ts          # 远程只读缓存
│   ├── snapshot.ts              # 全量快照
│   └── incremental.ts           # 增量同步
└── vault/
    ├── markdown-export.ts       # md+json / vault export
    └── frontmatter.ts           # frontmatter schema
```

这些目录不是第一阶段必须全部落地，但它们能让“语义层”和“协议层”保持分离，避免继续把规则散落在 adapter 或 retrieval 中。

---

## 6. 核心数据模型

### 6.1 Scope

建议扩展当前 `MemoryScope`：

```typescript
interface MemoryScope {
  tenantId: string;
  appId: string;
  userId: string;
  workspaceId?: string;
  projectId?: string;
  agentId?: string;
  sessionId?: string;
  namespace: string;
  visibility: "private" | "workspace" | "team" | "public";
}
```

兼容策略：当前缺失字段用默认值补齐，旧 API 不强制传 `workspaceId/sessionId/visibility`，但 repository 内部统一写入规范化 scope。

### 6.2 MemoryNode

```typescript
interface MemoryNode {
  id: string;
  scope: MemoryScope;
  container: "personal" | "project" | "session_candidate" | "team" | "enterprise";
  kind: MemoryKind;
  semanticType?: MemorySemanticType;
  title: string;
  body: string;
  summary?: string;
  dimension?: string;
  value?: string;
  dimensionFields: Record<string, unknown>;
  tags: string[];
  confidence: number;
  importance: number;
  hotness: number;
  lifecycleStatus: "active" | "archived" | "revoked" | "superseded" | "promoted";
  sourceNodeIds: string[];
  evidenceChunkIds: string[];
  evidenceQuotes: string[];
  supersededBy?: string;
  promotedToSkillId?: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}
```

约束：

1. `kind` 必填，用于兼容旧数据、研究事实、资源指针和无法稳定归类的复杂场景。
2. `semanticType` 可选；只有能稳定回答 Q1-Q5 的节点才参与 5 槽位上下文。
3. `kind=other` 或未分类节点可以进入长期主库，但不进入必读层，仍可通过 `memory_lookup` 检索。
4. 自动抽取的低置信或无法分类信息进入 candidate；用户显式保存的信息不因缺少 `semanticType` 被丢弃。
5. `evidenceChunkIds` 或 `sourceNodeIds` 至少存在一个。
6. `lifecycleStatus !== active` 时，不参与必读层召回。
7. `promoted` 节点仍可按需检索，但降低自动召回权重，避免和 SKILL 重复。

### 6.3 Type 维度字段

#### `profile`

| 字段 | 取值 | 说明 |
|------|------|------|
| `dimension` | motivation / achievement_orientation / control_preference / risk_attitude / expression_style | 画像维度 |
| `value` | intrinsic / external_regulated / mastery / performance / high_control / delegatable / promotion / prevention / balanced / context_switching | 维度值 |
| `dimensionFields.stability` | low / medium / high | 只对稳定偏好入库 |

规则：`profile` 不记录人格评价，只记录会改变 Agent 行为的工作协作倾向。

#### `task_context`

| 字段 | 取值 | 说明 |
|------|------|------|
| `dimension` | goal_structure / role_relation / constraint_context | 任务情境维度 |
| `dimensionFields.goal` | string | 目标 |
| `dimensionFields.stage` | string | 当前阶段 |
| `dimensionFields.deadline` | string | 时间压力 |
| `dimensionFields.stakeholders` | string[] | 协作方 |

规则：只记录项目级或工作流级上下文，不记录单次工具调用细节。

#### `rules`

| 字段 | 取值 | 说明 |
|------|------|------|
| `dimensionFields.source` | personal / project / team / enterprise / compliance | 规范来源 |
| `dimensionFields.strength` | hard / soft | 约束强度 |
| `dimensionFields.consequence` | high / medium / low / unknown | 违反后果 |
| `dimensionFields.priority` | number | 合规最高 |

规则：`soft` 约束默认进入候选区，不直接进入必读层；compliance 不因数量上限淘汰。

#### `experience`

| 字段 | 取值 | 说明 |
|------|------|------|
| `dimensionFields.what` | string | 做了什么决策或方法 |
| `dimensionFields.why` | string | 为什么这样做，必填 |
| `dimensionFields.outcome` | string | 结果，可后补 |
| `dimensionFields.transferability` | local / project / cross_project / general | 可迁移边界 |
| `dimensionFields.memoryType` | episodic / semantic | 具体经验或通用方法论 |

规则：缺 `why` 不进入 experience。只有 what 而没有 why 的信息最多作为 task_context 或 fact 候选。

#### `resource`

| 字段 | 取值 | 说明 |
|------|------|------|
| `dimensionFields.subType` | doc / kb / tool / skill / connector / expert / system | 资源类型 |
| `dimensionFields.entryPoint` | string | 入口 URI、文件、工具 ID 或 skill ID |
| `dimensionFields.metaKnowledge` | string | 这个资源解决什么问题 |
| `dimensionFields.trustLevel` | low / medium / high / authority | 信任度 |
| `dimensionFields.boundary` | string | 使用边界 |

规则：resource 只存指针、用途、边界和信任度，不把外部知识库全文复制进长期记忆。

### 6.4 Edge

工作记忆图谱需要独立关系层：

```typescript
interface MemoryEdge {
  id: string;
  scope: MemoryScope;
  sourceId: string;
  targetId: string;
  predicate:
    | "derives_from"
    | "constrains"
    | "supports"
    | "contradicts"
    | "supersedes"
    | "references"
    | "uses"
    | "belongs_to"
    | "promoted_to"
    | "grounded_by";
  confidence: number;
  evidenceChunkIds: string[];
  reason?: string;
  createdAt: number;
  updatedAt?: number;
}
```

关系约束：

1. `contradicts` 必须进入冲突审查队列，不能静默覆盖。
2. `supersedes` 必须同步更新 source node 的 `lifecycleStatus=superseded`。
3. `promoted_to` 只能指向 SKILL 或团队资产候选，不能指向远程原始记忆。
4. 所有 edge 都必须有 evidence。

### 6.5 SummaryNode

```typescript
interface SummaryNode {
  id: string;
  scope: MemoryScope;
  treeType: "source" | "topic" | "global" | "slot"; // slot 仅 v1+，v0.x 使用 SlotSnapshot
  treeKey: string;
  semanticType?: "profile" | "task_context" | "rules" | "experience" | "resource";
  level: number;
  title: string;
  summary: string;
  childNodeIds: string[];
  leafIds: string[];
  evidenceChunkIds: string[];
  sourceNodeIds: string[];
  entityIds: string[];
  relationIds: string[];
  tokenCount: number;
  timeRange?: { startAt: number; endAt: number };
  status: "open" | "sealed" | "stale" | "archived";
  version: number;
  trigger: "bucket_full" | "ttl_flush" | "manual_rebuild" | "critical_change";
  createdAt: number;
  sealedAt?: number;
  metadata: Record<string, unknown>;
}
```

`slot` tree 是本方案相对 OpenHuman 的新增适配：OpenHuman 的 source/topic/global tree 解决来源、主题、时间；memory-autodb 还需要把 5 个本质问题稳定组织成 prompt slot，因此需要 slot tree 或 slot snapshot。

---

## 7. 结构化知识图谱设计

### 7.1 统一 GraphRepository，区分查询 intent

memory-autodb 需要同时支持实体关系和记忆演化关系，但底层不应拆成两套 repository。v0.x 应使用统一 `GraphRepository`，通过 `nodeType` 和 `edgeType` 区分：

```typescript
interface GraphNode {
  id: string;
  scope: MemoryScope;
  nodeType: "entity" | "memory" | "summary" | "skill_candidate";
  label: string;
  metadata: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  scope: MemoryScope;
  edgeType: "entity_relation" | "memory_relation";
  predicate: string;
  sourceId: string;
  targetId: string;
  evidenceChunkIds: string[];
  metadata: Record<string, unknown>;
}
```

查询 API 可以按 intent 分层，但 storage/index 统一，避免“概念上两套图谱 -> 实现上两套存储 -> 同步问题”的滑坡。

| 图谱 | 作用 | 节点 | 典型查询 |
|------|------|------|----------|
| Entity Graph | 现实世界实体关系 | person/org/project/file/tool/topic | “A 和 B 有什么关系？” |
| Work Memory Graph | 工作记忆演化关系 | MemoryNode/SummaryNode/SkillCandidate | “这个决策从哪里来，后来被什么替代？” |

建议查询 facade：

| API | 说明 |
|-----|------|
| `queryEntityGraph(scope, entityId | query)` | 实体关系探索 |
| `queryMemoryEvolution(scope, memoryId)` | 记忆证据、替代、冲突、升格链路 |

### 7.2 Entity Graph

Entity Graph 用于跨文档、跨会话、跨来源聚合实体。

| Entity type | 示例 | 主要来源 |
|-------------|------|----------|
| person | 用户、客户、同事 | profile、task_context、resource |
| organization | 团队、企业、客户 | task_context、rules |
| project | 工作项目、代码项目 | task_context、experience |
| file | README、配置文件、设计文档 | ingest chunk |
| tool | OpenClaw、MCP、连接器 | resource |
| skill | code-review、memory-review | resource、promotion |
| topic | “记忆树”、“合规整改” | experience、summary |
| concept | “RRF 融合”、“slot 注入” | knowledge chunk |

Entity Graph 的 relation allowlist：

| Predicate | 说明 |
|-----------|------|
| `mentions` | 文档或记忆提到实体 |
| `works_on` | 用户、Agent 或团队处理某项目 |
| `uses` | 项目、用户或 Agent 使用工具、技能、连接器 |
| `owns` | 用户、团队拥有资源或规则 |
| `depends_on` | 项目、任务或模块依赖实体 |
| `decided` | 某主体做出决策 |
| `prefers` | 用户或团队偏好 |
| `blocked_by` | 任务或经验被某问题阻塞 |
| `fixed_by` | 问题由某改动修复 |
| `related_to` | 弱相关，低权重 |

### 7.3 Work Memory Graph

Work Memory Graph 用于描述记忆本身如何产生、冲突、替代、升格。

| Edge | 示例 | 行为影响 |
|------|------|----------|
| `grounded_by` | rule grounded_by chunk | 支持证据下钻 |
| `derives_from` | experience derives_from decision chunk | 支持决策链 |
| `constrains` | rules constrains resource | 约束工具调用 |
| `supports` | experience supports task_context | 提高召回权重 |
| `contradicts` | rules contradicts rules | 进入人工审查 |
| `supersedes` | task_context v2 supersedes v1 | 旧节点退出必读层 |
| `promoted_to` | experience promoted_to skill | 降低自动召回，转向 SKILL |
| `references` | resource references document | 速查中展示入口 |

### 7.4 Evidence 强约束

图谱中的每个实体、关系、摘要必须能追溯到以下至少一种证据：

1. `evidenceChunkIds`
2. `sourceNodeIds`
3. `observationIds`
4. `documentId + chunk ordinal`
5. 用户显式创建记录和 audit log

Console 展示图谱时，不能只展示“AI 生成的关系”。每条关系至少展示一条 evidence preview，并允许下钻到原始 chunk 或 memory node。

---

## 8. 记忆树设计

### 8.1 为什么需要树

向量检索解决相似度，图谱解决关系，记忆树解决压缩和导航。

| 问题 | 向量 | 图谱 | 记忆树 |
|------|------|------|--------|
| “最近这个项目发生了什么？” | 不稳定 | 只能列关系 | topic/global summary |
| “某来源文件有什么历史变化？” | 需要精确 query | 关系过碎 | source tree |
| “Agent 启动前应该知道什么？” | 容易碎片化 | 不适合 prompt | slot tree |
| “今天全局有什么重要变化？” | 召回不完整 | 时间聚合弱 | global daily digest |

### 8.2 树与快照的分阶段边界

v2 评审后，v0.x 不实现完整 Slot Tree。5 槽位上下文先由 `SlotSnapshotCache` 提供；Tree 只作为数据量增长后的压缩/导航能力。

| 能力 | v0.x 策略 | v1+ 策略 | 作用 |
|------|-----------|----------|------|
| SlotSnapshot | 必做 | 持续保留 | 生成 5 槽位必读层 |
| Source Tree | v0.4 起可做第一棵持久树 | 完善 seal / drilldown | 按来源折叠，如文件、会话、连接器 |
| Topic Tree | 延后 | 有足够热主题后开启 | 按实体、主题、项目导航 |
| Global Tree | 延后 | 有跨来源 digest 需求后开启 | 时间维度全局摘要和 daily digest |
| Slot Tree | 不做 | 只有 SlotSnapshot 不够用时再演进 | 历史 slot 压缩和版本导航 |

`SlotSnapshot` 建议结构：

```typescript
interface SlotSnapshot {
  scope: MemoryScope;
  semanticType: MemorySemanticType;
  topNodes: MemoryNode[];
  generatedAt: number;
  ttlMs: number;
  sourceVersion: string;
  warnings: string[];
}
```

### 8.3 写入与 seal 流程

```text
L0 MemoryNode / Chunk admitted
  -> refresh affected SlotSnapshot when needed
  -> append source buffer when source tree enabled
  -> append topic/global buffers only when feature flag enabled
  -> seal tree buffers in background
```

### 8.4 SlotSnapshot 的差异化策略

| Type | L1 生成策略 | 必读层注入策略 | 默认预算 |
|------|-------------|----------------|----------|
| `profile` | 合并稳定画像，控制长度 | 全文导入 | 600 字符 |
| `task_context` | 合并项目目标、阶段、约束 | 全文导入 | 1000 字符 |
| `rules` | 去重、排序、限制条数 | 条目全量导入，合规优先 | 1000 字符 |
| `resource` | 只保留概要索引和入口 | 注入 top 资源指针 | 600 字符 |
| `experience` | 只保留概要索引和边界 | 注入 top 经验索引 | 800 字符 |

SlotSnapshot 不是替代 Source/Topic/Global Tree。SlotSnapshot 负责“Agent 必读”，其他树负责“探索和概览”。只有当 SlotSnapshot 无法处理大量历史版本、需要 slot 历史导航或压缩时，才升级为 Slot Tree。

### 8.5 TTL 与触发建议

| Tree | bucket 触发 | TTL 触发 | 备注 |
|------|-------------|----------|------|
| snapshot/profile | 相关 active node 变化 | 30 天 | 画像宁可少变 |
| snapshot/task_context | 当前 project node 变化 | 7 天 | 项目状态需要新鲜 |
| snapshot/rules | hard rule 变化 | 变更即重建 | 规则必须稳定 |
| snapshot/resource | resource 新增/撤销 | 变更即重建 | 资源卸载要立即生效 |
| snapshot/experience | experience admitted/promoted | 7 天 | 经验以索引方式注入 |
| source tree | token budget 满 | 24 小时 | v0.4+ 来源导航 |
| topic tree | hotness 达阈值 | 24 小时 | v1+ 热主题优先 |
| global tree | 每日 | 每日 | v1+ daily digest |

### 8.6 树下钻 API

建议新增或扩展：

| API | 说明 |
|-----|------|
| `POST /v1/tree/walk` | 从 scope 或 treeKey 开始浏览摘要树 |
| `POST /v1/tree/drill-down` | 从某个 SummaryNode 下钻子节点 |
| `POST /v1/tree/fetch-leaves` | 拉取摘要背后的 L0 evidence |
| `POST /v1/context/slots` | 返回 5 槽位上下文和每槽 provenance |
| `POST /v1/console/tree` | Console 专用聚合视图 |

MCP 可暴露 `memory_tree_walk`、`memory_tree_drill_down`、`memory_context_slots`。

---

## 9. 运行机制

### 9.0 Agent 运行时快路径

Agent 和中间件的交互应保持简单、稳定、低延迟。推荐把一次任务运行拆成 4 个时点：

```text
task_start
  -> memory_context_fast(scope, task)
  -> 返回 5 槽位上下文 + task hints + warnings

task_running
  -> memory_observe_light(scope, event)
  -> 返回 ack + traceId，不阻塞 Agent

task_needs_more
  -> memory_lookup(scope, query, filters)
  -> 返回可引用 evidence 和下钻入口

task_end
  -> memory_session_commit(scope, transcriptRef, summary)
  -> 异步触发候选抽取、索引、树折叠
```

Agent 默认只需要使用 `context_fast`、`observe_light`、`lookup`、`session_commit` 四类能力。内部的 5 type、候选区、图谱构建、树 seal、远程同步、升格治理由中间件自己调度。

#### 输入最小化

Agent 快路径输入应尽量短：

```typescript
interface AgentTaskContextRequest {
  scope: MemoryScopeInput;
  task: string;
  intent?: "chat" | "coding" | "research" | "writing" | "ops" | "unknown";
  constraints?: string[];
  tokenBudget?: number;
  latencyBudgetMs?: number;
}
```

#### 输出可直接使用

输出必须可直接放进 prompt，同时保留结构化元数据：

```typescript
interface AgentTaskContextResponse {
  content: string;
  slots: FiveSlotContextBlock["slots"];
  taskHints: Array<{
    kind: "rule" | "experience" | "resource" | "warning";
    text: string;
    evidenceIds: string[];
  }>;
  actions: Array<{
    type: "lookup" | "drill_down" | "open_resource";
    label: string;
    input: Record<string, unknown>;
  }>;
  freshness: {
    slotSnapshotAt?: number;
    staleSlots: string[];
  };
  warnings: string[];
}
```

关键约束：Agent 不需要知道候选区在哪里，也不需要知道 L1/L2 如何生成；它只需要知道“现在应该遵守什么、参考什么、还能去哪里查”。

### 9.1 写入入口

| 入口 | 触发者 | 进入路径 |
|------|--------|----------|
| `memory_store` | 用户或 OpenClaw 工具 | 已结构化内容直接进入 candidate 或 memory |
| `memory_observe` | Hook / Adapter | observation -> extractor job |
| `memory_ingest` | 文件、目录、连接器 | document -> chunk -> extractor/tree jobs |
| `chat_end` | 产品会话结束 | session document -> 5 type extractor |
| 用户显式保存 | Web/产品 UI | 直接写目标容器，置信度最高 |
| 系统关键事件 | 项目创建、资源安装 | task_context/resource/rules candidate |

### 9.1.1 对外可见能力与内部能力边界

5 问题、5 type、候选区是底层逻辑驱动，但不能全部原样暴露给 Agent。对外应按使用者分层：

| 能力 | Agent 可直接用 | 产品 UI / Console 可用 | 内部后台使用 | 说明 |
|------|----------------|------------------------|--------------|------|
| 5 槽位上下文 | 是 | 是 | 是 | Agent 启动任务的主入口 |
| 基础速查 lookup | 是 | 是 | 是 | 返回 evidence，不暴露内部候选 |
| observation 轻写入 | 是 | 是 | 是 | Agent 只提交观察，不决定长期入库 |
| 显式保存 memory_save | 有限制 | 是 | 是 | Agent 仅在用户明确要求“记住”时可用 |
| 5 type 分类 | 只读可见 | 可编辑/确认 | 是 | Agent 可看到 type，但不直接改分类规则 |
| 候选区 | 否 | 是 | 是 | 防止 Agent 自行批准候选 |
| 图谱/树下钻 | 是 | 是 | 是 | 只读检索能力 |
| 冲突解决 | 否 | 是 | 是 | 需要用户或管理员确认 |
| SKILL 升格 | 否 | 是 | 是 | 非 Agent 通道 |
| 远程团队贡献 | 否 | 是 | 是 | 必须 UI/API 审核 |
| tree seal / digest | 否 | 否 | 是 | 内部调度 |
| embedding / LLM job | 否 | 否 | 是 | 内部成本控制 |

Agent 的权限边界要保守：可以输入事实、观察和显式保存请求；可以读取上下文、证据和下钻结果；不能批准候选、上传团队、修改远程权威源或触发高成本后台任务。

### 9.2 写入状态机

```text
raw_input
  -> observed
  -> canonicalized
  -> chunked
  -> extracted_candidate
  -> admitted_l0
  -> indexed
  -> graphed
  -> buffered
  -> sealed_l1
  -> promoted_or_archived
```

每一步都写 job 和 audit，失败不应吞掉。Console Jobs 页面要能看到卡在哪一步。

### 9.2.1 实时数据处理与快速迭代

为保证运行中“快而准”，数据应按增量事件实时进入系统，而不是等会话结束一次性处理。

```text
event stream
  -> append observation log
  -> fast filters
       secret scan
       prompt injection marker
       dedupe hash
       privacy label
  -> light index
       recent ring buffer
       BM25 delta
       scope hot cache
  -> async fanout
       embed job
       5 type candidate extraction
       entity/relation extraction
       slot snapshot refresh
       tree buffer append
```

#### 实时缓存

| 缓存 | 内容 | 失效策略 |
|------|------|----------|
| `slotSnapshotCache` | 每个 scope 的 5 槽位 L1 快照 | 相关 type 有 admitted L0 或 TTL 到期 |
| `recentObservationRing` | 最近 N 条低风险 observation 摘要 | 会话结束或容量满 |
| `taskLookupCache` | task query -> recall hits | scope 变更、相关 chunk 入库、短 TTL |
| `entityHotCache` | 热实体和 topic | relation/entity 更新 |
| `resourceIndexCache` | resource 指针和边界 | resource 新增/撤销 |

#### 快速迭代策略

1. 显式保存和 hard rules 写入后立即刷新对应 slot snapshot。
2. 低置信自动抽取先进入 candidate，不污染当前 slot。
3. `recentObservationRing` 可以作为“本轮会话短记忆”，只在当前任务内参与召回。
4. embedding 失败时保留 BM25 和 recent 检索，不阻塞上下文构建。
5. slot snapshot 旧但可用时先返回，并在 warnings 标记 stale，同时后台刷新。

### 9.3 候选区

自动抽取的记忆默认先进入 `session_candidate`，除非满足高置信度和低风险条件。

| Type | 入库下限 | 直写目标容器 | 前置丢弃 |
|------|----------|--------------|----------|
| `profile` | confidence >= 0.7 | >= 0.9 且用户多次表达 | value=unknown |
| `task_context` | confidence >= 0.7 | >= 0.9 且项目级信息明确 | 只影响当前一句话 |
| `rules` | confidence >= 0.8 | >= 0.9 且 hard constraint | 推断出的 soft rule |
| `experience` | confidence >= 0.75 | >= 0.9 且 what+why 完整 | 缺 why |
| `resource` | confidence >= 0.7 | >= 0.95 或用户挂载 | trustLevel=low |

候选不是长期记忆，不进入必读层。为了避免候选区变成第二个长期垃圾桶，必须有自动淘汰：

| 条件 | 动作 |
|------|------|
| 30 天内未被 lookup/recall 命中过 | 自动删除，仅保留 audit 统计 |
| 30 天内被命中过但用户未确认 | 标记 `archived_candidate`，不参与自动召回 |
| 用户批量接受 | 写入目标容器并生成 admitted L0 |
| 用户批量拒绝 | 标记 rejected，后续同 contentHash 降权 |

Console Candidates 不能只做逐条审核，必须提供批量操作：

1. 按 type 全部接受或拒绝。
2. 按 confidence 阈值批量拒绝。
3. 按 source/session 批量归档。
4. 一键清理过期候选。

### 9.4 读取与上下文注入

```text
buildContext(scope, task)
  -> normalize scope
  -> load slot snapshots
       profile
       task_context
       rules
       resource
       experience
  -> run task-related retrieval
       BM25 + vector + graph + tree
  -> merge remote readonly cache
  -> enforce priority and privacy
  -> pack fixed slots
  -> append task-related evidence
  -> prompt-safe escaping
```

返回结构不应只有 `content`，还应包含每个 slot 的来源：

```typescript
interface FiveSlotContextBlock {
  scope: MemoryScope;
  slots: Array<{
    type: "profile" | "task_context" | "rules" | "resource" | "experience";
    question: string;
    content: string;
    tokenEstimate: number;
    sourceNodeIds: string[];
    evidenceChunkIds: string[];
    warnings: string[];
  }>;
  taskRelated: RecallHit[];
  content: string;
  tokenEstimate: number;
}
```

### 9.4.1 快速召回策略

`context_fast` 默认不跑全量检索。推荐顺序：

```text
1. 读取 slotSnapshotCache
2. 合并 remote readonly cache 的 rules/resource/experience 摘要
3. 对 task 执行轻量 BM25 + recent ring 检索
4. 命中 resource/experience 时只返回摘要和下钻 action
5. 若 latencyBudgetMs 允许，再补 vector/topical/tree hits
6. pack context，返回 freshness 和 warnings
```

这意味着 Agent 启动任务时优先拿到“稳定答案”，不是等待最全的检索结果。重检索放在 `memory_lookup` 或 `drill_down` 中按需触发。

### 9.4.2 准确性策略

快不代表粗糙。准确性通过以下机制保证：

1. rules slot 永远优先于 experience/resource。
2. revoked/superseded/private 默认排除。
3. 每个 slot 带 provenance，便于用户或 Console 纠错。
4. task_context 只取当前 project/workspace scope，不跨项目漂移。
5. experience 必须有 why 和 transferability，避免错误泛化。
6. resource 必须有 boundary，避免 Agent 误用工具或连接器。

### 9.5 冲突与替代

规则、画像、项目上下文都可能变化。不能简单追加。

| 场景 | 处理 |
|------|------|
| 新 rules 与旧 rules 冲突 | 写 `contradicts` edge，进入审查队列 |
| 新 task_context 表示阶段变化 | 新节点 `supersedes` 旧节点，旧节点退出必读层 |
| profile 同维度出现新稳定证据 | 合并或替代旧值，保留 sourceNodeIds |
| resource 被卸载或失效 | lifecycleStatus=revoked |
| experience 被 SKILL 覆盖 | lifecycleStatus=promoted，保留按需检索 |

---

## 10. 双端与多产品架构

### 10.1 运行模式

| 模式 | 说明 | 适用 |
|------|------|------|
| embedded | 与 OpenClaw 同进程运行 | 当前兼容 |
| local-server | 本机 daemon，多个本地产品共享 | Codex/Cursor/OpenClaw 共用 |
| remote-client | v1+，本机只有 adapter，连接远程服务 | 团队部署 |
| remote-server | v1+，远程 memory-autodb 服务 | 企业共享 |
| backend-proxy | v1+，代理到 agentmemory/Mem0/Cognee | 对接外部后端 |

v0.x 默认只承诺 `embedded` 和 `local-server`。默认数据栈是 LanceDB + 本地文件 + embedding API，不引入远程团队/企业同步。

### 10.2 v1+ 远程是只读权威源

借鉴 `copy-from-mate` 的双端架构，未来团队部署时 Agent 不应直接上传团队记忆。远程团队/企业记忆来源只有：

1. 管理员录入。
2. 用户在 UI 主动分享。
3. 后端在授权前提下从日志聚合并审核。
4. 本地 experience 先晋升为 SKILL，再由用户分享。

Agent 只看到本地合并后的结果，对远程来源无感知，但 provenance 中保留 `origin=remote/team/enterprise`。这一节不进入 v0.x 默认交付。

### 10.3 v1+ 远程缓存合并策略

| Type | 合并策略 |
|------|----------|
| `profile` | 本地用户画像优先，远程组织身份只作为补充 |
| `task_context` | 不合并远程 |
| `rules` | enterprise > team > project > personal |
| `experience` | 本地项目经验 + 远程最佳实践按 task relevance 排序 |
| `resource` | enterprise/team 权威资源优先，本地资源补充 |

---

## 11. Web Console 优化方案

Web Console 不能只是数据库 viewer。它应成为“记忆速查、整体预览、治理审查”的基础界面。

### 11.1 信息架构

Console 不应一次性实现 8 个页面。当前 vanilla TypeScript MVP 可以支撑 Overview/Lookup，但如果要做候选审核、图谱和树可视化，建议升级到 Vite + React + Tailwind + TanStack Query。页面按三档推进：

| 页面 | 目标 | 核心组件 |
|------|------|----------|
| Overview | v0.1 核心页：一眼看到当前 scope 的记忆健康 | 5 type 数量、SlotSnapshot freshness、失败 jobs、SLO 指标 |
| Quick Lookup | v0.1 核心页：基础知识速查 | 搜索框、type filter、source filter、evidence preview、复制引用 |
| Candidates | v0.2 治理页：候选审核 | 批量接受/拒绝/归档、过期清理 |
| Jobs & Audit | v0.3 治理页：运维治理 | job 状态、失败重试、删除/导出审计 |
| Five Slots | v0.3 辅助页：查看 Agent 当前会被注入什么 | 5 槽位内容、预算、来源、冲突警告 |
| Memory Tree | v0.4+ 可视化页：整体预览和下钻 | 先做 source tree，topic/global/slot 延后 |
| Graph | v0.4+ 可视化页：关系图谱 | 统一 GraphRepository 的基础视图 |
| Resources | v0.5+ 资源页 | resource 指针、连接器边界、SKILL 关联 |

### 11.2 Overview 必备指标

| 指标 | 说明 |
|------|------|
| Active memories by type | 5 type 当前有效数量 |
| Candidate backlog | 候选区积压 |
| Slot freshness | 每个槽位最近更新时间 |
| Tree seal status | source/topic/global/slot 是否有 stale buffer |
| Graph health | entity/relation/evidence 覆盖率 |
| Retrieval health | vector/text/tree index ready 比例 |
| Privacy warnings | private/sensitive 被过滤数量 |
| Failed jobs | 后台任务失败和重试 |

### 11.3 Quick Lookup 返回结构

速查应默认返回“摘要 + 证据 + 可下钻入口”，不是裸文本。

```typescript
interface ConsoleLookupResult {
  id: string;
  kind: MemoryKind;
  semanticType?: MemorySemanticType;
  title: string;
  preview: string;
  sourceLabel: string;
  confidence: number;
  hotness: number;
  lifecycleStatus: string;
  scoreBreakdown: Record<string, number>;
  evidence: Array<{
    id: string;
    label: string;
    preview: string;
  }>;
  actions: Array<"open" | "copy_reference" | "drill_down" | "show_graph">;
}
```

### 11.4 Console 权限

1. Console API 只能经服务层访问，不能直连数据库。
2. private 内容默认显示 `[private]`，需要明确权限才能查看。
3. 删除、撤销、晋升、分享必须写 audit。
4. remote/team/enterprise 内容在本地 Console 中默认只读。

---

## 12. API 与协议演进

### 12.0 协议设计原则

对外协议按“快路径优先、结构化输出、内部细节隐藏”设计：

1. Agent 一次任务开始最多调用 1 次上下文接口。
2. Agent 运行中 observation 写入必须 fire-and-forget，可返回 ack 但不等待 LLM。
3. Agent 查询返回 evidence、score、action，不返回未审核候选。
4. 产品 UI 和 Console 才能访问 candidates、audit、promotion。
5. 所有高成本能力都必须显式传 `mode=deep` 或由后台 job 触发。

### 12.1 REST

保留现有 API，并新增语义化端点：

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/observe` | 捕获原始观察，进入 extractor |
| `POST` | `/v1/memories` | 写结构化记忆，`kind` 必填、`semanticType` 可选 |
| `POST` | `/v1/recall` | 混合检索，返回 ranked hits |
| `POST` | `/v1/context` | 兼容旧 context |
| `POST` | `/v1/context/slots` | 生成 5 槽位上下文 |
| `POST` | `/v1/tree/walk` | v0.4+ 记忆树浏览，先支持 source tree |
| `POST` | `/v1/tree/drill-down` | v0.4+ 摘要下钻 |
| `POST` | `/v1/graph/query` | v0.4+ 图谱查询 |
| `POST` | `/v1/candidates/review` | v0.2+ 候选审核，Console 使用 |
| `POST` | `/v1/promotions/skill-candidates` | v0.5+ 生成或查询 SKILL 候选 |
| `POST` | `/v1/sync/pull` | v1+ 拉取远程只读快照或增量 |

建议新增 Agent 快路径端点：

| 方法 | 路径 | 说明 | 延迟目标 |
|------|------|------|----------|
| `POST` | `/v1/agent/context` | Agent 任务启动上下文，返回 5 槽位 + task hints | 单机 P95 < 80ms |
| `POST` | `/v1/agent/observe` | 轻量 observation 写入，返回 ack/job ids | 单机 P95 < 20ms |
| `POST` | `/v1/agent/lookup` | 运行中按需速查，默认 text/recent/slot snapshot | 单机 P95 < 100ms |
| `POST` | `/v1/agent/session-end` | 会话结束提交摘要或 transcriptRef，异步处理 | 单机 P95 < 50ms |

`/v1/agent/*` 是对 Agent 友好的 facade；内部仍调用 `MemoryService`、slot builder、retrieval orchestrator 和 job queue。

### 12.2 MCP

MCP 工具分三层：

| 层 | Tool | 说明 |
|----|------|------|
| 基础 | `memory_save`, `memory_recall`, `memory_context`, `memory_health` | 兼容现有能力 |
| 结构 | `memory_context_slots`, `memory_tree_walk`, `memory_graph_query` | 结构化检索 |
| 治理 | `memory_candidates`, `memory_forget`, `memory_audit` | 候选和治理，默认需要权限 |

Agent 默认只能使用基础和结构工具。治理工具对产品 UI 或管理员开放。

#### 推荐 MCP 工具面

面向 Agent 的 MCP 工具应减少数量，但每个工具语义要强：

| Tool | Agent 是否默认可用 | 输入 | 输出 | 用途 |
|------|-------------------|------|------|------|
| `memory_context_fast` | 是 | `scope, task, tokenBudget, latencyBudgetMs` | prompt-safe context + slots + warnings | 任务启动 |
| `memory_observe_light` | 是 | `scope, eventType, text, metadata` | `ack, traceId, queuedJobs` | 运行中轻量写入 |
| `memory_lookup` | 是 | `scope, query, filters, mode=fast/deep` | hits + evidence + actions | 任务中速查 |
| `memory_save_explicit` | 是，需用户显式触发 | `scope, semanticType?, text, reason` | stored/candidate/rejected | 用户要求“记住” |
| `memory_session_commit` | 是 | `scope, summary?, transcriptRef?` | ack + jobs | 会话结束 |
| `memory_tree_walk` | v0.4+ 可选 | `scope, treeType, treeKey` | summaries + drill actions | 结构下钻 |
| `memory_graph_query` | v0.4+ 可选 | `scope, query/entityId, depth` | graph paths + evidence | 关系查询 |
| `memory_candidates_review` | 否 | candidate 操作 | review result | Console/管理员 |
| `memory_promote_skill` | v0.5+ 否 | experience/skill candidate | promotion result | 产品 UI |
| `memory_sync_remote` | v1+ 否 | sync request | sync result | 后台/管理员 |

与当前基础工具的映射：

| 当前工具 | vNext 角色 |
|----------|------------|
| `memory_context` | 保留兼容；内部可转调 `memory_context_fast` |
| `memory_recall` | 保留兼容；逐步收敛为 `memory_lookup` |
| `memory_save` | 保留兼容；明确为 `memory_save_explicit` 的底层入口 |
| `memory_observe` | 改为轻量 observation，不应直接等同 storeMemory |
| `memory_ingest` | 面向产品/后台，不作为 Agent 默认工具 |
| `memory_forget` | 默认不暴露给 Agent |
| `memory_health` | 可保留，只返回简化健康状态 |

#### MCP 输出格式约束

MCP 返回给 Agent 的内容必须避免“工具输出过大”和“含混不可用”：

1. 默认返回 `content` 字符串 + `structuredContent`。
2. 每条 hit 不超过摘要 240 字符，完整内容通过 action 下钻。
3. 默认最多 5 条 task hints、5 条 lookup hits。
4. `warnings` 必须显式提示 stale、budget_exceeded、private_filtered、deep_index_unavailable。
5. 所有 retrieved text 都按 prompt-safe formatter 包装为不可信历史数据。

### 12.3 SDK

JS SDK 应提供高层调用：

```typescript
const memory = new MemoryClient({ baseURL, apiKey });

await memory.observe({ scope, event });
await memory.save({ scope, semanticType: "rules", title, body });
const context = await memory.buildFiveSlotContext({ scope, task });
const overview = await memory.console.overview(scope);
```

SDK 也应暴露 Agent facade：

```typescript
await memory.agent.context({ scope, task, tokenBudget: 2000, latencyBudgetMs: 200 });
await memory.agent.observeLight({ scope, eventType: "tool_result", text });
await memory.agent.lookup({ scope, query, mode: "fast" });
await memory.agent.sessionEnd({ scope, summary, transcriptRef });
```

---

## 13. 成本与性能控制

### 13.1 性能目标

| 路径 | 目标 | 超时策略 |
|------|------|----------|
| `memory_context_fast` / `/v1/agent/context` | 单机 P95 < 80ms | 返回 stale snapshot + warning |
| `memory_observe_light` | 单机 P95 < 20ms | 只写 observation log 和 job queue |
| `memory_lookup` fast | 单机 P95 < 100ms | text/recent/slot snapshot 优先，跳过 deep vector/tree |
| `memory_lookup` deep | 单机 P95 < 800ms | 可使用 vector/graph/tree，下钻明确触发 |
| `memory_session_commit` | 单机 P95 < 50ms | ack 后异步处理 |
| slot snapshot refresh | 秒级 | 后台 job，可合并多次更新 |
| summary seal / SKILL candidate | 分钟级 | 批处理，低优先级 |

这些目标基于默认单机配置：LanceDB + 本地文件 + embedding API。远程模式的 SLO 在 v1+ 另行定义。

### 13.2 成本预算

```typescript
interface MemoryBudgetPolicy {
  scopeKey: string;
  request: {
    maxLatencyMs: number;
    maxOutputTokens: number;
    maxLookupHits: number;
  };
  daily: {
    maxEmbeddingTokens: number;
    maxLlmInputTokens: number;
    maxLlmOutputTokens: number;
    maxDeepJobs: number;
  };
  degradation: {
    allowStaleSlots: boolean;
    skipVectorOnTimeout: boolean;
    skipGraphOnTimeout: boolean;
    useExtractiveSummaryFallback: boolean;
  };
}
```

预算超限不能让请求无限变慢。系统应返回部分结果和明确 warning：

| warning | 含义 | Agent 处理 |
|---------|------|------------|
| `budget_exceeded` | 超过 token/LLM/embedding 预算 | 使用当前结果，不触发 deep lookup |
| `stale_slot_snapshot` | 槽位快照过期但可用 | 谨慎使用，必要时 lookup |
| `vector_unavailable` | 向量索引不可用或超时 | 使用 BM25/recent/tree |
| `graph_unavailable` | 图谱不可用或超时 | 不做关系推断 |
| `private_filtered` | 有 private 内容被过滤 | 不要求展开私密内容 |

### 13.3 降本策略

| 策略 | 说明 |
|------|------|
| Slot snapshot 优先 | 任务启动只读已生成快照，避免每次重排全部记忆 |
| 分级检索 | fast 默认 BM25/recent/tree summary；deep 才启用 vector/graph |
| 增量 embedding | contentHash 去重，chunk 未变不重新 embedding |
| 批量后台任务 | embedding/entity/seal 合并批处理 |
| Extractive fallback | LLM 不可用时用 evidence 句子生成临时摘要 |
| Hot entity routing | 只有热实体进入 topic tree，冷实体只保留 source/global |
| Resource 指针化 | resource 不复制长文档，减少 token 和存储 |
| Candidate gate | 低置信自动抽取不进入 slot，减少错误和重算 |
| Prompt budget 固定 | 5 槽位固定预算，超出优先保 rules/task_context |

### 13.4 准确性与成本的取舍

默认策略：

1. rules 和 task_context 优先准确，必要时牺牲 experience/resource 数量。
2. 启动上下文优先稳定快照，不追求全量最优召回。
3. 深度图谱和树下钻由 Agent 或用户明确触发。
4. LLM 只用于“提升下一次质量”，不阻塞当前任务。
5. 对低置信候选宁可不注入，也不为了召回覆盖率污染上下文。

### 13.5 可观测性

每次 Agent 快路径请求都应记录：

| 指标 | 用途 |
|------|------|
| `latency_ms` | 判断是否满足 SLO |
| `cache_hit_rate` | 判断 slot/retrieval 缓存效果 |
| `token_estimate` | 控制 prompt 成本 |
| `hits_by_source` | 看 BM25/vector/tree/graph 贡献 |
| `warnings` | 暴露降级原因 |
| `jobs_enqueued` | 看实时输入造成的后台压力 |
| `candidate_accept_rate` | 调整 extractor 阈值 |
| `slot_refresh_lag` | 判断快照是否滞后 |

这些指标应进入 Console Overview 和 Jobs/Audit 页面。

---

## 14. 可靠性架构

### 14.1 可靠性目标

memory-autodb 是 Agent 的上下文基础设施，因此可靠性目标不是传统“服务可用”就够了，还包括“不能给 Agent 错误或越权的上下文”。

| 目标 | 说明 |
|------|------|
| Read correctness | 召回结果必须符合 scope、visibility、lifecycle |
| Write durability | observation 和用户显式保存不能因后台 job 失败而丢失 |
| Index consistency | 索引可延迟，但必须能识别版本和滞后 |
| Safe degradation | vector/graph/tree/LLM 失败时仍能返回安全降级上下文 |
| Replayability | 关键抽取、seal、promotion 可基于 evidence 重放 |
| Auditability | store/delete/promote/sync/export 都可审计 |

### 14.2 LanceDB 单机一致性边界

默认单机配置是 LanceDB + 本地文件。LanceDB 不提供跨表事务，因此文档不能承诺关系型数据库意义上的跨表强一致。v0.x 的可靠性目标应改为：**关键写入 durable，派生视图 replayable，跨表状态最终一致**。

| 数据 | 单机一致性目标 | 说明 |
|------|----------------|------|
| WAL / operation log | durable | 关键写操作先写 WAL，本地落盘 |
| `observations` | durable | 写入后可用于 replay |
| `memory_nodes` | durable | 用户显式保存和 admitted L0 尽快落盘 |
| `audit_logs` | best-effort + replayable | audit 写失败可由 WAL 重放补齐 |
| `chunks` | durable per write | document/chunk/hash 去重尽量同批处理 |
| `text/vector indexes` | eventually consistent | 允许滞后，读取时暴露 index version |
| `entities/relations` | eventually consistent | 可从 evidence 重建，不作为唯一事实源 |
| `summary_nodes` | eventually consistent | 可重生，必须保留 sourceNodeIds |
| `slot_snapshots` | eventually consistent | 可 stale，但必须标注 generatedAt/version |

建议引入轻量 WAL：

```typescript
await wal.append({ op: "store_memory", scope, id, contentHash, timestamp });
await memoryRepository.store([record]);
await auditRepository.append({ op: "store_memory", id });
await wal.commit(logId);
```

daemon 启动时扫描未 commit 的 WAL，补齐 memory/audit/index/job。这样可以兑现“durable + replayable”，而不是对 LanceDB 单机模式承诺无法保证的跨表强一致。

### 14.3 任务幂等与重放

后台 job 必须以 deterministic key 去重：

```text
jobKey = hash(scopeKey + jobType + sourceId + contentHash + schemaVersion)
```

每类 job 的输出写入前都要检查目标版本：

1. contentHash 未变化则跳过。
2. schemaVersion 变化则允许生成新版本。
3. 上游 memory node 已 revoked 时停止派生。
4. 重试不生成重复 entity/relation/summary。
5. job 失败保留 error、attempts、nextRetryAt。

v0.1 不应一次性引入 9 类 job 和 DAG 调度。默认只保留三类核心 job：

| Job | 作用 | v0.x 优先级 |
|-----|------|-------------|
| `embed_chunk` | 为 chunk / memory 生成向量 | v0.1 |
| `extract_candidate` | 从 observation/session summary 抽取 5 type 候选 | v0.2 |
| `refresh_slot_snapshot` | 刷新 5 槽位快照 | v0.1 |

`seal_summary`、`daily_digest`、`skill_candidate`、`remote_sync` 等延后到数据量和需求明确后再加。

如果后续需要 retry、dead-letter、priority、schedule、DAG，不建议长期自造队列。Node.js 生态可评估：

| 库 | 适用 |
|----|------|
| `pg-boss` | PostgreSQL 部署，天然 durable |
| `BullMQ` | Redis 部署，高吞吐任务队列 |
| 本地 lightweight queue + WAL | 默认单机 v0.x |

`schemaVersion` 不应默认触发全量重算。建议 job 支持 `reuseCompatibleResults`：只有 schema 不兼容变更才强制重新 enqueue 历史数据。

### 14.4 降级矩阵

| 失败点 | 降级策略 | 返回 warning |
|--------|----------|--------------|
| Vector index timeout | 使用 BM25 + recent + slot snapshot | `vector_unavailable` |
| Graph repository unavailable | 跳过 graph hints | `graph_unavailable` |
| Tree snapshot stale | 返回旧 snapshot + 后台刷新 | `stale_slot_snapshot` |
| LLM extractor failed | 保留 observation，不生成 candidate | `extractor_failed` |
| Summary seal failed | 使用 extractive fallback 或保留 open buffer | `summary_unavailable` |
| Remote sync failed | v1+ 使用上一次 remote cache | `remote_cache_stale` |
| Budget exceeded | 限制 hits 和 deep jobs | `budget_exceeded` |

降级结果必须仍遵守 privacy、scope、lifecycle 过滤。

### 14.5 评测与质量门槛

架构可靠性需要评测闭环，建议建立 `memory-eval` 数据集：

| 评测 | 衡量 |
|------|------|
| Slot relevance | 5 槽位是否回答对应问题 |
| Rule safety | 禁止事项是否被正确注入且优先级最高 |
| Context freshness | task_context 是否使用当前项目最新阶段 |
| Evidence grounding | 每条摘要是否能追溯到 L0 |
| Privacy leakage | private/sensitive 是否进入上下文 |
| Retrieval usefulness | 用户/Agent 是否采纳召回内容 |
| Regression replay | schema/job/prompt 变化后旧样本是否稳定 |

没有评测集时，不应声称“记忆更智能”；只能声称“结构更完整”。

---

## 15. v1+ 开放平台设计

### 15.1 开放性的目标

开放平台不是 v0.x 默认交付。v0.x 只保留 embedding provider 抽象和导入导出 dry-run；完整 provider registry、type extension registry 放到 v1+。

memory-autodb 作为中间件，长期开放性有四个层次：

1. **多 Agent 接入**：OpenClaw、Codex、Cursor、OpenHuman、自研 Agent 都能通过 REST/MCP/SDK 使用。
2. **多产品嵌入**：产品可以只用 Agent 快路径，也可以使用 Console、治理和同步能力。
3. **多后端替换**：存储、向量、文本索引、图谱、LLM、embedding 都可替换。
4. **多语义扩展**：行业或产品可扩展专业 type，但必须映射回 5 槽位或声明独立 slot。

### 15.2 插件扩展点

v0.x 默认只实现或保留 `EmbeddingProvider` 抽象。以下扩展点是 v1+ 方向：

| 扩展点 | 接口 | 约束 |
|--------|------|------|
| StorageProvider | metadata/chunk/audit/job repository | 必须支持 scope filter |
| VectorProvider | embed/search/upsert/delete | 必须暴露 model/version |
| TextIndexProvider | BM25/FTS search | 必须支持增量更新 |
| GraphProvider | entity/relation/path query | 必须返回 evidence |
| TreeProvider | buffer/seal/walk/drill | SummaryNode 必须可下钻 |
| ExtractorProvider | observation/chunk -> candidates | 输出必须带 confidence/reason/evidence |
| RerankerProvider | hits -> ranked hits | 不能绕过 privacy/lifecycle |
| PolicyProvider | visibility/rbac/budget | 默认 deny |
| SyncProvider | snapshot/incremental | remote 默认只读 |

### 15.3 Type extension registry

Type extension registry 是 v1+ 能力。v0.x 只在文档中规定原则：专业类型先保留在 `kind/metadata`，由 slot builder 做映射，不开放第三方动态注册。未来开放专业记忆类型时，不能破坏主协议。建议：

```typescript
interface MemoryTypeExtension {
  type: string;
  mapsToSlot: "profile" | "task_context" | "rules" | "experience" | "resource" | "custom";
  schema: unknown;
  extractionPolicy: string;
  recallPolicy: string;
  visibilityDefault: "private" | "workspace" | "team" | "public";
}
```

示例：

| 扩展 type | mapsToSlot | 说明 |
|-----------|------------|------|
| `tool_affordance` | `resource` | 某工具能做什么、不能做什么 |
| `workflow_policy` | `rules` | 工作流约束 |
| `domain_model` | `experience` | 某业务领域的可迁移模型 |
| `team_playbook` | `experience` | 团队作业手册 |
| `customer_context` | `task_context` | 客户项目背景 |

### 15.4 互操作与迁移

对外导入导出建议支持：

| 格式 | 用途 |
|------|------|
| JSONL | 完整结构化导入导出 |
| Markdown vault | 人类可读、审查、备份 |
| MCP resources | 给 MCP 客户端发现 scope、schema、health |
| OpenAPI schema | REST/SDK 生成 |
| Provider manifest | 描述后端能力、限制和版本 |

导入时必须经过 dry-run：

1. 检查 schemaVersion。
2. 预估 memory type mapping。
3. 检查 scope/visibility。
4. 检查敏感字段。
5. 输出会创建、合并、跳过、进入候选的数量。

### 15.5 生态边界

开放不等于让外部系统写穿核心记忆。外部系统只能：

1. 提交 observation、document、explicit memory。
2. 查询 context、lookup、tree、graph。
3. 注册 provider 或 type extension。
4. 通过受控 API 请求导入导出。

外部系统不能：

1. 绕过 audit 直接改 lifecycle。
2. 绕过候选审核写 team/enterprise。
3. 绕过 privacy filter 获取 private 原文。
4. 修改内置 rules 优先级。
5. 修改已经 seal 的 summary 而不生成新版本。

---

## 16. 存储与迁移

### 16.1 Durable schema

默认单机 v0.x 建议先稳定 8-9 个核心表/集合，不一次性铺开完整平台 schema：

| 表 | 作用 |
|----|------|
| `memory_nodes` | 通用长期记忆节点，`kind` 必填、`semanticType` 可选 |
| `memory_edges` | 工作记忆关系，v0.4+ |
| `observations` | 原始观察 |
| `documents` | 来源文档 |
| `chunks` | evidence chunk |
| `entities` | 规范化实体，v0.4+ |
| `entity_relations` | 实体关系，v0.4+ |
| `summary_nodes` | source tree summary，v0.4+ |
| `slot_snapshots` | 5 槽位可注入快照 |
| `candidates` | session 候选记忆 |
| `jobs` | 后台任务 |
| `audit_logs` | 审计 |

v1+ 再考虑：

| 表 | 作用 |
|----|------|
| `tree_buffers` | open bucket，用于完整 tree seal |
| `sync_states` | 远程同步 cursor |
| `provider_manifests` | 外部 provider 能力描述 |
| `eval_runs` | memory-eval 运行结果 |

### 16.2 md+json / Vault Export

本方案不要求一开始实现 Obsidian 双向编辑，但应保留人类可读导出：

```text
memory-vault/
├── personal/
│   ├── profile/
│   ├── rules/
│   └── resource/
├── projects/<projectId>/
│   ├── task_context/
│   ├── rules/
│   ├── experience/
│   └── resource/
├── summaries/
│   ├── slot/
│   ├── source/
│   ├── topic/
│   └── global/
└── indexes/
    ├── by-type.json
    ├── by-source.json
    └── by-hotness.json
```

Markdown frontmatter 必须包含 `id/scope/kind/container/lifecycleStatus/source/evidence/version`，`semanticType` 只在节点已稳定归入 5 槽位时出现。用户手动编辑回流可以作为后续能力，不放入第一阶段。

### 16.3 迁移策略

1. 保留旧 `memories` / `knowledge`。
2. 新写入双写到 `memory_nodes` 和旧表，直到两个小版本稳定。
3. `LegacyDatabaseAdapter` 负责旧记录读取。
4. `ltm migrate --to-schema v5 --dry-run` 输出迁移计划，显示每条旧记录的 `kind`、可选 `semanticType` 或 fallback 原因。
5. 不确定类型进入 candidate，不强行归类。
6. 迁移后召回默认用新 orchestrator，缺索引时 fallback 到旧向量检索。

---

## 17. 安全与治理

### 17.1 隐私边界

| 内容 | 策略 |
|------|------|
| profile | 默认 private，不允许自动分享 |
| task_context | 默认 workspace/project private |
| rules | 可按来源提升可见性 |
| experience | 可生成 SKILL 候选，但原文不自动上传 |
| resource | 指针可分享，凭证和私有 URI 不分享 |
| secret/token/password | ingest 阶段过滤或加密隔离 |

### 17.2 生命周期

| 状态 | 召回行为 |
|------|----------|
| `active` | 正常参与召回 |
| `archived` | 不参与必读层，可按需检索 |
| `revoked` | 不参与任何召回，仅审计可见 |
| `superseded` | 不参与必读层，可按需检索历史 |
| `promoted` | 降低召回权重，优先提示 SKILL |

### 17.3 Agent 权限

Agent 可以：

1. 保存用户明确要求记住的内容。
2. 查询上下文。
3. 下钻树和图谱。
4. 报告冲突和候选。

Agent 不可以：

1. 静默上传到团队或企业。
2. 删除远程权威记忆。
3. 绕过 Console 审核晋升 SKILL。
4. 读取 private 内容的原文，除非当前产品显式授权。

---

## 18. 分阶段开发计划

### Milestone 1（v0.1）：最小可用 Agent 快路径

目标：让 OpenClaw 或任意 Agent 通过一次调用获得 5 段上下文答案。

交付：

1. `memory_context_fast` MCP tool 和 `/v1/agent/context` REST 端点。
2. `MemorySemanticType` 作为可选字段，不强制所有节点分类。
3. 简化版 Slot Context Builder：基于现有 `MemoryRecord` 的 `kind -> semanticType` 映射临时分组。
4. `SlotSnapshot` 内存 cache，不做 Slot Tree。
5. Console 只做 Overview + Quick Lookup 两个核心页面。
6. migration dry-run 前置：显示旧记录如何映射到 `semanticType` 或 fallback。

暂不做：

1. 候选区。
2. Work Memory Graph。
3. Tree 持久化。
4. 远程同步。
5. provider/type extension registry。

验收：

1. Agent 启动任务只需一次 context 调用。
2. 本地 `memory_context_fast` P95 < 100ms。
3. private/revoked 不进入 context。
4. 无法归类的旧记录仍可通过 `memory_lookup` 查到。

### Milestone 2（v0.2）：候选区 + 5 type 收口

目标：让自动抽取的记忆有门控，5 type 从可选字段变成推荐语义视图。

交付：

1. `candidates` repository。
2. 5 type extractor contract。
3. 入库阈值和前置过滤。
4. 候选区自动淘汰：30 天未命中删除；命中过但未确认归档。
5. Console Candidates 页面，必须支持批量接受、批量拒绝、按 source/session 归档。
6. Quick Lookup 展示 evidence preview。

暂不做：

1. SKILL 升格。
2. 远程贡献。
3. Slot Tree。

验收：

1. 缺 why 的 experience 被丢弃或降级。
2. soft rules 不进入必读层。
3. 候选区积压可批量清理。
4. 5 type 覆盖率和候选接受率可在 Console 看到。

### Milestone 3（v0.3）：可观测性 + 性能控制

目标：让“快而准”可量化、可调优。

交付：

1. `BudgetPolicy` 和降级 warning。
2. Recent Observation Ring。
3. BM25 delta index 或基于 LanceDB 元数据的轻量 text search。
4. Retrieval telemetry：记录哪些记忆被注入、被下钻、被忽略。
5. Console Overview 补齐 latency、cache hit、candidate accept rate、warning 统计。

验收：

1. 单机 `context_fast` P95 < 80ms。
2. `observe_light` P95 < 20ms。
3. `lookup fast` P95 < 100ms。
4. embedding 失败不影响 fast lookup。

### Milestone 4（v0.4）：统一图谱 + Source Tree

目标：让记忆能追溯、能折叠，但只做最有价值的最小图/树。

交付：

1. 统一 `GraphRepository`，用 `nodeType/edgeType` 区分 entity 和 memory relation。
2. 工作记忆边先做 3 种：`derives_from`、`supersedes`、`contradicts`。
3. `SummaryNode` durable 存储。
4. 先做 Source Tree，不做 Topic/Global/Slot Tree。
5. Console Graph 基础视图 + Source Tree 基础视图。

暂不做：

1. Topic Tree。
2. Global Tree。
3. Slot Tree。
4. 复杂图 layout 切换。

验收：

1. 每条 edge 有 evidence。
2. supersedes 会更新 lifecycle。
3. 每个 Source SummaryNode 可下钻到 L0。

### Milestone 5（v0.5+）：按真实需求选做

以下能力不进入默认 v0.x 主线，只有出现真实需求和数据量后再做：

| 能力 | 触发条件 |
|------|----------|
| Topic Tree / Global Tree | 用户有按主题、按日期看全局 digest 的真实需求 |
| Slot Tree | SlotSnapshot 无法处理大量历史版本 |
| SKILL 升格 | 出现可复用 SKILL 流程和审核入口 |
| memory-eval 数据集 | 开始做召回质量迭代或模型/prompt 替换 |
| Vault export / Markdown 双向编辑 | 有 Obsidian/人工审查需求 |
| 远程同步 | 有团队部署需求 |
| Provider Registry / Type Extension | 有第三方扩展请求 |

---

## 19. 成功标准

### 19.1 产品效果

1. OpenClaw 继续可用，旧工具不破坏。
2. 默认单机配置 LanceDB + 本地文件 + embedding API 可独立运行。
3. Agent 启动任务时可以通过一次快路径调用获得 5 槽位上下文。
4. 5 type 是可选语义视图；无法分类的节点仍可通过 lookup 检索。
5. Agent 运行中可以轻量提交 observation，不被 LLM/embedding 阻塞。
6. Web Console v0.1 至少支持 Overview + Quick Lookup。
7. 任意 context/lookup 结果能看到来源、证据和分数解释。
8. 候选区有自动淘汰和批量审核，不形成第二个垃圾库。
9. 超预算、索引不可用、快照过期时有明确降级 warning。
10. v0.4 后记忆关系和 Source Tree 可下钻到 L0 evidence。

### 19.2 工程验收

1. `npx tsc --noEmit` 通过。
2. 核心单元测试覆盖 Agent facade、semantic mapping、SlotSnapshot、candidate rules、budget policy、WAL/replay、graph edges。
3. REST/MCP/OpenClaw adapter 共享同一 `MemoryService`。
4. Console API 不绕过 service 和权限层。
5. fast path tests 覆盖 stale snapshot、vector timeout、private filtered、budget exceeded。
6. reliability tests 覆盖 idempotent job、stale index、revoked wins、scope mandatory。
7. migration dry-run 能显示 legacy 记录的 semanticType 映射或 fallback。
8. `npm test` 中依赖本地 embedding 服务的集成失败需要显式标注为环境依赖，不能误判为业务失败。

---

## 20. 关键架构决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 默认落地 | LanceDB + 本地文件 + embedding API 单机优先 | 当前仓库真实默认配置，能最快交付端到端价值 |
| 对外协议 | Agent facade + 内部 service 分层 | 让 Agent 快速输入输出，同时隐藏候选区和后台复杂度 |
| 记忆主语义 | 5 问题 + 5 type 作为可选语义视图 | 把召回从相似片段升级为 Agent 执行前答案，同时保留 fallback |
| 理论边界 | 5 type 作为产品语义，底层保留 working/episodic/semantic/procedural/external memory 映射 | 防止方案被单一分类锁死 |
| 能力成熟度 | L0-L5 分级演进 | 避免功能堆叠，保证每级可验证、可降级、可迁移 |
| 存储层级 | L0 evidence + SlotSnapshot + v0.4 Source Tree | 先满足 Agent 上下文，再做压缩导航 |
| 图谱设计 | 统一 GraphRepository，查询 intent 区分 Entity/Memory | 避免双图谱分裂成两套存储 |
| 记忆树 | v0.x 不做 Slot Tree，先做 SlotSnapshot；Source Tree 优先 | 避免过早引入 buffer/seal/cascade 复杂度 |
| 候选策略 | 自动抽取先候选，用户保存可直写，候选自动淘汰 | 降低错记和污染长期记忆的风险 |
| 实时处理 | hot/warm/cold path | 当前任务快，深层语义异步迭代 |
| 成本性能 | latency/token/job budget + 降级 warning | 避免中间件因为追求全量语义而拖慢 Agent |
| 可靠性 | durable + replayable，派生视图最终一致 | 符合 LanceDB 单机能力边界 |
| 开放性 | v0.x 只保留 embedding provider；完整 provider/type registry v1+ | 避免为不存在的第三方扩展过早抽象 |
| 远程策略 | v0.x 不做远程同步；v1+ 才考虑远程只读权威源 | 默认单机先落地 |
| Web Console | v0.1 Overview + Quick Lookup；治理和可视化分档 | 避免 8 页面管理后台一次性膨胀 |
| 迁移策略 | legacy 双写和 v5 dry-run migration | 不破坏 OpenClaw 现有能力 |

---

## 21. 当前不做的事

1. 不把所有原始对话日志导入长期记忆。
2. 不让 Agent 静默上传团队记忆。
3. 不把外部连接器完整数据复制进 resource。
4. 不在第一阶段实现 Obsidian 双向编辑。
5. 不把 Mem0、Cognee、agentmemory 作为核心依赖前提。
6. 不把 `other` 当 5 槽位来源；但允许它作为主库 fallback，避免丢失显式保存信息。
7. 不在 v0.x 实现远程同步、provider registry、type extension registry。
8. 不让插件扩展绕过 scope、privacy、lifecycle 和 audit。
9. 不在没有 eval/replay 证据时声称“智能化效果提升”。
10. 不一次性实现 8 页面 Console、Topic/Global/Slot Tree、复杂图可视化。

这些边界能保护 memory-autodb 从“什么都存”退化成“不可控的信息堆”。

---

## 22. 后续文档拆分建议

本文件是顶层到架构层的总方案。落地时建议继续拆分：

| 文档 | 位置 | 内容 |
|------|------|------|
| Agent 快路径协议设计 | `docs/04-design/04.2-detail/agent-fast-path-protocol-detail.md` | MCP/REST/SDK facade、输入输出、降级 warning |
| 5 type 语义视图设计 | `docs/04-design/04.2-detail/semantic-five-types-detail.md` | 可选 semanticType、fallback、覆盖率统计、迁移 |
| 5 槽位召回设计 | `docs/04-design/04.2-detail/five-slot-context-detail.md` | SlotSnapshot、预算、排序、prompt-safe |
| 候选区治理设计 | `docs/04-design/04.2-detail/memory-candidate-governance-detail.md` | candidate、自动淘汰、批量审核、前置过滤 |
| 成本性能控制设计 | `docs/04-design/04.2-detail/memory-cost-performance-detail.md` | hot/warm/cold path、budget、缓存、降级 |
| 单机可靠性设计 | `docs/04-design/04.2-detail/memory-local-reliability-detail.md` | LanceDB 一致性边界、WAL、幂等、降级 |
| Console v0.x 设计 | `docs/04-design/04.1-overview/web-console-v0x-design.md` | Overview/Lookup 优先、治理和可视化分档 |
| 调试与基准手册 | `docs/07-test/memory-debug-benchmark.md` | 召回不准排查、P95 SLO 验证、数据集规模 |
| v0.x 开发计划 | `docs/04-design/04.2-detail/memory-autodb-v0x-development-plan.md` | 5 个 milestone、测试、迁移 |

优先级建议：先做 Agent 快路径协议、5 type 语义视图和 SlotSnapshot；再做候选区治理和性能可观测；最后按真实数据量推进统一图谱、Source Tree 和更完整 Console。
