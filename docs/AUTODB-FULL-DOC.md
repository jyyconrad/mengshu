# AutoDB Memory Provider — 完整文档

> **版本**: v1.0 | **日期**: 2026-04-12 | **状态**: 已完成
> **插件位置**: `plugins/memory/autodb/`
> **测试**: 135 tests, 全通过

---

## 1. 概述

AutoDB 是 Hermes Agent 的向量语义记忆插件，提供**长期记忆**的存储与智能召回能力。作为 Hermes `MemoryProvider` 插件体系的外部 Provider，与内置的 `MEMORY.md` / `USER.md` 文件记忆互补。

### 核心能力

| 能力 | 说明 |
|------|------|
| **向量语义搜索** | 文本 → Embedding → pgvector/LanceDB 余弦相似度 |
| **全文搜索** | PostgreSQL `tsvector` + `ts_rank_cd` 排序 |
| **混合搜索 (RRF)** | 向量 + 全文融合，Reciprocal Rank Fusion |
| **自动捕获** | 每轮对话后自动提取值得记忆的信息 |
| **自动召回** | 每轮对话前预取相关记忆注入上下文 |
| **知识库路由** | 正则匹配自动分类到 `knowledge_*` 表 |
| **多后端** | LanceDB（本地零配置）/ PostgreSQL / Supabase |
| **安全过滤** | Prompt 注入检测 + HTML 转义 |

---

## 2. 架构

```
MemoryProvider (Hermes ABC)
  └── AutoDBMemoryProvider
        ├── EmbeddingClient       # OpenAI 兼容 Embedding API
        ├── DatabaseProvider      # 存储后端（多态）
        │     ├── LanceDBBackend  # 本地文件向量库
        │     ├── PostgresBackend # PostgreSQL + pgvector + tsvector
        │     └── SupabaseBackend # Supabase 云端
        └── RoutingEngine         # 知识库路由
```

### 数据流

**写入**:
```
用户对话 → sync_turn() / autodb_store
    ↓
text → compute_content_hash → 去重
    ↓
text → EmbeddingClient.embed() → vector
    ↓
RoutingEngine.route() → 目标表 (memories / knowledge_*)
    ↓
DatabaseProvider.store() → 写入后端
```

**召回**:
```
用户消息 → prefetch() / autodb_recall
    ↓
query → EmbeddingClient.embed() → vector
    ↓
query.dispatch(search_mode):
  - "vector" → pgvector cosine similarity
  - "text"   → tsvector full-text search
  - "hybrid" → RRF(vector ∪ text)
    ↓
格式化 → 注入 system prompt context
```

---

## 3. 文件结构

```
plugins/memory/autodb/
├── __init__.py          # AutoDBMemoryProvider + register()     (392 行)
├── plugin.yaml          # 插件元数据 + 依赖声明
├── config.py            # 配置加载/校验/模型维度映射           (305 行)
├── embedding.py         # OpenAI 兼容 Embedding 客户端         (176 行)
├── store.py             # create_provider 工厂方法              (119 行)
├── routing.py           # 知识库路由引擎                        (218 行)
├── utils.py             # 哈希/注入检测/转义                    (95 行)
├── cli.py               # hermes autodb CLI 命令                (68 行)
├── backends/
│   ├── __init__.py      # 导出所有后端
│   ├── base.py          # DatabaseProvider ABC + 数据类型       (176 行)
│   ├── lancedb.py       # LanceDB 本地后端                      (415 行)
│   ├── postgres.py      # PostgreSQL 后端 + tsvector + RRF     (785 行)
│   └── supabase.py      # Supabase 云端后端                     (444 行)
└── tests/
    ├── conftest.py      # 测试 fixtures + import alias
    ├── test_provider_abc.py    # MemoryProvider ABC 兼容测试
    ├── test_abc_inheritance.py # 继承关系验证
    ├── test_provider.py        # Provider 集成测试
    ├── test_store.py           # 工厂方法测试
    ├── test_embedding.py       # Embedding 客户端测试
    ├── test_supabase_backend.py # Supabase 后端测试
    └── test_postgres_text_search.py  # 全文搜索 + RRF 测试 (28 个)
```

**总代码量**: ~4,500 行 Python + ~540 行测试

---

## 4. 数据模型

### 4.1 MemoryEntry

```python
@dataclass
class MemoryEntry:
    id: str              # UUID (自动生成)
    text: str            # 原文内容
    content_hash: str    # SHA-256 去重哈希
    vector: list[float]  # Embedding 向量
    importance: float    # 重要性 0-1 (默认 0.7)
    category: str        # 分类标签
    data_type: str       # memory / knowledge
    table_name: str      # 目标表名
    metadata: dict       # JSON 元数据
    created_at: str      # ISO 时间戳
```

