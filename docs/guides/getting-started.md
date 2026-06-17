# 快速开始

## 安装

```bash
npm install -g mengshu
# 或者
pnpm add mengshu
```

## 初始化配置

运行交互式配置向导：

```bash
ms init
```

这将引导你完成：
1. LLM 配置（API key、model）
2. Embedding 配置
3. 数据库类型选择（LanceDB / PostgreSQL / Supabase）

配置文件生成位置：
- 全局配置：`~/.mengshu/config.json`
- 项目配置：`$PROJECT/.mengshu/config.json`

## 基本使用

### 自动捕获记忆

在代码中启用自动捕获：

```typescript
import { MemoryService } from 'mengshu';

const memory = new MemoryService({
  autoCapture: true,
  autoRecall: true
});

// 自动捕获对话中的关键信息
await memory.processMessage({
  role: 'user',
  content: '我偏好使用 TypeScript 而不是 JavaScript'
});
```

### 手动存储记忆

```typescript
await memory.store({
  text: '用户偏好使用 TypeScript',
  semanticType: 'profile',
  targetScope: 'global'
});
```

### 召回记忆

```typescript
const memories = await memory.recall({
  query: '用户的编程语言偏好',
  limit: 5
});
```

## 命令行工具

```bash
# 诊断配置
ms doctor

# 查看记忆评分明细
ms why <记忆ID>

# 召回并解释
ms recall "查询内容" --explain

# 删除/归档记忆
ms forget <记忆ID>

# 导入 agent history
ms import ./agent-history.jsonl
```

## 下一步

- [配置详解](configuration.md)
- [集成指南](integration.md)
- [CLI 命令参考](../api/cli-commands.md)
