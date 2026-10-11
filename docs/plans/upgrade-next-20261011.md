# mengshu 下一阶段升级方案

> 基线：分支 `1.0.7`（包 `@mengshu/core` 1.0.7）  
> 前序：[`upgrade-local-agent-memory-5type-20261011.md`](./upgrade-local-agent-memory-5type-20261011.md)（P0+P1 已合入）  
> 定位：编码 / 工作 Agent 的**本地治理记忆中间件**（不是 Mem0 式最大生态 API，也不是 Letta 式 Agent 本体）

---

## 1. 现状

### 1.1 已有能力

| 能力 | 位置 | 说明 |
|------|------|------|
| 用法 Skill | `.agents/skills/mengshu/SKILL.md` | 默认工具序、5type 写入/召回、fail-closed 话术 |
| MCP 工具门面 | `packages/mcp/src/tool-mode.ts`、`tools.ts` | `default` / `minimal` / `full`；`memory_tools_discover` |
| 五槽连续 | `packages/core/src/context/five-slot-continuity.ts` | `ensureFiveSlots()`；空槽带 `empty_slot:` |
| 治理可解释 | `memory_explain`；schema v39 收据表 | stored why / dry-run / `lastDecision` |
| 一键 Postgres | `docker-compose.postgres.yml` + `docs/guides/local-agent-memory-quickstart.md` | 本地默认可起库 |
| 会话钩子推荐表 | `packages/core/src/runtime/agent-session-hooks.ts` + `docs/guides/agent-session-hooks.md` | `session_start` → 召回；compact/结束 → 捕获 |
| CLI 目录扫描雏形 | `packages/api/src/cli/ms.ts`（`ms scan`） | 目前主吃 `.md` / `.mdx` → ingestion |
| evolve 目录批次 | `packages/api/src/cli/evolve.ts` | host-registered `scan --source-id` |

### 1.2 要解决的问题

1. **MCP**：Agent 回合内工具序和空召回/拒绝状态不够清楚；扫盘类工具容易被误当成热路径。  
2. **CLI**：`ms scan` 偏 Markdown；「分析报告 → dry-run 提案 → apply 入库」产品化不足，与 5type / admission 结果对操作者不够可见。  
3. **Hooks**：推荐表已有，宿主真实事件覆盖不齐；会话载荷合同碎，compact/结束仍易丢结论。  
4. **横切**：authority 冷启动、旧库 migrate（含 v39 收据）可见性、5type **抽取质量**（不只五键恒在）缺少日常闸门。

一句话：门面已立；缺口在**三条本地入口的分工清晰度与可测性**，以及横切冷启动/质量闸。

---

## 2. 目标

### 2.1 要达成什么

让编码 / 工作 Agent 在本地治理记忆时：

| 维度 | 目标 |
|------|------|
| **便捷** | 约 15 分钟内完成：起库 → authority → 一轮 MCP 记取 或 一次 CLI dry-run→apply 或 一次 Hooks 被动捕获 |
| **强大** | 拒绝可解释、写入有收据、升格（experience→`skill_candidate`）可见但不可自动执行 |
| **5type 持续** | 五槽 schema 连续 + 覆盖/混淆/错标拒绝可测；写入与召回都按五槽语义消费 |

三条入口各自打穿：

| 入口 | 目标行为 |
|------|----------|
| **MCP** | Agent **实时**调用：`context_fast` → `recall` → `observe`/`save` → 争议时 `explain` |
| **CLI** | **全面分析目录**，把目录信息经治理写入记忆库（批处理、可审计、可 dry-run） |
| **Hooks** | **被动**触发：用 Agent 会话等信息更新记忆（不弹窗、不发明宿主 API） |

### 2.2 目标约束

- **暂不做** npm 及其他发布渠道（registry、正式 release tag、`main` 快进另议）。  
- **不接入** Graphiti 或任何第三方记忆中间件桥（Zep / Mem0 server / Cognee-as-backend 等）。  
- **优先做强** MCP、CLI、Hooks；CI / 插件包装让路。  
- **不改** Write Kernel / RuntimeHost / 统一设计 D-01~D-23 算法规格；不重设计 5type 枚举。  
- **不绕过** authority / admission；CLI 与 Hooks 写入与 MCP 走同一主链。  
- experience→`skill_candidate`：**可观测、可解释、不可自动变可执行 Skill**。

