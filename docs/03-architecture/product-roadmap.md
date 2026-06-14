# memory-autodb 产品路线图

> 日期：2026-06-14
> 状态：当前版本规划真源
> 适用范围：约束 v0.1.x 之后的版本节奏、发布门槛和优先级取舍。
> 编制依据：[product-positioning.md](./product-positioning.md)、[next-iteration-product-plan.md](../04-design/04.2-detail/next-iteration-product-plan.md)、[v0.1 验收报告](../07-test/v0.1-acceptance-report.md)、[changelog](../09-changelog/README.md) 和当前 CodeGraph 代码核对。

---

## 1. 路线图原则

memory-autodb 的产品路线图只围绕两个主轴展开：

1. **Working Context 语义层**：把长期记忆整理成 Agent Runtime 可直接使用的 5 slot 上下文。
2. **Project Memory Workspace 本地入口**：把本地目录变成用户工作上下文的 project 容器。

近期不做以下方向：

1. 不做通用 RAG / 知识库平台。
2. 不做企业 Memory Lake 或云端同步平台。
3. 不做 coding-agent 专用记忆。
4. 不做上下文路由 DSL / proactive routing 平台。
5. 不做 OpenMemory / Letta Agent File 完整 import/export 互操作。
6. 不把 Console 扩展成复杂治理产品。

版本规划必须满足三个要求：

1. **每个版本都有可验证的用户价值**，不能只交付内部抽象。
2. **每个版本都有 release gate**，至少包含类型检查、单元/集成测试、quick eval、安全门槛。
3. **当前已实现和未来计划分开写**，changelog 只记录已交付能力，roadmap 只记录后续承诺。

---

## 2. 当前基线

### 2.1 历史版本线

| 版本 | 状态 | 价值 |
|------|------|------|
| v2.1.0 | 历史兼容基线 | OpenClaw 插件、多表存储、CLI、扫描、自动捕获/召回 |
| v3.0.0 | 历史架构升级 | 5 问题语义协议、Agent 快路径、候选区、Slot Context Builder |
| v4.0.0 | 中间件 baseline | MemoryService、REST、MCP facade、SDK、ingestion、retrieval、graph/tree/console baseline |
| v0.1.0 | 产品新线起点 | 单 appId Working Context 闭环：scope policy、5 slot、候选区治理、eval gate |
| v0.1.1 | 当前最新基线 | MCP stdio、LLM client、observe → build_tree、lookup_deep 树摘要融合 |

> 说明：v0.1.x 是产品方向重定位后的新版本线，基于 v4.0.0 baseline 演进。`package.json` 当前仍使用 `2026.3.9` 版本号，后续需要在 release governance 中统一产品版本、包版本和 changelog 版本。

### 2.2 当前已经具备的能力

| 能力 | 当前状态 | 证据 |
|------|----------|------|
| 单 appId Working Context | 已完成 | v0.1.0 changelog + v0.1 验收报告 |
| 5 slot `context_fast` | 已完成 | `ContextFastResponse`、SlotContextBuilder、quick eval |
| 注入安全 | 已完成 | safety suite 40/40 PASS，误注入 0% |
| 候选区治理 | 已完成基础闭环 | Console Candidates API/page + candidate promotion |
| Project Workspace identity | 已完成 lite 版 | `ltm init` + `.memory-autodb.json` manifest |
| MCP 真实接入 | 已完成 stdio transport | v0.1.1 changelog，仍需真实客户端冒烟 |
| LLM 客户端 | 已完成 OpenAI-compatible client | v0.1.1 changelog，仍需真实 API 冒烟 |
| 记忆树 | 已完成 in-memory 自动构建基础 | observe 入队 `build_tree`，`lookup_deep` 融合 tree summary |
| quick eval | 已完成本地黄金集 | `memory-autodb-v0.1`、`memory-autodb-safety` |

### 2.3 当前缺口

