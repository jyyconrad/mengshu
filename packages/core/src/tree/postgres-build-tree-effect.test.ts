import { describe, expect, test, vi } from "vitest";

import type { NativeBuildTreeEffectRequest } from "../../../../server/native-build-tree-handler.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { bufferId } from "./buffer.js";
import {
  executePostgresBuildTreeDomainEffect,
  type PostgresBuildTreeEffectQueryClient,
  type PostgresBuildTreeEffectRequest,
} from "./postgres-build-tree-effect.js";

const nativeRequestIsStructurallyCompatible:
  NativeBuildTreeEffectRequest extends PostgresBuildTreeEffectRequest ? true : false = true;
void nativeRequestIsStructurallyCompatible;

const scope = Object.freeze({
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "app-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "working-context",
  visibility: "private" as const,
});

const fullScope = Object.freeze({
  ...scope,
  workspaceId: "workspace-1",
  sessionId: "session-1",
});

function request(overrides: Partial<PostgresBuildTreeEffectRequest> = {}): PostgresBuildTreeEffectRequest {
  const semanticRequest = Object.freeze({
    type: "build_tree" as const,
    version: 1 as const,
    traceId: "trace-20",
    context: Object.freeze({ workspaceId: "workspace-1", sessionId: "session-1" }),
    treeType: "source" as const,
    treeKey: "source-key",
    level: 0 as const,
    policy: Object.freeze({ maxLeafCount: 20 as const, maxTokenCount: 6000 as const }),
    leaf: Object.freeze({
      id: "trace-20",
      scope: fullScope,
      chunkId: "trace-20",
      sourceId: "source-1",
      entityIds: Object.freeze(["entity-2", "entity-1"]),
      importance: 0.75,
      eventAt: 2_000,
      createdAt: 2_000,
      text: "new leaf",
      tokenCount: 2,
    }),
    expectedBufferId: bufferId(fullScope, "source", "source-key", 0),
  });
  return {
    effectKey: "build_tree.persist.v1",
    effectInput: Object.freeze({
      id: "job-1",
      scope,
      owner: "worker-1",
      leaseToken: "t".repeat(32),
      leaseGeneration: 1,
    }),
    semanticRequest,
    ...overrides,
  };
}

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function bufferRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: bufferId(fullScope, "source", "source-key", 0),
    leaf_ids: [],
    child_node_ids: [],
    token_count: "0",
    opened_at: "2000",
    updated_at: "2000",
    ...overrides,
  };
}

function leafRow(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `leaf-${String(index).padStart(2, "0")}`,
    chunk_id: `chunk-${index}`,
    source_id: "source-1",
    entity_ids: [`entity-${index % 3}`],
    importance: index % 2 === 0 ? 0.8 : 0.6,
    event_at: String(1_000 + index),
    created_at: String(1_000 + index),
    text: `leaf text ${index}`,
    token_count: "1",
    ...overrides,
  };
}

function scriptedClient(
  responses: Array<{ rows: readonly Record<string, unknown>[]; rowCount?: number | null }>,
): { readonly client: PostgresBuildTreeEffectQueryClient; readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const response = responses.shift();
    if (!response) throw new Error("unexpected query");
    return response;
  });
  return { client: { query } as PostgresBuildTreeEffectQueryClient, calls };
}

