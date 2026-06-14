# LLM 驱动图谱提取升级方案

> 版本：v1.0
> 日期：2026-06-14
> 状态：设计方案
> 关联：[brand-story.md](./brand-story.md) · [structured-knowledge-graph-memory-tree-detail.md](../04-design/04.2-detail/structured-knowledge-graph-memory-tree-detail.md)

---

## 1. 背景与动机

### 当前状态

梦枢的 `graph/extractor.ts` 是纯规则实现：

- 用正则提取文件路径、项目名
- 用硬编码词表匹配工具名（postgres、lancedb 等）
- confidence 全部写死（0.75 / 0.72 / 0.6）
- 只能识别 3 类实体（project / file / tool），11 种关系中只用了 2 个（mentions / uses）

这导致：

1. **语义层关系无法提取**——"用户偏好先给结论再解释"这类信息完全丢失
2. **实体覆盖率极低**——14 种 EntityType 只用了 3 种
3. **历史会话数据无法有效摄入**——即使读进来也只能做向量化，不能构建有意义的记忆图谱
4. **记忆树质量受限**——topic tree 的 hotness 依赖 mentionCount，但规则抽取的 mention 极少

### 升级目标

用 LLM 替代规则层做实体/关系提取，参考 LightRAG 的方式：

- 一次 LLM 调用从 chunk 文本中提取**多组三元组**（subject, predicate, object）
- 每个三元组带 confidence 和 evidence 文本
- 支持全部 14 种 EntityType 和 11 种 RelationPredicate
- 规则层降级为 fallback（LLM 不可用或 budget 超限时）

---

## 2. LightRAG 提取策略参考

LightRAG 的实体/关系提取核心流程：

```
Document → Chunk → LLM Extract → Entity Dedup → Relation Build → Graph Store
```

关键设计选择：

| LightRAG 做法 | 梦枢适配 |
|--------------|---------|
| 一个 chunk 一次 LLM 调用，prompt 要求输出结构化 JSON | 相同，使用 structured output |
| Entity 去重靠 canonicalName 归一化 | 相同，复用现有 `canonicalizeName()` |
| Relation 必须有 evidence text（原文片段） | 相同，每个三元组必须引用原文 |
| 对 entity type 有预定义 taxonomy | 相同，复用 14 种 EntityType |
| 批量处理 + 并发控制 | 相同，复用 p-limit / p-retry |

梦枢的差异点：

1. **scope 隔离**——提取出的 entity/relation 带 MemoryScope，不同项目不串
2. **confidence 由 LLM 自评**——prompt 中要求输出 0-1 的置信度
3. **规则层 fallback**——LLM 超时/失败时退回规则提取，保证写入不阻塞
4. **Working Context 语义类型映射**——提取后自动标记 entity 对应哪个 slot（profile/rules/experience 等）

---

## 3. 架构设计

### 3.1 整体链路

```
Input Text (chunk / message / observation)
      │
      ▼
┌─────────────────────────────────┐
│  LLM Entity-Relation Extractor  │  ← 核心新增
│  (graph/llm-extractor.ts)       │
└────────────┬────────────────────┘
             │ structured output
             ▼
┌─────────────────────────────────┐
│  Extraction Validator           │  ← 校验 + 过滤
│  (graph/extraction-validator.ts)│
└────────────┬────────────────────┘
             │ validated entities + relations
             ▼
┌─────────────────────────────────┐
│  Entity Resolver                │  ← 去重 + 合并
│  (graph/entity-resolver.ts)     │
└────────────┬────────────────────┘
             │ resolved entities + relations
             ▼
┌─────────────────────────────────┐
│  Graph Repository               │  ← 持久化
│  (graph/repository.ts)          │
└─────────────────────────────────┘
```

### 3.2 LLM Extractor

核心文件：`graph/llm-extractor.ts`

