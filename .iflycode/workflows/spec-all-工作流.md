---
name: spec-all-工作流
description: SPEC-自动化规范研发，贯穿分析、规划、实现与归档全流程
---
# 🎯 Workflow 目标
本工作流自动串联以下 4 个 SPEC 指令：
1. `/spec-1-分析.md`  —— 需求分析
2. `/spec-2-规划.md`     —— 需求规划
3. `/spec-3-实现.md`    —— 规划执行
4. `/spec-4-归档.md`  —— 自动归档

其中 **仅需求分析阶段（`spec-1-分析.md`）需要人工确认**。
所有其他子指令内的人工询问步骤均被此 workflow 自动跳过。

---

# ⚙ Workflow 主流程（调度器）

## Step 1：读取并按步骤执行需求分析（`.iflycode/workflows/spec-1-分析.md`）

执行工作流：

```
.iflycode/workflows/spec-1-分析.md <需求>
```

行为要求：

1. 需求为空
   若用户未提供 <需求>
   → 立即终止 workflow
   → 返回提示：“请提供需求内容后再继续。”

2. 需求模糊（模型返回：需澄清）
   若 `/spec-1-分析.md` 返回 “需求模糊，需要澄清”
   → workflow 暂停
   → 明确返回澄清问题，等待用户补充

用户补充后
→ workflow 自动再次执行 `/spec-1-分析.md`
→ 直到获得“清晰需求”为止

3. 清晰需求时的评分处理
   3.1 若评分 ≤ 0（轻微修改）

Workflow 必须返回：
```
是否仍要继续进入规划？

1 是，继续规划 （进行 Step 2 ）
2 否，直接执行变更（无需规划）
```

⚠ 注意：不得展示评分数字、不得说明评分相关内容

要求：
- 在用户明确选择前，停止所有后续步骤。
- 如果用户选择“2”或“否”或“不规划”等，则 跳出 workflow，直接执行变更。
- 如果用户选择“1”或“是”或“继续规划”等，则 继续执行 Step 2 。

3.2 若评分 > 0（需要规划）
- 不需要询问用户
- workflow 自动进入 Step 2

⚠ 禁止向用户显示评分或任何评分描述内容

---

## Step 2：读取并按步骤执行规划（`.iflycode/workflows/spec-2-规划.md`）

执行工作流：

```
.iflycode/workflows/spec-2-规划.md <需求>
```

规划阶段自动化要求：

- 自动生成 change-id
- 自动建立：
    - `proposal.md`
    - `tasks.md`
    - `design.md`（如需要）
- 检查自动建立的文件内容是否与需求一直，并且完全覆盖用户需求
- 若验证失败 → workflow 自动重试一次
- 若仍无法通过 → workflow 暂停并给出错误原因

### 忽略`design.md`文件中需要人工确认的流程，默认继续执行

---

## Step 3：读取并按步骤自动执行实现（`.iflycode/workflows/spec-3-实现.md`）

执行工作流：

```
.iflycode/workflows/spec-3-实现.md <change-id>
```

自动化规则：

- 完全自动执行 `tasks.md`
- 遇到模糊任务不向用户提问，而是：
    1. 回看 proposal/design 获取上下文
    2. 若仍无法判断 → workflow 暂停
- 每个任务完成后自动验证变更
- 自动更新 `tasks.md` 中的 `[x]` 状态
- 实现结束后自动执行一致性检查

---

## Step 4：读取并按步骤自动执行归档（`.iflycode/workflows/spec-4-归档.md`）

在上一步获取的 `<change-id>` 基础上执行：

```
.iflycode/workflows/spec-4-归档.md <change-id>
```

自动化规则：

- 自动识别变更 ID
- 将`.iflycode/changes/<id>`目录remove到`.iflycode/changes/archive/<id>`下

---

# 🧩 错误恢复机制（Workflow 级别）

在任意子步骤发生异常时，workflow 会：

1. 捕获错误输出
2. 判断是“可自动修复”还是“需用户介入”
3. 若可修复 → 自动重试
4. 若无法修复 → 提示用户并暂停

可自动修复示例：

- change-id 重名 → 自动生成新 id 重试
- spec validate 缺失场景 → 自动补齐默认场景
- tasks.md 语法不完整 → 自动修复

需用户确认示例：

- design.md 内存在未解决问题
- tasks.md 指令无法推断操作意图
- code-level 实现无法判断行为是否正确

---

# ✔ Workflow 成功结束时输出格式

```
🎉 全自动 SPEC 执行完成！

✔ 已完成：需求分析
✔ 已完成：规划（proposal/design/spec/tasks）
✔ 已完成：自动实现（tasks.md 全部已执行）
✔ 已完成：变更归档

变更 ID：<id>
归档位置：changes/archive/<id>

```

# 📚 上述指令文件均位于：

```
.iflycode/workflows/
  ├─ spec-1-分析.md
  ├─ spec-2-规划.md
  ├─ spec-3-实现.md
  ├─ spec-4-归档.md
```