import { describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";

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
      chunkId: "evidence-trace-20",
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

function finalizeRequest(
  overrides: Partial<PostgresBuildTreeEffectRequest> = {},
): PostgresBuildTreeEffectRequest {
  return {
    effectKey: "build_tree.persist.v1",
    effectInput: Object.freeze({
      id: "job-finalize-1",
      scope,
      owner: "worker-1",
      leaseToken: "t".repeat(32),
      leaseGeneration: 1,
    }),
    semanticRequest: Object.freeze({
      type: "finalize_tree_buffer" as const,
      version: 1 as const,
      traceId: "history-finalize-source-key",
      context: Object.freeze({ workspaceId: "workspace-1", sessionId: "session-1" }),
      treeType: "source" as const,
      treeKey: "source-key",
      level: 0 as const,
      finalizeMode: "history_rebuild" as const,
      expectedBufferId: bufferId(fullScope, "source", "source-key", 0),
    }),
    ...overrides,
  };
}

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

type QueryResponse = { rows: readonly Record<string, unknown>[]; rowCount?: number | null };

function workMemoryRow(
  id: string,
  nodeType: "evidence" | "memory" | "summary",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    scope_fingerprint: authorityScopeFingerprint(fullScope),
    tenant_id: fullScope.tenantId,
    user_id: fullScope.userId,
    app_id: fullScope.appId,
    project_id: fullScope.projectId,
    agent_id: fullScope.agentId,
    namespace: fullScope.namespace,
    visibility: fullScope.visibility,
    workspace_id: fullScope.workspaceId,
    session_id: fullScope.sessionId,
    node_type: nodeType,
    record_id: id.slice(id.indexOf(":") + 1),
    label: id,
    evidence_kind: nodeType === "evidence" ? "chunk" : null,
    semantic_type: null,
    lifecycle_status: nodeType === "memory" ? "active" : null,
    tree_type: nodeType === "summary" ? "source" : null,
    level: nodeType === "summary" ? 1 : null,
    skill_candidate_status: null,
    evidence_memory_ids: [],
    evidence_chunk_ids: nodeType === "evidence" ? [] : ["chunk-provenance"],
    metadata: {},
    created_at: "2000",
    updated_at: null,
    ...overrides,
  };
}

function workMemoryQueryResponse(
  sql: string,
  params: readonly unknown[],
  nodes: Map<string, Record<string, unknown>>,
): QueryResponse | undefined {
  if (sql.startsWith("INSERT INTO mengshu_work_memory_nodes")) {
    const row = workMemoryRow(
      params[0] as string,
      params[11] as "evidence" | "memory" | "summary",
      {
        record_id: params[12], label: params[13], evidence_kind: params[14],
        semantic_type: params[15], lifecycle_status: params[16], tree_type: params[17],
        level: params[18], skill_candidate_status: params[19],
        evidence_memory_ids: JSON.parse(params[20] as string),
        evidence_chunk_ids: JSON.parse(params[21] as string),
        metadata: JSON.parse(params[22] as string), created_at: String(params[23]),
        updated_at: params[24],
      },
    );
    nodes.set(row.id as string, row);
    return { rows: [{ id: row.id }], rowCount: 1 };
  }
  if (sql.includes("FROM mengshu_work_memory_nodes") && sql.includes("node_type = 'evidence'")) {
    const ids = params[10] as string[];
    return {
      rows: ids.map((id) => workMemoryRow(`evidence:${id}`, "evidence", { record_id: id })),
      rowCount: ids.length,
    };
  }
  if (sql.includes("FROM mengshu_work_memory_nodes") && sql.includes("id = ANY")) {
    const ids = params[10] as string[];
    const rows = ids.map((id) => nodes.get(id) ?? (id.startsWith("memory:")
      ? workMemoryRow(id, "memory")
      : workMemoryRow(id, "summary")));
    return { rows, rowCount: rows.length };
  }
  if (sql.startsWith("INSERT INTO mengshu_work_memory_edges")) {
    return { rows: [{ id: params[0] }], rowCount: 1 };
  }
  return undefined;
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

function summaryRow(
  id: string,
  level: 1 | 2 | 3,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    tree_type: "source",
    tree_key: "source-key",
    level,
    title: `summary ${id}`,
    summary: `grounded ${id}`,
    child_node_ids: [],
    leaf_ids: [`leaf-${id}`],
    evidence_chunk_ids: [`evidence-${id}`],
    entity_ids: [],
    relation_ids: [],
    token_count: "4",
    start_at: "1000",
    end_at: "2000",
    status: "sealed",
    created_at: "2000",
    sealed_at: "2000",
    metadata: { summaryMode: "extractive" },
    ...overrides,
  };
}

