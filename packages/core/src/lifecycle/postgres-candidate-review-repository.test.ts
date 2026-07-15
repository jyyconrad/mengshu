import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { PostgresProvider } from "../db/providers/postgres.js";
import {
  PostgresBoundCandidateReviewRepository,
  PostgresCandidateReviewRepositoryError,
  type PostgresCandidateReviewQueryClient,
} from "./postgres-candidate-review-repository.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

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
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    text: "remember this rule",
    semantic_type: "rules",
    kind: "constraint",
    confidence: 0.9,
    reason: "explicit",
    evidence_ids: ["observation-1"],
    extractor: "llm-v1",
    status: "pending",
    hit_count: 0,
    metadata: { admission: "pending" },
    created_at: "100",
    updated_at: null,
    last_hit_at: null,
    promoted_to_memory_id: null,
    ...overrides,
  };
}

function queueClient(results: Array<{ rows?: readonly Record<string, unknown>[]; rowCount?: number | null }>) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => {
    const next = results.shift() ?? { rows: [], rowCount: 0 };
    return { rows: next.rows ?? [], rowCount: next.rowCount ?? 0 };
  });
  return { client: { query } as PostgresCandidateReviewQueryClient, query };
}

describe("PostgresBoundCandidateReviewRepository", () => {
  test("get binds all 9 authority dimensions and strictly decodes one frozen candidate", async () => {
    const work = queueClient([{ rows: [candidateRow()], rowCount: 1 }]);
    const repository = new PostgresBoundCandidateReviewRepository({ client: work.client, scope });

    const result = await repository.get("candidate-1");

    expect(result).toEqual(expect.objectContaining({
      id: "candidate-1",
      scope,
      status: "pending",
      createdAt: 100,
      evidenceIds: ["observation-1"],
    }));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.scope)).toBe(true);
    const [sql, params] = work.query.mock.calls[0]!;
    expect(sql).toContain("tenant_id = $1 AND user_id = $2 AND app_id = $3");
    expect(sql).toContain("workspace_id = $8 AND session_id = $9");
    expect(sql).toContain("id = $10");
    expect(params).toEqual([
      "tenant-a", "user-a", "mengshu", "project-a", "agent-a",
      "working-context", "private", "workspace-a", "session-a", "candidate-1",
    ]);
  });

  test("list uses fixed parameterized filters, deterministic order and a bounded limit", async () => {
    const work = queueClient([{ rows: [candidateRow()], rowCount: 1 }]);
    const repository = new PostgresBoundCandidateReviewRepository({ client: work.client, scope });

    await expect(repository.list({
      scope,
      status: "pending",
      semanticType: "rules",
      minConfidence: 0.8,
      limit: 25,
    })).resolves.toHaveLength(1);

    const [sql, params] = work.query.mock.calls[0]!;
    expect(sql).toContain("($10::text IS NULL OR status = $10)");
    expect(sql).toContain("($11::text IS NULL OR semantic_type = $11)");
    expect(sql).toContain("($12::double precision IS NULL OR confidence >= $12)");
    expect(sql).toContain("ORDER BY created_at DESC, id");
    expect(sql).toContain("LIMIT $13");
    expect(params?.slice(9)).toEqual(["pending", "rules", 0.8, 25]);
    expect(sql).not.toContain("rules");
  });

  test("refuses a foreign requested scope and foreign/malformed rows before returning data", async () => {
    const work = queueClient([
      { rows: [candidateRow({ workspace_id: "workspace-b" })], rowCount: 1 },
      { rows: [candidateRow(), candidateRow({ id: "candidate-2" })], rowCount: 2 },
    ]);
    const repository = new PostgresBoundCandidateReviewRepository({ client: work.client, scope });

    await expect(repository.list({ scope: { ...scope, sessionId: "session-b" } }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(work.query).not.toHaveBeenCalled();
    await expect(repository.get("candidate-1"))
      .rejects.toMatchObject({ code: "INVALID_RESULT" });
    await expect(repository.get("candidate-1"))
      .rejects.toMatchObject({ code: "INVALID_RESULT" });
  });

  test("status transition is one scope-bound idempotent statement and clears active dedupe identity", async () => {
    const work = queueClient([{ rows: [{
      id: "candidate-1",
      status: "approved",
      promoted_to_memory_id: "memory-1",
      status_reason: null,
      changed: true,
    }], rowCount: 1 }]);
    const repository = new PostgresBoundCandidateReviewRepository({
      client: work.client,
      scope,
      now: () => 500,
    });

    await repository.setStatus("candidate-1", "approved", {
      promotedToMemoryId: "memory-1",
    });

    const [sql, params] = work.query.mock.calls[0]!;
    expect(sql.trimStart()).toMatch(/^WITH transitioned AS/);
    expect(sql).toContain("UPDATE mengshu_candidates");
    expect(sql).toContain("active_content_hash = NULL");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("status = $11");
    expect(sql).toContain("RETURNING id");
    expect(params?.slice(9)).toEqual(["candidate-1", "approved", "memory-1", null, 500]);
  });

  test("status transition is replay-safe and fails closed on a conflicting terminal state", async () => {
    const work = queueClient([
      { rows: [{
        id: "candidate-1",
        status: "approved",
        promoted_to_memory_id: "memory-1",
        status_reason: null,
        changed: false,
      }], rowCount: 1 },
      { rows: [{
        id: "candidate-1",
        status: "rejected",
        promoted_to_memory_id: null,
        status_reason: "policy",
        changed: false,
      }], rowCount: 1 },
    ]);
    const repository = new PostgresBoundCandidateReviewRepository({
      client: work.client,
      scope,
      now: () => 500,
    });

    await expect(repository.setStatus("candidate-1", "approved", {
      promotedToMemoryId: "memory-1",
    })).resolves.toBeUndefined();
    await expect(repository.setStatus("candidate-1", "approved", {
      promotedToMemoryId: "memory-1",
    })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  test("archiveByIds and deleteByIds are bounded, scope-bound and safe to retry", async () => {
    const work = queueClient([
      { rows: [{ id: "candidate-1" }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = new PostgresBoundCandidateReviewRepository({
      client: work.client,
      scope,
      now: () => 500,
    });

    await expect(repository.archiveByIds(["candidate-1"], "manual_review")).resolves.toBe(1);
    await expect(repository.deleteByIds(["candidate-1"])).resolves.toBe(0);

    const [archiveSql, archiveParams] = work.query.mock.calls[0]!;
    expect(archiveSql).toContain("status = 'archived'");
    expect(archiveSql).toContain("status = 'pending'");
    expect(archiveSql).toContain("id = ANY($10::text[])");
    expect(archiveParams?.slice(9)).toEqual([["candidate-1"], "manual_review", 500]);
    const [deleteSql] = work.query.mock.calls[1]!;
    expect(deleteSql.trimStart()).toMatch(/^DELETE FROM mengshu_candidates/);
    expect(deleteSql).toContain("status = 'expired'");
  });

  test("count and eviction use fixed SQL; eviction archives hit rows and deletes never-hit rows atomically", async () => {
    const work = queueClient([
      { rows: [{ count: "2" }], rowCount: 1 },
      { rows: [{ evicted: "3", archived: "4" }], rowCount: 1 },
    ]);
    const repository = new PostgresBoundCandidateReviewRepository({
      client: work.client,
      scope,
      now: () => 40 * 86_400_000,
    });

    await expect(repository.count({ scope, status: "pending" })).resolves.toBe(2);
    await expect(repository.runEvictionScan({ evictionDays: 30, archiveDays: 20 }))
      .resolves.toEqual({ evicted: 3, archived: 4 });

    const [evictionSql, evictionParams] = work.query.mock.calls[1]!;
    expect(evictionSql).toContain("WITH archived AS");
    expect(evictionSql).toContain("DELETE FROM mengshu_candidates");
    expect(evictionSql).toContain("UPDATE mengshu_candidates");
    expect(evictionSql).toContain("last_hit_at IS NULL");
    expect(evictionSql).toContain("last_hit_at IS NOT NULL");
    expect(evictionParams?.slice(9)).toEqual([20 * 86_400_000, 10 * 86_400_000, 40 * 86_400_000]);
  });

  test("readiness and database failures are normalized without leaking the original message", async () => {
    const notReadyQuery = vi.fn();
    const notReady = new PostgresBoundCandidateReviewRepository({
      client: { query: notReadyQuery },
      scope,
      assertReady: () => { throw new Error("secret schema detail"); },
    });
    await expect(notReady.get("candidate-1")).rejects.toMatchObject({
      code: "NOT_READY",
      message: "Candidate review repository is not ready",
    });
    expect(notReadyQuery).not.toHaveBeenCalled();

    const failing = new PostgresBoundCandidateReviewRepository({
      client: { query: vi.fn(async () => { throw new Error("postgres://secret@host/raw"); }) },
      scope,
    });
    const error = await failing.get("candidate-1").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(PostgresCandidateReviewRepositoryError);
    expect(error).toMatchObject({ code: "QUERY_FAILED", message: "Candidate review query failed" });
    expect(String(error)).not.toContain("secret");
  });

  test("rejects invalid ids, filters, transitions and forged clients before SQL", async () => {
    const work = queueClient([]);
    const repository = new PostgresBoundCandidateReviewRepository({ client: work.client, scope });
    await expect(repository.get("bad id")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.list({ limit: 10_001 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.setStatus("candidate-1", "pending"))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.archiveByIds(Array.from({ length: 1_001 }, (_, i) => `id-${i}`)))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(work.query).not.toHaveBeenCalled();

    const getter = vi.fn(() => vi.fn());
    const forged = Object.defineProperty({}, "query", { enumerable: true, get: getter });
    expect(() => new PostgresBoundCandidateReviewRepository({
      client: forged as PostgresCandidateReviewQueryClient,
      scope,
    })).toThrowError(PostgresCandidateReviewRepositoryError);
    expect(getter).not.toHaveBeenCalled();
  });

  test("handles empty reads/batches, default filters and missing transitions deterministically", async () => {
    const work = queueClient([
      { rows: [], rowCount: 0 },
      { rows: [], rowCount: 0 },
      { rows: [{ count: "0" }], rowCount: 1 },
      { rows: [], rowCount: 0 },
      { rows: [{ evicted: "0", archived: "0" }], rowCount: 1 },
    ]);
    const repository = new PostgresBoundCandidateReviewRepository({
      client: work.client,
      scope,
      now: () => 100 * 86_400_000,
    });

    await expect(repository.get("candidate-missing")).resolves.toBeUndefined();
    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.count()).resolves.toBe(0);
    await expect(repository.archiveByIds([])).resolves.toBe(0);
    await expect(repository.deleteByIds([])).resolves.toBe(0);
    await expect(repository.setStatus("candidate-missing", "rejected", { reason: "policy" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.runEvictionScan()).resolves.toEqual({ evicted: 0, archived: 0 });

    expect(work.query).toHaveBeenCalledTimes(5);
    expect(work.query.mock.calls[1]?.[1]?.slice(9)).toEqual([null, null, null, 10_000]);
    expect(work.query.mock.calls[2]?.[1]?.slice(9)).toEqual([null]);
  });
});

describe("PostgresProvider candidate review capability", () => {
  function providerWithSchema(schemaVersion: number, query: ReturnType<typeof vi.fn>) {
    const provider = new PostgresProvider({
      host: "unused",
      port: 5432,
      database: "unused",
      user: "unused",
      password: "unused",
    }, "text-embedding-3-small");
    Object.assign(provider as unknown as Record<string, unknown>, {
      pool: { query },
      schemaVersion,
      schemaContractState: "ready",
    });
    return provider;
  }

  test("mints a scope-bound repository over the provider-owned pool at schema v8+", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({
      rows: [],
      rowCount: 0,
    }));
    const provider = providerWithSchema(8, query);
    const repository = provider.createCandidateReviewRepository(scope);

    await expect(repository.get("candidate-1")).resolves.toBeUndefined();

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("FROM mengshu_candidates");
    expect(query.mock.calls[0]?.[1]).toEqual([
      "tenant-a", "user-a", "mengshu", "project-a", "agent-a",
      "working-context", "private", "workspace-a", "session-a", "candidate-1",
    ]);
  });

  test("fails closed before SQL when the durable candidate schema is unavailable", async () => {
    const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({
      rows: [],
      rowCount: 0,
    }));
    const provider = providerWithSchema(7, query);
    const repository = provider.createCandidateReviewRepository(scope);

    await expect(repository.get("candidate-1")).rejects.toMatchObject({
      code: "QUERY_FAILED",
      message: "Candidate review query failed",
    });
    expect(query).not.toHaveBeenCalled();
  });
});
