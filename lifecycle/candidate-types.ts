/**
 * 候选区（Candidate Zone）核心类型与契约。
 *
 * 实现方案文档 §9.3 和评审 §2.1 问题 3：
 * - 自动抽取的记忆默认进入 session_candidate
 * - 30 天未命中自动删除；命中过但未确认归档
 * - 提供批量审核 API（接受、拒绝、归档）
 *
 * 候选不是长期记忆，不进入必读层（5 槽位）。
 */

import type {
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
} from "../core/types.js";

/**
 * 候选状态机
 */
export type CandidateStatus =
  | "pending"      // 待审核
  | "approved"     // 已接受（写入主库后保留 audit）
  | "rejected"     // 已拒绝
  | "archived"     // 命中过但未确认 → 归档
  | "expired";     // 30 天未命中 → 自动删除

/**
 * 候选记录
 */
export interface CandidateRecord {
  id: string;
  scope: MemoryScope;
  /** 候选记忆主体 */
  text: string;
  /** 自动抽取的 semanticType */
  semanticType?: MemorySemanticType;
  /** 自动抽取的 kind */
  kind: string;
  /** 抽取置信度 0-1 */
  confidence: number;
  /** 抽取理由 */
  reason?: string;
  /** 来源 evidence */
  evidenceIds: string[];
  /** 提取器名称（用于追溯） */
  extractor?: string;
  /** 状态 */
  status: CandidateStatus;
  /** 上次被命中时间（用于自动淘汰） */
  lastHitAt?: number;
  /** 命中次数 */
  hitCount: number;
  /** 元数据（含来源 session 等） */
  metadata: Record<string, unknown>;
  /** 创建时间 */
  createdAt: number;
  /** 更新时间 */
  updatedAt?: number;
  /** 接受后写入的 memory id（双向追溯） */
  promotedToMemoryId?: string;
}

/**
 * 5 type 抽取阈值（参考 §9.3）
 */
export const CANDIDATE_THRESHOLDS: Record<
  MemorySemanticType,
  { min: number; direct: number }
> = {
  profile: { min: 0.7, direct: 0.9 },
  task_context: { min: 0.7, direct: 0.9 },
  rules: { min: 0.8, direct: 0.9 },
  experience: { min: 0.75, direct: 0.9 },
  resource: { min: 0.7, direct: 0.95 },
};

/**
 * 候选区配置
 */
export interface CandidateZoneConfig {
  /** 自动淘汰：30 天未命中 → 删除 */
  evictionDays?: number;
  /** 归档延迟：命中过但 30 天未确认 → 归档 */
  archiveDays?: number;
  /** 审核批次大小 */
  reviewBatchSize?: number;
}

export const DEFAULT_CANDIDATE_CONFIG: Required<CandidateZoneConfig> = {
  evictionDays: 30,
  archiveDays: 30,
  reviewBatchSize: 100,
};

/**
 * 候选区 repository 接口
 */
export interface CandidateRepository {
  /** 入库（来自 extractor） */
  enqueue(record: Omit<CandidateRecord, "id" | "status" | "hitCount" | "createdAt"> & {
    id?: string;
    status?: CandidateStatus;
  }): Promise<CandidateRecord>;
  /** 单个查询 */
  get(id: string): Promise<CandidateRecord | undefined>;
  /** 列表查询 */
  list(filter?: {
    scope?: MemoryScope;
    status?: CandidateStatus;
    semanticType?: MemorySemanticType;
    minConfidence?: number;
    limit?: number;
  }): Promise<CandidateRecord[]>;
  /** 状态推进 */
  setStatus(
    id: string,
    status: CandidateStatus,
    metadata?: { promotedToMemoryId?: string; reason?: string }
  ): Promise<void>;
  /** 命中时刷新 lastHitAt */
  touchHit(id: string, now?: number): Promise<void>;
  /** 计数 */
  count(filter?: {
    scope?: MemoryScope;
    status?: CandidateStatus;
  }): Promise<number>;
  /** 批量删除（用于自动淘汰） */
  deleteByIds(ids: string[]): Promise<number>;
}

/**
 * 批量审核操作
 */
export type CandidateReviewAction =
  | { action: "approve"; ids: string[] }
  | { action: "reject"; ids: string[]; reason?: string }
  | { action: "archive"; ids: string[] }
  | {
      action: "approve_by_filter";
      filter: {
        semanticType?: MemorySemanticType;
        minConfidence?: number;
      };
    }
  | {
      action: "reject_by_filter";
      filter: {
        semanticType?: MemorySemanticType;
        maxConfidence?: number;
      };
    }
  | { action: "evict_expired"; olderThanDays?: number };

/**
 * 批量审核结果
 */
export interface CandidateReviewResult {
  affected: number;
  promoted: string[];
  errors: string[];
}

/**
 * 候选区配置：根据 semanticType 计算入库决策
 */
export type CandidateAdmissionDecision =
  | { route: "memory"; reason: string }
  | { route: "candidate"; reason: string }
  | { route: "drop"; reason: string };

export function decideAdmission(
  semanticType: MemorySemanticType | undefined,
  confidence: number,
  text: string,
  meta: { hasWhy?: boolean; hasOutcome?: boolean } = {}
): CandidateAdmissionDecision {
  // 无 semanticType：进入候选（但不丢弃，保留 lookup）
  if (!semanticType) {
    return { route: "candidate", reason: "no_semantic_type" };
  }

  // experience 必须有 why
  if (semanticType === "experience" && !meta.hasWhy) {
    return { route: "drop", reason: "experience_missing_why" };
  }

  const threshold = CANDIDATE_THRESHOLDS[semanticType];
  if (!threshold) {
    return { route: "candidate", reason: "unknown_semantic_type" };
  }

  if (confidence >= threshold.direct) {
    return { route: "memory", reason: "high_confidence" };
  }
  if (confidence >= threshold.min) {
    return { route: "candidate", reason: "medium_confidence" };
  }
  return { route: "drop", reason: "low_confidence" };
}
