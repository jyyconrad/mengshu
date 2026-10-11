# mengshu 升级方案：本地治理记忆 × 5type 可持续发挥

> **状态**：**LOCKED（2026-10-11）** — 先定稿再编码；实现必须对照本文件，不得漂移成 Mem0/Letta 克隆。  
> **基线分支**：`1.0.6` @ `cdc868d`（包版本已标 1.0.7）  
> **实现分支**：`maintain/upgrade-local-agent-memory-20261011`  
> **依据**：仓库分析、开源记忆产品对比简报、`docs/design/memory-system-unified-design.md`（D-01~D-23）、`docs/architecture/system-architecture.md`、`packages/api/src/agent-fast-path`、`packages/mcp/src/tools.ts`、`packages/core/src/context/slot-context-builder.ts`

---

## 0. 决策摘要（给实现者的硬约束）

| ID | 决策 | 理由 |
|----|------|------|
| L1 | 产品定位 = **本地治理记忆中间件**（编码/工作 Agent） | 对比简报 §5.2：邻居是 FactMem / Graphiti / CrewAI；生态标杆是 Mem0，但赛道不同 |
| L2 | 5type **不改枚举**：`profile / task_context / rules / experience / resource` | D-04/§2.3；存储维；消费维 = 五槽 `memory_context_fast` |
| L3 | P0 **不重写** RuntimeHost / Write Kernel / D-01~D-23 | 缺口在门面、连续性、Skill、默认路径，不在算法 |
| L4 | MCP 工具 **只藏不删**；`MENGSHU_MCP_TOOL_MODE=default\|minimal\|full` | 对齐 Cognee tool modes / FactMem 少工具面 |
| L5 | 五槽响应 **五键恒在**；空槽 `nodeCount=0` + `empty_slot:` reason；prompt 仍跳过空槽 | 现状 `SlotContextBuilder` 只输出有数据的 key，Agent 无法稳定依赖 schema |
| L6 | `memory_explain` = 已存 why **或** 候选 admission **dry-run**（不造假 last-decision 库） | CLI 已有 `ms why`；admission 有 `reason`；缺 MCP 门面 |
| L7 | 交付物必须含可安装用法 Skill：`.agents/skills/mengshu/SKILL.md`（name: `mengshu`） | 用户硬性要求；对齐 Mem0 SKILL 分发 |
| L8 | 本轮 **不 push / 不发 npm / 不打正式 tag** | 用户未授权 |

---

## 1. 定位重申与竞品差距

### 1.1 产品定位（锁定）

mengshu **不是** Mem0 式「最大生态记忆 API」，也 **不是** Letta 式「Agent 本体记忆（MemFS）」。

它是 **编码 / 工作 Agent 的本地优先治理型记忆中间件**：

| 承诺 | 含义 | 代码/文档锚点 |
|------|------|----------------|
| 本地优先 | CLI / MCP / Codex·Claude·OpenClaw；推荐本机 Postgres | `docs/guides/configuration.md`；`ms setup` / `ms init` |
| 治理 fail-closed | authority → validator → admission；缺 capability 收缩 | `packages/core/src/lifecycle/*`；architecture §3 |
| 5type 持续发挥 | 存储 semanticType；消费五槽 | `semantic-types.ts` FIVE_QUESTIONS；`agent-fast-path` |
| 可解释 | 六因子回执、filtered reason、admission reason | recall receipts；`ms why` |

### 1.2 可核验差距（相对对比简报 §3–§6）

| 维度 | 邻居 | mengshu 现状（代码事实） | 本轮补法 |
|------|------|--------------------------|----------|
| 默认能跑 | Mem0 Server / FactMem SQLite；Cognee Docker | 推荐 Postgres，**无**仓库级 `docker-compose`；LanceDB fail-closed 散落在 configuration | compose + quickstart + fail-closed 表 |
| Agent 工具面 | Cognee 少工具；FactMem MCP+resource | `createMcpMemoryTools` 注册几十个 `memory_*`（temporal/working_set/evolve/asset…） | `tool-mode` 默认门面 + discover |
| Skill | Mem0 `skills/mem0/SKILL.md` | 仅 `plugins/codex/skills/mengshu-memory`；根 `.agents/skills` 无 `mengshu` | **通用 `mengshu` Skill** |
| 治理可演示 | CrewAI match_reasons | `ms why` + admission `reason` 存在；MCP 无统一 explain | `memory_explain` |
| 五槽消费 | 多数无固定 5 问题协议 | Builder 按有数据的 type 填 slots；**空 key 省略**（测例曾 `experience` → `undefined`） | `ensureFiveSlots()` |

**赢面**：fail-closed authority + 5type 协议 + 多 Runtime。  
**输面**：本地默认路径 + Agent 默认工具/Skill 心智。  
**本轮只补输面与连续性，不改算法规格。**

---

## 2. 目标定义（可验收）

### 2.1 便捷

