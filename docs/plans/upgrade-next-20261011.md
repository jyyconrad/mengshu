# mengshu 下一阶段升级方案（P2 / P3）

> **状态**：DRAFT → **LOCKED for planning（2026-10-11，Asia/Manila）** — 只定路线与验收，不在本文件提交中改运行时代码。  
> **基线**：分支 `1.0.7` @ `9cd41bd`（包版本 `@mengshu/core` 1.0.7）  
> **前序方案**：[`upgrade-local-agent-memory-5type-20261011.md`](./upgrade-local-agent-memory-5type-20261011.md)（P0+P1 已完成）  
> **依据**：`/workspace/mengshu-analysis.md`、`/workspace/memory-products-comparison.md`、统一设计 D-01~D-23、本轮竞品深核（FactMem / Graphiti·Zep / Mem0 skills / CrewAI consolidation / Cognee MCP modes / Letta MemFS / 2026 coding-agent MCP+Skill 模式）  
> **产品定位（锁定）**：编码 / 工作 Agent 的 **本地治理记忆中间件** — 不是 Mem0 式最大生态记忆 API，也不是 Letta 式 Agent 本体（MemFS）。

---

## 0. 决策摘要（给实现者的硬约束）

| ID | 决策 | 理由 |
|----|------|------|
| N1 | 下一阶段仍补 **输面与连续性证明**，不重写 Write Kernel / RuntimeHost / D-01~D-23 | P0+P1 已证明门面可改；算法不动是差异化护城河 |
| N2 | **发布成熟度**（CI + 可安装包 + tag）进入 P2 必做，否则「本地便捷」无法对第三方复现 | npm `@mengshu/core` 仍 404；无 `.github` CI；无 `v1.0.7` tag |
| N3 | Graphiti **只做可选异步桥**，永不进热路径、不替换 admission | 对齐 opencode-graphiti：热路径本地/缓存，图库后台；Graphiti MCP 官方标注 experimental |
| N4 | experience→`skill_candidate` **可观测、可解释、不可自动变可执行 Skill** | D-05 / D-17；设计 P4 风险表明确禁止自动可执行 skill |
| N5 | 竞品可抄「门面与证明」，不可抄「静默 ADD / LLM 自动 consolidation 当默认裁决」 | Mem0 ADD、CrewAI consolidation 失败默认 insert 与 mengshu fail-closed 冲突 |
| N6 | 5type 下一阶段重心 = **抽取质量闸门 + 空槽/覆盖率评测**，不是改枚举 | `ensureFiveSlots` 已解决 schema 连续；剩语义质量与 Agent 是否真用上 |
| N7 | OpenClaw `flush-plan` 继续 **null 直到上游合同稳定**；Codex/Claude 用 Skill + 宿主真实钩子映射 | 已故意返回 null，避免伪造 API |
| N8 | 本方案可在用户授权下 push 到 `origin/1.0.7`；**发 npm / 打 tag / 快进 main 仍须另嘱** | 与前序 L8 一致；本文件本身可作为排期真源 |

---

## 1. 现状盘点（1.0.7 已有 / 仍缺）

### 1.1 已有（P0 + P1，可核验）

| 能力 | 锚点 | 对「便捷 / 强大 / 5type」的贡献 |
|------|------|--------------------------------|
| 用法 Skill | `.agents/skills/mengshu/SKILL.md`（`name: mengshu`） | 便捷：Agent 有默认心智；5type 写入/召回合同 |
| MCP 工具门面 | `MENGSHU_MCP_TOOL_MODE=default\|minimal\|full` + `memory_tools_discover` | 便捷：降选错工具率 |
| 五槽连续 | `ensureFiveSlots()`；空槽 `empty_slot:` | 5type：schema 可持续依赖 |
| 治理可演示 | `memory_explain`（stored why / dry-run / `lastDecision`） | 强大：可解释 |
| 一键 Postgres | `docker-compose.postgres.yml` + `local-agent-memory-quickstart.md` | 便捷：默认能跑 |
| 会话钩子推荐表 | `agent-session-hooks.ts` + guide；OpenClaw `before_prompt_build` / `agent_end` | 便捷：触发时机统一语言 |
| Admission 收据 | schema **v39** `mengshu_admission_decision_receipts`；write-kernel best-effort | 强大：last-decision 可查 |
| README 对照 | 「升级前后对照（P0+P1）」 | 对外证明输面补齐 |

