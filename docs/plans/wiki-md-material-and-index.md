# Wiki 条目素材 + 多层索引：设计方案（同树贯通版）

> **类型**：实现设计（现状 → 目标 → 实现思路）  
> **日期**：2026-10-12（修订：废弃独立 `material/` 旁路，改落现有 `pages/` 树）  
> **前置**：`docs/plans/wiki-memory-feasibility.md` §0.1 / §0.2 决策落定  
> **范围**：文档 only；不改产品代码、不 commit（除非另嘱）

---

## 0. 一句话目标

Agent **写入 memories / knowledge 时**，在现有 **`~/.mengshu/wiki`（可配置 `wikiRoot`）同一棵树内**落一份条目级 `.md` 素材，回写 `metadata.wikiPath`（相对 root）；并 **自动维护多层 INDEX**，使本地 wiki 继续作为可浏览、可治理的工作区。召回始终带相对地址；模型可用 `wiki_read` 读 root 下任意相对 `.md`。

**明确不做**：写时全自动融合进 `pages/<slug>/page-NNN.md`；不另起与 `pages/` 脱节的顶级旁路树（已否决的 `material/`）；不替换离线 USAGE 融合管线；不接 Graphiti；不搭车 npm 发布。

---

## 0.1 相对上一版的硬修正（必须服从）

| 否决项 | 原因 | 取代方案 |
|--------|------|----------|
| 顶级 `material/<kind>/<scope>/<type>/<id>.md` | 与现有 `~/.mengshu/wiki` **未贯通**；Postgres 记忆/知识本由 **`pages/` + ingest-wiki** 构建，新写入也应落入**同一地方** | **`pages/<scopeSlug>/entries/<semanticType>/<id>.md`** |
| 用独立 kind 顶层（`material/memories` vs `material/knowledge`）重劈树 | kind 已编码在 **scopeKey / scope-registry slug**（如 `default-knowledge` / `default-memories`） | **复用既有 slug**；不再平行造一套 kind 目录 |

---

## 1. 现状

### 1.1 本机 wiki 实况（`~/.mengshu/wiki`）

| 路径 | 角色 | 热路径？ |
|------|------|----------|
| `pages/<scopeSlug>/page-NNN.md` + `.sources` | 离线**融合正本页**（多源合并）；页号在 slug 内顺延 | 否 |
| `INDEX.md` | **仅一层根索引**：总页/来源 + `scopeKey × semanticType` 汇总（实测无 `pages/**/INDEX.md`） | 批处理再生 |
| `scope-registry.json` | scopeKey → slug / pages / sources | 离线 |
| `completion.jsonl` | id→页；现状 **全部** `status: "fused"`（49509 行） | 离线 |
| `path-map.jsonl` | 迁移旧 part 路径 → `pages/<slug>/…` | 离线 |
| `USAGE.md` | 合同：wiki 是知识**唯一正本**；DB 为投影；**融合维护不动 memories** | — |
| `STYLE-GUIDE.md` | 融合页 frontmatter / 模板门禁（仅 Track F） | 离线 |
| `evidence/` / `receipts/` | 治理证据与回执 | 离线 |

融合页 `wikiPath` 先例（ingest-wiki）：`metadata.wikiPath = page.path`，形如 `pages/default-knowledge/page-019.md`（**相对** wiki 根）。

### 1.2 代码缺口（相对本目标）

| 能力 | 现状 |
|------|------|
| `config` wiki 根 | **无** `wikiRoot`；operator 靠 `--wiki` |
| 写时落盘 md | WriteKernel / `storeMemory` / agent-fast-path **不写** wiki 文件 |
| `metadata.wikiPath` | ingest-wiki 写入 **knowledge**（`pages/.../page-NNN.md`）；memories 无约定；召回展示层丢掉 path |
| 按路径读文件 | 仅有 `memory_knowledge_read`（库内 UUID+revision），无 FS wiki_read |
| 多层索引 | 仅根 `INDEX.md` 批再生；无 scope / entries / type 层索引页 |

