# 项目目录层级与包结构重构方案

> 日期：2026-06-18  
> 范围：在多产品插件化基础上，按能力边界重组仓库目录与包结构，形成 `core`、`plugins`、`mcp`、`api`、`ui`、`tests` 等长期稳定层级。

## 目标

当前仓库按早期演进自然生长，目录既有领域能力（`core`、`lifecycle`、`retrieval`），也有协议适配（`adapters/mcp`、`adapters/rest`）、产品插件（`adapters/openclaw`）、控制台（`console`）和测试/eval 混排。随着 OpenClaw、Codex、后续 Claude Code / Cursor / Cline 等产品插件进入，单层目录会持续膨胀。

本方案目标是把仓库升级为能力分层清晰的 monorepo：

- `core`：产品无关算法与领域能力
- `mcp`：MCP 协议与 server 包
- `api`：REST / SDK / CLI 对外接口包
- `plugins`：各类 Agent 产品插件包
- `ui`：Web Console 和未来可视化界面
- `tests`：集成、契约、smoke、fixtures、eval 统一入口
- `docs`：长期维护文档

## 设计原则

1. 能力边界优先于历史文件位置。
2. 产品插件不得反向污染核心算法层。
3. 协议包可复用核心能力，但不得依赖具体产品插件。
4. UI 只依赖 API/SDK，不直接穿透到存储实现。
5. 测试按验证目标组织，单元测试可随代码 colocate，跨包测试进入 `tests/`。
6. 迁移分阶段进行，先建立新目录与 re-export，再逐步移动实现。

## 目标目录

```text
memory-autodb/
├── packages/
│   ├── core/
│   │   ├── src/
│   │   │   ├── domain/
│   │   │   ├── scoring/
│   │   │   ├── lifecycle/
│   │   │   ├── retrieval/
│   │   │   ├── graph/
│   │   │   ├── tree/
│   │   │   ├── ingest/
│   │   │   ├── storage/
│   │   │   ├── db/
│   │   │   ├── routing/
│   │   │   └── runtime/
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── mcp/
│   │   ├── src/
│   │   │   ├── tools.ts
│   │   │   ├── stdio-server.ts
│   │   │   ├── http-server.ts
│   │   │   └── schemas.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── api/
│   │   ├── src/
│   │   │   ├── rest/
│   │   │   ├── sdk/
│   │   │   ├── cli/
│   │   │   └── generated/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── ui/
│       ├── src/
│       │   ├── console/
│       │   ├── components/
│       │   └── api-client/
│       ├── package.json
│       └── tsconfig.json
├── plugins/
│   ├── openclaw/
│   ├── codex/
│   ├── claude-code/
│   └── _template/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── smoke/
│   ├── fixtures/
│   ├── eval/
│   └── helpers/
├── bin/
├── docs/
├── scripts/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── vitest.config.ts
```

## 能力层说明

### `packages/core`

核心包是单一事实来源，包含所有产品无关逻辑。

| 目标子目录 | 当前来源 | 职责 |
|---|---|---|
| `domain/` | `packages/core/src/domain/` | 基础类型、scope、服务契约、召回评分、领域映射、语义协议、profile 分层、召回过滤 |
| `scoring/` | `packages/core/src/scoring/`、`packages/core/src/domain/recall-scoring.ts` | valueScore / importance / confidence / hotness |
| `lifecycle/` | `packages/core/src/lifecycle/` | 候选区、validator、去重、遗忘、晋升 |
| `retrieval/` | `packages/core/src/retrieval/` | 召回编排、上下文打包、prompt safety |
| `graph/` | `packages/core/src/graph/` | entity/relation、中心性、query hits |
| `tree/` | `packages/core/src/tree/` | L0-L3 摘要树、leaf routing、faithfulness |
| `ingest/` | `packages/core/src/ingest/` | chunker、canonicalize、scanner、history import |
| `storage/` | `packages/core/src/storage/` | repository 抽象与实现 |
| `db/` | `packages/core/src/db/` | LanceDB/Supabase/Postgres provider |
| `routing/` | `packages/core/src/routing/` | table / knowledge base 路由 |
| `service/` | `packages/core/src/service/memory-service.ts` | MemoryService 实现 |
| `context/` | `core/slot-*` | 5 槽位上下文构建、prompt packer、snapshot cache |
| `runtime/` | `packages/core/src/runtime/{paths,registry}.ts`、`packages/core/src/runtime/llm/`、`runtime.ts`、`config.ts` | 全局路径、项目 registry、LLM/embedding runtime、createMengshuRuntime、配置解析、错误标准化 |

