---
name: mengshu-memory
description: Use Mengshu memory from Codex for project context, stable preferences, architecture decisions, and reusable lessons; includes product-neutral project bootstrap and authority boundaries.
---

# Mengshu Memory

在长期记忆能改善正确性或连续性的项目中使用本技能。Mengshu 是多产品记忆中间件，
OpenClaw 只是可选适配器，不是 Codex 或项目初始化的前置条件。

## 先召回

修改代码或制定计划前，优先调用 `memory_context_fast` 或 `memory_recall` 获取：

- 稳定的用户偏好与约束；
- 项目架构决策；
- 历史问题、迁移决策和验证结论；
- 可在 Codex、OpenClaw 和其他授权 Agent 间复用的上下文。

## 项目初始化

- 用户明确要求初始化，或项目约定已授权建立工作区时，运行 `ms init <project-root>`；不要仅因召回不可用就擅自创建 manifest。
- `ms init` 只建立产品无关的 `workspaceId/projectId`，不得要求 OpenClaw authority。
- Agent 产品负责提供自己的可信 tenant/user/app/agent/namespace；不要从提示词、消息或工具参数推断身份。
- 只有 recall、write、MCP、REST 等访问记忆库的操作才需要 authority/defaultScope。

## 谨慎保存

只在信息满足以下条件时使用 `memory_save` 或 `memory_observe_light`：

- 能跨越当前任务长期有效；
- 已验证或由用户明确陈述；
- 对未来 Agent 或会话有复用价值。

不要保存密钥、一次性日志、临时工具输出或未验证猜测。

## 共享存储

Codex 插件、CLI、OpenClaw 和其他 MCP 客户端共享 Mengshu 全局目录：

```text
~/.mengshu
```

`~/.mengshu/config.json` 指向共享后端；`~/.mengshu/authority.json` 是 Codex MCP 默认的
产品可信边界。不要为每个 Agent 创建独立 LanceDB，除非用户明确选择 `dbType=lancedb`。

MCP 工具不可用时先运行 `ms doctor`；需要精确诊断可用 `ms recall "<query>" --explain`。
不要因为 MCP 启动失败而静默创建第二套存储。