### 1.3 双轨张力（必须写清）

- **历史合同（USAGE）**：`pages/<slug>/page-NNN` = 知识融合正本；knowledge 行是投影；融合流程不维护 memories。
- **热写入现实**：Agent 以 **DB** 为结构化权威；需在**同一 wiki 根**留下可导航的条目素材，且**不得**假装已完成融合。
- **化解方式**：同一 `pages/<slug>/` 下分列 **Track F（fused）** 与 **Track E（entries）**；索引分层统计；ingest-wiki v1 **仍只吃** `page-*.md`。

---

## 2. 目标能力

1. **配置**：`wikiRoot`（默认 `~/.mengshu/wiki`）；DB 与工具只存/只接受 **相对 root** 的 path。  
2. **写路径**：memories **与** knowledge 持久化成功后 → 在 **`pages/<slug>/entries/...`** 写/更新 `.md` → `metadata.wikiPath = <相对路径>`。  
3. **多层索引自动更新**（一等能力）：条目增删改后，**只刷新受影响祖先 INDEX**（MVP）；全量用 CLI `reindex`。  
4. **召回**：命中一律尽量带相对 `wikiPath`（含既有 fused path 与新 entries path）；v1 关联仅可选 `sourceIds`（截断）。  
5. **`wiki_read`**：MCP `memory_wiki_read` + CLI `ms wiki read`；**任意** root 下相对 `.md`（安全约束见下）。  
6. **同树共存**：`page-NNN` 融合语料与 offline promote/ingest **继续有效**；新条目落在同 slug 的 `entries/` 子树，**不覆盖**融合正文。

---

## 3. 信息模型与目录布局

### 3.1 选定布局（同树、扩展 `pages/` 分类法）

```text
<wikiRoot>/                              # 默认 ~/.mengshu/wiki
  INDEX.md                               # L0：既有 fused 汇总 + Entries 汇总（补丁节）
  USAGE.md                               # 既有；补「Track E / entries」附录（实现期）
  STYLE-GUIDE.md                         # 仅约束 Track F 融合页
  scope-registry.json                    # 既有；entries 复用同一 slug，不另造 registry（v1）
  completion.jsonl                       # 扩展 status：fused | entry（见 §3.4）
  path-map.jsonl / evidence/ / receipts/ # 离线治理；热路径禁止改

  pages/
    <scopeSlug>/                         # 与 scope-registry 一致，如 default-knowledge
      page-001.md                        # Track F：融合正本 —— 热路径禁止改写
      page-001.sources
      page-002.md
      page-002.sources
      …
      INDEX.md                           # L1（新）：本 slug 融合页摘要 + entries 分型计数
      entries/                           # Track E：热路径自动写入的条目素材
        INDEX.md                         # L2：各 semanticType 计数与链接
        <semanticType>/                  # profile|task_context|rules|experience|resource|unclassified
          INDEX.md                       # L3：本目录文件表（id / title / relpath / updated_at）
          <id>.md                        # 一行 DB 记录 ↔ 一份 md
```

**`wikiPath` 示例（一律相对 wikiRoot，正斜杠）**：

| 轨道 | 示例 |
|------|------|
| Track F（存量 ingest） | `pages/default-knowledge/page-019.md` |
| Track E knowledge | `pages/default-knowledge/entries/experience/<uuid>.md` |
| Track E memory | `pages/default-memories/entries/rules/<uuid>.md` |
| Track E unscoped | `pages/__unscoped__/entries/unclassified/<uuid>.md` |

**为何选 `pages/<slug>/entries/` 而不是顶级旁路**：

