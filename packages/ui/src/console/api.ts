/**
 * Console aggregation API.
 *
 * 聚合 MemoryService、graph、tree、jobs 和 chunks 的只读视图；所有入口都要求
 * 显式 scope，private raw content 不返回。
 */

import type { MemoryService } from "../core/service-types.js";
import type { MemoryScope, RecallHit } from "../core/types.js";
import type { GraphQueryService } from "../graph/query.js";
import type { ChunkRepository, JobRepository } from "../storage/repositories/types.js";
import type { TreeRepository } from "../tree/types.js";
import type {
  CandidateRecord,
  CandidateRepository,
  CandidateStatus,
} from "../lifecycle/candidate-types.js";
import type { CandidateReviewService } from "../lifecycle/candidate-review.js";
import type {
  ConsoleApi,
  ConsoleCandidate,
  ConsoleCandidateReviewRequest,
  ConsoleCandidateReviewResponse,
  ConsoleCandidatesRequest,
  ConsoleCandidatesResponse,
  ConsoleGraphResponse,
  ConsoleJobsResponse,
  ConsoleLookupRequest,
  ConsoleLookupResponse,
  ConsoleLookupResult,
  ConsoleOverview,
} from "./types.js";

export interface CreateConsoleApiOptions {
  service: MemoryService;
  graph?: GraphQueryService;
  chunks?: ChunkRepository;
  jobs?: JobRepository;
  tree?: TreeRepository;
  /** 候选区只读仓库（用于列出 / 计数 pending 候选） */
  candidates?: CandidateRepository;
  /** 候选区审核服务（approve 才会通过 promoteCandidate 写入主库） */
  candidateReview?: CandidateReviewService;
}

function hitText(hit: RecallHit): string {
  if ("text" in hit.record) {
    return hit.record.text;
  }
  return hit.record.summary;
}

function hitKind(hit: RecallHit): string {
  if ("kind" in hit.record) {
    return hit.record.kind;
  }
  if ("treeType" in hit.record) {
    return "summary";
  }
  return hit.source;
}

function sourceLabel(hit: RecallHit): string {
  return hit.provenance?.sourceId ??
    hit.provenance?.filePath ??
    ("provenance" in hit.record ? hit.record.provenance?.sourceId : undefined) ??
    ("provenance" in hit.record ? hit.record.provenance?.filePath : undefined) ??
    hit.record.id;
}

function isPrivate(hit: RecallHit): boolean {
  const metadata = "metadata" in hit.record ? hit.record.metadata : undefined;
  return Boolean(metadata?.private || metadata?.visibility === "private");
}

function toLookupResult(hit: RecallHit): ConsoleLookupResult {
  const text = hitText(hit);
  const privateContent = isPrivate(hit);
  return {
    id: hit.record.id,
    kind: hitKind(hit),
    title: text.split("\n")[0]?.slice(0, 80) || hit.record.id,
    preview: privateContent ? "[private]" : text.slice(0, 240),
    raw: privateContent ? undefined : text,
    score: hit.score,
    scoreBreakdown: hit.scoreBreakdown ?? {},
    sourceLabel: sourceLabel(hit),
    namespace: hit.record.scope.namespace,
    provenanceCount: hit.provenance ? 1 : 0,
  };
}

/**
 * 把内部 CandidateRecord 投影为 UI 安全字段。
 *
 * 仅暴露审核所需的字段；metadata、extractor、hitCount、lastHitAt 等内部状态
 * 不外泄，避免 Console 成为内部数据的旁路出口。
 */
function toConsoleCandidate(record: CandidateRecord): ConsoleCandidate {
  return {
    id: record.id,
    preview: record.text.slice(0, 240),
    semanticType: record.semanticType,
    kind: record.kind,
    confidence: record.confidence,
    status: record.status,
    evidenceIds: record.evidenceIds,
    createdAt: record.createdAt,
  };
}

