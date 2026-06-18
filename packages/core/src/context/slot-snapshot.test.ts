/**
 * slot-snapshot.test.ts
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { SlotSnapshotCache, RECOMMENDED_TTL } from "./slot-snapshot.js";
import type { MemoryScope } from "../domain/semantic-types.js";
import type { MemoryRecord } from "../domain/types.js";

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

  it("should invalidate specific slot", () => {
    cache.create(mockScope, "task_context", [mockRecord as MemoryRecord]);
    cache.create(mockScope, "profile", []);

    cache.invalidate(mockScope, "task_context");

    expect(cache.get(mockScope, "task_context")).toBeNull();
    expect(cache.get(mockScope, "profile")).not.toBeNull();
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