function topicRequest(): PostgresBuildTreeEffectRequest {
  const current = request();
  const semanticRequest = {
    ...current.semanticRequest,
    treeType: "topic" as const,
    treeKey: "postgresql-migration",
    expectedBufferId: bufferId(fullScope, "topic", "postgresql-migration", 0),
  };
  return { ...current, semanticRequest };
}

function topicAliasRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scope_fingerprint: authorityScopeFingerprint(fullScope),
    tenant_id: fullScope.tenantId,
    user_id: fullScope.userId,
    app_id: fullScope.appId,
    project_id: fullScope.projectId,
    agent_id: fullScope.agentId,
    namespace: fullScope.namespace,
    visibility: fullScope.visibility,
    workspace_id: fullScope.workspaceId,
    session_id: fullScope.sessionId,
    legacy_tree_key: "entity-pg",
    canonical_topic_label: "postgresql-migration",
    status: "active",
    merged_from: ["entity-pg"],
    created_at: "1000",
    updated_at: "1000",
    sealed_node_id: null,
    superseded_at: null,
    archived_at: null,
    ...overrides,
  };
}

function scriptedClient(
  responses: Array<{ rows: readonly Record<string, unknown>[]; rowCount?: number | null }>,
): { readonly client: PostgresBuildTreeEffectQueryClient; readonly calls: QueryCall[] } {
  const calls: QueryCall[] = [];
  let lastInsertedBuffer: Record<string, unknown> | undefined;
  let lastInsertedSummary: Record<string, unknown> | undefined;
  const workMemoryNodes = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
    calls.push({ sql, params });
    const graphResponse = workMemoryQueryResponse(sql, params, workMemoryNodes);
    if (graphResponse) return graphResponse;
    if (sql.includes("FROM mengshu_tree_summary_nodes") && sql.includes("id = $11") &&
        lastInsertedSummary) {
      return { rows: [lastInsertedSummary], rowCount: 1 };
    }
    const response = responses.shift();
    if (sql.startsWith("INSERT INTO mengshu_tree_summary_nodes") && response?.rowCount === 1) {
      lastInsertedSummary = summaryRow(params[10] as string, params[14] as 1 | 2, {
        tree_type: params[12], tree_key: params[13], title: params[15], summary: params[16],
        child_node_ids: JSON.parse(params[17] as string),
        leaf_ids: JSON.parse(params[18] as string),
        evidence_chunk_ids: JSON.parse(params[19] as string),
        entity_ids: JSON.parse(params[20] as string), relation_ids: JSON.parse(params[21] as string),
        token_count: String(params[22]), start_at: String(params[23]), end_at: String(params[24]),
        status: params[25], created_at: String(params[26]), sealed_at: String(params[27]),
        metadata: JSON.parse(params[28] as string),
      });
    }
    if (!response && sql.startsWith("INSERT INTO mengshu_tree_buffers")) {
      lastInsertedBuffer = {
        id: params[10],
        leaf_ids: JSON.parse(params[14] as string),
        child_node_ids: JSON.parse(params[15] as string),
        token_count: String(params[16]),
        opened_at: String(params[17]),
        updated_at: String(params[18]),
      };
      return { rows: [], rowCount: 1 };
    }
    if (!response && sql.includes("FROM mengshu_tree_buffers") && sql.includes("FOR UPDATE") &&
        lastInsertedBuffer) {
      return { rows: [lastInsertedBuffer], rowCount: 1 };
    }
    if (!response && sql.startsWith("UPDATE mengshu_tree_buffers")) {
      return { rows: [], rowCount: 1 };
    }
    if (!response) throw new Error("unexpected query");
    return response;
  });
  return { client: { query } as PostgresBuildTreeEffectQueryClient, calls };
}

