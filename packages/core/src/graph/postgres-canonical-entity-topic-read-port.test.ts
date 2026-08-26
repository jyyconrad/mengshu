import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  PostgresCanonicalEntityTopicReadPort,
  type PostgresCanonicalEntityTopicReadClient,
} from "./postgres-canonical-entity-topic-read-port.js";

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "codex",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace",
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

function activeMetadata() {
  return {
    admissionRoute: "active",
    contextEligible: true,
    memoryContainer: "project",
    semanticType: "experience",
    valueScore: 0.81,
    importance: 0.72,
    sourceNodeIds: ["evidence-a"],
    governance: {
      commandType: "observeAuto",
      evidenceIds: ["evidence-a"],
      candidate: {
        confidence: 0.9,
        riskFlags: [],
        evidence: { eventIds: ["evidence-a"] },
        treeRouting: {
          version: 1,
          evidenceId: "evidence-a",
          sourceId: "session-a",
          entityIds: [],
          scopeVisibility: "project",
          riskFlags: [],
          topicLabels: [],
          topicHotnessEligible: false,
          explicitGlobal: false,
          isWorkspaceRule: false,
        },
      },
      native: {
        kind: "decision",
        semanticType: "experience",
        container: "project",
        category: "decision",
        dataType: "memory",
      },
      provenance: {
        source: "agent",
        sourceId: "evidence-a",
        sessionId: "session-a",
        createdAt: 1_000,
      },
    },
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    active_memory_id: "memory-a",
    active_text: "Runtime architecture uses PostgreSQL.",
    active_importance: 0.72,
    active_created_at_ms: "1000",
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
    active_metadata: activeMetadata(),
    memory_link_id: "a".repeat(64),
    memory_link_scope_fingerprint: authorityScopeFingerprint(scope),
    memory_link_target_memory_id: "memory-a",
    memory_link_evidence_memory_id: "evidence-a",
    memory_link_kind: "grounded_by",
    memory_link_source: "entity_graph",
    memory_link_created_at: "1000",
    entity_id: "entity-topic",
    entity_canonical_name: "runtime architecture",
    entity_display_name: "Runtime Architecture",
    entity_type: "topic",
    entity_aliases: ["Runtime Architecture"],
    entity_mention_count: 20,
    entity_mention_count_30d: 20,
    entity_distinct_source_count: 3,
    entity_last_seen_at: "1000",
    entity_hotness: 0,
    entity_graph_centrality: 0.8,
    entity_query_hits_30d: 4,
    entity_status: "active",
    entity_merged_into: null,
    entity_created_at: "900",
    entity_updated_at: "1000",
    entity_metadata: {},
    entity_evidence_link_id: "c".repeat(64),
    entity_evidence_memory_id: "evidence-a",
    entity_evidence_source_id: "message-a",
    entity_evidence_source_kind: "agent-fast-path",
    entity_evidence_created_at: "1000",
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
    value: { query } as PostgresCanonicalEntityTopicReadClient,
  };
}

function input(signal = new AbortController().signal) {
  return {
    graphKind: "entity" as const,
    activeMemoryId: "memory-a",
    evidenceId: "evidence-a",
    receiptEntityIds: ["entity-topic"],
    scope,
    signal,
  };
}

