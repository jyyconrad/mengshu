import { describe, expect, test, vi } from "vitest";

import { bufferId } from "../../tree/buffer.js";
import { PostgresProvider } from "./postgres.js";
import type {
  PostgresBuildTreeEffectRequest,
  PostgresExtractGraphEffectRequest,
} from "./postgres-job-v2-domain-effects.js";

const scope = Object.freeze({
  tenantId: "tenant",
  userId: "user",
  appId: "app",
  projectId: "project",
  agentId: "agent",
  namespace: "memory",
  visibility: "private" as const,
});
const fullScope = Object.freeze({ ...scope, workspaceId: "workspace", sessionId: "session" });

function treeRequest(): PostgresBuildTreeEffectRequest {
  return {
    effectKey: "build_tree.persist.v1",
    effectInput: {
      id: "job-tree",
      scope,
      owner: "worker-1",
      leaseToken: "t".repeat(32),
      leaseGeneration: 1,
    },
    semanticRequest: {
      type: "build_tree",
      version: 1,
      traceId: "trace-1",
      context: { workspaceId: "workspace", sessionId: "session" },
      treeType: "source",
      treeKey: "source-1",
      level: 0,
      policy: { maxLeafCount: 20, maxTokenCount: 6000 },
      leaf: {
        id: "trace-1",
        scope: fullScope,
        chunkId: "trace-1",
        sourceId: "source-1",
        entityIds: [],
        importance: 0.5,
        eventAt: 100,
        createdAt: 100,
        text: "evidence",
        tokenCount: 2,
      },
      expectedBufferId: bufferId(fullScope, "source", "source-1", 0),
    },
  };
}

function graphRequest(): PostgresExtractGraphEffectRequest {
  return {
    effectInput: {
      id: "job-graph",
      scope,
      owner: "worker-1",
      leaseToken: "g".repeat(32),
      leaseGeneration: 1,
    },
    context: { workspaceId: "workspace", sessionId: "session" },
    semanticRequest: { chunkId: "chunk-1", text: "Project uses PostgreSQL" },
    entities: [{
      id: "entity-1",
      scope: fullScope,
      canonicalName: "postgresql",
      displayName: "PostgreSQL",
      type: "tool",
      aliases: ["PostgreSQL"],
      mentionCount: 1,
      mentionCount30d: 1,
      distinctSourceCount: 1,
      lastSeenAt: 100,
      hotness: 0.5,
      graphCentrality: 0,
      queryHits30d: 0,
      status: "active",
      createdAt: 100,
      updatedAt: 100,
      metadata: {},
    }],
    relations: [],
  };
}

function providerHarness() {
  const calls: Array<{ readonly sql: string; readonly params: readonly unknown[] }> = [];
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      const normalized = sql.trim().replace(/\s+/g, " ");
      calls.push({ sql: normalized, params });
      if (normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (/^SELECT id FROM mengshu_jobs_v2/.test(normalized)) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/^SELECT job_id, effect_key/.test(normalized)) {
        return { rows: [], rowCount: 0 };
      }
      if (/^INSERT INTO mengshu_job_v2_effect_receipts/.test(normalized)) {
        return {
          rows: [{
            job_id: params[0],
            effect_key: params[1],
            request_fingerprint: params[2],
            lease_generation: params[3],
            result: JSON.parse(String(params[4])),
            committed_at: params[5],
          }],
          rowCount: 1,
        };
      }
      if (/^SELECT id, leaf_ids/.test(normalized)) {
        return {
          rows: [{
            id: bufferId(fullScope, "source", "source-1", 0),
            leaf_ids: [],
            child_node_ids: [],
            token_count: 0,
            opened_at: 100,
            updated_at: 100,
          }],
          rowCount: 1,
        };
      }
      if (/^INSERT INTO mengshu_graph_entities/.test(normalized)) {
        return { rows: [{ id: params[0] }], rowCount: 1 };
      }
      if (/^(?:INSERT|UPDATE|DELETE) (?:INTO )?mengshu_tree_/.test(normalized)) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${normalized}`);
    }),
  };
  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(),
    end: vi.fn(async () => undefined),
  };
  const provider = new PostgresProvider({
    host: "unused",
    port: 5432,
    database: "unused",
    user: "unused",
    password: "unused",
  }, "text-embedding-3-small");
  Object.assign(provider as unknown as Record<string, unknown>, {
    pool,
    schemaVersion: 9,
    schemaContractState: "ready",
  });
  const bundle = provider.createDurableJobV2RuntimeBundle({
    clock: () => 200,
    effectClock: () => 200,
    tokenFactory: () => "x".repeat(32),
    backoffMs: () => 100,
  });
  return { provider, bundle, pool, client, calls };
}

describe("PostgresProvider tree/graph durable effects", () => {
  test("build_tree 通过 provider-owned runner 在 fence/receipt 同一事务持久化", async () => {
    const h = providerHarness();
    const result = await h.bundle.executeBuildTreeEffect(treeRequest(), new AbortController().signal);

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "build_tree.persist.v1",
        result: {
          leafId: "trace-1",
          sealed: false,
          bufferId: bufferId(fullScope, "source", "source-1", 0),
          nodeId: null,
        },
      },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^INSERT INTO mengshu_tree_leaves/),
      expect.stringMatching(/^UPDATE mengshu_tree_leaves/),
      expect.stringMatching(/^INSERT INTO mengshu_tree_buffers/),
      expect.stringMatching(/^SELECT id, leaf_ids/),
      expect.stringMatching(/^UPDATE mengshu_tree_buffers/),
      expect.stringMatching(/^INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("extract_graph 在 transaction 外完成输入快照并原子写 entity+receipt", async () => {
    const h = providerHarness();
    const result = await h.bundle.executeGraphEffect(graphRequest());

    expect(result).toMatchObject({
      status: "applied",
      receipt: {
        effectKey: "extract_graph.persist.v1",
        result: {
          createdEntities: 1,
          createdRelations: 0,
          entityIds: ["entity-1"],
          relationIds: [],
        },
      },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/^SELECT id FROM mengshu_jobs_v2/),
      expect.stringMatching(/^SELECT job_id, effect_key/),
      expect.stringMatching(/^INSERT INTO mengshu_graph_entities/),
      expect.stringMatching(/^INSERT INTO mengshu_job_v2_effect_receipts/),
      "COMMIT",
    ]);
  });

  test("build_tree pre-abort 不连接数据库", async () => {
    const h = providerHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(h.bundle.executeBuildTreeEffect(treeRequest(), controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(h.pool.connect).not.toHaveBeenCalled();
  });
});