describe("executePostgresBuildTreeDomainEffect", () => {
  test("history finalize 强制 seal 低于在线阈值的 L0 buffer 并继续追加 L2 folding buffer", async () => {
    const leaf = leafRow(1);
    const { client, calls } = scriptedClient([
      { rows: [{ pending_count: "0" }], rowCount: 1 },
      { rows: [bufferRow({
        leaf_ids: [leaf.id], token_count: "1", opened_at: "1000", updated_at: "1001",
      })], rowCount: 1 },
      { rows: [leaf], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    const result = await executePostgresBuildTreeDomainEffect(client, finalizeRequest());

    expect(result).toEqual({
      leafId: "history-finalize-source-key",
      sealed: true,
      bufferId: null,
      nodeId: expect.stringMatching(/^sum_[0-9a-f]{24}$/),
      foldedNodeIds: [],
    });
    expect(calls[0]!.sql).toContain("FROM mengshu_jobs_v2");
    expect(calls[1]!.sql).toContain("FOR UPDATE");
    expect(calls[2]!.sql).toContain("FROM mengshu_tree_leaves");
    expect(calls[3]!.sql).toContain("INSERT INTO mengshu_tree_summary_nodes");
    const projectionIndex = calls.findIndex(({ sql }) =>
      sql.startsWith("INSERT INTO mengshu_work_memory_nodes"));
    const deleteIndex = calls.findIndex(({ sql }) => sql.startsWith("DELETE FROM mengshu_tree_buffers"));
    expect(projectionIndex).toBeGreaterThan(3);
    expect(deleteIndex).toBeGreaterThan(projectionIndex);
    const parentInsert = calls.find(({ sql, params }) =>
      sql.startsWith("INSERT INTO mengshu_tree_buffers") && params[13] === 2)!;
    expect(parentInsert.params[13]).toBe(2);
    const parentUpdate = calls.find(({ sql, params }) =>
      sql.startsWith("UPDATE mengshu_tree_buffers") && params[13] === 2)!;
    expect(parentUpdate.params[15]).toEqual(JSON.stringify([result.nodeId]));
  });

  test("history finalize 在 append 尚未创建 buffer 时返回 retryable pending", async () => {
    const { client, calls } = scriptedClient([
      { rows: [{ pending_count: "1" }], rowCount: 1 },
    ]);

    await expect(executePostgresBuildTreeDomainEffect(client, finalizeRequest()))
      .rejects.toMatchObject({ code: "POSTGRES_TREE_FINALIZE_PENDING", retryable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("status <> 'completed'");
    expect(calls[0]!.sql).toContain("current_finalize.created_at");
  });

  test("history finalize 在普通阈值已经 seal 后幂等完成且不创建空 summary", async () => {
    const { client, calls } = scriptedClient([
      { rows: [{ pending_count: "0" }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ id: "sum_existing" }], rowCount: 1 },
    ]);

    await expect(executePostgresBuildTreeDomainEffect(client, finalizeRequest())).resolves.toEqual({
      leafId: "history-finalize-source-key",
      sealed: true,
      bufferId: null,
      nodeId: "sum_existing",
      foldedNodeIds: [],
    });
    expect(calls).toHaveLength(3);
  });

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
      foldedNodeIds: [],
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
    expect(calls[0]!.params).toContain("evidence-trace-20");
    expect(calls[0]!.params).toContain(JSON.stringify(["entity-2", "entity-1"]));
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
      chunk_id: "evidence-trace-20",
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
      foldedNodeIds: [],
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
    const summaryIndex = calls.findIndex(({ sql }) =>
      sql.startsWith("INSERT INTO mengshu_tree_summary_nodes"));
    const projectionIndex = calls.findIndex(({ sql }) =>
      sql.startsWith("INSERT INTO mengshu_work_memory_nodes"));
    const deleteIndex = calls.findIndex(({ sql }) => sql.startsWith("DELETE FROM mengshu_tree_buffers"));
    expect(summaryIndex).toBeLessThan(projectionIndex);
    expect(projectionIndex).toBeLessThan(deleteIndex);

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

  test("summary identity 已存在但 canonical 内容不同则在图投影前 fail closed", async () => {
    const priorLeafIds = Array.from({ length: 19 }, (_, index) =>
      `leaf-${String(index + 1).padStart(2, "0")}`);
    const leaves = priorLeafIds.map((_, index) => leafRow(index + 1));
    leaves.push(leafRow(20, {
      id: "trace-20", chunk_id: "evidence-trace-20", entity_ids: ["entity-2"],
      importance: 0.75, event_at: "2000", created_at: "2000", text: "new leaf",
      token_count: "2",
    }));
    const calls: QueryCall[] = [];
    let step = 0;
    const client: PostgresBuildTreeEffectQueryClient = {
      query: vi.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        const fixed = [
          { rows: [], rowCount: 1 },
          { rows: [], rowCount: 1 },
          { rows: [], rowCount: 0 },
          { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19", opened_at: "1000" })], rowCount: 1 },
          { rows: [], rowCount: 1 },
          { rows: leaves, rowCount: 20 },
          { rows: [], rowCount: 0 },
        ];
        if (step < fixed.length) return fixed[step++]!;
        if (sql.includes("FROM mengshu_tree_summary_nodes") && sql.includes("id = $11")) {
          return {
            rows: [summaryRow(params[10] as string, 1, {
              title: "conflicting canonical title",
              leaf_ids: [...priorLeafIds, "trace-20"],
              evidence_chunk_ids: leaves.map((leaf) => leaf.chunk_id),
            })],
            rowCount: 1,
          };
        }
        throw new Error("unexpected query");
      }) as PostgresBuildTreeEffectQueryClient["query"],
    };

    await expect(executePostgresBuildTreeDomainEffect(client, request()))
      .rejects.toThrow(/query result is invalid/i);
    expect(calls.some(({ sql }) => sql.startsWith("INSERT INTO mengshu_work_memory_nodes")))
      .toBe(false);
    expect(calls.some(({ sql }) => sql.startsWith("DELETE FROM mengshu_tree_buffers")))
      .toBe(false);
  });

  test("L1 seal 后在同一 fenced effect 事务追加 deterministic L2 folding buffer", async () => {
    const priorLeafIds = Array.from({ length: 19 }, (_, index) =>
      `leaf-${String(index + 1).padStart(2, "0")}`);
    const leaves = priorLeafIds.map((_, index) => leafRow(index + 1));
    leaves.push(leafRow(20, {
      id: "trace-20",
      chunk_id: "evidence-trace-20",
      entity_ids: ["entity-2", "entity-1"],
      importance: 0.75,
      event_at: "2000",
      created_at: "2000",
      text: "new leaf",
      token_count: "2",
    }));
    const parentBufferId = expect.stringMatching(/^fold-buffer:[0-9a-f]{64}$/);
    const { client, calls } = scriptedClient([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19", opened_at: "1000" })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: leaves, rowCount: 20 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    const result = await executePostgresBuildTreeDomainEffect(client, request());

    expect(result).toMatchObject({
      sealed: true,
      foldedNodeIds: [],
    });
    const parentInsert = calls.find(({ sql, params }) =>
      sql.startsWith("INSERT INTO mengshu_tree_buffers") && params[13] === 2)!;
    expect(parentInsert.params[10]).toEqual(parentBufferId);
    const parentLock = calls.find(({ sql, params }) => sql.includes("FOR UPDATE") && params.at(-1) === 2)!;
    expect(parentLock.params.at(-1)).toBe(2);
    const parentUpdate = calls.find(({ sql, params }) =>
      sql.startsWith("UPDATE mengshu_tree_buffers") && params[13] === 2)!;
    expect(parentUpdate.params[15]).toEqual(JSON.stringify([result.nodeId]));
  });

  test("达到 parent 阈值时在同一事务连续 seal L2/L3，且不创建 L4", async () => {
    const priorLeafIds = Array.from({ length: 19 }, (_, index) =>
      `leaf-${String(index + 1).padStart(2, "0")}`);
    const leaves = priorLeafIds.map((_, index) => leafRow(index + 1));
    leaves.push(leafRow(20, {
      id: "trace-20", chunk_id: "evidence-trace-20", entity_ids: ["entity-2"],
      importance: 0.75, event_at: "2000", created_at: "2000", text: "new leaf",
      token_count: "2",
    }));
    const l1Ids = Array.from({ length: 19 }, (_, index) => `l1-${index + 1}`);
    const l2Ids = Array.from({ length: 19 }, (_, index) => `l2-${index + 1}`);
    const summaries = new Map<string, Record<string, unknown>>([
      ...l1Ids.map((id) => [id, summaryRow(id, 1)] as const),
      ...l2Ids.map((id) => [id, summaryRow(id, 2)] as const),
    ]);
    const insertedBufferIds = new Map<number, string>();
    const calls: QueryCall[] = [];
    const workMemoryNodes = new Map<string, Record<string, unknown>>();
    const client: PostgresBuildTreeEffectQueryClient = {
      query: vi.fn(async (sql, params = []) => {
        calls.push({ sql, params });
        const graphResponse = workMemoryQueryResponse(sql, params, workMemoryNodes);
        if (graphResponse) return graphResponse;
        if (sql.startsWith("INSERT INTO mengshu_tree_buffers")) {
          insertedBufferIds.set(params[13] as number, params[10] as string);
          return { rows: [], rowCount: params[13] === 0 ? 0 : 1 };
        }
        if (sql.includes("FROM mengshu_tree_buffers") && sql.includes("FOR UPDATE")) {
          const level = params[12] as number;
          if (level === 0) return {
            rows: [bufferRow({ leaf_ids: priorLeafIds, token_count: "19", opened_at: "1000" })],
            rowCount: 1,
          };
          const childIds = level === 2 ? l1Ids : l2Ids;
          return { rows: [{
            id: insertedBufferIds.get(level), leaf_ids: [], child_node_ids: childIds,
            token_count: String(childIds.length * 4), opened_at: "1000", updated_at: "2000",
          }], rowCount: 1 };
        }
        if (sql.includes("FROM mengshu_tree_leaves")) return { rows: leaves, rowCount: leaves.length };
        if (sql.includes("FROM mengshu_tree_summary_nodes")) {
          const ids = Array.isArray(params[10]) ? params[10] as string[] : [params[10] as string];
          const rows = ids.map((id) => summaries.get(id)).filter(Boolean) as Record<string, unknown>[];
          return { rows, rowCount: rows.length };
        }
        if (sql.startsWith("INSERT INTO mengshu_tree_summary_nodes")) {
          const level = params[14] as 1 | 2 | 3;
          summaries.set(params[10] as string, summaryRow(params[10] as string, level, {
            title: params[15], summary: params[16], child_node_ids: JSON.parse(params[17] as string),
            leaf_ids: JSON.parse(params[18] as string), evidence_chunk_ids: JSON.parse(params[19] as string),
            entity_ids: JSON.parse(params[20] as string), relation_ids: JSON.parse(params[21] as string),
            token_count: String(params[22]), start_at: String(params[23]), end_at: String(params[24]),
            status: params[25], created_at: String(params[26]), sealed_at: String(params[27]),
            metadata: JSON.parse(params[28] as string),
          }));
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }) as PostgresBuildTreeEffectQueryClient["query"],
    };

    const result = await executePostgresBuildTreeDomainEffect(client, request());

    expect(result.foldedNodeIds).toEqual([
      expect.stringMatching(/^fold-node:[0-9a-f]{64}$/),
      expect.stringMatching(/^fold-node:[0-9a-f]{64}$/),
    ]);
    expect(calls.filter(({ sql }) => sql.startsWith("INSERT INTO mengshu_tree_summary_nodes"))
      .map(({ params }) => params[14])).toEqual([1, 2, 3]);
    expect(calls.filter(({ sql }) => sql.startsWith("INSERT INTO mengshu_tree_buffers"))
      .map(({ params }) => params[13])).toEqual([0, 2, 3]);
  });

  test("token 达到 6000 时 seal，未达到 20 leaves 也生成 node", async () => {
    const priorLeafIds = ["leaf-01"];
    const current = request();
    if (current.semanticRequest.type !== "build_tree") throw new Error("expected append request");
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
        id: "trace-20", chunk_id: "evidence-trace-20", text: "xxxx", token_count: "1",
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

  test("D-21 topic seal 同事务合并旧 entity buffer，保留旧树并在 summary 后 supersede alias", async () => {
    const current = topicRequest();
    const legacyPrior = Array.from({ length: 19 }, (_, index) =>
      `leaf-${String(index + 1).padStart(2, "0")}`);
    const allLeafIds = ["trace-20", ...legacyPrior];
    const canonicalBuffer = bufferRow({
      id: current.semanticRequest.expectedBufferId,
      leaf_ids: ["trace-20"],
      token_count: "2",
      opened_at: "1000",
    });
    const legacyBuffer = {
      id: bufferId(fullScope, "topic", "entity-pg", 0),
      tree_key: "entity-pg",
      leaf_ids: legacyPrior,
      child_node_ids: [],
      token_count: "19",
      opened_at: "900",
      updated_at: "1900",
    };
    const mergedBuffers = [{ ...canonicalBuffer, tree_key: "postgresql-migration" }, legacyBuffer];
    const fullLeaves = legacyPrior.map((_, index) => leafRow(index + 1));
    fullLeaves.push(leafRow(20, {
      id: "trace-20", chunk_id: "evidence-trace-20", text: "new leaf",
      token_count: "2", event_at: "2000", created_at: "2000",
    }));
    const sealedNodeId = `sum_${createHash("sha256").update(JSON.stringify([
      "mengshu.tree-summary/v1",
      authorityScopeFingerprint(fullScope),
      "topic",
      "postgresql-migration",
      1,
      ...allLeafIds.slice().sort(),
    ])).digest("hex").slice(0, 24)}`;
    const superseded = topicAliasRow({
      status: "superseded", updated_at: "2000", sealed_node_id: sealedNodeId,
      superseded_at: "2000",
    });
    const { client, calls } = scriptedClient([
      { rows: [topicAliasRow()], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [bufferRow({
        id: current.semanticRequest.expectedBufferId,
        leaf_ids: [],
        token_count: "0",
        opened_at: "1000",
      })], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [topicAliasRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: mergedBuffers, rowCount: 2 },
      { rows: allLeafIds.map((id, index) => ({
        id, token_count: id === "trace-20" ? "2" : "1",
      })), rowCount: allLeafIds.length },
      { rows: [], rowCount: 1 },
      { rows: fullLeaves, rowCount: fullLeaves.length },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [superseded], rowCount: 1 },
    ]);

    const result = await executePostgresBuildTreeDomainEffect(client, current);

    expect(result).toMatchObject({ sealed: true, bufferId: null });
    const summaryCall = calls.find(({ sql }) =>
      sql.includes("INSERT INTO mengshu_tree_summary_nodes"))!;
    expect(JSON.parse(summaryCall.params[18] as string)).toEqual(allLeafIds);
    expect(JSON.parse(summaryCall.params[19] as string)).toContain("chunk-1");
    const deletes = calls.filter(({ sql }) => /^DELETE FROM mengshu_tree_buffers/.test(sql));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.params).toContain("postgresql-migration");
    expect(deletes[0]?.params).not.toContain("entity-pg");
    const supersedeIndex = calls.findIndex(({ sql }) => sql.includes("status = 'superseded'"));
    expect(supersedeIndex).toBeGreaterThan(calls.indexOf(summaryCall));
    expect(calls.some(({ sql }) => /DELETE.+entity-pg/is.test(sql))).toBe(false);
  });

  test("D-21 in-flight legacy-key job resolves canonical identity before any buffer DML", async () => {
    const current = topicRequest();
    const legacyRequest = {
      ...current,
      semanticRequest: {
        ...current.semanticRequest,
        treeKey: "entity-pg",
        expectedBufferId: bufferId(fullScope, "topic", "entity-pg", 0),
      },
    };
    const canonicalBuffer = bufferRow({
      id: current.semanticRequest.expectedBufferId,
      leaf_ids: [],
      token_count: "0",
    });
    const { client, calls } = scriptedClient([
      { rows: [topicAliasRow()], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [canonicalBuffer], rowCount: 1 },
      { rows: [], rowCount: 1 },
      { rows: [topicAliasRow()], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ ...canonicalBuffer, tree_key: "postgresql-migration", leaf_ids: ["trace-20"], token_count: "2" }], rowCount: 1 },
      { rows: [{ id: "trace-20", token_count: "2" }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]);

    await expect(executePostgresBuildTreeDomainEffect(client, legacyRequest))
      .resolves.toMatchObject({
        sealed: false,
        bufferId: current.semanticRequest.expectedBufferId,
      });

    const bufferWrites = calls.filter(({ sql }) =>
      /^(?:INSERT INTO|UPDATE|DELETE FROM) mengshu_tree_buffers/.test(sql));
    expect(bufferWrites.length).toBeGreaterThan(0);
    expect(bufferWrites.every(({ params }) => !params.includes("entity-pg"))).toBe(true);
    expect(bufferWrites.every(({ params }) =>
      params.includes("postgresql-migration") ||
      params.includes(current.semanticRequest.expectedBufferId))).toBe(true);
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
