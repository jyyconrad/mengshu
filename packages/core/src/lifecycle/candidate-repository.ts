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
    const status: CandidateStatus = input.status ?? "pending";

    // D-02 / §17.1：候选区单会话容量约束。
    // 仅对新写入 status=pending 的候选生效——超限时把同会话最早入队的 pending
    // 标记为 archived（含 audit 原因 archived_due_to_session_capacity），保证候选区
    // 不会无限膨胀。会话身份按 scope.sessionId 识别；缺省时退回 full scope 比较，
    // 让限制即便在无 sessionId 的旧调用方也生效。
    if (status === "pending") {
      this.evictOldestPendingIfFull(input.scope);
    }

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
      status,
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

  /**
   * D-02：超限时归档最早入队的 pending 候选。
   *
   * 同会话（按 scope.sessionId 优先；缺省退回 sameScope 全字段匹配）的 pending
   * 数 >= maxCandidatesPerSession 时，按 createdAt 升序找最旧条目并将 status
   * 改为 archived，metadata.statusReason 写入 archived_due_to_session_capacity
   * 以便后续 audit 追溯。该归档行为是内部副作用，不改 enqueue 外部签名。
   */
  private evictOldestPendingIfFull(scope: MemoryScope): void {
    const limit = this.config.maxCandidatesPerSession;
    if (!Number.isFinite(limit) || limit <= 0) return;

    const sessionId = scope.sessionId;
    const sameSession = (a: MemoryScope): boolean =>
      sessionId !== undefined
        ? a.sessionId === sessionId
        : sameScope(a, scope);

    const pendingInSession: CandidateRecord[] = [];
    for (const r of this.records.values()) {
      if (r.status === "pending" && sameSession(r.scope)) {
        pendingInSession.push(r);
      }
    }
    if (pendingInSession.length < limit) return;

    pendingInSession.sort((a, b) => a.createdAt - b.createdAt);
    // 可能存在多余条目（理论上应只多 1 条；为稳妥按需驱逐多余的）。
    const overflow = pendingInSession.length - limit + 1;
    for (let i = 0; i < overflow; i++) {
      const oldest = pendingInSession[i];
      oldest.status = "archived";
      oldest.updatedAt = this.now();
      oldest.metadata = {
        ...oldest.metadata,
        statusReason: "archived_due_to_session_capacity",
      };
    }
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
