import { createHash } from "node:crypto";

import { describe, expect, test, vi } from "vitest";

import type { WorkMemoryGraphBatch } from
  "../packages/core/src/graph/work-memory-types.js";
import {
  HistoryWorkMemoryProjectionError,
  normalizeHistoryWorkMemoryProjectionClient,
  runHistoryWorkMemoryProjectionOperator,
  type HistoryWorkMemoryProjectionDependencies,
  type HistoryWorkMemoryProjectionQueryClient,
} from "./operator-history-work-memory-projection.js";

const scope = Object.freeze({
  tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
  agentId: "agent", namespace: "memory", visibility: "private" as const,
});

const batch: WorkMemoryGraphBatch = Object.freeze({
  scope,
  nodes: Object.freeze([{
    id: "evidence:evidence-1", scope, nodeType: "evidence" as const,
    recordId: "evidence-1", evidenceKind: "observation" as const,
    label: "evidence", metadata: Object.freeze({}), createdAt: 1,
  }, {
    id: "memory:memory-1", scope, nodeType: "memory" as const,
    recordId: "memory-1", semanticType: "experience" as const,
    lifecycleStatus: "active" as const, evidenceChunkIds: ["evidence-1"],
    label: "memory", metadata: Object.freeze({ kind: "observation" }), createdAt: 1,
  }]),
  edges: Object.freeze([{
    id: "grounded-by:edge-1", scope, edgeType: "memory_relation" as const,
    predicate: "grounded_by" as const, sourceId: "memory:memory-1",
    targetId: "evidence:evidence-1", confidence: 1,
    evidenceChunkIds: ["evidence-1"], metadata: Object.freeze({}), createdAt: 1,
  }]),
});

test("projection client 将 raw pg envelope 归一化后再交给严格 repository", async () => {
  const raw = {
    query: vi.fn(async () => ({
      rows: [{ id: "node-a" }],
      rowCount: 1,
      command: "SELECT",
      fields: [{ name: "id" }],
    })),
  } as unknown as HistoryWorkMemoryProjectionQueryClient;

  await expect(normalizeHistoryWorkMemoryProjectionClient(raw).query("SELECT 1"))
    .resolves.toEqual({ rows: [{ id: "node-a" }], rowCount: 1 });
});

function manifestText(): string {
  return `${JSON.stringify({
    version: 1,
    migrationId: "history-rebuild-test",
    requiredSchemaVersion: 24,
    source: { sourceCount: 1, snapshotSha256: "1".repeat(64), parserVersions: ["postgres-history-v24"] },
    funnel: { mappingVersion: "kind-to-semantic-type/v1", conflictPolicy: "lookup_only", lifecyclePolicy: "preserve" },
    models: {
      extraction: { provider: "openai-compatible", baseURL: "https://example.test/v1", model: "model", promptPolicyVersion: "history-extract-v1", temperature: 0 },
      embedding: { provider: "openai-compatible", baseURL: "https://example.test/v1", model: "embedding", dimensions: 1024, normalization: "l2" },
    },
    budget: { maxRecords: 10, maxModelCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostMinorUnits: 0, currency: "USD", pricingSnapshotVersion: "test", inputCostPerMillionTokens: 0, outputCostPerMillionTokens: 0 },
    security: { remoteEgress: "deny", redactionMapVersion: "2026.06.19-2", logContent: "hash-only", receiptContent: "hash-only" },
    tree: { policyVersion: "history-tree-routing/v2", topicLabelVersion: "scope-topic-taxonomy/v1", policyBundleSha256: "2".repeat(64), requireEvidence: true, requireSealed: true, ambiguousPolicy: "quarantine" },
  }, null, 2)}\n`;
}

