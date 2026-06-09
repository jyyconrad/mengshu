# OpenHuman 项目分析报告 — 对 banto 记忆体系的启发

> **来源项目**：[tinyhumansai/openhuman](https://github.com/tinyhumansai/openhuman)
> **分析日期**：2026-05-29
> **分析方法**：抓取 README.zh-CN.md + GitBook 文档（`memory-tree`、`obsidian-wiki` 子页）
> **状态**：分析报告，不修改 banto 现有设计

---

## 摘要

OpenHuman 是一款"本地优先 + 桌面壳"的个人 AI 智能体框架，它有两个对 banto 记忆体系最具冲击力的设计：

1. **Memory Tree（记忆树）** — 分层摘要树（L0 原始叶 → Lₙ 摘要），通过 bucket seal 机制级联折叠，节点按 `Source / Global / Topic` 三种 flavour 组织
2. **Obsidian Wiki Vault** — 把记忆树的 chunk 直接以 `.md` 文件物化到工作区 `wiki/` 目录，用 `[[wikilink]]` 互链，**用户可用 Obsidian 客户端直接编辑**

这两个机制对 banto 当前 v0.6 设计（"四层平铺 + md+json 双存 + edges/ 独立目录"）形成了**结构性挑战与互补机会**——本报告的核心结论是 **banto 应该吸收"分层摘要折叠"和"用户可编辑文件镜像"两个机制，但保留自己的"工作进化系统三重职能"和"与 banto 产品形态映射"的独有定位**。

---

## 一、项目概览

### 一句话定位

> "OpenHuman 是你的个人 AI 超级智能：本地记忆，按需托管服务，简洁而强大。"

### 核心特性

| # | 特性 | 含义 |
|---|---|---|
| 1 | UI 优先 + 桌面吉祥物 | 内置可说话、感知环境、能加入 Google Meet 的拟人吉祥物 |
| 2 | 118+ 一键 OAuth 集成 | 通过 Composio 接入 Gmail/Notion/GitHub/Slack/Linear/Jira 等 |
| 3 | Auto-Fetch 周期同步 | 核心每 20 分钟轮询活跃连接，把外部新数据吸入记忆树 |
| 4 | **Memory Tree + Obsidian Wiki 双层知识库** | SQLite 中的分层压缩 + 工作区 `.md` 文件镜像 |
| 5 | 原生工具集 | 网页搜索、抓取爬虫、文件系统/git/lint/test/grep、STT、TTS、口型同步 |
| 6 | 模型路由 | 后端按工作负载（推理/快速/视觉）选 LLM；可选 Ollama 本地推理 |
| 7 | TokenJuice 上下文压缩 | HTML→Markdown、URL 缩短、工具输出去重，官称 "降低 80% 成本和延迟" |
| 8 | 跨智能体共享记忆 | 通过 `agentmemory` 后端与 Claude Code/Cursor/Codex/OpenCode 共享存储 |

---

## 二、6 维度结构化分析

### 2.1 项目定位（与 banto 的相似与差异）

**相似**：

- 都是桌面应用（Tauri / Electron），强调本地数据所有权
- 都把"外部连接器（MCP / Composio）+ 工具调用 + 持久记忆"作为核心三件套
- 都定位为"长期协作的工作助手"而非"一次性问答"
- 都用 Markdown 作为记忆的人类可读形式

**差异**：

| 维度 | OpenHuman | banto |
|---|---|---|
| 核心抽象 | 记忆树 + Wiki vault（两种数据视图） | 短时任务 / Project / 自动化（三大工作容器） |
| 启动哲学 | 自动后台拉取 + 持续吸入 | 用户主动发起任务 |
| 角色感 | 通用个人智能体 | 企业岗位工作助手 |
| 主动性 | 后台思考 + 周期同步 | chat-end 三阶段触发 + 主动建议 |

**关键差异点**：OpenHuman 是"**信息聚合型**"个人 agent（把所有数据都吸进来再用），banto 是"**任务推进型**"工作助手（围绕具体任务展开记忆）。这决定了两者记忆模型的重心不同。

### 2.2 记忆体系设计

OpenHuman 的记忆体系核心是 **Memory Tree**（位于 `src/openhuman/memory_tree/`）：

**层级结构**：
- **L0**：原始叶子（每个 ≤ 3K token 的 Markdown 片段）
- **L1**：L0 满 bucket 后由 LLM 生成的摘要节点
- **Lₙ**：层层向上级联，无显式深度上限

**树种类（TreeKind，三种 flavour）**：
- `Source` — 按数据来源组织（如 Gmail 树、Slack 树、Linear 树）
- `Global` — 按时间维度的全局摘要（如按日期）
- `Topic` — 按实体/主题组织（如按客户、按项目）

**核心契约类型**（`io.rs` 定义，"Pure types, no IO"）：
- `TreeWriteRequest` / `TreeWriteOutcome`
- `TreeReadRequest` / `TreeReadHit` / `TreeReadResult`
- `TreeLeafPayload`
- `TreeLabelStrategy`

**写入流程（bucket seal 机制）**：
1. Orchestrator 构造 `TreeWriteRequest`（带 `TreeKind` + `TreeLeafPayload`）
2. 叶子追加到 L0 的开放 bucket
3. 若 bucket 装满则**封口（seal）**：调用 chat 模型生成 L1 摘要，作为叶子进入 L1 bucket
4. 级联向上："cascade continues upward until a non-full bucket is hit"

**TTL Flush 机制**：bucket 未满但 TTL 到期时执行**部分封口（partial seal）**，确保上层始终有新鲜内容。

### 2.3 自学习与进化机制

OpenHuman **没有显式的"自学习"章节**，进化主要通过：

- **持续摄取**（Auto-Fetch 20 分钟周期增量拉新）
- **后台思考**（吉祥物"即使你停止输入后仍在后台持续思考"，"跨周记住你"）
- **打分系统**（`score/` 模块异步、不阻塞写入路径）：
  - Embedding 后端：cloud / Ollama / inert 三选一
  - 实体抽取：regex 优先，LLM 可选
  - **Hotness 信号**：热度评分，让"warm content surfaces first"

OpenHuman 在自身对比表里把记忆能力描述为"记忆树 + Obsidian 仓库"，把竞品 Hermes 标为"自学习"——**暗示 OpenHuman 自己不做在线训练**，进化靠数据吸入 + 压缩 + 热度。

### 2.4 知识结构（图谱 / 文档 / 向量）

OpenHuman 是**混合结构**：

| 维度 | 实现 |
|---|---|
| 文档层 | Obsidian Wiki vault（`.md` 文件 + frontmatter） |
| 树形层 | Memory Tree（SQLite 中的分层摘要） |
| 图谱层 | Obsidian `[[wikilink]]` 双链（用户/客户端维护，OpenHuman 不维护索引层） |
| 向量层 | `score/` 模块的 embedding 索引（可选 cloud/Ollama/无） |
| 实体层 | `score/` 的 entity index store |

**关键设计**："**The same chunks the agent reasons over are written as plain .md files into a vault inside your workspace.**"—— **不是镜像，是同一份数据的物化**。

### 2.5 触发与运转机制

| 时机 | 触发的动作 |
|---|---|
| 周期触发（每 20 分钟） | Auto-Fetch 拉取活跃连接的新数据 |
| 数据进入 | Ingest 管线 → chunk → score → fold into trees |
| Bucket 满 | Seal → 生成上层摘要 |
| TTL 到期 | Partial seal → 上层有新鲜内容 |
| Agent 推理时 | 调用 retrieval/ 工具读取（walk / drill_down / fetch_leaves / query_* / search_entities）|
| 用户编辑 vault | 同一管线消费手写笔记，并入 topic 和 global 树 |

**Agent 可见的检索工具**：

| 工具 | 用途 |
|---|---|
| `walk` | Agentic 探索，由 agent 自行选择摘要节点下钻 |
| `drill_down` | 从已知摘要起点的确定性遍历 |
| `fetch_leaves` | 拉取已封口 bucket 的原始叶子 |
| `query_{source,global,topic}` | Kind 范围内的检索 |
| `search_entities` | 基于实体索引的查找 |

**所有读取处理器都查询 `hotness`**——"让热门内容先浮现"。

### 2.6 与多 Agent / 工具 / 协议的耦合

- **集成层**：默认走 OpenHuman 托管后端代理 Composio 的 OAuth 与工具调用；自带 Composio API key 可直连
- **跨智能体协议**：通过 `agentmemory` 后端可与 Claude Code、Cursor、Codex、OpenCode **共享同一记忆存储**
- **模型层**：托管模型路由（订阅含全部模型）+ 可选 Ollama 本地模型
- **会议/语音**：原生接入 Google Meet 实时智能体，ElevenLabs TTS

---

## 三、Memory Tree + Obsidian Wiki 深度分析

### 3.1 Memory Tree 的核心机制（已在 2.2 详述）

**关键工程不变量**（kind-agnostic 三条规则）：
- **无 tree-kind 分支**：`bucket_seal`、`flush`、`registry`、`summarise` 都把 `TreeKind` 当作不透明参数
- **无持久化**：所有读写经 `memory_store::trees::{store, registry, hotness}`
- **无策略**：curator gates、digest cadence、global scope sentinels 都在外层 `memory::tree_{global,topic}`

**未公开**：bucket 容量、TTL 数值、token 预算、embedding 维度、hotness 计算公式、`TreeLeafPayload` 字段、prompt 模板。

### 3.2 Obsidian Wiki 的核心机制

**目录结构**：

```
<workspace>/
└── wiki/
    ├── summaries/   # 自动生成的摘要树（按 date / source / entity 分）
    ├── notes/       # 用户手写笔记（如 wiki/notes/2026-05-08-board-call.md）
    └── …            # 每个已连接 toolkit 一个文件夹
```

**Frontmatter 携带溯源信息**：source ids、time range、scope —— 让 agent 可把任何论断回溯到原始 chunk。

**双链机制**：
- 标准 Obsidian 语法 `[[wiki-link]]`
- "Obsidian's graph view, backlinks, and tag explorer all work out of the box"
- **OpenHuman 自身不维护额外索引层**，反向链接由 Obsidian 客户端基于 `[[]]` 解析

**用户可直接编辑（核心设计点）**：
- 桌面应用 Memory 标签页提供 **"View vault in Obsidian"** 按钮（`obsidian://open?path=...`）
- 用户的手工编辑会被 agent 看到（"the agent will see your edits"）
- 设计哲学（与"黑箱嵌入"对立）：**"If the agent gets something wrong, you can find the file, fix it, and the next retrieval is correct."**

**Memory Tree 与 Wiki 的关系**：
- 不是镜像，**是同一份数据的两种视图**
- Memory Tree 是 SQLite 中的层级压缩结构
- Wiki vault 是磁盘上的 `.md` 文件，让人类可打开/浏览/编辑
- 用户在 `wiki/notes/` 下的手写笔记会被 ingest 管线消费 → chunks → scores → 并入主题树和全局树

---

## 四、与 banto v0.6 的对比

### 4.1 相似度对比表

| 维度 | OpenHuman | banto v0.6 | 相似度 |
|---|---|---|---|
| 桌面应用 | Tauri | Electron | ✅ 相同 |
| 本地存储 | SQLite + 文件系统 | 文件系统（Markdown + JSON） | 🟡 部分 |
| 记忆人类可读 | Markdown vault | Markdown 文件 | ✅ 相同 |
| 节点关系 | Obsidian `[[]]` 双链 | edges/ 独立目录 + 5 类边 | 🟡 不同实现 |
| 分层结构 | 树形（L0→Lₙ 摘要折叠） | 平铺四层（全局/项目/会话/自动化） | 🔴 根本不同 |
| 写入触发 | Auto-Fetch 周期 + ingest 管线 | chat-end 三阶段触发 + AI 观察 | 🔴 不同时机 |
| 用户可直接编辑记忆 | ✅ 通过 Obsidian 客户端 | ❌ 仅 UI 内编辑 | 🔴 banto 缺 |
| 跨 agent 共享 | ✅ agentmemory 后端 | ❌ 仅本应用 | 🔴 banto 缺 |
| 主动观察建议 | ❌ 仅"后台思考"模糊描述 | ✅ 五种主动观察输出 | 🟢 banto 强 |
| 与产品容器映射 | ❌ 通用，无明确容器 | ✅ 三大容器映射 | 🟢 banto 强 |
| 支撑体系联动 | 工具/Composio 直接耦合 | 专家/技能/连接器三层耦合 | 🟢 banto 更精细 |
| 三重职能定位 | ❌ 仅"做好当下" | ✅ 做好当下 + 沉淀能力 + 优化未来 | 🟢 banto 强 |

**结论**：
- OpenHuman 在 **数据层（树形折叠 + 用户可编辑文件）** 比 banto 强
- banto 在 **产品层（容器映射 + 三重职能 + 主动建议）** 比 OpenHuman 强
- 两者**互补性高于冲突**，可以择优融合

### 4.2 核心结构性挑战

**挑战 1：树形分层 vs 平铺四层**

banto 当前是 **平铺**结构（全局/项目/会话/自动化是 4 个并行容器）。OpenHuman 的 **树形**结构（L0 原始叶 → Lₙ 摘要）解决了一个 banto 没回答的问题：

> 当一个项目积累了 100 次会话、500 个决策节点时，如何避免"信息洪流"？如何让用户"先看摘要再下钻"？

banto 的"分层召回"（必读/任务相关/按需检索）是**注入策略层面的分层**，但**存储层面仍是平铺**。OpenHuman 的"L0 → Lₙ 摘要"是**存储层面的分层**，更彻底。

**挑战 2：双链 vs 独立 edges 目录**

banto 当前是 `edges/` 独立目录存关系。OpenHuman 是 `[[wikilink]]` 嵌入正文。各有优劣：

| 维度 | banto edges/ | OpenHuman [[]] |
|---|---|---|
| 全局关系查询 | ✅ 易（直接扫 edges/） | ❌ 需扫所有 .md |
| 关系类型多样性 | ✅ 5 类边带 weight/reason | ❌ 只有"链接"一种关系 |
| 用户阅读体验 | 🔴 需打开两个文件 | ✅ 单文件即可看上下文 |
| 与 Obsidian 兼容 | ❌ 不能用 Obsidian 看 | ✅ 开箱即用 |
| 维护成本 | 🟡 双写（节点 + 边） | ✅ 嵌入正文，自动维护 |

**挑战 3：用户可直接编辑 .md 文件**

OpenHuman 的"用户可用 Obsidian 客户端打开 vault 直接编辑"是 banto 没有的能力。这背后的哲学是：

> **如果 AI 错了，用户可以打开文件改正，下次检索就正确。**

banto 当前所有记忆操作都封装在 UI 里。这意味着用户无法快速浏览全局，无法批量编辑，无法用第三方工具增强体验。

---

## 五、启发清单

### 5.1 ✅ 可直接吸收的设计

| # | 启发点 | 吸收方式 |
|---|---|---|
| **A1** | **Frontmatter 携带溯源信息** | banto 的 md 文件 frontmatter 应该强制包含 `source`、`sessionId`、`time range`、`scope` 等字段，让任何记忆都可回溯到原始 chunk |
| **A2** | **Hotness 热度评分** | banto 的"按需检索层"召回时，应该让"近期高频引用 / 用户多次确认"的记忆优先浮现，而不只是 confidence |
| **A3** | **TTL Flush 机制** | banto 的 chat-end 整理可借鉴 partial seal——即使会话很短没满 bucket，TTL 到期也强制整理一次，确保不积压 |
| **A4** | **检索工具分类** | banto 的"按需检索 AI 工具"可参考 OpenHuman 的 `walk / drill_down / fetch_leaves / query_*` 设计，提供多种粒度的检索方式而非单一 search |

### 5.2 🔧 需要改造后吸收

| # | 启发点 | 改造方向 |
|---|---|---|
| **B1** | **L0 → Lₙ 摘要折叠** | banto 的"项目记忆"层应该引入子层（项目原始叶 / 项目摘要 / 项目主题摘要）。**但 banto 不需要无限层级**——做到"原始叶 + 一层摘要"两层即可，因为 banto 是任务驱动而非数据驱动 |
| **B2** | **Obsidian Wiki vault 物化** | banto 应在 `userData/banto-wiki/` 下生成可被 Obsidian 打开的 vault，但这是**记忆体系的"导出视图"而非主存储**。banto 的主存储仍是 md+json，vault 是定期同步的镜像 |
| **B3** | **`[[wikilink]]` 互链** | banto 的 Markdown 正文中应该使用 `[[]]` 语法引用其他记忆节点，**与 edges/ 目录共存**——`[[]]` 是"软引用"（人类阅读用），`edges/` 是"硬关系"（结构化查询用） |
| **B4** | **TreeKind 三种 flavour** | banto 可借鉴 `Source / Global / Topic` 的多视角组织，对应到 banto 即"按容器（自动化）/ 按时间（每周回顾）/ 按主题（客户、领域）"三种摘要视角 |
| **B5** | **跨 agent 记忆共享** | banto 的 md+json 格式应该考虑兼容 `agentmemory` 接口，让 banto 的记忆未来可以被 Claude Code、Cursor 等读取，反之亦然 |

### 5.3 ❌ 应保留 banto 现有设计（不引入 OpenHuman 的做法）

| # | 保留的 banto 设计 | 不引入 OpenHuman 的理由 |
|---|---|---|
| **C1** | **三大产品容器映射** | OpenHuman 没有"短时任务 / Project / 自动化"的概念，它是通用 agent。banto 必须保留这个映射，因为它是产品形态的核心 |
| **C2** | **三重职能（做好当下 / 沉淀能力 / 优化未来）** | OpenHuman 只做"做好当下"。banto 的"沉淀能力 → Skill"和"优化未来 → 主动建议"是差异化优势 |
| **C3** | **专家智能体 / 技能 / 连接器三层支撑体系** | OpenHuman 把工具直接绑定，没有"专家"和"技能"的产品概念。banto 的支撑体系层与记忆的联动是独有设计 |
| **C4** | **chat-end 三阶段触发** | OpenHuman 是"Auto-Fetch 周期 + 后台思考"模式，banto 是"任务结束触发"模式。前者适合数据聚合，后者适合任务推进 |
| **C5** | **企业边界与权限** | OpenHuman 完全是个人 agent，无组织边界。banto 是企业产品，必须保留"项目级权限"、"全局记忆所有权归用户账号"等边界 |
| **C6** | **`edges/` 独立目录** | OpenHuman 的 `[[]]` 双链表达力有限（只有一种关系）。banto 的 5 类关系（derives_from/conflicts_with/depends_on/supersedes/references）+ weight + reason 必须保留 |

### 5.4 🆕 OpenHuman 没解决但 banto 应该解决的问题

| # | banto 独有的问题 | 可能方向 |
|---|---|---|
| **D1** | **任务进化中的"决策链回溯"** | banto 的 5 类关系支持 `derives_from`，可以追溯"当前决策 ← 之前约束 ← 最初事实"的完整链条。OpenHuman 无此能力 |
| **D2** | **"沉淀能力"的可控性** | banto 应该让用户能看到"哪些记忆即将晋升为 Skill"，OpenHuman 没有 Skill 概念 |
| **D3** | **"优化未来"的主动建议克制度** | banto 已设计"低风险主动推 + 高风险被动出"的边界。OpenHuman 是"后台思考"模糊推送 |
| **D4** | **企业场景的多用户协作** | 多人共同维护一个 Project 的记忆，OpenHuman 完全没考虑（它是个人 agent）|
| **D5** | **离线企业内网部署** | OpenHuman 默认"按需托管服务"，banto 在企业内网必须能完全离线运行 |

### 5.5 ⚠️ OpenHuman 的局限与风险（banto 应避免）

| # | 风险 | banto 应避免的做法 |
|---|---|---|
| **E1** | **打分公式不透明** | OpenHuman 的 hotness、score 实现都未公开，可能导致用户不信任。banto 应让 confidence、引用次数、衰减规则**完全透明、用户可查看** |
| **E2** | **后台 Auto-Fetch 隐私担忧** | 20 分钟周期主动拉外部数据，可能让用户感到"被监控"。banto 应让所有自动同步都有显式开关 |
| **E3** | **跨 agent 共享存储的数据所有权** | OpenHuman 通过 `agentmemory` 让 Claude Code/Cursor 读 banto 记忆，会有数据泄露风险。banto 应**先做导出导入，再考虑共享** |
| **E4** | **树形折叠的不可逆** | bucket seal 后原始 L0 叶子是否还能查到？文档不清晰。banto 在引入摘要折叠时**必须保证原始记忆可回查** |
| **E5** | **"自学习"被市场宣传带偏** | OpenHuman 自己承认不做"自学习"，但易被误解。banto 应明确说明"沉淀 Skill"和"自学习"的边界——是用户可控的能力进化，不是黑箱训练 |

---

## 六、主线程下一步建议

基于以上分析，建议在 banto v0.6 设计的下一个迭代中，针对 9 项关键决策做以下增强：

### 优先建议 A：在"四层记忆模型"中引入"摘要折叠"子层

**改造点**：项目记忆层下增加"原始节点 / 摘要节点"两层。会话记忆晋升时不只复制原始内容，还要触发上层摘要更新。

**带来什么**：解决"项目积累 100+ 节点后如何召回不爆炸"的问题。

**对应文档**：[01-memory-layers-and-containers.md](./01-memory-layers-and-containers.md)

### 优先建议 B：在"md+json 数据模型"中增加 `[[wikilink]]` 软引用

**改造点**：节点正文支持 `[[name]]` 语法，与 `edges/` 的硬关系并存。`[[]]` 给人类阅读用，`edges/` 给结构化查询用。

**带来什么**：人类阅读体验大幅提升，未来支持 Obsidian 客户端直接浏览。

**对应文档**：[02-work-graph-data-model.md](./02-work-graph-data-model.md)

### 优先建议 C：增加"用户可直接编辑文件"作为新决策点

**改造点**：在 `userData/banto-wiki/` 下生成 Obsidian 兼容 vault，作为"导出视图"。用户编辑后通过文件监听同步回主存储。

**带来什么**：让用户在 AI 出错时能"找到文件、改正、下次就对"。这是 banto 当前完全缺失的能力。

**新增决策**：决策 10 — 是否引入"用户可编辑的 Obsidian Vault 镜像"？

### 优先建议 D：增加 hotness 热度信号

**改造点**：召回时不只按 confidence，还按"最近使用时间 + 引用频率 + 用户确认次数"综合排序。

**带来什么**：让"温热"记忆优先浮现，老旧但 confidence 高的记忆不会一直占位。

**对应文档**：[03-runtime-mechanisms.md](./03-runtime-mechanisms.md) 第 5 节"读取召回策略"

### 优先建议 E：加入 TreeKind 三视角组织

**改造点**：项目记忆的摘要按三种视角生成——按时间（每周回顾）、按主题（客户/领域）、按容器（自动化执行流）。

**带来什么**：让"优化未来"的工作预测有更丰富的数据视角。

**对应文档**：[01-memory-layers-and-containers.md](./01-memory-layers-and-containers.md) + [03-runtime-mechanisms.md](./03-runtime-mechanisms.md) 第 8 节

---

## 七、总结

OpenHuman 的核心价值是**"两层数据视图（树形压缩 + 文件镜像）+ 用户可直接编辑"**。

banto 应该吸收的是 **数据层的设计哲学**（摘要折叠、软引用、文件镜像、热度信号），保留的是 **产品层的差异化定位**（三大容器映射、三重职能、支撑体系联动）。

两者的核心冲突点只有一个：**树形分层 vs 平铺四层**。建议折中——banto 保留四层平铺作为"容器边界"，在每一层内部引入"原始 / 摘要"两子层作为"数据折叠"。

最值得引入的单个机制是 **Obsidian Wiki vault 镜像**——这能让 banto 从"封闭的桌面应用"变成"用户拥有数据所有权的协作系统"，是值得在 v0.6 决策清单中新增第 10 项的设计。

---

## 来源引用

- README.zh-CN.md — `https://github.com/tinyhumansai/openhuman/blob/main/README.zh-CN.md`
- Memory Tree 架构文档 — `https://tinyhumans.gitbook.io/openhuman/developing/architecture/memory-tree`
- Obsidian Wiki 功能文档 — `https://tinyhumans.gitbook.io/openhuman/features/obsidian-wiki`
- 源码位置 — `src/openhuman/memory_tree/`、`memory_store::trees`
- 灵感来源 — Karpathy 的 obsidian-wiki 工作流推文、`github.com/rohitg00/agentmemory`

---

## 附录：记忆树 + Obsidian Wiki 深度分析

> 本附录基于第二轮深挖完成，重点回答用户提出的"具体到 banto 应该怎么吸收"层面的问题。

### A. 记忆树：从用户视角看它解决了什么

OpenHuman 的记忆树本质上是一种 **"金字塔式压缩"**：

```
                    [Lₙ 顶层摘要]              ← agent 首先看到的入口
                       ↓ 下钻
                  [L₁ 段摘要 × N]
                       ↓ 下钻
            [L₀ 原始 Markdown 片段 × N×M]      ← 真正的事实
```

它解决的不是"如何存得多"，而是 **"如何在面对海量数据时让 agent 先看摘要再下钻"**。

**关键设计选择**：

| 选择 | OpenHuman 的取舍 |
|---|---|
| 摘要谁生成 | LLM 生成（chat 模型 + 固定 prompt + token 预算） |
| 何时生成 | bucket 满 / TTL 到期（partial seal） |
| 摘要如何检索 | 三种 query 工具（`query_source/global/topic`）+ 通用 `walk` / `drill_down` |
| 摘要是否可信 | 通过 frontmatter 溯源，agent 可下钻验证 |
| 摘要错了怎么办 | 用户在 Obsidian 里编辑修正 |

**对 banto 的启示**：

banto 当前没有"摘要"机制——所有记忆条目都是平等的"原始事实"。当一个 Project 积累 100+ 条记忆时，全量注入会爆炸，按 confidence 排序又会丢失关联上下文。

**建议的 banto 改造方向**（不是直接抄 OpenHuman）：

> banto 不需要无限层级，**两层够用**：
> - **L0：原始记忆节点**（保留当前 4 类型 + 5 类关系 + Why/How to apply）
> - **L1：项目摘要节点**（chat-end 三阶段的"阶段 1.5"自动生成，按时间维度 / 主题维度 / 容器维度三种视角）

这样既不破坏 banto 当前的图谱设计（节点 + 关系 + edges/），又解决了"项目记忆膨胀后如何召回"的问题。

### B. Obsidian Wiki：从用户视角看它解决了什么

OpenHuman 的 Wiki vault 解决的是 **"信任与可纠错性"**。

核心场景：
> "如果 agent 把客户偏好记错了，用户怎么办？"

| 方案 | 用户体验 |
|---|---|
| 黑箱嵌入 / 向量库 | 用户不知道存了什么，错了也无从修改 |
| 应用 UI 内编辑 | 用户能改，但效率低、不能跨工具 |
| **OpenHuman 方案：本地 .md vault** | 用户可用 Obsidian / VS Code / 任何编辑器直接打开改正 |

**Vault 与主存储的关系**（关键）：

OpenHuman 的设计是 **"vault 是主存储本身"**——agent 推理用的 chunk 与磁盘 .md 是同一份。这是激进设计。

banto 如果照搬，会破坏 md+json 双存的结构化优势。**建议改造方向**：

> banto 应该把 Vault 作为 **"导出视图 / 协作视图"**，而不是主存储：
> - **主存储**：保持 banto 当前的 md+json 双存（`nodes/` + `edges/` + `indexes/`）
> - **Vault 视图**：在 `userData/banto-vault/` 下生成扁平的 .md 文件镜像，使用 `[[wikilink]]` 互链
> - **同步规则**：主存储 → Vault 单向同步（每次 chat-end 后批量更新）；用户在 Vault 编辑后通过文件监听检测变更，触发"用户修订"流程让用户确认是否同步回主存储

这样既保留了 banto 的结构化能力，又获得了 OpenHuman 的"可编辑、可纠错"价值。

### C. Auto-Fetch 调度器（OpenHuman 新发现）

补充一个之前未深挖的重要机制 —— OpenHuman 的 Auto-Fetch 是 **"全局单调度器 + per-provider 节奏 + 日预算"**：

| 机制 | 实现 |
|---|---|
| 全局 tick | 每 20 分钟触发一次单一调度器（非每连接独立任务） |
| sync_state | 按 `(toolkit, connection_id)` 维度，含 `last sync` / `daily budget` / `dedup set` / `cursor` |
| 重启恢复 | 从本地 KV 重建状态，漏一次周期无影响 |
| 错误处理 | 仅记录吞掉，绝不 panic 跳出主循环 |
| 与 webhook 协同 | 事件驱动同步会写入同一 `sync_state`，避免调度器重复触发 |
| 节奏调优 | 全局从 60 秒调整到 20 分钟（减轻前台负载） |

**对 banto 的启示**：

banto 当前是 **任务驱动**（用户主动发起），没有 Auto-Fetch 概念。但 banto 的 **自动化容器（定时任务）** 本质上就是类似机制。

OpenHuman 的设计可以指导 banto 自动化记忆的演化：

| OpenHuman 概念 | banto 自动化容器对应 |
|---|---|
| 全局 tick | banto 调度器 |
| sync_state | 自动化记忆中的 `execution-log` 节点 |
| daily budget | 自动化任务的执行配额 |
| dedup set | 防止同一任务重复触发的去重机制 |
| cursor | 增量同步的游标（如"上次处理到哪封邮件"） |

**建议**：banto 自动化记忆层应该借鉴 OpenHuman 的 sync_state 模型，存储这些字段。

### D. 三种 TreeKind 对 banto 的启示

OpenHuman 的 `Source / Global / Topic` 三视角对应到 banto 应该是什么？

| OpenHuman | banto 类比 |
|---|---|
| **Source 树** — 按数据来源（Gmail 树、Slack 树） | banto 的 **连接器视角**（每个 MCP 连接器一棵摘要树） |
| **Global 树** — 按时间维度（每日/每周摘要） | banto 的 **时间视角**（每周工作回顾、每月项目总结） |
| **Topic 树** — 按实体（客户、项目、人物） | banto 的 **项目/专家视角**（每个 Project 一棵摘要树、每个专家关联的记忆树） |

**对 banto 的设计意义**：

banto 的"摘要节点"不应该只有一种生成方式，应该按这三种视角分别生成：

- **时间视角**："本周你在 Project A 上做了 X、Y、Z 决策"
- **主题/项目视角**："Project A 至今的所有关键决策按主题归类"
- **连接器视角**："本周通过 Linear 连接器同步的所有任务"

这能让"优化未来"职能的工作预测更精准——不同视角支持不同类型的预测：

- 时间视角 → 周期性预测（如周报、月度回顾）
- 主题视角 → 项目演化预测（如下一里程碑）
- 连接器视角 → 系统级预测（如外部任务变更）

### E. 推断：OpenHuman 的"hotness 信号"如何工作

虽然 OpenHuman 没公开公式，但从设计目标"warm content surfaces first"可以推断：

```
hotness = f(
  最近访问时间（recency）,
  访问频率（frequency）,
  用户显式标记（explicit signal）,
  关联实体的活跃度（associated entity heat）
)
```

**与 banto 的对比**：

banto 当前召回主要靠 `confidence`（置信度）。但 confidence 高 ≠ 当下相关。例如：
- 一年前的项目决策 confidence=0.95，但与当前任务无关
- 上周的 feedback confidence=0.75，但是当前最相关的

**建议**：banto 召回排序应该是 `hotness × confidence` 复合分：

```
召回得分 = α × hotness + β × confidence + γ × 当前任务相关性
```

具体权重等细化阶段再定，但**方向是明确的**：confidence 一票否决在 v0.6 中需要被复合排序替代。

### F. 5 个新增 banto 设计建议（深挖后）

基于这次深挖，新增 5 个值得纳入 v0.6 的设计点（与之前主报告的 5 项建议互补）：

| # | 建议 | 落点 |
|---|---|---|
| **F1** | **L0 + L1 两层结构**：项目记忆下增加 L1 摘要节点，按"时间/主题/容器"三视角生成 | 决策 1（四层记忆模型） + 决策 6（chat-end 流程） |
| **F2** | **Vault 作为导出视图**：主存储不变，新增 `userData/banto-vault/` 单向导出 + 双向编辑同步 | 决策 10（新增）|
| **F3** | **复合召回排序**：hotness × confidence × 任务相关性，替代单一 confidence 排序 | 决策 5（置信度阈值） + 决策 8（按需检索）|
| **F4** | **自动化记忆借鉴 sync_state 模型**：每个定时任务的记忆节点存储 last sync / dedup set / cursor / budget | 决策 1（自动化记忆隔离细化）|
| **F5** | **TTL Flush 机制**：会话短没满 bucket 时，TTL 到期也触发整理，避免会话切换后信息积压 | 决策 6（chat-end 异步执行细化）|

### G. 不同于主报告 7 类启发的"反向警示"

深挖后发现 OpenHuman 也有些 banto 不该学的东西，比第一轮主报告的"E 类风险"更具体：

**警示 1：OpenHuman 摘要"不可逆"**

bucket seal 后原始 L0 叶子是否还能查？文档说 `fetch_leaves` 可以拉，但需要从 `query_*` 找到摘要节点再下钻。如果摘要节点被进一步折叠到 L2，L0 还能 trace 到吗？文档不清晰。

**banto 应避免**：摘要必须永久保留对原始节点的反向链接，且原始节点不能因为被折叠而消失或归档。

**警示 2：OpenHuman 缺少"决策回溯链"**

OpenHuman 的关系层只有 `[[wikilink]]`（弱链接），没有 banto 这种 5 类有语义的边。结果是：用户能看到"决策 A 引用了笔记 B"，但看不到"决策 A 是因为约束 X 导致的"。

**banto 应保留**：`derives_from` / `conflicts_with` / `depends_on` / `supersedes` / `references` 5 类关系是 banto 的差异化优势，**绝不能为了"对齐 Obsidian"而退化为单一链接**。

**警示 3：OpenHuman 没区分"客观事实"和"用户主观偏好"**

OpenHuman 把所有数据扔进同一棵树。banto 当前的 4 类型（user/feedback/project/reference）有明确语义边界。

**banto 应保留**：4 类型边界即使在引入摘要折叠后也不能模糊。L1 摘要节点应该按类型分别生成（如"本周用户偏好摘要"、"本周项目决策摘要"），而不是混合摘要。

---

## 附录总结

OpenHuman 的两个核心设计（Memory Tree + Obsidian Wiki）背后的设计哲学是 **"分层压缩 + 文件镜像 + 用户可编辑"**。

banto 应该吸收的不是它的具体实现（树形 SQLite + Obsidian 双链），而是它的**设计哲学**：

| OpenHuman 哲学 | banto 落地方式 |
|---|---|
| 分层压缩（金字塔） | L0 + L1 两层（不是无限层级） |
| 多视角组织（Source/Global/Topic） | 时间/主题/容器三视角生成摘要 |
| 文件镜像（vault 是主存储） | Vault 作为导出视图（主存储仍是 md+json） |
| 用户可编辑（"AI 错了用户改文件"） | Vault 编辑触发"用户修订"流程 + 主存储仍受结构化保护 |
| 热度信号（warm first） | hotness × confidence 复合召回 |
| 全局调度（auto-fetch） | 自动化记忆借鉴 sync_state 模型 |

**核心结论**：OpenHuman 给 banto 的最大启发是 **"记忆体系应该让用户能看见、能修改、能信任"**。这一点 banto 当前 v0.6 做得还不够——所有操作都封装在 UI 里，用户既看不见全局，也不能批量修改。

**最值得新增的单个决策**：**决策 10 — 引入 Vault 作为用户可编辑的导出视图**。这是把 banto 从"封闭桌面应用"升级为"用户拥有数据所有权的协作系统"的关键一步。