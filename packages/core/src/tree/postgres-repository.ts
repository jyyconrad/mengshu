/**
 * PostgreSQL-backed Memory Tree repository.
 *
 * Persists tree leaves, open buffers and sealed summary nodes so build_tree
 * jobs survive process restarts and can be shared across OpenClaw/Codex/Claude.
 */

import pg from "pg";
import { scopeToKey } from "../domain/scope.js";
import type { MemoryScope } from "../domain/types.js";
import type {
  MemoryTreeType,
  SummaryNodeStatus,
  TreeBuffer,
  TreeLeaf,
  TreeRepository,
  TreeSummaryNode,
} from "./types.js";

const { Pool } = pg;

export interface PostgresTreeRepositoryConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean | object;
}

type PgPool = pg.Pool;

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function toMs(value: unknown): number {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === "string" || typeof value === "number") {
    return new Date(value).getTime();
  }
  return Date.now();
}

function optionalToMs(value: unknown): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return toMs(value);
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function jsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function memoryScope(value: unknown): MemoryScope {
  const scope = jsonObject(value);
  return {
    tenantId: String(scope.tenantId ?? "local"),
    appId: String(scope.appId ?? "default"),
    userId: String(scope.userId ?? "default"),
    projectId: String(scope.projectId ?? "default"),
    agentId: String(scope.agentId ?? "default"),
    namespace: String(scope.namespace ?? "default"),
    workspaceId: typeof scope.workspaceId === "string" ? scope.workspaceId : undefined,
    sessionId: typeof scope.sessionId === "string" ? scope.sessionId : undefined,
    visibility: scope.visibility as MemoryScope["visibility"] | undefined,
  };
}

function isQueryPool(value: PostgresTreeRepositoryConfig | PgPool): value is PgPool {
  return "query" in value && typeof value.query === "function";
}

export class PostgresTreeRepository implements TreeRepository {
  private readonly ownedPool: PgPool | null;
  private readonly pool: PgPool;
  private initPromise: Promise<void> | null = null;

