# P2 开发计划：MCP / CLI / Hooks

> 依据：`docs/plans/upgrade-next-20261011.md`  
> 分支：`1.0.7`  
> 约束：不做 npm 发布；不接 Graphiti/第三方记忆桥；MCP=Agent 实时；CLI=目录治理入库；Hooks=被动会话更新。

## 目标验收（本轮结束必须满足）

1. **MCP**：default 工具面只含实时工具；空召回有可区分状态；`memory_explain` 覆盖 lastDecision；聚焦单测绿。
2. **CLI**：`ms scan`（或等价）支持目录分析 → 报告 → dry-run → apply；入库走同一 admission；dry-run 不写库。
3. **Hooks**：session_start / pre_compact / task_complete / session_end 有可调用入口 + 文档；失败可观测、不阻断回合；不伪造宿主 API。
4. **横切**：`ms doctor` 可见 schema（含 v39 收据）；authority 冷启动路径文档或 `ms authority init` 雏形。

## 工作包顺序

| 序 | 包 | 主要内容 | 完成定义 |
|----|----|----------|----------|
| W1 | MCP 实时面 | 收紧 default List；空召回状态码；Skill 对齐工具序 | vitest MCP + five-slot + explain 绿 |
| W2 | CLI 目录治理 | scan 管线产品化：ignore、报告、dry-run、apply、5type 标注 | CLI 单测 + 对临时目录 dry-run→apply 冒烟 |
| W3 | Hooks 被动更新 | 统一 SessionEvent 载荷；插件映射表；Skill 写入纪律 | hooks 单测 + OpenClaw 不回归 |
| W4 | 评审修复 | 独立评审：安全、主链绕过、secret、假 API | 问题清单清零或记入 hold |
| W5 | Mac 对齐 | migrate 到当前 schema；按需 wiki 治理/重扫 | doctor 显示就绪；wiki 与代码合同一致 |

## 执行方式

1. 在 Mac 本地 mengshu 克隆上用 **Grok**（`--always-approve`、单轮 prompt）按 W1→W3 改代码并提交到 `1.0.7`。
2. 父 Agent / 第二轮 Grok 做 **代码评审 + 修复**。
3. 推送 `origin/1.0.7`。
4. 若 `~/.mengshu` Postgres / wiki 落后于 schema 或 CLI 合同 → 再启 Agent：`migrate` + wiki 更新（只用本机已有 config，禁止把密钥写入仓库或聊天）。

## 明确不做

npm 发布、Graphiti 桥、自动可执行 Skill、静默 ADD、重写 D-01~D-23。

## Grok workflow 执行

- Workflow 定义：`.grok/workflows/mengshu-p2.rhai`（`/mengshu-p2`）
- 启动方式：短指令「运行 mengshu-p2 workflow」，由 Grok 读本文件分阶段执行；不要把全文粘进 prompt。
- 盯梢：每小时检查 commits / 进程；挂死后只重启当前阶段。