### 1.2 仍缺（相对定位与竞品门面）

| 缺口 | 代码/事实 | 为什么卡住「本地治理好用且效果强」 |
|------|-----------|-------------------------------------|
| **发布故事断裂** | registry `@mengshu/core` **404**；无 `.github/`；无 `v*` tag；仓内有 tracked `mengshu-core-1.0.7.tgz` | README/`npm i -g` 对路人不可复现；Skill 软链只能对源码树 |
| **Authority 上手摩擦** | 需手写 `authority.json` + `MENGSHU_AUTHORITY_FILE`；`ms init` 故意不扩 authority | fail-closed 正确，但「第一次成功写入」路径过长，Agent 易放弃 |
| **Migrate UX 静默** | 连接时 migrate 到 `CURRENT_SCHEMA_VERSION`（含 v39）；quickstart 只口头提醒 | 旧库用户不知道收据表是否已建；`ms doctor` 未把「schema 当前/目标/收据可用」做成一等信号 |
| **5type 质量未设门禁** | type-extractor / validator 已有；eval 多轨存在，但无「五槽覆盖率 / 类型混淆率」日常闸 | 五键恒在 ≠ 语义正确；空槽可能是抽取错 type，而非真无记忆 |
| **Skill 分发未产品化** | 仅软链；Codex 有 `mengshu-memory` 包装；无 Mem0 式 `npx skills add` / skill graph | 安装步骤仍像开发者文档，不像可复制 Agent 资产 |
| **E3 experience→skill** | `SkillCandidateAggregator` 已实现；设计写明 skill_candidate **如何注入 experience 槽未定**；首期不产可执行 skill | 「经验可复用」对 Agent 几乎不可见 → 5type 的 experience 槽价值被低估 |
| **钩子深度** | OpenClaw flush-plan = `null`；Codex/Claude 无原生 PreCompact 时靠 Skill 自觉 | compact 前丢耐久结论的风险仍在；相对 Claude Code SessionStart/Stop/PreCompact 模式落后半拍 |
| **时序/图能力外置** | 自有 temporal / graph；无 Graphiti 桥 | 长线「事实失效」叙事弱于 Graphiti；但主链更强——桥应是增强而非替代 |
| **插件包装碎** | `plugins/{openclaw,codex,claude-code}` 能力不对齐（Claude 仅 sources） | 「一个 Skill + 一个 MCP」心智未落到三宿主同等体验 |

### 1.3 一句判断

P0+P1 已把 **门面与证明** 从「有内核无入口」拉到「本地可演示」。下一阶段若仍堆算法，会继续输在 **安装复现、authority 第一次成功、5type 质量可测、experience 升格可见**。赢面不变：fail-closed + 5type 协议 + 多 Runtime；输面从「完全没有门面」变成「门面还不够像可安装产品」。

---

## 2. 深度调研结论（竞品可抄 vs 不该抄）

调研日期：2026-10-11。一手入口见文末 Sources。

### 2.1 可抄（贴合本地治理中间件）

