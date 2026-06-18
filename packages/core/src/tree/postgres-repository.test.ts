import { describe, expect, test } from "vitest";
import { PostgresTreeRepository } from "./postgres-repository.js";
import type { TreeLeaf } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

class FakePool {
  public readonly calls: Array<{ sql: string; params?: unknown[] }> = [];
  private readonly rows = new Map<string, any>();

  async query(sql: string, params?: unknown[]) {
    this.calls.push({ sql, params });
    if (sql.includes("SELECT * FROM tree_leaves WHERE id = ANY")) {
      return { rows: (params?.[0] as string[]).map((id) => this.rows.get(id)).filter(Boolean) };
    }
    if (sql.includes("SELECT * FROM tree_leaves WHERE id = $1")) {
      const row = this.rows.get(String(params?.[0]));
      return { rows: row ? [row] : [] };
    }
    if (/INSERT INTO tree_leaves/.test(sql)) {
      this.rows.set(String(params?.[0]), {
        id: params?.[0],
        scope: JSON.parse(String(params?.[2])),
        chunk_id: params?.[3],
        source_id: params?.[4],
        entity_ids: JSON.parse(String(params?.[5])),
        importance: params?.[6],
        event_at: new Date(String(params?.[7])),
        created_at: new Date(String(params?.[8])),
        text: params?.[9],
        token_count: params?.[10],
      });
    }
    return { rows: [], rowCount: 0 };
  }

  async end() {}
}

function leaf(id: string): TreeLeaf {
  return {
    id,
    scope,
    chunkId: `chunk-${id}`,
    sourceId: "source-1",
    entityIds: ["entity-1"],
    importance: 0.8,
    eventAt: 1710000000000,
    createdAt: 1710000000000,
    text: "durable tree leaf",
    tokenCount: 4,
  };
}

describe("PostgresTreeRepository", () => {
  test("initializes schema and round-trips leaves through injected pool", async () => {
    const pool = new FakePool();
    const repository = new PostgresTreeRepository(pool as any);

    await repository.upsertLeaf(leaf("leaf-1"));

    expect(pool.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS tree_leaves"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS tree_buffers"))).toBe(true);
    expect(pool.calls.some((call) => call.sql.includes("CREATE TABLE IF NOT EXISTS summary_nodes"))).toBe(true);

    const stored = await repository.getLeaf("leaf-1");
    expect(stored).toMatchObject({
      id: "leaf-1",
      chunkId: "chunk-leaf-1",
      sourceId: "source-1",
      entityIds: ["entity-1"],
      text: "durable tree leaf",
    });
    expect(stored?.scope).toMatchObject(scope);

    await expect(repository.listLeaves(["missing", "leaf-1"])).resolves.toHaveLength(1);
  });
});
