import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import pg from "pg";

import { memoryConfigSchema, type MemoryConfig } from "../config.js";
import { authorityScopeFingerprint } from
  "../packages/core/src/domain/authority-scope-fingerprint.js";
import {
  planHistoryRebuild,
  summarizeHistoryRebuildPlans,
  type HistoryRebuildPlan,
  type HistoryRebuildScanRow,
} from "../packages/core/src/db/migrations/history-rebuild.js";
import {
  PostgresHistoryRebuildRepository,
  HISTORY_REBUILD_SOURCE_IDENTITY_VERSION,
  HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION,
  HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
  historyRebuildTreeRoutingPolicyHash,
  planHistoryRebuildTreeRouting,
  historyRebuildSourceKind,
  type CreatedHistoryRebuildRun,
  type AppliedHistoryRebuildRun,
  type HistoryRebuildBatchCommit,
  type HistoryRebuildModelReceiptInput,
  type HistoryRebuildScopeSummary,
  type HistoryRebuildSourceIdentityFact,
  type HistoryRebuildTreeRoutingPolicy,
  type ListHistoryRebuildScopesInput,
  type ScanHistoryRebuildBatchInput,
  type RolledBackHistoryRebuildRun,
  type VerifiedHistoryRebuildRun,
} from "../packages/core/src/db/migrations/postgres-history-rebuild.js";
import { normalizeTopicLabel } from "../packages/core/src/tree/tree-fan-out.js";
import { REDACTION_MAP_VERSION, redactSecrets } from
  "../packages/core/src/ingest/agent-history/redaction.js";
import { createLlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import {
  deriveHistoryRebuildLlmPins,
  runHistoryRebuildLlmPlanner,
} from "./history-rebuild-llm.js";
import type {
  HistoryRebuildLlmReceipt,
  RunHistoryRebuildLlmPlannerInput,
  HistoryRebuildLlmPlannerDependencies,
} from "./history-rebuild-llm.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const PROVIDER = "openai-compatible" as const;

export interface HistoryRebuildManifest {
  readonly version: 1;
  readonly migrationId: string;
  readonly requiredSchemaVersion: 23 | 24;
  readonly source: Readonly<{
    snapshotSha256: string;
    sourceCount: number;
    parserVersions: readonly string[];
  }>;
  readonly funnel: Readonly<{
    mappingVersion: "kind-to-semantic-type/v1";
    conflictPolicy: "lookup_only";
    lifecyclePolicy: "preserve";
  }>;
  readonly models: Readonly<{
    extraction: Readonly<{
      provider: typeof PROVIDER;
      baseURL: string;
      model: string;
      promptPolicyVersion: string;
      temperature: 0;
    }>;
    embedding: Readonly<{
      provider: typeof PROVIDER;
      baseURL: string;
      model: string;
      dimensions: number;
      normalization: "l2" | "none";
    }>;
  }>;
  readonly budget: Readonly<{
    maxRecords: number;
    maxModelCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxCostMinorUnits: number;
    currency: string;
    pricingSnapshotVersion: string;
    inputCostPerMillionTokens: number;
    outputCostPerMillionTokens: number;
  }>;
  readonly security: Readonly<{
    remoteEgress: "deny" | "redacted-only";
    redactionMapVersion: string;
    logContent: "hash-only";
    receiptContent: "hash-only";
  }>;
  readonly tree: Readonly<{
    policyVersion: string;
    topicLabelVersion: string;
    policyBundleSha256?: string;
    requireEvidence: true;
    requireSealed: true;
    ambiguousPolicy: "quarantine";
  }>;
}

export interface HistoryRebuildTreePolicyBundle {
  readonly version: 1;
  readonly policyVersion: typeof HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION;
  readonly topicTaxonomyVersion: typeof HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION;
  readonly sourceIdentityVersion: typeof HISTORY_REBUILD_SOURCE_IDENTITY_VERSION;
  readonly policies: readonly HistoryRebuildTreeRoutingPolicy[];
}

export interface LoadedHistoryRebuildTreePolicyBundle {
  readonly bundle: HistoryRebuildTreePolicyBundle;
  readonly sha256: string;
}

export interface HistoryRebuildTreePolicyAuditReport {
  readonly version: 1;
  readonly policyVersion: typeof HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION;
  readonly bundleSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceCount: number;
  readonly scopes: number;
  readonly emptyPolicies: number;
  readonly topic: Readonly<{
    planEligible: number;
    rawAssignments: number;
    rawTargetsAtMinimumSupport: number;
    retainedRecords: number;
    retainedAssignments: number;
    targetCount: number;
    singletonTargets: number;
    minimumTargetLeaves: number;
    maximumTargetLeaves: number;
    iterations: number;
  }>;
  readonly source: Readonly<{
    planEligible: number;
    directSessionRecords: number;
    auditedRecords: number;
    targetCount: number;
    minimumTargetLeaves: number;
    maximumTargetLeaves: number;
    singletonDowngraded: number;
    priorLookupOnlyDowngraded: number;
    missingAuditableIdentity: number;
  }>;
  readonly policyHashes: readonly Readonly<{
    scopeFingerprint: string;
    policyHash: string;
  }>[];
}

export interface LoadedHistoryRebuildManifest {
  readonly manifest: HistoryRebuildManifest;
  readonly sha256: string;
}

export interface HistoryRebuildPlanningResult {
  readonly sourceCount: number;
  readonly dispositions: Readonly<{
    preserveExplicit: number;
    backfill: number;
    lookupOnly: number;
    invalidExplicit: number;
  }>;
  readonly tree: Readonly<{
    mapped: number;
    orphan: number;
    ambiguous: number;
  }>;
  readonly estimatedModelCalls: number;
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number;
  readonly estimatedCostMinorUnits: number;
  readonly globalParityVerification?: HistoryRebuildGlobalParityVerification;
  readonly sealedTreeVerification?: HistoryRebuildSealedTreeVerification;
}

interface HistoryRebuildScoreBasisReport {
  readonly real: number;
  readonly legacyFloor: number;
  readonly realRate: number;
  readonly legacyFloorRate: number;
}

interface HistoryRebuildInventoryTableReport {
  readonly physical: number;
  readonly included: number;
  readonly legacyQuarantine: number;
  readonly newQuarantine: number;
}

export interface HistoryRebuildGlobalParityVerification {
  readonly runs: Readonly<{
    total: number;
    completed: number;
    nonCompleted: number;
    scopes: number;
    identityConflicts: number;
    pinDrift: number;
  }>;
  readonly ledger: Readonly<{
    sourceRows: number;
    plans: number;
    settled: number;
    metadataParity: number;
    expectedModelReceipts: number;
    modelReceipts: number;
    batchAppliedRecords: number;
    batchApplyReceipts: number;
    runApplyReceipts: number;
  }>;
  readonly inventory: Readonly<{
    physical: number;
    included: number;
    legacyQuarantine: number;
    newQuarantine: number;
    tables: Readonly<{
      memories: HistoryRebuildInventoryTableReport;
      knowledge: HistoryRebuildInventoryTableReport;
    }>;
  }>;
  readonly scoring: Readonly<{
    total: number;
    valueScore: HistoryRebuildScoreBasisReport;
    importance: HistoryRebuildScoreBasisReport;
    confidence: HistoryRebuildScoreBasisReport;
  }>;
}

export interface HistoryRebuildSealedTreeVerification {
  readonly runs: number;
  readonly historyTreeJobs: number;
  readonly completedTreeJobs: number;
  readonly sourceTargets: number;
  readonly topicTargets: number;
  readonly sealedSourceTargets: number;
  readonly sealedTopicTargets: number;
  readonly coveredLeaves: number;
  readonly evidenceCoveredLeaves: number;
  readonly unfinishedL0Buffers: number;
  readonly foldableParentBuffers: number;
  readonly l1Nodes: number;
  readonly l2Nodes: number;
  readonly l3Nodes: number;
}

export interface HistoryRebuildQueryClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows?: readonly Row[]; readonly rowCount?: number | null }>;
}

export interface HistoryRebuildOperatorConnection {
  readonly client: HistoryRebuildQueryClient;
  close(): Promise<void>;
}

export interface HistoryRebuildPlanningInput {
  readonly client: HistoryRebuildQueryClient;
  readonly manifest: HistoryRebuildManifest;
  readonly manifestSha256: string;
  readonly modelAssisted: boolean;
  readonly operatorConfig: unknown;
  readonly treePolicyBundle?: HistoryRebuildTreePolicyBundle;
  readonly treePolicyBundleSha256?: string;
}

/**
 * Planning dependencies deliberately expose no model or mutation port. A dry-run or verify
 * implementation therefore cannot call a model or write through this operator contract.
 */
export interface HistoryRebuildOperatorDependencies {
  readText(path: string): string;
  parseConfig(text: string): unknown;
  connect(config: unknown): Promise<HistoryRebuildOperatorConnection>;
  assertSchemaVersion(input: HistoryRebuildPlanningInput): Promise<void>;
  plan(input: HistoryRebuildPlanningInput): Promise<HistoryRebuildPlanningResult>;
  planWithModel(input: HistoryRebuildPlanningInput): Promise<HistoryRebuildPlanningResult>;
  verify(input: HistoryRebuildPlanningInput): Promise<HistoryRebuildPlanningResult>;
  apply(input: HistoryRebuildPlanningInput): Promise<Record<string, unknown>>;
  rollback(input: HistoryRebuildPlanningInput): Promise<Record<string, unknown>>;
}

export type HistoryRebuildWriteExecutionPort = (
  input: HistoryRebuildPlanningInput,
) => Promise<Record<string, unknown>>;

export interface CreateHistoryRebuildDependenciesOptions {
  readonly apply?: HistoryRebuildWriteExecutionPort;
  readonly rollback?: HistoryRebuildWriteExecutionPort;
  readonly checkpoint?: Parameters<typeof runHistoryRebuildLlmPlanner>[1]["checkpoint"];
  readonly now?: () => number;
  readonly runId?: () => string;
  readonly repository?: (client: HistoryRebuildQueryClient) => HistoryRebuildRepositoryPort;
  readonly estimateCostMinorUnits?: (
    inputTokens: number,
    outputTokens: number,
    pricing: Readonly<{
      model: string;
      currency: string;
      pricingSnapshotVersion: string;
    }>,
  ) => number;
  readonly llmPlanner?: (
    input: RunHistoryRebuildLlmPlannerInput,
    dependencies: HistoryRebuildLlmPlannerDependencies,
  ) => ReturnType<typeof runHistoryRebuildLlmPlanner>;
  readonly llm?: HistoryRebuildLlmPlannerDependencies["llm"];
}

export interface HistoryRebuildRepositoryPort {
  listScopes(input: ListHistoryRebuildScopesInput): Promise<readonly HistoryRebuildScopeSummary[]>;
  createRun(input: Parameters<PostgresHistoryRebuildRepository["createRun"]>[0]):
    Promise<CreatedHistoryRebuildRun>;
  readModelUsage?(input: Parameters<PostgresHistoryRebuildRepository["readModelUsage"]>[0]):
    ReturnType<PostgresHistoryRebuildRepository["readModelUsage"]>;
  reserveModelAttempt?(input: Parameters<PostgresHistoryRebuildRepository["reserveModelAttempt"]>[0]):
    ReturnType<PostgresHistoryRebuildRepository["reserveModelAttempt"]>;
  completeModelAttempt?(input: Parameters<PostgresHistoryRebuildRepository["completeModelAttempt"]>[0]):
    ReturnType<PostgresHistoryRebuildRepository["completeModelAttempt"]>;
  scanBatch(input: ScanHistoryRebuildBatchInput): Promise<readonly HistoryRebuildScanRow[]>;
  commitBatch(input: HistoryRebuildBatchCommit):
    Promise<Awaited<ReturnType<PostgresHistoryRebuildRepository["commitBatch"]>>>;
  applyRun(input: Parameters<PostgresHistoryRebuildRepository["applyRun"]>[0]):
    Promise<AppliedHistoryRebuildRun>;
  verifyRun(input: Parameters<PostgresHistoryRebuildRepository["verifyRun"]>[0]):
    Promise<VerifiedHistoryRebuildRun>;
  rollbackRun(input: Parameters<PostgresHistoryRebuildRepository["rollbackRun"]>[0]):
    Promise<RolledBackHistoryRebuildRun>;
}

export interface PreparedHistorySnapshot {
  readonly sourceCount: number;
  readonly snapshotSha256: string;
  readonly parserVersions: readonly string[];
}

export interface PreparedHistoryPolicy {
  readonly budget: HistoryRebuildManifest["budget"];
  readonly remoteEgress: HistoryRebuildManifest["security"]["remoteEgress"];
  readonly treePolicyVersion: string;
  readonly topicLabelVersion: string;
  readonly treePolicyBundleSha256: string;
}

export type HistoryRebuildOperatorErrorCode =
  | "HISTORY_REBUILD_INVALID_ARGUMENTS"
  | "HISTORY_REBUILD_INVALID_CONFIG"
  | "HISTORY_REBUILD_INVALID_MANIFEST"
  | "HISTORY_REBUILD_WRITE_GATE_REQUIRED"
  | "HISTORY_REBUILD_MANIFEST_MISMATCH"
  | "HISTORY_REBUILD_SCHEMA_NOT_READY"
  | "HISTORY_REBUILD_EXECUTION_FAILED"
  | "HISTORY_REBUILD_CONNECTION_FAILED"
  | "HISTORY_REBUILD_PLANNING_FAILED"
  | "HISTORY_REBUILD_SOURCE_DRIFT"
  | "HISTORY_REBUILD_BUDGET_EXCEEDED"
  | "HISTORY_REBUILD_MODEL_REQUIRED"
  | "HISTORY_REBUILD_PRICING_UNAVAILABLE"
  | "HISTORY_REBUILD_OPERATOR_LOCKED";

const ERROR_MESSAGES: Record<HistoryRebuildOperatorErrorCode, string> = {
  HISTORY_REBUILD_INVALID_ARGUMENTS: "History rebuild operator arguments are invalid",
  HISTORY_REBUILD_INVALID_CONFIG: "History rebuild operator configuration is invalid",
  HISTORY_REBUILD_INVALID_MANIFEST: "History rebuild operator manifest is invalid",
  HISTORY_REBUILD_WRITE_GATE_REQUIRED: "History rebuild write operation requires explicit maintenance confirmation",
  HISTORY_REBUILD_MANIFEST_MISMATCH: "History rebuild manifest hash does not match the pinned value",
  HISTORY_REBUILD_SCHEMA_NOT_READY: "History rebuild requires the complete PostgreSQL schema v24 contract",
  HISTORY_REBUILD_EXECUTION_FAILED: "History rebuild write execution failed",
  HISTORY_REBUILD_CONNECTION_FAILED: "History rebuild database connection failed",
  HISTORY_REBUILD_PLANNING_FAILED: "History rebuild read-only planning failed",
  HISTORY_REBUILD_SOURCE_DRIFT: "History rebuild source snapshot or funnel counts drifted",
  HISTORY_REBUILD_BUDGET_EXCEEDED: "History rebuild plan exceeds its pinned budget",
  HISTORY_REBUILD_MODEL_REQUIRED: "History rebuild contains unresolved model classifications",
  HISTORY_REBUILD_PRICING_UNAVAILABLE: "History rebuild live model pricing is unavailable",
  HISTORY_REBUILD_OPERATOR_LOCKED: "Another history rebuild operator holds the migration lock",
};

export class HistoryRebuildOperatorError extends Error {
  constructor(readonly code: HistoryRebuildOperatorErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "HistoryRebuildOperatorError";
  }
}

