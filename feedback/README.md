# Feedback Collector 模块

## 概述

FeedbackCollector 模块负责采集和分析记忆系统的隐式反馈信号，用于优化记忆的重要性评分、召回排序和生命周期管理。

## 核心功能

### 1. 反馈信号类型

- **召回事件（recall）**: 记录记忆被召回的事件，包含查询文本、召回分数、排名等
- **采纳事件（adoption）**: 记录用户实际使用召回记忆的行为
- **拒绝事件（rejection）**: 记录用户忽略或明确拒绝记忆的行为
- **停留事件（dwelling）**: 记录记忆在上下文中的停留时长
- **编辑事件（edit）**: 记录用户编辑记忆的行为
- **显式反馈（explicit_feedback）**: 记录用户的点赞/踩等明确反馈
- **查询命中（query_hit）**: 记录记忆在搜索中被命中
- **上下文注入（context_injection）**: 记录记忆被注入到 agent 上下文

### 2. 采纳类型

- **direct_use**: 直接使用（复制粘贴、引用等）
- **indirect_use**: 间接使用（基于记忆做决策）
- **confirm**: 确认（用户确认记忆正确）
- **extend**: 扩展（用户基于记忆补充信息）
- **reject**: 拒绝（用户明确表示不使用）
- **ignore**: 忽略（用户未使用）

### 3. 反馈统计指标

- **召回次数（recallCount）**: 记忆被召回的总次数
- **采纳次数（adoptionCount）**: 记忆被实际使用的次数
- **采纳率（adoptionRate）**: 采纳次数 / 召回次数
- **平均停留时长（avgDwellingDuration）**: 记忆在上下文中的平均停留时间
- **加权反馈分数（weightedScore）**: 综合各类信号的加权分数

## 使用示例

### 基础使用

```typescript
import { FeedbackCollector, InMemoryFeedbackStore } from "./feedback/index.js";
import type { MemoryScope } from "./core/types.js";

// 创建存储
const store = new InMemoryFeedbackStore();

// 创建采集器
const collector = new FeedbackCollector(store, {
  enabled: true,
  adoptionWindowMs: 5 * 60 * 1000, // 5 分钟采纳窗口
  dwellingThresholdMs: 30 * 1000, // 30 秒停留阈值
  batchSize: 50,
  batchIntervalMs: 5000,
});

await collector.initialize();

// 定义作用域
const scope: MemoryScope = {
  tenantId: "tenant-1",
  appId: "app-1",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "default",
};
```

### 记录召回事件

```typescript
await collector.recordRecall("memory-123", scope, {
  queryText: "如何实现反馈采集",
  recallScore: 0.85,
  recallRank: 1,
  sessionId: "session-456",
  conversationId: "conv-789",
});
```

### 记录采纳事件

```typescript
await collector.recordAdoption("memory-123", scope, {
  adoptionType: "direct_use",
  sessionId: "session-456",
  metadata: {
    adoptionContext: "用户复制了记忆内容",
  },
});
```

### 记录停留时间

```typescript
// 方式 1: 直接记录
await collector.recordDwelling("memory-123", scope, {
  dwellingDuration: 120000, // 2 分钟
  contextSlot: "task_context",
  sessionId: "session-456",
});

// 方式 2: 自动追踪
collector.startDwellingTracking("memory-123", "task_context", "session-456");
// ... 一段时间后
await collector.endDwellingTracking("memory-123", scope, "session-456");
```

### 记录显式反馈

```typescript
// 正面反馈
await collector.recordExplicitFeedback("memory-123", scope, {
  positive: true,
  sessionId: "session-456",
});

// 负面反馈
await collector.recordExplicitFeedback("memory-123", scope, {
  positive: false,
  strength: -1.0,
  sessionId: "session-456",
});
```

### 查询反馈统计