| 缺口 | 影响 | 放入版本 |
|------|------|----------|
| MCP 真实客户端未人工冒烟 | stdio 单测通过，但 Claude Desktop / Cursor 真实接入风险未消除 | v0.1.2 |
| LLM 真实调用未冒烟 | fake client 覆盖，不代表真实 provider 配置可用 | v0.1.2 |
| `package.json` 版本与产品版本线不一致 | 发布和 changelog 容易混乱 | v0.1.2 |
| provider scope filter spike 未完成 | v0.2 跨 appId 召回可能遇到存储过滤性能风险 | v0.1.2 / v0.2.0 前置 |
| 跨 appId 复用未完成 | 核心差异化尚未兑现 | v0.2.0 |
| 完整 Project Workspace 未完成 | 多 source root、增量 evidence、refresh/watch 尚未形成闭环 | v0.2.0 |
| 行为采集 pipeline 缺失 | “越用越懂”目前只能定性，不能量化 | v0.3.0 |
| tree/graph 仍 in-memory | 重启丢失，不能作为长期追溯真源 | v0.4.0 或 v1.0 前 |

---

## 3. 版本路线图

### v0.1.2：真实接入与发布治理收口

定位：把 v0.1.1 已完成的 MCP、LLM、tree 接线从“测试可用”推进到“真实本机可用”，并补齐发布治理。

目标用户价值：

> 开发者配置好本地服务、MCP 客户端和模型后，可以实际调用 memory-autodb 的 5 slot 上下文、lookup 和 observe 能力，并能用 doctor/eval 判断是否接入成功。

范围：

| 模块 | 交付 |
|------|------|
| MCP | 用 Claude Desktop / Cursor 或 MCP inspector 做真实 stdio 冒烟；沉淀配置示例和排障清单 |
| LLM | 用真实 OpenAI-compatible chat endpoint 跑 `summarize` 冒烟；失败时明确降级行为 |
| tree | 验证 observe → build_tree → `lookup_deep` 的真实链路；确认 in-memory 边界 |
| eval | 跑 LongMemEval small / fixture 扩展，证明通用长记忆问答不退化 |
| release governance | 统一产品版本、package 版本、changelog 版本；补发布 checklist |
| coverage | 补 console/tree/server 分支测试，branch coverage 保持 ≥ 70% |

不做：

1. 不做跨 appId 复用。
2. 不做 source roots 完整索引。
3. 不做 tree 持久化。

Release gate：

| 门槛 | 目标 |
|------|------|
| TypeScript | `npx tsc --noEmit` 通过 |
| Unit / integration | `npx vitest run` 全绿 |
| Eval | `memory-autodb-v0.1` 30/30 PASS，`memory-autodb-safety` 40/40 PASS |
| MCP smoke | `listTools` 能看到 11 个工具；`memory_context_fast` / `memory_lookup` 可真实调用 |
| LLM smoke | 真实 provider `summarize` 成功；无配置时 `NullLlmClient` 降级符合预期 |
| Docs | README、CLI、MCP、config、changelog 同步 |

### v0.2.0：跨产品 Working Context + 完整 Project Workspace

定位：兑现核心产品差异化，让同一用户在多个授权 Agent 产品之间复用工作上下文。

目标用户价值：

> 用户在 OpenClaw 类产品 A 中沉淀的偏好、规则、项目背景和资源线索，切换到产品 B 后仍能被安全、可解释地使用。

范围：

| 模块 | 交付 |
|------|------|
| Scope | Owner Scope / Working Context Scope 分离；新增 `WorkingContextResolver` 和跨 appId 查询策略 |
| Repository | provider scope filter 实现和性能 spike；避免全量向量搜索后再业务过滤 |
| Project Workspace | 完整 manifest registry、`sourceRoots[]`、role、include/exclude、source root status |
| CLI | `ltm project add-root/index/refresh/watch/context/lookup` 最小闭环 |
| Scanner | scanner 改造为 source root aware；按 contentHash 和 manifest diff 增量更新 |
| Cross-product demo | 至少两个 `appId` 的本地 demo，验证 profile/rules 复用、task_context 不跨 project |
| Eval | 新增 `memory-autodb-cross-product` 黄金集和 release gate |
| Console | context preview 展示 owner provenance、working context scope 和 filtered reason |