1. Postgres 投影来自 **`pages/` + ingest-wiki`**；新文件留在同一 `pages/<slug>/` 下，与 INDEX / completion / scope-registry **同一导航空间**。  
2. **不撞** `page-NNN` 编号与 `.sources` 合同；离线工具可继续 `glob page-*.md`（显式忽略 `entries/`）。  
3. **kind 不必再拆顶层目录**：`default-knowledge` vs `default-memories` 等 slug 已表达 kind。  
4. `wiki_read` / 人工浏览从根 INDEX → slug INDEX → entries → 文件，路径直觉与现网一致。

**scopeSlug 解析**：优先 `scope-registry.json` 已有 `scopeKey → slug`；未知 scopeKey → 稳定 slugify（与 promote 规则对齐或复用），缺省桶 `__unscoped__`。  
**semanticType**：五型 + `unclassified`；缺失走 unclassified。

### 3.2 条目 `.md` 最小合同（Track E）

```markdown
---
id: <uuid>
kind: memory | knowledge
scope_key: <scopeKey>
semantic_type: <type>
updated_at: <ISO-8601>
wiki_path: pages/<slug>/entries/<type>/<id>.md
track: entry
---

# <title or first-line summary>

<body text as stored in DB>

## Meta

- source: ...
- admissionRoute: ...（可选，白名单字段）
```

- 正文以 **当前 DB 行为准**（素材镜像，非融合）。  
- 更新 = 覆写同 path（id 稳定 → path 稳定）；若 semanticType/scope 变更 → **移文件**并更新新旧目录 INDEX + `wikiPath`。  
- **不写** `.sources`（那是融合页多源合同）；单条素材一一对应一行。  
- **不套用** STYLE-GUIDE 的融合 frontmatter 四键模板（那是 Track F）；Track E 用上表键即可。

### 3.3 DB 元数据

| 表 | 字段 | 约定 |
|----|------|------|
| memories / knowledge | `metadata.wikiPath` | **相对** `wikiRoot`，正斜杠 |
| 可选 | `metadata.wikiTrack: "entry" \| "fused"` | 可由 path 前缀推断：`.../entries/` → entry；`.../page-NNN.md` → fused；显式字段便于召回展示 |

**权威**：Agent 读写、打分、authority、forget → **仍以 DB 为准**。  
**wiki 工作区**：浏览、人工审核、模型按 path 钻取、多层 INDEX 导航；其中 Track F 仍是离线融合正本面。

### 3.4 completion.jsonl 扩展（可选但推荐贯通）

现状：每 id 一行，`status: "fused"`，`page` = 融合相对路径。  
扩展：Track E 写入时追加或更新为：

```json
{"id":"<uuid>","page":"pages/<slug>/entries/<type>/<id>.md","scope":"<scopeKey>","semanticType":"<type>","status":"entry"}
```

规则：

- **每 id 仍恰好一行**（沿用 USAGE）；同一 id 从 entry **晋升**为 fused 时，**更新**该行（`status`→`fused`，`page`→`page-NNN.md`），不得重复追加。  
- 热路径 **只**写/改 `status=entry` 的行；**禁止**改写 `status=fused` 行的 `page`（除非走离线晋升工具）。  
- 若担心热路径碰 completion 风险过高：MVP 可改为旁路 `entries-manifest.jsonl`，但 **目录仍必须在 `pages/.../entries/`**；推荐优先扩展 completion 以保持「一账本」。

---

## 4. 配置

```ts
// config.ts（示意）
wiki: {
  root: string;                 // 绝对路径；默认 ~/.mengshu/wiki
  entriesDirName?: string;      // 默认 "entries"（位于 pages/<slug>/ 下）
  writeEntriesOnPersist?: boolean; // 默认 true（可关便于测试）
  indexUpdate?: "sync-ancestors" | "off"; // MVP 默认 sync-ancestors
  updateCompletion?: boolean;   // 默认 true：同步写 completion status=entry
}
```

- 校验：`root` 绝对路径；解析 `~`；首次写入可 `mkdir -p` `pages/<slug>/entries/<type>/`。  
- **禁止**把绝对本机 path 写入 DB；工具入参若含绝对 path → 规范化到相对或拒绝。  
- CLI/operator 既有 `--wiki` 应与 config 对齐（config 优先，flag 覆盖）。

---

## 5. 多层索引自动更新

### 5.1 为何值得做

没有 INDEX，`entries/` 在千级文件后不可导航，治理价值接近散落归档。  
根 `INDEX.md` 已证明汇总页有用；本机 **缺** slug / entries / type 层 — 在 **同一 `pages/` 树**内补齐，而不是另起 `material/` 索引宇宙。

**结论：Endorse — 多层索引自动更新 = yes。**  
MVP = **写时只再生受影响祖先链**，避免每次全树扫描 9581+ 融合页。

### 5.2 层级模型（相对选定布局）

| 层 | 文件 | 内容 |
|----|------|------|
| L0 | `<wikiRoot>/INDEX.md` | **保留**既有 fused 节（离线流程继续负责页数/来源口径）。**新增** `## Entries` 节：按 scopeKey（或 slug）汇总 entry 条数，并链到各 `pages/<slug>/INDEX.md`。MVP **只补丁 Entries 节**，不重算 fused 页数。 |
| L1 | `pages/<slug>/INDEX.md` | 本 slug：**Fused**（`page-*.md` 数量 / 可选链到 page 列表摘要）+ **Entries**（按 semanticType 计数，链到 L2） |
| L2 | `pages/<slug>/entries/INDEX.md` | semanticType 列表与计数 |
| L3 | `pages/<slug>/entries/<semanticType>/INDEX.md` | 文件表：`id` \| title/摘要 \| 相对 path \| updated_at |
| （可选 P2） | `pages/RECENT-ENTRIES.md` 或根 `ENTRIES-CHANGELOG.md` | 最近 N 条；append + 截断 |

