import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import type { GraphEntityRecord } from "./types.js";
import { deriveAuthoritativeEntityGraph } from "./authoritative-entity-graph-derivation.js";
import {
  persistAuthoritativeEntityGraphWithClient,
  snapshotAuthoritativeEntityGraphDerivation,
  type PostgresAuthoritativeEntityGraphClient,
} from "./postgres-authoritative-entity-graph-effect.js";

const scope: MemoryScope = {
  tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
  agentId: "agent", namespace: "memory", visibility: "private",
  workspaceId: "workspace", sessionId: "session",
};

function graph() {
  const entity: GraphEntityRecord = {
    id: "entity-1", scope, canonicalName: "runtime architecture",
    displayName: "Runtime Architecture", type: "topic", aliases: ["Runtime Architecture"],
    mentionCount: 1, mentionCount30d: 1, distinctSourceCount: 1,
    lastSeenAt: 100, hotness: 0, graphCentrality: 0, queryHits30d: 0,
    status: "active", createdAt: 100, updatedAt: 100, metadata: {},
  };
  return deriveAuthoritativeEntityGraph({
    graphKind: "entity", memoryId: "memory-1",
    evidence: {
      authority: "persisted_evidence",
      evidenceId: "evidence-1", scope, text: "Runtime Architecture",
      sourceId: "source-1", sourceKind: "explicit_save", createdAt: 100,
    },
    extraction: { entities: [entity], relations: [] },
  });
}

describe("Postgres authoritative Entity Graph effect", () => {
  test("provider snapshot 拒绝伪造 evidence ledger/alias，并返回重新派生的冻结 projection", () => {
    const value = graph();
    const snapshot = snapshotAuthoritativeEntityGraphDerivation(value);
    expect(snapshot).toEqual(value);
    expect(Object.isFrozen(snapshot)).toBe(true);

    expect(() => snapshotAuthoritativeEntityGraphDerivation({
      ...value,
      entityEvidenceLinks: value.entityEvidenceLinks.map((link) => ({
        ...link,
        targetId: "forged-entity",
      })),
    })).toThrow(/derivation/i);
    expect(() => snapshotAuthoritativeEntityGraphDerivation({
      ...value,
      aliasProjections: value.aliasProjections.map((alias) => ({
        ...alias,
        sourceId: "forged-source",
      })),
    })).toThrow(/derivation/i);
  });

  test("graph、memory evidence、entity evidence 与 alias 在同一 caller-owned transaction callback 写入", async () => {
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        calls.push({ sql, params });
        if (sql.startsWith("INSERT INTO mengshu_graph_entities")) {
          return { rows: [{ id: "entity-1" }], rowCount: 1 };
        }
        const returning = sql.includes("RETURNING alias_id") ? "alias_id" : "link_id";
        return { rows: [{ [returning]: String(params[0]) }], rowCount: 1 };
      });
    const client: PostgresAuthoritativeEntityGraphClient = {
      query: query as PostgresAuthoritativeEntityGraphClient["query"],
    };

    await expect(persistAuthoritativeEntityGraphWithClient(client, graph())).resolves.toEqual({
      createdEntities: 1, createdRelations: 0, entityIds: ["entity-1"], relationIds: [],
      memoryEvidenceLinks: 1, entityEvidenceLinks: 1, relationEvidenceLinks: 0,
      aliasProjections: 1,
    });
    expect(calls.map(({ sql }) => sql.match(/^INSERT INTO (\S+)/)?.[1])).toEqual([
      "mengshu_graph_entities", "mengshu_memory_evidence_links",
      "mengshu_graph_entity_evidence", "mengshu_graph_entity_aliases",
    ]);
    expect(calls.every(({ sql }) => !/\b(?:BEGIN|COMMIT|ROLLBACK)\b/i.test(sql))).toBe(true);
    expect(calls.slice(1).every(({ sql }) => sql.includes("ON CONFLICT") && sql.includes("DO NOTHING")))
      .toBe(true);
    expect(calls[1]?.params.slice(-3)).toEqual(["grounded_by", "entity_graph", 100]);
  });

  test("相同 projection 重放只返回 graph receipt，不产生重复 ledger mutation", async () => {
    const query = vi.fn(async (sql: string) => {
        if (sql.startsWith("INSERT INTO mengshu_graph_entities")) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("UPDATE mengshu_graph_entities")) {
          return { rows: [{ id: "entity-1" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
    const client: PostgresAuthoritativeEntityGraphClient = {
      query: query as PostgresAuthoritativeEntityGraphClient["query"],
    };
    const result = await persistAuthoritativeEntityGraphWithClient(client, graph());
    expect(result).toMatchObject({
      createdEntities: 0, memoryEvidenceLinks: 0, entityEvidenceLinks: 0,
      relationEvidenceLinks: 0, aliasProjections: 0,
    });
  });

  test("零 entity/relation 仍记录 memory 到 authoritative evidence 的通用 link", async () => {
    const empty = deriveAuthoritativeEntityGraph({
      graphKind: "entity", memoryId: "memory-empty",
      evidence: {
        authority: "persisted_evidence", evidenceId: "evidence-empty", scope,
        text: "No canonical graph facts.", sourceId: "source-empty",
        sourceKind: "explicit_save", createdAt: 321,
      },
      extraction: { entities: [], relations: [] },
    });
    const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return sql.startsWith("INSERT INTO mengshu_memory_evidence_links")
        ? { rows: [{ link_id: params[0] }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    const client: PostgresAuthoritativeEntityGraphClient = {
      query: query as PostgresAuthoritativeEntityGraphClient["query"],
    };

    await expect(persistAuthoritativeEntityGraphWithClient(client, empty)).resolves.toMatchObject({
      entityIds: [], relationIds: [], memoryEvidenceLinks: 1,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.at(-1)).toBe(321);
  });
});
