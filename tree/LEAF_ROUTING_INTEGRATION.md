# Leaf 分级路由集成指南（D-03 实现）

> **版本**: v1.0  
> **日期**: 2026-06-17  
> **关联决策**: D-03（§0.3 / §7.2 / §7.3）

---

## 概述

本文档说明如何在 mengshu 记忆系统中集成 D-03 决策的 leaf 分级路由功能：

- **准入阈值**: `valueScore >= 0.55` 才准入 leaf
- **分级路由**: `0.55-0.70` 仅进入 source tree，`>= 0.70` 才进入 topic/global tree
- **防止噪声**: 低价值 leaf 不扩散到 topic/global 树

---

## 核心模块

### 1. `tree/leaf-routing.ts`

提供核心路由决策函数：

```typescript
import { routeLeaf, shouldRouteToTree, type LeafRoutingInput } from "./tree/leaf-routing.js";

// 完整路由决策
const decision = routeLeaf({
  valueScore: 0.75,
  importance: 0.8,
  hasTopicLabel: true,
  semanticType: "experience",
  scopeVisibility: "project",
});

console.log(decision.admitted);     // true
console.log(decision.treeTypes);    // ["source", "topic"]
console.log(decision.reason);       // 详细决策理由

// 便捷函数：判断是否路由到特定树
if (shouldRouteToTree(input, "topic")) {
  // 路由到 topic tree
}
```

### 2. `tree/topic.ts`

更新后的 `routeLeafToTopicTree` 函数，集成分级路由：

```typescript
import { routeLeafToTopicTree } from "./tree/topic.js";
import type { LeafRoutingInput } from "./tree/leaf-routing.js";

const routed = await routeLeafToTopicTree(
  repository,
  leaf,
  entities,
  {
    valueScore: 0.75,        // D-03: >= 0.70 才进 topic tree
    importance: 0.8,
    hasTopicLabel: true,
    semanticType: "experience",
  },
  Date.now(),
);
```

---

## 集成步骤

### 步骤 1: 计算 valueScore 和 importance

在候选提取或 leaf 创建时，计算这两个评分：

```typescript
import { computeValueScore, type ValueScoreSignals } from "./processing/value-score.js";
import { computeImportance } from "./processing/importance.js"; // 需要实现

const signals: ValueScoreSignals = {
  explicitness: 0.8,
  durability: 0.7,
  actionability: 0.8,
  specificity: 0.6,
  evidence: 0.7,
  scopeFit: 0.9,
  novelty: 0.8,
  riskPenalty: 0,
};

const valueScore = computeValueScore(signals);
const importance = computeImportance({
  salience_llm: 0.75,
  sourceAuthority: 0.8,
  explicitnessBonus: 1.0,
  typePrior: 0.85,
});
```

### 步骤 2: 构建路由输入

```typescript
import type { LeafRoutingInput } from "./tree/leaf-routing.js";

const routingInput: LeafRoutingInput = {
  valueScore,
  importance,
  hasTopicLabel: Boolean(candidate.topicLabel),
  semanticType: candidate.semanticType,
  scopeVisibility: candidate.scope.name,
  riskFlags: candidate.riskFlags,
  explicitGlobal: candidate.metadata.explicitGlobal,
  isWorkspaceRule: 
    candidate.semanticType === "rules" &&
    (candidate.scope.name === "workspace" || candidate.scope.name === "team"),
};
```

### 步骤 3: 执行路由决策

```typescript
import { routeLeaf } from "./tree/leaf-routing.js";

const decision = routeLeaf(routingInput);

if (!decision.admitted) {
  console.log(`Leaf rejected: ${decision.reason}`);
  return;
}

// 根据 decision.treeTypes 路由到相应的树
for (const treeType of decision.treeTypes) {
  switch (treeType) {
    case "source":
      await appendLeafToBuffer(repository, {
        scope: leaf.scope,
        treeType: "source",
        treeKey: leaf.sourceId,
        leaf,
        now: Date.now(),
      });
      break;

    case "topic":
      await routeLeafToTopicTree(
        repository,
        leaf,
        entities,
        routingInput,
        Date.now(),
      );
      break;

    case "global":
      await appendLeafToBuffer(repository, {
        scope: leaf.scope,
        treeType: "global",
        treeKey: dayKey(leaf.eventAt),
        leaf,
        now: Date.now(),
      });
      break;
  }
}
```

---

## 典型场景

### 场景 1: 低价值候选（0.55 ≤ valueScore < 0.70）

