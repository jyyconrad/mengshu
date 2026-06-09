# memory-autodb 下一步迭代产品方案

> 日期：2026-06-09
> 状态：下一迭代方案
> 基线：基于当前代码实现，而不是只基于长期架构设计。
> 产品定位真源：[product-positioning.md](../../03-architecture/product-positioning.md)

---

## 1. 一句话目标

下一步迭代的目标不是继续扩展图谱、树或远程平台，而是把当前已经实现的中间件基线打通成一个可被 Agent Runtime 使用的 **用户工作上下文闭环**：

> 用户在一个 Agent 产品、任务或工作场景中沉淀的工作记忆、偏好、规则、项目背景、历史经验和资源线索，在切换到另一个授权 Agent 产品或任务场景后，仍能被 `memory_context_fast`、`memory_lookup` 和 Console 快速、安全、可解释地使用。

本迭代的产品目标是：Agent 越用越懂用户，越理解用户的工作，运行越来越流畅；长期记忆可找、可追溯、可撤销。

---

## 2. 当前代码基线

当前代码已经具备以下基线能力：

| 能力 | 当前实现 | 状态判断 |
|------|----------|----------|
| 共享核心 | `core/memory-service.ts`、`core/service-types.ts` | 已有 `MemoryService` 合同和 default service |
| Scope | `core/scope.ts`、`adapters/openclaw/scope.ts` | 已有多维 scope，但产品级 app/workspace 语义需要强化 |
| OpenClaw adapter | `index.ts`、`adapters/openclaw/*` | 旧工具和 hooks 兼容，`memory_context_fast` 已接入 |
| REST server | `api/rest/router.ts`、`server/daemon.ts` | 已有 `/v1/*`、`/v1/agent/*`、`/v1/console/*` |
| MCP facade | `adapters/mcp/*` | 有 transport-agnostic 工具注册表，未绑定实际 transport |
| JS SDK | `sdk/js/client.ts` | REST client baseline |
| Agent 快路径 | `api/agent-fast-path.ts` | 有 context/observe/lookup/session commit 四类接口 |
| 5 槽位 | `core/semantic-type-mapper.ts`、`core/slot-context-builder.ts`、`core/slot-snapshot.ts` | 有 `kind -> semanticType`、SlotSnapshot 和 builder |
| 候选区 | `lifecycle/candidate-*`、`lifecycle/type-extractor.ts` | 有类型、内存 repository、review service 和启发式 extractor |
| Console | `console/api.ts`、`console/web/` | Overview / Lookup / Graph / Jobs baseline |
| Ingestion | `ingest/*` | document/chunk/job/audit 基线已存在 |
| Graph/Tree | `graph/*`、`tree/*` | 有 in-memory baseline，不是下一迭代主线 |
| CLI | `ltm serve/status/health/migrate` + legacy `ltm search/scan/...` | 可启动本机 server，但缺少 connect/doctor/demo |
| 评测方案 | `docs/07-test/memory-evaluation-plan.md` | 有方案，无实现 harness 和黄金集 |

结论：当前不是“从零实现”。下一迭代要做的是产品化闭环和稳定接入，而不是重新设计核心抽象。

---

## 3. 目标用户与场景

### 3.1 目标用户

| 用户 | 需求 |
|------|------|
| 用户 | 在不同 Agent 产品、任务和工作场景之间切换时，偏好、规则、项目背景和历史经验仍然可用 |
| Agent 产品开发者 | 用 REST/MCP/SDK 快速接入用户工作上下文，不重写记忆系统 |
| Agent Runtime | 启动任务时一次拿到 prompt-safe 的 5 槽位上下文 |
| 运维/产品管理员 | 通过 Console 速查、预览、审核和诊断记忆状态 |

### 3.2 首批场景

1. **用户偏好持续存在**
   - 用户在一个 Agent 产品中表达“复杂方案先给短结论，再给计划”。
   - 切到另一个授权 Agent 产品后，`memory_context_fast` 仍把这个偏好放入 rules/profile。

2. **工作背景持续存在**
   - 用户在 Claw Research 中沉淀项目背景。
   - 切到另一个任务场景后，任务上下文仍能召回项目目标、边界和资源。

