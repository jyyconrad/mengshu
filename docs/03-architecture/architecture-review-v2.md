# memory-autodb 深层优化架构方案评审报告（v2）

> **评审日期**: 2026-06-08  
> **评审范围**: [memory-autodb-deep-optimization-architecture.md](./memory-autodb-deep-optimization-architecture.md)  
> **评审视角**: 方案可行性、可持续迭代、默认单机配置（LanceDB + 本地 embedding）  
> **评审性质**: 升级方案架构评审，非代码审查

---

## 一、总评

这是一份**理论扎实、工程自觉的中间件架构方案**。核心优点：

1. **设计原则清晰**（§3）："记忆不是日志"、"先回答问题再做相似度"、"evidence first"、"可靠性优先于智能化" —— 这些原则能防止方案退化成"什么都存"的信息堆。
2. **5 问题 + 5 type 语义协议**（§1、§4.2）是真正的产品视角差异化，不是技术堆砌。
3. **分层清晰**：L0 evidence → L1 slot/type summary → L2 tree summary → L3 asset candidate（§4.4），每层有明确职责。
4. **Agent 快路径设计**（§9.0）把复杂度藏在中间件内部，对外只暴露 4 个简单时点，是中间件成熟度的体现。

**核心问题**：方案长度 1869 行、覆盖 10 个 Phase（§18 A-J）、至少 6-9 人月工作量，但**没有给出迭代优先级的决策依据**。如果按 Phase A → J 顺序执行，会在 Phase C（5 槽位 Context Builder）之前完成大量"地基"却看不到效果，容易中途失去动力。

本评审给出**3 条可持续迭代路径**，让每个阶段都能交付可验证价值。

---

## 二、方案本身的 7 个核心问题

### 问题 1：Slot Tree 是"过度设计"还是"必要分层"？

**方案陈述**（§8.2、§8.4）：
- 在 source/topic/global 三类树基础上新增 Slot Tree
- Slot Tree 按 `semanticType + scopeKey` 组织，生成 5 槽位必读层
- 每个 type 有独立的 bucket 触发、TTL 触发策略

**问题**：
- Slot Tree 的 L1 SummaryNode 和普通的 `MemoryNode`（§6.2）有什么本质区别？Slot Tree 是否只是"按 type 分组的 memory 聚合视图"？
- 如果 Slot Tree 只是视图，为什么需要独立的 tree buffer/seal 机制？能否简化为"slot snapshot = 对 active MemoryNode 按 type 排序 + 预算截断"？

**建议**：
- **v0.1-v0.3 不实现 Slot Tree**，只实现 `SlotSnapshotCache`：
  ```typescript
  interface SlotSnapshot {
    scope: MemoryScope;
    semanticType: SemanticType;
    topNodes: MemoryNode[];  // 按 importance/hotness 排序，截断到预算
    generatedAt: number;
    ttl: number;  // 按 §8.5 设置
  }
  ```
- Slot Tree 的价值在"能压缩历史"，但前提是**有足够的历史数据**。v0.1 用户的数据量不足以让 Slot Tree 体现价值，应延迟到 v0.5+。
- 如果未来确实需要 Slot Tree，再从 SlotSnapshot 演进，而不是一开始就上全套 buffer/seal/cascade。

---

### 问题 2：双图谱（Entity + Work Memory）真的需要两套 Repository 吗？

**方案陈述**（§7.1）：
- Entity Graph：现实世界实体关系（person/org/project/file/tool）
- Work Memory Graph：工作记忆演化关系（MemoryNode 之间的 derives_from / supersedes / contradicts）

**问题**：
- 两类图谱底层都是节点 + 边，能否用统一的 `GraphRepository<TNode, TEdge>`？
- 方案说"可以共用 GraphRepository，但查询 API 应区分 intent"——既然能共用，为什么文档分两章写？是否在暗示未来会分裂成两套存储？

