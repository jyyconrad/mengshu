# 开源文档撰写指南

各类文档的必备内容、写作格式、完整模板与工具命令。按当前撰写的文档类型查阅对应章节。

## 目录

- [1. 快速开始（Getting Started）](#1-快速开始getting-started)
- [2. 配置说明（Configuration）](#2-配置说明configuration)
- [3. API 参考（API Reference）](#3-api-参考api-reference)
- [4. 架构文档（Architecture）](#4-架构文档architecture)
- [5. 设计文档（Design）](#5-设计文档design)
- [6. 完整红线清单](#6-完整红线清单)
- [7. 文档更新流程](#7-文档更新流程)
- [8. 工具和命令](#8-工具和命令)
- [9. 通用模板](#9-通用模板)

---

## 1. 快速开始（Getting Started）

必须包含：安装步骤（清晰、可复制）、最简配置（5 分钟内完成）、Hello World 示例（可运行）、下一步指引。

示例结构：

````markdown
# 快速开始

## 安装
```bash
npm install -g mengshu
```

## 初始化
```bash
ms init
```

## 基本使用
```typescript
import { MemoryService } from 'mengshu';
// ...
```

## 下一步
- [配置详解](configuration.md)
- [集成指南](integration.md)
````

---

## 2. 配置说明（Configuration）

必须包含：配置文件位置、所有配置项说明（表格）、默认值、示例配置、常见问题。

格式：

```markdown
## 配置项说明

| 字段 | 说明 | 默认值 | 必填 |
|------|------|--------|------|
| `apiKey` | LLM API 密钥 | - | 是 |
| `model` | 模型名称 | `gpt-4o-mini` | 否 |
```

---

## 3. API 参考（API Reference）

必须包含：接口签名、参数说明、返回值说明、示例代码、错误处理。

格式：

````markdown
## memory.recall(options)

召回记忆。

### 参数

- `query` (string) - 查询文本
- `limit` (number) - 召回数量，默认 5
- `minImportance` (number) - 最低 importance 阈值

### 返回值

```typescript
{
  memories: Memory[],
  context: string
}
```

### 示例

```typescript
const result = await memory.recall({
  query: '用户偏好',
  limit: 5
});
```
````

---

## 4. 架构文档（Architecture）

原则：高层次概览，避免实现细节；使用图表说明（Mermaid / ASCII）；说明"为什么"而非"怎么做"。

不要写：详细的类图、方法签名；内部实现细节；过程性讨论。

应该写：系统整体架构；模块划分和职责；技术选型理由；扩展性考虑。

---

## 5. 设计文档（Design）

适用场景：核心算法说明、关键设计决策、数据模型。

原则：精简版，聚焦"单一事实来源"；移除过程性内容（"下一步""待实施"）；保留已实施的决策和算法。

注意：mengshu 的设计文档是"单一事实来源"，开源精简版（`docs/design/`）与内部完整版（`.memory-docs/original-docs/04-design/`）需同步。修改算法层决策（D-01~D-23）后两处都要更新。

---

## 6. 完整红线清单

### 不要暴露的内容

1. 内部过程：需求讨论过程、设计迭代过程、测试用例细节、缺陷记录。
2. 实现细节：内部函数名、文件组织结构（除非必要）、代码实现细节。
3. 临时信息："下一步""待实施"、"TODO""FIXME"、未完成的功能。

### 应该暴露的内容

1. 用户价值：功能特性、使用方法、最佳实践。
2. API 契约：公共接口、数据格式、错误代码。
3. 架构决策：设计理念、技术选型、扩展性考虑。

---

## 7. 文档更新流程

### 新增功能

1. 用户指南 - 添加使用说明。
2. API 参考 - 更新接口文档。
3. 配置说明 - 更新配置项（如有）。
4. Changelog - 记录变更（内部 `.memory-docs/.../09-changelog/`，由 document-workflow 管理）。

### 修改功能

1. 识别影响范围 - 哪些文档需要更新。
2. 同步更新 - 代码和文档一起提交。
3. 版本说明 - 标注破坏性变更。

### 删除功能

1. 标记废弃 - 先标记 deprecated。
2. 迁移指南 - 提供替代方案。
3. 移除文档 - 下个大版本移除。

---

## 8. 工具和命令

### 文档检查

```bash
# 检查链接有效性
npx markdown-link-check docs/**/*.md

# 拼写检查
npx cspell "docs/**/*.md"
```

### 文档生成

```bash
# API 文档自动生成（如果支持）
npm run docs:api

# 预览文档
npm run docs:serve
```

---

## 9. 通用模板

### 用户指南模板

````markdown
# {功能名称}

> 一句话概述

## 使用场景

说明何时使用此功能。

## 快速示例

```typescript
// 简单示例
```

## 详细说明

### 步骤 1
### 步骤 2

## 注意事项

- 注意点 1
- 注意点 2

## 下一步

- [相关功能](link)
````

### API 参考模板

```markdown
## functionName(params)

一句话描述。

### 参数

| 参数 | 类型 | 说明 | 必填 |
|------|------|------|------|

### 返回值

### 示例

### 错误处理
```
