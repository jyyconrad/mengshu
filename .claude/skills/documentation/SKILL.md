---
name: documentation
description: mengshu 开源项目面向用户的文档编写规范。在 docs/ 下编写或更新 guides/ 用户指南、api/ 接口参考、architecture/ 架构概览、design/ 核心设计时使用。触发场景：(1) 编写、更新、生成面向用户的开源文档；(2) 把内部设计/需求转化为对外文档；(3) 审查文档是否暴露了不该暴露的内部实现细节；(4) 用户说"写文档""更新文档""write documentation""update docs"且目标是 docs/ 而非内部 .memory-docs/。与 document-workflow 技能配合：后者管理内部 9 目录编号过程文档，本技能管理对外开源文档。
---

# mengshu 开源文档编写规范

面向 `docs/` 目录的用户文档编写。核心理念：文档是给用户看的，简洁、清晰、实用优先。

## 与 document-workflow 的职责边界

| 维度 | document-workflow（全局技能） | documentation（本技能） |
|------|------------------------------|------------------------|
| 输出位置 | `.memory-docs/original-docs/`（内部） | `docs/`（开源对外） |
| 目录体系 | 9 个编号目录（01~09） | guides / api / architecture / design |
| 受众 | 团队内部 | 最终用户、集成者、贡献者 |
| 内容 | 需求/设计/测试/缺陷全过程 | 使用方法、API 契约、架构理念 |
| 入口 | `/update-doc` 初始化/更新/健康检查 | `/update-doc` 对外文档子流程 |

**判断规则**：写的是过程记录（需求讨论、缺陷记录、测试用例）→ 用 document-workflow；写的是用户拿到手就能用的文档 → 用本技能。涉及"单一事实来源"设计文档时，两处都需同步（内部完整版 + 开源精简版）。

## 三条核心原则

1. **面向用户，而非开发者** — 用户关心"如何使用"，不关心"如何实现"。不暴露内部函数名、文件组织、实现细节。
2. **文档即产品** — 文档质量直接影响用户体验，与代码同步更新。
3. **渐进式引导** — 从快速开始到高级用法，从简单示例到完整参考，提供充分的导航链接。

## docs/ 目录结构

```
docs/
├── README.md                  # 文档导航和概览
├── guides/                    # 用户指南（getting-started/configuration/integration/best-practices）
├── api/                       # API 参考（cli-commands/memory-api）
├── architecture/              # 架构概览（system-architecture/technology-stack，高层次）
└── design/                    # 核心设计（memory-system-unified-design 单一事实来源/schema）
```

| 类型 | 位置 | 受众 |
|------|------|------|
| 用户指南 | `docs/guides/` | 所有用户 |
| API 参考 | `docs/api/` | 开发者、集成者 |
| 架构文档 | `docs/architecture/` | 架构师、贡献者 |
| 设计文档 | `docs/design/` | 深度贡献者 |

## 工作流程

1. **识别文档类型** — 用户指南 / API 参考 / 架构 / 设计，对应 docs/ 子目录。
2. **读取现有同类文档** — 保持风格、结构、术语一致。开源文档优先复用项目已有约定，不引入新风格。
3. **选用对应模板撰写** — 各类文档的必备内容与模板见 [references/writing-guide.md](references/writing-guide.md)。
4. **应用红线检查** — 不暴露内部过程、实现细节、临时信息（"待实施""TODO"）。完整红线清单见 writing-guide.md。
5. **提交前过检查清单** — 见下方。

## 红线（速查）

不暴露：内部过程（需求讨论、设计迭代、测试用例、缺陷）、实现细节（内部函数名、代码组织）、临时信息（"下一步""待实施""TODO"）。
应暴露：用户价值（功能特性、使用方法、最佳实践）、API 契约（公共接口、数据格式、错误码）、架构决策（设计理念、技术选型、扩展性）。

## 提交前检查清单

- [ ] 用户视角（是否易懂）
- [ ] 代码示例可运行
- [ ] 链接有效
- [ ] 无拼写错误
- [ ] 无内部实现细节
- [ ] 无"待实施""下一步"等临时信息
- [ ] 格式一致（Markdown 规范）

## 详细参考

各类文档的必备内容、写作格式、完整模板和工具命令，见 [references/writing-guide.md](references/writing-guide.md)。需要为某类文档撰写时按需读取。
