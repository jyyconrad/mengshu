# mengshu 下一阶段升级方案（P2 / P3）

> **状态**：DRAFT → **LOCKED for planning（2026-10-11，Asia/Manila）** — 只定路线与验收，不在本文件提交中改运行时代码。  
> **修订**：同日用户硬约束锁定（N9–N14）——不以 npm/第三方记忆桥为下一阶段主线；**优先做强 MCP / CLI / Hooks**。  
> **基线**：分支 `1.0.7` @ `d3151d1`（包版本 `@mengshu/core` 1.0.7；运行时能力含至 `9cd41bd` P1）  
> **前序方案**：[`upgrade-local-agent-memory-5type-20261011.md`](./upgrade-local-agent-memory-5type-20261011.md)（P0+P1 已完成）  
> **依据**：`/workspace/mengshu-analysis.md`、`/workspace/memory-products-comparison.md`、统一设计 D-01~D-23、竞品深核、用户 2026-10-11 六条产品锁  
> **产品定位（锁定）**：编码 / 工作 Agent 的 **本地治理记忆中间件** — 不是 Mem0 式最大生态记忆 API，也不是 Letta 式 Agent 本体（MemFS）。

---

## 0. 决策摘要（给实现者的硬约束）

### 0.1 继承约束（仍有效）

| ID | 决策 | 理由 |
|----|------|------|
| N1 | 下一阶段仍补 **输面与连续性证明**，不重写 Write Kernel / RuntimeHost / D-01~D-23 | P0+P1 已证明门面可改；算法不动是差异化护城河 |
| N4 | experience→`skill_candidate` **可观测、可解释、不可自动变可执行 Skill** | D-05 / D-17；禁止自动可执行 skill |
| N5 | 竞品可抄「门面与证明」，不可抄「静默 ADD / LLM 自动 consolidation 当默认裁决」 | 与 fail-closed 冲突 |
| N6 | 5type 下一阶段重心 = **抽取质量闸门 + 空槽/覆盖率评测**，不是改枚举 | `ensureFiveSlots` 已解决 schema 连续 |
| N7 | OpenClaw `flush-plan` 继续 **null 直到上游合同稳定**；Codex/Claude 用 Skill + 宿主真实钩子映射 | 不发明 API |

### 0.2 用户硬锁（2026-10-11，覆盖前序 N2 / N3 / N8）

| ID | 决策 | 理由 / 实现含义 |
|----|------|-----------------|
| **N9** | **暂时不做 npm 及任何其他发布渠道**（含 registry publish、`npx skills add` 依赖 registry、对外 release 仪式） | 用户明确：暂不发渠道；安装继续用源码树 / 本地软链 / 仓内 tgz（若已有） |
| **N10** | **不接入 Graphiti 或任何第三方记忆中间件桥**（含 Zep、Mem0 server、Cognee 当后端等） | 用户明确；时序/图继续用自有能力；竞品调研仅作门面参考，不落地桥代码 |
| **N11** | **下一阶段优先做强：MCP 工具、CLI、Hooks**（相对 CI 发布故事、Skill 生态分发、插件包装） | 三入口 = 产品主战场；其它项让路或降为支撑 |
| **N12** | **MCP = Agent 实时调用为主** | 热路径：`context_fast` / `recall` / `observe` / `save` / `explain` / discover；短 default List；低延迟、可解释拒绝；不做「MCP 批处理扫盘」当主叙事 |
| **N13** | **CLI = 全面分析目录，把目录信息治理进 mengshu 记忆库为主** | 热路径：`ms scan`、evolve directory scan、目录→5type/admission 治理链路；批处理、可审计、可 dry-run；Agent 实时回合不替代 CLI 扫盘 |
| **N14** | **Hooks = 被动触发；输入 Agent 会话等信息，更新 mengshu 记忆** | 热路径：session_start 召回、pre_compact / task_complete / session_end 捕获；宿主事件进治理写入；不主动弹窗、不发明 flush-plan |

**废止 / 改写的旧决策**

