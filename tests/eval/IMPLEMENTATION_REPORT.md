# Golden Set 扩充实施报告

> **任务**：扩充 eval golden set，从经验值变为验证值，按设计 §15 实现
> **执行日期**：2026-06-17
> **状态**：✅ 完成（工具链和文档就绪，待人工标注）

---

## 一、交付物清单

### 1. 文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `eval/EXPANSION_PLAN.md` | 扩充计划：P0-P2 完整路线图 | ✅ 完成 |
| `eval/ANNOTATION_GUIDE.md` | 标注规范：type 判定、关系枚举、边界样例 | ✅ 完成 |
| `eval/README.md` | 评测基础设施说明（已更新标注流程） | ✅ 更新 |
| `eval/tools/annotation-workflow-example.sh` | 标注流程示例脚本 | ✅ 完成 |

### 2. 工具

| 文件 | 功能 | 状态 |
|------|------|------|
| `eval/tools/annotator.js` | 标注工具（CLI） | ✅ 完成 |

**annotator.js 功能清单**：
- ✅ `annotate` 模式：单人标注
- ✅ `consistency` 模式：计算 Cohen's Kappa
- ✅ `arbitrate` 模式：仲裁分歧样例
- ✅ `merge` 模式：合并标注结果

---

## 二、当前 Golden Set 状态

| Suite | 当前条数 | 目标条数 (P0-c) | 状态 | 备注 |
|-------|---------|----------------|------|------|
| mengshu-extraction | 100 | 100 | ✅ 达标 | 需增加标注元数据 |
| mengshu-dedup | 80 | 80 | ✅ 达标 | 需双人标注+仲裁 |
| mengshu-recall-explain | 60 | 60 | ✅ 达标 | 需 breakdown 验证 |
| mengshu-conflict | 10 | 10 (P0), 30 (P1), 50 (P3) | ✅ P0 达标 | P1/P3 扩充 |
| mengshu-tree-summary | 8 | 8 (P0), 50 (P3) | ✅ P0 达标 | P3 扩充 |
| mengshu-skill-candidate | 8 | 8 (P0), 30 (P4) | ✅ P0 达标 | P4 扩充 |

**结论**：P0-c 骨架完整，满足设计 §15.5 要求的"提取 100 条 + 去重 80 条"。现需人工标注转换为验证值。

---

## 三、实施路径

### Phase 1: P0-c（提取 + 去重）

**目标**：将现有 100 条 extraction + 80 条 dedup 从经验值转换为验证值

**步骤**：
1. ✅ 创建标注工具（`annotator.js`）
2. ✅ 编写标注规范（`ANNOTATION_GUIDE.md`）
3. ⏳ 招募标注人（2 人标注 + 1 人审核 + 1 人仲裁）
4. ⏳ 双人独立标注（预计 3-4 天）
   - extraction 100 条（~5 小时）
   - dedup 80 条（~4 小时）
   - recall-explain 60 条（~3 小时）
5. ⏳ 一致性计算（自动）
6. ⏳ 仲裁分歧样例（预计 0.5-1 天）
7. ⏳ 合并结果 + 更新 manifest（自动 + 手动）
8. ⏳ 验证通过（运行 `npm run eval:quick`）

**验收标准**：
- [ ] mengshu-extraction 100 条全部带标注元数据
- [ ] mengshu-dedup 80 条一致性 >= 0.85
- [ ] mengshu-recall-explain 60 条 breakdown 输出率=1.0
- [ ] 边界样例（extraction 20 条 + dedup 15 条）第三人审核通过
- [ ] rules 冲突样例 false merge=0

### Phase 2: P1（摘要 + 冲突扩充）

**目标**：扩充 tree-summary 至 50 条，conflict 至 30 条

**步骤**：
1. ⏳ 编写 tree-summary 新样例（42 条）
2. ⏳ 编写 conflict 新样例（20 条 rules 类）
3. ⏳ 人工标注（模型辅助标注 + 人工校验）
4. ⏳ 验证 faithfulness >= 0.95

