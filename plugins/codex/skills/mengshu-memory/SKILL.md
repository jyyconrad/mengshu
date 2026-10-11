---
name: mengshu-memory
description: Codex wrapper for Mengshu governed memory. Follow the shared mengshu skill for 5type rules, default MCP tools, and fail-closed behavior.
---

# Mengshu Memory（Codex）

跨产品用法真源：仓库根目录 [`.agents/skills/mengshu/SKILL.md`](../../../../.agents/skills/mengshu/SKILL.md)（skill name: `mengshu`）。

本包装仅补充 Codex 插件事实：

- MCP 由 `plugins/codex` 以 `MENGSHU_MCP_MODE=standalone` 拉起；默认工具面还受 `MENGSHU_MCP_TOOL_MODE`（建议 `default`）约束。
- 共享家目录：`~/.mengshu`（`config.json` + `authority.json`）。
- 项目：`ms init` 只建 workspace/project 指针；访问库仍需产品 authority。
- 启动前：`ms doctor`；解释：`memory_explain`（含 `lastDecision`）或 `ms why`。
- 压缩前 / 任务收尾：按共享 skill 的会话钩子表 flush 已验证 5type，勿整段 transcript 入库。

**必须遵守共享 skill 中的**：选用顺序、5type 写入/召回、禁止编造、fail-closed 话术。
