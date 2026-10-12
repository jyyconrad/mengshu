# 目录扫描：`ms scan`

`ms scan` 把一个目录里的 Markdown 收成可审计的入库提案。它默认是 dry-run：只读文件、出报告，不写数据库。只有 `--apply` 才会把已经通过准入预览的提案送进记忆写入内核。

这不是回合内召回，也不是进化批次。Agent 回合里用 MCP；目录入库用本命令。

## 和 `ms evolve scan` 的边界

| | `ms scan <directory>` | `ms evolve scan --source-id <id>` |
|---|---|---|
| 输入 | 文件系统目录 | host 已注册的来源 id，不接受目录路径 |
| 默认 | dry-run，不写库 | preview，不改 canonical |
| 写入 | `--apply`，走记忆写入内核的 admission | `--apply-allowed`，走进化批次门禁 |
| 文件 | 本阶段只读 `.md` / `.mdx` | host 来源自己声明的 Markdown 或 JSONL |
| 5type | 报告标注，错标在准入里拒绝 | 不由本命令标注 |

`--help` 与上表一致：`ms scan --help` 写明 dry-run 不写库；`ms evolve scan --help` 写明它不是目录路径。

## 怎么跑

先看报告：

```bash
ms scan ./docs
ms scan ./notes --ignore ignored.md dist --ignore-rule "*.draft.md"
ms scan ./notes --json
```

确认报告后再入库：

```bash
ms scan ./notes --apply --category 知识库
```

`--dry-run` 与 `--apply` 不能同时给。不带 `--apply` 时就是 dry-run。

## 报告里有什么

- 文件数和扩展名分布。`.txt`、代码和结构化文件不进入提案。
- 5type 标注：`profile`、`task_context`、`rules`、`experience`、`resource`。来源可以是 frontmatter、路径，或未标注时的 `resource`。
- 拟写入的 semanticType 分布。这里只统计 dry-run 认为可以送去写入的提案，并且用准入校准后的类型。
- 拒绝预览：缺类型、非法类型、正文过短、profile 维度不在白名单、以及 admission 给出的 `drop`。
- 指纹和去重。同一规范化正文只保留路径排序后的第一条。

frontmatter 示例：

```markdown
---
semanticType: profile
profileDimension: language
---
以后都用简体中文回答。
```

`semanticType` 必须是上面五个值之一。写成别的值会标成无效并拒绝，不会偷偷改成另一个类型。`profile` 还必须带白名单维度：`language`、`response_style`、`verification_preference`、`planning_preference`、`risk_boundary`、`domain_focus`。

路径里的目录或文件名也会提示类型，例如 `rules/policy.md` 标成 `rules`。没有这些线索的 Markdown 标成 `resource`。

## dry-run 为什么不写库

dry-run 不创建数据库 runtime，也不调用写入器。预览走 `explainAdmissionCandidate`：同一套候选校验和 admission 路由，intent 按显式 `--apply` 将要使用的 `remember`，时效按 `persistent`，scope 按 `project` 估计。

它不读已有记忆，也不算 embedding 相似度，所以 evidence / novelty 按未知处理。报告里的 `route=active` 只是准入路由；真正入库时 `observeAuto` 不会把这类结果存成 active，报告里的 `persistedRoute` 会写成 `candidate`。

## `--apply` 怎么入库

`--apply` 需要 server authority（`MENGSHU_AUTHORITY_JSON` 或 `MENGSHU_AUTHORITY_FILE`）。没有 authority 时命令在读配置和开库之前失败。

有 authority 之后，每条预览通过的提案作为 `observeAuto` + `intent: remember` 进入记忆写入内核。内核会再跑一遍校验、admission、去重和收据。预览被拒绝、重复或 `drop` 的提案不会送进去。写入能力不存在时（例如没有 Postgres 写入内核）命令直接拒绝，不会退回旧的目录灌库路径。

内核仍可能拒绝、丢弃或判重。这不是 dry-run 失手，而是入库时用了权威信号再裁一次。

`--category` 只在 `--apply` 时决定表和分类，默认 `知识库`。它不改变 authority 给出的 scope。

## 文件类型

本阶段只加强 `.md` / `.mdx` 和报告。代码、JSON、表格等放到下一阶段，而且到时候仍然要过同一套 admission，不会因为文件变多就绕过治理。

`--chunk-size` 把长正文切成多条提案。每条仍单独准入，不把切块当成绕过闸门的办法。
