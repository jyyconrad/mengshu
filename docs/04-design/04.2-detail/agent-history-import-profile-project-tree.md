# Agent 历史导入、用户画像与项目记忆树方案

> 日期：2026-06-15  
> 状态：方案文档，尚未实现为稳定命令  
> 适用范围：在现有 `ms init`、5 slot Working Context、基础记忆树生成与召回能力之上，设计 Claude Code / Codex 历史记忆和工作日志的导入、画像构建、项目记忆树构建方案。  
> 关联文档：[product-roadmap.md](../../03-architecture/product-roadmap.md)、[global-config-directory-upgrade.md](../../03-architecture/global-config-directory-upgrade.md)、[structured-knowledge-graph-memory-tree-detail.md](./structured-knowledge-graph-memory-tree-detail.md)、[cli-commands.md](../../05-api/cli-commands.md)

---

## 1. 目标

本方案要解决的问题：

1. 从本机已有 Claude Code、Codex 的记忆信息、会话记录和工作日志中提取可复用工作上下文。
2. 以用户为维度构建可审计、可撤销、不过度推断的用户工作画像。
3. 以 project 为维度构建项目记忆树，让 Agent 能回答“这个项目是什么、最近做过什么、有哪些规则、踩过什么坑、有哪些资源”。
4. 与当前 `ms init`、`ms project context`、`memory_context_fast`、`lookup_deep` 能力衔接，而不是另起一套记忆系统。

非目标：

1. 不把 `ms init` 改成默认扫描全盘或默认导入历史记录。
2. 不自动读取、上传、总结所有个人数据；所有导入必须有显式命令和 dry-run 预览。
3. 不从日志推断人格、健康、政治、宗教等敏感属性；画像只记录会改变 Agent 协作行为的工作偏好和稳定约束。
4. 不把 Claude Code / Codex 的内部文件格式当成稳定公共协议；路径和解析器必须 adapter 化。
5. 不在当前阶段实现跨机器云同步。

---

## 2. 当前基线核对

截至 2026-06-15，当前仓库已经具备以下基础：

| 能力 | 当前状态 | 对本方案的影响 |
|------|----------|----------------|
| `ms init` | 已创建项目指针 `.mengshu.json`、全局 `~/.mengshu/projects/<projectId>/manifest.json` 和 registry | 可作为项目归属和 scope identity 的入口 |
| 5 slot 语义类型 | 已有 `profile / task_context / rules / experience / resource` | 导入结果应归入同一语义协议 |
| scope 复用策略 | `profile/rules/experience` 可 workspace 级复用，`task_context/resource` project 级隔离 | 用户画像和项目树的复用边界已有基础 |
| `MemoryService` | 已有 `storeMemory / recall / buildContext` | 导入后的候选和记忆写入应走统一服务 |
| 记忆树 | 已有 `source/topic/global` 类型、buffer、summary 和基础构建链路 | 项目记忆树优先复用现有三类树，不新增第四类 tree type |
| MCP / fast path | 已有 `memory_context_fast` 和 `lookup_deep` 路线 | 导入后要能被启动上下文和深度召回消费 |
| `adapters/openclaw/cli-import.ts` | 工作区存在草稿文件，但当前未接入 `index.ts` 或 `bin/ms.ts` 注册链路 | 可作为实现参考，但不能视为已交付 CLI |

当前缺口：

1. 还没有稳定的 Claude Code / Codex source adapter。
2. 还没有项目归属判定流程，不能把任意会话日志可靠映射到 `projectId`。
3. 还没有画像合并器，不能把零散偏好沉淀为稳定 profile。
4. 记忆树当前仍以 in-memory 基础能力为主，若要作为长期项目记忆树，需要持久化到 `~/.mengshu/projects/<projectId>/tree/`。
5. 还没有导入 dry-run 报告、去重状态、审计记录和用户确认流程。

---

## 3. 命令设计决策

### 3.1 不建议让 `ms init` 默认导入历史

`ms init` 当前语义是“初始化项目记忆工作区 identity”。它应保持幂等、低风险、无隐式写库副作用。

推荐行为：

```bash
ms init
```

继续只做：

1. 创建或复用项目指针。
2. 注册全局 project manifest。
3. 打印下一步建议，例如发现 Codex / Claude Code 历史路径时提示可执行导入 dry-run。

可选增强：

