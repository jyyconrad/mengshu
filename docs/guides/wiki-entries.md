# Wiki 双轨：融合页（Track F）与条目素材（Track E）

本页是本机 `~/.mengshu/wiki/USAGE.md` 里应补的 Track E 附录，放在仓库指南中。不要改写本机 `USAGE.md`、`pages/**/page-*.md` 或同名 `.sources`。融合页的维护步骤仍以那份 USAGE 为准；本页只说明 Agent 怎么读、两条轨道怎么分。

配置字段见 [configuration.md](./configuration.md)。用法入口见 [local-agent-memory-quickstart.md](./local-agent-memory-quickstart.md) 与 [`.agents/skills/mengshu/SKILL.md`](../../.agents/skills/mengshu/SKILL.md)。

## 权威

| 面 | 用途 |
|----|------|
| 数据库（memories / knowledge） | Agent 的 record of record：召回、打分、authority、forget、结构化读写 |
| Track F：`pages/<slug>/page-NNN.md` | 离线治理的知识融合正本（USAGE 原意） |
| Track E：`pages/<slug>/entries/...` | 同树下的条目素材、导航和审核面。不是新的唯一融合正本，也不取代数据库 |

Wiki 文件写入失败不得回滚已经提交的记忆。缺文件时召回可以没有路径；不要把缺文件说成记忆没写上。

## `wiki.root`

- 配置键是 `wiki.root`。省略整个 `wiki` 对象时默认 `~/.mengshu/wiki`。
- 可以改成另一个绝对目录。`~` 会展开；相对路径会被拒绝。
- `metadata.wikiPath` 和召回里的地址都相对这个根，只用正斜杠，例如 `pages/default-knowledge/page-019.md`。
- 不要把绝对本机路径写进记忆，也不要把它当作 `memory_wiki_read` 的 `path`。

没有与 `pages/` 脱节的顶级 `material/` 树。kind 用既有 slug 表达，例如 `default-knowledge` 与 `default-memories`。

## Track F 与 Track E

| | Track F — 融合页 | Track E — 条目 |
|--|------------------|----------------|
| 路径 | `pages/<slug>/page-NNN.md` 与同名 `.sources` | `pages/<slug>/entries/<semanticType>/<id>.md` |
| 例子 | `pages/default-knowledge/page-019.md` | `pages/default-knowledge/entries/experience/<uuid>.md`；`pages/default-memories/entries/rules/<uuid>.md`；无 scope 时 `pages/__unscoped__/entries/unclassified/<uuid>.md` |
| 谁写 | 离线融合 / promote / 人工。热路径禁止改写 | 持久化成功之后的素材镜像 |
| ingest-wiki v1 | **只吃** `page-*.md` | **不**自动当作融合输入 |
| 风格 | 本机 `STYLE-GUIDE.md` | 不套用 STYLE-GUIDE |

`semanticType` 为 `profile`、`task_context`、`rules`、`experience`、`resource`，缺省为 `unclassified`。

已经指向 `pages/.../page-NNN.md` 的 knowledge 行，召回继续用这条 Track F 路径。热更新默认不改融合页，也不再复制一份 entries，以免同一条正文出现两份。

### STYLE-GUIDE 只约束 Track F

本机 `STYLE-GUIDE.md` 是融合页门禁，不是条目模板。Track F 的 frontmatter 恰好四个单行键：`scope_key`、`semantic_type`、`memory_form`、`tree_type`，并且每个 `page-NNN.md` 有同名 `.sources`。

Track E 不用这四键，也不写 `.sources`。一条数据库记录对应一个文件，最小键是：

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
```

正文以当前数据库行为准（素材镜像，不是融合稿）。

热路径禁止改：`page-NNN.md`、`.sources`、已经 `fused` 的 completion 行、`path-map.jsonl`、冻结 evidence。不要在对话里重跑 ingest-wiki，也不要接 Graphiti。

## Agent 怎么读

召回（`memory_recall`，以及 `ms recall`）可能带上相对 wiki 路径：文本模式一行 `wiki: pages/...`，raw 模式字段 `wikiPath`。Track F 与 Track E 都这样展示。没有路径就省略，不要编造。

要读文件：

| 入口 | 调用 | 读的是什么 |
|------|------|------------|
| MCP | `memory_wiki_read`，参数只有 `path` 和可选 `maxChars` | `wiki.root` 下任意相对 `.md` |
| CLI | `ms wiki read <relpath>`，可选 `--max-chars` | 同上；只读文件，不开数据库 |

允许规范化之后仍在根内的普通 `.md` 文件（融合页和条目都可以）。拒绝 `..`、逃出根目录的绝对路径、符号链接（含中间目录）、非 `.md` 和目录。

**`memory_wiki_read` 不是 `memory_knowledge_read`。**

- `memory_wiki_read` / `ms wiki read`：按相对路径钻取 wiki 文件。
- `memory_knowledge_read`：按 UUID `ref` + `revision` 读库内 knowledge 投影，受 authority 和截断约束。

二者互补，不能互相替代。默认 MCP 列表包含 `memory_wiki_read`；`memory_knowledge_read` 不在该列表里。
