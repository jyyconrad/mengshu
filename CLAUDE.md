# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

mengshu（梦枢）是面向多产品 Agent Runtime 的本地优先记忆中间件。当前版本 v1.0.2，P0-P4 算法层已全量交付。

核心能力：LLM 结构化提取 → 11 闸门 validator → 4 套评分 → 语义去重 → L0-L3 树摘要 → 6 因子召回 → 5 槽位注入。

多适配器接入：OpenClaw 插件 / MCP Server / REST API / Web Console / CLI（`ms` 命令组）。

**算法层单一事实来源**：`docs/design/memory-system-unified-design.md`（D-01~D-23 决策）。

**详细开发文档**：参见 `CLAUDE.local.md`（包含内部文档导航）。

## 常用命令

```bash
# 开发
npm test                        # vitest run（100 文件 / 1101 测试）
npx tsc --noEmit                # 类型检查
npx vitest run core/            # 运行单目录测试
npm run eval:quick              # 快速 golden set 评估

# CLI 命令组（ms）
ms init                         # 交互式初始化配置向导
ms doctor                       # 配置/连接诊断
ms why <记忆ID>                  # 评分明细追溯
ms recall "查询" --explain       # 召回 + importance breakdown
ms forget <记忆ID>               # 撤回/归档/纠错
ms import <path>                # 导入 agent history
ms project                      # 项目管理
ms stats / ms search / ms scan / ms serve / ms mcp
```

## 核心架构（v1.0.2 P0-P4）

### 铁律

1. **"LLM 可以建议，不可单独裁决"**：所有入库经 `lifecycle/candidate-validator.ts` 11 闸门
2. **"四套评分分工明确"**：valueScore（准入）/ importance（召回排序）/ confidence（去重治理）/ hotness（树路由）
3. **"单一事实来源"**：权重在 `processing/scoring-weights.ts`，实体类型在 `graph/schema.ts`

### 核心目录

| 目录 | 职责 | 关键文件 |
|------|------|---------|
| `core/` | 领域类型、评分集成、profile 分层、scope 隔离 | `recall-scoring.ts`、`profile-layer.ts`、`types.ts`、`scope.ts`、`memory-service.ts` |
| `processing/` | 评分公式、LLM 客户端、extraction rules | `value-score.ts`、`importance-score.ts`、`confidence-score.ts`、`scoring-weights.ts`、`llm-client.ts`、`extraction-rules.ts` |
| `lifecycle/` | 候选区、validator、去重、遗忘、晋升、skill 聚合 | `candidate-validator.ts`、`semantic-dedup.ts`、`forget-handler.ts`、`candidate-promotion.ts`、`skill-candidate-aggregator.ts`、`extract-candidate-handler.ts` |
| `graph/` | 知识图谱、entity 三级匹配、LLM 抽取 | `llm-extractor.ts`、`entity-resolver.ts`、`centrality-calculator.ts`、`schema.ts`、`extract-graph-handler.ts` |
| `tree/` | L0-L3 树摘要、leaf 路由、buffer | `seal.ts`、`leaf-routing.ts`、`faithfulness.ts`、`buffer.ts`、`build-tree-handler.ts` |
| `retrieval/` | 召回编排、融合排序、prompt 注入防护、上下文打包 | `orchestrator.ts`、`fusion.ts`、`prompt-safety.ts`、`context-packer.ts` |
| `ingest/` | 摄入管线、chunker、agent-history 导入 | `pipeline.ts`、`chunker.ts`、`agent-history/redaction.ts` |
| `routing/` | 路由规则引擎 | `index.ts`、`rules.ts` |
| `storage/` | 存储抽象层、索引 | `legacy-database-adapter.ts`、`repositories/`、`indexes/` |
| `feedback/` | 反馈闭环 | `collector.ts`、`in-memory-store.ts` |
| `adapters/openclaw/` | OpenClaw 插件适配 + CLI 命令 | `hooks.ts`、`tools.ts`、`cli-why.ts`、`cli-recall.ts`、`cli-forget.ts`、`cli-doctor.ts`、`cli-import.ts`、`cli-setup.ts` |
| `adapters/mcp/` | MCP Server 适配 | `server.ts`、`stdio-server.ts`、`tools.ts` |
| `api/` | REST API + agent fast path | `agent-fast-path.ts`、`rest/` |
| `server/` | 后台 daemon + worker | `daemon.ts`、`workers.ts`、`health.ts` |
| `console/` | Web Console API | `api.ts`、`web/` |
| `eval/` | Golden set 评估框架 | `runners/`、`goldens/`、`fixtures/` |
| `sdk/` | JS SDK 封装 | `js/` |

