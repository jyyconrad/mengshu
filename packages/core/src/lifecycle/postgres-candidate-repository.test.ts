import { createHash } from "node:crypto";
import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  MENGSHU_CANDIDATE_CONFLICT_COLUMNS,
  PostgresCandidateRepository,
  type PostgresCandidateQueryClient,
} from "./postgres-candidate-repository.js";

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

function input(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    text: "remember this rule",
    semanticType: "rules" as const,
    kind: "constraint",
    confidence: 0.9,
    reason: "explicit",
    evidenceIds: ["observation-1"],
    extractor: "llm-v1",
    metadata: { admission: "pending" },
    createdAt: 100,
    ...overrides,
  };
}

const binding = Object.freeze({ sourceJobId: "job-1", scope });

function client(rowCounts: Array<0 | 1> = [1]) {
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => ({
    rows: [],
    rowCount: rowCounts.shift() ?? 0,
  }));
  return { client: { query } as PostgresCandidateQueryClient, query };
}

describe("PostgresCandidateRepository insert-only kernel", () => {
  test("uses full 9D scope, SHA-256 and exact deterministic conflict target", async () => {
    const work = client([1, 0]);
    const repository = new PostgresCandidateRepository();

    await expect(repository.insertPendingWithClient(work.client, binding, input()))
      .resolves.toEqual({ inserted: true, candidateId: "candidate-1" });
    await expect(repository.insertPendingWithClient(work.client, binding, input()))
      .resolves.toEqual({ inserted: false });

    expect(MENGSHU_CANDIDATE_CONFLICT_COLUMNS).toEqual([
      "tenant_id", "user_id", "app_id", "project_id", "agent_id", "namespace",
      "visibility", "workspace_id", "session_id", "active_content_hash",
    ]);
    const [sql, params] = work.query.mock.calls[0]!;
    expect(sql).toContain(
      "ON CONFLICT (tenant_id, user_id, app_id, project_id, agent_id, namespace, visibility, workspace_id, session_id, active_content_hash) DO NOTHING",
    );
    expect(sql).not.toMatch(/RETURNING|SELECT|WITH\s/i);
    expect(params?.slice(1, 10)).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    expect(params).toContain(createHash("sha256").update("remember this rule").digest("hex"));
  });

  test("workspace/session participate in persistence identity instead of cross-session dedupe", async () => {
    const work = client([1, 1]);
    const repository = new PostgresCandidateRepository();

    await repository.insertPendingWithClient(work.client, binding, input());
    await repository.insertPendingWithClient(work.client, {
      ...binding,
      scope: { ...scope, sessionId: "session-b" },
    }, input({
      id: "candidate-2",
    }));

    expect(work.query.mock.calls[0]?.[1]?.[9]).toBe("session-a");
    expect(work.query.mock.calls[1]?.[1]?.[9]).toBe("session-b");
  });

  test("rejects Proxy/getter/toJSON/symbol/extra/sparse inputs without invoking attacker code", async () => {
    const work = client();
    const repository = new PostgresCandidateRepository();
    const getter = vi.fn(() => ({ admission: "pending" }));
    const accessor = input();
    Object.defineProperty(accessor, "metadata", { enumerable: true, get: getter });
    const toJson = input({ metadata: { admission: "pending", toJSON: vi.fn(() => ({})) } });
    const symbol = Object.assign(input(), { [Symbol("extra")]: true });
    const extra = input({ extra: true });
    const sparse = input({ evidenceIds: Array(1) });
    const proxied = new Proxy(input(), { get: vi.fn(Reflect.get) });

    for (const value of [accessor, toJson, symbol, extra, sparse, proxied]) {
      await expect(repository.insertPendingWithClient(work.client, binding, value as never))
        .rejects.toThrow(/candidate input/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(work.query).not.toHaveBeenCalled();
  });

  test("rejects forged query clients and malformed/extended results", async () => {
    const repository = new PostgresCandidateRepository();
    const getter = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const accessorClient = Object.defineProperty({}, "query", { enumerable: true, get: getter });
    await expect(repository.insertPendingWithClient(accessorClient as never, binding, input()))
      .rejects.toThrow(/candidate input/i);
    expect(getter).not.toHaveBeenCalled();

    const extended = {
      query: vi.fn(async () => ({ rows: [], rowCount: 1, command: "INSERT" })),
    };
    await expect(repository.insertPendingWithClient(extended, binding, input()))
      .rejects.toThrow(/candidate input/i);
  });

  test("readiness guard runs before any SQL and normalized result is frozen", async () => {
    const work = client();
    const blocked = new PostgresCandidateRepository({
      assertReady: () => { throw new Error("candidate schema v8 is required"); },
    });
    await expect(blocked.insertPendingWithClient(work.client, binding, input())).rejects.toThrow(/v8/);
    expect(work.query).not.toHaveBeenCalled();

    const result = await new PostgresCandidateRepository().insertPendingWithClient(
      work.client,
      binding,
      input(),
    );
    expect(Object.isFrozen(result)).toBe(true);
  });

  test("rejects bound authority in candidate input and unsafe Unicode before SQL", async () => {
    const work = client();
    const repository = new PostgresCandidateRepository();
    const unsafe = [
      input({ sourceJobId: "job-b" }),
      input({ scope: { ...scope, tenantId: "tenant-b" } }),
      input({ text: "bad\u0000text" }),
      input({ text: "bad\ud800text" }),
      input({ id: "bad\ud800candidate" }),
      input({ evidenceIds: ["bad\udfffobservation"] }),
      input({ reason: "bad\u0001reason" }),
      input({ metadata: { nested: { "bad\u0000key": "value" } } }),
      input({ metadata: { nested: { key: "bad\udfffvalue" } } }),
    ];
    for (const value of unsafe) {
      await expect(repository.insertPendingWithClient(work.client, binding, value as never))
        .rejects.toThrow(/candidate input/i);
    }
    expect(work.query).not.toHaveBeenCalled();
  });

  test("allows ordinary multiline text and JSON strings with tab/LF/CR", async () => {
    const work = client();
    await expect(new PostgresCandidateRepository().insertPendingWithClient(
      work.client,
      binding,
      input({
        text: "line 1\n\tline 2\r\n",
        reason: "line 1\nline 2",
        metadata: { note: "line 1\n\tline 2\r\n" },
      }),
    )).resolves.toEqual({ inserted: true, candidateId: "candidate-1" });
    expect(work.query).toHaveBeenCalledTimes(1);
  });
});
