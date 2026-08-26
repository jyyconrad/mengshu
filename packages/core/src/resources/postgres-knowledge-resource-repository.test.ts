import { describe, expect, test, vi } from "vitest";

import {
  PostgresKnowledgeResourceRepository,
} from "./postgres-knowledge-resource-repository.js";

const scope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
  workspaceId: "workspace-a",
  sessionId: "current-session",
};

const ref = "11111111-1111-4111-8111-111111111111";
const revision = "a".repeat(64);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ref,
    content_hash: revision,
    category: "docs",
    created_at: "2026-08-01T00:00:00.000Z",
    title: "Runtime guide",
    document_id: "doc-1",
    provenance_source_id: null,
    file_path: null,
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    canonical_project_id: scope.projectId,
    product_id: scope.appId,
    producer_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    lifecycle_status: null,
    risk_blocked: null,
    conflict_unresolved: null,
    ...overrides,
  };
}

describe("PostgresKnowledgeResourceRepository", () => {
  test("lists metadata-only index rows under exact persistent scope", async () => {
    const query = vi.fn(async () => ({ rows: [row()], rowCount: 1 }));
    const repository = new PostgresKnowledgeResourceRepository({ query });

    await expect(repository.list(scope, { limit: 5 })).resolves.toEqual([{
      ref,
      revision,
      title: "Runtime guide",
      category: "docs",
      createdAt: "2026-08-01T00:00:00.000Z",
      sourceRef: { kind: "document", ref: "doc-1" },
      evidence: { kind: "knowledge_record", ref, revision },
    }]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    const selectClause = sql.slice(0, sql.indexOf("FROM knowledge"));
    expect(selectClause).not.toContain("LEFT(text");
    expect(selectClause).not.toContain("char_length(text)");
    expect(sql).toContain("tenant_id = $1 AND user_id = $2");
    expect(sql).toContain("canonical_project_id = $3");
    expect(sql).toContain("product_id = $4 AND producer_id = $5");
    expect(sql).toContain("namespace = $6 AND visibility = $7");
    expect(sql).toContain("COALESCE(workspace_id, '') = $8");
    expect(sql).toContain("legacy_quarantine_reason IS NULL");
    expect(sql.indexOf("canonical_project_id = $3")).toBeLessThan(sql.indexOf("LIMIT $9"));
    expect(params).toEqual([
      scope.tenantId,
      scope.userId,
      scope.projectId,
      scope.appId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      scope.workspaceId,
      5,
    ]);
    expect(params).not.toContain(scope.sessionId);
  });

  test("searches with a parameterized escaped literal and bounds content in SQL", async () => {
    const query = vi.fn(async () => ({
      rows: [row({ content: "matched body", content_length: "12" })],
      rowCount: 1,
    }));
    const repository = new PostgresKnowledgeResourceRepository({ query });

    await expect(repository.search(scope, {
      query: "100%_done\\now",
      limit: 3,
      maxContentChars: 120,
    })).resolves.toEqual([
      expect.objectContaining({ ref, content: "matched body", truncated: false }),
    ]);

    const [sql, params] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("LEFT(text, $10)");
    expect(sql).toContain("text ILIKE $9 ESCAPE '\\'");
    expect(sql.indexOf("text ILIKE $9")).toBeLessThan(sql.indexOf("LIMIT $11"));
    expect(params[8]).toBe("%100\\%\\_done\\\\now%");
    expect(params.slice(9)).toEqual([120, 3]);
  });

  test("reads only an id plus pinned revision and returns bounded content", async () => {
    const query = vi.fn(async () => ({
      rows: [row({ content: "body", content_length: "900" })],
      rowCount: 1,
    }));
    const repository = new PostgresKnowledgeResourceRepository({ query });

    await expect(repository.read(scope, {
      ref,
      revision,
      maxContentChars: 400,
    })).resolves.toEqual(expect.objectContaining({
      ref,
      revision,
      content: "body",
      truncated: true,
      evidence: { kind: "knowledge_record", ref, revision },
    }));

    const [sql, params] = query.mock.calls[0] as unknown as [string, readonly unknown[]];
    expect(sql).toContain("id = $9::uuid AND content_hash = $10");
    expect(sql).toContain("LEFT(text, $11)");
    expect(params.slice(8)).toEqual([ref, revision, 400]);
  });

  test.each([
    ["tenant", { tenant_id: "tenant-b" }],
    ["project", { canonical_project_id: "project-b" }],
    ["workspace", { workspace_id: "workspace-b" }],
    ["revision", { content_hash: "b".repeat(64) }],
    ["revoked", { lifecycle_status: "revoked" }],
    ["risk", { risk_blocked: "true" }],
    ["conflict", { conflict_unresolved: "true" }],
  ])("fails closed when returned %s mirror drifts", async (_label, overrides) => {
    const repository = new PostgresKnowledgeResourceRepository({
      query: async () => ({
        rows: [row({ content: "body", content_length: "4", ...overrides })],
        rowCount: 1,
      }),
    });

    await expect(repository.read(scope, {
      ref,
      revision,
      maxContentChars: 100,
    })).rejects.toThrow("KNOWLEDGE_RESOURCE_ROW_INVALID");
  });

  test("treats missing or revision-mismatched reads as the same absence", async () => {
    const repository = new PostgresKnowledgeResourceRepository({
      query: async () => ({ rows: [], rowCount: 0 }),
    });

    await expect(repository.read(scope, {
      ref,
      revision,
      maxContentChars: 100,
    })).resolves.toBeUndefined();
  });
});
