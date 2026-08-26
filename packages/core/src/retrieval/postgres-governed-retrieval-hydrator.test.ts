import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { computeContentHash } from "../scoring/hash-utils.js";
import {
  GovernedRetrievalEngine,
  type GovernedRetrievalCandidate,
} from "./governed-retrieval-engine.js";
import {
  PostgresGovernedRetrievalHydrator,
  type PostgresGovernedRetrievalHydrationClient,
} from "./postgres-governed-retrieval-hydrator.js";

const requestScope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace",
  workspaceId: "workspace-a",
  sessionId: "session-request",
};

const authoritativeScope: MemoryScope = {
  ...requestScope,
  projectId: "project-shared",
  agentId: "agent-shared",
  sessionId: "session-source",
};

function governance(
  semanticType: "rules" | "task_context" = "rules",
  route: "active" | "lookup_only" = "active",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    admissionRoute: route,
    contextEligible: route === "active",
    valueScore: route === "active" ? 0.92 : 0.65,
    confidence: 0.88,
    semanticType,
    memoryContainer: route === "active" ? "project" : "session_candidate",
    sourceNodeIds: ["evidence-a"],
    riskFlags: [],
    governance: {
      commandType: "observeAuto",
      evidenceIds: ["evidence-a"],
      candidate: {
        evidence: { eventIds: ["evidence-a"] },
        riskFlags: [],
        targetScope: semanticType === "rules" ? "workspace" : "project",
      },
      provenance: {
        source: "agent",
        sourceId: "trace-a",
        sessionId: authoritativeScope.sessionId,
      },
      native: {
        kind: semanticType === "rules" ? "decision" : "task",
        semanticType,
        category: semanticType === "rules" ? "decision" : "task",
        dataType: "memory",
      },
    },
    ...overrides,
  };
}

function memoryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const text = "Always use the governed retrieval path.";
  return {
    id: "memory-a",
    text,
    content_hash: computeContentHash(text),
    importance: 0.81,
    category: "decision",
    data_type: "memory",
    created_at_ms: "1000",
    updated_at_ms: "1000",
    tenant_id: authoritativeScope.tenantId,
    user_id: authoritativeScope.userId,
    app_id: authoritativeScope.appId,
    project_id: authoritativeScope.projectId,
    agent_id: authoritativeScope.agentId,
    namespace: authoritativeScope.namespace,
    visibility: authoritativeScope.visibility,
    workspace_id: authoritativeScope.workspaceId,
    session_id: authoritativeScope.sessionId,
    lifecycle_status: "active",
    legacy_quarantine_reason: null,
    metadata: governance(),
    ...overrides,
  };
}

function evidenceMetadata(
  sourceId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    admissionRoute: "evidence_only",
    contextEligible: false,
    memoryContainer: "session_candidate",
    eventType: "observation",
    sourceNodeIds: [sourceId],
    governance: {
      commandType: "importEvidence",
      evidenceIds: [sourceId],
      candidate: {
        phase: "raw_evidence",
        evidenceOnly: true,
        quote: `raw evidence ${sourceId}`,
        sourceId,
      },
      provenance: {
        source: "agent-fast-path",
        sourceId,
        sessionId: authoritativeScope.sessionId,
      },
      native: {
        kind: "observation",
        container: "session_candidate",
        category: "core",
        dataType: "memory",
      },
    },
    ...overrides,
  };
}