  constructor(configOrPool: PostgresTreeRepositoryConfig | PgPool) {
    if (isQueryPool(configOrPool)) {
      this.pool = configOrPool;
      this.ownedPool = null;
    } else {
      this.ownedPool = new Pool(configOrPool);
      this.pool = this.ownedPool;
    }
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.createSchema();
    }
    return this.initPromise;
  }

  async close(): Promise<void> {
    if (this.ownedPool) {
      await this.ownedPool.end();
    }
  }

  async upsertLeaf(leaf: TreeLeaf): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `
        INSERT INTO tree_leaves (
          id, scope_key, scope, chunk_id, source_id, entity_ids, importance,
          event_at, created_at, text, token_count
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
        ON CONFLICT (id) DO UPDATE SET
          scope_key = EXCLUDED.scope_key,
          scope = EXCLUDED.scope,
          chunk_id = EXCLUDED.chunk_id,
          source_id = EXCLUDED.source_id,
          entity_ids = EXCLUDED.entity_ids,
          importance = EXCLUDED.importance,
          event_at = EXCLUDED.event_at,
          created_at = EXCLUDED.created_at,
          text = EXCLUDED.text,
          token_count = EXCLUDED.token_count
      `,
      [
        leaf.id,
        scopeToKey(leaf.scope),
        JSON.stringify(leaf.scope),
        leaf.chunkId,
        leaf.sourceId,
        JSON.stringify(leaf.entityIds),
        leaf.importance,
        toIso(leaf.eventAt),
        toIso(leaf.createdAt),
        leaf.text ?? null,
        leaf.tokenCount ?? null,
      ],
    );
  }

  async getLeaf(id: string): Promise<TreeLeaf | undefined> {
    await this.initialize();
    const { rows } = await this.pool.query("SELECT * FROM tree_leaves WHERE id = $1", [id]);
    return rows[0] ? this.rowToLeaf(rows[0]) : undefined;
  }

  async listLeaves(ids: string[]): Promise<TreeLeaf[]> {
    await this.initialize();
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.pool.query(
      "SELECT * FROM tree_leaves WHERE id = ANY($1::text[])",
      [ids],
    );
    const byId = new Map(rows.map((row) => [String(row.id), this.rowToLeaf(row)]));
    return ids.map((id) => byId.get(id)).filter((leaf): leaf is TreeLeaf => Boolean(leaf));
  }

  async upsertBuffer(buffer: TreeBuffer): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `
        INSERT INTO tree_buffers (
          id, scope_key, scope, tree_type, tree_key, level, leaf_ids,
          child_node_ids, token_count, opened_at, updated_at, seal_after_at
        )
        VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)
        ON CONFLICT (id) DO UPDATE SET
          scope_key = EXCLUDED.scope_key,
          scope = EXCLUDED.scope,
          tree_type = EXCLUDED.tree_type,
          tree_key = EXCLUDED.tree_key,
          level = EXCLUDED.level,
          leaf_ids = EXCLUDED.leaf_ids,
          child_node_ids = EXCLUDED.child_node_ids,
          token_count = EXCLUDED.token_count,
          opened_at = EXCLUDED.opened_at,
          updated_at = EXCLUDED.updated_at,
          seal_after_at = EXCLUDED.seal_after_at
      `,
      [
        buffer.id,
        scopeToKey(buffer.scope),
        JSON.stringify(buffer.scope),
        buffer.treeType,
        buffer.treeKey,
        buffer.level,
        JSON.stringify(buffer.leafIds),
        JSON.stringify(buffer.childNodeIds),
        buffer.tokenCount,
        toIso(buffer.openedAt),
        toIso(buffer.updatedAt),
        buffer.sealAfterAt ? toIso(buffer.sealAfterAt) : null,
      ],
    );
  }

  async getBuffer(id: string): Promise<TreeBuffer | undefined> {
    await this.initialize();
    const { rows } = await this.pool.query("SELECT * FROM tree_buffers WHERE id = $1", [id]);
    return rows[0] ? this.rowToBuffer(rows[0]) : undefined;
  }

  async deleteBuffer(id: string): Promise<void> {
    await this.initialize();
    await this.pool.query("DELETE FROM tree_buffers WHERE id = $1", [id]);
  }

  async upsertSummary(node: TreeSummaryNode): Promise<void> {
    await this.initialize();
    await this.pool.query(
      `
        INSERT INTO summary_nodes (
          id, scope_key, scope, tree_type, tree_key, level, title, summary,
          child_node_ids, leaf_ids, evidence_chunk_ids, entity_ids, relation_ids,
          token_count, time_range, status, created_at, sealed_at, metadata
        )
        VALUES (
          $1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb,
          $11::jsonb, $12::jsonb, $13::jsonb, $14, $15::jsonb, $16, $17, $18, $19::jsonb
        )
        ON CONFLICT (id) DO UPDATE SET
          scope_key = EXCLUDED.scope_key,
          scope = EXCLUDED.scope,
          tree_type = EXCLUDED.tree_type,
          tree_key = EXCLUDED.tree_key,
          level = EXCLUDED.level,
          title = EXCLUDED.title,
          summary = EXCLUDED.summary,
          child_node_ids = EXCLUDED.child_node_ids,
          leaf_ids = EXCLUDED.leaf_ids,
          evidence_chunk_ids = EXCLUDED.evidence_chunk_ids,
          entity_ids = EXCLUDED.entity_ids,
          relation_ids = EXCLUDED.relation_ids,
          token_count = EXCLUDED.token_count,
          time_range = EXCLUDED.time_range,
          status = EXCLUDED.status,
          created_at = EXCLUDED.created_at,
          sealed_at = EXCLUDED.sealed_at,
          metadata = EXCLUDED.metadata
      `,
      [
        node.id,
        scopeToKey(node.scope),
        JSON.stringify(node.scope),
        node.treeType,
        node.treeKey,
        node.level,
        node.title,
        node.summary,
        JSON.stringify(node.childNodeIds),
        JSON.stringify(node.leafIds),
        JSON.stringify(node.evidenceChunkIds),
        JSON.stringify(node.entityIds),
        JSON.stringify(node.relationIds),
        node.tokenCount,
        JSON.stringify(node.timeRange),
        node.status,
        toIso(node.createdAt),
        node.sealedAt ? toIso(node.sealedAt) : null,
        JSON.stringify(node.metadata),
      ],
    );
  }

  async getSummary(id: string): Promise<TreeSummaryNode | undefined> {
    await this.initialize();
    const { rows } = await this.pool.query("SELECT * FROM summary_nodes WHERE id = $1", [id]);
    return rows[0] ? this.rowToSummary(rows[0]) : undefined;
  }

  async listSummaries(filter: { scope: MemoryScope; treeType?: MemoryTreeType; treeKey?: string }): Promise<TreeSummaryNode[]> {
    await this.initialize();
    const params: unknown[] = [scopeToKey(filter.scope)];
    const conditions = ["scope_key = $1"];
    if (filter.treeType) {
      params.push(filter.treeType);
      conditions.push(`tree_type = $${params.length}`);
    }
    if (filter.treeKey) {
      params.push(filter.treeKey);
      conditions.push(`tree_key = $${params.length}`);
    }
    const { rows } = await this.pool.query(
      `
        SELECT * FROM summary_nodes
        WHERE ${conditions.join(" AND ")}
        ORDER BY COALESCE(sealed_at, created_at) DESC
      `,
      params,
    );
    return rows.map((row) => this.rowToSummary(row));
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tree_leaves (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope JSONB NOT NULL,
        chunk_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        event_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        text TEXT,
        token_count INTEGER
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS tree_buffers (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope JSONB NOT NULL,
        tree_type TEXT NOT NULL,
        tree_key TEXT NOT NULL,
        level INTEGER NOT NULL DEFAULT 0,
        leaf_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        child_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        token_count INTEGER NOT NULL DEFAULT 0,
        opened_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        seal_after_at TIMESTAMPTZ,
        UNIQUE(scope_key, tree_type, tree_key, level)
      )
    `);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS summary_nodes (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        scope JSONB NOT NULL,
        tree_type TEXT NOT NULL,
        tree_key TEXT NOT NULL,
        level INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        child_node_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        leaf_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        evidence_chunk_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        relation_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        token_count INTEGER NOT NULL DEFAULT 0,
        time_range JSONB NOT NULL DEFAULT '{}'::jsonb,
        status TEXT NOT NULL DEFAULT 'sealed',
        created_at TIMESTAMPTZ NOT NULL,
        sealed_at TIMESTAMPTZ,
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);
    await this.pool.query("CREATE INDEX IF NOT EXISTS tree_leaves_scope_idx ON tree_leaves(scope_key)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS tree_buffers_scope_type_idx ON tree_buffers(scope_key, tree_type, tree_key)");
    await this.pool.query("CREATE INDEX IF NOT EXISTS summary_tree_idx ON summary_nodes(scope_key, tree_type, tree_key, level, sealed_at DESC)");
  }

  private rowToLeaf(row: any): TreeLeaf {
    return {
      id: String(row.id),
      scope: memoryScope(row.scope),
      chunkId: String(row.chunk_id),
      sourceId: String(row.source_id),
      entityIds: jsonArray(row.entity_ids),
      importance: Number(row.importance),
      eventAt: toMs(row.event_at),
      createdAt: toMs(row.created_at),
      text: row.text ?? undefined,
      tokenCount: row.token_count === null || row.token_count === undefined ? undefined : Number(row.token_count),
    };
  }

  private rowToBuffer(row: any): TreeBuffer {
    return {
      id: String(row.id),
      scope: memoryScope(row.scope),
      treeType: row.tree_type as MemoryTreeType,
      treeKey: String(row.tree_key),
      level: Number(row.level),
      leafIds: jsonArray(row.leaf_ids),
      childNodeIds: jsonArray(row.child_node_ids),
      tokenCount: Number(row.token_count),
      openedAt: toMs(row.opened_at),
      updatedAt: toMs(row.updated_at),
      sealAfterAt: optionalToMs(row.seal_after_at),
    };
  }

  private rowToSummary(row: any): TreeSummaryNode {
    const timeRange = jsonObject(row.time_range);
    return {
      id: String(row.id),
      scope: memoryScope(row.scope),
      treeType: row.tree_type as MemoryTreeType,
      treeKey: String(row.tree_key),
      level: Number(row.level),
      title: String(row.title),
      summary: String(row.summary),
      childNodeIds: jsonArray(row.child_node_ids),
      leafIds: jsonArray(row.leaf_ids),
      evidenceChunkIds: jsonArray(row.evidence_chunk_ids),
      entityIds: jsonArray(row.entity_ids),
      relationIds: jsonArray(row.relation_ids),
      tokenCount: Number(row.token_count),
      timeRange: {
        startAt: Number(timeRange.startAt ?? 0),
        endAt: Number(timeRange.endAt ?? 0),
      },
      status: row.status as SummaryNodeStatus,
      createdAt: toMs(row.created_at),
      sealedAt: optionalToMs(row.sealed_at),
      metadata: jsonObject(row.metadata),
    };
  }
}
