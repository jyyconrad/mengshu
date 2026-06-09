# 自动捕获和召回详细设计

本文描述 OpenClaw hooks 的当前行为。实现入口在 [adapters/openclaw/hooks.ts](../../../adapters/openclaw/hooks.ts)，捕获判断在 [index.ts](../../../index.ts)。

## 开关

| 功能 | 配置 |
|------|------|
| 自动召回 | `autoRecall: true` |
| 自动捕获 | `autoCapture: true` |
| 自动召回是否包含文档 | `recallIncludeDocuments: true` |
| 捕获最大长度 | `captureMaxChars`，默认 `500` |

## 自动召回

触发点：`before_agent_start`。

流程：

```text
before_agent_start
  -> 提取当前用户输入
  -> memory recall
  -> formatRelevantMemoriesContext()
  -> 注入 prompt-safe context
```

召回输出会经过 `retrieval/prompt-safety.ts` 处理，去除危险标签并转义内容。

## 自动捕获

触发点：`agent_end`。

流程：

```text
agent_end
  -> 遍历会话文本
  -> shouldCapture(text)
  -> detectCategory(text)
  -> computeContentHash(text)
  -> embedding
  -> store memory
```

## 捕获触发规则

当前 `shouldCapture()` 使用启发式规则，覆盖：

| 类型 | 示例 |
|------|------|
| 显式记忆请求 | `remember`、`pamatuj`、`zapamatuj si` |
| 偏好 | `prefer`、`like`、`hate`、`want`、`need` |
| 决策 | `decided`、`will use`、`rozhodli jsme` |
| 联系方式 | 邮箱、电话号码 |
| 个人信息 | `my ... is`、`is my` |
| 强约束 | `always`、`never`、`important` |

## 跳过条件

| 条件 | 原因 |
|------|------|
| 文本少于 10 字符 | 信号不足 |
| 文本超过 `captureMaxChars` | 避免长段落误入库 |
| 包含 `<relevant-memories>` | 避免把召回上下文再次捕获 |
| 疑似 XML/HTML system block | 跳过系统生成内容 |
| 同时包含 markdown 强格式和列表 | 跳过 agent summary |
| emoji 超过 3 个 | 高概率是 agent 输出 |
| 命中 prompt injection 模式 | 安全拒绝 |

## 分类

`detectCategory()` 当前返回：

| 分类 | 触发 |
|------|------|
| `preference` | 偏好、喜欢、讨厌、想要 |
| `decision` | 决定、约定、将使用 |
| `entity` | 邮箱、电话、命名表达 |
| `fact` | 一般事实表达 |
| `other` | 未命中以上规则 |

## 已知边界

- 自动捕获不是 LLM extractor，只做轻量启发式判断。
- 复杂的 5 type extractor 和候选区治理在 `lifecycle/`，与 OpenClaw 自动捕获链路分阶段融合。
- 自动召回基于当前 provider 的检索能力；BM25/RRF 和 context packer 属于中间件检索链路。
