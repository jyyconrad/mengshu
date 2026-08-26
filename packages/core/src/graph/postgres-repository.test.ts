import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  MENGSHU_GRAPH_ENTITY_CONFLICT_COLUMNS,
  MENGSHU_GRAPH_ENTITY_RELATION,
  MENGSHU_GRAPH_RELATION_CONFLICT_COLUMNS,
  MENGSHU_GRAPH_RELATION_RELATION,
  PostgresGraphRepository,
  type PostgresGraphQueryClient,
  type PostgresGraphQueryResult,
} from "./postgres-repository.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

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

function entity(id: string, overrides: Partial<GraphEntityRecord> = {}): GraphEntityRecord {
  return {
    id,
    scope,
    canonicalName: id,
    displayName: id,
    type: "project",
    aliases: [id],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: 100,
    hotness: 0.5,
    graphCentrality: 0.25,
    queryHits30d: 0,
    status: "active",
    createdAt: 100,
    updatedAt: 100,
    metadata: { source: "llm" },
    ...overrides,
  };
}

function relation(
  id: string,
  subjectId = "entity-1",
  objectId = "entity-2",
  overrides: Partial<GraphRelationRecord> = {},
): GraphRelationRecord {
  return {
    id,
    scope,
    subjectId,
    predicate: "depends_on",
    objectId,
    confidence: 0.9,
    evidenceChunkIds: ["chunk-1"],
    evidenceCount: 1,
    firstSeenAt: 100,
    lastSeenAt: 100,
    status: "active",
    sourceKinds: ["llm"],
    metadata: { source: "llm" },
    ...overrides,
  };
}

type QueryCall = readonly [sql: string, params?: readonly unknown[]];

function result<Row extends Record<string, unknown>>(
  rows: readonly Row[],
  rowCount = rows.length,
): PostgresGraphQueryResult<Row> {
  return { rows, rowCount };
}

function scriptedClient(results: readonly PostgresGraphQueryResult[]) {
  const queue = [...results];
  const query = vi.fn(async (_sql: string, _params: readonly unknown[] = []) => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected query");
    return next;
  });
  return { client: { query } as PostgresGraphQueryClient, query, queue };
}

