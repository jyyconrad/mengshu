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

import { createHash } from "node:crypto";
import type {
  ContextFastResponse,
  FilteredEntry,
  FilteredReason,
  SlotContextBlock,
  ContextAssemblyPlan,
} from "../domain/semantic-types.js";
import { FIVE_QUESTIONS, lifecycleStatusToFilteredReason } from "../domain/semantic-types.js";
import type {
  MemoryLifecycleStatus,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  MemoryVisibility,
  RecallHit,
} from "../domain/types.js";
import {
  SlotSnapshotCache,
  globalSlotSnapshotCache,
  RECOMMENDED_TTL,
} from "./slot-snapshot.js";
import { kindToSemanticType } from "../domain/semantic-type-mapper.js";
import {
  DEFAULT_RECALL_WEIGHTS,
  isRecallScoreBreakdown,
  sortByNodeScore,
  type RecallWeights,
} from "../domain/recall-scoring.js";
import { packSlotsToPrompt } from "./slot-prompt-packer.js";
import { mergeProfileByLayer, enrichProfileLayer } from "../domain/profile-layer.js";
import type { TreeSummaryNode } from "../tree/types.js";
import { validateDeterministicEvidence } from "../tree/faithfulness.js";

export interface BuildSlotContextOptions {
  /** 每个槽位最大字符预算（默认按 type 推荐） */
  tokenBudgetPerSlot?: number;
  /** Per-slot Loadout budget; takes precedence over the uniform request budget. */
  tokenBudgetBySlot?: Partial<Record<MemorySemanticType, number>>;
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
  /** Exact-scope canonical tree summaries used only as governed navigation refs. */
  treeSummaries?: readonly TreeSummaryNode[];
  treeDepth?: "source" | "topic" | "global";
  /** Loadout native policy; excluded types remain explainable but cannot enter R0. */
  allowedSemanticTypes?: readonly MemorySemanticType[];
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

const SLOT_SNAPSHOT_VERSION = 2 as const;
const RETRIEVAL_VERSION = "six-factor-v1";
const SCORING_VERSION = "SCORING_WEIGHTS_V1";
const PROMPT_POLICY_VERSION = "slot-prompt-v2";

function contentHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
    const semanticPolicy = this.applySemanticTypePolicy(enriched, options.allowedSemanticTypes);
    filtered.push(...semanticPolicy.filtered);

