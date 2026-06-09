# 数据库设计

本目录记录 legacy 表结构、中间件 schema 草案、索引和迁移注意事项。

## 当前文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [schema.md](./schema.md) | 当前 | `memories`、`knowledge` legacy 表，中间件 v4 schema 草案，索引和 RPC |

## 当前存储边界

| 层 | 状态 |
|----|------|
| Legacy provider | LanceDB、Supabase、Postgres provider 由 `db/providers/` 实现 |
| Core service | `storage/legacy-database-adapter.ts` 把 legacy 数据映射到 `MemoryRecord` |
| Middleware baseline | documents/chunks/jobs/audit/graph/tree 以 in-memory contract baseline 为主 |
| 持久化迁移 | `ltm migrate --to-schema v4 --dry-run` 当前提供迁移估算 |

## 维护规则

- 改 `db/types.ts`、`core/types.ts`、`storage/` 或 provider 时更新 schema。
- 写向量维度时必须注明模型来源，并提醒迁移成本。
- 方案表和已持久化表要分开写，避免误导部署。
