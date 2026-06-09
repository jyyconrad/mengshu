# 测试文档

本目录记录测试范围、稳定验证命令和已知环境依赖。

## 当前文档

| 文档 | 状态 | 说明 |
|------|------|------|
| [plugin-test.md](./plugin-test.md) | 当前 | OpenClaw 插件、中间件、REST、MCP、SDK、ingestion、retrieval、graph、tree、console、migration、lifecycle 的验证命令 |

## 推荐验证

```bash
npx tsc --noEmit
npx vitest run config.middleware.test.ts api/rest/auth.test.ts api/rest/router.test.ts server/daemon.test.ts server/health.test.ts sdk/js/client.test.ts adapters/mcp/tools.test.ts adapters/mcp/server.test.ts adapters/openclaw/cli.test.ts index.test.ts adapters/openclaw/tools.test.ts adapters/openclaw/hooks.test.ts adapters/openclaw/scope.test.ts core/memory-service.test.ts storage/legacy-database-adapter.test.ts storage/repositories/in-memory.test.ts storage/indexes/in-memory-bm25.test.ts core/scope.test.ts core/legacy-mapping.test.ts retrieval/prompt-safety.test.ts retrieval/fusion.test.ts retrieval/orchestrator.test.ts retrieval/context-packer.test.ts ingest/canonicalize.test.ts ingest/chunker.test.ts ingest/pipeline.test.ts ingest/jobs.test.ts ingest/adapters/file-system.test.ts server/workers.test.ts graph/extractor.test.ts graph/repository.test.ts graph/query.test.ts tree/buffer.test.ts tree/seal.test.ts tree/topic.test.ts tree/global.test.ts console/api.test.ts console/web-smoke.test.ts migration/v4.test.ts lifecycle/audit.test.ts lifecycle/retention.test.ts
```

`npm test` 会运行更广的测试集，其中部分测试依赖本机 embedding 服务。

## 维护规则

- 新模块必须有相邻测试或明确的集成测试覆盖。
- 如果验证失败来自环境依赖，需要记录具体依赖和失败现象。
- 测试文档只记录可复现命令，不写无法核验的覆盖率数字。