不做：

1. 不做云端团队同步。
2. 不做通用 RAG 查询产品。
3. 不做路由 DSL。
4. 不做 tree/graph 持久化作为 v0.2 必选项。

Release gate：

| 门槛 | 目标 |
|------|------|
| Cross-app recall | cross-product suite 关键记忆召回率 ≥ 80% |
| Scope safety | task_context 不跨 project；private/revoked/stale/conflict 误注入率 = 0 |
| Provider filter | 同 scope 查询不依赖全量扫描；输出性能基准 |
| Project refresh | 文件移动且 contentHash 不变时记忆重建数 = 0 |
| Context fast | 本地 P95 < 250ms |
| Docs | product-positioning、API、CLI、schema、changelog 全部同步 |

### v0.2.1：Project Workspace 质量增强

定位：把 v0.2.0 的跨产品能力稳定成日常可用的本地项目工作区。

范围：

| 模块 | 交付 |
|------|------|
| 多目录 | 多 source root 的增删改、orphan root 告警、路径移动追踪 |
| 资源召回 | resource slot 返回文件/链接/工具位置、摘要和 evidence，不注入长文本 |
| 增量索引 | refresh/watch 的批处理、失败重试、generated_output 默认排除 |
| 备份恢复 | 最小 `ltm backup/restore` 或数据包导出方案 |
| Doctor | 增加 workspace/source root/index freshness 检查 |

Release gate：

| 门槛 | 目标 |
|------|------|
| 多 root | 至少 2 个 source roots 增量 refresh 只处理变化文件 |
| 资源查找 | resource lookup success 达到黄金集门槛 |
| 数据安全 | reset/backup/restore 有确认和回归测试 |
| 文档 | Project Workspace 快速上手和排障文档可直接使用 |

### v0.3.0：越用越懂的行为反馈闭环

定位：把“越用越懂用户”从定性观察升级为可量化能力。

前置条件：

1. v0.2 的跨产品 Working Context 已稳定。
2. Console/Runtime 能记录最小行为信号。
3. 用户可撤销、可解释、可关闭行为采集。

范围：

| 模块 | 交付 |
|------|------|
| FeedbackCollector | 记录上下文是否被使用、被忽略、被用户纠正 |
| RepetitionDetector | 检测用户是否重复说明同类偏好/规则/背景 |
| Preference promotion | 高频有效偏好可建议提升 scope，需用户确认 |
| Metrics | 重复解释减少率、偏好/规则采纳率、纠错率 |
| Eval | 行为黄金集 + LLM judge 或人工标注流程 |

安全边界：

1. 不推断人格标签。
2. 不推断敏感属性。
3. 行为信号默认本地保存。
4. 用户可查看、删除和关闭采集。

Release gate：

| 门槛 | 目标 |
|------|------|
| 可量化 | 重复解释减少率、采纳率、纠错率有可复现计算口径 |
| 安全 | 人格/敏感属性写入为 0 |
| 治理 | Console 可解释某条偏好为什么被提升或未提升 |
| 回归 | v0.1/v0.2 eval suite 不退化 |

### v0.4.0：持久化记忆树与长期追溯

定位：把 in-memory graph/tree baseline 升级为可重启、可追溯、可压缩的长期结构层。

范围：

| 模块 | 交付 |
|------|------|
| Tree provider | Source/Topic/Global Tree 持久化 provider |
| Graph relation | derives_from / supersedes / contradicts / related_to 关系持久化 |
| Lookup deep | vector + BM25 + tree + graph 融合查询 |
| Maintenance | tree seal、summary refresh、stale propagation、retention sweep |
| Console preview | Project overview 和 source/topic/global 预览 |

