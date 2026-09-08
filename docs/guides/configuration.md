# 配置说明

## 配置文件位置

mengshu 使用三层配置加载策略：

1. **全局配置**：`~/.mengshu/config.json`
2. **项目配置**：`$PROJECT/.mengshu/config.json`
3. **环境变量**：覆盖前两者

优先级：环境变量 > 项目配置 > 全局配置

`~/.mengshu` 是 OpenClaw 插件、Codex 插件、Claude Code MCP、CLI 和 MCP Server 的共享 home。当前推荐配置直接指向共享 PostgreSQL + pgvector 后端；OpenClaw 是可选适配器，不是配置来源或前置条件。旧版 `~/.openclaw` 和本地 `~/.mengshu/memory/lancedb` 仅作为兼容回退或显式 LanceDB 模式使用。

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

### Runtime 与 Server

```json
{
  "mode": "server",
  "server": {
    "enabled": true,
    "host": "127.0.0.1",
    "port": 3847,
    "secret": "${MENGSHU_SERVER_SECRET}",
    "requireHttps": false
  }
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `mode` | `embedded / server / remote / backend-proxy` | `embedded` |
| `server.enabled` | 启用 server 配置 | `false` |
| `server.host` | TCP 监听地址 | `127.0.0.1` |
| `server.port` | TCP 端口 | `3847` |
| `server.secret` | REST/RuntimeClient bearer secret | 未设置 |
| `server.requireHttps` | 非 loopback 访问是否要求 HTTPS | `false` |

本机共享部署由 `ms serve` 持有 RuntimeHost。默认 `ms mcp` 使用 RuntimeClient 连接该 host；设置 `MENGSHU_RUNTIME_SOCKET` 时使用 owner-only Unix socket，否则使用 loopback HTTP。MCP direct diagnostic 只用于隔离诊断，不应与共享 daemon 同时持有 worker。

### 项目身份与运行时 Authority

`ms init` 只在项目目录和 Mengshu home 中写入 `workspaceId/projectId`。它不读取
OpenClaw 配置，也不需要 authority。运行 `ms mcp`、`ms serve` 或 Codex MCP 时，Agent
产品必须另外提供包含 `authority/defaultScope` 的可信配置。

```json
{
  "authority": {
    "tenantId": "local",
    "userId": "owner",
    "allow": {
      "appIds": ["codex"],
      "projectIds": ["project-api"],
      "agentIds": ["codex"],
      "namespaces": ["working-context"],
      "visibilities": ["private"]
    }
  },
  "defaultScope": {
    "tenantId": "local",
    "userId": "owner",
    "appId": "codex",
    "projectId": "project-api",
    "agentId": "codex",
    "namespace": "working-context",
    "visibility": "private"
  }
}
```

推荐保存到权限为 `0600` 的 `~/.mengshu/authority.json`，通过绝对路径传入：

```bash
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
```

也可以使用 `MENGSHU_AUTHORITY_JSON`，但两个变量必须且只能设置一个。字段归属、
allowlist 规则和错误排查见[项目身份与运行时 Authority](authority-and-project-scope.md)。

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
  "recallIncludeDocuments": false,
  "captureMaxChars": 500
}
```

| 字段 | 说明 | 默认值 |
|------|------|--------|
| `autoCapture` | 自动捕获记忆 | `false` |
| `autoRecall` | 自动召回记忆 | `true` |
| `recallIncludeDocuments` | 自动召回是否包含扫描文档 | `false` |
| `captureMaxChars` | 可自动捕获的消息长度上限（100-10000） | `500` |

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
AgentLoadout。启用时 Runtime 仍会校验 v20/v21 schema、资产状态和 Loadout capability；任一条件不满足都保留原生 5 槽位。

### 增量能力开关

```json
{
  "features": {
    "bm25": true,
    "graph": true,
    "summaryTree": true,
    "webConsole": true,
    "assetInjection": false,
    "temporalMemory": false,
    "continuousMemoryEvolution": false,
    "sessionWorkingSet": false,
    "skillArtifacts": false,
    "memoryPolicyOverlay": false,
    "teamAssets": false,
    "proxy": false
  }
}
```

所有 `features.*` 默认都是 `false`，只有显式 `true` 才请求启用；Runtime 还会校验 provider capability。PostgreSQL 是 temporal、working set、skill、policy、asset 和 durable job 的参考组合，LanceDB/Supabase 不自动获得这些能力。

