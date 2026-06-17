# memory-autodb v3.0 交付记录

> 状态：历史交付记录
> 日期：2026-06-08
> 当前文档入口：见 [docs/README.md](./docs/README.md)

本文保留 v3.0 架构升级的交付摘要。当前项目已经继续演进到 v4 memory middleware 基线；最新能力以 [README.md](./README.md) 和 [docs/09-changelog](./docs/09-changelog/README.md) 为准。

## 交付成果

### Milestone 1：Agent 快路径

- 5 问题语义协议：`profile`、`task_context`、`rules`、`experience`、`resource`
- `kind -> semanticType` 映射器
- SlotSnapshot 缓存和差异化 TTL
- Slot Context Builder
- Agent 快路径服务：context、observe、lookup、session commit
- OpenClaw tool：`memory_context_fast`
- REST API：`POST /v1/agent/*`

### Milestone 2：候选区

- `CandidateRecord` 状态机
- In-memory candidate repository
- Candidate review service
- 启发式 5 type extractor
- 自动淘汰机制

### 后续框架

- `MemoryEdge`、`GraphNode`、生命周期、container、visibility 等类型字段
- Telemetry 字段
- GraphRepository、Source Tree、WAL 延后到后续版本线

## 验收记录

历史交付记录中的测试数字来自当时运行结果，可能和当前仓库测试集不同。当前验证命令见 [docs/07-test/plugin-test.md](./docs/07-test/plugin-test.md)。

## 相关文档

- [v3.0.0 Changelog](./docs/09-changelog/v3.0.0.md)
- [架构方案](./docs/03-architecture/mengshu-deep-optimization-architecture.md)
- [架构评审](./docs/03-architecture/architecture-review-v2.md)
- [Memory API](./docs/05-api/memory-api.md)

## 后续状态

v3.0 已被 v4 中间件基线继续吸收。不要把本文中的“下一步发布 v3.0.0”当作当前待办。