**建议**：
- **统一为 GraphRepository，用 `nodeType` 和 `edgeType` 区分**：
  ```typescript
  interface GraphNode {
    id: string;
    nodeType: "entity" | "memory" | "summary" | "skill_candidate";
    // ...
  }
  interface GraphEdge {
    edgeType: "entity_relation" | "memory_relation";
    predicate: string;  // mentions / derives_from / supersedes ...
  }
  ```
- 查询 API 层面按 intent 分：`queryEntityGraph(scope, entityId)` vs `queryMemoryEvolution(scope, memoryId)`，但底层复用同一套 index。
- 避免"概念上两套图谱 → 实现上两套存储 → 同步问题"的滑坡。

---

### 问题 3：候选区的 7-30 天保留期是"治理"还是"垃圾堆"？

**方案陈述**（§9.3）：
- 自动抽取的记忆默认进入 `session_candidate`
- 候选区默认保留 7-30 天，视产品配置
- 候选不是长期记忆，不进入必读层

**问题**：
- 用户不主动审核时，候选区会无限堆积（7-30 天 × 每天 N 条）→ 变成第二个"长期记忆垃圾桶"
- 方案没有说"30 天后自动删除"还是"自动降级到某个冷存储"
- Console Candidates 页面（§11.1）是手动逐条审核，无批量操作 → 用户不会审核超过 50 条的积压

**建议**：
- **引入"候选区自动淘汰"机制**：
  - 30 天内未被 Agent 召回（通过 retrieval telemetry 统计）→ 自动删除
  - 30 天内被召回但用户仍未确认 → 降级到 `archived`，不再参与自动召回但保留 provenance
- **Console 增加批量操作**："按 type 全部接受" / "按置信度阈值批量拒绝" / "按 source 批量归档"
- 否则候选区会成为"用户永远不看的第二个数据库"，失去治理意义。

---

### 问题 4：5 type 强制映射会"锁死"还是"锁不住"真实场景？

**方案陈述**（§4.2、§6.3）：
- 所有记忆必须归入 `profile / task_context / rules / experience / resource` 之一
- 旧分类通过映射表降级（preference → profile, decision → experience, fact → 按上下文归类）
- §3.10 说"不能回答 Q1-Q5 的信息不进入长期记忆"

**冲突场景**：
1. **编程任务**："这个函数的设计意图是为了解耦 HTTP 层和业务层"
   - 不是 experience（缺 outcome）
   - 不是 rules（不是约束）
   - 不是 resource（不是工具）
   - 不是 task_context（不是项目目标）
   - 不是 profile（不是用户偏好）
   - → **应该入库吗？入哪个 type？**

2. **研究任务**："实验 A 的对照组数据显示 p < 0.05"
   - 这是事实（fact），但方案说 fact 无法回答 Q1-Q5 时不进入长期记忆
   - 但研究场景下，事实就是核心记忆
   - → **5 type 是否适合研究类任务？**

3. **客服任务**："客户 X 在 2025-03-01 投诉过产品 Y 的延迟问题"
   - 既是 task_context（客户背景），又是 experience（历史问题），还可能是 fact
   - → **如何决策入哪个槽位？**

**建议**：
- **v0.1-v0.3 不强制 5 type，允许 `kind=other` 作为 fallback**：
  ```typescript
  interface MemoryNode {
    semanticType?: SemanticType;  // 可选
    kind: MemoryKind;  // 保留旧 kind 作为后备
    // ...
  }
  ```
- **5 type 作为"语义视图"而非"主库约束"**：
  - 主库仍是 generic `MemoryNode`
  - Slot Context Builder 时优先使用有 `semanticType` 的节点
  - 无法分类的节点仍可通过 `memory_lookup` 检索
- 等真实产品跑 6-12 个月后，用数据回答"5 type 覆盖率是否 > 80%"，再决定是否收口为强制协议。

---

### 问题 5：LanceDB 单机配置下的"强一致"承诺能兑现吗？