| 开关 | 能力 | v1.0.7 边界 |
|------|------|--------------|
| `bm25` | 文本检索候选 | 与 governed recall 组合 |
| `graph` | 图谱派生与查询 | 依赖 native handler/repository |
| `summaryTree` | source/topic/global tree | 受 faithfulness 和 job capability 约束 |
| `webConsole` | Console 接口/页面 | 由 server 暴露 |
| `assetInjection` | Asset/Loadout 上下文增强 | 默认关闭，exact private scope |
| `temporalMemory` | 版本链与 as-of/evolve/correct/restore | PostgreSQL |
| `continuousMemoryEvolution` | 存量/已注册目录的有限进化批次 | 默认关闭；需 RuntimeHost/native PostgreSQL capability。v36 为批次基础，治理扩展使用 v37；开关不等于启用低频维护 |
| `sessionWorkingSet` | 会话工作集 | PostgreSQL，有限保留 |
| `skillArtifacts` | reviewed Skill Artifact | 仅 `suggest_only` |
| `memoryPolicyOverlay` | scoped policy version/resolve | 不得扩大 authority |
| `teamAssets` | 保留配置位 | v1.0.7 不注册 Team ACL 能力，保持 `false` |
| `proxy` | 保留配置位 | v1.0.7 不注册 Optional Proxy 能力，保持 `false` |

### 持续记忆进化来源

`evolution` 接受 `sources`、`control`、`attestation`、`maintenance` 和 `reuse`，拒绝其他字段；`sources` 最多 64 个来源绑定。以下片段需合并到操作者的全局配置；没有目录来源时可省略 sources，库存入口不依赖目录注册。

```json
{
  "features": { "continuousMemoryEvolution": true },
  "evolution": {
    "sources": [
      {
        "sourceId": "project-notes",
        "root": "/srv/mengshu-input/project-notes",
        "parser": "markdown",
        "semantics": "current_document",
        "include": ["**/*.md"],
        "exclude": ["**/node_modules/**"]
      }
    ]
  }
}
```

| 字段 | 必填 | 默认值/边界 |
|------|------|-------------|
| `sourceId` | 是 | 唯一、1-128 字符，首字符为字母/数字，其余只允许字母/数字与 `._-`，不允许冒号 |
| `root` | 是 | host 绝对目录，最多 4096 字符，无控制字符；示例路径不是实际部署目录 |
| `parser` | 否 | `auto`；可选 `markdown`、`codex-jsonl`、`claude-code-jsonl`、`openclaw-jsonl` |
| `semantics` | 否 | Markdown 为 `current_document`，已识别日志为 `append_history`；也接受 `reference_snapshot`；来源语义不赋予内容可信度 |
| `scope` | 否 | 继承 host scope；只允许 `appId/projectId/agentId/namespace/visibility`，必须在 authority 内且与运行批次精确匹配 |
| `include` / `exclude` | 否 | 相对输入树的匹配模式；每项最多 256 字符、每组最多 64 项，不接受 `!` 前缀覆盖排除规则，仍受格式、路径与容量限制 |

来源块不能包含 `tenantId/userId`、模型、凭据、任意命令或自定义 authority；未知字段拒绝。客户端只传 `sourceId`，不能传 `root` 或改变绑定。host 还会排除自身输出目录、拒绝 symlink 和路径逃逸。

注册目录和设置 scope 只授权读取，不证明内容作者或允许修改某条记忆。没有可信证明的目录与库存 legacy raw evidence 均为 untrusted；feature 开关、MCP/user 通道标签、remember intent 不能使其成为可信更新证据。独立 owner 审阅必须绑定具体提案、hash/revision 和有效期；它是明确批准，不会把来源改成可信作者陈述，也没有“自动批准所有内容”的配置字段。

进化模型从全局 `llm` 解析，使用结构化提取用途的模型选择规则。可信操作者的 `MENGSHU_CONFIG` 可显式选择 host 配置；被扫描项目的配置不参与此解析。模型与来源绑定在批次开始时冻结指纹，不接受客户端覆盖。没有单独的每目录模型或 watcher；低频维护策略与来源登记分开配置。

预算通过每次请求的 `limits` / inventory、scan 的 CLI flags 设置，不写入来源块。治理控制仅接受请求 JSON 中的四项 I/O 限额，模型/token 预算由内部固定为零，不增加模型或来源配置。动作、默认预算、恢复与保留期说明见[持续记忆进化指南](continuous-memory-evolution.md)。

