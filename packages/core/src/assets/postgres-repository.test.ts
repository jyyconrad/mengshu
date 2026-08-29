import { describe, expect, test, vi } from "vitest";

import { PostgresMemoryViewAssetRepository } from "./postgres-repository.js";
import { MemoryViewAssetError } from "./content-ref.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryViewAssetDescriptor, MemoryViewPromotionReceipt } from "./types.js";

const scope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
  agentId: "agent-a", namespace: "memory", visibility: "private" as const,
};
const descriptor: MemoryViewAssetDescriptor = {
  id: "asset-1",
  kind: "memory_view",
  owner: { subjectType: "user", subjectId: scope.userId },
  title: "Rules",
  semanticTypes: ["rules"],
  sourceScope: scope,
  version: 1,
  status: "published",
  visibility: "private",
  contentRef: {
    type: "memory_projection",
    recordIds: ["memory-1"],
    treeNodeIds: [],
    evidenceIds: ["evidence-1"],
    semanticTypes: ["rules"],
    resolutionHash: "a".repeat(64),
  },
  provenanceRefs: ["memory-1"],
  evidenceRefs: ["evidence-1"],
  riskFlags: [],
  qualitySnapshot: { scoringVersion: "recall-v1", importance: 0.9 },
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};
const receipt: MemoryViewPromotionReceipt = {
  id: "receipt-1",
  requestKey: "request-1",
  requestHash: "b".repeat(64),
  assetId: descriptor.id,
  assetVersion: descriptor.version,
  scopeFingerprint: authorityScopeFingerprint(scope),
  targetStatus: "published",
  decisions: ["private_scope", "content_ref_valid"],
  createdAt: descriptor.createdAt,
};