1. `docker compose -f docker-compose.postgres.yml up -d` 起 pgvector Postgres（默认端口/库/用户写进 quickstart）。  
2. `docs/guides/local-agent-memory-quickstart.md` ≤10 步：`setup` → `init` → authority → `mcp`（default mode）→ 安装 Skill。  
3. quickstart **显式表**：LanceDB-only 时哪些能力 fail-closed（temporal / working set / skill artifacts / durable job / continuous evolution / 部分 forget 事务能力等，以 configuration + architecture 为准）。  
4. `MENGSHU_MCP_TOOL_MODE`：`default`（默认）/ `minimal` / `full`；`memory_tools_discover` 列出未广告工具。

### 2.2 强大

1. 写入主链不变：authority → validator（含 5type 闸门）→ admission。  
2. `memory_explain`：  
   - `memoryId|query` → 已存记忆 why（复用 `extractWhyDetails` / `formatWhyReport`）；  
   - `candidate{text,semanticType,…}` → validator+admission **dry-run**，返回 `reasonCodes` / `route` / `rejectedReason`。  
3. Skill：触发条件、主工具、5type 写入/召回规则、禁止编造、fail-closed 提示。

### 2.3 5type 可持续发挥

| 验收项 | 标准 |
|--------|------|
| 五键恒在 | `context_fast` 响应 `slots` 必含五 key |
| 空槽形态 | `nodeCount===0`，`sourceIds=[]`，`content===""`，`warnings` 含 `empty_slot:<reason>` |
| reason 枚举 | 至少：`no_active_memories` / `loadout_policy_excluded` / `all_filtered` |
| Prompt | `packSlotsToPrompt` 继续跳过 `nodeCount===0`（不涨 token） |
| 不塌缩 | 不同 semanticType 不得合并进同一槽；单测锁定 |

---

## 3. 架构目标态

```text
 Coding/Work Agent
   │  SKILL name=mengshu  (.agents/skills/mengshu/SKILL.md)
   ▼
 MCP ListTools ← MENGSHU_MCP_TOOL_MODE
   default: context_fast, recall, save, observe, observe_light,
            forget, lookup, explain, tools_discover, health, namespaces
   minimal: context_fast, recall, tools_discover, health
   full:    全部已注册 memory_*
   │  CallTool：隐藏工具仍可按精确名调用（只藏 List，不删实现）
   ▼
 RuntimeHost（P0 不改主链）
   Write: authority → validator(5type) → score → dedupe → admission
   Recall/Context: retrieval → SlotContextBuilder → ensureFiveSlots ★ → pack
   Explain: memory_explain → why | admission dry-run
   Storage: Postgres 推荐；LanceDB = 兼容存取 + 治理 capability fail-closed
```

**5type 贯穿点（必须写进 Skill 与测试）**

1. **写入**：MCP `memory_observe` / governed save 携带 `semanticType`；validator G05 + profile 白名单。  
2. **存储**：`MemoryRecord.semanticType` ∈ 五枚举。  
3. **消费**：`memory_context_fast` 五槽 = 五问题（FIVE_QUESTIONS）。  
4. **解释**：dry-run / why 带上 semanticType 与闸门原因码。

---

## 4. 分阶段路线

### P0（本轮）

| ID | 动机 | 路径 | 验收 | 风险 / 缓解 |
|----|------|------|------|-------------|
| P0-1 | Agent 用法入口 | `.agents/skills/mengshu/SKILL.md`；Codex skill 对齐指针 | Skill 可软链安装为 `mengshu`；含触发/5type/主工具/fail-closed | 过长 → 短清单 + 链到 quickstart |
| P0-2 | 降选错工具率 | `packages/mcp/src/tool-mode.ts`；`tools.ts` `applyMcpToolFacade` | default List ⊆ 主工具集；full=全量；discover 列出隐藏 | 旧客户端要全量 → 文档写 `MODE=full`；**默认改为 default** |
| P0-3 | 五槽连续性 | `five-slot-continuity.ts`；`slot-context-builder` 两入口 | 五键恒在；空槽 reason；改旧测 `toBeUndefined` | Loadout 过滤测例期望 undefined → 改为 empty+reason |
| P0-4 | 治理可演示 | `admission-explain.ts`；MCP `memory_explain` | dry-run + stored why；无假数据 | 无持久 last-decision → 明确 dry-run 语义 |
| P0-5 | 一键本地 | `docker-compose.postgres.yml`；`docs/guides/local-agent-memory-quickstart.md` | compose 文件存在；fail-closed 表完整 | 镜像网络 → 文档注明镜像名 |

### P1

- 会话结束 / compact 前 / 任务完成钩子（FactMem PreCompact 对齐）  
- admission 短时收据落库（真 last-decision by id）  
- README「拦下 vs 通过」对照  
- CI + npm 发布 / `v1.0.7` tag（成熟度）

### P2

