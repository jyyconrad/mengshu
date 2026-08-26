import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import {
  PostgresAuthoritativeEntityGraphReadPort,
  type PostgresAuthoritativeEntityGraphReadClient,
} from "./postgres-authoritative-entity-graph-read-port.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active_memory_id: "memory-a",
    active_text: "Mengshu uses PostgreSQL for durable memory.",
    active_tenant_id: scope.tenantId,
    active_user_id: scope.userId,
    active_app_id: scope.appId,
    active_project_id: scope.projectId,
    active_agent_id: scope.agentId,
    active_namespace: scope.namespace,
    active_visibility: scope.visibility,
    active_workspace_id: scope.workspaceId,
    active_session_id: scope.sessionId,
    active_data_type: "memory",
    active_lifecycle_status: "active",
    active_legacy_quarantine_reason: null,
    active_metadata: {
      admissionRoute: "active",
      contextEligible: true,
      memoryContainer: "project",
      sourceNodeIds: ["evidence-a"],
      governance: {
        evidenceIds: ["evidence-a"],
        candidate: { evidence: { eventIds: ["evidence-a"] } },
        provenance: {
          source: "agent",
          sourceId: "message-1",
          sessionId: "session-a",
          createdAt: 1_000,
        },
      },
    },
    evidence_id: "evidence-a",
    evidence_text: "The project selected PostgreSQL as its durable store.",
    evidence_created_at_ms: "900",
    evidence_tenant_id: scope.tenantId,
    evidence_user_id: scope.userId,
    evidence_app_id: scope.appId,
    evidence_project_id: scope.projectId,
    evidence_agent_id: scope.agentId,
    evidence_namespace: scope.namespace,
    evidence_visibility: scope.visibility,
    evidence_workspace_id: scope.workspaceId,
    evidence_session_id: scope.sessionId,
    evidence_data_type: "memory",
    evidence_lifecycle_status: "archived",
    evidence_legacy_quarantine_reason: null,
    evidence_metadata: {
      admissionRoute: "evidence_only",
      contextEligible: false,
      memoryContainer: "session_candidate",
      eventType: "observation",
      sourceNodeIds: ["message-1"],
      governance: {
        commandType: "importEvidence",
        evidenceIds: ["message-1"],
        candidate: {
          phase: "raw_evidence",
          evidenceOnly: true,
          quote: "The project selected PostgreSQL as its durable store.",
          sourceId: "message-1",
        },
        provenance: {
          source: "agent-fast-path",
          sourceId: "message-1",
          sessionId: "session-a",
        },
        native: {
          kind: "observation",
          container: "session_candidate",
          category: "core",
          dataType: "memory",
        },
      },
    },
    ...overrides,
  };
}

function client(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
    rows: [...rows],
    rowCount: rows.length,
  }));
  return {
    query,
    value: { query } as PostgresAuthoritativeEntityGraphReadClient,
  };
}

function input(signal = new AbortController().signal) {
  return {
    graphKind: "entity" as const,
    activeMemoryId: "memory-a",
    evidenceId: "evidence-a",
    scope,
    signal,
  };
}