### 5.3 何时更新

| 事件 | 动作 |
|------|------|
| persist 新记忆/知识 | 写 `entries/.../<id>.md` → 更新 L3 一行 → 滚计数 L2→L1 → 补丁 L0 Entries 节；可选 completion 追加 `status=entry` |
| 更新正文同 path | 覆写 md → 更新 L3 行（title/mtime）→ 上层计数不变可跳过 |
| scope/type 变更 | 移文件 → 旧 L3 删行 + 新 L3 增行 → 两侧祖先计数；更新 `wikiPath` / completion |
| forget/删除 | 删 md（或移 trash）→ L3 删行 → 祖先计数；completion 行删除或标 `status=deleted`（推荐 MVP：**删文件 + 删 completion entry 行**，fused 行不动） |
| 启动/维修 | `ms wiki reindex entries` 全量重建 **entries 相关** INDEX（及 L0 Entries 节）；**默认不**重算 fused 总表 |

**同步 vs 异步**：MVP **同步轻量祖先更新**。全量 reindex → CLI。  
**幂等**：INDEX 由目录实况派生（稳定排序）；禁止只 append 不去重。  
**性能边界**：写时 **不得**为了 entries 去扫描全部 `page-*.md`；L1 的 fused 计数可用「仅统计 `page-*.md` 文件名」的轻量 readdir，或缓存到 L1 frontmatter，避免读正文。

### 5.4 双轨共存（同一 wikiRoot）

| | Track F — Fused（既有） | Track E — Entries（本方案） |
|--|------------------------|---------------------------|
| 路径 | `pages/<slug>/page-NNN.md` + `.sources` | `pages/<slug>/entries/<type>/<id>.md` |
| 写入方 | 人工 / promote / 批处理 | WriteKernel 成功后副作用 |
| 索引 | 根 INDEX fused 节 + completion `fused` | L0 Entries 节 + L1–L3 + completion `entry` |
| ingest-wiki | **唯一**正式输入（v1） | **不**自动作为融合输入 |
| USAGE | 「正本」表述保留在融合面 | 附录：entries = DB 镜像素材面，同树可治 |
| memories | 历史「融合维护不动 memories」 | **允许**写 entries（解除的是「不能落 wiki 文件」，不是「自动融合 memories」） |

