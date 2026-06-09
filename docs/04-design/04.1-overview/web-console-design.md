# Web Console Design

> 版本：v4.0 Overview  
> 日期：2026-05-30  
> 状态：设计方案  
> 关联架构：[memory-middleware-architecture.md](../../03-architecture/memory-middleware-architecture.md)  
> 关联详细设计：[structured-knowledge-graph-memory-tree-detail.md](../04.2-detail/structured-knowledge-graph-memory-tree-detail.md)

---

## 1. 模块职责

Web Console 是 memory-autodb 中间件的基础可视化界面，目标不是替代产品侧 UI，而是提供本机/团队部署时的“知识速查 + 整体预览 + 运维观测”。

核心职责：

1. **知识速查**：快速搜索 memory、knowledge、chunk、summary、entity、relation，并展示来源证据。
2. **整体预览**：展示当前记忆库规模、来源、命名空间、时间活跃度、热门实体、最近摘要。
3. **图谱与记忆树浏览**：浏览 Entity Graph、Source Tree、Topic Tree、Global Tree。
4. **来源追溯**：从召回结果回到 source/document/chunk/summary/evidence。
5. **系统健康**：展示 ingest jobs、embedding 状态、graph/tree 构建状态、失败重试和存储健康。
6. **治理操作**：最小化提供 forget、archive、rebuild、export、reindex、retry job，所有破坏性操作必须确认和审计。

定位：

| 不做 | 要做 |
|------|------|
| 不做营销站 | 做可反复使用的操作台 |
| 不做全功能数据标注平台 | 做基础查看、搜索、追溯、诊断 |
| 不直接暴露所有底层表 | 按产品语义组织信息 |
| 不默认允许远程裸奔访问 | 本机 loopback 优先，远程必须认证 |

---

## 2. 信息架构

### 2.1 一级导航

```text
Web Console
├── Overview        # 整体预览
├── Quick Lookup    # 知识速查
├── Graph           # 实体关系图
├── Trees           # Source / Topic / Global tree
├── Sources         # 来源、文档、扫描目录、连接器
├── Jobs            # ingest / embed / extract / seal / digest jobs
├── Audit           # 删除、导入导出、权限、重建记录
└── Settings        # scope、存储、索引、功能开关
```

### 2.2 默认首页

默认打开 `Overview`，第一屏应让用户知道：

1. 当前连接的是哪个 memory server。
2. 当前 scope 是什么。
3. 记忆库是否健康。
4. 有多少 memories / chunks / entities / relations / summary nodes。
5. 最近 24h 发生了什么。
6. 当前最热 topic 是什么。

---

## 3. 页面设计

### 3.1 Overview

模块：

| 区域 | 内容 |
|------|------|
| Scope Bar | tenant/app/user/workspace/project/namespace 切换器 |
| Health Strip | server、storage、embedding、jobs、graph、tree 状态 |
| Metrics Grid | memories、chunks、entities、relations、summaries、sources、jobs failed |
| Recent Activity | 最近 ingest、store、delete、seal、digest 事件 |
| Hot Topics | hotness 排名前 N 的实体/主题 |
| Daily Digest | global tree 最新 daily summary |
| Source Coverage | 来源分布：OpenClaw sessions、files、knowledge、manual/import |

交互：

1. 点击 metric 进入对应列表页。
2. 点击 hot topic 进入 Topic Tree。
3. 点击 daily digest 可展开 evidence chunks。
4. Health Strip 失败项跳转 Jobs 或 Settings。

### 3.2 Quick Lookup

这是最重要页面，面向日常速查。

布局：

```text
┌────────────────────────────────────────────────────────────┐
│ Scope selector | Query input | Search mode | Run            │
├───────────────┬───────────────────────────┬────────────────┤
│ Filters       │ Results                   │ Evidence Panel │
│ namespace     │ ranked hits               │ selected hit   │
│ kind          │ score badges              │ source/chunks  │
│ source        │ provenance icons          │ graph path     │
│ time range    │                           │ tree path      │
│ min score     │                           │ raw content    │
└───────────────┴───────────────────────────┴────────────────┘
```

搜索模式：

| 模式 | 说明 |
|------|------|
| `Auto` | 自动识别 semantic/entity/topic/source/time |
| `Semantic` | 向量 + BM25 |
| `Entity` | 实体关系查询 |
| `Topic` | topic tree 状态查询 |
| `Source` | source tree drilldown |
| `Time` | global digest / 时间范围 |

结果卡片字段：

```typescript
interface LookupResultView {
  id: string;
  kind: "memory" | "chunk" | "summary" | "entity" | "relation";
  title: string;
  preview: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  sourceLabel: string;
  namespace: string;
  updatedAt: number;
  badges: string[];
  provenanceCount: number;
}
```

Evidence Panel 展示：

