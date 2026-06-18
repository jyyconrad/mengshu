/**
 * Web Console API view types.
 *
 * Console 不直接暴露底层表，而是按 overview、lookup、graph、jobs 四类
 * 操作台视图返回数据，并保留 scope/provenance 以支持追溯。
 */

import type { MemoryScope, MemorySemanticType, RecallHit } from "../core/types.js";
import type { GraphQueryResult } from "../graph/query.js";
import type { JobRecord } from "../storage/repositories/types.js";
import type {
  CandidateReviewAction,
  CandidateReviewResult,
  CandidateStatus,
} from "../lifecycle/candidate-types.js";

export interface ConsoleOverview {
  scope: MemoryScope;
  health: { ok: boolean; records?: number; error?: string };
  metrics: {
    memories: number;
    chunks: number;
    entities: number;
    relations: number;
    summaries: number;
    queuedJobs: number;
    failedJobs: number;
    /** 候选区 backlog：等待审核的 pending 候选数量 */
    pendingCandidates: number;
  };
  /** 槽位新鲜度：最近一次候选入队时间（毫秒），无候选时缺省 */
  slotFreshness?: number;
  hotTopics: Array<{ id: string; label: string; hotness: number }>;
  dailyDigest?: { id: string; title: string; summary: string; sealedAt?: number };
}

export interface ConsoleLookupRequest {
  scope: MemoryScope;
  query: string;
  limit?: number;
}

export interface ConsoleLookupResult {
  id: string;
  kind: string;
  title: string;
  preview: string;
  score: number;
  scoreBreakdown: Record<string, number>;
  sourceLabel: string;
  namespace: string;
  provenanceCount: number;
  raw?: string;
}

export interface ConsoleLookupResponse {
  scope: MemoryScope;
  query: string;
  results: ConsoleLookupResult[];
}

export interface ConsoleGraphResponse extends GraphQueryResult {}

export interface ConsoleJobsResponse {
  jobs: JobRecord[];
  counts: Record<string, number>;
}

/**
 * 候选区 UI 投影。
 *
 * 只暴露 Console 审核需要的字段，不泄露 metadata、内部 hit 计数等内部状态。
 * 候选不是 active MemoryRecord，因此永远不会进入必读层（5 槽位），仅在用户
 * approve 后才通过 promoteCandidate 写入主库。
 */
export interface ConsoleCandidate {
  id: string;
  preview: string;
  semanticType?: MemorySemanticType;
  kind: string;
  confidence: number;
  status: CandidateStatus;
  evidenceIds: string[];
  createdAt: number;
}

export interface ConsoleCandidatesRequest {
  scope: MemoryScope;
  filter?: {
    status?: CandidateStatus;
    semanticType?: MemorySemanticType;
    minConfidence?: number;
    limit?: number;
  };
}

export interface ConsoleCandidatesResponse {
  candidates: ConsoleCandidate[];
  total: number;
}

export interface ConsoleCandidateReviewRequest {
  action: CandidateReviewAction;
}

export interface ConsoleCandidateReviewResponse extends CandidateReviewResult {}

export interface ConsoleApi {
  overview(scope: MemoryScope): Promise<ConsoleOverview>;
  lookup(input: ConsoleLookupRequest): Promise<ConsoleLookupResponse>;
  graph(input: { scope: MemoryScope; query?: string; entityId?: string; depth?: number; limit?: number }): Promise<ConsoleGraphResponse>;
  jobs(): Promise<ConsoleJobsResponse>;
  /** 列出候选区记录（只读，投影为 UI 字段） */
  candidates(req: ConsoleCandidatesRequest): Promise<ConsoleCandidatesResponse>;
  /** 批量审核候选（approve/reject/archive/by_filter/evict） */
  reviewCandidates(req: ConsoleCandidateReviewRequest): Promise<ConsoleCandidateReviewResponse>;
  /** 候选区计数 */
  candidateCount(
    scope: MemoryScope,
    filter?: { status?: CandidateStatus }
  ): Promise<number>;
}

export type ConsoleRecallHit = RecallHit;
