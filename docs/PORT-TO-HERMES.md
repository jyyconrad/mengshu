# Memory-AutoDB Hermes 移植方案

> 版本: v1.0 | 日期: 2026-04-11 | 状态: 需求确认

---

## 1. 背景与目标

### 1.1 现状

- **OpenClaw** 已有成熟的 `memory-autodb` 插件（TypeScript），支持 LanceDB / PostgreSQL / Supabase 三种后端，具备自动捕获、自动召回、目录扫描、知识库路由等能力
- **Hermes Agent** 已有 `MemoryProvider` 插件接口（Python ABC），支持 holographic（SQLite）、mem0、retaindb 等外部 Provider
- 两个系统的记忆数据**完全独立**，无法互通

### 1.2 目标

将 memory-autodb 的核心能力移植为 Hermes 的 `autodb` 记忆插件，使 Hermes 拥有：

1. **向量语义记忆** — 基于 Embedding 的存储与召回
2. **多后端支持** — LanceDB（本地零配置）+ PostgreSQL + Supabase
3. **自动捕获/召回** — 对话中自动提取和注入记忆
4. **兼容现有数据** — 复用 OpenClaw 已存储的 LanceDB/PG 数据
5. **知识库路由** — 内容自动分类到不同知识库表

### 1.3 非目标

| 不做 | 原因 |
|------|------|
| 目录扫描（scanner）| Hermes 已有 skill/文件系统工具，不重复 |
| 文本切片（text-splitter）| 无直接场景，后续可加 |
| Node.js 混合调用 | 纯 Python 实现，无 Node 依赖 |
| 替换 Hermes 内置记忆 | `MEMORY.md`/`USER.md` 保留，autodb 是**补充** |

---

## 2. 功能需求

### 2.1 核心功能（P0）

| ID | 功能 | 说明 |
|----|------|------|
| F01 | **向量存储** | 文本 → Embedding → 存入向量库（支持去重） |
| F02 | **语义召回** | Query → Embedding → 向量搜索 → Top-K 结果 |
| F03 | **多后端** | LanceDB / PostgreSQL(pgvector) / Supabase 三选一 |
| F04 | **配置管理** | 兼容 OpenClaw 的 `config.json` 格式 + Hermes `config.yaml` |
| F05 | **工具暴露** | 向 Hermes 暴露 `autodb_recall`、`autodb_store` 等工具 |
| F06 | **自动召回** | 每轮对话前自动检索相关记忆注入上下文 |

### 2.2 增强功能（P1）

| ID | 功能 | 说明 |
|----|------|------|
| F07 | **自动捕获** | 每轮对话后自动提取值得记忆的信息 |
| F08 | **知识库路由** | 按内容正则匹配自动路由到 knowledge_* 表 |
| F09 | **统计与维护** | `autodb_stats` 查看各表数据量，`autodb_delete` 清理 |
| F10 | **数据迁移** | 从 OpenClaw 已有 LanceDB/PG 数据直接读取 |

### 2.3 未来功能（P2）

| ID | 功能 | 说明 |
|----|------|------|
| F11 | 记忆衰减 | 按时间/访问频率降低 importance |
| F12 | 记忆合并 | 相似记忆自动合并 |
| F13 | 多用户隔离 | Gateway 场景按 user_id 隔离记忆 |

---

## 3. 技术架构

### 3.1 模块结构

```
~/.hermes/hermes-agent/plugins/memory/autodb/
├── __init__.py          # AutoDBMemoryProvider + register()
├── plugin.yaml          # 插件元数据
├── config.py            # 配置加载、校验、模型维度映射
├── embedding.py         # OpenAI 兼容 Embedding 客户端
├── store.py             # DatabaseProvider ABC + 工厂方法
├── backends/
│   ├── __init__.py
│   ├── base.py          # DatabaseProvider 抽象基类
│   ├── lancedb.py       # LanceDB 后端（本地文件）
│   ├── postgres.py      # PostgreSQL + pgvector 后端
│   └── supabase.py      # Supabase 后端
├── routing.py           # 知识库路由引擎
└── utils.py             # 哈希、安全检查等工具函数
```

### 3.2 类关系