1. 来源路径：source -> document -> chunk -> summary/relation。
2. score breakdown。
3. 相关实体和关系。
4. 原始 chunk 文本。
5. 可复制为 prompt context 的安全格式。
6. 操作：open source、copy id、archive、forget、reindex。

### 3.3 Graph

Graph 页用于结构化知识图谱浏览，不追求一次展示所有节点。

能力：

1. 搜索实体。
2. 以实体为中心展开 1-2 层关系。
3. 按 predicate、confidence、time range、source 过滤。
4. 点击边展示 evidence chunks。
5. 展示 entity hotness、mention count、distinct sources、last seen。

图视图与表视图并存：

| 视图 | 说明 |
|------|------|
| Graph Canvas | 看局部关系网络 |
| Relation Table | 精确筛选和排序 |
| Entity Drawer | 实体详情、别名、topic tree 入口 |

性能边界：

1. 默认最多渲染 200 nodes / 500 edges。
2. 超过限制进入 table-first 模式。
3. Graph API 必须分页/按 depth 查询，禁止一次取全图。

### 3.4 Trees

Trees 页展示三类记忆树。

Tabs：

| Tab | 内容 |
|-----|------|
| Source Tree | 按 sourceId 浏览 L0/L1/L2 摘要与 chunks |
| Topic Tree | 按 hot entities 浏览主题摘要 |
| Global Tree | 按日期浏览 daily/weekly/monthly digest |

交互：

1. 左侧 tree selector。
2. 中间 tree timeline / node list。
3. 右侧 node detail，展示 summary、children、leaf chunks、entities、relations。
4. 支持 drill down：summary -> child summary -> leaf chunks。
5. 支持 flush/seal/rebuild 操作，仅 admin 或本机 owner 可用。

### 3.5 Sources

用于查看数据从哪里来。

字段：

| 字段 | 说明 |
|------|------|
| sourceId | 稳定来源 ID |
| sourceType | file/openclaw-session/manual/import/connector |
| namespace | 所属 namespace |
| documentCount | 文档数 |
| chunkCount | chunk 数 |
| lastIngestedAt | 最近摄取时间 |
| syncStatus | idle/running/failed/disabled |
| treeStatus | not_started/buffering/sealed/stale |

操作：

1. run ingest。
2. reindex。
3. rebuild graph。
4. rebuild tree。
5. export source。
6. delete/archive source。

### 3.6 Jobs

用于诊断后台管线。

Queue lanes：

| Lane | Jobs |
|------|------|
| Ingest | canonicalize/chunk/admit |
| Embedding | embed_chunk |
| Graph | extract_chunk/recompute_hotness |
| Tree | append_buffer/seal_buffer/digest_daily/flush_stale |
| Lifecycle | retention_sweep/export_vault |

视图：

1. 当前队列深度。
2. running / failed / dead jobs。
3. 最近错误。
4. retry / cancel / dead-letter inspect。
5. worker lease 状态。

### 3.7 Audit

显示治理操作：

| 事件 | 内容 |
|------|------|
| store | 谁写入、scope、source |
| forget | 删除对象、原因、影响数量 |
| export/import | 文件、scope、条目数量 |
| rebuild | graph/tree/index 重建 |
| auth | 登录/认证失败 |
| settings | 配置变更 |

Audit 默认只读。破坏性操作必须写 audit。

---

## 4. API 设计

Web Console 不直接读数据库，只通过 REST API。