**预计耗时**：5-6 天

### Phase 3: P2（主动学习）

**目标**：建立持续扩容机制

**步骤**：
1. ⏳ 从线上采样低置信度样例
2. ⏳ 每周标注 25 条
3. ⏳ 回灌各 suite

**预计耗时**：每周 2 小时（持续进行）

---

## 四、标注流程示例

详见 `eval/tools/annotation-workflow-example.sh`，演示完整流程：

```bash
# 1. 双人独立标注
node eval/tools/annotator.js annotate --suite mengshu-dedup --annotator human_001
node eval/tools/annotator.js annotate --suite mengshu-dedup --annotator human_002

# 2. 计算一致性
node eval/tools/annotator.js consistency \
  --suite mengshu-dedup \
  --file1 eval/results/human_001_mengshu-dedup.jsonl \
  --file2 eval/results/human_002_mengshu-dedup.jsonl

# 3. 仲裁分歧
node eval/tools/annotator.js arbitrate \
  --conflicts eval/results/conflicts_mengshu-dedup.json \
  --arbitrator human_003

# 4. 合并结果
node eval/tools/annotator.js merge \
  --suite mengshu-dedup \
  --file1 eval/results/human_001_mengshu-dedup.jsonl \
  --file2 eval/results/human_002_mengshu-dedup.jsonl \
  --arbitrated eval/results/arbitrated.json \
  --output eval/goldens/mengshu-dedup-annotated.jsonl

# 5. 更新 manifest
shasum -a 256 eval/goldens/mengshu-dedup-annotated.jsonl
# 手动更新 eval/goldens/manifest.json

# 6. 验证
npm run eval:quick -- mengshu-dedup
```

---

## 五、关键设计决策

### 5.1 标注元数据格式

按照设计 §15.5 要求，每条 case 增加以下元数据：

**extraction 套件**：
```json
{
  "annotation": {
    "annotator": "human_001",
    "annotatedAt": "2026-06-17T10:30:00Z",
    "reviewedBy": "human_002",
    "reviewedAt": "2026-06-17T14:00:00Z",
    "agreement": "full",
    "boundaryCase": false,
    "notes": "evidence span 已人工核对"
  }
}
```

**dedup 套件**：
```json
{
  "annotation": {
    "annotator_1": "human_001",
    "annotator_1_label": "duplicate",
    "annotator_2": "human_002",
    "annotator_2_label": "duplicate",
    "agreement": "full",
    "boundaryCase": true,
    "lexicalSimilarity": 0.89,
    "annotatedAt": "2026-06-17T10:30:00Z",
    "notes": "中文近义词，0.88 阈值边界"
  }
}
```

**仲裁记录**：
```json
{
  "annotation": {
    "annotator_1": "human_001",
    "annotator_1_label": "update",
    "annotator_2": "human_002",
    "annotator_2_label": "related",
    "agreement": "arbitrated",
    "arbitrator": "human_003",
    "finalLabel": "update",
    "arbitrationReason": "B 增加了 why，属于增量信息",
    "annotatedAt": "2026-06-17T10:30:00Z",
    "arbitratedAt": "2026-06-17T16:00:00Z"
  }
}
```

### 5.2 一致性门禁

使用 **Cohen's Kappa** 计算一致性：

| Kappa 值 | 判定 | 操作 |
|----------|------|------|
| >= 0.85 | 优秀 | 直接合并 |
| 0.70 - 0.85 | 良好 | 仲裁分歧样例后合并 |
| < 0.70 | 不足 | 重新标注 |

### 5.3 边界样例标记

从现有 golden set 中挑选边界样例：

**extraction（20 条）**：
- ext-066~070：应抽不抽/不应抽却抽（5 条）
- ext-015~018：拒绝闸门测试（4 条）
- ext-087~090：敏感信息拦截（4 条）
- ext-091~094：type 边界（4 条）
- ext-098~100：evidence 引用（3 条）