| 旧 ID | 原决策 | 现状态 |
|-------|--------|--------|
| N2 | 发布成熟度（CI + 可安装包 + tag）进 P2 必做 | **废止为 P2 必做**。CI 仅作可选工程支撑（P3 或并行低优）；**npm / tag / main 快进整体延期至用户另嘱** |
| N3 | Graphiti 只做可选异步桥 | **废止**。改为 N10：不做第三方记忆桥 |
| N8 | 可 push 1.0.7；发 npm/tag/main 另嘱 | **收紧为 N9**：连「发布仪式排期」都不再进 P2/P3 主表；另嘱前不出现在退出标准里 |

---

## 0.3 三入口职责分工（实现者必读）

```
┌─────────────┐     实时回合（低延迟）      ┌──────────────────┐
│ Coding/Work │ ── MCP tools ─────────────► │ mengshu memory   │
│ Agent       │     context / recall /      │ (authority →     │
│             │     observe / save / explain│  admission)      │
└──────┬──────┘                             └────────▲─────────┘
       │ 被动宿主事件（session / compact）            │
       └──────── Hooks ──────────────────────────────┘
                                                     ▲
┌─────────────┐     批处理扫盘 + 治理                 │
│ Operator /  │ ── CLI (`ms scan`, evolve…) ─────────┘
│ 本地脚本    │     目录 → 解析 → 校验 → 入库
└─────────────┘
```

| 入口 | 谁调用 | 输入 | 输出 / 副作用 | 不做 |
|------|--------|------|---------------|------|
| **MCP** | Agent 回合内实时 | 查询、候选记忆、memoryId、explain 请求 | 召回上下文、写入回执、拒绝原因 | 大批量目录枚举；长跑 evolve |
| **CLI** | 人 / 脚本 / CI 作业 | **目录路径**、sourceId、ignore、dry-run/apply | 扫描统计、治理提案、记忆入库 | 替代 Agent 实时召回；无 authority 的静默灌库 |
| **Hooks** | 宿主被动回调 | **会话/轮次/compact 事件载荷** | 触发 recall 或 typed capture→admission | 主动打扰用户；伪造宿主 API；CLI 级扫盘 |

---

## 1. 现状盘点（1.0.7 已有 / 仍缺）

### 1.1 已有（P0 + P1，可核验）

| 能力 | 锚点 | 对「便捷 / 强大 / 5type」的贡献 |
|------|------|--------------------------------|
| 用法 Skill | `.agents/skills/mengshu/SKILL.md`（`name: mengshu`） | 便捷：Agent 有默认心智；5type 写入/召回合同 |
| MCP 工具门面 | `MENGSHU_MCP_TOOL_MODE=default\|minimal\|full` + `memory_tools_discover` | 便捷：降选错工具率；对齐 N12 短 List |
| 五槽连续 | `ensureFiveSlots()`；空槽 `empty_slot:` | 5type：schema 可持续依赖 |
| 治理可演示 | `memory_explain`（stored why / dry-run / `lastDecision`） | 强大：可解释 |
| 一键 Postgres | `docker-compose.postgres.yml` + `local-agent-memory-quickstart.md` | 便捷：默认能跑 |
| 会话钩子推荐表 | `agent-session-hooks.ts` + guide；OpenClaw `before_prompt_build` / `agent_end` | Hooks 统一语言（N14 起点） |
| Admission 收据 | schema **v39** `mengshu_admission_decision_receipts` | 强大：last-decision 可查 |
| README 对照 | 「升级前后对照（P0+P1）」 | 对外证明输面补齐 |
| CLI 扫盘雏形 | `ms scan <directory>`（Markdown/.mdx → ingestion）；`ms evolve scan --source-id`（host-bound） | N13 已有地基，缺「全面分析 → 治理可见」产品化 |

### 1.2 仍缺（按 N11 三入口重排优先级）

