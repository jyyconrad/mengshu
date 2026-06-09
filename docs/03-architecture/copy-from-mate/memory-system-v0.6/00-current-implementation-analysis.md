# banto 记忆系统现状分析（基于代码）

> **分析日期**：2026-06-01
> **代码版本**：v0.4.4（dev/banto/0.4.4 分支）
> **目的**：从代码出发，分析当前记忆系统的实际实现、问题和局限，为 v0.6 方案提供对照基准

---

## 一、系统架构总览

当前记忆系统是一个三层架构：

```
┌─────────────────────────────────────────────────────────┐
│                    注入层（Injection）                     │
│  system-prompt.ts → 全量注入 <system_memories> 块         │
│  8000 字符上限，feedback 优先 + updatedAt 倒序裁剪        │
└────────────────────────────┬────────────────────────────┘
                             │ 读取
┌────────────────────────────▼────────────────────────────┐
│                    存储层（Storage）                       │
│  ai-engine/memory/index.ts                               │
│  纯 .md 文件（YAML frontmatter + Markdown body）          │
│  模块级 Map 内存缓存                                      │
└────────────────────────────┬────────────────────────────┘
                             │ 写入
┌────────────────────────────▼────────────────────────────┐
│                    提取层（Extraction）                    │
│  ai-engine/memory/extractor/                             │
│  LLM Structured Outputs + 10s debounce + 去重黑名单       │
└─────────────────────────────────────────────────────────┘
```

---

## 二、关键文件清单

| 文件 | 职责 | 行数 |
|------|------|------|
| `ai-engine/memory/index.ts` | 核心存储层：save/delete/recall/缓存/索引重建 | ~986 |
| `ai-engine/memory/extractor/index.ts` | LLM 自动提取主流程 | ~453 |
| `ai-engine/memory/extractor/prompt.ts` | Extractor 提示词 | ~269 |
| `ai-engine/memory/extractor/schema.ts` | ExtractedMemory 类型 | ~36 |
| `ai-engine/memory/extractor/deduplicate.ts` | bigram Jaccard 去重 | ~61 |
| `ai-engine/memory/extractor/blacklist.ts` | 删除黑名单（SHA1+JSONL） | ~90 |
| `ai-engine/prompt/system-prompt.ts` | 记忆注入到 system prompt | 279-391 |
| `ai-engine/workflow/vibe.ts` | 对话循环结束触发提取（第13步） | 736-757 |
| `modules/memory/index.ts` | IPC handler（CRUD/list/stats） | ~497 |
| `modules/memory/push.ts` | 主→渲染事件推送 | ~92 |

---

## 三、存储格式（实际）

### 3.1 目录结构

```
~/.iflymate/memory/
├── MEMORY.md                    # 全局索引（按 type 分组的列表）
├── .deleted.jsonl               # 删除黑名单（SHA1 哈希）
├── .cleanup-state.json          # 清理状态
├── user_*.md                    # 全局 user 类型记忆
├── feedback_*.md                # 全局 feedback 类型记忆
├── reference_*.md               # 全局 reference 类型记忆
└── projects/
    └── <projectId>/
        ├── MEMORY.md            # 项目索引
        ├── project_*.md         # 项目记忆
        └── _sessions/
            └── <sessionId>/     # 会话分区（实际未使用）
                └── *.md
```

### 3.2 单条记忆文件格式

```markdown
---
name: prefer-concise-output
description: 用户偏好简洁输出，不要冗长解释
type: feedback
updatedAt: 2026-05-28T14:30:00+08:00
source:
  sessionId: sess_abc123
  messageIndex: 5
---

用户明确表示不喜欢长篇大论的回答，偏好简洁直接的输出风格。
```

### 3.3 索引文件格式（MEMORY.md）

每次 save/delete 后自动重建，按 type 分组的 Markdown 列表：

```markdown
## feedback
- [feedback_prefer-concise-output.md](feedback_prefer-concise-output.md) — 用户偏好简洁输出 (2026-05-28)

## user
- [user_frontend-engineer.md](user_frontend-engineer.md) — 用户是前端工程师 (2026-05-20)
```

---

## 四、写入机制（实际）

### 4.1 唯一自动触发点

对话循环结束后（`vibe.ts` 第 13 步）→ `enqueueExtraction()` → 10s debounce → `runExtraction()`

### 4.2 提取流程

1. 取最近 **12 条消息**（约 6 轮对话）
2. 加载已有记忆清单（最多 30 条 type/name/description）作为上下文
3. 调用主对话同款 LLM，system prompt 为英文 Extractor 提示词
4. 输出纯 JSON `{"memories":[...]}`，最多 5 条候选
5. 每条候选 confidence ≥ 0.7 才落盘
6. bigram Jaccard 相似度 > 0.8 视为重复，跳过
7. 检查删除黑名单（SHA1 哈希），命中则丢弃
8. 支持 `supersedes` 字段实现"偏好覆盖更新"

