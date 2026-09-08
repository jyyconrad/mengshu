# Mengshu 评测体系

> 协议版本：v2（G/P/Q 三轨）
> 代码快照：2026-08-31
> 设计真源：`.memory-docs/original-docs/07-test/memory-evaluation-plan.md`

本目录承载 Mengshu 的效果评测、工程质量门禁、数据冻结、报告完整性和回归比较。三条轨道回答不同问题，禁止互相替代：

| 轨道 | 产物 | 回答的问题 | 当前状态 |
|------|------|------------|----------|
| G - General | GMS + 分 benchmark/capability 报告 | 通用长期记忆效果是否不回归 | G0 runner 已有；当前离线 lexical 仅为 diagnostic |
| P - Private | PMS + cohort/capability/slice 报告 | Mengshu 真实数据分布上是否不回归 | `private-v1` collecting，目标 500 例 |
| Q - Quality | pass/block | contract、安全、算法和 runtime 工程质量是否达标 | 12 套 deterministic suite，358 case |

`npm run eval:quick` 只运行 Q 轨。Q 轨通过不能表述为 GMS/PMS 提升，也不能单独得出版本可发布结论。

## 目录

```text
tests/eval/
├── goldens/                 # Q 轨 deterministic JSONL + manifest v2
├── runtime-e2e/             # Q 轨生产运行合同 fixture
├── public/                  # G 轨公开 benchmark registry、adapter、scorer bridge、kb-pilot 同步集
├── private/                 # P 轨 cohort registry、manifest、脱敏构建工具
├── selfbuilt/               # 自建 diagnostic 数据与 runner（SBS）
├── runners/                 # 三轨协议、quick/general/compare/gate runner
├── adapters/                # legacy/兼容 adapter
├── fixtures/                # 小型单测 fixture，不等于正式数据集
└── results/                 # 本地运行产物，默认不作为源码提交
```

## Q 轨：工程质量门禁

`goldens/manifest.json` 使用 schema v2。每个 suite 必须声明：

- `track: "quality"`
- `datasetVersion`
- runner、指标、case 数、字节数和 SHA-256
- suite 级 gate

当前登记：

| Suite | Case | 主要合同 |
|-------|-----:|----------|
| `mengshu-v0.1` | 30 | 5 槽位召回与 scope |
| `mengshu-safety` | 40 | wrong injection、敏感与转义 |
| `mengshu-extraction` | 100 | type/evidence/over-capture |
| `mengshu-dedup` | 80 | lexical/duplicate/false merge |
| `mengshu-recall-explain` | 60 | 6 因子解释 |
| `mengshu-conflict` | 10 | rules 冲突 |
| `mengshu-tree-summary` | 8 | summary faithfulness |
| `mengshu-skill-candidate` | 8 | 候选而非可执行 skill |
| `mengshu-progressive-disclosure` | 5 | R0-R4 导航 |
| `mengshu-asset-promotion` | 5 | Asset 晋升 |
| `mengshu-slot-loadout` | 6 | Loadout 槽位与预算 |
| `mengshu-import-compat` | 6 | SHA-256/legacy MD5 与 project-workspace 作用域 |

运行全部或指定 suite：

```bash
npm run eval:quick
npm run eval:quick -- mengshu-safety
```

报告中的关键字段：

- `qualityGatePassed`：Q 轨 suite gate 是否全部通过。
- `releaseGatePassed`：兼容字段，当前等同 Q 轨，不能解释为版本发布结论。
- `versionReleaseGatePassed`：quick runner 固定 fail-closed，因为它没有运行正式 G/P。
- `productionReleaseGatePassed`：只在满足 production eligibility 的 Q 轨组合上有意义，不替代 live production test。

Vitest 回归：

```bash
npx vitest run tests/eval/runners/quick-eval.test.ts tests/eval/runners/quick-eval-cli.test.ts tests/eval/runners/evaluation-protocol.test.ts tests/eval/runners/eval-manifest.test.ts
```

## G 轨：公开通用评测

`public/registry.json` 固定公开数据仓库 revision、文件 SHA-256、license SHA-256 和 scorer 状态。当前 registry 覆盖 LongMemEval cleaned、LoCoMo、MemoryAgentBench，以及按 kb-pilot 协议同步的 RAG-Multi-Corpus G1 diagnostic。

G0 使用冻结后的 `EvalCaseV2` 数据验证 runner、检索 diagnostic、对照组与两轮稳定性：

```bash
# 先按 public/tools/prepare-g0.ts 冻结数据到 ~/.mengshu/eval-datasets/public/frozen/g0-v1
npm run eval:g0:round1
npm run eval:g0:round2
npm run eval:g0:finalize
```

两轮报告默认写入：

```text
~/.mengshu/eval-results/g0-v1/
├── round-1/report.json
├── round-2/report.json
├── stability-comparison.json
├── no-memory-ablation.json
├── efficiency.json
└── release-gate.json
```