| 缺口 | 代码/事实 | 卡住什么 | P2 优先级 |
|------|-----------|----------|-----------|
| **MCP 实时调用体验** | default 门面已有；空召回诊断弱；无清晰「回合内工具序」SLO；scan_directory 若暴露易诱 Agent 扫盘 | N12：Agent 不敢用 / 用错 | **P2 最高** |
| **CLI 目录全面治理** | `ms scan` 偏 Markdown；统计偏 pipeline 内部；与 5type/admission 结果对 Agent **不可见对齐**；缺少「分析报告→提案→入库」一条龙 UX | N13：目录知识进不去或进去不可审计 | **P2 最高** |
| **Hooks 被动会话更新** | 推荐表有；OpenClaw 部分真接；Codex/Claude 靠 Skill；flush-plan=null；会话载荷→记忆的契约文档碎 | N14：compact/结束丢结论 | **P2 最高** |
| Authority 冷启动 | 手写 `authority.json` | 三入口第一次成功都疼 | P2 高（支撑） |
| Migrate / doctor 可见 | v39 收据对旧库静默 | explain/hooks 收据「像坏了」 | P2 高（支撑） |
| 5type 质量闸 | 无日常混淆/覆盖评测 | 五键恒在 ≠ 语义正确 | P2 中高 |
| skill_candidate 可见 | 聚合器在，Agent 看不见 | experience 槽价值低估 | P2 中（MCP discover） |
| Skill triage 文案 | SAFE 门未强化 | 密钥误入库 | P2 中（支撑 MCP/Hooks） |
| CI / 发布故事 | 无 `.github`；npm 404 | **按 N9 不再作为 P2 退出标准** | P3 可选 / 另嘱 |
| Graphiti 等桥 | 无 | **按 N10 不做** | **砍掉** |
| 插件包装对齐 | Claude 仅 sources | 次于三入口 | P3 |

### 1.3 一句判断

P0+P1 把门面立起来了。按用户锁，下一阶段 **不是**「可安装产品 + 图桥」，而是把 **三条本地入口做成清晰分工**：Agent 用 MCP 实时记/取；人用 CLI 把目录治理进库；宿主用 Hooks 被动把会话沉淀进库——三者都走同一套 authority / 5type / admission。

---

## 2. 深度调研结论（仍有效，桥相关改为「只参考不落地」）

调研日期：2026-10-11。一手入口见文末 Sources。

### 2.1 可抄（贴合本地治理中间件；**不**含第三方桥落地）

| 来源 | 机制 | 对 mengshu 的含义 |
|------|------|-------------------|
| **FactMem** | 短工具面；会话初 briefing；supersede；consolidate 显式 | MCP：开场 context；纠正可解释；**不**默认 SQLite |
| **Cognee MCP** | tool mode；空结果状态行 | MCP：加强空召回诊断（N12） |
| **Mem0 Skills** | SAFE 门、自包含事实 | Skill/Hooks 写入纪律；**不**做 registry 分发（N9） |
| **CrewAI Memory** | `match_reasons` | 拒绝/命中理由对 Agent 可读 |
| **编码 Agent 钩子模式** | SessionStart→召回；Stop/PreCompact→抽取 | **直接支撑 N14**；填真实宿主事件 |
| **目录摄入邻居（FactMem 目录所有权、各类 repo ingest）** | 目录级边界 + 显式 ingest | **支撑 N13**：CLI 扫盘要有边界、指纹、dry-run |

### 2.2 明确不抄 / 不落地

1. Mem0 静默 ADD；CrewAI consolidation 失败默认 insert。  
2. Letta MemFS。  
3. **任何 Graphiti / Zep / Mem0-server / Cognee-as-backend 桥（N10）。**  
4. 自动可执行 Skill。  
5. 默认云端记忆。  
6. 把 default MCP 扩成扫盘/evolve 长跑工具集（违背 N12）。  
7. **npm / skills registry / 正式 tag 发布渠道（N9）。**

### 2.3 落点一句话

装进编码 Agent 时：**MCP 回合内又快又说得清；CLI 把目录知识治理进库；Hooks 把会话被动写进库**——而不是「记了更多」或「接了另一家记忆」。