| 来源 | 机制 | 对 mengshu 的含义 |
|------|------|-------------------|
| **FactMem** | 目录级所有权；会话初 `get_session_context` / `memory://briefing`；事实 **supersede 不物理删**；`consolidate` 显式阶段；工具面极短 | 抄「会话开场一页 briefing」与「纠正= supersede 语义可解释」；**不**改成默认 SQLite 推荐（治理 capability 仍绑 PG） |
| **Cognee MCP** | `remember/recall/forget` 三件套；`COGNEE_MCP_TOOL_MODE`；`search_tools` + `call_tool` NL 发现；空结果带 `indexing` / `build_failed` 状态行 | 已抄 tool mode；下一阶段可加强 **空召回诊断**（索引中/迁移中/authority 拒）与可选 NL discover |
| **Mem0 Skills** | Skill graph：参考 skill 常驻 + pipeline skill 按需；`npx skills add`；OpenClaw `memory-triage` 的 **SAFE 门**（密钥绝不入库） | 抄 **分发与 triage 纪律**（尤其密钥门、自包含事实）；**不**抄默认 LLM 静默 ADD |
| **CrewAI Memory** | `match_reasons`；consolidation 有 keep/update/delete/insert_new；batch 向量去重无 LLM | 抄「理由对 Agent 可读」；consolidation **只能作为进化作业建议**，失败不得默认 insert 绕过 admission |
| **Graphiti + opencode-graphiti** | MCP `add_memory` / `search_*`；**热路径不调图**，后台 drain；drift 触发异步刷新 | 抄 **异步桥架构**；不把 Graphiti 工具塞进 default MCP List |
| **Letta（仅时序灵感）** | sleeptime / dreaming 后台整理；hooks 可挡工具 | 抄「后台整理时机」对应 continuous evolution / skill aggregation 窗口；**不**做 MemFS |
| **2026 coding-agent 模式** | SessionStart 召回 → 回合检索 → Stop/PreCompact 抽取 → SessionEnd 巩固；插件可捆 MCP+hooks+Skills | 与 mengshu 钩子表同构；下一阶段把 Codex/Claude **能接到的真实事件**填满，缺事件的继续 Skill 合同 |

### 2.2 不该抄（会毁掉定位）

1. **Mem0 / 多数向量记忆的默认静默 ADD** — 与「模型不可单独裁决」冲突。  
2. **CrewAI consolidation 失败默认 insert** — 与 fail-closed 冲突；最多作 governed proposal。  
3. **Letta「记忆=Agent 文件系统」** — 赛道变成 Agent 本体，中间件价值消失。  
4. **把 Graphiti 当主存储** — 丢掉 Postgres 事务治理 / authority / 五槽消费协议。  
5. **自动把 experience 写成可执行 Skill 并暴露执行入口** — 设计明确 high_risk；只允许 `skill_candidate`。  
6. **为追生态而默认云端记忆** — 本地优先是卖点。  
7. **再扩一长串 default MCP 工具** — Cognee/FactMem 证明短 List 才是 Agent 友好。

### 2.3 相对邻居的落点（不变）

- **最近开源邻居**：FactMem（本地 MCP + 固化/超写）、Graphiti（时序图）、CrewAI Memory（框架内 consolidation）。  
- **生态标杆**：Mem0（Skill/分发/心智占有率）。  
- **mengshu 该赢的一句话**：同样装进编码 Agent 时，**被拒绝也说得清、五槽协议稳、authority fail-closed**，而不是「记了更多」。

---

## 3. 下一阶段目标与验收

### 3.1 便捷

| # | 目标 | 验收 |
|---|------|------|
| C1 | 陌生机器 15 分钟内：compose → setup → **authority 脚手架** → MCP default → Skill 安装 → 一次成功 `context_fast` + 一次成功 typed write | quickstart 更新；`ms authority init`（或等价）生成 0600 模板；doctor 绿 |
| C2 | 不依赖「先 clone 再软链」也能装 Skill / 包 | 至少一种：发布 npm **或** 文档化 `npx`/`skills add` 从 git 安装；CI 保证 main/1.0.7 可 build+聚焦测 |
| C3 | 旧库升级可感知 | `ms doctor`（或 `ms migrate status`）显示 schema 当前/目标；v39 收据表存在性；缺则一键 migrate 指引 |
| C4 | 三宿主安装路径表对齐 | OpenClaw / Codex / Claude Code：MCP + Skill（+ 已有 hook）各一行；缺能力处显式标「Skill-only」 |

