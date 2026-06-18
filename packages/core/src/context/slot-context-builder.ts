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
 * - docs/03-architecture/mengshu-deep-optimization-architecture.md §5/§9
 */

import type {
  ContextFastResponse,
  FilteredEntry,
  FilteredReason,
  SlotContextBlock,
} from "../domain/semantic-types.js";
import { FIVE_QUESTIONS, lifecycleStatusToFilteredReason } from "../domain/semantic-types.js";
import type {
  MemoryLifecycleStatus,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  MemoryVisibility,
} from "../domain/types.js";
import {
  SlotSnapshotCache,
  globalSlotSnapshotCache,
  RECOMMENDED_TTL,
} from "./slot-snapshot.js";
import { kindToSemanticType } from "../domain/semantic-type-mapper.js";
import {
  DEFAULT_RECALL_WEIGHTS,
  sortByNodeScore,
  type RecallWeights,
} from "../domain/recall-scoring.js";
import { packSlotsToPrompt } from "./slot-prompt-packer.js";
import { mergeProfileByLayer, enrichProfileLayer } from "../domain/profile-layer.js";

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
  /** 召回评分权重（默认 DEFAULT_RECALL_WEIGHTS） */
  weights?: RecallWeights;
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
      weights = DEFAULT_RECALL_WEIGHTS,
    } = options;

    const warnings: string[] = [];
    // filtered：累积所有被过滤出必读层的记忆解释（生命周期/无类型/超预算）
    const filtered: FilteredEntry[] = [];
    let cacheHit = false;

    // 1. 生命周期过滤：仅保留 active，其余按状态记入 filtered
    const { kept, filtered: lifecycleFiltered } = this.applyLifecycleFilter(allRecords);
    filtered.push(...lifecycleFiltered);

    // 2. 为没有 semanticType 的记忆自动映射
    const enriched = this.enrichSemanticType(kept);

    // 3. 按 semanticType 分组，无法归类的记入 filtered(no_semantic_type)
    const { grouped, filtered: ungrouped } = this.groupBySemanticType(enriched);
    filtered.push(...ungrouped);

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

      // 4.2 构建新槽位（selectTopNodes 同时返回超预算被裁掉的记录）
      const records = grouped[semanticType] ?? [];
      const budget = options.tokenBudgetPerSlot ?? SLOT_BUDGET_DEFAULT[semanticType];
      const { selected, overflow } = this.selectTopNodes(records, budget, weights);

      slots[semanticType] = this.recordsToBlock(selected, semanticType, budget);

      for (const record of overflow) {
        filtered.push({
          recordId: record.id,
          reason: "budget_exceeded",
          semanticType,
        });
      }

      // 4.3 缓存结果
      if (useCache) {
        this.cache.create(
          scope,
          semanticType,
          selected,
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
      filtered,
      filteredSummary: this.summarizeFiltered(filtered),
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
   * 应用生命周期过滤：仅保留 active，其余按状态记入 filtered。
   * 必读层只接受 active；archived/promoted 通过 lookup 检索。
   */
  private applyLifecycleFilter(records: MemoryRecord[]): {
    kept: MemoryRecord[];
    filtered: FilteredEntry[];
  } {
    const kept: MemoryRecord[] = [];
    const filtered: FilteredEntry[] = [];
    for (const record of records) {
      const status: MemoryLifecycleStatus = record.lifecycleStatus ?? "active";
      if (status === "active") {
        kept.push(record);
        continue;
      }
      const reason = lifecycleStatusToFilteredReason(status);
      if (reason) {
        filtered.push({ recordId: record.id, reason, semanticType: record.semanticType });
      }
    }
    return { kept, filtered };
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
   * 按 semanticType 分组；无法归类的记入 filtered(no_semantic_type)。
   * 注意：no_semantic_type 是降级为 lookup-only，不是错误。
   *
   * D-13 profile 分层合并：
   * - profile 类型按 profileLayer 合并（project > app > global）
   * - 同 profileDimension 保留高层，低层记入 filtered(overridden_by_layer)
   */
  private groupBySemanticType(records: MemoryRecord[]): {
    grouped: Partial<Record<MemorySemanticType, MemoryRecord[]>>;
    filtered: FilteredEntry[];
  } {
    const grouped: Partial<Record<MemorySemanticType, MemoryRecord[]>> = {};
    const filtered: FilteredEntry[] = [];

    // 1. 先按 semanticType 初步分组
    const byType: Partial<Record<MemorySemanticType, MemoryRecord[]>> = {};
    for (const record of records) {
      if (!record.semanticType) {
        filtered.push({ recordId: record.id, reason: "no_semantic_type" });
        continue;
      }
      if (!byType[record.semanticType]) {
        byType[record.semanticType] = [];
      }
      byType[record.semanticType]!.push(record);
    }

    // 2. 对 profile 类型应用分层合并（D-13）
    if (byType.profile && byType.profile.length > 0) {
      // 2.1 为缺失 profileLayer 的记忆自动补充
      const enriched = byType.profile.map((r) => enrichProfileLayer(r));

      // 2.2 按层级合并
      const { active, overridden, unclassified } = mergeProfileByLayer(enriched);

      // 2.3 active + unclassified 进入 grouped
      grouped.profile = [...active, ...unclassified];

      // 2.4 overridden 记入 filtered
      for (const record of overridden) {
        filtered.push({
          recordId: record.id,
          reason: "overridden_by_layer" as FilteredReason,
          semanticType: "profile",
          metadata: {
            overriddenBy: record.overriddenBy,
            profileDimension: record.profileDimension,
          },
        });
      }
    }

    // 3. 其他类型直接复制
    for (const type of Object.keys(byType) as MemorySemanticType[]) {
      if (type !== "profile") {
        grouped[type] = byType[type];
      }
    }

    return { grouped, filtered };
  }

  /**
   * 选择 top-N 节点：按显式权重打分（recall-scoring）降序，截断到字符预算。
   * 返回 selected（入选）与 overflow（超预算被裁掉，记为 budget_exceeded）。
   */
  private selectTopNodes(
    records: MemoryRecord[],
    charBudget: number,
    weights: RecallWeights = DEFAULT_RECALL_WEIGHTS,
  ): { selected: MemoryRecord[]; overflow: MemoryRecord[] } {
    const sorted = sortByNodeScore(records, weights);

    const selected: MemoryRecord[] = [];
    const overflow: MemoryRecord[] = [];
    let used = 0;
    for (const record of sorted) {
      const cost = record.text.length + 4;
      if (used + cost > charBudget) {
        overflow.push(record);
        continue;
      }
      selected.push(record);
      used += cost;
    }
    return { selected, overflow };
  }

  /**
   * 按 reason 聚合 filtered 计数，保持稳定的首次出现顺序。
   */
  private summarizeFiltered(
    filtered: FilteredEntry[],
  ): Array<{ reason: FilteredReason; count: number }> {
    const order: FilteredReason[] = [];
    const counts = new Map<FilteredReason, number>();
    for (const entry of filtered) {
      if (!counts.has(entry.reason)) {
        order.push(entry.reason);
      }
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    }
    return order.map((reason) => ({ reason, count: counts.get(reason) ?? 0 }));
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