```typescript
// 获取单个记忆的统计
const stats = await collector.getStats("memory-123", scope);
console.log("采纳率:", stats.adoptionRate);
console.log("召回次数:", stats.recallCount);
console.log("加权分数:", stats.weightedScore);

// 批量获取统计
const statsList = await collector.getBatchStats(
  ["memory-1", "memory-2", "memory-3"],
  scope
);

// 查询反馈信号
const signals = await collector.querySignals({
  memoryIds: ["memory-123"],
  signalTypes: ["recall", "adoption"],
  startTime: Date.now() - 7 * 24 * 60 * 60 * 1000, // 最近 7 天
  limit: 100,
});
```

### 检测未采纳的召回

```typescript
// 检测某个会话中未被采纳的记忆
const unadoptedMemoryIds = await collector.detectUnadoptedRecalls("session-456");

// 可以对这些记忆进行处理，例如降低重要性
for (const memoryId of unadoptedMemoryIds) {
  console.log(`记忆 ${memoryId} 被召回但未被采纳`);
}
```

## 配置选项

```typescript
interface FeedbackCollectorConfig {
  /** 是否启用反馈采集 */
  enabled: boolean;

  /** 采纳检测窗口（毫秒），默认 5 分钟 */
  adoptionWindowMs: number;

  /** 停留检测阈值（毫秒），默认 30 秒 */
  dwellingThresholdMs: number;

  /** 统计聚合窗口（天），默认 30 天 */
  aggregationWindowDays: number;

  /** 批量写入大小 */
  batchSize: number;

  /** 批量写入间隔（毫秒） */
  batchIntervalMs: number;

  /** 信号权重配置 */
  weights: {
    recall: number; // 默认 0.1
    adoption: number; // 默认 1.0
    rejection: number; // 默认 -0.5
    dwelling: number; // 默认 0.3
    edit: number; // 默认 0.8
    explicitFeedback: number; // 默认 1.5
    queryHit: number; // 默认 0.2
    contextInjection: number; // 默认 0.15
  };

  /** 是否记录详细元数据 */
  recordDetailedMetadata: boolean;
}
```

## 反馈闭环集成

### 与记忆召回集成

```typescript
// 在召回时记录反馈
async function recallMemories(query: string, scope: MemoryScope) {
  const results = await memorySystem.recall(query, scope);

  // 记录召回事件
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    await feedbackCollector.recordRecall(result.id, scope, {
      queryText: query,
      recallScore: result.score,
      recallRank: i,
      sessionId: getCurrentSessionId(),
    });
  }

  return results;
}
```

### 与记忆重要性评分集成

```typescript
// 使用反馈统计调整重要性
async function adjustImportanceWithFeedback(memoryId: string, scope: MemoryScope) {
  const stats = await feedbackCollector.getStats(memoryId, scope);

  if (!stats) return;

  // 根据采纳率和加权分数调整重要性
  let importanceBoost = 0;

  if (stats.adoptionRate > 0.8) {
    importanceBoost += 0.1; // 高采纳率
  } else if (stats.adoptionRate < 0.2) {
    importanceBoost -= 0.1; // 低采纳率
  }

  if (stats.weightedScore > 10) {
    importanceBoost += 0.05; // 高加权分数
  }

  // 应用调整
  await memorySystem.updateImportance(memoryId, scope, importanceBoost);
}
```

### 与热度（hotness）集成

```typescript
// 根据反馈更新热度
async function updateHotnessFromFeedback(memoryId: string, scope: MemoryScope) {
  const stats = await feedbackCollector.getStats(memoryId, scope);

  if (!stats) return;

  // 计算热度分数
  const hotness =
    Math.log(stats.recallCount + 1) +
    0.5 * stats.adoptionRate +
    (stats.lastRecallAt ? recencyDecay(Date.now(), stats.lastRecallAt) : 0);

  await memorySystem.updateHotness(memoryId, scope, hotness);
}

function recencyDecay(now: number, lastRecallAt: number): number {
  const daysSinceRecall = (now - lastRecallAt) / (24 * 60 * 60 * 1000);
  if (daysSinceRecall <= 1) return 1.0;
  if (daysSinceRecall <= 7) return 0.5;
  if (daysSinceRecall <= 30) return 0.2;
  return 0;
}
```

## 持久化存储

### 实现自定义存储

