import { describe, expect, it, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  PostgresCandidateDedupReadAdapter,
  type PostgresCandidateDedupReadQueryClient,
} from "./candidate-dedup-read-port.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

const embeddingSpaceId = `embedding-space:v1:${"a".repeat(64)}`;
const excludedId = "00000000-0000-4000-8000-000000000001";

interface QueryCall {
  readonly sql: string;
  readonly params: readonly unknown[];
}

function clientWithRows(rows: readonly Record<string, unknown>[]): {
  readonly client: PostgresCandidateDedupReadQueryClient;
  readonly calls: QueryCall[];
} {
  const calls: QueryCall[] = [];
  const client: PostgresCandidateDedupReadQueryClient = {
    async query<Row extends Record<string, unknown>>(
      sql: string,
      params: readonly unknown[] = [],
    ) {
      calls.push({ sql, params });
      return { rows: [...rows] as Row[], rowCount: rows.length };
    },
  };
  return { client, calls };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000002",
    text: "生产发布前必须运行完整测试",
    vector_text: "[0.25,0.5,0.75]",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    app_id: scope.appId,
    project_id: scope.projectId,
    agent_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
    memory_kind: "decision",
    semantic_type: "experience",
    lifecycle_status: "active",
    admission_route: "active",
    context_eligible: "true",
    memory_container: "project",
    embedding_space_id: embeddingSpaceId,
    embedding_space_state: "known-queryable",
    metadata_embedding_space_id: embeddingSpaceId,
    metadata_embedding_space_state: "known-queryable",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    scope,
    kind: "decision" as const,
    semanticType: "experience" as const,
    embeddingSpaceId,
    embeddingSpaceState: "known-queryable" as const,
    excludeIds: [excludedId],
    ...overrides,
  };
}

