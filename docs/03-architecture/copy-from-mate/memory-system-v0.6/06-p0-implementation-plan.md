# P0 实施方案：记忆系统核心升级

> **文档版本**: v0.6-rev11
> **更新时间**: 2026-06-02
> **状态**：设计中（不写代码）
> **前置依赖**：[00-current-implementation-analysis.md](./00-current-implementation-analysis.md)
> **约束**：纯文件方案（md+json），不引入向量化；向量检索能力归属"资料"系统（个人库/企业库）

---

## 重要变更说明（v0.6-rev11）

> **v0.6-rev11 同步更新**：
> - JSON 双存（子任务 D）示例更新为 5 type 体系 + `lifecycleStatus` + `dimension_fields` + `evidenceQuotes` + `relations`
> - Extractor 输出 schema（第六节 6.2）更新为统一 `memories: [...]` 数组格式 + 各 type 特有字段
> - frontmatter 新增字段表（第六节 6.1）补 `lifecycleStatus` / `evidenceQuotes` / `dimension` / `value` / `supersededBy` / `promotedToSkillId`
> - 引用计数追踪（第六节 6.3）补充"必读层固定注入不计 referenceCount"

## 重要变更说明（v0.6-rev7）

> 本文档原"4 子任务（recallMemory 改造、分层召回、Session 晋升、元数据摘要折叠）"已扩展为 **5 子任务**，新增子任务 E：5 type 体系落地与迁移。
>
> **新 P0 范围**：
> 1. **子任务 E（新增）**：5 type 体系落地（profile/task-context/rules/experience/resource）+ 旧记忆迁移
> 2. **子任务 A**：recallMemory 改造 + 5 槽位注入（替代原"分层召回"）
> 3. **子任务 B**：Session 候选区机制（替代原"Session 晋升"）
> 4. **子任务 C**：元数据摘要折叠（轻量 L1，按 type 分组生成）
> 5. **子任务 D**：JSON 双存

---

## 一、P0 目标与边界

### 1.1 解决的核心问题

| # | 问题 | 当前影响 | P0 解决方式 |
|---|------|----------|-------------|
| 1 | type 碎片化（user/feedback/project/reference 语义重叠） | agent 不知道召回什么 | **5 type 体系落地（子任务 E）** |
| 2 | 全量注入无语义召回 | 记忆多了相关的被裁掉 | recallMemory 改造 + 5 槽位注入 |
| 3 | recallMemory 完全闲置 | 已有能力浪费 | 启用并升级评分逻辑 |
| 4 | Session 晋升未实现 | 所有记忆直接进共享区 | 启用候选区 + 晋升规则 |
| 5 | 记忆只增不减 | 噪音累积 | 元数据摘要折叠（轻量 L1，按 type 分组） |
| 6 | 无 JSON 结构化存储 | 无法多维索引 | 写入时同步生成 .json |

### 1.2 不在 P0 范围

- edges/关系目录（P1）
- chat-end 阶段 2/3 模式识别与主动建议（P2/P6）
- insights/ 目录（P2/P6）
- 前端 UI 重构（按需跟进）
- 向量化检索（归属资料系统）
- 远程同步缓存（P1-P3）
- 双端架构（P1-P3）

---

## 一·二、子任务 E（新增）：5 type 体系落地

### E.1 目标

把当前"4 类型 + 散落字段"的记忆体系迁移为"5 type 体系"：

| 旧 type | 含义 | 新 type | 拆分规则 |
|---------|------|---------|---------|
| `user` | 用户身份偏好 | `profile` | 全部迁移 |
| `feedback` | 反馈约束/偏好 | `profile` + `rules` | 偏好语句 → profile，约束语句 → rules |
| `project` | 项目目标/决策 | `task-context` + `experience` | 目标/阶段 → task-context，决策依据 → experience |
| `reference` | 外部系统指针 | `resource` | 全部迁移，扩展 subType 字段 |