### 4.2 PostgreSQL 表结构

```sql
CREATE TABLE memories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    text        TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    vector      vector(dim) NOT NULL,
    importance  DOUBLE PRECISION DEFAULT 0.7,
    category    TEXT DEFAULT 'other',
    data_type   TEXT DEFAULT 'memory',
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    text_tsv    TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);

-- 索引
CREATE INDEX idx_memories_vector ON memories USING ivfflat (vector vector_cosine_ops);
CREATE INDEX idx_memories_text_tsv ON memories USING GIN (text_tsv);
CREATE INDEX idx_memories_content_hash ON memories (content_hash);
```

### 4.3 内置表

| 表名 | 用途 | 默认 importance |
|------|------|----------------|
| `memories` | 对话记忆 | 0.7 |
| `knowledge` | 通用知识库 | 0.5 |
| `knowledge_personal` | 个人知识（路由自动分类） | 0.5 |
| `knowledge_work` | 工作知识 | 0.5 |
| `knowledge_code` | 代码/编程知识 | 0.5 |
| `knowledge_learning` | 学习笔记 | 0.5 |

### 4.4 分类体系

```
core        — 核心记忆（姓名、身份）
preference  — 用户偏好
fact        — 事实
entity      — 实体（人名、项目名）
decision    — 决策记录
task        — 任务
plan        — 规划
goal        — 目标
other       — 其他
```

---

## 5. 搜索模式

### 5.1 向量搜索 (search_mode="vector")

**默认模式**。基于 Embedding 余弦相似度。

```python
options = MemoryQueryOptions(
    vector=[...],          # query embedding
    limit=5,
    min_score=0.1,
    table_name="memories", # 或 search_all=True
)
```

**SQL 核心**:
```sql
SELECT *, 1 - (vector <=> $1::vector) AS similarity
FROM memories
ORDER BY vector <=> $1::vector
LIMIT $2;
```

### 5.2 全文搜索 (search_mode="text")

基于 PostgreSQL `tsvector`，使用 `plainto_tsquery` 安全转换查询文本。

```python
options = MemoryQueryOptions(
    text_query="Python 编程最佳实践",
    search_mode="text",
    limit=10,
)
```

**SQL 核心**:
```sql
SELECT *, ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) AS text_score
FROM memories
WHERE text_tsv @@ plainto_tsquery('english', $1)
ORDER BY text_score DESC
LIMIT $2;
```

**优势**:
- 精确关键词匹配（向量搜索可能忽略）
- 不需要 Embedding 调用（零延迟）
- 适合已知确切术语的搜索

### 5.3 混合搜索 (search_mode="hybrid")

**Reciprocal Rank Fusion (RRF)** 融合向量搜索 + 全文搜索结果。

```
rrf_score(d) = α × (1 / (k + rank_vector(d)))
             + (1-α) × (1 / (k + rank_text(d)))
```

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `rrf_k` | 60 | RRF 常数，越大则排名差异影响越小 |
| `vector_weight` | 0.7 | 向量搜索权重 α（0-1），文本权重 = 1-α |

```python
options = MemoryQueryOptions(
    vector=[...],
    text_query="Python 编程",
    search_mode="hybrid",
    rrf_k=60,
    vector_weight=0.7,
)
```

**适用场景**: 同时需要语义理解 + 关键词精确匹配的复合查询。

---

## 6. 配置

### 6.1 config.yaml 完整配置

```yaml
memory:
  provider: autodb

autodb:
  # --- Embedding 配置 ---
  embedding:
    api_key: ${SILICONFLOW_API_KEY}     # 必填
    base_url: https://api.siliconflow.cn/v1
    model: BAAI/bge-m3

  # --- 后端选择 ---
  db_type: lancedb    # lancedb | postgres | supabase

  # --- LanceDB 配置 (db_type=lancedb) ---
  db_path: ~/.hermes/memory/autodb

  # --- PostgreSQL 配置 (db_type=postgres) ---
  # postgres:
  #   host: localhost
  #   port: 5432
  #   database: hermes
  #   user: postgres
  #   password: ${PG_PASSWORD}
  #   ssl: prefer

  # --- Supabase 配置 (db_type=supabase) ---
  # supabase:
  #   url: https://xxx.supabase.co
  #   service_key: ${SUPABASE_SERVICE_KEY}

  # --- 行为配置 ---
  auto_capture: true        # 自动捕获对话记忆
  auto_recall: true         # 自动召回相关记忆
  capture_max_chars: 500    # 自动捕获最大字符数

  # --- 批处理 ---
  batch_processing:
    max_batch_size: 50
    concurrency: 4
    retry_attempts: 3

  # --- 知识库 ---
  knowledge_bases:
    enabled: true
    auto_create_tables: true
    builtin_categories: ["personal", "work", "code", "learning"]
    custom_categories: ["finance"]    # 自动创建 knowledge_finance 表

  # --- 路由规则 ---
  routing_rules:
    - name: personal
      patterns: ["个人|笔记|日记|diary|随笔"]
      target_table: knowledge_personal
      enabled: true
    - name: work
      patterns: ["工作|项目|work|project|任务"]
      target_table: knowledge_work
      enabled: true
```

