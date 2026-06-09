# CLI 命令

## 命令列表

| 命令 | 参数 | 描述 |
|------|------|------|
| `ltm stats` | - | 显示统计 |
| `ltm tables` | - | 列出所有表 |
| `ltm search` | `query` | 搜索记忆 |
| `ltm query` | `filter` | 高级查询 |
| `ltm export` | `format` | 导出数据 |
| `ltm scan` | `directory` | 扫描目录 |
| `ltm cleanup` | `options` | 清理数据 |
| `ltm serve` | `--host --port` | 启动本机 REST server 和 `/console` |
| `ltm status` | - | 查看 middleware 状态 |
| `ltm health` | - | 输出 service health JSON |
| `ltm migrate` | `--to-schema v4 --dry-run` | 估算 v4 schema 迁移 |

---

## ltm stats

### 功能
显示内存统计信息

### 用法
```bash
ltm stats
```

### 输出示例
```
Memory Statistics:
- Total entries: 1256
- User memories: 256
- Scanned documents: 1000
- Database type: hybrid

Storage Categories:
- 核心记忆 (memories): 256 entries
- 知识库 (knowledge): 1000 entries

- Supabase URL: https://your-project.supabase.co
- LanceDB path: ~/.openclaw/memory/autodb
```

---

## ltm tables

### 功能
列出所有可用的存储分类

### 用法
```bash
ltm tables
```

### 输出示例
```
Available tables:
- memories: 256 entries
- knowledge: 1000 entries
```

---

## ltm search

### 功能
向量搜索记忆

### 用法
```bash
ltm search "查询内容" [选项]
```

### 选项
| 选项 | 简写 | 说明 |
|------|------|------|
| `--limit` | `-l` | 返回数量 (默认：10) |
| `--category` | `-c` | 存储分类 |
| `--search-all` | `-a` | 搜索所有分类 |
| `--include-documents` | `-d` | 包含文档 |

### 示例
```bash
# 基础搜索
ltm search "配置数据库" --limit 10

# 指定分类搜索
ltm search "React 组件" --category 知识库 --limit 5

# 跨分类搜索
ltm search "用户偏好" --search-all --limit 20
```

---

## ltm query

### 功能
高级 JSON 过滤查询

### 用法
```bash
ltm query [选项]
```

### 选项
| 选项 | 简写 | 说明 |
|------|------|------|
| `--category` | `-c` | 存储分类 |
| `--filter` | `-f` | JSON 过滤器 |
| `--vector` | `-v` | 向量搜索查询 |
| `--limit` | `-l` | 返回数量 |

### 示例
```bash
# 使用 JSON 过滤器查询
ltm query --category 核心记忆 \
  --filter '{"category": "preference", "source": "user"}'

# 结合向量搜索
ltm query --category 知识库 \
  --vector "数据库配置" --limit 10 \
  --filter '{"dataType": "document"}'
```

---

## ltm export

### 功能
导出数据

### 用法
```bash
ltm export [选项]
```

### 选项
| 选项 | 简写 | 说明 |
|------|------|------|
| `--category` | `-c` | 存储分类 |
| `--format` | `-f` | 导出格式 (json/csv) |
| `--output` | `-o` | 输出文件 |
| `--filter` | `-F` | JSON 过滤器 |

### 示例
```bash
# 导出核心记忆为 JSON
ltm export --category 核心记忆 --format json --output memories.json

# 导出知识库为 CSV
ltm export --category 知识库 --format csv --output knowledge.csv

# 导出过滤后的数据
ltm export --category 核心记忆 \
  --filter '{"category": "decision"}' \
  --format json
```

---

## ltm scan

### 功能
扫描目录构建知识库

### 用法
```bash
ltm scan <directory> [选项]
```

### 选项
| 选项 | 简写 | 说明 |
|------|------|------|
| `--category` | `-c` | 存储分类 |
| `--ignore` | `-i` | 忽略路径 (可重复) |
| `--auto-enrich` | `-e` | 自动丰富元数据 |

### 示例
```bash
# 扫描到知识库（默认）
ltm scan /path/to/docs --ignore node_modules --ignore dist

# 扫描到核心记忆
ltm scan /path/to/notes --category 核心记忆
```

扫描现在走 v4 ingestion pipeline，输出会额外包含：

```text
- Jobs queued: 24
- Chunks admitted: 24
- Chunks dropped: 3
```

---

## ltm serve / status / health

### 功能

启动本机 memory middleware，并通过 REST、SDK、MCP proxy 和 Web Console 给其他产品接入。

### 用法

```bash
ltm serve --host 127.0.0.1 --port 3847
ltm status
ltm health
```

启动后访问：

```text
http://127.0.0.1:3847/console
```

---

## ltm migrate

### 功能

估算或执行 v4 记忆中间件 schema 迁移。当前建议先 dry-run：

```bash
ltm migrate --to-schema v4 --dry-run
```

输出包含源记录、预计 chunks、entities、jobs 数量。迁移应按 namespace/table 灰度执行，并保留旧表回滚窗口。

---

## ltm cleanup

### 功能
清理旧数据

### 用法
```bash
ltm cleanup [选项]
```

### 选项
| 选项 | 简写 | 说明 |
|------|------|------|
| `--category` | `-c` | 存储分类 |
| `--data-type` | `-t` | 数据类型 |
| `--older-than` | `-o` | 清理 N 天前的数据 |
| `--filter` | `-f` | JSON 过滤器 |

### 示例
```bash
# 清理 30 天以上的文档数据
ltm cleanup --data-type document --older-than 30

# 清理所有测试相关的记忆
ltm cleanup --filter '{"tag": "test"}'

# 清理指定分类的数据
ltm cleanup --category 知识库 --older-than 90
```

---

## 环境变量

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API 密钥 |
| `SUPABASE_URL` | Supabase 项目 URL |
| `SUPABASE_SERVICE_KEY` | Supabase 服务密钥 |

## 创建信息

- 创建日期：2026-03-11
- 最后更新：2026-03-11
