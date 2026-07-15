# AGENTS.md

This file provides guidance to Codex and AI coding assistants when working with code in this repository.

## 项目概述

mengshu（梦枢）是面向多产品 Agent Runtime 的本地优先记忆中间件。当前版本 v1.0.6。D-01~D-23 算法规格和模块资产覆盖较广，但真实运行主链尚未全量集成；当前状态与升级顺序见 `.memory-docs/original-docs/03-architecture/mengshu-local-runtime-audit-and-upgrade-plan-2026-07.md`。

核心能力：LLM 结构化提取 → 11 闸门 validator → 4 套评分 → 语义去重 → L0-L3 树摘要 → 6 因子召回 → 5 槽位注入。

多适配器接入：OpenClaw 插件 / MCP Server / REST API / Web Console / CLI（`ms` 命令组）。

**算法层单一事实来源**：`docs/design/memory-system-unified-design.md`（D-01~D-23 决策）。

**详细开发文档**：参见 `AGENTS.local.md`（包含代理编排、核心目录、评分体系等）。

## 常用命令

```bash
# 开发
npm test                        # vitest run；默认离线，provider 凭据不会自动启用 live
npm run test:live               # 仅显式 MENGSHU_RUN_LIVE_TESTS=1 的网络测试
npx tsc --noEmit                # 类型检查
npx vitest run core/            # 运行单目录测试
npm run eval:quick              # 快速 golden set 评估

# CLI 命令组（ms）
ms init                         # 交互式初始化配置向导
ms doctor                       # 配置/连接诊断
ms why <记忆ID>                  # 评分明细追溯
ms recall "查询" --explain       # 召回 + importance breakdown
ms forget <记忆ID>               # 撤回/归档/纠错
ms project ingest-history --from codex --dry-run  # 预览 agent history 导入
ms project                      # 项目管理
ms stats / ms search / ms scan / ms serve / ms mcp
```

## 核心架构

### 铁律

1. **"LLM 可以建议，不可单独裁决"**：所有入库经 `lifecycle/candidate-validator.ts` 11 闸门
2. **"四套评分分工明确"**：valueScore（准入）/ importance（召回排序）/ confidence（去重治理）/ hotness（树路由）
3. **"单一事实来源"**：权重在 `packages/core/src/scoring/scoring-weights.ts`，实体类型在 `graph/schema.ts`

### 核心目录

| 目录 | 职责 | 关键文件 |
|------|------|---------|
| `core/` | 根层旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/domain/` | 产品无关基础类型、scope、服务契约、评分与语义协议 | `types.ts`、`scope.ts`、`scope-policy.ts`、`service-types.ts`、`recall-scoring.ts`、`legacy-mapping.ts`、`status-mapping.ts`、`semantic-types.ts`、`semantic-type-mapper.ts`、`profile-layer.ts`、`recall-filter.ts` |
| `packages/core/src/service/` | 核心服务实现 | `memory-service.ts` |
| `packages/core/src/context/` | 5 槽位上下文构建与缓存 | `slot-context-builder.ts`、`slot-prompt-packer.ts`、`slot-snapshot.ts` |
| `packages/core/src/runtime/` | 全局路径与项目 registry | `paths.ts`、`registry.ts` |
| `packages/core/src/scoring/` | 评分公式与文本工具 | `value-score.ts`、`importance-score.ts`、`confidence-score.ts`、`scoring-weights.ts`、`hash-utils.ts`、`text-splitter.ts` |
| `packages/core/src/runtime/llm/` | LLM / embedding runtime 与抽取词表 | `llm-client.ts`、`embeddings.ts`、`extraction-rules.ts` |
| `processing/` | 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/retrieval/` | 召回编排、上下文打包、prompt 安全 | `orchestrator.ts`、`fusion.ts`、`context-packer.ts`、`prompt-safety.ts` |
| `retrieval/` | 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/db/` | LanceDB/Supabase/Postgres provider contract 与 factory | `types.ts`、`factory.ts`、`providers/` |
| `db/` | 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/storage/` | 存储 adapter、repository 和文本索引 | `legacy-database-adapter.ts`、`repositories/`、`indexes/` |
| `storage/` | 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/lifecycle/` | 候选区、validator、去重、遗忘、skill 聚合 | `candidate-validator.ts`、`semantic-dedup.ts`、`forget-handler.ts`、`skill-candidate-aggregator.ts` |
| `lifecycle/` | lifecycle 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/graph/` | 知识图谱、entity 三级匹配 | `llm-extractor.ts`、`entity-resolver.ts`、`centrality-calculator.ts`、`schema.ts` |
| `graph/` | graph 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/tree/` | L0-L3 树摘要、leaf 路由 | `seal.ts`、`leaf-routing.ts`、`faithfulness.ts` |
| `tree/` | tree 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/ingest/` | 入库管道、chunker、canonicalize、scanner、agent-history 协议 | `pipeline.ts`、`chunker.ts`、`canonicalize.ts`、`scanner/`、`agent-history/` |
| `ingest/`、`scanner/` | ingest/scanner 旧路径兼容 facade | `*.ts` re-export |
| `packages/core/src/feedback/` | 反馈闭环 | `collector.ts`、`in-memory-store.ts` |
| `feedback/` | 反馈闭环旧路径兼容层 | `*.ts` re-export |
| `packages/core/src/routing/` | 路由规则引擎 | `index.ts`、`rules.ts` |
| `routing/` | 路由规则旧路径兼容层 | `*.ts` re-export |
| `plugins/openclaw/` | OpenClaw memory slot 插件包 | `src/index.ts`、`src/register.ts`、`src/tools.ts`、`src/hooks.ts`、`src/context-fast.ts`、`src/scope.ts`、`src/manifest.ts`、`src/cli/`、`openclaw.plugin.json` |
| `plugins/codex/` | Codex 插件包（MCP + skill + source adapter） | `.codex-plugin/plugin.json`、`.mcp.json`、`mcp/server.mjs`、`skills/mengshu-memory/SKILL.md`、`sources/adapter.ts` |
| `plugins/claude-code/` | Claude Code source adapter 插件边界 | `sources/adapter.ts` |
| `adapters/openclaw/` | OpenClaw 旧路径兼容层 | `scope.ts`、`manifest.ts`、`cli-*.ts` re-export |
| `adapters/sources/` | Agent history source adapter 旧路径兼容层 | `index.ts`、`*/adapter.ts` re-export |
| `packages/core/src/ingest/sources/` | 通用 source 解析能力 | `jsonl-parser.ts` |
| `packages/mcp/src/` | MCP Server 适配 | `server.ts`、`stdio-server.ts`、`tools.ts` |
| `packages/api/src/` | REST / SDK / CLI / agent fast-path | `rest/router.ts`、`sdk/client.ts`、`cli/ms.ts`、`agent-fast-path/index.ts` |
| `packages/ui/src/console/` | Console 聚合 API | `api.ts`、`types.ts` |
| `packages/ui/src/web/` | Web Console 静态前端 | `src/`、`index.html` |
| `tests/` | 跨包 contract / smoke / integration / eval 测试 | `contract/`、`smoke/`、`eval/`、`fixtures/` |