```
MemoryProvider (Hermes ABC)
  └── AutoDBMemoryProvider
        ├── EmbeddingClient     # Embedding API 调用
        ├── DatabaseProvider    # 存储后端（多态）
        │     ├── LanceDBBackend
        │     ├── PostgresBackend
        │     └── SupabaseBackend
        └── RoutingEngine       # 知识库路由（可选）
```

### 3.3 数据流

#### 写入流程

```
用户对话 → sync_turn() / autodb_store 工具
    ↓
text → compute_content_hash → 去重检查
    ↓
text → EmbeddingClient.embed() → vector
    ↓
RoutingEngine.route() → 确定目标表 (memories / knowledge / knowledge_*)
    ↓
DatabaseProvider.store(entry) → 写入后端
```

#### 召回流程

```
用户消息 → prefetch() / queue_prefetch()
    ↓
query → EmbeddingClient.embed() → vector
    ↓
DatabaseProvider.query(vector, limit, filters) → 结果列表
    ↓
格式化 → 注入 system prompt context
```

---

## 4. 数据模型

### 4.1 统一 MemoryEntry（Python）

```python
@dataclass
class MemoryEntry:
    id: str                          # UUID
    text: str                        # 原文
    content_hash: str                # MD5 去重
    vector: list[float]              # Embedding 向量
    importance: float                # 重要性 0-1
    category: str                    # 分类: core/preference/fact/entity/decision/task/plan/goal/other
    data_type: str                   # memory / knowledge
    table_name: str                  # memories / knowledge / knowledge_*
    metadata: dict                   # JSON 元数据
    created_at: int                  # 时间戳 ms
```

### 4.2 表结构（所有后端统一）

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| text | TEXT | 原文内容 |
| content_hash | TEXT | MD5 哈希（唯一约束） |
| vector | VECTOR(dim) | Embedding 向量 |
| importance | FLOAT | 重要性评分 (默认 memories=0.7, knowledge=0.5) |
| category | TEXT | 分类标签 |
| data_type | TEXT | memory / knowledge |
| metadata | JSON/JSONB | 扩展元数据 |
| created_at | TIMESTAMP | 创建时间 |

### 4.3 内置表

| 表名 | 用途 |
|------|------|
| `memories` | 对话记忆（核心记忆、偏好、事实、决策等） |
| `knowledge` | 通用知识库 |
| `knowledge_personal` | 个人知识库（路由规则自动分类） |
| `knowledge_work` | 工作知识库（路由规则自动分类） |

### 4.4 分类体系

```python
MEMORY_CATEGORIES = [
    "core",        # 核心记忆
    "preference",  # 用户偏好
    "fact",        # 事实
    "entity",      # 实体
    "decision",    # 决策
    "task",        # 任务
    "plan",        # 规划
    "goal",        # 目标
    "other",       # 其他
]
```

---

## 5. Embedding 配置

### 5.1 支持的模型与维度

| 模型 | 维度 | 来源 |
|------|------|------|
| `text-embedding-3-small` | 1536 | OpenAI |
| `text-embedding-3-large` | 3072 | OpenAI |
| `BAAI/bge-m3` | 1024 | SiliconFlow / Ollama |
| `nomic-embed-text` | 768 | Ollama |
| `mxbai-embed-large` | 1024 | Ollama |
| `all-minilm` | 384 | Ollama |
| `snowflake-arctic-embed` | 1024 | Ollama |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | ModelScope |

### 5.2 EmbeddingClient 设计

- 基于 `httpx` 或 `openai` Python SDK（支持 `base_url` 自定义）
- 批量 + 重试（指数退避）
- 并发控制
- 兼容 SiliconFlow / Ollama / OpenAI 等 OpenAI API 兼容服务

---

## 6. 配置格式

### 6.1 Hermes config.yaml 方式