### E.2 改造内容

| 改造点 | 说明 |
|--------|------|
| **Schema 变更** | 引入新 type 字段（profile/task-context/rules/experience/resource/summary）；resource 扩展 subType；新增 relatedResourceId 字段 |
| **Extractor 升级** | LLM Prompt 强制要求输出 5 type 之一，否则记忆不入库 |
| **目录重组** | 容器内按 type 分子目录（global/profile/、global/rules/...） |
| **迁移脚本** | 旧记忆按规则自动 + 用户审核迁移到新 type |
| **向后兼容** | 保留 `_archived_legacy/` 目录存原文件，支持回滚 |

### E.3 迁移规则

```
现有 user 类型 → profile（直接迁移）
现有 feedback 类型：
  - 含"喜欢/偏好/习惯/希望"关键词 → profile
  - 含"不要/禁止/必须/约束/规范/不能"关键词 → rules
  - 模糊条目 → 留待用户审核（写入 _migration_pending/）
现有 project 类型：
  - 含"目标/阶段/范围/客户约束/里程碑"关键词 → task-context
  - 含"决定/选择/原因/因为/考虑到"关键词 → experience
  - 模糊条目 → 留待用户审核
现有 reference 类型 → resource（扩展 subType=external_system 默认）
```

### E.4 改造涉及的文件

| 文件 | 改动 |
|------|------|
| `ai-engine/memory/index.ts` | type 枚举改为 5 type；新增 subType 字段处理 |
| `ai-engine/memory/extractor/schema.ts` | ExtractedMemory 类型 type 改为 5 type 枚举 |
| `ai-engine/memory/extractor/prompt.ts` | LLM Prompt 强制要求 5 type 标注 + reason 字段 |
| `ai-engine/memory/migration.ts`（新增） | 迁移脚本主逻辑 |
| `ai-engine/prompt/system-prompt.ts` | 注入逻辑改为按 5 type 读取 |

### E.5 验收标准

- 所有新写入记忆必须有合法 type（5 type 之一）
- 旧记忆 100% 完成迁移（自动 + 用户审核）
- agent system prompt 中按 5 type 分类显示

---

## 二、子任务 A：recallMemory 改造 + 5 槽位注入

### 2.1 现状

```typescript
// ai-engine/memory/index.ts:265-303（当前实现，完全闲置）
export async function recallMemory(params: RecallMemoryParams): Promise<MemoryEntry[]> {
  // 全量加载 → 多因子评分 → top-N
  // 评分：名称匹配(+10) + 描述匹配(+5) + 内容匹配(+2) + 词Jaccard(×3) + 时间衰减(+0~1)
}

// ai-engine/prompt/system-prompt.ts:279-391（当前注入方式）
// getMemoryPrompt(projectDir) → 全量加载 → 8000字符裁剪 → 注入
```

### 2.2 改造目标

将 `getMemoryPrompt` 从"全量加载 + 裁剪"改为"5 槽位注入 + 任务相关召回"：

```
┌──────────────────────────────────────────────────────────┐
│ 必读层 4000 字符（5 槽位结构，每槽对应一个本质问题）       │
├──────────────────────────────────────────────────────────┤
│ [槽 1] profile L1     ~600 字符  - Q1 我为谁工作          │
│ [槽 2] task-context L1 ~1000 字符 - Q2 我在做什么         │
│ [槽 3] rules 全量   ~1000 字符 - Q3 什么不能做         │
│ [槽 4] resource L1     ~600 字符  - Q5 有什么资源         │
│ [槽 5] experience top-3 ~800 字符 - Q4 之前怎么做过       │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ 任务相关层（Task-Relevant Recall）                         │
│ 预算：3000 字符                                            │
│ 内容：必读层未覆盖的 rules/experience/resource 细节     │
│ 来源：调用改造后的 recallMemory，传入对话关键词             │
│ 排序：复合分 = hotness × 0.35 + confidence × 0.30         │
│       + task_relevance × 0.30 + user_signal × 0.05        │
└──────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────┐
│ 按需检索层（On-Demand, 未来 P1）                           │
│ 预算：1000 字符/次                                        │
│ 内容：agent 通过 memory_query 工具按 type 主动查询         │
└──────────────────────────────────────────────────────────┘
```