export function createConsoleApi(options: CreateConsoleApiOptions): ConsoleApi {
  return {
    async overview(scope: MemoryScope): Promise<ConsoleOverview> {
      const [health, chunks, queuedJobs, failedJobs, summaries, pendingCandidateList] = await Promise.all([
        options.service.health(),
        options.chunks?.list({ scope }) ?? Promise.resolve([]),
        options.jobs?.list("queued") ?? Promise.resolve([]),
        options.jobs?.list("failed") ?? Promise.resolve([]),
        options.tree?.listSummaries({ scope }) ?? Promise.resolve([]),
        options.candidates?.list({ scope, status: "pending" }) ?? Promise.resolve([]),
      ]);
      const graph = options.graph
        ? await options.graph.query({ scope, depth: 1, limit: 10 })
        : { entities: [], relations: [], evidenceChunkIds: [] };
      // 槽位新鲜度：最近一次候选入队时间，反映候选区活跃度
      const slotFreshness = pendingCandidateList.length > 0
        ? Math.max(...pendingCandidateList.map((c) => c.createdAt))
        : undefined;
      return {
        scope,
        health,
        metrics: {
          memories: health.records ?? 0,
          chunks: chunks.length,
          entities: graph.entities.length,
          relations: graph.relations.length,
          summaries: summaries.length,
          queuedJobs: queuedJobs.length,
          failedJobs: failedJobs.length,
          // candidate backlog：等待审核的 pending 候选；未注入时为 0（向后兼容）
          pendingCandidates: pendingCandidateList.length,
        },
        slotFreshness,
        hotTopics: graph.entities
          .map((entity) => ({ id: entity.id, label: entity.displayName, hotness: entity.hotness }))
          .sort((left, right) => right.hotness - left.hotness)
          .slice(0, 10),
        dailyDigest: summaries.find((summary) => summary.treeType === "global")
          ? (() => {
            const digest = summaries.find((summary) => summary.treeType === "global")!;
            return {
              id: digest.id,
              title: digest.title,
              summary: digest.summary,
              sealedAt: digest.sealedAt,
            };
          })()
          : undefined,
      };
    },

    async lookup(input: ConsoleLookupRequest): Promise<ConsoleLookupResponse> {
      const recalled = await options.service.recall({
        query: input.query,
        scope: input.scope,
        limit: input.limit,
      });
      return {
        scope: recalled.scope,
        query: recalled.query,
        results: recalled.hits.map(toLookupResult),
      };
    },

    async graph(input): Promise<ConsoleGraphResponse> {
      if (!options.graph) {
        return { entities: [], relations: [], evidenceChunkIds: [] };
      }
      return options.graph.query(input);
    },

    async jobs(): Promise<ConsoleJobsResponse> {
      const jobs = await (options.jobs?.list() ?? Promise.resolve([]));
      const counts: Record<string, number> = {};
      for (const job of jobs) {
        counts[job.status] = (counts[job.status] ?? 0) + 1;
      }
      return { jobs, counts };
    },

    /**
     * 列出候选区记录（只读）。
     *
     * 安全边界：candidate 不是 active MemoryRecord，永远不会进入必读层（5 槽位）。
     * 该接口仅读取候选区并投影为 UI 字段；未注入 candidates 时返回空列表，
     * 保持向后兼容。
     */
    async candidates(req: ConsoleCandidatesRequest): Promise<ConsoleCandidatesResponse> {
      if (!options.candidates) {
        return { candidates: [], total: 0 };
      }
      const records = await options.candidates.list({
        scope: req.scope,
        status: req.filter?.status,
        semanticType: req.filter?.semanticType,
        minConfidence: req.filter?.minConfidence,
        limit: req.filter?.limit,
      });
      return {
        candidates: records.map(toConsoleCandidate),
        total: records.length,
      };
    },

    /**
     * 批量审核候选。
     *
     * 安全边界：只有 approve 才会通过 candidateReview.promoteCandidate →
     * MemoryService.store 把候选写入主库；reject/archive 仅推进状态机，不注入主库。
     * 未注入 candidateReview 时返回错误结果，绝不静默放行。
     */
    async reviewCandidates(
      req: ConsoleCandidateReviewRequest
    ): Promise<ConsoleCandidateReviewResponse> {
      if (!options.candidateReview) {
        return { affected: 0, promoted: [], errors: ["candidate_review_not_available"] };
      }
      return options.candidateReview.review(req.action);
    },

    async candidateCount(
      scope: MemoryScope,
      filter?: { status?: CandidateStatus }
    ): Promise<number> {
      if (!options.candidates) {
        return 0;
      }
      return options.candidates.count({ scope, status: filter?.status });
    },
  };
}
