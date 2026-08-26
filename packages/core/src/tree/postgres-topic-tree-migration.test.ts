import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  archiveSupersededPostgresTopicTrees,
  markPostgresTopicTreesSuperseded,
  mergeLegacyPostgresTopicBuffers,
  persistPostgresTopicTreeAliases,
  resolvePostgresTopicTreeReadKeys,
  type PostgresTopicTreeMigrationQueryClient,
} from "./postgres-topic-tree-migration.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memories",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

const scopeParams = [
  authorityScopeFingerprint(scope), scope.tenantId, scope.userId, scope.appId,
  scope.projectId, scope.agentId, scope.namespace, scope.visibility,
  scope.workspaceId, scope.sessionId,
];

function aliasRow(overrides: Record<string, unknown> = {}) {
  return {
    scope_fingerprint: scopeParams[0],
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    legacy_tree_key: "entity-pg",
    canonical_topic_label: "postgresql-migration",
    status: "active",
    merged_from: ["entity-pg"],
    created_at: "100",
    updated_at: "100",
    sealed_node_id: null,
    superseded_at: null,
    archived_at: null,
    ...overrides,
  };
}

class ScriptedClient implements PostgresTopicTreeMigrationQueryClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(
    private readonly responder: (
      sql: string,
      params: readonly unknown[],
      callIndex: number,
    ) => { rows: readonly Record<string, unknown>[]; rowCount: number },
  ) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ) {
    this.calls.push({ sql, params });
    const result = this.responder(sql, params, this.calls.length - 1);
    return result as { rows: readonly Row[]; rowCount: number };
  }
}

