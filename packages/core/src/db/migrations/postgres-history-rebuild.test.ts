import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import { planHistoryRebuild } from "./history-rebuild.js";
import {
  buildHistoryRebuildMemoryMaterial,
  HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
  historyRebuildTreeRoutingPolicyHash,
  historyRebuildSourceKind,
  HistoryRebuildRepositoryError,
  planHistoryRebuildTreeRouting,
  PostgresHistoryRebuildRepository,
  type HistoryRebuildBatchCommit,
  type HistoryRebuildTreeRoutingPolicy,
  type PostgresHistoryRebuildClient,
} from "./postgres-history-rebuild.js";

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "app-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "working-context",
  visibility: "private",
  workspaceId: "workspace-a",
  sessionId: "session-a",
};
const RUN_ID = "history-v1";
const HASH = "a".repeat(64);
const ID = "00000000-0000-4000-8000-000000000001";
const SECOND_ID = "00000000-0000-4000-8000-000000000002";

function modelAttemptInput() {
  return {
    migrationId: "history-rebuild-resume-v1", manifestHash: HASH, runId: RUN_ID,
    sourceTable: "memories" as const, recordId: ID, sourceHash: "1".repeat(64), attempt: 0,
    modelFingerprint: "b".repeat(64), promptHash: "c".repeat(64),
    schemaHash: "d".repeat(64), inputHash: "e".repeat(64),
    usageCeiling: { modelCalls: 1, inputTokens: 120, outputTokens: 64, costMinorUnits: 9 },
    budget: { maxModelCalls: 10, maxInputTokens: 10_000,
      maxOutputTokens: 1_000, maxCostMinorUnits: 100 },
    now: 1_720_000_000_000,
  };
}

function treePolicy(overrides: Partial<HistoryRebuildTreeRoutingPolicy> = {}):
HistoryRebuildTreeRoutingPolicy {
  return {
    version: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
    scopeFingerprint: authorityScopeFingerprint(scope),
    topic: {
      version: "scope-topic-taxonomy/v1",
      minimumSupport: 2,
      maxLabelsPerRecord: 3,
      taxonomy: [
        { canonicalLabel: "release-safety", aliases: ["Release Safety"], support: 3 },
        { canonicalLabel: "postgresql", aliases: ["PostgreSQL", "postgres"], support: 4 },
        { canonicalLabel: "alpha-topic", aliases: ["Alpha Topic"], support: 3 },
        { canonicalLabel: "zeta-topic", aliases: ["Zeta Topic"], support: 2 },
      ],
    },
    source: {
      version: "auditable-source-identity/v1",
      identities: [],
    },
    ...overrides,
  };
}

function runState(
  state: "running" | "completed",
  policy: HistoryRebuildTreeRoutingPolicy = treePolicy(),
) {
  return {
    rows: [{ state, policy_hash: historyRebuildTreeRoutingPolicyHash(policy) }],
    rowCount: 1,
  };
}

class ScriptedClient implements PostgresHistoryRebuildClient {
  readonly calls: Array<{ sql: string; params: readonly unknown[] }> = [];

  constructor(private readonly responder: (
    sql: string,
    params: readonly unknown[],
  ) => { rows: readonly Record<string, unknown>[]; rowCount: number }) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ) {
    this.calls.push({ sql, params });
    return this.responder(sql, params) as { rows: readonly Row[]; rowCount: number };
  }
}

function sourceRow(table: "memories" | "knowledge" = "memories") {
  return {
    id: ID,
    text: "生产发布前必须完成回归测试",
    content_hash: HASH,
    vector_text: "[0.1,0.2]",
    importance: 0.8,
    metadata: table === "memories"
      ? { governance: { native: { kind: "decision" } }, sourceNodeIds: [ID] }
      : { kind: "knowledge" },
    category: table === "memories" ? "decision" : "other",
    data_type: table === "memories" ? "memory" : "knowledge",
    lifecycle_status: "active",
    created_at_ms: "1720000000000",
    embedding_space_id: `embedding-space:v1:${"f".repeat(64)}`,
    embedding_space_state: "known-queryable",
    tenant_id: scope.tenantId,
    user_id: scope.userId,
    canonical_project_id: scope.projectId,
    product_id: scope.appId,
    producer_id: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    workspace_id: scope.workspaceId,
    session_id: scope.sessionId,
  };
}

function batch(overrides: Partial<HistoryRebuildBatchCommit> = {}): HistoryRebuildBatchCommit {
  return {
    runId: RUN_ID,
    scope,
    sourceTable: "memories",
    expectedAfterId: null,
    nextAfterId: ID,
    expectedCheckpointVersion: 0,
    counts: {
      total: 1, preserve: 0, backfill: 1, modelClassify: 0,
      lookupOnly: 0, quarantine: 0,
    },
    sourceRows: [{
      sourceTable: "memories",
      recordId: ID,
      sourceHash: HASH,
      text: "生产发布前必须完成回归测试",
      kind: "decision",
      metadata: {},
      scope,
      lifecycleStatus: "active",
      contentHash: HASH,
      vector: [0.1, 0.2],
      importance: 0.8,
      category: "decision",
      dataType: "memory",
      createdAt: 1_720_000_000_000,
      embeddingSpaceId: `embedding-space:v1:${"f".repeat(64)}`,
      embeddingSpaceState: "known-queryable",
      canCreateEvidenceMirror: true,
      evidenceIds: [ID],
      topicLabels: ["release-safety"],
    }],
    plans: [{
      sourceTable: "memories",
      recordId: ID,
      sourceHash: HASH,
      disposition: "backfill",
      semanticType: "rules",
      topicLabels: ["release-safety"],
      contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "deterministic_kind_mapping",
      receiptHash: "b".repeat(64),
    }],
    modelReceipts: [],
    operationReceipt: {
      receiptHash: "c".repeat(64),
      operation: "plan",
      status: "applied",
      counts: { planned: 1 },
    },
    now: 1_720_000_000_000,
    ...overrides,
  };
}

function multiRowBatch(size: number, firstText = "生产发布前必须完成回归测试"):
  HistoryRebuildBatchCommit {
  const current = batch();
  const sourceRows = Array.from({ length: size }, (_, index) => {
    const recordId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const sourceHash = createHash("sha256").update(`source:${index}`).digest("hex");
    return {
      ...current.sourceRows[0]!,
      recordId,
      sourceHash,
      contentHash: sourceHash,
      text: index === 0 ? firstText : `历史记忆 ${index + 1}`,
      evidenceIds: [recordId],
    };
  });
  const plans = sourceRows.map((source, index) => ({
    ...current.plans[0]!,
    recordId: source.recordId,
    sourceHash: source.sourceHash,
    receiptHash: createHash("sha256").update(`plan:${index}`).digest("hex"),
  }));
  return batch({
    nextAfterId: sourceRows.at(-1)?.recordId ?? null,
    counts: {
      total: size, preserve: 0, backfill: size, modelClassify: 0,
      lookupOnly: 0, quarantine: 0,
    },
    sourceRows,
    plans,
    operationReceipt: {
      ...current.operationReceipt,
      counts: { planned: size },
    },
  });
}

function frozenRows(current = batch()) {
  return current.sourceRows.map((source) => ({
    source_table: source.sourceTable,
    record_id: source.recordId,
    source_hash: source.sourceHash,
    source_row: source,
    plan: current.plans.find((candidate) => candidate.recordId === source.recordId),
  }));
}