3. **显式记住与速查**
   - 用户要求“记住这个约束”。
   - 后续可通过 `memory_lookup` 或 Console Quick Lookup 找到原文、来源和 evidence。

4. **运行中 observation 进入候选区**
   - Runtime 提交 `observe_light`。
   - 系统 ack 立即返回，后台生成 candidate，Console 可审核。

5. **本机诊断**
   - 产品接入失败时，开发者能用 `ltm doctor` 快速检查 server、配置、scope、数据库和接口健康。

---

## 4. 本迭代产品边界

### 4.1 必做

| 编号 | 能力 | 价值 |
|------|------|------|
| P0-1 | 用户工作上下文 scope 和授权复用规则 | 让不同授权 Agent 产品能复用同一用户工作上下文 |
| P0-2 | Agent Runtime 快路径增强 | 让 runtime 一次拿到 context、warnings、evidence、telemetry |
| P0-3 | `ltm doctor` / `ltm demo` / `ltm connect openclaw` | 降低接入成本和排障成本 |
| P0-4 | Console Overview + Quick Lookup 强化 | 让用户能速查、预览和追溯长记忆，不只是看数据库 |
| P0-5 | 候选区最小可见闭环 | 让自动抽取可审核、可解释、可清理 |
| P0-6 | 内置黄金集和 quick eval | 用固定评测证明新架构确实提升 |

### 4.2 暂不做

| 不做 | 原因 |
|------|------|
| 远程团队同步 | 当前主线是本地优先和用户工作上下文持续存在 |
| 完整 Graphiti/Zep 式 temporal graph | 当前已有 graph baseline，下一迭代不以图谱为主收益 |
| 完整 Slot Tree / Topic Tree / Global Tree | SlotSnapshot 已足够支撑 v0.x 快路径 |
| coding-agent 专用接入 | 当前产品方向不进入 coding-agent 细分赛道 |
| 大而全 SaaS Memory API | 不符合本地优先和用户工作上下文主线 |

---

## 5. 产品功能设计

### 5.1 用户工作上下文 Scope Contract

当前 `MemoryScope` 已有 `tenantId/appId/userId/projectId/agentId/namespace`，但用户工作上下文被多个授权 Agent 产品复用时，需要明确规则：

| 字段 | 下一迭代约定 |
|------|--------------|
| `tenantId` | 本机默认 `local` |
| `userId` | 用户工作上下文主键 |
| `appId` | 具体接入产品，例如 `claw-research`、`claw-project` |
| `workspaceId` | 同一工作空间内的工作上下文复用边界 |
| `projectId` | 当前项目或任务域 |
| `agentId` | 当前 runtime/agent 名称 |
| `namespace` | `memories`、`knowledge`、`candidates` 等逻辑空间 |
| `visibility` | `private`、`workspace`、`team`，v0.x 先本地解释 |

复用策略：

1. `profile` 和稳定 `rules` 默认按 `userId + workspaceId` 复用。
2. `task_context` 默认按 `userId + workspaceId + projectId` 复用。
3. `experience` 默认按 `projectId` 复用，可由用户或治理规则提升。
4. `resource` 默认按 `workspaceId/projectId` 复用。
5. private/revoked/stale 永远不因产品接入而放宽。

交付物：

- `scope policy` 文档和测试。
- OpenClaw adapter 支持传入或推导 `appId/workspaceId/projectId`。
- REST/SDK 示例覆盖两个不同 `appId` 复用同一用户工作上下文。

### 5.2 存储视图与 5type 运行视图

5type 是 Runtime 运行视图，不是长期记忆主库的全量存储模型。下一迭代需要明确输入、落盘、存储介质、记忆树和从存储视图到 5 slot 的召回管线。

产品输入分六类：

| 输入 | 入口 | 默认落盘路由 |
|------|------|--------------|
| Runtime observation | `memory_observe_light` | evidence + candidate job |
| Explicit save | `memory_save_explicit` | evidence + MemoryRecord 或 candidate |
| Session commit | `memory_session_commit` | session evidence + task/experience candidate |
| Document ingest | scan / ingest API | local file + Document/Chunk + index/tree jobs |
| Console governance | Console API | candidate/audit/lifecycle + snapshot invalidation |
| Import / migration | import API / CLI | staged import + validation + durable memory |