describe("Postgres authoritative Entity Graph read port", () => {
  test("以 persisted evidence 行时间作为权威 createdAt，不要求 provenance 重复镜像", async () => {
    const harness = client([row()]);
    const port = new PostgresAuthoritativeEntityGraphReadPort(harness.value);

    const fact = await port.read(input());

    expect(fact).toEqual({
      authority: "persisted_active_memory_evidence",
      graphKind: "entity",
      activeMemoryId: "memory-a",
      activeText: "Mengshu uses PostgreSQL for durable memory.",
      evidence: {
        authority: "persisted_evidence",
        evidenceId: "evidence-a",
        scope,
        text: "The project selected PostgreSQL as its durable store.",
        sourceId: "message-1",
        sourceKind: "agent-fast-path",
        createdAt: 900,
      },
    });
    expect(Object.isFrozen(fact)).toBe(true);
    expect(Object.isFrozen(fact.evidence)).toBe(true);
    expect(Object.isFrozen(fact.evidence.scope)).toBe(true);

    const [sql, params] = harness.query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("FROM memories AS active_memory");
    expect(sql).toContain("JOIN memories AS evidence_memory");
    expect(sql).toContain("active_memory.lifecycle_status = 'active'");
    expect(sql).toContain("evidence_memory.lifecycle_status = 'archived'");
    expect(sql).toContain("active_memory.metadata->>'sessionId' =");
    expect(sql).toContain("evidence_memory.metadata->>'sessionId' =");
    expect(params).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      "memory-a", "evidence-a",
    ]);
  });

  test.each([
    ["active evidence identity", {
      active_metadata: {
        admissionRoute: "active", contextEligible: true, memoryContainer: "project",
        sourceNodeIds: ["other-evidence"],
        governance: {
          evidenceIds: ["other-evidence"],
          candidate: { evidence: { eventIds: ["other-evidence"] } },
          provenance: {
            source: "agent", sourceId: "message-1",
            sessionId: "session-a", createdAt: 1_000,
          },
        },
      },
    }],
    ["active provenance scope", {
      active_metadata: {
        admissionRoute: "active", contextEligible: true, memoryContainer: "project",
        sourceNodeIds: ["evidence-a"],
        governance: {
          evidenceIds: ["evidence-a"],
          candidate: { evidence: { eventIds: ["evidence-a"] } },
          provenance: {
            source: "agent", sourceId: "message-1",
            sessionId: "session-b", createdAt: 1_000,
          },
        },
      },
    }],
    ["evidence scope", { evidence_project_id: "project-b" }],
    ["evidence provenance", {
      evidence_metadata: {
        admissionRoute: "evidence_only", contextEligible: false,
        memoryContainer: "session_candidate", eventType: "observation",
        sourceNodeIds: ["message-1"],
        governance: {
          commandType: "importEvidence", evidenceIds: ["message-1"],
          candidate: {
            phase: "raw_evidence", evidenceOnly: true,
            quote: "The project selected PostgreSQL as its durable store.", sourceId: "message-1",
          },
          provenance: {
            source: "agent-fast-path", sourceId: "forged-message",
            sessionId: "session-a", createdAt: 900,
          },
          native: {
            kind: "observation", container: "session_candidate",
            category: "core", dataType: "memory",
          },
        },
      },
    }],
    ["evidence governance", { evidence_lifecycle_status: "active" }],
  ] as const)("%s 不一致时 fail-closed", async (_label, overrides) => {
    const harness = client([row(overrides as Record<string, unknown>)]);
    const port = new PostgresAuthoritativeEntityGraphReadPort(harness.value);

    await expect(port.read(input())).rejects.toMatchObject({
      code: "POSTGRES_AUTHORITATIVE_ENTITY_GRAPH_READ_INVALID",
    });
  });

  test("缺行、重复行、额外行均 fail-closed", async () => {
    for (const rows of [[], [row(), row()], [row(), row({ active_memory_id: "memory-b" })]]) {
      const harness = client(rows);
      const port = new PostgresAuthoritativeEntityGraphReadPort(harness.value);
      await expect(port.read(input())).rejects.toMatchObject({
        code: "POSTGRES_AUTHORITATIVE_ENTITY_GRAPH_READ_INVALID",
      });
    }
  });

  test("接口只接受 Entity Graph identity payload，不接受 Work Graph/CodeGraph 或自由正文", async () => {
    const harness = client([row()]);
    const port = new PostgresAuthoritativeEntityGraphReadPort(harness.value);
    const invalidInputs = [
      { ...input(), graphKind: "work_memory" },
      { ...input(), graphKind: "external_code_graph" },
      { ...input(), text: "caller supplied text" },
      { ...input(), metadata: { sourceId: "caller-supplied" } },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(port.read(invalidInput as never)).rejects.toMatchObject({
        code: "POSTGRES_AUTHORITATIVE_ENTITY_GRAPH_READ_INVALID",
      });
    }
    expect(harness.query).not.toHaveBeenCalled();
  });

  test("查询前或查询后 abort 均原样终止", async () => {
    const before = new AbortController();
    before.abort();
    const beforeHarness = client([row()]);
    const beforePort = new PostgresAuthoritativeEntityGraphReadPort(beforeHarness.value);
    await expect(beforePort.read(input(before.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeHarness.query).not.toHaveBeenCalled();

    const after = new AbortController();
    const query = vi.fn(async () => {
      after.abort();
      return { rows: [row()], rowCount: 1 };
    });
    const afterPort = new PostgresAuthoritativeEntityGraphReadPort({
      query: query as PostgresAuthoritativeEntityGraphReadClient["query"],
    });
    await expect(afterPort.read(input(after.signal))).rejects.toMatchObject({ name: "AbortError" });
  });
});
