# 最佳实践

## 1. 记忆分类最佳实践

### semanticType 选择

mengshu 支持 5 种语义类型：

| 类型 | 用途 | 示例 |
|------|------|------|
| `profile` | 用户画像、偏好、身份信息 | "用户是前端开发者" |
| `task_context` | 任务上下文、目标、约束 | "当前任务：重构用户模块" |
| `rules` | 规则、约束、不能做的事 | "禁止使用 var 声明变量" |
| `experience` | 经验教训、历史决策 | "之前使用 Redux 遇到性能问题" |
| `resource` | 资源引用、外部链接 | "API 文档：https://..." |

**建议**：
- 明确分类，避免混用
- profile 和 rules 具有长期有效性，设置 `targetScope: 'global'`
- task_context 通常仅在当前会话有效，设置 `targetScope: 'session'`

### targetScope 选择

6 档作用域由小到大：

| Scope | 生命周期 | 典型场景 |
|-------|----------|----------|
| `message` | 单条消息 | 临时上下文 |
| `turn` | 单轮对话 | 工具调用结果 |
| `session` | 单次会话 | 当前任务目标 |
| `project` | 项目级 | 项目架构决策 |
| `app` | 应用级 | 应用配置偏好 |
| `global` | 全局 | 用户身份、技能 |

**建议**：
- 默认使用 `project`（项目级隔离）
- 用户画像使用 `global`（跨项目复用）
- 临时信息使用 `session` 或 `turn`

## 2. 召回策略

### 控制召回数量

```typescript
const result = await memory.recall({
  query: '用户偏好',
  limit: 5,           // 召回数量
  minImportance: 0.7  // 最低 importance 阈值
});
```

**建议**：
- API 调用场景：limit 3-5（减少 token 消耗）
- 分析场景：limit 10-20（更全面）
- 设置 minImportance 过滤低质量记忆

### 按 scope 过滤

```typescript
const result = await memory.recall({
  query: '架构决策',
  scope: 'project'  // 仅召回项目级记忆
});
```

### 解释召回结果

```bash
ms recall "编程语言偏好" --explain
```

输出包含：
- 每条记忆的 importance breakdown
- salience_llm（LLM 评估相关性）
- sourceAuthority（来源权威性）
- explicitnessBonus（显式性加成）
- typePrior（类型先验）

## 3. 记忆质量管理

### 查看评分明细

```bash
ms why <记忆ID>
```

输出包含 4 套评分：
- **valueScore**（准入评分）：8 维度明细
- **importance**（召回排序）：4 项加权
- **confidence**（去重治理）：多证据累积
- **hotness**（树路由）：5 项求和

### 低质量记忆处理

**场景 1：误捕获**

```bash
ms forget <记忆ID>  # 选择 revoke（撤回）
```

**场景 2：过时信息**

```bash
ms forget <记忆ID>  # 选择 archive（归档）
```

**场景 3：信息错误**

```bash
ms forget <记忆ID>  # 选择 correct（纠错并提供正确版本）
```

### 避免重复记忆

mengshu 自动去重（P2 语义去重）：
- Entity 三级匹配（exact / fuzzy / semantic）
- Embedding 相似度阈值（0.82 pending / 0.90 confident）

**建议**：
- 同一信息不要重复存储
- 使用 `ms search` 检查是否已存在

## 4. 性能优化

### Embedding 缓存

mengshu 自动缓存 embedding：
- 相同文本复用 embedding
- 减少 API 调用

### 批量操作

```typescript
// ❌ 逐条存储（慢）
for (const text of texts) {
  await memory.store({ text });
}

// ✅ 批量存储（快）
await memory.storeBatch(texts.map(text => ({ text })));
```

### 控制 LLM 调用

```typescript
// 禁用 LLM 结构化提取（仅做语义匹配）
await memory.recall({
  query: '...',
  skipLLM: true  // 跳过 salience 计算
});
```

## 5. 安全实践

### 敏感信息脱敏

导入 agent history 时自动脱敏：

```bash
ms import ./history.jsonl --redact
```

自动移除：
- API keys（`sk-*`, `Bearer *`）
- 密码（`password: "..."`）
- 敏感路径（`/Users/xxx`）

### 环境变量管理

```bash
# ✅ 使用环境变量
export OPENAI_API_KEY="sk-..."

# ❌ 配置文件明文写入
{
  "llm": {
    "apiKey": "sk-..."  // 不要这样做
  }
}
```

配置文件使用变量引用：

```json
{
  "llm": {
    "apiKey": "${OPENAI_API_KEY}"
  }
}
```

## 6. 监控与诊断

### 配置诊断

```bash
ms doctor
```

检查项：
- LLM 连接
- Embedding 连接
- 数据库连接
- 配置完整性

### 统计信息

```bash
ms stats
```

输出：
- 记忆总数
- 各 semanticType 分布
- 平均 importance
- 存储占用

### 调试模式

```bash
export DEBUG=mengshu:*
ms recall "..."
```

输出详细日志：
- LLM 调用参数
- 召回评分计算过程
- 去重匹配结果

## 7. 版本升级

### 检查版本

```bash
ms --version
```

### 升级

```bash
npm update -g mengshu
```

### 迁移数据

v1.0.x → v1.1.x：

```bash
ms migrate --from 1.0 --to 1.1
```

## 下一步

- [配置详解](configuration.md)
- [API 参考](../api/cli-commands.md)
- [设计文档](../design/memory-system-unified-design.md)
