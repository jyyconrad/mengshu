# mengshu（梦枢）文档

> 面向多产品 Agent Runtime 的本地优先记忆中间件

## 快速开始

- [安装配置指南](guides/getting-started.md) - 快速安装和配置
- [CLI 命令参考](api/cli-commands.md) - 命令行工具使用

## 核心文档

### 架构设计
- [系统架构](architecture/system-architecture.md) - 整体架构设计
- [技术栈](architecture/technology-stack.md) - 技术选型说明
- [项目目录层级与包结构重构方案](architecture/project-structure-refactor-plan.md) - core/plugins/mcp/api/ui/tests 分层与迁移路线
- [多产品插件化实施方案](architecture/plugin-packaging-implementation-plan.md) - plugins/ 目录、OpenClaw/Codex 插件包与迁移路线

### 核心设计
- [记忆系统统一设计](design/memory-system-unified-design.md) - 算法层单一事实来源
- [记忆树批量推理方案](design/memory-tree-batch-inference-plan.md) - 记忆树摘要、faithfulness judge 和结论生成的异步 Batch LLM 方案
- [数据库 Schema](design/schema.md) - 数据模型设计

### API 参考
- [CLI 命令](api/cli-commands.md) - ms 命令组完整参考
- [Memory API](api/memory-api.md) - REST API 接口规范

### 测试与评测
- [OpenClaw 历史数据评测集方案](07-test/openclaw-history-eval-plan.md) - 用真实 OpenClaw 历史验证提取、召回、上下文注入和记忆树能力

## 用户指南

- [配置说明](guides/configuration.md) - 配置文件详解
- [集成指南](guides/integration.md) - 如何集成到你的项目
- [最佳实践](guides/best-practices.md) - 使用建议

## 项目信息

- 当前版本：v1.0.2
- 开源协议：MIT
- 仓库地址：[GitHub](https://github.com/your-org/mengshu)

---

**内部开发文档**见 `.memory-docs/original-docs/`，包含完整的设计过程、测试用例、缺陷记录等。
