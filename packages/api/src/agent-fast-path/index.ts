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
import { normalizeScope } from "../core/scope.js";
import { globalSlotContextBuilder, type SlotContextBuilder } from "../core/slot-context-builder.js";
import type {
  AgentTaskContextRequest,
  ContextFastResponse,
} from "../core/semantic-types.js";
import type { MemoryRepository } from "../core/service-types.js";
import type {
  MemoryRecord,
  MemoryScope,
  MemoryScopeInput,
  RecallHit,
  RecallResult,
} from "../core/types.js";
import type { TreeSummaryNode } from "../tree/types.js";

export type { AgentTaskContextRequest };

export interface AgentObserveLightRequest {
  scope: MemoryScopeInput;
  eventType: "user_input" | "tool_result" | "agent_output" | "system_event" | string;
  text: string;
  metadata?: Record<string, unknown>;
  /** 如果是显式保存请求 */
  intent?: "remember" | "ignore" | "auto";
}

export interface AgentObserveLightResponse {
  ack: true;
  traceId: string;
  queuedJobs: string[];
  warnings?: string[];
}

export interface AgentLookupRequest {
  scope: MemoryScopeInput;
  query: string;
  filters?: Record<string, unknown>;
  mode?: "fast" | "deep";
  limit?: number;
}

export interface AgentLookupResponse {
  hits: Array<{
    id: string;
    preview: string;
    score: number;
    source: string;
    semanticType?: string;
    evidence: Array<{ id: string; preview: string }>;
    actions: Array<"open" | "copy_reference" | "drill_down" | "show_graph">;
  }>;
  warnings?: string[];
  telemetry: {
    latencyMs: number;
    mode: "fast" | "deep";
  };
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

/**
 * 任务调度依赖（外部注入）
 */
export interface AgentFastPathDeps {
  /** 通过 scope 加载相关记忆 */
  loadRecordsForScope(scope: MemoryScope): Promise<MemoryRecord[]>;
  /** 普通召回（lookup 复用） */
  recall(
    scope: MemoryScope,
    query: string,
    options?: { limit?: number; minScore?: number }
  ): Promise<RecallResult>;
  /** observation 写入 */
  storeObservation?(input: {
    scope: MemoryScope;
    text: string;
    metadata: Record<string, unknown>;
  }): Promise<{ id: string }>;
  /** job 入队（observe / session_commit 异步处理） */
  enqueueJob?(input: { type: string; payload: Record<string, unknown> }): Promise<string>;
  /** lookup_deep 时加载记忆树摘要（source/topic/global），未注入则 deep 退化为 fast。 */
  loadTreeSummaries?(scope: MemoryScope, query: string): Promise<TreeSummaryNode[]>;
  /** 自定义 SlotContextBuilder（默认全局） */
  builder?: SlotContextBuilder;
  /** 默认 scope（兜底） */
  defaultScope?: MemoryScope;
  logger?: { info?(msg: string): void; warn?(msg: string): void };
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

  /**
   * 任务启动：获取 5 槽位上下文
   */
  async context(request: AgentTaskContextRequest): Promise<ContextFastResponse> {
    const scope = normalizeScope(request.scope, this.deps.defaultScope);
    const records = await this.deps.loadRecordsForScope(scope);

    const response = await this.builder.buildSlotContext(scope, records, {
      latencyBudgetMs: request.latencyBudgetMs,
      tokenBudgetPerSlot: request.tokenBudget
        ? Math.floor(request.tokenBudget / 5)
        : undefined,
      task: request.task,
    });

    // 附加任务相关 hints（首版从 records 中找 rules/experience top-1）
    const hints = this.collectTaskHints(records, request.task);
    if (hints && hints.length > 0) {
      response.taskHints = hints;
    }

    response.actions = this.collectActions(scope, request.task);

    return response;
  }

