import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import { planHistoryRebuild } from
  "../packages/core/src/db/migrations/history-rebuild.js";
import { historyRebuildTreeRoutingPolicyHash, planHistoryRebuildTreeRouting } from
  "../packages/core/src/db/migrations/postgres-history-rebuild.js";
import { authorityScopeFingerprint } from
  "../packages/core/src/domain/authority-scope-fingerprint.js";
import {
  deriveHistoryRebuildLlmPins,
  type HistoryRebuildLlmPlannerDependencies,
  type RunHistoryRebuildLlmPlannerInput,
} from "./history-rebuild-llm.js";

import {
  buildPreparedHistoryRebuildManifest,
  createHistoryRebuildOperatorDependencies,
  generateHistoryRebuildTreePolicy,
  HistoryRebuildOperatorError,
  loadHistoryRebuildManifest,
  loadHistoryRebuildTreePolicyBundle,
  prepareHistoryRebuildManifest,
  requiresHistoryRebuildModelEnrichment,
  runHistoryRebuildCli,
  runHistoryRebuildOperator,
  HISTORY_GLOBAL_VERIFY_SQL,
  SEALED_TREE_VERIFY_SQL,
  type HistoryRebuildOperatorDependencies,
  type HistoryRebuildManifest,
  type HistoryRebuildPlanningResult,
  type HistoryRebuildQueryClient,
  type HistoryRebuildTreePolicyBundle,
} from "./operator-history-rebuild.js";

const primaryScope = {
  tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
  agentId: "agent", namespace: "default", visibility: "private" as const,
  workspaceId: "workspace", sessionId: "session",
};

function policyBundleForScopes(
  scopes: readonly Parameters<typeof authorityScopeFingerprint>[0][],
): HistoryRebuildTreePolicyBundle {
  return {
    version: 1,
    policyVersion: "history-tree-routing/v2",
    topicTaxonomyVersion: "scope-topic-taxonomy/v1",
    sourceIdentityVersion: "auditable-source-identity/v1",
    policies: scopes.map((scope) => ({
      version: "history-tree-routing/v2" as const,
      scopeFingerprint: authorityScopeFingerprint(scope),
      topic: {
        version: "scope-topic-taxonomy/v1" as const,
        minimumSupport: 2,
        maxLabelsPerRecord: 3 as const,
        taxonomy: [
          { canonicalLabel: "migration", aliases: ["migration"], support: 2 },
          { canonicalLabel: "release", aliases: ["release"], support: 2 },
          { canonicalLabel: "resume", aliases: ["resume"], support: 2 },
        ],
      },
      source: { version: "auditable-source-identity/v1" as const, identities: [] },
    })),
  };
}

function policyBundleInputForScopes(
  scopes: readonly Parameters<typeof authorityScopeFingerprint>[0][],
) {
  const treePolicyBundle = policyBundleForScopes(scopes);
  const treePolicyBundleSha256 = createHash("sha256")
    .update(JSON.stringify(treePolicyBundle)).digest("hex");
  return { treePolicyBundle, treePolicyBundleSha256 } as const;
}

const treePolicyBundle = policyBundleForScopes([primaryScope]);
const treePolicyBundleText = JSON.stringify(treePolicyBundle);
const treePolicyBundleSha256 = createHash("sha256").update(treePolicyBundleText).digest("hex");
const bundleInput = {
  treePolicyBundle,
  treePolicyBundleSha256,
} as const;

const manifest = {
  version: 1,
  migrationId: "history-rebuild-2026-08",
  requiredSchemaVersion: 24,
  source: {
    snapshotSha256: "1".repeat(64),
    sourceCount: 12,
    parserVersions: ["codex-jsonl-v1", "openclaw-jsonl-v1"],
  },
  funnel: {
    mappingVersion: "kind-to-semantic-type/v1",
    conflictPolicy: "lookup_only",
    lifecyclePolicy: "preserve",
  },
  models: {
    extraction: {
      provider: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      model: "extract-model-v1",
      promptPolicyVersion: "history-extract-v1",
      temperature: 0,
    },
    embedding: {
      provider: "openai-compatible",
      baseURL: "https://models.example.test/v1",
      model: "BAAI/bge-m3",
      dimensions: 1024,
      normalization: "l2",
    },
  },
  budget: {
    maxRecords: 100,
    maxModelCalls: 50,
    maxInputTokens: 100_000,
    maxOutputTokens: 10_000,
    maxCostMinorUnits: 5_000,
    currency: "CNY",
    pricingSnapshotVersion: "pricing-2026-08-13",
    inputCostPerMillionTokens: 100,
    outputCostPerMillionTokens: 300,
  },
  security: {
    remoteEgress: "redacted-only",
    redactionMapVersion: "redaction-map-v1",
    logContent: "hash-only",
    receiptContent: "hash-only",
  },
  tree: {
    policyVersion: "history-tree-routing/v2",
    topicLabelVersion: "scope-topic-taxonomy/v1",
    policyBundleSha256: treePolicyBundleSha256,
    requireEvidence: true,
    requireSealed: true,
    ambiguousPolicy: "quarantine",
  },
} as const;
const manifestText = JSON.stringify(manifest);
const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
const legacyManifest = {
  ...manifest,
  requiredSchemaVersion: 23,
  tree: {
    policyVersion: "history-tree-routing/v1",
    topicLabelVersion: "history-topic-label/v1",
    requireEvidence: true,
    requireSealed: true,
    ambiguousPolicy: "quarantine",
  },
} as const satisfies HistoryRebuildManifest;
const legacyManifestText = JSON.stringify(legacyManifest);
const legacyManifestSha256 = createHash("sha256").update(legacyManifestText).digest("hex");

const planningResult: HistoryRebuildPlanningResult = {
  sourceCount: 12,
  dispositions: {
    preserveExplicit: 2,
    backfill: 4,
    lookupOnly: 5,
    invalidExplicit: 1,
  },
  tree: { mapped: 6, orphan: 4, ambiguous: 2 },
  estimatedModelCalls: 8,
  estimatedInputTokens: 16_000,
  estimatedOutputTokens: 2_000,
  estimatedCostMinorUnits: 800,
};

function globalParityResult(sourceCount: number, overrides: Record<string, unknown> = {}) {
  return {
    runs: {
      total: sourceCount === 0 ? 0 : 1,
      completed: sourceCount === 0 ? 0 : 1,
      nonCompleted: 0,
      scopes: sourceCount === 0 ? 0 : 1,
      identityConflicts: 0,
      pinDrift: 0,
    },
    ledger: {
      sourceRows: sourceCount,
      plans: sourceCount,
      settled: sourceCount,
      metadataParity: sourceCount,
      expectedModelReceipts: 0,
      modelReceipts: 0,
      batchAppliedRecords: sourceCount,
      batchApplyReceipts: sourceCount === 0 ? 0 : 1,
      runApplyReceipts: sourceCount === 0 ? 0 : 1,
    },
    inventory: {
      physical: sourceCount,
      included: sourceCount,
      legacyQuarantine: 0,
      newQuarantine: 0,
      tables: {
        memories: {
          physical: sourceCount,
          included: sourceCount,
          legacyQuarantine: 0,
          newQuarantine: 0,
        },
        knowledge: {
          physical: 0,
          included: 0,
          legacyQuarantine: 0,
          newQuarantine: 0,
        },
      },
    },
    scoring: {
      total: sourceCount,
      valueScore: { real: 0, legacyFloor: sourceCount, realRate: 0, legacyFloorRate: sourceCount === 0 ? 0 : 1 },
      importance: { real: 0, legacyFloor: sourceCount, realRate: 0, legacyFloorRate: sourceCount === 0 ? 0 : 1 },
      confidence: { real: 0, legacyFloor: sourceCount, realRate: 0, legacyFloorRate: sourceCount === 0 ? 0 : 1 },
    },
    ...overrides,
  };
}

function globalParityRow(overrides: Record<string, unknown> = {}) {
  return {
    run_count: "1", completed_run_count: "1", non_completed_run_count: "0",
    run_scope_count: "1", included_scope_count: "1", identity_conflict_count: "0",
    pin_drift_count: "0", snapshot_count: "2", checkpoint_count: "2",
    completed_checkpoint_count: "2", snapshot_source_count: "1", source_count: "1",
    distinct_source_count: "1", plan_count: "1", distinct_plan_count: "1",
    source_plan_parity_count: "1", scope_parity_count: "1",
    settled_count: "1", metadata_parity_count: "1",
    expected_model_receipt_count: "0", model_receipt_count: "0",
    model_receipt_parity_count: "0", batch_applied_record_count: "1",
    batch_apply_receipt_count: "1", expected_batch_apply_receipt_count: "1",
    run_apply_receipt_count: "1", operation_receipt_drift_count: "0",
    tree_routing_drift_count: "0",
    physical_memory_count: "1", included_memory_count: "1",
    legacy_quarantine_memory_count: "0", new_quarantine_memory_count: "0",
    physical_knowledge_count: "0", included_knowledge_count: "0",
    legacy_quarantine_knowledge_count: "0", new_quarantine_knowledge_count: "0",
    memory_source_count: "1", knowledge_source_count: "0", scored_memory_count: "1",
    real_value_score_count: "0", floor_value_score_count: "1",
    real_importance_count: "0", floor_importance_count: "1",
    real_confidence_count: "0", floor_confidence_count: "1",
    ...overrides,
  };
}

function routingReplayRow(
  topicLabels: readonly string[] = ["migration", "release", "resume", "uncatalogued"],
) {
  const sourceHash = "a".repeat(64);
  const recordId = "11111111-1111-4111-8111-111111111111";
  return {
    run_id: "run-verified",
    scope_fingerprint: authorityScopeFingerprint(primaryScope),
    source_table: "memories",
    record_id: recordId,
    source_hash: sourceHash,
    source_row: {
      sourceTable: "memories" as const, recordId, sourceHash,
      text: "history routing fixture", kind: "preference" as const, metadata: {},
      scope: primaryScope,
    },
    plan: {
      sourceTable: "memories" as const, recordId, sourceHash,
      disposition: "preserve" as const, semanticType: "rules" as const, topicLabels,
      contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "valid_explicit_semantic_type" as const,
      receiptHash: "b".repeat(64),
    },
  };
}

function sealedTreeRow(overrides: Record<string, unknown> = {}) {
  return {
    run_count: "1", history_tree_job_count: "4", completed_tree_job_count: "4",
    dead_letter_tree_job_count: "0", finalize_job_count: "2", distinct_target_count: "2",
    expected_source_target_count: "1", eligible_topic_record_count: "1",
    expected_topic_target_count: "1", source_target_count: "1", topic_target_count: "1",
    sealed_source_target_count: "1", sealed_topic_target_count: "1",
    covered_leaf_count: "2", evidence_covered_leaf_count: "2",
    unfinished_l0_buffer_count: "0", foldable_parent_buffer_count: "0",
    l1_node_count: "2", l2_node_count: "1", l3_node_count: "1", ...overrides,
  };
}

function verifiedPlanSummaryRow(sourceCount = 1) {
  return {
    source_count: String(sourceCount), preserve_count: String(sourceCount), backfill_count: "0",
    lookup_only_count: "0", quarantine_count: "0",
    topic_eligible_count: String(sourceCount), source_eligible_count: String(sourceCount),
  };
}