describe("Postgres D-21 topic tree migration", () => {
  test("M1 persists scoped entity.id aliases and records all keys merged into one canonical topic", async () => {
    const rows = [
      aliasRow({ merged_from: ["entity-pg", "entity-postgres"] }),
      aliasRow({
        legacy_tree_key: "entity-postgres",
        merged_from: ["entity-pg", "entity-postgres"],
      }),
    ];
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("legacy_tree_key = ANY")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.startsWith("INSERT")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 2 };
      return { rows, rowCount: rows.length };
    });

    const result = await persistPostgresTopicTreeAliases(client, {
      scope,
      entities: [
        { entityId: "entity-pg", canonicalName: " PostgreSQL Migration " },
        { entityId: "entity-postgres", canonicalName: "postgresql / migration" },
      ],
      now: 100,
    });

    expect(result.map((item) => item.legacyTreeKey)).toEqual([
      "entity-pg", "entity-postgres",
    ]);
    expect(result.every((item) => item.canonicalTopicLabel === "postgresql-migration"))
      .toBe(true);
    expect(result.every((item) => item.mergedFrom.join(",") === "entity-pg,entity-postgres"))
      .toBe(true);
    expect(client.calls.every((call) => call.params.slice(0, 10).join("|") === scopeParams.join("|")))
      .toBe(true);
  });

  test("M1 incremental backfill unions prior aliases instead of replacing historical mergedFrom", async () => {
    const prior = aliasRow({
      legacy_tree_key: "entity-pg",
      merged_from: ["entity-pg"],
    });
    const rows = [
      aliasRow({ merged_from: ["entity-pg", "entity-postgres"] }),
      aliasRow({
        legacy_tree_key: "entity-postgres",
        merged_from: ["entity-pg", "entity-postgres"],
      }),
    ];
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("legacy_tree_key = ANY")) {
        return { rows: [prior], rowCount: 1 };
      }
      if (sql.startsWith("INSERT")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE")) return { rows: [], rowCount: 2 };
      return { rows, rowCount: rows.length };
    });

    const result = await persistPostgresTopicTreeAliases(client, {
      scope,
      entities: [{ entityId: "entity-postgres", canonicalName: "PostgreSQL Migration" }],
      now: 110,
    });

    expect(result).toHaveLength(2);
    expect(result.every((item) =>
      item.mergedFrom.join(",") === "entity-pg,entity-postgres")).toBe(true);
    expect(client.calls.find(({ sql }) => sql.startsWith("INSERT"))?.params)
      .toContain(JSON.stringify(["entity-pg", "entity-postgres"]));
  });

  test("M1 fails closed instead of rebinding an existing legacy key to another canonical topic", async () => {
    const existing = aliasRow({ canonical_topic_label: "original-topic" });
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("legacy_tree_key = ANY")) {
        return { rows: [existing], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(persistPostgresTopicTreeAliases(client, {
      scope,
      entities: [{ entityId: "entity-pg", canonicalName: "Replacement Topic" }],
      now: 110,
    })).rejects.toThrow("Postgres topic tree migration row is invalid");
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("FOR UPDATE");
  });

  test("M1 treats a superseded same-label mapping as immutable idempotent state", async () => {
    const existing = aliasRow({
      status: "superseded",
      updated_at: "200",
      sealed_node_id: "summary-1",
      superseded_at: "200",
    });
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("legacy_tree_key = ANY")) {
        return { rows: [existing], rowCount: 1 };
      }
      if (sql.startsWith("INSERT") || sql.startsWith("UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [existing], rowCount: 1 };
    });

    await expect(persistPostgresTopicTreeAliases(client, {
      scope,
      entities: [{ entityId: "entity-pg", canonicalName: "PostgreSQL Migration" }],
      now: 210,
    })).resolves.toMatchObject([{ status: "superseded", updatedAt: 200 }]);
    expect(client.calls.find(({ sql }) => sql.startsWith("UPDATE"))?.sql)
      .toContain("status = 'active'");
  });

  test("M1 preserves an archived same-label mapping without reactivating or rewriting it", async () => {
    const existing = aliasRow({
      status: "archived",
      updated_at: "300",
      sealed_node_id: "summary-1",
      superseded_at: "200",
      archived_at: "300",
    });
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("SELECT") && sql.includes("legacy_tree_key = ANY")) {
        return { rows: [existing], rowCount: 1 };
      }
      if (sql.startsWith("INSERT") || sql.startsWith("UPDATE")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [existing], rowCount: 1 };
    });

    await expect(persistPostgresTopicTreeAliases(client, {
      scope,
      entities: [{ entityId: "entity-pg", canonicalName: "PostgreSQL Migration" }],
      now: 310,
    })).resolves.toMatchObject([{ status: "archived", updatedAt: 300 }]);
    expect(client.calls.filter(({ sql }) => sql.startsWith("UPDATE")))
      .toSatisfy((calls: Array<{ sql: string }>) =>
        calls.every(({ sql }) => sql.includes("status = 'active'")));
  });

  test("M2 dual-read resolves canonical and legacy keys within scope; unknown alias falls back canonical", async () => {
    const aliases = [
      aliasRow({ merged_from: ["entity-pg", "entity-postgres"] }),
      aliasRow({
        legacy_tree_key: "entity-postgres",
        status: "superseded",
        merged_from: ["entity-pg", "entity-postgres"],
        sealed_node_id: "summary-1",
        superseded_at: "200",
        updated_at: "200",
      }),
    ];
    const client = new ScriptedClient((_sql, _params, index) => index === 0
      ? { rows: aliases, rowCount: aliases.length }
      : { rows: [], rowCount: 0 });

    await expect(resolvePostgresTopicTreeReadKeys(client, {
      scope,
      requestedTreeKey: "entity-pg",
    })).resolves.toMatchObject({
      canonicalTopicLabel: "postgresql-migration",
      readTreeKeys: ["postgresql-migration", "entity-pg", "entity-postgres"],
    });
    await expect(resolvePostgresTopicTreeReadKeys(client, {
      scope,
      requestedTreeKey: " New Topic ",
    })).resolves.toMatchObject({
      canonicalTopicLabel: "new-topic",
      readTreeKeys: ["new-topic"],
    });
    expect(client.calls[0]?.params.slice(0, 10)).toEqual(scopeParams);
    expect(client.calls[0]?.sql).toContain("scope_fingerprint = $1");
  });

  test("M2 rejects malformed rows and an alias from another full scope", async () => {
    const malformed = new ScriptedClient(() => ({
      rows: [aliasRow({ merged_from: "entity-pg" })], rowCount: 1,
    }));
    await expect(resolvePostgresTopicTreeReadKeys(malformed, {
      scope,
      requestedTreeKey: "entity-pg",
    })).rejects.toThrow("Postgres topic tree migration row is invalid");

    const crossScope = new ScriptedClient(() => ({
      rows: [aliasRow({ project_id: "project-b" })], rowCount: 1,
    }));
    await expect(resolvePostgresTopicTreeReadKeys(crossScope, {
      scope,
      requestedTreeKey: "entity-pg",
    })).rejects.toThrow("Postgres topic tree migration row is invalid");
  });

  test("M3/M4 merges multiple legacy buffers into the canonical buffer without deleting old trees", async () => {
    const aliases = [
      aliasRow({ merged_from: ["entity-pg", "entity-postgres"] }),
      aliasRow({
        legacy_tree_key: "entity-postgres",
        merged_from: ["entity-pg", "entity-postgres"],
      }),
    ];
    const buffers = [{
      id: "canonical-buffer",
      tree_key: "postgresql-migration",
      leaf_ids: ["leaf-canonical", "leaf-shared"],
      child_node_ids: ["child-canonical"],
      token_count: "7",
      opened_at: "90",
      updated_at: "100",
    }, {
      id: "legacy-buffer-pg",
      tree_key: "entity-pg",
      leaf_ids: ["leaf-pg", "leaf-shared"],
      child_node_ids: ["child-pg"],
      token_count: "5",
      opened_at: "70",
      updated_at: "95",
    }, {
      id: "legacy-buffer-postgres",
      tree_key: "entity-postgres",
      leaf_ids: ["leaf-postgres"],
      child_node_ids: [],
      token_count: "3",
      opened_at: "80",
      updated_at: "96",
    }];
    const client = new ScriptedClient((sql) => {
      if (sql.includes("FROM mengshu_topic_tree_aliases")) {
        return { rows: aliases, rowCount: aliases.length };
      }
      if (sql.startsWith("SELECT") && sql.includes("FROM mengshu_tree_buffers")) {
        return { rows: buffers, rowCount: buffers.length };
      }
      if (sql.includes("FROM mengshu_tree_leaves")) {
        const rows = [
          { id: "leaf-canonical", token_count: "4" },
          { id: "leaf-shared", token_count: "3" },
          { id: "leaf-pg", token_count: "5" },
          { id: "leaf-postgres", token_count: "3" },
        ];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 1 };
    });

    const merged = await mergeLegacyPostgresTopicBuffers(client, {
      scope,
      requestedTreeKey: "entity-pg",
      canonicalBufferId: "canonical-buffer",
      level: 0,
      now: 110,
    });

    expect(merged).toMatchObject({
      canonicalTopicLabel: "postgresql-migration",
      canonicalBufferId: "canonical-buffer",
      leafIds: ["leaf-canonical", "leaf-shared", "leaf-pg", "leaf-postgres"],
      childNodeIds: ["child-canonical", "child-pg"],
      tokenCount: 15,
      mergedFrom: ["entity-pg", "entity-postgres"],
      converged: true,
    });
    expect(client.calls.some(({ sql }) => /\bDELETE\b/i.test(sql))).toBe(false);
    expect(client.calls.find(({ sql }) => sql.startsWith("UPDATE"))?.params)
      .toContain("canonical-buffer");
  });

  test("M3 convergence replay is idempotent when the canonical buffer already contains legacy leaves", async () => {
    const aliases = [aliasRow()];
    const buffers = [{
      id: "canonical-buffer", tree_key: "postgresql-migration",
      leaf_ids: ["leaf-1"], child_node_ids: [], token_count: "4",
      opened_at: "90", updated_at: "100",
    }, {
      id: "legacy-buffer", tree_key: "entity-pg",
      leaf_ids: ["leaf-1"], child_node_ids: [], token_count: "4",
      opened_at: "80", updated_at: "95",
    }];
    const client = new ScriptedClient((sql) => {
      if (sql.includes("FROM mengshu_topic_tree_aliases")) return { rows: aliases, rowCount: 1 };
      if (sql.includes("FROM mengshu_tree_buffers")) return { rows: buffers, rowCount: 2 };
      if (sql.includes("FROM mengshu_tree_leaves")) {
        return { rows: [{ id: "leaf-1", token_count: "4" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(mergeLegacyPostgresTopicBuffers(client, {
      scope,
      requestedTreeKey: "postgresql-migration",
      canonicalBufferId: "canonical-buffer",
      level: 0,
      now: 110,
    })).resolves.toMatchObject({ tokenCount: 4, converged: false });
  });

  test("M3 does not merge a superseded legacy buffer again while M2 keeps it readable", async () => {
    const aliases = [aliasRow({
      status: "superseded",
      updated_at: "120",
      sealed_node_id: "summary-1",
      superseded_at: "120",
    })];
    const canonical = {
      id: "canonical-buffer", tree_key: "postgresql-migration",
      leaf_ids: ["leaf-new"], child_node_ids: [], token_count: "3",
      opened_at: "121", updated_at: "121",
    };
    const client = new ScriptedClient((sql, params) => {
      if (sql.includes("FROM mengshu_topic_tree_aliases")) {
        return { rows: aliases, rowCount: aliases.length };
      }
      if (sql.includes("FROM mengshu_tree_buffers")) {
        expect(params.at(-2)).toEqual(["postgresql-migration"]);
        return { rows: [canonical], rowCount: 1 };
      }
      if (sql.includes("FROM mengshu_tree_leaves")) {
        return { rows: [{ id: "leaf-new", token_count: "3" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(mergeLegacyPostgresTopicBuffers(client, {
      scope,
      requestedTreeKey: "postgresql-migration",
      canonicalBufferId: "canonical-buffer",
      level: 0,
      now: 121,
    })).resolves.toMatchObject({
      leafIds: ["leaf-new"],
      mergedFrom: [],
      converged: false,
    });
  });

  test("M3 marks all merged legacy trees superseded only after seal and retains mergedFrom", async () => {
    const rows = [
      aliasRow({
        status: "superseded",
        merged_from: ["entity-pg", "entity-postgres"],
        updated_at: "200",
        sealed_node_id: "summary-1",
        superseded_at: "200",
      }),
      aliasRow({
        legacy_tree_key: "entity-postgres",
        status: "superseded",
        merged_from: ["entity-pg", "entity-postgres"],
        updated_at: "200",
        sealed_node_id: "summary-1",
        superseded_at: "200",
      }),
    ];
    const client = new ScriptedClient((sql) => sql.startsWith("UPDATE")
      ? { rows, rowCount: rows.length }
      : { rows: [], rowCount: 0 });

    await expect(markPostgresTopicTreesSuperseded(client, {
      scope,
      canonicalTopicLabel: "postgresql-migration",
      mergedFrom: ["entity-pg", "entity-postgres"],
      sealedNodeId: "summary-1",
      now: 200,
    })).resolves.toMatchObject([
      { status: "superseded", sealedNodeId: "summary-1", supersededAt: 200 },
      { status: "superseded", sealedNodeId: "summary-1", supersededAt: 200 },
    ]);
    expect(client.calls[0]?.sql).toContain("status = 'superseded'");
    expect(client.calls[0]?.sql).not.toMatch(/\bDELETE\b/i);
  });

  test("M3 rejects a supersede receipt that does not exactly match the requested aliases", async () => {
    const client = new ScriptedClient(() => ({
      rows: [aliasRow({
        status: "superseded",
        merged_from: ["entity-pg", "entity-postgres"],
        updated_at: "200",
        sealed_node_id: "wrong-summary",
        superseded_at: "200",
      })],
      rowCount: 1,
    }));

    await expect(markPostgresTopicTreesSuperseded(client, {
      scope,
      canonicalTopicLabel: "postgresql-migration",
      mergedFrom: ["entity-pg", "entity-postgres"],
      sealedNodeId: "summary-1",
      now: 200,
    })).rejects.toThrow("Postgres topic tree migration row is invalid");
  });

  test("M5 archives superseded aliases after the grace cutoff without deleting rollback evidence", async () => {
    const rows = [aliasRow({
      status: "archived", updated_at: "300", sealed_node_id: "summary-1",
      superseded_at: "200", archived_at: "300",
    })];
    const client = new ScriptedClient((sql) => {
      if (sql.startsWith("UPDATE mengshu_topic_tree_aliases")) {
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith("UPDATE mengshu_tree_summary_nodes")) {
        return { rows: [], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(archiveSupersededPostgresTopicTrees(client, {
      scope,
      supersededBefore: 250,
      now: 300,
    })).resolves.toMatchObject([{ status: "archived", archivedAt: 300 }]);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]?.sql).toContain("status = 'superseded'");
    expect(client.calls[0]?.sql).toContain("NOT EXISTS");
    expect(client.calls[0]?.sql).toContain("old_buffer.updated_at");
    expect(client.calls[0]?.sql).toContain("old_summary.created_at");
    expect(client.calls[1]?.sql).toContain("UPDATE mengshu_tree_summary_nodes");
    expect(client.calls[1]?.sql).toContain("status = 'archived'");
    expect(client.calls[1]?.params.at(-1)).toEqual(["entity-pg"]);
    expect(client.calls.every(({ sql }) => !/\bDELETE\b/i.test(sql))).toBe(true);
  });
});
