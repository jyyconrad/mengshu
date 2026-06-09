# memory-autodb v3.0 项目总结

> 状态：历史总结
> 日期：2026-06-08
> 当前入口：见 [README.md](./README.md) 和 [docs/README.md](./docs/README.md)

本文保留 v3.0 架构升级的阶段总结。当前仓库已经继续推进 v4 memory middleware 基线，因此最新能力、API 和验证命令以 `docs/` 下当前文档为准。

## 核心交付

| 里程碑 | 交付 |
|--------|------|
| Agent 快路径 | 5 问题语义协议、SlotSnapshot、Slot Context Builder、`memory_context_fast`、`/v1/agent/*` |
| 候选区 | CandidateRecord、状态机、批量审核、启发式 extractor、自动淘汰 |
| 类型扩展 | `MemoryEdge`、`GraphNode`、`lifecycleStatus`、`container`、`visibility` |
| 可观测 | latency、nodesUsed、cacheHit、tokenEstimate、warnings |

## 关键设计结论

1. `semanticType` 是可选语义视图，不是主库硬约束。
2. 启发式 extractor 可支持单机配置，不依赖 LLM。
3. SlotSnapshot 比 Slot Tree 更适合作为早期快路径。
4. 候选区需要自动淘汰和批量操作，避免变成第二个长期垃圾库。
5. 无法归类的记忆仍应通过普通 lookup/recall 可检索。

## 当前替代文档

| 主题 | 当前文档 |
|------|----------|
| 项目快速上手 | [README.md](./README.md) |
| 文档总入口 | [docs/README.md](./docs/README.md) |
| 当前中间件架构 | [docs/03-architecture/memory-middleware-architecture.md](./docs/03-architecture/memory-middleware-architecture.md) |
| 深层优化方案 | [docs/03-architecture/memory-autodb-deep-optimization-architecture.md](./docs/03-architecture/memory-autodb-deep-optimization-architecture.md) |
| v3.0 变更 | [docs/09-changelog/v3.0.0.md](./docs/09-changelog/v3.0.0.md) |
| v4.0 变更 | [docs/09-changelog/v4.0.0.md](./docs/09-changelog/v4.0.0.md) |

## 注意

历史总结曾引用 `.claude/tasks/*` 下的过程报告和中间产物；这些文件不在当前仓库中。长期可维护信息已经收敛到 `docs/`。