禁止事项：

- 不 import `openclaw/plugin-sdk`
- 不 import Codex plugin manifest 或 CLI UI
- 不读写 `~/.codex` / `~/.claude` / `~/.openclaw` 产品配置

### `packages/mcp`

MCP 包只处理 MCP 协议，不处理产品安装方式。

迁移来源：

- `adapters/mcp/tools.ts`
- `adapters/mcp/stdio-server.ts`
- `adapters/mcp/server.ts`
- `scripts/mengshu-mcp.ts` 中可复用的 server bootstrap

目标导出：

```ts
export { createMcpMemoryTools } from "./tools";
export { createMcpStdioServer, startMcpStdioServer } from "./stdio-server";
export { createMcpHttpServer } from "./http-server";
```

依赖方向：

```text
packages/mcp -> packages/core
plugins/codex -> packages/mcp
bin/ms -> packages/mcp
```

### `packages/api`

API 包聚合对外调用面：REST、SDK、CLI 命令注册。

迁移来源：

- `adapters/rest`
- `adapters/sdk`
- `bin/ms.ts`
- `adapters/openclaw/cli-*` 中产品无关的 `ms` 命令
- `docs/api/*` 对应接口说明

拆分建议：

```text
packages/api/src/rest/
packages/api/src/sdk/
packages/api/src/cli/
```

CLI 包首期可仍由根 `bin/ms.ts` 调用，待 workspace 稳定后发布为 `@mengshu/cli`。

### `packages/ui`

UI 包承载 Web Console 和未来可视化工具。

迁移来源：

- `console/`
- `packages/ui/src/web/`

依赖方向：

```text
packages/ui -> packages/api/sdk
packages/ui 不直接 import packages/core/storage/db
```

这样 UI 的数据访问必须通过 SDK/REST contract，避免控制台绕开权限和 prompt-safety 逻辑。

### `plugins`

`plugins/` 是产品插件包目录，承载开源和闭源 Agent 产品的集成形态。

首期：

- `plugins/openclaw`
- `plugins/codex`

后续可扩展：

- `plugins/claude-code`
- `plugins/cursor`
- `plugins/cline`
- `plugins/zed`
- `plugins/open-webui`

每个插件包必须包含：

- 自己的 manifest
- README
- 安装/卸载/验证说明
- smoke test
- 对核心包的依赖声明

插件包不得复制核心算法；只做宿主能力桥接。

### `tests`

测试目录按验证目标组织，而不是按历史源码路径堆叠。

```text
tests/
├── unit/              # 可选，全局纯函数/跨包单测；多数单测仍可 colocate
├── integration/       # DB/runtime/API 跨模块集成
├── contract/          # MCP/OpenClaw/Codex manifest 和工具契约
├── smoke/             # CLI、MCP handshake、插件加载
├── fixtures/          # 共享 fixtures
├── eval/              # golden set、评估 runner、结果
└── helpers/           # 测试辅助
```

迁移建议：

- 现有 `*.test.ts` 暂时保留 colocate，降低重构风险。
- `eval/` 迁到 `tests/eval/`，通过 `npm run eval:quick` 保持命令入口兼容。
- 新增跨包测试必须放入 `tests/integration`、`tests/contract`、`tests/smoke`。

## 当前目录到目标目录映射

