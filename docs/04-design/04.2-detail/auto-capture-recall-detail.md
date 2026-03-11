# 自动捕获和召回详细设计

## 功能描述

自动捕获：在对话结束时，智能识别并存储重要信息。
自动召回：在新对话开始时，自动检索相关记忆注入上下文。

## 捕获规则

### 1. 用户偏好识别

**模式匹配**：
```typescript
const PREFERENCE_PATTERNS = [
  /我 (喜欢 | 偏好 | 习惯 | 希望 | 想要).*/,
  /请使用.*方式.*/,
  /我更 (喜欢 | 倾向于).*/,
  /不要.*要.*$/,
];
```

**示例**：
- "我更喜欢使用 TypeScript 编写代码"
- "请使用简洁的回答风格"
- "我希望代码注释用中文"

### 2. 决策识别

**模式匹配**：
```typescript
const DECISION_PATTERNS = [
  /我们 (决定 | 确定 | 约定 | 同意).*/,
  /就 (这么 | 这样) (定 | 办).*/,
  /最终方案是.*/,
];
```

**示例**：
- "我们决定使用 PostgreSQL 数据库"
- "就这么定了，用 React 18"

### 3. 实体识别

**实体类型**：
- 人名
- 地名
- 组织名
- 项目名

**识别方式**：
- NER 模型（未来）
- 规则匹配（当前）

### 4. 任务和规划识别

**模式匹配**：
```typescript
const TASK_PATTERNS = [
  /需要.*完成.*/,
  /计划.*做.*/,
  /接下来要.*/,
  /待办.*：.*/,
];
```

## 召回逻辑

### 1. 关键词提取

```typescript
function extractKeywords(message: string): string[] {
  // 移除停用词
  const stopwords = ['的', '了', '是', '在', '我', '有', '和'];
  const words = message.split(/[\s,，.。?!？！]+/);
  return words.filter(w => w.length > 1 && !stopwords.includes(w));
}
```

### 2. 向量搜索

```typescript
async function autoRecall(
  userMessage: string,
  options: RecallOptions
): Promise<MemoryEntry[]> {
  // 1. 生成查询向量
  const queryVector = await embeddings.generate(userMessage);

  // 2. 搜索相关记忆
  const memories = await db.search({
    vector: queryVector,
    limit: options.limit || 5,
    minSimilarity: 0.7,
  });

  // 3. 过滤和排序
  return memories
    .filter(m => isRelevant(m, userMessage))
    .sort((a, b) => b.importance - a.importance);
}
```

### 3. 上下文注入

```typescript
function injectContext(memories: MemoryEntry[]): string {
  if (memories.length === 0) return '';

  const context = memories.map(m =>
    `[相关记忆] ${m.text} (重要性：${m.importance})`
  ).join('\n');

  return `
<relevant_memories>
${context}
</relevant_memories>
`;
}
```

## 输入输出

### 捕获输入

```typescript
interface CaptureContext {
  conversationId: string;
  messages: Message[];
  agentState: AgentState;
}
```

### 召回输入

```typescript
interface RecallContext {
  userMessage: string;
  sessionId: string;
  options: {
    limit: number;
    includeDocuments: boolean;
  };
}
```

### 输出

```typescript
// 捕获输出
interface CaptureResult {
  stored: MemoryEntry[];
  skipped: number;
}

// 召回输出
interface RecallResult {
  memories: MemoryEntry[];
  context: string;
}
```

## 边界条件

### 捕获条件

| 条件 | 处理 |
|------|------|
| 消息 < 10 字符 | 跳过 |
| 消息 > 500 字符 | 截断 |
| 低重要性 | 跳过 |

### 召回条件

| 条件 | 处理 |
|------|------|
| 无相关记忆 | 返回空 |
| 相似度 < 0.5 | 过滤 |
| 超过 limit | 截断 |

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
