import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { HostManagedReuseAuthorizer, type HostReuseState } from "../evolution/reuse/explicit-reuse-authorizer.js";
import {
  PostgresGovernedRetrievalCandidateSource,
  PostgresGovernedRetrievalCandidateSourceError,
  type PostgresGovernedRetrievalCandidateQueryClient,
} from "./postgres-governed-retrieval-candidate-source.js";

const SCOPE: MemoryScope = Object.freeze({
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

const ROW_KEYS = [
  "source", "node_type", "source_ref", "authoritative_record_id", "evidence_ids",
  "relevance", "scope_fingerprint", "tenant_id", "user_id", "app_id", "project_id",
  "agent_id", "namespace", "visibility", "workspace_id", "session_id",
  "memory_data_type", "memory_lifecycle_status", "memory_admission_route",
  "memory_context_eligible", "memory_legacy_quarantine_reason", "memory_kind",
  "memory_semantic_type", "memory_content_hash",
] as const;

type CandidateRow = Record<(typeof ROW_KEYS)[number], unknown>;

function row(overrides: Partial<CandidateRow> = {}): CandidateRow {
  return {
    source: "bm25",
    node_type: "memory",
    source_ref: "memory-a",
    authoritative_record_id: "memory-a",
    evidence_ids: ["evidence-a"],
    relevance: 0.91,
    scope_fingerprint: authorityScopeFingerprint(SCOPE),
    tenant_id: SCOPE.tenantId,
    user_id: SCOPE.userId,
    app_id: SCOPE.appId,
    project_id: SCOPE.projectId,
    agent_id: SCOPE.agentId,
    namespace: SCOPE.namespace,
    visibility: SCOPE.visibility,
    workspace_id: SCOPE.workspaceId,
    session_id: SCOPE.sessionId,
    memory_data_type: "memory",
    memory_lifecycle_status: "active",
    memory_admission_route: "active",
    memory_context_eligible: "true",
    memory_legacy_quarantine_reason: null,
    memory_kind: "decision",
    memory_semantic_type: "rules",
    memory_content_hash: "a".repeat(32),
    ...overrides,
  };
}

function clientWith(rows: readonly CandidateRow[]): PostgresGovernedRetrievalCandidateQueryClient {
  return {
    query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }),
  };
}