### 3.2 强大

| # | 目标 | 验收 |
|---|------|------|
| Pw1 | 治理证明可复现 | README/quickstart 有「拒绝→explain→改写→通过」最短剧本；收据在 PG migrate 后可 `lastDecision` |
| Pw2 | 空召回可诊断 | `memory_recall` / `context_fast` 在「无命中 / 被 authority 过滤 / schema 未就绪」时返回可区分 reason（不编造记忆） |
| Pw3 | experience 升格对 Agent 可见 | MCP（full 或 discover）可列出/解释 `skill_candidate`；**不**提供执行入口；experience 槽可链到候选摘要（折叠） |
| Pw4 | 可选 Graphiti 桥（异步） | feature flag；写入主链不变；桥故障不影响 admission |

### 3.3 5type 持续发挥作用

| # | 目标 | 验收 |
|---|------|------|
| T1 | 五键恒在（已有）保持回归闸 | 现有 continuity 测进 CI |
| T2 | **类型质量闸** | 新增/接入 eval：type 混淆率、强制错标拒绝率、五槽非空覆盖率（按任务 fixture）；阈值先标记 unvalidated 经验值 |
| T3 | Skill triage 强化 | Skill 增加 SAFE/密钥门 +「自包含事实」条款（对齐 Mem0 triage，语气本地治理） |
| T4 | 空槽原因可运营 | 聚合 `empty_slot:*` 分布（至少脚本或 doctor 摘要）；区分「真无」vs「loadout 排除」vs「全被过滤」 |

---

## 4. P2 / P3 分项

### 4.1 P2（建议 1–2 周内做完的「产品可安装 + 5type 可测」）

#### P2-1 发布成熟度（CI + pack 验证；tag/npm 另嘱执行）

- **动机**：对比简报与分析均指出「有 tgz、无 registry、无 CI」是成熟度最大污点；便捷目标 C2 阻塞点。  
- **改哪些路径**：新增 `.github/workflows/ci.yml`（`npm ci` → `npm run build` → 聚焦 vitest 矩阵：continuity / tool-mode / explain / admission-receipt / session-hooks / schema v39）；可选 `npm pack` 冒烟；文档写清「未发布时用源码 / 本地 tgz」。  
- **验收**：PR/push 到 `1.0.7` 有绿勾；workflow 不依赖外部 Postgres 密钥（用 compose service 或跳过 live）。  
- **风险**：全量 480 测过慢/flaky（已知 authority 竞态）→ **先聚焦闸，全量 nightly**。  
- **优先级**：P0 of P2（最高）。

#### P2-2 Authority 脚手架与第一次成功路径

- **动机**：FactMem「一个目录即安装」、Mem0 `mem0 init --agent` 都把身份门槛压到一条命令；mengshu 的 fail-closed 正确但冷启动残酷。  
- **改哪些路径**：`packages/api/src/cli/` 增加 `ms authority init`（模板写入 `~/.mengshu/authority.json`、chmod 0600、打印 export）；`ms doctor` 增加 authority 文件存在/权限/必填字段；quickstart §2 改用该命令；Skill fail-closed 表链到命令。  
- **验收**：新用户不手写 JSON 也能过 doctor；MCP 写入不再因「忘了文件」静默失败而不知所措。  
- **风险**：脚手架过宽 allow → 默认 **最小本地 allow**（当前 user + 当前 projectId 提示），文档强调审查。  
- **优先级**：高。

#### P2-3 Migrate / schema 可见性（含 v39 收据）