输入：
```typescript
interface LlmExtractionInput {
  scope: MemoryScope;
  chunkId: string;
  text: string;
  sourceId?: string;
  createdAt: number;
  context?: {
    projectName?: string;
    userName?: string;
    agentName?: string;
  };
}
```

输出（LLM structured output）：
```typescript
interface LlmExtractionOutput {
  entities: Array<{
    name: string;
    type: EntityType;
    description: string;
    aliases?: string[];
  }>;
  relations: Array<{
    subject: string;       // entity name
    predicate: RelationPredicate;
    object: string;        // entity name
    confidence: number;    // 0-1
    evidence: string;      // 原文摘引
  }>;
  summary?: string;        // chunk 一句话摘要
}
```

### 3.3 Prompt 设计

```
你是一个知识图谱提取专家。从下面的文本中提取实体和关系。

## 实体类型（只能使用以下类型）
person, organization, project, repo, file, topic, tool, task, concept, user, agent, chunk, document, other

## 关系类型（只能使用以下谓词）
mentions, works_on, uses, owns, depends_on, decided, prefers, blocked_by, fixed_by, supersedes, related_to

## 上下文
- 项目：{projectName}
- 用户：{userName}

## 要求
1. 提取文本中出现的所有有意义的实体（人、工具、项目、概念、文件等）
2. 提取实体之间的关系，每个关系必须包含原文证据
3. confidence 表示你对这个关系的确信度（0.0-1.0）
4. 忽略过于笼统或无信息量的实体（如"代码"、"功能"）
5. 用中文描述实体和关系（如果原文是中文）

## 输入文本
{text}

## 输出格式（严格 JSON）
{schema}
```

### 3.4 Extraction Validator

校验规则（任何不通过的项被丢弃，不阻塞整体）：

| 校验项 | 规则 |
|--------|------|
| entity.type | 必须在 14 种 EntityType 内 |
| entity.name | 非空，长度 ≤ 200 |
| relation.predicate | 必须在 11 种 RelationPredicate 内 |
| relation.confidence | 0 < confidence ≤ 1.0 |
| relation.evidence | 非空，且在原文 text 中能模糊匹配 |
| relation.subject/object | 必须引用 entities 数组中已声明的 name |

### 3.5 Entity Resolver

去重和合并策略：

1. **名称归一化**：`canonicalizeName(name)` → 小写、去标点、trim
2. **别名合并**：同一 scope 下 canonicalName 相同的 entity 合并
3. **跨 chunk 累加**：mentionCount++、distinctSourceCount++、lastSeenAt 更新
4. **类型冲突**：保留 confidence 更高的类型；同 confidence 取更具体的（file > other）

---

## 4. LLM 调用时机

| 场景 | 触发 | 调用方式 |
|------|------|---------|
| **autoCapture** | Agent 对话结束 | 异步 enqueue `extract_graph` job，不阻塞响应 |
| **ms import** | 历史会话导入 | 批量串行/并行，受 concurrency 控制 |
| **ingest pipeline** | 文档/目录扫描 | `embed_chunk` 完成后追加 `extract_graph` job |
| **手动触发** | `ms extract --file` | 同步提取并展示结果 |
| **seal buffer** | 记忆树摘要（已有） | 保持不变，使用 `summarize()` |

### 4.1 Job 队列设计

新增 job type：`extract_graph`

```typescript
interface ExtractGraphJob {
  type: "extract_graph";
  chunkId: string;
  text: string;
  scope: MemoryScope;
  sourceId?: string;
  context?: { projectName?: string; userName?: string };
  priority: "high" | "normal" | "low";
  createdAt: number;
}
```

优先级规则：
- `high`：用户显式 save 的记忆、autoCapture 的决策类记忆
- `normal`：autoCapture 普通记忆、ingest pipeline
- `low`：历史导入（ms import）

### 4.2 成本控制