---

## 3. 实现思路与逻辑

### 3.1 三条通道怎么配合

```
Agent 回合（低延迟）
  └── MCP：context / recall / observe / save / explain
           （default List 只含实时工具）

宿主事件（被动）
  └── Hooks：session_start → 召回
             pre_compact / task_complete / session_end → typed capture
           （失败可观测，不阻断回合）

人 / 脚本（批处理）
  └── CLI：ms scan（及 evolve scan）
           目录 → 解析 → 报告 → dry-run → apply → 入库
```

| 入口 | 谁调用 | 输入 | 副作用 | 边界 |
|------|--------|------|--------|------|
| MCP | Agent 回合内 | 查询、候选、memoryId | 召回上下文、写入回执 | 不做大批量扫盘 / 长跑 evolve |
| CLI | 人 / 脚本 | **目录路径**、ignore、dry-run/apply | 扫描报告、治理入库 | 不替代回合内召回；无 authority 不灌库 |
| Hooks | 宿主回调 | **会话/compact 事件载荷** | 触发召回或捕获写入 | 不主动打扰；不发明 flush-plan；不做 CLI 级扫盘 |

三者写入同一套：**authority → 校验 → 评分 → 去重 → admission →（PG）收据**。召回同一套：多路候选 + scope + 多因子分 + 五槽打包。

### 3.2 写入 / 召回 / 治理主链怎么接

1. **召回热路径（MCP + Hooks session_start）**  
   `memory_context_fast` / `memory_recall` → `SlotContextBuilder` + `ensureFiveSlots` → Agent 消费五键；空槽不填假内容。

2. **写入热路径（MCP observe/save + Hooks capture + CLI apply）**  
   候选 → admission → 持久化；PG 下写 `mengshu_admission_decision_receipts`；Agent 用 `memory_explain` 查 why / lastDecision。

3. **CLI 批处理**  
   扫盘只产生「拟写入提案」；apply 才进主链。dry-run 必须能预览 semanticType 分布与拒绝预览。

4. **工具面隔离**  
   扫盘 / evolve 长跑：**CLI 主入口**；MCP 若保留 `memory_scan_directory` 等，只进 `full` / discover，文档指向 CLI。

### 3.3 5type 怎么贯穿

| 环节 | 做法 |
|------|------|
| Schema | 五键恒在（已有 `ensureFiveSlots`） |
| 写入 | Skill + CLI 报告强制标 `profile` / `task_context` / `rules` / `experience` / `resource`；错标可拒 |
| 召回 | 按槽打包进 prompt；空槽跳过正文，保留 reason |
| 质量闸 | 评测子集：覆盖率、混淆率、错标拒绝率（P2 补）；不只「键在不在」 |
| 升格 | `experience` → 可见的 `skill_candidate`（只读）；禁止自动可执行 |

### 3.4 支撑项（服务三入口，非主叙事）

- `ms authority init` + doctor（冷启动）  
- migrate/doctor 暴露 schema v39 收据状态  
- Skill SAFE / 密钥门（约束 MCP 与 Hooks 写入内容）

---

## 4. 可借鉴开源仓库

> 只借鉴**门面与证明手法**；治理默认仍是 mengshu 的 fail-closed admission。  
> **Graphiti 不接入**（见 §2.2）；下表若出现，仅作异步/检索模式参考。