**方案陈述**（§14.2）：
- `observations / memory_nodes / audit_logs / chunks` 强一致
- `text/vector indexes / entities/relations / summary_nodes / slot_snapshots` 最终一致

**问题**：
- **LanceDB 不支持跨表事务**（它是向量库，不是关系型数据库）
- 方案说"observations 先写入，再派生"，但如果写入 observation 成功、写入 audit 失败，就违反了"强一致"
- 默认配置（LanceDB + 本地文件）无法实现"强一致 + 跨表写"

**建议**：
- **明确"LanceDB 单机模式的一致性边界"**：
  - 单表内强一致（LanceDB 保证单次 append 原子）
  - 跨表最终一致（通过 job 异步同步）
- **引入"WAL 模式"保证关键操作**：
  ```typescript
  // 写入前先写 WAL
  await walLog.append({
    op: "store_memory",
    scope, id, text, timestamp
  });
  await memoryRepository.store([record]);
  await auditRepository.append({...});
  await walLog.commit(logId);
  ```
- **不要在文档中承诺"强一致"，改为"durable + replayable"**：
  - observation 写入后立即落盘（LanceDB append 是 durable）
  - 所有派生视图可从 observation 重建（replayable）
  - 这是单机配置能兑现的最强保证

---

### 问题 6：异步 job 系统的复杂度被低估

**方案陈述**（§9.2、§13.1、§14.3）：
- 至少 9 类 job：embed_chunk / 5_type_extraction / entity_relation / slot_snapshot_refresh / seal / candidate_review / skill_candidate / remote_sync / daily_digest
- job 必须幂等（§14.3）：`jobKey = hash(scopeKey + jobType + sourceId + contentHash + schemaVersion)`
- job 失败保留 error / attempts / nextRetryAt

**问题**：
1. **9 类 job 有依赖关系**：
   - slot_snapshot_refresh 依赖 5_type_extraction
   - daily_digest 依赖所有 seal
   - → 需要 DAG 调度，不是 flat queue
2. **schemaVersion 变化 → 全量重算**：
   - prompt 微调、LLM 升级、5 type 定义调整都会触发 schemaVersion 变化
   - jobKey 重算 → 所有旧 job 失效 → 需要重新 enqueue 全部历史数据
   - → 对 token 预算（§13.2）的严重冲击
3. **in-memory job repository 不 durable**：
   - 当前 [storage/repositories/in-memory.ts](../storage/repositories/in-memory.ts) 是内存 Map
   - 单机 daemon 重启 → 所有 queued/running job 丢失

**建议**：
- **v0.1 只保留 3 类核心 job**：
  - `embed_chunk`：已实现
  - `extract_candidate`：5 type 抽取
  - `seal_summary`：树折叠
  - 其他延迟到 v0.3+
- **引入成熟 job 库而不是自己造**：
  - Node.js 生态：`pg-boss`（PostgreSQL backed）或 `BullMQ`（Redis backed）
  - 提供 retry / dead-letter / priority / schedule / DAG 全套能力
  - 避免重复造轮子
- **jobKey 增加 `--ignore-schema-version` 模式**：
  - 允许"prompt 微调但复用旧结果"
  - 只有"schema 不兼容变更"才强制重算

---

### 问题 7：Console 8 页面 + 树/图可视化的工程量被严重低估

**方案陈述**（§11.1）：
- 8 个页面：Overview / Quick Lookup / Five Slots / Memory Tree / Graph / Candidates / Jobs & Audit / Resources
- Memory Tree 需要可交互树视图（4 种 layout）+ 摘要懒加载
- Graph 需要图可视化库 + evidence preview

**问题**：
- 8 个页面 + 树/图可视化是"完整管理后台"的体量，至少 4-6 人月前端工作
- 当前 Console 是 vanilla TypeScript（167 行），如果继续扩展，**会在 2-3 个页面后进入"难以维护"状态**
- 没有页面优先级排序，看起来 8 个都是"必须"