function evidenceRow(
  evidenceId = "evidence-a",
  origin: "record" | "duplicate_ledger" = "record",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const sourceId = evidenceId === "evidence-a" ? "message-a" : "message-duplicate";
  return {
    evidence_id: evidenceId,
    evidence_text: `raw evidence ${sourceId}`,
    evidence_created_at_ms: "900",
    tenant_id: authoritativeScope.tenantId,
    user_id: authoritativeScope.userId,
    app_id: authoritativeScope.appId,
    project_id: authoritativeScope.projectId,
    agent_id: authoritativeScope.agentId,
    namespace: authoritativeScope.namespace,
    visibility: authoritativeScope.visibility,
    workspace_id: authoritativeScope.workspaceId,
    session_id: authoritativeScope.sessionId,
    data_type: "memory",
    lifecycle_status: "archived",
    legacy_quarantine_reason: null,
    metadata: evidenceMetadata(sourceId),
    evidence_origin: origin,
    ledger_link_id: origin === "duplicate_ledger" ? "b".repeat(64) : null,
    ledger_target_memory_id: origin === "duplicate_ledger" ? "memory-a" : null,
    ledger_evidence_memory_id: origin === "duplicate_ledger" ? evidenceId : null,
    ledger_link_kind: origin === "duplicate_ledger" ? "duplicate_evidence" : null,
    ledger_source: origin === "duplicate_ledger" ? "write_kernel_dedup" : null,
    ledger_tenant_id: origin === "duplicate_ledger" ? authoritativeScope.tenantId : null,
    ledger_user_id: origin === "duplicate_ledger" ? authoritativeScope.userId : null,
    ledger_app_id: origin === "duplicate_ledger" ? authoritativeScope.appId : null,
    ledger_project_id: origin === "duplicate_ledger" ? authoritativeScope.projectId : null,
    ledger_agent_id: origin === "duplicate_ledger" ? authoritativeScope.agentId : null,
    ledger_namespace: origin === "duplicate_ledger" ? authoritativeScope.namespace : null,
    ledger_visibility: origin === "duplicate_ledger" ? authoritativeScope.visibility : null,
    ledger_workspace_id: origin === "duplicate_ledger" ? authoritativeScope.workspaceId : null,
    ledger_session_id: origin === "duplicate_ledger" ? authoritativeScope.sessionId : null,
    ...overrides,
  };
}

function candidate(
  semanticType: "rules" | "task_context" = "rules",
  overrides: Partial<GovernedRetrievalCandidate> = {},
): GovernedRetrievalCandidate {
  return {
    candidateId: "candidate-a",
    authoritativeRecordId: "memory-a",
    scope: authoritativeScope,
    source: "vector",
    nodeType: "memory",
    relevance: 0.9,
    evidenceIds: ["evidence-a"],
    ...overrides,
  };
}

function harness(
  memoryRows: readonly Record<string, unknown>[] = [memoryRow()],
  evidenceRows: readonly Record<string, unknown>[] = [evidenceRow()],
) {
  const query = vi.fn(async (sql: string, _params?: readonly unknown[]) =>
    sql.includes("WITH direct_evidence")
      ? { rows: [...evidenceRows], rowCount: evidenceRows.length }
      : { rows: [...memoryRows], rowCount: memoryRows.length });
  const value = { query } as PostgresGovernedRetrievalHydrationClient;
  return { query, hydrator: new PostgresGovernedRetrievalHydrator(value) };
}

function hydrationInput(
  candidates: readonly GovernedRetrievalCandidate[] = [candidate()],
  signal?: AbortSignal,
) {
  return {
    scope: requestScope,
    authoritativeRecordId: "memory-a",
    candidates,
    ...(signal === undefined ? {} : { signal }),
  };
}