function persistedRunRow(scope = primaryScope) {
  return {
    run_id: "run-verified", tenant_id: scope.tenantId, user_id: scope.userId,
    app_id: scope.appId, project_id: scope.projectId, agent_id: scope.agentId,
    namespace: scope.namespace, visibility: scope.visibility,
    workspace_id: scope.workspaceId ?? "", session_id: scope.sessionId ?? "",
  };
}

function verifiedRunResult(sourceCount = 1) {
  return {
    totalSourceCount: sourceCount, memorySourceCount: sourceCount, knowledgeSourceCount: 0,
    totalPlanCount: sourceCount, memoryPlanCount: sourceCount, knowledgePlanCount: 0,
    appliedMemoryCount: sourceCount, unchangedKnowledgeCount: 0,
    evidenceMirrors: sourceCount, evidenceLinks: sourceCount,
    treeJobs: sourceCount === 0 ? 0 : 2, queuedTreeJobs: 0,
    completedTreeJobs: sourceCount === 0 ? 0 : 2, deadLetterTreeJobs: 0,
  };
}

function fakeDependencies(options: {
  plan?: () => Promise<HistoryRebuildPlanningResult>;
  planWithModel?: () => Promise<HistoryRebuildPlanningResult>;
  verify?: () => Promise<HistoryRebuildPlanningResult>;
  apply?: () => Promise<Record<string, unknown>>;
  rollback?: () => Promise<Record<string, unknown>>;
  schemaError?: Error;
  connectError?: Error;
  queryError?: Error;
  lockAcquired?: boolean;
  manifestText?: string;
  treePolicyBundleText?: string;
} = {}): {
  deps: HistoryRebuildOperatorDependencies;
  calls: string[];
  connect: ReturnType<typeof vi.fn>;
  plan: ReturnType<typeof vi.fn>;
  planWithModel: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
  assertSchemaVersion: ReturnType<typeof vi.fn>;
  modelCall: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const calls: string[] = [];
  const modelCall = vi.fn();
  const query = vi.fn(async <Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
  ): Promise<{ rows: readonly Row[]; rowCount: number }> => {
    calls.push(sql);
    if (options.queryError) throw options.queryError;
    if (sql.includes("history-rebuild:operator-lock")) {
      return { rows: [{ acquired: options.lockAcquired ?? true }] as unknown as Row[], rowCount: 1 };
    }
    if (sql.includes("history-rebuild:operator-unlock")) {
      return { rows: [{ released: true }] as unknown as Row[], rowCount: 1 };
    }
    return { rows: [] as Row[], rowCount: 0 };
  });
  const plan = vi.fn(options.plan ?? (async () => planningResult));
  const planWithModel = vi.fn(options.planWithModel ?? (async () => planningResult));
  const verify = vi.fn(options.verify ?? (async () => ({
    ...planningResult,
    globalParityVerification: globalParityResult(planningResult.sourceCount),
  })));
  const apply = vi.fn(options.apply ?? (async () => ({ applied: 12, checkpoint: "done" })));
  const rollback = vi.fn(options.rollback ?? (async () => ({ restored: 12 })));
  const assertSchemaVersion = vi.fn(async () => {
    if (options.schemaError) throw options.schemaError;
  });
  const close = vi.fn(async () => undefined);
  const connect = vi.fn(async () => {
    if (options.connectError) throw options.connectError;
    return {
      client: { query: query as unknown as HistoryRebuildQueryClient["query"] },
      close,
    };
  });
  return {
    calls,
    connect,
    plan,
    verify,
    planWithModel,
    apply,
    rollback,
    assertSchemaVersion,
    modelCall,
    close,
    deps: {
      readText: vi.fn((path: string) => path.endsWith("manifest.json")
        ? options.manifestText ?? manifestText
        : path.endsWith("tree-policy.json")
          ? options.treePolicyBundleText ?? treePolicyBundleText
          : JSON.stringify({ dbType: "postgres", password: "database-secret" })),
      parseConfig: vi.fn(() => ({ dbType: "postgres" })),
      connect: connect as unknown as HistoryRebuildOperatorDependencies["connect"],
      plan,
      planWithModel,
      verify,
      apply,
      rollback,
      assertSchemaVersion,
    },
  };
}

function operatorCallKinds(calls: readonly string[]): string[] {
  return calls.map((sql) => sql.includes("history-rebuild:operator-lock") ? "LOCK"
    : sql.includes("history-rebuild:operator-unlock") ? "UNLOCK" : sql);
}

const baseArgs = [
  "--config", "/tmp/config.json", "--manifest", "/tmp/manifest.json",
  "--tree-policy-bundle", "/tmp/tree-policy.json",
];

