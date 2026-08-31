import { describe, expect, test, vi } from "vitest";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
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
