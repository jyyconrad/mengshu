import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  PostgresCanonicalEntityCentralityRefresh,
  type PostgresCanonicalEntityCentralityClient,
} from "./postgres-canonical-entity-centrality-refresh.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

function result(overrides: Record<string, unknown> = {}) {
  return {
    active_entity_count: "3",
    active_relation_count: "2",
    invalid_relation_count: "0",
    updated_count: "3",
    centralities: {
      "entity-a": 1,
      "entity-b": 0.5,
      "entity-c": 0.5,
    },
    ...overrides,
  };
}

describe("Postgres canonical Entity centrality refresh", () => {
  test("在完整 AuthorityScope 内按 active degree/maxDegree 更新 canonical centrality", async () => {
    const query = vi.fn(async () => ({ rows: [result()], rowCount: 1 }));
    const refresh = new PostgresCanonicalEntityCentralityRefresh({
      query: query as PostgresCanonicalEntityCentralityClient["query"],
    });
    const signal = new AbortController().signal;

    await expect(refresh.refresh({ scope, now: 2_000, signal })).resolves.toEqual({
      activeEntityCount: 3,
      activeRelationCount: 2,
      updatedCount: 3,
      centralities: {
        "entity-a": 1,
        "entity-b": 0.5,
        "entity-c": 0.5,
      },
    });

    const [sql, params] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("WITH active_entities AS MATERIALIZED");
    expect(sql).toContain("active_relations AS MATERIALIZED");
    expect(sql).toContain("status = 'active'");
    expect(sql).toContain("graph_centrality =");
    expect(sql).toContain("updated_at =");
    expect(sql).not.toMatch(/mention_count\s*=/);
    expect(sql).not.toMatch(/distinct_source_count\s*=/);
    expect(sql).not.toMatch(/query_hits_30d\s*=/);
    expect(sql).not.toMatch(/hotness\s*=/);
    expect(params).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId, 2_000,
    ]);
  });

  test("无 active relation 时仍持久化 0 centrality", async () => {
    const query = vi.fn(async () => ({
      rows: [result({
        active_entity_count: "2",
        active_relation_count: "0",
        updated_count: "2",
        centralities: { "entity-a": 0, "entity-b": 0 },
      })],
      rowCount: 1,
    }));
    const refresh = new PostgresCanonicalEntityCentralityRefresh({
      query: query as PostgresCanonicalEntityCentralityClient["query"],
    });

    await expect(refresh.refresh({
      scope,
      now: 2_000,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      activeRelationCount: 0,
      centralities: { "entity-a": 0, "entity-b": 0 },
    });
  });

  test("跨 active entity 的关系或更新计数不完整时 fail-closed", async () => {
    for (const row of [
      result({ invalid_relation_count: "1", updated_count: "0" }),
      result({ updated_count: "2" }),
      result({ centralities: { "entity-a": 2 } }),
    ]) {
      const refresh = new PostgresCanonicalEntityCentralityRefresh({
        query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) as
          unknown as PostgresCanonicalEntityCentralityClient["query"],
      });
      await expect(refresh.refresh({
        scope,
        now: 2_000,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: "POSTGRES_CANONICAL_ENTITY_CENTRALITY_REFRESH_INVALID",
      });
    }
  });

  test("查询前后 abort 原样终止", async () => {
    const before = new AbortController();
    before.abort();
    const beforeQuery = vi.fn();
    await expect(new PostgresCanonicalEntityCentralityRefresh({ query: beforeQuery }).refresh({
      scope,
      now: 2_000,
      signal: before.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeQuery).not.toHaveBeenCalled();

    const after = new AbortController();
    const afterQuery = vi.fn(async () => {
      after.abort();
      return { rows: [result()], rowCount: 1 };
    });
    await expect(new PostgresCanonicalEntityCentralityRefresh({
      query: afterQuery as PostgresCanonicalEntityCentralityClient["query"],
    }).refresh({
      scope,
      now: 2_000,
      signal: after.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