describe("PostgresGovernedRetrievalCandidateSource", () => {
  test("current-version SQL discovers strictly lookup-only archived/active versions without widening the existing gates", async () => {
    const client = clientWith([row({ memory_lifecycle_status: "archived",
      memory_admission_route: "lookup_only", memory_context_eligible: "false", memory_semantic_type: null })]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);
    await expect(source.search({ scope: SCOPE, query: "lookup", limit: 1 })).resolves.toEqual([
      expect.objectContaining({ authoritativeRecordId: "memory-a", admissionRoute: "lookup_only", claimKind: "decision" }),
    ]);
    const sql = vi.mocked(client.query).mock.calls[0]![0].replace(/\s+/g, " ");
    expect(sql).toContain(`(memory.lineage_id IS NULL OR memory.id = (
      SELECT current_version.id FROM memories AS current_version
      WHERE current_version.scope_fingerprint = memory.scope_fingerprint
        AND current_version.lineage_id = memory.lineage_id
        AND current_version.valid_from <= CURRENT_TIMESTAMP
        AND (current_version.valid_to IS NULL OR current_version.valid_to > CURRENT_TIMESTAMP)
        AND current_version.temporal_invalidated IS NOT TRUE
        AND current_version.temporal_purge_pending IS NOT TRUE
        AND current_version.evolution_alias_of IS NULL
        AND ((current_version.lifecycle_status = 'active'
            AND current_version.temporal_activation_state = 'active')
          OR (current_version.lifecycle_status = 'archived'
            AND current_version.temporal_activation_state = 'staged')
          OR (current_version.lifecycle_status = 'archived'
            AND current_version.temporal_activation_state = 'active'
            AND current_version.metadata->>'admissionRoute' = 'lookup_only'
            AND current_version.metadata->>'contextEligible' = 'false'))
      ORDER BY current_version.valid_from DESC, current_version.revision DESC LIMIT 1
    ))`.replace(/\s+/g, " "));
    for (const fragment of [
      "memory.temporal_invalidated IS NOT TRUE", "memory.temporal_purge_pending IS NOT TRUE",
      "memory.evolution_disputed IS NOT TRUE", "memory.legacy_quarantine_reason IS NULL",
      "COALESCE(memory.metadata #> '{governance,evolution,disputed}', 'false'::jsonb) = 'false'::jsonb",
      "COALESCE(memory.metadata #> '{governance,evolution,needsReview}', 'false'::jsonb) = 'false'::jsonb",
      "AND (memory.valid_to IS NULL OR memory.valid_to > CURRENT_TIMESTAMP) AND memory.evolution_alias_of IS NULL",
    ]) expect(sql).toContain(fragment);
  });

  test.each([
    ["missing route", { memory_admission_route: null }],
    ["active route", { memory_admission_route: "active" }],
    ["evidence-only route", { memory_admission_route: "evidence_only" }],
    ["context eligible", { memory_context_eligible: "true" }],
    ["missing context eligibility", { memory_context_eligible: null }],
    ["non-SQL boolean", { memory_context_eligible: false }],
    ["revoked", { memory_lifecycle_status: "revoked" }],
    ["deleted", { memory_lifecycle_status: "deleted" }],
    ["quarantined", { memory_legacy_quarantine_reason: "legacy" }],
  ])("lookup-only candidate decoder rejects %s", async (_label, overrides) => {
    const source = new PostgresGovernedRetrievalCandidateSource(clientWith([row({
      memory_lifecycle_status: "archived", memory_admission_route: "lookup_only", memory_context_eligible: "false",
      ...overrides as Partial<CandidateRow>,
    })]));
    await expect(source.search({ scope: SCOPE, query: "lookup", limit: 1 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
  });

  test.each(["tenant_id", "user_id", "app_id", "project_id", "agent_id", "namespace",
    "visibility", "workspace_id", "session_id", "scope_fingerprint"] as const)(
    "lookup-only candidate decoder still rejects mismatched %s", async key => {
      const source = new PostgresGovernedRetrievalCandidateSource(clientWith([row({
        memory_lifecycle_status: "archived", memory_admission_route: "lookup_only", memory_context_eligible: "false",
        [key]: "other",
      })]));
      await expect(source.search({ scope: SCOPE, query: "lookup", limit: 1 }))
        .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
    });

  test.each([
    { name: "open-ended", offset: null, alias: null, eligible: true },
    { name: "future expiry", offset: 1, alias: null, eligible: true },
    { name: "exact expiry", offset: 0, alias: null, eligible: false },
    { name: "expired", offset: -1, alias: null, eligible: false },
    { name: "expired merge alias", offset: -1, alias: "canonical", eligible: false },
    { name: "future-dated merge alias", offset: 1, alias: "canonical", eligible: false },
  ])("ordinary kind-only source SQL applies expiry independently of null lineage: $name", async input => {
    const dbNow = Date.parse("2026-09-06T00:00:00Z");
    const stored = { lineage_id: null, valid_to: input.offset === null ? null : new Date(dbNow + input.offset),
      evolution_alias_of: input.alias };
    const query = vi.fn(async (sql: string) => {
      // This transport models only the asserted WHERE clause; real PG execution belongs to acceptance.
      expect(sql.replace(/\s+/g, " ")).toContain("AND (memory.valid_to IS NULL OR memory.valid_to > CURRENT_TIMESTAMP) " +
        "AND memory.evolution_alias_of IS NULL AND (memory.lineage_id IS NULL OR memory.valid_from <= CURRENT_TIMESTAMP)");
      const eligible = (stored.valid_to === null || stored.valid_to.getTime() > dbNow) && stored.evolution_alias_of === null;
      return { rows: eligible ? [row({ memory_kind: "fact", memory_semantic_type: null })] : [] };
    });
    const source = new PostgresGovernedRetrievalCandidateSource({ query } as PostgresGovernedRetrievalCandidateQueryClient);
    expect(await source.search({ scope: SCOPE, query: "fact", limit: 1 })).toHaveLength(input.eligible ? 1 : 0);
  });
  test("candidate SQL excludes disputed and source-review-held canonical identities", async () => {
    const client = clientWith([]);
    await new PostgresGovernedRetrievalCandidateSource(client).search({ scope: SCOPE, query: "a", limit: 1 });
    const sql = vi.mocked(client.query).mock.calls[0]?.[0];
    expect(sql).toContain("memory.evolution_disputed IS NOT TRUE");
    expect(sql).toContain("{governance,evolution,disputed}");
    expect(sql).toContain("{governance,evolution,needsReview}");
  });
  test("explicit reuse fans out only to authorized exact source scopes and filters real claim kinds", async () => {
    const target = { ...SCOPE, appId: "app-b" };
    let state: HostReuseState = {
      revision: "1", authority: {
        tenantId: SCOPE.tenantId, userId: SCOPE.userId,
        workspaceId: SCOPE.workspaceId, sessionId: SCOPE.sessionId,
        allow: { appIds: [SCOPE.appId, target.appId], projectIds: [SCOPE.projectId],
          agentIds: [SCOPE.agentId], namespaces: [SCOPE.namespace], visibilities: ["private"] },
      },
      grants: [{ id: "grant-a", sourceScope: SCOPE, targetScope: target, claimKinds: ["decision"],
        notBefore: "2026-09-01T00:00:00.000Z", expiresAt: "2026-09-07T00:00:00.000Z" }],
    };
    const granted = state;
    let clock = Date.parse("2026-09-06T00:00:00Z");
    let revokeDuringQuery = false;
    const authorizer = new HostManagedReuseAuthorizer({ read: async () => state }, () => clock);
    const query = vi.fn(async (_sql: string, params?: readonly unknown[]) => {
      const sourceQuery = params?.[0] === authorityScopeFingerprint(SCOPE);
      if (sourceQuery && revokeDuringQuery) state = { ...state, revision: "revoked", grants: [] };
      return { rows: sourceQuery ? [row(), row({
        source_ref: "memory-b", authoritative_record_id: "memory-b", memory_kind: "fact",
      })] : [] };
    });
    const source = new PostgresGovernedRetrievalCandidateSource(
      { query } as PostgresGovernedRetrievalCandidateQueryClient, { reuseAuthorizer: authorizer },
    );
    const found = await source.search({ query: "governed", scope: target, limit: 8 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ scope: SCOPE, authoritativeRecordId: "memory-a" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]![1]?.slice(0, 10)).toEqual([
      authorityScopeFingerprint(SCOPE), SCOPE.tenantId, SCOPE.userId, SCOPE.appId,
      SCOPE.projectId, SCOPE.agentId, SCOPE.namespace, SCOPE.visibility, SCOPE.workspaceId, SCOPE.sessionId,
    ]);
    state = { ...state, revision: "2", grants: [] };
    query.mockClear();
    expect(await source.search({ query: "governed", scope: target, limit: 8 })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    state = { ...granted, revision: "3" };
    revokeDuringQuery = true;
    expect(await source.search({ query: "governed", scope: target, limit: 8 })).toEqual([]);
    state = { ...granted, revision: "4" };
    revokeDuringQuery = false;
    clock = Date.parse("2026-09-07T00:00:00Z");
    query.mockClear();
    expect(await source.search({ query: "governed", scope: target, limit: 8 })).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("同一参数化快照返回 BM25、Entity Graph、Work Memory Graph 与 tree 的权威 identity", async () => {
    const query = "Robert'); DROP TABLE memories; --";
    const client = clientWith([
      row(),
      row({
        source: "entity_graph",
        node_type: "entity_graph",
        source_ref: "entity-a",
        authoritative_record_id: "memory-b",
        evidence_ids: ["evidence-b"],
        relevance: 0.82,
      }),
      row({
        source: "work_memory_graph",
        node_type: "work_memory_graph",
        source_ref: "work-node-a",
        authoritative_record_id: "memory-c",
        evidence_ids: ["evidence-c"],
        relevance: 0.73,
      }),
      row({
        source: "tree",
        node_type: "tree",
        source_ref: "memory-d",
        authoritative_record_id: "memory-d",
        evidence_ids: ["evidence-d"],
        relevance: 0.64,
      }),
    ]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);

    const result = await source.search({
      query,
      scope: SCOPE,
      limit: 8,
      signal: new AbortController().signal,
    });

    expect(result.map((candidate) => ({
      source: candidate.source,
      nodeType: candidate.nodeType,
      authoritativeRecordId: candidate.authoritativeRecordId,
      evidenceIds: candidate.evidenceIds,
      governedSemanticIdentity: candidate.governedSemanticIdentity,
      admissionRoute: candidate.admissionRoute,
      navigation: candidate.navigation,
    }))).toEqual([
      {
        source: "bm25", nodeType: "memory", authoritativeRecordId: "memory-a",
        evidenceIds: ["evidence-a"],
        governedSemanticIdentity: JSON.stringify([
          "mengshu.governed-semantic-identity/v1", "decision", "rules", "a".repeat(32),
        ]),
        admissionRoute: "active", navigation: undefined,
      },
      {
        source: "entity_graph", nodeType: "entity_graph", authoritativeRecordId: "memory-b",
        evidenceIds: ["evidence-b"],
        governedSemanticIdentity: JSON.stringify([
          "mengshu.governed-semantic-identity/v1", "decision", "rules", "a".repeat(32),
        ]),
        admissionRoute: "active", navigation: { kind: "entity_graph", ref: "entity-a" },
      },
      {
        source: "work_memory_graph", nodeType: "work_memory_graph",
        authoritativeRecordId: "memory-c", evidenceIds: ["evidence-c"],
        governedSemanticIdentity: JSON.stringify([
          "mengshu.governed-semantic-identity/v1", "decision", "rules", "a".repeat(32),
        ]),
        admissionRoute: "active",
        navigation: { kind: "work_memory_graph", ref: "work-node-a" },
      },
      {
        source: "tree", nodeType: "tree", authoritativeRecordId: "memory-d",
        evidenceIds: ["evidence-d"],
        governedSemanticIdentity: JSON.stringify([
          "mengshu.governed-semantic-identity/v1", "decision", "rules", "a".repeat(32),
        ]),
        admissionRoute: "active", navigation: { kind: "tree", ref: "memory-d" },
      },
    ]);
    expect(result.every((candidate) => candidate.scope === result[0]?.scope)).toBe(true);
    expect(result[0]?.scope).toEqual(SCOPE);
    expect(new Set(result.map((candidate) => candidate.candidateId)).size).toBe(4);

    const queryCall = vi.mocked(client.query).mock.calls[0];
    expect(queryCall).toBeDefined();
    const [sql, params] = queryCall!;
    expect(sql).not.toContain(query);
    expect(params).toEqual([
      authorityScopeFingerprint(SCOPE),
      SCOPE.tenantId,
      SCOPE.userId,
      SCOPE.appId,
      SCOPE.projectId,
      SCOPE.agentId,
      SCOPE.namespace,
      SCOPE.visibility,
      SCOPE.workspaceId,
      SCOPE.sessionId,
      query,
      8,
    ]);
    for (const fragment of [
      "mengshu_memory_evidence_links",
      "mengshu_graph_entity_evidence",
      "mengshu_graph_relation_evidence",
      "mengshu_work_memory_nodes",
      "node_type = 'memory'",
      "work_node.record_id",
      "work_node.evidence_chunk_ids",
      "mengshu_tree_leaves",
      "tree_leaf.id::text = memory.id::text",
      "tree_leaf.chunk_id",
      "string_agg(quote_literal(term.lexeme), ' | ' ORDER BY term.lexeme)",
      "unnest(to_tsvector('simple', memory.text))",
      "cardinality(term.positions)",
      "document_frequency",
      "corpus_stats",
      "1.2::double precision",
      "0.75::double precision",
      "LN(1.0 +",
      "1.0 - EXP(-score.raw_bm25)",
      "memory.metadata->>'admissionRoute' IN ('active', 'lookup_only')",
      "memory.direct_evidence_ids, memory.memory_kind, memory.semantic_type, memory.content_hash",
      "scope_fingerprint = $1",
      "tenant_id = $2",
      "session_id = $10",
    ]) {
      expect(sql).toContain(fragment);
    }
    expect(sql).not.toContain("websearch_to_tsquery");
  });

  test("BM25 允许 active 与 lookup_only，图和树候选只允许 active", async () => {
    const client = clientWith([
      row({
        authoritative_record_id: "memory-lookup",
        source_ref: "memory-lookup",
        memory_lifecycle_status: "archived",
        memory_admission_route: "lookup_only",
        memory_context_eligible: "false",
      }),
    ]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);
    await expect(source.search({ query: "lookup", scope: SCOPE, limit: 1 })).resolves.toHaveLength(1);

    vi.mocked(client.query).mockResolvedValueOnce({
      rows: [row({
        source: "entity_graph",
        node_type: "entity_graph",
        source_ref: "entity-a",
        memory_lifecycle_status: "archived",
        memory_admission_route: "lookup_only",
        memory_context_eligible: "false",
      })],
      rowCount: 1,
    });
    await expect(source.search({ query: "entity", scope: SCOPE, limit: 1 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
  });

  test("候选 identity 接受 Markdown 工作集规范 SHA-256", async () => {
    const source = new PostgresGovernedRetrievalCandidateSource(clientWith([
      row({ memory_content_hash: "b".repeat(64) }),
    ]));

    await expect(source.search({ query: "memory", scope: SCOPE, limit: 1 }))
      .resolves.toEqual([
        expect.objectContaining({
          governedSemanticIdentity: JSON.stringify([
            "mengshu.governed-semantic-identity/v1",
            "decision",
            "rules",
            "b".repeat(64),
          ]),
        }),
      ]);
  });

  test.each([
    ["cross-scope", { tenant_id: "tenant-b" }],
    ["forged-fingerprint", { scope_fingerprint: "0".repeat(64) }],
    ["missing-evidence", { evidence_ids: [] }],
    ["invalid-governed-kind", { memory_kind: "rule" }],
    ["invalid-governed-semantic-type", { memory_semantic_type: "instruction" }],
    ["invalid-governed-content-hash", { memory_content_hash: "not-a-hash" }],
    ["unverifiable-legacy-content-hash", { memory_content_hash: "a".repeat(36) }],
    ["unknown-source", { source: "external_code_graph" }],
    ["entity-text-as-memory", {
      source: "entity_graph", node_type: "memory", source_ref: "entity-a",
    }],
    ["tree-id-is-not-memory-id", {
      source: "tree", node_type: "tree", source_ref: "leaf-not-memory-a",
    }],
  ])("%s 结果使整批候选 fail closed", async (_name, overrides) => {
    const client = clientWith([row(), row(overrides as Partial<CandidateRow>)]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);

    await expect(source.search({ query: "memory", scope: SCOPE, limit: 8 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
  });

  test("fail-closed 错误只暴露常量化诊断原因", async () => {
    const source = new PostgresGovernedRetrievalCandidateSource(clientWith([
      row({ memory_content_hash: "not-a-hash" }),
    ]));

    await expect(source.search({ query: "memory", scope: SCOPE, limit: 8 }))
      .rejects.toMatchObject({
        code: "POSTGRES_GOVERNED_RETRIEVAL_CANDIDATE_INVALID",
        reason: "GOVERNED_SEMANTIC_IDENTITY_INVALID",
      });
  });

  test("多行 context task 保留合法文本空白，仍拒绝其它控制字符", async () => {
    const client = clientWith([]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);
    const query = "发布规则\nprofile\trules\r\nresource";

    await expect(source.search({ query, scope: SCOPE, limit: 8 })).resolves.toEqual([]);
    expect(vi.mocked(client.query).mock.calls[0]?.[1]?.[10]).toBe(query);
    await expect(source.search({ query: "unsafe\u0000query", scope: SCOPE, limit: 8 }))
      .rejects.toMatchObject({ reason: "INPUT_INVALID" });
    expect(client.query).toHaveBeenCalledTimes(1);
  });

  test("额外字段、rowCount 不一致和非法输入均 fail closed", async () => {
    const extra = { ...row(), injected_text: "not authoritative" };
    const extraClient: PostgresGovernedRetrievalCandidateQueryClient = {
      query: vi.fn().mockResolvedValue({ rows: [extra], rowCount: 1 }),
    };
    await expect(new PostgresGovernedRetrievalCandidateSource(extraClient).search({
      query: "memory", scope: SCOPE, limit: 1,
    })).rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);

    const countClient: PostgresGovernedRetrievalCandidateQueryClient = {
      query: vi.fn().mockResolvedValue({ rows: [row()], rowCount: 2 }),
    };
    await expect(new PostgresGovernedRetrievalCandidateSource(countClient).search({
      query: "memory", scope: SCOPE, limit: 1,
    })).rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);

    const resultEnvelopeClient: PostgresGovernedRetrievalCandidateQueryClient = {
      query: vi.fn().mockResolvedValue({ rows: [row()], rowCount: 1, command: "SELECT" }),
    };
    await expect(new PostgresGovernedRetrievalCandidateSource(resultEnvelopeClient).search({
      query: "memory", scope: SCOPE, limit: 1,
    })).rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);

    const client = clientWith([]);
    const source = new PostgresGovernedRetrievalCandidateSource(client);
    await expect(source.search({ query: " ", scope: SCOPE, limit: 1 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
    await expect(source.search({ query: "memory", scope: { ...SCOPE, visibility: undefined }, limit: 1 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
    await expect(source.search({ query: "memory", scope: SCOPE, limit: 0 }))
      .rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
    expect(client.query).not.toHaveBeenCalled();
  });

  test("数据库异常与重复 identity 均整批 fail closed", async () => {
    const rejected: PostgresGovernedRetrievalCandidateQueryClient = {
      query: vi.fn().mockRejectedValue(new Error("database unavailable")),
    };
    await expect(new PostgresGovernedRetrievalCandidateSource(rejected).search({
      query: "memory", scope: SCOPE, limit: 2,
    })).rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);

    const duplicate = clientWith([row(), row()]);
    await expect(new PostgresGovernedRetrievalCandidateSource(duplicate).search({
      query: "memory", scope: SCOPE, limit: 2,
    })).rejects.toBeInstanceOf(PostgresGovernedRetrievalCandidateSourceError);
  });

  test("查询前和查询完成后的 AbortSignal 都会中止且不返回部分候选", async () => {
    const before = new AbortController();
    before.abort();
    const beforeClient = clientWith([row()]);
    await expect(new PostgresGovernedRetrievalCandidateSource(beforeClient).search({
      query: "memory", scope: SCOPE, limit: 1, signal: before.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(beforeClient.query).not.toHaveBeenCalled();

    const after = new AbortController();
    const afterClient: PostgresGovernedRetrievalCandidateQueryClient = {
      query: vi.fn().mockImplementation(async () => {
        after.abort();
        return { rows: [row()], rowCount: 1 };
      }),
    };
    await expect(new PostgresGovernedRetrievalCandidateSource(afterClient).search({
      query: "memory", scope: SCOPE, limit: 1, signal: after.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