```bash
ms init --with-agent-history
```

该选项也不应直接写入记忆库，而是进入向导并默认执行 dry-run：

```bash
ms project ingest-history --from codex,claude-code --since 180d --dry-run
```

### 3.2 推荐新增显式导入命令

项目维度导入推荐挂在 `ms project` 下：

```bash
ms project ingest-history \
  --from codex,claude-code \
  --since 180d \
  --profile candidates \
  --tree source-topic-global \
  --dry-run

ms project ingest-history \
  --from codex \
  --since 90d \
  --apply
```

全局多项目导入可作为后续命令：

```bash
ms import agent-history \
  --from codex,claude-code \
  --project-map auto \
  --dry-run
```

命名原则：

| 命令 | 定位 | 是否首期必需 |
|------|------|--------------|
| `ms project ingest-history` | 当前项目导入，最符合 `ms init` 后的用户心智 | 是 |
| `ms import agent-history` | 跨项目批量导入，依赖 project mapping 更成熟 | 否 |
| `ms profile rebuild` | 从已导入 evidence 重建用户画像 | 是 |
| `ms project tree rebuild` | 从 project evidence 重建项目记忆树 | 是 |
| `ms project tree status` | 查看项目树构建进度、节点数、最近更新时间 | 是 |

---

## 4. 来源适配器

历史数据来源不能直接写死在核心逻辑里，应通过 source adapter 统一输出 canonical event。

### 4.1 初始支持的来源

| 来源 | 默认探测路径 | 内容类型 | 初始处理策略 |
|------|--------------|----------|--------------|
| Codex sessions | `~/.codex/sessions/**/*.jsonl` | 会话事件、tool call、状态流、最终回复 | 解析为工作日志和会话 evidence |
| Codex memories | `~/.codex/memories/MEMORY.md`、`memory_summary.md`、`rollout_summaries/` | 已沉淀记忆、rollout 摘要、偏好 | 作为高置信候选，但仍需 provenance 和确认 |
| Claude Code sessions | 常见为 `~/.claude/projects/**/*.jsonl`，实际路径以 adapter 探测为准 | 会话记录、工具调用、项目上下文 | 解析为工作日志 evidence |
| Claude Code memory / rules | 用户级和项目级 `CLAUDE.md`、`.claude/` 配置、项目规则文件 | 用户偏好、项目规范、工具约束 | 用户级进入 profile/rules 候选，项目级进入 project rules/resource |
| Project local files | `AGENTS.md`、`CLAUDE.md`、`README.md`、`docs/`、package/config 文件 | 项目规则、资源、技术栈、运行方式 | 作为项目树的 resource/rules/task_context evidence |

说明：

1. Claude Code 和 Codex 的本地存储路径可能随版本变化，adapter 必须支持 `--source-root` 显式覆盖。
2. 默认探测只生成报告，不自动读取全文写库。
3. 对日志、消息和工具参数必须做 secret redaction，再进入 embedding 或 LLM。

### 4.2 Adapter 输出协议

所有 adapter 输出统一事件：

```typescript
interface AgentHistoryEvent {
  id: string;
  provider: "codex" | "claude-code" | "openclaw" | string;
  sourceKind: "session" | "memory" | "rule" | "work_log" | "project_file";
  sourcePath?: string;
  sourceHash: string;
  sessionId?: string;
  threadId?: string;
  cwd?: string;
  projectRootHint?: string;
  timestamp?: number;
  role?: "user" | "assistant" | "system" | "tool";
  text: string;
  metadata: Record<string, unknown>;
}
```

导入状态单独存储，保证幂等：

```typescript
interface AgentHistoryImportState {
  sourceHash: string;
  provider: string;
  sourcePath?: string;
  projectId?: string;
  status: "seen" | "imported" | "skipped" | "failed";
  eventCount: number;
  importedRecordIds: string[];
  updatedAt: number;
  error?: string;
}
```

建议状态路径：

```text
~/.mengshu/imports/agent-history/state.json
~/.mengshu/projects/<projectId>/audit/imports.jsonl
```

---

## 5. Project 归属判定

导入日志的第一难点是“这条历史属于哪个项目”。必须先归属，再写入 project scope。

判定顺序：

