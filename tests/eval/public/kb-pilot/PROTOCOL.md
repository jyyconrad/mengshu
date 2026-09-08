# kb-pilot 评测方案同步说明

> 同步日期：2026-08-31  
> Mengshu 定位：G1 公开知识库检索诊断集  
> 正式计分资格：否（`formalScoreEligible=false`）

本目录同步 `kb-pilot` 使用的 RAG-Multi-Corpus Markdown 语料、问题集和评测流程。同步目标是复现它的测试输入和证据合同，不把上游自报结果直接转换为 Mengshu 的正式 GMS。

## 1. 来源冻结

| 资产 | 冻结版本 |
|------|----------|
| kb-pilot | `waylondev/kb-pilot@a987183b1ff3c983775d4eff14e012baf811f080` |
| kb-pilot 详细 E2E 方案 | 历史提交 `e7265b25c698e8daddd79b7e718cdd17a3f05880` 中的 `tests/e2e_test_prompt.md` |
| RAG-Multi-Corpus | `udayallu/RAG-Multi-Corpus@39071af3f4dd25e59f5c59a6f9b6e8e99cd643b3` |
| 原始问题文件 | `bechmark/bechmark-agentic-references/Dataset categories - queries.csv` |

精确 SHA-256 见 [source-manifest.json](source-manifest.json)。RAG-Multi-Corpus 的 MIT 许可随数据保存在 `data/rag-multi-corpus-v1/LICENSE.rag-multi-corpus`。

## 2. 上游评测流程

kb-pilot 的 E2E 方案可以归纳为五个阶段：

1. 准备知识库：将多格式材料转换为结构良好的 Markdown，保留来源清单。
2. 建立索引：对每篇文档运行 `kb-ingest`，要求无空节点、无 source drift，manifest 与 tree 完整。
3. 盲测问答：只向 `kb-chat` 提供问题，不预读 supporting facts；依次执行 manifest 路由、tree 定位、源文读取、行级引用和自验证。
4. 严格核验：数字与枚举必须完全匹配；引用路径、行号及内容必须支持对应 claim；证据不足时必须拒答；多文档冲突必须显式呈现。
5. 汇总报告：报告正确、部分正确、错误、无效基准、冲突、引用准确率、遗漏、漂移、token/延迟和静默失败。

上游详细方案还要求覆盖：

- 事实、数字、枚举、比较、冲突、负例、跨文档与多轮问题；
- fenced code、BOM、标题跳级、重复标题、超长文档、脏数据和空知识库；
- re-ingest 后的 SHA-256 漂移、结构变化与陈旧摘要检查；
- 模糊提问、用户错误信息、纠正、追问和主题切换；
- 路径、Unicode、符号链接、外部资源和并发一致性边界。

## 3. 已同步评测集

| 项目 | 数量 |
|------|-----:|
| Markdown 文档 | 236 |
| 原始 CSV 行 | 1088 |
| 按 `enterpriseName + query` 去重后的问题 | 907 |
| 证据文件完整、可进入检索评分的问题 | 902 |
| 引用缺失文档的问题 | 5 |

907 题的企业分布为：ZX Bank 323、Cendara University 186、Aventro Motors 221、Velvera Technologies 177。CloudWay-24 的 37 篇 Markdown 作为统一库干扰语料保留，但上游 907 题切片没有 CloudWay 问题。

同步产物：

```text
data/rag-multi-corpus-v1/
├── corpus/datasets/        # 236 篇 Markdown，共享语料
├── source/queries.csv      # 上游 1088 行原始问题
├── queries.jsonl           # 907 题规范化、合并后的问题集
├── corpus-manifest.json    # 每篇文档的 path/bytes/SHA-256
├── manifest.json           # 数据集身份、计数和限制
└── LICENSE.rag-multi-corpus
```

重复问题会合并全部 supporting facts，不静默采用第一行。文件名匹配仅折叠首尾和连续空白；语料中的原始路径与带前导空格的文件名保持不变。

## 4. Mengshu 映射

`rag-multi-corpus.ts` 将单题映射为 `EvalCaseV2`：

- `track="general"`，`benchmarkId="rag-multi-corpus-kb-pilot"`；
- 236 篇 Markdown 全部进入共享 `memoryStream`，不使用仅含正例的 oracle corpus；
- supporting fact 的文件映射为 `requiredEvidenceRefs`；
- 上游默认 retrieval cutoff 保留为 `topK=6`；
- 问题类型映射为 capability；
- 原始数据没有 reference answer，因此 `gold.answer` 不伪造，`answerGoldStatus="absent"`；
- 缺失证据文件的 case fail-closed，不进入检索得分。

该集合当前只可报告 evidence retrieval、路由、引用、延迟和 token 诊断。要进入正式 GMS，至少还需补齐：版本化 answer scorer、独立人类校准、完整 baseline/candidate paired run 和固定 reader/judge/prompt。

## 5. 与上游报告的差异

kb-pilot 当前结论报告声明 907 题中 899 correct、7 invalid、1 conflict，严格正确率 99.1%。这些数字作为上游声明记录，但不作为本项目基线，原因如下：

1. 上游仓库未提交 907 题逐题输出和完整 adjudication ledger，无法逐条复核 899 个 correct。
2. 答案由人工按 supporting facts 判定，没有版本化 scorer，也没有独立 judge 校准记录。
3. CSV 提供 supporting facts，但没有 reference answer。
4. 原始数据中实际有 5 个去重问题引用缺失的 `Account Close Guide.md`；上游报告写成 4 个，二者不一致。
5. 上游另有 135 题自出题、自答、自判的深入测试，其中前四轮逐题记录未持久化，不能重建为完整评测集。

因此本项目保留 907 题原始分布，同时将 5 个缺失证据题显式标记为 `invalid-missing-document`。

## 6. 刷新与验证

从固定 revision 的 RAG-Multi-Corpus checkout 刷新数据：

```bash
npm run eval:rag-multi:sync -- --source /absolute/path/to/RAG-Multi-Corpus --force
```

运行完整性与 adapter 测试：

```bash
npx vitest run tests/eval/public/kb-pilot/dataset-integrity.test.ts \
  tests/eval/public/adapters/rag-multi-corpus.test.ts
```

同步脚本会核对 Git revision、问题 CSV、LICENSE、文档数和问题数；任一身份漂移都会失败，不会用新版本覆盖现有 v1。