### 4.3 限流

- 全局每日 100 次（进程内计数，重启归零）
- 同 session 10s debounce 合并

### 4.4 手动写入

前端通过 `memory:save` IPC channel，`manual: true` 标记，直接写入。

---

## 五、读取/注入机制（实际）

### 5.1 注入方式：全量注入

`system-prompt.ts` 的 `getMemoryPrompt(projectDir)` 实现：

1. 加载全局记忆（A 段）+ 项目记忆（B 段）
2. **不含 session 分区**
3. 排序：feedback 类型优先，其次按 updatedAt 倒序
4. 裁剪：总长度超 8000 字符时从末尾逐条裁剪，优先裁 B 段
5. 单条内容超 1000 字符时截断
6. 注入格式：`<system_memories>` XML 标签包裹

### 5.2 已实现但闲置的能力

`recallMemory()` 函数已实现多因子评分：
- 名称精确匹配（+10）
- 描述匹配（+5）
- 内容匹配（+2）
- 词级 Jaccard 相似度（×3）
- 30 天线性时间衰减（+0~1）

**但这个函数当前无调用方**——system prompt 注入走的是全量加载路径。

---

## 六、Session 分区与晋升（实际）

### 6.1 代码存在但未启用

- `saveMemory` 支持 `activeSessionId` 参数写入 `_sessions/<sid>/`
- `promoteSessionMemory` 函数已实现（复制到项目共享区）
- **但 Extractor 当前直接写项目共享区**（`activeSessionId: undefined`）
- 代码注释明确说"晋升机制未实现"

### 6.2 实际效果

Session 分区只有 UI 展示用途，自动提取的记忆全部直接进入项目共享区。

---

## 七、问题清单（按严重程度排序）

### 严重（影响核心体验）

| # | 问题 | 代码证据 | 影响 |
|---|------|----------|------|
| 1 | **全量注入无语义召回** | `system-prompt.ts:279-391` 全量加载 + 8000 字符裁剪 | 记忆增多后，相关记忆被裁掉，不相关记忆占位 |
| 2 | **recallMemory 完全闲置** | `index.ts:265-303` 已实现但无调用方 | 已有的多因子评分能力浪费 |
| 3 | **Session 晋升机制未实现** | `extractor/index.ts:291` 注释"晋升机制未实现" | 所有记忆直接进项目共享区，无分层过滤 |
| 4 | **无关系/图谱能力** | 整个 memory 模块无 edge/relation 概念 | 无法追溯决策链、无法表达记忆间关系 |
| 5 | **无摘要/折叠能力** | 无 L1 摘要概念 | 记忆只增不减（除手动删除），长期使用后噪音累积 |

### 中等（影响效率和可维护性）

| # | 问题 | 代码证据 | 影响 |
|---|------|----------|------|
| 6 | **路径逻辑重复实现** | `ai-engine/memory/index.ts` 和 `modules/memory/index.ts` 各写一份 | 修改路径规则时容易漏改 |
| 7 | **每日 100 次限流无提示** | `extractor/index.ts:49` DAILY_LIMIT=100，进程内计数 | 高频用户触达上限后当天不再提取，无 UI 提示 |
| 8 | **supersedes scope 推断简化** | extractor 中 type→scope 映射 | feedback/reference 类型可能跨 scope 删除错误 |
| 9 | **无版本历史** | 记忆更新直接覆盖文件 | 无法回溯"为什么改了这个偏好" |
| 10 | **无置信度衰减** | confidence 写入后不再变化 | 旧记忆永远高置信度占位 |

### 轻微（可改进但不紧急）

| # | 问题 | 代码证据 | 影响 |
|---|------|----------|------|
| 11 | **Jaccard 去重实现重复** | `memory/index.ts` 和 `extractor/deduplicate.ts` 各写一份 | 代码冗余 |
| 12 | **缓存失效不完整** | `promoteSessionMemory` 未失效 session 分区缓存 | 晋升后缓存不一致（当前无实际影响因为晋升未启用） |
| 13 | **无自动化记忆层** | 无 automation 容器概念 | 定时任务的执行记录无法独立管理 |

---

## 八、当前能力边界总结

### 已有能力（可复用）