```yaml
memory:
  provider: autodb

autodb:
  embedding:
    apiKey: ${SILICONFLOW_API_KEY}
    baseURL: https://api.siliconflow.cn/v1
    model: BAAI/bge-m3
  dbType: lancedb          # lancedb | postgres | supabase
  dbPath: ~/.hermes/memory/autodb   # LanceDB 专用
  # postgres:              # PostgreSQL 专用
  #   host: localhost
  #   port: 5432
  #   database: memory
  #   user: postgres
  #   password: ${PG_PASSWORD}
  #   ssl: false
  # supabase:              # Supabase 专用
  #   url: https://xxx.supabase.co
  #   serviceKey: ${SUPABASE_SERVICE_KEY}
  autoCapture: true
  autoRecall: true
  captureMaxChars: 500
  batchProcessing:
    maxBatchSize: 20
    concurrency: 3
    retryAttempts: 3
  knowledgeBases:
    enabled: true
    autoCreateTables: true
    builtinCategories: ["personal", "work"]
  routingRules:
    - name: personal
      patterns: ["个人 | 笔记 | 日记 | diary"]
      targetTable: knowledge_personal
      enabled: true
    - name: work
      patterns: ["工作 | 项目 | work | project"]
      targetTable: knowledge_work
      enabled: true
```

### 6.2 兼容 OpenClaw 配置

插件自动检测 `~/.openclaw/conf/plugins.json` 中 `memory-lancedb` / `memory-autodb` 配置，如 Hermes config.yaml 未配置则 fallback 读取。

---

## 7. 工具 API 设计

### 7.1 autodb_recall

```json
{
  "name": "autodb_recall",
  "description": "语义搜索长期记忆。支持分类过滤、跨表搜索、知识库指定。",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "搜索查询" },
      "limit": { "type": "integer", "description": "最大结果数 (默认 5)" },
      "min_score": { "type": "number", "description": "最低相似度 0-1 (默认 0.1)" },
      "category": { "type": "string", "description": "分类过滤" },
      "search_all": { "type": "boolean", "description": "跨所有表搜索" },
      "knowledge_base": { "type": "string", "description": "指定知识库表" }
    },
    "required": ["query"]
  }
}
```

### 7.2 autodb_store

```json
{
  "name": "autodb_store",
  "description": "存储重要信息到长期记忆。支持自动分类路由和去重。",
  "parameters": {
    "type": "object",
    "properties": {
      "text": { "type": "string", "description": "要记忆的内容" },
      "importance": { "type": "number", "description": "重要性 0-1 (默认 0.7)" },
      "category": { "type": "string", "description": "分类标签" },
      "metadata": { "type": "object", "description": "自定义元数据" }
    },
    "required": ["text"]
  }
}
```

### 7.3 autodb_stats

```json
{
  "name": "autodb_stats",
  "description": "查看各记忆表的统计信息。",
  "parameters": { "type": "object", "properties": {} }
}
```

### 7.4 autodb_delete

```json
{
  "name": "autodb_delete",
  "description": "删除指定记忆。支持按 ID 或过滤条件删除。",
  "parameters": {
    "type": "object",
    "properties": {
      "ids": { "type": "array", "items": { "type": "string" }, "description": "要删除的记忆 ID" },
      "filter": { "type": "object", "description": "过滤条件" }
    }
  }
}
```

---

## 8. Hermes MemoryProvider 接口实现

### 8.1 生命周期映射

| MemoryProvider 方法 | autodb 实现 |
|---------------------|-------------|
| `name` | 返回 `"autodb"` |
| `is_available()` | 检查配置文件存在 + embedding API key 非空 + 后端依赖已装 |
| `initialize(session_id, **kwargs)` | 加载配置 → 创建 EmbeddingClient → 创建 DatabaseProvider → 初始化表 |
| `system_prompt_block()` | 返回 autodb 使用说明 |
| `prefetch(query)` | 返回缓存的预取结果（由 queue_prefetch 产生） |
| `queue_prefetch(query)` | 后台线程：query → embed → 向量搜索 → 缓存结果 |
| `sync_turn(user, assistant)` | 如果 autoCapture=true，后台提取并存储 |
| `get_tool_schemas()` | 返回 4 个工具 schema |
| `handle_tool_call(name, args)` | 分发到对应处理函数 |
| `shutdown()` | 关闭后端连接，刷新队列 |
| `on_memory_write(action, target, content)` | 镜像 Hermes 内置记忆写入到 autodb |

### 8.2 注册方式