    // 3. 按 semanticType 分组，无法归类的记入 filtered(no_semantic_type)
    const { grouped, filtered: ungrouped } = this.groupBySemanticType(semanticPolicy.kept);
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
            this.slotBudget(options, semanticType)
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
      const budget = this.slotBudget(options, semanticType);
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
      assemblyPlan: this.createAssemblyPlan(scope, slots, filtered, task, options),
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
   * F0 生产入口：消费 Retrieval Engine 已完成排序的 RecallHit，禁止在槽位层重算分数。
   * 裸 MemoryRecord 入口仅保留给旧 adapter 与兼容测试。
   */
  async buildSlotContextFromRecallHits(
    scope: MemoryScope,
    allHits: RecallHit[],
    options: BuildSlotContextOptions = {},
  ): Promise<ContextFastResponse> {
    const startTime = Date.now();
    const {
      latencyBudgetMs = 80,
      useCache = true,
      task,
    } = options;
    const warnings: string[] = [];
    const filtered: FilteredEntry[] = [];
    let cacheHit = false;

    const governedHits = allHits.map((hit) => this.assertGovernedRecallHit(hit));
    const { kept, filtered: lifecycleFiltered } = this.applyLifecycleFilterToHits(governedHits);
    filtered.push(...lifecycleFiltered);

    const enriched = kept.map((hit) => ({
      ...hit,
      record: this.enrichSemanticType([hit.record])[0]!,
    }));
    const semanticPolicy = this.applySemanticTypePolicy(
      enriched.map((hit) => hit.record),
      options.allowedSemanticTypes,
    );
    filtered.push(...semanticPolicy.filtered);
    const allowedIds = new Set(semanticPolicy.kept.map((record) => record.id));
    const allowedHits = enriched.filter((hit) => allowedIds.has(hit.record.id));
    const { grouped: groupedRecords, filtered: ungrouped } = this.groupBySemanticType(
      allowedHits.map((hit) => hit.record),
    );
    filtered.push(...ungrouped);

    const hitById = new Map(allowedHits.map((hit) => [hit.record.id, hit]));
    const slots: ContextFastResponse["slots"] = {};
    const staleSlots: string[] = [];
    let snapshotAtMin: number | undefined;

    for (const semanticType of Object.keys(groupedRecords) as MemorySemanticType[]) {
      const hits = (groupedRecords[semanticType] ?? [])
        .map((record) => hitById.get(record.id))
        .filter((hit): hit is RecallHit & { record: MemoryRecord } => hit !== undefined);
      const inputFingerprint = this.recallInputFingerprint(hits, options, semanticType);
      const budget = this.slotBudget(options, semanticType);

      if (useCache) {
        const cached = this.cache.get(scope, semanticType, inputFingerprint);
        if (cached?.topHits) {
          slots[semanticType] = this.hitsToBlock(cached.topHits, semanticType, budget);
          cacheHit = true;
          snapshotAtMin = snapshotAtMin
            ? Math.min(snapshotAtMin, cached.generatedAt)
            : cached.generatedAt;
          continue;
        }
      }

      const { selected, overflow } = this.selectTopHits(hits, budget);
      slots[semanticType] = this.hitsToBlock(selected, semanticType, budget);
      for (const hit of overflow) {
        filtered.push({
          recordId: hit.record.id,
          reason: "budget_exceeded",
          semanticType,
        });
      }

      if (useCache) {
        this.cache.createFromRecallHits(
          scope,
          semanticType,
          selected,
          inputFingerprint,
          RECOMMENDED_TTL[semanticType],
        );
      }
    }

    const content = packSlotsToPrompt(slots, task);
    const latencyMs = Date.now() - startTime;
    if (latencyBudgetMs > 0 && latencyMs > latencyBudgetMs) {
      warnings.push(`latency_exceeded: 延迟 ${latencyMs}ms 超过预算 ${latencyBudgetMs}ms`);
    }
    const nodesUsed = Object.values(slots).reduce(
      (sum, block) => sum + (block?.nodeCount ?? 0),
      0,
    );

    return {
      scope,
      slots,
      content,
      assemblyPlan: this.createAssemblyPlan(scope, slots, filtered, task, options),
      warnings: warnings.length > 0 ? warnings : undefined,
      filtered,
      filteredSummary: this.summarizeFiltered(filtered),
      freshness: { slotSnapshotAt: snapshotAtMin, staleSlots },
      telemetry: {
        latencyMs,
        nodesUsed,
        cacheHit,
        tokenEstimate: content.length,
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
      if (record.container === "session_candidate") {
        filtered.push({
          recordId: record.id,
          reason: "raw_evidence",
          semanticType: record.semanticType,
        });
        continue;
      }
      if (record.metadata?.admissionRoute === "lookup_only") {
        filtered.push({
          recordId: record.id,
          reason: "lookup_only",
          semanticType: record.semanticType,
        });
        continue;
      }
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

  private applyLifecycleFilterToHits(
    hits: Array<RecallHit & { record: MemoryRecord }>,
  ): {
    kept: Array<RecallHit & { record: MemoryRecord }>;
    filtered: FilteredEntry[];
  } {
    const records = hits.map((hit) => hit.record);
    const result = this.applyLifecycleFilter(records);
    const keptIds = new Set(result.kept.map((record) => record.id));
    return {
      kept: hits.filter((hit) => keptIds.has(hit.record.id)),
      filtered: result.filtered,
    };
  }

  private assertGovernedRecallHit(hit: RecallHit): RecallHit & { record: MemoryRecord } {
    const record = hit.record;
    if (!("text" in record) || !("importance" in record)) {
      throw new Error("CONTEXT_MEMORY_RECORD_REQUIRED");
    }
    if (!isRecallScoreBreakdown(hit.scoreBreakdown) ||
        Math.abs(hit.score - hit.scoreBreakdown.score) > 1e-9 ||
        !hit.scoreBreakdown.matchedBy.includes(hit.source)) {
      throw new Error("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
    }
    return hit as RecallHit & { record: MemoryRecord };
  }

  private recallInputFingerprint(
    hits: Array<RecallHit & { record: MemoryRecord }>,
    options: BuildSlotContextOptions,
    semanticType: MemorySemanticType,
  ): string {
    return contentHash({
      hits: hits.map((hit) => {
      const record = hit.record;
      return [
        record.id,
        record.contentHash,
        record.lifecycleStatus ?? "active",
        record.container ?? "project",
        record.semanticType ?? "",
        record.metadata?.admissionRoute ?? "",
        record.updatedAt ?? record.createdAt,
        hit.score,
      ].join(":");
      }).sort(),
      budget: this.slotBudget(options, semanticType),
      allowedSemanticTypes: [...(options.allowedSemanticTypes ?? [])].sort(),
    });
  }

  private applySemanticTypePolicy(
    records: MemoryRecord[],
    allowed: readonly MemorySemanticType[] | undefined,
  ): { kept: MemoryRecord[]; filtered: FilteredEntry[] } {
    if (allowed === undefined) return { kept: records, filtered: [] };
    const allowedTypes = new Set(allowed);
    const kept: MemoryRecord[] = [];
    const filtered: FilteredEntry[] = [];
    for (const record of records) {
      if (record.semanticType === undefined || allowedTypes.has(record.semanticType)) {
        kept.push(record);
      } else {
        filtered.push({
          recordId: record.id,
          semanticType: record.semanticType,
          reason: "loadout_policy_excluded",
        });
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

  private selectTopHits(
    hits: Array<RecallHit & { record: MemoryRecord }>,
    charBudget: number,
  ): {
    selected: Array<RecallHit & { record: MemoryRecord }>;
    overflow: Array<RecallHit & { record: MemoryRecord }>;
  } {
    const sorted = [...hits].sort((a, b) => b.score - a.score);
    const selected: Array<RecallHit & { record: MemoryRecord }> = [];
    const overflow: Array<RecallHit & { record: MemoryRecord }> = [];
    let used = 0;
    for (const hit of sorted) {
      const cost = hit.record.text.length + 4;
      if (used + cost > charBudget) {
        overflow.push(hit);
        continue;
      }
      selected.push(hit);
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
      evidenceRefs: [...new Set(records.flatMap((record) => record.sourceNodeIds ?? []))],
      nodeCount: records.length,
      tokenEstimate: content.length,
    };
  }

  private createAssemblyPlan(
    scope: MemoryScope,
    slots: ContextFastResponse["slots"],
    filtered: FilteredEntry[],
    task?: string,
    options: BuildSlotContextOptions = {},
  ): ContextAssemblyPlan {
    const assemblies: ContextAssemblyPlan["slots"] = {};
    for (const semanticType of Object.keys(slots) as MemorySemanticType[]) {
      const block = slots[semanticType];
      if (!block) continue;
      const lines = block.content.split("\n").map((line) => line.replace(/^\s*-\s*/, ""));
      const evidenceRefs = [...new Set(block.evidenceRefs ?? [])];
      assemblies[semanticType] = {
        semanticType,
        mustRead: block.sourceIds.map((ref, index) => ({
          ref,
          semanticType,
          content: lines[index] ?? "",
          evidenceRefs,
        })),
        navigation: [
          ...block.sourceIds.map((ref) => ({
            ref,
            kind: "memory" as const,
            level: "R1" as const,
            semanticType,
          })),
          ...evidenceRefs.map((ref) => ({
            ref,
            kind: "evidence" as const,
            level: "R4" as const,
            semanticType,
          })),
        ],
        assetRefs: [],
        evidenceRefs,
        filtered: filtered
          .filter((entry) => entry.semanticType === semanticType)
          .map((entry) => ({ ref: entry.recordId ?? "unknown", reason: entry.reason })),
        tokenBudget: this.slotBudget(options, semanticType),
      };
      const treeDepth = options.treeDepth ?? "global";
      const allowedTreeTypes = treeDepth === "source"
        ? new Set(["source"])
        : treeDepth === "topic"
          ? new Set(["source", "topic"])
          : new Set(["source", "topic", "global"]);
      const sourceIds = new Set(block.sourceIds);
      const evidenceSet = new Set(evidenceRefs);
      const treeRefs = (options.treeSummaries ?? [])
        .filter((node) => node.status === "sealed" && allowedTreeTypes.has(node.treeType) &&
          validateDeterministicEvidence(node).valid &&
          (node.leafIds.some((id) => sourceIds.has(id)) ||
            node.evidenceChunkIds.some((id) => evidenceSet.has(id))))
        .slice(0, 20)
        .map((node) => ({
          ref: node.id,
          kind: `${node.treeType}_tree` as const,
          level: node.treeType === "source" ? "R1" as const : "R2" as const,
          semanticType,
        }));
      assemblies[semanticType]!.navigation.push(...treeRefs);
    }

    const stableSlots = {
      profile: assemblies.profile,
      rules: assemblies.rules,
    };
    const dynamicSlots = {
      task: task ?? "",
      task_context: assemblies.task_context,
      experience: assemblies.experience,
      resource: assemblies.resource,
    };
    const now = Date.now();
    return {
      sessionId: scope.sessionId ?? "",
      slots: assemblies,
      tools: [],
      denied: filtered.map((entry) => ({
        ref: entry.recordId ?? "unknown",
        reason: entry.reason,
      })),
      versions: {
        slotSnapshot: SLOT_SNAPSHOT_VERSION,
        retrieval: RETRIEVAL_VERSION,
        scoring: SCORING_VERSION,
        promptPolicy: PROMPT_POLICY_VERSION,
      },
      stableContentHash: contentHash(stableSlots),
      dynamicContentHash: contentHash(dynamicSlots),
      expiresAt: new Date(now + RECOMMENDED_TTL.task_context).toISOString(),
    };
  }

  private slotBudget(options: BuildSlotContextOptions, semanticType: MemorySemanticType): number {
    return options.tokenBudgetBySlot?.[semanticType] ??
      options.tokenBudgetPerSlot ?? SLOT_BUDGET_DEFAULT[semanticType];
  }

  private hitsToBlock(
    hits: RecallHit[],
    semanticType: MemorySemanticType,
    charBudget: number,
  ): SlotContextBlock {
    const records = hits.map((hit) => hit.record as MemoryRecord);
    const block = this.recordsToBlock(records, semanticType, charBudget);
    const recallReceipts = hits.map((hit) => {
      if (!isRecallScoreBreakdown(hit.scoreBreakdown)) {
        throw new Error("CONTEXT_RECALL_BREAKDOWN_REQUIRED");
      }
      return {
        sourceId: hit.record.id,
        score: hit.score,
        source: hit.source,
        scoreBreakdown: hit.scoreBreakdown,
      };
    });
    return {
      ...block,
      recallReceipts,
    };
  }

  /**
   * 使缓存失效
   */
  invalidateCache(scope: MemoryScope, semanticType?: MemorySemanticType): void {
    this.cache.invalidate(scope, semanticType);
  }

  invalidateCacheFingerprint(scopeFingerprint: string): void {
    this.cache.invalidateFingerprint(scopeFingerprint);
  }
}

/**
 * 全局单例实例
 */
export const globalSlotContextBuilder = new SlotContextBuilder();