```typescript
const input: LeafRoutingInput = {
  valueScore: 0.60,
  importance: 0.5,
  hasTopicLabel: true,
  semanticType: "resource",
};

const decision = routeLeaf(input);
// admitted: true
// treeTypes: ["source"]
// reason: "valueScore 0.60 >= 0.55 → source tree; valueScore 0.60 < 0.7 → skip topic/global"
```

**结果**: 仅进入 source tree，不污染 topic/global 树。

### 场景 2: 中价值候选（0.70 ≤ valueScore < 0.85）

```typescript
const input: LeafRoutingInput = {
  valueScore: 0.75,
  importance: 0.65,
  hasTopicLabel: true,
  semanticType: "experience",
};

const decision = routeLeaf(input);
// admitted: true
// treeTypes: ["source", "topic"]
// reason: "...→ source tree; ...→ topic tree; importance 0.65 < 0.85 ...→ skip global tree"
```

**结果**: 进入 source 和 topic 树，但不进入 global 树。

### 场景 3: 高价值候选（importance >= 0.85）

```typescript
const input: LeafRoutingInput = {
  valueScore: 0.80,
  importance: 0.90,
  hasTopicLabel: true,
  semanticType: "rules",
};

const decision = routeLeaf(input);
// admitted: true
// treeTypes: ["source", "topic", "global"]
```

**结果**: 进入全部三棵树。

### 场景 4: 敏感信息阻止进入 global

```typescript
const input: LeafRoutingInput = {
  valueScore: 0.85,
  importance: 0.90,
  hasTopicLabel: true,
  scopeVisibility: "session",
  riskFlags: ["sensitive"],
};

const decision = routeLeaf(input);
// admitted: true
// treeTypes: ["source", "topic"]  // 不含 "global"
// reason: "...sensitive + session/project scope → skip global tree"
```

**结果**: 高价值但含敏感信息且 scope 为 session/project，不进入 global 树。

---

## 配置阈值

所有阈值集中在 `tree/leaf-routing.ts` 中定义：

```typescript
export const LEAF_ADMISSION_THRESHOLD = 0.55;  // 最低准入阈值
export const TOPIC_TREE_THRESHOLD = 0.70;      // topic/global tree 门槛
export const GLOBAL_TREE_IMPORTANCE = 0.85;    // global tree 的 importance 门槛
```

若需调整阈值，修改这些常量并重新运行测试验证。

---

## 测试验证

运行完整测试套件：

```bash
# 测试核心路由逻辑
npm test -- tree/leaf-routing.test.ts

# 测试 topic tree 集成
npm test -- tree/topic.test.ts

# 运行所有 tree 相关测试
npm test -- tree/
```

测试覆盖：
- ✅ D-03 准入阈值（0.55）
- ✅ 分级路由（0.55-0.70 仅 source，≥0.70 进 topic）
- ✅ global tree 门槛（importance ≥ 0.85）
- ✅ 敏感信息过滤
- ✅ workspace rule 例外
- ✅ 显式 global 保存
- ✅ profile 类型不进 topic tree
- ✅ 边界值测试

---

## 后续工作

### P0（核心路由已完成）

- [x] 实现 `tree/leaf-routing.ts` 核心逻辑
- [x] 更新 `tree/topic.ts` 集成分级路由
- [x] 完整测试覆盖

### P1（集成到主流程）

- [ ] 在 `lifecycle/extract-candidate-handler.ts` 中集成路由决策
- [ ] 在 `ingest/pipeline.ts` 中对文档 chunk 应用路由
- [ ] 实现 `computeImportance` 函数（`processing/importance.ts`）
- [ ] 在 candidate admission 时计算 valueScore 和 importance

### P2（监控和优化）

- [ ] 添加路由决策 audit 日志
- [ ] 实现 `ms tree stats` CLI 命令（显示各树的 leaf 分布）
- [ ] 收集 telemetry 数据验证阈值合理性
- [ ] A/B 测试阈值优化

---

## 参考

- **设计文档**: `docs/04-design/04.2-detail/memory-system-unified-design.md`
  - §0.3 D-03 决策
  - §7.2 Leaf 准入
  - §7.3 三棵树的路由规则
- **实现代码**:
  - `tree/leaf-routing.ts` - 核心路由逻辑
  - `tree/leaf-routing.test.ts` - 完整测试套件
  - `tree/topic.ts` - topic tree 集成
- **评分系统**:
  - `processing/value-score.ts` - valueScore 计算
  - `processing/scoring-weights.ts` - 权重配置

---

**版本历史**:
- v1.0 (2026-06-17): 初始版本，D-03 分级路由实现完成