function repository(options: {
  latest?: number;
  existingReceipt?: MemoryViewPromotionReceipt;
  existingDescriptor?: MemoryViewAssetDescriptor;
  zeroWrite?: "version" | "head" | "receipt" | "audit" | "outbox";
} = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes("asset-repository:receipt-lock")) {
        return options.existingReceipt
          ? { rows: [{
              receipt: options.existingReceipt,
              receipt_id: options.existingReceipt.id,
              scope_fingerprint: options.existingReceipt.scopeFingerprint,
              request_key: options.existingReceipt.requestKey,
              request_hash: options.existingReceipt.requestHash,
              asset_id: options.existingReceipt.assetId,
              asset_version: options.existingReceipt.assetVersion,
              descriptor: options.existingDescriptor ?? descriptor,
              version_kind: (options.existingDescriptor ?? descriptor).kind,
              version_status: (options.existingDescriptor ?? descriptor).status,
              version_visibility: (options.existingDescriptor ?? descriptor).visibility,
              version_owner_user_id: (options.existingDescriptor ?? descriptor).owner.subjectId,
            }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes("asset-repository:head-lock")) {
        return options.latest === undefined
          ? { rows: [], rowCount: 0 }
          : { rows: [{ latest_version: options.latest }], rowCount: 1 };
      }
      const writes = {
        "asset-repository:insert-version": ["version", descriptor.version],
        "asset-repository:upsert-head": ["latest_version", descriptor.version],
        "asset-repository:insert-receipt": ["receipt_id", receipt.id],
        "asset-repository:insert-audit": ["audit_id", "1"],
        "asset-repository:insert-outbox": ["event_id", expect.any(String)],
      } as const;
      for (const [marker, [key, value]] of Object.entries(writes)) {
        if (!sql.includes(marker)) continue;
        const stage = marker.slice("asset-repository:insert-".length);
        if (options.zeroWrite === stage ||
            (marker.includes("upsert-head") && options.zeroWrite === "head")) {
          return { rows: [], rowCount: 0 };
        }
        const actual = key === "event_id" ? params[0] : value;
        return { rows: [{ [key]: actual }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client), query: client.query };
  return { calls, client, repo: new PostgresMemoryViewAssetRepository(pool) };
}

describe("PostgresMemoryViewAssetRepository", () => {
  test("legacy reads filter memory_view before governed document kinds are enabled", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [], rowCount: 0,
    }));
    const repo = new PostgresMemoryViewAssetRepository({ query, connect: vi.fn() as never });

    await repo.listLatest(scope);
    await repo.getLatest(scope, "asset-1");
    await repo.getVersion(scope, "asset-1", 1);

    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql] of query.mock.calls) {
      expect(sql).toMatch(/kind\s*=\s*'memory_view'/);
    }
  });

  test("appends immutable version/head/receipt/audit/outbox in one transaction", async () => {
    const fake = repository();
    await expect(fake.repo.appendVersion({
      asset: descriptor,
      receipt,
      expectedLatestVersion: 0,
    })).resolves.toEqual({ asset: descriptor, receipt, replayed: false });
    expect(fake.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("asset-repository:receipt-lock"),
      expect.stringContaining("asset-repository:head-lock"),
      expect.stringContaining("asset-repository:insert-version"),
      expect.stringContaining("asset-repository:upsert-head"),
      expect.stringContaining("asset-repository:insert-receipt"),
      expect.stringContaining("asset-repository:insert-audit"),
      expect.stringContaining("asset-repository:insert-outbox"),
      "COMMIT",
    ]);
    expect(fake.client.release).toHaveBeenCalledOnce();
  });

  test("replays the same receipt without creating another version", async () => {
    const fake = repository({ existingReceipt: receipt });
    await expect(fake.repo.appendVersion({
      asset: descriptor,
      receipt,
      expectedLatestVersion: 0,
    })).resolves.toEqual({ asset: descriptor, receipt, replayed: true });
    expect(fake.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("asset-repository:receipt-lock"),
      "COMMIT",
    ]);
  });

  test("concurrent same-key replay returns the persisted version despite generated timestamps", async () => {
    const persistedReceipt = { ...receipt, id: "persisted-receipt", createdAt: "2026-08-13T00:00:00.000Z" };
    const persistedDescriptor = {
      ...descriptor,
      createdAt: "2026-08-13T00:00:00.000Z",
      updatedAt: "2026-08-13T00:00:00.000Z",
    };
    const concurrentDescriptor = {
      ...descriptor,
      createdAt: "2026-08-13T00:00:01.000Z",
      updatedAt: "2026-08-13T00:00:01.000Z",
    };
    const concurrentReceipt = {
      ...receipt,
      id: "concurrent-receipt",
      createdAt: "2026-08-13T00:00:01.000Z",
    };
    const fake = repository({ existingReceipt: persistedReceipt, existingDescriptor: persistedDescriptor });

    await expect(fake.repo.appendVersion({
      asset: concurrentDescriptor,
      receipt: concurrentReceipt,
      expectedLatestVersion: 0,
    })).resolves.toEqual({
      asset: persistedDescriptor,
      receipt: persistedReceipt,
      replayed: true,
    });
  });

  test("rejects an idempotency replay whose persisted descriptor differs", async () => {
    const fake = repository({
      existingReceipt: receipt,
      existingDescriptor: { ...descriptor, title: "Different rules" },
    });
    await expect(fake.repo.appendVersion({ asset: descriptor, receipt, expectedLatestVersion: 0 }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("rejects head CAS drift and rolls back", async () => {
    const fake = repository({ latest: 2 });
    await expect(fake.repo.appendVersion({ asset: descriptor, receipt, expectedLatestVersion: 0 }))
      .rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("getLatest validates descriptor and exact scope fingerprint", async () => {
    const relational = {
      scope_fingerprint: authorityScopeFingerprint(scope),
      asset_id: descriptor.id,
      latest_version: descriptor.version,
      version: descriptor.version,
      kind: descriptor.kind,
      status: descriptor.status,
      visibility: descriptor.visibility,
      owner_user_id: descriptor.owner.subjectId,
      descriptor,
    };
    const query = vi.fn(async () => ({ rows: [relational], rowCount: 1 }));
    const repo = new PostgresMemoryViewAssetRepository({ query, connect: vi.fn() as never });
    await expect(repo.getLatest(scope, descriptor.id)).resolves.toEqual(descriptor);
    const corrupted = new PostgresMemoryViewAssetRepository({
      query: async () => ({
        rows: [{ ...relational, descriptor: { ...descriptor, visibility: "team" } }], rowCount: 1,
      }),
      connect: vi.fn() as never,
    });
    await expect(corrupted.getLatest(scope, descriptor.id))
      .rejects.toBeInstanceOf(MemoryViewAssetError);
  });

  test("rejects a self-consistent descriptor that disagrees with relational columns or head", async () => {
    const repo = new PostgresMemoryViewAssetRepository({
      query: async () => ({
        rows: [{
          scope_fingerprint: authorityScopeFingerprint(scope),
          asset_id: descriptor.id,
          latest_version: 2,
          version: descriptor.version,
          kind: descriptor.kind,
          status: "draft",
          visibility: descriptor.visibility,
          owner_user_id: descriptor.owner.subjectId,
          descriptor,
        }],
        rowCount: 1,
      }),
      connect: vi.fn() as never,
    });
    await expect(repo.getLatest(scope, descriptor.id))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test.each(["version", "head", "receipt", "audit", "outbox"] as const)(
    "rolls back when the %s write does not return exactly one row",
    async (zeroWrite) => {
      const fake = repository({ zeroWrite });
      await expect(fake.repo.appendVersion({ asset: descriptor, receipt, expectedLatestVersion: 0 }))
        .rejects.toMatchObject({ code: zeroWrite === "head" ? "VERSION_CONFLICT" : "INVALID_INPUT" });
      expect(fake.calls.at(-1)?.sql).toBe("ROLLBACK");
    },
  );
});