```typescript
import type { FeedbackStore } from "./feedback/store.js";

class CustomFeedbackStore implements FeedbackStore {
  async initialize(): Promise<void> {
    // 初始化数据库连接
  }

  async storeSignals(signals: FeedbackSignal[]): Promise<void> {
    // 批量写入数据库
  }

  async querySignals(options: FeedbackQueryOptions): Promise<FeedbackSignal[]> {
    // 查询数据库
  }

  // ... 实现其他方法
}

// 使用自定义存储
const customStore = new CustomFeedbackStore();
const collector = new FeedbackCollector(customStore);
```

## 性能优化

### 批量写入

FeedbackCollector 内置批量写入优化，会自动聚合反馈信号后批量写入存储：

- 达到批量大小（默认 50）时立即刷新
- 定时刷新（默认 5 秒）
- 关闭时强制刷新剩余批次

### 内存管理

- 采纳检测上下文会在超过采纳窗口的 2 倍时间后自动清理
- 停留检测上下文在会话结束时自动清理
- 批量队列限制最大 1000 条，防止内存泄漏

### 统计缓存

- 统计数据会缓存 1 小时
- 超过 1 小时未更新时自动重新计算
- 可手动触发重建统计

## 数据清理

```typescript
// 清理 90 天前的信号
const deletedCount = await store.cleanupExpiredSignals(90);
console.log(`已清理 ${deletedCount} 条过期信号`);

// 重建统计数据
await store.rebuildStats(); // 重建所有
await store.rebuildStats("memory-123"); // 重建单个
```

## 测试

运行测试：

```bash
npm test feedback/
```

查看测试覆盖率：

```bash
npm test -- --coverage feedback/
```

## 架构说明

### 模块结构

```
feedback/
├── types.ts                  # 类型定义
├── store.ts                  # 存储接口
├── collector.ts              # 采集器实现
├── in-memory-store.ts        # 内存存储实现
├── collector.test.ts         # 采集器测试
├── in-memory-store.test.ts   # 存储测试
├── index.ts                  # 导出索引
└── README.md                 # 本文档
```

### 设计原则

1. **异步非阻塞**: 反馈采集不应阻塞主流程，使用批量写入和异步更新
2. **可扩展性**: 支持自定义存储实现，适配不同数据库
3. **可配置性**: 提供丰富的配置选项，适应不同场景
4. **可观测性**: 提供详细的统计和查询功能，便于分析和调试
5. **容错性**: 写入失败时自动重试，保护数据不丢失

## 与算法设计文档的对应关系

本模块实现了设计文档 `memory-algorithm-design.md` 中的以下内容：

### § 开放问题 - 隐式反馈闭环

> **问题**: 是否做隐式反馈闭环？  
> **当前建议**: P4 后考虑，先把 queryHits30d 和 recall explain 接上

本模块提供了完整的隐式反馈闭环实现：

- ✅ 召回追踪（queryHits）
- ✅ 采纳率检测
- ✅ 停留时长统计
- ✅ 二次召回检测
- ✅ 加权反馈分数

### § 8.5 Hotness 与任务过期

> hotness 决定 topic 是否值得建树、保留、归档，也影响 status summary 类召回。

本模块提供的统计数据可用于计算 hotness：

```typescript
hotness =
  ln(mentionCount30d + 1) +
  0.5 * distinctSourceCount +
  recencyDecay(now, lastSeenAt) +
  graphCentrality +
  2.0 * queryHits30d;
```

其中：
- `queryHits30d`: 由 `stats.queryHitCount` 提供
- `lastSeenAt`: 由 `stats.lastRecallAt` 提供
- 采纳率可作为质量权重

## 未来扩展

- [ ] 支持 LanceDB/Supabase 持久化存储
- [ ] 提供 CLI 命令查看反馈统计（`ms feedback stats`）
- [ ] 自动化反馈驱动的重要性调整
- [ ] 基于反馈的记忆生命周期管理
- [ ] 反馈数据的可视化分析
- [ ] A/B 测试支持（对比不同召回策略的反馈）