| 当前目录/文件 | 目标位置 | 迁移策略 |
|---|---|---|
| `core/` | `packages/core/src/{domain,service,context,runtime}/` + 根层兼容 bridge | 已迁移核心类型/scope/service contract/recall-scoring/semantic/profile/recall-filter/memory-service/slot/paths/registry；根 `core/*` 仅 re-export |
| `processing/` | `packages/core/src/scoring/` + `packages/core/src/runtime/llm` | 已迁移，旧路径 re-export |
| `lifecycle/` | `packages/core/src/lifecycle/` | 已迁移，旧路径 re-export |
| `retrieval/` | `packages/core/src/retrieval/` | 已迁移，旧路径 re-export |
| `graph/` | `packages/core/src/graph/` | 已迁移，旧路径 re-export |
| `tree/` | `packages/core/src/tree/` | 已迁移，旧路径 re-export |
| `feedback/` | `packages/core/src/feedback/` | 已迁移，旧路径 re-export |
| `ingest/` | `packages/core/src/ingest/` | 已迁移，旧路径 re-export；产品 source adapter 已拆到 `plugins/*/sources` |
| `scanner/` | `packages/core/src/ingest/scanner/` | 已迁移，旧路径 re-export |
| `db/` | `packages/core/src/db/` | 已迁移，旧路径 re-export |
| `storage/` | `packages/core/src/storage/` | 已迁移，旧路径 re-export |
| `routing/` | `packages/core/src/routing/` | 已迁移，旧路径 re-export |
| `api/` | `packages/core/src/agent-api/` 或 `packages/api/src/agent-fast-path/` | 按是否产品无关决定 |
| `adapters/mcp/` | `packages/mcp/src/` | 整体迁移 |
| `adapters/rest/` | `packages/api/src/rest/` | 整体迁移 |
| `adapters/sdk/` | `packages/api/src/sdk/` | 整体迁移 |
| `adapters/openclaw/` | `plugins/openclaw/src/` | 先 re-export，后移动实现 |
| `adapters/sources/` | `packages/core/src/ingest/sources/` + `plugins/*/sources` | 已迁移，旧路径 re-export |
| `console/` | `packages/ui/src/console/` | UI 包建立后迁移 |
| `bin/ms.ts` | `packages/api/src/cli/bin.ts` 或 `packages/cli/src/index.ts` | P3 后独立 CLI 包 |
| `eval/` | `tests/eval/` | 保留 npm script 兼容 |
| `coverage/` | 不入源码结构 | 加强 `.gitignore`，不纳入架构 |

## 包依赖方向

```text
plugins/openclaw ─┐
plugins/codex    ├── packages/mcp ─── packages/core
packages/api     ┘        │
packages/ui ──────────────┘

bin/ms -> packages/api + packages/mcp + packages/core
tests -> all packages
```

禁止反向依赖：

- `packages/core` 不依赖 `packages/api`
- `packages/core` 不依赖 `packages/mcp`
- `packages/core` 不依赖 `plugins/*`
- `packages/mcp` 不依赖 `plugins/*`
- `packages/ui` 不直接依赖 `db/providers`

## 包命名建议

| 包 | npm 名 | 发布阶段 |
|---|---|---|
| core | `@mengshu/core` | P0 保留 |
| mcp | `@mengshu/mcp` | P2/P3 |
| api | `@mengshu/api` | P3 |
| cli | `@mengshu/cli` | P3，可从 api 拆出 |
| ui | `@mengshu/ui` | P3/P4 |
| OpenClaw plugin | `@mengshu/plugin-openclaw` | P3 |
| Codex plugin | `@mengshu/plugin-codex` | P3 |

首期不急于发布多个 npm 包，先在仓库内建立目录和导入边界。

## TypeScript 与构建策略

### 当前问题

当前 `tsconfig.json` 使用：

```json
{
  "rootDir": "./",
  "noEmit": true,
  "include": ["./**/*.ts"]
}
```

这适合单包开发，但不适合多包发布。后续需要拆成：

```text
tsconfig.base.json
packages/*/tsconfig.json
plugins/*/tsconfig.json
tsconfig.json              # references 聚合
```

### 推荐配置

