/**
 * Slot Context Builder
 *
 * 5 槽位上下文构建器，基于 MemoryRecord 聚合生成 Agent 快路径上下文。
 *
 * 核心流程：
 * 1. 接收外部传入的记忆列表（已按 scope 过滤）
 * 2. 自动补充 semanticType（如缺失）
 * 3. 按 semanticType 分组、排序、截断
 * 4. 生成 5 槽位 + prompt-safe content + telemetry
 * 5. 缓存结果到 SlotSnapshot
 *
 * 参考文档：
 * - docs/03-architecture/memory-autodb-deep-optimization-architecture.md §5/§9
 */

import type {
  ContextFastResponse,
  SlotContextBlock,
} from "./semantic-types.js";
import { FIVE_QUESTIONS } from "./semantic-types.js";
import type {
  MemoryLifecycleStatus,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  MemoryVisibility,
} from "./types.js";
import {
  SlotSnapshotCache,
  globalSlotSnapshotCache,
  RECOMMENDED_TTL,
} from "./slot-snapshot.js";
import { kindToSemanticType } from "./semantic-type-mapper.js";

export interface BuildSlotContextOptions {
  /** 每个槽位最大字符预算（默认按 type 推荐） */
  tokenBudgetPerSlot?: number;
  /** 总字符预算（默认 4000） */
  totalTokenBudget?: number;
  /** 延迟预算（毫秒，默认 80ms） */
  latencyBudgetMs?: number;
  /** 是否使用缓存（默认 true） */
  useCache?: boolean;
  /** 自定义缓存实例 */
  cache?: SlotSnapshotCache;
  /** 任务描述（用于上下文标题，可选） */
  task?: string;
}

/**
 * 推荐的槽位字符预算（参考方案文档 §8.4）
 */
const SLOT_BUDGET_DEFAULT: Record<MemorySemanticType, number> = {
  profile: 600,
  task_context: 1000,
  rules: 1000,
  resource: 600,
  experience: 800,
};

/**
 * Prompt 注入模板。
 * 将 5 槽位拼接为可直接放入 Agent prompt 的文本。
 */
function packSlotsToPrompt(
  slots: ContextFastResponse["slots"],
  task?: string
): string {
  const lines: string[] = ["<relevant-memories>"];

  if (task) {
    lines.push(`<task>${escapeForPrompt(task)}</task>`);
  }

  const order: MemorySemanticType[] = [
    "rules", // 规则优先（合规底线）
    "profile",
    "task_context",
    "experience",
    "resource",
  ];

  for (const type of order) {
    const block = slots[type];
    if (!block || block.nodeCount === 0) continue;
    lines.push(`<slot type="${type}" question="${escapeForPrompt(block.question)}">`);
    lines.push(escapeForPrompt(block.content));
    lines.push(`</slot>`);
  }

  lines.push("</relevant-memories>");
  return lines.join("\n");
}

/**
 * 简单的 prompt-safe 转义：剔除可能注入的标签
 */
function escapeForPrompt(text: string): string {
  return text
    .replace(/<\/?relevant-memories>/g, "")
    .replace(/<\/?slot[^>]*>/g, "")
    .replace(/<\/?system>/gi, "");
}

export class SlotContextBuilder {
  private cache: SlotSnapshotCache;

  constructor(cache?: SlotSnapshotCache) {
    this.cache = cache ?? globalSlotSnapshotCache;
  }

