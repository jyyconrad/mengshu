# Memory API

## 工具函数列表

| 工具 | 方法 | 描述 |
|------|------|------|
| `memory_store` | POST | 存储记忆 |
| `memory_recall` | POST | 检索记忆 |
| `memory_scan_directory` | POST | 扫描目录 |
| `memory_cleanup` | POST | 清理数据 |

---

## memory_store

### 接口定义

**描述**: 存储单条记忆到数据库

**工具调用**:
```typescript
{
  "name": "memory_store",
  "parameters": {
    "text": "string",
    "storageCategory": "核心记忆" | "知识库",  // 可选
    "importance": number,                       // 可选，默认 0.7
    "category": string,                         // 可选
    "metadata": object                          // 可选
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `text` | string | 是 | - | 要存储的文本内容 |
| `storageCategory` | string | 否 | "核心记忆" | 存储分类 |
| `importance` | number | 否 | 0.7 | 重要性分数 (0-1) |
| `category` | string | 否 | "other" | 记忆分类 |
| `metadata` | object | 否 | {} | 自定义元数据 |

**响应示例**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "记忆已存储:\n- ID: mem_123456789\n- 分类：核心记忆\n- 重要性：0.8\n- 创建时间：2026-03-11T10:00:00Z"
    }
  ]
}
```

**状态码**:
| 状态 | 说明 |
|------|------|
| 成功 | 记忆存储成功 |
| 错误 | 嵌入生成失败/数据库错误 |

---

## memory_recall

### 接口定义

**描述**: 检索相关记忆

**工具调用**:
```typescript
{
  "name": "memory_recall",
  "parameters": {
    "query": "string",
    "category": "核心记忆" | "知识库",  // 可选
    "limit": number,                    // 可选，默认 5
    "includeDocuments": boolean,        // 可选，默认 false
    "filter": object                    // 可选
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | - | 搜索查询 |
| `category` | string | 否 | "核心记忆" | 存储分类 |
| `limit` | number | 否 | 5 | 返回数量 |
| `includeDocuments` | boolean | 否 | false | 包含文档 |
| `filter` | object | 否 | - | 元数据过滤 |

**响应示例**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "找到 3 条相关记忆:\n\n[1] [相似度：0.92] 用户偏好使用 TypeScript 编写代码\n    分类：preference | 重要性：0.8\n\n[2] [相似度：0.85] 项目使用 PostgreSQL 数据库\n    分类：fact | 重要性：0.9\n\n[3] [相似度：0.78] 每天上午 10 点执行数据备份\n    分类：task | 重要性：0.7"
    }
  ]
}
```

---

## memory_scan_directory

### 接口定义

**描述**: 扫描目录构建知识库

**工具调用**:
```typescript
{
  "name": "memory_scan_directory",
  "parameters": {
    "directory": "string",
    "category": "知识库",           // 可选
    "autoEnrichMetadata": true,     // 可选
    "ignorePaths": string[],        // 可选
    "ignoreRules": string[]         // 可选
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `directory` | string | 是 | - | 要扫描的目录 |
| `category` | string | 否 | "知识库" | 存储分类 |
| `autoEnrichMetadata` | boolean | 否 | true | 自动丰富元数据 |
| `ignorePaths` | string[] | 否 | [] | 忽略路径 |
| `ignoreRules` | string[] | 否 | [] | 忽略规则 |

**响应示例**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "目录扫描完成:\n- 扫描目录：/path/to/docs\n- 总文件数：156\n- 成功处理：152\n- 失败：4\n- 总块数：892\n- 新增存储：821\n- 重复跳过：71"
    }
  ]
}
```

---

## memory_cleanup

### 接口定义

**描述**: 清理旧数据

**工具调用**:
```typescript
{
  "name": "memory_cleanup",
  "parameters": {
    "category": "核心记忆" | "知识库",  // 可选
    "dataType": "memory" | "document",  // 可选
    "olderThanDays": number,            // 可选
    "filter": object                    // 可选
  }
}
```

**参数说明**:

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `category` | string | 否 | - | 存储分类 |
| `dataType` | string | 否 | - | 数据类型 |
| `olderThanDays` | number | 否 | - | 清理 N 天前的数据 |
| `filter` | object | 否 | - | 额外过滤条件 |

**响应示例**:
```json
{
  "content": [
    {
      "type": "text",
      "text": "数据清理完成:\n- 清理条件：> 30 天\n- 删除条目：125\n- 释放空间：2.5 MB"
    }
  ]
}
```

---

## 错误响应

### 通用错误格式

```json
{
  "content": [
    {
      "type": "text",
      "text": "错误：{错误信息}"
    }
  ]
}
```

### 常见错误

| 错误 | 原因 | 解决 |
|------|------|------|
| 嵌入生成失败 | API 限额/网络问题 | 检查 API 密钥/重试 |
| 数据库连接失败 | 数据库不可用 | 检查连接配置 |
| 目录不存在 | 路径错误 | 检查路径 |
| 权限不足 | Supabase 权限问题 | 检查 service key |

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