**建议**：
- **页面分三档**：
  - **核心档（v0.1）**：Overview + Quick Lookup（必须有，2 个页面）
  - **治理档（v0.3）**：Candidates + Jobs/Audit（候选审核必须可视化）
  - **可视化档（v0.5+）**：Memory Tree + Graph + Five Slots + Resources（数据量足够后才有价值）
- **技术栈升级**：
  - 现状 vanilla TS 做 8 页面 + 可视化是反模式
  - v0.1 切换到 **Vite + React + Tailwind + TanStack Query**，工作量增加 1 周但后续可维护性提升数倍
  - 图可视化用 **react-force-graph**（轻量、零配置）或 **cytoscape.js**（成熟、复杂度高）
- **Memory Tree 的 4 种 layout 简化**：
  - v0.5 只做 source tree（最容易理解，数据现成）
  - topic/global/slot tree 等真实数据足够后再做

---

## 三、与竞品的差异化（重新审视）

修正上一版评审中"被吐槽的过度设计"判断：

### 3.1 真正的差异化（站得住脚）

| 差异化点 | 竞品现状 | 本方案优势 |
|---|---|---|
| **5 问题 + 5 type 产品语义协议** | Mem0/Letta 都没有；Letta 的 core/archival 是技术分层不是产品语义 | 唯一以"Agent 执行前必须知道什么"为出发点的协议 |
| **Container 层（personal/project/session_candidate/team）** | Mem0 只有 user/agent/run 三层，无 project 隔离 | 多产品多项目场景的真实需求 |
| **候选区门控**（自动抽取先入候选，用户审核才晋升） | Mem0/Letta/Cognee 都是"自动写入主库" | 防止 Agent 静默污染长期记忆，**这是工程纪律的核心差异** |
| **Evidence first 强约束**（每条记忆/边/摘要都可追溯到 L0） | Cognee/Graphiti 有部分；Mem0 无 | 配合 Console 的 evidence preview，是可信度的工程保证 |
| **5 槽位 prompt 注入**（不是 ranked list 而是 5 段答案） | 所有竞品都返回 ranked hits | 让 Agent 拿到的是"答案"而不是"候选" |
| **Hot/Warm/Cold 三层 path**（§3.7） | Letta 有部分（自管理 context window）；其他无 | 性能保证 + 成本控制的清晰边界 |

### 3.2 重新评估上一版"可能被吐槽"的点

上一版评审说 Slot Tree、Work Memory Graph 是过度设计，**修正如下**：

| 上一版判断 | 修正后判断 |
|---|---|
| Slot Tree 是 OpenHuman 复刻 | Slot Tree 概念正确，但 **v0.x 用 SlotSnapshot 实现即可，不需要完整 tree 机制** |
| Work Memory Graph + Entity Graph 双图谱差异不锐 | 双图谱概念有价值（决策链 vs 实体关系），但 **底层应统一 Repository**，不要分裂存储 |
| 远程只读权威源用不到 | 单机模式确实用不到，**v0.x 直接砍掉远程章节**，等有团队部署需求再加 |

### 3.3 核心建议

不要被竞品的"功能丰富"带跑。本方案的**真正差异化是工程纪律和产品语义**，不是"双图谱""四类树""五槽位"这些技术概念本身。

文档应该突出：
1. **为什么"自动入库"是错的**（候选区门控的价值）
2. **为什么"ranked list"不够**（5 槽位的产品视角）
3. **为什么"evidence first"是底线**（不变量的可靠性意义）

---

## 四、默认 LanceDB + 本地文件 + embedding 配置下的方案修正

用户明确：**默认配置是 LanceDB + 本地文件 + embedding API**。这意味着：

### 4.1 必须删除或改造的章节