---

## 3. 下一阶段目标与验收（按三入口）

### 3.1 MCP（N12：Agent 实时调用）

| # | 目标 | 验收 |
|---|------|------|
| M1 | 默认工具序稳定：开场 `context_fast` → 检索 `recall` → 写入 `observe`/`save` → 争议 `explain` | Skill + MCP 文档同序；default List 仅含实时工具 |
| M2 | 空召回 / 拒绝可区分 | `ok-empty` / `authority-filtered` / `not-ready` 等 machine-readable state；Agent 不编造记忆 |
| M3 | 写入回执回合内可用 | accept/reject + reasonCodes；PG 下 `lastDecision`；不阻塞下一 tool call |
| M4 | **禁止**把目录全量扫描当作 MCP 主路径 | `memory_scan_directory` 若保留：仅 full/discover，文档标明「请用 CLI」；default 不出现 |
| M5 | discover 可找到治理只读工具 | `memory_explain`、skill_candidate 列表（只读）等；不进 minimal |

### 3.2 CLI（N13：目录全面分析 → 治理入库）

| # | 目标 | 验收 |
|---|------|------|
| L1 | `ms scan`（或后继统一命令）成为 **目录→记忆** 主入口 | 一页 guide：边界、ignore、dry-run、apply、authority 要求 |
| L2 | 「全面分析」产出可审计 | 扫描报告：文件计数、类型分布、拟写入 semanticType 分布、拒绝预览、指纹/去重摘要 |
| L3 | 入库必经治理 | 无 bypass admission；dry-run 可看到会拒哪些；apply 写收据 |
| L4 | 与 evolve directory 边界清晰 | `ms scan` = 通用目录摄入；`ms evolve scan --source-id` = host-registered 进化批次；文档对照表 |
| L5 | 不只 Markdown 的路线图写清 | P2：强化 md/mdx + 报告 UX；P3：按需扩代码/结构化文件——**扩类型不得弱化治理** |

### 3.3 Hooks（N14：被动会话更新）

| # | 目标 | 验收 |
|---|------|------|
| H1 | 触发→动作表可测 | `session_start`→召回；`pre_compact`/`task_complete`/`session_end`→typed capture |
| H2 | 输入合同 = 会话信息 | 文档规定最小载荷：runId/sessionId/projectId/user、事件类型、可选 transcript 摘要；缺字段 fail-closed 或跳过捕获并记 reason |
| H3 | 被动：不弹窗、不阻断宿主 | 捕获失败可观测（日志/收据），不抛倒 Agent 回合 |
| H4 | 宿主矩阵 | OpenClaw / Codex / Claude：真实事件 vs Skill-only 一表；flush-plan 仍 null |
| H5 | 与 MCP 分工 | Hooks 调同一写入主链；Agent 仍可用 MCP 补写；不双写冲突（幂等/去重） |

### 3.4 横向支撑（服务三入口，非发布）

| # | 目标 | 验收 |
|---|------|------|
| S1 | `ms authority init` + doctor | 第一次 MCP/CLI/Hooks 写入前 authority 可脚手架 |
| S2 | migrate/doctor 含 v39 收据 | 旧库升级可感知 |
| S3 | 5type 质量子集评测 | 混淆率/错标拒绝/覆盖率报告；服务 M/L/H 写入质量 |
| S4 | Skill SAFE/密钥门 | 约束 MCP 与 Hooks 写入内容 |

### 3.5 明确移出本阶段退出标准

- npm publish、git release tag、`main` 快进、registry 型 Skill 分发（**N9**）  
- Graphiti / 任何第三方记忆中间件桥（**N10**）

---

## 4. P2 / P3 分项（重排）

### 4.1 P2（建议 1–2 周：三入口可用且分工清楚）

#### P2-A MCP 实时调用面打磨（N12）— **最高**

