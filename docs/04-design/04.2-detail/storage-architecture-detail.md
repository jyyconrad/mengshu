# 存储架构详细设计

本文描述当前存储层如何同时支持 legacy provider 和中间件 core model。数据库表细节见 [数据库 Schema](../../06-database/schema.md)。

## 层次

| 层 | 文件 | 说明 |
|----|------|------|
| Legacy entry | `db/types.ts` | `MemoryEntry`、`MemoryMetadata`、`DatabaseProvider` |
| Provider | `db/providers/` | LanceDB、Supabase、Postgres、Hybrid |
| Factory | `db/factory.ts` | 根据配置创建 provider |
| Core record | `core/types.ts` | `MemoryRecord`、`MemoryScope`、`ChunkRecord` 等 |
| Adapter | `storage/legacy-database-adapter.ts` | legacy provider 与 `MemoryRepository` 之间的桥 |
| In-memory baseline | `storage/repositories/in-memory.ts` | v4 contract baseline |

## Legacy 表

| 表 | 用途 | 数据类型 |
|----|------|----------|
| `memories` | 对话记忆、用户偏好、事实、决策 | `memory` |
| `knowledge` | 扫描文档和知识条目 | `knowledge` / `document` |

用户友好分类由 OpenClaw adapter 映射到底层表：

| 用户输入 | 表 |
|----------|----|
| `核心记忆`、`记忆`、`对话记忆`、`用户偏好`、`偏好` | `memories` |
| `知识库`、`文档` | `knowledge` |

## Core `MemoryRecord`

`MemoryRecord` 是 REST、MCP、SDK、console 和 retrieval 共享的领域对象。关键字段：

| 字段 | 说明 |
|------|------|
| `scope` | tenant/app/user/project/agent/namespace 隔离边界 |
| `kind` | 通用分类，如 `preference`、`decision`、`fact`、`knowledge` |
| `semanticType` | 可选 5 问题语义视图 |
| `container` | 可选语义容器，如 `personal`、`project`、`session_candidate` |
| `lifecycleStatus` | 可选生命周期状态 |
| `text` | 记忆正文 |
| `contentHash` | 去重 hash |
| `metadata` | 扩展元数据 |
| `provenance` | 来源、会话、文件等证据 |

## 写入流程

```text
OpenClaw memory_store
  -> detect category / resolve table
  -> compute content hash
  -> generate embedding
  -> build legacy MemoryEntry
  -> DefaultMemoryService.storeMemory()
  -> LegacyDatabaseAdapter.store()
  -> DatabaseProvider.insert()
```

REST/MCP 直接传入 `MemoryRecord` 时，会从 core service 进入 repository。

## 召回流程

```text
query
  -> embeddings.embed(query)
  -> MemoryRepository.query()
  -> legacy provider vector query
  -> map MemoryEntry to MemoryRecord
  -> RecallHit[]
```

`buildContext()` 会继续调用 `retrieval/context-packer.ts`，生成 prompt-safe context。

## 去重

OpenClaw 工具层使用 `computeContentHash()` 计算内容 hash，并通过 provider 的 `existsByContentHash()` 做重复检查。不同 provider 对唯一索引和冲突处理的能力不同，持久化层仍应保留 content hash 唯一约束。

## v4 baseline

v4 中间件新增 `documents`、`chunks`、`jobs`、`audit`、`entities`、`relations`、`summary_nodes` 等结构。当前重点是通过 in-memory repository 固化 contract；持久化 provider 按 [schema.md](../../06-database/schema.md) 后续落地。

## 边界条件

| 条件 | 处理 |
|------|------|
| 向量维度和模型不一致 | `vectorDimsForModel()` 抛错或 provider 查询失败，应迁移/重建索引 |
| 删除未带条件 | `memory_cleanup` 拒绝执行 |
| 无法稳定归入 5 type | 保留 `kind`，不丢弃；仍可普通 recall |
| provider 不支持表统计 | CLI 输出“不支持”提示 |
| REST server 暴露 | 默认 loopback；secret 和 HTTPS 由 server config 控制 |
