# 变更日志

本目录按版本记录已交付能力。这里写已经落地并经过验证的变更，未来方案放在架构或设计文档。

## 版本索引

| 版本 | 文档 | 说明 |
|------|------|------|
| v4.0.0 | [v4.0.0.md](./v4.0.0.md) | Memory middleware 基线：MemoryService、REST、MCP、SDK、ingestion、retrieval、graph/tree/console baseline |
| v3.0.0 | [v3.0.0.md](./v3.0.0.md) | 5 问题语义协议、Agent 快路径、候选区和 Slot Context Builder |
| v2.1.0 | [v2.1.0.md](./v2.1.0.md) | 多表存储、CLI 增强、元数据自动丰富和配置扩展 |

## 维护规则

- 新版本文件使用 `v{major}.{minor}.{patch}.md` 命名。
- 每条变更尽量链接相关架构、API、测试或迁移文档。
- 不在 changelog 里写愿景；计划能力写到 `../03-architecture/` 或 `../04-design/`。

## 新文档模板

```markdown
# v{版本} - {发布日期}

## 新增

## 改进

## 修复

## 变更

## 移除

## 验证
```