| 章节 | 现状 | 修正建议 |
|---|---|---|
| §10 双端与多产品架构 | 5 种运行模式（embedded/local-server/remote-client/remote-server/backend-proxy） | **v0.x 只保留 embedded + local-server**，其他延迟 |
| §10.2-10.3 远程只读权威源 | 团队/企业记忆同步 | **v0.x 整章删除**，等有真实团队部署需求再加 |
| §15 开放平台设计 | 9 类 Provider + Type Extension Registry | **v0.x 只保留 EmbeddingProvider 抽象**（已有），其他都不暴露扩展点 |
| §16.1 14 张主表 | 假设有事务能力 | **明确 LanceDB 单机模式的一致性边界**（见问题 5） |
| §17.1 隐私边界（远程不分享） | 多端场景 | **v0.x 简化为"所有数据都本地"**，无远程同步问题 |
| §18 Phase I 远程缓存与升格治理 | 完整 Phase | **v0.x 整 Phase 删除** |

### 4.2 默认配置下的简化收益

删除以上章节后：

- **方案文档从 1869 行 → 约 900-1100 行**（瘦身 40%）
- **Phase 从 10 个（A-J）→ 5 个**（见第五章迭代路径）
- **数据模型从 14 张表 → 8-9 张核心表**（删除 sync_states 等）
- **API 从 ~16 个端点 → ~8 个核心端点**

### 4.3 LanceDB 单机模式的特殊优化

**现有 [db/providers/lancedb.ts](../../db/providers/lancedb.ts)（565 行）的能力发挥**：
- LanceDB 原生支持向量 + 元数据混合查询，可以直接做 BM25 + vector 融合
- 单文件存储（`~/.openclaw/memory/autodb`）天然 portable，符合"本地优先"
- LanceDB 的 schema 演进能力（add column）适合 5 type 渐进引入

**单机优势**：
- 无 Supabase/PostgreSQL 配置门槛
- 无云端 embedding 强依赖（可用本地 ollama 或 transformers.js）
- 无网络延迟（hot path P95 < 50ms 可达，方案 §13.1 目标 < 200ms 太保守）

**修正后的 SLO**：
| 路径 | 原目标 | 单机配置目标 |
|---|---|---|
| `memory_context_fast` | P95 < 200ms | **P95 < 80ms**（本地无网络） |
| `memory_observe_light` | P95 < 50ms | **P95 < 20ms** |
| `memory_lookup` fast | P95 < 300ms | **P95 < 100ms** |
| `memory_lookup` deep | P95 < 2s | **P95 < 800ms** |

更激进的 SLO 反而是开源的卖点："本地 80ms 就能拿到 Agent 上下文"。

---

## 五、可持续迭代路径（核心建议）

### 5.1 迭代失败的常见模式

按方案当前 Phase A → J 顺序执行的风险：

1. **Phase A（Agent 快路径）→ B（语义层）→ C（5 槽位）三个 Phase 才能看到第一个完整可用功能**，中间 2-3 个月无可见价值
2. **Phase D（候选区）依赖 B（5 type 协议）→** 5 type 协议如果设计有偏差，候选区要重做
3. **Phase F（Work Memory Graph）→ G（Tree 持久化）→ H（Console）才能看到全貌**，前面的工作可能因为后面发现问题而返工

### 5.2 推荐的可持续迭代路径

**核心原则**：每个 milestone 都能交付**完整可用的 Agent 体验**，而不是"地基 → 上层 → UI"的瀑布。

#### Milestone 1（v0.1）：最小可用 Agent 快路径

**目标**：让 OpenClaw（或任何 Agent）通过一次调用获得 5 段答案。

**交付**：
- `memory_context_fast` MCP tool + `/v1/agent/context` REST 端点
- `MemorySemanticType` 作为可选字段（不强制）
- Slot Context Builder 简化版：基于现有 `MemoryRecord` 按 `kind → semanticType` 映射临时分组
- SlotSnapshot 内存 cache（不做 Tree）
- Console Overview + Quick Lookup（2 页面）

