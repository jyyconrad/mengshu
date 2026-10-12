# Wiki × 记忆：可行性与价值提升分析

> **类型**：可行性 / 价值评估（非完整实现设计）；§0.1 / §0.2 为决策落定，实现见 `wiki-md-material-and-index.md`  
> **分支基线**：`1.0.7` @ `6993b6d`（相对 `eb3f5f1` 之后）  
> **日期**：2026-10-12  
> **范围**：相对用户四点诉求，对照现有代码与本机 `~/.mengshu/wiki` 实况；不改实现、不推送。

---

## 0. 一句话结论

| 诉求 | 可行性 | 建议 |
|------|--------|------|
| ① 每次记忆写入自动生成 wiki 文档信息 | **中**（全量同步融合页=低；写时 sidecar/异步 stub=中高） | **缓做全量自动融合**；MVP 只做「可追溯 wiki 元信息」 |
| ② 配置文件可改 wiki 存储位置 | **高** | **做**（低成本、高卫生） |
| ③ 召回自动带上原始 wiki 地址（含关联地址可行性） | **高**（自身地址）；关联地址 **中** | **做自身地址**；关联 **MVP 仅 sourceIds/.sources** |
| ④ 模型凭地址读 wiki 原文 | **高**（需路径 allowlist） | **做**（MCP/CLI 只读工具） |

**投入产出最优切片**：② + ③自身地址 + ④只读工具 ≫ ①全量写时融合。  
现有离线 wiki 治理（9581 页 / 49509 来源）已证明「wiki 正本 + DB 投影」模式；缺口在**热路径未接通**，不在「再造一套 wiki」。

---

## 0.1 决策落定（2026-10-12，覆盖上文部分建议）

> 以下为产品决策；上文 §2–§5 的可行性论证仍保留作历史依据，凡与本节冲突处以本节为准。完整实现设计见 `docs/plans/wiki-md-material-and-index.md`。

| # | 决策 | 相对原评估的变化 |
|---|------|------------------|
| D1 | **不做**写时全自动「融合正本页」生成（不跑类 ingest-wiki / 不改 `pages/<slug>/page-NNN.md` 合同） | 确认原 P2「不做同步融合」；**废弃**「写时 stub pending 再批融合」作为主路径 |
| D2 | 持久化的 **memories 与 knowledge 均落盘为 `.md`**，作为本地 **wiki 素材（material）**，不是「取代 9581 融合正本」的独占模型 | **升级**原①：从「元信息/pending」改为「每条记录一份 md 素材」；覆盖 memories + knowledge |
| D3 | 素材增删改时，**自动更新多层 wiki 索引页**（一等能力） | **新增**；原评估未列为 P0 |
| D4 | `wiki_read`：**任意** `wikiRoot` 下相对路径（`.md` + 穿越拒绝 + 禁 symlink），**不限**召回命中 | 关闭原开放点#2：选「任意相对路径」 |
| D5 | **所有** memories 与 knowledge 均支持 `metadata.wikiPath`（相对 root）与 md 素材 | 关闭原开放点#3：不限 knowledge |

**仍有效的原建议**：② `wikiRoot` 配置；③ 召回回传相对 `wikiPath`（关联 v1 仅 `sourceIds`）；④ MCP/CLI 只读；不做 Graphiti / npm 发布搭车。

**被取代的表述**：

- §0 / §4「① MVP 只做可追溯元信息 / pending stub」→ 改为 **写 md 素材 + 索引维护**（仍**不是**融合页）。
- §1.3「写时再生成每记忆一页会与 wiki=融合正本冲突」→ 冲突通过 **同树双轨**化解：`pages/<slug>/page-NNN` 保留离线融合正本；`pages/<slug>/entries/` 承载热路径条目素材（见 §0.2）；语义见设计文。
- §5 开放决策 1–3 → **已关闭**（见 D1–D5）。

**推荐切片（更新后）**：`wikiRoot` + 写时落 md 素材（memories+knowledge）+ **受影响父级多层 INDEX 轻量更新** + 召回带 `wikiPath` + `wiki_read` 任意相对路径。

---

## 0.2 布局修正（2026-10-12，覆盖 §0.1 中的 `material/` 表述）