存储视图分四层：

| 层 | 保存什么 | 和 5type 的关系 |
|----|----------|-----------------|
| Source / Evidence | observation、document、chunk、tool result、provenance | 支撑追溯，不直接注入 |
| Durable Memory | `MemoryRecord`，包含 `kind`、`semanticType?`、scope、lifecycle、evidence | 5 slot 的主候选池 |
| Enrichment / Structure | entity、relation、summary、index、SlotSnapshot | 提供检索、解释和快路径 |
| Candidate / Governance | pending/approved/rejected/archived/expired candidate 和 audit | 审核后才能进入 durable memory |

存储介质边界：

| 介质 | 放什么 | 不放什么 |
|------|--------|----------|
| Structured store | MemoryRecord、Candidate、Document/Chunk metadata、Job、Audit、Lifecycle | 原始大文件 |
| Vector store | active memory、chunk、summary node、可选 entity/relation descriptor | audit、job、权限状态、pending candidate 默认不放 |
| Local files | raw/canonical document、transcript、tree export、eval source、backup package | lifecycle 真源 |
| Tree/graph store | entity、relation、TreeLeaf、TreeBuffer、TreeSummaryNode | 原始全文和权限真源 |
| Text/BM25 index | memory/chunk/summary text | 审计和 job 状态 |

记忆树保留三类：

| Tree | 用途 |
|------|------|
| Source Tree | 来源追溯、文档/会话摘要、evidence drill-down |
| Topic Tree | 围绕实体/项目/工具/文件的主题召回 |
| Global Tree | 工作区、项目、日期维度的整体预览 |

召回到 5type 的流程：

```text
normalize scope
  -> load fresh SlotSnapshot
  -> retrieve active MemoryRecord
  -> map kind / semanticType / metadata to slot candidates
  -> filter lifecycle / visibility / safety / conflict
  -> score by relevance, scopeFit, importance, confidence, evidence, recency
  -> allocate slot budget
  -> pack prompt-safe 5 slot context with evidence and telemetry
```

关键规则：

1. `semanticType?` 是运行视图字段，不能作为主库强制要求。
2. 无法映射到 5type 的合规记忆保留为 lookup-only。
3. pending candidate、raw observation、raw chunk 不进入 `context_fast`。
4. 每个 slot block 必须能回指 source/evidence。
5. SlotSnapshot 是快路径缓存，不是长期记忆真源。

召回模式：

| 模式 | 用途 | 主要数据 |
|------|------|----------|
| `context_fast` | Agent 启动 5 slot | SlotSnapshot、active MemoryRecord、轻量 text/BM25 |
| `lookup_fast` | 速查具体记忆和证据 | MemoryRecord、chunk index、source/evidence |
| `lookup_deep` | 复杂追溯和整体理解 | vector、BM25、source/topic/global tree、graph relation |

LightRAG 的 `naive/local/global/mix` 可作为 `lookup_deep` 的理论参考：chunk/vector 对应 naive，Topic Tree 对应 local，Global/Source Tree 对应 global，tree + graph + vector 融合对应 mix。`context_fast` 不走 mix，避免延迟和成本失控。

### 5.3 Agent Runtime 快路径增强

当前 `AgentFastPathService` 已有：

```text
context / observeLight / lookup / sessionCommit
```

下一迭代要把返回结构变成产品可用：

```typescript
interface AgentContextFastResult {
  contextBlock: string;
  slots: Record<string, SlotContextBlock>;
  taskHints: Array<{
    id: string;
    kind: string;
    semanticType?: string;
    preview: string;
    evidenceIds: string[];
  }>;
  warnings: string[];
  filtered: Array<{ id: string; reason: string }>;
  telemetry: {
    latencyMs: number;
    tokenEstimate?: number;
    cacheHit: boolean;
    scopeKey: string;
  };
}
```

增强点：

