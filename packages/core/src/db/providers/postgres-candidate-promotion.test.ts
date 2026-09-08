import { describe, expect, test, vi } from "vitest";

import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import {
  isProviderOwnedCandidatePromotionPort,
  PostgresCandidatePromotionPort,
  type PostgresCandidatePromotionClient,
} from "./postgres-candidate-promotion.js";
import { PostgresProvider } from "./postgres.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "codex",
  namespace: "working-context",
  visibility: "private",
});

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    scope,
    kind: "fact",
    semanticType: "rules",
    text: "所有生产变更必须先通过离线测试。",
    contentHash: "a".repeat(64),
    importance: 0.9,
    confidence: 0.92,
    category: "core",
    dataType: "memory",
    tableName: "memories",
    container: "project",
    lifecycleStatus: "active",
    metadata: {
      promotedFromCandidate: "candidate-1",
      embeddingSpaceId: `embedding-space:v1:${"b".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
    },
    provenance: { source: "candidate-promotion", sourceId: "candidate-1" },
    createdAt: 1_000,
    updatedAt: 1_000,
    vector: [0.1, 0.2],
    ...overrides,
  };
}

function material() {
  const record = memory();
  return {
    id: record.id,
    importance: record.importance,
    category: record.category,
    container: record.container,
    metadata: {
      embeddingSpaceId: record.metadata.embeddingSpaceId,
      embeddingSpaceState: record.metadata.embeddingSpaceState,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    vector: record.vector!,
  };
}

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: "",
    session_id: "",
    text: memory().text,
    semantic_type: memory().semanticType,
    kind: memory().kind,
    confidence: memory().confidence,
    content_hash: memory().contentHash,
    evidence_ids: ["evidence-1", "evidence-2"],
    status: "pending",
    promoted_to_memory_id: null,
    ...overrides,
  };
}

interface HarnessOptions {
  candidate?: Record<string, unknown> | null;
  failOn?: RegExp;
}

function harness(options: HarnessOptions = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  let queryImpl: PostgresCandidatePromotionClient["query"] = async <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(
    sql: string,
    params: readonly unknown[] = [],
  ) => {
    const normalized = sql.replace(/\s+/g, " ").trim();
    calls.push({ sql: normalized, params });
    if (options.failOn?.test(normalized)) throw new Error("provider secret must not escape");
    if (/FROM mengshu_candidates/.test(normalized) && /FOR UPDATE/.test(normalized)) {
      const row = options.candidate === null
        ? undefined
        : options.candidate ?? candidateRow();
      return { rows: (row ? [row] : []) as unknown as Row[], rowCount: row ? 1 : 0 };
    }
    if (/FROM mengshu_write_receipts/.test(normalized)) {
      return { rows: [], rowCount: 0 };
    }
    if (/UPDATE mengshu_candidates/.test(normalized)) {
      return {
        rows: [{
          id: "candidate-1",
          status: "approved",
          promoted_to_memory_id: memory().id,
        }] as unknown as Row[],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 1 };
  };
  const client: PostgresCandidatePromotionClient = {
    query: <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => queryImpl<Row>(sql, params),
    release: vi.fn(),
  };
  return {
    client,
    calls,
    pool: { connect: vi.fn(async () => client) },
    setQuery: (next: PostgresCandidatePromotionClient["query"]) => { queryImpl = next; },
  };
}

describe("PostgresCandidatePromotionPort", () => {
  test.each([{ version: 1, operation: "evolve" }, { operation: "create" }, null, false])(
    "evolution metadata cannot enter ordinary provider promotion: %j",
    async (evolution) => {
      const h = harness({ candidate: candidateRow({ metadata: { evolution } }) });
      const insert = vi.fn();
      const port = new PostgresCandidatePromotionPort(h.pool, insert, scope);
      await expect(port.promote({ candidateId: "candidate-1", material: material() }))
        .rejects.toMatchObject({ code: "EVOLUTION_REVIEW_REQUIRED", retryable: false });
      expect(insert).not.toHaveBeenCalled();
      expect(h.calls.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
      expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
      expect(h.calls.some(({ sql }) => /SELECT.*metadata/.test(sql))).toBe(true);
    },
  );

  test("Postgres provider factory 只返回带 provider-owned 品牌的 scope-bound port", () => {
    const provider = new PostgresProvider({
      host: "127.0.0.1",
      port: 5432,
      database: "mengshu",
      user: "mengshu",
      password: "not-used",
    }, "text-embedding-3-small");

    const port = provider.createCandidatePromotionPort(scope);

    expect(isProviderOwnedCandidatePromotionPort(port)).toBe(true);
    expect(isProviderOwnedCandidatePromotionPort({ promote: port.promote.bind(port) })).toBe(false);
  });

  test("在同一 dedicated transaction 写 active memory、candidate 状态、audit/outbox 与 promotion receipt", async () => {
    const h = harness();
    const insert = vi.fn(async (client: PostgresCandidatePromotionClient, record: MemoryRecord) => {
      expect(client).toBe(h.client);
      expect(record.lifecycleStatus).toBe("active");
      await client.query("INSERT INTO memories (id) VALUES ($1)", [record.id]);
      return { requestedId: record.id, persistedId: record.id, stored: true };
    });
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .resolves.toEqual({
        status: "applied",
        candidateId: "candidate-1",
        memoryId: memory().id,
        stored: true,
      });

    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0]?.[1]).toMatchObject({
      scope,
      text: candidateRow().text,
      kind: "fact",
      semanticType: candidateRow().semantic_type,
      confidence: candidateRow().confidence,
      contentHash: candidateRow().content_hash,
      sourceNodeIds: candidateRow().evidence_ids,
      lifecycleStatus: "active",
      metadata: {
        admissionRoute: "active",
        contextEligible: true,
        importance: memory().importance,
        promotedFromCandidate: "candidate-1",
      },
      provenance: { sourceId: "candidate-1" },
    });
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/SELECT .+ FROM mengshu_candidates .+ FOR UPDATE/),
      expect.stringMatching(/SELECT .+ FROM mengshu_write_receipts/),
      "INSERT INTO memories (id) VALUES ($1)",
      expect.stringMatching(/UPDATE mengshu_candidates/),
      expect.stringMatching(/INSERT INTO mengshu_write_audit/),
      expect.stringMatching(/INSERT INTO mengshu_write_outbox/),
      expect.stringMatching(/INSERT INTO mengshu_write_receipts/),
      "COMMIT",
    ]);
    const update = h.calls.find(({ sql }) => /UPDATE mengshu_candidates/.test(sql));
    expect(update?.sql).toContain("status = 'approved'");
    expect(update?.sql).toContain("promoted_to_memory_id = $11");
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["scope 不匹配", null],
    ["非 pending", candidateRow({ status: "rejected" })],
  ])("%s 时 fail-closed，memory/journal 零写入并回滚", async (_name, candidate) => {
    const h = harness({ candidate });
    const insert = vi.fn();
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .rejects.toMatchObject({ code: "CANDIDATE_NOT_PENDING" });

    expect(insert).not.toHaveBeenCalled();
    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/FROM mengshu_candidates/),
      "ROLLBACK",
    ]);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("任一 journal 写失败时回滚整个 promotion，不返回部分成功", async () => {
    const h = harness({ failOn: /INSERT INTO mengshu_write_outbox/ });
    const insert = vi.fn(async (client: PostgresCandidatePromotionClient, record: MemoryRecord) => {
      await client.query("INSERT INTO memories (id) VALUES ($1)", [record.id]);
      return { requestedId: record.id, persistedId: record.id, stored: true };
    });
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .rejects.toMatchObject({ code: "PROMOTION_FAILED" });

    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(h.calls.some(({ sql }) => sql === "COMMIT")).toBe(false);
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("approved candidate 只有在 receipt 与请求完全匹配时幂等 replay，且不重复写 memory/outbox", async () => {
    const first = harness();
    const inserted = vi.fn(async (_client: PostgresCandidatePromotionClient, record: MemoryRecord) => ({
      requestedId: record.id,
      persistedId: record.id,
      stored: true,
    }));
    const firstPort = new PostgresCandidatePromotionPort(first.pool, inserted, scope, () => 2_000);
    await firstPort.promote({ candidateId: "candidate-1", material: material() });
    const savedReceipt = first.calls.find(({ sql }) => /INSERT INTO mengshu_write_receipts/.test(sql));
    expect(savedReceipt).toBeDefined();

    const replay = harness({
      candidate: candidateRow({ status: "approved", promoted_to_memory_id: memory().id }),
    });
    replay.setQuery(async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) => {
      const normalized = sql.replace(/\s+/g, " ").trim();
      replay.calls.push({ sql: normalized, params });
      if (/FROM mengshu_candidates/.test(normalized)) {
        return {
          rows: [candidateRow({
            status: "approved",
            promoted_to_memory_id: memory().id,
          })] as unknown as Row[],
          rowCount: 1,
        };
      }
      if (/FROM mengshu_write_receipts/.test(normalized)) {
        return {
          rows: [{
            storage_key: savedReceipt!.params[0],
            tenant_id: scope.tenantId,
            user_id: scope.userId,
            request_fingerprint: savedReceipt!.params[3],
            result: JSON.parse(String(savedReceipt!.params[4])),
          }] as unknown as Row[],
          rowCount: 1,
        };
      }
      return { rows: [] as Row[], rowCount: 1 };
    });
    const replayInsert = vi.fn();
    const replayPort = new PostgresCandidatePromotionPort(replay.pool, replayInsert, scope, () => 9_999);

    await expect(replayPort.promote({ candidateId: "candidate-1", material: material() }))
      .resolves.toEqual({
        status: "replayed",
        candidateId: "candidate-1",
        memoryId: memory().id,
        stored: true,
      });
    expect(replayInsert).not.toHaveBeenCalled();
    expect(replay.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/FROM mengshu_candidates/),
      expect.stringMatching(/FROM mengshu_write_receipts/),
      "COMMIT",
    ]);
  });

  test("非法 memory material 在插入前拒绝，候选派生字段无调用方覆盖入口", async () => {
    const h = harness();
    const insert = vi.fn();
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({
      candidateId: "candidate-1",
      material: { ...material(), vector: [] },
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    expect(insert).not.toHaveBeenCalled();
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("沿用 Mengshu 原候选映射，非 MemoryKind 标签安全收敛为 other", async () => {
    const h = harness({ candidate: candidateRow({ kind: "reference" }) });
    const insert = vi.fn(async (_client: PostgresCandidatePromotionClient, record: MemoryRecord) => ({
      requestedId: record.id,
      persistedId: record.id,
      stored: true,
    }));
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await port.promote({ candidateId: "candidate-1", material: material() });

    expect(insert.mock.calls[0]?.[1].kind).toBe("other");
  });

  test("provider duplicate/false-success 不批准 candidate，并回滚整个 transaction", async () => {
    const h = harness();
    const insert = vi.fn(async (_client: PostgresCandidatePromotionClient, record: MemoryRecord) => ({
      requestedId: record.id,
      persistedId: "22222222-2222-4222-8222-222222222222",
      stored: false,
    }));
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .rejects.toMatchObject({ code: "PROMOTION_CONFLICT" });

    expect(h.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN",
      expect.stringMatching(/FROM mengshu_candidates/),
      expect.stringMatching(/FROM mengshu_write_receipts/),
      "ROLLBACK",
    ]);
    expect(h.calls.some(({ sql }) => /UPDATE mengshu_candidates/.test(sql))).toBe(false);
  });

  test("approved candidate 缺少原子 receipt 时拒绝 replay", async () => {
    const h = harness({
      candidate: candidateRow({ status: "approved", promoted_to_memory_id: memory().id }),
    });
    const insert = vi.fn();
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .rejects.toMatchObject({ code: "PROMOTION_CONFLICT" });

    expect(insert).not.toHaveBeenCalled();
    expect(h.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("commit 后 release 失败返回 cleanup receipt，不伪装 promotion 失败", async () => {
    const h = harness();
    h.client.release = vi.fn(() => {
      throw new Error("provider release secret");
    });
    const insert = vi.fn(async (_client: PostgresCandidatePromotionClient, record: MemoryRecord) => ({
      requestedId: record.id,
      persistedId: record.id,
      stored: true,
    }));
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    await expect(port.promote({ candidateId: "candidate-1", material: material() }))
      .resolves.toEqual({
        status: "applied",
        candidateId: "candidate-1",
        memoryId: memory().id,
        stored: true,
        cleanupFailed: true,
      });
    expect(h.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("rollback 自身失败时仍返回稳定错误，不泄漏 provider 细节", async () => {
    const h = harness({ failOn: /INSERT INTO mengshu_write_outbox|ROLLBACK/ });
    const insert = vi.fn(async (_client: PostgresCandidatePromotionClient, record: MemoryRecord) => ({
      requestedId: record.id,
      persistedId: record.id,
      stored: true,
    }));
    const port = new PostgresCandidatePromotionPort(h.pool, insert, scope, () => 2_000);

    const failure = await port.promote({ candidateId: "candidate-1", material: material() })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROMOTION_FAILED", retryable: true });
    expect((failure as Error).message).toBe("Postgres candidate promotion failed");
    expect((failure as Error).message).not.toContain("provider secret");
    expect(h.client.release).toHaveBeenCalledTimes(1);
  });

  test("连接失败也返回稳定错误，不向审核 API 泄漏 provider 细节", async () => {
    const port = new PostgresCandidatePromotionPort({
      connect: async () => {
        throw new Error("postgres://user:provider-secret@db.internal/mengshu");
      },
    }, vi.fn(), scope, () => 2_000);

    const failure = await port.promote({ candidateId: "candidate-1", material: material() })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "PROMOTION_FAILED", retryable: true });
    expect((failure as Error).message).toBe("Postgres candidate promotion failed");
    expect((failure as Error).message).not.toContain("provider-secret");
  });
});
