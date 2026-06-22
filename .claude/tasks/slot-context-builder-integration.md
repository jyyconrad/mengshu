# SlotContextBuilder 集成完成报告

**任务**: 在 `ingest-history.ts` 的 QA 阶段用 SlotContextBuilder 替换简化 slot context 拼接

**状态**: ✅ 完成

**修改日期**: 2026-06-20

---

## 修改摘要

### 1. 导入 SlotContextBuilder 和类型
**文件**: `plugins/openclaw/src/cli/ingest-history.ts`

新增导入：
```typescript
import { SlotContextBuilder } from "../../../../packages/core/src/context/slot-context-builder.js";
import type { MemoryScope, RecallResult } from "../../../../packages/core/src/domain/types.js";
```

### 2. 扩展 IngestHistoryCliDeps 接口
新增 `defaultScope` 字段：
```typescript
export interface IngestHistoryCliDeps {
  adapters?: SourceAdapter[];
  cwd?: () => string;
  service?: any;
  embeddings?: any;
  llmClient?: any;
  defaultScope?: MemoryScope;  // 新增
}
```

### 3. 修改召回阶段
**位置**: line 967

新增 `recallResults` 数组保存原始 `RecallResult`：
```typescript
const recallResults: RecallResult[] = [];  // 新增
```

在召回循环中保存结果（line 1037）：
```typescript
// 保存原始 RecallResult 供 QA 阶段使用
recallResults.push(result);
```

### 4. 重构 QA 阶段
**位置**: line 1083-1148

#### 修改前（简化拼接）
```typescript
const memoryContent = recall.topResults
  .map((r: any) => `- ${r.contentPreview}`)
  .join("\n");
const slotContext = `<relevant-memories>\n${memoryContent}\n</relevant-memories>`;
```

#### 修改后（标准 5 槽位）
```typescript
// 使用标准 SlotContextBuilder 构建 5 槽位上下文
const scope: MemoryScope = deps.defaultScope ?? {
  tenantId: "",
  appId: "openclaw",
  userId: "default",
  projectId: "",
  agentId: "",
  namespace: "",
};

// 从 RecallHit 提取 MemoryRecord（过滤掉 ChunkRecord 和 SummaryNode）
const memories = result.hits
  .map((hit) => hit.record)
  .filter((record): record is import("...").MemoryRecord => {
    return "kind" in record && "importance" in record && "category" in record;
  });

const contextResponse = await SlotContextBuilder.prototype.buildSlotContext.call(
  new SlotContextBuilder(),
  scope,
  memories,
  {
    useCache: false,
    task: query,
  }
);

const slotContext = contextResponse.content;
```

#### 更新 filledSlots
```typescript
filledSlots: Object.keys(contextResponse.slots).filter(
  (type) => {
    const slot = contextResponse.slots[type as MemorySemanticType];
    return slot && slot.nodeCount > 0;
  }
),
```

### 5. 更新 runRealApply 函数签名
**位置**: line 768-777

新增 `defaultScope?` 参数：
```typescript
async function runRealApply(
  report: DryRunReport,
  validationDir: string,
  deps: {
    service: any;
    embeddings: any;
    llmClient: any;
    defaultScope?: MemoryScope;  // 新增
    maxCases: number;
  },
): Promise<void>
```

调用处也同步更新（line 128-133）：
```typescript
await runRealApply(report, validationDir, {
  service: deps.service,
  embeddings: deps.embeddings,
  llmClient: deps.llmClient,
  defaultScope: deps.defaultScope,  // 新增
  maxCases,
});
```

### 6. 在 project.ts 转发 defaultScope
**文件**: `plugins/openclaw/src/cli/project.ts`
**位置**: line 295-306

```typescript
registerIngestHistoryCommand(project, {
  cwd: deps.cwd,
  service: deps.service,
  embeddings: deps.embeddings,
  llmClient: deps.llmClient,
  defaultScope: {  // 新增
    tenantId: "",
    appId: "openclaw",
    userId: "default",
    projectId: "",
    agentId: "",
    namespace: "",
  },
});
```

---

## 验证结果

### 类型检查
```bash
npx tsc --noEmit
```
✅ 通过（无类型错误）

### 单元测试
```bash
npm test -- --run plugins/openclaw/src/cli/ingest-history.test.ts
```
✅ 通过（3/3 tests passed）

```bash
npm test -- --run packages/core/src/context/slot-context-builder.test.ts
```
✅ 通过（21/21 tests passed）

---

## 预期输出变化

### 修改前（简化格式）
```xml
<relevant-memories>
- Agent 自我提升体系...
- 用户偏好：❌ 讨厌过度询问...
</relevant-memories>
```

### 修改后（5 槽位格式）
```xml
<profile>
- Agent 自我提升体系...
</profile>

<rules>
- 用户偏好：❌ 讨厌过度询问...
</rules>

<experience>
- 历史决策和解决方案...
</experience>
```

### trace 文件变化
**文件**: `phase-4-qa/qa-trace.jsonl`

- `filledSlots`: 从硬编码 `["rules"]` 改为动态提取实际填充的槽位
- `contextPreview`: 从 `<relevant-memories>` 格式改为 5 槽位标签格式
- `injectedMemoryIds`: 从 `topResults.memoryId` 改为 `hits[].record.id`

---

## 运行验证

完整验证命令（需要配置数据库和 LLM）：
```bash
ms project ingest-history --from openclaw --apply --max-cases 5 --save-validation
```

检查输出：
```bash
cat .eval-validation/run-*/phase-4-qa/qa-trace.jsonl | jq '.contextPreview' | head -3
```

预期看到：
- 包含 `<profile>`、`<task_context>`、`<rules>`、`<experience>`、`<resource>` 等标签
- 不再是简化的 `<relevant-memories>` 格式

---

## 依赖关系

本修改依赖：
- `SlotContextBuilder` (`packages/core/src/context/slot-context-builder.ts`)
- `MemoryScope` / `RecallResult` / `MemorySemanticType` 类型定义
- `slot-prompt-packer.ts` (内部依赖，由 SlotContextBuilder 调用)

---

## 注意事项

1. **类型安全**: 使用 TypeScript 类型守卫过滤 `RecallHit.record`，确保只传递 `MemoryRecord` 给 `SlotContextBuilder`
2. **向后兼容**: `defaultScope` 为可选参数，未提供时使用默认值
3. **缓存控制**: QA 阶段使用 `useCache: false`，每次构建新上下文（避免缓存污染）
4. **槽位提取**: 动态提取 `filledSlots`，反映实际填充的语义类型

---

## 后续工作

- [ ] 补充完整的 OpenClaw history 测试数据到 `tests/eval/fixtures/openclaw-history/snippets/`
- [ ] 运行完整 golden set 验证 5 槽位 prompt 对 QA 质量的影响
- [ ] 考虑将 `defaultScope` 从配置文件读取（而非硬编码）

---

**完成时间**: 2026-06-20 16:40
**验证状态**: ✅ 类型检查通过，单元测试通过
**部署状态**: 待运行完整 eval 验证