describe("PostgresCandidateDedupReadAdapter", () => {
  it("在 SQL 内完整绑定 authority/scope/type/embedding-space，并只读取 active eligible memory", async () => {
    const { client, calls } = clientWithRows([row()]);
    const port = new PostgresCandidateDedupReadAdapter(client);

    await expect(port.findExisting(request())).resolves.toEqual([{
      id: "00000000-0000-4000-8000-000000000002",
      text: "生产发布前必须运行完整测试",
      vector: [0.25, 0.5, 0.75],
      kind: "decision",
      semanticType: "experience",
    }]);

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.params).toEqual([
      scope.tenantId,
      scope.userId,
      scope.appId,
      scope.projectId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      scope.workspaceId,
      scope.sessionId,
      "decision",
      "experience",
      embeddingSpaceId,
      "known-queryable",
      [excludedId],
    ]);

    expect(call.sql).toMatch(/FROM memories\b/);
    expect(call.sql).toContain("tenant_id = $1");
    expect(call.sql).toContain("user_id = $2");
    expect(call.sql).toContain("product_id = $3");
    expect(call.sql).toContain("canonical_project_id = $4");
    expect(call.sql).toContain("producer_id = $5");
    expect(call.sql).toContain("namespace = $6");
    expect(call.sql).toContain("visibility = $7");
    expect(call.sql).toContain("COALESCE(workspace_id, '') = $8");
    expect(call.sql).toContain("metadata->>'sessionId'");
    expect(call.sql).toContain("= $9");
    expect(call.sql).toContain("metadata #>> '{governance,native,kind}' = $10");
    expect(call.sql).toContain("metadata->>'semanticType' = $11");
    expect(call.sql).toContain("embedding_space_id = $12");
    expect(call.sql).toContain("embedding_space_state = $13");
    expect(call.sql).toContain("metadata->>'embeddingSpaceId' = $12");
    expect(call.sql).toContain("metadata->>'embeddingSpaceState' = $13");
    expect(call.sql).toContain("NOT (id::text = ANY($14::text[]))");
    expect(call.sql).toContain("data_type = 'memory'");
    expect(call.sql).toContain("lifecycle_status = 'active'");
    expect(call.sql).toContain("metadata->>'admissionRoute' = 'active'");
    expect(call.sql).toContain("metadata->>'contextEligible' = 'true'");
    expect(call.sql).toContain("metadata->>'memoryContainer' IN");
    expect(call.sql).toContain("legacy_quarantine_reason IS NULL");
    expect(call.sql).not.toMatch(/existsByContentHash|content_hash\s+IN/i);
  });

  it("semanticType 缺失时只读取同为 kind-only 的记录，且空 workspace/session 仍精确绑定", async () => {
    const kindOnlyScope: MemoryScope = Object.freeze({
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
    });
    const { client, calls } = clientWithRows([row({
      workspace_id: "",
      session_id: "",
      semantic_type: null,
    })]);
    const port = new PostgresCandidateDedupReadAdapter(client);

    await expect(port.findExisting(request({
      scope: kindOnlyScope,
      semanticType: undefined,
      excludeIds: [],
    }))).resolves.toMatchObject([{ kind: "decision" }]);
    expect(calls[0]!.params.slice(7, 14)).toEqual([
      "",
      "",
      "decision",
      null,
      embeddingSpaceId,
      "known-queryable",
      [],
    ]);
    expect(calls[0]!.sql).toContain("$11::text IS NULL");
    expect(calls[0]!.sql).toContain("metadata->>'semanticType' IS NULL");
    expect(calls[0]!.sql).toContain("metadata #>> '{governance,native,semanticType}' IS NULL");
  });

  it("session 顶层镜像与治理快照冲突时 SQL 明确排除", async () => {
    const { client, calls } = clientWithRows([]);
    const port = new PostgresCandidateDedupReadAdapter(client);

    await port.findExisting(request());

    expect(calls[0]!.sql).toContain("metadata #>> '{governance,provenance,sessionId}'");
    expect(calls[0]!.sql).toMatch(
      /metadata->>'sessionId'\s*=\s*metadata #>> '\{governance,provenance,sessionId\}'/,
    );
  });

  it("在发起查询前拒绝不完整 scope、未知 embedding state 与非法排除 ID", async () => {
    const query = vi.fn();
    const port = new PostgresCandidateDedupReadAdapter({ query } as PostgresCandidateDedupReadQueryClient);

    await expect(port.findExisting(request({
      scope: { ...scope, visibility: undefined },
    }))).rejects.toThrow(/candidate dedup read input is invalid/);
    await expect(port.findExisting(request({
      embeddingSpaceState: "unknown-unqueryable",
    }))).rejects.toThrow(/candidate dedup read input is invalid/);
    await expect(port.findExisting(request({
      excludeIds: ["bad id"],
    }))).rejects.toThrow(/candidate dedup read input is invalid/);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["scope", { tenant_id: "other-tenant" }],
    ["kind", { memory_kind: "fact" }],
    ["semantic type", { semantic_type: "rules" }],
    ["lifecycle", { lifecycle_status: "archived" }],
    ["eligibility", { context_eligible: "false" }],
    ["container", { memory_container: "session_candidate" }],
    ["embedding column", { embedding_space_id: `embedding-space:v1:${"b".repeat(64)}` }],
    ["embedding mirror", { metadata_embedding_space_state: "unknown-unqueryable" }],
    ["vector", { vector_text: "[1,\"bad\"]" }],
  ])("查询客户端返回不符合 %s 约束的行时 fail-closed", async (_label, overrides) => {
    const { client } = clientWithRows([row(overrides)]);
    const port = new PostgresCandidateDedupReadAdapter(client);

    await expect(port.findExisting(request())).rejects.toThrow(
      /candidate dedup read row is invalid/,
    );
  });

  it.each([
    ["evidence_only", "archived", "false", "session_candidate"],
    ["lookup_only", "archived", "false", "session_candidate"],
    ["candidate", "active", "false", "session_candidate"],
    ["candidate_low_priority", "active", "false", "session_candidate"],
  ])("%s 路由不得伪装成 active 去重记录", async (
    admissionRoute,
    lifecycleStatus,
    contextEligible,
    memoryContainer,
  ) => {
    const { client } = clientWithRows([row({
      admission_route: admissionRoute,
      lifecycle_status: lifecycleStatus,
      context_eligible: contextEligible,
      memory_container: memoryContainer,
    })]);
    const port = new PostgresCandidateDedupReadAdapter(client);

    await expect(port.findExisting(request())).rejects.toThrow(
      /candidate dedup read row is invalid/,
    );
  });
});