5 槽位组装详见 [03-runtime-mechanisms.md 第五节](./03-runtime-mechanisms.md)。


### 2.3 recallMemory 评分升级

**现有评分**（保留并增强）：

```
现有分 = 名称匹配(+10) + 描述匹配(+5) + 内容匹配(+2) + 词Jaccard(×3) + 时间衰减(+0~1)
```

**升级为复合分**：

```
score = α × hotness + β × confidence + γ × task_relevance + δ × user_signal

默认权重：α=0.35, β=0.30, γ=0.30, δ=0.05
```

**各维度计算方式（纯文件元数据，不依赖 embedding）**：

| 维度 | 计算方式 | 数据来源 |
|------|----------|----------|
| **hotness** | `recency × 0.5 + frequency × 0.5` | `updatedAt` + `referenceCount`（新增字段） |
| **confidence** | 直接读取 | 现有 frontmatter `confidence` 字段 |
| **task_relevance** | 关键词命中率 + 标签交集 + 容器匹配 | 对话关键词 vs 记忆 title/tags/body |
| **user_signal** | 手动标记权重 | `manual: true` → 1.0, 否则 0.0 |

**hotness 公式**：

```
recency = exp(-Δt / 30)        // Δt=距上次引用天数，30天半衰期
frequency = log(1 + refCount) / log(1 + maxRefCount)  // 对数归一化
hotness = recency × 0.5 + frequency × 0.5
```

**task_relevance 公式**（纯文件元数据）：

```
keyword_score = 命中关键词数 / 对话总关键词数     // 0-1
tag_score = |对话标签 ∩ 记忆标签| / |对话标签|   // 0-1
container_score = 同项目?1.0 : 全局?0.5 : 0.2

task_relevance = max(keyword_score, tag_score) × 0.7 + container_score × 0.3
```

### 2.4 对话关键词提取（低成本方案）

不用额外 LLM 调用，直接从当前对话中提取：

```
1. 取最近 3 条用户消息
2. 提取：
   - 实体名（大写开头的词、引号内内容）
   - 项目名（匹配已知 projectId）
   - 技术术语（出现在现有记忆 tags 中的词）
3. 去停用词（的、了、是、一个、这个...）
4. 得到 keywords: string[]（通常 3-8 个）
```

### 2.5 改造涉及的文件

| 文件 | 改动 |
|------|------|
| `ai-engine/memory/index.ts` | 升级 `computeRelevanceScore` 为复合分；新增 `referenceCount` 字段追踪 |
| `ai-engine/prompt/system-prompt.ts` | `getMemoryPrompt` 从全量注入改为分层注入；必读层直读 + 任务相关层调 `recallMemory` |
| `ai-engine/memory/index.ts` | 新增 `extractKeywords(messages)` 工具函数 |
| frontmatter schema | 新增 `referenceCount`、`lastAccessedAt` 字段 |

### 2.6 向后兼容

- 现有记忆文件无 `referenceCount` 字段 → 默认 0
- 现有记忆无 `tags` 字段 → keyword_score 仍可匹配 title/body
- 必读层保证全局 feedback 一定注入（与现行为一致）
- 总预算 7000 字符 < 现有 8000，给未来按需检索层留余量

---

## 三、子任务 B：Session 晋升机制启用

### 3.1 现状

```typescript
// extractor/index.ts — 当前直接写项目共享区
// activeSessionId: undefined  ← 注释说"晋升机制未实现"

// ai-engine/memory/index.ts:751-786 — promoteSessionMemory 已实现
// 功能：把 _sessions/<sid>/ 下的文件复制到项目共享区
```

