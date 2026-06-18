/**
 * 候选区审核服务
 *
 * 实现 §9.3 的批量审核能力：
 * - approve：写入主库（通过 promote 回调）
 * - reject：仅标记拒绝（保留 contentHash 用于降权）
 * - archive：批量归档（命中过未确认）
 * - approve_by_filter / reject_by_filter：按 type / confidence 批量
 * - evict_expired：手动触发自动淘汰
 */

import type {
  CandidateRecord,
  CandidateRepository,
  CandidateReviewAction,
  CandidateReviewResult,
} from "./candidate-types.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";

export interface CandidateReviewServiceDeps {
  repository: CandidateRepository;
  /** 接受候选时调用，将候选转换为 MemoryRecord 并写入主库 */
  promoteCandidate?(input: {
    candidate: CandidateRecord;
  }): Promise<{ memoryId: string }>;
  /** 拒绝时记录 contentHash 黑名单（可选） */
  recordRejectedHash?(contentHash: string): Promise<void>;
  /** 审计日志 */
  audit?(input: {
    scope: MemoryScope;
    action: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
  now?: () => number;
}

export class CandidateReviewService {
  private deps: CandidateReviewServiceDeps;
  private now: () => number;

  constructor(deps: CandidateReviewServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async review(action: CandidateReviewAction): Promise<CandidateReviewResult> {
    switch (action.action) {
      case "approve":
        return this.approveBatch(action.ids);
      case "reject":
        return this.rejectBatch(action.ids, action.reason);
      case "archive":
        return this.archiveBatch(action.ids);
      case "approve_by_filter":
        return this.approveByFilter(action.filter);
      case "reject_by_filter":
        return this.rejectByFilter(action.filter);
      case "evict_expired":
        return this.evictExpired();
      default:
        return { affected: 0, promoted: [], errors: ["unknown_action"] };
    }
  }

  private async approveBatch(ids: string[]): Promise<CandidateReviewResult> {
    const promoted: string[] = [];
    const errors: string[] = [];
    let affected = 0;

    for (const id of ids) {
      const record = await this.deps.repository.get(id);
      if (!record) {
        errors.push(`not_found:${id}`);
        continue;
      }
      if (record.status !== "pending") {
        errors.push(`not_pending:${id}`);
        continue;
      }
      try {
        let memoryId: string | undefined;
        if (this.deps.promoteCandidate) {
          const result = await this.deps.promoteCandidate({ candidate: record });
          memoryId = result.memoryId;
          promoted.push(memoryId);
        }
        await this.deps.repository.setStatus(id, "approved", {
          promotedToMemoryId: memoryId,
        });
        await this.deps.audit?.({
          scope: record.scope,
          action: "candidate.approve",
          targetId: id,
          metadata: { memoryId },
        });
        affected++;
      } catch (err) {
        errors.push(`promote_failed:${id}:${(err as Error).message}`);
      }
    }

    return { affected, promoted, errors };
  }

  private async rejectBatch(
    ids: string[],
    reason?: string
  ): Promise<CandidateReviewResult> {
    const errors: string[] = [];
    let affected = 0;

    for (const id of ids) {
      const record = await this.deps.repository.get(id);
      if (!record) {
        errors.push(`not_found:${id}`);
        continue;
      }
      await this.deps.repository.setStatus(id, "rejected", { reason });
      await this.deps.audit?.({
        scope: record.scope,
        action: "candidate.reject",
        targetId: id,
        metadata: { reason },
      });
      affected++;
    }

    return { affected, promoted: [], errors };
  }

  private async archiveBatch(ids: string[]): Promise<CandidateReviewResult> {
    const errors: string[] = [];
    let affected = 0;

    for (const id of ids) {
      const record = await this.deps.repository.get(id);
      if (!record) {
        errors.push(`not_found:${id}`);
        continue;
      }
      await this.deps.repository.setStatus(id, "archived");
      await this.deps.audit?.({
        scope: record.scope,
        action: "candidate.archive",
        targetId: id,
      });
      affected++;
    }

    return { affected, promoted: [], errors };
  }

  private async approveByFilter(filter: {
    semanticType?: import("../domain/types.js").MemorySemanticType;
    minConfidence?: number;
  }): Promise<CandidateReviewResult> {
    const candidates = await this.deps.repository.list({
      status: "pending",
      semanticType: filter.semanticType,
      minConfidence: filter.minConfidence,
    });
    return this.approveBatch(candidates.map((c) => c.id));
  }

  private async rejectByFilter(filter: {
    semanticType?: import("../domain/types.js").MemorySemanticType;
    maxConfidence?: number;
  }): Promise<CandidateReviewResult> {
    const all = await this.deps.repository.list({ status: "pending" });
    const targets = all.filter((c) => {
      if (
        filter.semanticType &&
        c.semanticType !== filter.semanticType
      )
        return false;
      if (
        typeof filter.maxConfidence === "number" &&
        c.confidence > filter.maxConfidence
      )
        return false;
      return true;
    });
    return this.rejectBatch(targets.map((c) => c.id));
  }

  private async evictExpired(): Promise<CandidateReviewResult> {
    const repo = this.deps.repository as unknown as {
      runEvictionScan?: () => Promise<{ evicted: number; archived: number }>;
    };
    if (!repo.runEvictionScan) {
      return {
        affected: 0,
        promoted: [],
        errors: ["repository_does_not_support_eviction"],
      };
    }
    const result = await repo.runEvictionScan();
    return {
      affected: result.evicted + result.archived,
      promoted: [],
      errors: [],
    };
  }
}

/**
 * 把 CandidateRecord 转换为 MemoryRecord（默认实现）
 */
export function candidateToMemoryRecord(
  candidate: CandidateRecord,
  options: {
    contentHash: string;
    importance?: number;
    category?: import("../../../../config.js").MemoryCategory;
    dataType?: import("../db/types.js").DataType;
    idFactory?: () => string;
  }
): MemoryRecord {
  const id = options.idFactory ? options.idFactory() : candidate.id + ":memory";
  return {
    id,
    scope: candidate.scope,
    kind: (candidate.kind ?? "other") as MemoryRecord["kind"],
    semanticType: candidate.semanticType,
    text: candidate.text,
    contentHash: options.contentHash,
    importance: options.importance ?? 0.7,
    confidence: candidate.confidence,
    category: options.category ?? "other",
    dataType: options.dataType ?? "memory",
    metadata: {
      ...candidate.metadata,
      promotedFromCandidate: candidate.id,
    },
    provenance: {
      source: candidate.extractor ?? "extractor",
      sourceId: candidate.id,
    },
    createdAt: Date.now(),
    container: "session_candidate",
    lifecycleStatus: "active",
  };
}
