import { describe, expect, test, vi } from "vitest";

import {
  CandidateEvidenceReadError,
  PostgresCandidateEvidenceReadPort,
} from "./postgres-candidate-evidence-read-port.js";

const scope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "private" as const,
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

function evidenceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    lifecycle_status: "archived",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    canonical_project_id: scope.projectId,
    product_id: scope.appId,
    producer_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    metadata: {
      sessionId: scope.sessionId,
      admissionRoute: "evidence_only",
      contextEligible: false,
      memoryContainer: "session_candidate",
      sourceNodeIds: ["event-a"],
      governance: {
        commandType: "importEvidence",
        candidate: {
          phase: "raw_evidence",
          evidenceOnly: true,
          sourceId: "event-a",
        },
        provenance: { source: "user", sourceId: "event-a" },
        evidenceIds: ["event-a"],
      },
    },
    ...overrides,
  };
}

function port(rows: readonly Record<string, unknown>[]) {
  const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
    rows: [...rows],
    rowCount: rows.length,
  }));
  return { query, reader: new PostgresCandidateEvidenceReadPort({ query }) };
}

describe("PostgresCandidateEvidenceReadPort", () => {
  test("按完整 9D scope 读取 persisted evidence，并恢复请求顺序与权威 source kind", async () => {
    const firstId = "11111111-1111-4111-8111-111111111111";
    const secondId = "22222222-2222-4222-8222-222222222222";
    const { query, reader } = port([
      evidenceRow({
        id: secondId,
        metadata: {
          ...evidenceRow().metadata as Record<string, unknown>,
          sourceNodeIds: ["tool-a"],
          governance: {
            commandType: "importEvidence",
            candidate: { phase: "raw_evidence", evidenceOnly: true, sourceId: "tool-a" },
            provenance: { source: "tool", sourceId: "tool-a" },
            evidenceIds: ["tool-a"],
          },
        },
      }),
      evidenceRow({ id: firstId }),
    ]);

    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: [firstId, secondId],
      scope,
      signal: new AbortController().signal,
    })).resolves.toEqual([
      { evidenceId: firstId, sourceKind: "session_user" },
      { evidenceId: secondId, sourceKind: "tool_result" },
    ]);

    expect(query).toHaveBeenCalledOnce();
    const [sql, params] = query.mock.calls[0]!;
    expect(sql).toContain("FROM memories");
    expect(sql).toContain("id = ANY($1::uuid[])");
    expect(sql).toContain("tenant_id = $2");
    expect(sql).toContain("workspace_id = $9");
    expect(sql).toContain("metadata->>'sessionId' = $10");
    expect(params).toEqual([
      [firstId, secondId],
      scope.tenantId,
      scope.userId,
      scope.projectId,
      scope.appId,
      scope.agentId,
      scope.namespace,
      scope.visibility,
      scope.workspaceId,
      scope.sessionId,
    ]);
  });

  test("显式 remember 的 Agent Fast Path observation 属于 session_user，普通 observation 仍属于 agent_output", async () => {
    const explicit = evidenceRow({
      metadata: {
        ...evidenceRow().metadata as Record<string, unknown>,
        eventType: "observation",
        intent: "remember",
        governance: {
          ...(evidenceRow().metadata as Record<string, unknown>).governance as Record<string, unknown>,
          provenance: { source: "agent-fast-path", sourceId: "event-a" },
        },
      },
    });
    const automatic = evidenceRow({
      metadata: {
        ...evidenceRow().metadata as Record<string, unknown>,
        eventType: "observation",
        intent: "auto",
        governance: {
          ...(evidenceRow().metadata as Record<string, unknown>).governance as Record<string, unknown>,
          provenance: { source: "agent-fast-path", sourceId: "event-a" },
        },
      },
    });
    const input = {
      evidenceIds: ["11111111-1111-4111-8111-111111111111"],
      scope,
      signal: new AbortController().signal,
    };

    await expect(port([explicit]).reader.readAuthoritativeEvidenceFacts(input))
      .resolves.toEqual([{ evidenceId: explicit.id, sourceKind: "session_user" }]);
    await expect(port([automatic]).reader.readAuthoritativeEvidenceFacts(input))
      .resolves.toEqual([{ evidenceId: automatic.id, sourceKind: "agent_output" }]);
  });

  test.each([
    ["missing row", []],
    ["duplicate row", [evidenceRow(), evidenceRow()]],
    ["wrong lifecycle", [evidenceRow({ lifecycle_status: "active" })]],
    ["wrong scope", [evidenceRow({ tenant_id: "tenant-b" })]],
    ["wrong admission", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>, admissionRoute: "active",
    } })]],
    ["wrong command", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>,
      governance: {
        ...(evidenceRow().metadata as Record<string, unknown>).governance as Record<string, unknown>,
        commandType: "saveExplicit",
      },
    } })]],
    ["wrong phase", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>,
      governance: {
        ...(evidenceRow().metadata as Record<string, unknown>).governance as Record<string, unknown>,
        candidate: { phase: "candidate", evidenceOnly: true, sourceId: "event-a" },
      },
    } })]],
    ["wrong container", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>, memoryContainer: "project",
    } })]],
    ["mismatched source refs", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>, sourceNodeIds: ["other-event"],
    } })]],
    ["unknown source", [evidenceRow({ metadata: {
      ...evidenceRow().metadata as Record<string, unknown>,
      governance: {
        ...(evidenceRow().metadata as Record<string, unknown>).governance as Record<string, unknown>,
        provenance: { source: "client-claimed-admin", sourceId: "event-a" },
      },
    } })]],
  ])("%s fail-closed", async (_label, rows) => {
    const { reader } = port(rows as readonly Record<string, unknown>[]);
    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: ["11111111-1111-4111-8111-111111111111"],
      scope,
      signal: new AbortController().signal,
    })).rejects.toBeInstanceOf(CandidateEvidenceReadError);
  });

  test("拒绝重复/非 UUID ID、缺失 9D scope 和 aborted read，且不访问数据库", async () => {
    const { query, reader } = port([]);
    const id = "11111111-1111-4111-8111-111111111111";
    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: [id, id], scope, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: ["event-a"], scope, signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: [id], scope: { ...scope, sessionId: undefined },
      signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: "INVALID_SCOPE" });
    const controller = new AbortController();
    controller.abort();
    await expect(reader.readAuthoritativeEvidenceFacts({
      evidenceIds: [id], scope, signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(query).not.toHaveBeenCalled();
  });
});