| 控制手段 | 说明 |
|---------|------|
| **chunk 过滤** | 短于 50 字的 chunk 跳过 LLM，只走规则 |
| **去重跳过** | contentHash 已处理过的 chunk 不重复提取 |
| **并发限制** | p-limit 默认 3 并发 |
| **日 budget** | 可选配置 `llm.dailyBudgetTokens`，超限后全部走规则 fallback |
| **模型分级** | 普通 chunk 用 mini 模型，高 importance chunk 用大模型 |

---

## 5. Embedding 调用时机

明确 embedding 在完整链路中的位置：

```
写入链路：
  text → embedBatch() → vector
       → storeMemory(record with vector) → 向量库
       → enqueue extract_graph job → LLM 提取 → 图谱库（异步）

召回链路：
  query → embed(query) → vector → 向量检索 → top-K results
        → 可选 graph 增强召回 → 合并排序 → 返回
```

| 时机 | 调用 | 同步/异步 |
|------|------|----------|
| 记忆写入 | `embedBatch(texts)` | 同步（写入前必须完成） |
| 查询 | `embed(query)` | 同步 |
| ingest chunk | `embed_chunk` job | 异步（队列） |
| 图谱提取 | 不需要 embedding | — |

---

## 6. 规则层 Fallback

LLM 不可用时（未配置 / 超 budget / 超时 / 错误），自动降级到规则提取：

```typescript
async function extractGraphWithFallback(input: LlmExtractionInput, deps: ExtractorDeps): Promise<ExtractionResult> {
  if (!deps.llmClient.available || deps.budget.exhausted()) {
    return ruleBasedExtract(input);  // 现有规则逻辑
  }
  try {
    const raw = await deps.llmClient.complete(buildPrompt(input), { responseFormat: "json" });
    const parsed = parseAndValidate(raw, input.text);
    return resolve(parsed, input.scope);
  } catch (err) {
    logger.warn("LLM extraction failed, fallback to rules", err);
    return ruleBasedExtract(input);
  }
}
```

---

## 7. 历史会话导入（ms import）

基于上述提取管道，新增 `ms import` 命令：

### 7.1 命令接口

```bash
# 从 openclaw 会话目录导入
ms import --source openclaw --agent main

# 从指定 JSONL 文件导入
ms import --file ~/.openclaw/agents/main/sessions/xxx.jsonl

# 从所有 agent 导入
ms import --source openclaw --all

# dry-run 预览
ms import --source openclaw --agent main --dry-run
```

### 7.2 处理流程

```
JSONL 文件
  → 解析事件流，过滤只保留 type=message 的 user/assistant 对话
  → 按对话轮次组合（user + assistant 为一组）
  → 文本切分（复用 text-splitter，chunkSize=2000 适配对话场景）
  → 每个 chunk：
      1. embedBatch() → vector → storeMemory()    [向量化入库]
      2. enqueue extract_graph job                  [LLM 提取三元组]
  → 记录 session 处理进度到 ~/.mengshu/import-state.json
  → 完成后报告统计
```

### 7.3 JSONL 解析器

```typescript
interface ParsedMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  sessionId: string;
}

function parseSessionJsonl(filePath: string): ParsedMessage[] {
  // 逐行读取，只保留 type=message 且 role=user/assistant
  // 提取 message.content[].text
  // 过滤空消息和系统事件（model_change/thinking_level_change/custom）
}
```

### 7.4 增量导入

`~/.mengshu/import-state.json`：
```json
{
  "openclaw": {
    "agents/main/sessions/xxx.jsonl": {
      "status": "done",
      "chunksProcessed": 42,
      "importedAt": "2026-06-14T..."
    },
    "agents/main/sessions/yyy.jsonl": {
      "status": "in-progress",
      "lastOffset": 1024
    }
  }
}
```

---

## 8. LLM Client 接口扩展

当前 `LlmClient` 只有 `complete` 和 `summarize`。新增：