describe("executePostgresBuildTreeDomainEffect", () => {
  test("固定 canonical 表中 upsert leaf、锁定并合并 L0 buffer", async () => {
    const { client, calls } = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [bufferRow()], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await expect(executePostgresBuildTreeDomainEffect(client, request())).resolves.toEqual({
      leafId: "trace-20",
      sealed: false,
      bufferId: bufferId(fullScope, "source", "source-key", 0),
      nodeId: null,
    });

    expect(calls.map(({ sql }) => sql.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "INSERT INTO mengshu_tree_leaves",
      "UPDATE mengshu_tree_leaves SET",
      "INSERT INTO mengshu_tree_buffers",
      "SELECT id, leaf_ids,",
      "UPDATE mengshu_tree_buffers SET",
    ]);
    expect(calls[0]!.params[0]).toBe(authorityScopeFingerprint(fullScope));
    expect(calls[0]!.sql).toContain("source_job_id");
    expect(calls[0]!.params).toContain("job-1");
    expect(calls[2]!.sql).toContain(
      "ON CONFLICT (scope_fingerprint, tree_type, tree_key, level) DO NOTHING",
    );
    expect(calls[3]!.sql).toContain("FOR UPDATE");
    expect(calls[3]!.params).toEqual([
      authorityScopeFingerprint(fullScope),
      "tenant-1", "user-1", "app-1", "project-1", "agent-1", "working-context",
      "private", "workspace-1", "session-1", "source", "source-key", 0,
    ]);
    expect(calls[4]!.params.slice(10, 14)).toEqual([
      bufferId(fullScope, "source", "source-key", 0),
      "source",
      "source-key",
      0,
    ]);
    expect(calls[4]!.params.slice(14, 17)).toEqual([
      JSON.stringify(["trace-20"]),
      JSON.stringify([]),
      2,
    ]);
  });

  test("重复 leaf 不重复累计 token，且输入在首个 await 前完成深快照", async () => {
    const raw = request() as PostgresBuildTreeEffectRequest & {
      semanticRequest: PostgresBuildTreeEffectRequest["semanticRequest"] & {
        leaf: { text: string; scope: { workspaceId?: string } };
      };
    };
    const mutable = structuredClone(raw) as typeof raw;
    const existing = bufferRow({ leaf_ids: ["trace-20"], token_count: "33", opened_at: "1000" });
    const calls: QueryCall[] = [];
    let step = 0;
    const client: PostgresBuildTreeEffectQueryClient = {
      query: vi.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        if (step++ === 0) {
          mutable.semanticRequest.leaf.text = "mutated after snapshot";
          mutable.semanticRequest.leaf.scope.workspaceId = "other-workspace";
          return { rows: [], rowCount: 1 };
        }
        if (step === 2) return { rows: [], rowCount: 1 };
        if (step === 3) return { rows: [], rowCount: 0 };
        if (step === 4) return { rows: [existing], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }) as PostgresBuildTreeEffectQueryClient["query"],
    };

    await expect(executePostgresBuildTreeDomainEffect(client, mutable)).resolves.toMatchObject({
      sealed: false,
    });
    expect(calls[0]!.params).toContain("new leaf");
    expect(calls[4]!.params[16]).toBe(33);
    expect(calls[4]!.params).toContain("workspace-1");
  });

  test("第 20 个 leaf 在同一事务生成 deterministic L1 extractive summary 并删除 buffer", async () => {
    const priorLeafIds = Array.from({ length: 19 }, (_, index) => `leaf-${String(index + 1).padStart(2, "0")}`);
    const leaves = priorLeafIds.map((_, index) => leafRow(index + 1));
    leaves.push(leafRow(20, {
      id: "trace-20",
      chunk_id: "trace-20",
      entity_ids: ["entity-2", "entity-1"],
      importance: 0.75,
      event_at: "2000",
      created_at: "2000",
      text: "new leaf",
      token_count: "2",
    }));
    const { client, calls } = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19", opened_at: "1000" })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: leaves.reverse(), rowCount: 20 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    const first = await executePostgresBuildTreeDomainEffect(client, request());
    expect(first).toEqual({
      leafId: "trace-20",
      sealed: true,
      bufferId: null,
      nodeId: expect.stringMatching(/^sum_[0-9a-f]{24}$/),
    });

    expect(calls[5]!.sql).toContain("FROM mengshu_tree_leaves");
    expect(calls[5]!.sql).toContain("id = ANY($11::text[])");
    expect(calls[6]!.sql).toContain("INSERT INTO mengshu_tree_summary_nodes");
    expect(calls[6]!.sql).toContain("sealed_by_job_id");
    expect(calls[6]!.params[10]).toBe(first.nodeId);
    expect(calls[6]!.params[14]).toBe(1);
    expect(calls[6]!.params[16]).toBe(
      ["leaf text 18", "leaf text 16", "leaf text 14", "leaf text 12", "leaf text 10"].join("\n\n"),
    );
    expect(calls[6]!.params).toContain("job-1");
    expect(calls[7]!.sql).toContain("DELETE FROM mengshu_tree_buffers");

    const secondClient = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19", opened_at: "1000" })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: leaves.slice().reverse(), rowCount: 20 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);
    const second = await executePostgresBuildTreeDomainEffect(secondClient.client, request());
    expect(second.nodeId).toBe(first.nodeId);
    expect(secondClient.calls[6]!.params[16]).toBe(calls[6]!.params[16]);
  });

  test("token 达到 6000 时 seal，未达到 20 leaves 也生成 node", async () => {
    const priorLeafIds = ["leaf-01"];
    const current = request();
    const semanticRequest = {
      ...current.semanticRequest,
      leaf: { ...current.semanticRequest.leaf, text: "x".repeat(4), tokenCount: 1 },
    };
    const { client } = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "5999" })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [leafRow(1), leafRow(2, {
        id: "trace-20", chunk_id: "trace-20", text: "xxxx", token_count: "1",
        event_at: "2000", created_at: "2000",
      })], rowCount: 2 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await expect(executePostgresBuildTreeDomainEffect(client, {
      ...current,
      semanticRequest,
    })).resolves.toMatchObject({ sealed: true, bufferId: null });
  });

  test.each([
    ["wrong effect key", () => ({ ...request(), effectKey: "wrong" })],
    ["effect scope mismatch", () => ({
      ...request(),
      effectInput: { ...request().effectInput, scope: { ...scope, tenantId: "tenant-2" } },
    })],
    ["context mismatch", () => ({
      ...request(),
      semanticRequest: {
        ...request().semanticRequest,
        context: { workspaceId: "workspace-2", sessionId: "session-1" },
      },
    })],
    ["buffer id mismatch", () => ({
      ...request(),
      semanticRequest: { ...request().semanticRequest, expectedBufferId: "buf_wrong" },
    })],
    ["wrong fixed policy", () => ({
      ...request(),
      semanticRequest: {
        ...request().semanticRequest,
        policy: { maxLeafCount: 19, maxTokenCount: 6000 },
      },
    })],
    ["proxy", () => new Proxy(request(), {})],
  ])("严格拒绝 %s", async (_label, factory) => {
    const client = { query: vi.fn() } as PostgresBuildTreeEffectQueryClient;
    await expect(executePostgresBuildTreeDomainEffect(
      client,
      factory() as PostgresBuildTreeEffectRequest,
    )).rejects.toThrow("Postgres build_tree effect input is invalid");
    expect(client.query).not.toHaveBeenCalled();
  });

  test("锁定结果、leaf 完整性或 DML rowCount 异常时 fail closed", async () => {
    const missingBuffer = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    await expect(executePostgresBuildTreeDomainEffect(missingBuffer.client, request()))
      .rejects.toThrow("Postgres build_tree query result is invalid");

    const priorLeafIds = Array.from({ length: 19 }, (_, index) => `leaf-${String(index + 1).padStart(2, "0")}`);
    const missingLeaf = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19" })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: priorLeafIds.slice(0, 18).map((_, index) => leafRow(index + 1)), rowCount: 18 },
    ]);
    await expect(executePostgresBuildTreeDomainEffect(missingLeaf.client, request()))
      .rejects.toThrow("Postgres build_tree query result is invalid");

    const badUpdate = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    await expect(executePostgresBuildTreeDomainEffect(badUpdate.client, request()))
      .rejects.toThrow("Postgres build_tree query result is invalid");
  });

  test("treeKey 只作为参数，不进入固定 SQL", async () => {
    const current = request();
    const unsafeLookingKey = "key-with-$1";
    const semanticRequest = {
      ...current.semanticRequest,
      treeKey: unsafeLookingKey,
      expectedBufferId: bufferId(fullScope, "source", unsafeLookingKey, 0),
    };
    const expected = bufferRow({ id: semanticRequest.expectedBufferId });
    const { client, calls } = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [expected], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await executePostgresBuildTreeDomainEffect(client, { ...current, semanticRequest });
    expect(calls.every(({ sql }) => !sql.includes(unsafeLookingKey))).toBe(true);
    expect(calls.some(({ params }) => params.includes(unsafeLookingKey))).toBe(true);
  });
});