### 3.2 改造目标

1. **Extractor 写入 session 分区**：自动提取的记忆先写入 `_sessions/<sid>/`
2. **晋升规则判定**：满足条件时自动晋升到项目共享区
3. **用户手动保存**仍直接写项目/全局（保持现有行为）

### 3.3 晋升规则

| 规则 | 条件 | 说明 |
|------|------|------|
| **自动晋升** | confidence ≥ 0.9 | 高置信度记忆直接晋升，无需等待 |
| **累积晋升** | 同一记忆被 ≥ 2 个 session 重复提取 | 跨会话验证的记忆价值更高 |
| **用户确认晋升** | 用户在 UI 点击"保留" | 现有 UI 的"保留"按钮触发 promote |
| **会话结束清理** | 会话结束后 7 天未晋升 | session 分区记忆自动归档（不删除，移入 `_archived/`） |

### 3.4 实现流程

```
会话进行中：
  Extractor 提取 → confidence ≥ 0.9? → 是 → 直接写项目共享区（现有行为）
                                      → 否 → 写入 _sessions/<sid>/

会话结束时（chat-end 阶段 1）：
  扫描 _sessions/<sid>/ 中所有记忆
  → 检查"累积晋升"：该记忆的 description 是否在其他 session 中出现过？
  → 满足 → 调用 promoteSessionMemory() 晋升
  → 不满足 → 保持 session 分区

7天后 TTL：
  session 分区记忆 → 移入 _sessions/<sid>/_archived/
  不删除（保证可逆性）
```

### 3.5 改造涉及的文件

| 文件 | 改动 |
|------|------|
| `ai-engine/memory/extractor/index.ts` | `enqueueExtraction` 传入 `activeSessionId`；confidence < 0.9 时写 session 分区 |
| `ai-engine/memory/index.ts` | `promoteSessionMemory` 增加"累积晋升"检测逻辑 |
| `modules/memory/index.ts` | 新增 `memory:promote` IPC handler（前端调用） |
| `ai-engine/memory/index.ts` | 新增 `archiveExpiredSessions(projectDir, ttlDays=7)` |

### 3.6 注入时的读取变化

必读层 + 任务相关层 **不含 session 分区**（保持现有行为）：
- 只有"当前活跃 session"的记忆才在当前对话中可见
- 已归档的 session 记忆不参与召回（除非通过按需检索工具主动查询）

---

## 四、子任务 C：元数据摘要折叠（轻量 L1）

### 4.1 设计思路

v0.6 完整方案的 L1 是用 LLM 生成的语义摘要。P0 阶段做**轻量版**：基于文件元数据（非 LLM）自动生成结构化摘要索引，作为必读层的注入内容。

| 维度 | 完整 L1（P2） | 轻量 L1（P0） |
|------|---------------|---------------|
| 生成方式 | LLM streamText | 元数据聚合（纯代码） |
| 内容 | 语义摘要文本 | 结构化统计 + 标题列表 |
| 触发时机 | chat-end 阶段 1.5 | 每次记忆写入/删除后增量更新 |
| 存储位置 | `L1/{time,topic,container}/` | `_summary.json`（每个容器一个） |
| 用途 | 必读层注入 + 模式识别输入 | 必读层注入（token 高效） |

### 4.2 `_summary.json` 结构

每个记忆容器目录下生成一个 `_summary.json`：

```json
{
  "containerType": "project",
  "containerId": "proj_xyz789",
  "generatedAt": "2026-06-01T10:00:00+08:00",
  "stats": {
    "totalCount": 15,
    "byType": { "feedback": 8, "project": 5, "reference": 2 },
    "avgConfidence": 0.84,
    "oldestMemory": "2026-03-15",
    "newestMemory": "2026-06-01"
  },
  "topMemories": [
    {
      "name": "no-any-type",
      "type": "feedback",
      "description": "禁止使用 any 类型",
      "confidence": 0.95,
      "referenceCount": 5,
      "hotness": 0.87
    }
  ],
  "recentChanges": [
    {
      "name": "prefer-concise-output",
      "action": "created",
      "date": "2026-06-01"
    }
  ],
  "tagCloud": ["typescript", "code-quality", "vue", "testing"]
}
```

