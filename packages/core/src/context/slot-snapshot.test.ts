/**
 * slot-snapshot.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  SlotSnapshotCache,
  RECOMMENDED_TTL,
  createSlotSnapshotVersion,
} from "./slot-snapshot.js";
import type { MemoryScope } from "../domain/semantic-types.js";
import type { MemoryRecord } from "../domain/types.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";

const mockScope: MemoryScope = {
  tenantId: "test-tenant",
  appId: "test-app",
  userId: "test-user",
  projectId: "test-project",
  agentId: "test-agent",
  namespace: "memories",
};

const mockRecord: Partial<MemoryRecord> = {
  id: "mem-1",
  kind: "goal",
  semanticType: "task_context",
  text: "Complete project by Q2",
  importance: 0.9,
};

describe("SlotSnapshotCache", () => {
  let cache: SlotSnapshotCache;

  beforeEach(() => {
    cache = new SlotSnapshotCache(5 * 60 * 1000);
  });

  it("should set and get snapshot", () => {
    const snapshot = cache.create(mockScope, "task_context", [mockRecord as MemoryRecord]);
    const retrieved = cache.get(mockScope, "task_context");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.topNodes).toHaveLength(1);
    expect(retrieved?.topNodes[0].id).toBe("mem-1");
  });

  it("should return null for non-existent key", () => {
    const result = cache.get(mockScope, "profile");
    expect(result).toBeNull();
  });

  it.each([
    ["workspaceId", { ...mockScope, workspaceId: "workspace-a", visibility: "private" as const }, { ...mockScope, workspaceId: "workspace-b", visibility: "private" as const }],
    ["sessionId", { ...mockScope, sessionId: "session-a", visibility: "private" as const }, { ...mockScope, sessionId: "session-b", visibility: "private" as const }],
    ["visibility", { ...mockScope, visibility: "private" as const }, { ...mockScope, visibility: "workspace" as const }],
  ])("should isolate snapshots across %s", (_dimension, sourceScope, otherScope) => {
    cache.create(sourceScope, "task_context", [mockRecord as MemoryRecord]);

    expect(cache.get(sourceScope, "task_context")?.topNodes[0]?.id).toBe("mem-1");
    expect(cache.get(otherScope, "task_context")).toBeNull();
  });

  it("should preserve legacy scopes without optional dimensions as private scope", () => {
    cache.create(mockScope, "task_context", [mockRecord as MemoryRecord]);

    expect(cache.get({ ...mockScope, visibility: "private" }, "task_context"))
      .not.toBeNull();
  });

  it("should fail closed for invalid visibility", () => {
    const invalidScope = {
      ...mockScope,
      visibility: "organization",
    } as unknown as MemoryScope;

    expect(() => cache.create(invalidScope, "task_context", [mockRecord as MemoryRecord]))
      .toThrow(/scope/i);
    expect(() => cache.get(invalidScope, "task_context")).toThrow(/scope/i);
    expect(() => cache.invalidate(invalidScope)).toThrow(/scope/i);
  });

  it("should invalidate specific slot", () => {
    cache.create(mockScope, "task_context", [mockRecord as MemoryRecord]);
    cache.create(mockScope, "profile", []);

    cache.invalidate(mockScope, "task_context");

    expect(cache.get(mockScope, "task_context")).toBeNull();
    expect(cache.get(mockScope, "profile")).not.toBeNull();
  });

  it("should invalidate only the exact authority scope", () => {
    const sessionA = {
      ...mockScope,
      sessionId: "session-a",
      visibility: "private" as const,
    };
    const sessionB = {
      ...mockScope,
      sessionId: "session-b",
      visibility: "private" as const,
    };
    cache.create(sessionA, "task_context", [mockRecord as MemoryRecord]);
    cache.create(sessionB, "task_context", [
      { ...mockRecord, id: "mem-session-b" } as MemoryRecord,
    ]);

    cache.invalidate(sessionA);

    expect(cache.get(sessionA, "task_context")).toBeNull();
    expect(cache.get(sessionB, "task_context")?.topNodes[0]?.id).toBe("mem-session-b");
  });

  it("should invalidate exact authority scope by durable fingerprint", () => {
    const sessionA = { ...mockScope, sessionId: "session-a" };
    const sessionB = { ...mockScope, sessionId: "session-b" };
    cache.create(sessionA, "rules", [mockRecord as MemoryRecord]);
    cache.create(sessionB, "rules", [{ ...mockRecord, id: "other" } as MemoryRecord]);

    cache.invalidateFingerprint(authorityScopeFingerprint({
      ...sessionA,
      visibility: "private",
    }));

    expect(cache.get(sessionA, "rules")).toBeNull();
    expect(cache.get(sessionB, "rules")?.topNodes[0]?.id).toBe("other");
    expect(() => cache.invalidateFingerprint("invalid")).toThrow(/fingerprint/i);
  });

  it("should return null for expired snapshot", () => {
    const shortTTL = 100;
    cache.create(mockScope, "task_context", [mockRecord as MemoryRecord], shortTTL);

    expect(cache.get(mockScope, "task_context")).not.toBeNull();

    vi.useFakeTimers();
    vi.advanceTimersByTime(200);

    expect(cache.get(mockScope, "task_context")).toBeNull();

    vi.useRealTimers();
  });

  it("should clean expired snapshots", () => {
    const shortTTL = 100;
    cache.create(mockScope, "task_context", [mockRecord as MemoryRecord], shortTTL);
    cache.create(mockScope, "profile", []);

    vi.useFakeTimers();
    vi.advanceTimersByTime(200);

    const cleaned = cache.cleanExpired();

    expect(cleaned).toBe(1);
    expect(cache.stats().size).toBe(1);

    vi.useRealTimers();
  });
});

describe("RECOMMENDED_TTL", () => {
  it("should have different TTLs for different types", () => {
    expect(RECOMMENDED_TTL.profile).toBe(30 * 60 * 1000);
    expect(RECOMMENDED_TTL.task_context).toBe(5 * 60 * 1000);
  });
});

describe("SlotSnapshotV2", () => {
  it("版本指纹同时绑定原生输入、Loadout、资产版本与策略版本", () => {
    const base = createSlotSnapshotVersion({
      inputFingerprint: "native-revision-1",
      retrievalVersion: "retrieval-v1",
      scoringVersion: "scoring-v1",
      promptPolicyVersion: "prompt-v1",
    });
    const withAssets = createSlotSnapshotVersion({
      inputFingerprint: "native-revision-1",
      loadoutVersion: 2,
      assetVersions: [
        { assetId: "asset-b", version: 3 },
        { assetId: "asset-a", version: 1 },
      ],
      retrievalVersion: "retrieval-v1",
      scoringVersion: "scoring-v1",
      promptPolicyVersion: "prompt-v1",
    });
    const reordered = createSlotSnapshotVersion({
      inputFingerprint: "native-revision-1",
      loadoutVersion: 2,
      assetVersions: [
        { assetId: "asset-a", version: 1 },
        { assetId: "asset-b", version: 3 },
      ],
      retrievalVersion: "retrieval-v1",
      scoringVersion: "scoring-v1",
      promptPolicyVersion: "prompt-v1",
    });

    expect(base.slotSnapshot).toBe(2);
    expect(base.assetVersionSetHash).toBeUndefined();
    expect(withAssets.assetVersionSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(withAssets.assetVersionSetHash).toBe(reordered.assetVersionSetHash);
    expect(withAssets.snapshotHash).toBe(reordered.snapshotHash);
    expect(withAssets.snapshotHash).not.toBe(base.snapshotHash);
  });

  it("缓存仅在请求版本与快照版本一致时命中", () => {
    const versionedCache = new SlotSnapshotCache();
    const version = createSlotSnapshotVersion({
      inputFingerprint: "native-revision-1",
      loadoutVersion: 1,
      assetVersions: [{ assetId: "asset-a", version: 1 }],
      retrievalVersion: "retrieval-v1",
      scoringVersion: "scoring-v1",
      promptPolicyVersion: "prompt-v1",
    });
    versionedCache.create(
      mockScope,
      "task_context",
      [mockRecord as MemoryRecord],
      undefined,
      version,
    );

    expect(versionedCache.get(mockScope, "task_context", undefined, version)?.version)
      .toEqual(version);
    expect(versionedCache.get(mockScope, "task_context", undefined, {
      ...version,
      loadoutVersion: 2,
    })).toBeNull();
  });
});
