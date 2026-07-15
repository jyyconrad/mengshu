import { describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  PostgresCanonicalGraphReadRepository,
  type PostgresCanonicalGraphReadQueryClient,
} from "./postgres-canonical-read-repository.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "namespace-a",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

const scopeColumns = {
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
};

const entityRow = {
  ...scopeColumns,
  id: "entity-1",
  canonical_name: "mengshu",
  display_name: "Mengshu",
  entity_type: "project",
  aliases: ["梦枢"],
  mention_count: 4,
  mention_count_30d: 3,
  distinct_source_count: 2,
  last_seen_at: "100",
  hotness: 0.8,
  graph_centrality: 0.4,
  query_hits_30d: 1,
  status: "active",
  merged_into: null,
  created_at: "90",
  updated_at: "100",
  metadata: { source: "test" },
};

const relationRow = {
  ...scopeColumns,
  id: "relation-1",
  subject_id: "entity-1",
  predicate: "depends_on",
  object_id: "entity-2",
  confidence: 0.9,
  evidence_chunk_ids: ["chunk-1"],
  evidence_count: 1,
  first_seen_at: "90",
  last_seen_at: "100",
  status: "active",
  source_kinds: ["document"],
  metadata: {},
};

class QueryClient implements PostgresCanonicalGraphReadQueryClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(private readonly responder: (sql: string) => readonly Record<string, unknown>[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ) {
    this.calls.push({ sql, params });
    return { rows: this.responder(sql) as readonly Row[] };
  }
}

function expectCanonicalBinding(call: { sql: string; params: readonly unknown[] }): void {
  expect(call.sql).toContain("scope_fingerprint = $1");
  expect(call.sql).toContain("tenant_id = $2");
  expect(call.sql).toContain("user_id = $3");
  expect(call.sql).toContain("app_id = $4");
  expect(call.sql).toContain("project_id = $5");
  expect(call.sql).toContain("agent_id = $6");
  expect(call.sql).toContain("namespace = $7");
  expect(call.sql).toContain("visibility = $8");
  expect(call.sql).toContain("workspace_id = $9");
  expect(call.sql).toContain("session_id = $10");
  expect(call.params.slice(0, 10)).toEqual([
    scopeColumns.scope_fingerprint,
    scope.tenantId,
    scope.userId,
    scope.appId,
    scope.projectId,
    scope.agentId,
    scope.namespace,
    scope.visibility,
    scope.workspaceId,
    scope.sessionId,
  ]);
}

describe("PostgresCanonicalGraphReadRepository", () => {
  it("accepts the normal 7D scope when workspace and session are omitted", async () => {
    const coreScope: MemoryScope = {
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
    };
    const client = new QueryClient(() => []);
    const repository = new PostgresCanonicalGraphReadRepository(client, coreScope);

    await expect(repository.getEntity("missing-entity")).resolves.toBeUndefined();
    expect(client.calls[0]?.params.slice(0, 10)).toEqual([
      authorityScopeFingerprint(coreScope),
      coreScope.tenantId,
      coreScope.userId,
      coreScope.appId,
      coreScope.projectId,
      coreScope.agentId,
      coreScope.namespace,
      coreScope.visibility,
      "",
      "",
    ]);
  });

  it("maps canonical entity and relation rows without owning a pool or transaction", async () => {
    const client = new QueryClient((sql) => sql.includes("mengshu_graph_entities")
      ? [entityRow]
      : [relationRow]);
    const repository = new PostgresCanonicalGraphReadRepository(client, scope);

    await expect(repository.getEntity("entity-1")).resolves.toMatchObject({
      id: "entity-1",
      scope,
      type: "project",
      lastSeenAt: 100,
    });
    await expect(repository.getRelation("relation-1")).resolves.toMatchObject({
      id: "relation-1",
      scope,
      predicate: "depends_on",
      lastSeenAt: 100,
    });

    expect(client.calls).toHaveLength(2);
    client.calls.forEach(expectCanonicalBinding);
    expect(client.calls.some(({ sql }) => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
  });

  it("binds graph filters and preserves production ordering in fixed SQL", async () => {
    const client = new QueryClient((sql) => sql.includes("mengshu_graph_entities")
      ? [entityRow]
      : [relationRow]);
    const repository = new PostgresCanonicalGraphReadRepository(client, scope);

    await expect(repository.findEntities({
      scope,
      query: "meng",
      type: "project",
      limit: 5,
    })).resolves.toHaveLength(1);
    await expect(repository.findRelations({
      scope,
      entityId: "entity-1",
      predicate: "depends_on",
      limit: 6,
    })).resolves.toHaveLength(1);

    client.calls.forEach(expectCanonicalBinding);
    expect(client.calls[0]?.params.slice(10)).toEqual(["project", "meng", 5]);
    expect(client.calls[0]?.sql).toContain("ORDER BY hotness DESC, mention_count DESC, id");
    expect(client.calls[1]?.params.slice(10)).toEqual(["entity-1", "depends_on", 6]);
    expect(client.calls[1]?.sql).toContain("ORDER BY confidence DESC, evidence_count DESC, id");
  });

  it("rejects cross-scope filters before querying", async () => {
    const client = new QueryClient(() => []);
    const repository = new PostgresCanonicalGraphReadRepository(client, scope);

    await expect(repository.findEntities({
      scope: { ...scope, namespace: "other" },
    })).rejects.toThrow("Canonical graph read scope does not match");
    await expect(repository.findRelations({
      scope: { ...scope, userId: "other" },
    })).rejects.toThrow("Canonical graph read scope does not match");
    await expect(repository.getEntity("entity-1", {
      ...scope,
      workspaceId: "other-workspace",
    })).rejects.toThrow("Canonical graph read scope does not match");
    await expect(repository.getRelation("relation-1", {
      ...scope,
      sessionId: "other-session",
    })).rejects.toThrow("Canonical graph read scope does not match");
    expect(client.calls).toHaveLength(0);
  });

  it("strictly rejects malformed or scope-mismatched rows and duplicate singleton rows", async () => {
    const malformedClient = new QueryClient(() => [{ ...entityRow, aliases: "梦枢" }]);
    await expect(new PostgresCanonicalGraphReadRepository(malformedClient, scope).getEntity("entity-1"))
      .rejects.toThrow("Canonical graph row is invalid");

    const wrongScopeClient = new QueryClient(() => [{ ...relationRow, namespace: "other" }]);
    await expect(new PostgresCanonicalGraphReadRepository(wrongScopeClient, scope).getRelation("relation-1"))
      .rejects.toThrow("Canonical graph row is invalid");

    const duplicateClient = new QueryClient(() => [{}, {}]);
    await expect(new PostgresCanonicalGraphReadRepository(duplicateClient, scope).getEntity("entity-1"))
      .rejects.toThrow("Canonical graph query returned duplicate rows");
  });
});
