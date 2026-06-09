# 开源 Agent 记忆竞品调研

> 日期：2026-06-09
> 状态：调研结论
> 目的：为 memory-autodb 从 OpenClaw 插件演进为多产品 Agent Runtime 记忆中间件提供竞品参考、差异化定位和架构取舍依据。
> 关联文档：
> - [product-positioning.md](./product-positioning.md)
> - [memory-autodb-deep-optimization-architecture.md](./memory-autodb-deep-optimization-architecture.md)
> - [architecture-review-v2.md](./architecture-review-v2.md)
> - [memory-evaluation-plan.md](../07-test/memory-evaluation-plan.md)

---

## 1. 一句话结论

开源 Agent 记忆系统已经从“向量库 + 聊天历史”进入四条路线：

1. **Memory API / SaaS + OSS SDK**：Mem0、Supermemory、Mengram。
2. **时序知识图谱 / 图谱记忆控制面**：Zep/Graphiti、Cognee。
3. **Agent Runtime 或开发工具内置记忆**：Letta、LangMem、agentmemory。
4. **Graph-enhanced RAG / 记忆树理论参考**：LightRAG。

memory-autodb 不应该直接复刻任何一个竞品。最合理的位置是：

> **本地优先、面向用户工作上下文、MCP/REST/SDK 统一、带候选治理和评测闭环的 Agent Runtime 记忆中间件。**

它不是要成为最大的云端 Memory API，也不是完整 Agent Runtime，更不是当前进入 coding-agent 细分赛道，而是把 OpenClaw 当前插件能力抽象成可被多个授权 Agent 产品复用的本地/私有化用户工作上下文基础设施。

---

## 2. 评估维度

调研按以下维度比较：

| 维度 | 关注点 |
|------|--------|
| 产品定位 | 是中间件、Agent runtime、图谱引擎，还是插件 |
| 开源边界 | 核心引擎是否开源，还是只有 SDK/插件开源 |
| 写入模型 | 手动 add、自动 hooks、后台抽取、候选审核 |
| 记忆模型 | semantic/episodic/procedural、profile、graph、filesystem |
| 检索模型 | vector、BM25、graph、rerank、context block |
| 接口层 | REST、SDK、MCP、CLI、OpenClaw adapter 和其它 Agent 产品 adapter |
| 治理能力 | scope、权限、retention、audit、forget、conflict |
| 可观测性 | console、viewer、logs、benchmarks |
| 评测方式 | 是否提供公开 benchmark、可复现 harness |
| 对 memory-autodb 的启发 | 应该吸收什么，避免什么 |

---

## 3. 核心竞品总览