### 4 套评分体系（SCORING_WEIGHTS_V1）

| 评分 | 用途 | 消费方 | 维度 |
|------|------|--------|------|
| **valueScore** | 准入决策（drop / low / pending / active） | `packages/core/src/lifecycle/admission-decision.ts` | 8 维（explicitness/durability/actionability/specificity/evidence/scopeFit/novelty/riskPenalty=-0.15） |
| **importance** | 召回排序 + score breakdown | `packages/core/src/domain/recall-scoring.ts` | 4 项（salience_llm 0.45 + sourceAuthority 0.20 + explicitnessBonus 0.20 + typePrior 0.15） |
| **confidence** | 去重治理 + 证据晋升 | `packages/core/src/scoring/confidence-score.ts` | 多证据贝叶斯累积 |
| **hotness** | topic tree 路由 + 归档 | `packages/core/src/graph/query-hits-tracker.ts` | 5 项（mention + source + recency + centrality + queryHits） |

### 决策阈值（D-01~D-03）

- **D-01 riskPenalty**：-0.15（`packages/core/src/scoring/scoring-weights.ts:32`）
- **D-02 Admission 阈值带**：drop<0.40 / low 0.40-0.55 / pending 0.55-0.88 / active≥0.88
- **D-03 Leaf 分级路由**：0.55-0.70 仅进 source tree，≥0.70 进 topic/global

## 配置

三层加载：`~/.mengshu/config.json` → `$PROJECT/.mengshu/config.json` → 环境变量覆盖

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
  "dbType": "postgres",
  "postgres": {
    "host": "${PG_HOST}",
    "port": 5432,
    "database": "${PG_DATABASE}",
    "user": "${PG_USER}",
    "password": "${PG_PASSWORD}",
    "ssl": false
  },
  "autoCapture": true,
  "autoRecall": true
}
```

## 开发注意事项

- TypeScript 严格模式，`tsc --noEmit` 必须 exit 0
- 测试覆盖率目标 80%+，新功能必须附带单元测试
- 评分函数必须**纯函数**（同入同出，禁止内部发起 LLM 调用）
- LLM 调用 temperature 一律 0.0（确定性提取）
- LLM 默认超时 30s（`DEFAULT_LLM_TIMEOUT_MS`）
- SQL 表名经运行时白名单校验（`packages/core/src/db/providers/supabase.ts`）
- 环境变量名经 `/^[A-Z_][A-Z0-9_]*$/` 白名单
- 记忆内容注入上下文时自动 HTML 转义（`packages/core/src/retrieval/prompt-safety.ts`）
- 修改阈值/权重/prompt 后必须跑全量 golden set（6 套 eval suite）
