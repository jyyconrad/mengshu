# 架构设计

本目录记录 memory-autodb 的系统架构、长期方案和架构评审。阅读时先区分当前实现、方案设计和外部参考。

## 当前真源

| 文档 | 状态 | 说明 |
|------|------|------|
| [memory-middleware-architecture.md](./memory-middleware-architecture.md) | 当前架构方案 | MemoryService、adapter、REST/MCP/SDK、ingestion、retrieval、graph/tree、console 的中间件化架构 |
| [memory-autodb-deep-optimization-architecture.md](./memory-autodb-deep-optimization-architecture.md) | 长期优化方案 | 5 问题、5 type、SlotSnapshot、候选治理、图谱和记忆树路线 |
| [architecture-review-v2.md](./architecture-review-v2.md) | 架构评审 | 对深层优化方案的可行性和阶段边界评审 |
| [system-architecture.md](./system-architecture.md) | 基线架构 | OpenClaw 插件和中间件演进后的模块总览 |
| [technology-stack.md](./technology-stack.md) | 当前技术栈 | 依赖、运行时、数据库和 embedding 模型 |

## 参考材料

| 路径 | 状态 | 使用方式 |
|------|------|----------|
| [copy-from-mate/](./copy-from-mate/) | 外部参考 | Banto/iFlyMate 记忆系统设计输入，不是 memory-autodb 当前实现承诺 |
| [../UPGRADE-v3.0-graph-requirements.md](../UPGRADE-v3.0-graph-requirements.md) | 历史需求 | v3.0 图谱检索升级需求，保留用于追溯 |
| [../UPGRADE-v3.0-technical-plan.md](../UPGRADE-v3.0-technical-plan.md) | 历史方案 | v3.0 技术升级方案，后续以当前架构文档为准 |
| [../AUTODB-FULL-DOC.md](../AUTODB-FULL-DOC.md) | 历史完整说明 | 旧 AutoDB provider 说明 |
| [../PORT-TO-HERMES.md](../PORT-TO-HERMES.md) | 移植方案 | Hermes 移植参考 |

## 维护规则

- 当前实现变化优先更新 `memory-middleware-architecture.md`。
- 未来路线或评审结论优先更新 `memory-autodb-deep-optimization-architecture.md` 和对应评审文档。
- `copy-from-mate/` 下内容默认保持参考材料身份，除非明确把其中结论吸收到当前方案。
