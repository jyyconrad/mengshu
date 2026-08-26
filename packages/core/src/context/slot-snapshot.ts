/**
 * SlotSnapshot 缓存
 *
 * 5 槽位上下文的内存缓存，避免每次请求都重新聚合记忆。
 */

import { createHash } from "node:crypto";
import type {
  MemoryScope,
  MemorySemanticType,
  MemoryRecord,
  RecallHit,
} from "../domain/types.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";

export interface SlotSnapshot {
  scope: MemoryScope;
  semanticType: MemorySemanticType;
  topNodes: MemoryRecord[];
  /** F0 生产上下文保留不可拆分的 RecallHit + 六因子回执。 */
  topHits?: RecallHit[];
  /** 当前已治理召回输入的稳定指纹；防止 lifecycle 变化后复用旧快照。 */
  inputFingerprint?: string;
  /** V2 cache identity；缺失表示 legacy snapshot。 */
  version?: SlotSnapshotVersion;
  generatedAt: number;
  ttl: number;
}

export interface SlotSnapshotVersionInput {
  inputFingerprint: string;
  loadoutVersion?: number;
  assetVersions?: Array<{ assetId: string; version: number }>;
  retrievalVersion: string;
  scoringVersion: string;
  promptPolicyVersion: string;
}

export interface SlotSnapshotVersion {
  slotSnapshot: 2;
  inputFingerprint: string;
  loadoutVersion?: number;
  assetVersionSetHash?: string;
  retrievalVersion: string;
  scoringVersion: string;
  promptPolicyVersion: string;
  snapshotHash: string;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function createSlotSnapshotVersion(
  input: SlotSnapshotVersionInput,
): SlotSnapshotVersion {
  const assetVersions = [...(input.assetVersions ?? [])]
    .sort((left, right) => left.assetId.localeCompare(right.assetId) || left.version - right.version);
  const assetVersionSetHash = assetVersions.length === 0
    ? undefined
    : hash(assetVersions);
  const identity = {
    slotSnapshot: 2 as const,
    inputFingerprint: input.inputFingerprint,
    ...(input.loadoutVersion === undefined ? {} : { loadoutVersion: input.loadoutVersion }),
    ...(assetVersionSetHash === undefined ? {} : { assetVersionSetHash }),
    retrievalVersion: input.retrievalVersion,
    scoringVersion: input.scoringVersion,
    promptPolicyVersion: input.promptPolicyVersion,
  };
  return Object.freeze({ ...identity, snapshotHash: hash(identity) });
}

function sameVersion(left: SlotSnapshotVersion, right: SlotSnapshotVersion): boolean {
  return left.slotSnapshot === right.slotSnapshot &&
    left.inputFingerprint === right.inputFingerprint &&
    left.loadoutVersion === right.loadoutVersion &&
    left.assetVersionSetHash === right.assetVersionSetHash &&
    left.retrievalVersion === right.retrievalVersion &&
    left.scoringVersion === right.scoringVersion &&
    left.promptPolicyVersion === right.promptPolicyVersion &&
    left.snapshotHash === right.snapshotHash;
}

function generateCacheKey(
  scope: MemoryScope,
  semanticType: MemorySemanticType
): string {
  return `${generateScopePrefix(scope)}${semanticType}`;
}

function generateScopePrefix(scope: MemoryScope): string {
  const canonicalScope = scope.visibility === undefined
    ? { ...scope, visibility: "private" as const }
    : scope;
  return `${authorityScopeFingerprint(canonicalScope)}:`;
}

export class SlotSnapshotCache {
  private cache: Map<string, SlotSnapshot> = new Map();
  private defaultTTL: number;

  constructor(defaultTTL: number = 5 * 60 * 1000) {
    this.defaultTTL = defaultTTL;
  }

  get(
    scope: MemoryScope,
    semanticType: MemorySemanticType,
    inputFingerprint?: string,
    version?: SlotSnapshotVersion,
  ): SlotSnapshot | null {
    const key = generateCacheKey(scope, semanticType);
    const snapshot = this.cache.get(key);

    if (!snapshot) {
      return null;
    }

    if (inputFingerprint !== undefined && snapshot.inputFingerprint !== inputFingerprint) {
      return null;
    }
    if (version !== undefined &&
        (snapshot.version === undefined || !sameVersion(snapshot.version, version))) {
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
    ttl?: number,
    version?: SlotSnapshotVersion,
  ): SlotSnapshot {
    const snapshot: SlotSnapshot = {
      scope,
      semanticType,
      topNodes,
      ...(version === undefined ? {} : { version }),
      generatedAt: Date.now(),
      ttl: ttl ?? this.defaultTTL,
    };

    this.set(snapshot);
    return snapshot;
  }

  createFromRecallHits(
    scope: MemoryScope,
    semanticType: MemorySemanticType,
    topHits: RecallHit[],
    inputFingerprint: string,
    ttl?: number,
    version?: SlotSnapshotVersion,
  ): SlotSnapshot {
    const snapshot: SlotSnapshot = {
      scope,
      semanticType,
      topNodes: topHits.map((hit) => hit.record as MemoryRecord),
      topHits,
      inputFingerprint,
      ...(version === undefined ? {} : { version }),
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
      const prefix = generateScopePrefix(scope);
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  invalidateFingerprint(scopeFingerprint: string): void {
    if (!/^[0-9a-f]{64}$/.test(scopeFingerprint)) {
      throw new Error("Slot snapshot scope fingerprint is invalid");
    }
    const prefix = `${scopeFingerprint}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
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