1. `warnings` 必须包含 stale、budget_exceeded、private_filtered、fallback_lookup。
2. `filtered` 解释哪些记忆被过滤，原因是什么。
3. `taskHints` 必须携带 evidence id。
4. telemetry 记录 latency、cacheHit、scopeKey、nodesUsed。
5. `memory_context_fast` 的 OpenClaw 工具、REST `/v1/agent/context` 和 SDK 输出保持一致。

### 5.4 接入体验：connect / doctor / demo

当前已有 `ltm serve/status/health/migrate`。下一迭代补三个产品化命令：

| 命令 | 作用 |
|------|------|
| `ltm doctor` | 检查配置、server、DB、embedding、scope、REST、Console 静态资源 |
| `ltm demo` | 写入一组用户工作上下文 demo 记忆，并演示不同 `appId` 下的 context/lookup |
| `ltm connect openclaw` | 输出 OpenClaw adapter 接入配置、server URL、secret、scope 示例 |

验收输出应面向产品开发者，而不是内部调试日志：

```text
Memory AutoDB Doctor
- server: ok http://127.0.0.1:3847
- database: ok lancedb ~/.openclaw/memory/lancedb
- embedding: warning not configured
- console: ok /console
- scope sample: local:claw-project:default:...
```

### 5.5 Console 最小可用治理闭环

当前 Console API 有 Overview / Lookup / Graph / Jobs。下一迭代聚焦三个页面：

| 页面 | 下一迭代要求 |
|------|--------------|
| Overview | 显示当前 scope、记录数、slot freshness、queued/failed jobs、candidate backlog |
| Quick Lookup | 返回 kind、semanticType、preview、evidence/source、score breakdown、copy reference |
| Candidates | pending/archived/rejected 过滤，批量 approve/reject/archive，30 天清理入口 |

不要求做复杂图谱可视化。Graph 页面可以保留为 baseline，但不是验收主线。

### 5.6 候选区闭环

当前已有 `CandidateRecord`、`InMemoryCandidateRepository`、`CandidateReviewService` 和启发式 extractor。下一迭代要打通到 Runtime 和 Console：

1. `observe_light` 入队 `extract_candidate`。
2. extractor 输出 candidate，不直接污染 5 槽位。
3. Console Candidates 可批量审核。
4. approve 后写入 `MemoryService.storeMemory()`。
5. reject/archive/expire 写 audit。
6. `memory_lookup` 可命中已入主库的 fallback 记忆；pending candidate 默认不进入 Agent context。

### 5.7 评测和验收

基于 [memory-evaluation-plan.md](../../07-test/memory-evaluation-plan.md)，本迭代先做 quick eval：

| 套件 | 数量 | 目的 |
|------|------|------|
| `memory-autodb-v0.1` | 20-40 | Agent context、lookup、SlotSnapshot、fallback |
| `memory-autodb-cross-product` | 20-30 | 同一用户工作上下文在不同 `appId` 下的连续性 |
| `memory-autodb-safety` | 15-25 | private/revoked/stale/conflict 不误注入 |

最低可用命令：

```bash
npx tsx eval/cli.ts run --target baseline-v4 --suite local-quick
npx tsx eval/cli.ts run --target vnext --suite local-quick
npx tsx eval/cli.ts compare --base baseline-v4 --candidate vnext
```

如果暂时不实现完整 eval CLI，也必须先落 `eval/goldens/*.jsonl` 和一个 Vitest runner，保证方案可回归。

---

## 6. 里程碑拆分

### Milestone A：用户工作上下文 scope 和快路径可用

目标：让两个不同 `appId` 的授权 Agent 产品能复用同一用户的稳定工作上下文，并通过 `memory_context_fast` 使用。

交付：

1. `scope policy` 实现和测试。
2. 存储视图和 Recall-to-5type 管线实现和测试。
3. OpenClaw adapter 支持 `appId/workspaceId/projectId` 推导或传入。
4. `/v1/agent/context` 返回 warnings、filtered、evidence、telemetry。
5. `memory_context_fast` 工具输出与 REST 对齐。
6. 文档示例：一个 `appId` 写入，另一个 `appId` 在同一用户 scope 下召回。

