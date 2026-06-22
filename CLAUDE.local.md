# CLAUDE.local.md

> **本文件仅供开发者使用，不包含在开源发布中**

## 内部文档位置

所有过程性文档、内部设计讨论、测试用例、缺陷记录等位于 `.memory-docs/original-docs/`：

```
.memory-docs/original-docs/
├── 01-business-requirements/    # 业务需求过程
├── 02-system-requirements/      # 系统需求分析
├── 03-architecture/             # 架构设计过程（含决策讨论）
├── 04-design/                   # 详细设计过程
├── 05-api/                      # API 设计过程
├── 06-database/                 # 数据库设计过程
├── 07-test/                     # 测试用例
├── 08-defects/                  # 缺陷记录
├── 09-changelog/                # 版本变更日志
└── archive/                     # 历史归档
```

## 快速导航

### 单一事实来源（算法层）
- [记忆系统统一设计 v2.0](.memory-docs/original-docs/04-design/04.2-detail/memory-system-unified-design.md)
  - P0-P4 全量实施完成（2026-06-17）
  - D-01~D-23 决策清单
  - 4 套评分体系（SCORING_WEIGHTS_V1）
  - 11 闸门 validator
  - 语义去重算法
  - L0-L3 树摘要

### 架构文档
- [系统架构](.memory-docs/original-docs/03-architecture/system-architecture.md)
- [技术栈](.memory-docs/original-docs/03-architecture/technology-stack.md)
- [产品路线图](.memory-docs/original-docs/03-architecture/product-roadmap.md)
- [架构评审 v2](.memory-docs/original-docs/03-architecture/architecture-review-v2.md)

### 重构方案
- [多产品适配器架构重构方案 v1.0](.memory-docs/original-docs/04-design/04.2-detail/adapters-refactoring-plan.md)
  - 状态：方案定稿，待实施（2026-06-17）
  - 核心：核心中间件 + 产品/协议入口 + 来源适配器 三层分离
  - 三阶段：P1 瘦身 index.ts → P2 迁移 api/sdk → P3 source adapter 骨架
  - 关联：[agent-history-import-profile-project-tree.md](.memory-docs/original-docs/04-design/04.2-detail/agent-history-import-profile-project-tree.md)

### API 设计
- [CLI 命令设计](.memory-docs/original-docs/05-api/README.md)
- [Memory API 设计](.memory-docs/original-docs/05-api/memory-api.md)

### 测试
- [测试用例](.memory-docs/original-docs/07-test/)

### 缺陷记录
- [缺陷追踪](.memory-docs/original-docs/08-defects/)

### 版本变更
- [Changelog](.memory-docs/original-docs/09-changelog/)

## 开源文档位置

面向用户的开源文档位于 `docs/`：

```
docs/
├── README.md                    # 文档导航
├── architecture/                # 架构概览（精简版）
├── design/                      # 核心设计（单一事实来源）
├── api/                         # API 参考
└── guides/                      # 用户指南
```

## 文档更新规则

1. **过程性文档** → `.memory-docs/original-docs/`
   - 需求讨论、设计过程、测试用例、缺陷记录
   - 仅供团队内部使用

2. **用户文档** → `docs/`
   - API 参考、用户指南、快速开始
   - 开源发布，面向最终用户

3. **单一事实来源** → 两处都有
   - `docs/design/memory-system-unified-design.md`（开源版）
   - `.memory-docs/original-docs/04-design/04.2-detail/memory-system-unified-design.md`（完整版）

## 开发注意事项

详见 [CLAUDE.md](CLAUDE.md) 和 [AGENTS.md](AGENTS.md)。

---

**提示**：使用 `ms doctor` 诊断配置，`ms why <记忆ID>` 查看评分明细。
