# Leaf 分级路由实现完成报告

**日期**: 2026-06-17  
**任务**: 实现 D-03 决策 - leaf 分级路由  
**状态**: ✅ 完成

---

## 实现内容

按照 `docs/04-design/04.2-detail/memory-system-unified-design.md` §0.3 D-03 决策，实现了 leaf 分级路由功能：

### 核心逻辑

1. **准入阈值**: `valueScore >= 0.55` 才准入 leaf
2. **分级路由**:
   - `0.55-0.70`: 仅进入 source tree
   - `>= 0.70`: 才可进入 topic/global tree
3. **防止噪声**: 低价值 leaf 不扩散到 topic/global 树

### 新增文件

1. **`tree/leaf-routing.ts`** (169 行)
   - 核心路由决策函数 `routeLeaf()`
   - 便捷函数 `shouldRouteToTree()`
   - 常量定义：`LEAF_ADMISSION_THRESHOLD`、`TOPIC_TREE_THRESHOLD`、`GLOBAL_TREE_IMPORTANCE`

2. **`tree/leaf-routing.test.ts`** (254 行)
   - 22 个测试用例，全部通过
   - 覆盖场景：
     - D-03 准入阈值验证
     - 分级路由（0.55-0.70 仅 source tree）
     - topic tree 评估（>= 0.70）
     - global tree 门槛（importance >= 0.85）
     - 敏感信息过滤
     - 边界值测试
     - 组合场景测试

3. **`tree/LEAF_ROUTING_INTEGRATION.md`** (集成指南)
   - 使用说明
   - 集成步骤
   - 典型场景示例
   - 后续工作计划

### 修改文件

1. **`tree/topic.ts`**
   - 导入 `shouldRouteToTree` 和 `LeafRoutingInput`
   - 更新 `routeLeafToTopicTree()` 函数签名，增加 `routingInput` 参数
   - 在路由前先判断 leaf 是否满足 topic tree 门槛（D-03）

2. **`tree/topic.test.ts`**
   - 更新现有测试以适应新的函数签名
   - 新增 2 个 D-03 验证测试：
     - `valueScore < 0.70` 不路由到 topic tree
     - `valueScore >= 0.70` 且 entity hot 才路由

---

## 测试结果

```bash
✅ tree/leaf-routing.test.ts   22 passed
✅ tree/topic.test.ts           7 passed
✅ tree/buffer.test.ts          21 passed
✅ tree/faithfulness.test.ts    11 passed
✅ tree/global.test.ts          4 passed
✅ tree/seal.test.ts            10 passed
✅ tree/build-tree-handler.test.ts  1 passed
-------------------------------------------
Total: 76 passed
```

所有 tree 相关测试全部通过，无破坏性变更。

---

## 设计决策对齐

| 决策项 | 设计文档要求 | 实现状态 |
|--------|-------------|---------|
| D-03 准入阈值 | `>= 0.55` | ✅ `LEAF_ADMISSION_THRESHOLD = 0.55` |
| D-03 分级路由 | `0.55-0.70` 仅 source tree | ✅ `TOPIC_TREE_THRESHOLD = 0.70` |
| topic tree 门槛 | `>= 0.70` 且 `importance >= 0.55` | ✅ 已实现 |
| global tree 门槛 | `importance >= 0.85` | ✅ `GLOBAL_TREE_IMPORTANCE = 0.85` |
| 敏感信息过滤 | sensitive + session/project 不进 global | ✅ 已实现 |
| profile 类型 | 不进 topic tree（走独立层） | ✅ 已实现 |
| workspace rule | 优先进 global tree | ✅ 已实现 |
| 显式 global | 用户明确要求进 global | ✅ 已实现 |

---

## 代码质量

- ✅ TypeScript 严格类型检查
- ✅ 完整的 JSDoc 注释
- ✅ 可解释性：decision.reason 包含详细决策理由
- ✅ 可测试性：纯函数，确定性输出
- ✅ 可维护性：阈值集中定义，易于调整

---

## 后续工作

### P1（集成到主流程）

- [ ] 在 `lifecycle/extract-candidate-handler.ts` 中集成路由决策
- [ ] 在 `ingest/pipeline.ts` 中对文档 chunk 应用路由
- [ ] 实现 `computeImportance` 函数（`processing/importance.ts`）
- [ ] 在 candidate admission 时计算 valueScore 和 importance

### P2（监控和优化）

- [ ] 添加路由决策 audit 日志
- [ ] 实现 `ms tree stats` CLI 命令
- [ ] 收集 telemetry 数据验证阈值合理性

---

## 文件清单

```
tree/
├── leaf-routing.ts              # 新增：核心路由逻辑
├── leaf-routing.test.ts         # 新增：完整测试套件
├── LEAF_ROUTING_INTEGRATION.md  # 新增：集成指南
├── topic.ts                     # 修改：集成分级路由
└── topic.test.ts                # 修改：更新测试
```

---

## 参考文档

- **设计文档**: `docs/04-design/04.2-detail/memory-system-unified-design.md`
  - §0.3 D-03 决策
  - §7.2 Leaf 准入
  - §7.3 三棵树的路由规则
- **集成指南**: `tree/LEAF_ROUTING_INTEGRATION.md`

---

**实现人**: AI Assistant  
**审核状态**: 待审核  
**合并状态**: 待合并到主分支