当前 `GeneralEvaluationReport` 明确写入：

- `scoreAuthority="diagnostic"`
- `officialAnswerScoring="not_run"`
- `formalScoreEligible=false`

因此 G0 的 lexical score 只用于开发诊断。在 official answer scorer、required controls 和 paired baseline/candidate 未齐备前，不得称为正式 GMS。

### kb-pilot / RAG-Multi-Corpus

`public/kb-pilot/data/rag-multi-corpus-v1/` 保存上游实际使用的 236 篇 Markdown、1088 行原始 CSV 和去重后的 907 题。902 题证据文件完整；5 题引用缺失的 `Account Close Guide.md`，保留用于审计但不进入评分。

```bash
npm run eval:rag-multi:sync -- --source /absolute/path/to/RAG-Multi-Corpus --force
npx vitest run tests/eval/public/kb-pilot/dataset-integrity.test.ts tests/eval/public/adapters/rag-multi-corpus.test.ts
```

完整协议、上游结果边界和不可复现项见 [public/kb-pilot/PROTOCOL.md](public/kb-pilot/PROTOCOL.md)。该数据集没有 reference answer 和版本化 scorer，当前 `formalScoreEligible=false`，不能把 kb-pilot 自报的 99.1% 直接当作 Mengshu 基线。

## P 轨：私有冻结集

`private/cohort-registry.json` 固定 `mengshu-private-v1` 的治理合同：

| Cohort | 配额 |
|--------|-----:|
| governed canonical | 200 |
| fresh holdout | 150 |
| legacy paired | 100 |
| adversarial | 50 |

总目标为 500 例，要求双人独立标注且 Cohen's Kappa 不低于 0.85。构建器只接受通过治理状态、隐私扫描、配额和 schema 校验的输入：

```bash
npm run eval:private:prepare
```

当前 `private-v1.collecting.json` 仍为 collecting 状态。P-FRESH 少于 150、独立标注未完成或总数不足时，release gate 必须保持 blocked。

## SBS：自建诊断集

`selfbuilt/data/mengshu-selfbuilt-v1/` 包含 360 例确定性自建数据，覆盖 6 个能力族 × 6 个场景；72 例 dev、288 例 test。它不读取生产私有正文，也不依赖公开 benchmark。

```bash
npm run eval:selfbuilt:prepare
npm run eval:selfbuilt:round1
npm run eval:selfbuilt:round2
npm run eval:selfbuilt:finalize
```

SBS 的 `formalReleaseEligible=false`。它是开发诊断分，不是 G/P/Q 之外的第四条发布轨，也不能替代 GMS、PMS 或 P-FRESH。

## 版本发布门禁

`runners/gate-runner.ts` 采用 fail-closed 合同。版本结论为 pass 需要同时满足：

1. Q 轨通过。
2. 数据与报告完整性通过。
3. G 轨具有 formal eligible report，且 baseline/candidate paired gate 通过。
4. P 轨 paired gate 通过。
5. P-FRESH 至少 150 例。

缺少任一输入都生成 blocker，不使用其它轨道的分数补齐。live production gate 还需单独显式运行：

```bash
MENGSHU_RUN_LIVE_TESTS=1 npm run test:production-gate
```

## 可复现性与完整性

正式运行记录 `EvalRunSpec`，包括 candidate/baseline version、dataset hash、governance snapshot、配置指纹、数据库 schema、模型、prompt hash、随机种子、token budget、topK 和 cache mode。RunSpec、dataset 与 report 都有 SHA-256 身份。

paired comparison 要求：

- baseline/candidate case id 完全一致；
- capability 不得在两轮间漂移；
- 使用固定随机种子 bootstrap；
- 总体和每个 capability 都检查回归容忍线；
- cold/warm 两轮不得改动 dataset、protocol 或 worktree 身份。

## 新增或修改 Q 轨 Suite

1. 在 `goldens/` 增加或修改 JSONL。
2. 更新 `goldens/manifest.json` 的 `track`、`datasetVersion`、case 数、bytes、SHA-256、metrics 与 gate。
3. 在 runner adapter 中实现确定性判定，不把 LLM 输出作为最终 gate。
4. 运行指定 suite 与 manifest/integrity 测试。
5. 阈值、权重或 prompt 变化时运行全部 Q 轨，并按需要运行 G/P paired evaluation。

计算 fixture 身份：

```bash
wc -c tests/eval/goldens/*.jsonl
shasum -a 256 tests/eval/goldens/*.jsonl
```

人工标注规范见 [ANNOTATION_GUIDE.md](ANNOTATION_GUIDE.md)，扩充计划见 [EXPANSION_PLAN.md](EXPANSION_PLAN.md)。

**最后更新**：2026-08-31
