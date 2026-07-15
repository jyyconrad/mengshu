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
  limit: 5,       // 召回数量
  minScore: 0.7   // 当前召回合同的最低分阈值
});
```

**建议**：

- API 调用场景：limit 3-5（减少 token 消耗）
- 分析场景：limit 10-20（更全面）
- 设置 `minScore` 过滤低分结果；其含义以当前入口返回的 score 为准

### 按 scope 过滤

```typescript
const result = await memory.recall({
  query: '架构决策',
  scope: {
    tenantId: 'local',
    userId: 'me',
    appId: 'codex',
    projectId: 'memory-autodb',
    agentId: 'default',
    namespace: 'memories',
    visibility: 'private'
  }
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

当前输出用于追溯记忆来源和状态，包含：

- importance 标量
- provenance 与 scope
- riskFlags（存在时）
- merge history（存在时）

valueScore、confidence 和 hotness 虽有算法模块，但当前 `ms why` 不承诺输出其完整明细。

### 低质量记忆处理

**场景 1：误捕获**

```bash
ms forget <记忆ID>  # 默认动作就是 revoke（撤回）
```

**场景 2：过时信息**

```bash
ms forget <记忆ID> --archive
```

**场景 3：信息错误**

```bash
ms forget <记忆ID> --correct --text "正确内容"
```

### 避免重复记忆

mengshu 提供 P2 语义去重模块；具体入口是否已接入该模块，应以当前运行链路为准：

- Entity 三级匹配（exact / fuzzy / semantic）
- Embedding 相似度阈值（0.82 pending / 0.90 confident）

**建议**：

- 同一信息不要重复存储
- 使用 `ms search` 检查是否已存在

### LanceDB 写锁恢复

LanceDB 开发模式使用跨进程单写锁。遇到残留锁时不要按时间自动删除，也不要在仍有 Mengshu 进程运行时恢复：

- 先停止所有指向同一 canonical 数据目录的 Mengshu 进程，满足全局静默条件。
- 使用 provider 的 `inspectWriteLock()` 检查固定写锁与 recovery guard；`onlineSafe: false` 表示不能在线恢复。
- 仅在锁所有者可确定已退出、并持有本次检查返回的 token 时调用 `recoverWriteLock()`。
- `recovery-blocked` 或非法 recovery guard 必须人工排查，不能由新 writer 自动接管。

该机制用于避免正常并发和崩溃后的误接管，不提供对同一 OS 用户下恶意进程的安全隔离。生产持久任务与 effect fencing 的参考实现仍是 PostgreSQL。

## 4. 性能优化

### Embedding 成本

当前公开合同不承诺跨进程 embedding 缓存。批量导入前先 dry-run，并通过稳定的 embedding space 配置避免重复重嵌入。

### 批量操作

```typescript
// 逐条存储适合少量手动写入
for (const text of texts) {
  await memory.storeMemory({ record: createRecord(text) });
}

// 大批量历史内容建议先走 dry-run，再确认导入
// ms project ingest-history --from codex --dry-run
```

## 5. 安全实践

### 敏感信息脱敏

导入 agent history 时自动脱敏：

```bash
ms project ingest-history --from codex --dry-run
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

- 总记录数、用户记忆数和扫描文档数
- 当前数据库类型
- provider 支持时的各表记录数

## 7. 版本升级

### 检查版本

```bash
ms --version
```

当前仓库仍处于本地开发和运行态升级阶段，尚未承诺 npm registry 的稳定升级路径，也不支持 `ms migrate --from/--to`。升级前以 release note、`ms --help` 和真实迁移命令为准；不要根据版本号猜测迁移参数。

## 下一步

- [配置详解](configuration.md)
- [API 参考](../api/cli-commands.md)
- [设计文档](../design/memory-system-unified-design.md)