Release gate：

| 门槛 | 目标 |
|------|------|
| 重启恢复 | 重启后 tree summary 和 graph relation 不丢失 |
| Deep lookup | deep lookup 在复杂追溯黄金集上优于 fast/vector-only baseline |
| 快路径隔离 | `context_fast` 不依赖 deep path，P95 不退化 |
| 成本控制 | LLM 摘要失败可降级，异步任务不阻塞主链路 |

### v1.0：稳定本地优先记忆中间件

定位：面向 OpenClaw 类产品的稳定本地优先 Working Context 中间件。

进入 v1.0 的条件：

1. `context_fast`、`lookup`、`observe_light`、`session_commit` 接口稳定。
2. Project Workspace 可在真实多目录项目中持续增量维护。
3. 跨 appId 复用、scope 安全、候选区治理通过 release gate。
4. MCP、REST、SDK、OpenClaw adapter 文档和 contract test 对齐。
5. 本地数据可备份、恢复、迁移。
6. quick eval、safety suite、cross-product suite 接入 CI。
7. 已明确不做的能力没有重新进入默认范围。

---

## 4. 跨版本工作流

| 工作流 | v0.1.2 | v0.2.0 | v0.2.1 | v0.3.0 | v0.4.0 |
|--------|--------|--------|--------|--------|--------|
| Agent 接入协议 | MCP/LLM 冒烟 | 跨 appId contract | 多 app 稳定性 | 行为反馈信号 | v1 API freeze |
| Working Context | 单 app 稳定 | 跨 app 复用 | scope 细化 | 行为闭环 | 长期结构化 |
| Project Workspace | identity 稳定 | source roots + refresh | 多目录质量 | 行为上下文 | source tree 持久化 |
| Eval | v0.1/safety + LongMemEval small | cross-product suite | resource/project suite | behavior suite | deep lookup suite |
| Console | candidates/overview 稳定 | provenance/context preview | source root health | feedback explain | tree overview |
| Storage | provider spike | scope filter | backup/restore | metrics store | tree/graph provider |

---

## 5. 近期执行顺序

### 第一批：v0.1.2 收口

1. MCP 真实客户端 smoke：记录配置、工具清单、调用结果和失败排障。
2. LLM 真实 provider smoke：验证 `llm` 配置、摘要调用、降级行为。
3. 版本治理：统一 `package.json`、changelog、README 的版本口径。
4. LongMemEval small run：产出本地报告，不纳入硬 gate 前先观察。
5. branch coverage 收口：补 console/tree/server 缺口。
6. 发布 `v0.1.2` changelog。

### 第二批：v0.2.0 先导

1. provider scope filter spike：LanceDB metadata filter、Postgres/Supabase pgvector 对照。
2. ADR：Owner Scope / Working Context Scope 的数据模型和查询策略。
3. `WorkingContextResolver` 原型：request scope、manifest、adapter metadata 三路解析。
4. cross-product 黄金集：至少 30 条，覆盖 profile/rules 复用、task_context 隔离、private/revoked 过滤。
5. 第二 appId demo：证明当前产品定位的核心“啊哈时刻”。

---

## 6. Roadmap 更新规则

1. changelog 新增版本后，必须回看本 roadmap 的“当前基线”和“当前缺口”。
2. 如果某项能力提前完成，移动到“当前已经具备的能力”，不要继续保留在未来版本。
3. 如果某项能力连续两个版本没有推进，要么降级为研究项，要么从 v0.x 范围移除。
4. 每次 roadmap 改动必须同步 `docs/README.md` 和 `docs/03-architecture/README.md` 的入口。
5. 如果 release gate 指标无法通过现有数据证伪，不能写成版本承诺。