1. 命令显式指定：`--project-id` 或当前目录已存在 `.mengshu.json`。
2. 事件中包含 `cwd`、`projectRoot`、workspace path，并能命中 registry 的 `lastSeenRoot`。
3. 事件 source path 属于某个已注册 source root。
4. 会话内容或工具调用中高频出现仓库路径、包名、git remote，可作为低置信候选。
5. 无法判断时进入 `workspace inbox`，不写入任何 project tree。

输出 dry-run 报告时必须列出：

| 字段 | 示例 |
|------|------|
| source | `codex_sessions` |
| sessions | `42` |
| matchedProject | `proj-xxxx` |
| matchReason | `cwd_prefix` / `registry_root` / `explicit` / `content_hint` |
| confidence | `0.95` |
| action | `import` / `skip` / `needs-confirmation` |

低于阈值的归属必须用户确认：

```bash
ms project ingest-history --from codex --confirm-mapping
```

---

## 6. 写入分层

导入不是把日志原文直接全部变成“长期记忆”。推荐分四层处理。

### 6.1 Evidence 层

保存最小可追溯来源：

1. source path、source hash、session id、event id。
2. canonical text chunk。
3. 时间、provider、project mapping、redaction 状态。

Evidence 可以进入 `MemoryRecord.kind = "observation"` 或 `ChunkRecord`，但不一定进入必读上下文。

### 6.2 Candidate 层

LLM 或启发式从 evidence 提取候选：

| 候选类型 | semanticType | 示例 |
|----------|--------------|------|
| 用户协作偏好 | `profile` | 用户偏好中文、直接、先验真再执行 |
| 稳定约束 | `rules` | 不要默认重置 dirty worktree |
| 项目当前状态 | `task_context` | 当前仓库正在做 Project Workspace 记忆能力 |
| 经验方法 | `experience` | 排查启动链路要先看真实脚本和日志 |
| 资源索引 | `resource` | 项目使用 `docs/05-api/cli-commands.md` 维护 CLI 契约 |

Candidate 默认不进入必读层，除非：

1. 用户显式确认。
2. 多条 evidence 重复支持，且置信度达到阈值。
3. 来源本身是用户维护的规则文件，例如 `AGENTS.md` / `CLAUDE.md`。

### 6.3 Active Memory 层

通过治理后写入 `MemoryRecord`：

```typescript
interface ImportedMemoryRecordPatch {
  semanticType: "profile" | "task_context" | "rules" | "experience" | "resource";
  container: "personal" | "project" | "session_candidate";
  lifecycleStatus: "active" | "promoted";
  confidence: number;
  sourceNodeIds: string[];
  metadata: {
    importRunId: string;
    provider: string;
    projectId?: string;
    extractionMethod: "llm" | "heuristic" | "manual";
    redacted: boolean;
  };
}
```

### 6.4 Snapshot / Tree 层

Active memory 再进入两个结构：

1. 用户画像 snapshot：面向 `profile` slot 的稳定压缩视图。
2. 项目记忆树：面向 project scope 的 source/topic/global tree。

---

## 7. 用户画像构建

画像只回答“Agent 该如何与用户协作”，不回答“用户是什么人格”。

### 7.1 输入

| 输入 | 使用方式 |
|------|----------|
| 用户显式规则和偏好 | 高置信，可直接进入候选或 active |
| 多次重复的纠正和反馈 | 中高置信，进入候选，需合并 |
| 单次对话中的表达风格 | 低置信，只作为 evidence |
| Agent 对用户的评价 | 默认不入画像，除非有用户确认 |
| 敏感个人信息 | 不入画像，默认过滤 |

### 7.2 画像维度

初始只保留能改变 Agent 输出行为的维度：

| 维度 | 含义 | 允许内容 |
|------|------|----------|
| language | 默认语言 | 中文、英文或混合偏好 |
| response_style | 回答结构 | 直接、证据驱动、少铺垫、先结论 |
| verification_preference | 验证偏好 | 先核对代码/配置/日志/真实产物 |
| planning_preference | 计划偏好 | 简单任务不要过程文件，复杂任务先简短计划 |
| risk_boundary | 风险边界 | 不写猜测性实现，不覆盖用户改动 |
| domain_focus | 常见工作域 | 记忆系统、Agent Runtime、PPT runtime 等 |

不允许自动写入：

1. 人格标签。
2. 健康、政治、宗教、民族等敏感属性。
3. 对用户能力、情绪、心理状态的评价。
4. 没有 evidence 的总结。