| 能力 | 实现质量 | 可复用性 |
|------|----------|----------|
| YAML frontmatter MD 文件读写 | 成熟 | 高 |
| 4 类记忆类型（user/feedback/project/reference） | 成熟 | 高 |
| LLM 自动提取 + confidence 阈值 | 成熟 | 高 |
| bigram Jaccard 去重 | 可用 | 中 |
| 删除黑名单（防写回拉锯） | 成熟 | 高 |
| supersedes 偏好覆盖 | 成熟 | 高 |
| 模块级内存缓存 | 可用 | 中 |
| MEMORY.md 索引自动重建 | 成熟 | 高 |
| 多因子评分（recallMemory） | 已实现 | 高（但闲置） |
| IPC CRUD + 前端 UI | 成熟 | 高 |

### 完全缺失的能力

| 能力 | v0.6 方案中的对应 |
|------|-------------------|
| 节点间关系（edges） | 5 类关系 + edges/ 目录 |
| 摘要折叠（L1） | 二维记忆模型 L0/L1 |
| 分层召回（必读/任务相关/按需） | 三层召回模型 |
| 版本历史 | version 字段 + 历史区块 |
| 升格机制（会话→项目→全局） | 三种升格路径 |
| 模式识别 + Skill 候选 | chat-end 阶段 2 |
| 主动观察与建议 | chat-end 阶段 3 |
| 热度信号（hotness） | 复合排序公式 |
| JSON 结构化存储 | md+json 双存 |
| 多维索引 | by-type/confidence/hotness/time |

---

## 九、能力分层：记忆系统 vs 资料系统

### 核心原则：向量化能力下放到"资料"系统

embedding/向量检索**不是删除**，而是**归类和下放**：

| 能力 | 归属系统 | 实现方式 |
|------|----------|----------|
| 向量化语义检索 | **资料系统**（个人库/企业库） | 资料系统已有 embedding 能力 |
| 文件元数据召回 | **记忆系统** | 关键词 + Jaccard + 标签 + 图谱遍历 |
| 全文语义搜索 | **资料系统** | 通过 `kb_get_context` MCP 工具 |
| 结构化图谱查询 | **记忆系统** | 纯文件 JSON 索引 + 关系遍历 |

**边界**：记忆系统负责"工作上下文的结构化管理"，资料系统负责"大规模内容的语义检索"。两者通过 `reference` 类型节点的 `knowledgeBaseRef` 字段桥接。

### 记忆系统的召回策略（纯文件元数据驱动）

```
task_relevance 计算（基于文件元数据，不依赖 embedding）：

1. 关键词匹配分（0-1）：
   - 从当前对话提取关键词（实体名、项目名、技术术语）
   - 与记忆的 title/tags/body 做关键词命中率

2. 标签交集分（0-1）：
   - 当前任务标签 ∩ 记忆标签 / 当前任务标签总数

3. 图谱距离分（0-1）：
   - 当前活跃节点到候选节点的最短路径（1跳=1.0, 2跳=0.5, 3跳=0.25, 无路径=0）

4. 容器匹配分（0-1）：
   - 同项目=1.0, 同全局=0.5, 跨项目=0.2

最终：task_relevance = max(关键词分, 标签分) × 0.6 + 图谱距离分 × 0.3 + 容器匹配分 × 0.1
```

### 需要深度语义检索时的协作路径

当记忆系统的元数据召回不够用时（如"之前讨论过类似问题吗？"），通过资料系统补充：

```
用户提问 → 记忆系统元数据召回（快，毫秒级）
         → 如果结果不足 → 通过 kb_get_context 调用资料系统语义检索（慢，秒级）
         → 合并结果注入上下文
```

---

## 十、从现状到 v0.6 的增量路径

基于"已有能力可复用 + 完全缺失需新建"的分析，建议实施顺序：

| 阶段 | 改动 | 复用现有 | 新建 |
|------|------|----------|------|
| **P0** | recallMemory 改造 + 分层召回 | recallMemory 多因子评分 | 改造 system-prompt.ts 注入逻辑 |
| **P0** | Session 晋升机制启用 | promoteSessionMemory 函数 | 触发条件判定 + Extractor 写入 session 分区 |
| **P0** | 元数据摘要折叠（轻量 L1） | MEMORY.md 索引重建 | 基于元数据的摘要生成 + 分层目录 |
| **P0** | JSON 双存 | YAML frontmatter 解析 | 每条记忆同时写 .json |
| **P1** | 新增 edges/ 关系目录 | 无 | 关系 schema + 读写逻辑 |
| **P1** | 多维索引 | MEMORY.md 索引 | by-type/hotness/time JSON 索引 |
| **P2** | chat-end 四阶段 | 现有 chat-end 提取 | 阶段 1.5/2/3 新增 |
| **P3** | 主动观察与建议 | 无 | insights/ 目录 + 推送机制 |

**P0 详细设计**见 [06-p0-implementation-plan.md](./06-p0-implementation-plan.md)。
