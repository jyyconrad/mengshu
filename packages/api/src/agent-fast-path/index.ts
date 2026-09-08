/**
 * Agent 快路径服务
 *
 * 实现方案文档 §9.0 / §12.1 中的 4 个 Agent 快路径接口：
 * - context_fast: 任务启动获取 5 槽位上下文
 * - observe_light: 运行中轻量提交观察
 * - lookup: 任务中按需速查
 * - session_commit: 会话结束提交摘要
 *
 * 核心约束：
 * - 隐藏内部复杂度（候选区/树/图谱/job）
 * - 输出 prompt-safe content + 结构化 telemetry
 * - 默认单机 SLO：context_fast P95 < 80ms
 */

import { randomUUID } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";
import { normalizeScope } from "../../../../core/scope.js";
import { globalSlotContextBuilder, type SlotContextBuilder } from "../../../../core/slot-context-builder.js";
import type {
  AgentTaskContextRequest,
  ContextFastResponse,
  DisclosureLevel,
  NavigationRef,
} from "../../../core/src/domain/semantic-types.js";
import { DATABASE_STORE_CLEANUP_WARNING } from "../../../core/src/db/types.js";
import type { MemoryRepository } from "../../../../core/service-types.js";
import type {
  AdmissionRoute,
  MemoryRecord,
  MemoryScope,
  MemoryScopeInput,
  RecallFilteredCandidate,
  RecallHit,
  RecallResult,
} from "../../../../core/types.js";
import type { TreeSummaryNode } from "../../../../tree/types.js";
import {
  requireContextFastRecallReceipts,
  requireRecallHitReceipt,
} from "../../../core/src/domain/recall-receipt-validation.js";
import { AgentLoadoutAssembler } from "../../../core/src/loadout/assembler.js";
import { applyLoadoutAssemblyToContext } from
  "../../../core/src/loadout/context-assembly.js";
import type {
  AgentLoadout,
  LoadoutAssemblyResult,
  LoadoutAssetCandidate,
} from "../../../core/src/loadout/types.js";
import {
  createContextAssemblyReceipt,
  type ContextAssemblyReceiptRepository,
} from "../../../core/src/context/assembly-receipt.js";
import type { KnowledgeResourceCapability } from
  "../../../core/src/resources/knowledge-resource-capability.js";
import { applyKnowledgeResourceIndexToContext } from
  "../../../core/src/resources/knowledge-resource-context.js";

export type { AgentTaskContextRequest };

export interface AgentObserveLightRequest {
  scope: MemoryScopeInput;
  eventType: "user_input" | "tool_result" | "agent_output" | "system_event" | string;
  text: string;
  metadata?: Record<string, unknown>;
  /** 调用方稳定请求标识；生产写内核用它实现跨重试幂等。 */
  idempotencyKey?: string;
  /** 如果是显式保存请求 */
  intent?: "remember" | "ignore" | "auto";
}

export interface AgentObserveLightResponse {
  ack: true;
  /** intent=ignore 时为 true，表示已确认忽略且没有产生持久化副作用。 */
  ignored?: boolean;
  traceId: string;
  /** Durable identity returned by the write kernel/provider. */
  persistedId?: string;
  /** 区分候选治理记录与可进入 graph/tree 的 active/lookup/evidence memory。 */
  recordType?: "memory" | "candidate";
  /** 持久化后的原生准入路由；缺失时仅用于旧 adapter 兼容。 */
  admissionRoute?: Exclude<AdmissionRoute, "drop">;
  /** Whether this request inserted a new durable observation. */
  stored?: boolean;
  /** Explicit duplicate acknowledgement; only native durable ensure may repair missing jobs. */
  duplicate?: boolean;
  queuedJobs: string[];
  warnings?: string[];
}

export interface AgentLookupRequest {
  scope: MemoryScopeInput;
  query: string;
  filters?: Record<string, unknown>;
  mode?: "fast" | "deep";
  limit?: number;
  minScore?: number;
  // D-25：项目/产品维度友好筛选（映射到 recall filterProject/filterProduct）
  /** 按项目精确筛选（如 'memory-autodb'），映射到 RecallInput.filterProject */
  project?: string;
  /** 按产品精确筛选（如 'codex'），映射到 RecallInput.filterProduct */
  product?: string;
  /** soft=跨项目软召回（默认），hard=精确筛选 */
  scopeFilterMode?: "soft" | "hard";
}

