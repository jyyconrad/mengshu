---
name: mengshu
description: Use Mengshu local governed memory for coding/work Agents—5-slot context_fast, typed writes (profile/task_context/rules/experience/resource), fail-closed authority. Prefer before planning or changing code when preferences, constraints, or prior lessons matter.
---

# Mengshu 用法 Skill（编码 / 工作 Agent）

mengshu 是**本地治理记忆中间件**，不是通用「随便记一笔」的笔记 API，也不是 Agent 内嵌文件系统。  
写入走 **authority → validator → admission**；模型可以建议，**不能单独裁决入库**。

## 何时启用

在以下情况**主动**使用本 skill：

- 改代码、定方案、排障前，需要项目约束 / 历史决策 / 可复用教训；
- 用户明确说出偏好、禁令、里程碑、或「以后都要…」；
- 跨会话连续性（同一 `projectId` 下的工作记忆）；
- 用户问「为什么没记住 / 为什么被拒绝」→ 用 `memory_explain`。

不要在无关闲聊、一次性日志、密钥/token、未验证猜测上调用写入工具。

## 默认 MCP 工具（选用顺序）

默认 List 受 `MENGSHU_MCP_TOOL_MODE` 控制（默认 `default`）。完整面：`full`。隐藏工具可用 `memory_tools_discover` 查看，仍可按精确名调用。

| 顺序 | 工具 | 用途 |
|------|------|------|
| 1 | `memory_context_fast` | 任务启动拉 **5 槽位**上下文（优先） |
| 2 | `memory_recall` / `memory_lookup` | 槽位不够时按查询深挖 |
| 3 | `memory_save` / `memory_observe` | 确认后的 governed 写入（须带 `semanticType`） |
| 4 | `memory_explain` | 争议或被拒时：已存 why / 候选 dry-run / **`lastDecision` 落库收据** |
| 5 | `memory_observe_light` | 运行中轻量观察 / 证据（异步抽候选；非直接当事实） |
| 6 | `memory_forget` | 用户明确要求撤销/归档/删除时（须 `idempotencyKey`） |
| — | `memory_health` / `memory_namespaces` | 探活与命名空间 |
| — | `memory_tools_discover` | 列出当前 mode 未广告的工具 |

目录扫盘、evolve、ingest、working set 不在 default List。目录入库用 CLI `ms scan`：默认 dry-run，不写库；`--apply` 才经 admission 写入。Skill artifact 只在 discover/full 列出，没有可执行 runner。

**推荐启动序列**

1. `memory_context_fast`（`task` = 当前任务一句话）  
2. 若某槽为空且任务确实需要该类信息 → `memory_recall` / `memory_lookup`。空结果看 `recallStatus`：`ok-empty` / `authority-filtered` / `not-ready`，都不要编造记忆。  
3. 仅当信息已验证或用户明示保存 → `memory_save` / `memory_observe`（带 5type）  
4. 写入被拒或用户质疑 → `memory_explain`

## 5type 写入规则（强制）

每条 governed 写入必须标注 `semanticType`，且只能是：

| semanticType | 记什么 | 不要记 |
|--------------|--------|--------|
| `profile` | 跨情境协作偏好（表达习惯、默认语言等） | 人格推断、单次情绪、隐私敏感标签 |
| `task_context` | 当前项目目标、阶段、范围、里程碑 | 无项目归属的空泛目标 |
| `rules` | 稳定约束 / 禁令 /「必须、总是、默认」 | 一次性临时要求（应落 task_context 或 experience） |
| `experience` | 带因果的已发生教训（因为/导致/修复） | 纯结果流水、缺 why 的闲聊 |
| `resource` | 可复用入口：文档、命令、服务、链接 | 无定位信息的「好像有个文件」 |

补充：

