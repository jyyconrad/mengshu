# mengshu（梦枢）

> 面向多产品 Agent Runtime 的本地优先记忆中间件

mengshu（梦枢）是一个智能记忆管理系统，主要服务于 OpenClaw 类型产品之间的工作记忆连续性。它让同一用户在不同 Agent 产品之间切换时，工作记忆、协作偏好、长期约束、历史经验和可用资源仍然持续存在。

## 快速开始

### 安装

```bash
npm install -g mengshu
```

### 初始化配置

运行交互式配置向导：

```bash
ms init
```

这将引导你完成 LLM、Embedding 和数据库的配置。

### 基本使用

```bash
# 存储记忆
ms store "用户偏好使用 TypeScript"

# 召回记忆
ms recall "编程语言偏好"

# 查看记忆评分
ms why <记忆ID>

# 管理记忆
ms forget <记忆ID>
```

完整指南见 [快速开始](docs/guides/getting-started.md)。

## 核心特性

- **智能记忆捕获**：LLM 结构化提取 + 11 闸门验证，自动分类为 profile/task_context/rules/experience/resource
- **多模召回**：向量检索 + BM25 + RRF 融合，支持 6 档作用域（message/turn/session/project/app/global）
- **上下文构建**：5 槽位任务上下文，自动组织为可注入的 prompt
- **召回解释**：4 套评分体系（valueScore/importance/confidence/hotness）明细追溯
- **记忆管理**：撤回/归档/纠错/回滚四种操作，审计可回溯
- **语义去重**：entity 三级匹配（精确/别名/语义）+ embedding 相似度去重
- **知识图谱**：entity/relation 自动抽取，图中心性计算
- **记忆树**：L0-L3 折叠层（evidence → source → topic → global）
- **技能聚合**：experience → skill_candidate 自动升格
- **反馈闭环**：采纳率/停留/二次召回隐式信号反馈

## CLI 命令

```bash
# 记忆管理
ms store "记忆内容"              # 存储记忆
ms recall "查询"                # 召回记忆
ms search "关键词"              # 搜索记忆
ms why <记忆ID>                 # 查看评分明细
ms forget <记忆ID>              # 管理记忆（撤回/归档/纠错）

# 统计与诊断
ms stats                       # 查看统计信息
ms doctor                      # 健康检查
ms tables                      # 查看表结构

# 数据管理
ms scan ./docs                 # 扫描目录
ms import history.jsonl        # 导入 agent history
ms cleanup                     # 清理过期数据
ms migrate-home               # 迁移旧配置

# 服务
ms serve                       # 启动 REST server + Web Console
ms mcp                        # 启动 MCP Server
```

完整命令参考见 [CLI 命令文档](docs/api/cli-commands.md)。

## 集成方式

### OpenClaw 插件

```bash
openclaw plugin add memory-autodb
```

### MCP Server

```bash
ms mcp
```

支持 Claude Desktop、Cline、Zed 等 MCP 客户端。

### REST API

```bash
ms serve --port 3847
```

API 文档见 [Memory API](docs/api/memory-api.md)。

### 代码集成

```typescript
import { MemoryService } from 'mengshu';

const memory = new MemoryService({
  llm: {
    apiKey: process.env.OPENAI_API_KEY,
    extractionModel: 'gpt-4o-mini'
  },
  embedding: {
    model: 'text-embedding-3-small'
  },
  dbType: 'lancedb'
});

await memory.initialize();
await memory.store({ text: '用户偏好 TypeScript' });
const result = await memory.recall({ query: '编程语言偏好' });
```

详见 [集成指南](docs/guides/integration.md)。

## 配置

mengshu 使用三层配置：

1. 全局配置：`~/.mengshu/config.json`
2. 项目配置：`$PROJECT/.mengshu/config.json`
3. 环境变量覆盖

最小配置示例：

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "extractionModel": "gpt-4o-mini"
  },
  "dbType": "lancedb",
  "dbPath": "~/.mengshu/memory/lancedb"
}
```

完整配置说明见 [配置文档](docs/guides/configuration.md)。

## 文档

| 文档 | 说明 |
|------|------|
| [快速开始](docs/guides/getting-started.md) | 安装、配置、基本使用 |
| [配置说明](docs/guides/configuration.md) | 配置文件详解 |
| [集成指南](docs/guides/integration.md) | OpenClaw/MCP/REST/SDK 集成 |
| [最佳实践](docs/guides/best-practices.md) | 使用建议和优化 |
| [CLI 命令](docs/api/cli-commands.md) | 命令行工具完整参考 |
| [Memory API](docs/api/memory-api.md) | REST API 接口文档 |
| [系统架构](docs/architecture/system-architecture.md) | 架构设计 |
| [核心设计](docs/design/memory-system-unified-design.md) | 算法层设计文档 |

## 项目结构

```text
.
├── core/                         # 领域类型、评分集成、profile 分层
├── processing/                   # 评分公式、LLM 客户端
├── lifecycle/                    # 候选区、validator、去重、遗忘管理
├── graph/                        # 知识图谱、entity 匹配
├── tree/                         # 记忆树、L0-L3 摘要
├── retrieval/                    # 召回编排、融合排序
├── ingest/                       # 摄入管线、agent-history 导入
├── feedback/                     # 反馈闭环
├── adapters/                     # OpenClaw / MCP 适配
│   ├── openclaw/                 # OpenClaw 插件 + CLI
│   └── mcp/                      # MCP Server
├── api/                          # REST API
├── console/                      # Web Console
├── storage/                      # 存储抽象层
└── docs/                         # 文档
```

## 开发

### 运行测试

```bash
npm test                  # vitest run
npx tsc --noEmit          # 类型检查
npm run eval:quick        # golden set 评估
```

### 开发文档

- [CLAUDE.md](CLAUDE.md) - 项目概述（面向 AI）
- [AGENTS.md](AGENTS.md) - 代理指南（面向 AI）
- [CLAUDE.local.md](CLAUDE.local.md) - 详细开发文档导航（团队内部）
- [AGENTS.local.md](AGENTS.local.md) - 代理编排详解（团队内部）

## 版本

当前版本：**v1.0.2**

- 4 套评分体系（valueScore/importance/confidence/hotness）
- 11 闸门 validator
- LLM 结构化提取
- 语义去重
- L0-L3 树摘要
- skill_candidate 聚合
- 反馈闭环
- 用户可见面（ms why/explain/forget）

详见 [Changelog](docs/09-changelog/)。

## 许可

MIT License

## 贡献

欢迎贡献！请查看 [贡献指南](CONTRIBUTING.md)。

---

**内部开发文档**见 `.memory-docs/original-docs/`（不包含在开源发布中）。