describe("history rebuild operator", () => {
  test("selects unresolved and label-only rows for model enrichment", () => {
    const unresolved = { sourceTable: "memories", recordId: "1", sourceHash: "a".repeat(64) };
    expect(requiresHistoryRebuildModelEnrichment(unresolved as never, {
      ...unresolved, reason: "model_classification_required", contextEligible: false,
      semanticType: undefined, topicLabels: [],
    } as never)).toBe(true);
    expect(requiresHistoryRebuildModelEnrichment(unresolved as never, {
      ...unresolved, reason: "deterministic_kind_mapping", contextEligible: true,
      semanticType: "rules", topicLabels: [],
    } as never)).toBe(true);
    expect(requiresHistoryRebuildModelEnrichment(unresolved as never, {
      ...unresolved, reason: "valid_explicit_semantic_type", contextEligible: true,
      semanticType: "profile", topicLabels: [],
    } as never)).toBe(false);
    expect(requiresHistoryRebuildModelEnrichment(unresolved as never, {
      ...unresolved, reason: "deterministic_kind_mapping", contextEligible: true,
      semanticType: "rules", topicLabels: ["release"],
    } as never)).toBe(false);
  });

  test("builds a secret-free manifest from a frozen snapshot and resolved model config", () => {
    const prepared = buildPreparedHistoryRebuildManifest({
      migrationId: "prepared-v1",
      snapshot: { sourceCount: 2, snapshotSha256: "a".repeat(64), parserVersions: ["postgres-v24"] },
      config: {
        llm: { provider: "openai", apiKey: "llm-secret", baseURL: "https://model.test/v1", model: "fallback", extractionModel: "extract-v1" },
        embedding: { provider: "openai", apiKey: "embed-secret", baseURL: "https://embed.test/v1", model: "BAAI/bge-m3" },
      } as never,
      policy: {
        budget: { maxRecords: 10, maxModelCalls: 5, maxInputTokens: 1000, maxOutputTokens: 200, maxCostMinorUnits: 99, currency: "CNY", pricingSnapshotVersion: "pricing-v1", inputCostPerMillionTokens: 100, outputCostPerMillionTokens: 300 },
        remoteEgress: "redacted-only",
        treePolicyVersion: "history-tree-routing/v2",
        topicLabelVersion: "scope-topic-taxonomy/v1",
        treePolicyBundleSha256,
      },
    });
    expect(prepared.models.extraction.model).toBe("extract-v1");
    expect(prepared.requiredSchemaVersion).toBe(24);
    expect(prepared.source).toEqual({ sourceCount: 2, snapshotSha256: "a".repeat(64), parserVersions: ["postgres-v24"] });
    expect(JSON.stringify(prepared)).not.toMatch(/llm-secret|embed-secret|apiKey|password/);
  });

  test("prepares a frozen secret-free manifest in READ ONLY and refuses overwrite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mengshu-history-prepare-"));
    const output = join(directory, "manifest.json");
    const calls: string[] = [];
    const config = {
      dbType: "postgres",
      postgres: { host: "db.internal", port: 5432, database: "mengshu", user: "operator", password: "postgres-secret" },
      llm: { provider: "openai", apiKey: "llm-secret", baseURL: "https://model.test/v1", model: "fallback", extractionModel: "extract-v1" },
      embedding: { provider: "openai", apiKey: "embed-secret", baseURL: "https://embed.test/v1", model: "BAAI/bge-m3" },
    } as never;
    const client: HistoryRebuildQueryClient = {
      query: async <Row extends Record<string, unknown>>(sql: string) => {
        calls.push(sql);
        const rows = sql.includes("prepare-snapshot")
          ? [{ source_count: "2", snapshot_sha256: "a".repeat(64) }]
          : [];
        return { rows: rows as unknown as Row[], rowCount: rows.length };
      },
    };
    const deps: HistoryRebuildOperatorDependencies = {
      readText: vi.fn(() => "config"),
      parseConfig: vi.fn(() => config),
      connect: vi.fn(async () => ({
        client,
        close: vi.fn(async () => undefined),
      })),
      assertSchemaVersion: vi.fn(async () => undefined),
      plan: vi.fn(), planWithModel: vi.fn(), verify: vi.fn(), apply: vi.fn(), rollback: vi.fn(),
    };
    const args = [
      "--config", "/tmp/config.json", "--prepare-manifest", output,
      "--migration-id", "prepared-v1", "--max-records", "10",
      "--max-model-calls", "5", "--max-input-tokens", "1000",
      "--max-output-tokens", "200", "--max-cost-minor-units", "99",
      "--currency", "CNY", "--pricing-snapshot-version", "pricing-v1",
      "--input-cost-per-million-tokens", "100",
      "--output-cost-per-million-tokens", "300",
      "--remote-egress", "redacted-only", "--tree-policy-version", "history-tree-routing/v2",
      "--topic-label-version", "scope-topic-taxonomy/v1",
      "--tree-policy-bundle-sha256", treePolicyBundleSha256,
    ];
    try {
      const result = await prepareHistoryRebuildManifest(args, deps);
      const text = readFileSync(output, "utf8");
      expect(result).toMatchObject({
        operation: "prepare-manifest", sourceCount: 2,
        snapshotSha256: "a".repeat(64),
        manifestSha256: createHash("sha256").update(text).digest("hex"),
      });
      expect(calls[0]).toBe("BEGIN READ ONLY");
      expect(calls.join("\n")).toMatch(/tenant_id.*lifecycle_status.*data_type/s);
      expect(calls.join("\n")).toContain(
        "metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'",
      );
      expect(calls.join("\n")).toContain("concat_ws(chr(31)");
      expect(calls.join("\n")).not.toContain("concat_ws(E'\\\\0'");
      expect(calls.at(-1)).toBe("ROLLBACK");
      expect(statSync(output).mode & 0o777).toBe(0o600);
      expect(text).not.toMatch(/postgres-secret|llm-secret|embed-secret|apiKey|password|db\.internal/);
      await expect(prepareHistoryRebuildManifest(args, deps))
        .rejects.toMatchObject({ code: "HISTORY_REBUILD_PLANNING_FAILED" });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("generates a deterministic read-only v2 policy bundle and audit report", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mengshu-history-policy-"));
    const outputA = join(directory, "policy-a.json");
    const auditA = join(directory, "audit-a.json");
    const outputB = join(directory, "policy-b.json");
    const auditB = join(directory, "audit-b.json");
    const scopeWithoutSession = { ...primaryScope, sessionId: undefined };
    const emptyScope = {
      ...scopeWithoutSession,
      projectId: "knowledge-only",
    };
    const scopeFingerprint = authorityScopeFingerprint(scopeWithoutSession);
    const memoryRows = [
      ["11111111-1111-4111-8111-111111111111", ["a", "b", "d"], "old-run"],
      ["22222222-2222-4222-8222-222222222222", ["a", "b", "c", "d"], "old-run"],
      ["33333333-3333-4333-8333-333333333333", ["a", "b", "c"], "old-run"],
      ["44444444-4444-4444-8444-444444444444", ["c"], "old-run"],
      ["55555555-5555-4555-8555-555555555555", [], "singleton-run"],
      ["66666666-6666-4666-8666-666666666666", [], undefined],
      ["77777777-7777-4777-8777-777777777777", [], "lookup-run"],
    ].map(([recordId, topicLabels, runId], index) => ({
      source_table: "memories",
      record_id: recordId,
      source_hash: String(index + 1).repeat(64),
      text: `memory-${index + 1}`,
      content_hash: `content-${index + 1}`,
      vector_text: "[0.1]",
      importance: 0.8,
      category: "preference",
      data_type: "preference",
      created_at_ms: "1",
      embedding_space_id: "space",
      embedding_space_state: "ready",
      metadata: {
        semanticType: "rules",
        valueScore: 0.8,
        sourceNodeIds: [`evidence-${index + 1}`],
        topicLabels,
        ...(runId ? {
          historyRebuild: {
            runId,
            sourceHash: "b".repeat(64),
            planReceiptHash: "c".repeat(64),
            disposition: runId === "lookup-run" ? "lookup_only" : "preserve",
          },
        } : {}),
      },
      tenant_id: scopeWithoutSession.tenantId,
      user_id: scopeWithoutSession.userId,
      product_id: scopeWithoutSession.appId,
      canonical_project_id: scopeWithoutSession.projectId,
      producer_id: scopeWithoutSession.agentId,
      namespace: scopeWithoutSession.namespace,
      visibility: scopeWithoutSession.visibility,
      workspace_id: scopeWithoutSession.workspaceId,
      session_id: "",
      lifecycle_status: "active",
    }));
    const knowledgeRow = {
      ...memoryRows[0],
      source_table: "knowledge",
      record_id: "88888888-8888-4888-8888-888888888888",
      source_hash: "8".repeat(64),
      canonical_project_id: emptyScope.projectId,
      metadata: {},
      topic_labels: [],
    };
    const auditRows = memoryRows
      .filter((row) => row.metadata.historyRebuild &&
        row.metadata.historyRebuild.disposition !== "lookup_only")
      .map((row) => ({
        record_id: row.record_id,
        migration_id: "history-rebuild-2026-08-14-prod-01",
        run_id: row.metadata.historyRebuild!.runId,
        scope_fingerprint: scopeFingerprint,
        legacy_source_hash: row.metadata.historyRebuild!.sourceHash,
        plan_receipt_hash: row.metadata.historyRebuild!.planReceiptHash,
        plan_disposition: row.metadata.historyRebuild!.disposition,
      }));
    const calls: string[] = [];
    const query = async <Row extends Record<string, unknown>>(sql: string) => {
      calls.push(sql);
      const rows = sql.includes("history-rebuild:scan")
        ? [...memoryRows, knowledgeRow]
        : sql.includes("history-rebuild:tree-policy-source-audit")
          ? auditRows
          : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    };
    const client: HistoryRebuildQueryClient = {
      query: vi.fn(query) as typeof query,
    };
    const deps: HistoryRebuildOperatorDependencies = {
      readText: vi.fn(() => "config"),
      parseConfig: vi.fn(() => ({ dbType: "postgres" })),
      connect: vi.fn(async () => ({ client, close: vi.fn(async () => undefined) })),
      assertSchemaVersion: vi.fn(), plan: vi.fn(), planWithModel: vi.fn(),
      verify: vi.fn(), apply: vi.fn(), rollback: vi.fn(),
    };
    try {
      const first = await generateHistoryRebuildTreePolicy([
        "--config", "/tmp/config.json",
        "--generate-tree-policy", outputA,
        "--audit-report", auditA,
      ], deps);
      const second = await runHistoryRebuildCli([
        "--config", "/tmp/config.json",
        "--generate-tree-policy", outputB,
        "--audit-report", auditB,
      ], deps);
      const bundleText = readFileSync(outputA, "utf8");
      const auditText = readFileSync(auditA, "utf8");
      const bundle = JSON.parse(bundleText) as HistoryRebuildTreePolicyBundle;
      const audit = JSON.parse(auditText);
      expect(bundleText).toBe(readFileSync(outputB, "utf8"));
      expect(auditText).toBe(readFileSync(auditB, "utf8"));
      expect(first).toEqual(second);
      expect(first).toMatchObject({
        operation: "generate-tree-policy",
        sourceCount: 8,
        scopes: 2,
        bundleSha256: createHash("sha256").update(bundleText).digest("hex"),
      });
      expect(bundle.policies).toHaveLength(2);
      const populated = bundle.policies.find((policy) =>
        policy.scopeFingerprint === scopeFingerprint)!;
      expect(populated.topic.taxonomy).toEqual([
        { canonicalLabel: "a", aliases: [], support: 3 },
        { canonicalLabel: "b", aliases: [], support: 3 },
        { canonicalLabel: "c", aliases: [], support: 3 },
      ]);
      expect(populated.source.identities).toHaveLength(4);
      expect(populated.source.identities.every((identity) =>
        identity.kind === "import_batch" && identity.identity.endsWith(":old-run")))
        .toBe(true);
      expect(bundle.policies.find((policy) =>
        policy.scopeFingerprint !== scopeFingerprint)).toMatchObject({
        topic: { taxonomy: [] }, source: { identities: [] },
      });
      expect(audit).toMatchObject({
        version: 1,
        bundleSha256: first.bundleSha256,
        source: {
          planEligible: 6,
          auditedRecords: 4,
          targetCount: 1,
          minimumTargetLeaves: 4,
          maximumTargetLeaves: 4,
          singletonDowngraded: 1,
          priorLookupOnlyDowngraded: 1,
          missingAuditableIdentity: 1,
        },
        topic: {
          planEligible: 4,
          retainedRecords: 4,
          targetCount: 3,
          singletonTargets: 0,
          minimumTargetLeaves: 3,
          maximumTargetLeaves: 3,
          iterations: 2,
        },
      });
      expect(calls[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(calls).toContain("ROLLBACK");
      expect(calls.join("\n")).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|CALL)\b/i);
      expect(statSync(outputA).mode & 0o777).toBe(0o600);
      expect(statSync(auditA).mode & 0o777).toBe(0o600);
      await expect(generateHistoryRebuildTreePolicy([
        "--config", "/tmp/config.json",
        "--generate-tree-policy", outputA,
        "--audit-report", auditA,
      ], deps)).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_ARGUMENTS" });
      expect(deps.connect).toHaveBeenCalledTimes(2);
      expect(deps.planWithModel).not.toHaveBeenCalled();
      expect(deps.apply).not.toHaveBeenCalled();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("strictly validates and hashes the immutable manifest", () => {
    const loaded = loadHistoryRebuildManifest(manifestText);
    expect(loaded.manifest).toEqual(manifest);
    expect(loaded.sha256).toBe(manifestSha256);

    for (const invalid of [
      { ...manifest, requiredSchemaVersion: 22 },
      { ...manifest, models: { ...manifest.models, extraction: {
        ...manifest.models.extraction, temperature: 0.1,
      } } },
      { ...manifest, security: { ...manifest.security, remoteEgress: "allow" } },
      { ...manifest, tree: { ...manifest.tree, requireEvidence: false } },
      { ...manifest, budget: { ...manifest.budget, maxCostMinorUnits: -1 } },
      { ...manifest, budget: { ...manifest.budget, inputCostPerMillionTokens: -1 } },
      { ...manifest, unexpected: true },
    ]) {
      expect(() => loadHistoryRebuildManifest(JSON.stringify(invalid)))
        .toThrowError(expect.objectContaining({ code: "HISTORY_REBUILD_INVALID_MANIFEST" }));
    }
  });

  test("strictly validates the scope-bound tree policy bundle", () => {
    expect(loadHistoryRebuildTreePolicyBundle(treePolicyBundleText)).toEqual({
      bundle: treePolicyBundle,
      sha256: treePolicyBundleSha256,
    });
    const duplicate = {
      ...treePolicyBundle,
      policies: [treePolicyBundle.policies[0], treePolicyBundle.policies[0]],
    };
    for (const invalid of [
      duplicate,
      { ...treePolicyBundle, policyVersion: "history-tree-routing/v1" },
      { ...treePolicyBundle, unexpected: true },
    ]) {
      expect(() => loadHistoryRebuildTreePolicyBundle(JSON.stringify(invalid)))
        .toThrowError(expect.objectContaining({ code: "HISTORY_REBUILD_INVALID_MANIFEST" }));
    }
  });

  test("rejects a policy bundle whose byte hash drifted from the manifest pin", async () => {
    const drifted = JSON.stringify({ ...treePolicyBundle, policies: [] });
    const fake = fakeDependencies({ treePolicyBundleText: drifted });
    await expect(runHistoryRebuildOperator(baseArgs, fake.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_MANIFEST_MISMATCH" });
    expect(fake.connect).not.toHaveBeenCalled();
  });

  test("defaults to a pure dry-run in an explicit read-only transaction", async () => {
    const fake = fakeDependencies();
    await expect(runHistoryRebuildOperator(baseArgs, fake.deps)).resolves.toEqual({
      operation: "dry-run",
      modelAssisted: false,
      manifestSha256,
      requiredSchemaVersion: 24,
      writes: 0,
      modelCalls: 0,
      ...planningResult,
    });
    expect(operatorCallKinds(fake.calls)).toEqual([
      "LOCK", "BEGIN READ ONLY", "ROLLBACK", "UNLOCK",
    ]);
    expect(fake.plan).toHaveBeenCalledOnce();
    expect(fake.verify).not.toHaveBeenCalled();
    expect(fake.modelCall).not.toHaveBeenCalled();
    expect(fake.calls.some((sql) => /\b(?:INSERT|UPDATE|DELETE|COMMIT|CREATE|ALTER|DROP)\b/i.test(sql)))
      .toBe(false);
  });

  test.each(["--plan", "--dry-run"])("%s explicitly selects read-only planning", async (flag) => {
    const fake = fakeDependencies();
    await expect(runHistoryRebuildOperator([...baseArgs, flag], fake.deps))
      .resolves.toMatchObject({ operation: flag === "--plan" ? "plan" : "dry-run", writes: 0 });
    expect(operatorCallKinds(fake.calls)).toEqual([
      "LOCK", "BEGIN READ ONLY", "ROLLBACK", "UNLOCK",
    ]);
    expect(fake.plan).toHaveBeenCalledOnce();
    expect(fake.calls.find((sql) => sql.includes("history-rebuild:operator-lock")))
      .toContain("$1::text");
    expect(fake.calls.find((sql) => sql.includes("history-rebuild:operator-unlock")))
      .toContain("$1::text");
  });

  test("fails closed when another operator owns the migration advisory lock", async () => {
    const fake = fakeDependencies({ lockAcquired: false });
    await expect(runHistoryRebuildOperator(baseArgs, fake.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_OPERATOR_LOCKED" });
    expect(operatorCallKinds(fake.calls)).toEqual(["LOCK"]);
    expect(fake.plan).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledOnce();
  });

  test("verify is read-only and operations are mutually exclusive", async () => {
    const fake = fakeDependencies();
    await expect(runHistoryRebuildOperator([...baseArgs, "--verify"], fake.deps))
      .resolves.toMatchObject({ operation: "verify", writes: 0, modelCalls: 0 });
    expect(operatorCallKinds(fake.calls)).toEqual([
      "LOCK", "BEGIN READ ONLY", "ROLLBACK", "UNLOCK",
    ]);
    expect(fake.verify).toHaveBeenCalledOnce();

    await expect(runHistoryRebuildOperator([...baseArgs, "--verify", "--apply"], fake.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_ARGUMENTS" });
  });

  test("rejects live-model outside a durable apply run before connecting", async () => {
    const fake = fakeDependencies();
    await expect(runHistoryRebuildOperator([...baseArgs, "--live-model"], fake.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_ARGUMENTS" });
    expect(fake.planWithModel).not.toHaveBeenCalled();
    expect(fake.plan).not.toHaveBeenCalled();
    expect(fake.connect).not.toHaveBeenCalled();
  });

  test("casts legacy numeric importance before deterministic and model planning", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
      workspaceId: "workspace", sessionId: "session",
    };
    const queries: string[] = [];
    const query: HistoryRebuildQueryClient["query"] = async <
      Row extends Record<string, unknown> = Record<string, unknown>,
    >(sql: string) => {
      queries.push(sql);
      return { rows: [] as unknown as Row[], rowCount: 0 };
    };
    const deps = createHistoryRebuildOperatorDependencies();

    await deps.plan({
      client: { query }, manifest: {
        ...manifest,
        source: {
          ...manifest.source,
          sourceCount: 0,
          snapshotSha256: createHash("sha256").update("").digest("hex"),
        },
      },
      manifestSha256,
      modelAssisted: false,
      operatorConfig: { scope },
    });

    expect(queries[0]).toContain("importance::double precision AS importance");
  });

  test.each(["apply", "rollback"] as const)(
    "%s requires maintenance, quiescence, manifest pin and the exact migration token",
    async (operation) => {
      const flag = `--${operation}`;
      const fake = fakeDependencies();
      await expect(runHistoryRebuildOperator([...baseArgs, flag], fake.deps))
        .rejects.toMatchObject({ code: "HISTORY_REBUILD_WRITE_GATE_REQUIRED" });
      expect(fake.connect).not.toHaveBeenCalled();

      await expect(runHistoryRebuildOperator([
        ...baseArgs, flag, "--maintenance", "--quiescence-confirmed",
        "--manifest-sha256", "f".repeat(64),
        "--confirmation-token", `${operation.toUpperCase()}:${manifest.migrationId}`,
      ], fake.deps)).rejects.toMatchObject({ code: "HISTORY_REBUILD_MANIFEST_MISMATCH" });
      expect(fake.connect).not.toHaveBeenCalled();

      await expect(runHistoryRebuildOperator([
        ...baseArgs, flag, "--maintenance", "--quiescence-confirmed",
        "--manifest-sha256", manifestSha256,
        "--confirmation-token", `${operation.toUpperCase()}:wrong-migration`,
      ], fake.deps)).rejects.toMatchObject({ code: "HISTORY_REBUILD_WRITE_GATE_REQUIRED" });
      expect(fake.connect).not.toHaveBeenCalled();

      const result = runHistoryRebuildOperator([
        ...baseArgs, flag, "--maintenance", "--quiescence-confirmed",
        "--manifest-sha256", manifestSha256,
        "--confirmation-token", `${operation.toUpperCase()}:${manifest.migrationId}`,
      ], fake.deps);
      if (operation === "apply") {
        await expect(result).resolves.toMatchObject({ operation: "apply", applied: 12 });
        expect(fake.apply).toHaveBeenCalledOnce();
      } else {
        await expect(result).resolves.toMatchObject({ operation: "rollback", restored: 12 });
        expect(fake.rollback).toHaveBeenCalledOnce();
      }
      expect(fake.connect).toHaveBeenCalledOnce();
    },
  );

  test("v23 manifests remain verify/rollback compatible but cannot start a new apply", async () => {
    const args = ["--config", "/tmp/config.json", "--manifest", "/tmp/manifest.json"];
    const verify = fakeDependencies({ manifestText: legacyManifestText });
    await expect(runHistoryRebuildOperator([...args, "--verify"], verify.deps))
      .resolves.toMatchObject({ operation: "verify", requiredSchemaVersion: 23 });
    expect(verify.verify).toHaveBeenCalledOnce();

    const apply = fakeDependencies({ manifestText: legacyManifestText });
    await expect(runHistoryRebuildOperator([
      ...args, "--apply", "--maintenance", "--quiescence-confirmed",
      "--manifest-sha256", legacyManifestSha256,
      "--confirmation-token", `APPLY:${legacyManifest.migrationId}`,
    ], apply.deps)).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_MANIFEST" });
    expect(apply.connect).not.toHaveBeenCalled();
  });

  test("checks schema v24 before planning or executing any operation", async () => {
    const fake = fakeDependencies({ schemaError: new Error("relation missing secret-row") });
    await expect(runHistoryRebuildOperator(baseArgs, fake.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_SCHEMA_NOT_READY" });
    expect(fake.plan).not.toHaveBeenCalled();
    expect(fake.apply).not.toHaveBeenCalled();
    expect(operatorCallKinds(fake.calls)).toEqual([
      "LOCK", "BEGIN READ ONLY", "ROLLBACK", "UNLOCK",
    ]);
  });

  test("rejects snapshot or budget drift returned by the read-only planning port", async () => {
    const sourceDrift = fakeDependencies({
      plan: async () => ({ ...planningResult, sourceCount: 11 }),
    });
    await expect(runHistoryRebuildOperator(baseArgs, sourceDrift.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_SOURCE_DRIFT" });
    expect(operatorCallKinds(sourceDrift.calls).slice(-2)).toEqual(["ROLLBACK", "UNLOCK"]);

    const budgetDrift = fakeDependencies({
      plan: async () => ({ ...planningResult, estimatedModelCalls: 51 }),
    });
    await expect(runHistoryRebuildOperator(baseArgs, budgetDrift.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_BUDGET_EXCEEDED" });
  });

  test("dependency failures are converted to stable errors without leaking secrets or content", async () => {
    const secret = "postgres://operator:password-secret@db.internal/mengshu raw-user-content";
    const connectFailure = fakeDependencies({ connectError: new Error(secret) });
    let error: unknown;
    try {
      await runHistoryRebuildOperator(baseArgs, connectFailure.deps);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HistoryRebuildOperatorError);
    expect(error).toMatchObject({ code: "HISTORY_REBUILD_CONNECTION_FAILED" });
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toMatch(/password-secret|raw-user-content|db\.internal/);

    const planningFailure = fakeDependencies({
      plan: async () => { throw new Error(secret); },
    });
    await expect(runHistoryRebuildOperator(baseArgs, planningFailure.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_PLANNING_FAILED" });
    expect(operatorCallKinds(planningFailure.calls).slice(-2)).toEqual(["ROLLBACK", "UNLOCK"]);

    const lockFailure = fakeDependencies({ queryError: new Error(secret) });
    await expect(runHistoryRebuildOperator(baseArgs, lockFailure.deps))
      .rejects.toMatchObject({ code: "HISTORY_REBUILD_CONNECTION_FAILED" });
  });

  test("default apply commits deterministic shadow plans through the PostgreSQL v24 repository", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
      workspaceId: "workspace", sessionId: "session",
    };
    const row = {
      sourceTable: "memories" as const,
      recordId: "11111111-1111-4111-8111-111111111111",
      sourceHash: "a".repeat(64), text: "prefers concise replies", kind: "preference" as const,
      metadata: {}, scope,
    };
    const snapshotSha256 = createHash("sha256")
      .update(`memories\u001f${row.recordId}\u001f${row.sourceHash}`)
      .digest("hex");
    const applyManifest = {
      ...manifest,
      source: { ...manifest.source, sourceCount: 1, snapshotSha256 },
    };
    const listScopes = vi.fn()
      .mockResolvedValueOnce([{ scope, memoriesCount: 1, knowledgeCount: 0 }])
      .mockResolvedValueOnce([]);
    const createRun = vi.fn(async () => ({
      runId: "run-1", scopeFingerprint: "b".repeat(64), attemptHash: "c".repeat(64),
      snapshots: [
        { sourceTable: "memories" as const, sourceUpperBound: row.recordId, sourceCount: 1, snapshotHash: "d".repeat(64) },
        { sourceTable: "knowledge" as const, sourceUpperBound: null, sourceCount: 0, snapshotHash: "e".repeat(64) },
      ],
    }));
    const scanBatch = vi.fn(async (input: { sourceTable: string }) =>
      input.sourceTable === "memories" ? [row] : []);
    const commitBatch = vi.fn(async (input: { complete?: boolean; nextAfterId: string | null }) => ({
      afterId: input.nextAfterId, checkpointVersion: 1,
      state: input.complete ? "completed" as const : "running" as const,
    }));
    const applyRun = vi.fn(async () => ({
      active: 1, lookupOnly: 0, classifiedInactive: 0,
      evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0,
    }));
    const verifyRun = vi.fn(async () => ({
      totalSourceCount: 1, memorySourceCount: 1, knowledgeSourceCount: 0,
      totalPlanCount: 1, memoryPlanCount: 1, knowledgePlanCount: 0,
      appliedMemoryCount: 1, unchangedKnowledgeCount: 0,
      evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0,
      queuedTreeJobs: 0, completedTreeJobs: 0, deadLetterTreeJobs: 0,
    }));
    const rollbackRun = vi.fn();
    const deps = createHistoryRebuildOperatorDependencies({
      now: () => 123,
      runId: () => "run-1",
      repository: () => ({
        listScopes, createRun, scanBatch, commitBatch, applyRun, verifyRun, rollbackRun,
      }),
    });
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(sql: string) => {
        const rows = sql.includes("history-rebuild:scan") ? [{
          source_table: "memories", record_id: row.recordId, source_hash: row.sourceHash,
          text: row.text, memory_kind: row.kind, metadata: {}, tenant_id: scope.tenantId,
          user_id: scope.userId, product_id: scope.appId,
          canonical_project_id: scope.projectId, producer_id: scope.agentId,
          namespace: scope.namespace, visibility: scope.visibility,
          workspace_id: scope.workspaceId, session_id: scope.sessionId,
        }] : [];
        return { rows: rows as unknown as Row[], rowCount: rows.length };
      };
    const client: HistoryRebuildQueryClient = { query: vi.fn(query) as typeof query };
    const result = await deps.apply({
      client, ...bundleInput, manifest: applyManifest, manifestSha256: "f".repeat(64),
      modelAssisted: false, operatorConfig: {},
    });
    expect(result).toMatchObject({ applied: 1, scopes: 1, runs: 1, materializedSourceRows: 1 });
    expect(listScopes).toHaveBeenCalledTimes(2);
    expect(createRun).toHaveBeenCalledOnce();
    expect(scanBatch).toHaveBeenCalledTimes(2);
    expect(commitBatch).toHaveBeenCalledTimes(2);
    expect(applyRun).toHaveBeenCalledOnce();
    expect(verifyRun).toHaveBeenCalledOnce();
    const pinnedPolicy = treePolicyBundle.policies[0]!;
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      policyHash: historyRebuildTreeRoutingPolicyHash(pinnedPolicy),
    }));
    expect(applyRun).toHaveBeenCalledWith(expect.objectContaining({ treePolicy: pinnedPolicy }));
    expect(verifyRun).toHaveBeenCalledWith(expect.objectContaining({ treePolicy: pinnedPolicy }));
    expect(commitBatch.mock.calls[0]![0]).toMatchObject({
      sourceTable: "memories", complete: true,
      counts: { total: 1, preserve: 0, backfill: 1, modelClassify: 0, lookupOnly: 0, quarantine: 0 },
    });
  });

  test("default apply rejects missing and extra scope policies", async () => {
    const missingBundle = policyBundleInputForScopes([]);
    const repository = {
      listScopes: vi.fn().mockResolvedValueOnce([{
        scope: primaryScope, memoriesCount: 1, knowledgeCount: 0,
      }]),
      createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
      applyRun: vi.fn(), verifyRun: vi.fn(), rollbackRun: vi.fn(),
    };
    const row = {
      source_table: "memories", record_id: "11111111-1111-4111-8111-111111111111",
      source_hash: "a".repeat(64), text: "prefers concise replies", memory_kind: "preference",
      metadata: {}, tenant_id: primaryScope.tenantId, user_id: primaryScope.userId,
      product_id: primaryScope.appId, canonical_project_id: primaryScope.projectId,
      producer_id: primaryScope.agentId, namespace: primaryScope.namespace,
      visibility: primaryScope.visibility, workspace_id: primaryScope.workspaceId,
      session_id: primaryScope.sessionId,
    };
    const snapshotSha256 = createHash("sha256")
      .update(`memories\u001f${row.record_id}\u001f${row.source_hash}`).digest("hex");
    const deps = createHistoryRebuildOperatorDependencies({ repository: () => repository });
    await expect(deps.apply({
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [row] as unknown as Row[], rowCount: 1,
      }) },
      ...missingBundle,
      manifest: {
        ...manifest,
        source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] },
        tree: { ...manifest.tree, policyBundleSha256: missingBundle.treePolicyBundleSha256 },
      },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_INVALID_MANIFEST" });
    expect(repository.createRun).not.toHaveBeenCalled();

    const extraRepository = {
      ...repository,
      listScopes: vi.fn().mockResolvedValueOnce([]),
    };
    const extraDeps = createHistoryRebuildOperatorDependencies({
      repository: () => extraRepository,
    });
    const emptySnapshotSha256 = createHash("sha256").update("").digest("hex");
    await expect(extraDeps.apply({
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [] as Row[], rowCount: 0,
      }) },
      ...bundleInput,
      manifest: {
        ...manifest,
        source: { sourceCount: 0, snapshotSha256: emptySnapshotSha256, parserVersions: ["v24"] },
      },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_SOURCE_DRIFT" });
  });

  test("live apply uses the configured small batch size for durable model checkpoints", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
    };
    const rows = Array.from({ length: 3 }, (_, index) => ({
      sourceTable: "memories" as const,
      recordId: `00000000-0000-4000-8000-00000000000${index + 1}`,
      sourceHash: String(index + 1).repeat(64), text: `rule-${index}`, kind: "preference" as const,
      metadata: {}, scope,
    }));
    const snapshotSha256 = createHash("sha256").update(rows.map((row) =>
      `memories\u001f${row.recordId}\u001f${row.sourceHash}`).join("\n")).digest("hex");
    const repository = {
      listScopes: vi.fn().mockResolvedValueOnce([{ scope, memoriesCount: 3, knowledgeCount: 0 }])
        .mockResolvedValueOnce([]),
      createRun: vi.fn(async () => ({
        runId: "run-small-batches", scopeFingerprint: "a".repeat(64),
        attemptHash: "b".repeat(64), state: "running" as const,
        snapshots: [
          { sourceTable: "memories" as const, sourceUpperBound: rows[2]!.recordId,
            sourceCount: 3, snapshotHash: "c".repeat(64) },
          { sourceTable: "knowledge" as const, sourceUpperBound: null,
            sourceCount: 0, snapshotHash: "d".repeat(64) },
        ],
      })),
      scanBatch: vi.fn(async (input: { sourceTable: string; afterId: string | null; batchSize: number }) =>
        input.sourceTable === "knowledge" ? [] : input.afterId === null ? rows.slice(0, 2)
          : input.afterId === rows[1]!.recordId ? rows.slice(2) : []),
      commitBatch: vi.fn(async (input: { nextAfterId: string | null; expectedCheckpointVersion: number; complete?: boolean; sourceRows: readonly unknown[] }) => ({
        afterId: input.nextAfterId, checkpointVersion: input.expectedCheckpointVersion + 1,
        state: input.complete ? "completed" as const : "running" as const,
      })),
      applyRun: vi.fn(async () => ({ active: 3, lookupOnly: 0, classifiedInactive: 0,
        evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0 })),
      verifyRun: vi.fn(async () => ({ totalSourceCount: 3, memorySourceCount: 3,
        knowledgeSourceCount: 0, totalPlanCount: 3, memoryPlanCount: 3,
        knowledgePlanCount: 0, appliedMemoryCount: 3, unchangedKnowledgeCount: 0,
        evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0, queuedTreeJobs: 0,
        completedTreeJobs: 0, deadLetterTreeJobs: 0 })),
      rollbackRun: vi.fn(),
    };
    const deps = createHistoryRebuildOperatorDependencies({ repository: () => repository });
    const scopedBundle = policyBundleInputForScopes([scope]);
    await expect(deps.apply({
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({ rows: rows.map((row) => ({
        source_table: row.sourceTable, record_id: row.recordId, source_hash: row.sourceHash,
        text: row.text, memory_kind: row.kind, metadata: {}, tenant_id: scope.tenantId,
        user_id: scope.userId, product_id: scope.appId, canonical_project_id: scope.projectId,
        producer_id: scope.agentId, namespace: scope.namespace, visibility: scope.visibility,
        workspace_id: "", session_id: "",
      })) as unknown as Row[], rowCount: 3 }) },
      ...scopedBundle,
      manifest: {
        ...manifest,
        source: { sourceCount: 3, snapshotSha256, parserVersions: ["v24"] },
        tree: { ...manifest.tree, policyBundleSha256: scopedBundle.treePolicyBundleSha256 },
      },
      manifestSha256, modelAssisted: false, operatorConfig: { batchProcessing: { maxBatchSize: 2 } },
    })).resolves.toMatchObject({ applied: 3 });
    expect(repository.scanBatch.mock.calls.filter((call) => call[0].sourceTable === "memories")
      .map((call) => call[0].batchSize)).toEqual([2, 2]);
    expect(repository.scanBatch.mock.calls.find((call) =>
      call[0].sourceTable === "knowledge")?.[0].batchSize).toBe(1_000);
    expect(repository.commitBatch.mock.calls.slice(0, 2).map((call) =>
      call[0].sourceRows.length)).toEqual([2, 1]);
  });

  test("apply fails closed before creating a run when deterministic planning still requires a model", async () => {
    const unresolved = {
      sourceTable: "memories" as const,
      recordId: "22222222-2222-4222-8222-222222222222",
      sourceHash: "2".repeat(64), text: "ambiguous historical fact", kind: "fact" as const,
      metadata: {}, scope: {
        tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
        agentId: "agent", namespace: "default", visibility: "private" as const,
        workspaceId: "workspace", sessionId: "session",
      },
    };
    const snapshotSha256 = createHash("sha256")
      .update(`memories\u001f${unresolved.recordId}\u001f${unresolved.sourceHash}`)
      .digest("hex");
    const createRun = vi.fn();
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun, scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(), rollbackRun: vi.fn(),
      }),
    });
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
      rows: [{
        source_table: "memories", record_id: unresolved.recordId,
        source_hash: unresolved.sourceHash, text: unresolved.text,
        memory_kind: unresolved.kind, metadata: {}, tenant_id: "tenant", user_id: "user",
        product_id: "app", canonical_project_id: "project", producer_id: "agent",
        namespace: "default", visibility: "private", workspace_id: "workspace",
        session_id: "session",
      }] as unknown as Row[], rowCount: 1,
    });
    await expect(deps.apply({
      client: { query },
      ...bundleInput,
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_MODEL_REQUIRED" });
    expect(createRun).not.toHaveBeenCalled();
  });

  test("live apply fails closed before model or repository writes when pinned pricing is unavailable", async () => {
    const planner = vi.fn();
    const createRun = vi.fn();
    const deps = createHistoryRebuildOperatorDependencies({
      llmPlanner: planner,
      repository: () => ({
        listScopes: vi.fn(), createRun, scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(), rollbackRun: vi.fn(),
      }),
    });
    const emptyManifest = {
      ...manifest,
      source: {
        sourceCount: 0,
        snapshotSha256: createHash("sha256").update("").digest("hex"),
        parserVersions: ["v24"],
      },
    };
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
      rows: [{
        source_count: "0", snapshot_sha256: emptyManifest.source.snapshotSha256,
      }] as unknown as Row[],
      rowCount: 1,
    });
    await expect(deps.apply({
      client: { query }, manifest: {
        ...emptyManifest,
        budget: { ...emptyManifest.budget, inputCostPerMillionTokens: -1 },
      } as never, manifestSha256, ...bundleInput,
      modelAssisted: true,
      operatorConfig: { llm: { model: "fallback", extractionModel: "extract-model-v1", baseURL: "https://models.example.test/v1" } },
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_PRICING_UNAVAILABLE" });
    expect(planner).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  test("live apply persists identity-bound model receipts and charges the pinned pricing snapshot", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
      workspaceId: "workspace", sessionId: "session",
    };
    const row = {
      sourceTable: "memories" as const,
      recordId: "33333333-3333-4333-8333-333333333333",
      sourceHash: "3".repeat(64), text: "ambiguous historical fact", kind: "fact" as const,
      metadata: {}, scope,
    };
    const snapshotSha256 = createHash("sha256")
      .update(`memories\u001f${row.recordId}\u001f${row.sourceHash}`).digest("hex");
    const acceptedPlan = {
      sourceTable: "memories" as const, recordId: row.recordId, sourceHash: row.sourceHash,
      disposition: "model_classify" as const, semanticType: "experience" as const,
      topicLabels: ["migration"], contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "model_classification_accepted" as const, modelConfidence: 0.91,
      receiptHash: "4".repeat(64),
    };
    const llmPlanner = vi.fn(async (
      plannerInput: RunHistoryRebuildLlmPlannerInput,
      dependencies: HistoryRebuildLlmPlannerDependencies,
    ) => {
      if (plannerInput.rows.length === 0) {
        return {
          plans: [], receipts: [],
          usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 },
          summary: {} as never,
        };
      }
      expect(dependencies.concurrency).toBe(1);
      expect(dependencies.estimateCostMinorUnits(120, 30)).toBe(9);
      const llmReceipt = {
        version: 1 as const, recordId: row.recordId, sourceHash: row.sourceHash,
        ...deriveHistoryRebuildLlmPins(plannerInput.manifest),
        inputHash: "6".repeat(64), outputHash: "7".repeat(64), confidence: 0.91,
        proposalCount: 1 as const, suggestionHash: "7".repeat(64),
        planReceiptHash: acceptedPlan.receiptHash, receiptHash: "8".repeat(64),
        usage: { modelCalls: 1, inputTokens: 120, outputTokens: 30, costMinorUnits: 9 },
      };
      return {
        plans: [acceptedPlan], receipts: [llmReceipt], usage: llmReceipt.usage,
        summary: {} as never,
      };
    });
    const pricing = vi.fn(() => 9);
    const commitBatch = vi.fn(async (input: { nextAfterId: string | null }) => ({
      afterId: input.nextAfterId, checkpointVersion: 1, state: "completed" as const,
    }));
    const repository = {
      readModelUsage: vi.fn()
        .mockResolvedValueOnce({ modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 })
        .mockResolvedValue({ modelCalls: 1, inputTokens: 120, outputTokens: 30, costMinorUnits: 9 }),
      reserveModelAttempt: vi.fn(),
      completeModelAttempt: vi.fn(),
      listScopes: vi.fn().mockResolvedValueOnce([{ scope, memoriesCount: 1, knowledgeCount: 0 }])
        .mockResolvedValueOnce([]),
      createRun: vi.fn(async () => ({
        runId: "run-live", scopeFingerprint: "9".repeat(64), attemptHash: "a".repeat(64),
        snapshots: [
          { sourceTable: "memories" as const, sourceUpperBound: row.recordId, sourceCount: 1, snapshotHash: "b".repeat(64) },
          { sourceTable: "knowledge" as const, sourceUpperBound: null, sourceCount: 0, snapshotHash: "c".repeat(64) },
        ],
      })),
      scanBatch: vi.fn(async (input: { sourceTable: string }) =>
        input.sourceTable === "memories" ? [row] : []),
      commitBatch,
      applyRun: vi.fn(async () => ({ active: 1, lookupOnly: 0, classifiedInactive: 0, evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0 })),
      verifyRun: vi.fn(async () => ({
        totalSourceCount: 1, memorySourceCount: 1, knowledgeSourceCount: 0,
        totalPlanCount: 1, memoryPlanCount: 1, knowledgePlanCount: 0,
        appliedMemoryCount: 1, unchangedKnowledgeCount: 0,
        evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0,
        queuedTreeJobs: 0, completedTreeJobs: 0, deadLetterTreeJobs: 0,
      })),
      rollbackRun: vi.fn(),
    };
    const deps = createHistoryRebuildOperatorDependencies({
      now: () => 123, runId: () => "run-live", repository: () => repository,
      estimateCostMinorUnits: pricing, llmPlanner,
      llm: { available: true, extractStructured: vi.fn() },
    });
    const queryStatements: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string,
    ) => {
      queryStatements.push(statement);
      return {
        rows: [{ source_count: "1", snapshot_sha256: snapshotSha256 }] as unknown as Row[],
        rowCount: 1,
      };
    };
    await expect(deps.apply({
      client: { query },
      ...bundleInput,
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: true,
      operatorConfig: { llm: { model: "fallback", extractionModel: "extract-model-v1", baseURL: "https://models.example.test/v1" } },
    })).resolves.toMatchObject({ modelCalls: 1, costMinorUnits: 9 });
    expect(pricing).toHaveBeenCalledWith(120, 30, {
      model: "extract-model-v1", currency: "CNY",
      pricingSnapshotVersion: "pricing-2026-08-13",
    });
    expect(queryStatements).toHaveLength(1);
    expect(queryStatements[0]).toContain("history-rebuild:verify-snapshot");
    expect(queryStatements[0]).not.toContain("vector::text");
    expect(commitBatch.mock.calls[0]![0]).toMatchObject({
      modelReceipts: [{
        receiptHash: "8".repeat(64), recordId: row.recordId,
        sourceHash: row.sourceHash,
        planReceiptHash: acceptedPlan.receiptHash,
        inputHash: "6".repeat(64), outputHash: "7".repeat(64),
        confidence: 0.91, proposalCount: 1, inputTokens: 120, outputTokens: 30,
      }],
    });
  });

  test("live apply resumes from durable checkpoint and charges only the manifest remainder", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
      workspaceId: "workspace", sessionId: "session",
    };
    const firstId = "44444444-4444-4444-8444-444444444441";
    const remaining = {
      sourceTable: "memories" as const,
      recordId: "44444444-4444-4444-8444-444444444442",
      sourceHash: "5".repeat(64), text: "remaining ambiguous fact", kind: "fact" as const,
      metadata: {}, scope,
    };
    const firstHash = "4".repeat(64);
    const snapshotSha256 = createHash("sha256").update([
      `memories\u001f${firstId}\u001f${firstHash}`,
      `memories\u001f${remaining.recordId}\u001f${remaining.sourceHash}`,
    ].join("\n")).digest("hex");
    const acceptedPlan = {
      sourceTable: "memories" as const, recordId: remaining.recordId,
      sourceHash: remaining.sourceHash, disposition: "model_classify" as const,
      semanticType: "experience" as const, topicLabels: ["resume"], contextEligible: true,
      treeEligibility: { source: true, topic: true, global: false },
      reason: "model_classification_accepted" as const, modelConfidence: 0.91,
      receiptHash: "6".repeat(64),
    };
    const llmPlanner = vi.fn(async (plannerInput: RunHistoryRebuildLlmPlannerInput) => {
      expect(plannerInput.rows.map((row) => row.recordId)).toEqual([remaining.recordId]);
      expect(plannerInput.manifest.budget).toEqual(manifest.budget);
      expect(plannerInput.runId).toBe("run-resumed");
      const usage = { modelCalls: 1, inputTokens: 120, outputTokens: 30, costMinorUnits: 1 };
      return {
        plans: [acceptedPlan],
        receipts: [{
          version: 1 as const, recordId: remaining.recordId, sourceHash: remaining.sourceHash,
          ...deriveHistoryRebuildLlmPins(plannerInput.manifest),
          inputHash: "7".repeat(64), outputHash: "8".repeat(64), confidence: 0.91,
          proposalCount: 1 as const, suggestionHash: "8".repeat(64),
          planReceiptHash: acceptedPlan.receiptHash, receiptHash: "9".repeat(64), usage,
        }],
        usage,
        summary: {} as never,
      };
    });
    const repository = {
      readModelUsage: vi.fn()
        .mockResolvedValueOnce({ modelCalls: 1, inputTokens: 100, outputTokens: 20, costMinorUnits: 1 })
        .mockResolvedValueOnce({ modelCalls: 2, inputTokens: 220, outputTokens: 50, costMinorUnits: 2 }),
      reserveModelAttempt: vi.fn(),
      completeModelAttempt: vi.fn(),
      listScopes: vi.fn().mockResolvedValueOnce([{ scope, memoriesCount: 2, knowledgeCount: 0 }])
        .mockResolvedValueOnce([]),
      createRun: vi.fn(async () => ({
        runId: "run-resumed", scopeFingerprint: "a".repeat(64), attemptHash: "b".repeat(64),
        state: "running" as const,
        snapshots: [
          { sourceTable: "memories" as const, sourceUpperBound: remaining.recordId,
            sourceCount: 2, snapshotHash: "c".repeat(64), afterId: firstId,
            checkpointVersion: 1, processedCount: 1, checkpointState: "running" as const },
          { sourceTable: "knowledge" as const, sourceUpperBound: null,
            sourceCount: 0, snapshotHash: "d".repeat(64), afterId: null,
            checkpointVersion: 0, processedCount: 0, checkpointState: "completed" as const },
        ],
      })),
      scanBatch: vi.fn(async (scan: { afterId: string | null }) => {
        expect(scan.afterId).toBe(firstId);
        return [remaining];
      }),
      commitBatch: vi.fn(async (commit: {
        nextAfterId: string | null;
        sourceRows: readonly unknown[];
      }) => ({
        afterId: commit.nextAfterId, checkpointVersion: 2, state: "completed" as const,
      })),
      applyRun: vi.fn(async () => ({ active: 2, lookupOnly: 0, classifiedInactive: 0,
        evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0 })),
      verifyRun: vi.fn(async () => ({ totalSourceCount: 2, memorySourceCount: 2,
        knowledgeSourceCount: 0, totalPlanCount: 2, memoryPlanCount: 2,
        knowledgePlanCount: 0, appliedMemoryCount: 2, unchangedKnowledgeCount: 0,
        evidenceMirrors: 0, evidenceLinks: 0, treeJobs: 0, queuedTreeJobs: 0,
        completedTreeJobs: 0, deadLetterTreeJobs: 0 })),
      rollbackRun: vi.fn(),
    };
    const dependencies = createHistoryRebuildOperatorDependencies({
      repository: () => repository, llmPlanner,
      llm: { available: true, extractStructured: vi.fn() },
    });
    const result = await dependencies.apply({
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [{ source_count: "2", snapshot_sha256: snapshotSha256 }] as unknown as Row[],
        rowCount: 1,
      }) },
      ...bundleInput,
      manifest: { ...manifest, source: {
        sourceCount: 2, snapshotSha256, parserVersions: ["v24"],
      } },
      manifestSha256, modelAssisted: true,
      operatorConfig: { llm: { model: "fallback", extractionModel: "extract-model-v1",
        baseURL: "https://models.example.test/v1" } },
    });

    expect(result).toMatchObject({
      applied: 2, modelCalls: 2, inputTokens: 220, outputTokens: 50, costMinorUnits: 2,
    });
    expect(repository.readModelUsage).toHaveBeenCalledTimes(2);
    expect(repository.commitBatch).toHaveBeenCalledOnce();
    expect(repository.commitBatch.mock.calls[0]![0].sourceRows).toEqual([remaining]);
    expect(llmPlanner).toHaveBeenCalledOnce();
  });

  test("live apply rejects exhausted durable usage before model calls or writes", async () => {
    const planner = vi.fn();
    const listScopes = vi.fn();
    const repository = {
      readModelUsage: vi.fn(async () => ({
        modelCalls: manifest.budget.maxModelCalls + 1, inputTokens: 0, outputTokens: 0,
        costMinorUnits: 0,
      })),
      reserveModelAttempt: vi.fn(), completeModelAttempt: vi.fn(),
      listScopes, createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
      applyRun: vi.fn(), verifyRun: vi.fn(), rollbackRun: vi.fn(),
    };
    const dependencies = createHistoryRebuildOperatorDependencies({
      repository: () => repository, llmPlanner: planner,
      llm: { available: true, extractStructured: vi.fn() },
    });
    const emptySnapshotSha256 = createHash("sha256").update("").digest("hex");

    await expect(dependencies.apply({
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [{ source_count: "0", snapshot_sha256: emptySnapshotSha256 }] as unknown as Row[],
        rowCount: 1,
      }) },
      ...bundleInput,
      manifest: { ...manifest, source: {
        sourceCount: 0, snapshotSha256: emptySnapshotSha256, parserVersions: ["v24"],
      } },
      manifestSha256, modelAssisted: true,
      operatorConfig: { llm: { model: "fallback", extractionModel: "extract-model-v1",
        baseURL: "https://models.example.test/v1" } },
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_BUDGET_EXCEEDED" });
    expect(planner).not.toHaveBeenCalled();
    expect(listScopes).not.toHaveBeenCalled();
    expect(repository.createRun).not.toHaveBeenCalled();
  });

  test("production dependencies calculate cost from the pinned per-million-token prices", async () => {
    const planner = vi.fn(async (_input, plannerDependencies) => {
      expect(plannerDependencies.estimateCostMinorUnits(1_000_000, 500_000)).toBe(250);
      return {
        plans: [], receipts: [],
        usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 },
        summary: {} as never,
      };
    });
    const dependencies = createHistoryRebuildOperatorDependencies({
      llmPlanner: planner,
      llm: { available: true, extractStructured: vi.fn() },
    });
    await expect(dependencies.planWithModel({
      client: { query: async () => ({ rows: [], rowCount: 0 }) },
      manifest: {
        ...manifest,
        source: {
          sourceCount: 0,
          snapshotSha256: createHash("sha256").update("").digest("hex"),
          parserVersions: ["v24"],
        },
      },
      manifestSha256,
      modelAssisted: true,
      operatorConfig: {
        llm: { model: "fallback", extractionModel: "extract-model-v1", baseURL: "https://models.example.test/v1" },
      },
    })).resolves.toMatchObject({ estimatedCostMinorUnits: 0 });
    expect(planner).toHaveBeenCalledOnce();
  });

  test("default rollback uses the v24 scope policy and preserves v23 compatibility", async () => {
    const sql: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      statement: string,
    ) => {
        sql.push(statement);
        const rows = statement.includes("history-rebuild:rollback-runs")
          ? [{
              run_id: "run-1", tenant_id: "tenant", user_id: "user", app_id: "app",
              project_id: "project", agent_id: "agent", namespace: "default",
              visibility: "private", workspace_id: "workspace", session_id: "session",
            }]
          : [];
        return { rows: rows as unknown as Row[], rowCount: rows.length };
      };
    const client: HistoryRebuildQueryClient = { query: vi.fn(query) as typeof query };
    const rollbackRun = vi.fn(async () => ({
      restored: 4, removedEvidenceMirrors: 1, removedTreeJobs: 2,
    }));
    const deps = createHistoryRebuildOperatorDependencies({
      now: () => 456,
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(), rollbackRun,
      }),
    });
    const result = await deps.rollback({
      client, ...bundleInput, manifest, manifestSha256,
      modelAssisted: false, operatorConfig: {},
    });
    expect(result).toMatchObject({
      rolledBackRuns: 1, restoredSourceRows: 4, removedTreeJobs: 2,
    });
    expect(rollbackRun).toHaveBeenCalledOnce();
    expect(rollbackRun).toHaveBeenLastCalledWith(expect.objectContaining({
      treePolicy: treePolicyBundle.policies[0],
    }));
    await expect(deps.rollback({
      client, manifest: legacyManifest, manifestSha256: legacyManifestSha256,
      modelAssisted: false, operatorConfig: {},
    })).resolves.toMatchObject({ rolledBackRuns: 1, restoredSourceRows: 4 });
    expect(rollbackRun).toHaveBeenLastCalledWith(expect.not.objectContaining({
      treePolicy: expect.anything(),
    }));
    expect(sql.join("\n")).toContain("mengshu_history_rebuild_runs");
    expect(sql.join("\n")).not.toMatch(/(?:UPDATE|DELETE FROM)\s+(?:memories|knowledge)\b/i);
  });

  test("default verify requires completed sealed history trees and reports L1-L3 counts", async () => {
    const scope = {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private",
      workspaceId: "workspace", sessionId: "session",
    };
    const snapshotSha256 = "a".repeat(64);
    const sealed = sealedTreeRow();
    let globalVerifyParams: readonly unknown[] | undefined;
    const verifySql: string[] = [];
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      verifySql.push(sql);
      if (sql.includes("verify-global-parity")) globalVerifyParams = params;
      const rows = sql.includes("verify-snapshot")
        ? [{ source_count: "1", snapshot_sha256: snapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow(scope as typeof primaryScope)]
        : sql.includes("verify-tree-routing-input") ? [routingReplayRow()]
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow()]
        : sql.includes("verify-global-parity") ? [globalParityRow()]
        : sql.includes("verify-sealed-trees") ? [sealed] : [];
      return { rows: rows as unknown as Row[], rowCount: 1 };
    };
    const verifyRun = vi.fn(async () => verifiedRunResult());
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun, rollbackRun: vi.fn(),
      }),
    });
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("migration_id = $1");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("manifest_hash = $2");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("jsonb_each_text($7::jsonb)");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("jsonb_to_recordset($8::jsonb)");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("run.policy_hash <> expected.policy_hash");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("expected_only.scope_fingerprint");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("NOT (source.source_row ? 'valueScore')");
    expect(HISTORY_GLOBAL_VERIFY_SQL).not.toContain(
      "($6::text IS NULL OR memory.metadata->'topicLabels' = expected.topic_labels)",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "memory.metadata#>>'{historyRebuild,treeRouting,policyHash}' = routing.policy_hash",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "memory.metadata#>>'{historyRebuild,treeRouting,receiptHash}' = routing.receipt_hash",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "memory.metadata#>>'{historyRebuild,treeRouting,sourceReason}' = routing.source_reason",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "memory.metadata#>>'{historyRebuild,treeRouting,topicReason}' = routing.topic_reason",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "memory.metadata->'topicLabels' = routing.topic_labels",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("topicHotnessEligible");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("tree_routing_drift_count");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("FULL JOIN expected_tree_routing routing");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("COALESCE(SUM(entries - 1), 0)");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "routing.source_eligible =\n          (routing.source_reason IN",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain(
      "routing.topic_eligible = (routing.topic_reason = 'canonical_topics_selected')",
    );
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("classified_operation_receipts");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("expected_batch_groups");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("run_group_drift");
    expect(HISTORY_GLOBAL_VERIFY_SQL).toContain("mengshu.history-rebuild-operation/v1");
    expect(HISTORY_GLOBAL_VERIFY_SQL).not.toContain("counts->>'planned'");
    expect(SEALED_TREE_VERIFY_SQL).toContain(
      "leaf.id = target.record_id::text",
    );
    expect(SEALED_TREE_VERIFY_SQL).toContain(
      "jsonb_array_length(buffer.child_node_ids) >= 20",
    );
    expect(SEALED_TREE_VERIFY_SQL).toContain("buffer.token_count >= 6000");
    expect(SEALED_TREE_VERIFY_SQL).not.toContain(
      "leaf.source_job_id = target.leaf_job_id",
    );
    expect(SEALED_TREE_VERIFY_SQL).not.toContain("mengshu_history_rebuild_shadow_plans");
    await expect(deps.verify({
      client: { query },
      ...bundleInput,
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).resolves.toMatchObject({
      globalParityVerification: {
        runs: { total: 1, completed: 1, nonCompleted: 0, scopes: 1 },
        ledger: {
          sourceRows: 1, plans: 1, settled: 1, metadataParity: 1,
          expectedModelReceipts: 0, modelReceipts: 0,
          batchAppliedRecords: 1, batchApplyReceipts: 1, runApplyReceipts: 1,
        },
        inventory: {
          physical: 1, included: 1, legacyQuarantine: 0, newQuarantine: 0,
          tables: {
            memories: { physical: 1, included: 1, legacyQuarantine: 0, newQuarantine: 0 },
            knowledge: { physical: 0, included: 0, legacyQuarantine: 0, newQuarantine: 0 },
          },
        },
        scoring: {
          total: 1,
          valueScore: { real: 0, legacyFloor: 1, realRate: 0, legacyFloorRate: 1 },
          importance: { real: 0, legacyFloor: 1, realRate: 0, legacyFloorRate: 1 },
          confidence: { real: 0, legacyFloor: 1, realRate: 0, legacyFloorRate: 1 },
        },
      },
      sealedTreeVerification: {
        historyTreeJobs: 4, completedTreeJobs: 4,
        sourceTargets: 1, topicTargets: 1,
        sealedSourceTargets: 1, sealedTopicTargets: 1,
        coveredLeaves: 2, evidenceCoveredLeaves: 2,
        unfinishedL0Buffers: 0, foldableParentBuffers: 0,
        l1Nodes: 2, l2Nodes: 1, l3Nodes: 1,
      },
    });
    expect(globalVerifyParams?.[5]).toBeNull();
    expect(JSON.parse(String(globalVerifyParams?.[6]))).toEqual({
      [authorityScopeFingerprint(primaryScope)]: historyRebuildTreeRoutingPolicyHash(
        treePolicyBundle.policies[0]!,
      ),
    });
    const replay = routingReplayRow();
    const expectedRouting = planHistoryRebuildTreeRouting({
      source: replay.source_row,
      plan: replay.plan,
      policy: treePolicyBundle.policies[0]!,
    });
    expect(JSON.parse(String(globalVerifyParams?.[7]))).toEqual([{
      run_id: replay.run_id,
      source_table: replay.source_table,
      record_id: replay.record_id,
      source_hash: replay.source_hash,
      plan_receipt_hash: replay.plan.receiptHash,
      policy_version: expectedRouting.policyVersion,
      policy_hash: expectedRouting.policyHash,
      receipt_hash: expectedRouting.receiptHash,
      topic_labels: expectedRouting.topic.labels,
      source_eligible: expectedRouting.source.eligible,
      topic_eligible: expectedRouting.topic.eligible,
      source_reason: expectedRouting.source.reason,
      topic_reason: expectedRouting.topic.reason,
    }]);
    expect(expectedRouting.topic.labels).toEqual(["migration", "release", "resume"]);
    expect(verifyRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-verified", treePolicy: treePolicyBundle.policies[0],
    }));
    expect(verifySql.some((sql) => sql.includes("history-rebuild:scan"))).toBe(false);
    expect(verifySql.some((sql) => sql.includes("history-rebuild:verify-snapshot"))).toBe(true);
    expect(verifySql.some((sql) => sql.includes("history-rebuild:verify-tree-routing-input")))
      .toBe(true);
  });

  test("v23 global verify retains the legacy global policy hash pin", async () => {
    let verifyParams: readonly unknown[] | undefined;
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      if (sql.includes("verify-global-parity")) verifyParams = params;
      const rows = sql.includes("verify-snapshot")
        ? [{ source_count: "1", snapshot_sha256: snapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow()]
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow()]
        : sql.includes("verify-global-parity") ? [globalParityRow()]
        : sql.includes("verify-sealed-trees") ? [sealedTreeRow()] : [];
      return { rows: rows as unknown as Row[], rowCount: 1 };
    };
    const snapshotSha256 = "a".repeat(64);
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(async () => verifiedRunResult()),
        rollbackRun: vi.fn(),
      }),
    });
    await expect(deps.verify({
      client: { query },
      manifest: {
        ...legacyManifest,
        source: { sourceCount: 1, snapshotSha256, parserVersions: ["postgres-history-v23"] },
      },
      manifestSha256: legacyManifestSha256, modelAssisted: false, operatorConfig: {},
    })).resolves.toMatchObject({ globalParityVerification: { runs: { pinDrift: 0 } } });
    expect(verifyParams?.[5]).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyParams?.[6]).toBe("{}");
    expect(verifyParams?.[7]).toBe("[]");
  });

  test("v24 strict routing replay downgrades singleton topics instead of preserving shadow labels", async () => {
    const snapshotSha256 = "a".repeat(64);
    let verifyParams: readonly unknown[] | undefined;
    const replay = routingReplayRow(["singleton-topic"]);
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      if (sql.includes("verify-global-parity")) verifyParams = params;
      const rows = sql.includes("verify-snapshot")
        ? [{ source_count: "1", snapshot_sha256: snapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow()]
        : sql.includes("verify-tree-routing-input") ? [replay]
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow()]
        : sql.includes("verify-global-parity") ? [globalParityRow()]
        : sql.includes("verify-sealed-trees") ? [sealedTreeRow({
          history_tree_job_count: "2", completed_tree_job_count: "2",
          finalize_job_count: "1", distinct_target_count: "1",
          eligible_topic_record_count: "0", expected_topic_target_count: "0",
          topic_target_count: "0", sealed_topic_target_count: "0",
          covered_leaf_count: "1", evidence_covered_leaf_count: "1",
          l1_node_count: "1", l2_node_count: "0", l3_node_count: "0",
        })] : [];
      return { rows: rows as unknown as Row[], rowCount: rows.length };
    };
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(async () => verifiedRunResult()),
        rollbackRun: vi.fn(),
      }),
    });
    await expect(deps.verify({
      client: { query }, ...bundleInput,
      manifest: {
        ...manifest,
        source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] },
      },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).resolves.toMatchObject({ globalParityVerification: { ledger: { metadataParity: 1 } } });
    expect(JSON.parse(String(verifyParams?.[7]))).toEqual([
      expect.objectContaining({
        topic_labels: [], topic_eligible: false, topic_reason: "taxonomy_miss",
      }),
    ]);
  });

  test.each([
    ["policy hash drift", [primaryScope], "HISTORY_REBUILD_SOURCE_DRIFT"],
    ["missing scope policy", [], "HISTORY_REBUILD_INVALID_MANIFEST"],
    ["extra scope policy", [primaryScope, {
      tenantId: "tenant", userId: "user", appId: "app", projectId: "project",
      agentId: "agent", namespace: "default", visibility: "private" as const,
    }], "HISTORY_REBUILD_SOURCE_DRIFT"],
  ])("v24 global verify rejects %s", async (_case, policyScopes, expectedCode) => {
    const scopedBundle = policyBundleInputForScopes(policyScopes);
    let verifyParams: readonly unknown[] | undefined;
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      if (sql.includes("verify-global-parity")) verifyParams = params;
      const rows = sql.includes("verify-snapshot")
        ? [{ source_count: "0", snapshot_sha256: emptySnapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow()]
        : sql.includes("verify-tree-routing-input") ? []
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow(0)]
        : sql.includes("verify-global-parity")
          ? [globalParityRow({ pin_drift_count: "1" })] : [];
      return { rows: rows as unknown as Row[], rowCount: 1 };
    };
    const emptySnapshotSha256 = createHash("sha256").update("").digest("hex");
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(async () => verifiedRunResult(0)),
        rollbackRun: vi.fn(),
      }),
    });
    await expect(deps.verify({
      client: { query }, ...scopedBundle,
      manifest: {
        ...manifest,
        source: {
          sourceCount: 0, snapshotSha256: emptySnapshotSha256,
          parserVersions: ["postgres-history-v24"],
        },
        tree: { ...manifest.tree, policyBundleSha256: scopedBundle.treePolicyBundleSha256 },
      },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: expectedCode });
    if (verifyParams) {
      expect(Object.keys(JSON.parse(String(verifyParams[6])))).toHaveLength(policyScopes.length);
    }
  });

  test("default plan adapters preserve offline estimates and pinned model callback contracts", async () => {
    const recordId = "11111111-1111-4111-8111-111111111111";
    const sourceHash = "a".repeat(64);
    const raw = {
      source_table: "memories", record_id: recordId, source_hash: sourceHash,
      text: "prefers concise replies", memory_kind: "preference", metadata: {},
      tenant_id: "tenant", user_id: "user", product_id: "app",
      canonical_project_id: "project", producer_id: "agent", namespace: "default",
      visibility: "private", workspace_id: "workspace", session_id: "session",
      content_hash: "content", vector_text: "[0.1]", importance: 0.6,
      category: "core", data_type: "memory", lifecycle_status: "active",
      created_at_ms: "123", embedding_space_id: null, embedding_space_state: null,
    };
    const snapshotSha256 = createHash("sha256")
      .update(`memories\u001f${recordId}\u001f${sourceHash}`).digest("hex");
    const llmPlanner = vi.fn(async (
      plannerInput: RunHistoryRebuildLlmPlannerInput,
      dependencies: HistoryRebuildLlmPlannerDependencies,
    ) => {
      expect(dependencies.estimateTokens("abcd")).toBe(1);
      expect(dependencies.estimateCostMinorUnits(1_000_000, 0)).toBe(100);
      await dependencies.checkpoint({
        version: 1, manifestSha256, sourceBatchSha256: "b".repeat(64), afterIndex: 0,
        usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 },
        receiptHashes: [],
      });
      await dependencies.wait(0);
      return {
        plans: plannerInput.rows.map((row) => planHistoryRebuild(row)), receipts: [],
        usage: { modelCalls: 0, inputTokens: 4, outputTokens: 0, costMinorUnits: 1 },
        summary: {} as never,
      };
    });
    const deps = createHistoryRebuildOperatorDependencies({
      llmPlanner,
      llm: { available: true, extractStructured: vi.fn() },
    });
    const input = {
      client: { query: async <Row extends Record<string, unknown> = Record<string, unknown>>() => ({
        rows: [raw] as unknown as Row[], rowCount: 1,
      }) },
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: false, operatorConfig: {
        llm: { model: "fallback", extractionModel: "extract-model-v1", baseURL: "https://models.example.test/v1" },
      },
    };

    await expect(deps.plan(input)).resolves.toMatchObject({
      sourceCount: 1, estimatedModelCalls: 0, estimatedInputTokens: 6,
      estimatedOutputTokens: 128,
    });
    await expect(deps.planWithModel({ ...input, modelAssisted: true })).resolves.toMatchObject({
      sourceCount: 1, estimatedModelCalls: 0, estimatedInputTokens: 4,
      estimatedOutputTokens: 0, estimatedCostMinorUnits: 1,
    });
    expect(llmPlanner).toHaveBeenCalledOnce();
  });

  test.each([
    ["partial run", { completed_run_count: "0", non_completed_run_count: "1" }],
    ["missing plan", { plan_count: "0" }],
    ["missing model receipt", {
      expected_model_receipt_count: "1", model_receipt_count: "0",
      model_receipt_parity_count: "0",
    }],
    ["metadata drift", { metadata_parity_count: "0" }],
    ["routing policy hash drift", { metadata_parity_count: "0" }],
    ["routing receipt hash drift", { metadata_parity_count: "0" }],
    ["canonical topic label or order drift", { metadata_parity_count: "0" }],
    ["routing reason or eligibility drift", { metadata_parity_count: "0" }],
    ["missing expected routing", { tree_routing_drift_count: "1" }],
    ["duplicate expected routing", { tree_routing_drift_count: "1" }],
    ["extra expected routing", { tree_routing_drift_count: "1" }],
    ["physical inventory drift", { physical_memory_count: "2" }],
  ])("global verify rejects %s", async (_case, override) => {
    const snapshotSha256 = "a".repeat(64);
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ) => ({
      rows: (sql.includes("verify-snapshot")
        ? [{ source_count: "1", snapshot_sha256: snapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow()]
        : sql.includes("verify-tree-routing-input") ? [routingReplayRow()]
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow()]
        : sql.includes("verify-global-parity") ? [globalParityRow(override)]
        : sql.includes("verify-sealed-trees") ? [sealedTreeRow()] : []) as unknown as Row[],
      rowCount: 1,
    });
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(async () => verifiedRunResult()),
        rollbackRun: vi.fn(),
      }),
    });

    await expect(deps.verify({
      client: { query },
      ...bundleInput,
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_SOURCE_DRIFT" });
  });

  test.each([
    ["pending job", { completed_tree_job_count: "3" }],
    ["dead letter", { dead_letter_tree_job_count: "1" }],
    ["missing deduplicated finalize", { finalize_job_count: "1" }],
    ["missing evidence coverage", { evidence_covered_leaf_count: "1" }],
    ["unfinished L0", { unfinished_l0_buffer_count: "1" }],
    ["foldable L2/L3 parent left open", { foldable_parent_buffer_count: "1" }],
    ["missing topic target", { topic_target_count: "0", sealed_topic_target_count: "0" }],
    ["unsealed topic target", { sealed_topic_target_count: "0" }],
  ])("sealed tree verify rejects %s", async (_case, override) => {
    const snapshotSha256 = "a".repeat(64);
    const counts = {
      run_count: "1", history_tree_job_count: "4", completed_tree_job_count: "4",
      dead_letter_tree_job_count: "0", finalize_job_count: "2", distinct_target_count: "2",
      expected_source_target_count: "1",
      eligible_topic_record_count: "1", expected_topic_target_count: "1",
      source_target_count: "1", topic_target_count: "1",
      sealed_source_target_count: "1", sealed_topic_target_count: "1",
      covered_leaf_count: "2", evidence_covered_leaf_count: "2",
      unfinished_l0_buffer_count: "0", foldable_parent_buffer_count: "0", l1_node_count: "2",
      l2_node_count: "0", l3_node_count: "0", ...override,
    };
    const query = async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
    ) => ({
      rows: (sql.includes("verify-snapshot")
        ? [{ source_count: "1", snapshot_sha256: snapshotSha256 }]
        : sql.includes("verify-runs") ? [persistedRunRow()]
        : sql.includes("verify-tree-routing-input") ? [routingReplayRow()]
        : sql.includes("verified-plan-summary") ? [verifiedPlanSummaryRow()]
        : sql.includes("verify-global-parity") ? [globalParityRow()]
        : sql.includes("verify-sealed-trees") ? [counts] : []) as unknown as Row[],
      rowCount: 1,
    });
    const deps = createHistoryRebuildOperatorDependencies({
      repository: () => ({
        listScopes: vi.fn(), createRun: vi.fn(), scanBatch: vi.fn(), commitBatch: vi.fn(),
        applyRun: vi.fn(), verifyRun: vi.fn(async () => verifiedRunResult()),
        rollbackRun: vi.fn(),
      }),
    });
    await expect(deps.verify({
      client: { query },
      ...bundleInput,
      manifest: { ...manifest, source: { sourceCount: 1, snapshotSha256, parserVersions: ["v24"] } },
      manifestSha256, modelAssisted: false, operatorConfig: {},
    })).rejects.toMatchObject({ code: "HISTORY_REBUILD_SOURCE_DRIFT" });
  });
});