### 7.3 合并策略

`profile` 不应无限追加，应合并为短 snapshot：

```text
新 profile 候选
  -> 查找同 dimension 已有 active profile
  -> 判断支持 / 补充 / 冲突 / 替代
  -> 支持或补充：合并摘要，保留 evidence ids
  -> 冲突：进入候选，等待用户确认
  -> 替代：旧节点 lifecycleStatus=superseded，新节点 active
```

阈值建议：

| 场景 | 默认动作 |
|------|----------|
| 用户明确说“记住/以后都...” | active candidate，仍记录 provenance |
| 来自 `AGENTS.md` / 用户维护记忆文件 | active 或高置信 candidate |
| 3 次以上独立 evidence 支持 | candidate 可自动合并，需可回滚 |
| 单次隐含行为 | 只存 evidence，不进 profile |
| LLM 推断但无原文支持 | 丢弃 |

### 7.4 输出形态

用户画像输出给 `memory_context_fast` 时应控制长度：

```text
Profile:
- 默认使用中文，回答直接，优先给真实依据和可验证结论。
- 对工程任务要求先核对代码、配置、日志和真实产物，再实施。
- 简单任务不需要过程文件；长链路任务先给简短计划。
```

每条 profile 必须能下钻到 evidence：

```bash
ms profile show --with-evidence
ms profile diff --from-import <importRunId>
ms profile revoke <profileRecordId>
```

---

## 8. 项目记忆树构建

“项目记忆树”不是新增第四种 `treeType`。首期应复用现有 `source/topic/global`：

| treeType | project 语义 | treeKey 示例 |
|----------|--------------|--------------|
| `source` | 单个会话、文件、导入批次或工作日志来源 | `session:<sessionId>`、`file:<path>`、`import:<runId>` |
| `topic` | 项目内热点实体、模块、任务、问题 | `entity:<entityId>`、`topic:cli-import` |
| `global` | 项目维度时间摘要和里程碑摘要 | `2026-06-15`、`week:2026-W25` |

project tree view 是“同一 project scope 下三类树的组合视图”：

```text
Project Memory Tree
  L3 project digest / milestone
    L2 topic summaries
      L1 session/file/source summaries
        L0 evidence chunks
```

### 8.1 L0：Evidence Chunk

来自 adapter 的 canonical event 会切分为 evidence chunk：

1. 保留 provider、sourcePath、sessionId、eventId。
2. 计算 contentHash，用于去重。
3. 建立 project scope。
4. 只保存 redaction 后文本。

### 8.2 L1：Source Summary

按来源聚合：

| 来源 | source tree key | 摘要重点 |
|------|-----------------|----------|
| Codex rollout/session | `session:<id>` | 目标、关键决策、修改文件、验证结果、失败原因 |
| Claude Code project session | `session:<id>` | 任务背景、工具操作、结论、后续约束 |
| 项目规则文件 | `file:<path>` | 规则、命令、禁止事项、项目约定 |
| 导入批次 | `import:<runId>` | 导入范围、候选数量、跳过原因 |

### 8.3 L2：Topic Summary

按实体、模块、主题聚合：

1. entity：文件、模块、命令、API、配置、外部系统。
2. topic：用户反复处理的问题，例如 `ms init`、MCP 接入、记忆树、global home。
3. hotness：由出现次数、最近访问、importance、召回次数决定。

Topic tree 用于回答：

1. “这个模块历史上为什么这样设计？”
2. “这个命令之前有哪些坑？”
3. “这个项目最近围绕哪个主题变化最多？”

### 8.4 L3：Global Project Digest

按天、周或里程碑生成 project digest：

```text
2026-06-15 project digest
- 目标：设计 agent history 导入、用户画像和项目记忆树方案。
- 已确认：ms init 不默认导入，新增显式 ingest-history 命令。
- 风险：Claude/Codex 本地日志格式不稳定；tree 持久化未完成。
- 下一步：实现 source adapter dry-run 和 project mapping 报告。
```

### 8.5 持久化边界

当前 tree repository 仍以基础内存能力为主。若项目记忆树要成为长期真源，需要新增持久化：

```text
~/.mengshu/projects/<projectId>/tree/
  leaves.jsonl
  buffers.jsonl
  summaries.jsonl
  indexes/
    by-source.json
    by-topic.json
    by-date.json
```

