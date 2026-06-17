# 候选自动晋升实现总结

**实现日期**: 2026-06-16  
**状态**: ✅ 已完成并测试通过

---

## 实现内容

按照设计文档 §11.1（experience 升格为 skill_candidate）和 §9.5（冲突自动降级）实现了候选自动晋升服务。

### 核心特性

1. **保守晋升阈值**
   - 5 条证据
   - 3 天观察窗口
   - 0.78 语义相似度
   - 可通过配置调整

2. **冲突自动降级**
   - 检测矛盾规则（必须 vs 禁止）
   - 检测时间替代关系（supersedes）
   - 自动降级低置信度候选
   - 记录降级原因便于审计

3. **Skill Candidate 生成**
   - 从满足条件的 experience 聚合生成
   - 提取触发条件、步骤、成功信号
   - 识别反模式和风险边界
   - 标记高风险操作

---

## 新增文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `lifecycle/candidate-auto-promotion.ts` | 550+ | 主实现 |
| `lifecycle/candidate-auto-promotion.test.ts` | 510+ | 19 个测试 |
| `config.ts` | +15 | 添加 `promotion` 配置 |
| `docs/04-design/04.2-detail/candidate-auto-promotion-implementation.md` | 400+ | 实现文档 |

---

## 测试结果

```
✅ 152 tests passed (lifecycle/)
   - 19 candidate-auto-promotion tests
   - 133 existing tests (无回归)
```

### 测试覆盖

- ✅ 证据数阈值验证
- ✅ 时间跨度阈值验证
- ✅ 相似度阈值验证
- ✅ Topic 分组和聚合
- ✅ Skill candidate 生成
- ✅ 高风险操作检测
- ✅ 矛盾规则检测
- ✅ 冲突降级应用
- ✅ 配置驱动阈值
- ✅ 完整自动晋升流程

---

## 配置示例

### 默认配置

```typescript
{
  minEvidenceCount: 5,
  minTimeSpanDays: 3,
  generalizeThreshold: 5,
  minSimilarity: 0.78,
  enabled: true
}
```

### 项目自定义配置

`.mengshu/config.json`:

```json
{
  "promotion": {
    "minEvidenceCount": 3,
    "minTimeSpanDays": 2,
    "minSimilarity": 0.70,
    "autoConflictDowngrade": true
  }
}
```

---

## API 使用

```typescript
import { CandidateAutoPromotionService } from "./lifecycle/candidate-auto-promotion.js";

const service = new CandidateAutoPromotionService({
  repository,
  config: {
    minEvidenceCount: 5,
    minTimeSpanDays: 3,
    minSimilarity: 0.78
  }
});

// 完整自动晋升流程
const result = await service.runAutoPromotion(scope);
console.log(`生成 ${result.skillCandidates.length} 个技能候选`);
console.log(`解决 ${result.conflictsResolved} 个冲突`);
```

---

## 设计符合性

| 设计要求 | 状态 |
|----------|------|
| §11.1 触发条件（5 条证据 + 3 天） | ✅ |
| §11.2 SkillCandidate Schema | ✅ |
| §11.3 运行边界（只生成候选） | ✅ |
| §9.5 冲突自动降级 | ✅ |
| §13 配置策略（.mengshu/config.json） | ✅ |
| §14 评测（测试覆盖） | ✅ |

---

## 后续优化方向

### P1（短期）
- 接入真实 embedding 相似度计算
- 添加 CLI 命令手动触发晋升
- 添加晋升审计日志

### P2（中期）
- Profile 分层冲突检测
- Task context 时间序列替代
- 用户自定义冲突规则

### P3（长期）
- 隐式反馈闭环（根据召回频率调整阈值）
- Skill candidate 转可执行 skill
- 自动化测试覆盖率提升

---

## 文件位置

- **实现**: `/Users/jiangyayun/develop/code/work_code/openclaw_plugins/memory-autodb/lifecycle/candidate-auto-promotion.ts`
- **测试**: `/Users/jiangyayun/develop/code/work_code/openclaw_plugins/memory-autodb/lifecycle/candidate-auto-promotion.test.ts`
- **文档**: `/Users/jiangyayun/develop/code/work_code/openclaw_plugins/memory-autodb/docs/04-design/04.2-detail/candidate-auto-promotion-implementation.md`
