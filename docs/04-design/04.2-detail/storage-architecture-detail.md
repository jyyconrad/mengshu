# 存储架构详细设计

## 功能描述

多表存储架构，支持对话记忆和文档知识的隔离存储和查询。

## 数据模型

### MemoryEntry

```typescript
interface MemoryEntry {
  id: string;                    // UUID 主键
  text: string;                  // 文本内容
  contentHash: string;           // SHA256 哈希（用于去重）
  vector: number[];              // 嵌入向量
  importance: number;            // 重要性 (0-1)
  category: string;              // 分类
  dataType: "memory" | "knowledge" | "document";
  metadata: Record<string, any>; // 元数据
  createdAt: Date;               // 创建时间
}
```

### 表结构映射

| 表名 | 用途 | 数据前缀 |
|------|------|----------|
| `memories` | 对话记忆 | `mem_` |
| `knowledge` | 文档知识 | `know_` |

### 用户友好分类映射

```typescript
const STORAGE_CATEGORY_MAP = {
  // 核心记忆类
  "核心记忆": "memories",
  "记忆": "memories",
  "对话记忆": "memories",

  // 用户偏好类
  "用户偏好": "memories",
  "偏好": "memories",

  // 知识库类
  "知识库": "knowledge",
  "文档": "knowledge",
};
```

## 输入输出

### 存储输入

```typescript
interface StoreParams {
  text: string;
  storageCategory?: "核心记忆" | "知识库";  // 默认：核心记忆
  importance?: number;                      // 默认：0.7
  category?: MemoryCategory;                // 默认：auto
  metadata?: Record<string, any>;
}
```

### 存储输出

```typescript
interface StoreResult {
  id: string;
  created: boolean;  // true=新建，false=已存在
  entry: MemoryEntry;
}
```

## 算法设计

### 内容哈希生成

```typescript
function computeContentHash(text: string): string {
  // 1. 规范化文本（去除空白、统一大小写）
  const normalized = text.trim().toLowerCase();
  // 2. 计算 SHA256
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
```

### 去重逻辑

```typescript
async function storeWithDedup(entry: MemoryEntry): Promise<StoreResult> {
  const hash = computeContentHash(entry.text);

  // 检查是否存在
  const existing = await db.findByHash(hash, entry.dataType);
  if (existing) {
    return { id: existing.id, created: false, entry: existing };
  }

  // 存储新数据
  const newEntry = await db.insert({ ...entry, contentHash: hash });
  return { id: newEntry.id, created: true, entry: newEntry };
}
```

### 向量搜索

```typescript
async function vectorSearch(
  query: string,
  options: SearchOptions
): Promise<MemoryEntry[]> {
  // 1. 生成查询向量
  const queryVector = await embeddings.generate(query);

  // 2. 选择搜索策略
  if (db.hasRPCFunctions()) {
    // 使用 RPC 函数（性能最好）
    return await db.callRPC('match_memories', [
      queryVector,
      options.limit,
      options.minSimilarity,
      options.filterDataType
    ]);
  } else if (db.isLanceDB()) {
    // LanceDB 原生搜索
    return await db.search(queryVector, options);
  } else {
    // 回退方案：内存计算
    const candidates = await db.getCandidates(options.limit * 10);
    return computeSimilarityInMemory(candidates, queryVector);
  }
}
```

## 边界条件

### 输入验证

| 条件 | 处理 |
|------|------|
| 空文本 | 抛出错误 |
| 文本 > 10000 字符 | 自动切分 |
| 重要性 < 0 或 > 1 | 抛出错误 |
| 无效分类 | 使用默认值 |

### 错误处理

```typescript
try {
  await store(entry);
} catch (error) {
  if (error.code === 'EMBEDDING_FAILED') {
    // 嵌入生成失败，重试
    await retry(store, entry, { maxAttempts: 3 });
  } else if (error.code === 'DUPLICATE_ENTRY') {
    // 返回现有条目
    return existing;
  } else {
    throw error;
  }
}
```

## 数据结构

### 元数据结构

```typescript
interface MemoryMetadata {
  // OpenClaw 上下文
  sessionId?: string;
  conversationId?: string;
  messageId?: string;
  userId?: string;

  // 项目信息
  projectPath?: string;
  workspacePath?: string;

  // Agent 信息
  agentId?: string;
  agentName?: string;

  // 群组信息
  groupId?: string;
  groupName?: string;

  // 用户信息
  userName?: string;
  userEmail?: string;

  // 技术元数据
  embeddingModel?: string;
  pluginVersion?: string;
  language?: string;
  source?: "user" | "agent" | "system" | "scan";

  // 文档元数据（扫描时）
  filePath?: string;
  fileModifiedAt?: string;
  directoryPath?: string;
  tokenCount?: number;

  // 用户自定义元数据
  [key: string]: any;
}
```

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