### 6.2 Embedding 模型选择

| 模型 | 维度 | 来源 | 推荐场景 |
|------|------|------|----------|
| `BAAI/bge-m3` | 1024 | SiliconFlow / Ollama | **首选**，中英文兼顾 |
| `text-embedding-3-small` | 1536 | OpenAI | 英文为主 |
| `text-embedding-3-large` | 3072 | OpenAI | 最高精度 |
| `nomic-embed-text` | 768 | Ollama | 本地隐私 |
| `all-minilm` | 384 | Ollama | 轻量本地 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 | ModelScope | 中文优化 |

### 6.3 后端选择建议

| 后端 | 优点 | 缺点 | 推荐场景 |
|------|------|------|----------|
| **LanceDB** | 零配置、本地文件、无需数据库 | 不支持全文搜索 | 快速开始、开发调试 |
| **PostgreSQL** | 全文搜索、混合查询、成熟稳定 | 需要 PG 实例 | **生产推荐** |
| **Supabase** | 云端托管、零运维 | 网络延迟、付费 | 多设备同步 |

### 6.4 OpenClaw 配置 Fallback

如果 Hermes `config.yaml` 未配置 embedding api_key，自动读取 `~/.openclaw/conf/plugins.json` 中的 `memory-autodb` 配置。

---

## 7. 工具 API

Agent 可使用的 4 个工具：

### 7.1 autodb_recall

```json
{
  "name": "autodb_recall",
  "parameters": {
    "query": "搜索查询文本",
    "limit": 5,
    "min_score": 0.1,
    "category": "fact",
    "search_all": false,
    "knowledge_base": "knowledge_work"
  }
}
```

### 7.2 autodb_store

```json
{
  "name": "autodb_store",
  "parameters": {
    "text": "要记忆的内容",
    "importance": 0.7,
    "category": "preference",
    "metadata": {"source": "user"}
  }
}
```

### 7.3 autodb_stats

```json
{"name": "autodb_stats", "parameters": {}}
```

返回各表行数统计。

### 7.4 autodb_delete

```json
{
  "name": "autodb_delete",
  "parameters": {
    "ids": ["uuid-1", "uuid-2"],
    "filter": {"category": "task"}
  }
}
```

---

## 8. CLI 命令

```bash
# 查看各表统计
hermes autodb stats

# 列出所有表
hermes autodb tables

# 语义搜索
hermes autodb search "Python 最佳实践" --limit 10 --min-score 0.2

# 指定表搜索
hermes autodb search "项目进度" --table knowledge_work

# 删除记忆
hermes autodb delete --ids uuid1 uuid2
```

---

## 9. 使用场景与最佳实践

### 9.1 快速开始（LanceDB 本地）

```yaml
# ~/.hermes/config.yaml
memory:
  provider: autodb

autodb:
  embedding:
    api_key: ${SILICONFLOW_API_KEY}
    base_url: https://api.siliconflow.cn/v1
    model: BAAI/bge-m3
  db_type: lancedb
```

```bash
# 确保 .env 中有 SILICONFLOW_API_KEY
hermes chat
# 自动激活：自动召回 + 自动捕获
```

### 9.2 生产部署（PostgreSQL 混合搜索）

```yaml
autodb:
  embedding:
    api_key: ${SILICONFLOW_API_KEY}
    base_url: https://api.siliconflow.cn/v1
    model: BAAI/bge-m3
  db_type: postgres
  postgres:
    host: localhost
    port: 5432
    database: hermes_memory
    user: hermes
    password: ${PG_PASSWORD}
  auto_capture: true
  auto_recall: true
  knowledge_bases:
    enabled: true
    auto_create_tables: true
```

PostgreSQL 建表 DDL（首次 initialize 自动执行）：
```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- 表会自动创建，含 tsvector 生成列
-- 无需手动建表
```

### 9.3 知识库路由自定义

```yaml
autodb:
  routing_rules:
    - name: finance
      patterns: ["财务|预算|budget|finance|投资|investment"]
      target_table: knowledge_finance
    - name: health
      patterns: ["健康|运动|health|exercise|饮食|diet"]
      target_table: knowledge_health
    - name: devops
      patterns: ["部署|deploy|CI/CD|docker|k8s|kubernetes"]
      target_table: knowledge_devops
```