**砍掉**：
- 候选区（v0.1 用户显式保存即可）
- Work Memory Graph（v0.1 只用 Entity Graph baseline）
- Tree 持久化（v0.1 只用 in-memory tree buffer）
- 远程同步（v0.1 整 Phase 删除）

**验证**：
- OpenClaw 接入 `memory_context_fast`，对比"接入前 vs 接入后"的任务成功率
- 本地 P95 < 100ms

**预期工作量**：1.5-2 人月

---

#### Milestone 2（v0.2）：候选区 + 5 type 收口

**目标**：让自动抽取的记忆有门控，5 type 从可选变为推荐。

**交付**：
- `candidates` 表 + 5 type extractor（仅依赖 LLM API）
- 入库阈值（§9.3）+ 前置过滤（缺 why 丢弃 experience）
- Console Candidates 页面（含批量操作）
- 候选区自动淘汰（30 天未召回 → 删除）
- Quick Lookup 显示 evidence preview

**砍掉**：
- SKILL 升格（v0.3+）
- 远程贡献（v0.5+）

**验证**：
- 候选区接受率 > 30%（用户愿意审核）
- 5 type 覆盖率 > 60%（足够多记忆能归入 5 type）

**预期工作量**：2 人月

---

#### Milestone 3（v0.3）：可观测性 + 性能控制

**目标**：让"快而准"可量化、可调优。

**交付**：
- BudgetPolicy（§13.2）+ 降级 warning
- Recent Observation Ring（§9.2.1）
- BM25 delta index（基于 LanceDB 元数据查询）
- Console Overview 补齐 latency / cache_hit / candidate_accept_rate
- Retrieval Telemetry（哪些记忆被注入、被采纳）

**砍掉**：
- memory-eval 数据集（v0.5+）
- LLM 录制回放（除非有真实需求）

**验证**：
- P95 SLO 达成（context < 80ms, observe < 20ms, lookup < 100ms）
- Console 可看到 24h 内 retrieval 健康度

**预期工作量**：1.5 人月

---

#### Milestone 4（v0.4）：Work Memory Graph + Tree 持久化

**目标**：让记忆"能追溯、能折叠"。

**交付**：
- 统一 GraphRepository（不分裂 Entity / Memory）
- 工作记忆边：`derives_from / supersedes / contradicts`（先 3 种，足够）
- SummaryNode durable 存储（LanceDB 表）
- Source Tree（先做 1 种）
- Console Memory Tree 页面（仅 source tree）+ Graph 页面（基础视图）

**砍掉**：
- Slot Tree（用 SlotSnapshot 即可）
- Topic / Global Tree（v0.5+）
- 4 种 layout 切换（先做 source 一种）

**预期工作量**：2 人月

---

#### Milestone 5（v0.5+）：选做能力

按真实需求选做：
- Topic Tree / Global Tree（如果用户有"按主题查"的需求）
- Slot Tree（如果 SlotSnapshot 不够用）
- SKILL 升格（如果有真实 SKILL 升格场景）
- memory-eval 数据集（如果有评测需求）
- Vault export / Markdown 双向编辑（如果有 Obsidian 用户）
- 远程同步（如果有团队部署需求）
- Provider Registry / Type Extension（如果有第三方扩展请求）

### 5.3 可持续性的关键纪律

1. **每个 milestone 必须有"端到端验证场景"**，不是"内部组件就绪"
2. **不允许"为未来设计抽象"**：Provider Registry / Type Extension 在没有真实第三方需求前不要实现
3. **每次 schema 变化必须配迁移工具**（dry-run + 双写），方案 §16.3 的 migration 策略要前置到 v0.1
4. **所有"4 种""5 种""9 种"列表都要给"先做哪一种"的决策**，避免一次性铺开

---

## 六、方案文档本身的改进建议

### 6.1 文档组织问题