function dependencies(): HistoryWorkMemoryProjectionDependencies & {
  readonly calls: string[];
  readonly upsertBatch: ReturnType<typeof vi.fn>;
  readonly verifyBatches: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql.trim());
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }], rowCount: 1 };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ released: true }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const close = vi.fn(async () => undefined);
  const upsertBatch = vi.fn(async () => undefined);
  const verifyBatches = vi.fn(async () => ({ nodes: 2, edges: 1, scopes: 1 }));
  return {
    calls,
    readText: (path) => path === "manifest.json" ? manifestText() : "{}",
    parseConfig: () => ({ dbType: "postgres", postgres: {} }),
    connect: async () => ({
      client: { query: query as unknown as HistoryWorkMemoryProjectionQueryClient["query"] },
      close,
    }),
    assertSchemaVersion: vi.fn(async () => undefined),
    loadBatches: vi.fn(async () => ({
      batches: [batch], activeMemories: 1, evidenceNodes: 1, summaries: 0,
    })),
    upsertBatch,
    verifyBatches,
    writeReport: vi.fn(),
    close,
  };
}

describe("history Work Memory projection operator", () => {
  test("plan 在只读事务中生成守恒清单，零写入零模型", async () => {
    const deps = dependencies();
    const result = await runHistoryWorkMemoryProjectionOperator([
      "--config", "config.json", "--manifest", "manifest.json", "--plan",
    ], deps);

    expect(result).toMatchObject({
      operation: "plan", writes: 0, modelCalls: 0,
      activeMemories: 1, evidenceNodes: 1, summaries: 0, nodes: 2, edges: 1, scopes: 1,
    });
    expect(deps.upsertBatch).not.toHaveBeenCalled();
    expect(deps.verifyBatches).not.toHaveBeenCalled();
    expect(deps.calls).toEqual([
      expect.stringContaining("pg_try_advisory_lock"),
      "BEGIN READ ONLY",
      "ROLLBACK",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
    expect(deps.close).toHaveBeenCalledOnce();
  });

  test("apply 缺 maintenance、manifest hash 或精确令牌时连接前拒绝", async () => {
    const deps = dependencies();
    await expect(runHistoryWorkMemoryProjectionOperator([
      "--config", "config.json", "--manifest", "manifest.json", "--apply",
    ], deps)).rejects.toBeInstanceOf(HistoryWorkMemoryProjectionError);
    expect(deps.calls).toEqual([]);
    expect(deps.upsertBatch).not.toHaveBeenCalled();
  });

  test("apply 仅投影已绑定 batch，事务内 strict verify 后提交", async () => {
    const deps = dependencies();
    const sha = createHash("sha256").update(manifestText()).digest("hex");
    const result = await runHistoryWorkMemoryProjectionOperator([
      "--config", "config.json", "--manifest", "manifest.json", "--apply",
      "--maintenance", "--quiescence-confirmed", "--manifest-sha256", sha,
      "--confirmation-token", "APPLY_WORK_MEMORY_PROJECTION:history-rebuild-test",
    ], deps);

    expect(result).toMatchObject({
      operation: "apply", modelCalls: 0, projectedBatches: 1,
      nodes: 2, edges: 1, scopes: 1,
    });
    expect(deps.upsertBatch).toHaveBeenCalledOnce();
    expect(deps.verifyBatches).toHaveBeenCalledOnce();
    expect(deps.calls).toEqual([
      expect.stringContaining("pg_try_advisory_lock"),
      "BEGIN ISOLATION LEVEL SERIALIZABLE",
      "COMMIT",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
  });

  test("verify 只读校验现存投影，不调用 upsert", async () => {
    const deps = dependencies();
    const result = await runHistoryWorkMemoryProjectionOperator([
      "--config", "config.json", "--manifest", "manifest.json", "--verify",
    ], deps);

    expect(result).toMatchObject({ operation: "verify", writes: 0, modelCalls: 0 });
    expect(deps.upsertBatch).not.toHaveBeenCalled();
    expect(deps.verifyBatches).toHaveBeenCalledOnce();
    expect(deps.calls).toContain("BEGIN READ ONLY");
    expect(deps.calls).toContain("ROLLBACK");
  });
});