> 用户明确要求：Postgres 中的记忆/知识本由 `~/.mengshu/wiki` 构建；新写入的 md **必须落在同一 wiki 树内并与现有 INDEX / pages / 治理约定贯通**，不得另起与 `pages/` 脱节的旁路目录。

| # | 决策 | 说明 |
|---|------|------|
| D6 | **废弃**设计草案中的顶级 `material/<kind>/...` 布局 | 与现网 `pages/<slug>/page-NNN` + ingest-wiki 投影链不贯通 |
| D7 | **选定**条目素材路径：`pages/<scopeSlug>/entries/<semanticType>/<id>.md` | 同 `wikiRoot`、同 `pages/` 分类法、复用 scope-registry slug；不撞 `page-NNN` / `.sources` |
| D8 | 双轨同根：Track F = `page-NNN`（融合正本）；Track E = `entries/`（热路径 DB 镜像素材） | 根 INDEX 增 Entries 节；ingest-wiki v1 仍只吃 fused；memories 允许写 entries，不等于自动融合 |
| D9 | 多层索引挂在 **同一树**：L0 根 INDEX Entries 节 → L1 `pages/<slug>/INDEX.md` → L2 `entries/INDEX.md` → L3 `entries/<type>/INDEX.md` | 写时只刷受影响祖先 |

**被取代的表述**：§0.1 D2「`material/`（或等价前缀）」→ 改为 **`pages/<slug>/entries/`**；凡设计文旧版以 `material/` 为例的路径均以 `wiki-md-material-and-index.md` 同树版为准。

**仍有效**：D1（不做写时全自动融合）、D3（多层索引）、D4（wiki_read 任意相对路径）、D5（memories+knowledge 均支持 wikiPath）。

---

## 1. 现状能力与缺口（相对四点诉求）

### 1.1 已有（代码 / 本机事实）

| 能力 | 锚点 | 说明 |
|------|------|------|
| Wiki 正本目录 | `~/.mengshu/wiki/`（`USAGE.md`、`INDEX.md`、`pages/`、`completion.jsonl`、`scope-registry.json`、`path-map.jsonl`） | 约定：**wiki 是知识唯一正本**；`knowledge` 表是入库投影 |
| 离线治理入库 | `scripts/operator-wiki-knowledge-replace.ts`（`ingest-wiki` / `apply`） | 事务替换 knowledge；`metadata.wikiPath` = 页面路径；带 `sourceIds` |
| 正式化 / 瘦身 | `scripts/wiki-promote.ts`、`scripts/wiki-slim.ts` | 批次 A/C 工具；零 LLM；路径可 `--dest` / `--wiki` CLI 传参 |
| 维护约定 | `~/.mengshu/wiki/USAGE.md` | 新增须：融合页追加 → `completion.jsonl` → INDEX 再生 →（可选）ingest-wiki |
| 写入热路径 | `packages/core/src/service/write-kernel.ts`、`memory-service.ts#storeMemory`、`packages/api/src/agent-fast-path` | authority → validator → admission；**不写 wiki 文件** |
| 召回热路径 | `packages/mcp/src/tools.ts`（`memory_recall`）、`RecallHit`（`packages/core/src/domain/types.ts`） | 命中含 `record`（可有 `metadata`）；**MCP 展示层丢掉 wikiPath** |
| Knowledge 只读 MCP | `memory_knowledge_search` / `memory_knowledge_read`（`tools.ts` + `knowledge-resource-capability.ts`） | 按 **UUID ref + revision** 读 **库内** knowledge 正文；**不是**按文件系统 wiki 路径读 |
| 原始捕获归档 | `packages/core/src/ingest/raw-archive.ts`、`source-capture.ts` | 观察原文归档；与 wiki 正本是不同层 |
| 5type / 五槽 | `semantic-types.ts`、`five-slot-continuity.ts` | 存储维 profile/task_context/rules/experience/resource；消费五槽 |
| 硬约束（前序计划） | `docs/plans/upgrade-next-20261011.md` | 暂不 npm 发布；不接 Graphiti/第三方记忆桥；优先 MCP + CLI + Hooks |

### 1.2 缺口对照四点