describe("PostgresGraphRepository transaction kernel", () => {
  test("uses fixed relations and full 9D scope for deterministic inserts", async () => {
    const work = scriptedClient([
      result([{ id: "entity-1" }]),
      result([{ id: "entity-2" }]),
      result([{ id: "entity-1" }, { id: "entity-2" }]),
      result([{ id: "relation-1" }]),
    ]);
    const repository = new PostgresGraphRepository();

    await expect(repository.upsertGraphWithClient(
      work.client,
      scope,
      [entity("entity-1"), entity("entity-2")],
      [relation("relation-1")],
    )).resolves.toEqual({
      createdEntities: 2,
      createdRelations: 1,
      entityIds: ["entity-1", "entity-2"],
      relationIds: ["relation-1"],
    });

    expect(MENGSHU_GRAPH_ENTITY_RELATION).toBe("mengshu_graph_entities");
    expect(MENGSHU_GRAPH_RELATION_RELATION).toBe("mengshu_graph_relations");
    expect(MENGSHU_GRAPH_ENTITY_CONFLICT_COLUMNS).toEqual([
      "scope_fingerprint", "id",
    ]);
    expect(MENGSHU_GRAPH_RELATION_CONFLICT_COLUMNS).toEqual(MENGSHU_GRAPH_ENTITY_CONFLICT_COLUMNS);

    const [entitySql, entityParams] = work.query.mock.calls[0] as QueryCall;
    expect(entitySql).toContain("INSERT INTO mengshu_graph_entities");
    expect(entitySql).toContain(
      "ON CONFLICT (scope_fingerprint, id) DO NOTHING",
    );
    expect(entitySql).toMatch(/RETURNING id\s*$/);
    expect(entitySql).not.toMatch(/scope\s+JSON|scope_key|\$\{/i);
    expect(entityParams?.[1]).toBe(authorityScopeFingerprint(scope));
    expect(entityParams?.slice(2, 11)).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);

    const [endpointSql, endpointParams] = work.query.mock.calls[2] as QueryCall;
    expect(endpointSql).toContain("FROM mengshu_graph_entities");
    expect(endpointSql).toContain("id = ANY($11::text[])");
    expect(endpointParams?.slice(0, 10)).toEqual(entityParams?.slice(1, 11));
    expect(endpointParams?.[10]).toEqual(["entity-1", "entity-2"]);

    const [relationSql] = work.query.mock.calls[3] as QueryCall;
    expect(relationSql).toContain("INSERT INTO mengshu_graph_relations");
    expect(relationSql).not.toMatch(/\$\{/);
    expect(work.queue).toHaveLength(0);
  });

  test("updates conflicts, preserves input id order and reports only actual creates", async () => {
    const work = scriptedClient([
      result([], 0),
      result([{ id: "entity-2" }]),
      result([{ id: "entity-1" }]),
      result([{ id: "entity-1" }, { id: "entity-2" }]),
      result([], 0),
      result([{ id: "relation-1" }]),
    ]);

    await expect(new PostgresGraphRepository().upsertGraphWithClient(
      work.client,
      scope,
      [entity("entity-2"), entity("entity-1")],
      [relation("relation-1")],
    )).resolves.toEqual({
      createdEntities: 1,
      createdRelations: 0,
      entityIds: ["entity-2", "entity-1"],
      relationIds: ["relation-1"],
    });

    const [entityUpdateSql, entityUpdateParams] = work.query.mock.calls[1] as QueryCall;
    expect(entityUpdateSql).toContain("UPDATE mengshu_graph_entities SET");
    expect(entityUpdateSql).toContain("jsonb_array_elements_text");
    expect(entityUpdateSql).toContain("mention_count = mention_count + $16");
    expect(entityUpdateSql).toContain("WHEN $19::bigint IS NULL THEN last_seen_at");
    expect(entityUpdateSql).toContain("metadata = metadata || $27::jsonb");
    expect(entityUpdateSql).toContain("RETURNING id");
    expect(entityUpdateParams?.[0]).toBe("entity-2");

    const [relationUpdateSql] = work.query.mock.calls[5] as QueryCall;
    expect(relationUpdateSql).toContain("UPDATE mengshu_graph_relations SET");
    expect(relationUpdateSql).toContain("evidence_count = (");
    expect(relationUpdateSql).toContain("source_kinds = (");
    expect(relationUpdateSql).toContain(
      "AND $17::bigint = jsonb_array_length($16::jsonb)",
    );
  });

  test("accepts relations referencing existing same-scope entities", async () => {
    const work = scriptedClient([
      result([{ id: "existing-a" }, { id: "existing-b" }]),
      result([{ id: "relation-1" }]),
    ]);

    await expect(new PostgresGraphRepository().upsertGraphWithClient(
      work.client,
      scope,
      [],
      [relation("relation-1", "existing-a", "existing-b")],
    )).resolves.toEqual({
      createdEntities: 0,
      createdRelations: 1,
      entityIds: [],
      relationIds: ["relation-1"],
    });
  });

  test("rejects a dangling/cross-scope endpoint before relation writes", async () => {
    const work = scriptedClient([
      result([{ id: "entity-1" }]),
      result([{ id: "entity-1" }]),
    ]);

    await expect(new PostgresGraphRepository().upsertGraphWithClient(
      work.client,
      scope,
      [entity("entity-1")],
      [relation("relation-1")],
    )).rejects.toThrow(/relation endpoint/i);
    expect(work.query).toHaveBeenCalledTimes(2);
  });

  test("snapshots batches strictly before readiness or SQL", async () => {
    const query = vi.fn();
    const assertReady = vi.fn();
    const repository = new PostgresGraphRepository({ assertReady });
    const accessor = entity("entity-1");
    const getter = vi.fn(() => "entity-1");
    Object.defineProperty(accessor, "displayName", { enumerable: true, get: getter });
    const proxied = new Proxy(entity("entity-2"), { get: vi.fn(Reflect.get) });
    const extra = { ...entity("entity-3"), unexpected: true };
    const sparse = Array(1) as GraphEntityRecord[];

    const invalidBatches: GraphEntityRecord[][] = [
      [accessor], [proxied as GraphEntityRecord], [extra as GraphEntityRecord], sparse,
    ];
    for (const entities of invalidBatches) {
      await expect(repository.upsertGraphWithClient(
        { query }, scope, entities, [],
      )).rejects.toThrow(/graph input/i);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(assertReady).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  test("限制单 effect graph 输出总量，避免持锁事务超过 lease", async () => {
    const query = vi.fn();
    const repository = new PostgresGraphRepository();
    const entities = Array.from({ length: 33 }, (_, index) => entity(`entity-${index}`));

    await expect(repository.upsertGraphWithClient({ query }, scope, entities, []))
      .rejects.toThrow(/graph input/i);
    expect(query).not.toHaveBeenCalled();
  });

  test("rejects invalid scope, duplicate ids, lifecycle, evidence and JSON snapshots", async () => {
    const query = vi.fn();
    const repository = new PostgresGraphRepository();
    const cases: Array<readonly [MemoryScope, GraphEntityRecord[], GraphRelationRecord[]]> = [
      [{ ...scope, visibility: undefined }, [entity("entity-1")], []],
      [scope, [entity("entity-1"), entity("entity-1")], []],
      [scope, [entity("entity-1", { scope: { ...scope, projectId: "other" } })], []],
      [scope, [entity("entity-1", { updatedAt: 99 })], []],
      [scope, [entity("entity-1", { aliases: ["same", "same"] })], []],
      [scope, [entity("entity-1", { metadata: { n: Number.NaN } })], []],
      [scope, [entity("entity-1")], [relation("relation-1", "entity-1", "entity-1", {
        evidenceCount: 2,
      })]],
      [scope, [entity("entity-1")], [relation("relation-1", "entity-1", "entity-1")]],
      [scope, [entity("entity-1")], [relation("relation-1", "entity-1", "entity-1", {
        evidenceChunkIds: [], evidenceCount: 0,
      })]],
    ];

    for (const [requestScope, entities, relations] of cases) {
      await expect(repository.upsertGraphWithClient(
        { query }, requestScope, entities, relations,
      )).rejects.toThrow(/graph input/i);
    }
    expect(query).not.toHaveBeenCalled();
  });

  test("rejects forged clients and malformed SQL results", async () => {
    const repository = new PostgresGraphRepository();
    const getter = vi.fn(async () => result([{ id: "entity-1" }]));
    const accessorClient = Object.defineProperty({}, "query", { enumerable: true, get: getter });
    await expect(repository.upsertGraphWithClient(
      accessorClient as PostgresGraphQueryClient, scope, [entity("entity-1")], [],
    )).rejects.toThrow(/graph input/i);
    expect(getter).not.toHaveBeenCalled();

    const extendedResult = {
      query: vi.fn(async () => ({ rows: [{ id: "entity-1" }], rowCount: 1, command: "INSERT" })),
    };
    await expect(repository.upsertGraphWithClient(
      extendedResult as unknown as PostgresGraphQueryClient, scope, [entity("entity-1")], [],
    )).rejects.toThrow(/graph query result/i);

    const wrongId = scriptedClient([result([{ id: "entity-other" }])]);
    await expect(repository.upsertGraphWithClient(
      wrongId.client, scope, [entity("entity-1")], [],
    )).rejects.toThrow(/graph query result/i);
  });

  test("readiness guard runs after snapshots and returned result is deeply frozen", async () => {
    const blocked = new PostgresGraphRepository({
      assertReady: () => { throw new Error("graph schema v9 is required"); },
    });
    const query = vi.fn();
    await expect(blocked.upsertGraphWithClient(
      { query }, scope, [entity("entity-1")], [],
    )).rejects.toThrow(/v9/);
    expect(query).not.toHaveBeenCalled();

    const work = scriptedClient([result([{ id: "entity-1" }])]);
    const persisted = await new PostgresGraphRepository().upsertGraphWithClient(
      work.client, scope, [entity("entity-1")], [],
    );
    expect(Object.isFrozen(persisted)).toBe(true);
    expect(Object.isFrozen(persisted.entityIds)).toBe(true);
    expect(Object.isFrozen(persisted.relationIds)).toBe(true);
  });
});