  /**
   * 构建 5 槽位上下文（主入口）
   */
  async buildSlotContext(
    scope: MemoryScope,
    allRecords: MemoryRecord[],
    options: BuildSlotContextOptions = {}
  ): Promise<ContextFastResponse> {
    const startTime = Date.now();
    const {
      latencyBudgetMs = 80,
      useCache = true,
      task,
    } = options;

    const warnings: string[] = [];
    let cacheHit = false;

    // 1. 过滤掉 revoked / superseded 记忆，应用 visibility 默认规则
    const filtered = this.applyLifecycleFilter(allRecords);

    // 2. 为没有 semanticType 的记忆自动映射
    const enriched = this.enrichSemanticType(filtered);

    // 3. 按 semanticType 分组
    const grouped = this.groupBySemanticType(enriched);

    // 4. 构建每个槽位
    const slots: ContextFastResponse["slots"] = {};
    const staleSlots: string[] = [];
    let snapshotAtMin: number | undefined;

    for (const semanticType of Object.keys(grouped) as MemorySemanticType[]) {
      // 4.1 检查缓存
      if (useCache) {
        const cached = this.cache.get(scope, semanticType);
        if (cached) {
          slots[semanticType] = this.recordsToBlock(
            cached.topNodes,
            semanticType,
            options.tokenBudgetPerSlot ?? SLOT_BUDGET_DEFAULT[semanticType]
          );
          cacheHit = true;
          snapshotAtMin = snapshotAtMin
            ? Math.min(snapshotAtMin, cached.generatedAt)
            : cached.generatedAt;
          continue;
        }
      }

      // 4.2 构建新槽位
      const records = grouped[semanticType] ?? [];
      const budget = options.tokenBudgetPerSlot ?? SLOT_BUDGET_DEFAULT[semanticType];
      const topNodes = this.selectTopNodes(records, budget);

      slots[semanticType] = this.recordsToBlock(topNodes, semanticType, budget);

      // 4.3 缓存结果
      if (useCache) {
        this.cache.create(
          scope,
          semanticType,
          topNodes,
          RECOMMENDED_TTL[semanticType]
        );
      }
    }

    // 5. 拼接 prompt 注入文本
    const content = packSlotsToPrompt(slots, task);

    // 6. 检查延迟预算
    const latencyMs = Date.now() - startTime;
    if (latencyBudgetMs > 0 && latencyMs > latencyBudgetMs) {
      warnings.push(
        `latency_exceeded: 延迟 ${latencyMs}ms 超过预算 ${latencyBudgetMs}ms`
      );
    }

    // 7. 统计节点数
    const nodesUsed = Object.values(slots).reduce(
      (sum, block) => sum + (block?.nodeCount ?? 0),
      0
    );

    const tokenEstimate = content.length;

    return {
      scope,
      slots,
      content,
      warnings: warnings.length > 0 ? warnings : undefined,
      freshness: {
        slotSnapshotAt: snapshotAtMin,
        staleSlots,
      },
      telemetry: {
        latencyMs,
        nodesUsed,
        cacheHit,
        tokenEstimate,
      },
    };
  }

  /**
   * 应用生命周期过滤：剔除 revoked / superseded
   */
  private applyLifecycleFilter(records: MemoryRecord[]): MemoryRecord[] {
    return records.filter((record) => {
      const status: MemoryLifecycleStatus = record.lifecycleStatus ?? "active";
      // 必读层只接受 active；archived/promoted 通过 lookup 检索
      return status === "active";
    });
  }

  /**
   * 为记忆补充 semanticType（如果缺失）
   */
  private enrichSemanticType(records: MemoryRecord[]): MemoryRecord[] {
    return records.map((record) => {
      if (record.semanticType) {
        return record;
      }
      const mappingResult = kindToSemanticType(record.kind, record);
      if (mappingResult.semanticType && mappingResult.confidence === "high") {
        return { ...record, semanticType: mappingResult.semanticType };
      }
      return record;
    });
  }

  /**
   * 按 semanticType 分组（跳过无法归类的）
   */
  private groupBySemanticType(
    records: MemoryRecord[]
  ): Partial<Record<MemorySemanticType, MemoryRecord[]>> {
    const grouped: Partial<Record<MemorySemanticType, MemoryRecord[]>> = {};

    for (const record of records) {
      if (!record.semanticType) continue;
      if (!grouped[record.semanticType]) {
        grouped[record.semanticType] = [];
      }
      grouped[record.semanticType]!.push(record);
    }

    return grouped;
  }

  /**
   * 选择 top-N 节点（按 importance × hotness 排序，截断到字符预算）
   */
  private selectTopNodes(
    records: MemoryRecord[],
    charBudget: number
  ): MemoryRecord[] {
    const sorted = [...records].sort((a, b) => {
      const scoreA = (a.importance ?? 0.5) * 10 + (a.hotness ?? 0);
      const scoreB = (b.importance ?? 0.5) * 10 + (b.hotness ?? 0);
      return scoreB - scoreA;
    });

    const result: MemoryRecord[] = [];
    let used = 0;
    for (const record of sorted) {
      const cost = record.text.length + 4;
      if (used + cost > charBudget) break;
      result.push(record);
      used += cost;
    }
    return result;
  }

  /**
   * 将记忆列表转换为 SlotContextBlock
   */
  private recordsToBlock(
    records: MemoryRecord[],
    semanticType: MemorySemanticType,
    charBudget: number
  ): SlotContextBlock {
    const content = records.map((r) => `- ${r.text}`).join("\n");
    return {
      semanticType,
      question: FIVE_QUESTIONS[semanticType],
      content,
      sourceIds: records.map((r) => r.id),
      nodeCount: records.length,
      tokenEstimate: content.length,
    };
  }

  /**
   * 使缓存失效
   */
  invalidateCache(scope: MemoryScope, semanticType?: MemorySemanticType): void {
    this.cache.invalidate(scope, semanticType);
  }
}

/**
 * 全局单例实例
 */
export const globalSlotContextBuilder = new SlotContextBuilder();