### 4 套评分体系（SCORING_WEIGHTS_V1）

| 评分 | 用途 | 消费方 | 维度 |
|------|------|--------|------|
| **valueScore** | 准入决策（drop / low / pending / active） | `lifecycle/admission-decision.ts` | 8 维（explicitness/durability/actionability/specificity/evidence/scopeFit/novelty/riskPenalty=-0.15） |
| **importance** | 召回排序 + score breakdown | `core/recall-scoring.ts` | 4 项（salience_llm 0.45 + sourceAuthority 0.20 + explicitnessBonus 0.20 + typePrior 0.15） |
| **confidence** | 去重治理 + 证据晋升 | `processing/confidence-score.ts` | 多证据贝叶斯累积 |
| **hotness** | topic tree 路由 + 归档 | `graph/query-hits-tracker.ts` | 5 项（mention + source + recency + centrality + queryHits） |

### 决策阈值（D-01~D-03）

- **D-01 riskPenalty**：-0.15（`processing/scoring-weights.ts:32`）
- **D-02 Admission 阈值带**：drop<0.40 / low 0.40-0.55 / pending 0.55-0.88 / active≥0.88
- **D-03 Leaf 分级路由**：0.55-0.70 仅进 source tree，≥0.70 进 topic/global

## 配置

三层加载（P1）：`~/.mengshu/config.json` → `$PROJECT/.mengshu/config.json` → 环境变量覆盖

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "model": "text-embedding-3-small"
  },
  "llm": {
    "apiKey": "${OPENAI_API_KEY}",
    "baseURL": "https://api.openai.com/v1",
    "extractionModel": "gpt-4o-mini",
    "summarizationModel": "gpt-4o-mini",
    "reasoningModel": "gpt-4o"
  },
  "dbType": "lancedb",
  "dbPath": "~/.mengshu/memory/lancedb",
  "autoCapture": true,
  "autoRecall": true
}
```

## 核心概念

1. **5 问题语义协议**（`MemorySemanticType`）
   - profile / task_context / rules / experience / resource
   - Agent 执行前必须回答的 5 个问题：为谁工作？做什么？不能做什么？之前怎么做？有什么资源？

2. **Profile 三层分层**（D-04/D-13）
   - project → app → global，召回优先级由近及远
   - 避免项目偏好污染全局画像

3. **候选区生命周期**（D-19）
   - 四套状态分离：AdmissionRoute / CandidateStatus / MemoryLifecycleStatus / UserVisibleStatus
   - 候选区 TTL 30d（low_priority），超时自动清理

4. **LLM 结构化提取**
   - `extractStructured` 支持 JSON schema 约束输出
   - 图谱抽取：entity + relation + attribute 三元组
   - 抽取结果经 `extraction-validator.ts` 校验后入图

5. **Scope 隔离**
   - 6 档 targetScope：message / turn / session / project / app / global
   - 运行时按 scope 策略过滤，防止跨域泄漏

6. **Eval 评估体系**
   - Golden set 驱动，覆盖提取/评分/召回/去重/树摘要/注入 6 类场景
   - `npm run eval:quick` 快速验证，CI 可集成

## 开发注意事项

- TypeScript 严格模式，`tsc --noEmit` 必须 exit 0
- 测试覆盖率目标 80%+，新功能必须附带单元测试
- 评分函数必须**纯函数**（同入同出，禁止内部发起 LLM 调用）
- LLM 调用 temperature 一律 0.0（确定性提取）
- LLM 默认超时 30s（`DEFAULT_LLM_TIMEOUT_MS`）
- LLM 结构化抽取使用 `llm-client.ts` 的 `extractStructured`（JSON schema 约束）
- SQL 表名经运行时白名单校验（`db/providers/supabase.ts`）
- 环境变量名经 `/^[A-Z_][A-Z0-9_]*$/` 白名单
- 记忆内容注入上下文时自动 HTML 转义（`retrieval/prompt-safety.ts`）
- agent-history 导入前自动 redaction（`ingest/agent-history/redaction.ts`）
- 路径解析统一通过 `core/paths.ts`，不允许各模块自行拼路径
- 修改阈值/权重/prompt 后必须跑全量 golden set（`npm run eval:quick` 或 6 套 eval suite）
- 配置缺失时给出友好错误信息，支持 `ms doctor` 自检