### 4.3 摘要注入格式（必读层使用）

```markdown
## 项目记忆概览（proj_xyz789）
- 记忆总数：15 条（feedback:8, project:5, reference:2）
- 近期变更：+prefer-concise-output (6/1)
- 高频主题：typescript, code-quality, vue, testing
- 核心约束：禁止使用 any 类型(0.95), 优先组合式 API(0.90), ...
```

**token 效率对比**：
- 现行全量注入 15 条记忆 → 约 3000-5000 字符
- 摘要注入 → 约 200-400 字符（节省 80%+ token）
- 剩余预算给任务相关层精选具体记忆

### 4.4 生成时机

| 时机 | 操作 |
|------|------|
| `saveMemory` 后 | 增量更新 `_summary.json`（添加到 topMemories/recentChanges） |
| `deleteMemory` 后 | 增量更新（从列表中移除） |
| `promoteSessionMemory` 后 | 目标容器的 `_summary.json` 刷新 |
| 应用启动时 | 全量重建一次（兜底） |

### 4.5 topMemories 选取规则

```
从容器内所有记忆中，按以下规则选取 top 5-10 条：
1. 优先 feedback 类型（用户约束必须可见）
2. 其次按 hotness 倒序
3. 同分时按 confidence 倒序
4. 上限 10 条
```

### 4.6 改造涉及的文件

| 文件 | 改动 |
|------|------|
| `ai-engine/memory/index.ts` | 新增 `updateSummary(memoryDir)` + `buildSummary(entries)` |
| `ai-engine/memory/index.ts` | `saveMemory`/`deleteMemory` 末尾调用 `updateSummary` |
| `ai-engine/prompt/system-prompt.ts` | 必读层读取 `_summary.json` 渲染为 Markdown 概览 |

---

## 五、子任务 D：JSON 双存

### 5.1 设计思路

每条记忆写入时，同时生成 `.md`（人类可读，保持现有格式）和 `.json`（结构化查询）。

### 5.2 JSON 文件格式

```json
{
  "id": "rules_no-any-type",
  "level": "L0",
  "type": "rules",
  "container": "project",
  "containerId": "proj_xyz789",
  "name": "no-any-type",
  "title": "禁止使用 any 类型",
  "body": "TypeScript 代码中不得使用 any，必须显式声明类型",
  "tags": ["typescript", "code-quality"],
  "dimension_fields": {
    "source": "personal",
    "strength": "hard",
    "consequence": "medium"
  },
  "metadata": {
    "confidence": 0.95,
    "lifecycleStatus": "active",
    "source": "chat-end-extraction",
    "manual": false,
    "createdAt": "2026-05-29T10:30:00+08:00",
    "updatedAt": "2026-05-29T10:30:00+08:00",
    "version": 1,
    "evidenceQuotes": ["不要用 any", "类型必须显式声明"]
  },
  "stats": {
    "referenceCount": 5,
    "lastAccessedAt": "2026-06-01T14:20:00+08:00"
  },
  "relations": {
    "relatedResourceId": null,
    "supersededBy": null
  }
}
```

**各 type 特有的 `dimension_fields`**：

| Type | dimension_fields 内容 |
|------|----------------------|
| `profile` | `{dimension, value}` |
| `task-context` | `{dimension}` — goal_structure / role_relation / constraint_context |
| `rules` | `{source, strength, consequence}` |
| `experience` | `{causality: {what, why, outcome}, transferability, memoryType}` |
| `resource` | `{cognitionAgent, subType, metaKnowledge, trustLevel, entryPoint}` |

### 5.3 双存同步规则