- **动机**：收据落库对未 migrate 的库等于不存在；用户无法区分「没拒绝」与「没表」。  
- **改哪些路径**：`ms doctor` / `ms migrate status` 输出 `currentVersion` / `targetVersion` / `admissionReceipts: ready|missing|lancedb-ephemeral`；quickstart 增加「升级后先 doctor」；可选 MCP `memory_health` 字段对齐。  
- **验收**：从 schema<39 的夹具升到 39 后 doctor 显示收据 ready；LanceDB 明确 ephemeral。  
- **风险**：暴露内部版本号 → 可以，但文案用「记忆库结构版本」而非吓阻用户。  
- **优先级**：高。

#### P2-4 5type 质量评测闸（覆盖率 / 混淆 / 拒绝）

- **动机**：五键恒在只保证协议；「可持续发挥作用」要靠抽取与校验质量可回归。  
- **改哪些路径**：`tests/eval/` 增加或扩展 runner：五槽覆盖率、semanticType 金标混淆矩阵、validator 错标拒绝；CI 跑 **小 fixture 子集**；设计文档阈值保持 unvalidated 标记直到金标够大。  
- **验收**：一份 markdown/JSON 报告可本地复现；CI 对子集设 floor（例如错标拒绝不低于基线，不强行追求覆盖率拉满）。  
- **风险**：用覆盖率 KPI 逼 Agent 灌垃圾记忆 → 验收必须同时卡 **拒绝率与 SAFE 门**。  
- **优先级**：高（效果强大的核心）。

#### P2-5 Skill 分发与 triage 强化

- **动机**：Mem0 用 skill graph + `npx skills add` 占领 Agent 心智；本地治理若不做分发，Skill 只活在本仓。  
- **改哪些路径**：`.agents/skills/mengshu/SKILL.md` 增补 SAFE/密钥、自包含事实、会话 briefing 顺序；可选 `skills/mengshu-triage`（pipeline，user-invocable false 风格可参考 Mem0，但写入仍走 mengshu admission）；README/quickstart 增加 git-based skills 安装示例；Codex 包装保持指针。  
- **验收**：Skill 合同可被「只读 Skill 的 Agent」执行密钥门；安装一节可复制。  
- **风险**：triage skill 若暗示「自动 ADD」→ 文案必须写 **observe/save 仍可能被拒**。  
- **优先级**：高。

#### P2-6 experience → skill_candidate 可见性（E3 半步）

- **动机**：聚合器已在代码里，但 Agent 看不见 → experience 槽无法体现「可复用模式」。设计悬案：skill_candidate 注入形态。  
- **改哪些路径**：MCP（建议 **不进 default List**，进 discover/full）：`memory_skill_candidates_list` / 或并入 `memory_explain`；`context_fast` 的 experience 槽 **可选**折叠一行「N 个待审 skill_candidate」链接；文档与 Skill：只审阅、不执行。  
- **验收**：有 ≥5 条窗口内 experience 时，治理作业或手动触发后 Agent 能列出候选；无「run skill」工具。  
- **风险**：token 膨胀 → 默认只摘要计数+标题，详情 lookup。  
- **优先级**：中高。

#### P2-7 钩子加深（真实事件优先，不发明 flush-plan）

- **动机**：2026 编码 Agent 标配 PreCompact/Stop；mengshu 表已齐，缺宿主填充。  
- **改哪些路径**：核对 Codex/Claude Code 当前可订阅事件；有则映射到 `pre_compact`/`task_complete`；无则保持 Skill；OpenClaw **仍** `registerMemoryFlushPlan → null` 直至上游文档稳定；guide 增加「宿主能力矩阵」。  
- **验收**：矩阵表；至少一端（优先 OpenClaw 已有 + Codex 若有）测到真实回调。  
- **风险**：绑死实验 API → 继续 null 策略。  
- **优先级**：中。

#### P2-8 空召回 / 健康诊断 UX

- **动机**：Cognee 空结果区分 indexing / failed；mengshu 易被理解成「没记性」。  
- **改哪些路径**：`memory_health` / recall 响应增加 machine-readable `state`；Skill 教 Agent 如何转述。  
- **验收**：三态可测：ok-empty / filtered / not-ready。  
- **优先级**：中。