**1869 行单文件难以维护**，建议拆分：

| 拆分 | 内容 | 行数 |
|---|---|---|
| `memory-autodb-overview.md` | §1-§5（一句话结论、设计原则、顶层模型、总体架构） | ~400 行 |
| `memory-autodb-data-model.md` | §6-§7（数据模型、图谱设计） | ~300 行 |
| `memory-autodb-runtime.md` | §8-§9（记忆树、运行机制、Agent 快路径） | ~400 行 |
| `memory-autodb-quality.md` | §13-§14（成本性能、可靠性） | ~200 行 |
| `memory-autodb-roadmap.md` | §18-§22（迭代计划、决策、不做的事） | ~200 行 |

**原 22 章合并为 5 个聚焦文档**，每个文档独立可读。

### 6.2 缺失的关键内容

1. **Anti-pattern 清单**：什么场景不适合用 memory-autodb？例如：纯日志/审计场景、强事务场景、超大文档存储场景
2. **从竞品迁移指南**：用户从 Mem0/Letta 迁移过来时，如何映射数据
3. **debugging 手册**：召回不准时如何排查（slot 命中？BM25 命中？vector 命中？lifecycle 过滤？）
4. **性能基准方法**：怎么验证 P95 SLO？数据集多大？硬件配置？

### 6.3 决策依据透明化

文档 §20 列了 15 项关键决策，但**只说了"选什么"，没说"为什么不选其他"**。建议每个决策补：

```markdown
| 决策 | 选择 | 理由 | 替代方案 | 不选的原因 |
|------|------|------|----------|------------|
| 记忆主语义 | 5 问题 + 5 type | ... | A: 通用 kind 分类 | 缺少产品视角 |
|           |              |     | B: 完整本体论 | 过度设计、维护成本高 |
```

这样未来回顾决策时知道"当时为什么排除其他方案"。

---

## 七、立即可做的 5 个 Quick Win

不需要等大型 Phase，这 5 个改动可以在 1-2 周内完成，立即提升方案可执行性：

1. **拆分 1869 行单文件为 5 个聚焦文档**（§6.1）
2. **明确 LanceDB 单机模式的一致性边界**（问题 5）
3. **删除远程同步章节**（§10、§18 Phase I）
4. **5 type 改为可选字段**（问题 4），定义 fallback 策略
5. **重写 §18 分阶段计划**为本评审第五章的 5 个 milestone

完成这 5 项后，方案落地的不确定性将显著降低。

---

## 八、最终结论

### 方案的核心价值（必须保留）

1. **§3 设计原则**——这是方案的灵魂
2. **§4.2 5 type 产品语义协议**——真正的差异化
3. **§9.0 Agent 快路径设计**——中间件成熟度的体现
4. **§9.3 候选区门控**——工程纪律的核心
5. **§14 可靠性不变量**（evidence first / scope mandatory / revoked wins）

### 方案需要修正的核心问题

1. **Slot Tree 用 SlotSnapshot 替代**（v0.x）
2. **双图谱底层统一 Repository**
3. **候选区增加自动淘汰 + 批量审核**
4. **5 type 从强制改为可选 + 渐进收口**
5. **明确 LanceDB 单机一致性边界**
6. **job 系统引入 pg-boss/BullMQ，不自造轮子**
7. **Console 切换 React 技术栈，3 档分级**

### 可持续迭代的核心纪律

- **每个 milestone 端到端可用**，不是"地基 → 上层 → UI"瀑布
- **所有"未来抽象"必须有真实需求驱动**
- **schema 变化必须配迁移工具**
- **所有"N 种"列表都给优先级**

---

**评审人**: Claude Code  
**评审版本**: v2  
**关联文档**: [memory-autodb-deep-optimization-architecture.md](./memory-autodb-deep-optimization-architecture.md)  
**下一步**: 基于本评审产出修订版方案（建议先做"七、立即可做的 5 个 Quick Win"）