根 `tsconfig.json`：

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/mcp" },
    { "path": "./packages/api" },
    { "path": "./plugins/openclaw" },
    { "path": "./plugins/codex" }
  ]
}
```

每个包开启 declaration 输出：

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "declaration": true
  },
  "include": ["src/**/*.ts"]
}
```

## 分阶段实施

### S0：规划与边界校验

任务：

1. 落地本方案文档。
2. 标记当前源码所有跨层 import。
3. 建立依赖边界检查脚本，先 report-only。
4. 明确 `packages/core` 公共 API 清单。

验收：

```bash
npm test
npx tsc --noEmit
```

### S1：建立目录骨架和 barrel exports

任务：

1. [x] 新建 `packages/core/src`、`packages/mcp/src`、`packages/api/src`、`packages/ui/src`、`plugins/openclaw`、`plugins/codex`、`tests/*`。
2. [x] 暂时不移动大量实现，只建立 `index.ts` re-export。
3. [x] 根路径继续兼容旧 import。
4. [x] 新增新旧入口和 manifest contract 测试，沿用现有 `vitest.config.ts` 测试发现规则。

验收：

```bash
npm test
npx tsc --noEmit
```

### S2：迁移协议层

任务：

1. [x] `adapters/mcp` -> `packages/mcp/src`。
2. [x] `adapters/rest`、`adapters/sdk` -> `packages/api/src`。
3. [x] 根旧路径保留 re-export。
4. [x] `bin/ms.ts` 改为调用 `packages/api/src/cli` 和 `packages/mcp`。

当前实现边界：

- `packages/mcp/src` 已承载 MCP tools / stdio-server / transport-agnostic server 实现，`adapters/mcp/*` 为兼容 re-export。
- `packages/api/src` 已承载 `agent-fast-path`、REST router/auth/types、SDK client/types 实现，`api/agent-fast-path.ts`、`adapters/rest/*`、`adapters/sdk/*` 为兼容 re-export。
- `bin/ms.ts` 已瘦身为入口壳，实际 CLI 主逻辑位于 `packages/api/src/cli/ms.ts`。
- `ms mcp` 与独立 `scripts/mengshu-mcp.ts` 已直接调用 `packages/mcp/src/stdio-server.ts`。
- OpenClaw scope / manifest 和 CLI 命令注册模块已迁到 `plugins/openclaw/src/*`，`adapters/openclaw/*` 为兼容 re-export；下一阶段再把产品无关命令继续拆入 `packages/api/src/cli`，OpenClaw 只保留宿主桥接。

验收：

```bash
ms --help
ms mcp
npm test -- adapters/mcp adapters/rest adapters/sdk
```

### S3：迁移产品插件层

任务：

1. [x] `adapters/openclaw/index.ts` -> `plugins/openclaw/src/register.ts`，旧路径保留 re-export。
2. [x] 新建 `plugins/codex`。
3. [x] OpenClaw 插件 id 修正为 `mengshu-openclaw`，并保留 `memory-autodb` / `mengshu` legacy alias。
4. [x] Codex 插件加入仓库级 marketplace。
5. [x] `adapters/openclaw/tools.ts`、`hooks.ts`、`context-fast.ts` 继续迁到 `plugins/openclaw/src`。
6. [x] `adapters/openclaw/cli-*.ts` 迁到 `plugins/openclaw/src/cli/`，旧路径保留 re-export；产品无关 CLI 继续拆入 `packages/api/src/cli` 留到后续阶段。
7. [x] `adapters/openclaw/scope.ts`、`manifest.ts` 迁到 `plugins/openclaw/src/`，旧路径保留 re-export。

当前实现边界：