| 操作 | .md | .json | _summary.json |
|------|-----|-------|---------------|
| 创建 | 写入（现有逻辑） | 同步写入 | 增量更新 |
| 更新 | 覆盖（现有逻辑） | 同步覆盖 | 增量更新 |
| 删除 | 删除文件 | 删除文件 | 增量更新 |
| 读取 | 仅缓存未命中时读 | 优先读 .json（更快） | 必读层直读 |

### 5.4 迁移策略

现有 `.md` 文件不强制迁移：
- 新写入的记忆自动生成 `.json`
- 读取时如果 `.json` 不存在，从 `.md` 解析 frontmatter 并补写 `.json`（lazy migration）
- `_summary.json` 在首次需要时全量生成

### 5.5 改造涉及的文件

| 文件 | 改动 |
|------|------|
| `ai-engine/memory/index.ts` | `saveMemory` 新增 `writeJsonFile` 步骤 |
| `ai-engine/memory/index.ts` | `loadAllMemories` 优先读 `.json`，fallback 读 `.md` |
| `ai-engine/memory/index.ts` | `deleteMemory` 同步删除 `.json` |

---

## 六、文件元数据扩展（支撑上述改造）

### 6.1 frontmatter 新增字段

| 字段 | 类型 | 默认值 | 用途 |
|------|------|--------|------|
| `tags` | string[] | [] | 关键词标签，供 task_relevance 计算 |
| `referenceCount` | number | 0 | 被引用次数，供 hotness 计算 |
| `lastAccessedAt` | string | null | 上次被注入的时间，供 recency 计算 |
| `version` | number | 1 | 版本号，供未来回溯 |
| `lifecycleStatus` | enum | "active" | 统一生命周期状态（active / archived / revoked / superseded / promoted） |
| `evidenceQuotes` | string[] | [] | 用户原话引用（≤2 条，每条 ≤50 字），供下钻回溯 |
| `dimension` | string | — | 记忆所属维度（仅 profile / task-context 适用） |
| `value` | string | — | 维度取值（仅 profile 适用，含 balanced / context_switching / unknown） |
| `supersededBy` | string | — | 取代本节点的新节点 id（lifecycleStatus=superseded 时填写） |
| `promotedToSkillId` | string | — | 晋升到的 SKILL id（lifecycleStatus=promoted 时填写） |

### 6.2 Extractor 输出扩展

Extractor 的 LLM 输出 schema 已升级为 5 type 体系 + 统一数组格式（v0.6-rev11）：

```json
{
  "memories": [
    {
      "type": "rules",
      "source": "personal",
      "strength": "hard",
      "consequence": "medium",
      "title": "禁止使用 any 类型",
      "body": "TypeScript 代码中不得使用 any，必须显式声明类型",
      "confidence": 0.95,
      "reason": "用户多次强调类型安全",
      "evidenceQuotes": ["不要用 any", "类型必须显式声明"],
      "tags": ["typescript", "code-quality"],
      "scope": "project",
      "relatedResourceId": null
    },
    {
      "type": "profile",
      "dimension": "achievement_orientation",
      "value": "mastery",
      "title": "偏好质量打磨",
      "body": "更偏质量导向，优先保证代码可维护性，再考虑交付速度",
      "confidence": 0.8,
      "reason": "用户明确表达质量优先",
      "evidenceQuotes": ["我希望代码写得漂亮一点，不急着交"],
      "tags": ["code-quality", "work-style"]
    }
  ]
}
```

**与旧版差异**：
- `type` 必须为 5 type 之一（profile / task-context / rules / experience / resource）
- 输出格式统一为 `memories: [...]` 数组（一次提取可输出多条不同 type/维度的记忆）
- 每条必须含 `evidenceQuotes`（用户原话引用）
- profile 类必须含 `dimension` + `value`
- rules 类必须含 `source` + `strength`（strength=soft 前期直接丢弃）
- experience 类必须含 `causality: {what, why, outcome}`（缺 why 不入库）
- resource 类必须含 `cognitionAgent` + `trustLevel`（trustLevel=low 前期丢弃）

