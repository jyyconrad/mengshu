/**
 * 候选区内存实现
 *
 * 实现 CandidateRepository 接口，提供：
 * - 入库（带状态机）
 * - 命中刷新（lastHitAt）
 * - 自动淘汰扫描
 * - 批量审核
 *
 * v0.x 单机配置使用纯内存实现；持久化由调用方在 onChange 钩子中负责
 * （未来可对接 LanceDB candidates 表）。
 */

import { randomUUID } from "node:crypto";
import type {
  CandidateRecord,
  CandidateRepository,
  CandidateStatus,
  CandidateZoneConfig,
} from "./candidate-types.js";
import { DEFAULT_CANDIDATE_CONFIG } from "./candidate-types.js";
import type { MemoryScope, MemorySemanticType } from "../core/types.js";

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return (
    a.tenantId === b.tenantId &&
    a.appId === b.appId &&
    a.userId === b.userId &&
    a.projectId === b.projectId &&
    a.agentId === b.agentId &&
    a.namespace === b.namespace
  );
}

export class InMemoryCandidateRepository implements CandidateRepository {
  private records = new Map<string, CandidateRecord>();
  private now: () => number;
  private idFactory: () => string;
  config: Required<CandidateZoneConfig>;

  constructor(options?: {
    now?: () => number;
    idFactory?: () => string;
    config?: CandidateZoneConfig;
  }) {
    this.now = options?.now ?? Date.now;
    this.idFactory = options?.idFactory ?? randomUUID;
    this.config = { ...DEFAULT_CANDIDATE_CONFIG, ...(options?.config ?? {}) };
  }

  async enqueue(input: Omit<
    CandidateRecord,
    "id" | "status" | "hitCount" | "createdAt"
  > & { id?: string; status?: CandidateStatus }): Promise<CandidateRecord> {
    const record: CandidateRecord = {
      id: input.id ?? this.idFactory(),
      scope: input.scope,
      text: input.text,
      semanticType: input.semanticType,
      kind: input.kind,
      confidence: input.confidence,
      reason: input.reason,
      evidenceIds: input.evidenceIds,
      extractor: input.extractor,
      status: input.status ?? "pending",
      hitCount: 0,
      metadata: input.metadata,
      createdAt: this.now(),
      updatedAt: undefined,
      lastHitAt: undefined,
      promotedToMemoryId: undefined,
    };
    this.records.set(record.id, record);
    return record;
  }

  async get(id: string): Promise<CandidateRecord | undefined> {
    return this.records.get(id);
  }

  async list(filter?: {
    scope?: MemoryScope;
    status?: CandidateStatus;
    semanticType?: MemorySemanticType;
    minConfidence?: number;
    limit?: number;
  }): Promise<CandidateRecord[]> {
    let result = Array.from(this.records.values());
    if (filter?.scope) {
      result = result.filter((r) => sameScope(r.scope, filter.scope!));
    }
    if (filter?.status) {
      result = result.filter((r) => r.status === filter.status);
    }
    if (filter?.semanticType) {
      result = result.filter((r) => r.semanticType === filter.semanticType);
    }
    if (typeof filter?.minConfidence === "number") {
      result = result.filter((r) => r.confidence >= filter.minConfidence!);
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    if (filter?.limit) {
      result = result.slice(0, filter.limit);
    }
    return result;
  }

  async setStatus(
    id: string,
    status: CandidateStatus,
    metadata?: { promotedToMemoryId?: string; reason?: string }
  ): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.status = status;
    record.updatedAt = this.now();
    if (metadata?.promotedToMemoryId) {
      record.promotedToMemoryId = metadata.promotedToMemoryId;
    }
    if (metadata?.reason) {
      record.metadata = { ...record.metadata, statusReason: metadata.reason };
    }
  }

  async touchHit(id: string, nowOverride?: number): Promise<void> {
    const record = this.records.get(id);
    if (!record) return;
    record.lastHitAt = nowOverride ?? this.now();
    record.hitCount += 1;
  }

  async count(filter?: {
    scope?: MemoryScope;
    status?: CandidateStatus;
  }): Promise<number> {
    return (await this.list(filter)).length;
  }

  async deleteByIds(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (this.records.delete(id)) deleted++;
    }
    return deleted;
  }

  /**
   * 自动淘汰扫描：
   * - 30 天未命中 → 标记 expired 并删除
   * - 命中过但 30 天未确认 → 标记 archived
   *
   * 返回扫描结果统计。
   */
  async runEvictionScan(): Promise<{
    evicted: number;
    archived: number;
  }> {
    const now = this.now();
    const evictionMs = this.config.evictionDays * 24 * 60 * 60 * 1000;
    const archiveMs = this.config.archiveDays * 24 * 60 * 60 * 1000;
    let evicted = 0;
    let archived = 0;

    for (const record of this.records.values()) {
      if (record.status !== "pending") continue;
      const age = now - record.createdAt;
      if (record.lastHitAt) {
        // 命中过但未确认 → 归档
        if (age > archiveMs) {
          record.status = "archived";
          record.updatedAt = now;
          archived++;
        }
      } else {
        // 未命中 → 淘汰
        if (age > evictionMs) {
          record.status = "expired";
          record.updatedAt = now;
          evicted++;
        }
      }
    }

    // 真正物理删除 expired
    const expiredIds = Array.from(this.records.values())
      .filter((r) => r.status === "expired")
      .map((r) => r.id);
    if (expiredIds.length > 0) {
      await this.deleteByIds(expiredIds);
    }

    return { evicted, archived };
  }
}