```typescript
interface LlmClient {
  // 已有
  complete(messages: LlmCompletionMessage[], options?: LlmCompletionOptions): Promise<string>;
  summarize(text: string, instruction: string): Promise<string>;
  readonly available: boolean;

  // 新增
  extractStructured<T>(
    messages: LlmCompletionMessage[],
    schema: JsonSchema,
    options?: LlmCompletionOptions,
  ): Promise<T>;
}
```

`extractStructured` 使用 OpenAI 兼容的 `response_format: { type: "json_schema", json_schema: schema }` 或 function calling，确保输出严格符合 schema。不支持 structured output 的模型（如部分国产）退化到 `complete` + JSON.parse + 校验重试。

---

## 9. 配置变更

`config.json` 中 LLM 从可选变为必选：

```json
{
  "embedding": { "apiKey": "...", "baseURL": "...", "model": "..." },
  "llm": {
    "apiKey": "...",
    "baseURL": "...",
    "model": "gpt-4o-mini",
    "maxTokens": 4096,
    "temperature": 0.1,
    "dailyBudgetTokens": 1000000,
    "extractionModel": "gpt-4o-mini",
    "summarizationModel": "gpt-4o-mini"
  },
  "dbType": "lancedb"
}
```

新增字段：
- `llm.dailyBudgetTokens`：每日 token 预算，超限后图谱提取降级到规则
- `llm.extractionModel`：可选，图谱提取使用的模型（可以和 summarization 用不同模型）
- `llm.summarizationModel`：可选，摘要使用的模型

---

## 10. 实施阶段

| 阶段 | 内容 | 依赖 | 产出 |
|------|------|------|------|
| **P1** | LlmClient 接口扩展 + extractStructured 实现 | 无 | `processing/llm-client.ts` |
| **P2** | LLM Extractor 核心实现 | P1 | `graph/llm-extractor.ts` |
| **P3** | Extraction Validator | P2 | `graph/extraction-validator.ts` |
| **P4** | Entity Resolver（去重合并） | P3 | `graph/entity-resolver.ts` |
| **P5** | extract_graph job + 队列集成 | P2-P4 | `jobs/extract-graph-job.ts` |
| **P6** | autoCapture 链路接入 | P5 | `adapters/openclaw/hooks.ts` 修改 |
| **P7** | ms import 命令 + JSONL 解析 | P5 | `adapters/openclaw/cli-import.ts` |
| **P8** | ingest pipeline 接入 | P5 | `ingest/` 修改 |
| **P9** | 测试 + eval | 全部 | 单元测试 + 黄金集 |

---

## 11. 成功标准

| 指标 | 目标 |
|------|------|
| 实体类型覆盖 | ≥ 8/14 种 EntityType 有实际数据 |
| 关系谓词覆盖 | ≥ 6/11 种 RelationPredicate 有实际数据 |
| 提取准确率 | 人工抽样 50 条，正确率 ≥ 80% |
| 提取延迟 | 单 chunk P95 < 3s（mini 模型） |
| 规则 fallback 率 | 正常运行时 < 5%，无 LLM 时 100% |
| 历史导入吞吐 | ≥ 10 sessions/min |
| 成本控制 | gpt-4o-mini 下单 chunk 平均 < 1000 tokens |

---

## 12. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| LLM 输出不稳定，JSON 解析失败 | 图谱数据丢失 | 重试 2 次 + 规则 fallback + extractStructured 强制 schema |
| 模型幻觉产生不存在的实体/关系 | 图谱噪音 | evidence 必须在原文可追溯；confidence < 0.5 标记 weak |
| 成本超预期 | 费用失控 | dailyBudgetTokens 硬限 + chunk 长度过滤 + 短文本跳过 |
| 国产模型 JSON output 不稳定 | 部分用户无法使用 | 退化到 complete + JSON.parse + 校验重试（最多 3 次） |
| 大量历史数据导入阻塞系统 | 正常使用受影响 | import 使用 low priority + 独立并发池 |
