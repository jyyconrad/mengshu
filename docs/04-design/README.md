# 详细设计

本目录把架构方案拆成模块设计、实施计划和可落地的工程细节。这里回答“怎么实现”和“改代码前要遵守什么边界”。

## 目录结构

| 目录 | 用途 |
|------|------|
| [04.1-overview](./04.1-overview/) | 模块级设计和交互说明 |
| [04.2-detail](./04.2-detail/) | 具体功能、算法、数据结构和实施计划 |

## 当前文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [04.1-overview/memory-plugin-design.md](./04.1-overview/memory-plugin-design.md) | 当前 | OpenClaw 插件工具、钩子、CLI 和中间件边界概览 |
| [04.1-overview/web-console-design.md](./04.1-overview/web-console-design.md) | 方案 | Web Console 信息架构和交互设计 |
| [04.2-detail/next-iteration-product-plan.md](./04.2-detail/next-iteration-product-plan.md) | 下一迭代方案 | 基于当前代码的跨产品 Agent Runtime 记忆闭环方案 |
| [04.2-detail/memory-middleware-development-plan.md](./04.2-detail/memory-middleware-development-plan.md) | 实施计划 | mengshu 中间件化分阶段任务 |
| [04.2-detail/structured-knowledge-graph-memory-tree-detail.md](./04.2-detail/structured-knowledge-graph-memory-tree-detail.md) | 方案 | 图谱与记忆树详细设计 |
| [04.2-detail/memory-algorithm-design.md](./04.2-detail/memory-algorithm-design.md) | 主方案草案 | 整合记忆算法与 LLM 执行规格，把理论依据落到可执行的输入契约、schema、评分、去重、冲突、树构建、召回和 eval |
| [04.2-detail/memory-algorithm-llm-execution-spec.md](./04.2-detail/memory-algorithm-llm-execution-spec.md) | 草案 | 记忆提取、去重、记忆树、召回和 LLM 执行边界的算法化规格 |
| [04.2-detail/theory-to-algorithm-extraction-spec.md](./04.2-detail/theory-to-algorithm-extraction-spec.md) | v0.2 | 把行为心理学理论转换成可执行的提取提示词、判断基准、评分函数与去重算法（已就 9 项决策定调） |
| [04.2-detail/agent-history-import-profile-project-tree.md](./04.2-detail/agent-history-import-profile-project-tree.md) | 方案 | Claude Code / Codex 历史记忆和工作日志导入、用户画像与项目记忆树构建方案 |
| [04.2-detail/auto-capture-recall-detail.md](./04.2-detail/auto-capture-recall-detail.md) | 当前 | 自动捕获和自动召回设计 |
| [04.2-detail/directory-scanner-detail.md](./04.2-detail/directory-scanner-detail.md) | 当前 | 目录扫描和 ingestion pipeline 设计 |
| [04.2-detail/storage-architecture-detail.md](./04.2-detail/storage-architecture-detail.md) | 当前 | legacy 多表存储和中间件 core record 的设计 |

## 维护规则

- 设计文档要明确“已实现”“方案中”“延后”。
- 涉及外部 API、CLI 或数据库字段时，同步更新 `../05-api/` 和 `../06-database/`。
- 实施计划完成后，把实际结果写入 `../09-changelog/`，不要只保留过程报告。
