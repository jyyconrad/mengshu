/**
 * SkillCandidate Repository 内存实现
 *
 * 提供 skill_candidate 的 CRUD 操作。
 * 首期使用内存存储，后续可扩展到持久化层。
 */

import type {
  SkillCandidate,
  SkillCandidateRepository,
  SkillCandidateStatus,
} from "./skill-candidate-types.js";
import type { MemoryScope } from "../core/types.js";

/**
 * 内存实现
 */
export class InMemorySkillCandidateRepository implements SkillCandidateRepository {
  private store: Map<string, SkillCandidate> = new Map();
  private now: () => number;

  constructor(deps?: { now?: () => number }) {
    this.now = deps?.now ?? Date.now;
  }

  async create(
    input: Omit<SkillCandidate, "id" | "createdAt"> & { id?: string }
  ): Promise<SkillCandidate> {
    const id = input.id ?? `skill-${this.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const candidate: SkillCandidate = {
      ...input,
      id,
      createdAt: this.now(),
    };

    this.store.set(id, candidate);
    return candidate;
  }

  async get(id: string): Promise<SkillCandidate | undefined> {
    return this.store.get(id);
  }

  async list(filter?: {
    scope?: MemoryScope;
    status?: SkillCandidateStatus;
    topicLabel?: string;
    minConfidence?: number;
    limit?: number;
  }): Promise<SkillCandidate[]> {
    let results = Array.from(this.store.values());

    // 应用过滤器
    if (filter) {
      if (filter.scope) {
        results = results.filter((c) => this.scopeMatches(c.scope, filter.scope!));
      }

      if (filter.status) {
        results = results.filter((c) => c.status === filter.status);
      }

      if (filter.topicLabel) {
        results = results.filter((c) => c.topicLabel === filter.topicLabel);
      }

      if (filter.minConfidence !== undefined) {
        results = results.filter((c) => c.confidence >= filter.minConfidence!);
      }

      if (filter.limit !== undefined && filter.limit > 0) {
        results = results.slice(0, filter.limit);
      }
    }

    return results;
  }

  async updateStatus(
    id: string,
    status: SkillCandidateStatus,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const candidate = this.store.get(id);
    if (!candidate) {
      throw new Error(`SkillCandidate ${id} not found`);
    }

    const updated: SkillCandidate = {
      ...candidate,
      status,
      updatedAt: this.now(),
      metadata: metadata ? { ...candidate.metadata, ...metadata } : candidate.metadata,
    };

    this.store.set(id, updated);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  async findByTopic(topicLabel: string, scope?: MemoryScope): Promise<SkillCandidate[]> {
    return this.list({ topicLabel, scope });
  }

  /**
   * 清空存储（测试用）
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * 获取存储大小（测试用）
   */
  size(): number {
    return this.store.size;
  }

  /**
   * Scope 匹配（简化版本）
   */
  private scopeMatches(candidateScope: MemoryScope, filterScope: MemoryScope): boolean {
    // 简单实现：精确匹配核心字段
    return (
      candidateScope.tenantId === filterScope.tenantId &&
      candidateScope.appId === filterScope.appId &&
      candidateScope.userId === filterScope.userId &&
      candidateScope.projectId === filterScope.projectId
    );
  }
}