**dedup（15 条）**：
- dd-002, dd-008：中文近义词
- dd-006, dd-010：冗余词汇
- dd-022, dd-030：否定等价
- dd-031~033：update 边界
- dd-035, dd-040：从建议到规则
- dd-069~070：高 lexical 但不 duplicate

这些边界样例需要第三人额外审核。

---

## 六、资源估算

### 6.1 人力投入

| 阶段 | 标注人 | 审核人 | 仲裁人 | 预计工时 |
|------|--------|--------|--------|----------|
| P0-c | 2 人 | 1 人 | 1 人 | 3-4 天 |
| P1 | 2 人 | 1 人 | 1 人 | 5-6 天 |
| P2 | 1 人（持续） | 1 人（每周） | - | 2 小时/周 |

### 6.2 工具开发

| 工具 | 状态 | 工时 |
|------|------|------|
| eval/tools/annotator.js | ✅ 完成 | 1 天 |
| eval/ANNOTATION_GUIDE.md | ✅ 完成 | 0.5 天 |
| eval/EXPANSION_PLAN.md | ✅ 完成 | 0.5 天 |
| eval/tools/annotation-workflow-example.sh | ✅ 完成 | 0.5 天 |

**总计**：2.5 天（已完成）

---

## 七、下一步行动

### 立即执行（P0-c）

1. **招募标注团队**：
   - [ ] 2 名标注人（需熟悉记忆系统设计）
   - [ ] 1 名审核人（需熟悉 §15.5 标注策略）
   - [ ] 1 名仲裁人（最终决策权）

2. **标注前培训**（0.5 天）：
   - [ ] 阅读 `eval/ANNOTATION_GUIDE.md`
   - [ ] 试标 5 条样例
   - [ ] 讨论边界 case 判定准则

3. **执行标注**（3-4 天）：
   - [ ] mengshu-extraction 100 条
   - [ ] mengshu-dedup 80 条
   - [ ] mengshu-recall-explain 60 条

4. **验收**：
   - [ ] 一致性 >= 0.85
   - [ ] 边界样例第三人审核通过
   - [ ] rules 冲突 false merge=0
   - [ ] 所有 suite 通过 `npm run eval:quick`

### 后续计划

- **P1（5-6 天）**：扩充 tree-summary + conflict
- **P2（持续）**：主动学习采样，每周 25 条

---

## 八、参考文档

- 设计 §15.5：标注策略
- 设计 §15.3：强制约束（确定性判定与 LLM 信号分离）
- 设计 §15.4：误判样例与回归
- `eval/EXPANSION_PLAN.md`：扩充计划
- `eval/ANNOTATION_GUIDE.md`：标注规范
- `eval/README.md`：评测基础设施

---

## 九、总结

### 已完成

✅ **工具链完整**：
- 标注工具支持双人标注、一致性计算、仲裁、合并
- 标注规范详细定义 type 判定、关系枚举、边界样例
- 扩充计划明确 P0-P2 路线图
- 示例脚本演示完整流程

✅ **P0-c 骨架达标**：
- extraction 100 条 ✓
- dedup 80 条 ✓
- recall-explain 60 条 ✓

### 待执行

⏳ **人工标注**：
- 招募标注团队（2+1+1 人）
- 执行双人独立标注（3-4 天）
- 仲裁分歧样例
- 验收通过

### 价值

从经验值到验证值的转换，将：
1. **提升可信度**：一致性 >= 0.85，有仲裁记录
2. **可追溯**：标注元数据完整（annotator/reviewer/arbitrator）
3. **可扩展**：工具链支持持续扩容（P2 主动学习）
4. **可复现**：标注规范详细，未来可按同样流程扩充

---

**当前状态**：工具和文档就绪，等待人工标注团队启动。