| # | 用户诉求 | 现状 | 缺口 |
|---|----------|------|------|
| 1 | 每份记忆存入自动生成 wiki 文档信息 | 写入只进 DB（memories/knowledge 视 admission）；wiki 靠人工/批处理按 USAGE 维护 | **无写时 hook→wiki**；memories 侧治理明确「不动 memories」 |
| 2 | 配置改 wiki 存储位置 | 约定 `~/.mengshu/wiki`；operator 用 `--wiki`；**`config.ts` 无 wikiRoot 字段** | 缺一等公民配置键与校验 |
| 3 | 召回带原始 wiki 地址（及关联） | knowledge 行可有 `metadata.wikiPath`；`.sources` / `sourceIds` / `completion.jsonl` 可溯源 | **recall 文本/raw 格式未回传 path**；无稳定「关联页」字段 |
| 4 | 模型按地址读 wiki 原文 | 有 `memory_knowledge_read`（库）与本机文件 | **无「按 wiki 路径 allowlist 读文件」的 MCP/CLI** |

### 1.3 架构事实（避免误解）

```text
今日真实链路（知识治理侧）:
  离线融合 → ~/.mengshu/wiki/pages/*.md (+ .sources)
           → ingest-wiki → knowledge.metadata.wikiPath
           → recall 命中 knowledge 正文（展示层不露 path）

今日真实链路（Agent 热写入）:
  MCP observe/save / Hooks capture
           → WriteKernel → memories（或 candidate / evidence_only）
           → 不写 wiki；不保证有 wikiPath
```

因此：「每条记忆写入 = 自动出 wiki 页」与当前 **「wiki = 融合后的知识正本」** 产品合同有张力；直接等同会制造双真源。

---

## 2. 逐点可行性（高 / 中 / 低）

### 2.1 ① 写入自动生成 wiki 文档信息

| 项 | 内容 |
|----|------|
| **可行性** | **中**（窄化后中高；「写一条 = 融合一页」为 **低**） |
| **技术依据** | 写入口集中：`MemoryWriteKernel`、`storeMemory`、`AgentFastPathService.observeLight`；已有 raw-archive / outbox（`server/postgres-active-derivation-outbox.ts`）可挂异步副作用；wiki 页格式与 registry 已由 promote/USAGE 固化 |
| **主要风险** | (a) **双真源**：USAGE 声明 wiki 正本、DB 投影——若写时再生成「每记忆一页」，与 9581 融合页模型冲突；(b) **延迟/IO**：同步写盘拖慢 MCP；(c) **memories vs knowledge**：历史治理刻意不碰 memories；(d) **治理账本**：completion/INDEX 不同步则正本腐烂 |
| **更稳的解读** | 「wiki 文档信息」= 可治理元数据（相对路径、scope slug、semanticType、sourceId、生成状态），**不等于**当场跑完整融合管线 |

### 2.2 ② 配置文件修改 wiki 存储位置

| 项 | 内容 |
|----|------|
| **可行性** | **高** |
| **技术依据** | `config.ts` 已有 `dbPath`、路径解析与校验模式；operator 已接受 `--wiki`；本机默认 `~/.mengshu/wiki` 可作 fallback |
| **主要风险** | 改根后旧 `metadata.wikiPath` 绝对路径失效；需约定存 **相对 wikiRoot 的路径** 或迁移回写（已有 promotion `path-map.jsonl` 先例） |
| **备注** | 与「是否自动写 wiki」解耦，可单独先做 |

### 2.3 ③ 召回带原始 wiki 地址（含关联）

| 项 | 内容 |
|----|------|
| **自身地址可行性** | **高** |
| **关联地址可行性** | **中**（source 级高；跨页/实体图低～中） |
| **技术依据** | `RecallHit.record.metadata` 可携带 `wikiPath`（ingest-wiki 已写）；缺口在 `formatRecallAsText` / `formatRecallAsRaw`（`packages/mcp/src/tools.ts`）未暴露 id/metadata/path；CLI recall（`packages/api/src/cli/ms.ts`）同理可加；关联侧：同页 `.sources`、`metadata.sourceIds`、`completion.jsonl`、`path-map.jsonl` 已有；图谱边在 `MemoryEdge`（`derives_from` / `references` 等）但未映射到 wiki 路径 |
| **主要风险** | 文本格式涨 token；无 path 的旧 memories 行；绝对路径泄漏本机布局；「关联」若做全图膨胀会伤召回延迟 |
| **关联结论** | **v1 可行**：命中页自身 `wikiPath`（相对）+ 可选 `sourceIds`（或截断列表）；**stretch**：同 slug 邻页、图谱邻居的 wikiPath、wiki 内 `[[links]]`——需额外索引，不进 MVP |