- OpenClaw canonical 入口为 `plugins/openclaw/src/index.ts`，注册主实现位于 `plugins/openclaw/src/register.ts`。
- 根 `index.ts` 和 `adapters/openclaw/index.ts` 仅保留兼容 re-export。
- OpenClaw tools / hooks / `memory_context_fast` handler 已迁到 `plugins/openclaw/src/tools.ts`、`hooks.ts`、`context-fast.ts`；旧 `adapters/openclaw/*` 同名文件仅保留兼容 re-export。
- OpenClaw scope / manifest 已迁到 `plugins/openclaw/src/scope.ts`、`manifest.ts`；旧 `adapters/openclaw/*` 同名文件仅保留兼容 re-export。
- OpenClaw CLI 注册实现已迁到 `plugins/openclaw/src/cli/`；旧 `adapters/openclaw/cli-*.ts` 和 `agent-service-helper.ts` 仅保留兼容 re-export。
- `plugins/openclaw/openclaw.plugin.json` 和根 `openclaw.plugin.json` 均使用 `mengshu-openclaw`，通过 `legacyPluginIds: ["memory-autodb", "mengshu"]` 兼容旧配置；`ms migrate-openclaw-plugin-id` 可迁移 `~/.openclaw/conf/plugins.json`。
- `plugins/codex` 已包含 `.codex-plugin/plugin.json`、`.mcp.json`、`mcp/server.mjs`、skill 和 `.agents/plugins/marketplace.json` 本地 marketplace 条目。
- OpenClaw CLI、scope、manifest 相关模块已迁入 `plugins/openclaw/src/*`；后续再按产品无关能力和宿主桥接职责继续拆分 CLI 与 runtime bridge。

验收：

```bash
openclaw plugins doctor
openclaw plugins list --json
codex plugin add mengshu-memory@mengshu-local
npx vitest run tests/smoke/codex-mcp-plugin.test.ts
```

### S4：迁移核心域层

任务：

1. [x] 按子域移动 `core`、`processing`、`lifecycle`、`retrieval`、`graph`、`tree`、`ingest`、`db`、`storage`。
2. [x] `routing/` -> `packages/core/src/routing/`，旧路径 re-export。
3. [x] `feedback/` -> `packages/core/src/feedback/`，旧路径 re-export。
4. [x] `adapters/sources/jsonl-parser.ts` -> `packages/core/src/ingest/sources/jsonl-parser.ts`，产品 source adapter 迁入 `plugins/*/sources`。
5. [x] `core/{types,scope,scope-policy,service-types,recall-scoring,legacy-mapping,status-mapping,semantic-types,semantic-type-mapper,profile-layer,recall-filter}` -> `packages/core/src/domain/`，旧路径 re-export。
6. [x] `core/memory-service.ts` -> `packages/core/src/service/memory-service.ts`，旧路径 re-export。
7. [x] `core/slot-*` -> `packages/core/src/context/`，旧路径 re-export。
8. [x] `core/{paths,registry}.ts` -> `packages/core/src/runtime/`，旧路径 re-export。
9. [x] `processing/{value-score,importance-score,confidence-score,scoring-weights,hash-utils,text-splitter,value-score-signals}.ts` -> `packages/core/src/scoring/`，旧路径 re-export。
10. [x] `processing/{llm-client,embeddings,extraction-rules}.ts` -> `packages/core/src/runtime/llm/`，旧路径 re-export。
11. [x] `retrieval/{context-packer,fusion,orchestrator,prompt-safety}.ts` -> `packages/core/src/retrieval/`，旧路径 re-export。
12. [x] `db/{types,factory,providers/*}.ts` -> `packages/core/src/db/`，旧路径 re-export。
13. [x] `storage/{legacy-database-adapter,indexes,repositories}` -> `packages/core/src/storage/`，旧路径 re-export。
14. [x] `ingest/{pipeline,chunker,canonicalize,jobs,adapters,agent-history}` -> `packages/core/src/ingest/`，旧路径 re-export。
15. [x] `scanner/*` -> `packages/core/src/ingest/scanner/`，旧路径 re-export。
16. [x] `lifecycle/*` -> `packages/core/src/lifecycle/`，旧路径 re-export。
17. [x] `graph/*` -> `packages/core/src/graph/`，旧路径 re-export。
18. [x] `tree/*` -> `packages/core/src/tree/`，旧路径 re-export。
19. [ ] 引入 package references。
20. [ ] 删除旧路径或保留 deprecated bridge 一个版本周期。

