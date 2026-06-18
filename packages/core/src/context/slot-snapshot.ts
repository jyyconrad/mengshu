/**
 * SlotSnapshot 缓存
 *
 * 5 槽位上下文的内存缓存，避免每次请求都重新聚合记忆。
 */

import type {
  MemoryScope,
  MemorySemanticType,
  MemoryRecord,
} from "../domain/types.js";

export interface SlotSnapshot {
  scope: MemoryScope;
  semanticType: MemorySemanticType;
  topNodes: MemoryRecord[];
  generatedAt: number;
  ttl: number;
}

function generateCacheKey(
  scope: MemoryScope,
  semanticType: MemorySemanticType
): string {
  return `${scope.tenantId}:${scope.appId}:${scope.userId}:${scope.projectId}:${scope.agentId}:${scope.namespace}:${semanticType}`;
}

export class SlotSnapshotCache {
  private cache: Map<string, SlotSnapshot> = new Map();
  private defaultTTL: number;

  constructor(defaultTTL: number = 5 * 60 * 1000) {
    this.defaultTTL = defaultTTL;
  }

  get(scope: MemoryScope, semanticType: MemorySemanticType): SlotSnapshot | null {
    const key = generateCacheKey(scope, semanticType);
    const snapshot = this.cache.get(key);

    if (!snapshot) {
      return null;
    }

    const now = Date.now();
    if (now - snapshot.generatedAt > snapshot.ttl) {
      this.cache.delete(key);
      return null;
    }

    return snapshot;
  }

  set(snapshot: SlotSnapshot): void {
    const key = generateCacheKey(snapshot.scope, snapshot.semanticType);
    this.cache.set(key, snapshot);
  }

  create(
    scope: MemoryScope,
    semanticType: MemorySemanticType,
    topNodes: MemoryRecord[],
    ttl?: number
  ): SlotSnapshot {
    const snapshot: SlotSnapshot = {
      scope,
      semanticType,
      topNodes,
      generatedAt: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    };

    this.set(snapshot);
    return snapshot;
  }

  invalidate(scope: MemoryScope, semanticType?: MemorySemanticType): void {
    if (semanticType) {
      const key = generateCacheKey(scope, semanticType);
      this.cache.delete(key);
    } else {
      const prefix = `${scope.tenantId}:${scope.appId}:${scope.userId}:${scope.projectId}:${scope.agentId}:${scope.namespace}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  clear(): void {
    this.cache.clear();
  }

  stats(): { size: number; expired: number; validKeys: string[] } {
    const now = Date.now();
    let expired = 0;
    const validKeys: string[] = [];

    for (const [key, snapshot] of this.cache.entries()) {
      if (now - snapshot.generatedAt > snapshot.ttl) {
        expired++;
      } else {
        validKeys.push(key);
      }
    }

    return { size: this.cache.size, expired, validKeys };
  }

  cleanExpired(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, snapshot] of this.cache.entries()) {
      if (now - snapshot.generatedAt > snapshot.ttl) {
        this.cache.delete(key);
        cleaned++;
      }
    }

    return cleaned;
  }
}

export const globalSlotSnapshotCache = new SlotSnapshotCache();

export const RECOMMENDED_TTL = {
  profile: 30 * 60 * 1000,
  task_context: 5 * 60 * 1000,
  rules: 60 * 60 * 1000,
  experience: 15 * 60 * 1000,
  resource: 10 * 60 * 1000,
} as const;