export interface AgentLookupResponse {
  hits: Array<{
    id: string;
    preview: string;
    score: number;
    /** recall/lookup/context/why/explain 共用的唯一六因子回执。 */
    scoreBreakdown?: RecallHit["scoreBreakdown"];
    source: string;
    semanticType?: string;
    evidence: Array<{ id: string; preview: string }>;
    actions: Array<"open" | "copy_reference" | "drill_down" | "show_graph">;
  }>;
  filtered?: RecallFilteredCandidate[];
  warnings?: string[];
  telemetry: {
    latencyMs: number;
    mode: "fast" | "deep";
  };
}

export interface AgentNavigateRequest {
  scope: MemoryScopeInput;
  ref: string;
  level?: DisclosureLevel;
  limit?: number;
}

export interface AgentNavigationItem extends NavigationRef {
  title: string;
  preview?: string;
  evidenceRefs?: string[];
}

export interface AgentNavigateResponse {
  ref: string;
  items: AgentNavigationItem[];
}

export interface AgentEvidenceReadRequest {
  scope: MemoryScopeInput;
  refs: string[];
}

export interface AgentEvidenceItem {
  ref: string;
  preview: string;
  source: "memory" | "chunk" | "document" | "message" | "resource";
}

export interface AgentEvidenceReadResponse {
  evidence: AgentEvidenceItem[];
}

