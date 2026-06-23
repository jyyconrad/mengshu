# OpenClaw 历史数据评测集方案

> 状态：方案稿（v0.5，过程数据可追溯整改版）
> 目标版本：v0.5
> 关联目录：`tests/eval/`
> 数据原则：原始 OpenClaw 历史数据只保留在本机，仓库只提交脱敏 fixture 与 golden expected。
> v0.5 整改要点（在 v0.4-rev1 基础上）：
>
> 1. 新增 [验证目的与最低交付物](#验证目的与最低交付物新增) 章节：明确真实验证必须证明 QA 问答、召回测试、记忆链路三类能力，禁止仅交付 DryRun 元数据。
> 2. 新增 [过程数据保存规约](#过程数据保存规约新增) 章节：每阶段必须保存 LLM / embedding 请求响应 trace、提取候选、validator 决策、入库记忆、召回排序明细、QA 答案与槽位注入，杜绝"只有结论没有过程"。
> 3. 扩展 [验证产物归档结构](#验证产物归档结构新增)：`~/.mengshu/eval-corpus/openclaw/validation-runs/<timestamp>/` 下增加 `phase-2-ingest`、`phase-3-recall`、`phase-4-qa`、`phase-5-analysis` 四个子目录，定义每个 jsonl 文件的字段集。
> 4. 改写 [实施步骤](#实施步骤) 中阶段 1-4 的验收条件：必须先有"完整过程数据"，再谈指标达标；阶段 1 不再止步于 DryRun 元数据。
> 5. 修订 [成功标准](#成功标准)：增加"任意一条 case 都能从过程数据完整回放 ingest → recall → answer 链路"为硬性条件。
>
> v0.4-rev1 基础整改保留：补齐 PII 脱敏规则；明确 evidence span 在脱敏后的偏移基准；为 GoldenCase 扩展字段定义 runner 集成路径；在阶段 0 与阶段 1 之间新增"阶段 0.5 runner 骨架扩展"；统一指标命名与定义；为 smoke "必须 100%" 类指标改为 per-case 硬性条件；明确 stale / context_precision / context_recall 算法。

## 背景

mengshu 当前已有 `mengshu-extraction`、`mengshu-dedup`、`mengshu-recall-explain`、`mengshu-tree-summary` 等 golden suite，但这些样本主要是设计驱动和人工构造。它们适合验证算法边界，却不足以覆盖真实 Agent Runtime 历史中的噪声、过期状态、跨 Agent 协作、长上下文压缩、Skill 文档干扰和证据链断裂。

OpenClaw 历史数据包含真实的会话状态、工作缓冲、学习记录、Agent 协作和插件配置。用这批数据构建评测集，可以验证 mengshu 是稳定的记忆系统，而不是简单的向量搜索包装。

本评测集不仅验证“有没有召回”，还要验证返回内容的正确性、可读性、结构性、树层级关系和 claim 证据忠实度。

## 目标

新增 `mengshu-openclaw-history` suite，用 OpenClaw 历史数据验证以下能力：

1. 从真实历史文本中提取长期记忆，包括偏好、规则、任务状态、经验和资源。
2. 在召回时区分真实历史记忆和 Skill/README 等背景文档噪声。
3. 正确处理 `appId`、`agentId`、`projectId`、`namespace` 等 scope。
4. 验证 `roomId`、`threadId`、`sessionId`、`messageId` 只作为 provenance/scope 标识，不被提升为 memory body 或 topic tree key。
5. 在 5 槽位上下文中把内容放入合理 slot，避免历史盘点类问题被误路由为 `resource`。
6. 对过期任务状态、敏感内容、prompt 注入内容做正确过滤、降权或时态标注。
7. 为记忆树摘要提供带 evidence 的真实 leaf 样本，并验证树层级、从属关系和连续关系。
8. 验证高精度 claim 提取：区分事实、推断、建议、规则/法规要求，并验证 evidence span、适用范围、日期、冲突和时效。
9. 评估返回结果的正确性、可读性和结构性，使上下文既能被程序稳定解析，也能被 Agent/人类快速理解。

## 评测对象分层

| 层级 | 评测对象 | 核心问题 | 主要指标 |
|------|----------|----------|----------|
| 抽取与准入层 | 从历史片段生成 candidate/memory | 该抽的是否抽出，不该抽的是否拒绝 | extraction_precision、claim_type_accuracy、identifier_non_promotion_rate |
| 检索与上下文层 | `memory_recall` / `memory_context_fast` | 该召回的是否进入 top-k/slot，不相关内容是否过滤 | requiredMemoryIds@k、context_precision、slot_routing_accuracy、scope_match_accuracy |
| 记忆树/图谱关系层 | source/topic/global tree、关系边 | 层级、从属、更新、覆盖和证据路径是否正确 | tree_relation_accuracy、topic_key_normalization_accuracy、evidence_path_coverage |
| 结构与可读性层 | 返回给 Agent 的结构化上下文 | 是否字段完整、可解析、可扫读、低噪声 | schema_valid_rate、parse_success_rate、readability_score、noise_density |
| 答案使用层 | 基于记忆回答用户问题 | 答案是否忠实证据、标注历史状态、避免无依据断言 | claim_supported_rate、unsupported_claim_rate、temporal_qualification_rate |

第一阶段以确定性 grader 覆盖抽取、检索、上下文和结构层；答案使用层先做报告型指标，不直接阻塞 release gate。

## 验证目的与最低交付物（新增）

> 整改背景：v0.4 实施过程中发现，仅在 DryRun 阶段保存 `report.json / statistics.json / redaction-samples.jsonl` 三类元数据无法证明系统在"真实问答 / 召回 / 记忆链路"上是有效的——所有指标都建立在元数据统计之上，没有可回放的 ingest → recall → answer 过程。本节固化"真实验证"的最低交付物，禁止以"DryRun 通过 = 验证通过"作为结论。

### 验证必须证明的三类能力

| 能力 | 必答问题 | 最低过程证据 |
|------|---------|------------|
| **QA 问答能力** | 给定一条真实历史，系统能否回答用户基于这条历史的提问？答案是否引用了正确的 evidence？ | `phase-4-qa/qa-trace.jsonl`：每条 case 必须包含 `query`、`injectedSlots`、`llmRequest`、`llmResponse`、`citedSpanIds`、`grader.verdict` |
| **召回能力** | 同一 query 在真实记忆库中能否把 `requiredMemoryIds` 召回到 top-k？误注入是否被过滤？ | `phase-3-recall/recall-trace.jsonl`：每条 case 必须包含 `query`、`embeddingVector` 摘要、`candidates[]`（含 importanceBreakdown）、`topK`、`forbiddenInjected[]` |
| **记忆链路完整性** | 从原始 OpenClaw 文本到入库记忆，每一步的输入输出都可回放吗？ | `phase-2-ingest/ingest-trace.jsonl`：每条 case 必须包含 `sourceSnippet`（脱敏后）、`extractionLLMRequest`、`extractionLLMResponse`、`candidates[]`、`validatorDecisions[]`、`storedMemories[]` |

### 最低交付物（任一缺失即视为验证未完成）

阶段 1（smoke 34 条）至少产出：

1. **34 条 ingest trace**：覆盖样本分层 10 个类别，每条都能从 `sourceSnippet` 回放出 `storedMemories`。
2. **34 条 recall trace**：每条 case 至少 1 条 query，记录 top-k 排序与 importance 分解。
3. **34 条 QA trace**：每条 case 至少 1 轮问答，记录 LLM 请求体、响应体、citation。
4. **1 份 analysis 报告**：`phase-5-analysis/failures-analysis.json` 列出所有失败 case 的根因（提取漏 / 召回漏 / 注入污染 / 答案不忠实）。
5. **1 份 performance 报告**：`phase-5-analysis/performance-metrics.json` 含 ingest / recall / answer 三段 P50 / P95 延迟。

完整版（100 条）在上述基础上增加双人标注一致性记录与 LLM judge 抽样校准记录。

### 禁止事项

- 禁止以"DryRun 报告显示 22 sessions / 5844 chunks / 26926 redactions"作为验证结论的全部内容。
- 禁止在 trace 中只记录 ID / 计数而不记录实际请求 / 响应文本（敏感字段允许脱敏，但结构必须完整）。
- 禁止跳过 ingest / recall / QA 任一阶段直接给指标；任一阶段缺少 trace，对应指标必须在报告中标注 `evidence: missing` 而非数值。

## 过程数据保存规约（新增）

### 命名空间与目录

每次 `ms project ingest-history --from openclaw --eval-run` 或等价 runner 启动时生成一个 `runId`：

```text
~/.mengshu/eval-corpus/openclaw/validation-runs/<runId>/
├── manifest.json                      # 本次 run 的元数据：CLI 参数、git sha、模型版本、REDACTION_MAP_VERSION、JUDGE_PROMPT_VERSION
├── phase-1-dry-run/
│   ├── report.json                    # 既有
│   ├── statistics.json                # 既有
│   └── redaction-samples.jsonl        # 既有，整改：每行新增 sourcePath / sourceLine
├── phase-2-ingest/
│   ├── ingest-trace.jsonl             # 每条 case 一行，见下文 schema
│   ├── llm-requests.jsonl             # LLM 抽取的 raw request / response（按 caseId 去重）
│   └── validator-decisions.jsonl      # 11 闸门 validator 每个闸门的 pass/fail + 原因
├── phase-3-recall/
│   ├── recall-trace.jsonl             # 每条 query 一行
│   ├── embedding-requests.jsonl       # 召回阶段的 embedding 请求 / 响应（向量取前 8 维 + 维度数即可）
│   └── ranking-breakdown.jsonl        # 每条 query 的 top-k 完整排序与 importance 4 项分解
├── phase-4-qa/
│   ├── qa-trace.jsonl                 # 每条问答一行
│   ├── slot-injection.jsonl           # 5 槽位实际注入内容 + token 计数
│   └── answer-verification.jsonl      # grader / LLM judge 的判定（含 citation 校验）
└── phase-5-analysis/
    ├── failures-analysis.json         # 失败 case 根因聚类
    ├── performance-metrics.json       # P50 / P95 延迟与 token 用量
    └── coverage-report.json           # 指标覆盖与 evidence: missing 清单
```

`tests/eval/results/mengshu-openclaw-history-<timestamp>/` 中的 runner 报告必须以 `validation-runs/<runId>/` 为唯一原始数据来源；不得把过程数据复制进仓库。

### 文件 schema（最小必填字段）

`manifest.json`：

```json
{
  "runId": "2026-06-19T03-48-48",
  "cli": "ms project ingest-history --from openclaw --eval-run --suite mengshu-openclaw-history-smoke",
  "gitSha": "<commit>",
  "redactionMapVersion": "2026.06.19-1",
  "judgePromptVersion": "v1",
  "models": {
    "extraction": "gpt-4o-mini@2024-07-18",
    "summarization": "gpt-4o-mini@2024-07-18",
    "embedding": "BAAI/bge-m3"
  },
  "datasets": { "ingestSource": "~/.openclaw", "goldenSuite": "mengshu-openclaw-history" },
  "createdAt": "2026-06-19T03:48:48Z"
}
```

`phase-2-ingest/ingest-trace.jsonl`（每行）：

```json
{
  "caseId": "openclaw-history-001",
  "sourceFile": "/Users/<USER_HOME>/.openclaw/.../SESSION-STATE.md",
  "sourceSnippet": "<脱敏后片段>",
  "extractionLLMRequestId": "req-xxxx",
  "candidates": [
    { "id": "cand-1", "text": "...", "semanticType": "rules", "valueScore": 0.91, "valueScoreBreakdown": { ... } }
  ],
  "validatorDecisions": [
    { "candidateId": "cand-1", "gate": "scope_consistency", "pass": true, "reason": "..." }
  ],
  "storedMemories": [
    { "id": "oc-m1", "scope": { ... }, "semanticType": "rules", "admissionRoute": "active" }
  ],
  "elapsedMs": { "extraction": 1234, "validation": 56, "storage": 78 }
}
```

`phase-2-ingest/llm-requests.jsonl`（每行）：

```json
{
  "requestId": "req-xxxx",
  "phase": "extraction",
  "model": "gpt-4o-mini@2024-07-18",
  "temperature": 0.0,
  "messages": [{ "role": "system", "content": "..." }, { "role": "user", "content": "..." }],
  "response": { "content": "...", "tokenUsage": { "prompt": 1024, "completion": 256 } },
  "elapsedMs": 1234
}
```

`phase-3-recall/recall-trace.jsonl`（每行）：

```json
{
  "caseId": "openclaw-history-001",
  "query": "OpenClaw 以前给 Agent 配置过哪些自我提升机制？",
  "embeddingRequestId": "emb-yyyy",
  "candidates": [
    {
      "memoryId": "oc-m1",
      "rank": 1,
      "importance": 0.92,
      "importanceBreakdown": { "salience_llm": 0.45, "sourceAuthority": 0.20, "explicitnessBonus": 0.20, "typePrior": 0.15 },
      "matchReason": "vector+keyword"
    }
  ],
  "topK": ["oc-m1", "oc-m5"],
  "requiredHit": true,
  "forbiddenInjected": [],
  "elapsedMs": 87
}
```

`phase-4-qa/qa-trace.jsonl`（每行）：

```json
{
  "caseId": "openclaw-history-001",
  "query": "OpenClaw 以前给 Agent 配置过哪些自我提升机制？",
  "injectedSlots": {
    "profile": ["..."],
    "task_context": ["..."],
    "rules": ["WAL Protocol、Working Buffer、Heartbeat"],
    "experience": [],
    "resource": ["..."]
  },
  "llmRequestId": "req-zzzz",
  "answer": "...",
  "citedSpanIds": ["span-1"],
  "grader": {
    "claim_supported_rate": 1.0,
    "temporal_qualification_rate": 1.0,
    "verdict": "pass"
  },
  "elapsedMs": 2100
}
```

### Trace 与 grader 的关系

- 所有 `code` 类 grader 必须以 trace jsonl 为输入，禁止读运行时内存；这保证"重跑 grader 不需要重跑 LLM"。
- 所有 `LLM_JUDGE` grader 在 `phase-4-qa/answer-verification.jsonl` 中保留 judge 的 prompt / response，便于 `grader_kappa_human_vs_llm` 计算与 prompt 升级回归。
- runner 主流程必须支持 `--replay-from <runId>`：从 trace jsonl 重放 grader，输出新的 `phase-5-analysis/`。这条是阶段 0.5 验收硬性要求。

### 验证产物归档结构（新增）

```text
~/.mengshu/eval-corpus/openclaw/
├── raw/                       # 原始数据（仅本机）
├── redacted/                  # 脱敏中间产物（仅本机）
├── annotations/               # 标注 / 仲裁 / 同意排除记录
├── validation-runs/<runId>/   # 见上文五阶段子目录
└── reports/                   # 长期保留的指标趋势汇总（每周 / 每月聚合）
```

`tests/eval/results/<suite>-<timestamp>/` 只保留 runner 渲染过的 markdown / html 报告，不存原始 trace。CI artifact 上传 `validation-runs/<runId>/` 整体压缩包，保留期 ≥ 30 天。

## 非目标

- 不把用户原始私有历史提交进仓库。
- 不把 Matrix `room_id`、`sessionId`、`threadId` 等裸标识符作为记忆树核心主题。
- 不为了凑样本把与 OpenClaw 历史无关的法律法规文本塞入本 suite；如真实历史中法律/合规材料不足，应另建 `mengshu-claim-evidence` 或接入公开法律评测集。
- 第一阶段不做大规模 LLM-as-judge，只使用确定性 grader、少量模型辅助和人工标注。
- 不替代现有 `mengshu-extraction`、`mengshu-dedup`、`mengshu-recall-explain` 等 suite，而是作为真实数据回归补充。

## 数据来源

本地原始数据建议只读扫描，保存在 `~/.mengshu/eval-corpus/openclaw/raw/`；脱敏后的中间产物保存在 `~/.mengshu/eval-corpus/openclaw/redacted/`。

| 来源 | 样本价值 | 示例能力 |
|------|----------|----------|
| `~/.openclaw/workspace-*/SESSION-STATE.md` | 任务状态、决策、当前进度 | task_context、decision、stale/current |
| `~/.openclaw/workspace-*/memory/working-buffer.md` | 长上下文危险期关键上下文 | context recovery、tree leaf、多 span evidence |
| `~/.openclaw/workspace/.learnings/LEARNINGS.md` | 用户纠正、偏好、长期经验 | profile、rules、experience |
| `~/.openclaw/workspace/.learnings/ERRORS.md` | 失败模式和规避经验 | experience、rules、conflict/update |
| `~/.openclaw/workspace/.learnings/FEATURE_REQUESTS.md` | 未完成需求和未来工作 | task_context、advice、not-promote-to-fact |
| `~/.openclaw/workspace/memory/*.md` | 调研报告、项目长期资料 | resource、topic tree、citation |
| `~/.openclaw/skills/**/SKILL.md`、README | 噪声和资源类样本 | wrong injection、resource precision |
| `~/.openclaw/cron/runs/*.jsonl` | 带时间戳的执行事实 | temporal_status、execution evidence |
| `~/.openclaw/logs/config-audit.jsonl` | 配置变更和冲突 | config fact、updates/supersedes |

## 数据治理

### 只读采集

优先使用 dry-run 预览历史导入范围：

```bash
ms project ingest-history --from openclaw --dry-run
```

如果需要指定来源：

```bash
ms project ingest-history --from openclaw --source-root ~/.openclaw --dry-run
```

### 脱敏规则

脱敏后才允许进入 `tests/eval/fixtures/openclaw-history/`。

脱敏唯一入口为 `packages/core/src/ingest/agent-history/redaction.ts` 的 `redactSecrets`；任何 fixture 入仓前必须经过它，禁止绕过。`RedactionCategory` 在整改后必须覆盖以下类型，缺一不可：

| 类型 | 模式 / 来源 | 占位符 |
|------|-------------|--------|
| api_key | OpenAI / Anthropic / 自建 LLM key | `[REDACTED:api_key]` |
| token | bearer token / refresh token / OAuth token | `[REDACTED:token]` |
| jwt | 裸 JWT `eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`（不依赖 Authorization 前缀） | `[REDACTED:jwt]` |
| private_key | PEM `-----BEGIN ... PRIVATE KEY-----` | `[REDACTED:private_key]` |
| auth_header | `Authorization: Bearer xxx` / `Cookie: xxx` | `[REDACTED:auth_header]` |
| env_secret | `XXX_SECRET=` / `XXX_KEY=` 风格环境变量 | `[REDACTED:env_secret]` |
| email | RFC 5322 简化式 `[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}` | `<EMAIL_REDACTED>` |
| matrix_user | `@user:server.org` 形态的 Matrix MXID | `<MATRIX_USER_REDACTED>` |
| matrix_room | `!roomid:server.org` / `#alias:server.org` | `<MATRIX_ROOM_REDACTED>` |
| ip_v4 / ip_v6 | 公网 IP（私网 / 链路本地由白名单豁免） | `<IP_REDACTED>` |
| phone | E.164 / 中国 11 位手机号 | `<PHONE_REDACTED>` |
| home_path | `/Users/<username>/...` / `/home/<username>/...` 中的用户名段（保留路径其余部分） | `/Users/<USER_HOME>/...` |
| git_remote | `git@host:org/repo.git` / `https://host/org/repo` 含组织/仓库名 | `<GIT_REMOTE_REDACTED>` |
| ssh_fp | SSH key fingerprint `SHA256:base64` | `<SSH_FP_REDACTED>` |

`AgentHistoryEvent.cwd / workdir / sourcePath` 在 `jsonl-parser.ts` 写入前必须先经 `home_path` 脱敏，不得透传系统用户名。

商业敏感项目名如无法公开则替换为稳定占位符（见下表）。原文中的 prompt 注入内容只保留段落级结构提示，所有 `< / > / system / assistant / developer / tool / relevant-memories` 标签级片段必须被转义；Markdown 标题 / 代码块形态的注入（如 ``` 块内的 `# system:`）整段从 fixture 中剥离，并在 `annotation.notes` 中记录"原文存在 prompt 注入，已剥离"。

推荐占位符：

| 类型 | 占位符 |
|------|--------|
| 用户名 | `<USER_MAIN>`、`<AGENT_CODE>` |
| 房间 | `<MATRIX_ROOM_1>` |
| 服务器 | `<SERVER_1>` |
| 项目 | `<PROJECT_NOVEL_1>` |
| 路径前缀 | `<OPENCLAW_HOME>` |
| 密钥 | `<SECRET_REDACTED>` |

#### 脱敏版本治理

`redaction.ts` 必须导出 `REDACTION_MAP_VERSION` 常量（语义化版本，例如 `"2026.06.18-1"`），写入：

- `AgentHistoryEvent.metadata.redactionMapVersion`
- 入仓 fixture 头部 frontmatter `redactionMapVersion: <ver>`
- GoldenCase `source.redactionMapVersion`

升级规则：

1. 新增 / 删除 / 修改任一 PII 类正则即 minor 版本号 +1；新增类即 minor +1；占位符变更即 major +1。
2. fixture 一旦入仓视为 version-frozen；后续规则升级不得在已入仓 fixture 上重跑替换，必须重新生成新版本副本。
3. grader 在校验 evidence span 时必须比对 `source.redactionMapVersion` 与当前 `REDACTION_MAP_VERSION`；不一致时只警告不阻塞，并在报告中标记"待重生成"。

#### Evidence span 偏移基准（脱敏后）

为消除"脱敏字符长度漂移导致 span 偏移失效"的问题，规约如下：

1. **所有 `evidenceSpans.charStart / charEnd` 以脱敏后 fixture 文本为基准**；原始文本偏移不入仓。
2. `redactSecrets` 整改后必须返回 `{ text: string; replacements: Array<{ start: number; end: number; originalLength: number; replacementLength: number; category: RedactionCategory }> }`，下游可在原始 / 脱敏偏移之间互转。
3. fixture 入仓时执行三步：脱敏 → 计算 `evidenceSpans` 时 `quote = text.slice(charStart, charEnd)` 必须严格相等 → 计算 `normalizedQuoteHash`。任一步失败拒绝入仓。
4. fixture 文件视为只读 artifact；标注完成后任何对 snippet 的"修一个错别字"都会触发偏移漂移，必须以"重生成 + bump fixture 版本号"方式处理，而非原地编辑。

#### `normalizedQuoteHash` 计算规范

为消除 Unicode 归一化与大小写差异：

```text
normalizedQuoteHash = sha256(
  quote
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
)
```

`packages/core/src/lifecycle/candidate-validator.ts::normalize` 必须同步加入 `String.prototype.normalize("NFKC")` 调用，保证抽取链路与 grader 链路 hash 一致。

### 标识符治理

Matrix `room_id` 和其他运行时 ID 的默认归属是 provenance，不是长期记忆正文。

| 输入形态 | 处理方式 |
|----------|----------|
| 裸 `!room:server`、`event_id`、`message_id` | 不抽 memory，只保留 evidence/provenance |
| “Jarvis 和 Planner 在 Matrix 房间同步任务” | 可抽协作事实；房间 ID 仍在 metadata |
| “以后 handoff 必须在 Matrix 协作房间留下任务编号” | 可抽 `rules`；topic 为 `Matrix Agent 协作`，不是 room ID |
| “#agents:example.org 是排查协作问题入口” | 可抽 `resource`，但必须有用途；真实 ID 放 evidence |
| “2026-02-27 在房间 X 讨论第 13-18 章下一步” | 可抽历史 `task_context` 并标 stale，不得当作当前任务 |

Golden expected 中应通过 `forbiddenBodyPatterns` 和 `forbiddenTopicKeyPatterns` 验证真实或占位 room ID 不泄露、不入树。

### 证据保留

脱敏不能破坏 evidence span。每条样本需要保留：

- `sourceFile`
- `sourceDate`
- `evidenceSpans`
- `charStart` / `charEnd`（以脱敏后 fixture 文本为基准，见上节）
- `normalizedQuoteHash`（NFKC + 折叠空白 + 小写化后 sha256）
- `spanRole`：`support`、`contradict`、`context`、`metadata`
- `minimalSufficient`：是否为最小充分证据。可验证定义为"去掉该 span 后，没有其他 span 单独支持同一 `claimId`"。grader 通过 `claimId → spanIds` 覆盖图回算，标注者只声明，不参与定义。
- `supportsClaimIds`
- `redactionMapVersion`

跨 span 重叠规则：允许两个 span 的 `[charStart, charEnd]` 重叠（例如同一句话同时支持两个 claim），但重叠区间不得同时被两个 span 标记为 `minimalSufficient = true`；grader 在 release 阻塞层只校验"是否存在违反此规则的标注"。

### 访问控制与同意

为缓解多人协作时的 PII 与合规风险：

1. 原始数据（`~/.mengshu/eval-corpus/openclaw/raw/`）只由数据所有者本人在本机运行 dry-run 与脱敏；标注 / 复核人员只接触 `redacted/` 与 `tests/eval/fixtures/openclaw-history/` 中的脱敏产物。
2. `annotation.annotator / reviewedBy` 必须填真实人员 ID（GitHub handle 或团队 ID）；标注人员在首次贡献前签署数据使用协议（项目仓库 `LEGAL/eval-data-policy.md`，缺则补）。
3. 历史数据中含第三方用户会话（例如 Matrix 房间内其他参与者）时，必须在 fixture 入仓前征得对方同意；无法征得同意的整段从样本中剔除，且在 `~/.mengshu/eval-corpus/openclaw/annotations/` 中记录排除原因。
4. dry-run 与 fixture 重生成命令仅在数据所有者本机执行；CI 不得拥有访问 raw / redacted 目录的凭据。

## 目录设计

```text
tests/eval/
├── fixtures/
│   └── openclaw-history/
│       ├── README.md
│       ├── raw-index.redacted.jsonl
│       └── snippets/
│           ├── openclaw-agent-self-improvement.md
│           ├── openclaw-novel-handoff.md
│           ├── openclaw-skill-noise.md
│           ├── openclaw-matrix-collaboration.md
│           ├── openclaw-stale-task-handoff.md
│           ├── openclaw-config-update-evidence.md
│           ├── openclaw-failure-correction.md
│           └── openclaw-claim-evidence.md
├── goldens/
│   ├── mengshu-openclaw-history.jsonl
│   └── manifest.json
└── results/
    └── mengshu-openclaw-history-<timestamp>/
```

`results/` 沿用现有平铺惯例 `mengshu-openclaw-history-<timestamp>/`，与既有 `results/<timestamp>/` 不互斥；不再新增 `results/openclaw-history/` 子目录层级，避免 `quick-eval.ts` 的 `outDir` 写出逻辑改动。

`snippets/` 至少 8 个文件，覆盖样本分层表的 10 个类别（多类别可共享 snippet，但同一类别不得只用 1 个 snippet 的多个片段，避免单点污染整类指标）。

原始数据目录不入仓：

```text
~/.mengshu/eval-corpus/openclaw/
├── raw/
├── redacted/
├── annotations/
└── reports/
```

## Golden Case Schema

第一版沿用 `tests/eval/runners/types.ts::GoldenCase`，**通过扩展字段承载 OpenClaw 元数据**。

> 关键约束：扩展字段在 JSON 解析层向后兼容（未知字段被忽略），但**当前 runner 不会执行任何针对扩展字段的判定**。Schema 落地必须与 [阶段 0.5 runner 骨架扩展](#阶段-05runner-骨架扩展新增) 同步进行；否则阶段 1 跑出的 pass 是假阳性。`tests/eval/goldens/manifest.json` 中本 suite 的元数据必须新增字段：
>
> - `schemaVersion: 2`
> - `requiresRunner: ["forbiddenBodyPatterns", "scope_match", "identifier_non_promotion", ...]`
> - 列出所有"已写入 golden 但 runner 尚未实现"的 grader，CI 在加载该 suite 时若发现 `requiresRunner` 中存在未实现项，必须显式 warning 而不是静默忽略。

```json
{
  "id": "openclaw-history-001",
  "suite": "mengshu-openclaw-history",
  "task": "从历史状态中提取 Agent 自我提升机制",
  "scope": {
    "tenantId": "local",
    "appId": "openclaw",
    "userId": "default",
    "agentId": "jarvis",
    "projectId": "default",
    "namespace": "memories"
  },
  "source": {
    "app": "openclaw",
    "agent": "jarvis",
    "file": "SESSION-STATE.md",
    "date": "2026-03-02",
    "redactedFixture": "fixtures/openclaw-history/snippets/openclaw-agent-self-improvement.md",
    "redactionMapVersion": "2026.06.18-1",
    "provenance": {
      "sessionId": "sess-1",
      "threadId": "thread-1",
      "roomId": "<MATRIX_ROOM_1>",
      "messageId": "msg-1"
    }
  },
  "evidenceSpans": [
    {
      "id": "span-1",
      "quote": "贾维斯已配置 WAL Protocol",
      "charStart": 120,
      "charEnd": 146,
      "normalizedQuoteHash": "sha256:...",
      "spanRole": "support",
      "minimalSufficient": true,
      "supportsClaimIds": ["claim-1"],
      "supportsNodeIds": ["node-topic-openclaw-self-improvement-l1"],
      "supportsRelationIds": ["rel-oc-m1-belongs-topic"],
      "relationRole": "membership"
    }
  ],
  "seedMemories": [
    {
      "id": "oc-m1",
      "kind": "fact",
      "semanticType": "rules",
      "body": "贾维斯已配置 WAL Protocol、Working Buffer 和 Heartbeat 自检机制。",
      "sourceIds": ["span-1", "span-2"]
    }
  ],
  "query": "OpenClaw 以前给 Agent 配置过哪些自我提升机制？",
  "expected": {
    "requiredMemoryIds": ["oc-m1"],
    "forbiddenMemoryIds": ["oc-noise-skill-install"],
    "requiredSlots": ["rules"],
    "answerMustContain": ["WAL Protocol", "Working Buffer", "Heartbeat"],
    "answerMustNotContain": ["当前仍有效", "<MATRIX_ROOM_1>"],
    "forbiddenBodyPatterns": ["<MATRIX_ROOM_1>", "!.*:.*"],
    "mustEscapeMaxCount": [{ "tag": "</relevant-memories>", "max": 1 }],
    "expectSensitiveBlocked": false,
    "claims": [
      {
        "id": "claim-1",
        "claim": "OpenClaw 历史中配置过 WAL Protocol。",
        "claimType": "fact",
        "verdict": "supported",
        "evidenceSpanIds": ["span-1"],
        "applicability": {
          "appId": "openclaw",
          "agentId": "jarvis",
          "projectId": "default",
          "jurisdiction": null,
          "audience": "agent-runtime"
        },
        "temporal": {
          "sourceDate": "2026-03-02",
          "status": "historical",
          "effectiveFrom": null,
          "effectiveTo": null
        },
        "conflictsWith": [],
        "mustNotPromoteTo": []
      }
    ],
    "tree": {
      "requiredNodes": [
        {
          "id": "node-topic-openclaw-self-improvement-l1",
          "treeType": "topic",
          "treeKey": "openclaw-agent-self-improvement",
          "level": 1,
          "status": "sealed",
          "mustContainLeafIds": ["oc-m1"],
          "mustContainEvidenceSpanIds": ["span-1"],
          "forbiddenLeafIds": ["oc-noise-skill-install"],
          "timeRange": {
            "startAt": "2026-03-02",
            "endAt": "2026-03-02"
          }
        }
      ],
      "requiredParentChild": [
        {
          "parent": "node-topic-openclaw-self-improvement-l2",
          "child": "node-topic-openclaw-self-improvement-l1",
          "treeType": "topic",
          "scopeContainment": true
        }
      ],
      "expectedTopicKeys": [
        {
          "raw": "OpenClaw Agent 自我提升",
          "normalized": "openclaw-agent-self-improvement",
          "forbiddenPatterns": ["<MATRIX_ROOM_1>", "!.*:.*", "thread-.*", "sess-.*"]
        }
      ],
      "forbiddenGlobalPromotions": ["oc-stale-task-next-chapter"],
      "maxOrphanRate": 0,
      "maxCycleRate": 0,
      "evidencePathRequired": true
    },
    "relations": [
      {
        "id": "rel-oc-m1-belongs-topic",
        "from": "oc-m1",
        "to": "node-topic-openclaw-self-improvement-l1",
        "type": "belongs_to",
        "evidenceSpanIds": ["span-1"],
        "scopeContainment": true
      },
      {
        "id": "rel-config-update-1",
        "from": "oc-browser-config-v2",
        "to": "oc-browser-config-v1",
        "type": "supersedes",
        "direction": "from_new_to_old",
        "normalizedClaimKey": "openclaw.browser.config",
        "temporalOrder": {
          "fromDate": "2026-03-03",
          "toDate": "2026-02-28",
          "operator": ">"
        },
        "evidenceSpanIds": ["span-new-config", "span-old-config"],
        "requiredStatus": "active",
        "oldFactExpectedStatus": "stale"
      },
      {
        "id": "rel-handoff-precedes-1",
        "from": "oc-task-handoff-planner",
        "to": "oc-task-handoff-coder",
        "type": "precedes",
        "evidenceSpanIds": ["span-handoff-1"],
        "scopeContainment": true
      },
      {
        "id": "rel-conflict-model-1",
        "from": "oc-current-model-a",
        "to": "oc-current-model-b",
        "type": "conflicts_with",
        "evidenceSpanIds": ["span-a", "span-b"],
        "mustNotMerge": true
      }
    ],
    "legacyTreeCompatibility": {
      "requiredRelations": [
        {
          "from": "oc-m1",
          "to": "openclaw-agent-self-improvement",
          "type": "belongs_to"
        },
        {
          "from": "oc-browser-config-v2",
          "to": "oc-browser-config-v1",
          "type": "supersedes"
        }
      ]
    },
    "requiredStructure": {
      "requiredFields": ["id", "semanticType", "sourceIds", "scope", "createdAt"],
      "parseable": true
    },
    "readability": {
      "maxTokens": 900,
      "mustMentionHistorical": true,
      "maxDuplicateFactRate": 0.1,
      "maxNoiseDensity": 0.15
    }
  },
  "metrics": [
    "slot_recall",
    "wrong_injection",
    "scope_match",
    "identifier_non_promotion",
    "tree_relation_accuracy",
    "claim_supported_rate",
    "latency"
  ],
  "annotation": {
    "annotator": "human_001",
    "reviewedBy": "human_002",
    "agreement": "full",
    "notes": "真实 OpenClaw 历史片段脱敏后标注"
  }
}
```

### 闭合枚举与子结构定义

下列字段在阶段 0.5 必须在 `tests/eval/runners/types.ts` 中以 TypeScript 字面 union / interface 形式落地，避免标注随意发挥：

```ts
type ClaimType = "fact" | "inference" | "advice" | "requirement";
type ClaimVerdict = "supported" | "partially_supported" | "unsupported" | "contradicted";
type TemporalStatus = "current" | "historical" | "stale" | "superseded" | "scheduled";
type SpanRole = "support" | "contradict" | "context" | "metadata";
type RelationRole = "membership" | "evidence" | "temporal" | "conflict";

interface RequirementFields {
  deonticModality: "obligation" | "prohibition" | "permission" | "right";
  bearer: string;             // 义务承担者，如 "agent" / "user" / "system"
  action: string;             // 必须 / 禁止 / 允许的动作
  condition?: string;         // 触发条件（可空）
  authority?: string;         // 出处，如 "用户偏好" / "公司合规" / "GDPR"
  effectiveDate?: string;     // ISO 日期
}

interface ClaimExpected {
  id: string;
  claim: string;
  claimType: ClaimType;
  verdict: ClaimVerdict;
  evidenceSpanIds: string[];
  applicability: {
    appId?: string;
    agentId?: string;
    projectId?: string;
    jurisdiction?: string | null;
    audience?: string;
  };
  temporal: {
    sourceDate: string;
    status: TemporalStatus;
    effectiveFrom?: string | null;
    effectiveTo?: string | null;
  };
  conflictsWith?: string[];
  mustNotPromoteTo?: ClaimType[];
  requirementFields?: RequirementFields;  // 仅当 claimType === "requirement" 必填
}
```

`relations[].type` 在 golden 中允许的关系谓词集为 `belongs_to | supersedes | updates | precedes | conflicts_with | derived_from | references`。若 `packages/core/src/graph/schema.ts::RELATION_PREDICATES` 尚未包含 `belongs_to / precedes / conflicts_with`，必须在阶段 0.5 同步扩展，单一事实来源仍是 `graph/schema.ts`；grader 加载 golden 时按 `RELATION_PREDICATES` 校验类型合法性。

### Stale / current / superseded 判定算法

供 grader 与标注者共用的确定性算法（伪代码）：

```text
function temporalStatus(claim, evalRunDate, MAX_STALE_DAYS = 90):
  if claim.temporal.effectiveTo and claim.temporal.effectiveTo < evalRunDate:
    return "superseded"          # 显式生效区间已过
  if claim.temporal.status == "scheduled":
    return "scheduled"
  if claim.claimType in {"advice", "requirement"} and claim.verdict in {"unsupported", "contradicted"}:
    return "stale"
  ageDays = evalRunDate - claim.temporal.sourceDate
  if ageDays > MAX_STALE_DAYS:
    return "historical"           # 老于阈值默认 historical，不当作 current
  return "current"
```

- `evalRunDate` 由 runner 启动时间注入（`Date.now()` 取 UTC 日期）；CI 中以 commit 时间替换避免漂移。
- `MAX_STALE_DAYS` 默认 90，可通过 manifest.json 中 suite 级别 `temporal.maxStaleDays` 覆盖。
- 标注者可显式声明 `temporal.status`，runner 在校验时取 `expected.status` 与 `temporalStatus(...)` 比对，差异即为 `temporal_status_accuracy` 的违例。

### `legacyTreeCompatibility` 双轨规约

`legacyTreeCompatibility.requiredRelations` 同时承载所有现有 mengshu-dedup / mengshu-tree-summary 风格的 `belongs_to` / `supersedes` / `updates` 关系，**字段集合必须是 `expected.relations` 的子集投影**（仅保留 `from / to / type`）。任何在 `legacyTreeCompatibility` 中出现却在 `relations` 中缺失的边视为标注错误，由 schema-valid grader 直接拒绝。迁移老 suite 时优先填新格式，再由脚本自动投影出 legacy 字段，避免标注者在两侧手填出现分裂。

## 样本分层

第一版目标 100 条；先实现 34 条 smoke，再扩充。

| 类别 | Smoke | 完整版 | 验证点 |
|------|------:|-------:|--------|
| 用户偏好与协作方式 | 4 | 10 | profile、response_style、autonomy preference |
| 任务状态与 handoff | 4 | 12 | task_context、过期状态、待办、owner |
| Matrix 协作语义 | 2 | 6 | rules、task、experience、协作事实 |
| Matrix/运行时标识符负例 | 3 | 8 | room id 不入树、不入正文、仅作 provenance |
| OpenClaw 配置与执行证据 | 3 | 10 | browser、heartbeat、workspace、cron/log evidence |
| 技能/插件历史 | 2 | 7 | resource、plugin boundary |
| 失败经验与纠正 | 3 | 10 | experience、rules、userCorrected |
| Skill/README 文档噪声 | 2 | 8 | wrong injection、resource precision |
| 记忆树/图谱关系 | 6 | 14 | tree summary、parent-child、belongs_to、updates、evidence path |
| 高精度事实/规则/证据 | 5 | 15 | fact/inference/advice/requirement、span、scope、temporal |

## 必测场景

### 1. 用户偏好

验证点：

- 能召回“不要过度询问”“过程透明”“不要半途而废”等长期偏好。
- 偏好应进入 `profile` 或 `rules`，不应被当成普通资源。
- 查询“怎么和用户协作”时，Skill 文档不应压过用户显式偏好。

### 2. OpenClaw 真实历史

验证点：

- 能回答过去完成过的 Agent 自我提升、网文协作、多 Agent 协作调研、小红书任务等事实。
- 输出中保留具体日期、角色分工和 evidence id。
- 对历史状态标注“历史记录，不一定代表当前仍有效”。
- README / Skill 安装说明不能被误判为“用户以前做过的真实任务”。

### 3. 任务状态时效

验证点：

- `2026-02-27` 的“下一步第 13-18 章”不能被当成今天的当前任务。
- 陈旧 `task_context` 应降权或在上下文中标注 stale。
- 用户问“当前状态”时，系统应优先最近且未过期的状态。

### 4. Matrix 和运行时标识符治理

验证点：

- 裸 `room_id/sessionId/threadId/messageId` 不应成为 memory body、summary leaf 或 topic key。
- 有明确用途的 Matrix 房间别名可作为 `resource`，但真实 ID 仍只在 provenance/evidence 中。
- 协作规则可以入 `rules`，topic key 应是 `matrix-agent-collaboration` 这类语义 label。
- `answerMustNotContain` 和 `forbiddenBodyPatterns` 能拦截真实或占位敏感标识符。

### 5. 噪声控制

验证点：

- 宽查询“OpenClaw 以前做过什么”允许返回 Skill 文档作为资源，但真实 `decision/fact/preference` 应排在前面。
- `~/.openclaw/skills/**/SKILL.md` 不应在用户偏好类查询中超过显式 `preference` 记忆。
- README 安装说明不应被误判为历史事实。

### 6. 5 槽位和 fast context

验证点：

- 历史盘点类 query 不应只注入 `resource` 槽。
- 用户协作偏好应进入 profile/rules。
- 当前任务状态应进入 task_context。
- 踩坑和纠正应进入 experience。

这条是回归重点：本地真实测试中，`memory_context_fast` 对“OpenClaw 以前做过哪些真实任务？用户当前工作状态和工作方式是什么？”一类组合查询仍可能只填 `resource` 槽，并过滤部分无 semantic type 的真实历史记忆。

### 7. 记忆树和图谱式关系验证

验证点：

- source tree 摘要必须有 evidence id，且能从 leaf 回溯到 source file、span 和 redaction map。
- topic tree 应使用归一化 topic label，例如 `OpenClaw Agent 自我提升`、`Matrix Agent 协作`，不得使用 Matrix room id、event id、message id。
- global tree 不应把一次性任务状态提升成长期规则。
- L0 leaf 不应直接伪装成高层 summary；L1/L2/L3 必须由 leaf 或 child summary 汇总而来。
- `parent-child` 层级应符合 L0-L3 结构，不能出现孤儿节点、重复父节点或跨 scope 错挂。
- `belongs_to` 应正确表达记忆与 topic/source/project 的从属关系。
- `precedes`、`updates`、`supersedes` 应按日期和证据顺序表达连续性，不能静默合并互斥事实。
- `conflicts_with` 应保留可查询冲突边，不能把互斥事实合并成同一个 active fact。
- 父子 `timeRange` 应包含子节点时间范围，`precedes/updates/supersedes` 应满足明确时间顺序。
- `evidence_path` 必须覆盖关键 leaf 和关系边，关系边没有证据时只能作为低置信推断，不可当事实。

关系样本设计建议：

| 场景 | 正例 | 负例 |
|------|------|------|
| task handoff | Planner 计划 `precedes` Coder 实施，handoff note `belongs_to` 同一任务 topic | 只有同一 Matrix 房间出现但任务不同，不应连 `precedes` |
| 过期状态 | 旧“下一步写 13-18 章”被新状态 `supersedes`，旧状态标 stale | 旧待办不得进入 global tree，不得回答成当前任务 |
| 配置变更 | `config-audit.jsonl` 中新配置 `updates/supersedes` 旧配置 | README 默认配置不应覆盖真实运行配置 |
| Matrix 协作语义 | “handoff 必须在协作房间留下任务编号”入 `rules`，topic key 为 `matrix-agent-collaboration` | `<MATRIX_ROOM_1>`、event id、message id 不入 body/topic/global |
| Skill 噪声 | Skill 文件可作为 `resource` 且 `belongs_to` skill-doc source tree | Skill 安装说明不得与用户真实偏好、历史任务建立 `updates/belongs_to` |
| 用户纠正 | 用户明确纠正旧规则，新规则 `supersedes` 旧规则 | 两条互斥偏好不能静默 merge |

### 8. 法规、事实、证据高精度提取

验证点：

- 原子 claim 必须区分 `fact`、`inference`、`advice/task`、`requirement`。
- `requirement` 需要标注义务、禁止、允许或权利等 deontic modality，并包含 bearer、action、condition、authority、effective date。
- 每个关键 claim 必须有最小充分 evidence span；span 是脱敏 fixture 的真实子串。
- 历史建议、未完成计划和法规/规则要求不能被错误晋升为已发生事实。
- 同一 normalized claim key 的更新、覆盖、冲突需要显式标注。

## 指标和门禁

### 指标定义清单（消除歧义）

下表中所有指标都必须先在 `tests/eval/runners/types.ts::GoldenMetric` 中以字面 union 落地，并在 `judge.ts` 中实现确定性算法或显式标注 `LLM_JUDGE` / `REPORT_ONLY`。指标名、计算公式、grader 类型在阶段 0.5 即冻结。

| 指标 | 计算公式（确定性） | grader 类型 | 备注 |
|------|-----------------|------------|------|
| `extraction_precision` | TP / (TP + FP)；TP = `seedMemories` 中被 LLM 抽出的条目数；FP = LLM 抽出但不在 seed 集 | code | 单 case 微平均 |
| `requiredMemoryIds@5` | `requiredMemoryIds ⊆ top5(retrieved)` 命中率 | code | smoke / 完整版同口径 |
| `context_precision` | `top-k 中属于 golden relevant set 的条目数 / k`（k 默认 = `requiredSlots × slotCapacity`，与 `slot_context_builder` 实际注入数量一致） | code | RAGAS 变体，按 id 比对 |
| `context_recall` | `golden relevant set 中被 top-k 召回的条目数 / |relevant set|` | code | 与 `context_precision` 同 k |
| `slot_routing_accuracy` | 每槽位"必要 memory 是否进入正确 slot"的命中率 | code | 错槽计入 wrong_injection |
| `wrongInjectionRate` | `forbiddenMemoryIds ∩ injected` / |injected| | code | 越低越好 |
| `scope_match_accuracy` | 返回 memory 中 `tenantId / appId / userId / agentId / projectId / namespace` 全等于 case scope 的比例 | code | 任一字段不等即失败 |
| `identifier_non_promotion_rate` | 1 - (返回 memory 的 body / topic key 命中 `forbiddenBodyPatterns ∪ forbiddenTopicKeyPatterns` 的次数 / 检验总次数) | code | smoke 改为 per-case 0 violation |
| `provenance_retention_rate` | 命中 `requiredMemoryIds` 的 memory 中 `provenance.{sessionId, threadId, roomId, messageId}` 至少保留 1 项的比例 | code | 不要求全保留 |
| `topic_key_normalization_accuracy` | `node.topicKey === expectedTopicKeys[].normalized` 命中率；命中 `forbiddenPatterns` 即 0 | code | |
| `tree_relation_accuracy` | `relations` 中 (`from`, `to`, `type`) 命中 golden 的比例 | code | 关系边粒度 |
| `parent_child_validity` | `requiredParentChild` 中所有边在 tree 中存在且 level 递进的比例 | code | 依赖 `seal.ts` 暴露 `parentId` 查询 |
| `orphan_rate` | tree 中无父节点的非根节点 / 节点总数 | code | golden required nodes 严格 0 |
| `cycle_rate` | DFS 检出环的节点比例 | code | 严格 0 |
| `scope_containment_accuracy` | 父节点 scope ⊇ 子节点 scope 的边比例 | code | |
| `temporal_edge_accuracy` | `precedes / updates / supersedes` 的 `temporalOrder` 满足声明 operator 的比例 | code | |
| `evidence_path_coverage` | 关键 leaf 与关系边可回溯到 ≥1 个 evidence span 的比例 | code | smoke 6 条树关系样本同样 1.00 |
| `topic_clustering_purity` | 同一 topic node 下 leaf 的 `expected.topicKey` 一致比例 | code | |
| `global_promotion_precision` | `forbiddenGlobalPromotions` 未出现在 global tree 的比例 | code | |
| `stale_demotion_rate` | `temporalStatus(...) ∈ {historical, stale, superseded}` 的 claim / memory 在召回中被降权（importance 衰减或在 top-k 之外）的比例 | code | 取代旧的 `stale_task_demotion` 与 `stale_superseded_demotion`（详见命名整改） |
| `claim_type_accuracy` | 抽出 claim 的 `claimType` 与 golden 一致比例 | code | |
| `key_fact_evidence_rate` | golden 中 `claimType ∈ {fact, requirement}` 的 claim 至少 1 个 evidence span 命中比例 | code | smoke 改为 per-case 0 violation |
| `atomic_fact_support_rate` | 完整版指标。所有原子 claim 至少 1 个 evidence span 命中比例（覆盖 `key_fact_evidence_rate` 的超集，含 `inference / advice`） | code | smoke 不阻塞 |
| `claim_supported_rate` | 答案使用层报告型。LLM judge 判定答案中陈述被 evidence 支撑的比例 | LLM_JUDGE | 报告型 |
| `unsupported_claim_rate` | 1 - `claim_supported_rate` | LLM_JUDGE | 报告型 |
| `temporal_qualification_rate` | 答案中提到历史事实时显式带"历史 / 已过期 / 已被 X 取代"的比例 | LLM_JUDGE | 报告型 |
| `temporal_status_accuracy` | grader 计算的 `temporalStatus` 与 golden `temporal.status` 一致比例 | code | 用上节算法 |
| `span_token_f1` | grader 提取的 evidence span 与 golden span 在 token 级 F1 | code | 中文按字符切分 |
| `citation_precision` | 答案中 citation id 全部存在于 evidence span 集 | code | |
| `citation_recall` | golden 关键 claim 的 evidence span 全部被引用 | code | |
| `conflict_edge_f1` | `relations[type=conflicts_with]` 的 (from, to) pair 与 golden 一致 F1 | code | 唯一冲突指标，取代旧 `conflict_detection_f1` |
| `schema_valid_rate` | 返回 JSON / slot block 通过 zod schema 校验 | code | 1.00 阻塞 |
| `parse_success_rate` | LLM 输出可被 `extractStructured` 解析 | code | 1.00 阻塞 |
| `required_field_coverage` | 返回 memory 包含 `requiredStructure.requiredFields` 的比例 | code | |
| `prompt_safety_escape` | `mustEscapeMaxCount` 全部满足 | code | 1.00 阻塞 |
| `sensitive_identifier_leak_rate` | `forbiddenBodyPatterns` 命中 / 检验总次数 | code | 0 阻塞 |
| `latency_p50_ms` | 已实现于 `judge.ts:182-183`，对一组 case 求 P50 | code | 报告型 |
| `latency_p95_ms` | P95 延迟 | code | 报告型 |
| `readability_score` | LLM judge 5 分制（rubric 见下） | LLM_JUDGE | 报告型 |
| `actionability_score` | LLM judge 5 分制（rubric 见下） | LLM_JUDGE | 报告型 |
| `redundancy_rate` | 同一 normalized claim key 在返回中重复出现比例 | code | 报告型 |
| `noise_density` | `forbiddenMemoryIds ∪ skill-doc resource` 在返回中占比 | code | 报告型 |
| `deterministic_order_stability` | 同一 case 多次运行 top-k 排序的 Kendall τ | code | 报告型 |
| `grader_kappa_human_vs_llm` | LLM judge 输出与人工标注集 Cohen's Kappa | code | 报告型，用于校准 |

LLM judge 5 分制 rubric 与 prompt 版本固化在 `tests/eval/runners/llm-judge/` 子目录（阶段 2 落地）；每次升级 prompt 即 bump `JUDGE_PROMPT_VERSION` 并在 manifest.json 记录。

### 命名整改记录（避免后续歧义）

| 旧名 | 新名 / 处理 | 原因 |
|------|------------|------|
| `conflict_detection_f1` | 删除，统一为 `conflict_edge_f1` | 概念同源，避免歧义 |
| `claim_supported_rate` | 仅作为答案使用层 LLM_JUDGE 报告型 | 与 `key_fact_evidence_rate / atomic_fact_support_rate` 三层分离 |
| `key_fact_evidence_rate` | smoke 阻塞用，仅 fact / requirement 类 claim | 缩小范围，避免过严 |
| `atomic_fact_support_rate` | 完整版阻塞用，含所有 claim 类型 | 覆盖 inference / advice |
| `stale_task_demotion` / `stale_superseded_demotion` | 合并为 `stale_demotion_rate` | 两个指标无可量化区分 |

### Smoke 阶段门禁（34 条）

> 整改要点：所有"必须 100%"指标改为 **per-case 硬性条件**（任一 case 出现 violation 即阻塞），不再用"34 条均值 = 1.00"的统计期望表达，规避小样本统计陷阱。

| 指标 | 目标 | 门禁形式 |
|------|------|---------|
| extraction_precision | >= 0.80 | suite 均值 |
| requiredMemoryIds@5 | >= 0.85 | suite 均值 |
| context_precision | >= 0.75 | suite 均值 |
| context_recall | >= 0.80 | suite 均值（新增，原方案缺失） |
| wrongInjectionRate | <= 0.20 | suite 均值 |
| slot_routing_accuracy | >= 0.75 | suite 均值 |
| scope_match_accuracy | >= 0.90 | suite 均值 |
| schema_valid_rate | per-case 0 violation | 硬性 |
| parse_success_rate | per-case 0 violation | 硬性 |
| prompt_safety_escape | per-case 0 violation | 硬性 |
| identifier_non_promotion_rate | per-case 0 violation | 硬性 |
| sensitive_identifier_leak_rate | per-case 0 violation | 硬性 |
| key_fact_evidence_rate | per-case 0 violation | 硬性 |
| evidence_path_coverage | 在 6 条树关系样本上 per-case 0 violation | 硬性（新增，原方案 smoke 缺失） |
| latency_p95_ms | <= 800（仅观察基线，不阻塞） | 报告型 |

### 完整版门禁（100 条）

| 指标 | 目标 | 门禁形式 |
|------|------|---------|
| extraction_precision | >= 0.85 | suite 均值 |
| requiredMemoryIds@5 | >= 0.90 | suite 均值 |
| context_recall | >= 0.85 | suite 均值 |
| context_precision | >= 0.80 | suite 均值 |
| wrongInjectionRate | <= 0.15 | suite 均值 |
| slot_routing_accuracy | >= 0.80 | suite 均值 |
| scope_match_accuracy | >= 0.90 | suite 均值 |
| stale_demotion_rate | >= 0.85 | suite 均值 |
| temporal_status_accuracy | >= 0.90 | suite 均值 |
| schema_valid_rate | per-case 0 violation | 硬性 |
| required_field_coverage | >= 0.95 | suite 均值 |
| parse_success_rate | per-case 0 violation | 硬性 |
| identifier_non_promotion_rate | per-case 0 violation | 硬性 |
| provenance_retention_rate | per-case 0 violation | 硬性 |
| resource_purpose_precision | >= 0.90 | suite 均值 |
| topic_key_normalization_accuracy | >= 0.95 | suite 均值 |
| tree_relation_accuracy | >= 0.85 | suite 均值 |
| parent_child_validity | >= 0.95 | suite 均值 |
| orphan_rate | golden required nodes 0；其余 <= 0.02 | 硬性 + 均值 |
| cycle_rate | per-case 0 violation | 硬性 |
| scope_containment_accuracy | >= 0.98 | suite 均值 |
| temporal_edge_accuracy | >= 0.90 | suite 均值 |
| evidence_path_coverage | per-case 0 violation | 硬性 |
| topic_clustering_purity | >= 0.90 | suite 均值 |
| global_promotion_precision | >= 0.95 | suite 均值 |
| claim_type_accuracy | >= 0.90 | suite 均值 |
| atomic_fact_support_rate | fact / requirement 子集 per-case 0 violation；其余 >= 0.95 | 硬性 + 均值 |
| span_token_f1 | >= 0.85 | suite 均值 |
| citation_precision | >= 0.95 | suite 均值 |
| citation_recall | per-case 0 violation | 硬性 |
| conflict_edge_f1 | >= 0.80 | suite 均值 |

### 报告型指标（不阻塞 release gate，定期人工校准）

| 指标 | 观察目标 |
|------|----------|
| readability_score | >= 4.0 / 5（LLM judge） |
| actionability_score | >= 4.0 / 5（LLM judge） |
| redundancy_rate | <= 0.10 |
| noise_density | <= 0.15 |
| unsupported_claim_rate | <= 0.05（LLM judge） |
| temporal_qualification_rate | >= 0.90（LLM judge） |
| deterministic_order_stability | Kendall τ >= 0.95 |
| latency_p50_ms / latency_p95_ms | 观察基线，无目标 |
| grader_kappa_human_vs_llm | >= 0.75（用于决定 LLM judge 是否可信） |

### Release gate "稳定" 的量化定义

阶段 4 接入 release gate 前必须满足"连续 3 次 CI run 稳定"，定义如下（任一指标在 3 次内只要一次违反即重新计数）：

1. 阻塞型指标：3 次中均无 per-case violation；
2. 均值型指标：3 次结果方差 σ² ≤ 该指标 95% 置信区间宽度的 1/4，且每次均高于目标值；
3. 报告型指标：3 次 Kendall τ ≥ 0.90，无显著性下降。

## Grader 设计

### Grader 实施入口与目录结构

阶段 0.5 起，`tests/eval/runners/judge.ts` 拆分为聚合入口 + 子 grader 目录：

```text
tests/eval/runners/
├── judge.ts                # defaultJudge 聚合入口，调用各子 grader
├── graders/
│   ├── retrieval.ts        # requiredMemoryIds@k / context_precision / context_recall / wrong_injection
│   ├── slot.ts             # slot_routing_accuracy / requiredSlots
│   ├── scope.ts            # scope_match_accuracy / scope_containment_accuracy
│   ├── identifier.ts       # forbiddenBodyPatterns / forbiddenTopicKeyPatterns / sensitive_identifier_leak_rate
│   ├── evidence.ts         # span quote / charStart-charEnd / normalizedQuoteHash / evidence_path_coverage
│   ├── claims.ts           # claim_type_accuracy / key_fact_evidence_rate / atomic_fact_support_rate
│   ├── tree.ts             # tree_relation_accuracy / parent_child_validity / orphan_rate / cycle_rate / topic_key_normalization_accuracy
│   ├── temporal.ts         # temporal_status_accuracy / temporal_edge_accuracy / stale_demotion_rate
│   ├── structure.ts        # schema_valid_rate / parse_success_rate / required_field_coverage
│   ├── safety.ts           # prompt_safety_escape / mustEscapeMaxCount
│   └── llm-judge/
│       ├── readability.ts
│       ├── actionability.ts
│       ├── claim-supported.ts
│       └── prompts/        # 固定 prompt + JUDGE_PROMPT_VERSION
└── types.ts                # 扩展 GoldenCase / ExpectedSpec / GoldenMetric / CaseResult
```

每个子 grader 是纯函数 `(goldenCase, runtimeOutput) => GraderResult`，便于单测；`defaultJudge` 仅做聚合。

### 代码 grader：release 阻塞

| 检查 | grader 模块 | 方法 |
|------|------------|------|
| required / forbidden memory | retrieval | `requiredMemoryIds` 是否在 top-k，`forbiddenMemoryIds` 是否未注入 |
| scope | scope | 返回 memory 的 6 维 scope 是否匹配 |
| slot | slot | `requiredSlots` 是否命中，且无明显错槽 |
| schema | structure | JSON / slot block 是否可解析，必需字段是否完整 |
| 标识符治理 | identifier | body / answer / topic key 是否命中 `forbiddenBodyPatterns ∪ forbiddenTopicKeyPatterns` 正则集 |
| evidence span | evidence | quote 子串校验、char offset 校验（脱敏后基准）、normalizedQuoteHash 校验（NFKC + 折叠空白 + 小写化） |
| tree relation | tree | required node / relation 是否存在，relation endpoint 是否存在，是否有 evidence path |
| tree invariant | tree | `treeType` 属于 source / topic / global，level 在 L0-L3，父子 level 递进 |
| graph invariant | tree | parent-child 无孤儿、无重复父、无环；`conflicts_with` 不被 merge 成 active fact |
| scope containment | tree + scope | 父 scope 不得比子 scope 更窄，不得跨 app / project / user 错挂 |
| topic normalization | tree | raw label 按 alias / slug 归一化，Matrix / path / session ID 被拒绝成 topic key |
| stale 判断 | temporal | 按 [Stale 算法节](#stale--current--superseded-判定算法) 计算 stale / current / superseded |
| 冲突关系 | tree + temporal | golden pair 的 `updates / supersedes / conflictsWith` 是否命中，旧 fact 是否 stale / archive |
| prompt safety | safety | 危险标签转义、敏感信息正则、token budget |

### 数据治理类 grader 的具体算法

为消除"标识符治理 grader 如何落地"的歧义，列出三个最高频检查的伪代码：

```text
forbiddenBodyPatterns:
  for each injected memory body:
    for each pattern in expected.forbiddenBodyPatterns:
      if RegExp(pattern).test(body):
        violations += 1
  pass = violations == 0

forbiddenTopicKeyPatterns:
  for each tree node where treeType in {topic, global}:
    if any pattern in expectedTopicKeys[].forbiddenPatterns matches node.topicKey:
      violations += 1
  pass = violations == 0

scope_match_accuracy:
  for each retrieved memory m:
    matched = ["tenantId","appId","userId","agentId","projectId","namespace"]
      .every(k => m.scope[k] === case.scope[k])
    if matched: tp += 1 else: fp += 1
  rate = tp / (tp + fp)
```

### LLM judge：报告信号

适合用于开放质量判断，但初期不作为硬门禁：

- 历史事实是否忠实于 evidence。
- 答案是否回答了 query，而不是堆砌资源。
- 任务状态是否正确限定为 historical / current / stale。
- Skill 文档返回在该 query 下属于可接受资源还是噪声。
- 可读性、行动性、冗余度和上下文可扫读性。

LLM judge 必须固定 prompt、模型版本和输出 schema，并定期用人工标注集校准。每次 prompt 改动都 bump `JUDGE_PROMPT_VERSION`，并要求 `grader_kappa_human_vs_llm >= 0.75` 才能被作为有效信号。

### 人工 grader：标准建立和仲裁

人工标注要求：

- Smoke 阶段单人标注 + 复核。
- 完整版关键边界样本双人标注，Cohen's Kappa >= 0.85。
- 分歧样本进入仲裁，仲裁结论写入 `annotation`。
- Matrix 标识符、法规 / 规则要求、冲突关系和 stale / current 边界样本必须额外复核。

## 实施步骤

### 阶段 0：数据盘点

```bash
ms project ingest-history --from openclaw --dry-run --save-validation
```

输出本地清单与 phase-1 元数据：

```text
~/.mengshu/eval-corpus/openclaw/validation-runs/<runId>/phase-1-dry-run/
├── report.json
├── statistics.json
└── redaction-samples.jsonl
~/.mengshu/eval-corpus/openclaw/redacted/raw-index.redacted.jsonl
```

`raw-index.redacted.jsonl` 字段（必须由 `printDryRunReport` 写入文件，而不仅打印控制台）：

- `sourceFile`
- `agent`
- `date`
- `recordType`
- `estimatedTokens`
- `riskFlags`：脱敏命中类型集合（`api_key / token / jwt / email / matrix_user / matrix_room / ip_v4 / ip_v6 / phone / home_path / git_remote / ssh_fp / private_key / auth_header / env_secret`）
- `identifierFlags`：未脱敏命中的 Matrix room id / event id / message id 数量与首例位置（用于阶段 1 标注负例）
- `candidateCategories`：候选语义类型分布（profile / task_context / rules / experience / resource）
- `candidateRelations`：检出的潜在关系类型（belongs_to / supersedes / precedes / conflicts_with）
- `candidateClaimTypes`：检出的潜在 claim 类型分布（fact / inference / advice / requirement）
- `redactionMapVersion`：当前 `REDACTION_MAP_VERSION`

阶段 0 的前置条件：`packages/core/src/ingest/agent-history/redaction.ts` 必须先扩展为支持上述全部 PII 类型；否则 dry-run 报告不准确，阶段 1 fixture 入仓必有 PII 漏脱敏。

> 阶段 0 验收：仅产出元数据。明确不构成"真实验证通过"的证据；任何把 phase-1 元数据当作最终结论的报告必须被拒收。

### 阶段 0.5：Runner 骨架扩展（新增）

> 关键节点：必须在阶段 1 入库 golden 之前完成，否则 golden 中的 `tree / claims / relations / forbiddenBodyPatterns` 等扩展字段在 runner 中无对应执行代码，跑出的 pass 全部假阳性。

最小变更集：

1. **`tests/eval/runners/types.ts`**：
   - 扩展 `GoldenCase` 增加 `source / evidenceSpans / annotation` 顶层字段；
   - 扩展 `ExpectedSpec` 增加 `forbiddenBodyPatterns / answerMustNotContain / claims / tree / relations / legacyTreeCompatibility / readability`；
   - 扩展 `SeedMemorySpec` 增加 `sourceIds`；
   - 扩展 `GoldenMetric` union 至本方案 [指标定义清单](#指标定义清单消除歧义) 全集；
   - 扩展 `CaseResult` 增加每个 grader 的违例计数与样本字段；
   - 落地闭合枚举：`ClaimType / ClaimVerdict / TemporalStatus / SpanRole / RelationRole / RequirementFields`。

2. **`tests/eval/runners/judge.ts`** 拆分为 `runners/graders/*.ts` 子模块（结构见 [Grader 实施入口](#grader-实施入口与目录结构)），并实现以下三项最高价值确定性 grader（其余 grader 留 stub 返回 `skip` 但**必须把 metric 写入 manifest.json 的 `requiresRunner`**，CI 加载时 warn）：
   - `identifier.ts::forbiddenBodyPatternsGrader`
   - `scope.ts::scopeMatchGrader`
   - `safety.ts::answerMustNotContainGrader`

3. **`tests/eval/goldens/manifest.json`**：本 suite entry 新增 `schemaVersion: 2 / requiresRunner: [...]`；CI runner 加载时若发现 `requiresRunner` 中存在未实现 grader，必须 console.warn 而不是静默忽略。

4. **`packages/core/src/lifecycle/candidate-validator.ts::normalize`** 加入 `String.prototype.normalize("NFKC")` 调用，保持与 grader hash 算法一致。

5. **`packages/core/src/graph/schema.ts::RELATION_PREDICATES`** 扩充 `belongs_to / precedes / conflicts_with`；旧消费方若有 exhaustive switch 同步更新。

6. **`packages/core/src/tree/`** 在 tree repository 暴露 `getParent(nodeId): Promise<TreeSummaryNode | null>` 查询，支撑 `parent_child_validity` grader。

7. **`plugins/openclaw/src/cli/ingest-history.ts`** 扩展 `DryRunReport` 字段并写入 `raw-index.redacted.jsonl` 文件；同步实现 `--eval-run` 参数与 trace 写入路径（见 [过程数据保存规约](#过程数据保存规约新增)）。

8. **新增 `tests/eval/runners/trace-writer.ts`**：统一封装 `writeIngestTrace / writeRecallTrace / writeQaTrace` 三个入口；ingest pipeline、recall orchestrator、slot context builder 在 eval 模式下注入此 writer。runner 必须支持 `--replay-from <runId>` 从 trace jsonl 重跑 grader 得到 `phase-5-analysis/`。

阶段 0.5 验收：

```bash
npx tsc --noEmit
npx vitest run tests/eval/runners/
ms project ingest-history --from openclaw --eval-run --suite mengshu-openclaw-history-smoke --replay-from <runId>
```

- `tsc --noEmit` exit 0；
- 现有 7 套 suite 在新 union 下不破坏；
- `tests/eval/runners/graders/*.test.ts` 至少覆盖三项最高价值 grader 的红绿路径；
- `--replay-from` 能在不调用 LLM / embedding 的情况下重新生成 `phase-5-analysis/`，证明 trace 自洽。

### 阶段 1：Smoke Golden 34 条 + 真实记忆链路

> v0.5 整改：阶段 1 验收物从"元数据 + jsonl golden"扩展为"jsonl golden + 完整 ingest / recall / QA trace"。任何只交付 DryRun 元数据的 PR 不能合入。

交付物：

- `tests/eval/fixtures/openclaw-history/README.md`
- `tests/eval/fixtures/openclaw-history/snippets/*.md`（≥ 8 个，覆盖 10 类）
- `tests/eval/goldens/mengshu-openclaw-history.jsonl`
- `tests/eval/goldens/manifest.json` 增加 suite 元数据，含 `schemaVersion: 2 / requiresRunner: [...]`
- 一次完整 `validation-runs/<runId>/`，包含 `phase-1` 至 `phase-5` 全部子目录（见 [过程数据保存规约](#过程数据保存规约新增)）

入仓流程（每条 case）：

1. 选定 snippet → 运行 `redactSecrets` → 计算 `evidenceSpans`（脱敏后偏移）→ 校验 `quote === text.slice(charStart, charEnd)` 严格相等 → 计算 `normalizedQuoteHash` → 标注 `claims / tree / relations` → 入 jsonl；
2. fixture 视为只读 artifact；任何修改都需 bump fixture 版本号或重新生成。

执行流程：

```bash
# 真实记忆链路（消耗模型 / embedding token，必须保存 trace）
ms project ingest-history --from openclaw --eval-run \
  --suite mengshu-openclaw-history-smoke \
  --save-validation
```

执行时必须依次产出：

1. **phase-2-ingest**：每条 case 至少 1 条 `ingest-trace.jsonl` 行 + 对应 `llm-requests.jsonl` / `validator-decisions.jsonl`。
2. **phase-3-recall**：每条 case 至少 1 条 `recall-trace.jsonl` 行 + `embedding-requests.jsonl` / `ranking-breakdown.jsonl`。
3. **phase-4-qa**：每条 case 至少 1 条 `qa-trace.jsonl` 行 + `slot-injection.jsonl` / `answer-verification.jsonl`。
4. **phase-5-analysis**：`failures-analysis.json` / `performance-metrics.json` / `coverage-report.json`。

验证：

```bash
npm run eval:quick -- mengshu-openclaw-history
ms project ingest-history --replay-from <runId>     # 不调模型，重新跑 grader，结果应与上一次一致
```

预期：

- 阶段 0.5 已实现的三项 grader 真实判定；其他 grader 在 console 显示 `[SKIP] requiresRunner: tree_relation_accuracy`，作为后续工作信号；
- `coverage-report.json` 中 `evidence: missing` 计数为 0（即每条 case 都有完整 trace），否则阶段 1 视为未通过；
- 重放产生的 `phase-5-analysis/` 与首次执行结果一致（grader 是确定性的）。

### 阶段 2：Runner 全量指标扩展

实现 [指标定义清单](#指标定义清单消除歧义) 中所有 `grader 类型 = code` 的指标，并接入 `LLM_JUDGE` 类型的报告型 grader。

需同步更新：

- `tests/eval/runners/types.ts`
- `tests/eval/runners/graders/*.ts`
- `tests/eval/runners/llm-judge/*`
- `tests/eval/runners/quick-eval.ts`（汇总到 `SuiteSummary`）
- `tests/eval/runners/quick-eval.test.ts`
- `tests/eval/runners/trace-writer.ts`（新增 phase-4 LLM judge trace 字段）

LLM judge 只用于疑难 entailment 和可读性抽样；span、scope、date、identifier 和 tree relation 优先用确定性检查。LLM judge 必须满足 `grader_kappa_human_vs_llm >= 0.75` 后才能作为报告信号。

阶段 2 验收：在 smoke 34 条 case 上重跑一次 `--eval-run`，`phase-5-analysis/coverage-report.json` 中 `metricsWithEvidence` 覆盖本方案全部 `code` 类指标；任一指标若返回 `evidence: missing` 必须在 PR 描述中显式说明原因。

### 阶段 3：完整版 100 条

按样本分层扩充至 100 条，并执行双人标注（Cohen's Kappa ≥ 0.85）。

交付物：

- 完整 `mengshu-openclaw-history.jsonl`
- 标注一致性报告（含 Kappa 计算工具与人工仲裁记录）
- `tests/eval/results/mengshu-openclaw-history-<timestamp>/report.md`
- `validation-runs/<runId>/` 全量 100 条 trace；`failures-analysis.json` 必须包含失败 case 的根因聚类（提取漏 / 召回漏 / 注入污染 / 答案不忠实 / scope 漂移 / 标识符泄漏 / 时态错判）。

### 阶段 4：Release Gate 接入

先作为非阻塞报告运行；按 [Release gate 稳定的量化定义](#release-gate-稳定-的量化定义) 连续 3 次稳定后纳入 release gate。

接入前置条件：

1. CI 中能够拉起本机或 sandbox 模型与 embedding，并产出完整 `validation-runs/<runId>/`；
2. Trace 体积超阈值时自动分卷压缩，CI artifact 保留期 ≥ 30 天；
3. `--replay-from` 在 CI 中可重跑 grader，避免每次 release 都消耗模型 token。

建议 gate（最小集）：

```text
wrongInjectionRate <= 0.15                       # suite 均值
requiredMemoryIds@5 >= 0.90                      # suite 均值
slot_routing_accuracy >= 0.80                    # suite 均值
scope_match_accuracy >= 0.90                     # suite 均值
schema_valid_rate per-case 0 violation
identifier_non_promotion_rate per-case 0 violation
topic_key_normalization_accuracy >= 0.95         # suite 均值
tree_relation_accuracy >= 0.85                   # suite 均值
citation_recall per-case 0 violation
evidence_path_coverage per-case 0 violation
trace_completeness per-case 0 evidence:missing   # 新增：过程数据完整性
```

## 风险和缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 历史数据含敏感信息 | 不能入仓 | 原始数据只在本机，入仓前强制脱敏；脱敏规则覆盖 15 类 PII |
| Matrix / runtime ID 被提升为记忆 | 记忆树污染、泄露标识符 | `identifier_non_promotion_rate` per-case 0 violation 阻塞；`forbiddenBodyPatterns / forbiddenTopicKeyPatterns` 双闸门 |
| 历史任务已过期 | 误判当前状态 | 标注 `temporal`，按 [Stale 算法](#stale--current--superseded-判定算法) 计算；`stale_demotion_rate >= 0.85` 阻塞 |
| Skill 文档噪声过强 | 误召回 | 设置 forbidden ids、`context_precision` 与 `noise_density` 双指标 |
| scope 不一致 | 命中不稳定 | 每条 case 明确 `tenantId / appId / userId / agentId / projectId / namespace` |
| fast context 误路由 | 上下文污染 | `slot_routing_accuracy` 与 `schema_valid_rate` 独立指标 |
| 树关系过度推断 | topic / global tree 产生无证关系 | `evidence_path_coverage` per-case 0 violation；无证关系只作低置信推断 |
| 法规 / 规则样本不足 | suite 失真 | 只用真实历史中出现的法规 / 规则；不足时拆出独立 `mengshu-claim-evidence` suite |
| LLM judge 不稳定 | 门禁抖动 | 初期只作报告型；固定 prompt + 模型版本；`grader_kappa_human_vs_llm >= 0.75` 才视为有效 |
| 标注成本高 | 进度慢 | 先 34 条 smoke，再扩到 100 条；提供标注模板与 Kappa 计算工具 |
| **GoldenCase schema 与 runner 不同步** | 阶段 1 出现假阳性 pass，掩盖系统缺陷 | 阶段 0.5 强制先扩 `types.ts / judge.ts`；manifest.json `requiresRunner` 字段在加载时 warn 未实现 grader |
| **脱敏后 evidence span 偏移漂移** | grader 校验失败或假通过 | `redactSecrets` 输出 `replacements[]`；`charStart/charEnd` 一律以脱敏后文本为基准；fixture 视为只读 artifact |
| **redaction 规则升级与历史 fixture 不一致** | 同一字段不同版本规则下行为分裂 | `REDACTION_MAP_VERSION` 写入 fixture 与 `source.redactionMapVersion`；版本不一致时报告"待重生成"而不阻塞 |
| **annotation tooling 缺失** | Kappa 不可计算、仲裁无追溯 | 阶段 2 同步落地 `tests/eval/tools/kappa.ts`；`annotation` 字段在 `GoldenCase` 类型中显式定义 |
| **grader 入口不明确** | 实施者写到 `judge.ts` 单文件超 300 行 | 在 [Grader 实施入口](#grader-实施入口与目录结构) 强制定义 `runners/graders/*.ts` 子目录结构 |
| **smoke 小样本下 100% 指标不稳** | 单 case 标注错误即触发 gate fail | "必须 100%"指标改为 per-case 硬性条件而非"34 条均值 = 1.00"；统计型指标走均值，硬性指标走 violation 计数 |
| **Markdown / 代码块形态的 prompt 注入** | 仅 HTML 标签转义无法拦截 | fixture 入仓前整段剥离 Markdown 注入并在 `annotation.notes` 中记录；`mustEscapeMaxCount` 覆盖集扩展为 `<system|assistant|developer|tool|relevant-memories>` |
| **多人协作时的 PII 同意 / 合规边界** | GDPR / PIPL 风险 | 见 [访问控制与同意](#访问控制与同意) 节 |
| **只保存 DryRun 元数据无法证明系统有效性** | 所有指标建立在元数据统计之上，无 ingest / recall / answer 过程可回放，无法定位失败根因 | 新增 [验证目的与最低交付物](#验证目的与最低交付物新增) 与 [过程数据保存规约](#过程数据保存规约新增)；阶段 1 验收物从"元数据 + jsonl"扩展为"jsonl + 完整 trace"；`coverage-report.json` 中 `evidence: missing` 计数为 0 成为阶段 1 硬性条件 |
| **Trace 体积过大影响 CI artifact** | 完整版 100 条 × (ingest + recall + QA) trace 可能超 GB | 自动分卷压缩；`llm-requests.jsonl` / `embedding-requests.jsonl` 按 caseId 去重；`--replay-from` 避免每次 release 都调模型；CI artifact 保留期 ≥ 30 天后自动清理 |
| **Trace 格式不一致导致 --replay-from 失败** | grader 读 trace 时字段缺失或类型不匹配 | 在 [过程数据保存规约](#过程数据保存规约新增) 固化每个 jsonl 的 schema；阶段 0.5 验收必须包含 `--replay-from` 能重跑 grader 的测试；trace-writer 输出必须通过 zod 校验 |

## 成功标准

当以下条件满足时，可认为 OpenClaw 历史评测集达到可用状态：

1. 阶段 0.5 完成：`types.ts / judge.ts / graph schema / tree repository / redaction.ts / ingest-history.ts / trace-writer.ts` 同步扩展，`tsc --noEmit` exit 0，现有 7 套 suite 不破坏，`--replay-from <runId>` 能在不调模型的情况下重跑 grader。
2. 34 条 smoke golden 已入仓并能通过 `npm run eval:quick -- mengshu-openclaw-history`，且 manifest.json `requiresRunner` 中无未实现 grader（或在 console 显式 warn）。
3. 每条样本有脱敏 fixture、expected、annotation、source 元数据和关键 evidence span；`charStart/charEnd` 与 `normalizedQuoteHash` 在脱敏后 fixture 上严格自洽。
4. **任意一条 case 都能从 `validation-runs/<runId>/` 完整回放 ingest → recall → answer 链路**：`phase-2-ingest / phase-3-recall / phase-4-qa` 三个阶段的 jsonl 缺一不可，`coverage-report.json` 中 `evidence: missing` 计数为 0。
5. 能稳定复现并覆盖以下真实问题：Skill 文档噪声、fast context 误路由、过期 task_context、Matrix 标识符非提升、树关系证据缺失、stale 与 superseded 区分、QA 答案 citation 与 evidence 一致性。
6. 完整版 100 条达到 [完整版门禁](#完整版门禁100-条) 全部目标，含 per-case 硬性条件与 suite 均值。
7. 评测报告能清楚显示命中、误注入、slot 路由、scope 匹配、结构合法率、证据支撑率、树关系准确率、stale 降权率和可读性抽样分；并附 `latency_p50_ms / latency_p95_ms` 报告型基线，以及 ingest / recall / answer 三段延迟与 token 用量分项。
8. **禁止以"DryRun 元数据 + 指标平均值"作为最终验收依据**；任一 release 必须附带 `failures-analysis.json` 列出失败 case 根因。

## 参考方法

- RAG 评测：RAGAS、TruLens RAG Triad、DeepEval 的 context precision/recall、faithfulness、groundedness。
- 图谱/记忆树评测：GraphRAG 的 text units、entities、relationships、community reports 和 source document 回溯。
- 时态事实和 provenance：Graphiti/Zep 的 temporal facts、episode/provenance、invalidated-not-deleted。
- 法律/规则和证据：LegalRuleML、ContractNLI、LegalBench-RAG、FEVER、AVeriTeC、FActScore、ERASER。
- 可读性：PlainLanguage.gov、CDC Clear Communication Index、SummEval 的 coherence/consistency/fluency/relevance。