首期可分两步：

1. P1 先把导入后的 evidence 写入 MemoryService，tree 仍可重建。
2. P2 再把 sealed summary node 持久化，支持重启后 `lookup_deep` 继续召回项目树。

---

## 9. 召回集成

导入后的数据要进入现有 5 slot 和 deep lookup。

### 9.1 `memory_context_fast`

启动上下文组装：

| slot | 来源 |
|------|------|
| `profile` | workspace 级用户画像 snapshot |
| `task_context` | 当前 project 的目标、阶段、近期 digest |
| `rules` | 用户规则 + 项目规则，hard rule 优先 |
| `experience` | 同 workspace 可复用经验 + 当前 project 历史决策 |
| `resource` | 当前 project 的文件、命令、文档、外部链接索引 |

### 9.2 `lookup_deep`

深度召回应融合：

1. 向量搜索命中的 MemoryRecord / ChunkRecord。
2. BM25 或 text source。
3. Project tree summaries。
4. Entity / relation graph path。
5. Recent project digest。

返回必须带 provenance：

```json
{
  "source": "tree",
  "treeType": "topic",
  "treeKey": "topic:ms-init",
  "evidenceChunkIds": ["chunk_xxx"],
  "sourcePath": "~/.codex/sessions/..."
}
```

---

## 10. CLI 交互草案

### 10.1 初始化后提示

```bash
$ ms init
已创建 .mengshu.json
- projectId: proj-xxxx
- workspaceId: ws-xxxx

发现可导入的 Agent 历史来源：
- Codex sessions: 128 files
- Codex memories: 1 registry, 42 rollout summaries
- Claude Code: 未确认路径

下一步可执行：
  ms project ingest-history --from codex --since 180d --dry-run
```

### 10.2 Dry-run

```bash
$ ms project ingest-history --from codex,claude-code --since 90d --dry-run

Agent history import preview
- projectId: proj-xxxx
- source files: 38
- sessions matched: 22
- sessions skipped: 16
- estimated chunks: 310
- profile candidates: 12
- project rules candidates: 8
- task_context candidates: 19
- experience candidates: 27
- resource candidates: 14
- tree leaves: 310
- requires confirmation: 5

No data written. Re-run with --apply to import.
```

### 10.3 Apply

```bash
$ ms project ingest-history --from codex --since 90d --apply

Imported agent history
- importRunId: imp_20260615_001
- records stored: 212
- candidates created: 48
- source summaries sealed: 18
- topic summaries sealed: 6
- profile changes: 3 pending review
```

### 10.4 Review / rebuild

```bash
ms profile show --with-evidence
ms profile rebuild --from-import imp_20260615_001 --dry-run
ms profile apply --candidate cand_xxx

ms project tree status
ms project tree rebuild --from imported-history --apply
ms project lookup "这个项目的 ms init 设计边界是什么？" --deep
```

---

## 11. 安全与隐私边界

必须作为 release gate 的安全规则：

1. 导入默认 dry-run，不写库。
2. `--apply` 前输出写入数量、来源、project mapping 和敏感信息过滤结果。
3. 默认排除 `.env`、keychain、tokens、cookies、SSH keys、npm tokens、私钥、完整请求头。
4. 对工具参数、终端输出、错误日志做 secret pattern redaction。
5. 未经用户确认，不把原始日志发送到远端 LLM；如果 embedding/LLM provider 是远端，命令必须提示。
6. profile 默认 private 或 workspace，不自动团队共享。
7. project memory 不跨 project 注入 `task_context/resource`。
8. 所有 import、promotion、revoke、delete 写 audit。
9. 支持按 importRunId 回滚：

```bash
ms import rollback imp_20260615_001 --dry-run
ms import rollback imp_20260615_001 --apply
```

---

## 12. 实施阶段

### P0：文档和命令边界

交付：

1. 本方案文档。
2. 明确 `ms init` 不默认导入历史。
3. 明确首期主命令为 `ms project ingest-history`。

验收：

1. 文档区分当前实现和未来方案。
2. README 路由能找到本方案。

### P1：Source adapter + dry-run

交付：

1. `AgentHistoryEvent` canonical schema。
2. Codex adapter：支持 sessions 和 memories dry-run。
3. Claude Code adapter：支持路径探测和 `--source-root`。
4. Project mapping 报告。
5. `ms project ingest-history --dry-run`。

