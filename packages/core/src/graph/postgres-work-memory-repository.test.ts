import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  PostgresWorkMemoryGraphRepository,
  upsertPostgresWorkMemoryGraphInTransaction,
  type PostgresWorkMemoryPool,
  type PostgresWorkMemoryQueryClient,
  type PostgresWorkMemoryQueryResult,
} from "./postgres-work-memory-repository.js";
import type {
  EvidenceGraphNode,
  MemoryNode,
  SummaryGraphNode,
  WorkMemoryEdge,
} from "./work-memory-types.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

const now = 100;

function evidence(): EvidenceGraphNode {
  return {
    id: "evidence:chunk-1",
    scope,
    nodeType: "evidence",
    recordId: "chunk-1",
    evidenceKind: "chunk",
    label: "chunk-1",
    metadata: {},
    createdAt: now,
  };
}

function memory(): MemoryNode {
  return {
    id: "memory:mem-1",
    scope,
    nodeType: "memory",
    recordId: "mem-1",
    semanticType: "experience",
    lifecycleStatus: "active",
    evidenceChunkIds: ["chunk-1"],
    label: "memory",
    metadata: {},
    createdAt: now,
  };
}

function grounded(): WorkMemoryEdge {
  return {
    id: "edge-1",
    scope,
    edgeType: "memory_relation",
    predicate: "grounded_by",
    sourceId: "memory:mem-1",
    targetId: "evidence:chunk-1",
    confidence: 1,
    evidenceChunkIds: ["chunk-1"],
    metadata: {},
    createdAt: now,
  };
}

function summaryNode(): SummaryGraphNode {
  return {
    id: "summary:sum-1",
    scope,
    nodeType: "summary",
    recordId: "sum-1",
    label: "canonical summary",
    treeType: "source",
    level: 1,
    evidenceChunkIds: ["chunk-1"],
    metadata: { treeKey: "source-1", sealedAt: now },
    createdAt: now,
  };
}

function result(rows: readonly Record<string, unknown>[]): PostgresWorkMemoryQueryResult {
  return { rows, rowCount: rows.length };
}

function scriptedClient(responses: readonly (PostgresWorkMemoryQueryResult | Error)[]) {
  const queue = [...responses];
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected query");
    if (next instanceof Error) throw next;
    return next;
  });
  const release = vi.fn();
  const typedQuery = query as unknown as PostgresWorkMemoryQueryClient["query"];
  const client = { query: typedQuery, release };
  const pool: PostgresWorkMemoryPool = {
    query: typedQuery,
    connect: async () => client,
  };
  return { client: pool, query, release, queue };
}

const id = (value: string) => result([{ id: value }]);

function persistedNodeRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "memory:mem-1",
    scope_fingerprint: authorityScopeFingerprint(scope),
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    node_type: "memory",
    record_id: "mem-1",
    label: "memory",
    evidence_kind: null,
    semantic_type: "experience",
    lifecycle_status: "active",
    tree_type: null,
    level: null,
    skill_candidate_status: null,
    evidence_memory_ids: [],
    evidence_chunk_ids: ["chunk-1"],
    metadata: {},
    created_at: 100,
    updated_at: null,
    ...overrides,
  };
}