### 4.2 P3（随后 2–4 周：增强与生态，不挡安装）

#### P3-1 可选 Graphiti 异步桥

- **动机**：时序失效与混合检索是 Graphiti 强项；opencode-graphiti 证明应离热路径。  
- **改哪些路径**：`packages/core` 或 `adapters/graphiti/`；episode 投递 outbox；配置 `features.graphitiBridge`；**不**进 default MCP。  
- **验收**：开关关闭时零依赖；开启时桥故障不阻断写入主链。  
- **风险**：运维负担（Neo4j/FalkorDB）→ 默认关；文档标 experimental。  
- **优先级**：中（按用户需求上浮）。

#### P3-2 插件包装对齐（Claude Code 补齐）

- **动机**：三宿主体验不一致削弱「中间件」叙事。  
- **改哪些路径**：`plugins/claude-code/` 补 MCP 说明 / Skill 软链文档；与 Codex/OpenClaw README 同构。  
- **验收**：integration.md 三列矩阵无「空白不知怎么办」。  
- **优先级**：中。

#### P3-3 evolution / wiki 进度对 Agent 可见

- **动机**：后台作业对编码 Agent 黑盒；Cognee 有 `cognify_status`。  
- **改哪些路径**：discover 工具 `memory_jobs_status`（或复用 evolution 工具但藏在 full）；Skill 仅在用户问进度时用。  
- **验收**：运行中作业可查；不进 minimal。  
- **优先级**：中低。

#### P3-4 type-specific 候选去重阈值（等评测）

- **动机**：D-16 明确首期统一阈值；P2-4 有数据后再分档。  
- **改哪些路径**：validator/dedup 配置；金标通过后改阈值。  
- **验收**：无金标不改生产默认。  
- **优先级**：低（依赖 P2-4）。

#### P3-5 main 快进与正式 release 仪式

- **动机**：分支名/`main`/npm/tag 长期不一致损害信任。  
- **改哪些路径**：release checklist；用户授权后：tag `v1.0.7`、npm publish、`main` FF 或 PR。  
- **验收**：registry 可装；GitHub Release 笔记含 P0–P2 对照。  
- **优先级**：高 **但权限上另嘱**（本方案不擅自执行 publish）。

---

## 5. 明确不做清单

1. 不重写 RuntimeHost / Write Kernel / 不改 D-01~D-23 算法规格。  
2. 不做 Mem0 式默认静默 ADD；不做「LLM consolidation 失败仍 insert」当默认。  
3. 不做 Letta MemFS / 不把记忆做成 Agent 内嵌 git 文件树。  
4. 不删除 MCP 工具实现；不把 Graphiti/evolution 工具塞进 **default** List。  
5. 不重新设计 5type 枚举或五槽问题语义。  
6. 不自动生成 **可执行** Skill，不把 `skill_candidate` 混入 `MemoryKind`/`MemorySemanticType`。  
7. 不发明 OpenClaw flush-plan 对象字段；合同未稳定前保持 `null`。  
8. 不把 LanceDB 宣称为与 Postgres 对等的治理后端。  
9. 不在未授权时 npm publish、打正式 release tag、或强行快进 `main`。  
10. 不为追星标去实现 SuperMemory 闭源 server 行为。

---

## 6. 建议排期（1–2 周粒度）