热路径 **禁止**改：`page-NNN.md` / `.sources` / fused 的 completion 行 / `path-map.jsonl` / 冻结 evidence。  
远期晋升：离线批处理读 entries → 写入/更新 `page-NNN` → completion `entry`→`fused` → 再 ingest-wiki；**不在**本方案热路径。

---

## 6. 写入实现思路

```text
MemoryWriteKernel / storeMemory / knowledge persist
  → DB commit 成功
  → EntryWriter.write({ id, kind, scopeKey, semanticType, text, title? })
       resolve wikiRoot + scopeSlug (registry) + entriesDirName
       path = pages/<slug>/entries/<type>/<id>.md
       mkdir -p parent
       atomic write *.md (tmp + rename)
       patch metadata.wikiPath (+ optional wikiTrack=entry)
       optional: upsert completion.jsonl status=entry
       IndexMaintainer.touchAncestors(path)  // L3→L2→L1→L0 Entries 节
  → 失败策略：DB 已成功则记 wikiStatus=error + 日志；不回滚记忆
```

挂点优先：`MemoryWriteKernel` 持久化成功分支；knowledge 对等入口；测试可关 `writeEntriesOnPersist`。

**与已有 fused wikiPath 的 knowledge 行**：若 `metadata.wikiPath` 已指向 `pages/.../page-NNN.md`，热更新正文 **默认不**改 fused 页，也 **默认不**再写一份 entries（避免双份正文）。仅当该行 **没有** wikiPath、或 path 指向缺失文件、或显式 `forceEntryMirror` 时才写 Track E。

---

## 7. 召回

- `formatRecallAsText` / raw / CLI：若有 `metadata.wikiPath` → 输出相对 path（一行 `wiki: pages/...`）。  
- `pages/.../page-NNN.md` 与 `pages/.../entries/...` **同等展示**（均可 wiki_read）。  
- 无 path：省略或 `wikiStatus: missing`（迁移前旧行）。  
- 关联 v1：可选截断 `sourceIds`；**不做**邻页/图谱展开。

---

## 8. MCP / CLI：`wiki_read`

| | |
|--|--|
| MCP | `memory_wiki_read` |
| CLI | `ms wiki read <relpath>` |
| 入参 | 相对 path（正斜杠）；可选 `maxChars` |
| 允许 | `resolve(wikiRoot, rel)` 规范化后 **仍在 root 内**；扩展名 `.md`；常规文件（含 fused 与 entries） |
| 拒绝 | `..` 穿越、绝对 path 逃逸、symlink（含中间目录）、非 `.md`、目录 |
| 与 knowledge_read | 库内权威+revision vs **文件钻取**；互补 |

**产品已锁定**：不限召回命中集合。

另：`ms wiki reindex entries`；可选 `ms wiki path <id>`；`ms wiki backfill-entries`。

---

## 9. 迁移 / 回填

| 策略 | 说明 |
|------|------|
| **惰性** | 旧行无文件 → 召回无 path；下次 **update** 时补写 entries |
| **批回填（推荐有命令）** | `ms wiki backfill-entries --kind all\|memories\|knowledge [--limit N]`：扫无 `wikiPath` 或 path 文件缺失的行 → 写 `pages/<slug>/entries/...` → 更新 metadata → 末尾一次 reindex entries |
| **已有 fused path** | knowledge 已是 `pages/.../page-NNN.md` → **不**强制再写 entries；召回继续用现有 path |

---

## 10. 工作包（便于后续短 prompt）