describe("Postgres canonical Entity topic read port", () => {
  test("只从 active memory、memory/evidence ledger、entity ledger 与 canonical GraphRepository 回读", async () => {
    const harness = client([row()]);
    const port = new PostgresCanonicalEntityTopicReadPort(harness.value);

    const facts = await port.read(input());

    expect(facts).toEqual({
      canonicalFactsAuthority: "graph_repository",
      memory: {
        memoryId: "memory-a",
        scope,
        text: "Runtime architecture uses PostgreSQL.",
        evidenceId: "evidence-a",
        sourceId: "session-a",
        entityIds: ["entity-topic"],
        eventAt: 1_000,
        createdAt: 1_000,
        routing: {
          valueScore: 0.81,
          importance: 0.72,
          semanticType: "experience",
          scopeVisibility: "project",
          riskFlags: [],
          topicHotnessEligible: false,
          explicitGlobal: false,
          isWorkspaceRule: false,
        },
      },
      canonicalEntities: [expect.objectContaining({
        id: "entity-topic",
        type: "topic",
        status: "active",
        graphCentrality: 0.8,
      })],
      entityEvidenceLinks: [expect.objectContaining({
        id: "c".repeat(64),
        targetKind: "entity",
        targetId: "entity-topic",
        evidenceId: "evidence-a",
        memoryId: "memory-a",
      })],
    });
    expect(Object.isFrozen(facts)).toBe(true);
    expect(Object.isFrozen(facts.memory.routing)).toBe(true);

    const [sql, params] = harness.query.mock.calls[0] as [string, readonly unknown[]];
    expect(sql).toContain("FROM memories AS active_memory");
    expect(sql).toContain("JOIN mengshu_memory_evidence_links AS memory_link");
    expect(sql).toContain("LEFT JOIN mengshu_graph_entities AS entity");
    expect(sql).toContain("LEFT JOIN mengshu_graph_entity_evidence AS entity_evidence");
    expect(sql).toContain("entity.status = 'active'");
    expect(params).toEqual([
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      "memory-a", "evidence-a", ["entity-topic"],
    ]);
  });

  test("entity ledger 不匹配时保留 canonical entity 但不伪造 evidence link", async () => {
    const port = new PostgresCanonicalEntityTopicReadPort(client([row({
      entity_evidence_link_id: null,
      entity_evidence_memory_id: null,
      entity_evidence_source_id: null,
      entity_evidence_source_kind: null,
      entity_evidence_created_at: null,
    })]).value);

    await expect(port.read(input())).resolves.toMatchObject({
      canonicalEntities: [expect.objectContaining({ id: "entity-topic" })],
      entityEvidenceLinks: [],
    });
  });

  test("cold/non-topic canonical entity 仍按原值回读，由纯 planner 决定零 target", async () => {
    const port = new PostgresCanonicalEntityTopicReadPort(client([row({
      entity_type: "tool",
      entity_mention_count: 1,
      entity_mention_count_30d: 1,
      entity_distinct_source_count: 0,
      entity_graph_centrality: 0,
      entity_query_hits_30d: 0,
    })]).value);

    await expect(port.read(input())).resolves.toMatchObject({
      canonicalEntities: [expect.objectContaining({
        type: "tool",
        mentionCount30d: 1,
        distinctSourceCount: 0,
        graphCentrality: 0,
        queryHits30d: 0,
      })],
    });
  });

  test.each([
    ["memory ledger", { memory_link_target_memory_id: "memory-forged" }],
    ["9D scope", { active_project_id: "project-b" }],
    ["routing evidence", {
      active_metadata: {
        ...activeMetadata(),
        governance: {
          ...activeMetadata().governance,
          candidate: {
            ...activeMetadata().governance.candidate,
            treeRouting: {
              ...activeMetadata().governance.candidate.treeRouting,
              evidenceId: "evidence-forged",
            },
          },
        },
      },
    }],
    ["routing score mirror", { active_importance: 0.1 }],
  ] as const)("%s 不完整时 fail-closed", async (_label, overrides) => {
    const port = new PostgresCanonicalEntityTopicReadPort(client([
      row(overrides as Record<string, unknown>),
    ]).value);
    await expect(port.read(input())).rejects.toMatchObject({
      code: "POSTGRES_CANONICAL_ENTITY_TOPIC_READ_INVALID",
    });
  });

  test("receipt entity identity 缺失、重复或多余 canonical 行时 fail-closed", async () => {
    await expect(new PostgresCanonicalEntityTopicReadPort(client([]).value).read(input()))
      .rejects.toMatchObject({ code: "POSTGRES_CANONICAL_ENTITY_TOPIC_READ_INVALID" });
    await expect(new PostgresCanonicalEntityTopicReadPort(client([row(), row()]).value).read(input()))
      .rejects.toMatchObject({ code: "POSTGRES_CANONICAL_ENTITY_TOPIC_READ_INVALID" });
    await expect(new PostgresCanonicalEntityTopicReadPort(client([row({
      entity_id: "entity-other",
    })]).value).read(input())).rejects.toMatchObject({
      code: "POSTGRES_CANONICAL_ENTITY_TOPIC_READ_INVALID",
    });
  });

  test("空 receipt entity 集合可权威回读 memory ledger，且不产生 canonical facts", async () => {
    const emptyEntityRow = row(Object.fromEntries([
      "entity_id", "entity_canonical_name", "entity_display_name", "entity_type",
      "entity_aliases", "entity_mention_count", "entity_mention_count_30d",
      "entity_distinct_source_count", "entity_last_seen_at", "entity_hotness",
      "entity_graph_centrality", "entity_query_hits_30d", "entity_status",
      "entity_merged_into", "entity_created_at", "entity_updated_at", "entity_metadata",
      "entity_evidence_link_id", "entity_evidence_memory_id", "entity_evidence_source_id",
      "entity_evidence_source_kind", "entity_evidence_created_at",
    ].map((key) => [key, null])));
    const port = new PostgresCanonicalEntityTopicReadPort(client([emptyEntityRow]).value);
    await expect(port.read({ ...input(), receiptEntityIds: [] })).resolves.toMatchObject({
      memory: { entityIds: [] },
      canonicalEntities: [],
      entityEvidenceLinks: [],
    });
  });

  test("查询前后 abort 原样终止", async () => {
    const before = new AbortController();
    before.abort();
    const beforeHarness = client([row()]);
    await expect(new PostgresCanonicalEntityTopicReadPort(beforeHarness.value)
      .read(input(before.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeHarness.query).not.toHaveBeenCalled();

    const after = new AbortController();
    const query = vi.fn(async () => {
      after.abort();
      return { rows: [row()], rowCount: 1 };
    });
    const port = new PostgresCanonicalEntityTopicReadPort({
      query: query as PostgresCanonicalEntityTopicReadClient["query"],
    });
    await expect(port.read(input(after.signal))).rejects.toMatchObject({ name: "AbortError" });
  });
});