- 可选 Graphiti 时序桥（不替换主链）  
- evolution/wiki Agent 可见进度  
- 评测：五槽覆盖率 / 空槽原因分布

---

## 5. 明确不做什么

1. 不做 Mem0：禁止默认「LLM 抽事实后静默 ADD」。  
2. 不做 Letta：不把记忆做成 Agent 内嵌 MemFS。  
3. 不重写 RuntimeHost / Write Kernel / 不改 D-01~D-23。  
4. 不删除 MCP 工具实现。  
5. 不重新设计 5type 枚举或槽位语义。  
6. 不在本机/云 box **安装** Grok；仅可在已有 Grok 的用户 Mac 上协助。  
7. 不 push、不发 npm、不打正式 release tag（除非用户另嘱）。

---

## 6. 用法 Skill 合同（交付硬门槛）

路径：`.agents/skills/mengshu/SKILL.md`  
frontmatter：`name: mengshu`  
另：`plugins/codex/skills/mengshu-memory/SKILL.md` 与之对齐并指向通用包。

**Skill 必须包含的章节**

1. **何时启用**（触发）：改代码/定计划前；用户提到偏好/约束/复用教训；跨会话连续性。  
2. **默认 MCP 工具**（与 default mode 一致）及选用顺序：`context_fast` → 不够再 `recall`/`lookup` → 确认后 `save`/`observe` → 纠错用 `explain` → 删除用 `forget`。  
3. **5type 写入规则**：每条 governed 写入必须标 semanticType；分类速查表；profile 白名单提示；禁止把一次性日志标 rules/profile。  
4. **5type 召回规则**：依赖五槽 key 恒在；空槽表示「该类无活跃记忆」而非工具失败。  
5. **禁止**：编造记忆、 invent id、绕过 authority、把候选当已准入事实。  
6. **fail-closed**：缺 authority / 缺 Postgres capability / LanceDB-only 时的行为与用户沟通话术。  
7. **安装**：软链到 Agent skills 目录的一行命令。

---

## 7. 本轮代码改动清单与进度

| # | 路径 | 变更 | 进度 |
|---|------|------|------|
| 1 | `docs/plans/upgrade-local-agent-memory-5type-20261011.md` | 本方案 LOCKED | ✅ |
| 2 | `packages/core/src/context/five-slot-continuity.ts` + test | ensureFiveSlots | ✅ |
| 3 | `packages/core/src/context/slot-context-builder.ts` | 返回前 ensureFiveSlots | ✅ |
| 4 | `packages/core/src/domain/semantic-types.ts` | 五键运行时保证注释 | ✅ |
| 5 | `packages/core/src/lifecycle/admission-explain.ts` + test | dry-run | ✅ |
| 6 | `packages/mcp/src/tool-mode.ts` + test | mode 过滤（ListTools） | ✅ |
| 7 | `packages/mcp/src/tools.ts` | facade + explain + discover | ✅ |
| 8 | `packages/mcp/src/stdio-server.ts` / `server.ts` | ListTools 按 mode 过滤 | ✅ |
| 9 | `.agents/skills/mengshu/SKILL.md` | **用法 Skill（硬门槛）** | ✅ |
| 10 | `plugins/codex/skills/mengshu-memory/SKILL.md` | 对齐 | ✅ |
| 11 | `docker-compose.postgres.yml` | pgvector | ✅ |
| 12 | `docs/guides/local-agent-memory-quickstart.md` | 快路径 | ✅ |
| 13 | vitest：continuity / tool-mode / explain；修旧断言 | | ✅ |

---

## 8. 测试计划（P0）

```bash
# 聚焦
npx vitest run packages/core/src/context/five-slot-continuity.test.ts
npx vitest run packages/core/src/context/slot-context-builder.test.ts
npx vitest run packages/api/src/agent-fast-path/index.test.ts
npx vitest run packages/core/src/lifecycle/admission-explain.test.ts
npx vitest run packages/mcp/src/tool-mode.test.ts
npx vitest run packages/mcp/src/tools.test.ts
```

断言要点：五键恒在；loadout 排除 → 空槽 + `loadout_policy_excluded`；default mode List 不含 `memory_evolve`；`memory_explain` candidate dry-run 返回 reasonCodes。

---

## 9. 成功标准

- [x] 方案 LOCKED  
- [x] P0 代码提交到实现分支（不 push）  
- [x] `.agents/skills/mengshu/SKILL.md` 达到 §6 合同  
- [x] 上表聚焦测试通过（authority 竞态旧测 1 条 flaky/无关，见报告）  
- [ ] 报告：实现 vs 延期、五槽如何强制、残留风险  

---

## 10. 实现顺序（本轮执行纪律）

1. ~~方案定稿~~
2. ~~用法 Skill~~（Grok@Mac CLI 可找到但单轮无输出；本地定稿）
3. ~~P0 代码与单测~~
4. ~~compose + quickstart~~
5. 提交 + 向 parent 报告  