### 9.4 Gateway 多平台使用

autodb 在 Gateway 模式下自动工作：

1. **Feishu/Telegram/Discord** 用户发消息
2. `queue_prefetch()` 后台预取相关记忆
3. 记忆注入 system prompt context
4. 对话结束后 `sync_turn()` 自动捕获
5. `on_memory_write()` 镜像内置记忆写入

### 9.5 搜索模式选择策略

| 场景 | 推荐模式 | 原因 |
|------|----------|------|
| 语义模糊查询 | `vector` | "如何提高代码质量" → 匹配相关讨论 |
| 精确关键词 | `text` | "Q3 预算" → 精确匹配文档 |
| 综合查询 | `hybrid` | "部署 Python 服务的最佳实践" → 语义 + 关键词 |
| 自动召回 | `vector` | 用户消息 embedding → 最相关记忆 |

> **注意**: 当前 `autodb_recall` 工具默认使用 vector 模式。如需启用 hybrid，可在 `_handle_recall()` 中根据查询长度自动选择。

---

## 10. 与 OpenClaw 数据兼容

| 功能 | 说明 |
|------|------|
| LanceDB 数据复用 | 直接指向 OpenClaw 的 db_path 即可读取 |
| PostgreSQL 数据共享 | 同一个 PG 数据库，表结构兼容 |
| 配置 Fallback | 自动读取 `~/.openclaw/conf/plugins.json` |

---

## 11. 性能调优

### Embedding 批处理

```yaml
autodb:
  batch_processing:
    max_batch_size: 50     # 每批最大文本数
    concurrency: 4         # 并发请求数
    retry_attempts: 3      # 失败重试次数
```

### PostgreSQL 索引

```sql
-- 数据量 < 10万行
-- IVFFlat 索引足够

-- 数据量 > 10万行
-- 考虑 HNSW 索引（更快的查询，更慢的写入）
CREATE INDEX idx_memories_vector_hnsw ON memories
  USING hnsw (vector vector_cosine_ops);
```

### 连接池

```python
# postgres.py 默认配置
ThreadedConnectionPool(minconn=1, maxconn=10)
```

---

## 12. 安全

| 措施 | 说明 |
|------|------|
| **Prompt 注入检测** | 28 条正则规则拦截恶意输入 |
| **参数化查询** | 所有 SQL 使用 `%s` 参数，杜绝注入 |
| **标识符转义** | 表名/列名用双引号包裹，验证 `[a-zA-Z_][a-zA-Z0-9_]*` |
| **HTML 转义** | 记忆注入 prompt 前自动转义 `& < > " '` |
| **内容去重** | SHA-256 哈希 + `ON CONFLICT DO NOTHING` |
| **环境变量** | API Key 通过 `${VAR}` 引用，不硬编码 |

---

## 13. 测试

```bash
# 运行全部 135 个测试
cd ~/.hermes/hermes-agent
source venv/bin/activate
python -m pytest plugins/memory/autodb/tests/ -v

# 仅跑全文搜索 + RRF 测试
python -m pytest plugins/memory/autodb/tests/test_postgres_text_search.py -v

# 仅跑 Provider 集成测试
python -m pytest plugins/memory/autodb/tests/test_provider.py -v
```

**测试分布**:

| 测试文件 | 用例数 | 覆盖范围 |
|----------|--------|----------|
| test_provider_abc.py | ~15 | MemoryProvider ABC 兼容性 |
| test_abc_inheritance.py | 4 | 继承关系、注册机制 |
| test_provider.py | ~12 | Provider 集成功能 |
| test_store.py | ~8 | 工厂方法、多后端创建 |
| test_embedding.py | ~14 | Embedding 客户端、重试、批处理 |
| test_supabase_backend.py | ~50 | Supabase 全流程 CRUD |
| test_postgres_text_search.py | 28 | DDL、text_search、RRF、dispatch |

---

## 14. 依赖

```yaml
# plugin.yaml
pip_dependencies:
  - httpx          # Embedding API 调用（必需）
  - lancedb        # LanceDB 本地向量库（db_type=lancedb 时）
  - psycopg2-binary  # PostgreSQL 连接（db_type=postgres 时）
  - supabase       # Supabase 客户端（db_type=supabase 时）
```

---

## 15. 未来增强方向 (P2)

| 方向 | 说明 |
|------|------|
| 记忆衰减 | 按时间/访问频率降低 importance |
| 记忆合并 | 相似记忆自动合并去重 |
| 多用户隔离 | Gateway 场景按 user_id 隔离 |
| recall 智能模式 | autodb_recall 自动选择 vector/text/hybrid |
| Grafana 面板 | 记忆使用统计可视化 |
| 跨 Provider 迁移 | LanceDB → PostgreSQL 数据迁移工具 |
