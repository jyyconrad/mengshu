# memory-autodb 文档

本文档目录按读者任务组织：先找当前可用能力，再看架构和设计，最后查历史方案和版本记录。

## 推荐阅读路径

### 使用者

1. 先读根目录 [README](../README.md)，了解安装、配置、CLI 和 REST 快速示例。
2. 查 [CLI 命令](./05-api/cli-commands.md) 或 [Memory API](./05-api/memory-api.md)。
3. 需要部署或排障时，查 [数据库 Schema](./06-database/schema.md) 和 [测试文档](./07-test/plugin-test.md)。

### 维护者

1. 先读 [memory-middleware-architecture.md](./03-architecture/memory-middleware-architecture.md)，理解当前中间件架构。
2. 再读 [memory-middleware-development-plan.md](./04-design/04.2-detail/memory-middleware-development-plan.md)，理解阶段拆解和已落地边界。
3. 修改 API、CLI 或 schema 后，同步更新 `05-api/`、`06-database/`、`07-test/` 和 `09-changelog/`。

### 架构评审者

1. 先读 [memory-autodb-deep-optimization-architecture.md](./03-architecture/memory-autodb-deep-optimization-architecture.md)。
2. 再读 [architecture-review-v2.md](./03-architecture/architecture-review-v2.md)。
3. 需要追溯设计来源时，再看 `03-architecture/copy-from-mate/` 下的外部参考材料。

## 当前真源

| 主题 | 当前真源 |
|------|----------|
| 项目简介和快速上手 | [../README.md](../README.md) |
| 当前中间件架构 | [03-architecture/memory-middleware-architecture.md](./03-architecture/memory-middleware-architecture.md) |
| 当前产品路线图 | [03-architecture/product-roadmap.md](./03-architecture/product-roadmap.md) |
| 全局配置目录升级（v0.1.2 核心） | [03-architecture/global-config-directory-upgrade.md](./03-architecture/global-config-directory-upgrade.md) |
| 深层优化方案 | [03-architecture/memory-autodb-deep-optimization-architecture.md](./03-architecture/memory-autodb-deep-optimization-architecture.md) |
| REST、OpenClaw 工具和 MCP facade | [05-api/memory-api.md](./05-api/memory-api.md) |
| CLI | [05-api/cli-commands.md](./05-api/cli-commands.md) |
| 数据库和 schema | [06-database/schema.md](./06-database/schema.md) |
| 测试和验证 | [07-test/plugin-test.md](./07-test/plugin-test.md) |
| 版本变更 | [09-changelog/README.md](./09-changelog/README.md) |

## 目录说明

| 目录 | 用途 | 阅读建议 |
|------|------|----------|
| [01-business-requirements](./01-business-requirements/README.md) | 业务需求和验收标准 | 了解为什么做长期记忆 |
| [02-system-requirements](./02-system-requirements/README.md) | 系统功能和非功能需求 | 了解功能边界 |
| [03-architecture](./03-architecture/README.md) | 架构方案、评审和外部参考 | 先读 README 再进长文 |
| [04-design](./04-design/README.md) | 模块设计和实施计划 | 修改代码前查相关模块设计 |
| [05-api](./05-api/README.md) | OpenClaw 工具、CLI、REST、MCP facade | 和代码契约一起维护 |
| [06-database](./06-database/README.md) | 表结构、索引、RPC、v4 schema 草案 | 改 provider 或迁移时更新 |
| [07-test](./07-test/README.md) | 测试范围和验证命令 | 交付前必须核对 |
| [08-defects](./08-defects/README.md) | 缺陷记录 | 只记录需要长期追溯的问题 |
| [09-changelog](./09-changelog/README.md) | 版本变更 | 每次发布或阶段交付更新 |

## 文档状态

| 类型 | 判断标准 | 示例 |
|------|----------|------|
| 当前文档 | 与当前代码、配置和测试一致 | `README.md`、`05-api/`、`06-database/schema.md` |
| 方案文档 | 描述正在推进或后续计划，不能当作已实现能力 | `memory-autodb-deep-optimization-architecture.md` |
| 历史文档 | 记录已交付阶段或旧版本，保留用于追溯 | `PROJECT-SUMMARY.md`、`DELIVERY.md`、旧升级方案 |
| 外部参考 | 来自 Banto/iFlyMate 的记忆系统材料，只作为设计输入 | `03-architecture/copy-from-mate/` |

## 写作约定

本文档按 GitHub Docs 风格维护：

- 每篇文档先说明读者目标、当前状态和适用范围。
- 任务类内容用编号步骤；参考类内容用表格；长列表只保留必要项。
- 链接指向当前仓库内存在的相对路径，不链接不存在的示例文件。
- 当前已实现能力和未来方案必须分开写，不能把计划能力写成已完成。
- 文档变更应优先更新已有入口，不新建平行说明文。