| 窗口 | 主题 | 项 | 退出标准 |
|------|------|----|----------|
| **W1** | 可安装 + 冷启动 | P2-1 CI 聚焦闸；P2-2 authority 脚手架；P2-3 migrate/doctor；quickstart/Skill 同步 | 新机器按 quickstart 15 分钟内 doctor 绿 + 一次 typed write |
| **W2** | 5type 效果可测 + 可见升格 | P2-4 eval 子集进 CI；P2-5 Skill triage/分发文案；P2-6 skill_candidate 可见；P2-8 空召回诊断 | 评测报告可复现；experience 升格可列出；空结果三态可测 |
| **W3（P3 起）** | 钩子与宿主 | P2-7 宿主矩阵；P3-2 插件对齐 | 矩阵无盲区；真实钩子有测 |
| **W4（P3）** | 可选增强与发布仪式 | P3-1 Graphiti 桥（按需）；P3-3 jobs status；**另嘱** P3-5 tag/npm/main | 桥默认关；发布仅在用户授权后 |

并行约束：W1 的 CI 必须先于大面积改 MCP，以免回归不可见。Graphiti 与正式 npm **不要**堵 W1 冷启动。

---

## 7. Sources

### 7.1 仓内真源

- `/workspace/mengshu` @ `1.0.7` / `9cd41bd`  
- `/workspace/mengshu-analysis.md`  
- `/workspace/memory-products-comparison.md`  
- `docs/plans/upgrade-local-agent-memory-5type-20261011.md`  
- `docs/design/memory-system-unified-design.md`（D-05 / D-16 / D-17 / §8 skill_candidate / P4 风险）  
- `docs/guides/local-agent-memory-quickstart.md`、`agent-session-hooks.md`、`authority-and-project-scope.md`  
- `.agents/skills/mengshu/SKILL.md`  
- `packages/core/src/lifecycle/skill-candidate-aggregator.ts`、`admission-decision-receipt.ts`、`runtime/agent-session-hooks.ts`  
- `packages/mcp/src/tool-mode.ts`

### 7.2 竞品一手（2026-10-11 核验）

- FactMem / Facthouse：https://github.com/gordonkjlee/factmem 、https://www.npmjs.com/package/@openmem/mcp 、https://glama.ai/mcp/servers/gordonkjlee/factmem  
- Graphiti MCP：https://help.getzep.com/graphiti/getting-started/mcp-server.mdx 、https://github.com/getzep/graphiti/blob/main/mcp_server/README.md  
- 热路径/异步桥参照：https://github.com/vicary/opencode-graphiti  
- Mem0 skills：https://raw.githubusercontent.com/mem0ai/mem0/main/skills/mem0/SKILL.md 、https://github.com/mem0ai/mem0/blob/main/integrations/openclaw/skills/memory-triage/SKILL.md 、https://github.com/mem0ai/mem0  
- Mem0 OSS MCP 桥模式：https://github.com/krim404/mem0-mcp  
- CrewAI Memory / consolidation：https://docs.crewai.com/edge/en/concepts/memory 、https://github.com/crewAIInc/crewAI/blob/main/lib/crewai/src/crewai/memory/analyze.py  
- Cognee MCP tools / modes：https://docs.cognee.ai/cognee-mcp/mcp-tools 、https://github.com/topoteretes/cognee/blob/main/cognee-mcp/README.md  
- Letta MemFS / dreaming：https://docs.letta.com/concepts/memfs/ 、https://docs.letta.com/configuration/memory/  
- Coding-agent 记忆模式讨论：https://dev.to/suede/the-architecture-of-persistent-memory-for-claude-code-17d 、Claude Code plugins reference（hooks + skills + mcp 捆包）

---

## 8. 与前序方案的关系

| 阶段 | 文件 | 状态 |
|------|------|------|
| P0+P1 | `upgrade-local-agent-memory-5type-20261011.md` | 已完成并合入 `1.0.7` |
| **P2/P3** | **本文件** | 规划锁定；实现另开提交 |
| 发布 | 用户另嘱 | CI 可先合；npm/tag/main 不自动做 |

**一句话路线**：先让陌生人能装、能过 authority、能看见 migrate 与拒绝原因；再用评测钉住 5type 质量，并让 experience→skill_candidate 被 Agent 看见但不被自动执行；图桥与正式发版放在安装故事之后。