export interface AgentSessionCommitRequest {
  scope: MemoryScopeInput;
  summary?: string;
  transcriptRef?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentSessionCommitResponse {
  ack: true;
  traceId: string;
  jobs: string[];
}

export interface AgentFastPathReadBoundary {
  resolveScope(requested?: MemoryScopeInput): MemoryScope;
  checkpoint(scope: MemoryScope): Promise<object>;
  revalidate(scope: MemoryScope, checkpoint: object): Promise<boolean>;
  rehydrate(scope: MemoryScope, hits: readonly RecallHit[], intent: "lookup" | "context"): Promise<RecallHit[]>;
  reference(hit: RecallHit): string;
  readEvidence(scope: MemoryScope, refs: readonly string[]): Promise<AgentEvidenceItem[]>;
  navigate(scope: MemoryScope, input: { ref: string; level?: DisclosureLevel; limit: number }): Promise<AgentNavigationItem[]>;
}

/**
 * 任务调度依赖（外部注入）
 */
export interface AgentFastPathDeps {
  /** Authenticated host-only E4 gate; ordinary request fields cannot install or replace it. */
  readBoundary?: AgentFastPathReadBoundary;
  /** F0 生产路径：按当前 task 在 scope 内加载带完整六因子回执的已治理命中。 */
  loadRecallHitsForScope?(scope: MemoryScope, query: string): Promise<RecallHit[]>;
  /** legacy adapter 降级路径；RuntimeHost 生产组合不得使用。 */
  loadRecordsForScope?(scope: MemoryScope): Promise<MemoryRecord[]>;
  /** 普通召回（lookup 复用） */
  recall(
    scope: MemoryScope,
    query: string,
    options?: { limit?: number; minScore?: number; filter?: Record<string, unknown> }
  ): Promise<RecallResult>;
  /** observation 写入 */
  storeObservation?(input: {
    scope: MemoryScope;
    text: string;
    metadata: Record<string, unknown>;
    intent: "remember" | "auto";
    idempotencyKey?: string;
  }): Promise<{
    id: string;
    stored: boolean;
    recordType?: "memory" | "candidate";
    admissionRoute?: Exclude<AdmissionRoute, "drop">;
    warnings?: Array<typeof DATABASE_STORE_CLEANUP_WARNING>;
  }>;
  /** job 入队（observe / session_commit 异步处理） */
  enqueueJob?(input: { type: string; payload: Record<string, unknown> }): Promise<string>;
  /** Durable-idempotent ensure capability; duplicate observations may use it to repair missing jobs. */
  ensureJob?(input: { type: string; payload: Record<string, unknown> }): Promise<string>;
  /** lookup_deep 时加载记忆树摘要（source/topic/global），未注入则 deep 退化为 fast。 */
  loadTreeSummaries?(scope: MemoryScope, query: string): Promise<TreeSummaryNode[]>;
  /** F1 authority-scoped progressive disclosure ports. */
  navigate?(
    scope: MemoryScope,
    input: { ref: string; level?: DisclosureLevel; limit: number },
  ): Promise<AgentNavigationItem[]>;
  readEvidence?(scope: MemoryScope, refs: readonly string[]): Promise<AgentEvidenceItem[]>;
  /** F3 optional overlay. Absence preserves the native five-slot response byte-for-byte. */
  resolveLoadout?(scope: MemoryScope): Promise<AgentLoadout | undefined>;
  resolveLoadoutAssetCandidates?(
    scope: MemoryScope,
    loadout: AgentLoadout,
    governedHits: readonly RecallHit[],
  ): Promise<readonly LoadoutAssetCandidate[]>;
  loadoutAssembler?: AgentLoadoutAssembler;
  /** Optional read-only Knowledge index/search/read provider for the resource slot. */
  knowledgeResources?: Pick<KnowledgeResourceCapability, "index">;
  /** F1 durable session explain path. Missing/failed persistence degrades to a warning. */
  contextAssemblyReceipts?: ContextAssemblyReceiptRepository;
  /** 自定义 SlotContextBuilder（默认全局） */
  builder?: SlotContextBuilder;
  /** 默认 scope（兜底） */
  defaultScope?: MemoryScope;
  logger?: { info?(msg: string): void; warn?(msg: string): void };
}

interface ParsedStoreObservationOutcome {
  readonly id: string;
  readonly stored: boolean;
  readonly recordType: "memory" | "candidate";
  readonly admissionRoute?: Exclude<AdmissionRoute, "drop">;
  readonly warnings?: readonly (typeof DATABASE_STORE_CLEANUP_WARNING)[];
}

const PERSISTED_ADMISSION_ROUTES = new Set<Exclude<AdmissionRoute, "drop">>([
  "candidate_low_priority",
  "candidate",
  "active",
  "lookup_only",
  "evidence_only",
]);

function parseStoreObservationOutcome(value: unknown): ParsedStoreObservationOutcome | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return undefined;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string") ||
      keys.some((key) => key !== "id" && key !== "stored" && key !== "recordType" &&
        key !== "admissionRoute" && key !== "warnings") ||
      !keys.includes("id") || !keys.includes("stored")) {
    return undefined;
  }
  const snapshot: Record<string, unknown> = {};
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
        descriptor.get !== undefined || descriptor.set !== undefined) {
      return undefined;
    }
    snapshot[key] = descriptor.value;
  }
  const id = snapshot.id;
  const stored = snapshot.stored;
  if (typeof id !== "string" || id.length === 0 || id.length > 512 || id !== id.trim() ||
      /[\u0000-\u001f\u007f]/.test(id) || typeof stored !== "boolean") {
    return undefined;
  }
  const recordType = snapshot.recordType ?? "memory";
  if (recordType !== "memory" && recordType !== "candidate") return undefined;
  const admissionRoute = snapshot.admissionRoute;
  if (admissionRoute !== undefined &&
      !PERSISTED_ADMISSION_ROUTES.has(admissionRoute as Exclude<AdmissionRoute, "drop">)) {
    return undefined;
  }

  let warnings: readonly (typeof DATABASE_STORE_CLEANUP_WARNING)[] | undefined;
  if (Object.prototype.hasOwnProperty.call(snapshot, "warnings")) {
    const rawWarnings = snapshot.warnings;
    if (!Array.isArray(rawWarnings) || nodeUtilTypes.isProxy(rawWarnings)) return undefined;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(rawWarnings, "length");
    if (!lengthDescriptor || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value") ||
        !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 0 ||
        lengthDescriptor.get !== undefined || lengthDescriptor.set !== undefined) {
      return undefined;
    }
    const length = Number(lengthDescriptor.value);
    const warningKeys = Reflect.ownKeys(rawWarnings);
    const expected = length === 0 ? ["length"] : ["0", "length"];
    if (length > 1 || warningKeys.length !== expected.length ||
        warningKeys.some((key) => typeof key !== "string" || !expected.includes(key))) {
      return undefined;
    }
    if (length === 1) {
      const descriptor = Object.getOwnPropertyDescriptor(rawWarnings, "0");
      if (!descriptor || descriptor.enumerable !== true ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.value !== DATABASE_STORE_CLEANUP_WARNING) {
        return undefined;
      }
      warnings = Object.freeze([DATABASE_STORE_CLEANUP_WARNING]);
    } else {
      warnings = Object.freeze([]);
    }
  }
  return Object.freeze({
    id,
    stored,
    recordType,
    ...(admissionRoute === undefined
      ? {}
      : { admissionRoute: admissionRoute as Exclude<AdmissionRoute, "drop"> }),
    ...(warnings ? { warnings } : {}),
  });
}

/**
 * Agent 快路径服务
 */
export class AgentFastPathService {
  private readonly deps: AgentFastPathDeps;
  private readonly builder: SlotContextBuilder;

  constructor(deps: AgentFastPathDeps) {
    this.deps = deps;
    this.builder = deps.builder ?? globalSlotContextBuilder;
  }

  get assetEnhancementConfigured(): boolean {
    return this.deps.resolveLoadout !== undefined &&
      this.deps.resolveLoadoutAssetCandidates !== undefined;
  }