### 2.4 ④ 模型按地址读 wiki 原文

| 项 | 内容 |
|----|------|
| **可行性** | **高** |
| **技术依据** | 文件系统即正本；`KnowledgeResourceCapability` 已有路径穿越拒绝模式（`PATH_TRAVERSAL`）；可新增 `memory_wiki_read`（MCP）+ `ms wiki read`（CLI），解析 `wikiRoot` + 相对 path，限制扩展名 `.md`、禁止 symlink（operator `scanWikiRoot` 已拒 symlink） |
| **与现有工具关系** | `memory_knowledge_read` 读 **DB 投影**，受 revision/authority/截断约束；wiki 文件读是 **正本钻取**，二者互补，不可互相替代 |
| **主要风险** | 路径穿越 / 读到 wikiRoot 外；大页撑爆上下文（需 maxChars）；LanceDB-only 无 PG 时仍应能读本地 wiki；权限与 scope：仅允许读「当前 authority 可见命中」还是任意 wikiRoot 下相对路径——需产品决策 |

---

## 3. 可产出的效果提升（诚实 ROI）

### 3.1 短期可感知（1～2 个小迭代）

| 效果 | 来自哪一点 | 预期 |
|------|------------|------|
| Agent 召回结果可点击/可再读正本 | ③ + ④ | **可解释性明显上升**：争议记忆可对照融合页，而不仅是截断 text |
| 运维换盘/多 wiki 根不改脚本 | ② | 配置与 operator/`~/.mengshu` 约定对齐，降低脚本人肉改路径 |
| 人工审核成本下降（抽查） | ③ + ④ | 审核员从「搜 DB id」变为「打开相对 path」；对齐现有 INDEX/completion |
| 与 9581 页存量立刻产生价值 | ③ + ④ | **无需等①**；存量 knowledge 已有 wikiPath 的可先受益 |

### 3.2 长期治理

| 效果 | 来自哪一点 | 预期 |
|------|------------|------|
| 自动化治理闭环（账本、再生 INDEX、增量 ingest） | ① 窄化版 + 现有 operator | 新写入有「待融合 / 已挂 path」状态，批处理可扫 pending |
| 召回质量 | 间接 | 正本钻取改善 **人/模型二次研判**，不自动提高向量分；对「融合去噪后的 knowledge」召回已做过一轮治理，热路径补 path 是 **消费侧**增益 |
| 双真源风险 | 若①做错 | 长期负收益：wiki 与 memories 打架、completion 漂移 |

### 3.3 投入产出与「不值得」

| 做法 | ROI 判断 |
|------|----------|
| 配置 `wiki.root` + recall 回传相对 `wikiPath` + allowlist 只读工具 | **高 ROI** — 接通已有正本，改动面小（MCP 展示层 + 薄工具 + config） |
| 写时异步写「stub 页 / 元信息 JSONL」并标 pending | **中 ROI** — 为后续批融合铺路，但要严格不自称「已融合正本」 |
| 每次 `storeMemory` 同步跑类 ingest-wiki 融合 | **低 ROI / 不值得（v1）** — 贵、慢、与 USAGE 融合模型冲突，且 memories 历史未入 wiki 合同 |
| 召回时全量展开关联 wiki 正文 | **不值得** — token 爆炸；应用④按需读 |
| 引入第三方 wiki/记忆中间件桥 | **不做**（硬锁） |

---

## 4. 推荐优先级与 MVP

### 4.1 优先级