describe("Postgres governed retrieval hydrator", () => {
  test("按候选 authoritative 9D scope 回读，而不是按 request scope", async () => {
    const { hydrator, query } = harness();

    const hydrated = await hydrator.hydrate(hydrationInput());

    expect(hydrated?.record).toMatchObject({
      id: "memory-a",
      scope: authoritativeScope,
      semanticType: "rules",
      lifecycleStatus: "active",
      sourceNodeIds: ["evidence-a"],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(hydrated?.evidenceIds).toEqual(["evidence-a"]);
    const [, params] = query.mock.calls[0] as [string, readonly unknown[]];
    const [sql] = query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("created_at_ms");
    expect(sql).toContain("created_at) * 1000)::text AS updated_at_ms");
    expect(sql).not.toContain("epoch FROM updated_at");
    expect(params).toEqual([
      authoritativeScope.tenantId, authoritativeScope.userId, authoritativeScope.appId,
      authoritativeScope.projectId, authoritativeScope.agentId, authoritativeScope.namespace,
      authoritativeScope.visibility, authoritativeScope.workspaceId,
      authoritativeScope.sessionId, "memory-a",
    ]);
    expect(params).not.toContain(requestScope.projectId);
  });

  test("显式保存的 raw evidence 可被权威 hydration 回读", async () => {
    const metadata = evidenceMetadata("message-a", { eventType: "explicit_save" });
    const { hydrator } = harness([memoryRow()], [evidenceRow("evidence-a", "record", {
      metadata,
    })]);

    await expect(hydrator.hydrate(hydrationInput())).resolves.toMatchObject({
      record: { id: "memory-a", semanticType: "rules" },
      evidenceIds: ["evidence-a"],
    });
  });

  test("跨 project 的 workspace rules 合法，task_context 仍由 Engine scope policy 拒绝", async () => {
    const rulesHarness = harness();
    const rulesEngine = new GovernedRetrievalEngine(rulesHarness.hydrator);
    const rules = await rulesEngine.retrieve({
      intent: "context", scope: requestScope, candidates: [candidate("rules")],
    });
    expect(rules.hits).toHaveLength(1);

    const taskMetadata = governance("task_context");
    const taskHarness = harness([memoryRow({
      category: "task",
      metadata: taskMetadata,
    })]);
    const taskEngine = new GovernedRetrievalEngine(taskHarness.hydrator);
    const task = await taskEngine.retrieve({
      intent: "context", scope: requestScope, candidates: [candidate("task_context")],
    });
    expect(task.hits).toEqual([]);
    expect(task.filtered).toEqual([
      expect.objectContaining({ filteredReason: "scope_mismatch" }),
    ]);
  });

  test("lookup_only 以 archived/session_candidate 权威合同返回", async () => {
    const metadata = governance("rules", "lookup_only");
    const { hydrator } = harness([memoryRow({
      lifecycle_status: "archived",
      metadata,
    })]);

    await expect(hydrator.hydrate(hydrationInput())).resolves.toMatchObject({
      record: {
        lifecycleStatus: "archived",
        container: "session_candidate",
        metadata: { admissionRoute: "lookup_only", contextEligible: false },
      },
      evidenceIds: ["evidence-a"],
    });
  });

  test("保留 MemoryKind + 可选 semanticType，不把 5 type 误设为通用召回前提", async () => {
    const metadata = governance();
    const native = ((metadata.governance as Record<string, unknown>).native as Record<string, unknown>);
    delete native.semanticType;
    delete metadata.semanticType;
    const { hydrator } = harness([memoryRow({ metadata })]);

    await expect(hydrator.hydrate(hydrationInput())).resolves.toMatchObject({
      record: { kind: "decision", sourceNodeIds: ["evidence-a"] },
      evidenceIds: ["evidence-a"],
    });
    const hydrated = await hydrator.hydrate(hydrationInput());
    expect(hydrated?.record.semanticType).toBeUndefined();
  });

  test.each([
    ["evidence_only", { lifecycle_status: "archived", metadata: governance("rules", "active", {
      admissionRoute: "evidence_only", contextEligible: false,
    }) }],
    ["candidate", { metadata: governance("rules", "active", { admissionRoute: "candidate" }) }],
    ["revoked", { lifecycle_status: "revoked" }],
    ["risk", { metadata: governance("rules", "active", { riskFlags: ["prompt_injection"] }) }],
    ["conflicting native container", { metadata: governance("rules", "active", {
      governance: {
        ...governance("rules").governance as Record<string, unknown>,
        native: {
          ...((governance("rules").governance as Record<string, unknown>)
            .native as Record<string, unknown>),
          container: "personal",
        },
      },
    }) }],
    ["incomplete governance", { metadata: governance("rules", "active", {
      governance: { evidenceIds: ["evidence-a"] },
    }) }],
  ] as const)("拒绝 %s authoritative record", async (_label, overrides) => {
    const { hydrator } = harness([memoryRow(overrides as Record<string, unknown>)]);
    await expect(hydrator.hydrate(hydrationInput())).resolves.toBeUndefined();
  });

  test("missing/extra/duplicate persisted evidence 均 fail-closed", async () => {
    for (const rows of [
      [],
      [evidenceRow(), evidenceRow("evidence-extra")],
      [evidenceRow(), evidenceRow()],
    ]) {
      const { hydrator } = harness([memoryRow()], rows);
      await expect(hydrator.hydrate(hydrationInput())).resolves.toBeUndefined();
    }
  });

  test("只接受完整 9D duplicate_evidence ledger 增补 proven evidence", async () => {
    const duplicateCandidate = candidate("rules", {
      candidateId: "candidate-duplicate",
      evidenceIds: ["evidence-duplicate"],
    });
    const valid = harness([memoryRow()], [
      evidenceRow(),
      evidenceRow("evidence-duplicate", "duplicate_ledger"),
    ]);
    await expect(valid.hydrator.hydrate(hydrationInput([
      candidate(), duplicateCandidate,
    ]))).resolves.toMatchObject({
      record: { sourceNodeIds: ["evidence-a", "evidence-duplicate"] },
      evidenceIds: ["evidence-a", "evidence-duplicate"],
    });

    const mismatches = [
      { ledger_link_kind: "grounded_by" },
      { ledger_target_memory_id: "memory-b" },
      { ledger_evidence_memory_id: "evidence-other" },
      { ledger_source: "untrusted_source" },
      { ledger_project_id: "project-other" },
      { ledger_session_id: "session-other" },
    ];
    for (const mismatch of mismatches) {
      const invalid = harness([memoryRow()], [
        evidenceRow(),
        evidenceRow("evidence-duplicate", "duplicate_ledger", mismatch),
      ]);
      await expect(invalid.hydrator.hydrate(hydrationInput([
        candidate(), duplicateCandidate,
      ]))).resolves.toBeUndefined();
    }
  });

  test.each([
    ["scope", { project_id: "project-other" }],
    ["session", { session_id: "session-other" }],
    ["provenance", {
      metadata: evidenceMetadata("message-a", {
        governance: {
          ...evidenceMetadata("message-a").governance as Record<string, unknown>,
          provenance: {
            source: "agent-fast-path", sourceId: "forged",
            sessionId: authoritativeScope.sessionId, createdAt: 900,
          },
        },
      }),
    }],
  ] as const)("evidence %s mismatch fail-closed", async (_label, overrides) => {
    const { hydrator } = harness([memoryRow()], [evidenceRow("evidence-a", "record", overrides)]);
    await expect(hydrator.hydrate(hydrationInput())).resolves.toBeUndefined();
  });

  test("候选 scope 不一致时不查询，candidate 自报 evidence 不参与权威 evidence 选取", async () => {
    const { hydrator, query } = harness();
    await expect(hydrator.hydrate(hydrationInput([
      candidate(),
      candidate("rules", { candidateId: "candidate-b", scope: requestScope }),
    ]))).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();

    const candidateClaim = candidate("rules", { evidenceIds: ["untrusted-ann-evidence"] });
    const trusted = harness();
    const hydrated = await trusted.hydrator.hydrate(hydrationInput([candidateClaim]));
    expect(hydrated?.evidenceIds).toEqual(["evidence-a"]);
    expect(trusted.query.mock.calls[1]?.[1]).toContainEqual(["evidence-a"]);
    expect(trusted.query.mock.calls[1]?.[1]).not.toContain("untrusted-ann-evidence");
  });

  test("查询前或查询后 abort 均终止且不返回部分 hydration", async () => {
    const before = new AbortController();
    before.abort();
    const beforeHarness = harness();
    await expect(beforeHarness.hydrator.hydrate(
      hydrationInput([candidate()], before.signal),
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeHarness.query).not.toHaveBeenCalled();

    const after = new AbortController();
    const query = vi.fn(async () => {
      after.abort();
      return { rows: [memoryRow()], rowCount: 1 };
    });
    const hydrator = new PostgresGovernedRetrievalHydrator({
      query: query as PostgresGovernedRetrievalHydrationClient["query"],
    });
    await expect(hydrator.hydrate(
      hydrationInput([candidate()], after.signal),
    )).rejects.toMatchObject({ name: "AbortError" });
  });
});