  invalidateContextCacheFingerprint(scopeFingerprint: string): void {
    this.builder.invalidateCacheFingerprint(scopeFingerprint);
  }

  /**
   * 任务启动：获取 5 槽位上下文
   */
  async context(request: AgentTaskContextRequest): Promise<ContextFastResponse> {
    const scope = this.resolveScope(request.scope);
    const checkpoint = await this.deps.readBoundary?.checkpoint(scope);
    const productionRecallPath = Boolean(this.deps.loadRecallHitsForScope);
    if (this.deps.readBoundary && !productionRecallPath) throw new Error("CONTEXT_RECALL_CAPABILITY_REQUIRED");
    let selectedLoadout: AgentLoadout | undefined;
    const preAssemblyWarnings: string[] = [];
    if (productionRecallPath && this.deps.resolveLoadout) {
      try {
        const loadout = await this.deps.resolveLoadout(scope);
        selectedLoadout = this.deps.readBoundary ? structuredClone(loadout) : loadout;
      } catch (error) {
        preAssemblyWarnings.push(
          `asset_enhancement_disabled: ${error instanceof Error ? error.message : "unavailable"}`,
        );
      }
    }
    let treeSummaries: readonly TreeSummaryNode[] | undefined;
    if (productionRecallPath && this.deps.loadTreeSummaries) {
      try {
        treeSummaries = await this.deps.loadTreeSummaries(scope, request.task);
      } catch (error) {
        preAssemblyWarnings.push(
          `tree_navigation_unavailable: ${error instanceof Error ? error.message : "unavailable"}`,
        );
      }
    }
    const requestedPerSlotBudget = request.tokenBudget
      ? Math.floor(request.tokenBudget / 5)
      : undefined;
    const tokenBudgetBySlot = selectedLoadout
      ? Object.fromEntries(Object.entries(selectedLoadout.nativeMemoryPolicy.tokenBudgets)
          .map(([slot, budget]) => [slot, requestedPerSlotBudget === undefined
            ? budget
            : Math.min(budget, requestedPerSlotBudget)]))
      : undefined;
    const buildOptions = {
      ...(this.deps.readBoundary ? { useCache: false } : {}),
      latencyBudgetMs: request.latencyBudgetMs,
      tokenBudgetPerSlot: requestedPerSlotBudget,
      tokenBudgetBySlot,
      allowedSemanticTypes: selectedLoadout?.nativeMemoryPolicy.semanticTypes,
      treeSummaries,
      treeDepth: selectedLoadout?.nativeMemoryPolicy.treeDepth ?? "global" as const,
      task: request.task,
    };
    let governedHits = productionRecallPath
      ? await this.deps.loadRecallHitsForScope!(scope, request.task)
      : undefined;
    if (this.deps.readBoundary) governedHits = await this.deps.readBoundary.rehydrate(scope, governedHits!, "context");
    let response = productionRecallPath
      ? await this.builder.buildSlotContextFromRecallHits(scope, governedHits!, buildOptions)
      : await this.builder.buildSlotContext(
          scope,
          await this.requireLegacyRecords(scope),
          buildOptions,
        );
    if (productionRecallPath) requireContextFastRecallReceipts(response);
    if (preAssemblyWarnings.length > 0) {
      response.warnings = [...new Set([...(response.warnings ?? []), ...preAssemblyWarnings])];
    }

    let selectedAssembly: LoadoutAssemblyResult | undefined;
    let selectedCandidates: readonly LoadoutAssetCandidate[] | undefined;
    if (productionRecallPath && selectedLoadout) {
      try {
        if (!this.deps.resolveLoadoutAssetCandidates) {
          throw new Error("asset resolver unavailable");
        }
        const resolvedCandidates = await this.deps.resolveLoadoutAssetCandidates(
          scope,
          selectedLoadout,
          governedHits!,
        );
        const candidates = this.deps.readBoundary ? structuredClone(resolvedCandidates) : resolvedCandidates;
        const assembly = (this.deps.loadoutAssembler ?? new AgentLoadoutAssembler())
          .assemble(selectedLoadout, candidates, {
            nativeTokenUsage: Object.fromEntries(Object.entries(response.slots)
              .map(([slot, block]) => [slot, block?.tokenEstimate ?? 0])),
          });
        response = applyLoadoutAssemblyToContext(response, selectedLoadout, assembly, request.task);
        requireContextFastRecallReceipts(response);
        selectedAssembly = assembly;
        if (assembly.enhancementEnabled && assembly.contributions.length > 0) selectedCandidates = candidates;
      } catch (error) {
        // Asset/Loadout is an optional overlay. A required binding fails the
        // overlay closed, but must never make native five-slot context unavailable.
        response.warnings = [
          ...(response.warnings ?? []),
          `asset_enhancement_disabled: ${error instanceof Error ? error.message : "unavailable"}`,
        ];
      }
    }

    if (productionRecallPath && this.deps.knowledgeResources) {
      try {
        const index = await this.deps.knowledgeResources.index(scope);
        response = applyKnowledgeResourceIndexToContext(response, index, request.task);
        requireContextFastRecallReceipts(response);
      } catch {
        response.warnings = [...new Set([
          ...(response.warnings ?? []),
          "knowledge_resource_unavailable",
        ])];
      }
    }

    // hints 只能从最终已选槽位派生，不能绕过 lifecycle/container/预算治理。
    const hints = this.collectTaskHints(response, request.task);
    if (hints && hints.length > 0) {
      response.taskHints = hints;
    }

    response.actions = this.collectActions(scope, request.task, response);
    if (this.deps.readBoundary) {
      response.actions = [{ type: "lookup", label: "lookup_more", input: { query: request.task, scope } },
        ...governedHits!.slice(0, 5).map(hit => ({ type: "drill_down" as const, label: "read_evidence",
          input: { ref: this.deps.readBoundary!.reference(hit), level: "R4", scope } }))];
      await this.finishAssets(scope, selectedLoadout, selectedCandidates, governedHits!);
      await this.finishRead(scope, checkpoint, governedHits!, "context");
    }

    if (productionRecallPath && response.assemblyPlan && scope.sessionId) {
      try {
        if (!this.deps.contextAssemblyReceipts) {
          throw new Error("receipt repository unavailable");
        }
        const receipt = createContextAssemblyReceipt({
          scope,
          response,
          ...(selectedLoadout === undefined ? {} : { loadout: selectedLoadout }),
          ...(selectedAssembly === undefined ? {} : { assembly: selectedAssembly }),
        });
        await this.deps.contextAssemblyReceipts.append(scope, receipt);
      } catch {
        response.warnings = [...new Set([
          ...(response.warnings ?? []),
          "context_receipt_unavailable",
        ])];
      }
    }

    await this.finishAssets(scope, selectedLoadout, selectedCandidates, governedHits ?? []);
    await this.finishRead(scope, checkpoint, governedHits ?? [], "context");
    return response;
  }