  /**
   * 运行中：轻量提交 observation
   */
  async observeLight(
    request: AgentObserveLightRequest
  ): Promise<AgentObserveLightResponse> {
    const scope = normalizeScope(request.scope, this.deps.defaultScope);
    const traceId = randomUUID();
    const jobs: string[] = [];
    const warnings: string[] = [];

    if (this.deps.storeObservation) {
      try {
        await this.deps.storeObservation({
          scope,
          text: request.text,
          metadata: {
            ...(request.metadata ?? {}),
            eventType: request.eventType,
            intent: request.intent ?? "auto",
            traceId,
          },
        });
      } catch (err) {
        warnings.push(`observation_store_failed: ${(err as Error).message}`);
      }
    }

    if (this.deps.enqueueJob) {
      try {
        const jobId = await this.deps.enqueueJob({
          type: "extract_candidate",
          payload: { scope, text: request.text, traceId, intent: request.intent },
        });
        jobs.push(jobId);
      } catch (err) {
        warnings.push(`enqueue_failed: ${(err as Error).message}`);
      }

      // F3-2：observation 同时进入 source 树构建链路（按 session 分组）。
      // 树构建失败不影响 observation ack；树是 in-memory 增强，非主链路。
      try {
        const treeKey = scope.sessionId ?? "default";
        const treeJobId = await this.deps.enqueueJob({
          type: "build_tree",
          payload: {
            scope,
            treeType: "source",
            treeKey,
            leaf: {
              id: traceId,
              chunkId: traceId,
              sourceId: scope.sessionId ?? scope.appId,
              text: request.text,
              eventAt: Date.now(),
            },
          },
        });
        jobs.push(treeJobId);
      } catch (err) {
        warnings.push(`tree_enqueue_failed: ${(err as Error).message}`);
      }
    }

    return {
      ack: true,
      traceId,
      queuedJobs: jobs,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * 运行中：按需速查
   */
  async lookup(request: AgentLookupRequest): Promise<AgentLookupResponse> {
    const startedAt = Date.now();
    const scope = normalizeScope(request.scope, this.deps.defaultScope);
    const limit = request.limit ?? 5;
    const mode = request.mode ?? "fast";

    let result: RecallResult;
    try {
      result = await this.deps.recall(scope, request.query, { limit });
    } catch (err) {
      return {
        hits: [],
        warnings: [`recall_failed: ${(err as Error).message}`],
        telemetry: { latencyMs: Date.now() - startedAt, mode },
      };
    }

    const hits = result.hits
      .filter((hit): hit is RecallHit => Boolean(hit))
      .map((hit) => this.shapeHit(hit));

    // F3-3：deep 模式融合记忆树摘要（source/topic/global），提供宏观追溯。
    // loadTreeSummaries 未注入时 deep 退化为 fast（只返回向量召回）。
    const warnings: string[] = [];
    if (mode === "deep" && this.deps.loadTreeSummaries) {
      try {
        const summaries = await this.deps.loadTreeSummaries(scope, request.query);
        for (const node of summaries) {
          hits.push(this.shapeTreeSummary(node));
        }
      } catch (err) {
        warnings.push(`tree_lookup_failed: ${(err as Error).message}`);
      }
    }

    return {
      hits,
      warnings: warnings.length > 0 ? warnings : undefined,
      telemetry: { latencyMs: Date.now() - startedAt, mode },
    };
  }

  /**
   * 会话结束：提交摘要
   */
  async sessionCommit(
    request: AgentSessionCommitRequest
  ): Promise<AgentSessionCommitResponse> {
    const scope = normalizeScope(request.scope, this.deps.defaultScope);
    const traceId = randomUUID();
    const jobs: string[] = [];

    if (this.deps.enqueueJob) {
      const jobTypes = ["refresh_slot_snapshot"];
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
    records: MemoryRecord[],
    task?: string
  ): ContextFastResponse["taskHints"] {
    if (!task) return undefined;

    const lower = task.toLowerCase();
    const hits: NonNullable<ContextFastResponse["taskHints"]> = [];

    // 首版：从 rules 中选最重要 1 条作为 hint
    const rules = records
      .filter(
        (r) =>
          r.semanticType === "rules" && (r.lifecycleStatus ?? "active") === "active"
      )
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0));
    if (rules[0]) {
      hits.push({
        kind: "rule",
        text: rules[0].text,
        evidenceIds: [rules[0].id],
      });
    }

    // 任务相关 experience 简单关键词匹配
    const experiences = records
      .filter((r) => r.semanticType === "experience")
      .filter((r) => r.text.toLowerCase().includes(lower.slice(0, 10)));
    if (experiences[0]) {
      hits.push({
        kind: "experience",
        text: experiences[0].text,
        evidenceIds: [experiences[0].id],
      });
    }

    return hits.length > 0 ? hits : undefined;
  }

  /**
   * 收集可用 action
   */
  private collectActions(
    scope: MemoryScope,
    task?: string
  ): ContextFastResponse["actions"] {
    const actions: NonNullable<ContextFastResponse["actions"]> = [];
    if (task) {
      actions.push({
        type: "lookup",
        label: "lookup_more",
        input: { query: task, scope },
      });
    }
    return actions;
  }

  private shapeHit(hit: RecallHit): AgentLookupResponse["hits"][number] {
    const record = hit.record as MemoryRecord;
    const preview = "text" in record ? record.text.slice(0, 240) : "";
    return {
      id: record.id,
      preview,
      score: hit.score,
      source: hit.source,
      semanticType: "semanticType" in record ? record.semanticType : undefined,
      evidence: [],
      actions: ["copy_reference", "drill_down"],
    };
  }

  /** 把记忆树摘要节点转为 lookup hit（deep 模式融合用）。 */
  private shapeTreeSummary(node: TreeSummaryNode): AgentLookupResponse["hits"][number] {
    return {
      id: node.id,
      preview: node.summary.slice(0, 240),
      score: 0,
      source: `tree:${node.treeType}`,
      evidence: node.evidenceChunkIds.slice(0, 5).map((id) => ({ id, preview: "" })),
      actions: ["drill_down", "show_graph"],
    };
  }
}