详见 [01 文档第三节](./01-memory-layers-and-containers.md) 各 type 提取提示词模板。

Extractor system prompt 补充 tags 提取指令（3-5 个关键词标签）。

### 6.3 引用计数追踪

每次 `recallMemory` 返回的记忆被实际注入到 system prompt 时：
- `referenceCount += 1`
- `lastAccessedAt = now()`
- 异步写回文件（不阻塞）

**例外**：必读层 5 槽位的固定注入**不计入** referenceCount——否则必读层条目永远是 hotness 最高，会把任务相关层的真实热点压下去。只有任务相关层 + 按需检索层的召回才 +1。

---

## 七、实施顺序与依赖关系

```
子任务 D（JSON 双存）      ← 最底层，其他子任务依赖结构化读写
    ↓
子任务 A（recallMemory + 分层召回） ← 依赖 JSON 读取 + stats 字段
    ↓
子任务 C（元数据摘要折叠）  ← 依赖 stats 字段 + 分层注入框架
    ↓
子任务 B（Session 晋升）    ← 依赖 Extractor 写 session 分区 + 摘要更新

实施建议顺序：D → A → C → B
```

### 7.1 具体步骤（设计阶段，不写代码）

| 步骤 | 子任务 | 改动范围 | 验证方式 |
|------|--------|----------|----------|
| 1 | D: frontmatter 扩展 + .json 双写 | `saveMemory` + `loadAllMemories` | 单元测试：写入后两个文件内容一致 |
| 2 | D: lazy migration | `loadAllMemories` | 读旧 .md 自动补 .json |
| 3 | A: `computeRelevanceScore` 升级 | 评分函数 | 单元测试：给定记忆集 + query，排序符合预期 |
| 4 | A: `getMemoryPrompt` 改造 | system-prompt.ts | 集成测试：注入内容分层正确 |
| 5 | A: 关键词提取 | 新函数 | 单元测试：从消息中提取合理关键词 |
| 6 | A: 引用计数追踪 | recall 路径 | 验证 referenceCount 递增 |
| 7 | C: `_summary.json` 生成 | 新函数 | 单元测试：从 entries 聚合出正确 summary |
| 8 | C: 必读层注入 summary | system-prompt.ts | 验证 token 用量下降 |
| 9 | B: Extractor 写 session 分区 | extractor/index.ts | 验证 confidence<0.9 写入 _sessions/ |
| 10 | B: 晋升规则 + archiveExpired | memory/index.ts | 验证晋升和归档行为 |

---

## 八、性能影响评估

| 操作 | 现有耗时 | P0 后耗时 | 变化原因 |
|------|----------|-----------|----------|
| 记忆写入 | ~5ms | ~8ms | 多写一个 .json 文件 + 更新 _summary.json |
| 记忆读取 | ~15ms（全量） | ~10ms（.json 优先） | JSON 解析比 gray-matter 快 |
| system prompt 构建 | ~20ms | ~25ms | 增加 recallMemory 调用 + keyword 提取 |
| chat-end 提取 | ~3s（LLM） | ~3s（不变） | Extractor 本身逻辑不变 |

**结论**：P0 改造对用户可感知延迟无影响（增量 < 10ms，远小于 LLM 响应时间）。

---

## 九、向后兼容保障

| 场景 | 处理方式 |
|------|----------|
| 现有 .md 文件无 tags/referenceCount | 默认值（[]/0），不强制迁移 |
| 现有记忆无 .json 对应文件 | lazy migration：首次读取时补写 |
| 现有全量注入逻辑 | 分层注入后总预算从 8000 降为 7000，但必读层保证 feedback 一定注入 |
| 现有前端 UI | 无变化（IPC 接口保持兼容） |
| 现有 MEMORY.md 索引 | 保留，继续重建（不依赖 _summary.json） |