function fail(code: HistoryRebuildOperatorErrorCode): never {
  throw new HistoryRebuildOperatorError(code);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plainRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function safeInteger(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function safeVersion(value: unknown): value is string {
  return typeof value === "string" && SAFE_VERSION.test(value);
}

function safeEndpoint(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "";
  } catch {
    return false;
  }
}

function validSource(value: unknown): value is HistoryRebuildManifest["source"] {
  if (!exactKeys(value, ["snapshotSha256", "sourceCount", "parserVersions"]) ||
      typeof value.snapshotSha256 !== "string" || !SHA256.test(value.snapshotSha256) ||
      !safeInteger(value.sourceCount) || !Array.isArray(value.parserVersions) ||
      value.parserVersions.length === 0 || !value.parserVersions.every(safeVersion)) return false;
  return new Set(value.parserVersions).size === value.parserVersions.length;
}

function validFunnel(value: unknown): value is HistoryRebuildManifest["funnel"] {
  return exactKeys(value, ["mappingVersion", "conflictPolicy", "lifecyclePolicy"]) &&
    value.mappingVersion === "kind-to-semantic-type/v1" &&
    value.conflictPolicy === "lookup_only" && value.lifecyclePolicy === "preserve";
}

function validModels(value: unknown): value is HistoryRebuildManifest["models"] {
  if (!exactKeys(value, ["extraction", "embedding"])) return false;
  const extraction = value.extraction;
  const embedding = value.embedding;
  return exactKeys(extraction, [
    "provider", "baseURL", "model", "promptPolicyVersion", "temperature",
  ]) && extraction.provider === PROVIDER && safeEndpoint(extraction.baseURL) &&
    safeVersion(extraction.model) && safeVersion(extraction.promptPolicyVersion) &&
    extraction.temperature === 0 &&
    exactKeys(embedding, [
      "provider", "baseURL", "model", "dimensions", "normalization",
    ]) && embedding.provider === PROVIDER && safeEndpoint(embedding.baseURL) &&
    safeVersion(embedding.model) && safeInteger(embedding.dimensions, 1) &&
    (embedding.normalization === "l2" || embedding.normalization === "none");
}

function validBudget(value: unknown): value is HistoryRebuildManifest["budget"] {
  return exactKeys(value, [
    "maxRecords", "maxModelCalls", "maxInputTokens", "maxOutputTokens",
    "maxCostMinorUnits", "currency", "pricingSnapshotVersion",
    "inputCostPerMillionTokens", "outputCostPerMillionTokens",
  ]) && safeInteger(value.maxRecords) && safeInteger(value.maxModelCalls) &&
    safeInteger(value.maxInputTokens) && safeInteger(value.maxOutputTokens) &&
    safeInteger(value.maxCostMinorUnits) && typeof value.currency === "string" &&
    /^[A-Z]{3}$/.test(value.currency) && safeVersion(value.pricingSnapshotVersion) &&
    safeInteger(value.inputCostPerMillionTokens) &&
    safeInteger(value.outputCostPerMillionTokens);
}

function validSecurity(value: unknown): value is HistoryRebuildManifest["security"] {
  return exactKeys(value, [
    "remoteEgress", "redactionMapVersion", "logContent", "receiptContent",
  ]) && (value.remoteEgress === "deny" || value.remoteEgress === "redacted-only") &&
    safeVersion(value.redactionMapVersion) && value.logContent === "hash-only" &&
    value.receiptContent === "hash-only";
}

function validTree(value: unknown): value is HistoryRebuildManifest["tree"] {
  if (!plainRecord(value)) return false;
  const record = value as Record<string, unknown>;
  const legacy = exactKeys(value, [
    "policyVersion", "topicLabelVersion", "requireEvidence", "requireSealed", "ambiguousPolicy",
  ]);
  const corrected = exactKeys(value, [
    "policyVersion", "topicLabelVersion", "policyBundleSha256", "requireEvidence",
    "requireSealed", "ambiguousPolicy",
  ]);
  const policyVersion = record.policyVersion;
  const topicLabelVersion = record.topicLabelVersion;
  const bundleSha256 = record.policyBundleSha256;
  return (legacy || corrected) && safeVersion(policyVersion) &&
    safeVersion(topicLabelVersion) &&
    (legacy || (typeof bundleSha256 === "string" && SHA256.test(bundleSha256))) &&
    record.requireEvidence === true && record.requireSealed === true &&
    record.ambiguousPolicy === "quarantine";
}

export function loadHistoryRebuildManifest(text: string): LoadedHistoryRebuildManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  if (!exactKeys(parsed, [
    "version", "migrationId", "requiredSchemaVersion", "source", "funnel",
    "models", "budget", "security", "tree",
  ]) || parsed.version !== 1 || typeof parsed.migrationId !== "string" ||
      !SAFE_ID.test(parsed.migrationId) ||
      (parsed.requiredSchemaVersion !== 23 && parsed.requiredSchemaVersion !== 24) ||
      !validSource(parsed.source) || !validFunnel(parsed.funnel) ||
      !validModels(parsed.models) || !validBudget(parsed.budget) ||
      !validSecurity(parsed.security) || !validTree(parsed.tree)) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  const correctedTree = parsed.tree.policyVersion === HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION &&
    parsed.tree.topicLabelVersion === HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION &&
    typeof parsed.tree.policyBundleSha256 === "string" &&
    SHA256.test(parsed.tree.policyBundleSha256);
  if ((parsed.requiredSchemaVersion === 24) !== correctedTree) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  return Object.freeze({
    manifest: parsed as unknown as HistoryRebuildManifest,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}

export function loadHistoryRebuildTreePolicyBundle(
  text: string,
): LoadedHistoryRebuildTreePolicyBundle {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  if (!exactKeys(parsed, [
    "version", "policyVersion", "topicTaxonomyVersion", "sourceIdentityVersion", "policies",
  ]) || parsed.version !== 1 ||
      parsed.policyVersion !== HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION ||
      parsed.topicTaxonomyVersion !== HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION ||
      parsed.sourceIdentityVersion !== HISTORY_REBUILD_SOURCE_IDENTITY_VERSION ||
      !Array.isArray(parsed.policies)) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  const fingerprints = new Set<string>();
  try {
    for (const policy of parsed.policies) {
      historyRebuildTreeRoutingPolicyHash(policy as HistoryRebuildTreeRoutingPolicy);
      if (!plainRecord(policy) || typeof policy.scopeFingerprint !== "string" ||
          fingerprints.has(policy.scopeFingerprint)) {
        fail("HISTORY_REBUILD_INVALID_MANIFEST");
      }
      fingerprints.add(policy.scopeFingerprint);
    }
  } catch (error) {
    if (error instanceof HistoryRebuildOperatorError) throw error;
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  return Object.freeze({
    bundle: parsed as unknown as HistoryRebuildTreePolicyBundle,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
  });
}

export function buildPreparedHistoryRebuildManifest(input: {
  readonly migrationId: string;
  readonly snapshot: PreparedHistorySnapshot;
  readonly config: MemoryConfig;
  readonly policy: PreparedHistoryPolicy;
}): HistoryRebuildManifest {
  const extractionModel = input.config.llm?.extractionModel ?? input.config.llm?.model;
  const embeddingModel = input.config.embedding.model;
  if (!SAFE_ID.test(input.migrationId) || !validSource(input.snapshot) ||
      !input.config.llm || !extractionModel || !input.config.llm.baseURL ||
      !embeddingModel || !input.config.embedding.baseURL ||
      input.policy.budget.maxRecords < input.snapshot.sourceCount) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  const manifest: HistoryRebuildManifest = {
    version: 1,
    migrationId: input.migrationId,
    requiredSchemaVersion: 24,
    source: Object.freeze({ ...input.snapshot, parserVersions: Object.freeze([...input.snapshot.parserVersions]) }),
    funnel: Object.freeze({
      mappingVersion: "kind-to-semantic-type/v1",
      conflictPolicy: "lookup_only",
      lifecyclePolicy: "preserve",
    }),
    models: Object.freeze({
      extraction: Object.freeze({
        provider: PROVIDER,
        baseURL: input.config.llm.baseURL,
        model: extractionModel,
        promptPolicyVersion: "history-extract-v1",
        temperature: 0,
      }),
      embedding: Object.freeze({
        provider: PROVIDER,
        baseURL: input.config.embedding.baseURL,
        model: embeddingModel,
        dimensions: 1024,
        normalization: "l2",
      }),
    }),
    budget: Object.freeze({ ...input.policy.budget }),
    security: Object.freeze({
      remoteEgress: input.policy.remoteEgress,
      redactionMapVersion: REDACTION_MAP_VERSION,
      logContent: "hash-only",
      receiptContent: "hash-only",
    }),
    tree: Object.freeze({
      policyVersion: input.policy.treePolicyVersion,
      topicLabelVersion: input.policy.topicLabelVersion,
      policyBundleSha256: input.policy.treePolicyBundleSha256,
      requireEvidence: true,
      requireSealed: true,
      ambiguousPolicy: "quarantine",
    }),
  };
  // Route through the same strict validator before exposing prepared output.
  return loadHistoryRebuildManifest(JSON.stringify(manifest)).manifest;
}

type Operation = "dry-run" | "plan" | "apply" | "verify" | "rollback";

interface CliArgs {
  readonly configPath: string;
  readonly manifestPath: string;
  readonly operation: Operation;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly manifestSha256?: string;
  readonly confirmationToken?: string;
  readonly liveModel: boolean;
  readonly treePolicyBundlePath?: string;
}

function cliArgs(argv: readonly string[]): CliArgs {
  const value = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : argv[index + 1];
  };
  const configPath = value("--config");
  const manifestPath = value("--manifest");
  const operations = ["--plan", "--dry-run", "--apply", "--verify", "--rollback"]
    .filter((flag) => argv.includes(flag));
  const knownFlags = new Set([
    "--config", "--manifest", "--plan", "--dry-run", "--apply", "--verify", "--rollback", "--maintenance",
    "--quiescence-confirmed", "--manifest-sha256", "--confirmation-token", "--live-model",
    "--tree-policy-bundle",
  ]);
  const valueFlags = new Set([
    "--config", "--manifest", "--manifest-sha256", "--confirmation-token",
    "--tree-policy-bundle",
  ]);
  let invalid = !configPath || !manifestPath || operations.length > 1;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!knownFlags.has(token)) invalid = true;
    if (valueFlags.has(token)) {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) invalid = true;
      index += 1;
    }
  }
  if (invalid) fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  return {
    configPath: configPath!,
    manifestPath: manifestPath!,
    operation: operations[0] === "--plan" ? "plan"
      : operations[0] === "--dry-run" ? "dry-run"
      : operations[0] === "--apply" ? "apply"
      : operations[0] === "--verify" ? "verify"
      : operations[0] === "--rollback" ? "rollback" : "dry-run",
    maintenance: argv.includes("--maintenance"),
    quiescenceConfirmed: argv.includes("--quiescence-confirmed"),
    manifestSha256: value("--manifest-sha256"),
    confirmationToken: value("--confirmation-token"),
    liveModel: argv.includes("--live-model"),
    treePolicyBundlePath: value("--tree-policy-bundle"),
  };
}

function assertWriteGate(args: CliArgs, loaded: LoadedHistoryRebuildManifest): void {
  if (args.operation !== "apply" && args.operation !== "rollback") return;
  if (!args.maintenance || !args.quiescenceConfirmed || !args.manifestSha256 ||
      !args.confirmationToken) {
    fail("HISTORY_REBUILD_WRITE_GATE_REQUIRED");
  }
  if (!SHA256.test(args.manifestSha256) || args.manifestSha256 !== loaded.sha256) {
    fail("HISTORY_REBUILD_MANIFEST_MISMATCH");
  }
  const token = `${args.operation.toUpperCase()}:${loaded.manifest.migrationId}`;
  if (args.confirmationToken !== token) fail("HISTORY_REBUILD_WRITE_GATE_REQUIRED");
}

function count(value: unknown): number {
  return safeInteger(value) ? value : fail("HISTORY_REBUILD_PLANNING_FAILED");
}

function reportObject(value: unknown): Record<string, unknown> {
  return plainRecord(value) ? value : fail("HISTORY_REBUILD_SOURCE_DRIFT");
}

