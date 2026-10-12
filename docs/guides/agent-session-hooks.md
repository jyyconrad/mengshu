# 编码 Agent 会话 / Compact 钩子（推荐触发）

目标：在**不发明宿主假 API**的前提下，让会话开始、压缩前、任务完成、会话结束时，记忆召回/落库按同一套建议执行。失败可观测、不阻断回合。

真源：`packages/core/src/runtime/agent-session-hooks.ts`。

- 推荐动作：`recommendAgentSessionHook`
- 可调用入口：`parseSessionEvent` / `resolveSessionEvent` / `dispatchSessionEvent`
- 宿主映射表：`listSessionHookHostBindings`
- flush-plan：`sessionHookFlushPlan()` **恒为 `null`**

## 触发与动作

| 触发 | 建议 MCP 动作 | 种类 | OpenClaw 真实事件 | Codex / Claude Code / Cursor |
|------|---------------|------|-------------------|------------------------------|
| `session_start` | `memory_context_fast` → 必要时 `memory_recall` | 召回 | `before_prompt_build` / `before_agent_start` | Skill 指引：开任务先 context_fast |
| `pre_compact` | `memory_observe` / `memory_save`（仅已验证 5type） | typed capture | **无稳定 flush-plan 形状**：`sessionHookFlushPlan()` 返回 `null` | Skill：压缩/摘要前先 flush 耐久结论 |
| `task_complete` | `memory_observe` / `memory_save` | typed capture | 无单独事件。不要再派发一次 | Skill：任务收尾时写入 experience/rules |
| `session_end` | `memory_observe` / `memory_save` | typed capture | `agent_end`（只捕获这一次） | Skill：会话结束前捕获偏好/决策 |

## SessionEvent 载荷合同

可调用入口只接受这一组最小字段。缺字段则 **skip** 并记下 reason，不写库、不抛错阻断回合。

| 字段 | 必填 | 说明 |
|------|------|------|
| `trigger` | 是 | `session_start` / `pre_compact` / `task_complete` / `session_end` |
| `runId` | 是 | 本轮 / 本次运行 id |
| `sessionId` | 是 | 会话 id |
| `projectId` | 是 | 项目 id |
| `user` | 是 | 用户标识 |
| `transcriptSummary` | 否 | 已整理的结论摘要；**禁止**整段 transcript。解析时走 `redactSecrets`，密钥不会进 handler |

skip reason：`missing_trigger` / `unknown_trigger` / `missing_runId` / `missing_sessionId` / `missing_projectId` / `missing_user` / `handler_missing`。`duplicate_session_hash` 只在调用方传入的 `seen` 里生效，键是 `sessionId + trigger + runId + transcriptSummary`。它不查询 MCP，也不查询写入内核。没有对应 handler 时返回 `handler_missing`，不记成成功，也不占用去重键。失败原因同样脱敏。`agent_end` 只映射到 `session_end` 一次捕获。

`dispatchSessionEvent` 永不抛给宿主：handler 失败返回 `{ status: "failed", blocking: false, reason }`。

OpenClaw 原生 `before_prompt_build` / `agent_end` 仍走插件现有 auto-recall / auto-capture（宿主事件形状不同），不把缺字段的宿主事件硬套进 SessionEvent。Skill / 其它宿主用上述合同。

## 宿主映射表

| host | 触发 | 绑定 | 原生事件 | flush-plan |
|------|------|------|----------|------------|
| openclaw | `session_start` | native | `before_prompt_build` / `before_agent_start` | `null` |
| openclaw | `session_end` | native | `agent_end`（一次捕获） | `null` |
| openclaw | `task_complete` | skill-only | 无。任务结论放进同一次 `session_end` | `null` |
| openclaw | `pre_compact` | skill-only | 无 | `null` |
| codex / claude-code / cursor | 四个触发 | skill-only | 无 | `null` |

## 写入纪律

- 只写已验证 5type（`profile` / `task_context` / `rules` / `experience` / `resource`）。
- 不整段 transcript 入库；不静默 ADD；不发明 flush-plan 字段。
- 失败记日志 / 收据，不弹窗、不阻断回合。

## OpenClaw

已接线的真实 hook：

- 召回：`before_prompt_build`（新版本）或 `before_agent_start`（旧版本）→ auto-recall / context_fast
- 捕获：`agent_end` → auto-capture（受配置与 authority 约束）

`registerMemoryFlushPlan`：宿主暴露了注册点，但 OpenClaw 未在本仓库固化可移植的 plan object 合同，因此 mengshu **故意返回 `null`**，避免伪造字段。压缩前落库请走 Skill/MCP `pre_compact` 建议，或依赖 `agent_end`。

## Codex / Claude Code

本仓库插件包（`plugins/codex`、`plugins/claude-code`）通过 MCP + Skill 工作，**没有**与 FactMem `PreCompact` 对等的原生宿主钩子声明。请安装 `.agents/skills/mengshu`，在压缩上下文或结束任务前按上表调用工具。

## 与 admission 收据

写入主链会 best-effort 落 `admission decision receipt`（Postgres v39+ 耐久；LanceDB 仅进程内）。被拒或通过后可用：

```text
memory_explain({ lastDecision: true })
memory_explain({ candidateHash: "<hash>" })
```

## LanceDB 限制

| 能力 | LanceDB-only |
|------|----------------|
| 会话钩子建议 / Skill | 可用（与存储无关） |
| OpenClaw agent_end / before_prompt_build | 可用（若插件启用） |
| admission 收据耐久落库 | **不可用**（仅 in-memory last-decision） |
| memory_explain lastDecision 跨进程 | **不可用** |