| 优先级 | 项 | 动作 |
|--------|----|------|
| **P0 做** | ② 配置 `wiki.root`（默认 `~/.mengshu/wiki`） | 校验绝对路径、存在性可选 warn |
| **P0 做** | ③ 召回/raw/context 附加 `wikiPath`（相对 root；无则省略或 `wikiStatus: missing`） | 改 MCP/CLI 展示与类型，不改打分 |
| **P0 做** | ④ `memory_wiki_read` + `ms wiki read` | allowlist：`resolve(wikiRoot, rel)` 必须以 root 为前缀；拒 `..`、symlink、非 `.md`；`maxChars` |
| **P1 缓做** | ③ 关联：返回 `sourceIds`（截断）或「同页来源数」；可选从 `.sources` 解析 | 不做跨页推荐 |
| **P1 缓做** | ① 写后异步：落 `wiki/pending/<id>.json` 或 metadata `wikiStatus=pending` | **不**自动改正式 `pages/` 融合页 |
| **P2 / 不做（v1）** | ① 同步自动融合进 `pages/` + 重写 completion/INDEX | 留给既有批处理 / 人工 USAGE 流程 |
| **不做** | Graphiti/第三方桥；npm 发布搭车；召回内嵌全文代替④ |

### 4.2 最小可行切片（MVP）

1. **config**：`wiki: { root: string }`（或 `wikiRoot`），默认解析到 `~/.mengshu/wiki`。  
2. **recall**：命中若 `metadata.wikiPath` 存在 → 规范化为相对 root 的地址一并返回（text 模式一行 `wiki: …`；raw 字段 `wikiPath`）。  
3. **read**：MCP/CLI 输入相对 path（或 file URI 限 scheme），校验后读正文，截断返回。  
4. **文档**：在 Skill / quickstart 写清「召回 → 需要原文 → wiki_read」；明确与 `memory_knowledge_read` 的差异。  
5. **验收**：对本机已有 `wikiPath` 的 knowledge 召回 ≥3 条可见 path；`wiki_read` 读通；越界 path 失败。

**明确非 MVP**：写时自动生成融合页；关联推荐图；回填全部历史 memories 的 wikiPath。

---

## 5. 仍开放的决策点（≤3）

> **已关闭（2026-10-12）**：见 §0.1 D1–D5。原三点结论摘要：①不做正式融合页、做 md 素材；④任意相对路径；wikiPath 覆盖 memories+knowledge。

1. ~~**①的产品语义**~~ → **D1+D2**：md 素材 + 多层索引；非融合页。  
2. ~~**④的授权边界**~~ → **D4**：任意 `wikiRoot` 相对路径（带 allowlist）。  
3. ~~**wikiPath 存放形态**~~ → **D5**：memories 与 knowledge 均写相对 `wikiPath`。

---

## 6. 关键文件速查（实现时）

| 路径 | 角色 |
|------|------|
| `config.ts` / `config.example.json` | 配置 schema；现无 wiki 根 |
| `packages/core/src/domain/types.ts` | `RecallHit` / `MemoryRecord.metadata` |
| `packages/mcp/src/tools.ts` | recall 展示；knowledge_read；工具注册 |
| `packages/core/src/resources/knowledge-resource-capability.ts` | 库内 knowledge 只读 + 路径穿越拒绝先例 |
| `packages/core/src/service/write-kernel.ts` / `memory-service.ts` | 写入热路径（挂副作用点） |
| `packages/api/src/agent-fast-path/index.ts` | observe/lookup 快路径 |
| `packages/api/src/cli/ms.ts` | CLI recall / 可挂 `wiki` 子命令 |
| `scripts/operator-wiki-knowledge-replace.ts` | wiki→knowledge；写入 `wikiPath` |
| `scripts/wiki-promote.ts` / `wiki-slim.ts` | 正本目录形态与安全复制约定 |
| `~/.mengshu/wiki/USAGE.md` | 正本维护合同（本机） |
| `docs/plans/upgrade-next-20261011.md` | MCP/CLI/Hooks 优先级与硬锁 |
| `work/tasks/2026-10-09-wiki-promotion/plan.md` | 正式化与 path 回写背景 |

---

## 7. 非目标（本评估不展开设计）

- 完整 W1… 实现排期与 API 草案（另文）  
- 替换或重跑 9581 页治理管线  
- 改变 5type 枚举或 Write Kernel 算法规格  
- 发布渠道与第三方记忆中间件