function validateGlobalParityReport(
  value: unknown,
  manifest: HistoryRebuildManifest,
): HistoryRebuildGlobalParityVerification {
  const report = reportObject(value);
  const runs = reportObject(report.runs);
  const ledger = reportObject(report.ledger);
  const inventory = reportObject(report.inventory);
  const tables = reportObject(inventory.tables);
  const memories = reportObject(tables.memories);
  const knowledge = reportObject(tables.knowledge);
  const scoring = reportObject(report.scoring);
  const scoreReports = ["valueScore", "importance", "confidence"].map((key) =>
    reportObject(scoring[key]));
  const sourceCount = manifest.source.sourceCount;
  const runTotal = count(runs.total);
  const included = count(inventory.included);
  const legacyQuarantine = count(inventory.legacyQuarantine);
  const physical = count(inventory.physical);
  const newQuarantine = count(inventory.newQuarantine);
  const memoryIncluded = count(memories.included);
  const memoryNewQuarantine = count(memories.newQuarantine);
  const knowledgeIncluded = count(knowledge.included);
  const scoredTotal = count(scoring.total);
  if (count(runs.completed) !== runTotal || count(runs.nonCompleted) !== 0 ||
      count(runs.scopes) !== runTotal || count(runs.identityConflicts) !== 0 ||
      count(runs.pinDrift) !== 0 || count(ledger.sourceRows) !== sourceCount ||
      count(ledger.plans) !== sourceCount || count(ledger.settled) !== sourceCount ||
      count(ledger.metadataParity) !== sourceCount ||
      count(ledger.expectedModelReceipts) !== count(ledger.modelReceipts) ||
      count(ledger.batchAppliedRecords) !== sourceCount ||
      count(ledger.runApplyReceipts) !== runTotal ||
      count(ledger.batchApplyReceipts) < runTotal || included !== sourceCount ||
      physical !== included + legacyQuarantine ||
      newQuarantine !== count(memories.newQuarantine) + count(knowledge.newQuarantine) ||
      physical !== count(memories.physical) + count(knowledge.physical) ||
      included !== memoryIncluded + knowledgeIncluded ||
      legacyQuarantine !== count(memories.legacyQuarantine) +
        count(knowledge.legacyQuarantine) ||
      scoredTotal !== memoryIncluded - memoryNewQuarantine) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  for (const score of scoreReports) {
    const real = count(score.real);
    const floor = count(score.legacyFloor);
    if (real + floor !== scoredTotal || typeof score.realRate !== "number" ||
        !Number.isFinite(score.realRate) || typeof score.legacyFloorRate !== "number" ||
        !Number.isFinite(score.legacyFloorRate) || score.realRate < 0 || score.realRate > 1 ||
        score.legacyFloorRate < 0 || score.legacyFloorRate > 1 ||
        Math.abs(score.realRate + score.legacyFloorRate - (scoredTotal === 0 ? 0 : 1)) > 1e-12) {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
  }
  return value as HistoryRebuildGlobalParityVerification;
}

function validatePlan(
  value: HistoryRebuildPlanningResult,
  manifest: HistoryRebuildManifest,
  requireGlobalParity: boolean = false,
): HistoryRebuildPlanningResult {
  const sourceCount = count(value.sourceCount);
  const dispositions = [
    count(value.dispositions?.preserveExplicit), count(value.dispositions?.backfill),
    count(value.dispositions?.lookupOnly), count(value.dispositions?.invalidExplicit),
  ];
  const tree = [count(value.tree?.mapped), count(value.tree?.orphan), count(value.tree?.ambiguous)];
  if (sourceCount !== manifest.source.sourceCount ||
      dispositions.reduce((sum, entry) => sum + entry, 0) !== sourceCount ||
      tree.reduce((sum, entry) => sum + entry, 0) !== sourceCount) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const estimatedModelCalls = count(value.estimatedModelCalls);
  const estimatedInputTokens = count(value.estimatedInputTokens);
  const estimatedOutputTokens = count(value.estimatedOutputTokens);
  const estimatedCostMinorUnits = count(value.estimatedCostMinorUnits);
  if (sourceCount > manifest.budget.maxRecords ||
      estimatedModelCalls > manifest.budget.maxModelCalls ||
      estimatedInputTokens > manifest.budget.maxInputTokens ||
      estimatedOutputTokens > manifest.budget.maxOutputTokens ||
      estimatedCostMinorUnits > manifest.budget.maxCostMinorUnits) {
    fail("HISTORY_REBUILD_BUDGET_EXCEEDED");
  }
  if (requireGlobalParity) validateGlobalParityReport(value.globalParityVerification, manifest);
  return value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function objectField(value: unknown): Record<string, unknown> {
  return plainRecord(value) ? value : {};
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value : undefined;
}

function scanRow(raw: Record<string, unknown>): HistoryRebuildScanRow {
  const metadata = objectField(raw.metadata);
  const scopeMetadata = objectField(metadata.scope);
  const sourceTable = raw.source_table === "knowledge" ? "knowledge" : "memories";
  const { kind, conflict } = historyRebuildSourceKind(sourceTable, raw);
  const workspaceId = stringField(raw.workspace_id) ?? stringField(scopeMetadata.workspaceId);
  const sessionId = stringField(raw.session_id) ?? stringField(scopeMetadata.sessionId);
  let vector: unknown;
  try {
    vector = typeof raw.vector_text === "string" ? JSON.parse(raw.vector_text) : undefined;
  } catch {
    vector = undefined;
  }
  const createdAt = typeof raw.created_at_ms === "string" && /^(0|[1-9][0-9]*)$/.test(raw.created_at_ms)
    ? Number(raw.created_at_ms) : undefined;
  const metadataValueScore = metadata.valueScore;
  const metadataConfidence = metadata.confidence;
  return {
    sourceTable,
    recordId: String(raw.record_id ?? ""),
    sourceHash: String(raw.source_hash ?? ""),
    text: typeof raw.text === "string" ? raw.text : "",
    kind,
    metadata,
    scope: {
      tenantId: stringField(raw.tenant_id) ?? stringField(scopeMetadata.tenantId) ?? "",
      userId: stringField(raw.user_id) ?? stringField(scopeMetadata.userId) ?? "",
      appId: stringField(raw.product_id) ?? stringField(scopeMetadata.appId) ?? "",
      projectId: stringField(raw.canonical_project_id) ?? stringField(scopeMetadata.projectId) ?? "",
      agentId: stringField(raw.producer_id) ?? stringField(scopeMetadata.agentId) ?? "",
      namespace: stringField(raw.namespace) ?? stringField(scopeMetadata.namespace) ?? "",
      visibility: (stringField(raw.visibility) ?? stringField(scopeMetadata.visibility)) as
        HistoryRebuildScanRow["scope"]["visibility"],
      ...(workspaceId ? { workspaceId } : {}),
      ...(sessionId ? { sessionId } : {}),
    },
    ...(stringField(raw.lifecycle_status)
      ? { lifecycleStatus: stringField(raw.lifecycle_status) as HistoryRebuildScanRow["lifecycleStatus"] }
      : {}),
    ...(stringField(raw.content_hash) ? { contentHash: stringField(raw.content_hash) } : {}),
    ...(Array.isArray(vector) && vector.length > 0 && vector.every((item) =>
      typeof item === "number" && Number.isFinite(item)) ? { vector: vector as number[] } : {}),
    ...(typeof raw.importance === "number" && Number.isFinite(raw.importance) &&
      raw.importance >= 0 && raw.importance <= 1 ? { importance: raw.importance } : {}),
    ...(typeof metadataValueScore === "number" && Number.isFinite(metadataValueScore) &&
      metadataValueScore >= 0 && metadataValueScore <= 1 ? { valueScore: metadataValueScore } : {}),
    ...(typeof metadataConfidence === "number" && Number.isFinite(metadataConfidence) &&
      metadataConfidence >= 0 && metadataConfidence <= 1 ? { confidence: metadataConfidence } : {}),
    ...(stringField(raw.category) ? { category: stringField(raw.category) } : {}),
    ...(stringField(raw.data_type) ? { dataType: stringField(raw.data_type) } : {}),
    ...(createdAt !== undefined && Number.isSafeInteger(createdAt) ? { createdAt } : {}),
    ...(raw.embedding_space_id === null || typeof raw.embedding_space_id === "string"
      ? { embeddingSpaceId: raw.embedding_space_id as string | null } : {}),
    ...(raw.embedding_space_state === null || typeof raw.embedding_space_state === "string"
      ? { embeddingSpaceState: raw.embedding_space_state as string | null } : {}),
    canCreateEvidenceMirror: sourceTable === "memories" && Array.isArray(vector) &&
      vector.length > 0 && createdAt !== undefined && stringField(raw.content_hash) !== undefined,
    ...(stringArray(metadata.sourceNodeIds)
      ? { evidenceIds: stringArray(metadata.sourceNodeIds) }
      : stringArray(metadata.evidenceIds) ? { evidenceIds: stringArray(metadata.evidenceIds) } : {}),
    ...(stringArray(metadata.topicLabels) ? { topicLabels: stringArray(metadata.topicLabels) } : {}),
    classificationConflict: conflict || metadata.classificationConflict === true,
    ...(typeof metadata.scopeConflict === "boolean" ? { scopeConflict: metadata.scopeConflict } : {}),
    ...(stringField(metadata.legacyQuarantineReason)
      ? { legacyQuarantineReason: stringField(metadata.legacyQuarantineReason) } : {}),
  };
}

export const HISTORY_SCAN_SQL = `/* history-rebuild:scan */
WITH exact_runs AS (
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2
    AND state IN ('running', 'completed')
), frozen_sources AS (
  SELECT DISTINCT ON (source.source_table, source.record_id)
    source.source_table, source.record_id::text, source.source_hash, source.source_row
  FROM mengshu_history_rebuild_source_rows source
  JOIN exact_runs run USING (run_id)
  ORDER BY source.source_table, source.record_id, source.captured_at DESC, source.run_id DESC
), current_sources AS (
SELECT 'memories'::text AS source_table, id::text AS record_id,
  encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
    tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
    lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash,
  text, content_hash, vector::text AS vector_text,
  importance::double precision AS importance, category, data_type,
  floor(extract(epoch FROM created_at) * 1000)::text AS created_at_ms,
  embedding_space_id, embedding_space_state, metadata, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, COALESCE(workspace_id, '') AS workspace_id,
  COALESCE(metadata->>'sessionId', '') AS session_id, lifecycle_status
FROM memories WHERE legacy_quarantine_reason IS NULL
  AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  AND NOT EXISTS (
    SELECT 1 FROM frozen_sources frozen
    WHERE frozen.source_table = 'memories' AND frozen.record_id = memories.id::text)
UNION ALL
SELECT 'knowledge'::text AS source_table, id::text AS record_id,
  encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
    tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
    visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
    lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash,
  text, content_hash, vector::text AS vector_text,
  importance::double precision AS importance, category, data_type,
  floor(extract(epoch FROM created_at) * 1000)::text AS created_at_ms,
  embedding_space_id, embedding_space_state, metadata, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, COALESCE(workspace_id, '') AS workspace_id,
  COALESCE(metadata->>'sessionId', '') AS session_id, lifecycle_status
FROM knowledge WHERE legacy_quarantine_reason IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM frozen_sources frozen
    WHERE frozen.source_table = 'knowledge' AND frozen.record_id = knowledge.id::text)
)
SELECT * FROM current_sources
UNION ALL
SELECT frozen.source_table, frozen.record_id,
  encode(sha256(convert_to(concat_ws(chr(31), frozen.record_id,
    frozen.source_row->>'contentHash', (frozen.source_row->'metadata')::text,
    frozen.source_row#>>'{scope,tenantId}', frozen.source_row#>>'{scope,userId}',
    frozen.source_row#>>'{scope,projectId}', frozen.source_row#>>'{scope,appId}',
    frozen.source_row#>>'{scope,agentId}', frozen.source_row#>>'{scope,namespace}',
    frozen.source_row#>>'{scope,visibility}',
    COALESCE(frozen.source_row#>>'{scope,workspaceId}', ''),
    COALESCE(frozen.source_row#>>'{metadata,sessionId}', ''),
    frozen.source_row->>'lifecycleStatus', frozen.source_row->>'dataType',
    frozen.source_row->>'category'), 'UTF8')), 'hex') AS source_hash,
  frozen.source_row->>'text' AS text,
  frozen.source_row->>'contentHash' AS content_hash,
  (frozen.source_row->'vector')::text AS vector_text,
  (frozen.source_row->>'importance')::double precision AS importance,
  frozen.source_row->>'category' AS category,
  frozen.source_row->>'dataType' AS data_type,
  frozen.source_row->>'createdAt' AS created_at_ms,
  frozen.source_row->>'embeddingSpaceId' AS embedding_space_id,
  frozen.source_row->>'embeddingSpaceState' AS embedding_space_state,
  frozen.source_row->'metadata' AS metadata,
  frozen.source_row#>>'{scope,tenantId}' AS tenant_id,
  frozen.source_row#>>'{scope,userId}' AS user_id,
  frozen.source_row#>>'{scope,projectId}' AS canonical_project_id,
  frozen.source_row#>>'{scope,appId}' AS product_id,
  frozen.source_row#>>'{scope,agentId}' AS producer_id,
  frozen.source_row#>>'{scope,namespace}' AS namespace,
  frozen.source_row#>>'{scope,visibility}' AS visibility,
  COALESCE(frozen.source_row#>>'{scope,workspaceId}', '') AS workspace_id,
  COALESCE(frozen.source_row#>>'{scope,sessionId}', '') AS session_id,
  frozen.source_row->>'lifecycleStatus' AS lifecycle_status
FROM frozen_sources frozen
ORDER BY source_table, record_id`;

export const HISTORY_TREE_POLICY_SOURCE_AUDIT_SQL = `/* history-rebuild:tree-policy-source-audit */
SELECT memory.id::text AS record_id,
  run.migration_id, run.run_id, run.scope_fingerprint,
  source.source_hash AS legacy_source_hash,
  plan.plan_receipt_hash, plan.disposition AS plan_disposition
FROM memories memory
JOIN mengshu_history_rebuild_runs run
  ON run.run_id = memory.metadata#>>'{historyRebuild,runId}'
 AND run.state = 'completed'
 AND run.tenant_id = memory.tenant_id
 AND run.user_id = memory.user_id
 AND run.app_id = memory.product_id
 AND run.project_id = memory.canonical_project_id
 AND run.agent_id = memory.producer_id
 AND run.namespace = memory.namespace
 AND run.visibility = memory.visibility
 AND run.workspace_id = COALESCE(memory.workspace_id, '')
 AND run.session_id = COALESCE(memory.metadata->>'sessionId', '')
JOIN mengshu_history_rebuild_source_rows source
  ON source.run_id = run.run_id
 AND source.source_table = 'memories'
 AND source.record_id = memory.id
 AND source.source_hash = memory.metadata#>>'{historyRebuild,sourceHash}'
JOIN mengshu_history_rebuild_shadow_plans plan
  ON plan.run_id = source.run_id
 AND plan.source_table = source.source_table
 AND plan.record_id = source.record_id
 AND plan.source_hash = source.source_hash
 AND plan.plan_receipt_hash = memory.metadata#>>'{historyRebuild,planReceiptHash}'
WHERE memory.legacy_quarantine_reason IS NULL
  AND memory.metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  AND memory.metadata#>>'{historyRebuild,disposition}' IS DISTINCT FROM 'lookup_only'
  AND memory.metadata#>>'{historyRebuild,disposition}' IS DISTINCT FROM 'quarantine'
  AND plan.disposition NOT IN ('lookup_only', 'quarantine')
  AND (plan.tree_eligibility->>'source')::boolean
ORDER BY run.scope_fingerprint, run.migration_id, run.run_id, memory.id`;

export const HISTORY_SNAPSHOT_VERIFY_SQL = `/* history-rebuild:verify-snapshot */
WITH exact_runs AS (
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2
    AND state IN ('running', 'completed')
), frozen_sources AS (
  SELECT DISTINCT ON (source.source_table, source.record_id)
    source.source_table, source.record_id::text,
    encode(sha256(convert_to(concat_ws(chr(31), source.record_id::text,
      source.source_row->>'contentHash', (source.source_row->'metadata')::text,
      source.source_row#>>'{scope,tenantId}', source.source_row#>>'{scope,userId}',
      source.source_row#>>'{scope,projectId}', source.source_row#>>'{scope,appId}',
      source.source_row#>>'{scope,agentId}', source.source_row#>>'{scope,namespace}',
      source.source_row#>>'{scope,visibility}',
      COALESCE(source.source_row#>>'{scope,workspaceId}', ''),
      COALESCE(source.source_row#>>'{metadata,sessionId}', ''),
      source.source_row->>'lifecycleStatus', source.source_row->>'dataType',
      source.source_row->>'category'), 'UTF8')), 'hex') AS source_hash
  FROM mengshu_history_rebuild_source_rows source
  JOIN exact_runs run USING (run_id)
  ORDER BY source.source_table, source.record_id, source.captured_at DESC, source.run_id DESC
), current_sources AS (
  SELECT 'memories'::text AS source_table, id::text AS record_id,
    encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
      tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
      visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
      lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash
  FROM memories WHERE legacy_quarantine_reason IS NULL
    AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
    AND NOT EXISTS (
      SELECT 1 FROM frozen_sources frozen
      WHERE frozen.source_table = 'memories' AND frozen.record_id = memories.id::text)
  UNION ALL
  SELECT 'knowledge'::text AS source_table, id::text AS record_id,
    encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
      tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
      visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
      lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash
  FROM knowledge WHERE legacy_quarantine_reason IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM frozen_sources frozen
      WHERE frozen.source_table = 'knowledge' AND frozen.record_id = knowledge.id::text)
), source_rows AS (
  SELECT * FROM current_sources
  UNION ALL
  SELECT source_table, record_id, source_hash FROM frozen_sources
)
SELECT COUNT(*)::text AS source_count,
  encode(sha256(convert_to(COALESCE(string_agg(
    concat_ws(chr(31), source_table, record_id, source_hash), E'\\n'
    ORDER BY source_table, record_id
  ), ''), 'UTF8')), 'hex') AS snapshot_sha256
FROM source_rows`;

async function readFrozenRows(input: HistoryRebuildPlanningInput): Promise<HistoryRebuildScanRow[]> {
  const result = await input.client.query(HISTORY_SCAN_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  const rows = (result.rows ?? []).map((row) => scanRow(row));
  const snapshotSha256 = createHash("sha256").update(rows.map((row) =>
    `${row.sourceTable}\u001f${row.recordId}\u001f${row.sourceHash}`).join("\n"), "utf8").digest("hex");
  if (rows.length !== input.manifest.source.sourceCount ||
      snapshotSha256 !== input.manifest.source.snapshotSha256) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  return rows;
}

async function assertFrozenSnapshot(input: HistoryRebuildPlanningInput): Promise<void> {
  const result = await input.client.query(HISTORY_SNAPSHOT_VERIFY_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1 ||
      String(row?.source_count) !== String(input.manifest.source.sourceCount) ||
      row?.snapshot_sha256 !== input.manifest.source.snapshotSha256) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
}

function planningResult(
  plans: readonly HistoryRebuildPlan[],
  estimates: Pick<HistoryRebuildPlanningResult,
    "estimatedModelCalls" | "estimatedInputTokens" | "estimatedOutputTokens" |
    "estimatedCostMinorUnits">,
): HistoryRebuildPlanningResult {
  const summary = summarizeHistoryRebuildPlans(plans);
  return {
    sourceCount: summary.total,
    dispositions: {
      preserveExplicit: summary.preserve,
      backfill: summary.backfill + summary.modelClassify,
      lookupOnly: summary.lookupOnly,
      invalidExplicit: summary.quarantine,
    },
    tree: {
      mapped: summary.topicTreeEligible,
      orphan: summary.sourceTreeEligible - summary.topicTreeEligible,
      ambiguous: summary.total - summary.sourceTreeEligible,
    },
    ...estimates,
  };
}

const HISTORY_TREE_ROUTING_VERIFY_INPUT_SQL = `/* history-rebuild:verify-tree-routing-input */
WITH exact_runs AS (
  SELECT run_id, scope_fingerprint FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2
)
SELECT run.run_id, run.scope_fingerprint, source.source_table,
  source.record_id::text, source.source_hash, source.source_row,
  jsonb_strip_nulls(jsonb_build_object(
    'sourceTable', plan.source_table,
    'recordId', plan.record_id::text,
    'sourceHash', plan.source_hash,
    'disposition', plan.disposition,
    'semanticType', plan.semantic_type,
    'topicLabels', plan.topic_labels,
    'contextEligible', plan.context_eligible,
    'treeEligibility', plan.tree_eligibility,
    'reason', plan.reason,
    'receiptHash', plan.plan_receipt_hash
  )) AS plan
FROM exact_runs run
JOIN mengshu_history_rebuild_source_rows source USING (run_id)
JOIN mengshu_history_rebuild_shadow_plans plan
  USING (run_id, source_table, record_id, source_hash)
WHERE source.source_table = 'memories' AND plan.disposition <> 'quarantine'
ORDER BY run.run_id, source.record_id`;

interface ExpectedHistoryTreeRouting {
  readonly run_id: string;
  readonly source_table: "memories";
  readonly record_id: string;
  readonly source_hash: string;
  readonly plan_receipt_hash: string;
  readonly policy_version: string;
  readonly policy_hash: string;
  readonly receipt_hash: string;
  readonly topic_labels: readonly string[];
  readonly source_eligible: boolean;
  readonly topic_eligible: boolean;
  readonly source_reason: string;
  readonly topic_reason: string;
}

async function replayExpectedHistoryTreeRouting(
  input: HistoryRebuildPlanningInput,
): Promise<readonly ExpectedHistoryTreeRouting[]> {
  if (!input.treePolicyBundle) fail("HISTORY_REBUILD_INVALID_MANIFEST");
  const policies = new Map<string, HistoryRebuildTreeRoutingPolicy>();
  for (const policy of input.treePolicyBundle.policies) {
    if (policies.has(policy.scopeFingerprint)) fail("HISTORY_REBUILD_INVALID_MANIFEST");
    policies.set(policy.scopeFingerprint, policy);
  }
  const result = await input.client.query(HISTORY_TREE_ROUTING_VERIFY_INPUT_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  if (!Array.isArray(result.rows) ||
      (result.rowCount ?? result.rows.length) !== result.rows.length) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const identities = new Set<string>();
  const expected: ExpectedHistoryTreeRouting[] = [];
  for (const raw of result.rows) {
    if (!plainRecord(raw) || !plainRecord(raw.source_row) || !plainRecord(raw.plan)) {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    const runId = stringField(raw.run_id);
    const scopeFingerprint = stringField(raw.scope_fingerprint);
    const sourceTable = stringField(raw.source_table);
    const recordId = stringField(raw.record_id);
    const sourceHash = stringField(raw.source_hash);
    if (!runId || !SAFE_ID.test(runId) || !scopeFingerprint || !SHA256.test(scopeFingerprint) ||
        sourceTable !== "memories" || !recordId || !SAFE_ID.test(recordId) ||
        !sourceHash || !SHA256.test(sourceHash)) {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    const identity = `${runId}\0${sourceTable}\0${recordId}\0${sourceHash}`;
    if (identities.has(identity)) fail("HISTORY_REBUILD_SOURCE_DRIFT");
    identities.add(identity);
    const source = raw.source_row as unknown as HistoryRebuildScanRow;
    const plan = raw.plan as unknown as HistoryRebuildPlan;
    if (source.sourceTable !== sourceTable || source.recordId !== recordId ||
        source.sourceHash !== sourceHash || plan.sourceTable !== sourceTable ||
        plan.recordId !== recordId || plan.sourceHash !== sourceHash ||
        plan.disposition === "quarantine") {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    const policy = policies.get(scopeFingerprint);
    if (!policy) fail("HISTORY_REBUILD_SOURCE_DRIFT");
    let routing;
    try {
      routing = planHistoryRebuildTreeRouting({ source, plan, policy });
    } catch {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    expected.push(Object.freeze({
      run_id: runId,
      source_table: "memories",
      record_id: recordId,
      source_hash: sourceHash,
      plan_receipt_hash: plan.receiptHash,
      policy_version: routing.policyVersion,
      policy_hash: routing.policyHash,
      receipt_hash: routing.receiptHash,
      topic_labels: Object.freeze([...routing.topic.labels]),
      source_eligible: routing.source.eligible,
      topic_eligible: routing.topic.eligible,
      source_reason: routing.source.reason,
      topic_reason: routing.topic.reason,
    }));
  }
  return Object.freeze(expected);
}

export const HISTORY_GLOBAL_VERIFY_SQL = `/* history-rebuild:verify-global-parity */
WITH exact_runs AS (
  SELECT * FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2
), expected_policy_hashes AS (
  SELECT key AS scope_fingerprint, value AS policy_hash
  FROM jsonb_each_text($7::jsonb)
), expected_tree_routing AS (
  SELECT * FROM jsonb_to_recordset($8::jsonb) AS routing(
    run_id text, source_table text, record_id text, source_hash text,
    plan_receipt_hash text, policy_version text, policy_hash text, receipt_hash text,
    topic_labels jsonb, source_eligible boolean, topic_eligible boolean,
    source_reason text, topic_reason text
  )
), included_scopes AS (
  SELECT DISTINCT tenant_id, user_id, product_id AS app_id,
    canonical_project_id AS project_id, producer_id AS agent_id, namespace, visibility,
    COALESCE(workspace_id, '') AS workspace_id,
    COALESCE(metadata->>'sessionId', '') AS session_id
  FROM memories
  WHERE legacy_quarantine_reason IS NULL
    AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  UNION
  SELECT DISTINCT tenant_id, user_id, product_id AS app_id,
    canonical_project_id AS project_id, producer_id AS agent_id, namespace, visibility,
    COALESCE(workspace_id, '') AS workspace_id,
    COALESCE(metadata->>'sessionId', '') AS session_id
  FROM knowledge WHERE legacy_quarantine_reason IS NULL
), sources AS (
  SELECT source.*, run.scope_fingerprint
  FROM mengshu_history_rebuild_source_rows source
  JOIN exact_runs run USING (run_id)
), plans AS (
  SELECT plan.* FROM mengshu_history_rebuild_shadow_plans plan
  JOIN exact_runs run USING (run_id)
), source_plan_parity AS (
  SELECT source.run_id, source.source_table, source.record_id
  FROM sources source JOIN plans plan
    USING (run_id, source_table, record_id, source_hash)
), expected_model_receipts AS (
  SELECT plan.run_id, plan.source_table, plan.record_id, plan.source_hash
  FROM plans plan JOIN sources source USING (run_id, source_table, record_id, source_hash)
  WHERE plan.reason IN ('model_classification_accepted', 'model_confidence_below_threshold')
    OR (plan.reason IN ('valid_explicit_semantic_type', 'deterministic_kind_mapping')
      AND plan.semantic_type IS NOT NULL AND plan.semantic_type <> 'profile'
      AND plan.context_eligible AND jsonb_array_length(plan.topic_labels) > 0
      AND COALESCE(jsonb_array_length(source.source_row->'topicLabels'), 0) = 0)
), bound_model_receipts AS (
  SELECT receipt.run_id, receipt.source_table, receipt.record_id
  FROM mengshu_history_rebuild_model_receipts receipt
  JOIN exact_runs run USING (run_id)
  JOIN plans plan USING (run_id, source_table, record_id, source_hash)
  WHERE receipt.model_fingerprint = $3 AND receipt.prompt_hash = $4
    AND receipt.schema_hash = $5
), memory_expected AS (
  SELECT source.*, plan.disposition, plan.semantic_type, plan.topic_labels,
    plan.context_eligible, plan.plan_receipt_hash
  FROM sources source JOIN plans plan USING (run_id, source_table, record_id, source_hash)
  WHERE source.source_table = 'memories'
), expected_routing_records AS (
  SELECT run_id, source_table, record_id::text, source_hash, plan_receipt_hash
  FROM memory_expected WHERE disposition <> 'quarantine'
), routing_pair_drift AS (
  SELECT COUNT(*)::bigint AS count FROM expected_routing_records expected
  FULL JOIN expected_tree_routing routing
    USING (run_id, source_table, record_id, source_hash, plan_receipt_hash)
  WHERE expected.record_id IS NULL OR routing.record_id IS NULL
), routing_duplicate_drift AS (
  SELECT COALESCE(SUM(entries - 1), 0)::bigint AS count FROM (
    SELECT COUNT(*)::bigint AS entries FROM expected_tree_routing
    GROUP BY run_id, source_table, record_id, source_hash, plan_receipt_hash
    HAVING COUNT(*) > 1
  ) duplicate
), tree_routing_drift AS (
  SELECT CASE WHEN $6::text IS NULL
    THEN (SELECT count FROM routing_pair_drift) + (SELECT count FROM routing_duplicate_drift)
    ELSE (SELECT COUNT(*) FROM expected_tree_routing)
  END::bigint AS count
), memory_materialized AS (
  SELECT expected.record_id FROM memory_expected expected
  JOIN memories memory ON memory.id = expected.record_id
  LEFT JOIN expected_tree_routing routing
    ON routing.run_id = expected.run_id
      AND routing.source_table = expected.source_table
      AND routing.record_id = expected.record_id::text
      AND routing.source_hash = expected.source_hash
      AND routing.plan_receipt_hash = expected.plan_receipt_hash
  WHERE expected.disposition <> 'quarantine'
    AND memory.text = expected.source_row->>'text'
    AND memory.content_hash = expected.source_row->>'contentHash'
    AND memory.importance IS NOT DISTINCT FROM
      (expected.source_row->>'importance')::double precision
    AND memory.metadata#>>'{historyRebuild,runId}' = expected.run_id
    AND memory.metadata#>>'{historyRebuild,sourceHash}' = expected.source_hash
    AND memory.metadata#>>'{historyRebuild,disposition}' = expected.disposition
    AND memory.metadata#>>'{historyRebuild,planReceiptHash}' = expected.plan_receipt_hash
    AND memory.metadata#>>'{historyRebuild,valueScoreBasis}' = CASE
      WHEN expected.source_row ? 'valueScore' THEN 'historical-metadata'
      ELSE 'legacy-active-floor-v1' END
    AND memory.metadata#>>'{historyRebuild,confidenceBasis}' = CASE
      WHEN expected.source_row ? 'confidence' THEN 'historical-metadata'
      ELSE 'legacy-governance-floor-v1' END
    AND (memory.metadata->>'valueScore')::double precision =
      COALESCE((expected.source_row->>'valueScore')::double precision, 0.70)
    AND (memory.metadata->>'importance')::double precision =
      COALESCE((expected.source_row->>'importance')::double precision, 0.70)
    AND (memory.metadata->>'confidence')::double precision =
      COALESCE((expected.source_row->>'confidence')::double precision, 0.85)
    AND (($6::text IS NOT NULL AND memory.metadata->'topicLabels' = expected.topic_labels)
      OR ($6::text IS NULL AND routing.record_id IS NOT NULL
        AND routing.policy_version = 'history-tree-routing/v2'
        AND routing.policy_hash = (
          SELECT policy_hash FROM expected_policy_hashes policy
          WHERE policy.scope_fingerprint = expected.scope_fingerprint)
        AND memory.metadata->'topicLabels' = routing.topic_labels
        AND memory.metadata#>>'{historyRebuild,treeRouting,policyVersion}' =
          routing.policy_version
        AND memory.metadata#>>'{historyRebuild,treeRouting,policyHash}' = routing.policy_hash
        AND memory.metadata#>>'{historyRebuild,treeRouting,receiptHash}' = routing.receipt_hash
        AND memory.metadata#>>'{historyRebuild,treeRouting,sourceReason}' = routing.source_reason
        AND memory.metadata#>>'{historyRebuild,treeRouting,topicReason}' = routing.topic_reason
        AND routing.source_eligible =
          (routing.source_reason IN ('audited_session_identity', 'audited_source_identity'))
        AND routing.topic_eligible = (routing.topic_reason = 'canonical_topics_selected')
        AND COALESCE(
          memory.metadata#>'{governance,candidate,treeRouting,topicHotnessEligible}',
          'false'::jsonb
        ) = to_jsonb(routing.topic_eligible)))
    AND memory.metadata->>'semanticType' IS NOT DISTINCT FROM expected.semantic_type
    AND memory.lifecycle_status IS NOT DISTINCT FROM CASE
      WHEN expected.disposition = 'lookup_only' THEN 'archived'
      ELSE COALESCE(expected.source_row->>'lifecycleStatus', 'active') END
), memory_quarantine_parity AS (
  SELECT expected.record_id FROM memory_expected expected
  JOIN memories memory ON memory.id = expected.record_id
  WHERE expected.disposition = 'quarantine'
    AND memory.text = expected.original_text
    AND memory.metadata = expected.original_metadata
    AND memory.lifecycle_status IS NOT DISTINCT FROM expected.original_lifecycle_status
), knowledge_parity AS (
  SELECT source.record_id FROM sources source
  JOIN knowledge record ON record.id = source.record_id
  WHERE source.source_table = 'knowledge' AND record.text = source.original_text
    AND record.metadata = source.original_metadata
    AND record.lifecycle_status IS NOT DISTINCT FROM source.original_lifecycle_status
), operation_receipts AS (
  SELECT receipt.* FROM mengshu_history_rebuild_operation_receipts receipt
  JOIN exact_runs run USING (run_id)
), classified_operation_receipts AS (
  SELECT receipt.*,
    operation = 'apply' AND status = 'applied'
      AND source_table IN ('memories', 'knowledge') AND drift_hash IS NULL
      AND receipt_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$'
      AND (SELECT COUNT(*) FROM jsonb_object_keys(counts)) = 6
      AND counts ?& ARRAY['total', 'preserve', 'backfill', 'modelClassify',
        'lookupOnly', 'quarantine']
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(counts) entry
        WHERE jsonb_typeof(entry.value) <> 'number' OR NOT CASE
          WHEN entry.value#>>'{}' ~ '^(0|[1-9][0-9]{0,15})$'
          THEN (entry.value#>>'{}')::numeric <= 9007199254740991 ELSE false END)
      AND result_hash = encode(sha256(
        convert_to('mengshu.history-rebuild-operation/v1', 'UTF8') || decode('00', 'hex') ||
        convert_to(
        '{"counts":{"backfill":' || (counts->>'backfill') ||
        ',"lookupOnly":' || (counts->>'lookupOnly') ||
        ',"modelClassify":' || (counts->>'modelClassify') ||
        ',"preserve":' || (counts->>'preserve') ||
        ',"quarantine":' || (counts->>'quarantine') ||
        ',"total":' || (counts->>'total') ||
        '},"operation":"apply","runId":' || to_json(run_id)::text ||
        ',"sourceTable":' || to_json(source_table)::text ||
        ',"status":"applied"}', 'UTF8')), 'hex') AS is_batch_apply,
    operation = 'apply' AND status = 'applied'
      AND source_table = 'memories' AND drift_hash IS NULL
      AND receipt_hash ~ '^[0-9a-f]{64}$' AND result_hash ~ '^[0-9a-f]{64}$'
      AND (SELECT COUNT(*) FROM jsonb_object_keys(counts)) = 6
      AND counts ?& ARRAY['active', 'lookupOnly', 'classifiedInactive',
        'evidenceMirrors', 'evidenceLinks', 'treeJobs']
      AND NOT EXISTS (SELECT 1 FROM jsonb_each(counts) entry
        WHERE jsonb_typeof(entry.value) <> 'number' OR NOT CASE
          WHEN entry.value#>>'{}' ~ '^(0|[1-9][0-9]{0,15})$'
          THEN (entry.value#>>'{}')::numeric <= 9007199254740991 ELSE false END)
      AS is_run_apply
  FROM operation_receipts receipt
), expected_batch_groups AS (
  SELECT snapshot.run_id, snapshot.source_table, snapshot.source_count,
    checkpoint.checkpoint_version,
    COUNT(plan.record_id) FILTER (WHERE plan.disposition = 'preserve')::bigint AS preserve,
    COUNT(plan.record_id) FILTER (WHERE plan.disposition = 'backfill')::bigint AS backfill,
    COUNT(plan.record_id) FILTER (WHERE plan.disposition = 'model_classify')::bigint
      AS model_classify,
    COUNT(plan.record_id) FILTER (WHERE plan.disposition = 'lookup_only')::bigint AS lookup_only,
    COUNT(plan.record_id) FILTER (WHERE plan.disposition = 'quarantine')::bigint AS quarantine
  FROM mengshu_history_rebuild_source_snapshots snapshot
  JOIN exact_runs run USING (run_id)
  JOIN mengshu_history_rebuild_checkpoints checkpoint USING (run_id, source_table)
  LEFT JOIN plans plan USING (run_id, source_table)
  GROUP BY snapshot.run_id, snapshot.source_table, snapshot.source_count,
    checkpoint.checkpoint_version
), actual_batch_groups AS (
  SELECT run_id, source_table, COUNT(*)::bigint AS receipts,
    COUNT(*) FILTER (WHERE (counts->>'total')::bigint = 0)::bigint AS zero_receipts,
    SUM((counts->>'total')::bigint)::bigint AS total,
    SUM((counts->>'preserve')::bigint)::bigint AS preserve,
    SUM((counts->>'backfill')::bigint)::bigint AS backfill,
    SUM((counts->>'modelClassify')::bigint)::bigint AS model_classify,
    SUM((counts->>'lookupOnly')::bigint)::bigint AS lookup_only,
    SUM((counts->>'quarantine')::bigint)::bigint AS quarantine
  FROM classified_operation_receipts WHERE is_batch_apply
  GROUP BY run_id, source_table
), batch_group_drift AS (
  SELECT COUNT(*)::bigint AS count FROM expected_batch_groups expected
  LEFT JOIN actual_batch_groups actual USING (run_id, source_table)
  WHERE actual.run_id IS NULL OR actual.receipts <> expected.checkpoint_version
    OR actual.total <> expected.source_count OR actual.preserve <> expected.preserve
    OR actual.backfill <> expected.backfill OR actual.model_classify <> expected.model_classify
    OR actual.lookup_only <> expected.lookup_only OR actual.quarantine <> expected.quarantine
    OR (expected.source_count = 0 AND (actual.receipts <> 1 OR actual.zero_receipts <> 1))
    OR (expected.source_count > 0 AND (actual.receipts < 1 OR actual.zero_receipts <> 0))
), run_receipt_expected AS (
  SELECT run.run_id, run.scope_fingerprint,
    COUNT(expected.record_id) FILTER (WHERE expected.disposition <> 'quarantine')::bigint
      AS updated_count,
    COUNT(expected.record_id) FILTER (WHERE expected.disposition <> 'quarantine'
      AND expected.context_eligible AND memory.lifecycle_status = 'active')::bigint AS active,
    COUNT(expected.record_id) FILTER (WHERE expected.disposition = 'lookup_only')::bigint
      AS lookup_only,
    COUNT(expected.record_id) FILTER (WHERE expected.disposition <> 'quarantine'
      AND expected.disposition <> 'lookup_only'
      AND NOT (expected.context_eligible AND memory.lifecycle_status = 'active'))::bigint
      AS classified_inactive,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_artifacts artifact
      WHERE artifact.run_id = run.run_id AND artifact.artifact_type = 'evidence_memory')::bigint
      AS evidence_mirrors,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_artifacts artifact
      WHERE artifact.run_id = run.run_id AND artifact.artifact_type = 'evidence_link')::bigint
      AS evidence_links,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_artifacts artifact
      WHERE artifact.run_id = run.run_id AND artifact.artifact_type = 'tree_job')::bigint
      AS tree_jobs,
    (SELECT COUNT(*) FROM mengshu_history_rebuild_artifacts artifact
      WHERE artifact.run_id = run.run_id)::bigint AS artifact_count
  FROM exact_runs run
  LEFT JOIN memory_expected expected ON expected.run_id = run.run_id
  LEFT JOIN memories memory ON memory.id = expected.record_id
  GROUP BY run.run_id, run.scope_fingerprint
), actual_run_receipts AS (
  SELECT run_id, COUNT(*)::bigint AS receipts,
    SUM((counts->>'active')::bigint)::bigint AS active,
    SUM((counts->>'lookupOnly')::bigint)::bigint AS lookup_only,
    SUM((counts->>'classifiedInactive')::bigint)::bigint AS classified_inactive,
    SUM((counts->>'evidenceMirrors')::bigint)::bigint AS evidence_mirrors,
    SUM((counts->>'evidenceLinks')::bigint)::bigint AS evidence_links,
    SUM((counts->>'treeJobs')::bigint)::bigint AS tree_jobs,
    MIN(receipt_hash) AS receipt_hash, MIN(result_hash) AS result_hash
  FROM classified_operation_receipts WHERE is_run_apply GROUP BY run_id
), run_group_drift AS (
  SELECT COUNT(*)::bigint AS count FROM run_receipt_expected expected
  LEFT JOIN actual_run_receipts actual USING (run_id)
  WHERE actual.run_id IS NULL OR actual.receipts <> 1 OR actual.active <> expected.active
    OR actual.lookup_only <> expected.lookup_only
    OR actual.classified_inactive <> expected.classified_inactive
    OR actual.evidence_mirrors <> expected.evidence_mirrors
    OR actual.evidence_links <> expected.evidence_links OR actual.tree_jobs <> expected.tree_jobs
    OR actual.receipt_hash <> encode(sha256(convert_to(concat_ws(chr(31),
      'history-apply/v2', expected.run_id, expected.scope_fingerprint), 'UTF8')), 'hex')
    OR actual.result_hash <> encode(sha256(convert_to(concat_ws(chr(31), expected.run_id,
      expected.updated_count::text, expected.artifact_count::text), 'UTF8')), 'hex')
), operation_receipt_stats AS (
  SELECT COALESCE(SUM((counts->>'total')::bigint) FILTER (WHERE is_batch_apply), 0)::bigint
      AS batch_records,
    COUNT(*) FILTER (WHERE is_batch_apply)::bigint AS batch_receipts,
    COUNT(*) FILTER (WHERE is_run_apply)::bigint AS run_receipts,
    (COUNT(*) FILTER (WHERE NOT is_batch_apply AND NOT is_run_apply) +
      (SELECT count FROM batch_group_drift) + (SELECT count FROM run_group_drift))::bigint AS drift
  FROM classified_operation_receipts
), expected_batch_receipts AS (
  SELECT COALESCE(SUM(checkpoint.checkpoint_version), 0)::bigint AS count
  FROM mengshu_history_rebuild_checkpoints checkpoint JOIN exact_runs run USING (run_id)
), inventory AS (
  SELECT
    (SELECT COUNT(*) FROM memories
      WHERE metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror')::bigint
      AS physical_memory_count,
    (SELECT COUNT(*) FROM memories WHERE legacy_quarantine_reason IS NULL
      AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror')::bigint
      AS included_memory_count,
    (SELECT COUNT(*) FROM memories WHERE legacy_quarantine_reason IS NOT NULL)::bigint
      AS legacy_quarantine_memory_count,
    (SELECT COUNT(*) FROM knowledge)::bigint AS physical_knowledge_count,
    (SELECT COUNT(*) FROM knowledge WHERE legacy_quarantine_reason IS NULL)::bigint
      AS included_knowledge_count,
    (SELECT COUNT(*) FROM knowledge WHERE legacy_quarantine_reason IS NOT NULL)::bigint
      AS legacy_quarantine_knowledge_count
), score_stats AS (
  SELECT COUNT(*)::bigint AS scored_memory_count,
    COUNT(*) FILTER (WHERE source.source_row ? 'valueScore')::bigint AS real_value_score_count,
    COUNT(*) FILTER (WHERE NOT (source.source_row ? 'valueScore'))::bigint AS floor_value_score_count,
    COUNT(*) FILTER (WHERE source.source_row ? 'importance')::bigint AS real_importance_count,
    COUNT(*) FILTER (WHERE NOT (source.source_row ? 'importance'))::bigint AS floor_importance_count,
    COUNT(*) FILTER (WHERE source.source_row ? 'confidence')::bigint AS real_confidence_count,
    COUNT(*) FILTER (WHERE NOT (source.source_row ? 'confidence'))::bigint AS floor_confidence_count
  FROM sources source JOIN plans plan USING (run_id, source_table, record_id, source_hash)
  WHERE source.source_table = 'memories' AND plan.disposition <> 'quarantine'
)
SELECT
  (SELECT COUNT(*)::text FROM exact_runs) AS run_count,
  (SELECT COUNT(*) FILTER (WHERE state = 'completed')::text FROM exact_runs)
    AS completed_run_count,
  (SELECT COUNT(*) FILTER (WHERE state <> 'completed')::text FROM exact_runs)
    AS non_completed_run_count,
  (SELECT COUNT(DISTINCT scope_fingerprint)::text FROM exact_runs) AS run_scope_count,
  (SELECT COUNT(*)::text FROM included_scopes) AS included_scope_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_runs
    WHERE migration_id = $1 AND manifest_hash <> $2) AS identity_conflict_count,
  (SELECT (COUNT(*) FILTER (WHERE run.model_fingerprint <> $3 OR run.prompt_hash <> $4
      OR run.schema_hash <> $5
      OR ($6::text IS NOT NULL AND run.policy_hash <> $6::text)
      OR ($6::text IS NULL AND (expected.scope_fingerprint IS NULL
        OR run.policy_hash <> expected.policy_hash))) +
    CASE WHEN $6::text IS NULL THEN (
      SELECT COUNT(*) FROM expected_policy_hashes expected_only
      WHERE NOT EXISTS (
        SELECT 1 FROM exact_runs scoped_run
        WHERE scoped_run.scope_fingerprint = expected_only.scope_fingerprint
      )
    ) ELSE 0 END)::text
    FROM exact_runs run
    LEFT JOIN expected_policy_hashes expected USING (scope_fingerprint)) AS pin_drift_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_source_snapshots snapshot
    JOIN exact_runs run USING (run_id)) AS snapshot_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_checkpoints checkpoint
    JOIN exact_runs run USING (run_id)) AS checkpoint_count,
  (SELECT COUNT(*) FILTER (WHERE checkpoint.state = 'completed')::text
    FROM mengshu_history_rebuild_checkpoints checkpoint JOIN exact_runs run USING (run_id))
    AS completed_checkpoint_count,
  (SELECT COALESCE(SUM(snapshot.source_count), 0)::text
    FROM mengshu_history_rebuild_source_snapshots snapshot JOIN exact_runs run USING (run_id))
    AS snapshot_source_count,
  (SELECT COUNT(*)::text FROM sources) AS source_count,
  (SELECT COUNT(*)::text FROM (SELECT DISTINCT source_table, record_id FROM sources) item)
    AS distinct_source_count,
  (SELECT COUNT(*)::text FROM plans) AS plan_count,
  (SELECT COUNT(*)::text FROM (SELECT DISTINCT source_table, record_id FROM plans) item)
    AS distinct_plan_count,
  (SELECT COUNT(*)::text FROM source_plan_parity) AS source_plan_parity_count,
  (SELECT COUNT(*)::text FROM exact_runs run JOIN included_scopes scope
    ON scope.tenant_id = run.tenant_id AND scope.user_id = run.user_id
      AND scope.app_id = run.app_id AND scope.project_id = run.project_id
      AND scope.agent_id = run.agent_id AND scope.namespace = run.namespace
      AND scope.visibility = run.visibility AND scope.workspace_id = run.workspace_id
      AND scope.session_id = run.session_id) AS scope_parity_count,
  ((SELECT COUNT(*) FROM memory_materialized) +
    (SELECT COUNT(*) FROM memory_quarantine_parity) +
    (SELECT COUNT(*) FROM knowledge_parity))::text AS settled_count,
  ((SELECT COUNT(*) FROM memory_materialized) +
    (SELECT COUNT(*) FROM memory_quarantine_parity) +
    (SELECT COUNT(*) FROM knowledge_parity))::text AS metadata_parity_count,
  (SELECT COUNT(*)::text FROM expected_model_receipts) AS expected_model_receipt_count,
  (SELECT COUNT(*)::text FROM mengshu_history_rebuild_model_receipts receipt
    JOIN exact_runs run USING (run_id)) AS model_receipt_count,
  (SELECT COUNT(*)::text FROM bound_model_receipts) AS model_receipt_parity_count,
  (SELECT batch_records::text FROM operation_receipt_stats) AS batch_applied_record_count,
  (SELECT batch_receipts::text FROM operation_receipt_stats) AS batch_apply_receipt_count,
  (SELECT count::text FROM expected_batch_receipts) AS expected_batch_apply_receipt_count,
  (SELECT run_receipts::text FROM operation_receipt_stats) AS run_apply_receipt_count,
  (SELECT drift::text FROM operation_receipt_stats) AS operation_receipt_drift_count,
  (SELECT count::text FROM tree_routing_drift) AS tree_routing_drift_count,
  inventory.physical_memory_count::text, inventory.included_memory_count::text,
  inventory.legacy_quarantine_memory_count::text,
  (SELECT COUNT(*) FILTER (WHERE source_table = 'memories' AND disposition = 'quarantine')::text
    FROM plans) AS new_quarantine_memory_count,
  inventory.physical_knowledge_count::text, inventory.included_knowledge_count::text,
  inventory.legacy_quarantine_knowledge_count::text,
  (SELECT COUNT(*) FILTER (WHERE source_table = 'knowledge' AND disposition = 'quarantine')::text
    FROM plans) AS new_quarantine_knowledge_count,
  (SELECT COUNT(*) FILTER (WHERE source_table = 'memories')::text FROM sources)
    AS memory_source_count,
  (SELECT COUNT(*) FILTER (WHERE source_table = 'knowledge')::text FROM sources)
    AS knowledge_source_count,
  score_stats.scored_memory_count::text, score_stats.real_value_score_count::text,
  score_stats.floor_value_score_count::text, score_stats.real_importance_count::text,
  score_stats.floor_importance_count::text, score_stats.real_confidence_count::text,
  score_stats.floor_confidence_count::text
FROM inventory CROSS JOIN score_stats`;

export const SEALED_TREE_VERIFY_SQL = `/* history-rebuild:verify-sealed-trees */
WITH RECURSIVE exact_runs AS (
  SELECT run_id, scope_fingerprint
  FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
), tree_artifacts AS (
  SELECT artifact.*, run.scope_fingerprint, job.status AS job_status,
    job.payload->>'treeType' AS tree_type,
    job.payload->>'treeKey' AS tree_key
  FROM mengshu_history_rebuild_artifacts artifact
  JOIN exact_runs run USING (run_id)
  JOIN mengshu_jobs_v2 job ON job.id = artifact.artifact_id
  WHERE artifact.artifact_type = 'tree_job'
), targets AS (
  SELECT artifact.run_id, artifact.scope_fingerprint, artifact.source_table,
    artifact.record_id, artifact.source_hash, artifact.artifact_id AS leaf_job_id,
    artifact.tree_type, artifact.tree_key
  FROM tree_artifacts artifact
  WHERE artifact.artifact_role IN ('source_leaf', 'topic_leaf')
), evidence AS (
  SELECT artifact.run_id, artifact.source_table, artifact.record_id,
    MAX(artifact.artifact_id) FILTER (
      WHERE artifact.artifact_type = 'evidence_memory'
        AND artifact.artifact_role = 'evidence_mirror'
        AND EXISTS (
          SELECT 1 FROM memories evidence_memory
          WHERE evidence_memory.id::text = artifact.artifact_id
            AND evidence_memory.metadata#>>'{historyRebuild,runId}' = artifact.run_id
            AND evidence_memory.metadata#>>'{historyRebuild,role}' = 'evidence_mirror'
        )) AS evidence_id,
    COUNT(*) FILTER (
      WHERE artifact.artifact_type = 'evidence_link'
        AND artifact.artifact_role = 'grounded_by'
        AND EXISTS (
          SELECT 1 FROM mengshu_memory_evidence_links link
          WHERE link.link_id = artifact.artifact_id
            AND link.target_memory_id = artifact.record_id::text
            AND link.source = 'history_rebuild:' || artifact.run_id
        ))::bigint AS link_count
  FROM mengshu_history_rebuild_artifacts artifact
  JOIN exact_runs run USING (run_id)
  GROUP BY artifact.run_id, artifact.source_table, artifact.record_id
), covered_targets AS (
  SELECT target.*,
    leaf.id IS NOT NULL AS leaf_covered,
    evidence.evidence_id IS NOT NULL AND evidence.link_count = 1
      AND leaf.chunk_id = evidence.evidence_id AS evidence_covered,
    EXISTS (
      SELECT 1 FROM mengshu_tree_summary_nodes node
      WHERE node.scope_fingerprint = target.scope_fingerprint
        AND node.tree_type = target.tree_type AND node.tree_key = target.tree_key
        AND node.level = 1 AND node.status = 'sealed' AND node.sealed_at IS NOT NULL
        AND node.leaf_ids ? target.record_id::text
    ) AS sealed_target
  FROM targets target
  LEFT JOIN evidence USING (run_id, source_table, record_id)
  LEFT JOIN mengshu_tree_leaves leaf
    ON leaf.scope_fingerprint = target.scope_fingerprint
    AND leaf.id = target.record_id::text
), unfinished_l0 AS (
  SELECT COUNT(*)::bigint AS count
  FROM (SELECT DISTINCT scope_fingerprint, tree_type, tree_key FROM targets) target
  JOIN mengshu_tree_buffers buffer
    ON buffer.scope_fingerprint = target.scope_fingerprint
    AND buffer.tree_type = target.tree_type AND buffer.tree_key = target.tree_key
    AND buffer.level = 0
), foldable_parents AS (
  SELECT COUNT(*)::bigint AS count
  FROM (
    SELECT DISTINCT buffer.scope_fingerprint, buffer.id
    FROM mengshu_tree_buffers buffer
    JOIN targets target
      ON target.scope_fingerprint = buffer.scope_fingerprint
      AND target.tree_type = buffer.tree_type AND target.tree_key = buffer.tree_key
    WHERE buffer.level IN (2, 3)
      AND (jsonb_array_length(buffer.child_node_ids) >= 20 OR buffer.token_count >= 6000)
  ) pending
), history_nodes AS (
  SELECT DISTINCT node.scope_fingerprint, node.id, node.level
  FROM mengshu_tree_summary_nodes node
  JOIN targets target
    ON target.scope_fingerprint = node.scope_fingerprint
    AND target.tree_type = node.tree_type AND target.tree_key = node.tree_key
  WHERE node.level = 1 AND node.status = 'sealed' AND node.sealed_at IS NOT NULL
    AND node.leaf_ids ? target.record_id::text
  UNION
  SELECT DISTINCT parent.scope_fingerprint, parent.id, parent.level
  FROM mengshu_tree_summary_nodes parent
  JOIN history_nodes child
    ON child.scope_fingerprint = parent.scope_fingerprint
    AND parent.level = child.level + 1
    AND parent.child_node_ids ? child.id
  WHERE parent.status = 'sealed' AND parent.sealed_at IS NOT NULL
    AND parent.level BETWEEN 2 AND 3
)
SELECT
  (SELECT COUNT(*)::text FROM exact_runs) AS run_count,
  (SELECT COUNT(*)::text FROM tree_artifacts) AS history_tree_job_count,
  (SELECT COUNT(*) FILTER (WHERE job_status = 'completed')::text FROM tree_artifacts)
    AS completed_tree_job_count,
  (SELECT COUNT(*) FILTER (WHERE job_status = 'dead_letter')::text FROM tree_artifacts)
    AS dead_letter_tree_job_count,
  (SELECT COUNT(*) FILTER (WHERE artifact_role IN ('source_finalize', 'topic_finalize'))::text
    FROM tree_artifacts) AS finalize_job_count,
  (SELECT COUNT(*)::text FROM (
    SELECT DISTINCT scope_fingerprint, tree_type, tree_key FROM targets
  ) distinct_targets) AS distinct_target_count,
  (SELECT COUNT(*) FILTER (WHERE tree_type = 'source')::text FROM targets)
    AS source_target_count,
  (SELECT COUNT(*) FILTER (WHERE tree_type = 'topic')::text FROM targets)
    AS topic_target_count,
  (SELECT COUNT(*) FILTER (WHERE tree_type = 'source' AND sealed_target)::text
    FROM covered_targets) AS sealed_source_target_count,
  (SELECT COUNT(*) FILTER (WHERE tree_type = 'topic' AND sealed_target)::text
    FROM covered_targets) AS sealed_topic_target_count,
  (SELECT COUNT(*) FILTER (WHERE leaf_covered)::text FROM covered_targets)
    AS covered_leaf_count,
  (SELECT COUNT(*) FILTER (WHERE evidence_covered)::text FROM covered_targets)
    AS evidence_covered_leaf_count,
  (SELECT count::text FROM unfinished_l0) AS unfinished_l0_buffer_count,
  (SELECT count::text FROM foldable_parents) AS foldable_parent_buffer_count,
  (SELECT COUNT(*) FILTER (WHERE level = 1)::text FROM history_nodes) AS l1_node_count,
  (SELECT COUNT(*) FILTER (WHERE level = 2)::text FROM history_nodes) AS l2_node_count,
  (SELECT COUNT(*) FILTER (WHERE level = 3)::text FROM history_nodes) AS l3_node_count`;

function postgresCount(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const parsed = Number(value);
  return safeInteger(parsed) ? parsed : fail("HISTORY_REBUILD_SOURCE_DRIFT");
}

function scoreBasisReport(real: number, legacyFloor: number): HistoryRebuildScoreBasisReport {
  const total = real + legacyFloor;
  return Object.freeze({
    real,
    legacyFloor,
    realRate: total === 0 ? 0 : real / total,
    legacyFloorRate: total === 0 ? 0 : legacyFloor / total,
  });
}

async function verifyGlobalHistoryRebuildParity(
  input: HistoryRebuildPlanningInput,
): Promise<HistoryRebuildGlobalParityVerification> {
  const pins = deriveHistoryRebuildLlmPins(input.manifest);
  let legacyPolicyHash: string | null = null;
  const scopedPolicyHashes: Record<string, string> = {};
  let expectedTreeRouting: readonly ExpectedHistoryTreeRouting[] = Object.freeze([]);
  if (input.manifest.requiredSchemaVersion === 24) {
    if (!input.treePolicyBundle ||
        input.treePolicyBundleSha256 !== input.manifest.tree.policyBundleSha256 ||
        input.treePolicyBundle.policyVersion !== HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION ||
        input.treePolicyBundle.topicTaxonomyVersion !== HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION ||
        input.treePolicyBundle.sourceIdentityVersion !== HISTORY_REBUILD_SOURCE_IDENTITY_VERSION) {
      fail("HISTORY_REBUILD_INVALID_MANIFEST");
    }
    for (const policy of input.treePolicyBundle.policies) {
      if (Object.hasOwn(scopedPolicyHashes, policy.scopeFingerprint)) {
        fail("HISTORY_REBUILD_INVALID_MANIFEST");
      }
      scopedPolicyHashes[policy.scopeFingerprint] = historyRebuildTreeRoutingPolicyHash(policy);
    }
    expectedTreeRouting = await replayExpectedHistoryTreeRouting(input);
  } else {
    legacyPolicyHash = taggedHash("mengshu.history-rebuild-policy/v1", {
      funnel: input.manifest.funnel,
      security: input.manifest.security,
      tree: input.manifest.tree,
    });
  }
  const result = await input.client.query(HISTORY_GLOBAL_VERIFY_SQL, [
    input.manifest.migrationId, input.manifestSha256,
    pins.modelFingerprint, pins.promptHash, pins.schemaHash, legacyPolicyHash,
    JSON.stringify(scopedPolicyHashes), JSON.stringify(expectedTreeRouting),
  ]);
  const row = result.rows?.[0];
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1 || !plainRecord(row)) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const fields = [
    "run_count", "completed_run_count", "non_completed_run_count", "run_scope_count",
    "included_scope_count", "identity_conflict_count", "pin_drift_count", "snapshot_count",
    "checkpoint_count", "completed_checkpoint_count", "snapshot_source_count", "source_count",
    "distinct_source_count", "plan_count", "distinct_plan_count", "source_plan_parity_count",
    "scope_parity_count", "settled_count", "metadata_parity_count",
    "expected_model_receipt_count", "model_receipt_count", "model_receipt_parity_count",
    "batch_applied_record_count", "batch_apply_receipt_count",
    "expected_batch_apply_receipt_count", "run_apply_receipt_count",
    "operation_receipt_drift_count", "tree_routing_drift_count",
    "physical_memory_count", "included_memory_count", "legacy_quarantine_memory_count",
    "new_quarantine_memory_count", "physical_knowledge_count", "included_knowledge_count",
    "legacy_quarantine_knowledge_count", "new_quarantine_knowledge_count",
    "memory_source_count", "knowledge_source_count", "scored_memory_count",
    "real_value_score_count", "floor_value_score_count", "real_importance_count",
    "floor_importance_count", "real_confidence_count", "floor_confidence_count",
  ] as const;
  const counts = Object.fromEntries(fields.map((field) => [field, postgresCount(row, field)])) as
    Record<(typeof fields)[number], number>;
  const sourceCount = input.manifest.source.sourceCount;
  const expectedRunCount = counts.included_scope_count;
  if (counts.run_count !== expectedRunCount || counts.completed_run_count !== expectedRunCount ||
      counts.non_completed_run_count !== 0 || counts.run_scope_count !== expectedRunCount ||
      counts.scope_parity_count !== expectedRunCount || counts.identity_conflict_count !== 0 ||
      counts.pin_drift_count !== 0 || counts.snapshot_count !== expectedRunCount * 2 ||
      counts.checkpoint_count !== expectedRunCount * 2 ||
      counts.completed_checkpoint_count !== expectedRunCount * 2 ||
      counts.snapshot_source_count !== sourceCount || counts.source_count !== sourceCount ||
      counts.distinct_source_count !== sourceCount || counts.plan_count !== sourceCount ||
      counts.distinct_plan_count !== sourceCount || counts.source_plan_parity_count !== sourceCount ||
      counts.settled_count !== sourceCount || counts.metadata_parity_count !== sourceCount ||
      counts.expected_model_receipt_count !== counts.model_receipt_count ||
      counts.model_receipt_parity_count !== counts.model_receipt_count ||
      counts.batch_applied_record_count !== sourceCount ||
      counts.batch_apply_receipt_count !== counts.expected_batch_apply_receipt_count ||
      counts.operation_receipt_drift_count !== 0 ||
      counts.tree_routing_drift_count !== 0 ||
      counts.run_apply_receipt_count !== expectedRunCount ||
      counts.included_memory_count !== counts.memory_source_count ||
      counts.included_knowledge_count !== counts.knowledge_source_count ||
      counts.included_memory_count + counts.included_knowledge_count !== sourceCount ||
      counts.physical_memory_count !== counts.included_memory_count +
        counts.legacy_quarantine_memory_count ||
      counts.physical_knowledge_count !== counts.included_knowledge_count +
        counts.legacy_quarantine_knowledge_count ||
      counts.scored_memory_count !== counts.memory_source_count - counts.new_quarantine_memory_count ||
      counts.real_value_score_count + counts.floor_value_score_count !== counts.scored_memory_count ||
      counts.real_importance_count + counts.floor_importance_count !== counts.scored_memory_count ||
      counts.real_confidence_count + counts.floor_confidence_count !== counts.scored_memory_count) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const memories = Object.freeze({
    physical: counts.physical_memory_count,
    included: counts.included_memory_count,
    legacyQuarantine: counts.legacy_quarantine_memory_count,
    newQuarantine: counts.new_quarantine_memory_count,
  });
  const knowledge = Object.freeze({
    physical: counts.physical_knowledge_count,
    included: counts.included_knowledge_count,
    legacyQuarantine: counts.legacy_quarantine_knowledge_count,
    newQuarantine: counts.new_quarantine_knowledge_count,
  });
  const report: HistoryRebuildGlobalParityVerification = Object.freeze({
    runs: Object.freeze({
      total: counts.run_count,
      completed: counts.completed_run_count,
      nonCompleted: counts.non_completed_run_count,
      scopes: counts.run_scope_count,
      identityConflicts: counts.identity_conflict_count,
      pinDrift: counts.pin_drift_count,
    }),
    ledger: Object.freeze({
      sourceRows: counts.source_count,
      plans: counts.plan_count,
      settled: counts.settled_count,
      metadataParity: counts.metadata_parity_count,
      expectedModelReceipts: counts.expected_model_receipt_count,
      modelReceipts: counts.model_receipt_count,
      batchAppliedRecords: counts.batch_applied_record_count,
      batchApplyReceipts: counts.batch_apply_receipt_count,
      runApplyReceipts: counts.run_apply_receipt_count,
    }),
    inventory: Object.freeze({
      physical: memories.physical + knowledge.physical,
      included: memories.included + knowledge.included,
      legacyQuarantine: memories.legacyQuarantine + knowledge.legacyQuarantine,
      newQuarantine: memories.newQuarantine + knowledge.newQuarantine,
      tables: Object.freeze({ memories, knowledge }),
    }),
    scoring: Object.freeze({
      total: counts.scored_memory_count,
      valueScore: scoreBasisReport(
        counts.real_value_score_count, counts.floor_value_score_count,
      ),
      importance: scoreBasisReport(
        counts.real_importance_count, counts.floor_importance_count,
      ),
      confidence: scoreBasisReport(
        counts.real_confidence_count, counts.floor_confidence_count,
      ),
    }),
  });
  return validateGlobalParityReport(report, input.manifest);
}

async function verifySealedHistoryTrees(
  input: HistoryRebuildPlanningInput,
): Promise<HistoryRebuildSealedTreeVerification> {
  const result = await input.client.query(SEALED_TREE_VERIFY_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const row = result.rows[0]!;
  const runs = postgresCount(row, "run_count");
  const historyTreeJobs = postgresCount(row, "history_tree_job_count");
  const completedTreeJobs = postgresCount(row, "completed_tree_job_count");
  const deadLetterTreeJobs = postgresCount(row, "dead_letter_tree_job_count");
  const finalizeJobs = postgresCount(row, "finalize_job_count");
  const distinctTargets = postgresCount(row, "distinct_target_count");
  const sourceTargets = postgresCount(row, "source_target_count");
  const topicTargets = postgresCount(row, "topic_target_count");
  const sealedSourceTargets = postgresCount(row, "sealed_source_target_count");
  const sealedTopicTargets = postgresCount(row, "sealed_topic_target_count");
  const coveredLeaves = postgresCount(row, "covered_leaf_count");
  const evidenceCoveredLeaves = postgresCount(row, "evidence_covered_leaf_count");
  const unfinishedL0Buffers = postgresCount(row, "unfinished_l0_buffer_count");
  const foldableParentBuffers = postgresCount(row, "foldable_parent_buffer_count");
  const l1Nodes = postgresCount(row, "l1_node_count");
  const l2Nodes = postgresCount(row, "l2_node_count");
  const l3Nodes = postgresCount(row, "l3_node_count");
  const targets = sourceTargets + topicTargets;
  if ((input.manifest.source.sourceCount > 0 && runs === 0) ||
      historyTreeJobs !== completedTreeJobs || deadLetterTreeJobs !== 0 ||
      finalizeJobs !== distinctTargets || historyTreeJobs !== targets + finalizeJobs ||
      sealedSourceTargets !== sourceTargets || sealedTopicTargets !== topicTargets ||
      coveredLeaves !== targets || evidenceCoveredLeaves !== targets ||
      unfinishedL0Buffers !== 0 || foldableParentBuffers !== 0 ||
      (targets > 0 && l1Nodes === 0)) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  return {
    runs, historyTreeJobs, completedTreeJobs, sourceTargets, topicTargets,
    sealedSourceTargets, sealedTopicTargets, coveredLeaves, evidenceCoveredLeaves,
    unfinishedL0Buffers, foldableParentBuffers, l1Nodes, l2Nodes, l3Nodes,
  };
}

function parseHistoryConfig(text: string): MemoryConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail("HISTORY_REBUILD_INVALID_CONFIG");
  }
  const config = memoryConfigSchema.parse(raw);
  if (config.dbType !== "postgres" || !config.postgres) {
    fail("HISTORY_REBUILD_INVALID_CONFIG");
  }
  return config;
}

function taggedHash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${JSON.stringify(value)}`).digest("hex");
}

function funnelCounts(plans: readonly HistoryRebuildPlan[]): HistoryRebuildBatchCommit["counts"] {
  const summary = summarizeHistoryRebuildPlans(plans);
  return {
    total: summary.total,
    preserve: summary.preserve,
    backfill: summary.backfill,
    modelClassify: summary.modelClassify,
    lookupOnly: summary.lookupOnly,
    quarantine: summary.quarantine,
  };
}

function pricingEstimator(
  options: CreateHistoryRebuildDependenciesOptions,
  manifest: HistoryRebuildManifest,
): (inputTokens: number, outputTokens: number) => number {
  const inputRate = manifest.budget.inputCostPerMillionTokens;
  const outputRate = manifest.budget.outputCostPerMillionTokens;
  if (!safeInteger(inputRate) || !safeInteger(outputRate)) {
    fail("HISTORY_REBUILD_PRICING_UNAVAILABLE");
  }
  return (inputTokens, outputTokens) => {
    if (!safeInteger(inputTokens) || !safeInteger(outputTokens)) {
      fail("HISTORY_REBUILD_PRICING_UNAVAILABLE");
    }
    const cost = options.estimateCostMinorUnits
      ? options.estimateCostMinorUnits(inputTokens, outputTokens, {
          model: manifest.models.extraction.model,
          currency: manifest.budget.currency,
          pricingSnapshotVersion: manifest.budget.pricingSnapshotVersion,
        })
      : Number((BigInt(inputTokens) * BigInt(inputRate) +
          BigInt(outputTokens) * BigInt(outputRate) + 999_999n) / 1_000_000n);
    return safeInteger(cost) ? cost : fail("HISTORY_REBUILD_PRICING_UNAVAILABLE");
  };
}

function repositoryModelReceipts(
  receipts: readonly HistoryRebuildLlmReceipt[],
  plans: readonly HistoryRebuildPlan[],
  selectedRows: readonly HistoryRebuildScanRow[],
  modelFingerprint: string,
  promptHash: string,
  schemaHash: string,
): readonly HistoryRebuildModelReceiptInput[] {
  const selected = new Set(selectedRows.map((row) => `${row.recordId}\0${row.sourceHash}`));
  const accepted = new Map(plans
    .filter((plan) => selected.has(`${plan.recordId}\0${plan.sourceHash}`) &&
      (plan.reason === "model_classification_accepted" ||
        plan.reason === "model_confidence_below_threshold" ||
        ((plan.reason === "valid_explicit_semantic_type" ||
          plan.reason === "deterministic_kind_mapping") &&
          plan.semanticType !== undefined && plan.semanticType !== "profile" &&
          plan.contextEligible && plan.topicLabels.length > 0)))
    .map((plan) => [`${plan.recordId}\0${plan.sourceHash}`, plan]));
  const mapped: HistoryRebuildModelReceiptInput[] = [];
  const seen = new Set<string>();
  for (const receipt of receipts) {
    const identity = `${receipt.recordId}\0${receipt.sourceHash}`;
    const plan = accepted.get(identity);
    if (!plan) continue;
    if (seen.has(identity) || receipt.planReceiptHash !== plan.receiptHash ||
        receipt.modelFingerprint !== modelFingerprint ||
        receipt.promptHash !== promptHash || receipt.schemaHash !== schemaHash) {
      fail("HISTORY_REBUILD_MODEL_REQUIRED");
    }
    seen.add(identity);
    mapped.push({
      receiptHash: receipt.receiptHash,
      recordId: receipt.recordId,
      sourceHash: receipt.sourceHash,
      planReceiptHash: receipt.planReceiptHash,
      modelFingerprint: receipt.modelFingerprint,
      promptHash: receipt.promptHash,
      schemaHash: receipt.schemaHash,
      inputHash: receipt.inputHash,
      outputHash: receipt.outputHash,
      confidence: receipt.confidence,
      proposalCount: receipt.proposalCount,
      inputTokens: receipt.usage.inputTokens,
      outputTokens: receipt.usage.outputTokens,
    });
  }
  if (mapped.length !== accepted.size || receipts.length !== mapped.length) {
    fail("HISTORY_REBUILD_MODEL_REQUIRED");
  }
  return mapped;
}

export function requiresHistoryRebuildModelEnrichment(
  row: Pick<HistoryRebuildScanRow, "sourceTable">,
  deterministic: Pick<HistoryRebuildPlan,
    "reason" | "contextEligible" | "semanticType" | "topicLabels">,
): boolean {
  return deterministic.reason === "model_classification_required" ||
    (row.sourceTable === "memories" && deterministic.contextEligible &&
      deterministic.semanticType !== undefined && deterministic.semanticType !== "profile" &&
      deterministic.topicLabels.length === 0);
}

function treePolicyForScope(
  bundle: HistoryRebuildTreePolicyBundle,
  scope: HistoryRebuildScopeSummary["scope"],
): HistoryRebuildTreeRoutingPolicy {
  const scopeFingerprint = authorityScopeFingerprint(scope);
  const matches = bundle.policies.filter((policy) => policy.scopeFingerprint === scopeFingerprint);
  if (matches.length !== 1) fail("HISTORY_REBUILD_INVALID_MANIFEST");
  historyRebuildTreeRoutingPolicyHash(matches[0]!);
  return matches[0]!;
}

async function defaultApply(
  input: HistoryRebuildPlanningInput,
  options: CreateHistoryRebuildDependenciesOptions,
): Promise<Record<string, unknown>> {
  if (input.manifest.requiredSchemaVersion !== 24 || !input.treePolicyBundle ||
      input.treePolicyBundleSha256 !== input.manifest.tree.policyBundleSha256 ||
      input.manifest.tree.policyVersion !== HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION ||
      input.manifest.tree.topicLabelVersion !== HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  if (input.modelAssisted) {
    await assertFrozenSnapshot(input);
  } else {
    const frozenRows = await readFrozenRows(input);
    if (frozenRows.some((row) =>
      planHistoryRebuild(row).reason === "model_classification_required")) {
      fail("HISTORY_REBUILD_MODEL_REQUIRED");
    }
  }
  const estimateCost = input.modelAssisted
    ? pricingEstimator(options, input.manifest)
    : undefined;
  const repository = options.repository?.(input.client) ?? new PostgresHistoryRebuildRepository({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      const result = await input.client.query<Row>(sql, params);
      return { rows: result.rows ?? [], rowCount: result.rowCount };
    },
  });
  const now = options.now ?? Date.now;
  const nextRunId = options.runId ?? randomUUID;
  const { modelFingerprint, promptHash, schemaHash } =
    deriveHistoryRebuildLlmPins(input.manifest);
  const usedPolicyScopes = new Set<string>();
  let afterScope: HistoryRebuildScopeSummary["scope"] | undefined;
  let scopedSourceCount = 0;
  let applied = 0;
  let scopeCount = 0;
  let runCount = 0;
  if (input.modelAssisted && (!repository.readModelUsage || !repository.reserveModelAttempt ||
      !repository.completeModelAttempt)) {
    fail("HISTORY_REBUILD_EXECUTION_FAILED");
  }
  const persistedUsage = input.modelAssisted
    ? await repository.readModelUsage!({
        migrationId: input.manifest.migrationId,
        manifestHash: input.manifestSha256,
        modelFingerprint,
        promptHash,
        schemaHash,
      })
    : { modelCalls: 0, inputTokens: 0, outputTokens: 0, costMinorUnits: 0 };
  if (![persistedUsage.modelCalls, persistedUsage.inputTokens, persistedUsage.outputTokens,
    persistedUsage.costMinorUnits].every((value) => safeInteger(value))) {
    fail("HISTORY_REBUILD_EXECUTION_FAILED");
  }
  let modelCalls = persistedUsage.modelCalls;
  let materializedSourceRows = 0;
  let evidenceLinks = 0;
  let treeJobs = 0;
  let inputTokens = persistedUsage.inputTokens;
  let outputTokens = persistedUsage.outputTokens;
  let costMinorUnits = persistedUsage.costMinorUnits;
  if (modelCalls > input.manifest.budget.maxModelCalls ||
      inputTokens > input.manifest.budget.maxInputTokens ||
      outputTokens > input.manifest.budget.maxOutputTokens ||
      costMinorUnits > input.manifest.budget.maxCostMinorUnits) {
    fail("HISTORY_REBUILD_BUDGET_EXCEEDED");
  }
  for (;;) {
    const scopes = await repository.listScopes({ limit: 1_000, ...(afterScope ? { after: afterScope } : {}) });
    if (scopes.length === 0) break;
    for (const summary of scopes) {
      const treePolicy = treePolicyForScope(input.treePolicyBundle, summary.scope);
      const scopeFingerprint = authorityScopeFingerprint(summary.scope);
      if (usedPolicyScopes.has(scopeFingerprint)) fail("HISTORY_REBUILD_SOURCE_DRIFT");
      usedPolicyScopes.add(scopeFingerprint);
      const policyHash = historyRebuildTreeRoutingPolicyHash(treePolicy);
      scopeCount += 1;
      scopedSourceCount += summary.memoriesCount + summary.knowledgeCount;
      const run = await repository.createRun({
        runId: nextRunId(), migrationId: input.manifest.migrationId, scope: summary.scope,
        manifestHash: input.manifestSha256, modelFingerprint, promptHash, schemaHash,
        policyHash, now: now(),
      });
      runCount += 1;
      if (run.state === "completed") {
        const verifiedRun = await repository.verifyRun({
          runId: run.runId, scope: summary.scope, treePolicy,
        });
        if (verifiedRun.totalSourceCount !== summary.memoriesCount + summary.knowledgeCount ||
            verifiedRun.totalPlanCount !== verifiedRun.totalSourceCount ||
            verifiedRun.treeJobs !== verifiedRun.queuedTreeJobs +
              verifiedRun.completedTreeJobs + verifiedRun.deadLetterTreeJobs) {
          fail("HISTORY_REBUILD_SOURCE_DRIFT");
        }
        applied += verifiedRun.totalSourceCount;
        materializedSourceRows += verifiedRun.appliedMemoryCount;
        evidenceLinks += verifiedRun.evidenceLinks;
        treeJobs += verifiedRun.treeJobs;
        continue;
      }
      for (const snapshot of run.snapshots) {
        const expectedCount = snapshot.sourceTable === "memories"
          ? summary.memoriesCount : summary.knowledgeCount;
        if (snapshot.sourceCount !== expectedCount) fail("HISTORY_REBUILD_SOURCE_DRIFT");
        let afterId = snapshot.afterId ?? null;
        let checkpointVersion = snapshot.checkpointVersion ?? 0;
        let processed = snapshot.processedCount ?? 0;
        applied += processed;
        if (snapshot.checkpointState === "completed") continue;
        for (;;) {
          const runtimeConfig = input.operatorConfig as MemoryConfig;
          const rows = await repository.scanBatch({
            runId: run.runId, scope: summary.scope, sourceTable: snapshot.sourceTable,
            afterId, sourceUpperBound: snapshot.sourceUpperBound,
            batchSize: snapshot.sourceTable === "knowledge"
              ? 1_000
              : Math.min(runtimeConfig.batchProcessing?.maxBatchSize ?? 500, 500),
          });
          if (rows.length === 0 && processed !== snapshot.sourceCount) {
            fail("HISTORY_REBUILD_SOURCE_DRIFT");
          }
          let plans: readonly HistoryRebuildPlan[];
          let modelReceipts: readonly HistoryRebuildModelReceiptInput[] = [];
          if (!input.modelAssisted) {
            plans = rows.map((row) => planHistoryRebuild(row));
          } else {
            if (!runtimeConfig.llm ||
                (runtimeConfig.llm.extractionModel ?? runtimeConfig.llm.model) !==
                  input.manifest.models.extraction.model ||
                runtimeConfig.llm.baseURL !== input.manifest.models.extraction.baseURL) {
              fail("HISTORY_REBUILD_INVALID_CONFIG");
            }
            const planner = options.llmPlanner ?? runHistoryRebuildLlmPlanner;
            const deterministicPlans = rows.map((row) => planHistoryRebuild(row));
            const modelRows = rows.filter((row, index) =>
              requiresHistoryRebuildModelEnrichment(row, deterministicPlans[index]!));
            const result = await planner({
              rows: modelRows,
              manifest: input.manifest,
              manifestSha256: input.manifestSha256,
              runId: run.runId,
            }, {
              // Durable attempt transactions share the operator's single PostgreSQL client.
              concurrency: 1,
              llm: options.llm ?? createLlmClient(runtimeConfig.llm, {
                concurrency: 1,
              }),
              redactor: { version: REDACTION_MAP_VERSION, redact: redactSecrets },
              estimateTokens: (text) => Math.ceil(text.length / 4),
              estimateCostMinorUnits: estimateCost!,
              attempts: {
                reserve: (attempt) => repository.reserveModelAttempt!({
                  ...attempt, resumeUnresolved: true, now: now(),
                }),
                complete: (attempt) => repository.completeModelAttempt!({
                  ...attempt, now: now(),
                }),
              },
              checkpoint: options.checkpoint ?? (async () => undefined),
              wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
            });
            const classified = new Map(result.plans.map((plan) => [
              `${plan.recordId}\0${plan.sourceHash}`,
              plan,
            ]));
            const selected = new Set(modelRows.map((row) =>
              `${row.recordId}\0${row.sourceHash}`));
            plans = deterministicPlans.map((plan) => selected.has(
              `${plan.recordId}\0${plan.sourceHash}`,
            ) ? classified.get(`${plan.recordId}\0${plan.sourceHash}`) ??
                fail("HISTORY_REBUILD_MODEL_REQUIRED") : plan);
            if (plans.some((plan) => plan.reason === "model_classification_required")) {
              fail("HISTORY_REBUILD_MODEL_REQUIRED");
            }
            const durableUsage = await repository.readModelUsage!({
              migrationId: input.manifest.migrationId,
              manifestHash: input.manifestSha256,
              modelFingerprint,
              promptHash,
              schemaHash,
            });
            modelCalls = durableUsage.modelCalls;
            inputTokens = durableUsage.inputTokens;
            outputTokens = durableUsage.outputTokens;
            costMinorUnits = durableUsage.costMinorUnits;
            if (modelCalls > input.manifest.budget.maxModelCalls ||
                inputTokens > input.manifest.budget.maxInputTokens ||
                outputTokens > input.manifest.budget.maxOutputTokens ||
                costMinorUnits > input.manifest.budget.maxCostMinorUnits) {
              fail("HISTORY_REBUILD_BUDGET_EXCEEDED");
            }
            modelReceipts = repositoryModelReceipts(
              result.receipts, plans, modelRows, modelFingerprint, promptHash, schemaHash,
            );
          }
          const nextAfterId = rows.at(-1)?.recordId ?? afterId;
          processed += rows.length;
          const complete = processed === snapshot.sourceCount;
          const counts = funnelCounts(plans);
          const receiptHash = taggedHash("mengshu.history-rebuild-apply/v1", {
            runId: run.runId, sourceTable: snapshot.sourceTable,
            expectedCheckpointVersion: checkpointVersion, afterId, nextAfterId,
            receipts: plans.map((plan) => plan.receiptHash),
          });
          const checkpoint = await repository.commitBatch({
            runId: run.runId, scope: summary.scope, sourceTable: snapshot.sourceTable,
            expectedAfterId: afterId, nextAfterId, expectedCheckpointVersion: checkpointVersion,
            counts, sourceRows: rows, plans, modelReceipts,
            operationReceipt: {
              receiptHash, operation: "apply", status: "applied", counts: { ...counts },
            },
            complete, now: now(),
          });
          applied += plans.length;
          afterId = checkpoint.afterId;
          checkpointVersion = checkpoint.checkpointVersion;
          if (complete) break;
        }
      }
      const appliedRun = await repository.applyRun({
        runId: run.runId, scope: summary.scope, now: now(), treePolicy,
      });
      const verifiedRun = await repository.verifyRun({
        runId: run.runId, scope: summary.scope, treePolicy,
      });
      if (verifiedRun.totalSourceCount !==
            verifiedRun.memorySourceCount + verifiedRun.knowledgeSourceCount ||
          verifiedRun.totalSourceCount !== summary.memoriesCount + summary.knowledgeCount ||
          verifiedRun.totalPlanCount !==
            verifiedRun.memoryPlanCount + verifiedRun.knowledgePlanCount ||
          verifiedRun.totalPlanCount !== verifiedRun.totalSourceCount ||
          verifiedRun.memorySourceCount !== verifiedRun.memoryPlanCount ||
          verifiedRun.memoryPlanCount !== verifiedRun.appliedMemoryCount ||
          verifiedRun.knowledgeSourceCount !== verifiedRun.knowledgePlanCount ||
          verifiedRun.knowledgePlanCount !== verifiedRun.unchangedKnowledgeCount ||
          verifiedRun.appliedMemoryCount !==
            appliedRun.active + appliedRun.lookupOnly + appliedRun.classifiedInactive ||
          verifiedRun.evidenceMirrors !== appliedRun.evidenceMirrors ||
          verifiedRun.evidenceLinks !== appliedRun.evidenceLinks ||
          verifiedRun.treeJobs !== appliedRun.treeJobs ||
          verifiedRun.treeJobs !== verifiedRun.queuedTreeJobs +
            verifiedRun.completedTreeJobs + verifiedRun.deadLetterTreeJobs) {
        fail("HISTORY_REBUILD_SOURCE_DRIFT");
      }
      materializedSourceRows += verifiedRun.appliedMemoryCount;
      evidenceLinks += verifiedRun.evidenceLinks;
      treeJobs += verifiedRun.treeJobs;
    }
    afterScope = scopes.at(-1)!.scope;
  }
  if (usedPolicyScopes.size !== input.treePolicyBundle.policies.length ||
      scopedSourceCount !== input.manifest.source.sourceCount || applied !== scopedSourceCount) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  return {
    applied, scopes: scopeCount, runs: runCount, modelCalls,
    inputTokens, outputTokens, costMinorUnits,
    materializedSourceRows, evidenceLinks, treeJobs,
    executionSemantics: "repository-owned-materialization",
  };
}

const VERIFY_RUNS_SQL = `/* history-rebuild:verify-runs */
SELECT run.run_id, run.tenant_id, run.user_id, run.app_id, run.project_id,
  run.agent_id, run.namespace, run.visibility, run.workspace_id, run.session_id
FROM mengshu_history_rebuild_runs run
WHERE run.migration_id = $1 AND run.manifest_hash = $2
ORDER BY run.run_id`;

const VERIFIED_PLAN_SUMMARY_SQL = `/* history-rebuild:verified-plan-summary */
WITH exact_runs AS (
  SELECT run_id FROM mengshu_history_rebuild_runs
  WHERE migration_id = $1 AND manifest_hash = $2 AND state = 'completed'
), plans AS (
  SELECT plan.* FROM mengshu_history_rebuild_shadow_plans plan
  JOIN exact_runs run USING (run_id)
)
SELECT COUNT(*)::text AS source_count,
  COUNT(*) FILTER (WHERE disposition = 'preserve')::text AS preserve_count,
  COUNT(*) FILTER (WHERE disposition IN ('backfill', 'model_classify'))::text
    AS backfill_count,
  COUNT(*) FILTER (WHERE disposition = 'lookup_only')::text AS lookup_only_count,
  COUNT(*) FILTER (WHERE disposition = 'quarantine')::text AS quarantine_count,
  COUNT(*) FILTER (WHERE (tree_eligibility->>'topic')::boolean)::text AS topic_eligible_count,
  COUNT(*) FILTER (WHERE (tree_eligibility->>'source')::boolean)::text AS source_eligible_count
FROM plans`;

function historyRebuildRunIdentity(row: Record<string, unknown>): Readonly<{
  runId: string;
  scope: HistoryRebuildScopeSummary["scope"];
}> {
  const runId = stringField(row.run_id);
  const scope = {
    tenantId: stringField(row.tenant_id), userId: stringField(row.user_id),
    appId: stringField(row.app_id), projectId: stringField(row.project_id),
    agentId: stringField(row.agent_id), namespace: stringField(row.namespace),
    visibility: stringField(row.visibility),
    ...(stringField(row.workspace_id) ? { workspaceId: stringField(row.workspace_id) } : {}),
    ...(stringField(row.session_id) ? { sessionId: stringField(row.session_id) } : {}),
  };
  if (!runId || !scope.tenantId || !scope.userId || !scope.appId || !scope.projectId ||
      !scope.agentId || !scope.namespace ||
      !["private", "workspace", "team", "public"].includes(scope.visibility ?? "")) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  return Object.freeze({
    runId,
    scope: scope as HistoryRebuildScopeSummary["scope"],
  });
}

async function verifyPersistedRuns(
  input: HistoryRebuildPlanningInput,
  options: CreateHistoryRebuildDependenciesOptions,
): Promise<void> {
  if (input.manifest.requiredSchemaVersion === 24 &&
      (!input.treePolicyBundle ||
        input.treePolicyBundleSha256 !== input.manifest.tree.policyBundleSha256)) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  const repository = options.repository?.(input.client) ?? new PostgresHistoryRebuildRepository({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      const result = await input.client.query<Row>(sql, params);
      return { rows: result.rows ?? [], rowCount: result.rowCount };
    },
  });
  const result = await input.client.query(VERIFY_RUNS_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  const usedPolicyScopes = new Set<string>();
  let totalSourceCount = 0;
  let totalPlanCount = 0;
  let memorySourceCount = 0;
  let knowledgeSourceCount = 0;
  for (const raw of result.rows ?? []) {
    const { runId, scope } = historyRebuildRunIdentity(raw);
    const treePolicy = input.manifest.requiredSchemaVersion === 24
      ? input.treePolicyBundle
        ? treePolicyForScope(input.treePolicyBundle, scope)
        : fail("HISTORY_REBUILD_INVALID_MANIFEST")
      : undefined;
    if (treePolicy) {
      if (usedPolicyScopes.has(treePolicy.scopeFingerprint)) {
        fail("HISTORY_REBUILD_SOURCE_DRIFT");
      }
      usedPolicyScopes.add(treePolicy.scopeFingerprint);
    }
    let verified: VerifiedHistoryRebuildRun;
    try {
      verified = await repository.verifyRun({
        runId, scope, ...(treePolicy ? { treePolicy } : {}),
      });
    } catch {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    if (verified.totalSourceCount !==
          verified.memorySourceCount + verified.knowledgeSourceCount ||
        verified.totalPlanCount !== verified.memoryPlanCount + verified.knowledgePlanCount ||
        verified.totalSourceCount !== verified.totalPlanCount ||
        verified.memorySourceCount !== verified.memoryPlanCount ||
        verified.memoryPlanCount !== verified.appliedMemoryCount ||
        verified.knowledgeSourceCount !== verified.knowledgePlanCount ||
        verified.knowledgePlanCount !== verified.unchangedKnowledgeCount ||
        verified.treeJobs !== verified.completedTreeJobs || verified.queuedTreeJobs !== 0 ||
        verified.deadLetterTreeJobs !== 0) {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    totalSourceCount += verified.totalSourceCount;
    totalPlanCount += verified.totalPlanCount;
    memorySourceCount += verified.memorySourceCount;
    knowledgeSourceCount += verified.knowledgeSourceCount;
  }
  if (totalSourceCount !== input.manifest.source.sourceCount ||
      totalPlanCount !== totalSourceCount || memorySourceCount + knowledgeSourceCount !== totalSourceCount ||
      (input.treePolicyBundle && usedPolicyScopes.size !== input.treePolicyBundle.policies.length)) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
}

async function readVerifiedPlanningResult(
  input: HistoryRebuildPlanningInput,
): Promise<HistoryRebuildPlanningResult> {
  const result = await input.client.query(VERIFIED_PLAN_SUMMARY_SQL, [
    input.manifest.migrationId, input.manifestSha256,
  ]);
  if (result.rows?.length !== 1 || (result.rowCount ?? 1) !== 1 ||
      !plainRecord(result.rows[0])) {
    fail("HISTORY_REBUILD_SOURCE_DRIFT");
  }
  const row = result.rows[0]!;
  const sourceCount = postgresCount(row, "source_count");
  const sourceEligible = postgresCount(row, "source_eligible_count");
  const topicEligible = postgresCount(row, "topic_eligible_count");
  if (topicEligible > sourceEligible) fail("HISTORY_REBUILD_SOURCE_DRIFT");
  return {
    sourceCount,
    dispositions: {
      preserveExplicit: postgresCount(row, "preserve_count"),
      backfill: postgresCount(row, "backfill_count"),
      lookupOnly: postgresCount(row, "lookup_only_count"),
      invalidExplicit: postgresCount(row, "quarantine_count"),
    },
    tree: {
      mapped: topicEligible,
      orphan: sourceEligible - topicEligible,
      ambiguous: sourceCount - sourceEligible,
    },
    estimatedModelCalls: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedCostMinorUnits: 0,
  };
}

const ROLLBACK_RUNS_SQL = `/* history-rebuild:rollback-runs */
SELECT run.run_id, run.tenant_id, run.user_id, run.app_id, run.project_id,
  run.agent_id, run.namespace, run.visibility, run.workspace_id, run.session_id
FROM mengshu_history_rebuild_runs run
WHERE run.migration_id = $1 AND run.manifest_hash = $2
  AND run.state = 'completed'
ORDER BY run.run_id`;

async function defaultRollback(
  input: HistoryRebuildPlanningInput,
  options: CreateHistoryRebuildDependenciesOptions,
): Promise<Record<string, unknown>> {
  if (input.manifest.requiredSchemaVersion === 24 &&
      (!input.treePolicyBundle ||
        input.treePolicyBundleSha256 !== input.manifest.tree.policyBundleSha256)) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  const now = (options.now ?? Date.now)();
  const repository = options.repository?.(input.client) ?? new PostgresHistoryRebuildRepository({
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: readonly unknown[],
    ) => {
      const result = await input.client.query<Row>(sql, params);
      return { rows: result.rows ?? [], rowCount: result.rowCount };
    },
  });
  try {
    const result = await input.client.query(ROLLBACK_RUNS_SQL, [
      input.manifest.migrationId, input.manifestSha256,
    ]);
    let restoredSourceRows = 0;
    let removedTreeJobs = 0;
    let rolledBackRuns = 0;
    const usedPolicyScopes = new Set<string>();
    for (const row of result.rows ?? []) {
      const runId = stringField(row.run_id);
      const scope = {
        tenantId: stringField(row.tenant_id), userId: stringField(row.user_id),
        appId: stringField(row.app_id), projectId: stringField(row.project_id),
        agentId: stringField(row.agent_id), namespace: stringField(row.namespace),
        visibility: stringField(row.visibility),
        ...(stringField(row.workspace_id) ? { workspaceId: stringField(row.workspace_id) } : {}),
        ...(stringField(row.session_id) ? { sessionId: stringField(row.session_id) } : {}),
      };
      if (!runId || !scope.tenantId || !scope.userId || !scope.appId || !scope.projectId ||
          !scope.agentId || !scope.namespace ||
          !["private", "workspace", "team", "public"].includes(scope.visibility ?? "")) {
        fail("HISTORY_REBUILD_EXECUTION_FAILED");
      }
      const typedScope = scope as HistoryRebuildScopeSummary["scope"];
      const treePolicy = input.manifest.requiredSchemaVersion === 24
        ? input.treePolicyBundle
          ? treePolicyForScope(input.treePolicyBundle, typedScope)
          : fail("HISTORY_REBUILD_INVALID_MANIFEST")
        : undefined;
      if (treePolicy) usedPolicyScopes.add(treePolicy.scopeFingerprint);
      const rolledBack = await repository.rollbackRun({
        runId,
        scope: typedScope,
        now,
        ...(treePolicy ? { treePolicy } : {}),
      });
      rolledBackRuns += 1;
      restoredSourceRows += rolledBack.restored;
      removedTreeJobs += rolledBack.removedTreeJobs;
    }
    if (input.treePolicyBundle && usedPolicyScopes.size !== input.treePolicyBundle.policies.length) {
      fail("HISTORY_REBUILD_INVALID_MANIFEST");
    }
    return {
      rolledBackRuns, restoredSourceRows, removedTreeJobs,
      executionSemantics: "repository-owned-materialization",
    };
  } catch (error) {
    if (error instanceof HistoryRebuildOperatorError) throw error;
    fail("HISTORY_REBUILD_EXECUTION_FAILED");
  }
}

export function createHistoryRebuildOperatorDependencies(
  options: CreateHistoryRebuildDependenciesOptions = {},
): HistoryRebuildOperatorDependencies {
  return {
    readText: (path) => readFileSync(path, "utf8"),
    parseConfig: parseHistoryConfig,
    connect: async (value) => {
      const config = value as MemoryConfig;
      const pool = new pg.Pool({
        ...config.postgres!,
        max: 1,
        keepAlive: true,
        keepAliveInitialDelayMillis: 10_000,
      });
      const connection = await pool.connect();
      // A checked-out pg client emits connection faults directly. Keep that event from
      // bypassing the operator's fail-closed query/rollback path as an uncaught process error.
      connection.on("error", () => undefined);
      return {
        client: connection,
        close: async () => {
          connection.release();
          await pool.end();
        },
      };
    },
    assertSchemaVersion: async ({ client, manifest }) => {
      const result = await client.query(`/* history-rebuild:schema-gate */
SELECT COUNT(*)::text AS version_count
FROM mengshu_schema_migrations WHERE version BETWEEN 1 AND $1`, [manifest.requiredSchemaVersion]);
      if (result.rows?.length !== 1 ||
          String(result.rows[0]?.version_count) !== String(manifest.requiredSchemaVersion)) {
        fail("HISTORY_REBUILD_SCHEMA_NOT_READY");
      }
    },
    plan: async (input) => {
      const rows = await readFrozenRows(input);
      return planningResult(rows.map((row) => planHistoryRebuild(row)), {
        estimatedModelCalls: rows.filter((row) =>
          planHistoryRebuild(row).reason === "model_classification_required").length,
        estimatedInputTokens: rows.reduce((sum, row) => sum + Math.ceil(row.text.length / 4), 0),
        estimatedOutputTokens: rows.length * 128,
        estimatedCostMinorUnits: 0,
      });
    },
    planWithModel: async (input) => {
      const rows = await readFrozenRows(input);
      const runtimeConfig = input.operatorConfig as MemoryConfig;
      if (!runtimeConfig?.llm ||
          (runtimeConfig.llm.extractionModel ?? runtimeConfig.llm.model) !== input.manifest.models.extraction.model ||
          runtimeConfig.llm.baseURL !== input.manifest.models.extraction.baseURL) {
        fail("HISTORY_REBUILD_INVALID_CONFIG");
      }
      const estimateCost = pricingEstimator(options, input.manifest);
      const planner = options.llmPlanner ?? runHistoryRebuildLlmPlanner;
      const result = await planner({
        rows, manifest: input.manifest, manifestSha256: input.manifestSha256,
      }, {
        concurrency: runtimeConfig.batchProcessing?.concurrency ?? 3,
        llm: options.llm ?? createLlmClient(runtimeConfig.llm, {
          concurrency: runtimeConfig.batchProcessing?.concurrency ?? 3,
        }),
        redactor: { version: REDACTION_MAP_VERSION, redact: redactSecrets },
        estimateTokens: (text) => Math.ceil(text.length / 4),
        estimateCostMinorUnits: estimateCost,
        // Read-only planning has no durable run/attempt ledger. A real planner therefore
        // fails before egress; model-assisted execution is supported only by governed apply.
        attempts: {
          reserve: async () => ({ state: "in_flight_or_unknown" as const }),
          complete: async () => fail("HISTORY_REBUILD_EXECUTION_FAILED"),
        },
        checkpoint: options.checkpoint ?? (async () => undefined),
        wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
      });
      return planningResult(result.plans, {
        estimatedModelCalls: result.usage.modelCalls,
        estimatedInputTokens: result.usage.inputTokens,
        estimatedOutputTokens: result.usage.outputTokens,
        estimatedCostMinorUnits: result.usage.costMinorUnits,
      });
    },
    verify: async (input) => {
      await assertFrozenSnapshot(input);
      await verifyPersistedRuns(input, options);
      const result = await readVerifiedPlanningResult(input);
      const globalParityVerification = await verifyGlobalHistoryRebuildParity(input);
      return input.manifest.tree.requireSealed
        ? {
            ...result,
            globalParityVerification,
            sealedTreeVerification: await verifySealedHistoryTrees(input),
          }
        : { ...result, globalParityVerification };
    },
    apply: options.apply ?? ((input) => defaultApply(input, options)),
    rollback: options.rollback ?? ((input) => defaultRollback(input, options)),
  };
}

const OPERATOR_LOCK_SQL = `/* history-rebuild:operator-lock */
SELECT pg_try_advisory_lock(hashtextextended(concat_ws(chr(31),
  'mengshu.history-rebuild-operator/v1', $1::text), 0)) AS acquired`;

const OPERATOR_UNLOCK_SQL = `/* history-rebuild:operator-unlock */
SELECT pg_advisory_unlock(hashtextextended(concat_ws(chr(31),
  'mengshu.history-rebuild-operator/v1', $1::text), 0)) AS released`;

async function changeOperatorLock(
  client: HistoryRebuildQueryClient,
  migrationId: string,
  operation: "acquire" | "release",
): Promise<boolean> {
  const result = await client.query(
    operation === "acquire" ? OPERATOR_LOCK_SQL : OPERATOR_UNLOCK_SQL,
    [migrationId],
  );
  const row = result.rows?.[0];
  const key = operation === "acquire" ? "acquired" : "released";
  return result.rowCount === 1 && result.rows?.length === 1 && plainRecord(row) && row[key] === true;
}

export async function runHistoryRebuildOperator(
  argv: readonly string[],
  dependencies: HistoryRebuildOperatorDependencies,
): Promise<Record<string, unknown>> {
  const args = cliArgs(argv);
  let loaded: LoadedHistoryRebuildManifest;
  try {
    loaded = loadHistoryRebuildManifest(dependencies.readText(args.manifestPath));
  } catch (error) {
    if (error instanceof HistoryRebuildOperatorError) throw error;
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  assertWriteGate(args, loaded);
  if (args.operation === "apply" && loaded.manifest.requiredSchemaVersion !== 24) {
    fail("HISTORY_REBUILD_INVALID_MANIFEST");
  }
  if (args.liveModel && args.operation !== "apply") {
    fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  }
  let loadedBundle: LoadedHistoryRebuildTreePolicyBundle | undefined;
  if (loaded.manifest.requiredSchemaVersion === 24) {
    if (!args.treePolicyBundlePath) fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
    try {
      loadedBundle = loadHistoryRebuildTreePolicyBundle(
        dependencies.readText(args.treePolicyBundlePath),
      );
    } catch (error) {
      if (error instanceof HistoryRebuildOperatorError) throw error;
      fail("HISTORY_REBUILD_INVALID_MANIFEST");
    }
    if (loadedBundle.sha256 !== loaded.manifest.tree.policyBundleSha256) {
      fail("HISTORY_REBUILD_MANIFEST_MISMATCH");
    }
  } else if (args.treePolicyBundlePath) {
    fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  }

  let config: unknown;
  try {
    config = dependencies.parseConfig(dependencies.readText(args.configPath));
  } catch {
    fail("HISTORY_REBUILD_INVALID_CONFIG");
  }
  const connection = await dependencies.connect(config)
    .catch(() => fail("HISTORY_REBUILD_CONNECTION_FAILED"));
  let lockAcquired = false;
  let primaryFailure: unknown;
  try {
    lockAcquired = await changeOperatorLock(
      connection.client, loaded.manifest.migrationId, "acquire",
    ).catch(() => fail("HISTORY_REBUILD_CONNECTION_FAILED"));
    if (!lockAcquired) fail("HISTORY_REBUILD_OPERATOR_LOCKED");
    const input = {
      client: connection.client,
      manifest: loaded.manifest,
      manifestSha256: loaded.sha256,
      modelAssisted: args.liveModel,
      operatorConfig: config,
      ...(loadedBundle ? {
        treePolicyBundle: loadedBundle.bundle,
        treePolicyBundleSha256: loadedBundle.sha256,
      } : {}),
    };
    if (args.operation === "apply" || args.operation === "rollback") {
      try {
        await dependencies.assertSchemaVersion(input);
      } catch {
        fail("HISTORY_REBUILD_SCHEMA_NOT_READY");
      }
      try {
        const result = args.operation === "apply"
          ? await dependencies.apply(input)
          : await dependencies.rollback(input);
        return {
          operation: args.operation,
          manifestSha256: loaded.sha256,
          requiredSchemaVersion: loaded.manifest.requiredSchemaVersion,
          modelAssisted: args.liveModel,
          ...result,
        };
      } catch (error) {
        if (error instanceof HistoryRebuildOperatorError) throw error;
        fail("HISTORY_REBUILD_EXECUTION_FAILED");
      }
    }
    try {
      await connection.client.query("BEGIN READ ONLY");
      try {
        await dependencies.assertSchemaVersion(input);
      } catch {
        fail("HISTORY_REBUILD_SCHEMA_NOT_READY");
      }
      const raw = args.operation === "verify" ? await dependencies.verify(input)
        : args.liveModel ? await dependencies.planWithModel(input)
          : await dependencies.plan(input);
      const result = validatePlan(raw, loaded.manifest, args.operation === "verify");
      await connection.client.query("ROLLBACK");
      return {
        operation: args.operation,
        manifestSha256: loaded.sha256,
        requiredSchemaVersion: loaded.manifest.requiredSchemaVersion,
        modelAssisted: args.liveModel,
        writes: 0,
        modelCalls: args.liveModel ? result.estimatedModelCalls : 0,
        ...result,
      };
    } catch (error) {
      await connection.client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof HistoryRebuildOperatorError) throw error;
      fail("HISTORY_REBUILD_PLANNING_FAILED");
    }
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    let releaseFailure = false;
    if (lockAcquired) {
      releaseFailure = !await changeOperatorLock(
        connection.client, loaded.manifest.migrationId, "release",
      ).catch(() => false);
    }
    await connection.close().catch(() => undefined);
    if (releaseFailure && primaryFailure === undefined) {
      fail("HISTORY_REBUILD_CONNECTION_FAILED");
    }
  }
  fail("HISTORY_REBUILD_EXECUTION_FAILED");
}

const PREPARE_SNAPSHOT_SQL = `/* history-rebuild:prepare-snapshot */
WITH source_rows AS (
  SELECT 'memories'::text AS source_table, id::text AS record_id,
    encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
      tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
      visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
      lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash
  FROM memories WHERE legacy_quarantine_reason IS NULL
    AND metadata#>>'{historyRebuild,role}' IS DISTINCT FROM 'evidence_mirror'
  UNION ALL
  SELECT 'knowledge'::text AS source_table, id::text AS record_id,
    encode(sha256(convert_to(concat_ws(chr(31), id::text, content_hash, metadata::text,
      tenant_id, user_id, canonical_project_id, product_id, producer_id, namespace,
      visibility, COALESCE(workspace_id, ''), COALESCE(metadata->>'sessionId', ''),
      lifecycle_status, data_type, category), 'UTF8')), 'hex') AS source_hash
  FROM knowledge WHERE legacy_quarantine_reason IS NULL
)
SELECT COUNT(*)::text AS source_count,
  encode(sha256(convert_to(COALESCE(string_agg(
    concat_ws(chr(31), source_table, record_id, source_hash), E'\\n'
    ORDER BY source_table, record_id
  ), ''), 'UTF8')), 'hex') AS snapshot_sha256
FROM source_rows`;

function requiredCliValue(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  const value = index < 0 ? undefined : argv[index + 1];
  if (!value || value.startsWith("--")) fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  return value;
}

function requiredCliInteger(argv: readonly string[], name: string): number {
  const value = Number(requiredCliValue(argv, name));
  return safeInteger(value) ? value : fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
}

interface HistoryTreePolicyTopicRecord {
  readonly recordId: string;
  readonly scopeFingerprint: string;
  readonly labels: readonly string[];
}

interface HistoryTreePolicyTopicResult {
  readonly taxonomyByScope: ReadonlyMap<string, readonly Readonly<{
    canonicalLabel: string;
    aliases: readonly string[];
    support: number;
  }>[]>;
  readonly planEligible: number;
  readonly rawAssignments: number;
  readonly rawTargetsAtMinimumSupport: number;
  readonly retainedRecords: number;
  readonly retainedAssignments: number;
  readonly targetCount: number;
  readonly singletonTargets: number;
  readonly minimumTargetLeaves: number;
  readonly maximumTargetLeaves: number;
  readonly iterations: number;
}

function topicPolicyKey(scopeFingerprint: string, label: string): string {
  return `${scopeFingerprint}\0${label}`;
}

function topicPolicyFixedPoint(records: readonly HistoryTreePolicyTopicRecord[]):
HistoryTreePolicyTopicResult {
  const rawSupport = new Map<string, number>();
  let rawAssignments = 0;
  for (const record of records) {
    rawAssignments += record.labels.length;
    for (const label of record.labels) {
      const key = topicPolicyKey(record.scopeFingerprint, label);
      rawSupport.set(key, (rawSupport.get(key) ?? 0) + 1);
    }
  }
  let active = new Set([...rawSupport]
    .filter(([, support]) => support >= 2)
    .map(([key]) => key));
  const rawTargetsAtMinimumSupport = active.size;
  let iterations = 0;
  let selectedByRecord = new Map<string, readonly string[]>();
  let selectedSupport = new Map<string, number>();
  if (records.length > 0) {
    while (true) {
      iterations += 1;
      selectedByRecord = new Map();
      selectedSupport = new Map();
      for (const record of records) {
        const labels = record.labels
          .filter((label) => active.has(topicPolicyKey(record.scopeFingerprint, label)))
          .sort((left, right) =>
            (rawSupport.get(topicPolicyKey(record.scopeFingerprint, right))! -
              rawSupport.get(topicPolicyKey(record.scopeFingerprint, left))!) ||
            left.localeCompare(right))
          .slice(0, 3);
        selectedByRecord.set(record.recordId, Object.freeze(labels));
        for (const label of labels) {
          const key = topicPolicyKey(record.scopeFingerprint, label);
          selectedSupport.set(key, (selectedSupport.get(key) ?? 0) + 1);
        }
      }
      const next = new Set([...active]
        .filter((key) => (selectedSupport.get(key) ?? 0) >= 2));
      if (next.size === active.size && [...next].every((key) => active.has(key))) break;
      active = next;
    }
  }
  const taxonomyByScope = new Map<string, Array<{
    canonicalLabel: string;
    aliases: readonly string[];
    support: number;
  }>>();
  for (const key of [...active].sort()) {
    const separator = key.indexOf("\0");
    const scopeFingerprint = key.slice(0, separator);
    const canonicalLabel = key.slice(separator + 1);
    const entries = taxonomyByScope.get(scopeFingerprint) ?? [];
    entries.push(Object.freeze({
      canonicalLabel,
      aliases: Object.freeze([]),
      support: rawSupport.get(key)!,
    }));
    taxonomyByScope.set(scopeFingerprint, entries);
  }
  return Object.freeze({
    taxonomyByScope,
    planEligible: records.length,
    rawAssignments,
    rawTargetsAtMinimumSupport,
    retainedRecords: [...selectedByRecord.values()].filter((labels) => labels.length > 0).length,
    retainedAssignments: [...selectedByRecord.values()]
      .reduce((total, labels) => total + labels.length, 0),
    targetCount: selectedSupport.size,
    singletonTargets: [...selectedSupport.values()].filter((support) => support === 1).length,
    minimumTargetLeaves: selectedSupport.size > 0
      ? Math.min(...selectedSupport.values()) : 0,
    maximumTargetLeaves: selectedSupport.size > 0
      ? Math.max(...selectedSupport.values()) : 0,
    iterations,
  });
}

interface HistoryTreePolicyAuditedSource {
  readonly recordId: string;
  readonly migrationId: string;
  readonly runId: string;
  readonly scopeFingerprint: string;
  readonly legacySourceHash: string;
  readonly planReceiptHash: string;
  readonly planDisposition: string;
}

function auditedHistorySource(value: Readonly<Record<string, unknown>>):
HistoryTreePolicyAuditedSource | undefined {
  const recordId = stringField(value.record_id);
  const migrationId = stringField(value.migration_id);
  const runId = stringField(value.run_id);
  const scopeFingerprint = stringField(value.scope_fingerprint);
  const legacySourceHash = stringField(value.legacy_source_hash);
  const planReceiptHash = stringField(value.plan_receipt_hash);
  const planDisposition = stringField(value.plan_disposition);
  if (!recordId || !SAFE_ID.test(recordId) || !migrationId || !SAFE_ID.test(migrationId) ||
      !runId || !SAFE_ID.test(runId) || !scopeFingerprint || !SHA256.test(scopeFingerprint) ||
      !legacySourceHash || !SHA256.test(legacySourceHash) ||
      !planReceiptHash || !SHA256.test(planReceiptHash) || !planDisposition ||
      planDisposition === "lookup_only" || planDisposition === "quarantine") {
    return undefined;
  }
  return Object.freeze({
    recordId, migrationId, runId, scopeFingerprint,
    legacySourceHash, planReceiptHash, planDisposition,
  });
}

interface HistoryTreePolicySourceResult {
  readonly identitiesByScope: ReadonlyMap<string, readonly HistoryRebuildSourceIdentityFact[]>;
  readonly planEligible: number;
  readonly directSessionRecords: number;
  readonly auditedRecords: number;
  readonly targetCount: number;
  readonly minimumTargetLeaves: number;
  readonly maximumTargetLeaves: number;
  readonly singletonDowngraded: number;
  readonly priorLookupOnlyDowngraded: number;
  readonly missingAuditableIdentity: number;
}

function sourcePolicyFacts(
  rows: readonly HistoryRebuildScanRow[],
  plans: readonly HistoryRebuildPlan[],
  auditedRows: readonly Readonly<Record<string, unknown>>[],
): HistoryTreePolicySourceResult {
  const auditedByRecord = new Map<string, HistoryTreePolicyAuditedSource>();
  for (const raw of auditedRows) {
    const audited = auditedHistorySource(raw);
    if (!audited) fail("HISTORY_REBUILD_SOURCE_DRIFT");
    if (auditedByRecord.has(audited.recordId)) fail("HISTORY_REBUILD_SOURCE_DRIFT");
    auditedByRecord.set(audited.recordId, audited);
  }
  const plansByRecord = new Map(plans.map((plan) => [
    `${plan.sourceTable}\0${plan.recordId}`, plan,
  ]));
  const groups = new Map<string, Array<{
    scopeFingerprint: string;
    identity: string;
    fact: HistoryRebuildSourceIdentityFact;
  }>>();
  const directTargets = new Map<string, number>();
  let planEligible = 0;
  let directSessionRecords = 0;
  let priorLookupOnlyDowngraded = 0;
  let missingAuditableIdentity = 0;
  for (const row of rows) {
    if (row.sourceTable !== "memories") continue;
    const plan = plansByRecord.get(`${row.sourceTable}\0${row.recordId}`);
    const history = objectField(row.metadata.historyRebuild);
    if (history.disposition === "lookup_only" || row.metadata.admissionRoute === "lookup_only") {
      priorLookupOnlyDowngraded += 1;
      continue;
    }
    if (!plan?.treeEligibility.source) continue;
    planEligible += 1;
    const scopeFingerprint = authorityScopeFingerprint(row.scope);
    if (row.scope.sessionId !== undefined) {
      directSessionRecords += 1;
      const target = `${scopeFingerprint}\0${row.scope.sessionId}`;
      directTargets.set(target, (directTargets.get(target) ?? 0) + 1);
      continue;
    }
    if (history.disposition === "quarantine") {
      continue;
    }
    const audited = auditedByRecord.get(row.recordId);
    if (!audited) {
      missingAuditableIdentity += 1;
      continue;
    }
    if (audited.scopeFingerprint !== scopeFingerprint || history.runId !== audited.runId ||
        history.sourceHash !== audited.legacySourceHash ||
        history.planReceiptHash !== audited.planReceiptHash) {
      fail("HISTORY_REBUILD_SOURCE_DRIFT");
    }
    // run_id is globally unique; keeping migrationId only in the receipt avoids
    // exceeding the v2 audited identity length when both IDs are near their limit.
    const identity = `history-import:${audited.runId}`;
    const receiptHash = taggedHash("mengshu.history-rebuild-source-identity-receipt/v1", {
      version: 1,
      scopeFingerprint,
      recordId: row.recordId,
      sourceHash: row.sourceHash,
      kind: "import_batch",
      identity,
      legacy: {
        migrationId: audited.migrationId,
        runId: audited.runId,
        sourceHash: audited.legacySourceHash,
        planReceiptHash: audited.planReceiptHash,
      },
    });
    const groupKey = `${scopeFingerprint}\0${identity}`;
    const group = groups.get(groupKey) ?? [];
    group.push({
      scopeFingerprint,
      identity,
      fact: Object.freeze({
        recordId: row.recordId,
        sourceHash: row.sourceHash,
        kind: "import_batch",
        identity,
        receiptHash,
      }),
    });
    groups.set(groupKey, group);
  }
  const identitiesByScope = new Map<string, HistoryRebuildSourceIdentityFact[]>();
  let singletonDowngraded = 0;
  let acceptedTargets = 0;
  let acceptedRecords = 0;
  const acceptedTargetLeaves: number[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) {
      singletonDowngraded += group.length;
      continue;
    }
    acceptedTargets += 1;
    acceptedRecords += group.length;
    acceptedTargetLeaves.push(group.length);
    for (const entry of group) {
      const identities = identitiesByScope.get(entry.scopeFingerprint) ?? [];
      identities.push(entry.fact);
      identitiesByScope.set(entry.scopeFingerprint, identities);
    }
  }
  acceptedTargetLeaves.push(...directTargets.values());
  for (const identities of identitiesByScope.values()) {
    identities.sort((left, right) =>
      left.recordId.localeCompare(right.recordId) || left.sourceHash.localeCompare(right.sourceHash));
  }
  return Object.freeze({
    identitiesByScope,
    planEligible,
    directSessionRecords,
    auditedRecords: acceptedRecords + directSessionRecords,
    targetCount: acceptedTargets + directTargets.size,
    minimumTargetLeaves: acceptedTargetLeaves.length > 0
      ? Math.min(...acceptedTargetLeaves) : 0,
    maximumTargetLeaves: acceptedTargetLeaves.length > 0
      ? Math.max(...acceptedTargetLeaves) : 0,
    singletonDowngraded,
    priorLookupOnlyDowngraded,
    missingAuditableIdentity,
  });
}

export async function generateHistoryRebuildTreePolicy(
  argv: readonly string[],
  dependencies: HistoryRebuildOperatorDependencies = createHistoryRebuildOperatorDependencies(),
): Promise<Record<string, unknown>> {
  const configPath = requiredCliValue(argv, "--config");
  const outputPath = requiredCliValue(argv, "--generate-tree-policy");
  const auditPath = requiredCliValue(argv, "--audit-report");
  if (outputPath === auditPath) fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  const valueFlags = ["--config", "--generate-tree-policy", "--audit-report"];
  if (argv.length !== valueFlags.length * 2 || valueFlags.some((flag) =>
    argv.filter((value) => value === flag).length !== 1) ||
      existsSync(outputPath) || existsSync(auditPath)) {
    fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  }
  let config: unknown;
  try {
    config = dependencies.parseConfig(dependencies.readText(configPath));
  } catch {
    fail("HISTORY_REBUILD_INVALID_CONFIG");
  }
  const connection = await dependencies.connect(config)
    .catch(() => fail("HISTORY_REBUILD_CONNECTION_FAILED"));
  let bundleText: string;
  let auditText: string;
  let result: Record<string, unknown>;
  try {
    await connection.client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    try {
      const scanned = await connection.client.query(HISTORY_SCAN_SQL, [
        `tree-policy-generation-${randomUUID()}`, "0".repeat(64),
      ]);
      const rows = (scanned.rows ?? []).map((row) => scanRow(row));
      const plans = rows.map((row) => planHistoryRebuild(row));
      const scopes = new Set<string>();
      const topicRecords: HistoryTreePolicyTopicRecord[] = [];
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index]!;
        const plan = plans[index]!;
        const scopeFingerprint = authorityScopeFingerprint(row.scope);
        scopes.add(scopeFingerprint);
        if (row.sourceTable === "memories" && plan.treeEligibility.topic) {
          topicRecords.push(Object.freeze({
            recordId: row.recordId,
            scopeFingerprint,
            labels: Object.freeze([...new Set(plan.topicLabels
              .map((label) => normalizeTopicLabel(label)).filter(Boolean))]),
          }));
        }
      }
      const topic = topicPolicyFixedPoint(topicRecords);
      const sourceAudit = await connection.client.query(HISTORY_TREE_POLICY_SOURCE_AUDIT_SQL);
      const source = sourcePolicyFacts(rows, plans, sourceAudit.rows ?? []);
      const policies = [...scopes].sort().map((scopeFingerprint) => Object.freeze({
        version: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
        scopeFingerprint,
        topic: Object.freeze({
          version: HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION,
          minimumSupport: 2,
          maxLabelsPerRecord: 3 as const,
          taxonomy: Object.freeze([...(topic.taxonomyByScope.get(scopeFingerprint) ?? [])]),
        }),
        source: Object.freeze({
          version: HISTORY_REBUILD_SOURCE_IDENTITY_VERSION,
          identities: Object.freeze([...(source.identitiesByScope.get(scopeFingerprint) ?? [])]),
        }),
      }));
      const bundle: HistoryRebuildTreePolicyBundle = Object.freeze({
        version: 1,
        policyVersion: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
        topicTaxonomyVersion: HISTORY_REBUILD_TOPIC_TAXONOMY_VERSION,
        sourceIdentityVersion: HISTORY_REBUILD_SOURCE_IDENTITY_VERSION,
        policies: Object.freeze(policies),
      });
      bundleText = `${JSON.stringify(bundle, null, 2)}\n`;
      const loaded = loadHistoryRebuildTreePolicyBundle(bundleText);
      const sourceSnapshotSha256 = createHash("sha256").update(rows.map((row) =>
        `${row.sourceTable}\u001f${row.recordId}\u001f${row.sourceHash}`).join("\n")).digest("hex");
      const policyHashes = policies.map((policy) => Object.freeze({
        scopeFingerprint: policy.scopeFingerprint,
        policyHash: historyRebuildTreeRoutingPolicyHash(policy),
      }));
      const emptyPolicies = policies.filter((policy) =>
        policy.topic.taxonomy.length === 0 && policy.source.identities.length === 0).length;
      const audit: HistoryRebuildTreePolicyAuditReport = Object.freeze({
        version: 1,
        policyVersion: HISTORY_REBUILD_TREE_ROUTING_POLICY_VERSION,
        bundleSha256: loaded.sha256,
        sourceSnapshotSha256,
        sourceCount: rows.length,
        scopes: policies.length,
        emptyPolicies,
        topic: Object.freeze({
          planEligible: topic.planEligible,
          rawAssignments: topic.rawAssignments,
          rawTargetsAtMinimumSupport: topic.rawTargetsAtMinimumSupport,
          retainedRecords: topic.retainedRecords,
          retainedAssignments: topic.retainedAssignments,
          targetCount: topic.targetCount,
          singletonTargets: topic.singletonTargets,
          minimumTargetLeaves: topic.minimumTargetLeaves,
          maximumTargetLeaves: topic.maximumTargetLeaves,
          iterations: topic.iterations,
        }),
        source: Object.freeze({
          planEligible: source.planEligible,
          directSessionRecords: source.directSessionRecords,
          auditedRecords: source.auditedRecords,
          targetCount: source.targetCount,
          minimumTargetLeaves: source.minimumTargetLeaves,
          maximumTargetLeaves: source.maximumTargetLeaves,
          singletonDowngraded: source.singletonDowngraded,
          priorLookupOnlyDowngraded: source.priorLookupOnlyDowngraded,
          missingAuditableIdentity: source.missingAuditableIdentity,
        }),
        policyHashes: Object.freeze(policyHashes),
      });
      auditText = `${JSON.stringify(audit, null, 2)}\n`;
      result = Object.freeze({
        operation: "generate-tree-policy",
        sourceCount: rows.length,
        scopes: policies.length,
        bundleSha256: loaded.sha256,
        sourceSnapshotSha256,
      });
      await connection.client.query("ROLLBACK");
    } catch (error) {
      await connection.client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof HistoryRebuildOperatorError) throw error;
      fail("HISTORY_REBUILD_PLANNING_FAILED");
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
  let bundleWritten = false;
  let auditWritten = false;
  try {
    writeFileSync(outputPath, bundleText!, { encoding: "utf8", flag: "wx", mode: 0o600 });
    bundleWritten = true;
    writeFileSync(auditPath, auditText!, { encoding: "utf8", flag: "wx", mode: 0o600 });
    auditWritten = true;
  } catch {
    if (auditWritten) {
      try { unlinkSync(auditPath); } catch { /* best-effort cleanup of this invocation */ }
    }
    if (bundleWritten) {
      try { unlinkSync(outputPath); } catch { /* best-effort cleanup of this invocation */ }
    }
    fail("HISTORY_REBUILD_PLANNING_FAILED");
  }
  return result!;
}

export async function prepareHistoryRebuildManifest(
  argv: readonly string[],
  dependencies: HistoryRebuildOperatorDependencies = createHistoryRebuildOperatorDependencies(),
): Promise<Record<string, unknown>> {
  const configPath = requiredCliValue(argv, "--config");
  const outputPath = requiredCliValue(argv, "--prepare-manifest");
  const migrationId = requiredCliValue(argv, "--migration-id");
  const remoteEgress = requiredCliValue(argv, "--remote-egress");
  if (remoteEgress !== "deny" && remoteEgress !== "redacted-only") {
    fail("HISTORY_REBUILD_INVALID_ARGUMENTS");
  }
  let config: MemoryConfig;
  try {
    config = dependencies.parseConfig(dependencies.readText(configPath)) as MemoryConfig;
  } catch {
    fail("HISTORY_REBUILD_INVALID_CONFIG");
  }
  const connection = await dependencies.connect(config)
    .catch(() => fail("HISTORY_REBUILD_CONNECTION_FAILED"));
  try {
    await connection.client.query("BEGIN READ ONLY");
    try {
      await dependencies.assertSchemaVersion({
        client: connection.client,
        manifest: { requiredSchemaVersion: 24 } as HistoryRebuildManifest,
        manifestSha256: "0".repeat(64), modelAssisted: false, operatorConfig: config,
      });
      const result = await connection.client.query(PREPARE_SNAPSHOT_SQL);
      const row = result.rows?.[0];
      const sourceCount = typeof row?.source_count === "string" && /^\d+$/.test(row.source_count)
        ? Number(row.source_count) : Number.NaN;
      const snapshotSha256 = row?.snapshot_sha256;
      if (!safeInteger(sourceCount) || typeof snapshotSha256 !== "string" ||
          !SHA256.test(snapshotSha256)) fail("HISTORY_REBUILD_SOURCE_DRIFT");
      const manifest = buildPreparedHistoryRebuildManifest({
        migrationId,
        snapshot: { sourceCount, snapshotSha256, parserVersions: ["postgres-history-v24"] },
        config,
        policy: {
          budget: {
            maxRecords: requiredCliInteger(argv, "--max-records"),
            maxModelCalls: requiredCliInteger(argv, "--max-model-calls"),
            maxInputTokens: requiredCliInteger(argv, "--max-input-tokens"),
            maxOutputTokens: requiredCliInteger(argv, "--max-output-tokens"),
            maxCostMinorUnits: requiredCliInteger(argv, "--max-cost-minor-units"),
            currency: requiredCliValue(argv, "--currency"),
            pricingSnapshotVersion: requiredCliValue(argv, "--pricing-snapshot-version"),
            inputCostPerMillionTokens: requiredCliInteger(
              argv, "--input-cost-per-million-tokens",
            ),
            outputCostPerMillionTokens: requiredCliInteger(
              argv, "--output-cost-per-million-tokens",
            ),
          },
          remoteEgress,
          treePolicyVersion: requiredCliValue(argv, "--tree-policy-version"),
          topicLabelVersion: requiredCliValue(argv, "--topic-label-version"),
          treePolicyBundleSha256: requiredCliValue(argv, "--tree-policy-bundle-sha256"),
        },
      });
      const text = `${JSON.stringify(manifest, null, 2)}\n`;
      writeFileSync(outputPath, text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await connection.client.query("ROLLBACK");
      return {
        operation: "prepare-manifest", outputPath, sourceCount, snapshotSha256,
        manifestSha256: createHash("sha256").update(text).digest("hex"),
      };
    } catch (error) {
      await connection.client.query("ROLLBACK").catch(() => undefined);
      if (error instanceof HistoryRebuildOperatorError) throw error;
      fail("HISTORY_REBUILD_PLANNING_FAILED");
    }
  } finally {
    await connection.close().catch(() => undefined);
  }
}

export async function runHistoryRebuildCli(
  argv: readonly string[],
  dependencies: HistoryRebuildOperatorDependencies = createHistoryRebuildOperatorDependencies(),
): Promise<Record<string, unknown>> {
  return argv.includes("--generate-tree-policy")
    ? generateHistoryRebuildTreePolicy(argv, dependencies)
    : argv.includes("--prepare-manifest")
    ? prepareHistoryRebuildManifest(argv, dependencies)
    : runHistoryRebuildOperator(argv, dependencies);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHistoryRebuildCli(process.argv.slice(2))
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      const output = error instanceof HistoryRebuildOperatorError
        ? { code: error.code, message: error.message }
        : { code: "HISTORY_REBUILD_PLANNING_FAILED", message: ERROR_MESSAGES.HISTORY_REBUILD_PLANNING_FAILED };
      process.stderr.write(`${JSON.stringify(output)}\n`);
      process.exitCode = 1;
    });
}
