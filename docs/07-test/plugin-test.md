# 测试与验证

本页记录当前仓库可复现的验证命令。测试文件与源码相邻，新增模块应新增相邻测试。

## 推荐验证顺序

1. 先跑类型检查。
2. 再跑稳定的单元和契约测试。
3. 最后按需跑 `npm test`，并确认本机 embedding 服务是否可用。

```bash
npx tsc --noEmit
```

```bash
npx vitest run \
  config.middleware.test.ts \
  api/rest/auth.test.ts \
  api/rest/router.test.ts \
  server/daemon.test.ts \
  server/health.test.ts \
  sdk/js/client.test.ts \
  adapters/mcp/tools.test.ts \
  adapters/mcp/server.test.ts \
  adapters/openclaw/cli.test.ts \
  index.test.ts \
  adapters/openclaw/tools.test.ts \
  adapters/openclaw/hooks.test.ts \
  adapters/openclaw/scope.test.ts \
  core/memory-service.test.ts \
  storage/legacy-database-adapter.test.ts \
  storage/repositories/in-memory.test.ts \
  storage/indexes/in-memory-bm25.test.ts \
  core/scope.test.ts \
  core/legacy-mapping.test.ts \
  retrieval/prompt-safety.test.ts \
  retrieval/fusion.test.ts \
  retrieval/orchestrator.test.ts \
  retrieval/context-packer.test.ts \
  ingest/canonicalize.test.ts \
  ingest/chunker.test.ts \
  ingest/pipeline.test.ts \
  ingest/jobs.test.ts \
  ingest/adapters/file-system.test.ts \
  server/workers.test.ts \
  graph/extractor.test.ts \
  graph/repository.test.ts \
  graph/query.test.ts \
  tree/buffer.test.ts \
  tree/seal.test.ts \
  tree/topic.test.ts \
  tree/global.test.ts \
  console/api.test.ts \
  console/web-smoke.test.ts \
  migration/v4.test.ts \
  lifecycle/audit.test.ts \
  lifecycle/retention.test.ts
```

## 完整测试

```bash
npm test
```

`npm test` 会运行更广的测试集，包括部分依赖本机 embedding 服务的集成测试。如果 `127.0.0.1:11434` 未启动，可能出现环境性的 `ECONNREFUSED`。这类失败需要和代码回归分开判断。

## 覆盖范围

| 区域 | 代表测试 |
|------|----------|
| 配置 | `config.middleware.test.ts`、`index.test.ts` |
| OpenClaw 工具和钩子 | `adapters/openclaw/*.test.ts` |
| REST server | `api/rest/*.test.ts`、`server/*.test.ts` |
| MCP facade | `adapters/mcp/*.test.ts` |
| JS SDK | `sdk/js/client.test.ts` |
| Core service 和 scope | `core/*.test.ts` |
| Legacy storage adapter | `storage/legacy-database-adapter.test.ts` |
| In-memory storage/index | `storage/repositories/*.test.ts`、`storage/indexes/*.test.ts` |
| Retrieval | `retrieval/*.test.ts` |
| Ingestion | `ingest/*.test.ts`、`ingest/adapters/*.test.ts` |
| Graph | `graph/*.test.ts` |
| Tree | `tree/*.test.ts` |
| Console | `console/api.test.ts`、`console/web-smoke.test.ts` |
| Migration | `migration/v4.test.ts` |
| Lifecycle | `lifecycle/*.test.ts` |

## 集成测试环境

| 测试 | 依赖 |
|------|------|
| OpenAI-compatible embedding | `OPENAI_API_KEY`、可访问的 `embedding.baseURL` |
| Ollama embedding | 本机 `127.0.0.1:11434` 服务和对应模型 |
| Supabase provider | `SUPABASE_URL`、`SUPABASE_SERVICE_KEY`、pgvector/RPC 配置 |
| Postgres provider | `postgres` 配置和可访问数据库 |

## 交付前检查

- 文档只改动时至少运行 Markdown 链接/格式检查脚本和 `git diff --check`。
- API、CLI、schema 改动时运行相关单元测试，并同步更新 `../05-api/`、`../06-database/`。
- 存储或检索改动时运行 `core/`、`storage/`、`retrieval/` 和 provider 相关测试。
- Web Console 改动时运行 `console/api.test.ts` 和 `console/web-smoke.test.ts`。