| 项目 | 类型 | 关键能力 | 对 memory-autodb 的威胁 | 对 memory-autodb 的启发 |
|------|------|----------|--------------------------|--------------------------|
| [Mem0](https://github.com/mem0ai/mem0) | 通用 Memory API / OSS stack | add/search、混合检索、实体链接、可自托管 server + dashboard | API 简洁、生态广、默认组件完整 | 学习 API 简洁性、provider 配置、评测公开化 |
| [Zep](https://help.getzep.com/) / [Graphiti](https://github.com/getzep/graphiti) | 企业记忆服务 + 开源时序图谱引擎 | temporal context graph、Context Lake、治理、低延迟上下文 | 图谱理论和企业治理强 | 学习 temporal edge、episode provenance、graph retrieval |
| [Cognee](https://github.com/topoteretes/cognee) | AI memory platform / graph pipeline | `remember/recall/forget/improve`、session cache、knowledge graph、CLI/UI | 图谱和 pipeline 抽象更成熟 | 学习四操作 API 和 session -> graph 分层 |
| [LightRAG](https://github.com/HKUDS/LightRAG) | Graph-enhanced RAG / dual-level retrieval | graph-structured indexing、local/global/hybrid/naive/mix 查询、四类后端存储 | 不是 Agent memory，但图谱+向量检索工程成熟 | 学习记忆树、图谱索引、增量更新、向量/图/文件存储分层 |
| [agentmemory](https://github.com/rohitg00/agentmemory) | 开发工具 agent 记忆 server + MCP/hooks | hooks 自动捕获、MCP、viewer、benchmark、本地优先 | 如果 memory-autodb 后续进入开发工具生态，会形成竞争 | 学习本地安装体验、viewer、bench harness；暂不牵引当前产品路线 |
| [Supermemory](https://github.com/supermemoryai/supermemory) | Memory API + app + MCP/plugins | memory/RAG/profile/connectors，一套 API，OpenClaw 插件 | 产品包装和客户端生态强 | 学习 profile/context API、插件矩阵和 benchmark 包装 |
| [Mengram](https://github.com/alibaizhanov/mengram) | 3 类记忆 API + OpenClaw 集成 | semantic/episodic/procedural、workflow feedback、MCP/OpenClaw | 明确打 OpenClaw 场景，流程记忆有差异化 | 学习 procedural memory，但警惕项目成熟度和 hosted 依赖 |
| [Letta](https://docs.letta.com/letta-code/memory/) | stateful agent runtime | MemFS、git-backed memory、agent 自编辑 markdown | runtime 体验完整 | 学习版本化文件记忆，不学习 agent 直接改主库 |
| [LangMem](https://github.com/langchain-ai/langmem) / Deep Agents memory | LangGraph 生态记忆模块 | structured schemas、hot/background memory manager、filesystem memory | LangGraph 生态吸附力强 | 学习 hot/background 分层和 schema 化抽取 |

---

## 4. 重点项目分析

### 4.1 Mem0

定位：通用、可自托管的 AI memory layer，提供 Python/Node library、self-hosted server、dashboard、API key、request audit log。

已验证信息：

- OSS 文档强调 self-host、组件可替换、离线环境和 fork 扩展。
- 默认 library 组件包含 OpenAI embedding、本地 Qdrant、SQLite history；server 默认 Postgres + pgvector。
- 新算法强调 ADD-only extraction、agent-generated facts、entity linking、semantic/BM25/entity 多信号融合和 temporal reasoning。
- 有 arXiv 论文和公开 evaluation framework。

优点：

1. API 语义简单，`add/search` 心智负担低。
2. provider 配置完整，容易进入“通用中间件”市场。
3. 自带 dashboard、audit log 和 benchmark 叙事。
4. 强调 token/latency 成本，而不是只讲召回准确率。

不足或风险：

1. 产品核心仍偏 Memory API，不是 OpenClaw 原生工作流。
2. 依赖 LLM 抽取和外部向量/pgvector，local-first 极简部署不如 memory-autodb 当前 LanceDB 路线轻。
3. 主叙事是事实抽取和搜索，缺少我们设计里的 5 槽位 Agent 启动上下文。
4. ADD-only extraction 对撤销、冲突、candidate gate 的治理表达不够明确。

对 memory-autodb 的建议：

1. 保留 `memory_save_explicit` / `memory_lookup` 的简洁接口，不把内部图谱、树、候选区全部暴露给 Agent。
2. 学习 Mem0 的 provider 配置和 benchmark 公开化，把 `ltm eval` 做成第一等能力。
3. v0.x 不要一次性追求 server + dashboard + cloud API，全量照搬会稀释 local-first 优势。

### 4.2 Zep / Graphiti

定位：Zep 是企业级 agent memory / Context Lake；Graphiti 是开源 temporal context graph engine。

已验证信息：

- Zep 文档描述从 chat、business data、documents、JSON 构建 temporal knowledge graph，并返回 governed、token-efficient、prompt-ready context。
- Zep 产品强调 ABAC、retention、audit/API logs、observability 和 sub-200ms retrieval。
- Graphiti 开源项目把 entities、facts/relationships、episodes 和 custom ontology 作为 context graph 的核心组件；每个 derived fact 可追溯到 episode。
- Zep 论文声称在 DMR 和 LongMemEval 上有明显提升，核心差异来自 Graphiti 的 temporal graph。

优点：

1. 图谱方向理论最强，尤其是 temporal validity、provenance、fact supersession。
2. 企业治理完整：权限、retention、audit、observability 都是 memory middleware 必需项。
3. Retrieval 不只是 vector，而是 semantic + keyword + graph traversal。
4. 明确把“动态业务数据 + 对话”合并成 Context Graph。

不足或风险：

1. Zep 的完整治理和低延迟能力主要在 managed / enterprise 产品中；Graphiti 开源部分不是完整 memory middleware。
2. Graphiti 需要自己补用户、会话、权限、API、Console 和任务快路径。
3. 对 memory-autodb v0.x 来说，完整 temporal graph 过重，容易拖慢最小可用闭环。

对 memory-autodb 的建议：

1. v0.x 不实现完整 Zep，但 GraphRepository 的 edge schema 应预留 `validFrom/validTo/observedAt/invalidatedAt/sourceEpisodeId`。
2. `observations/chunks` 应作为 episode/provenance 的本地等价物，保证后续图谱可重放。
3. 不承诺 Zep 级企业治理；先做本地 scope、lifecycle、audit、candidate gate。

### 4.3 Cognee

定位：开源 AI memory platform / knowledge graph pipeline，目标是把文档、会话和执行结果变成可 recall 的 graph memory。

已验证信息：

- API 主打四个操作：`remember`、`recall`、`forget`、`improve`。
- 支持 session memory fast cache，后台同步到 permanent knowledge graph。
- 提供 CLI、本地 UI、Claude Code plugin，并在 hooks 中接入 SessionStart、PostToolUse、UserPromptSubmit、PreCompact、SessionEnd。
- 强调 customer support、SQL copilot、expert knowledge distillation 等生产场景。

优点：

1. `remember/recall/forget/improve` 比传统 CRUD 更贴近 memory 心智模型。
2. session cache -> permanent graph 的分层和 memory-autodb 的 hot/warm/cold path 高度一致。
3. hooks 生命周期设计对 Agent Runtime 场景有参考价值。
4. 图谱和数据 pipeline 抽象较完整。

不足或风险：

1. 更像 graph memory platform，不是轻量本地插件。
2. 对 Agent 启动前的固定槽位上下文没有清晰产品语义。
3. `improve` 的语义强，但如果没有候选审核和 evidence gate，容易把错误经验固化。

对 memory-autodb 的建议：

1. 保留我们当前 `observe/context/lookup/session_commit`，但 Console/SDK 可以提供更友好的 `remember/recall/forget/improve` 别名。
2. 学习 Cognee 的 session memory fast cache -> permanent graph，但 v0.x 只做 SlotSnapshot，不做完整图谱。
3. `improve` 类能力只能进入 candidate 或 SKILL 候选，不能直接改 active memory。

### 4.4 agentmemory

定位：面向开发工具 agent 的本地记忆 server + MCP + hooks + viewer。

已验证信息：

- 明确支持 Claude Code、Codex CLI、OpenClaw、Hermes、OpenCode、Cursor、Gemini CLI 等 agent。
- 提供 MCP、REST、hooks、skills、real-time viewer。
- README 声称 0 external DBs、SQLite + iii-engine、本地 server、LongMemEval-S 和 coding-agent-life-v1 benchmark。
- 提供大量 MCP tools 和 hooks，可自动捕获 session、tool calls、compact 前后信息。

优点：

1. 与 memory-autodb 的本地优先、MCP 和 OpenClaw 接入能力有部分重叠。
2. 安装和 agent wiring 体验很强：一条命令启动 server，再 connect agent。
3. viewer、session replay、benchmark harness 对我们很有启发。
4. 本地优先，不依赖 cloud，是未来进入开发工具生态时的参考对象。

不足或风险：

1. 强开发工具 agent 场景，不适合作为 memory-autodb 当前用户工作上下文路线的主参照。
2. MCP 工具面很宽，Agent 容易看到过多内部能力。
3. 其 benchmark 与其他系统的横向数字并非同一数据集，需要谨慎比较。
4. 复杂 hooks 对不同 host 的兼容成本高。

对 memory-autodb 的建议：

1. 必须把首批 OpenClaw adapter 的安装和诊断体验做到同级：`ltm serve`、`ltm connect openclaw`、`ltm doctor`。
2. Console 至少要有 Overview、Quick Lookup、session trace 和“为什么注入”视图。
3. MCP 工具保持少而强，不复制几十个工具的接口膨胀。
4. `memory-eval` 应把 agentmemory 作为可选 external baseline。

### 4.5 Supermemory

定位：Memory API + app + MCP/plugins + connectors，强调 memory、RAG、user profile、documents/connectors 一体化。

已验证信息：

- GitHub README 描述 supermemory 可以作为 developer API：添加 memory、RAG、user profiles、connectors、file processing。
- 提供多类 agent 插件，其中包括 OpenClaw 插件；MCP 工具包含 `memory`、`recall`、`context`。
- API 提供 `add()`、`profile()`、memory/document search、file upload、settings。
- README 声称支持 contradiction resolving、auto-forgetting、MemoryBench。

优点：

1. `profile()` 把用户画像和相关 search 组合成一个接口，和我们 5 槽位 context 很接近。
2. 插件矩阵覆盖 OpenClaw，说明 OpenClaw adapter 已经是 memory 产品的重要入口。
3. 记忆 + 文档 RAG + connectors 一体化，产品包装完整。
4. 明确区分 memory 和 RAG，对我们知识库/记忆分表有参考价值。

不足或风险：

1. 开源边界需要谨慎看待：插件和 repo 开源，但 API/服务能力仍明显 SaaS 化。
2. 自称 benchmark 领先，但需要用本地 `memory-eval` 复现，不应直接接受。
3. 对候选审核、用户确认、主库 fallback 的治理细节不够透明。

对 memory-autodb 的建议：

1. `memory_context_fast` 应提供类似 `profile + relevant memories + warnings` 的一体化输出。
2. 文档知识库和用户记忆必须保持边界清晰，避免变成普通 RAG API。
3. 可以参考 MemoryBench 方向，但本仓评测必须能离线复现。

### 4.6 Mengram

定位：面向 Agent 的 semantic / episodic / procedural 三类记忆 API，带 MCP、OpenClaw 集成和 workflow feedback。

已验证信息：

- GitHub README 展示 semantic、episodic、procedural 三类搜索。
- 提供 OpenClaw plugin、MCP server、LangChain、CrewAI 集成。
- Procedural memory 支持 workflow feedback，失败后演化 procedure。
- 提供 `/v1/add`、`/v1/search`、`/v1/search/all`、episode/procedure/profile/triggers 等 API。

优点：

1. procedural memory 和“失败经验 -> 工作流演化”是强差异点。
2. OpenClaw 集成说明它是 memory-autodb 的直接边缘竞品。
3. 三类记忆比单纯 facts 更符合 Agent 长期成长。
4. API 覆盖 profile、triggers、workflow history。

不足或风险：

1. 项目成熟度和社区体量明显小于 Mem0、Zep、Supermemory、agentmemory。
2. hosted API 色彩强，本地自托管和数据治理边界需要进一步验证。
3. 自动演化 procedure 如果没有严格 evidence 和候选审核，容易学坏。

对 memory-autodb 的建议：

1. v0.x 不急着做 full procedural memory，但 `experience -> skill candidate` 要保留清晰路径。
2. `memory_promote_skill` 应吸收 workflow feedback 的思想，但通过候选区和人工确认落地。
3. 不要把 procedural memory 放到必读层；它更适合 SKILL 或 resource/procedure 指针。

### 4.7 Letta

定位：stateful agent runtime，记忆是 Agent runtime 的一部分，不是独立中间件。

已验证信息：

- Letta Code 的 MemFS 是 git-backed memory filesystem，memory 以 markdown 文件目录组织。
- Agent 可以直接编辑 memory 文件并 commit 保存；Letta Cloud 可同步 commit。
- `system/` 目录完整加载进 system prompt，其他文件通过 memory tree 按需可见。

优点：

1. Git-backed memory 有版本历史、可审查、可回滚。
2. 文件树对人类可读，比纯数据库更容易解释和迁移。
3. system/full-load 与 on-demand memory tree 的分层很清晰。

不足或风险：

1. Letta 是 agent runtime，强绑定运行时；memory-autodb 不能变成 OpenClaw 专属 runtime。
2. Agent 直接编辑主记忆文件不适合中间件治理边界。
3. 把某些文件完整塞进 system prompt，容易和 token budget/SLO 冲突。

对 memory-autodb 的建议：

1. 可以借鉴 Markdown export/import 和 versioned memory tree。
2. 不能让 Agent 直接改 durable 主库；所有写入仍应走 `MemoryService`、candidate、audit。
3. Source Tree 和 Console 应让人类能读懂 memory，不要求人类直接编辑主存储。

### 4.8 LangMem / Deep Agents Memory

定位：LangGraph/Deep Agents 生态里的记忆模块和运行时范式。

已验证信息：

- LangMem 提供 memory store manager、schema 自定义、hot path 和 background quickstart。
- Deep Agents memory 使用 filesystem-backed memory，支持 agent-scoped 和 user-scoped memory。
- Memory 可按需加载，background consolidation 可在对话后更新。

优点：

1. hot path / background reflection 分层和我们架构一致。
2. schema 化抽取、namespace、store backend 是通用好设计。
3. 对 agent-scoped / user-scoped memory 的区分清晰。

不足或风险：

1. 强 LangGraph 生态绑定，不是独立记忆服务。
2. 主要解决 Agent app 内部 memory，不直接提供面向用户工作上下文的中间件治理。
3. 评测、Console、候选审核不是核心。

对 memory-autodb 的建议：

1. `MemoryService` 要保持 framework-neutral，不依赖 OpenClaw 或 LangGraph。
2. 学习 hot/background 两条 path，但快路径只能依赖已持久化和可回放数据。
3. namespace、schema manager、background reflection 可以作为后续 SDK adapter 参考。

### 4.9 LightRAG

定位：LightRAG 是 graph-enhanced RAG 框架，不是 Agent memory 中间件。它的价值在于用图结构增强文本索引和检索，并把向量检索、图谱检索和增量更新工程化。

已验证信息：

- 论文描述 LightRAG 将 graph structures 引入 text indexing 和 retrieval，并采用 dual-level retrieval，从低层细节和高层知识发现两个层面提高检索。
- GitHub README 描述 LightRAG 同时管理 knowledge graph 和 vector embeddings，支持 incremental knowledge base updates。
- LightRAG 查询模式包括 `local`、`global`、`hybrid`、`naive`、`mix`：`local` 偏具体实体上下文，`global` 偏宏观主题和跨文档关系，`naive` 是传统 chunk 向量检索，`mix` 合并图谱和向量结果。
- LightRAG 后端存储明确分成 `KV_STORAGE`、`VECTOR_STORAGE`、`GRAPH_STORAGE`、`DOC_STATUS_STORAGE` 四类；默认文件持久化适合开发调试，生产可换 PostgreSQL、MongoDB、OpenSearch、Milvus/Qdrant、Neo4j/Memgraph。
- README 强调 embedding 模型一旦变更需要重建向量相关表，也提示 rerank 会引入额外延迟。

优点：

1. 明确证明“纯向量 chunk 检索不足以处理复杂依赖”，图结构能补全实体、关系和跨文档上下文。
2. `local/global/hybrid/naive/mix` 查询模式可以直接启发 memory-autodb 的 lookup 分层。
3. 四类存储后端说明了向量库、图存储、KV/文件和文档状态不应该混在一个表里。
4. 增量更新策略适合用户工作上下文这类不断变化的数据。

不足或风险：

1. LightRAG 面向文档知识库问答，不直接处理用户偏好、rules、candidate、revoked、scope 授权和 Agent 快路径。
2. 依赖实体关系抽取，对本地优先 memory 中间件来说成本可能较高。
3. 其默认 `mix` 适合深度 lookup，不适合 `context_fast` 的低延迟必读路径。
4. 它的 source 文档是主要输入，而 memory-autodb 的输入还包括运行中 observation、显式记住、session commit 和 Console 治理操作。

对 memory-autodb 的建议：

1. 把 LightRAG 作为 **记忆树和 lookup deep 的理论参考**，不要直接把它作为 Agent 快路径。
2. 建立类似 `local/global/naive/mix` 的召回模式：
   - `local`：entity/topic tree + graph relation。
   - `global`：global/source tree summary。
   - `naive`：chunk/vector/BM25。
   - `mix`：lookup deep 融合多路结果。
3. 存储视图应拆成 record store、vector store、graph/tree store、file/evidence store、job/audit store，避免把所有东西都塞进向量库。
4. 记忆树不应只做 UI 层目录，而应参与召回：source tree 做来源追溯，topic tree 做实体/主题召回，global tree 做整体预览和宏观摘要。
5. 增量更新必须优先：新 observation、文档 chunk、candidate approve、revoked/superseded 都应局部更新相关 tree/index，而不是全量重建。

---

## 5. 竞品能力矩阵

| 能力 | Mem0 | Zep/Graphiti | Cognee | LightRAG | agentmemory | Supermemory | Mengram | Letta | LangMem |
|------|------|--------------|--------|----------|-------------|-------------|---------|-------|---------|
| 开源核心 | 是 | Graphiti 是，Zep 完整服务偏商业 | 是 | 是 | 是 | 部分/产品化 | 是 | 是 | 是 |
| 本地优先 | 可自托管 | Graphiti 可自托管 | 可自托管 | 可本地部署 | 强 | 部分 | 部分 | local mode | 依赖 backend |
| MCP | 有独立 MCP | Graphiti/Zep 生态有 | 有插件 | 非重点 | 强 | 强 | 强 | runtime 内 | 可集成 |
| OpenClaw 集成 | 文档中出现 | 无直接重点 | 无直接重点 | 无直接重点 | 强 | 强 | 强 | 间接 | 间接 |
| 图谱 | graph memory | temporal graph 最强 | knowledge graph | graph + vector dual-level retrieval | graph/hybrid | memory graph | knowledge graph | memory tree | 可接 store |
| 候选审核 | 不突出 | 商业治理强 | 不突出 | 无 Agent candidate 概念 | governance tools | 不透明 | 不突出 | agent 自编辑 | 不突出 |
| 评测公开 | 有 paper/eval | 有 paper/bench | 有 eval 叙事 | 有 paper/实验 | 有 harness | 有 MemoryBench | 有 benchmarks 目录 | 不突出 | 不突出 |
| Console/viewer | dashboard | dashboard/Graphiti 自建 | UI | WebUI | viewer/replay | app/dashboard | console | runtime/UI | LangSmith 周边 |
| 适合直接学习 | API/评测 | 图谱/evidence | pipeline | 记忆树/图谱召回/存储分层 | agent hooks/viewer | profile/context | procedural | markdown tree | hot/background |

---

## 6. 对 memory-autodb 的直接设计影响

### 6.1 必须强化的能力

1. **极简 Agent facade**
   - 竞品都在减少 Agent 心智负担。
   - memory-autodb 应坚持 `context_fast / observe_light / lookup / save_explicit / session_commit`。
   - 不应把 candidate、tree buffer、graph mutation 暴露给普通 Agent。

2. **本地可运行的一键体验**
   - agentmemory 和 Supermemory 都证明本地安装、连接和诊断体验会直接影响 adoption。
   - memory-autodb 必须补 `ltm serve`、`ltm connect openclaw`、`ltm doctor`、`ltm demo`。

3. **可解释上下文**
   - Zep、Graphiti、Supermemory 都强调 prompt-ready context，而不是裸 hits。
   - `memory_context_fast` 应返回 slots、task hints、evidence、warnings、filtered reasons。

4. **公开评测闭环**
   - Mem0、Zep、agentmemory、Supermemory 都有 benchmark 叙事。
   - `memory-eval` 不应只是内部脚本，要成为文档和 CLI 的正式能力。

5. **人类可审查的 Console**
   - 竞品有 dashboard/viewer/app。
   - v0.1 至少要有 Overview + Quick Lookup；v0.2 必须有 Candidates；v0.3 必须有 Explain。

6. **Graph 预留，但不早做重图谱**
   - Graphiti 证明 temporal graph 有价值。
   - v0.x 先把 evidence、edge type、supersession、WAL/replay 做对；完整 graph 可视化放 v0.4+。

7. **存储视图必须分层**
   - LightRAG 的四类后端存储说明：向量、图谱、KV/文件、文档状态有不同生命周期和失效模式。
   - memory-autodb 也应区分 durable record、vector index、tree/graph index、file/evidence、job/audit，不能把所有信息都放进 LanceDB 或一个 JSON 文件。

8. **记忆树必须参与召回**
   - LightRAG 的 local/global/hybrid/mix 模式说明，树/图不是只给 UI 看。
   - memory-autodb 的 source/topic/global tree 应分别服务来源追溯、主题实体召回、整体预览，并在 `lookup deep` 中参与融合。

### 6.2 必须避免的误区

1. **不要把 memory-autodb 做成另一个大而全 SaaS API**
   - 我们的优势是 local-first、OpenClaw 原生和私有化部署。

2. **不要一次性复制 Graphiti/Zep 的完整 temporal graph**
   - v0.x 目标是 Agent 快路径和 SlotSnapshot，不是企业 Context Lake。

3. **不要复制 agentmemory 的超宽 MCP 工具体系**
   - 工具越多，Agent 越容易误用内部治理能力。

4. **不要让 Agent 直接编辑主库**
   - Letta 的 MemFS 对 runtime 合理，但 memory-autodb 需要服务层、candidate 和 audit。

5. **不要把 semanticType 做成强制分类**
   - 竞品大量事实/事件/过程记忆都无法自然归入 5 type；我们的 `kind + semanticType?` 边界是正确的。

6. **不要把所有长期记忆都放进向量库**
   - 向量库适合语义召回单元，不适合保存审计、候选状态、权限、原始大文件、树结构真源。
   - 向量索引应可重建，不能成为唯一真源。

---

## 7. 差异化定位

### 7.1 和 Mem0 / Supermemory 比

它们更像“Memory API + 平台”。memory-autodb 应强调：

1. 本地默认可用，不依赖云端 API。
2. OpenClaw 插件和中间件一体，不需要外部记忆 SaaS。
3. 5 槽位上下文服务 Agent 启动任务，而不是只提供 search。
4. 候选区和人工/产品治理是第一等能力。
5. 开源评测和内置黄金集随仓库维护。

### 7.2 和 Zep / Graphiti 比

它们图谱理论更强。memory-autodb 应承认差距，但不正面硬拼：

1. v0.x 不追求 Graphiti 级 temporal graph。
2. 先把本地 episode/evidence、supersession、revoked wins、WAL replay 做对。
3. 后续可把 GraphRepository 做成可替换 provider，甚至接 Graphiti。

### 7.3 和 agentmemory 比

agentmemory 是开发工具 agent 记忆方向的重要参考，但不是 memory-autodb 当前产品主战场。memory-autodb 应做出不同：

1. 更少、更稳定的 MCP 工具面。
2. 更明确的用户工作上下文中间件边界，不把开发工具 agent 作为当前优先目标。
3. 更强的候选审核、安全过滤和可解释 context。
4. 与 OpenClaw 生命周期深度集成，但不锁死 OpenClaw。

### 7.4 和 Letta / LangMem 比

它们是 runtime memory。memory-autodb 应避免框架绑定：

1. 不做完整 Agent runtime。
2. 不要求 Agent 使用特定 planner / graph runtime。
3. 通过 REST/MCP/SDK 提供 framework-neutral memory service。

---

## 8. 推荐路线调整

基于竞品调研，对现有架构方案建议做四点强化：

### 8.1 v0.1 增加 install/demo/doctor

当前方案强调 API 和 Console，但竞品说明“接入体验”本身就是护城河。

建议 v0.1 增加：

```bash
ltm serve
ltm demo
ltm connect openclaw
ltm doctor
```

### 8.2 v0.1 的 context 返回结构要更像产品接口

建议 `memory_context_fast` 输出：

```typescript
interface AgentContextFastResult {
  contextBlock: string;
  slots: Record<MemorySemanticType, SlotContext>;
  taskHints: MemoryHit[];
  profileSummary?: string;
  evidence: EvidenceRef[];
  warnings: string[];
  filtered: Array<{ id: string; reason: string }>;
  metrics: {
    latencyMs: number;
    tokenCount: number;
    cacheHit: boolean;
  };
}
```

### 8.3 v0.2 增加 explain API

竞品的 dashboard/viewer 都在解决“为什么 agent 记住了这个”。

建议新增：

```text
GET /v1/memories/:id/explain
POST /v1/context/explain
```

用于 Console 展示：

1. 为什么被注入。
2. 为什么被过滤。
3. 来源 evidence。
4. 哪个 job 生成。
5. 是否被 superseded/revoked。

### 8.4 v0.3 增加互操作 schema

为了和 Mem0、agentmemory、Supermemory、Graphiti 竞争或迁移，建议定义 export/import：

```json
{
  "format": "memory-autodb-portable-v1",
  "nodes": [],
  "edges": [],
  "evidence": [],
  "audit": []
}
```

并规划：

```bash
ltm import --from mem0
ltm import --from agentmemory
ltm export --format portable-v1
```

---

## 9. 结论

竞品已经证明几个方向是行业共识：

1. 记忆必须是独立层，不应只是 prompt 片段。
2. 纯向量检索不够，需要 metadata、BM25、图谱、profile、lifecycle。
3. Agent 需要一个低延迟 context API，而不是自己拼 retrieval。
4. 记忆必须可治理、可解释、可评测。
5. OpenClaw adapter 是首批验证入口；开发工具 agent 是未来可选扩展，不是当前主线。

memory-autodb 当前方案方向基本正确，但必须更明确地把差异化落在：

1. local-first。
2. 面向用户工作上下文，先服务 OpenClaw adapter，但保持 framework-neutral。
3. 少而强的 MCP/REST/SDK facade。
4. 5 槽位 Agent 上下文，而非强制 5 type 主库。
5. candidate gate + audit + explain。
6. 自带 `memory-eval`，用开源 benchmark 和内置黄金集证明提升。

如果后续实现只补 graph、tree、Console 页面，而没有做到用户工作上下文、快路径、解释、评测和治理，那么会被 Mem0/Supermemory 的产品化和其它本地记忆方案夹击。

---

## 10. 参考来源

| 来源 | 用途 |
|------|------|
| [Mem0 GitHub](https://github.com/mem0ai/mem0) | Mem0 OSS 特性、算法说明、license、benchmark 入口 |
| [Mem0 Open Source Overview](https://docs.mem0.ai/open-source/overview) | 自托管、默认组件、server/dashboard/audit 描述 |
| [Mem0 paper](https://arxiv.org/abs/2504.19413) | LoCoMo 评测、latency/token 成本声明 |
| [Zep docs](https://help.getzep.com/) | Zep Context Graph、Context Lake、低延迟上下文描述 |
| [Zep product page](https://www.getzep.com/) | ABAC、retention、audit、observability、benchmark 声明 |
| [Zep paper](https://arxiv.org/abs/2501.13956) | temporal graph memory 和 LongMemEval 结果 |
| [Graphiti GitHub](https://github.com/getzep/graphiti) | temporal context graph、entities/facts/episodes/custom ontology |
| [Cognee GitHub](https://github.com/topoteretes/cognee) | remember/recall/forget/improve、session cache、runtime hooks |
| [agentmemory GitHub](https://github.com/rohitg00/agentmemory) | developer-agent memory、MCP/hooks/viewer/benchmark |
| [Supermemory GitHub](https://github.com/supermemoryai/supermemory) | Memory API、MCP、OpenClaw plugin、MemoryBench、profile/search |
| [Mengram GitHub](https://github.com/alibaizhanov/mengram) | semantic/episodic/procedural memory、OpenClaw/MCP、workflow feedback |
| [Letta Memory Docs](https://docs.letta.com/letta-code/memory/) | MemFS、git-backed memory、memory tree |
| [LangMem GitHub](https://github.com/langchain-ai/langmem) | hot/background memory manager、schemas |
| [Deep Agents Memory Docs](https://docs.langchain.com/oss/python/deepagents/memory) | filesystem-backed memory、agent/user scope、background consolidation |
| [LightRAG GitHub](https://github.com/HKUDS/LightRAG) | graph/vector dual-level retrieval、query mode、存储后端分层、增量更新 |
| [LightRAG paper](https://arxiv.org/abs/2410.05779) | graph-structured indexing、dual-level retrieval、Graph-enhanced RAG 理论依据 |