describe("PostgresWorkMemoryGraphRepository", () => {
  test("事务绑定 helper 复用调用方事务且不发送事务控制语句", async () => {
    const work = scriptedClient([
      id("evidence:chunk-1"),
      id("memory:mem-1"),
      result([persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      result([persistedNodeRow(), persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      id("edge-1"),
    ]);

    await expect(upsertPostgresWorkMemoryGraphInTransaction(work.client, {
      scope,
      nodes: [evidence(), memory()],
      edges: [grounded()],
    })).resolves.toBeUndefined();

    expect(work.query.mock.calls.some(([sql]) =>
      sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")).toBe(false);
    expect(work.release).not.toHaveBeenCalled();
    expect(work.queue).toHaveLength(0);
  });

  test("在单一事务内写节点、校验同 scope evidence/端点并写边", async () => {
    const work = scriptedClient([
      result([]),
      id("evidence:chunk-1"),
      id("memory:mem-1"),
      result([persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      result([persistedNodeRow(), persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      id("edge-1"),
      result([]),
    ]);
    const repository = new PostgresWorkMemoryGraphRepository(work.client);

    await expect(repository.upsertWorkMemoryGraph({
      scope,
      nodes: [evidence(), memory()],
      edges: [grounded()],
    })).resolves.toBeUndefined();

    expect(work.query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(work.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    const nodeInsert = work.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO mengshu_work_memory_nodes"));
    expect(nodeInsert?.[0]).toContain("ON CONFLICT (scope_fingerprint, id) DO UPDATE");
    expect(nodeInsert?.[1]?.[1]).toBe(authorityScopeFingerprint(scope));
    expect(nodeInsert?.[1]?.slice(2, 11)).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    const endpointRead = work.query.mock.calls.find(([sql]) => sql.includes("id = ANY") &&
      sql.includes("mengshu_work_memory_nodes"));
    expect(endpointRead?.[0]).toContain("scope_fingerprint = $1");
    expect(work.query.mock.calls.some(([sql]) => sql.includes("mengshu_graph_entities"))).toBe(false);
    expect(work.release).toHaveBeenCalledOnce();
    expect(work.queue).toHaveLength(0);
  });

  test("重复 upsert 使用相同 identity conflict guard，不创建第二条记录", async () => {
    const cycle = [
      result([]), id("evidence:chunk-1"), id("memory:mem-1"),
      result([persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      result([persistedNodeRow(), persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      id("edge-1"), result([]),
    ];
    const work = scriptedClient([...cycle, ...cycle]);
    const repository = new PostgresWorkMemoryGraphRepository(work.client);
    const batch = { scope, nodes: [evidence(), memory()], edges: [grounded()] };

    await repository.upsertWorkMemoryGraph(batch);
    await repository.upsertWorkMemoryGraph(batch);

    const nodeSql = work.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO mengshu_work_memory_nodes"))?.[0];
    const edgeSql = work.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO mengshu_work_memory_edges"))?.[0];
    expect(nodeSql).toMatch(/WHERE mengshu_work_memory_nodes\.node_type = EXCLUDED\.node_type/i);
    expect(nodeSql).toMatch(/EXCLUDED\.node_type <> 'summary'/i);
    expect(nodeSql).toMatch(/mengshu_work_memory_nodes\.evidence_chunk_ids = EXCLUDED\.evidence_chunk_ids/i);
    expect(edgeSql).toMatch(/WHERE mengshu_work_memory_edges\.predicate = EXCLUDED\.predicate/i);
    expect(edgeSql).toMatch(/EXCLUDED\.predicate <> 'derives_from'/i);
    expect(work.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(2);
    expect(work.release).toHaveBeenCalledTimes(2);
  });

  test("summary canonical 字段冲突时 fail closed 并回滚", async () => {
    const work = scriptedClient([
      result([]),
      result([]),
      result([]),
    ]);

    await expect(new PostgresWorkMemoryGraphRepository(work.client).upsertWorkMemoryGraph({
      scope,
      nodes: [summaryNode()],
      edges: [],
    })).rejects.toThrow(/identity conflict/i);

    expect(work.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO mengshu_work_memory_nodes"),
      "ROLLBACK",
    ]);
  });

  test("任一边写入失败时 rollback，且不 commit", async () => {
    const work = scriptedClient([
      result([]), id("evidence:chunk-1"), id("memory:mem-1"),
      result([persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      result([persistedNodeRow(), persistedNodeRow({
        id: "evidence:chunk-1", node_type: "evidence", record_id: "chunk-1",
        label: "chunk-1", evidence_kind: "chunk", semantic_type: null,
        lifecycle_status: null, evidence_chunk_ids: [],
      })]),
      new Error("edge failure"), result([]),
    ]);

    await expect(new PostgresWorkMemoryGraphRepository(work.client).upsertWorkMemoryGraph({
      scope, nodes: [evidence(), memory()], edges: [grounded()],
    })).rejects.toThrow("edge failure");

    expect(work.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(work.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(work.release).toHaveBeenCalledOnce();
  });

  test("查询使用完整 scope 且严格拒绝跨 scope 或扩展字段 row", async () => {
    const ok = scriptedClient([result([persistedNodeRow()])]);
    await expect(new PostgresWorkMemoryGraphRepository(ok.client)
      .getWorkMemoryNode("memory:mem-1", scope)).resolves.toEqual(memory());
    expect(ok.query.mock.calls[0]?.[1]?.slice(0, 10)).toEqual([
      authorityScopeFingerprint(scope), scope.tenantId, scope.userId, scope.appId,
      scope.projectId, scope.agentId, scope.namespace, scope.visibility,
      scope.workspaceId, scope.sessionId,
    ]);

    const crossScope = scriptedClient([result([persistedNodeRow({ project_id: "project-b" })])]);
    await expect(new PostgresWorkMemoryGraphRepository(crossScope.client)
      .getWorkMemoryNode("memory:mem-1", scope)).rejects.toThrow(/row|scope/i);

    const extended = scriptedClient([result([persistedNodeRow({ unexpected: true })])]);
    await expect(new PostgresWorkMemoryGraphRepository(extended.client)
      .getWorkMemoryNode("memory:mem-1", scope)).rejects.toThrow(/row/i);
  });

  test("缺失 workspace/session 的持久化空值在领域出口恢复为省略字段", async () => {
    const compactScope: MemoryScope = Object.freeze({
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
    });
    const work = scriptedClient([result([persistedNodeRow({
      scope_fingerprint: authorityScopeFingerprint(compactScope),
      workspace_id: "",
      session_id: "",
    })])]);

    const actual = await new PostgresWorkMemoryGraphRepository(work.client)
      .getWorkMemoryNode("memory:mem-1", compactScope);

    expect(actual).toEqual({ ...memory(), scope: compactScope });
    expect(actual?.scope).not.toHaveProperty("workspaceId");
    expect(actual?.scope).not.toHaveProperty("sessionId");
  });

  test("接受 pg 对 BIGINT 时间戳的十进制字符串返回形态", async () => {
    const work = scriptedClient([result([persistedNodeRow({
      created_at: "100",
      updated_at: "101",
    })])]);

    await expect(new PostgresWorkMemoryGraphRepository(work.client)
      .getWorkMemoryNode("memory:mem-1", scope)).resolves.toEqual({
        ...memory(),
        updatedAt: 101,
      });
  });
});