### Owner 控制与后台运行门

`evolution.control.ownerSecret` 是独立操作者凭据，不等同于 `server.secret`。值为 32-4096 字符，禁止空白和控制字符，支持可信环境变量占位。以下示例的变量须由操作者提供，不是自动生成的授权：

```json
{
  "server": { "backgroundWork": { "mode": "paused", "allowedBatchIds": [] } },
  "evolution": { "control": { "ownerSecret": "${MENGSHU_EVOLUTION_OWNER_TOKEN}" } }
}
```

REST/SDK 通过独立 `x-mengshu-owner-token` 传递操作者凭据，MCP proxy 也须独立 owner 认证才可使用审阅、来源、复用和治理控制工具。CLI 为这些专用命令及 resume 转发配置中的可选 ownerSecret，普通 inventory 请求不携带该凭据。控制批次 resume 必须有 owner，普通无凭据批次恢复保持兼容；命令见 [CLI 参考](../api/cli-commands.md#治理控制)。不要把该值放入扫描材料、批次 body 或 CLI flag。普通 bearer、loopback 连接、同一 userId 都不能代替 owner 认证。native RuntimeHost 已组装专用审阅与治理控制，其他 host 仍须提供对应 capability；配置凭据不会自动补出缺失服务。

来源对账、canonical 支持关系撤销和精确治理撤销复用现有 owner、source binding、durable 队列及后台 allowlist。没有额外 control handler、客户端 path/authority 或任意 state 配置；自动维护仍只准备 due/propose，不触发这些显式治理动作。

| `server.backgroundWork` | 默认值/合同 |
|-------------------------|-------------|
| `mode` | 省略整个块时为 `all`；可显式设 `paused` 或 `evolution_only` |
| `allowedBatchIds` | `all/paused` 只允许空数组；`evolution_only` 要求 1-100 个不重复安全 batch ID，只允许当前 scope 对应批次的当前执行段 |

受控升级可在启动配置设 `paused`。运行时更新还需当前 `expectedRevision`；模式切换先取消活跃 worker 信号，`draining` 不等于已静默，须等 `active=0`。暂停保留读服务，不回滚已提交事务，也不禁止显式前台写入。运行时更新不修改启动配置，重启生成新 revision 并重新应用启动配置。操作见 [CLI](../api/cli-commands.md)和 [API](../api/memory-api.md)。

`server.workerOwnership` 选择后台归属，省略时按 `runtime-host` 处理。一个运行环境只应有一个 durable scheduler owner：

| 值 | 合同 |
|----|------|
| `runtime-host` | 当前 host 拥有后台 worker；启用进化的 OpenClaw 插件要求 server 模式并拥有该 host |
| `external-runtime-host` | 不创建本地 owner host，后台保持 paused；不能同时启用本地进化或放开后台门，也不能用它启动 `ms serve` 的 owner worker |

外部归属不是通用 REST proxy 配置，不能由此推断插件所有前台读写已经委托给另一个 host。MCP proxy 连接共享 host，与 standalone 的独立 runtime 有别；不要为普通 MCP 代理配置 ownerSecret 来自动批准自身提案。

### 可信来源签名

`evolution.attestation` 只接受 `trustedIssuers` 数组，可为空，最多 32 个。每项必须包含：

| 字段 | 合同 |
|------|------|
| `id` | 唯一，1-256 字符，首字符字母/数字，其余为字母/数字及 `._:-` |
| `publicKeyPem` | 最多 4096 字符的 `BEGIN PUBLIC KEY` PEM，实际解析为 Ed25519 公钥；不是私钥或任意文本 |

省略此配置或空数组不授予来源信任。配置公钥只允许验证指定 issuer 的签名，不能将已扫描的内容自动变成作者陈述。专用 `source/attest` 接收已经签名的精确声明，还需独立 owner 认证并绑定 evidence/source revision/hash、独立根、scope、目标和期限；不是把公钥配置成自动签发器。默认 Runtime 已接入输入预算及 writer 同事务来源证明/撤销复核，仍可能因缺证、漂移、撤销或预算不足阻断应用。

`source/revoke-attestation` 只撤销来源信任资格，不等于现有 canonical evidence/links 已退役。它还为后续 source_revoke 提供绑定 sourceRevision 与 operationIdempotencyKey 的行政批准回执，canonical 支持关系须经独立控制批次及事务门禁处理。来源、复用与治理控制使用专用 REST/SDK/CLI/MCP proxy 入口，没有通用 state put，也没有用配置批量批准内容的能力，详见 [API](../api/memory-api.md#治理控制批次)。

### 复用目标配置

`evolution.reuse` 只接受必填 `targetProfile` 和可选 `evaluations`。目标 profile 是可信 host 对执行环境的声明，不是模型切换、行为证明或跨 app grant；默认 Runtime 已装配受控读取与配对评测入口。`targetProfile` 以下字段全部必填，嵌套对象拒绝未知字段：

| `targetProfile` 字段 | 合同 |
|---------------------|------|
| `model` | provider/modelId/revision；每项 1-256 字符且无空白/控制字符；revision 不能是 latest/default/auto/unknown |
| `tools` | 最多 128 项，名称唯一；每项 name/version/schemaHash；name/version 同样有界，version 不接受上述浮动值，schemaHash 为 64 位小写十六进制 |
| `environmentFingerprint` | 64 位小写十六进制的环境指纹 |
| `applicability` | 1-128 个不重复适用域标识，每项 1-256 字符，无空白/控制字符 |

改变模型、工具 schema/version 或适用域会改变兼容性指纹。默认读取仍需精确同 owner grant、真实 artifact/证据重载、有效兼容性回执以及引用/缓存重验；配置不授予这些资格，也不允许自动执行 Skill。来源内容不能自行声明兼容目标配置。

`evaluations` 最多 32 项，省略或空数组不会注册可运行计划。每项只接受以下必填字段：

| 字段 | 合同 |
|------|------|
| `id` | 唯一 planId，1-128 字符，首字符字母/数字，其余为字母/数字及 `._:-` |
| `planFile` / `holdoutFile` | host 绝对文件路径，最多 4096 字符，无控制字符；不能由 evaluate 请求上传或改写 |
| `planFileHash` / `holdoutFileHash` | 对应文件原始字节的 SHA-256，64 位小写十六进制；不接受内容自述 hash |

以下仅展示配置结构，路径、模型 revision 和 hash 均为示意值，不是可用评测材料或有效证明；配置 parser 不会读取这些文件：

```json
{
  "evolution": {
    "reuse": {
      "targetProfile": {
        "model": { "provider": "openai", "modelId": "example-model", "revision": "example-revision-1" },
        "tools": [],
        "environmentFingerprint": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "applicability": ["synthetic:fact-selection-v1"]
      },
      "evaluations": [
        {
          "id": "fact-selection-demo-v1",
          "planFile": "/srv/mengshu-evaluation/demo-plan.json",
          "planFileHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          "holdoutFile": "/srv/mengshu-evaluation/demo-holdout.json",
          "holdoutFileHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
        }
      ]
    }
  }
}
```

调用 evaluate 才有界读取注册文件：plan 上限 128000 字节、holdout 上限 2000000 字节，拒绝最终文件 symlink、读前后漂移或 hash 不匹配。请求只传 planId；启动装配不运行评测。当前 evaluator 仅支持 `synthetic:fact-selection-v1`，使用全局 reasoning 模型并检查目标 provider/modelId 与 profile 指纹；缺模型、依赖 reader 或有效证明时阻断。完整目标执行绑定与配对正例仍属工程验证范围，不从静态 profile 或文件注册推导任意 Skill 兼容性或正式 G/P 通过。

### 低频维护配置合同

`evolution.maintenance` 省略时不启用。提供该块时下列字段全部必填；启用进化的默认 Runtime 已组装维护 driver、持久预算和 retention，复用原 scheduler 的 idle、批次准入和 maintenance 批次释放租约前回调，不创建第二个 timer。自动调度仅 `due + propose`，不自动 apply。

| 字段 | 合同 |
|------|------|
| `enabled` | 显式 boolean，不能由来源材料设置 |
| `intervalMs` | 60000-2592000000 毫秒 |
| `quietPeriodMs` | 1000-86400000 毫秒 |
| `dailyTokens` | 正安全整数，host 每日 token 预算输入，不替代单批 limits |
| `dailyMinorUnits` | 正安全整数，按 `llm.pricing` 的币种及 minorUnitsPerMajor 换算为 owner/day cost_micros；缺可信价格时阻断，不按零处理 |
| `maxStorageBytes` / `minFreeBytes` | 正安全整数，数据库已用量上限/可信 backing-store 剩余空间门禁；当前剩余量未知，不能用本地盘样本代替 |

后台运行门优先于维护策略：`paused/evolution_only`、前台忙或静默期不足、未知价格、预算不足、空间未知/不足均阻止自动 maintenance。每日预算跨同 owner 的 batch/scope 共享，实际用量不明则保留 reservation，不用预算上界充当真实结算。

当前默认 PG 组合传入的数据库剩余空间为未知，`databaseFreeBytes=null`；本地 `statfs` 只提供 `localFreeBytes`，即使与 PG 同机也未证明它属于数据库 backing volume。因此 `enabled=true` 仍不能使自动维护可运行。`ms evolve maintenance` / `GET /v1/runtime/maintenance` 可读状态；不能用配置开关宣称清理已完成或完整 E3 已接通，受治理经验到 Skill 聚合仍缺有独立结果证明的默认 ExperienceSource。

### Temporal、Working Set 与 Skill 参数

```json
{
  "temporalMemory": {
    "defaultExpirationAction": "archive",
    "allowHistoricalRecall": true,
    "allowRestore": true,
    "historicalIndex": "bm25"
  },
  "sessionWorkingSet": {
    "mildRatio": 0.5,
    "aggressiveRatio": 0.85,
    "emergencyRatio": 0.95,
    "emergencyTargetRatio": 0.6,
    "outlineMaxRatio": 0.2,
    "retentionDays": 30
  },
  "skillArtifacts": {
    "maxResourceBytes": 5242880,
    "allowExecutable": false,
    "executionMode": "suggest_only"
  }
}
```

约束：

- Temporal 的过期动作固定为 `archive`，历史索引固定为 `bm25`。
- Working Set 必须满足 `mild < aggressive < emergency`、`emergencyTarget < aggressive`、`outlineMax <= 0.2`；`retentionDays` 为非负整数。
- Skill v1 强制 `allowExecutable=false`、`executionMode=suggest_only`；资源大小默认上限为 5 MiB。
- 参数块只定义策略，仍需对应 `features.*=true` 与 PostgreSQL capability 才会启用运行能力。

## 环境变量覆盖

```bash
export OPENAI_API_KEY="sk-..."
export MENGSHU_DB_TYPE="postgres"
export MENGSHU_AUTO_CAPTURE="true"
export MENGSHU_AUTHORITY_FILE="$HOME/.mengshu/authority.json"
```

### 模型请求的网络代理

Embedding 和 LLM 请求默认读取运行进程继承的代理环境变量，无需额外设置
`NODE_USE_ENV_PROXY=1`。CLI、MCP 和插件使用相同规则：

| 环境变量 | 用途 |
|----------|------|
| `HTTP_PROXY` | HTTP 请求的代理 |
| `HTTPS_PROXY` | HTTPS 请求的代理 |
| `ALL_PROXY` | 未设置对应协议代理时的后备代理，仅支持 HTTP/HTTPS 代理地址 |
| `NO_PROXY` | 需要直连的主机或域名列表，逗号分隔；支持端口和 `*` |

以上变量均支持小写名称；同名大小写变量同时存在时，非空的小写值优先。
HTTPS 请求未配置 `HTTPS_PROXY` 或 `ALL_PROXY` 时复用 `HTTP_PROXY`。
代理地址支持 `http://` 和 `https://`；不支持 SOCKS/PAC。未配置代理时保持原有连接方式。

例如，已有本机 HTTP 代理时，可在启动 Mengshu 的终端或宿主环境中设置：

```bash
export HTTPS_PROXY="http://127.0.0.1:7897"
export HTTP_PROXY="$HTTPS_PROXY"
export NO_PROXY="localhost,127.0.0.1,::1"
ms doctor
```

代理配置只作用于 Mengshu 的模型请求，不修改宿主的全局网络设置。
桌面应用启动的 MCP 进程也需要继承这些变量；操作系统图形界面的代理设置不会自动转换为环境变量。

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

模型与存储参考 [config.example.json](../../config.example.json)，产品可信边界参考
[authority.example.json](../../config/authority.example.json)。

`config.json` 只描述模型、存储和运行能力；项目 `.mengshu.json` 与运行时
`authority.json` 是独立文件，不能相互替代。
