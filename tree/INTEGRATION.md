# build_tree handler 主线程集成指南

## 1. 在 index.ts 顶部导入

在第 52 行 `createExtractCandidateHandler` 导入附近添加：

```typescript
import { createBuildTreeHandler } from "./tree/build-tree-handler.js";
import { InMemoryTreeRepository } from "./tree/buffer.js";
import { createLlmClient } from "./processing/llm-client.js";
```

## 2. 在插件初始化时创建依赖

在第 207 行 `extractCandidateHandler` 创建附近添加：

```typescript
// tree repository（v0.1 使用内存实现）
const treeRepository = new InMemoryTreeRepository();

// LLM 客户端（用于 abstractive 摘要）
const llmClient = createLlmClient(cfg.llm);

// build_tree job handler：leaf → buffer → seal SummaryNode。
const buildTreeHandler = createBuildTreeHandler({
  repository: treeRepository,
  llmClient,
  policy: {
    maxLeafCount: 20,
    maxTokenCount: 6000,
    staleAfterMs: 7 * 24 * 60 * 60 * 1000, // 7 天
  },
});
```

## 3. 在 worker handlers 中注册

在第 405 行的 `handlers` 对象中添加：

```typescript
handlers: {
  extract_candidate: extractCandidateHandler,
  build_tree: buildTreeHandler,
},
```

完整代码片段（第 405 行附近）：

```typescript
worker: {
  jobs: ingestionStore.jobs,
  leaseMs: 30_000,
  intervalMs: 1_000,
  handlers: {
    extract_candidate: extractCandidateHandler,
    build_tree: buildTreeHandler,
  },
},
```

## 4. 验证步骤

1. 类型检查：`npx tsc --noEmit`
2. 运行测试：`npx vitest run tree/`
3. 确认现有测试不破坏：`npx vitest run`

## 5. 后续集成（F3-2+）

- 在 candidate promotion 流程中调用 `enqueueUniqueJob(jobs, { type: "build_tree", payload: { scope, treeType, treeKey, leaf } })`
- 在 chunk 存储后触发 build_tree 任务
- 在 CLI 中添加 `ltm tree` 命令查看树结构