当前实现边界：

- `packages/core/src/domain/` 已承载基础领域类型、scope/scope-policy、服务契约、6 因子召回评分、legacy 映射、用户可见状态映射、5 问题语义协议、kind 到 semanticType 映射、profile 三层分层与召回过滤。
- `packages/core/src/service/` 已承载 `DefaultMemoryService`，`packages/core/src/context/` 已承载 slot context builder / prompt packer / snapshot cache，`packages/core/src/runtime/` 已承载全局路径与 registry。
- `packages/core/src/scoring/` 已承载 value/importance/confidence 评分、权重、hash/text 工具和 value signals；`packages/core/src/runtime/llm/` 已承载 LLM client、embedding runtime 和 extraction rules。
- `packages/core/src/retrieval/` 已承载召回编排、RRF 融合、上下文打包和 prompt safety。
- `packages/core/src/db/` 已承载 provider contract、factory 和 LanceDB/Supabase/Postgres/Hybrid provider；`packages/core/src/storage/` 已承载 legacy adapter、in-memory repository、job repository 和 BM25 text index。
- 根 `core/*` 仅作为兼容 re-export。
- 根 `processing/*` 仅作为兼容 re-export。
- 根 `retrieval/*` 仅作为兼容 re-export。
- 根 `db/*`、`storage/*` 仅作为兼容 re-export。
- `packages/core/src/index.ts` 已导出 `domain`、`feedback`、`routing`、通用 source parser 和根层核心类型/服务，作为新包入口。
- `tests/contract/package-compat-exports.test.ts` 覆盖新包入口、迁移后实现路径和旧路径兼容 facade 的一致性。

验收：

```bash
npm test
npx tsc --build
npm run eval:quick
```

### S5：UI 与测试体系收敛

任务：

1. [x] `console` -> `packages/ui`。
2. [x] `eval` -> `tests/eval`。
3. 新增 `tests/smoke/openclaw`、`tests/smoke/codex-mcp`。
4. CI 分层：unit / integration / smoke / eval。

当前实现边界：

- Console 聚合 API 和类型已迁到 `packages/ui/src/console`，根 `console/api.ts`、`console/types.ts` 为兼容 re-export。
- Web Console 静态前端已迁到 `packages/ui/src/web`，`server/daemon.ts` 从该路径提供 `/console` 静态资源。
- Golden set、评测 runner、adapter 和历史结果已迁到 `tests/eval`，`npm run eval:quick` 保持命令兼容。

验收：

```bash
npm run test:unit
npm run test:integration
npm run test:smoke
npm run eval:quick
```

## 验收标准

完成后应满足：

- 核心算法层无产品 SDK import。
- OpenClaw 和 Codex 插件可单独安装、禁用、验证。
- `ms` CLI 与 MCP server 仍可独立使用。
- REST / SDK / UI 通过 API contract 访问核心能力。
- 新增产品插件只需新增 `plugins/<product>`，不改核心目录。
- 旧路径有清晰 deprecation 周期，不突然破坏已有用户配置。

## 风险与控制

| 风险 | 控制 |
|---|---|
| 一次性移动导致 import 爆炸 | 先 re-export，再小批移动 |
| 多包构建增加复杂度 | S1/S2 只建目录不立刻发布多包 |
| 测试路径变化导致覆盖率下降 | 保留 colocated 单测，跨包测试进 `tests/` |
| 插件依赖源码路径 | P3 后统一 dist 产物和 package exports |
| UI 绕过 API | 明确 `packages/ui -> packages/api` 依赖规则 |
| eval 历史路径失效 | `npm run eval:quick` 保持兼容，文档统一指向 `tests/eval` |

## 与插件化方案的关系

本方案是仓库结构总方案；`plugin-packaging-implementation-plan.md` 是其中 `plugins/` 层的产品插件实施细化。实施顺序建议：

1. 先按本方案 S1 建骨架。
2. 再按插件化方案完成 `plugins/openclaw` 和 `plugins/codex`。
3. 最后迁移核心、API、UI、测试目录。
