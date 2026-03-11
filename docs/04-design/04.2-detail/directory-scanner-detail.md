# 目录扫描器详细设计

## 功能描述

扫描指定目录下的 Markdown 文件，解析内容并存储到知识库。

## 扫描流程

```
1. 递归扫描目录
        │
2. 应用过滤规则
   ├── .gitignore 规则
   ├── 默认忽略路径
   └── 自定义忽略规则
        │
3. 读取文件内容
        │
4. Markdown 解析
   ├── 提取标题
   ├── 提取代码块
   └── 提取文本
        │
5. 文本切分
   ├── 每块 1000 字符
   └── 重叠 200 字符
        │
6. 批量向量化
   ├── 每批 20 条
   └── 并发 3 个
        │
7. 存储到数据库
        │
8. 返回统计
```

## 忽略规则

### 默认忽略路径

```typescript
const DEFAULT_IGNORE_PATHS = [
  'node_modules',
  '.git',
  '.github',
  '.vscode',
  'dist',
  'build',
  'coverage',
];
```

### 自定义忽略规则

```typescript
const customIgnoreRules = [
  '*.log',
  '*.tmp',
  '*.temp',
  '*.test.md',
  '*draft*',
];
```

### 过滤逻辑

```typescript
function shouldIgnore(filePath: string): boolean {
  // 1. 检查路径匹配
  if (DEFAULT_IGNORE_PATHS.some(p => filePath.includes(p))) {
    return true;
  }

  // 2. 检查 .gitignore
  if (gitignoreFilter.ignores(filePath)) {
    return true;
  }

  // 3. 检查自定义规则
  if (customRules.some(rule => minimatch(filePath, rule))) {
    return true;
  }

  return false;
}
```

## 文本切分

### 切分策略

```typescript
interface TextSplitterOptions {
  chunkSize: number;      // 每块大小（默认 1000）
  chunkOverlap: number;   // 重叠大小（默认 200）
  separators: string[];   // 分隔符（默认 ['\n\n', '\n', '。', '！', '？']）
}
```

### 切分算法

```typescript
function splitText(text: string, options: TextSplitterOptions): string[] {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    let end = start + options.chunkSize;

    if (end >= text.length) {
      chunks.push(text.slice(start));
      break;
    }

    // 尝试在句子边界切分
    for (const sep of options.separators) {
      const lastSep = text.slice(start, end).lastIndexOf(sep);
      if (lastSep > 0) {
        end = start + lastSep + sep.length;
        break;
      }
    }

    chunks.push(text.slice(start, end));
    start = end - options.chunkOverlap;
  }

  return chunks;
}
```

## 批量处理

### 配置

```typescript
interface BatchProcessingConfig {
  maxBatchSize: number;   // 每批最多 20 条
  concurrency: number;    // 最多 3 个并发
  retryAttempts: number;  // 最多重试 3 次
}
```

### 处理逻辑

```typescript
async function processInBatches(
  chunks: string[],
  config: BatchProcessingConfig
): Promise<ProcessResult> {
  const results = [];
  const batches = chunkArray(chunks, config.maxBatchSize);

  // 限流处理
  const limiter = pLimit(config.concurrency);

  const promises = batches.map(batch =>
    limiter(async () => {
      try {
        // 批量生成嵌入
        const vectors = await embeddings.generateBatch(batch);

        // 批量存储
        const stored = await db.insertBatch(batch, vectors);
        results.push(...stored);
      } catch (error) {
        // 重试逻辑
        await retry(() => processBatch(batch), config.retryAttempts);
      }
    })
  );

  await Promise.all(promises);
  return { total: results.length, stored: results };
}
```

## 元数据丰富

### 自动添加的元数据

```typescript
function enrichMetadata(
  base: Record<string, any>,
  fileInfo: FileInfo
): Record<string, any> {
  return {
    ...base,
    filePath: fileInfo.path,
    fileModifiedAt: fileInfo.mtime.toISOString(),
    directoryPath: fileInfo.dir,
    fileName: fileInfo.name,
    tokenCount: estimateTokens(fileInfo.content),
    source: 'scan',
  };
}
```

## 错误处理

### 错误类型

| 错误 | 处理 |
|------|------|
| 文件读取失败 | 记录日志，继续处理 |
| Markdown 解析失败 | 使用纯文本 |
| 嵌入生成失败 | 重试 3 次 |
| 存储失败 | 记录失败文件 |

### 错误报告

```typescript
interface ScanResult {
  directory: string;
  totalFiles: number;
  processed: number;
  failed: number;
  totalChunks: number;
  stored: number;
  duplicates: number;
  failures: Array<{
    file: string;
    error: string;
  }>;
}
```

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