### 4.1 Console API

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/v1/console/overview` | 首页指标和摘要 |
| `POST` | `/v1/console/lookup` | 知识速查 |
| `GET` | `/v1/console/entities` | 实体列表 |
| `GET` | `/v1/console/entities/:id` | 实体详情 |
| `GET` | `/v1/console/graph` | 局部图查询 |
| `GET` | `/v1/console/trees` | tree 列表 |
| `GET` | `/v1/console/trees/:id` | tree node/detail |
| `GET` | `/v1/console/sources` | 来源列表 |
| `GET` | `/v1/console/jobs` | job 列表 |
| `POST` | `/v1/console/jobs/:id/retry` | 重试 job |
| `GET` | `/v1/console/audit` | 审计列表 |
| `GET` | `/v1/console/settings` | console 可见配置 |

### 4.2 Lookup Request

```typescript
interface ConsoleLookupRequest {
  scope: Partial<MemoryScope>;
  query: string;
  mode: "auto" | "semantic" | "entity" | "topic" | "source" | "time";
  filters?: {
    namespaces?: string[];
    kinds?: string[];
    sourceIds?: string[];
    entityIds?: string[];
    predicates?: string[];
    since?: number;
    until?: number;
    minScore?: number;
  };
  limit?: number;
  includeEvidence?: boolean;
  includeRawChunk?: boolean;
}
```

### 4.3 Lookup Response

```typescript
interface ConsoleLookupResponse {
  queryId: string;
  modeUsed: string;
  elapsedMs: number;
  results: LookupResultView[];
  facets: {
    namespaces: Array<{ value: string; count: number }>;
    kinds: Array<{ value: string; count: number }>;
    sources: Array<{ value: string; count: number }>;
    entities: Array<{ id: string; label: string; count: number }>;
  };
  selectedEvidence?: EvidenceView;
  warnings: string[];
}
```

---

## 5. 权限与安全

### 5.1 访问模式

| 模式 | 策略 |
|------|------|
| loopback local | 默认开启，首次生成 local secret |
| remote server | 必须认证，建议 HTTPS |
| embedded OpenClaw | 通过 OpenClaw adapter 内部调用，不暴露 console |
| team deploy | tenant + role |

### 5.2 Role

| Role | 权限 |
|------|------|
| `viewer` | 查看 overview/lookup/graph/tree/source |
| `operator` | retry job、run ingest、reindex |
| `admin` | forget、archive、settings、export/import |

### 5.3 安全约束

1. Console 所有接口必须带 scope filter。
2. Evidence raw chunk 默认隐藏敏感字段。
3. `<private>` 和 `privacyLevel=private` 内容不展示 raw，只展示占位。
4. destructive action 二次确认，并写 audit。
5. 远程 HTTP 非 HTTPS 时不得发送 bearer，除非显式 insecure 开关。

---

## 6. 前端技术建议

当前仓库是 TypeScript 插件/中间件，Web Console 建议作为轻量内置前端：

| 层 | 建议 |
|----|------|
| 构建 | Vite + React 或纯静态 HTML/TS |
| 样式 | CSS variables + utility classes，避免引入重 UI 框架 |
| 图谱 | 初期用 SVG/Canvas 局部图，后续可接 Cytoscape/D3 |
| 表格 | 自研轻量 table，支持排序/筛选/分页 |
| 状态 | URL query 保持 scope/filter/query，可分享 |
| 部署 | server 内置静态文件，`/console` 访问 |

不建议第一阶段引入复杂 Next.js/SSR。Console 是本机中间件 UI，应优先低依赖、易打包、可离线运行。

---

## 7. 视觉与交互原则

Console 是工具型界面，设计方向应是“密集但清晰的运维/知识工作台”：

1. 首屏不做 hero，不做营销说明。
2. 布局优先扫描效率：左侧导航、顶部 scope bar、主体分栏。
3. 卡片只用于 metric 或重复实体，不嵌套卡片。
4. 表格、过滤器、详情抽屉是核心控件。
5. 颜色用于状态和类型，不做大面积单色主题。
6. 关键对象都可复制 ID、打开来源、查看 provenance。
7. 所有破坏性操作用明确按钮、确认文案和影响范围。

推荐信息密度：

| 页面 | 密度 |
|------|------|
| Overview | 中等，强调概览和异常 |
| Quick Lookup | 高，三栏工作台 |
| Graph | 中等，图 + 表 + drawer |
| Trees | 高，tree list + node detail |
| Jobs | 高，队列和错误诊断 |

---

## 8. 与其他模块的交互

```text
Web Console
  -> REST Console API
      -> MemoryService
      -> RetrievalOrchestrator
      -> StructuredGraphService
      -> MemoryTreeService
      -> JobRepository
      -> AuditRepository
```

Console 不直接依赖 OpenClaw。OpenClaw 只是其中一个 source/app/scope。

---

## 9. 第一阶段范围

MVP 只做四页：

1. `Overview`
2. `Quick Lookup`
3. `Graph`
4. `Jobs`

MVP API：

1. `/v1/console/overview`
2. `/v1/console/lookup`
3. `/v1/console/graph`
4. `/v1/console/jobs`

暂不做：

1. 完整 Settings。
2. 多用户团队 RBAC UI。
3. 复杂图布局编辑。
4. connector 管理。
5. 在线手工 merge entity。

---

## 10. 测试策略

| 测试 | 目标 |
|------|------|
| Console API contract | response schema 稳定 |
| Scope filtering | overview/lookup/graph/jobs 不跨 scope |
| Lookup facets | filter count 与结果一致 |
| Evidence rendering | relation/summary/chunk provenance 正确 |
| Sensitive content | private/raw 内容不泄露 |
| Job actions | retry/cancel 写 audit |
| UI smoke | `/console` 可加载，四个页面无空白 |
| Large graph | 节点超限降级 table-first |

---

## 11. 后续演进

| 阶段 | 能力 |
|------|------|
| Phase 1 | 本机 console，overview/lookup/graph/jobs |
| Phase 2 | Trees、Sources、Audit |
| Phase 3 | Settings、export/import、rebuild tools |
| Phase 4 | 多租户团队视图、RBAC |
| Phase 5 | entity merge、relation correction、人工标注反馈 |

---

## 创建信息

- 创建日期：2026-05-30
- 最后更新：2026-05-30
