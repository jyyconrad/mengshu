# 配置说明

## 配置文件位置

mengshu 使用三层配置加载策略：

1. **全局配置**：`~/.mengshu/config.json`
2. **项目配置**：`$PROJECT/.mengshu/config.json`
3. **环境变量**：覆盖前两者

优先级：环境变量 > 项目配置 > 全局配置

`~/.mengshu` 是 OpenClaw 插件、Codex 插件、Claude Code MCP、CLI 和 MCP Server 的共享 home。当前推荐配置复用 OpenClaw 中的 PostgreSQL + pgvector 后端；旧版 `~/.openclaw` 和本地 `~/.mengshu/memory/lancedb` 仅作为兼容回退或显式 LanceDB 模式使用。

## 配置项说明

### LLM 配置

```json
{
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "extractionModel": "gpt-4o-mini",
    "summarizationModel": "gpt-4o-mini",
    "reasoningModel": "gpt-4o"
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `apiKey` | LLM API 密钥 | 必填 |
| `baseURL` | API 端点 | `https://api.openai.com/v1` |
| `extractionModel` | 结构化提取模型 | `gpt-4o-mini` |
| `summarizationModel` | 摘要生成模型 | `gpt-4o-mini` |
| `reasoningModel` | 推理模型 | `gpt-4o` |

结构化调用的 `temperature` 由 runtime 固定为 `0.0`，配置文件不接受该字段。可选 `llm.pricing` 用于本地 `ms cost` 金额估算：

```json
{
  "llm": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "${OPENAI_API_KEY}",
    "pricing": {
      "version": "provider-price-YYYYMMDD",
      "provider": "openai",
      "currency": "USD",
      "minorUnitsPerMajor": 100,
      "models": {
        "default": {
          "inputTokenPrice": 1,
          "outputTokenPrice": 1
        },
        "text-embedding-3-small": {
          "embeddingPrice": 1
        }
      }
    }
  }
}
```

`inputTokenPrice`、`outputTokenPrice` 和 `embeddingPrice` 的单位是每百万 token 的主货币单位；上例数值仅展示字段形状，部署时必须替换为 provider 当前价格并更新 `version`。不配置或模型未命中时，事件仍会记账，但金额保持 unpriced。

**中国大陆用户**：可配置为国内代理或使用支持的 AI 提供商（阿里云百炼、硅基流动、DeepSeek 等）。

### Embedding 配置

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  }
}
```

### 数据库配置

#### PostgreSQL（推荐共享后端）

```json
{
  "dbType": "postgres",
  "postgres": {
    "host": "${PG_HOST}",
    "port": 5432,
    "database": "${PG_DATABASE}",
    "user": "${PG_USER}",
    "password": "${PG_PASSWORD}",
    "ssl": false
  }
}
```

PostgreSQL 存储依赖 `pgvector`，初始化时会执行 `CREATE EXTENSION IF NOT EXISTS vector` 并创建 `memories` / `knowledge` / `tree_*` / `summary_nodes` 表，因此连接用户需要具备创建扩展、建表和索引的权限。Codex、Claude Code、OpenClaw 和 CLI 都通过该配置读写同一个库。

#### LanceDB（本地单机，可选）

```json
{
  "dbType": "lancedb",
  "dbPath": "~/.mengshu/memory/lancedb"
}
```

仅在不需要跨产品共享远端库时使用 LanceDB。`dbType=postgres` 时不要配置或依赖 `dbPath`。

#### Supabase

```json
{
  "dbType": "supabase",
  "supabase": {
    "url": "https://xxx.supabase.co",
    "serviceKey": "${SUPABASE_SERVICE_KEY}"
  }
}
```

Supabase 配置需要 service role key，而不是 anon key；建议通过环境变量引用，避免明文写入 `config.json`。

### OpenClaw 多 Agent 权限

OpenClaw 插件必须由本机 operator 显式提供 `authority`。`tenantId`、`userId`
和各维 allowlist 不能从消息或工具参数推断。多 Agent 宿主还必须配置
`defaultAgentId`，用于没有 host context 的 CLI；它必须是 `agentIds` 的精确成员。

```json
{
  "authority": {
    "tenantId": "local",
    "userId": "owner",
    "allow": {
      "appIds": ["openclaw"],
      "projectIds": ["default"],
      "agentIds": ["main", "codex"],
      "namespaces": ["default"],
      "visibilities": ["private"]
    }
  },
  "defaultAgentId": "main"
}
```

OpenClaw hook 和 Agent tool factory 会使用宿主提供的真实 `agentId` 与 session
收窄 scope。未知 Agent 会被拒绝，不会回退或映射到默认 Agent。只有单 Agent
allowlist 可以省略 `defaultAgentId`，此时唯一值会成为规范化默认值。

### 自动捕获配置

```json
{
  "autoCapture": true,
  "autoRecall": true,
  "recallLimit": 5,
  "minImportance": 0.7
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `autoCapture` | 自动捕获记忆 | `true` |
| `autoRecall` | 自动召回记忆 | `true` |
| `recallLimit` | 召回数量上限 | `5` |
| `minImportance` | 召回最低 importance | `0.7` |

### Asset/Loadout 注入

```json
{
  "features": {
    "assetInjection": false
  }
}
```

`features.assetInjection` 默认关闭。关闭时仍可管理、解释和迁移 private
`memory_view` Asset，但 `memory_context_fast` 只返回原生 5 槽位，不解析
AgentLoadout。完成 v20/v21 schema 校验、资产发布审查和 Loadout 配置后，再按项目显式开启。

## 环境变量覆盖

```bash
export OPENAI_API_KEY="sk-..."
export MENGSHU_DB_TYPE="postgres"
export MENGSHU_AUTO_CAPTURE="true"
```

## 配置诊断

使用 `ms doctor` 检查配置：

```bash
ms doctor
```

输出示例：

```
✓ LLM 配置正常（gpt-4o-mini）
✓ Embedding 配置正常（text-embedding-3-small）
✓ 数据库连接正常（postgres）
⚠ 警告：未设置 reasoningModel，将使用 extractionModel
```

## 完整示例

参考 [config.example.json](../../config.example.json)。