  /**
   * 运行中：轻量提交 observation
   */
  async observeLight(
    request: AgentObserveLightRequest
  ): Promise<AgentObserveLightResponse> {
    const scope = this.resolveScope(request.scope);
    const traceId = randomUUID();

    if (request.intent === "ignore") {
      return {
        ack: true,
        ignored: true,
        traceId,
        queuedJobs: [],
      };
    }

    const jobs: string[] = [];
    const warnings: string[] = [];
    let storeOutcome: {
      id: string;
      stored: boolean;
      recordType: "memory" | "candidate";
      admissionRoute?: Exclude<AdmissionRoute, "drop">;
      warnings?: readonly (typeof DATABASE_STORE_CLEANUP_WARNING)[];
    } | undefined;

    if (this.deps.storeObservation) {
      try {
        const outcome = await this.deps.storeObservation({
          scope,
          text: request.text,
          intent: request.intent ?? "auto",
          ...(request.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: request.idempotencyKey }),
          metadata: {
            ...(request.metadata ?? {}),
            eventType: request.eventType,
            intent: request.intent ?? "auto",
            traceId,
          },
        });
        const parsedOutcome = parseStoreObservationOutcome(outcome);
        if (!parsedOutcome) {
          warnings.push("observation_store_outcome_invalid");
        } else {
          storeOutcome = parsedOutcome;
          if (storeOutcome.warnings) warnings.push(...storeOutcome.warnings);
        }
      } catch (err) {
        warnings.push(`observation_store_failed: ${(err as Error).message}`);
      }
    } else {
      warnings.push("observation_store_unavailable");
    }

