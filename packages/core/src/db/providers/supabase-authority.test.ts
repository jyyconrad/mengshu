import { beforeEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_VECTOR_CANDIDATE_LIMIT } from "../types.js";
import type { MemoryEntry } from "../types.js";

const mockState = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; args: unknown[] }>,
  directRows: [] as Record<string, unknown>[],
  directError: null as { message: string } | null,
  directResponses: [] as Array<{
    data: Record<string, unknown>[];
    error: { message: string } | null;
  }>,
  rpcRows: [] as Record<string, unknown>[],
  rpcError: null as { message: string } | null,
  respectRpcMatchCount: false,
}));

vi.mock("@supabase/supabase-js", () => {
  class QueryBuilder implements PromiseLike<{ data: Record<string, unknown>[]; error: { message: string } | null }> {
    select(...args: unknown[]) { mockState.calls.push({ method: "select", args }); return this; }
    in(...args: unknown[]) { mockState.calls.push({ method: "in", args }); return this; }
    eq(...args: unknown[]) { mockState.calls.push({ method: "eq", args }); return this; }
    limit(...args: unknown[]) { mockState.calls.push({ method: "limit", args }); return this; }
    upsert(...args: unknown[]) { mockState.calls.push({ method: "upsert", args }); return this; }
    then<TResult1 = { data: Record<string, unknown>[]; error: { message: string } | null }, TResult2 = never>(
      onfulfilled?: ((value: { data: Record<string, unknown>[]; error: { message: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
      _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
    ): PromiseLike<TResult1 | TResult2> {
      const response = mockState.directResponses.shift() ?? {
        data: mockState.directRows,
        error: mockState.directError,
      };
      return Promise.resolve(response).then(onfulfilled);
    }
  }
  return {
    createClient: () => ({
      from: (table: string) => {
        mockState.calls.push({ method: "from", args: [table] });
        return new QueryBuilder();
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        mockState.calls.push({ method: "rpc", args: [name, args] });
        if (name === "exec_sql") return { data: null, error: null };
        const data = mockState.respectRpcMatchCount
          ? mockState.rpcRows.slice(0, Number(args.match_count))
          : mockState.rpcRows;
        return { data, error: mockState.rpcError };
      },
    }),
  };
});

import { SupabaseProvider } from "./supabase.js";
import { LegacyDatabaseAdapter } from "../../storage/legacy-database-adapter.js";
import { DefaultMemoryService } from "../../service/memory-service.js";

const config = ["https://example.supabase.co", "service-key", "text-embedding-3-small"] as const;

function row(id: string, tenantId: string | null, userId: string | null): Record<string, unknown> {
  return {
    id,
    text: `text-${id}`,
    content_hash: `hash-${id}`,
    vector: [0.1, 0.2],
    importance: 0.7,
    category: "fact",
    data_type: "memory",
    metadata: {},
    created_at: new Date(0).toISOString(),
    tenant_id: tenantId,
    user_id: userId,
    similarity: 0.9,
  };
}

describe("SupabaseProvider recall authority", () => {
  beforeEach(() => {
    mockState.calls.length = 0;
    mockState.directRows = [];
    mockState.directError = null;
    mockState.directResponses = [];
    mockState.rpcRows = [];
    mockState.rpcError = null;
    mockState.respectRpcMatchCount = false;
  });

  test("non-vector query 在 limit 前对 canonical tenant/user 独立列 exact eq，并隐藏 NULL/alien", async () => {
    mockState.directRows = [
      row("legacy-null-tenant", null, "user-a"),
      row("legacy-null-user", "tenant-a", null),
      row("alien", "tenant-b", "user-a"),
      row("allowed", "tenant-a", "user-a"),
    ];
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({ tenantId: "tenant-a", userId: "user-a", limit: 2 });

    expect(result.map(({ id }) => id)).toEqual(["allowed"]);
    const businessCalls = mockState.calls.filter(({ method }) => method !== "rpc");
    expect(businessCalls.map(({ method }) => method)).toEqual(["from", "select", "eq", "eq", "limit"]);
    expect(businessCalls[2]?.args).toEqual(["tenant_id", "tenant-a"]);
    expect(businessCalls[3]?.args).toEqual(["user_id", "user-a"]);
    expect(businessCalls[4]?.args).toEqual([2]);
  });

  test("vector RPC 传递 authority 参数，100 组污染结果 post-filter 后再正确 limit", async () => {
    mockState.rpcRows = [
      ...Array.from({ length: 100 }, (_, index) => row(
        `alien-${index}`,
        index % 2 === 0 ? `tenant-${index}` : "tenant-a",
        index % 2 === 0 ? "user-a" : `user-${index}`,
      )),
      ...Array.from({ length: 8 }, (_, index) => row(`allowed-${index}`, "tenant-a", "user-a")),
    ];
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2], tenantId: "tenant-a", userId: "user-a", limit: 5,
    });

    expect(result.map(({ id }) => id)).toEqual([
      "allowed-0", "allowed-1", "allowed-2", "allowed-3", "allowed-4",
    ]);
    const matchCall = mockState.calls.find(({ method, args }) =>
      method === "rpc" && args[0] === "match_memories");
    expect(matchCall?.args[1]).toMatchObject({
      match_count: DEFAULT_VECTOR_CANDIDATE_LIMIT,
      min_similarity: -1,
      filter_tenant_id: "tenant-a",
      filter_user_id: "user-a",
    });
  });

  test("vector RPC 的候选池独立于 legacy final limit，允许第 6 条以后返回 core", async () => {
    mockState.respectRpcMatchCount = true;
    mockState.rpcRows = Array.from({ length: 8 }, (_, index) =>
      row(`allowed-${index}`, "tenant-a", "user-a"));
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2],
      tenantId: "tenant-a",
      userId: "user-a",
    });

    expect(result).toHaveLength(8);
    expect(result.at(5)?.id).toBe("allowed-5");
    const matchCall = mockState.calls.find(({ method, args }) =>
      method === "rpc" && args[0] === "match_memories");
    expect(matchCall?.args[1]).toMatchObject({
      match_count: DEFAULT_VECTOR_CANDIDATE_LIMIT,
      min_similarity: -1,
    });
  });

  test("RPC 返回过量数据时 provider 在 authority 后收敛到 candidateLimit", async () => {
    mockState.rpcRows = Array.from({ length: 12 }, (_, index) =>
      row(`allowed-${index}`, "tenant-a", "user-a"));
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2],
      tenantId: "tenant-a",
      userId: "user-a",
      candidateLimit: 8,
    });

    expect(result).toHaveLength(8);
  });

  test("candidateLimit 可配置，final limit 只在 RPC 候选取回后应用", async () => {
    mockState.respectRpcMatchCount = true;
    mockState.rpcRows = Array.from({ length: 20 }, (_, index) =>
      row(`allowed-${index}`, "tenant-a", "user-a"));
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2],
      tenantId: "tenant-a",
      userId: "user-a",
      candidateLimit: 8,
      limit: 5,
    });

    expect(result).toHaveLength(5);
    const matchCall = mockState.calls.find(({ method, args }) =>
      method === "rpc" && args[0] === "match_memories");
    expect(matchCall?.args[1]).toMatchObject({ match_count: 8, min_similarity: -1 });
  });

  test("legacy minScore 只在 RPC 候选取回后应用，不下推为 min_similarity", async () => {
    mockState.rpcRows = [
      { ...row("below", "tenant-a", "user-a"), similarity: 0.6 },
      { ...row("above", "tenant-a", "user-a"), similarity: 0.8 },
    ];
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2],
      tenantId: "tenant-a",
      userId: "user-a",
      minScore: 0.7,
    });

    expect(result.map(({ id }) => id)).toEqual(["above"]);
    const matchCall = mockState.calls.find(({ method, args }) =>
      method === "rpc" && args[0] === "match_memories");
    expect(matchCall?.args[1]).toMatchObject({ min_similarity: -1 });
  });

  test("第 6 条以后候选仍进入 core 六因子排序，final minScore/limit 不下推 RPC", async () => {
    mockState.respectRpcMatchCount = true;
    const scope = {
      tenantId: "tenant-a",
      userId: "user-a",
      projectId: "project-a",
      appId: "openclaw",
      agentId: "agent-a",
      namespace: "memories",
    } as const;
    const governedRow = (
      id: string,
      similarity: number,
      importance: number,
      confidence: number,
      createdAt: number,
    ): Record<string, unknown> => ({
      ...row(id, scope.tenantId, scope.userId),
      similarity,
      importance,
      created_at: new Date(createdAt).toISOString(),
      canonical_project_id: scope.projectId,
      product_id: scope.appId,
      producer_id: scope.agentId,
      namespace: scope.namespace,
      visibility: "private",
      lifecycle_status: "active",
      metadata: {
        semanticType: "rules",
        admissionRoute: "active",
        memoryContainer: "project",
        confidence,
        sourceNodeIds: confidence === 1 ? ["e1", "e2", "e3", "e4", "e5"] : [],
      },
    });
    mockState.rpcRows = [
      ...Array.from({ length: 5 }, (_, index) =>
        governedRow(`vector-top-${index}`, 0.9 - index * 0.01, 0, 0, 0)),
      governedRow("core-winner-after-five", 0.6, 1, 1, Date.now()),
      governedRow("vector-tail-1", 0.5, 0, 0, 0),
      governedRow("vector-tail-2", 0.4, 0, 0, 0),
    ];
    const provider = new SupabaseProvider(...config);
    const service = new DefaultMemoryService({
      repository: new LegacyDatabaseAdapter(provider, scope),
      embeddings: { embed: async () => [0.1, 0.2] },
    });

    const result = await service.recall({
      query: "governed candidate pool",
      scope,
      limit: 1,
      minScore: 0.7,
    });

    expect(result.hits.map((hit) => hit.record.id)).toEqual(["core-winner-after-five"]);
    const matchCall = mockState.calls.find(({ method, args }) =>
      method === "rpc" && args[0] === "match_memories");
    expect(matchCall?.args[1]).toMatchObject({
      match_count: DEFAULT_VECTOR_CANDIDATE_LIMIT,
      min_similarity: -1,
    });
  });

  test("RPC fallback 仍在 limit 前下推 authority，且 top-level id array 使用 in", async () => {
    mockState.rpcError = { message: "rpc unavailable" };
    mockState.directRows = [row("allowed", "tenant-a", "user-a")];
    const provider = new SupabaseProvider(...config);

    await expect(provider.query({
      vector: [0.1, 0.2], tenantId: "tenant-a", userId: "user-a", limit: 3,
      filter: { id: ["allowed"] },
    })).resolves.toMatchObject([{ id: "allowed", tenantId: "tenant-a", userId: "user-a" }]);

    const methods = mockState.calls.map(({ method }) => method);
    const lastTenantEq = mockState.calls.findIndex(({ method, args }) => method === "eq" && args[0] === "tenant_id");
    const lastUserEq = mockState.calls.findIndex(({ method, args }) => method === "eq" && args[0] === "user_id");
    const idIn = mockState.calls.findIndex(({ method, args }) => method === "in" && args[0] === "id");
    expect(lastTenantEq).toBeGreaterThan(-1);
    expect(lastUserEq).toBeGreaterThan(lastTenantEq);
    expect(idIn).toBeGreaterThan(lastUserEq);
    // direct computed-query fallback 没有可靠的数据库 alias ordering；必须取回后
    // 按 similarity 排序再裁 candidateLimit，不能先按行序截断。
    expect(methods).not.toContain("limit");
  });

  test("RPC fallback 先按相似度排序再裁候选池，第 6 条不会被旧缺省 5 丢弃", async () => {
    mockState.rpcError = { message: "rpc unavailable" };
    mockState.directRows = Array.from({ length: 8 }, (_, index) => ({
      ...row(`allowed-${index}`, "tenant-a", "user-a"),
      similarity: index === 5 ? 1 : 0.9 - index * 0.01,
    }));
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2],
      tenantId: "tenant-a",
      userId: "user-a",
      candidateLimit: 8,
    });

    expect(result).toHaveLength(8);
    expect(result[0]?.id).toBe("allowed-5");
    expect(mockState.calls.filter(({ method }) => method === "limit")).toHaveLength(0);
  });

  test("fallback 失败进入 alternative 时仍保持 authority/ID 预选并隐藏污染行", async () => {
    mockState.rpcError = { message: "rpc unavailable" };
    mockState.directResponses = [
      { data: [], error: { message: "computed select unavailable" } },
      {
        data: [
          row("alien", "tenant-b", "user-a"),
          row("allowed", "tenant-a", "user-a"),
        ],
        error: null,
      },
    ];
    const provider = new SupabaseProvider(...config);

    const result = await provider.query({
      vector: [0.1, 0.2], tenantId: "tenant-a", userId: "user-a", limit: 2,
      filter: { id: ["allowed"] },
    });

    expect(result.map(({ id }) => id)).toEqual(["allowed"]);
    expect(mockState.calls.filter(({ method, args }) =>
      method === "eq" && args[0] === "tenant_id")).toHaveLength(2);
    expect(mockState.calls.filter(({ method, args }) =>
      method === "in" && args[0] === "id")).toHaveLength(2);
  });

  test.each([
    { tenantId: "tenant-a" },
    { userId: "user-a" },
    { tenantId: "x' OR '1'='1", userId: "user-a" },
    { tenantId: "tenant-a", userId: "../user" },
  ])("invalid/partial authority %# 在 initialize/provider call 前 fail-closed", async (authority) => {
    const provider = new SupabaseProvider(...config);
    await expect(provider.query(authority)).rejects.toThrow(/authority/i);
    expect(mockState.calls).toEqual([]);
  });

  test("DDL 声明 tenant_id/user_id 索引，store 将 canonical authority 写入独立列", async () => {
    const provider = new SupabaseProvider(...config);
    const entry = {
      id: "00000000-0000-0000-0000-000000000001",
      text: "x", contentHash: "h", vector: [0.1], importance: 0.5,
      category: "fact", dataType: "memory", metadata: {}, createdAt: 1,
      tenantId: "tenant-a", userId: "user-a",
      canonicalProjectId: "project-a", productId: "openclaw", producerId: "agent-a",
      namespace: "memories", visibility: "private",
    } satisfies MemoryEntry;
    mockState.directRows = [{ id: entry.id, content_hash: entry.contentHash }];
    await expect(provider.store([entry])).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
      records: [{ requestedId: entry.id, persistedId: entry.id, stored: true }],
    });

    const ddlCalls = mockState.calls.filter(({ method, args }) =>
      method === "rpc" && args[0] === "exec_sql");
    expect(ddlCalls).toHaveLength(2);
    for (const call of ddlCalls) {
      const sql = String((call.args[1] as { sql: string }).sql);
      expect(sql).toContain("tenant_id TEXT");
      expect(sql).toMatch(/\(tenant_id, user_id\)/);
    }
    const upsert = mockState.calls.find(({ method }) => method === "upsert");
    expect((upsert?.args[0] as Record<string, unknown>[])[0]).toMatchObject({
      tenant_id: "tenant-a",
      user_id: "user-a",
    });
  });

  test("store provider error 必须抛出，不能记录日志后虚报 stored", async () => {
    const provider = new SupabaseProvider(...config);
    const entry = {
      id: "00000000-0000-0000-0000-000000000001",
      text: "x", contentHash: "h", vector: [0.1], importance: 0.5,
      category: "fact", dataType: "memory", metadata: {}, createdAt: 1,
      tenantId: "tenant-a", userId: "user-a", canonicalProjectId: "project-a",
      productId: "openclaw", producerId: "agent-a", namespace: "memories", visibility: "private",
    } satisfies MemoryEntry;
    mockState.directError = { message: "permission denied secret-detail" };

    await expect(provider.store([entry])).rejects.toMatchObject({ code: "SUPABASE_STORE_FAILED" });
  });

  test("同 authority duplicate 返回真实 persisted ID，跨 authority global conflict 明确 pending", async () => {
    const provider = new SupabaseProvider(...config);
    const entry = {
      id: "00000000-0000-0000-0000-000000000001",
      text: "x", contentHash: "h", vector: [0.1], importance: 0.5,
      category: "fact", dataType: "memory", metadata: {}, createdAt: 1,
      tenantId: "tenant-a", userId: "user-a", canonicalProjectId: "project-a",
      productId: "openclaw", producerId: "agent-a", namespace: "memories", visibility: "private",
    } satisfies MemoryEntry;
    mockState.directResponses = [
      { data: [], error: null },
      { data: [{ id: "00000000-0000-0000-0000-000000000099", content_hash: "h" }], error: null },
    ];
    await expect(provider.store([entry])).resolves.toEqual({
      inserted: 0,
      duplicates: 1,
      records: [{
        requestedId: entry.id,
        persistedId: "00000000-0000-0000-0000-000000000099",
        stored: false,
      }],
    });

    mockState.directResponses = [
      { data: [], error: null },
      { data: [], error: null },
    ];
    await expect(provider.store([{ ...entry, id: "00000000-0000-0000-0000-000000000002" }]))
      .rejects.toMatchObject({ code: "SCHEMA_CONTRACT_PENDING" });
  });
});