describe("Postgres history rebuild repository", () => {
  test("source kind treats explicit legacy kind as authoritative over orthogonal category", () => {
    expect(historyRebuildSourceKind("memories", {
      metadata: { kind: "task" }, category: "fact", data_type: "memory",
    })).toEqual({ kind: "task", conflict: false });
    expect(historyRebuildSourceKind("memories", {
      metadata: { kind: "task", memoryKind: "decision" }, category: "fact",
      data_type: "memory",
    })).toEqual({ kind: "task", conflict: true });
  });

  test("rejects legacy or unbound history tree routing policy versions", () => {
    const current = batch();
    expect(() => planHistoryRebuildTreeRouting({
      source: current.sourceRows[0]!,
      plan: current.plans[0]!,
      policy: { ...treePolicy(), version: "history-tree-routing/v1" } as never,
    })).toThrow();
    expect(() => planHistoryRebuildTreeRouting({
      source: current.sourceRows[0]!,
      plan: current.plans[0]!,
      policy: { ...treePolicy(), scopeFingerprint: "f".repeat(64) },
    })).toThrow();
    expect(() => planHistoryRebuildTreeRouting({
      source: current.sourceRows[0]!,
      plan: current.plans[0]!,
      policy: {
        ...treePolicy(),
        source: { ...treePolicy().source, version: "auditable-source-identity/v0" },
      } as never,
    })).toThrow();
  });

  test("resolves aliases through the scope taxonomy and caps canonical topics at three", () => {
    const current = batch();
    const plan = {
      ...current.plans[0]!,
      topicLabels: ["postgres", "PostgreSQL", "Release Safety", "Alpha Topic", "Zeta Topic"],
    };

    const decision = planHistoryRebuildTreeRouting({
      source: current.sourceRows[0]!, plan, policy: treePolicy(),
    });

    expect(decision.topic).toMatchObject({
      eligible: true,
      labels: ["postgresql", "alpha-topic", "release-safety"],
      reason: "canonical_topics_selected",
    });
    expect(decision.topic.droppedLabels).toEqual(["zeta-topic"]);
    expect(decision.policyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.receiptHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("downgrades singleton topics below the scope minimum support", () => {
    const current = batch();
    const policy = treePolicy({
      topic: {
        version: "scope-topic-taxonomy/v1",
        minimumSupport: 2,
        maxLabelsPerRecord: 3,
        taxonomy: [{ canonicalLabel: "release-safety", aliases: [], support: 1 }],
      },
    });

    expect(planHistoryRebuildTreeRouting({
      source: current.sourceRows[0]!, plan: current.plans[0]!, policy,
    }).topic).toEqual({
      eligible: false,
      labels: [],
      droppedLabels: ["release-safety"],
      reason: "below_minimum_support",
    });
  });

  test("groups audited document identities within one scope", () => {
    const current = batch();
    const withoutSession = { ...scope, sessionId: undefined };
    const first = { ...current.sourceRows[0]!, scope: withoutSession };
    const second = {
      ...first, recordId: SECOND_ID, sourceHash: "b".repeat(64), text: "同一文档的第二条记忆",
    };
    const secondPlan = {
      ...current.plans[0]!, recordId: second.recordId, sourceHash: second.sourceHash,
      receiptHash: "d".repeat(64),
    };
    const policy = treePolicy({
      scopeFingerprint: authorityScopeFingerprint(withoutSession),
      source: {
        version: "auditable-source-identity/v1",
        identities: [first, second].map((source, index) => ({
          recordId: source.recordId,
          sourceHash: source.sourceHash,
          kind: "document" as const,
          identity: "document:release-runbook",
          receiptHash: String(index + 1).repeat(64),
        })),
      },
    });

    const firstDecision = planHistoryRebuildTreeRouting({
      source: first, plan: current.plans[0]!, policy,
    });
    const secondDecision = planHistoryRebuildTreeRouting({
      source: second, plan: secondPlan, policy,
    });
    expect(firstDecision.source).toMatchObject({
      eligible: true, kind: "document", reason: "audited_source_identity",
    });
    expect(secondDecision.source.treeKey).toBe(firstDecision.source.treeKey);
    const firstMaterial = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source: first, plan: current.plans[0]!, policy,
    });
    const secondMaterial = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source: second, plan: secondPlan, policy,
    });
    expect(firstMaterial?.treeJobs.find((job) => job.artifactRole === "source_leaf")
      ?.payload.treeKey).toBe(secondMaterial?.treeJobs.find((job) =>
      job.artifactRole === "source_leaf")?.payload.treeKey);
  });

  test("downgrades source routing without auditable provenance instead of using evidence identity", () => {
    const current = batch();
    const withoutSession = { ...current.sourceRows[0]!, scope: { ...scope, sessionId: undefined } };
    const policy = treePolicy({
      scopeFingerprint: authorityScopeFingerprint(withoutSession.scope),
    });

    expect(planHistoryRebuildTreeRouting({
      source: withoutSession, plan: current.plans[0]!, policy,
    }).source).toEqual({
      eligible: false,
      reason: "missing_auditable_source_identity",
    });
  });

  test("binds source identity to scope and never merges the same provenance across scopes", () => {
    const current = batch();
    const firstScope = { ...scope, sessionId: undefined };
    const secondScope = { ...firstScope, projectId: "project-b" };
    const sourceFor = (targetScope: MemoryScope) => ({
      ...current.sourceRows[0]!, scope: targetScope,
    });
    const policyFor = (targetScope: MemoryScope) => treePolicy({
      scopeFingerprint: authorityScopeFingerprint(targetScope),
      source: {
        version: "auditable-source-identity/v1",
        identities: [{
          recordId: ID, sourceHash: HASH, kind: "provenance" as const,
          identity: "connector:shared-source", receiptHash: "e".repeat(64),
        }],
      },
    });
    const firstPolicy = policyFor(firstScope);
    const first = planHistoryRebuildTreeRouting({
      source: sourceFor(firstScope), plan: current.plans[0]!, policy: firstPolicy,
    });
    const second = planHistoryRebuildTreeRouting({
      source: sourceFor(secondScope), plan: current.plans[0]!, policy: policyFor(secondScope),
    });

    expect(first.source.treeKey).not.toBe(second.source.treeKey);
    expect(() => planHistoryRebuildTreeRouting({
      source: sourceFor(secondScope), plan: current.plans[0]!, policy: firstPolicy,
    })).toThrow();
  });

  test("refuses tree materialization without an explicit v2 routing policy", () => {
    const current = batch();
    expect(() => buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source: current.sourceRows[0]!, plan: current.plans[0]!,
    })).toThrow();
  });

  test("apply rejects missing v2 policy before opening a transaction", async () => {
    const client = new ScriptedClient(() => ({ rows: [], rowCount: 0 }));
    await expect(new PostgresHistoryRebuildRepository(client).applyRun({
      runId: RUN_ID, scope, now: 1_720_000_000_001,
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_INPUT" });
    expect(client.calls).toEqual([]);
  });

  test("apply rejects a persisted policy hash drift before reading frozen material", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:run-lock")
      ? { rows: [{ state: "running", policy_hash: "f".repeat(64) }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    await expect(new PostgresHistoryRebuildRepository(client).applyRun({
      runId: RUN_ID, scope, now: 1_720_000_000_001, treePolicy: treePolicy(),
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
    expect(client.calls.some(({ sql }) => sql.includes("history-rebuild:frozen-material")))
      .toBe(false);
    expect(client.calls.map(({ sql }) => sql)).toEqual([
      "BEGIN", expect.stringContaining("history-rebuild:run-lock"), "ROLLBACK",
    ]);
  });

  test("materialization records singleton downgrade and omits topic tree jobs", () => {
    const current = batch();
    const policy = treePolicy({
      topic: {
        version: "scope-topic-taxonomy/v1",
        minimumSupport: 2,
        maxLabelsPerRecord: 3,
        taxonomy: [{ canonicalLabel: "release-safety", aliases: [], support: 1 }],
      },
    });
    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source: current.sourceRows[0]!, plan: current.plans[0]!, policy,
    });

    expect(material?.treeJobs.map((job) => job.artifactRole)).toEqual([
      "source_leaf", "source_finalize",
    ]);
    expect(material?.plan).toMatchObject({
      topicLabels: [],
      treeEligibility: { source: true, topic: false, global: false },
    });
    expect(material?.resultingMetadata).toMatchObject({
      topicLabels: [],
      historyRebuild: {
        treeRouting: {
          policyVersion: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
          sourceReason: "audited_session_identity",
          topicReason: "below_minimum_support",
          policyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
          receiptHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      },
    });
  });

  test("materialization never creates a source target from per-record evidence fallback", () => {
    const current = batch();
    const source = { ...current.sourceRows[0]!, scope: { ...scope, sessionId: undefined } };
    const policy = treePolicy({
      scopeFingerprint: authorityScopeFingerprint(source.scope),
    });
    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source, plan: current.plans[0]!, policy,
    });

    expect(material?.treeJobs.map((job) => job.artifactRole)).toEqual([
      "topic_leaf", "topic_finalize",
    ]);
    expect(material?.treeJobs.some((job) =>
      job.payload.treeType === "source" || job.payload.treeKey === material.evidenceId)).toBe(false);
    expect(material?.resultingMetadata).toMatchObject({
      historyRebuild: { treeRouting: { sourceReason: "missing_auditable_source_identity" } },
    });
  });

  test("materializes deterministic archived evidence mirrors and native append/finalize jobs", () => {
    const current = batch();
    const source = current.sourceRows[0]!;
    const plan = current.plans[0]!;

    const policy = treePolicy();
    const first = buildHistoryRebuildMemoryMaterial({ runId: RUN_ID, source, plan, policy });
    const replay = buildHistoryRebuildMemoryMaterial({ runId: RUN_ID, source, plan, policy });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      resultingLifecycleStatus: "active",
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      evidenceMetadata: {
        admissionRoute: "evidence_only",
        contextEligible: false,
        memoryContainer: "session_candidate",
        governance: {
          commandType: "importEvidence",
          evidenceIds: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
        },
      },
    });
    const evidenceId = first?.evidenceId;
    expect(first?.resultingMetadata).toMatchObject({
      sourceNodeIds: [evidenceId],
      governance: {
        evidenceIds: [evidenceId],
        candidate: { evidence: { eventIds: [evidenceId] } },
      },
    });
    expect(first?.treeJobs).toHaveLength(4);
    expect(first?.treeJobs.map((job) => job.artifactRole)).toEqual([
      "source_leaf", "source_finalize", "topic_leaf", "topic_finalize",
    ]);
    expect(first?.treeJobs.filter((job) => job.artifactRole.endsWith("_leaf"))
      .map((job) => job.payload)).toSatisfy((payloads: Readonly<Record<string, unknown>>[]) =>
      payloads.every((payload) => "leaf" in payload && "targetIdempotencyKey" in payload));
    expect(first?.treeJobs.filter((job) => job.artifactRole.endsWith("_leaf"))
      .map((job) => job.maxAttempts)).toEqual([3, 3]);
    expect(first?.treeJobs.filter((job) => job.artifactRole.endsWith("_finalize"))
      .map((job) => job.payload)).toSatisfy((payloads: Readonly<Record<string, unknown>>[]) =>
      payloads.every((payload) => {
        const finalize = payload.finalize as Record<string, unknown> | undefined;
        return !("leaf" in payload) && finalize?.mode === "history_rebuild" &&
          typeof finalize.expectedBufferId === "string" &&
          finalize.expectedBufferId.startsWith("buf_");
      }));
    expect(first?.treeJobs.filter((job) => job.artifactRole.endsWith("_finalize"))
      .map((job) => job.maxAttempts)).toEqual([100, 100]);
    expect(new Set(first?.treeJobs.map((job) => job.dedupeKey)).size).toBe(4);
    expect(new Set(first?.treeJobs.map((job) => job.scopedDedupeKey)).size).toBe(4);
  });

  test("lookup-only archives the source as a session candidate while disabling context and tree", () => {
    const current = batch();
    const source = current.sourceRows[0]!;
    const plan = {
      ...current.plans[0]!,
      disposition: "lookup_only" as const,
      semanticType: undefined,
      topicLabels: [],
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
      reason: "model_confidence_below_threshold" as const,
    };

    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID, source, plan, policy: treePolicy(),
    });

    expect(material).toMatchObject({
      source: { lifecycleStatus: "active" },
      resultingLifecycleStatus: "archived",
      resultingMetadata: {
        admissionRoute: "lookup_only",
        contextEligible: false,
        memoryContainer: "session_candidate",
        historyRebuild: { disposition: "lookup_only" },
        governance: {
          native: { container: "session_candidate" },
        },
      },
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      treeJobs: [],
    });
  });

  test("lists all canonical scopes with empty workspace/session via aggregate keyset", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:list-scopes")
      ? { rows: [{
          tenant_id: scope.tenantId, user_id: scope.userId,
          canonical_project_id: scope.projectId, product_id: scope.appId,
          producer_id: scope.agentId, namespace: scope.namespace, visibility: scope.visibility,
          workspace_id: "", session_id: "", memories_count: "10", knowledge_count: "2",
        }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const repository = new PostgresHistoryRebuildRepository(client);

    await expect(repository.listScopes({ limit: 25 })).resolves.toEqual([{
      scope: {
        tenantId: scope.tenantId, userId: scope.userId, projectId: scope.projectId,
        appId: scope.appId, agentId: scope.agentId, namespace: scope.namespace,
        visibility: scope.visibility,
      },
      memoriesCount: 10,
      knowledgeCount: 2,
    }]);
    const sql = client.calls[0]?.sql ?? "";
    expect(sql).toContain("UNION ALL");
    expect(sql).toContain("COALESCE(workspace_id, '')");
    expect(sql).toContain("COALESCE(metadata->>'sessionId', '')");
    expect(sql).toContain("ROW(tenant_id, user_id, canonical_project_id");
    expect(sql).toContain("ORDER BY tenant_id, user_id, canonical_project_id");
    expect(sql).toContain("metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'");
  });

  test("creates one immutable exact-scope run with memories/knowledge upper bounds", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:source-snapshot")) {
        return { rows: [{ source_upper_bound: ID, source_count: "1" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);

    const result = await repository.createRun({
      runId: RUN_ID,
      migrationId: "history-rebuild-5type-tree-v1",
      scope,
      manifestHash: HASH,
      modelFingerprint: "b".repeat(64),
      promptHash: "c".repeat(64),
      schemaHash: "d".repeat(64),
      policyHash: "e".repeat(64),
      now: 1_720_000_000_000,
    });

    expect(result.snapshots.map((item) => item.sourceTable)).toEqual(["memories", "knowledge"]);
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    const scans = client.calls.filter(({ sql }) => sql.includes("history-rebuild:source-snapshot"));
    expect(scans).toHaveLength(2);
    expect(scans.map(({ sql }) => sql)).toSatisfy((values: string[]) => values.every((sql) =>
      sql.includes("array_agg(id ORDER BY id DESC)") && !sql.includes("MAX(id)")));
    expect(scans.map(({ sql }) => sql)).toSatisfy((values: string[]) => values.every((sql) =>
      sql.includes("tenant_id = $1") && sql.includes("user_id = $2") &&
      sql.includes("canonical_project_id = $3") && sql.includes("product_id = $4") &&
      sql.includes("producer_id = $5") && sql.includes("namespace = $6") &&
      sql.includes("visibility = $7") && sql.includes("COALESCE(workspace_id, '') = $8") &&
      sql.includes("COALESCE(metadata->>'sessionId', '') = $9")));
    expect(scans.map(({ sql }) => sql)).toSatisfy((values: string[]) => values.every((sql) =>
      sql.includes("metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'")));
    const runInsert = client.calls.find(({ sql }) => sql.includes("history-rebuild:run-insert"));
    expect(runInsert?.sql).toContain("tenant_id, user_id, project_id, app_id");
    expect(runInsert?.params.slice(3, 7)).toEqual([
      scope.tenantId, scope.userId, scope.projectId, scope.appId,
    ]);
  });

  test("resumes a legacy attempt using its frozen snapshot and checkpoint", async () => {
    const existingRunId = "history-existing-v1";
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:source-snapshot")) {
        return { rows: [{ source_upper_bound: ID, source_count: "1" }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:run-insert")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("history-rebuild:resumable-run")) {
        return { rows: [{ run_id: existingRunId, state: "running" }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:resumable-snapshots")) {
        const runInsert = client.calls.find(({ sql: statement }) =>
          statement.includes("history-rebuild:run-insert"));
        const attemptHash = String(runInsert?.params[17]);
        expect(attemptHash).toMatch(/^[0-9a-f]{64}$/);
        return {
          rows: [
            { source_table: "memories", source_upper_bound: ID, source_count: "1",
              snapshot_hash: hashSnapshot("memories"), after_id: ID,
              checkpoint_version: "1", checkpoint_state: "completed", processed_count: "1" },
            { source_table: "knowledge", source_upper_bound: ID, source_count: "1",
              snapshot_hash: hashSnapshot("knowledge"), after_id: null,
              checkpoint_version: "0", checkpoint_state: "running", processed_count: "0" },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const hashSnapshot = (sourceTable: "memories" | "knowledge") => createHash("sha256")
      .update(`mengshu.history-rebuild-snapshot/v1\0${JSON.stringify({
        scopeFingerprint: authorityScopeFingerprint(scope), sourceCount: 1,
        sourceTable, sourceUpperBound: ID,
      })}`)
      .digest("hex");
    const result = await new PostgresHistoryRebuildRepository(client).createRun({
      runId: RUN_ID, migrationId: "history-rebuild-resume-v1", scope,
      manifestHash: HASH, modelFingerprint: "b".repeat(64), promptHash: "c".repeat(64),
      schemaHash: "d".repeat(64), policyHash: "e".repeat(64), now: 1_720_000_000_000,
    });

    expect(result).toMatchObject({ runId: existingRunId, state: "running" });
    expect(result.snapshots).toMatchObject([
      { sourceTable: "memories", processedCount: 1, checkpointVersion: 1,
        checkpointState: "completed", afterId: ID },
      { sourceTable: "knowledge", processedCount: 0, checkpointVersion: 0,
        checkpointState: "running", afterId: null },
    ]);
  });

  test("reserves, completes and replays one durable model attempt without another reservation", async () => {
    const input = modelAttemptInput();
    const output = {
      confidence: 0.91, recordId: ID, semanticType: "experience",
      sourceHash: input.sourceHash, topicLabels: ["migration-safety"],
    };
    const outputHash = createHash("sha256").update(JSON.stringify(output)).digest("hex");
    let completed = false;
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:model-attempt-read")) {
        return completed ? { rows: [{
          migration_id: input.migrationId, manifest_hash: input.manifestHash,
          run_id: input.runId, source_table: input.sourceTable, record_id: input.recordId,
          source_hash: input.sourceHash, attempt: "0", model_fingerprint: input.modelFingerprint,
          prompt_hash: input.promptHash, schema_hash: input.schemaHash, input_hash: input.inputHash,
          state: "completed", output, output_hash: outputHash,
          actual_input_tokens: "120", actual_output_tokens: "24", actual_cost_minor_units: "4",
        }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes("history-rebuild:model-attempt-budget")) {
        return { rows: [{ model_calls: "0", input_tokens: "0",
          output_tokens: "0", cost_minor_units: "0" }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:model-attempt-complete")) completed = true;
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);

    await expect(repository.reserveModelAttempt(input)).resolves.toEqual({ state: "reserved" });
    await expect(repository.completeModelAttempt({
      ...input,
      result: { version: 1, output, outputHash,
        usage: { modelCalls: 1, inputTokens: 120, outputTokens: 24, costMinorUnits: 4 } },
    })).resolves.toBeUndefined();
    await expect(repository.reserveModelAttempt(input)).resolves.toMatchObject({
      state: "completed", result: { outputHash, usage: { modelCalls: 1, outputTokens: 24 } },
    });
    expect(client.calls.filter(({ sql }) => sql.includes("model-attempt-reserve"))).toHaveLength(1);
    expect(client.calls.filter(({ sql }) => sql.includes("model-attempt-complete"))).toHaveLength(1);
    expect(client.calls.filter(({ sql }) => sql.includes("model-attempt-lock"))).toHaveLength(2);
    expect(client.calls.find(({ sql }) => sql.includes("model-attempt-lock"))?.sql)
      .toContain("$1::text, $2::text");
  });

  test("counts an unknown reservation at its ceiling and refuses an over-budget attempt", async () => {
    const input = modelAttemptInput();
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:model-attempt-read")) return { rows: [], rowCount: 0 };
      if (sql.includes("history-rebuild:model-attempt-budget")) return {
        rows: [{ model_calls: "10", input_tokens: "1200",
          output_tokens: "640", cost_minor_units: "90" }], rowCount: 1,
      };
      return { rows: [], rowCount: 1 };
    });
    await expect(new PostgresHistoryRebuildRepository(client).reserveModelAttempt(input))
      .resolves.toEqual({ state: "budget_exceeded" });
    expect(client.calls.some(({ sql }) => sql.includes("model-attempt-reserve"))).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("lets the migration-lock owner advance past an unresolved durable attempt", async () => {
    const input = modelAttemptInput();
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:model-attempt-read")) {
        return { rows: [{
          migration_id: input.migrationId, manifest_hash: input.manifestHash,
          run_id: input.runId, source_table: input.sourceTable, record_id: input.recordId,
          source_hash: input.sourceHash, attempt: String(input.attempt),
          model_fingerprint: input.modelFingerprint, prompt_hash: input.promptHash,
          schema_hash: input.schemaHash, input_hash: input.inputHash, state: "reserved",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);

    await expect(repository.reserveModelAttempt(input))
      .resolves.toEqual({ state: "in_flight_or_unknown" });
    await expect(repository.reserveModelAttempt({ ...input, resumeUnresolved: true }))
      .resolves.toEqual({ state: "retry_next_attempt" });
  });

  test("reads migration-wide durable attempt usage with immutable run pins", async () => {
    const client = new ScriptedClient((sql, params) => {
      if (!sql.includes("history-rebuild:model-usage")) return { rows: [], rowCount: 0 };
      expect(params).toEqual([
        "history-rebuild-resume-v1", HASH, "b".repeat(64), "c".repeat(64), "d".repeat(64),
      ]);
      return {
        rows: [{
          model_calls: "3", input_tokens: "1200", output_tokens: "240", cost_minor_units: "18",
          binding_drift_count: "0",
        }],
        rowCount: 1,
      };
    });

    await expect(new PostgresHistoryRebuildRepository(client).readModelUsage({
      migrationId: "history-rebuild-resume-v1",
      manifestHash: HASH,
      modelFingerprint: "b".repeat(64),
      promptHash: "c".repeat(64),
      schemaHash: "d".repeat(64),
    })).resolves.toEqual({
      modelCalls: 3, inputTokens: 1200, outputTokens: 240, costMinorUnits: 18,
    });
    const sql = client.calls[0]?.sql ?? "";
    expect(sql).toContain("FROM mengshu_history_rebuild_model_attempts attempt");
    expect(sql).toContain("attempt.state = 'completed'");
    expect(sql).toContain("attempt.migration_id = $1");
    expect(sql).toContain("attempt.manifest_hash = $2");
  });

  test("fails closed when durable model usage is bound to different run pins", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:model-usage")
      ? { rows: [{ model_calls: "1", input_tokens: "10", output_tokens: "2", cost_minor_units: "1",
          binding_drift_count: "1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 });

    await expect(new PostgresHistoryRebuildRepository(client).readModelUsage({
      migrationId: "history-rebuild-resume-v1",
      manifestHash: HASH,
      modelFingerprint: "b".repeat(64), promptHash: "c".repeat(64),
      schemaHash: "d".repeat(64),
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_DB_RESULT" });
  });

  test("accepts listScopes output with omitted workspace/session as canonical empty dimensions", async () => {
    const unscoped = { ...scope, workspaceId: undefined, sessionId: undefined };
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:source-snapshot")
      ? { rows: [{ source_upper_bound: ID, source_count: "1" }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    await new PostgresHistoryRebuildRepository(client).createRun({
      runId: "history-empty-scope-v1", migrationId: "history-empty-scope-v1",
      scope: unscoped, manifestHash: HASH, modelFingerprint: "b".repeat(64),
      promptHash: "c".repeat(64), schemaHash: "d".repeat(64),
      policyHash: "e".repeat(64), now: 1_720_000_000_000,
    });
    const scan = client.calls.find(({ sql }) => sql.includes("history-rebuild:source-snapshot"));
    expect(scan?.params.slice(7, 9)).toEqual(["", ""]);
  });

  test.each(["memories", "knowledge"] as const)(
    "keyset scans %s inside the pinned upper bound and reconstructs a source hash",
    async (sourceTable) => {
      const client = new ScriptedClient((sql) => sql.includes("history-rebuild:keyset-scan")
        ? { rows: [sourceRow(sourceTable)], rowCount: 1 }
        : { rows: [], rowCount: 0 });
      const repository = new PostgresHistoryRebuildRepository(client);

      const [record] = await repository.scanBatch({
        runId: RUN_ID,
        scope,
        sourceTable,
        afterId: null,
        sourceUpperBound: ID,
        batchSize: 50,
      });

      expect(record).toMatchObject({ sourceTable, recordId: ID, sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(record?.kind).toBe(sourceTable === "knowledge" ? "knowledge" : "decision");
      const call = client.calls.find(({ sql }) => sql.includes("history-rebuild:keyset-scan"))!;
      expect(call.sql).toContain(
        "metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'",
      );
      expect(call.sql).toContain("($10::uuid IS NULL OR id > $10::uuid)");
      expect(call.sql).toContain("id <= $11::uuid");
      expect(call.sql).toContain("importance::double precision AS importance");
      expect(call.sql).toContain("ORDER BY id ASC");
      expect(call.sql).toContain("COALESCE(workspace_id, '') AS workspace_id");
      expect(call.sql).toContain("COALESCE(metadata->>'sessionId', '') AS session_id");
      expect(call.params.slice(0, 9)).toEqual([
        scope.tenantId, scope.userId, scope.projectId, scope.appId, scope.agentId,
        scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      ]);
    },
  );

  test("preserves a legacy NULL importance while decoding a frozen memory row", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:keyset-scan")
      ? { rows: [{ ...sourceRow(), importance: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const repository = new PostgresHistoryRebuildRepository(client);

    const [record] = await repository.scanBatch({
      runId: RUN_ID,
      scope,
      sourceTable: "memories",
      afterId: null,
      sourceUpperBound: ID,
      batchSize: 50,
    });

    expect(record).not.toHaveProperty("importance");
    expect(record).toMatchObject({
      sourceTable: "memories",
      recordId: ID,
      sourceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("freezes an empty legacy knowledge row so the funnel can quarantine it", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:keyset-scan")
      ? { rows: [{ ...sourceRow("knowledge"), text: "" }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    const repository = new PostgresHistoryRebuildRepository(client);

    const [record] = await repository.scanBatch({
      runId: RUN_ID,
      scope,
      sourceTable: "knowledge",
      afterId: null,
      sourceUpperBound: ID,
      batchSize: 50,
    });

    expect(record?.text).toBe("");
    expect(planHistoryRebuild(record!)).toMatchObject({
      disposition: "quarantine",
      reason: "invalid_source_row",
      contextEligible: false,
      treeEligibility: { source: false, topic: false, global: false },
    });
  });

  test("commits an empty legacy knowledge row as a quarantined shadow plan", async () => {
    const source = { ...batch().sourceRows[0]!, sourceTable: "knowledge" as const, text: "",
      kind: "knowledge" as const, canCreateEvidenceMirror: false };
    const plan = planHistoryRebuild(source);
    const input = batch({
      sourceTable: "knowledge", sourceRows: [source], plans: [plan],
      counts: { total: 1, preserve: 0, backfill: 0, modelClassify: 0,
        lookupOnly: 0, quarantine: 1 },
    });
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:checkpoint-lock")) {
        return { rows: [{ after_id: null, checkpoint_version: "0", state: "running" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(input))
      .resolves.toMatchObject({ checkpointVersion: 1 });
    const storedPlan = client.calls.find(({ sql }) => sql.includes("history-rebuild:shadow-plan"));
    expect(JSON.parse(String(storedPlan?.params[2]))).toEqual([
      expect.objectContaining({
        disposition: "quarantine", semantic_type: null, reason: "invalid_source_row",
      }),
    ]);
  });

  test("uses the compatibility importance only for derived history artifacts", () => {
    const current = batch();
    const { importance: _legacyNull, ...sourceWithoutImportance } = current.sourceRows[0]!;

    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID,
      source: sourceWithoutImportance,
      plan: current.plans[0]!,
      policy: treePolicy(),
    });

    expect(material?.source).not.toHaveProperty("importance");
    expect(material?.resultingMetadata).toMatchObject({ importance: 0.7 });
    expect(material?.evidenceMetadata).toMatchObject({ importance: 0.7 });
    expect(material?.treeJobs.filter((job) => job.artifactRole.endsWith("_leaf")))
      .toSatisfy((jobs: ReadonlyArray<{ payload: Record<string, unknown> }>) =>
        jobs.every(({ payload }) => {
          const routing = payload.routing as Record<string, unknown> | undefined;
          return routing?.importance === 0.7;
        }));
  });

  test("canonicalizes unordered topic labels and merges normalization collisions", () => {
    const current = batch();
    const unordered = {
      ...current.plans[0]!,
      topicLabels: ["Zeta Topic", "alpha-topic"],
    };
    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID,
      source: current.sourceRows[0]!,
      plan: unordered,
      policy: treePolicy(),
    });

    expect(material?.treeJobs.filter((job) => job.artifactRole === "topic_leaf")
      .map((job) => job.payload.treeKey)).toEqual(["alpha-topic", "zeta-topic"]);
    expect(material?.plan).toMatchObject({
      topicLabels: ["alpha-topic", "zeta-topic"],
      treeEligibility: { source: true, topic: true, global: false },
    });
    expect(buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID,
      source: current.sourceRows[0]!,
      plan: { ...unordered, topicLabels: ["Zeta Topic", "zeta-topic"] },
      policy: treePolicy(),
    })?.treeJobs.filter((job) => job.artifactRole === "topic_leaf")
      .map((job) => job.payload.treeKey)).toEqual(["zeta-topic"]);
  });

  test("does not publish frozen workspace rules to the global tree without eligibility", () => {
    const current = batch();
    const source = {
      ...current.sourceRows[0]!,
      scope: { ...current.sourceRows[0]!.scope, sessionId: undefined },
    };
    const policy = treePolicy({
      scopeFingerprint: authorityScopeFingerprint(source.scope),
      source: {
        version: "auditable-source-identity/v1",
        identities: [{
          recordId: source.recordId, sourceHash: source.sourceHash,
          kind: "provenance", identity: "workspace-rule-import",
          receiptHash: "9".repeat(64),
        }],
      },
    });
    const material = buildHistoryRebuildMemoryMaterial({
      runId: RUN_ID,
      source,
      plan: current.plans[0]!,
      policy,
    });

    expect(material?.treeJobs.map((job) => job.payload.treeType)).not.toContain("global");
    expect(material?.treeJobs.find((job) => job.artifactRole === "source_leaf")?.payload)
      .toMatchObject({ routing: { globalHotnessEligible: false } });
  });

  test("atomically appends plan/model/operation receipts and CAS-advances checkpoint", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:checkpoint-lock")) {
        return { rows: [{ after_id: null, checkpoint_version: "0", state: "running" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);
    const input = batch({
      counts: {
        total: 1, preserve: 0, backfill: 0, modelClassify: 1,
        lookupOnly: 0, quarantine: 0,
      },
      plans: [{
        ...batch().plans[0]!,
        disposition: "model_classify",
        reason: "model_classification_accepted",
        modelConfidence: 0.92,
      }],
      modelReceipts: [{
        receiptHash: "d".repeat(64), recordId: ID, sourceHash: HASH,
        planReceiptHash: batch().plans[0]!.receiptHash,
        modelFingerprint: "e".repeat(64), promptHash: "f".repeat(64),
        schemaHash: "1".repeat(64), inputHash: "2".repeat(64), outputHash: "3".repeat(64),
        confidence: 0.92, proposalCount: 1, inputTokens: 120, outputTokens: 24,
      }],
    });

    await expect(repository.commitBatch(input)).resolves.toMatchObject({
      afterId: ID, checkpointVersion: 1, state: "running",
    });
    const sql = client.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("history-rebuild:checkpoint-lock");
    expect(sql).toMatch(/SELECT after_id::text, checkpoint_version::text, checkpoint\.state/);
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("history-rebuild:source-row-snapshot");
    expect(sql).toContain("history-rebuild:shadow-plan");
    expect(sql).toContain("history-rebuild:model-receipt");
    expect(sql).toContain("JOIN mengshu_history_rebuild_shadow_plans plan");
    expect(sql).toContain("run.model_fingerprint = $6");
    expect(sql).toContain("run.prompt_hash = $7");
    expect(sql).toContain("run.schema_hash = $8");
    expect(sql).toContain("plan.plan_receipt_hash = $15");
    expect(sql).toContain("history-rebuild:operation-receipt");
    expect(sql).toContain("history-rebuild:checkpoint-cas");
    expect(sql).not.toMatch(/(?:UPDATE|INSERT INTO)\s+(?:memories|knowledge|mengshu_tree_)/i);
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
    expect(JSON.stringify(client.calls)).not.toContain("promptText");
  });

  test("bulk-inserts 500 source snapshots and plans with two parameterized SQL calls", async () => {
    const injectedText = "'); DROP TABLE memories; --";
    const input = multiRowBatch(500, injectedText);
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:checkpoint-lock")) {
        return { rows: [{ after_id: null, checkpoint_version: "0", state: "running" }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:source-row-snapshot")) {
        return { rows: [], rowCount: input.sourceRows.length };
      }
      if (sql.includes("history-rebuild:shadow-plan")) {
        return { rows: [], rowCount: input.plans.length };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(input))
      .resolves.toMatchObject({ checkpointVersion: 1, afterId: input.nextAfterId });

    const sourceCalls = client.calls.filter(({ sql }) =>
      sql.includes("history-rebuild:source-row-snapshot"));
    const planCalls = client.calls.filter(({ sql }) => sql.includes("history-rebuild:shadow-plan"));
    expect(sourceCalls).toHaveLength(1);
    expect(planCalls).toHaveLength(1);
    expect(sourceCalls[0]?.sql).toContain("jsonb_to_recordset");
    expect(planCalls[0]?.sql).toContain("jsonb_to_recordset");
    expect(sourceCalls[0]?.sql).not.toContain(injectedText);
    expect(planCalls[0]?.sql).not.toContain(injectedText);
    expect(sourceCalls[0]?.params).toHaveLength(4);
    expect(planCalls[0]?.params).toHaveLength(4);
    const sourcePayload = JSON.parse(String(sourceCalls[0]?.params[2]));
    const planPayload = JSON.parse(String(planCalls[0]?.params[2]));
    expect(sourcePayload).toHaveLength(500);
    expect(planPayload).toHaveLength(500);
    expect(sourcePayload[0]).toMatchObject({
      record_id: input.sourceRows[0]?.recordId,
      source_hash: input.sourceRows[0]?.sourceHash,
      source_row: {
        recordId: input.sourceRows[0]?.recordId,
        sourceHash: input.sourceRows[0]?.sourceHash,
        lifecycleStatus: "active",
      },
      original_lifecycle_status: "active",
      original_metadata_hash: createHash("sha256")
        .update("mengshu.history-rebuild-original-metadata/v1\0{}")
        .digest("hex"),
    });
    expect(planPayload[0]).toMatchObject({
      record_id: input.plans[0]?.recordId,
      source_hash: input.plans[0]?.sourceHash,
      plan_receipt_hash: input.plans[0]?.receiptHash,
    });
    expect(String(sourceCalls[0]?.params[2])).toContain(injectedText);
  });

  test.each(["source", "plan"] as const)(
    "rolls back when the %s bulk insert reports fewer rows than the batch",
    async (conflictStage) => {
      const input = multiRowBatch(3);
      const client = new ScriptedClient((sql) => {
        if (sql.includes("history-rebuild:checkpoint-lock")) {
          return {
            rows: [{ after_id: null, checkpoint_version: "0", state: "running" }], rowCount: 1,
          };
        }
        if (sql.includes("history-rebuild:source-row-snapshot")) {
          return {
            rows: [],
            rowCount: input.sourceRows.length - (conflictStage === "source" ? 1 : 0),
          };
        }
        if (sql.includes("history-rebuild:shadow-plan")) {
          return {
            rows: [], rowCount: input.plans.length - (conflictStage === "plan" ? 1 : 0),
          };
        }
        return { rows: [], rowCount: 1 };
      });

      await expect(new PostgresHistoryRebuildRepository(client).commitBatch(input))
        .rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
      expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
      expect(client.calls.filter(({ sql }) => sql.includes("history-rebuild:source-row-snapshot")))
        .toHaveLength(1);
      expect(client.calls.some(({ sql }) => sql.includes("history-rebuild:shadow-plan")))
        .toBe(conflictStage === "plan");
      expect(client.calls.some(({ sql }) => sql.includes("history-rebuild:operation-receipt")))
        .toBe(false);
    },
  );

  test("accepts a model receipt for topic-label-only enrichment without changing 5-type", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:checkpoint-lock")) {
        return { rows: [{ after_id: null, checkpoint_version: "0", state: "running" }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const current = batch({
      counts: {
        total: 1, preserve: 1, backfill: 0, modelClassify: 0,
        lookupOnly: 0, quarantine: 0,
      },
      plans: [{
        ...batch().plans[0]!,
        disposition: "preserve",
        reason: "valid_explicit_semantic_type",
      }],
      modelReceipts: [{
        receiptHash: "d".repeat(64), recordId: ID, sourceHash: HASH,
        planReceiptHash: batch().plans[0]!.receiptHash,
        modelFingerprint: "e".repeat(64), promptHash: "f".repeat(64),
        schemaHash: "1".repeat(64), inputHash: "2".repeat(64), outputHash: "3".repeat(64),
        confidence: 0.92, proposalCount: 1, inputTokens: 120, outputTokens: 24,
      }],
    });

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(current))
      .resolves.toMatchObject({ checkpointVersion: 1 });
  });

  test("rejects a model receipt for a deterministic plan without accepted topic enrichment", async () => {
    const client = new ScriptedClient(() => ({ rows: [], rowCount: 0 }));
    const current = batch({
      plans: [{
        ...batch().plans[0]!,
        disposition: "preserve",
        semanticType: "profile",
        topicLabels: [],
        contextEligible: true,
        treeEligibility: { source: false, topic: false, global: false },
        reason: "valid_explicit_semantic_type",
      }],
      modelReceipts: [{
        receiptHash: "d".repeat(64), recordId: ID, sourceHash: HASH,
        planReceiptHash: batch().plans[0]!.receiptHash,
        modelFingerprint: "e".repeat(64), promptHash: "f".repeat(64),
        schemaHash: "1".repeat(64), inputHash: "2".repeat(64), outputHash: "3".repeat(64),
        confidence: 0.82, proposalCount: 1, inputTokens: 120, outputTokens: 24,
      }],
    });

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(current))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_INPUT" });
    expect(client.calls).toHaveLength(0);
  });

  test("rejects a model receipt whose plan hash does not bind to the same shadow plan", async () => {
    const client = new ScriptedClient(() => ({ rows: [], rowCount: 0 }));
    const current = batch({
      counts: {
        total: 1, preserve: 0, backfill: 0, modelClassify: 1,
        lookupOnly: 0, quarantine: 0,
      },
      plans: [{
        ...batch().plans[0]!, disposition: "model_classify",
        reason: "model_classification_accepted", modelConfidence: 0.92,
      }],
      modelReceipts: [{
        receiptHash: "d".repeat(64), recordId: ID, sourceHash: HASH,
        planReceiptHash: "9".repeat(64),
        modelFingerprint: "e".repeat(64), promptHash: "f".repeat(64),
        schemaHash: "1".repeat(64), inputHash: "2".repeat(64), outputHash: "3".repeat(64),
        confidence: 0.92, proposalCount: 1, inputTokens: 120, outputTokens: 24,
      }],
    });

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(current))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_INPUT" });
    expect(client.calls).toHaveLength(0);
  });

  test("requires exactly one receipt for every model-classified plan", async () => {
    const client = new ScriptedClient(() => ({ rows: [], rowCount: 0 }));
    const plan = {
      ...batch().plans[0]!, disposition: "model_classify" as const,
      reason: "model_classification_accepted" as const, modelConfidence: 0.92,
    };
    const receipt = {
      receiptHash: "d".repeat(64), recordId: ID, sourceHash: HASH,
      planReceiptHash: plan.receiptHash,
      modelFingerprint: "e".repeat(64), promptHash: "f".repeat(64),
      schemaHash: "1".repeat(64), inputHash: "2".repeat(64), outputHash: "3".repeat(64),
      confidence: 0.92, proposalCount: 1, inputTokens: 120, outputTokens: 24,
    };
    const common = {
      counts: {
        total: 1, preserve: 0, backfill: 0, modelClassify: 1,
        lookupOnly: 0, quarantine: 0,
      },
      plans: [plan],
    };

    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(batch({
      ...common, modelReceipts: [],
    }))).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_INPUT" });
    await expect(new PostgresHistoryRebuildRepository(client).commitBatch(batch({
      ...common, modelReceipts: [receipt, { ...receipt, receiptHash: "4".repeat(64) }],
    }))).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_INPUT" });
    expect(client.calls).toHaveLength(0);
  });

  test("rolls back the whole batch on checkpoint drift", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:checkpoint-lock")
      ? { rows: [{ after_id: ID, checkpoint_version: "1", state: "running" }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const repository = new PostgresHistoryRebuildRepository(client);

    await expect(repository.commitBatch(batch())).rejects.toMatchObject({
      code: "HISTORY_REBUILD_CONCURRENT_DRIFT",
    } satisfies Partial<HistoryRebuildRepositoryError>);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(client.calls.some(({ sql }) => sql.includes("history-rebuild:shadow-plan"))).toBe(false);
  });

  test("knowledge is resource/evidence only and cannot enter context or any tree", async () => {
    const client = new ScriptedClient(() => ({ rows: [], rowCount: 0 }));
    const repository = new PostgresHistoryRebuildRepository(client);
    const invalid = batch({
      sourceTable: "knowledge",
      sourceRows: [{
        ...batch().sourceRows[0]!,
        sourceTable: "knowledge",
        kind: "knowledge",
      }],
      plans: [{
        ...batch().plans[0]!,
        sourceTable: "knowledge",
        semanticType: "rules",
        contextEligible: true,
        treeEligibility: { source: true, topic: true, global: true },
      }],
    });

    await expect(repository.commitBatch(invalid)).rejects.toMatchObject({
      code: "HISTORY_REBUILD_INVALID_INPUT",
    });
    expect(client.calls).toHaveLength(0);
  });

  test("applies frozen plans with metadata/lifecycle CAS, evidence links, and durable tree jobs", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("running");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      return sql.includes("history-rebuild:apply")
        ? { rows: [{
            active_count: "1", lookup_only_count: "0", classified_inactive_count: "0",
            evidence_mirror_count: "1", evidence_link_count: "1", tree_job_count: "4",
            expected_evidence_mirror_count: "1", expected_evidence_link_count: "1",
            expected_tree_job_count: "4", drift_count: "0",
          }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);

    await expect(repository.applyRun({
      runId: RUN_ID, scope, now: 1_720_000_000_001, treePolicy: treePolicy(),
    }))
      .resolves.toEqual({
        active: 1, lookupOnly: 0, classifiedInactive: 0,
        evidenceMirrors: 1, evidenceLinks: 1, treeJobs: 4,
      });
    const sql = client.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("history-rebuild:run-lock");
    expect(sql).toContain("history-rebuild:frozen-material");
    expect(sql).toContain("history-rebuild:apply");
    expect(sql).toContain("WHERE run_id = $1 AND state = 'completed'");
    expect(sql).toContain("SUM(source_count)");
    expect(sql).toContain("memory.metadata = material.source->'metadata'");
    expect(sql).toContain("material.resulting_lifecycle_status");
    expect(sql).toContain("mengshu_memory_evidence_links");
    expect(sql).toContain("history-rebuild:evidence-mirrors");
    expect(sql).toMatch(/visibility,\s*scope_key,\s*lifecycle_status/);
    expect(sql).toContain("mengshu_history_rebuild_artifacts");
    expect(sql).toContain("INSERT INTO mengshu_jobs_v2");
    expect(sql).toContain("'build_tree'");
    expect(sql).toContain("ON CONFLICT (scoped_dedupe_key) DO UPDATE SET");
    expect(sql).toContain("id = EXCLUDED.id");
    expect(sql).toContain("mengshu_jobs_v2.id LIKE 'history-job:%'");
    expect(sql).toContain("mengshu_jobs_v2.status = 'queued'");
    expect(sql).toContain("mengshu_jobs_v2.attempts = 0");
    expect(sql).toContain("mengshu_jobs_v2.lease_generation = 0");
    expect(sql).toContain("candidate.source_job_id = mengshu_jobs_v2.id");
    expect(sql).toContain("receipt.job_id = mengshu_jobs_v2.id");
    expect(sql).toContain("leaf.source_job_id = mengshu_jobs_v2.id");
    expect(sql).toContain("node.sealed_by_job_id = mengshu_jobs_v2.id");
    expect(sql).toContain("(job->>'maxAttempts')::integer");
    expect(sql).toContain("actual.max_attempts = expected.max_attempts");
    expect(sql).toContain("actual.status = 'completed'");
    expect(sql).toContain("mengshu_job_v2_effect_receipts reusable_receipt");
    expect(sql).toContain("reusable_receipt.effect_key = 'build_tree.persist.v1'");
    expect(sql).toContain("actual.id AS artifact_id");
    expect(sql).toContain("RETURNING id, scoped_dedupe_key");
    expect(sql).toContain("FROM inserted_jobs inserted");
    expect(sql).toContain("resolved.artifact_id");
    expect(sql).toContain("concat_ws(chr(31)");
    expect(sql).toContain("memory.importance IS NOT DISTINCT FROM");
    expect(sql).toContain("material.evidence_metadata->>'importance'");
    expect(sql).not.toContain("concat_ws(E'\\\\0'");
    expect(sql).not.toContain("'migrationRunId'");
    expect(sql).not.toMatch(/UPDATE\s+knowledge/i);
    const apply = client.calls.find((call) => call.sql.includes("history-rebuild:apply"));
    expect(apply?.params.at(-1)).toBe(
      "tenant-a:app-a:user-a:project-a:agent-a:working-context",
    );
    expect(JSON.parse(String(apply?.params.at(-2)))).toMatchObject([{
      source: { recordId: ID, sourceHash: HASH },
      plan: { semanticType: "rules" },
      evidenceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      treeJobs: expect.arrayContaining([
        expect.objectContaining({ artifactRole: "source_leaf" }),
        expect.objectContaining({ artifactRole: "source_finalize" }),
      ]),
    }]);
    expect(client.calls[0]?.sql).toBe("BEGIN");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("fails the whole apply when a scoped-dedupe job is not an exact reusable match", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("running");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      return sql.includes("history-rebuild:apply")
        ? { rows: [{
            active_count: "1", lookup_only_count: "0", classified_inactive_count: "0",
            evidence_mirror_count: "1", evidence_link_count: "1", tree_job_count: "3",
            expected_evidence_mirror_count: "1", expected_evidence_link_count: "1",
            expected_tree_job_count: "4", drift_count: "1",
          }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).applyRun({
      runId: RUN_ID, scope, now: 1_720_000_000_001, treePolicy: treePolicy(),
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
    const applySql = client.calls.find(({ sql }) => sql.includes("history-rebuild:apply"))?.sql ?? "";
    expect(applySql).toContain("actual.payload = expected.payload");
    expect(applySql).toContain("actual.dedupe_key = expected.dedupe_key");
    expect(applySql).toContain("actual.max_attempts = expected.max_attempts");
    expect(applySql).toContain("actual.status = 'completed'");
    expect(applySql).toContain("reusable_receipt.effect_key = 'build_tree.persist.v1'");
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  test("materializes one finalize per run, scope, and tree target across a frozen cohort", async () => {
    const current = batch();
    const secondSource = {
      ...current.sourceRows[0]!,
      recordId: SECOND_ID,
      sourceHash: "2".repeat(64),
      text: "灰度发布完成后再进入全量发布",
      contentHash: "3".repeat(64),
    };
    const secondPlan = {
      ...current.plans[0]!,
      recordId: SECOND_ID,
      sourceHash: secondSource.sourceHash,
      receiptHash: "4".repeat(64),
    };
    const cohort = batch({
      sourceRows: [current.sourceRows[0]!, secondSource],
      plans: [current.plans[0]!, secondPlan],
    });
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("running");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(cohort), rowCount: 2 };
      }
      return sql.includes("history-rebuild:apply")
        ? { rows: [{
            active_count: "2", lookup_only_count: "0", classified_inactive_count: "0",
            evidence_mirror_count: "2", evidence_link_count: "2", tree_job_count: "6",
            expected_evidence_mirror_count: "2", expected_evidence_link_count: "2",
            expected_tree_job_count: "6", drift_count: "0",
          }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).applyRun({
      runId: RUN_ID, scope, now: 1_720_000_000_001, treePolicy: treePolicy(),
    })).resolves.toMatchObject({ active: 2, treeJobs: 6 });
    const apply = client.calls.find(({ sql }) => sql.includes("history-rebuild:apply"));
    const material = JSON.parse(String(apply?.params.at(-2))) as Array<{
      source: { recordId: string };
      treeJobs: Array<{ artifactRole: string; scopedDedupeKey: string }>;
    }>;
    const jobs = material.flatMap((item) => item.treeJobs);
    const finalizers = jobs.filter((job) => job.artifactRole.endsWith("_finalize"));
    expect(jobs).toHaveLength(6);
    expect(finalizers).toHaveLength(2);
    expect(new Set(finalizers.map((job) => job.scopedDedupeKey)).size).toBe(2);
    expect(material.find((item) => item.source.recordId === SECOND_ID)?.treeJobs
      .filter((job) => job.artifactRole.endsWith("_finalize"))).toEqual([]);
  });

  test("verify is read-only and fails closed on source/result/tree parity drift", async () => {
    const healthy = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-state")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      return sql.includes("history-rebuild:verify")
        ? { rows: [{
            run_count: "1", total_source_count: "1", memory_source_count: "1",
            knowledge_source_count: "0", total_plan_count: "1", memory_plan_count: "1",
            knowledge_plan_count: "0", applied_memory_count: "1", unchanged_knowledge_count: "0",
            evidence_mirror_count: "1", evidence_link_count: "1", tree_job_count: "4",
            queued_tree_job_count: "4", completed_tree_job_count: "0",
            dead_letter_tree_job_count: "0", drift_count: "0",
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    await expect(new PostgresHistoryRebuildRepository(healthy).verifyRun({
      runId: RUN_ID, scope, treePolicy: treePolicy(),
    }))
      .resolves.toEqual({
        totalSourceCount: 1, memorySourceCount: 1, knowledgeSourceCount: 0,
        totalPlanCount: 1, memoryPlanCount: 1, knowledgePlanCount: 0,
        appliedMemoryCount: 1, unchangedKnowledgeCount: 0, evidenceMirrors: 1,
        evidenceLinks: 1, treeJobs: 4, queuedTreeJobs: 4,
        completedTreeJobs: 0, deadLetterTreeJobs: 0,
      });
    expect(healthy.calls).toHaveLength(3);
    const verifySql = healthy.calls.map((call) => call.sql).join("\n");
    expect(verifySql).toContain("$12::bigint = 0");
    expect(verifySql).toContain("evidence.scope_key = $14");
    expect(verifySql).toContain(
      "(material.evidence_metadata->>'importance')::double precision::numeric",
    );
    const verifyCall = healthy.calls.find((call) => call.sql.includes("history-rebuild:verify"));
    expect(verifyCall?.params.at(-1)).toBe(
      "tenant-a:app-a:user-a:project-a:agent-a:working-context",
    );
    expect(verifySql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);

    const drifted = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-state")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      return sql.includes("history-rebuild:verify")
        ? { rows: [{
            run_count: "1", total_source_count: "1", memory_source_count: "1",
            knowledge_source_count: "0", total_plan_count: "1", memory_plan_count: "1",
            knowledge_plan_count: "0", applied_memory_count: "0", unchanged_knowledge_count: "0",
            evidence_mirror_count: "0", evidence_link_count: "0", tree_job_count: "0",
            queued_tree_job_count: "0", completed_tree_job_count: "0",
            dead_letter_tree_job_count: "0", drift_count: "1",
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });
    await expect(new PostgresHistoryRebuildRepository(drifted).verifyRun({
      runId: RUN_ID, scope, treePolicy: treePolicy(),
    }))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
  });

  test("verify rejects a persisted policy hash drift before reading any material", async () => {
    const client = new ScriptedClient((sql) => sql.includes("history-rebuild:run-state")
      ? { rows: [{ state: "completed", policy_hash: "f".repeat(64) }], rowCount: 1 }
      : { rows: [], rowCount: 0 });
    await expect(new PostgresHistoryRebuildRepository(client).verifyRun({
      runId: RUN_ID, scope, treePolicy: treePolicy(),
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.sql).toContain("history-rebuild:run-state");
  });

  test("verifies a knowledge-only run with no mutable material or derived artifacts", async () => {
    const knowledgeBatch = batch({
      sourceTable: "knowledge",
      sourceRows: [{
        ...batch().sourceRows[0]!, sourceTable: "knowledge", kind: "knowledge",
        canCreateEvidenceMirror: false,
      }],
      plans: [{
        ...batch().plans[0]!, sourceTable: "knowledge", disposition: "preserve",
        semanticType: "resource", topicLabels: [], contextEligible: false,
        treeEligibility: { source: false, topic: false, global: false },
        reason: "knowledge_resource_only",
      }],
    });
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-state")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(knowledgeBatch), rowCount: 1 };
      }
      return sql.includes("history-rebuild:verify")
        ? { rows: [{
            run_count: "1", total_source_count: "1", memory_source_count: "0",
            knowledge_source_count: "1", total_plan_count: "1", memory_plan_count: "0",
            knowledge_plan_count: "1", applied_memory_count: "0", unchanged_knowledge_count: "1",
            evidence_mirror_count: "0", evidence_link_count: "0", tree_job_count: "0",
            queued_tree_job_count: "0", completed_tree_job_count: "0",
            dead_letter_tree_job_count: "0", drift_count: "0",
          }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).verifyRun({
      runId: RUN_ID, scope, treePolicy: treePolicy(),
    }))
      .resolves.toMatchObject({
        knowledgeSourceCount: 1, unchangedKnowledgeCount: 1,
        appliedMemoryCount: 0, evidenceMirrors: 0, treeJobs: 0,
      });
    const frozen = client.calls.find(({ sql }) => sql.includes("history-rebuild:frozen-material"));
    expect(frozen?.sql).toContain("source.source_table = 'memories'");
    const verify = client.calls.find(({ sql }) => sql.includes("history-rebuild:verify"));
    expect(verify?.params.at(-2)).toBe("[]");
    expect(verify?.params.at(-1)).toBe(
      "tenant-a:app-a:user-a:project-a:agent-a:working-context",
    );
  });

  test("rollback restores CAS rows and removes queued or receipt-free dead-letter tree jobs", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:rollback-preflight")) {
        return { rows: [{
          started_job_count: "0", tree_job_count: "4",
          evidence_link_count: "1", evidence_mirror_count: "1",
        }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      if (sql.includes("history-rebuild:rollback")) {
        return { rows: [{
          restored_count: "1", removed_job_count: "4", removed_link_count: "1",
          removed_evidence_mirror_count: "1", removed_artifact_count: "6", drift_count: "0",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresHistoryRebuildRepository(client);
    await expect(repository.rollbackRun({ runId: RUN_ID, scope, now: 1_720_000_000_002 }))
      .resolves.toEqual({ restored: 1, removedEvidenceMirrors: 1, removedTreeJobs: 4 });
    const sql = client.calls.map((call) => call.sql).join("\n");
    expect(sql).toContain("status = 'queued' AND attempts = 0");
    expect(sql).toContain("status = 'dead_letter'");
    expect(sql).toContain("effect_key = 'build_tree.persist.v1'");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("actual_max_attempts IS DISTINCT FROM max_attempts");
    expect(sql).toContain("run.scope_fingerprint = $2::text");
    expect(sql).toContain("actual_payload->'scope'->>'workspaceId'");
    expect(sql).toContain("actual_payload->'scope'->>'sessionId'");
    expect(sql).toContain("exact_job.scoped_dedupe_key = expected.scoped_dedupe_key");
    expect(sql).toContain("job.max_attempts = spec.max_attempts");
    expect(sql).toContain("unexpected_ledger");
    expect(sql).toContain("mengshu_history_rebuild_artifacts");
    expect(sql).toContain("metadata = material.source->'metadata'");
    expect(sql).toContain(
      "(material.evidence_metadata->>'importance')::double precision::numeric",
    );
    expect(sql).toContain("history-rebuild:rollback-receipt");
    expect(client.calls.at(-1)?.sql).toBe("COMMIT");
  });

  test("rollback restores the frozen active lifecycle after lookup-only archived materialization", async () => {
    const current = batch();
    const lookupOnly = batch({
      counts: {
        total: 1, preserve: 0, backfill: 0, modelClassify: 0,
        lookupOnly: 1, quarantine: 0,
      },
      plans: [{
        ...current.plans[0]!,
        disposition: "lookup_only",
        semanticType: undefined,
        topicLabels: [],
        contextEligible: false,
        treeEligibility: { source: false, topic: false, global: false },
        reason: "model_confidence_below_threshold",
      }],
    });
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(lookupOnly), rowCount: 1 };
      }
      if (sql.includes("history-rebuild:rollback-preflight")) {
        return { rows: [{
          started_job_count: "0", tree_job_count: "0",
          evidence_link_count: "1", evidence_mirror_count: "1",
        }], rowCount: 1 };
      }
      if (sql.includes("history-rebuild:rollback")) {
        return { rows: [{
          restored_count: "1", removed_job_count: "0", removed_link_count: "1",
          removed_evidence_mirror_count: "1", removed_artifact_count: "2", drift_count: "0",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(new PostgresHistoryRebuildRepository(client).rollbackRun({
      runId: RUN_ID, scope, now: 1_720_000_000_004,
    })).resolves.toEqual({ restored: 1, removedEvidenceMirrors: 1, removedTreeJobs: 0 });

    const rollbackCall = client.calls.find(({ sql }) => sql.includes("history-rebuild:rollback */"));
    const material = JSON.parse(String(rollbackCall?.params.at(-1))) as Array<{
      source: { lifecycleStatus: string };
      resultingLifecycleStatus: string;
    }>;
    expect(material).toMatchObject([{
      source: { lifecycleStatus: "active" },
      resultingLifecycleStatus: "archived",
    }]);
    expect(rollbackCall?.sql).toContain(
      "lifecycle_status = material.source->>'lifecycleStatus'",
    );
    expect(rollbackCall?.sql).toContain(
      "memory.lifecycle_status IS NOT DISTINCT FROM material.resulting_lifecycle_status",
    );
    expect(rollbackCall?.sql).toContain("history-rebuild:rollback-receipt");
  });

  test("rollback fails closed before mutation when any migration tree job has started", async () => {
    const client = new ScriptedClient((sql) => {
      if (sql.includes("history-rebuild:run-lock")) {
        return runState("completed");
      }
      if (sql.includes("history-rebuild:frozen-material")) {
        return { rows: frozenRows(), rowCount: 1 };
      }
      if (sql.includes("history-rebuild:rollback-preflight")) {
        return { rows: [{
          started_job_count: "1", tree_job_count: "4",
          evidence_link_count: "1", evidence_mirror_count: "1",
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    await expect(new PostgresHistoryRebuildRepository(client).rollbackRun({
      runId: RUN_ID, scope, now: 1_720_000_000_003,
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_CONCURRENT_DRIFT" });
    expect(client.calls.some(({ sql }) => sql.includes("history-rebuild:rollback */"))).toBe(false);
    expect(client.calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});
