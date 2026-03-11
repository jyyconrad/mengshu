# Memory Plugin Design

## 模块职责

OpenClaw 内存插件提供长期记忆存储和检索功能，支持向量相似度搜索。

## 核心功能

### 1. 记忆存储 (`memory_store`)

**输入**：
- `text`: 要存储的文本
- `importance`: 重要性分数 (0-1)
- `category`: 分类 (core, preference, fact, entity, decision, task, plan, goal, other)
- `storageCategory`: 存储分类 (核心记忆/知识库)
- `metadata`: 自定义元数据

**处理流程**：
```
用户调用 memory_store
    │
    ▼
生成内容哈希 (SHA256)
    │
    ▼
检查是否重复
    │
    ├── 已存在 ──▶ 返回现有 ID
    │
    ▼
生成嵌入向量
    │
    ▼
存储到数据库
    │
    ├── LanceDB (向量索引)
    └── Supabase (完整数据)
    │
    ▼
返回存储结果
```

### 2. 记忆检索 (`memory_recall`)

**输入**：
- `query`: 搜索查询
- `limit`: 返回数量
- `category`: 存储分类
- `filter`: 元数据过滤
- `includeDocuments`: 是否包含文档

**处理流程**：
```
用户调用 memory_recall
    │
    ▼
生成查询向量
    │
    ▼
向量相似度搜索
    │
    ├── LanceDB: 快速搜索
    └── Supabase: RPC 函数
    │
    ▼
应用元数据过滤
    │
    ▼
返回结果
```

### 3. 目录扫描 (`memory_scan_directory`)

**处理流程**：
```
用户调用 memory_scan_directory
    │
    ▼
扫描目录 (递归)
    │
    ▼
过滤文件 (.gitignore 规则)
    │
    ▼
读取文件内容
    │
    ▼
Markdown 解析
    │
    ▼
文本切分 (1000 字符，重叠 200)
    │
    ▼
批量向量化 (20 条/批)
    │
    ▼
存储到数据库
    │
    ▼
返回统计信息
```

### 4. 自动捕获 (`agent_end` 钩子)

**触发条件**：
- 对话结束
- `autoCapture: true`

**捕获规则**：
- 用户偏好声明
- 重要决策和共识
- 实体信息（人名、地名等）
- 任务和规划

### 5. 自动召回 (`before_agent_start` 钩子)

**触发条件**：
- 新对话开始
- `autoRecall: true`

**召回逻辑**：
- 提取用户消息关键词
- 向量搜索相关记忆
- 注入到系统上下文

## 模块接口

### 工具函数

| 工具 | 参数 | 返回 |
|------|------|------|
| `memory_store` | `StoreMemoryParams` | `MemoryEntry` |
| `memory_recall` | `RecallMemoryParams` | `MemoryEntry[]` |
| `memory_scan_directory` | `ScanDirectoryParams` | `ScanResult` |
| `memory_cleanup` | `CleanupMemoryParams` | `CleanupResult` |

### CLI 命令

| 命令 | 参数 | 说明 |
|------|------|------|
| `ltm stats` | - | 显示统计 |
| `ltm tables` | - | 列出所有表 |
| `ltm search` | `query` | 搜索记忆 |
| `ltm query` | `filter` | 高级查询 |
| `ltm export` | `format` | 导出数据 |
| `ltm scan` | `directory` | 扫描目录 |
| `ltm cleanup` | `olderThan` | 清理数据 |

## 错误处理

### 错误类型

| 错误 | 处理 |
|------|------|
| 嵌入 API 失败 | 自动重试 (3 次) |
| 数据库连接失败 | 降级到本地存储 |
| 向量维度不匹配 | 抛出明确错误 |
| Prompt 注入检测 | 拒绝执行 |

### 错误信息

```typescript
// 示例错误信息
{
  "error": "embedding_api_error",
  "message": "Failed to generate embeddings: API rate limit exceeded",
  "retryable": true,
  "retryAfter": 60
}
```

## 流程图

### 存储流程

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  用户   │────▶│ 插件    │────▶│ Embedding│────▶│ 数据库  │
│  调用   │     │  入口   │     │  生成    │     │  存储   │
└─────────┘     └─────────┘     └─────────┘     └─────────┘
     │               │               │               │
     │ memory_store  │               │               │
     │──────────────▶│               │               │
     │               │  生成哈希      │               │
     │               │──────────────▶│               │
     │               │               │  向量化       │
     │               │               │──────────────▶│
     │               │               │               │
     │◌─────────────┼───────────────┼───────────────┤
     │  返回结果     │               │               │
```

### 检索流程

```
┌─────────┐     ┌─────────┐     ┌─────────┐     ┌─────────┐
│  用户   │────▶│ 插件    │────▶│ 向量    │────▶│ 数据库  │
│  调用   │     │  入口   │     │  搜索    │     │  检索   │
└─────────┘     └─────────┘     └─────────┘     └─────────┘
     │               │               │               │
     │ memory_recall │               │               │
     │──────────────▶│               │               │
     │               │  生成查询向量  │               │
     │               │──────────────▶│               │
     │               │               │  相似度搜索    │
     │               │               │──────────────▶│
     │               │               │               │
     │◌─────────────┼───────────────┼───────────────┤
     │  返回结果     │               │               │
```

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