| 仓库 | 借鉴什么 | 对方能力落点（公开文档/常见模块） | 落到 mengshu 的哪条入口 / 哪段代码 |
|------|----------|-----------------------------------|-------------------------------------|
| **[FactMem](https://github.com/gordonkjlee/factmem)**（`@factmem/mcp`） | 短 MCP 工具面；会话初 briefing；事实 supersede（不可静默物理删）；目录级所有权 | MCP tools（remember/recall 类）；SQLite 本地库；integrate/supersede 管线 | **MCP**：收紧 default List、开场 `memory_context_fast`；**治理话术**：`memory_explain` 拒绝/替代原因。参考其「本地 MCP + 固化」体验，**不**默认改用 SQLite 替代 Postgres |
| **[Cognee](https://github.com/topoteretes/cognee)** | MCP tool mode；空结果带状态行；`remember` / `recall` / `forget` 语义清晰 | MCP server + ECL（add→cognify）管线 | **MCP**：空召回区分 `ok-empty` / `authority-filtered` / `not-ready`（`packages/mcp/src/tools.ts` + health）；**不做** Cognee-as-backend |
| **[Mem0](https://github.com/mem0ai/mem0)** | Skill/SAFE 写入纪律；自包含事实句；user/agent/run scope 隔离思路 | OSS SDK `add`/`search`；Skills 文档中的 SAFE 门 | **Skill + Hooks 写入纪律**（`.agents/skills/mengshu/SKILL.md`）；**不抄**默认静默 ADD；**不做** Mem0 server 桥、**暂不做** registry 分发 |
| **[CrewAI Memory](https://docs.crewai.com/concepts/memory)**（框架内 `Memory`） | 复合分 + `match_reasons`；scope 树可读 | Crew/Agent 内建 Memory；LanceDB 默认存储 | **MCP/召回可解释**：命中与拒绝理由对 Agent 可读（对齐 score breakdown / explain）。**不抄** consolidation 失败默认 insert |
| **编码 Agent 钩子模式**（Claude Code / Codex 等 SessionStart、PreCompact、Stop 文档） | 会话开始召回、compact/结束抽取的**时机** | 宿主生命周期钩子 | **Hooks**：`packages/core/src/runtime/agent-session-hooks.ts` + `docs/guides/agent-session-hooks.md`；OpenClaw 真事件优先；无稳定合同则 Skill 映射，**不发明** flush-plan |
| **LangMem + LangGraph Store**（[langchain-ai/langmem](https://github.com/langchain-ai/langmem)） | 热路径 tool + 后台 manager 的分工；namespace 隔离 | `manage` tool + 后台 memory manager；`BaseStore` | **思路对齐**：MCP=热路径，CLI/进化作业=批处理；**不强绑** LangGraph |
| **[Memori](https://github.com/MemoriLabs/Memori)** | SQL 原生、attribution（entity/process）；conscious vs auto 双模式的「何时写」 | SQL 表 + LiteLLM 回调 | **CLI/运维叙事**：目录摄入要有来源归因；写入模式显式（dry-run vs apply），避免「回调静默灌库」 |
| **[Graphiti](https://github.com/getzep/graphiti)**（**不接入**） | 仅参考：episode 增量、检索侧少强制 LLM rerank、异步摄入节奏 | 时序图引擎；Neo4j/FalkorDB 等 | **不接桥、不当后端**。若未来自研异步批次，只借鉴「摄入与检索解耦」的产品节奏，实现仍走自有 evolve/CLI |

**汇总映射**

| 借鉴主题 | 主要来源 | mengshu 落点 |
|----------|----------|--------------|
| 短工具面 + 空结果状态 | FactMem、Cognee | MCP default / health |
| 开场 briefing + SAFE 写入 | FactMem、Mem0 Skills | MCP `context_fast` + Skill |
| 可解释命中/拒绝 | CrewAI `match_reasons` | explain + score breakdown |
| 会话被动更新时机 | 编码 Agent 钩子文档 | Hooks 推荐表与宿主接线 |
| 目录边界 + 显式 ingest | FactMem 目录所有权、各类 repo ingest | CLI `ms scan` 报告/ignore/dry-run |
| 热路径 vs 批处理分工 | LangMem tool/manager | MCP vs CLI/evolve |
| 异步摄入节奏（参考） | Graphiti（**不接入**） | 仅文档级节奏参考 |

---

## 5. 分阶段落地

### 5.1 P2-A — MCP（Agent 实时调用）

| 改什么 | 怎么做 | 验收 |
|--------|--------|------|
| 默认工具序 | Skill 与 MCP 文档统一：`context_fast` → `recall` → `observe`/`save` → `explain`；`tool-mode` default 只含实时工具 | Agent 按序完成一轮记取；default List 无扫盘长跑 |
| 空召回 / 拒绝三态 | machine-readable：`ok-empty` / `authority-filtered` / `not-ready` | 测例覆盖；Agent 不编造记忆 |
| 写入回执 | accept/reject + reasonCodes；PG 下 `lastDecision` 不阻塞下一 tool call | explain 路径测全 |
| 扫盘移出热路径 | `memory_scan_directory` 等仅 full/discover；文案指向 `ms scan` | default 不出现；discover 可找到 |
| skill_candidate 只读 | discover/full 可列出；不可 run | 可观测、不可执行 |

### 5.2 P2-B — CLI（目录分析 → 治理入库）

| 改什么 | 怎么做 | 验收 |
|--------|--------|------|
| `ms scan` 主入口产品化 | guide：边界、ignore、dry-run、apply、authority 要求 | 一页文档可跟着跑通 |
| 可审计分析报告 | 文件计数、类型分布、拟写入 semanticType 分布、拒绝预览、指纹/去重摘要 | dry-run 输出稳定可测 |
| 入库必经治理 | apply 走 admission；写收据；禁止 bypass | 无 authority 失败可解释 |
| 与 evolve 边界 | 对照表：`ms scan`=通用目录摄入；`ms evolve scan --source-id`=host 进化批次 | 文档与 `--help` 一致 |
| 文件类型路线 | P2 强化 md/mdx + 报告 UX；扩代码/结构化放到下一阶段且不降治理 | L 路线图写清即可 |

### 5.3 P2-C — Hooks（被动会话更新）

| 改什么 | 怎么做 | 验收 |
|--------|--------|------|
| 触发→动作可测 | `session_start`→召回；`pre_compact` / `task_complete` / `session_end`→typed capture | 单测 + 至少一端宿主真被动捕获 |
| 会话载荷合同 | 最小字段：runId/sessionId/projectId/user、事件类型、可选 transcript 摘要；缺字段 skip 并记 reason | 合同进 guide；缺字段不瞎写 |
| 被动与幂等 | 不弹窗、不阻断回合；session+hash 去重，避免与 MCP 双写冲突 | 失败进日志/收据 |
| 宿主矩阵 | OpenClaw / Codex / Claude：真实事件 vs Skill-only 一表；flush-plan 保持 null | 矩阵表可维护 |

### 5.4 横切支撑（与 A/B/C 并行）

| 项 | 验收 |
|----|------|
| `ms authority init` + doctor | 三入口第一次写入前可脚手架 |
| migrate/doctor 含 v39 收据 | 旧库升级可感知 |
| 5type 质量评测子集 | 混淆/错标拒绝/覆盖率报告可复现 |
| Skill SAFE / 密钥门 | 约束 MCP 与 Hooks 写入 |

### 5.5 建议节奏

- **同一窗口并行** P2-A / P2-B / P2-C；authority/doctor 尽早，避免三线卡冷启动。  
- 随后加深：CLI 扩文件类型、Hooks 宿主对齐、MCP 回合内成本可读、evolution/jobs 只读进 discover；可选聚焦 CI（工程卫生，非发布渠道）。

---

## 6. 不做清单

1. 不重写 RuntimeHost / Write Kernel；不改 D-01~D-23 算法规格。  
2. 不做 Mem0 式默认静默 ADD；不做「LLM consolidation 失败仍 insert」当默认。  
3. 不做 Letta MemFS。  
4. **不接入** Graphiti / Zep / Mem0 server / Cognee-as-backend 等第三方记忆桥。  
5. **暂不** npm publish、正式 release tag、`main` 快进、registry Skill 分发。  
6. 不把目录全量扫描做成 MCP default 主路径。  
7. 不让 Hooks 主动打扰用户或发明 flush-plan。  
8. 不让 CLI 绕过 admission / authority 灌库。  
9. 不删除已有 MCP 工具实现；只按 mode 隐藏；长跑/扫盘不进 default。  
10. 不重新设计 5type 枚举；不自动生成可执行 Skill。  
11. 不把 LanceDB 宣称为与 Postgres 对等的治理后端。

---

## 参考

- 仓内：`docs/guides/local-agent-memory-quickstart.md`、`agent-session-hooks.md`、`.agents/skills/mengshu/SKILL.md`  
- 代码：`packages/mcp/src/tool-mode.ts`、`tools.ts`；`packages/api/src/cli/ms.ts`、`evolve.ts`；`packages/core/src/runtime/agent-session-hooks.ts`；`packages/core/src/context/five-slot-continuity.ts`  
- 调研底稿：`/workspace/memory-products-comparison.md`、`/workspace/mengshu-analysis.md`