- `profile` 须可落到协作偏好维；不确定时先 `memory_explain` dry-run，或改标 `rules` / `experience`。  
- 缺因果的「经验」降为 `task_context`，不要硬标 `experience`。  
- `memory_observe_light` 产出的是观察/候选，**不是**已准入事实；引用前先 recall/context。

## 5type 召回规则

- 优先信 `memory_context_fast` 的结构化 `slots`：键名固定为五 type。  
- **空槽**（`nodeCount === 0` 且可能有 `empty_slot: …`）表示「该类暂无活跃记忆」或被策略过滤，**不是** MCP 失败。  
- Prompt 注入会跳过空槽；不要为填满五槽而编造内容。  
- 需要证据链时用 `memory_lookup` / `memory_explain`，不要臆造 `memoryId`。

## 禁止事项

- 禁止编造记忆正文、id、provenance、admission 结果。  
- 禁止把候选区 / observe_light 结果当成已 active 事实执行。  
- 禁止为「显得有记性」而写入密钥、token、隐私、一次性构建日志。  
- 禁止在无 authority / 用户未授权时擅自 `ms init` 扩大范围或绕过 fail-closed。  
- 禁止假设 LanceDB-only 拥有与 Postgres 同等的治理 capability。

## 会话 / Compact 钩子（推荐触发）

| 时机 | 动作 |
|------|------|
| 开任务 / 会话开始 | `memory_context_fast` |
| 宿主即将压缩长上下文 | 仅 flush 已验证 5type → `memory_observe` / `memory_save` |
| 任务完成 / 会话结束 | 同上；不要整段 transcript 入库 |
| 写入被拒 | `memory_explain({ lastDecision: true })` 或 candidate dry-run |

**被动写入纪律**

- 载荷最小字段：`trigger`、`runId`、`sessionId`、`projectId`、`user`；可选 `transcriptSummary`。缺字段则 skip，记下 reason，**不编造字段、不写库、不阻断回合**。
- 只写已验证 5type；不要 dump 整段 transcript；不要静默 ADD。
- 同一 session + 内容哈希已由 MCP 写过则不要再 hook 写一遍。
- 密钥 / token / 隐私仍走上面的禁止事项。
- OpenClaw 真实事件：`before_prompt_build`（召回）、`agent_end`（捕获）。`registerMemoryFlushPlan` 保持 `null`，不要发明 flush-plan。
- Codex / Claude Code / Cursor 无原生 PreCompact：按本表用 MCP。

详见 [agent-session-hooks.md](../../docs/guides/agent-session-hooks.md)。

## Fail-closed 要点（对用户怎么说）

| 情况 | Agent 行为 |
|------|------------|
| 缺 `MENGSHU_AUTHORITY_*` / authority 无效 | 不假装写入成功；提示配置 authority 文件 |
| `dbType=lancedb`（或无 Postgres capability） | 说明部分治理能力不可用（temporal / working set / skill / durable job / continuous evolution 等）；引导 quickstart 一键 Postgres |
| admission / validator 拒绝 | 用 `memory_explain` 展示原因码；按 5type 规则改写后再试 |
| MCP 工具极少 | 先 `memory_health`；再 `memory_tools_discover`；需要全量时请用户设 `MENGSHU_MCP_TOOL_MODE=full` |

详情：`docs/guides/local-agent-memory-quickstart.md`。

## 安装

仓库内路径：`.agents/skills/mengshu/`（本文件）。

```bash
# Codex 示例（按你的 Agent skills 根目录调整）
mkdir -p ~/.codex/skills
ln -sfn /path/to/mengshu/.agents/skills/mengshu ~/.codex/skills/mengshu
```

Codex 插件内另有 `plugins/codex/skills/mengshu-memory`（产品包装）；**以本 `mengshu` skill 为跨产品用法真源**。

## 最小口令（给自己）

1. 先 `context_fast`，再动手。  
2. 写入必带 5type；不确定就 `explain` dry-run。  
3. 空槽 ≠ 故障；编造 = 违规。  
4. 治理失败要说清，不装成功。
