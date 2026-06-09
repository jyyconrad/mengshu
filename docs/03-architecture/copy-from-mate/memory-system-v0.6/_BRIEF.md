# 共享简报：banto 记忆体系 v0.6 设计任务

> **目标**：基于 banto 真实产品形态（短时任务对话 / Project / 自动化），设计一套 md+json 工作图谱记忆体系
> **档位**：full（多 agent 并行 + 主线程整合）
> **输出**：4 个子文档 + 1 个主索引文档

---

## 任务背景

### 用户核心质疑（必须回答）

1. **概念与产品脱节** — 之前方案过于抽象，没有扣住 banto 的三大工作容器（短时任务对话、Project、自动化）和支撑体系（专家、技能、连接器、Identity）
2. **记忆分层不清晰** — 没有明确"全局记忆 vs 项目记忆 vs 会话记忆 vs 自动化记忆"的边界
3. **运转机制不具体** — 存储、提取、回溯、升格的方向不清楚
4. **缺少工作图谱设计** — 要求设计 md+json 双存的结构化记忆体系
5. **chat-end 触发未利用** — 应该在会话结束时触发工作图谱整理

### banto 产品形态（必读）

**三大工作容器**：

| 容器 | 定位 | 路由 |
|---|---|---|
| 短时任务对话 | 快速发起即时任务 | `/home` 欢迎态 → 对话态 |
| Project | 持续推进长期工作 | `/projects` 列表 + `/projects/:id` 详情 |
| 自动化（定时任务） | 周期性执行任务（当前暂不开放） | `/scheduled`（代码保留） |

**支撑体系**：

| 体系 | 职责 |
|---|---|
| Identity（岗位角色） | 初始化默认身份、默认专家、首页能力卡片 |
| 专家智能体 | 提供更专业的执行能力，可通过 `@专家` 或能力卡片调用 |
| 技能 | 沉淀可复用的方法、流程与能力封装 |
| 连接器（MCP） | 接入外部系统与外部工具 |

**核心流程**：

1. 用户登录 → 选择 Identity → 进入 `/home` 欢迎态
2. 发起短时任务对话 → 自动创建或绑定 Project → 进入对话态（`ChatAssistant`）
3. 需要持续推进时 → 进入 `/projects/:id` 查看历史会话、产物、推进上下文
4. 专家能力通过能力卡片或 `@专家` 参与，不打断主流程

### 当前 banto 记忆现状（v0.3-v0.4）

**存储布局**：

- `~/.iflymate/memory/` — 全局记忆（user/feedback/reference）
- `~/.iflymate/memory/projects/<projectId>/` — 项目记忆（type=project）
- `~/.iflymate/memory/projects/<projectId>/_sessions/<sessionId>/` — 会话分区（已预留，未实施晋升）
- 每目录一个 `MEMORY.md` 索引文件

**4 类记忆条目**：

- `user`（身份与偏好）
- `feedback`（反馈与约束）
- `project`（项目事实与决策）
- `reference`（外部系统指针）

**写入路径**：

- 自动：`chat-end` → 10s debounce → LLM Extractor 分析最近 12 条消息 → 最多提取 5 条 confidence ≥ 0.7 的记忆落盘
- 手动：前端 IPC `memory:save` → `manual=true`

**读取路径**：

- 全局记忆 + 项目记忆全量注入 system prompt，8000 字符上限，按 `updatedAt` 倒序裁剪
- AI 无主动检索能力（v0.4.1 已移除 `save_memory` / `recall_memory` 工具）

**主要短板**：

- 记忆与产品容器（短时任务 / Project / 自动化）未显式映射
- 无工作图谱（节点 / 关系 / 演化）
- 无 chat-end 触发的图谱整理机制
- 与专家 / 技能 / 连接器体系解耦

---

## 分工方案

| Agent | 子文档主题 | 核心问题 | 输出文件 |
|---|---|---|---|
| **A** | 记忆分层与工作容器映射 | 全局 / 项目 / 会话 / 自动化记忆各记什么？边界在哪？ | `01-memory-layers-and-containers.md` |
| **B** | md+json 工作图谱数据模型 | 节点 / 关系 / 双存格式 / 目录布局如何设计？ | `02-work-graph-data-model.md` |
| **C** | 运转机制 | 写入触发、chat-end 整理、读取召回、回溯、升格如何实现？ | `03-runtime-mechanisms.md` |
| **D** | 与支撑体系耦合 | 记忆如何与专家 / 技能 / 连接器 / Identity 联动？ | `04-coupling-with-capability-system.md` |

---

## 共享约束（所有 agent 必须遵守）

1. **扣住产品形态** — 所有设计必须映射到"短时任务对话 / Project / 自动化"三大容器
2. **md+json 双存** — 记忆必须同时有 JSON（结构化查询）和 Markdown（人类可读）
3. **工作图谱思维** — 记忆不是平铺列表，而是节点 + 关系的图谱
4. **chat-end 触发** — 必须设计会话结束时的图谱整理机制
5. **只写方向不写代码** — 输出为概念设计，不含代码、阈值、工期
6. **与现有 4 类型兼容** — user/feedback/project/reference 作为节点类型保留
7. **与支撑体系耦合** — 记忆要能与专家 / 技能 / 连接器 / Identity 联动

---

## 输出要求

每个子文档必须包含：

1. **核心问题陈述** — 本文档回答什么问题
2. **设计原则** — 3-5 条不可妥协的原则
3. **概念模型** — 用表格 / 图示说明核心概念
4. **与 banto 产品的映射** — 如何对应到短时任务 / Project / 自动化
5. **与现状的差异** — 当前 v0.3-v0.4 缺什么、升级方向是什么
6. **关键判断** — 需要用户确认的设计决策（2-3 项）

格式：Markdown，2000-3000 字，包含表格与 Mermaid 图。

---

## 参考文档（所有 agent 可读）

- [product-concept-0.3.1.md](../../../01-product/01-overview/product-concept-0.3.1.md) — banto 产品概念基线
- [current-product-logic-baseline.md](../../../01-product/02-logic/current-product-logic-baseline.md) — 当前产品逻辑基线
- [product-memory-think.md](../product-memory-think.md) — 企业 agent 记忆的产品思考（上下文连续性、双轴模型）
- [memory-system-upgrade-design-appendix.md](../memory-system-upgrade-design-appendix.md) — 早期 harness 借鉴的实施细节（可参考但不照搬）

---

## 主线程整合检查清单

主线程收到 4 个子文档后，必须检查：

1. **一致性** — 4 个文档的术语、概念、边界是否一致
2. **完整性** — 是否覆盖了用户的 5 个核心质疑
3. **可执行性** — 是否给出了明确的方向（不是空泛原则）
4. **与产品的贴合度** — 是否真正扣住了 banto 的三大容器和支撑体系
5. **冲突解决** — 如果 4 个文档有矛盾，主线程必须裁决并统一

整合后输出主索引文档：`memory-system-upgrade-design.md`（5000-6000 字）。

---

## 开始信号

所有 agent 收到本简报后立即开始，无需等待主线程进一步指令。输出文件直接写入 `doc/02-architecture/05-ai-engine/memory-system-v0.6/` 目录。