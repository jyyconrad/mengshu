# 编码 Agent 会话 / Compact 钩子（推荐触发）

目标：在**不发明宿主假 API**的前提下，让会话开始、压缩前、任务完成、会话结束时，记忆召回/落库按同一套建议执行。

真源推荐表见 `packages/core/src/runtime/agent-session-hooks.ts`（`recommendAgentSessionHook`）。

## 触发与动作

| 触发 | 建议 MCP 动作 | OpenClaw 真实事件 | Codex / Claude Code / Cursor |
|------|---------------|-------------------|------------------------------|
| `session_start` | `memory_context_fast` → 必要时 `memory_recall` | `before_prompt_build` / `before_agent_start` | Skill 指引：开任务先 context_fast |
| `pre_compact` | `memory_observe` / `memory_save`（仅已验证 5type） | **无稳定 flush-plan 形状**：`registerMemoryFlushPlan` 已注册但返回 `null` | Skill：压缩/摘要前先 flush 耐久结论 |
| `task_complete` | `memory_observe` / `memory_save` | `agent_end`（同轮结束） | Skill：任务收尾时写入 experience/rules |
| `session_end` | `memory_observe` / `memory_save` | `agent_end` | Skill：会话结束前捕获偏好/决策 |

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
