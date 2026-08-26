import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { SCORING_WEIGHTS_V1 } from "../scoring/scoring-weights.js";
import {
  PostgresEntityGraphQueryHitsPort,
  type PostgresEntityGraphQueryHitsQueryClient,
} from "./postgres-entity-query-hits.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

function result(rows: readonly Record<string, unknown>[] = []) {
  return { rows: [...rows], rowCount: rows.length };
}

describe("PostgresEntityGraphQueryHitsPort", () => {
  test("沿 authoritative Entity Graph evidence ledger 原子更新 queryHits/hotness", async () => {
    const query = vi.fn(async (
      _sql: string,
      _params: readonly unknown[] = [],
    ) => result([
      { entity_id: "entity-a", query_hits_30d: 4, hotness: 9.5 },
      { entity_id: "entity-b", query_hits_30d: 2, hotness: 5.25 },
    ]));
    const port = new PostgresEntityGraphQueryHitsPort({
      query: query as PostgresEntityGraphQueryHitsQueryClient["query"],
    });

    await expect(port.incrementRecallHits({
      memoryIds: ["memory-b", "memory-a", "memory-a"],
      scope,
      occurredAt: 1_723_456_789_000,
    })).resolves.toEqual({
      updatedEntityIds: ["entity-a", "entity-b"],
    });

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("UPDATE mengshu_graph_entities AS entity");
    expect(sql).toContain("mengshu_memory_evidence_links");
    expect(sql).toContain("mengshu_graph_entity_evidence");
    expect(sql).toContain("memory_link.link_kind = 'grounded_by'");
    expect(sql).toContain("memory_link.source = 'entity_graph'");
    expect(sql).toContain("query_hits_30d = entity.query_hits_30d + 1");
    expect(sql).toContain("hotness = entity.hotness + $13");
    expect(sql).toContain("entity.status = 'active'");
    expect(sql).not.toMatch(/\bconfidence\b/i);
    expect(sql).not.toContain("mengshu_work_memory_");
    expect(sql).not.toMatch(/code.?graph/i);
    expect(params).toEqual([
      authorityScopeFingerprint(scope),
      "tenant-a",
      "user-a",
      "codex",
      "project-a",
      "agent-a",
      "memory",
      "private",
      "workspace-a",
      "session-a",
      ["memory-a", "memory-b"],
      1_723_456_789_000,
      SCORING_WEIGHTS_V1.hotness.query_hits_coeff,
    ]);
  });

  test("空命中不查库；非法 identity/scope/result 均 fail closed", async () => {
    const query = vi.fn(async (
      _sql: string,
      _params: readonly unknown[] = [],
    ) => result());
    const port = new PostgresEntityGraphQueryHitsPort({
      query: query as PostgresEntityGraphQueryHitsQueryClient["query"],
    });

    await expect(port.incrementRecallHits({
      memoryIds: [], scope, occurredAt: 10,
    })).resolves.toEqual({ updatedEntityIds: [] });
    expect(query).not.toHaveBeenCalled();

    await expect(port.incrementRecallHits({
      memoryIds: ["unsafe id"], scope, occurredAt: 10,
    })).rejects.toThrow(/query hits input is invalid/i);
    await expect(port.incrementRecallHits({
      memoryIds: ["memory-a"], scope: { ...scope, visibility: undefined }, occurredAt: 10,
    })).rejects.toThrow(/query hits input is invalid/i);
    expect(query).not.toHaveBeenCalled();

    const malformed = new PostgresEntityGraphQueryHitsPort({
      query: vi.fn(async (
        _sql: string,
        _params: readonly unknown[] = [],
      ) => result([
        { entity_id: "entity-a", query_hits_30d: 1, hotness: 2, confidence: 1 },
      ])) as PostgresEntityGraphQueryHitsQueryClient["query"],
    });
    await expect(malformed.incrementRecallHits({
      memoryIds: ["memory-a"], scope, occurredAt: 10,
    })).rejects.toThrow(/query hits result is invalid/i);
  });

  test("provider SQL 错误保持可重试且不降级为内存写", async () => {
    const query = vi.fn(async (
      _sql: string,
      _params: readonly unknown[] = [],
    ) => { throw new Error("postgres unavailable"); });
    const port = new PostgresEntityGraphQueryHitsPort({
      query: query as PostgresEntityGraphQueryHitsQueryClient["query"],
    });

    await expect(port.incrementRecallHits({
      memoryIds: ["memory-a"], scope, occurredAt: 10,
    })).rejects.toThrow("postgres unavailable");
    expect(query).toHaveBeenCalledOnce();
  });
});
