import { describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  PostgresCanonicalTreeReadRepository,
  type PostgresCanonicalTreeReadQueryClient,
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

class QueryClient implements PostgresCanonicalTreeReadQueryClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(private readonly responder: (
    sql: string,
    params: readonly unknown[],
  ) => readonly Record<string, unknown>[]) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ) {
    this.calls.push({ sql, params });
    const rows = this.responder(sql, params) as readonly Row[];
    return { rows, rowCount: rows.length };
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

describe("PostgresCanonicalTreeReadRepository", () => {
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
    const repository = new PostgresCanonicalTreeReadRepository(client, coreScope);

    await expect(repository.getLeaf("missing-leaf")).resolves.toBeUndefined();
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

  it("reads leaf, buffer and summary rows through caller-owned client", async () => {
    const client = new QueryClient((sql) => {
      if (sql.includes("FROM mengshu_tree_leaves")) {
        return [{
          ...scopeColumns,
          id: "leaf-1",
          chunk_id: "chunk-1",
          source_id: "source-1",
          entity_ids: ["entity-1"],
          importance: 0.8,
          event_at: "100",
          created_at: "101",
          text: "evidence",
          token_count: 4,
        }];
      }
      if (sql.includes("FROM mengshu_tree_buffers")) {
        return [{
          ...scopeColumns,
          id: "buffer-1",
          tree_type: "topic",
          tree_key: "topic-a",
          level: 0,
          leaf_ids: ["leaf-1"],
          child_node_ids: [],
          token_count: 4,
          opened_at: "100",
          updated_at: "101",
          seal_after_at: null,
        }];
      }
      return [{
        ...scopeColumns,
        id: "summary-1",
        tree_type: "topic",
        tree_key: "topic-a",
        level: 1,
        title: "Topic A",
        summary: "Summary",
        child_node_ids: [],
        leaf_ids: ["leaf-1"],
        evidence_chunk_ids: ["chunk-1"],
        entity_ids: ["entity-1"],
        relation_ids: [],
        token_count: 8,
        start_at: "100",
        end_at: "101",
        status: "sealed",
        created_at: "101",
        sealed_at: "102",
        metadata: { source: "test" },
      }];
    });
    const repository = new PostgresCanonicalTreeReadRepository(client, scope);

    await expect(repository.getLeaf("leaf-1")).resolves.toMatchObject({
      id: "leaf-1",
      scope,
      eventAt: 100,
    });
    await expect(repository.getBuffer("buffer-1")).resolves.toMatchObject({
      id: "buffer-1",
      scope,
      treeType: "topic",
    });
    await expect(repository.getSummary("summary-1")).resolves.toMatchObject({
      id: "summary-1",
      scope,
      timeRange: { startAt: 100, endAt: 101 },
    });

    expect(client.calls).toHaveLength(3);
    client.calls.forEach(expectCanonicalBinding);
    expect(client.calls.some(({ sql }) => /\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(sql))).toBe(false);
  });

  it("preserves requested leaf ordering, binds summary filters and finds a scoped parent", async () => {
    const leaf = (id: string) => ({
      ...scopeColumns,
      id,
      chunk_id: `chunk-${id}`,
      source_id: "source-1",
      entity_ids: [],
      importance: 0.5,
      event_at: 10,
      created_at: 10,
      text: id,
      token_count: 1,
    });
    const summary = {
      ...scopeColumns,
      id: "parent-1",
      tree_type: "source",
      tree_key: "source-1",
      level: 2,
      title: "Parent",
      summary: "Summary",
      child_node_ids: ["child-1"],
      leaf_ids: [],
      evidence_chunk_ids: [],
      entity_ids: [],
      relation_ids: [],
      token_count: 1,
      start_at: 1,
      end_at: 2,
      status: "sealed",
      created_at: 2,
      sealed_at: 2,
      metadata: {},
    };
    const client = new QueryClient((sql) => sql.includes("mengshu_tree_leaves")
      ? [leaf("leaf-2"), leaf("leaf-1")]
      : [summary]);
    const repository = new PostgresCanonicalTreeReadRepository(client, scope);

    await expect(repository.listLeaves(["leaf-1", "leaf-2", "leaf-1"]))
      .resolves.toMatchObject([{ id: "leaf-1" }, { id: "leaf-2" }, { id: "leaf-1" }]);
    await expect(repository.listSummaries({ scope, treeType: "source", treeKey: "source-1" }))
      .resolves.toHaveLength(1);
    await expect(repository.getParent("child-1")).resolves.toMatchObject({ id: "parent-1" });

    client.calls.forEach(expectCanonicalBinding);
    expect(client.calls[1]?.params.slice(10)).toEqual(["source", "source-1"]);
    expect(client.calls[2]?.params[10]).toBe('["child-1"]');
  });

  it("rejects cross-scope filters and malformed database rows", async () => {
    const malformedClient = new QueryClient(() => [{
      ...scopeColumns,
      id: "leaf-1",
      chunk_id: "chunk-1",
      source_id: "source-1",
      entity_ids: "not-json-array",
      importance: 0.5,
      event_at: 1,
      created_at: 1,
      text: "evidence",
      token_count: 1,
    }]);
    const repository = new PostgresCanonicalTreeReadRepository(malformedClient, scope);

    await expect(repository.getLeaf("leaf-1")).rejects.toThrow("Canonical tree row is invalid");
    await expect(repository.listSummaries({
      scope: { ...scope, projectId: "other-project" },
    })).rejects.toThrow("Canonical tree read scope does not match");
    expect(malformedClient.calls).toHaveLength(1);
  });

  it("does not query on empty leaf list and rejects duplicate singleton rows", async () => {
    const client = new QueryClient(() => []);
    const repository = new PostgresCanonicalTreeReadRepository(client, scope);
    await expect(repository.listLeaves([])).resolves.toEqual([]);
    expect(client.calls).toHaveLength(0);

    const duplicateClient = new QueryClient(() => [{}, {}]);
    await expect(new PostgresCanonicalTreeReadRepository(duplicateClient, scope).getLeaf("leaf-1"))
      .rejects.toThrow("Canonical tree query returned duplicate rows");
  });

  it("D-21 resolves an old entity key and dual-reads canonical plus legacy topic summaries", async () => {
    const summary = (id: string, treeKey: string) => ({
      ...scopeColumns,
      id,
      tree_type: "topic",
      tree_key: treeKey,
      level: 1,
      title: treeKey,
      summary: `${treeKey} summary`,
      child_node_ids: [],
      leaf_ids: [`leaf-${id}`],
      evidence_chunk_ids: [`chunk-${id}`],
      entity_ids: ["entity-pg"],
      relation_ids: [],
      token_count: 2,
      start_at: 100,
      end_at: 101,
      status: "sealed",
      created_at: 101,
      sealed_at: 102,
      metadata: {},
    });
    const client = new QueryClient((sql, params) => {
      if (sql.includes("FROM mengshu_topic_tree_aliases")) return [{
        ...scopeColumns,
        legacy_tree_key: "entity-pg",
        canonical_topic_label: "postgresql-migration",
        status: "active",
        merged_from: ["entity-pg"],
        created_at: "90",
        updated_at: "90",
        sealed_node_id: null,
        superseded_at: null,
        archived_at: null,
      }];
      expect(params.at(-1)).toEqual(["postgresql-migration", "entity-pg"]);
      return [
        summary("summary-canonical", "postgresql-migration"),
        summary("summary-legacy", "entity-pg"),
      ];
    });
    const repository = new PostgresCanonicalTreeReadRepository(client, scope);

    await expect(repository.listSummaries({
      scope,
      treeType: "topic",
      treeKey: "entity-pg",
    })).resolves.toMatchObject([
      { id: "summary-canonical", treeKey: "postgresql-migration" },
      { id: "summary-legacy", treeKey: "entity-pg" },
    ]);
    expect(client.calls).toHaveLength(2);
    client.calls.forEach(expectCanonicalBinding);
    expect(client.calls[1]?.sql).toContain("tree_key = ANY");
  });
});
