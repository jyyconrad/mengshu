# 技术栈

## 核心技术栈

### 语言和运行时

| 技术 | 版本 | 用途 |
|------|------|------|
| TypeScript | 5.x | 主要编程语言 |
| Node.js | 18+ | 运行时环境 |

### 依赖库

| 库 | 版本 | 用途 |
|---|------|------|
| @sinclair/typebox | ^0.34.15 | Schema 验证 |
| @lancedb/lancedb | ^0.10.0 | 本地向量数据库 |
| @supabase/supabase-js | ^2.39.0 | Supabase 客户端 |
| openai | ^4.87.3 | OpenAI API 客户端 |
| @anthropic-ai/sdk | ^0.39.0 | Anthropic SDK |
| command-line-args | ^6.0.0 | CLI 参数解析 |
| glob | ^10.3.10 | 文件匹配 |
| ignore | ^7.0.3 | .gitignore 解析 |

### 开发工具

| 工具 | 用途 |
|------|------|
| vitest | 测试框架 |
| eslint | 代码检查 |
| prettier | 代码格式化 |
| tsc | TypeScript 编译 |

## 嵌入模型支持

### OpenAI 模型

| 模型 | 维度 | 说明 |
|------|------|------|
| text-embedding-3-small | 1536 | 推荐，性价比高 |
| text-embedding-3-large | 3072 | 更高精度 |

### BAAI 模型

| 模型 | 维度 | 说明 |
|------|------|------|
| BAAI/bge-m3 | 1024 | 开源模型 |

### Ollama 模型（本地运行）

| 模型 | 维度 |
|------|------|
| nomic-embed-text | 768 |
| mxbai-embed-large | 1024 |
| all-minilm | 384 |
| snowflake-arctic-embed | 512-1024 |

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