```python
# __init__.py
def register(ctx):
    ctx.register_memory_provider(AutoDBMemoryProvider())
```

---

## 9. 依赖

### 9.1 Python 包

| 包 | 用途 | 必需 |
|----|------|------|
| `httpx` | Embedding API 调用 | ✅ |
| `lancedb` | LanceDB 本地向量库 | dbType=lancedb 时 |
| `psycopg2-binary` 或 `asyncpg` | PostgreSQL 连接 | dbType=postgres 时 |
| `supabase` | Supabase 客户端 | dbType=supabase 时 |

### 9.2 plugin.yaml 声明

```yaml
name: autodb
version: 0.1.0
description: "AutoDB 记忆插件 — LanceDB/PostgreSQL/Supabase 向量语义记忆，自动捕获/召回，知识库路由"
pip_dependencies:
  - httpx
  - lancedb
hooks:
  - on_session_end
  - on_memory_write
```

---

## 10. 实施计划

### Phase 1: 核心存储（P0）

| 步骤 | 内容 | 估时 |
|------|------|------|
| 1 | 创建插件骨架 + plugin.yaml + register() | 0.5h |
| 2 | 实现 config.py（配置加载/校验/模型映射） | 1h |
| 3 | 实现 embedding.py（OpenAI 兼容客户端） | 1h |
| 4 | 实现 backends/base.py + lancedb.py | 2h |
| 5 | 实现 store.py 工厂方法 | 0.5h |
| 6 | 实现 __init__.py（AutoDBMemoryProvider） | 2h |
| 7 | 测试 LanceDB 存储 + 召回 | 1h |

### Phase 2: 工具与自动召回（P0-P1）

| 步骤 | 内容 | 估时 |
|------|------|------|
| 8 | 实现 4 个工具 schema + handle_tool_call | 1.5h |
| 9 | 实现 prefetch / queue_prefetch 自动召回 | 1h |
| 10 | 实现自动捕获（sync_turn） | 1h |
| 11 | 集成测试 | 1h |

### Phase 3: 多后端 + 增强（P1）

| 步骤 | 内容 | 估时 |
|------|------|------|
| 12 | 实现 postgres.py 后端 | 1.5h |
| 13 | 实现 supabase.py 后端 | 1.5h |
| 14 | 实现 routing.py 知识库路由 | 1h |
| 15 | 实现 autodb_stats / autodb_delete | 0.5h |
| 16 | 兼容 OpenClaw 配置 fallback | 0.5h |
| 17 | 端到端测试 | 1h |

**总估时**: ~17h

---

## 11. 验收标准

| # | 标准 | 优先级 |
|---|------|--------|
| 1 | `hermes memory setup` 可选择 autodb 并完成配置 | P0 |
| 2 | `autodb_store` 工具可写入记忆到 LanceDB | P0 |
| 3 | `autodb_recall` 工具可通过语义搜索召回 | P0 |
| 4 | 自动召回（prefetch）每轮对话前注入相关记忆 | P0 |
| 5 | PostgreSQL 后端可正常存储和搜索 | P1 |
| 6 | 自动捕获从对话中提取并存储记忆 | P1 |
| 7 | 知识库路由自动分类内容到对应表 | P1 |
| 8 | 复用 OpenClaw 已有 LanceDB 数据（无需迁移） | P1 |
| 9 | Supabase 后端可正常工作 | P2 |
| 10 | 内置记忆写入自动镜像到 autodb | P2 |

---

## 12. 风险与注意事项

| 风险 | 缓解措施 |
|------|---------|
| LanceDB Python API 与 Node.js API 差异 | 已对比确认核心 API 兼容，元数据序列化需注意 JSON string vs dict |
| Embedding API 延迟影响对话体验 | prefetch 使用后台线程预取，sync_turn 异步队列化 |
| PostgreSQL pgvector 索引需手动创建 | 提供 `supabase-rpc-functions.sql` 等建表脚本 |
| Hermes 同步执行模型 vs 异步 IO | LanceDB/PG 操作均为同步调用，与 Hermes agent loop 一致 |
| 配置兼容性 | 优先读 Hermes config.yaml，fallback 读 OpenClaw plugins.json |
