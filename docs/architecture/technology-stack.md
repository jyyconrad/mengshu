# 技术栈

> 当前版本：v1.0.7
> 代码快照：2026-08-31
> 事实来源：`package.json`、`tsconfig.json`、`config.ts`

## 运行时与构建

| 项目 | 当前值 | 说明 |
|------|--------|------|
| 语言 | TypeScript 6.0，ESM | strict mode，target ES2022，bundler module resolution |
| Node.js | `>=20` | 由 `package.json.engines` 约束 |
| 构建 | `tsc -p tsconfig.build.json` | 输出到 `dist/`，同时生成声明文件 |
| 测试 | Vitest `^4.0.18` | 默认离线；live suite 必须显式 opt-in |
| CLI | Commander `^10.0.1` + tsx `^4.22.4` | 发布后入口为 `dist/bin/ms.js` |
| 包格式 | 单 npm 包、多 subpath export | `@mengshu/core`、`./api`、`./mcp`、`./ui`、`./openclaw` |

仓库包含 `packages/core`、`packages/api`、`packages/mcp`、`packages/ui` 与产品插件。根层旧目录继续编译用于兼容历史导入，但不是新实现的放置位置。

## 主要依赖

### 协议与适配器

| 依赖 | 版本 | 用途 |
|------|------|------|
| `@modelcontextprotocol/sdk` | `^1.29.0` | MCP stdio server 与工具协议 |
| `@sinclair/typebox` | `0.34.48` | OpenClaw 配置/工具 schema |
| `commander` | `^10.0.1` | `ms` / `mengshu` CLI |
| `openclaw` | `*`（optional peer + dev） | OpenClaw 宿主类型和插件集成 |

MCP 的默认部署形态是 stdio proxy：协议进程通过 `RuntimeClient` 连接共享 RuntimeHost，而不是自行持有 provider 与 worker。

### LLM 与 Embedding

| 依赖 | 版本 | 用途 |
|------|------|------|
| `openai` | `^6.45.0` | OpenAI-compatible chat/structured output 与 embedding |
| `p-limit` | `^6.1.0` | 批处理并发控制 |
| `p-retry` | `^6.2.0` | provider 调用重试 |

LLM 请求统一由运行时固定 `temperature=0.0`。`extractionModel`、`summarizationModel`、`reasoningModel` 可分层配置；未提供 LLM 时使用确定性降级路径。每次 provider attempt 可写入 append-only cost ledger，缺价格时记录为 `unpriced`。

### 数据与存储

| 依赖 | 版本 | 用途 |
|------|------|------|
| `pg` | `^8.16.0` | PostgreSQL 完整治理参考实现 |
| `@supabase/supabase-js` | `^2.108.2` | Supabase 兼容 provider |
| `@lancedb/lancedb` | `^0.26.2` | 本地 LanceDB 兼容 provider |
| `md5` | `^2.3.0` | legacy 内容哈希兼容；canonical 路径使用 SHA-256 |
| `nanoid` | `^5.1.16` | 部分本地标识生成 |
| `seedrandom` | `^3.0.5` | 可复现评测与抽样 |

PostgreSQL 组合提供 provider-owned atomic write、embedding registry、durable outbox/job、图谱/树、Asset/Loadout、ContextAssemblyReceipt、Temporal Memory、Working Set、Skill、Policy 与 Documents/Vault repository。Supabase 与 LanceDB 保留基础 provider 能力，不应据此推断拥有相同的持久化扩展。

## Embedding Space

`config.ts` 的 `vectorDimsForModel()` 是内置维度映射真源。当前支持：

| 模型 | 维度 |
|------|------|
| `text-embedding-3-small` | 1536 |
| `text-embedding-3-large` | 3072 |
| `BAAI/bge-m3` | 1024 |
| `nomic-embed-text` / `nomic-embed-text:v1.5` | 768 |
| `mxbai-embed-large` / `mxbai-embed-large:v1` | 1024 |
| `all-minilm` / `all-minilm:v6` / `all-minilm:v6.5` | 384 |
| `snowflake-arctic-embed` / `:l` | 1024 |
| `snowflake-arctic-embed:m` | 768 |
| `snowflake-arctic-embed:s` | 512 |
| `Qwen/Qwen3-Embedding-0.6B` | 1024 |
| `modelscope.cn/Qwen/Qwen3-Embedding-0.6B-GGUF:latest` | 1024 |

Embedding space 指纹包含 provider、base URL、model、维度与归一化策略。PostgreSQL 读写需要 active registry 匹配；切换模型前必须迁移或重建向量，不能在同一 ANN 空间混写。

## 服务与传输

| 层 | 实现 | 说明 |
|----|------|------|
| HTTP daemon | Node.js `http` | REST、runtime control、MCP facade；支持 loopback TCP |
| Unix socket | Node.js local socket | socket 与父目录均校验 owner/mode，socket 权限为 `0600` |
| Runtime client | fetch transport / Unix transport | 校验 runtime home fingerprint、owner 与 generation |
| MCP | MCP SDK stdio | 默认只转发 RuntimeHost 动态工具注册表 |
| Web Console | 静态前端 + console API | 由 `packages/ui/src/` 提供 |

## 配置与 Feature Gate

配置按 `~/.mengshu/config.json`、项目 `.mengshu/config.json`、环境变量覆盖三层加载。核心 feature gate 包括：

项目 `.mengshu.json` 不属于这三层运行配置：它只保存产品无关的 project pointer。
`MENGSHU_AUTHORITY_FILE/JSON` 由 Agent 产品在启动 MCP/REST Runtime 时提供，并与当前
project pointer 组合为完整 scope。`ms init` 不读取或生成 OpenClaw 配置。

```json
{
  "features": {
    "bm25": true,
    "graph": true,
    "summaryTree": true,
    "webConsole": true,
    "assetInjection": false,
    "temporalMemory": false,
    "sessionWorkingSet": false,
    "skillArtifacts": false,
    "memoryPolicyOverlay": false,
    "teamAssets": false,
    "proxy": false
  }
}
```

布尔开关只有显式 `true` 才启用相应增量能力；运行时还会检查 provider capability，因此“配置已开”不等于“能力一定 ready”。完整字段见 [配置说明](../guides/configuration.md)。

## 验证命令

```bash
# 类型检查
npx tsc --noEmit

# 默认离线测试
npm test

# 覆盖率
npm run test:coverage

# Q 轨工程质量门禁
npm run eval:quick

# G0 两轮 diagnostic（不产生正式 GMS）
npm run eval:g0:round1
npm run eval:g0:round2
npm run eval:g0:finalize

# 显式 live production gate
MENGSHU_RUN_LIVE_TESTS=1 npm run test:production-gate
```

`eval:quick` 通过只代表 Q 轨工程合同通过；正式版本门禁还需要 G/P paired gate、报告完整性和 P-FRESH 配额。

## 相关文档

- [系统架构](system-architecture.md)
- [配置说明](../guides/configuration.md)
- [统一记忆设计](../design/memory-system-unified-design.md)
- [Memory API](../api/memory-api.md)

**最后更新**：2026-08-31