- **动机**：Agent 只愿意在回合内调短、稳、可解释的工具。  
- **改哪些路径**：`packages/mcp` tool-mode 审计；default List 仅实时工具；空召回/`memory_health` state；Skill 工具序；`memory_scan_directory` 移出 default 并文档指向 CLI；explain/lastDecision 路径测全。  
- **验收**：M1–M5。  
- **风险**：藏工具后老用户找不到 → `memory_tools_discover` + CHANGELOG。  
- **优先级**：P0 of P2。

#### P2-B CLI 目录分析与治理入库（N13）— **最高**

- **动机**：目录知识是工作记忆的大宗来源；必须批处理 + 可审计，不能靠 Agent 用 MCP 扫盘。  
- **改哪些路径**：`packages/api/src/cli/ms.ts` `scan`；ingestion 报告层；guide `docs/guides/` 新「directory-ingest」；与 `evolve scan` 对照；dry-run 展示 5type/admission 预览；apply 打收据。  
- **验收**：L1–L4（L5 路线图即可）。  
- **风险**：扫盘过宽灌垃圾 → 默认 ignore + SAFE + admission；大目录超时 → 分页/上限已有则文档化。  
- **优先级**：P0 of P2（与 P2-A 并行）。

#### P2-C Hooks 被动会话更新（N14）— **最高**

- **动机**：compact/结束是丢记忆高峰；必须被动、合同化。  
- **改哪些路径**：`agent-session-hooks.ts` + guide；OpenClaw 真事件保持；Codex/Claude 能接则接，不能则 Skill；**输入载荷 schema**（会话信息）；捕获→observe/save；失败 reason；矩阵表。  
- **验收**：H1–H5。  
- **风险**：发明 flush-plan → 禁止；双写 → 去重/idempotency key（session+hash）。  
- **优先级**：P0 of P2（与 A/B 并行）。

#### P2-D Authority 脚手架与 doctor/migrate（支撑）

- **动机**：三入口共享冷启动摩擦。  
- **改哪些路径**：`ms authority init`；doctor 含 authority + schema/v39。  
- **验收**：S1–S2。  
- **优先级**：高。

#### P2-E 5type 质量闸 + Skill SAFE（支撑）

- **动机**：入口变多后更易写错 type / 泄密钥。  
- **改哪些路径**：`tests/eval` 子集；Skill SAFE 条款。  
- **验收**：S3–S4。  
- **优先级**：中高。

#### P2-F skill_candidate 只读可见（MCP discover）

- **动机**：experience 升格可见，仍不可执行。  
- **改哪些路径**：discover/full 工具；context 槽可选折叠计数。  
- **验收**：可列出、不可 run。  
- **优先级**：中。

### 4.2 P3（随后：加深三入口，仍不发版、不接桥）

| ID | 项 | 说明 | 优先级 |
|----|----|------|--------|
| P3-1 | CLI 扩文件类型 / 更深目录分析 | 在治理不降级前提下扩代码/结构化；仍走 scan 主入口 | 中 |
| P3-2 | Hooks 宿主对齐加深 | 更多真实事件；仍 null flush-plan | 中 |
| P3-3 | MCP 实时 SLO / 成本可读 | 回合内延迟与 token 提示（可选） | 中低 |
| P3-4 | evolution / jobs 状态只读 | discover 可见；不进 MCP default | 中低 |
| P3-5 | 插件包装对齐 | 次于入口 | 中低 |
| P3-6 | 可选聚焦 CI | **仅工程卫生**；非发布渠道；无 npm/tag 要求 | 低 |
| ~~P3-Graphiti~~ | ~~异步桥~~ | **按 N10 删除** | — |
| ~~P3-release~~ | ~~npm / tag / main~~ | **按 N9 整段延期至用户另嘱**；本方案不排期 | — |

### 4.3 已砍 / 延期对照表

| 原方案项 | 现处置 |
|----------|--------|
| P2-1 发布成熟度（CI+pack+npm 叙事） | **不再作为 P2 必做**；CI→P3-6 可选 |
| P3-1 Graphiti 异步桥 | **删除**（N10） |
| P3-5 main/npm/tag 仪式 | **延期至另嘱**（N9）；退出标准移除 |
| C2「不 clone 也能装包」 | **改写**：源码软链 / 本地路径安装即可；不承诺 registry |
| Pw4 可选 Graphiti 桥 | **删除** |