| WP | 内容 | 验收要点 |
|----|------|----------|
| **W1** | config `wiki.root` + 路径解析/校验 + example | 改配置可指向临时目录 |
| **W2** | `EntryWriter`：`pages/<slug>/entries/<type>/<id>.md`、atomic 写、frontmatter | 单测临时 root；scope 变更会移动文件；不碰 `page-*.md` |
| **W3** | WriteKernel / knowledge 持久化挂钩 + metadata.wikiPath | 新写入落在 entries 下且 DB 有相对 path |
| **W4** | `IndexMaintainer` 祖先链（L3→L0 Entries 节）+ 可选 completion `entry` | 写 1 条只改祖先；幂等；`reindex entries` 一致；fused 总表不被热路径重算坏 |
| **W5** | recall 展示 wikiPath（MCP+CLI） | fused 与 entries path 均可见 |
| **W6** | `memory_wiki_read` + `ms wiki read` 安全读 | 合法 md OK；`../` symlink 非 md 拒绝 |
| **W7** | `backfill-entries` CLI | 抽样旧行补齐；dry-run；跳过已有 fused path |
| **W8** | 文档：Skill/quickstart；USAGE 附录 Track E；与 STYLE-GUIDE 边界 | 审阅通过 |
| **W9**（可选） | RECENT；outbox 异步索引；entry→fused 晋升批处理 | 非 MVP |

建议落地顺序：**W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8**。

---

## 11. 非目标

- Graphiti / 第三方记忆桥  
- 写时全量融合管线 / 改写 `pages/page-NNN` / 自动 ingest-wiki  
- 顶级独立 `material/`（或同构旁路）树  
- 召回内嵌全文代替 wiki_read  
- npm 发布搭车  
- 改 5type 枚举或 WriteKernel 打分规格  
- 重跑 9581 页治理或修改冻结 evidence

---

## 12. 诚实说明：三面权威

| 面 | 权威用途 |
|----|----------|
| **DB（memories / knowledge）** | Agent 操作、召回打分、authority、forget、MCP 结构化读写的 record of record |
| **`pages/<slug>/page-NNN`（Track F）** | 离线治理的 **知识融合正本**（USAGE 原意保留） |
| **`pages/<slug>/entries/...`（Track E）** | 同树 **条目素材 / 导航 / 审核面**；便于自动化治理入口；**不是**新的唯一融合正本，也 **不**取代 DB |

对外表述建议：  
「`~/.mengshu/wiki` = 本地知识工作区；`pages/<slug>/page-*` 为融合正本，`pages/<slug>/entries/` 为条目级素材镜像；Agent 运行时以数据库为准；二者同根、同 slug、分层索引。」

---

## 13. 开放问题（≤2）

1. **completion 是否由热路径更新**：扩展同一 `completion.jsonl`（`status=entry`） vs 旁路 `entries-manifest.jsonl`？（**推荐**：同一 completion，严格每 id 一行；若实现期发现与离线锁冲突，再降级旁路清单，**目录布局不变**。）  
2. **删除策略**：forget 后 entry md 物理删除 vs `pages/<slug>/entries/_trash/`？（**推荐** MVP 物理删除 + 依赖 DB；需要审计再开 trash。）

其余产品点已在可行性 §0.1 / §0.2 关闭。

---

## 14. 代码锚点（实现时）

| 路径 | 角色 |
|------|------|
| `config.ts` / `config.example.json` | wikiRoot |
| `packages/core/src/service/write-kernel.ts` | 写成功挂钩 |
| `packages/core/src/service/memory-service.ts` | storeMemory |
| `packages/core/src/domain/types.ts` | RecallHit / metadata |
| `packages/mcp/src/tools.ts` | recall 格式；注册 wiki_read |
| `packages/api/src/cli/ms.ts` | `wiki read` / `reindex entries` / `backfill-entries` |
| `packages/core/src/resources/knowledge-resource-capability.ts` | 穿越拒绝先例 |
| `scripts/operator-wiki-knowledge-replace.ts` | fused wikiPath 先例（只扫 page 形态） |
| `scripts/wiki-promote.ts` | slug / `pages/<slug>/page-NNN` 合同 |
| `~/.mengshu/wiki/USAGE.md` | fused 合同（热路径勿违反；另补 Track E 附录） |
| `docs/plans/wiki-memory-feasibility.md` | 决策与 ROI 背景 |