验收：

1. 不需要 embedding/LLM 也能 dry-run。
2. 能列出 matched / skipped / needs-confirmation。
3. 解析失败不会中断整批导入。

### P2：Evidence 写入和候选生成

交付：

1. 幂等 import state。
2. evidence chunk 写入 MemoryService。
3. profile/rules/task_context/experience/resource 候选生成。
4. import audit。

验收：

1. 重复执行不会重复写入。
2. 所有候选可追溯到 source event。
3. redaction 测试覆盖常见 secret。

### P3：用户画像合并器

交付：

1. `ms profile show/rebuild/diff/apply/revoke`。
2. profile dimension merge。
3. conflict candidate。
4. context_fast profile snapshot 接入。

验收：

1. 单次隐含行为不自动进入 profile。
2. 冲突画像不会自动覆盖。
3. `memory_context_fast` 输出长度受控。

### P4：项目记忆树持久化和 deep recall

交付：

1. project tree persistence。
2. import 后构建 source summary。
3. topic/global project digest。
4. `ms project tree status/rebuild`。
5. `lookup_deep` 融合 project tree summary。

验收：

1. 重启后 project tree 仍可召回。
2. project tree 节点带 evidenceChunkIds。
3. `task_context/resource` 不跨 project。

### P5：Console 审核体验

交付：

1. Import runs 列表。
2. Candidate review。
3. Profile diff。
4. Project tree explorer。

验收：

1. 用户能查看、接受、撤销导入结果。
2. UI 展示来源和 redaction 状态。

---

## 13. 测试与评估

### 13.1 单元测试

| 模块 | 测试重点 |
|------|----------|
| source adapter | JSONL 解析、坏行跳过、路径覆盖 |
| project mapper | cwd/registry/sourceRoot/content hint 优先级 |
| redaction | API key、token、私钥、env 输出 |
| import state | 幂等、失败恢复、partial retry |
| profile merger | 合并、冲突、supersede、revoke |
| tree builder | source/topic/global summary evidence 保留 |

### 13.2 集成测试

1. fixture Codex session -> dry-run -> apply -> profile candidate。
2. fixture Claude Code session -> project mapping -> tree leaves。
3. 重复导入同一 source -> 0 duplicate writes。
4. `memory_context_fast` 能读到 profile 和 project rules。
5. `lookup_deep` 能命中 project tree summary。

### 13.3 Eval

新增黄金集：

| Eval | 目标 |
|------|------|
| `mengshu-agent-history-import` | 历史日志导入分类准确率 |
| `mengshu-profile-safety` | 画像不过度推断、不写敏感属性 |
| `mengshu-project-tree-recall` | 项目问题能从 tree summary 找到依据 |

最低门槛：

1. profile 敏感误写入率 = 0。
2. project 归属高置信样本准确率 >= 95%。
3. 重复导入重复记录数 = 0。
4. `task_context/resource` 跨 project 误注入率 = 0。

---

## 14. 主要风险

| 风险 | 处理 |
|------|------|
| Claude Code / Codex 本地文件格式变化 | adapter 化，保留 `--source-root` 和 parser version |
| 历史日志包含敏感信息 | 默认 dry-run、redaction、远端 provider 提示、可回滚 |
| 项目归属误判 | 低置信进入确认，不写 project tree |
| profile 过度推断 | 只记录工作协作偏好，单次行为不入 active profile |
| tree 当前不持久 | P4 前明确只能作为可重建结构，不宣称长期真源 |
| 导入后上下文变长 | snapshot 控制预算，resource/experience 只注入索引 |
| 未提交草稿命令误导用户 | 文档标注 `cli-import.ts` 是草稿，正式命令以本方案为准 |

---

## 15. 推荐落地顺序

首期最小可用闭环：

1. 保持 `ms init` 当前低风险语义。
2. 实现 `ms project ingest-history --from codex --dry-run`。
3. 完成 Codex source adapter 和 project mapping 报告。
4. 写入 evidence + candidates，不直接改 active profile。
5. 实现 `ms profile rebuild --dry-run`。
6. 接入 source tree summary，先不做 topic/global 持久化。
7. 最后再扩展 Claude Code adapter、profile apply、project tree persistence。

这样可以先验证“历史日志能否可靠转成可审计 evidence”，再逐步打开画像和项目记忆树的自动化程度。