---

## 5. 明确不做清单

1. 不重写 RuntimeHost / Write Kernel / 不改 D-01~D-23 算法规格。  
2. 不做 Mem0 式默认静默 ADD；不做「LLM consolidation 失败仍 insert」当默认。  
3. 不做 Letta MemFS。  
4. **不接入 Graphiti / Zep / Mem0 server / Cognee-as-backend 或其它第三方记忆中间件桥（N10）。**  
5. **暂不 npm publish、不打正式 release tag、不快进 main、不做 registry Skill 分发（N9）。**  
6. 不把目录全量扫描做成 MCP default 主路径（N12）。  
7. 不让 Hooks 主动打扰用户或发明 flush-plan（N14）。  
8. 不让 CLI 绕过 admission / authority 灌库（N13）。  
9. 不删除 MCP 工具实现；只藏进 mode；长跑/扫盘工具不进 default。  
10. 不重新设计 5type 枚举；不自动生成可执行 Skill。  
11. 不把 LanceDB 宣称为与 Postgres 对等的治理后端。

---

## 6. 建议排期（1–2 周粒度）

| 窗口 | 主题 | 项 | 退出标准 |
|------|------|----|----------|
| **W1** | 三入口分工落地 | P2-A MCP 实时面；P2-B CLI 目录治理 UX；P2-C Hooks 载荷+矩阵；P2-D authority/doctor | Agent 按工具序完成一轮记取；`ms scan` dry-run→apply 可审计；至少一端 Hooks 真被动捕获可测 |
| **W2** | 质量与可见 | P2-E 5type eval + SAFE；P2-F skill_candidate 只读；空召回三态收口 | 评测报告可复现；密钥门进 Skill；experience 升格可列出 |
| **W3+（P3）** | 加深入口 | P3-1…P3-5；可选 P3-6 CI | 无 npm/桥；入口文档与行为一致 |

并行约束：**A/B/C 同周开干**；authority/doctor 尽早以免三线都卡冷启动。不安排 Graphiti，不安排发布窗口。

---

## 7. Sources

### 7.1 仓内真源

- `/workspace/mengshu` @ `1.0.7`  
- `/workspace/mengshu-analysis.md`、`/workspace/memory-products-comparison.md`  
- `docs/plans/upgrade-local-agent-memory-5type-20261011.md`  
- `docs/design/memory-system-unified-design.md`、`docs/api/cli-commands.md`  
- `docs/guides/agent-session-hooks.md`、`local-agent-memory-quickstart.md`、`continuous-memory-evolution.md`  
- `.agents/skills/mengshu/SKILL.md`  
- `packages/api/src/cli/ms.ts`（`scan`）、`packages/api/src/cli/evolve.ts`  
- `packages/core/src/runtime/agent-session-hooks.ts`、`packages/mcp/src/tool-mode.ts`

### 7.2 竞品一手（门面参考；桥不落地）

- FactMem、Cognee MCP modes、Mem0 skills/SAFE、CrewAI match_reasons、编码 Agent Session/PreCompact 模式（链接同前一版方案；**Graphiti 文档仅作「为何不桥」对照，不进实现**）

---

## 8. 与前序方案的关系

| 阶段 | 文件 | 状态 |
|------|------|------|
| P0+P1 | `upgrade-local-agent-memory-5type-20261011.md` | 已完成并合入 `1.0.7`；见该文「用户硬锁追记」 |
| **P2/P3** | **本文件** | **按 N9–N14 重锁**；实现另开提交 |
| 发布 / 第三方桥 | 用户另嘱前 **不排期** | N9 / N10 |

**一句话路线**：先把 **MCP 实时、CLI 目录治理、Hooks 会话被动更新** 三条入口做利、做清、做可测；5type 与 authority 继续当横切质量闸；**不发 npm、不接 Graphiti 类中间件**。