    // No durable identity means downstream jobs would point at a dangling trace.
    if (!storeOutcome) {
      return {
        ack: true,
        traceId,
        persistedId: undefined,
        stored: undefined,
        duplicate: undefined,
        queuedJobs: [],
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    }

    // Generic enqueue is not assumed idempotent and is used only for a new
    // durable observation. Duplicate repair is allowed solely through the
    // separately injected native-v2 ensure capability.
    const jobWriter = this.deps.ensureJob ?? (storeOutcome.stored ? this.deps.enqueueJob : undefined);
    if (jobWriter) {
      // Candidate route 已经完成提取与准入，只保留候选治理链；不得把候选 ID
      // 当作 active memory 再次触发树/图增强。
      if (storeOutcome.recordType === "candidate") {
        return {
          ack: true,
          traceId,
          persistedId: storeOutcome.id,
          recordType: storeOutcome.recordType,
          admissionRoute: storeOutcome.admissionRoute,
          stored: storeOutcome.stored,
          duplicate: !storeOutcome.stored,
          queuedJobs: [],
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // Raw evidence must be audited durably before candidate extraction.
      // Graph/tree jobs are derived only from the committed-active receipt, where
      // authoritative evidence and routing facts are available.
      const shouldExtractCandidate = storeOutcome.admissionRoute === "evidence_only" ||
        storeOutcome.admissionRoute === undefined;
      if (shouldExtractCandidate) {
        try {
          const jobId = await jobWriter({
            type: "extract_candidate",
            payload: { scope, text: request.text, traceId: storeOutcome.id, intent: request.intent },
          });
          jobs.push(jobId);
        } catch (err) {
          warnings.push(`enqueue_failed: ${(err as Error).message}`);
        }
      }

    }

    return {
      ack: true,
      traceId,
      persistedId: storeOutcome.id,
      recordType: storeOutcome.recordType,
      admissionRoute: storeOutcome.admissionRoute,
      stored: storeOutcome.stored,
      duplicate: !storeOutcome.stored,
      queuedJobs: jobs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 运行中：按需速查
   */
  async lookup(request: AgentLookupRequest): Promise<AgentLookupResponse> {
    const startedAt = Date.now();
    const scope = this.resolveScope(request.scope);
    const checkpoint = await this.deps.readBoundary?.checkpoint(scope);
    const limit = request.limit ?? 5;
    const mode = request.mode ?? "fast";

    // 安全校验：filters 白名单（防止 SQL 注入）
    let sanitizedFilters = this.sanitizeFilters(request.filters);

    // D-25：硬过滤模式时，把 project/product 注入 filters（内部 key）
    if (request.scopeFilterMode === "hard") {
      const project = request.project ?? (scope.projectId !== "default" ? scope.projectId : undefined);
      const product = request.product ?? (scope.appId !== "default" ? scope.appId : undefined);

      if (project || product) {
        sanitizedFilters = sanitizedFilters ?? {};
        if (project) {
          sanitizedFilters._projectName = project;
        }
        if (product) {
          sanitizedFilters._appName = product;
        }
      }
    }

    // 构建 recall options：只传有值的参数
    const recallOptions: { limit: number; minScore?: number; filter?: Record<string, unknown> } = { limit };
    if (request.minScore !== undefined) {
      recallOptions.minScore = request.minScore;
    }
    if (sanitizedFilters) {
      recallOptions.filter = sanitizedFilters;
    }

    let result: RecallResult;
    try {
      result = await this.deps.recall(scope, request.query, recallOptions);
    } catch (err) {
      return {
        hits: [],
        warnings: [`recall_failed: ${(err as Error).message}`],
        telemetry: { latencyMs: Date.now() - startedAt, mode },
      };
    }

    const hits: AgentLookupResponse["hits"] = [];
    const governedHits = this.deps.readBoundary
      ? await this.deps.readBoundary.rehydrate(scope, result.hits, "lookup") : result.hits;
    for (const hit of governedHits.filter((item): item is RecallHit => Boolean(item))) {
      hits.push(await this.shapeHit(scope, hit));
    }

    // F0：裸 SummaryNode 尚无完整六因子评分合同，不能以伪造 score 混入排序。
    // 保留加载 seam 供后续接入 Retrieval Engine，当前明确降级为 fast。
    const warnings: string[] = [];
    if (mode === "deep" && this.deps.loadTreeSummaries) {
      try {
        const summaries = await this.deps.loadTreeSummaries(scope, request.query);
        if (summaries.length > 0) {
          warnings.push("tree_recall_breakdown_unavailable");
        }
      } catch (err) {
        warnings.push(`tree_lookup_failed: ${(err as Error).message}`);
      }
    }

    await this.finishRead(scope, checkpoint, governedHits, "lookup");
    return {
      hits,
      ...(result.filtered === undefined ? {} : { filtered: result.filtered }),
      warnings: warnings.length > 0 ? warnings : undefined,
      telemetry: { latencyMs: Date.now() - startedAt, mode },
    };
  }

  async navigate(request: AgentNavigateRequest): Promise<AgentNavigateResponse> {
    const scope = this.resolveScope(request.scope);
    const checkpoint = await this.deps.readBoundary?.checkpoint(scope);
    const navigate = this.deps.readBoundary?.navigate ?? this.deps.navigate;
    if (!navigate) throw new Error("MEMORY_NAVIGATION_CAPABILITY_REQUIRED");
    const ref = this.safeRef(request.ref);
    const limit = request.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("MEMORY_NAVIGATION_INPUT_INVALID");
    }
    const items = await navigate(scope, {
      ref,
      ...(request.level === undefined ? {} : { level: request.level }),
      limit,
    });
    await this.finishRead(scope, checkpoint);
    return { ref, items };
  }

  async evidenceRead(request: AgentEvidenceReadRequest): Promise<AgentEvidenceReadResponse> {
    const scope = this.resolveScope(request.scope);
    const checkpoint = await this.deps.readBoundary?.checkpoint(scope);
    const readEvidence = this.deps.readBoundary?.readEvidence ?? this.deps.readEvidence;
    if (!readEvidence) throw new Error("MEMORY_EVIDENCE_READ_CAPABILITY_REQUIRED");
    if (!Array.isArray(request.refs) || request.refs.length < 1 || request.refs.length > 50) {
      throw new Error("MEMORY_EVIDENCE_READ_INPUT_INVALID");
    }
    const refs = request.refs.map((ref) => this.safeRef(ref));
    if (new Set(refs).size !== refs.length) throw new Error("MEMORY_EVIDENCE_READ_INPUT_INVALID");
    const evidence = await readEvidence(scope, refs);
    await this.finishRead(scope, checkpoint);
    return { evidence };
  }

  /**
   * 会话结束：提交摘要
   */
  async sessionCommit(
    request: AgentSessionCommitRequest
  ): Promise<AgentSessionCommitResponse> {
    const scope = this.resolveScope(request.scope);
    const traceId = randomUUID();
    const jobs: string[] = [];
    this.builder.invalidateCache(scope);

    if (this.deps.enqueueJob) {
      const jobTypes: string[] = [];
      if (request.summary || request.transcriptRef) {
        jobTypes.push("extract_candidate");
      }
      for (const type of jobTypes) {
        try {
          const id = await this.deps.enqueueJob({
            type,
            payload: {
              scope,
              summary: request.summary,
              transcriptRef: request.transcriptRef,
              metadata: request.metadata,
              traceId,
            },
          });
          jobs.push(id);
        } catch (err) {
          this.deps.logger?.warn?.(`session_commit job ${type} failed: ${(err as Error).message}`);
        }
      }
    }

    return { ack: true, traceId, jobs };
  }

  /**
   * 提取任务相关 hints
   */
  private collectTaskHints(
    response: ContextFastResponse,
    task?: string
  ): ContextFastResponse["taskHints"] {
    if (!task) return undefined;

    const lower = task.toLowerCase();
    const hits: NonNullable<ContextFastResponse["taskHints"]> = [];
    const firstLine = (semanticType: "rules" | "experience") => {
      const line = response.slots[semanticType]?.content.split("\n")[0];
      return line?.replace(/^\s*-\s*/, "").trim();
    };
    const evidenceIds = (semanticType: "rules" | "experience") =>
      response.slots[semanticType]?.evidenceRefs?.slice(0, 1) ?? [];

    const rule = firstLine("rules");
    if (rule) {
      hits.push({
        kind: "rule",
        text: rule,
        evidenceIds: evidenceIds("rules"),
      });
    }

    const experience = response.slots.experience?.content
      .split("\n")
      .map((line) => line.replace(/^\s*-\s*/, "").trim())
      .find((line) => line.toLowerCase().includes(lower.slice(0, 10)));
    if (experience) {
      hits.push({
        kind: "experience",
        text: experience,
        evidenceIds: evidenceIds("experience"),
      });
    }

    return hits.length > 0 ? hits : undefined;
  }

  private async requireLegacyRecords(scope: MemoryScope): Promise<MemoryRecord[]> {
    if (!this.deps.loadRecordsForScope) {
      throw new Error("CONTEXT_RECALL_CAPABILITY_REQUIRED");
    }
    return this.deps.loadRecordsForScope(scope);
  }

  /**
   * 收集可用 action
   */
  private collectActions(
    scope: MemoryScope,
    task?: string,
    response?: ContextFastResponse,
  ): ContextFastResponse["actions"] {
    const actions: NonNullable<ContextFastResponse["actions"]> = [];
    if (task) {
      actions.push({
        type: "lookup",
        label: "lookup_more",
        input: { query: task, scope },
      });
    }
    const evidenceRefs = Object.values(response?.slots ?? {})
      .flatMap((slot) => slot?.evidenceRefs ?? []);
    for (const ref of [...new Set(evidenceRefs)].slice(0, 5)) {
      actions.push({
        type: "drill_down",
        label: "read_evidence",
        input: { ref, level: "R4", scope },
      });
    }
    return actions;
  }

  private async shapeHit(
    scope: MemoryScope,
    hit: RecallHit,
  ): Promise<AgentLookupResponse["hits"][number]> {
    const scoreBreakdown = requireRecallHitReceipt(hit);
    const record = hit.record as MemoryRecord;
    const preview = "text" in record ? record.text.slice(0, 240) : "";
    const evidenceRefs = this.deps.readBoundary ? [this.deps.readBoundary.reference(hit)]
      : [...new Set(record.sourceNodeIds ?? [])];
    const readEvidence = this.deps.readBoundary?.readEvidence ?? this.deps.readEvidence;
    const evidence = readEvidence && evidenceRefs.length > 0
      ? await readEvidence(scope, evidenceRefs)
      : [];
    return {
      id: record.id,
      preview,
      score: hit.score,
      scoreBreakdown,
      source: hit.source,
      semanticType: "semanticType" in record ? record.semanticType : undefined,
      evidence: evidence.map((item) => ({ id: item.ref, preview: item.preview })),
      actions: evidence.length > 0 ? ["copy_reference", "drill_down"] : ["copy_reference"],
    };
  }

  private safeRef(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > (this.deps.readBoundary ? 4096 : 512) ||
        value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("MEMORY_REFERENCE_INVALID");
    }
    return value;
  }

  private resolveScope(requested?: MemoryScopeInput): MemoryScope {
    return this.deps.readBoundary?.resolveScope(requested) ?? normalizeScope(requested, this.deps.defaultScope);
  }

  private async finishAssets(scope: MemoryScope, loadout: AgentLoadout | undefined,
    candidates: readonly LoadoutAssetCandidate[] | undefined, hits: readonly RecallHit[]): Promise<void> {
    if (!this.deps.readBoundary || !loadout || !candidates) return;
    try {
      const currentLoadout = await this.deps.resolveLoadout!(scope);
      if (!currentLoadout || JSON.stringify(loadout) !== JSON.stringify(currentLoadout)) throw new Error();
      const current = await this.deps.resolveLoadoutAssetCandidates!(scope, currentLoadout, hits);
      const snapshot = (items: readonly LoadoutAssetCandidate[]) => JSON.stringify([...items].sort((a, b) =>
        a.assetKind.localeCompare(b.assetKind) || a.assetId.localeCompare(b.assetId) || a.assetVersion - b.assetVersion));
      if (snapshot(candidates) !== snapshot(current)) throw new Error();
    } catch {
      // An already rendered overlay cannot degrade to native-only after its authority changes.
      throw new Error("REUSE_READ_CHANGED");
    }
  }

  private async finishRead(scope: MemoryScope, checkpoint: object | undefined,
    hits?: readonly RecallHit[], intent: "context" | "lookup" = "lookup"): Promise<void> {
    const boundary = this.deps.readBoundary;
    if (!boundary || !checkpoint) return;
    if (hits) {
      const current = await boundary.rehydrate(scope, hits, intent);
      const records = (values: readonly RecallHit[]) => JSON.stringify(values.map(hit => hit.record)
        .sort((left, right) => left.id.localeCompare(right.id)));
      if (records(hits) !== records(current)) throw new Error("REUSE_READ_CHANGED");
    }
    if (!await boundary.revalidate(scope, checkpoint)) throw new Error("REUSE_READ_CHANGED");
  }

  /**
   * 安全过滤：filters 白名单校验（防止 SQL 注入）
   */
  private sanitizeFilters(
    filters: Record<string, unknown> | undefined
  ): Record<string, unknown> | undefined {
    if (!filters) return undefined;

    // 白名单字段
    // 注意：scope 维度的 _projectName/_appName/_projectPattern 是内部 key，
    // 由 lookup() 在 sanitizeFilters 之后注入（值走 provider 参数化查询，不经此处），
    // 不放进客户端白名单，避免客户端绕过 request.project 直接传内部 key。
    const allowedKeys = [
      "category",
      "dataType",
      "lifecycleStatus",
      "kind",
      "semanticType",
    ];

    // SQL 注入危险字符
    const dangerousChars = /[;'"\\`\-\-/\*]/;

    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(filters)) {
      // 只保留白名单字段
      if (!allowedKeys.includes(key)) continue;

      // 只允许 string/number/boolean
      if (
        typeof value !== "string" &&
        typeof value !== "number" &&
        typeof value !== "boolean"
      ) {
        continue;
      }

      // 字符串 value 拒绝 SQL 注入字符
      if (typeof value === "string" && dangerousChars.test(value)) {
        continue;
      }

      sanitized[key] = value;
    }

    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }
}