验收：

1. 两个 `appId` 在同一 `userId/workspaceId` 下复用 profile/rules。
2. task_context 不跨 project 泄漏。
3. private/revoked 不进入 context。
4. pending candidate、raw observation、raw chunk 不进入 `context_fast`。
5. 无 `semanticType` 的合规记忆仍可通过 `memory_lookup` 命中。
6. 每个 slot block 有 source/evidence 引用。
7. `npx tsc --noEmit` 和相关 Vitest 通过。

### Milestone B：本机接入体验

目标：产品开发者能在 10 分钟内启动、诊断并接入一个 OpenClaw adapter。

交付：

1. `ltm doctor`。
2. `ltm demo`。
3. `ltm connect openclaw`。
4. README 和 CLI 文档更新。

验收：

1. 没有 embedding 服务时，doctor 能区分 warning 和 fatal。
2. demo 能写入用户工作上下文样例，并在不同 `appId` 下输出 context/lookup 结果。
3. connect 输出可复制的 server URL、secret、scope 示例。

### Milestone C：Console 和候选区闭环

目标：自动抽取不直接污染主库，用户能在 Console 审核和解释。

交付：

1. Console Candidates API。
2. Console Candidates 页面。
3. candidate approve/reject/archive/expire 写 audit。
4. Overview 增加 candidate backlog 和 slot freshness。
5. Quick Lookup 增加 evidence/source 和 copy reference。

验收：

1. pending candidate 不进入 5 槽位。
2. approve 后可被 context/lookup 使用。
3. reject/archive 后不会被注入。
4. 批量操作有测试覆盖。

### Milestone D：quick eval 和发布门槛

目标：能用固定黄金集证明这次迭代比 baseline 更好。

交付：

1. `eval/goldens/memory-autodb-v0.1.jsonl`。
2. `eval/goldens/memory-autodb-cross-product.jsonl`。
3. `eval/goldens/memory-autodb-safety.jsonl`。
4. quick eval runner。
5. `eval/results/*/report.md`。

验收：

1. cross-product suite 显示同一用户工作上下文在不同 `appId` 下关键记忆召回成功。
2. safety suite private/revoked 误注入为 0。
3. fallback 记忆无 `semanticType` 仍可 lookup。
4. context 快路径 P95 达到本地 SLO 或输出性能缺口。

---

## 7. API 和文档同步清单

本迭代涉及以下文档同步：

| 改动 | 同步文档 |
|------|----------|
| scope policy | `docs/03-architecture/product-positioning.md`、`docs/06-database/schema.md` |
| `/v1/agent/context` 输出增强 | `docs/05-api/memory-api.md` |
| `ltm doctor/demo/connect` | `docs/05-api/cli-commands.md` |
| Console Candidates | `docs/04-design/04.1-overview/web-console-design.md` |
| eval quick runner | `docs/07-test/memory-evaluation-plan.md`、`docs/07-test/README.md` |
| 版本发布 | `docs/09-changelog/` |

---

## 8. 风险和处理

| 风险 | 处理 |
|------|------|
| scope 共享过宽导致隐私泄漏 | 默认只共享 profile/rules，task_context 按 project 隔离，private/revoked 强过滤 |
| 候选区增加后用户不审核 | 提供批量 approve/reject/archive 和自动清理 |
| Console 扩展过快 | 本迭代只做 Overview/Lookup/Candidates，不做复杂 graph/tree UI |
| eval 工程量过大 | 先做 JSONL golden + Vitest runner，再做完整 CLI |
| OpenClaw adapter 继续膨胀 | 新能力尽量进 `MemoryService`、`AgentFastPathService`、Console API，adapter 只做映射 |

---

## 9. 推荐实施顺序

1. Milestone A：scope policy + Agent context 输出增强。
2. Milestone B：`ltm doctor/demo/connect`。
3. Milestone C：Console Candidates + candidate 审核闭环。
4. Milestone D：quick eval + release gate。

这四个里程碑完成后，memory-autodb 才算从“已有中间件模块”进入“可被授权 Agent 产品稳定复用的用户工作上下文方案”。
