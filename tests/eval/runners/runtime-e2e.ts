import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import path from "node:path";

import pg from "pg";

import type { MemoryKind, MemorySemanticType, RecallHit } from
  "../../../packages/core/src/domain/types.js";
import { isRecallScoreBreakdown, type CompleteRecallScoreBreakdown } from
  "../../../packages/core/src/domain/recall-scoring.js";
import { SCORING_WEIGHTS_V1 } from
  "../../../packages/core/src/scoring/scoring-weights.js";
import { normalizeTopicLabel } from
  "../../../packages/core/src/tree/tree-fan-out.js";
import {
  routeLeaf,
  type LeafRoutingInput,
} from "../../../packages/core/src/tree/leaf-routing.js";
import type { MemoryTreeType } from "../../../packages/core/src/tree/types.js";
import { recencyDecay, TOPIC_CREATION_THRESHOLD } from
  "../../../packages/core/src/tree/topic.js";
import {
  createMetric,
  REQUIRED_PRODUCTION_STAGES,
  sameCompleteRecallBreakdowns,
} from "./eval-metrics.js";
import type {
  CaseResult,
  ProductionPendingCandidateReceipt,
  ProductionRuntimeStage,
  ProductionSealedSummaryReceipt,
  ProductionStageEvidence,
  SuiteSummary,
} from "./types.js";

const { Client } = pg;
const CANDIDATE_EFFECT_KEY = "extract_candidate.persist.v1" as const;
const GRAPH_EFFECT_KEY = "extract_graph.persist.v1" as const;
const TREE_EFFECT_KEY = "build_tree.persist.v1" as const;
const SEMANTIC_TYPES: readonly MemorySemanticType[] = [
  "profile", "task_context", "rules", "experience", "resource",
];
const MEMORY_KINDS = new Set<MemoryKind>([
  "preference", "decision", "entity", "fact", "task", "plan", "goal",
  "document", "knowledge", "observation", "other",
]);
const SEMANTIC_TYPE_SET = new Set<MemorySemanticType>(SEMANTIC_TYPES);

type RuntimeTreeRoutingFacts = Omit<LeafRoutingInput, "hasTopicLabel">;

export function expectedRuntimeTreeTypes(
  routing: RuntimeTreeRoutingFacts,
  hasEligibleTopic: boolean,
): MemoryTreeType[] {
  return [...routeLeaf({ ...routing, hasTopicLabel: hasEligibleTopic }).treeTypes].sort();
}

export interface RuntimeE2ePostgresConfig {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
}

export interface ProductionRestRuntimeE2eOptions {
  readonly postgres: RuntimeE2ePostgresConfig;
  readonly configPath: string;
  readonly embeddingModel: string;
  readonly extractionModel: string;
  readonly projectRoot?: string;
  readonly timeoutMs?: number;
  /** Test-only, redacted progress evidence for diagnosing an outer live-gate timeout. */
  readonly onProgress?: (evidence: RuntimeE2eProgressEvidence) => void;
}

export const RUNTIME_E2E_PROGRESS_STAGES = Object.freeze([
  "initial_graph_tree",
  "slot_save",
  "seal_save",
  "sealed_summary_ready",
  "restart_replay",
] as const);

export type RuntimeE2eProgressStage = (typeof RUNTIME_E2E_PROGRESS_STAGES)[number];

export interface RuntimeE2eProgressEvidence {
  readonly stage: RuntimeE2eProgressStage;
  readonly completed: number;
  readonly total: number;
}

const RUNTIME_E2E_PROGRESS_STAGE_SET = new Set<RuntimeE2eProgressStage>(
  RUNTIME_E2E_PROGRESS_STAGES,
);

function validateRuntimeE2eProgressEvidence(value: unknown): RuntimeE2eProgressEvidence {
  if (!plainObject(value) || Object.keys(value).length !== 3 ||
      !Object.prototype.hasOwnProperty.call(value, "stage") ||
      !Object.prototype.hasOwnProperty.call(value, "completed") ||
      !Object.prototype.hasOwnProperty.call(value, "total") ||
      !RUNTIME_E2E_PROGRESS_STAGE_SET.has(value.stage as RuntimeE2eProgressStage) ||
      !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) ||
      Number(value.completed) < 0 || Number(value.total) < 1 ||
      Number(value.completed) > Number(value.total)) {
    throw new Error("runtime-e2e progress evidence is invalid");
  }
  return Object.freeze({
    stage: value.stage as RuntimeE2eProgressStage,
    completed: Number(value.completed),
    total: Number(value.total),
  });
}

export function createRuntimeE2eProgressReporter(
  writeLine: (line: string) => void,
): (evidence: RuntimeE2eProgressEvidence) => void {
  if (typeof writeLine !== "function") {
    throw new Error("runtime-e2e progress writer is invalid");
  }
  return (evidence) => {
    const valid = validateRuntimeE2eProgressEvidence(evidence);
    writeLine(`[runtime-e2e-progress] ${valid.stage} ${valid.completed}/${valid.total}`);
  };
}

function progress(
  options: ProductionRestRuntimeE2eOptions,
  stage: RuntimeE2eProgressStage,
  completed: number,
  total: number,
): void {
  if (!options.onProgress) return;
  options.onProgress(validateRuntimeE2eProgressEvidence({ stage, completed, total }));
}

interface RuntimeRestCase {
  readonly id: string;
  readonly suite: "mengshu-runtime-rest";
  readonly productionContract: {
    readonly requiredStages: readonly ProductionRuntimeStage[];
    readonly evidencePolicy: "runtime-observed-receipts-only";
  };
  readonly input: {
    readonly observations: readonly [
      Readonly<{ text: string; idempotencyKey: string }>,
      Readonly<{ text: string; idempotencyKey: string }>,
    ];
    readonly pendingObservation: Readonly<{ text: string; idempotencyKey: string }>;
    readonly sealedSourceMemories: ReadonlyArray<Readonly<{
      text: string;
      idempotencyKey: string;
      metadata: Readonly<{ salience: 0.3 }>;
    }>>;
    readonly slotMemories: ReadonlyArray<Readonly<{
      text: string;
      kind: MemoryKind;
      semanticType: MemorySemanticType;
      idempotencyKey: string;
      metadata?: Readonly<Record<string, unknown>>;
    }>>;
    readonly query: string;
    readonly pendingQuery: string;
  };
  readonly expected: {
    readonly healthOk: true;
    readonly semanticType: MemorySemanticType;
    readonly candidateEffectKey: typeof CANDIDATE_EFFECT_KEY;
    readonly graphEffectKey: typeof GRAPH_EFFECT_KEY;
    readonly treeEffectKey: typeof TREE_EFFECT_KEY;
  };
}

interface ObserveResponse {
  ack: true;
  traceId: string;
  persistedId: string;
  stored: boolean;
  recordType: "memory";
  admissionRoute: "evidence_only";
  queuedJobs: string[];
}

interface ExplicitSaveResponse {
  id: string;
  stored: true;
  status: "persisted";
  route: "active";
  recordType: "memory";
}

interface RuntimeChainEvidence {
  candidateJobId: string;
  candidateAttempts: number;
  activeMemoryId: string;
  graphJobId: string;
  graphAttempts: number;
  graphEntityIds: string[];
  graphRelationIds: string[];
  sourceTreeJobId: string;
  sourceTreeKey: string;
  globalTreeJobId: string | null;
  topicTreeJobIds: string[];
  topicTreeKeys: string[];
  sourceLeafId: string;
  globalLeafId: string | null;
  topicLeafIds: string[];
  treeBufferIds: string[];
  storageKey: string;
  memoryEvidenceLinkIds: string[];
  entityEvidenceLinkIds: string[];
  relationEvidenceLinkIds: string[];
  memoryEvidenceBindings: Array<{ linkId: string; targetId: string; evidenceId: string }>;
  entityEvidenceBindings: Array<{ linkId: string; targetId: string; evidenceId: string }>;
  relationEvidenceBindings: Array<{ linkId: string; targetId: string; evidenceId: string }>;
  workMemoryNodeIds: string[];
  workMemoryActiveNodeId: string;
  workMemoryEvidenceNodeId: string;
  workMemoryEdgeIds: string[];
  workMemoryEdgeBindings: Array<{
    edgeId: string;
    predicate: "grounded_by";
    sourceId: string;
    targetId: string;
    evidenceChunkIds: string[];
  }>;
  candidateGovernance: {
    memoryKind: MemoryKind;
    semanticType: MemorySemanticType;
    admissionRoute: "active";
    lifecycleStatus: "active";
    contextEligible: true;
    valueScore: number;
    importance: number;
    confidence: number;
    treeRouting: RuntimeTreeRoutingFacts;
    validatorAudit: Readonly<Record<string, unknown>>;
    dedupTrace: {
      created: 1;
      duplicateCount: number;
      capacityRejectedCount: number;
      droppedCount: number;
      candidateIds: string[];
      memoryIds: string[];
      activeMemoryIds: string[];
    };
  };
  effectReceiptIds: string[];
  ledgerIds: string[];
  treeBufferBindings: Array<{
    jobId: string;
    treeType: "source" | "global" | "topic";
    treeKey: string;
    bufferId: string;
    leafId: string;
  }>;
  exactJobCounts: {
    candidate: number;
    graph: number;
    sourceTree: number;
    globalTree: number;
  };
  expectedTreeTypes: MemoryTreeType[];
}

interface RuntimePendingCandidateEvidence extends ProductionPendingCandidateReceipt {
  candidateAttempts: number;
}

interface RuntimeSealedSummaryEvidence extends ProductionSealedSummaryReceipt {
  jobAttempts: number;
}

export interface RuntimeHotnessEvidence {
  readonly topicEntityId: string;
  readonly canonicalName: string;
  readonly mentionCount30d: number;
  readonly distinctSourceCount: number;
  readonly lastSeenAt: number;
  readonly recencyDecay: number;
  readonly graphCentrality: number;
  readonly queryHits30d: number;
  readonly score: number;
}

export function selectColdHotnessWitness(
  candidates: readonly RuntimeHotnessEvidence[],
  graphReceiptEntityIds: readonly string[],
  observationText: string,
): RuntimeHotnessEvidence | undefined {
  const receiptIds = new Set(graphReceiptEntityIds);
  const normalizedText = observationText.toLocaleLowerCase();
  return candidates
    .filter((candidate) => candidate.score < TOPIC_CREATION_THRESHOLD &&
      receiptIds.has(candidate.topicEntityId) &&
      candidate.canonicalName.trim().length > 0 &&
      normalizedText.includes(candidate.canonicalName.toLocaleLowerCase()))
    .sort((left, right) => right.score - left.score ||
      left.topicEntityId.localeCompare(right.topicEntityId))[0];
}

export function canonicalTopicKeysSettled(
  actualKeys: readonly string[],
  expectedKeys: readonly string[],
): boolean {
  if (expectedKeys.length === 0 || actualKeys.some((key) => key.length === 0) ||
      expectedKeys.some((key) => key.length === 0)) return false;
  return JSON.stringify([...new Set(actualKeys)].sort()) ===
    JSON.stringify([...new Set(expectedKeys)].sort()) &&
    new Set(actualKeys).size === actualKeys.length &&
    new Set(expectedKeys).size === expectedKeys.length;
}

export function selectHotMultisourceWitness(
  hotTopic: RuntimeHotnessEvidence,
  actualTopicKeys: readonly string[],
): RuntimeHotnessEvidence | undefined {
  const canonicalKey = normalizeTopicLabel(hotTopic.canonicalName);
  return hotTopic.score >= TOPIC_CREATION_THRESHOLD && canonicalKey.length > 0 &&
      actualTopicKeys.includes(canonicalKey)
    ? hotTopic
    : undefined;
}

interface RuntimeE2eScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: "private";
  readonly workspaceId: string;
  readonly sessionId: string;
}

function createRuntimeIsolation(): { readonly scope: RuntimeE2eScope } {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return Object.freeze({
    scope: Object.freeze({
      tenantId: "eval-tenant",
      userId: "eval-user",
      appId: "mengshu",
      projectId: `runtime-e2e-${suffix}`,
      agentId: "codex",
      namespace: `working-context-${suffix}`,
      visibility: "private" as const,
      workspaceId: `eval-workspace-${suffix}`,
      sessionId: `eval-session-${suffix}`,
    }),
  });
}

export function parseRuntimeRestFixture(fixturePath: string): RuntimeRestCase {
  const lines = readFileSync(fixturePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new Error("runtime-e2e fixture must contain exactly one case");
  const value = JSON.parse(lines[0]!) as Partial<RuntimeRestCase>;
  const requiredStages = value.productionContract?.requiredStages;
  const observations = value.input?.observations;
  const pendingObservation = value.input?.pendingObservation;
  const sealedSourceMemories = value.input?.sealedSourceMemories;
  const slotMemories = value.input?.slotMemories;
  if (value.id !== "runtime-rest-001" || value.suite !== "mengshu-runtime-rest" ||
      !Array.isArray(requiredStages) ||
      requiredStages.length !== REQUIRED_PRODUCTION_STAGES.length ||
      REQUIRED_PRODUCTION_STAGES.some((stage, index) => requiredStages[index] !== stage) ||
      value.productionContract?.evidencePolicy !== "runtime-observed-receipts-only" ||
      !Array.isArray(observations) || observations.length !== 2 ||
      observations.some((item) => !item || typeof item.text !== "string" ||
        item.text.trim().length < 50 || typeof item.idempotencyKey !== "string" ||
        item.idempotencyKey.trim().length === 0) ||
      observations[0]!.idempotencyKey === observations[1]!.idempotencyKey ||
      !pendingObservation || typeof pendingObservation.text !== "string" ||
      pendingObservation.text.trim().length < 50 ||
      typeof pendingObservation.idempotencyKey !== "string" ||
      pendingObservation.idempotencyKey.trim().length === 0 ||
      observations.some(({ idempotencyKey }) => idempotencyKey === pendingObservation.idempotencyKey) ||
      !Array.isArray(sealedSourceMemories) || sealedSourceMemories.length !== 20 ||
      sealedSourceMemories.some((item, index) => !item ||
        typeof item.text !== "string" || item.text.trim().length < 50 ||
        !item.text.includes(`F0_SEAL_${String(index + 1).padStart(2, "0")}`) ||
        typeof item.idempotencyKey !== "string" || item.idempotencyKey.trim().length === 0 ||
        item.metadata?.salience !== 0.3) ||
      new Set(sealedSourceMemories.map(({ text }) => text)).size !== 20 ||
      new Set(sealedSourceMemories.map(({ idempotencyKey }) => idempotencyKey)).size !== 20 ||
      sealedSourceMemories.some(({ idempotencyKey }) =>
        observations.some((item) => item.idempotencyKey === idempotencyKey) ||
        pendingObservation.idempotencyKey === idempotencyKey) ||
      !Array.isArray(slotMemories) || slotMemories.length !== SEMANTIC_TYPES.length ||
      slotMemories.some((item, index) => !item || item.semanticType !== SEMANTIC_TYPES[index] ||
        !MEMORY_KINDS.has(item.kind) || typeof item.text !== "string" || item.text.trim().length < 8 ||
        typeof item.idempotencyKey !== "string" || item.idempotencyKey.trim().length === 0) ||
      new Set(slotMemories.map(({ idempotencyKey }) => idempotencyKey)).size !== slotMemories.length ||
      typeof value.input?.query !== "string" || value.input.query.trim().length === 0 ||
      typeof value.input?.pendingQuery !== "string" || value.input.pendingQuery.trim().length === 0 ||
      value.expected?.healthOk !== true ||
      !SEMANTIC_TYPE_SET.has(value.expected.semanticType as MemorySemanticType) ||
      value.expected.candidateEffectKey !== CANDIDATE_EFFECT_KEY ||
      value.expected.graphEffectKey !== GRAPH_EFFECT_KEY ||
      value.expected.treeEffectKey !== TREE_EFFECT_KEY) {
    throw new Error("runtime-e2e fixture contract is invalid");
  }
  const { treeTypes: _deprecatedTreeTypes, ...expected } = value.expected as
    RuntimeRestCase["expected"] & { readonly treeTypes?: readonly MemoryTreeType[] };
  return Object.freeze({
    ...value,
    expected: Object.freeze(expected),
  }) as RuntimeRestCase;
}

async function reservePort(): Promise<number> {
  const listener = createNetServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => error ? reject(error) : resolve());
  });
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error("runtime-e2e could not reserve a local port");
  }
  return port;
}

function authorityConfig(scope: RuntimeE2eScope) {
  return {
    authority: {
      tenantId: scope.tenantId,
      userId: scope.userId,
      allow: {
        appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId],
        namespaces: [scope.namespace], visibilities: [scope.visibility],
      },
    },
    defaultScope: { ...scope },
  };
}

function clientScope(scope: RuntimeE2eScope) {
  return {
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
  };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function spawnProductionServe(
  projectRoot: string,
  configPath: string,
  port: number,
  scope: RuntimeE2eScope,
) {
  const child = spawn(
    path.join(projectRoot, "node_modules/.bin/tsx"),
    [path.join(projectRoot, "bin/ms.ts"), "serve", "--host", "127.0.0.1", "--port", String(port)],
    {
      cwd: projectRoot,
      env: {
        ...process.env, MENGSHU_CONFIG: configPath,
        MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig(scope)), MENGSHU_AUTHORITY_FILE: "",
        NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1",
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.pipe(process.stderr);
  return child;
}

async function waitForHealth(
  child: ChildProcessWithoutNullStreams,
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; records?: number }> {
  const deadline = Date.now() + timeoutMs;
  let exited = false;
  child.once("exit", () => { exited = true; });
  while (Date.now() < deadline) {
    if (exited) throw new Error("production ms serve exited before REST readiness");
    try {
      const response = await fetch(`${url}/v1/health`);
      if (response.ok) return await response.json() as { ok: boolean; records?: number };
    } catch {
      // Production listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("production ms serve REST readiness timed out");
}

async function postJson<T>(url: string, pathName: string, body: unknown): Promise<T> {
  const response = await fetch(`${url}${pathName}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json() as T;
  if (!response.ok) {
    const detail = plainObject(result)
      ? [result.error, result.code].filter((value) => typeof value === "string").join("/")
      : "";
    throw new Error(`production REST ${pathName} failed with ${response.status}${
      detail.length === 0 ? "" : `: ${detail}`
    }`);
  }
  return result;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function exactStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || item.length === 0) ||
      new Set(value).size !== value.length) return undefined;
  return value as string[];
}

function evidenceBindings(value: unknown): RuntimeChainEvidence["memoryEvidenceBindings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => plainObject(item) &&
      typeof item.linkId === "string" && typeof item.targetId === "string" &&
      typeof item.evidenceId === "string"
    ? [{ linkId: item.linkId, targetId: item.targetId, evidenceId: item.evidenceId }]
    : []);
  return result.length === value.length && new Set(result.map(({ linkId }) => linkId)).size === result.length
    ? result
    : undefined;
}

function treeBufferBindings(value: unknown): RuntimeChainEvidence["treeBufferBindings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result: RuntimeChainEvidence["treeBufferBindings"] = value.flatMap((item) => plainObject(item) &&
      typeof item.jobId === "string" &&
      (item.treeType === "source" || item.treeType === "global" || item.treeType === "topic") &&
      typeof item.treeKey === "string" && typeof item.bufferId === "string" &&
      typeof item.leafId === "string"
    ? [{
        jobId: item.jobId,
        treeType: item.treeType as "source" | "global" | "topic",
        treeKey: item.treeKey,
        bufferId: item.bufferId, leafId: item.leafId,
      }]
    : []);
  return result.length === value.length &&
      new Set(result.map(({ jobId }) => jobId)).size === result.length &&
      new Set(result.map(({ bufferId }) => bufferId)).size === result.length
    ? result
    : undefined;
}

function workMemoryEdgeBindings(
  value: unknown,
): RuntimeChainEvidence["workMemoryEdgeBindings"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.flatMap((item) => plainObject(item) &&
      typeof item.edgeId === "string" && item.predicate === "grounded_by" &&
      typeof item.sourceId === "string" && typeof item.targetId === "string" &&
      Array.isArray(item.evidenceChunkIds) &&
      item.evidenceChunkIds.every((id) => typeof id === "string")
    ? [{
        edgeId: item.edgeId, predicate: "grounded_by" as const,
        sourceId: item.sourceId, targetId: item.targetId,
        evidenceChunkIds: item.evidenceChunkIds as string[],
      }]
    : []);
  return result.length === value.length &&
      new Set(result.map(({ edgeId }) => edgeId)).size === result.length
    ? result
    : undefined;
}

function acceptedProposalReceipts(value: unknown): ProductionPendingCandidateReceipt["proposalReceipts"] | undefined {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  const proposal = value[0];
  if (!plainObject(proposal) || proposal.version !== 1 || proposal.outcome !== "accepted" ||
      !plainObject(proposal.validation) || !plainObject(proposal.admission) ||
      (proposal.admission.route !== "candidate" &&
        proposal.admission.route !== "candidate_low_priority")) return undefined;
  return value as ProductionPendingCandidateReceipt["proposalReceipts"];
}

async function readPendingCandidateEvidence(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  evidenceId: string,
): Promise<RuntimePendingCandidateEvidence | null> {
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT
  candidate_job.id AS candidate_job_id,
  candidate_job.attempts AS candidate_attempts,
  candidate_receipt.result AS candidate_result,
  candidate_row.id AS candidate_id,
  candidate_row.tenant_id AS candidate_tenant_id,
  candidate_row.user_id AS candidate_user_id,
  candidate_row.app_id AS candidate_app_id,
  candidate_row.project_id AS candidate_project_id,
  candidate_row.agent_id AS candidate_agent_id,
  candidate_row.namespace AS candidate_namespace,
  candidate_row.visibility AS candidate_visibility,
  candidate_row.workspace_id AS candidate_workspace_id,
  candidate_row.session_id AS candidate_session_id,
  candidate_row.status,
  candidate_row.promoted_to_memory_id,
  candidate_row.content_hash,
  candidate_row.active_content_hash,
  candidate_row.evidence_ids,
  candidate_row.kind,
  candidate_row.semantic_type,
  candidate_row.confidence,
  candidate_row.metadata,
  (SELECT count(*)::int FROM memories memory
    WHERE memory.id::text = candidate_row.id) AS memory_count,
  (SELECT count(*)::int FROM mengshu_jobs_v2 graph_job
    WHERE graph_job.type = 'extract_graph'
      AND (graph_job.payload->>'activeMemoryId' = candidate_row.id
        OR graph_job.payload->>'evidenceId' = $1)
      AND graph_job.tenant_id = $2 AND graph_job.user_id = $3
      AND graph_job.app_id = $4 AND graph_job.project_id = $5
      AND graph_job.agent_id = $6 AND graph_job.namespace = $7
      AND graph_job.visibility = $8
      AND COALESCE(graph_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(graph_job.payload #>> '{scope,sessionId}', '') = $10) AS graph_job_count,
  (SELECT count(*)::int FROM mengshu_jobs_v2 tree_job
    WHERE tree_job.type = 'build_tree'
      AND (tree_job.payload #>> '{leaf,id}' = candidate_row.id
        OR tree_job.payload #>> '{leaf,chunkId}' = $1)
      AND tree_job.tenant_id = $2 AND tree_job.user_id = $3
      AND tree_job.app_id = $4 AND tree_job.project_id = $5
      AND tree_job.agent_id = $6 AND tree_job.namespace = $7
      AND tree_job.visibility = $8
      AND COALESCE(tree_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(tree_job.payload #>> '{scope,sessionId}', '') = $10) AS tree_job_count,
  (SELECT count(*)::int FROM mengshu_tree_buffers buffer
    WHERE buffer.leaf_ids ? candidate_row.id
      AND buffer.tenant_id = $2 AND buffer.user_id = $3
      AND buffer.app_id = $4 AND buffer.project_id = $5
      AND buffer.agent_id = $6 AND buffer.namespace = $7 AND buffer.visibility = $8
      AND buffer.workspace_id = $9 AND buffer.session_id = $10) AS tree_buffer_count,
  (SELECT count(*)::int FROM mengshu_work_memory_nodes node
    WHERE node.record_id IN (candidate_row.id, $1)
      AND node.tenant_id = $2 AND node.user_id = $3 AND node.app_id = $4
      AND node.project_id = $5 AND node.agent_id = $6 AND node.namespace = $7
      AND node.visibility = $8 AND node.workspace_id = $9 AND node.session_id = $10
  ) AS work_memory_node_count,
  (SELECT count(*)::int FROM mengshu_work_memory_edges edge
    WHERE (edge.source_id IN (SELECT id FROM mengshu_work_memory_nodes node
            WHERE node.record_id IN (candidate_row.id, $1))
      OR edge.target_id IN (SELECT id FROM mengshu_work_memory_nodes node
            WHERE node.record_id IN (candidate_row.id, $1)))
      AND edge.tenant_id = $2 AND edge.user_id = $3 AND edge.app_id = $4
      AND edge.project_id = $5 AND edge.agent_id = $6 AND edge.namespace = $7
      AND edge.visibility = $8 AND edge.workspace_id = $9 AND edge.session_id = $10
  ) AS work_memory_edge_count,
  ((SELECT count(*)::int FROM mengshu_memory_evidence_links link
      WHERE (link.target_memory_id = candidate_row.id OR link.evidence_memory_id = $1)
        AND link.tenant_id = $2 AND link.user_id = $3 AND link.app_id = $4
        AND link.project_id = $5 AND link.agent_id = $6 AND link.namespace = $7
        AND link.visibility = $8 AND link.workspace_id = $9 AND link.session_id = $10)
    + (SELECT count(*)::int FROM mengshu_graph_entity_evidence link
      WHERE link.evidence_memory_id = $1 AND link.tenant_id = $2 AND link.user_id = $3
        AND link.app_id = $4 AND link.project_id = $5 AND link.agent_id = $6
        AND link.namespace = $7 AND link.visibility = $8
        AND link.workspace_id = $9 AND link.session_id = $10)
    + (SELECT count(*)::int FROM mengshu_graph_relation_evidence link
      WHERE link.evidence_memory_id = $1 AND link.tenant_id = $2 AND link.user_id = $3
        AND link.app_id = $4 AND link.project_id = $5 AND link.agent_id = $6
        AND link.namespace = $7 AND link.visibility = $8
        AND link.workspace_id = $9 AND link.session_id = $10)) AS evidence_link_count
FROM mengshu_jobs_v2 candidate_job
JOIN mengshu_job_v2_effect_receipts candidate_receipt
  ON candidate_receipt.job_id = candidate_job.id
  AND candidate_receipt.effect_key = '${CANDIDATE_EFFECT_KEY}'
JOIN mengshu_candidates candidate_row
  ON candidate_row.source_job_id = candidate_job.id
  AND candidate_row.id = candidate_receipt.result->'candidateIds'->>0
  AND candidate_row.tenant_id = $2 AND candidate_row.user_id = $3
  AND candidate_row.app_id = $4 AND candidate_row.project_id = $5
  AND candidate_row.agent_id = $6 AND candidate_row.namespace = $7
  AND candidate_row.visibility = $8
  AND candidate_row.workspace_id = $9 AND candidate_row.session_id = $10
WHERE candidate_job.type = 'extract_candidate' AND candidate_job.status = 'completed'
  AND candidate_job.payload->>'traceId' = $1
  AND candidate_job.payload->>'intent' = 'auto'
  AND candidate_job.tenant_id = $2 AND candidate_job.user_id = $3
  AND candidate_job.app_id = $4 AND candidate_job.project_id = $5
  AND candidate_job.agent_id = $6 AND candidate_job.namespace = $7
  AND candidate_job.visibility = $8
  AND COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '') = $9
  AND COALESCE(candidate_job.payload #>> '{scope,sessionId}', '') = $10
LIMIT 1`, [
      evidenceId, scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    const row = result.rows[0];
    if (!row || typeof row.candidate_job_id !== "string" ||
        typeof row.candidate_id !== "string" || !plainObject(row.candidate_result) ||
        !plainObject(row.metadata)) return null;
    const candidateResult = row.candidate_result;
    const metadata = row.metadata;
    const governance = plainObject(metadata.governance) ? metadata.governance : undefined;
    const native = governance && plainObject(governance.native) ? governance.native : undefined;
    const candidateGovernance = governance && plainObject(governance.candidate)
      ? governance.candidate
      : undefined;
    const validationReceipt = candidateGovernance?.validationReceipt;
    const proposalReceipts = acceptedProposalReceipts(candidateResult.proposalReceipts);
    const candidateIds = exactStrings(candidateResult.candidateIds);
    const memoryIds = exactStrings(candidateResult.memoryIds);
    const activeMemoryIds = exactStrings(candidateResult.activeMemoryIds);
    const evidenceIds = exactStrings(row.evidence_ids);
    const created = Number(candidateResult.created);
    const duplicateCount = Number(candidateResult.duplicateCount);
    const capacityRejectedCount = Number(candidateResult.capacityRejectedCount);
    const droppedCount = Number(candidateResult.droppedCount);
    const candidateScope = {
      tenantId: row.candidate_tenant_id,
      userId: row.candidate_user_id,
      appId: row.candidate_app_id,
      projectId: row.candidate_project_id,
      agentId: row.candidate_agent_id,
      namespace: row.candidate_namespace,
      visibility: row.candidate_visibility,
      workspaceId: row.candidate_workspace_id,
      sessionId: row.candidate_session_id,
    };
    const admissionRoute = metadata.admissionRoute;
    if (row.status !== "pending" || row.promoted_to_memory_id !== null ||
        typeof row.content_hash !== "string" || row.active_content_hash !== row.content_hash ||
        !evidenceIds || evidenceIds.length !== 1 || evidenceIds[0] !== evidenceId ||
        typeof row.kind !== "string" || !MEMORY_KINDS.has(row.kind as MemoryKind) ||
        row.semantic_type !== "rules" || typeof row.confidence !== "number" ||
        (admissionRoute !== "candidate" && admissionRoute !== "candidate_low_priority") ||
        !proposalReceipts ||
        proposalReceipts[0]?.admission.route !== admissionRoute ||
        typeof metadata.valueScore !== "number" ||
        typeof metadata.importance !== "number" || native?.kind !== row.kind ||
        Object.values(candidateScope).some((value) => typeof value !== "string" || value.length === 0) ||
        !plainObject(validationReceipt) ||
        created !== 1 || duplicateCount !== 0 || capacityRejectedCount !== 0 || droppedCount !== 0 ||
        !candidateIds || candidateIds.length !== 1 || candidateIds[0] !== row.candidate_id ||
        !memoryIds || memoryIds.length !== 0 || !activeMemoryIds || activeMemoryIds.length !== 0) {
      return null;
    }
    const derivationCounts = {
      memories: Number(row.memory_count), graphJobs: Number(row.graph_job_count),
      treeJobs: Number(row.tree_job_count), treeBuffers: Number(row.tree_buffer_count),
      workMemoryNodes: Number(row.work_memory_node_count),
      workMemoryEdges: Number(row.work_memory_edge_count), evidenceLinks: Number(row.evidence_link_count),
    };
    if (Object.values(derivationCounts).some((count) => count !== 0)) return null;
    return {
      executed: true,
      receiptIds: [row.candidate_job_id, CANDIDATE_EFFECT_KEY, evidenceId, row.candidate_id],
      jobId: row.candidate_job_id,
      candidateAttempts: Number(row.candidate_attempts),
      effectKey: CANDIDATE_EFFECT_KEY,
      evidenceId,
      candidate: {
        candidateId: row.candidate_id,
        scope: candidateScope as RuntimePendingCandidateEvidence["candidate"]["scope"],
        status: "pending", promotedToMemoryId: null,
        contentHash: row.content_hash, activeContentHash: row.active_content_hash,
        evidenceIds, memoryKind: row.kind as MemoryKind, semanticType: "rules",
        admissionRoute, valueScore: metadata.valueScore,
        importance: metadata.importance, confidence: row.confidence,
        validationReceipt: validationReceipt as never,
      },
      effectTrace: {
        created: 1, duplicateCount: 0, capacityRejectedCount: 0, droppedCount: 0,
        candidateIds, memoryIds, activeMemoryIds,
      },
      proposalReceipts,
      derivationCounts: derivationCounts as RuntimePendingCandidateEvidence["derivationCounts"],
      visibility: { contextSourceIds: [], lookupHitIds: [], recallHitIds: [] },
    };
  } finally {
    await client.end();
  }
}

async function waitForPendingCandidateEvidence(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  evidenceId: string,
  timeoutMs: number,
  minimumAttempts = 1,
): Promise<RuntimePendingCandidateEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: RuntimePendingCandidateEvidence | null = null;
  while (Date.now() < deadline) {
    latest = await readPendingCandidateEvidence(config, scope, evidenceId);
    if (latest && latest.candidateAttempts >= minimumAttempts) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const client = new Client(config);
  await client.connect();
  try {
    const diagnostics = await client.query<Record<string, unknown>>(`SELECT
  job.id AS job_id,
  job.status AS job_status,
  job.attempts,
  job.max_attempts,
  job.last_error_code,
  job.last_error_retryable,
  job.payload->>'intent' AS intent,
  receipt.effect_key,
  CASE WHEN jsonb_typeof(receipt.result->'candidateIds') = 'array'
    THEN jsonb_array_length(receipt.result->'candidateIds') ELSE NULL END AS candidate_id_count,
  CASE WHEN jsonb_typeof(receipt.result->'memoryIds') = 'array'
    THEN jsonb_array_length(receipt.result->'memoryIds') ELSE NULL END AS memory_id_count,
  CASE WHEN jsonb_typeof(receipt.result->'activeMemoryIds') = 'array'
    THEN jsonb_array_length(receipt.result->'activeMemoryIds') ELSE NULL END AS active_memory_id_count,
  candidate.id AS candidate_id,
  candidate.status AS candidate_status,
  candidate.promoted_to_memory_id,
  candidate.metadata->>'admissionRoute' AS admission_route
FROM mengshu_jobs_v2 job
LEFT JOIN mengshu_job_v2_effect_receipts receipt
  ON receipt.job_id = job.id AND receipt.effect_key = '${CANDIDATE_EFFECT_KEY}'
LEFT JOIN mengshu_candidates candidate ON candidate.source_job_id = job.id
WHERE job.type = 'extract_candidate' AND job.payload->>'traceId' = $1
  AND job.tenant_id = $2 AND job.user_id = $3 AND job.app_id = $4
  AND job.project_id = $5 AND job.agent_id = $6 AND job.namespace = $7
  AND job.visibility = $8
  AND COALESCE(job.payload #>> '{scope,workspaceId}', '') = $9
  AND COALESCE(job.payload #>> '{scope,sessionId}', '') = $10
ORDER BY job.id, candidate.id`, [
      evidenceId, scope.tenantId, scope.userId, scope.appId, scope.projectId,
      scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    throw new Error(`production pending candidate evidence timed out: ${JSON.stringify({
      latest,
      jobs: diagnostics.rows,
    })}`);
  } finally {
    await client.end();
  }
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length &&
    actual.every((key, index) => key === [...keys].sort()[index]);
}

async function readProductionSealedSummary(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  expectedActiveMemoryIds: readonly string[],
): Promise<RuntimeSealedSummaryEvidence | null> {
  const client = new Client(config);
  await client.connect();
  try {
    const binding = [
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ];
    const summaryRows = await client.query<Record<string, unknown>>(`SELECT
  job.id AS job_id, job.attempts AS job_attempts,
  receipt.request_fingerprint, receipt.lease_generation,
  receipt.result AS effect_result, receipt.committed_at,
  summary.id AS node_id, summary.tree_type, summary.tree_key, summary.level,
  summary.status, summary.leaf_ids, summary.evidence_chunk_ids
FROM mengshu_jobs_v2 job
JOIN mengshu_job_v2_effect_receipts receipt
  ON receipt.job_id = job.id AND receipt.effect_key = '${TREE_EFFECT_KEY}'
JOIN mengshu_tree_summary_nodes summary
  ON summary.sealed_by_job_id = job.id AND summary.id = receipt.result->>'nodeId'
  AND summary.tenant_id = job.tenant_id AND summary.user_id = job.user_id
  AND summary.app_id = job.app_id AND summary.project_id = job.project_id
  AND summary.agent_id = job.agent_id AND summary.namespace = job.namespace
  AND summary.visibility = job.visibility
  AND summary.workspace_id = COALESCE(job.payload #>> '{scope,workspaceId}', '')
  AND summary.session_id = COALESCE(job.payload #>> '{scope,sessionId}', '')
WHERE job.type = 'build_tree' AND job.status = 'completed'
  AND job.payload->>'treeType' = 'source' AND job.payload->>'treeKey' = $9
  AND receipt.result->>'sealed' = 'true' AND receipt.result->>'bufferId' IS NULL
  AND job.tenant_id = $1 AND job.user_id = $2 AND job.app_id = $3
  AND job.project_id = $4 AND job.agent_id = $5 AND job.namespace = $6
  AND job.visibility = $7
  AND COALESCE(job.payload #>> '{scope,workspaceId}', '') = $8
  AND COALESCE(job.payload #>> '{scope,sessionId}', '') = $9
ORDER BY receipt.committed_at, job.id`, binding);
    if (summaryRows.rows.length !== 1) return null;
    const row = summaryRows.rows[0]!;
    const effectResult = plainObject(row.effect_result) ? row.effect_result : undefined;
    const leafIds = exactStrings(row.leaf_ids);
    const evidenceChunkIds = exactStrings(row.evidence_chunk_ids);
    const foldedNodeIds = effectResult ? exactStrings(effectResult.foldedNodeIds) : undefined;
    if (typeof row.job_id !== "string" || typeof row.node_id !== "string" ||
        typeof row.request_fingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(row.request_fingerprint) ||
        row.tree_type !== "source" || row.tree_key !== scope.sessionId || Number(row.level) !== 1 ||
        row.status !== "sealed" || !leafIds || leafIds.length !== 20 ||
        !evidenceChunkIds || evidenceChunkIds.length !== 20 || !effectResult ||
        !exactObjectKeys(effectResult, [
          "leafId", "sealed", "bufferId", "nodeId", "foldedNodeIds",
        ]) || !foldedNodeIds || foldedNodeIds.length !== 0 ||
        effectResult.sealed !== true || effectResult.bufferId !== null ||
        effectResult.nodeId !== row.node_id || typeof effectResult.leafId !== "string" ||
        new Set(leafIds).size !== 20 || new Set(evidenceChunkIds).size !== 20 ||
        new Set(expectedActiveMemoryIds).size !== 20 ||
        JSON.stringify([...leafIds].sort()) !== JSON.stringify([...expectedActiveMemoryIds].sort())) {
      return null;
    }
    const leaves = await client.query<{ id: string; chunk_id: string }>(`SELECT id, chunk_id
FROM mengshu_tree_leaves
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = $9
  AND id = ANY($10::text[])
ORDER BY id`, [...binding, leafIds]);
    if (leaves.rows.length !== 20 ||
        JSON.stringify([...new Set(leaves.rows.map(({ chunk_id }) => chunk_id))].sort()) !==
          JSON.stringify([...evidenceChunkIds].sort())) return null;
    const memoryIds = [...leafIds, ...evidenceChunkIds];
    const memories = await client.query<Record<string, unknown>>(`SELECT
  id::text AS id, lifecycle_status, metadata
FROM memories
WHERE tenant_id = $1 AND user_id = $2 AND product_id = $3
  AND canonical_project_id = $4 AND producer_id = $5 AND namespace = $6
  AND visibility = $7 AND COALESCE(workspace_id, '') = $8
  AND COALESCE(metadata->>'sessionId', metadata #>> '{governance,provenance,sessionId}', '') = $9
  AND id::text = ANY($10::text[])
ORDER BY id::text`, [...binding, memoryIds]);
    if (memories.rows.length !== 40) return null;
    const memoryById = new Map(memories.rows.map((item) => [item.id, item]));
    const leafEvidenceBindings = leaves.rows.map(({ id: leafId, chunk_id: evidenceChunkId }) => {
      const active = memoryById.get(leafId);
      const evidence = memoryById.get(evidenceChunkId);
      const activeMetadata = active && plainObject(active.metadata) ? active.metadata : undefined;
      const activeGovernance = activeMetadata && plainObject(activeMetadata.governance)
        ? activeMetadata.governance : undefined;
      const evidenceMetadata = evidence && plainObject(evidence.metadata) ? evidence.metadata : undefined;
      const evidenceGovernance = evidenceMetadata && plainObject(evidenceMetadata.governance)
        ? evidenceMetadata.governance : undefined;
      if (active?.lifecycle_status !== "active" || activeMetadata?.admissionRoute !== "active" ||
          !Array.isArray(activeGovernance?.evidenceIds) ||
          !activeGovernance.evidenceIds.includes(evidenceChunkId) ||
          evidence?.lifecycle_status !== "archived" ||
          evidenceMetadata?.admissionRoute !== "evidence_only" ||
          evidenceGovernance?.commandType !== "importEvidence") return null;
      return {
        leafId, evidenceChunkId, activeLifecycleStatus: "active" as const,
        activeAdmissionRoute: "active" as const,
        evidenceLifecycleStatus: "archived" as const,
        evidenceAdmissionRoute: "evidence_only" as const,
        evidenceCommandType: "importEvidence" as const,
      };
    });
    if (leafEvidenceBindings.some((item) => item === null)) return null;
    const counts = await client.query<Record<string, unknown>>(`SELECT
  (SELECT count(*)::int FROM mengshu_tree_summary_nodes
    WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
      AND agent_id = $5 AND namespace = $6 AND visibility = $7
      AND workspace_id = $8 AND session_id = $9
      AND tree_type = 'source' AND tree_key = $9 AND level = 1 AND status = 'sealed') AS summary_count,
  (SELECT count(*)::int FROM mengshu_tree_leaves
    WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
      AND agent_id = $5 AND namespace = $6 AND visibility = $7
      AND workspace_id = $8 AND session_id = $9 AND id = ANY($10::text[])) AS leaf_count,
  (SELECT count(*)::int FROM mengshu_tree_buffers
    WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
      AND agent_id = $5 AND namespace = $6 AND visibility = $7
      AND workspace_id = $8 AND session_id = $9
      AND tree_type = 'source' AND tree_key = $9 AND level = 0) AS source_buffer_count`,
    [...binding, leafIds]);
    const countsRow = counts.rows[0];
    if (!countsRow || Number(countsRow.summary_count) !== 1 || Number(countsRow.leaf_count) !== 20 ||
        Number(countsRow.source_buffer_count) !== 0) return null;
    return {
      executed: true,
      jobId: row.job_id,
      jobAttempts: Number(row.job_attempts),
      effectKey: TREE_EFFECT_KEY,
      requestFingerprint: row.request_fingerprint,
      leaseGeneration: Number(row.lease_generation),
      committedAt: Number(row.committed_at),
      nodeId: row.node_id,
      treeType: "source",
      treeKey: row.tree_key as string,
      level: 1,
      status: "sealed",
      leafIds,
      evidenceChunkIds,
      leafEvidenceBindings: leafEvidenceBindings as ProductionSealedSummaryReceipt["leafEvidenceBindings"],
      summaryCount: 1,
      leafCount: 20,
      sourceBufferCount: 0,
      effectResult: effectResult as unknown as ProductionSealedSummaryReceipt["effectResult"],
    };
  } finally {
    await client.end();
  }
}

async function waitForProductionSealedSummary(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  expectedActiveMemoryIds: readonly string[],
  timeoutMs: number,
  minimumAttempts = 1,
): Promise<RuntimeSealedSummaryEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: RuntimeSealedSummaryEvidence | null = null;
  while (Date.now() < deadline) {
    latest = await readProductionSealedSummary(config, scope, expectedActiveMemoryIds);
    if (latest && latest.jobAttempts >= minimumAttempts) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`production sealed source summary timed out: ${JSON.stringify(latest)}`);
}

async function readRuntimeChain(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  evidenceId: string,
  requireTopic = false,
): Promise<RuntimeChainEvidence | null> {
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT
  candidate_job.id AS candidate_job_id,
  candidate_job.attempts AS candidate_attempts,
  candidate_receipt.result AS candidate_result,
  candidate_receipt.result->'activeMemoryIds'->>0 AS active_memory_id,
  (SELECT count(*)::int FROM mengshu_jobs_v2 exact_candidate
    WHERE exact_candidate.type = 'extract_candidate'
      AND exact_candidate.payload->>'traceId' = $1
      AND exact_candidate.tenant_id = $2 AND exact_candidate.user_id = $3
      AND exact_candidate.app_id = $4 AND exact_candidate.project_id = $5
      AND exact_candidate.agent_id = $6 AND exact_candidate.namespace = $7
      AND exact_candidate.visibility = $8
      AND COALESCE(exact_candidate.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(exact_candidate.payload #>> '{scope,sessionId}', '') = $10) AS candidate_job_count,
  graph_job.id AS graph_job_id,
  graph_job.attempts AS graph_attempts,
  (SELECT count(*)::int FROM mengshu_jobs_v2 exact_graph
    WHERE exact_graph.type = 'extract_graph'
      AND exact_graph.payload->>'activeMemoryId' = candidate_receipt.result->'activeMemoryIds'->>0
      AND exact_graph.payload->>'evidenceId' = $1
      AND exact_graph.tenant_id = $2 AND exact_graph.user_id = $3
      AND exact_graph.app_id = $4 AND exact_graph.project_id = $5
      AND exact_graph.agent_id = $6 AND exact_graph.namespace = $7
      AND exact_graph.visibility = $8
      AND COALESCE(exact_graph.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(exact_graph.payload #>> '{scope,sessionId}', '') = $10) AS graph_job_count,
  graph_receipt.result->'entityIds' AS graph_entity_ids,
  graph_receipt.result->'relationIds' AS graph_relation_ids,
  source_job.id AS source_tree_job_id,
  (SELECT count(*)::int FROM mengshu_jobs_v2 exact_source
    WHERE exact_source.type = 'build_tree' AND exact_source.payload->>'treeType' = 'source'
      AND exact_source.payload->>'treeKey' = $10
      AND exact_source.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND exact_source.payload #>> '{leaf,chunkId}' = $1
      AND exact_source.tenant_id = $2 AND exact_source.user_id = $3
      AND exact_source.app_id = $4 AND exact_source.project_id = $5
      AND exact_source.agent_id = $6 AND exact_source.namespace = $7
      AND exact_source.visibility = $8
      AND COALESCE(exact_source.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(exact_source.payload #>> '{scope,sessionId}', '') = $10) AS source_tree_job_count,
  global_job.id AS global_tree_job_id,
  (SELECT count(*)::int FROM mengshu_jobs_v2 exact_global
    WHERE exact_global.type = 'build_tree' AND exact_global.payload->>'treeType' = 'global'
      AND exact_global.payload->>'treeKey' ~ '^\\d{4}-\\d{2}-\\d{2}$'
      AND exact_global.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND exact_global.payload #>> '{leaf,chunkId}' = $1
      AND exact_global.tenant_id = $2 AND exact_global.user_id = $3
      AND exact_global.app_id = $4 AND exact_global.project_id = $5
      AND exact_global.agent_id = $6 AND exact_global.namespace = $7
      AND exact_global.visibility = $8
      AND COALESCE(exact_global.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(exact_global.payload #>> '{scope,sessionId}', '') = $10) AS global_tree_job_count,
  ARRAY(SELECT topic_job.id FROM mengshu_jobs_v2 topic_job
    JOIN mengshu_job_v2_effect_receipts topic_receipt
      ON topic_receipt.job_id = topic_job.id AND topic_receipt.effect_key = '${TREE_EFFECT_KEY}'
    JOIN mengshu_tree_buffers topic_buffer
      ON topic_buffer.tree_type = 'topic'
      AND topic_buffer.tree_key = topic_job.payload->>'treeKey'
      AND topic_buffer.tenant_id = topic_job.tenant_id
      AND topic_buffer.user_id = topic_job.user_id
      AND topic_buffer.app_id = topic_job.app_id
      AND topic_buffer.project_id = topic_job.project_id
      AND topic_buffer.agent_id = topic_job.agent_id
      AND topic_buffer.namespace = topic_job.namespace
      AND topic_buffer.visibility = topic_job.visibility
      AND topic_buffer.workspace_id = COALESCE(topic_job.payload #>> '{scope,workspaceId}', '')
      AND topic_buffer.session_id = COALESCE(topic_job.payload #>> '{scope,sessionId}', '')
      AND topic_buffer.leaf_ids ? (candidate_receipt.result->'activeMemoryIds'->>0)
    WHERE topic_job.type = 'build_tree' AND topic_job.status = 'completed'
      AND topic_job.payload->>'treeType' = 'topic'
      AND topic_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND topic_job.payload #>> '{leaf,chunkId}' = $1
      AND topic_job.tenant_id = candidate_job.tenant_id
      AND topic_job.user_id = candidate_job.user_id
      AND topic_job.app_id = candidate_job.app_id
      AND topic_job.project_id = candidate_job.project_id
      AND topic_job.agent_id = candidate_job.agent_id
      AND topic_job.namespace = candidate_job.namespace
      AND topic_job.visibility = candidate_job.visibility
      AND COALESCE(topic_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(topic_job.payload #>> '{scope,sessionId}', '') = $10
    ORDER BY topic_job.id) AS topic_tree_job_ids,
  ARRAY(SELECT DISTINCT topic_job.payload->>'treeKey' FROM mengshu_jobs_v2 topic_job
    JOIN mengshu_job_v2_effect_receipts topic_receipt
      ON topic_receipt.job_id = topic_job.id AND topic_receipt.effect_key = '${TREE_EFFECT_KEY}'
    WHERE topic_job.type = 'build_tree' AND topic_job.status = 'completed'
      AND topic_job.payload->>'treeType' = 'topic'
      AND topic_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND topic_job.payload #>> '{leaf,chunkId}' = $1
      AND topic_job.tenant_id = candidate_job.tenant_id
      AND topic_job.user_id = candidate_job.user_id
      AND topic_job.app_id = candidate_job.app_id
      AND topic_job.project_id = candidate_job.project_id
      AND topic_job.agent_id = candidate_job.agent_id
      AND topic_job.namespace = candidate_job.namespace
      AND topic_job.visibility = candidate_job.visibility
      AND COALESCE(topic_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(topic_job.payload #>> '{scope,sessionId}', '') = $10
    ORDER BY topic_job.payload->>'treeKey') AS topic_tree_keys,
  source_receipt.result->>'leafId' AS source_leaf_id,
  global_receipt.result->>'leafId' AS global_leaf_id,
  ARRAY(SELECT topic_receipt.result->>'leafId' FROM mengshu_jobs_v2 topic_job
    JOIN mengshu_job_v2_effect_receipts topic_receipt
      ON topic_receipt.job_id = topic_job.id AND topic_receipt.effect_key = '${TREE_EFFECT_KEY}'
    WHERE topic_job.type = 'build_tree' AND topic_job.status = 'completed'
      AND topic_job.payload->>'treeType' = 'topic'
      AND topic_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND topic_job.payload #>> '{leaf,chunkId}' = $1
      AND topic_job.tenant_id = candidate_job.tenant_id
      AND topic_job.user_id = candidate_job.user_id
      AND topic_job.app_id = candidate_job.app_id
      AND topic_job.project_id = candidate_job.project_id
      AND topic_job.agent_id = candidate_job.agent_id
      AND topic_job.namespace = candidate_job.namespace
      AND topic_job.visibility = candidate_job.visibility
      AND COALESCE(topic_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(topic_job.payload #>> '{scope,sessionId}', '') = $10
    ORDER BY topic_job.id) AS topic_leaf_ids,
  ARRAY(SELECT buffer.id FROM mengshu_tree_buffers buffer
    WHERE buffer.tenant_id = candidate_job.tenant_id AND buffer.user_id = candidate_job.user_id
      AND buffer.app_id = candidate_job.app_id AND buffer.project_id = candidate_job.project_id
      AND buffer.agent_id = candidate_job.agent_id AND buffer.namespace = candidate_job.namespace
      AND buffer.visibility = candidate_job.visibility
      AND buffer.workspace_id = COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '')
      AND buffer.session_id = COALESCE(candidate_job.payload #>> '{scope,sessionId}', '')
      AND buffer.leaf_ids ? (candidate_receipt.result->'activeMemoryIds'->>0)
    ORDER BY buffer.id) AS tree_buffer_ids,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'jobId', tree_job.id,
      'treeType', tree_job.payload->>'treeType',
      'treeKey', tree_job.payload->>'treeKey',
      'bufferId', tree_buffer.id,
      'leafId', candidate_receipt.result->'activeMemoryIds'->>0
    ) ORDER BY tree_job.id), '[]'::jsonb)
    FROM mengshu_jobs_v2 tree_job
    JOIN mengshu_job_v2_effect_receipts tree_receipt
      ON tree_receipt.job_id = tree_job.id AND tree_receipt.effect_key = '${TREE_EFFECT_KEY}'
    JOIN mengshu_tree_buffers tree_buffer
      ON tree_buffer.tree_type = tree_job.payload->>'treeType'
      AND tree_buffer.tree_key = tree_job.payload->>'treeKey'
      AND tree_buffer.tenant_id = tree_job.tenant_id AND tree_buffer.user_id = tree_job.user_id
      AND tree_buffer.app_id = tree_job.app_id AND tree_buffer.project_id = tree_job.project_id
      AND tree_buffer.agent_id = tree_job.agent_id AND tree_buffer.namespace = tree_job.namespace
      AND tree_buffer.visibility = tree_job.visibility
      AND tree_buffer.workspace_id = COALESCE(tree_job.payload #>> '{scope,workspaceId}', '')
      AND tree_buffer.session_id = COALESCE(tree_job.payload #>> '{scope,sessionId}', '')
      AND tree_buffer.leaf_ids ? (candidate_receipt.result->'activeMemoryIds'->>0)
    WHERE tree_job.type = 'build_tree' AND tree_job.status = 'completed'
      AND tree_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
      AND tree_job.payload #>> '{leaf,chunkId}' = $1
      AND tree_job.tenant_id = candidate_job.tenant_id AND tree_job.user_id = candidate_job.user_id
      AND tree_job.app_id = candidate_job.app_id AND tree_job.project_id = candidate_job.project_id
      AND tree_job.agent_id = candidate_job.agent_id AND tree_job.namespace = candidate_job.namespace
      AND tree_job.visibility = candidate_job.visibility
      AND COALESCE(tree_job.payload #>> '{scope,workspaceId}', '') = $9
      AND COALESCE(tree_job.payload #>> '{scope,sessionId}', '') = $10
  ) AS tree_buffer_bindings,
  (SELECT storage_key FROM mengshu_write_audit WHERE memory_id = $1
    AND tenant_id = $2 AND user_id = $3 AND canonical_project_id = $5
    AND product_id = $4 AND producer_id = $6 AND namespace = $7 AND visibility = $8
    AND workspace_id = $9 AND session_id = $10) AS storage_key,
  (SELECT jsonb_build_object(
      'memoryKind', memory.metadata #>> '{governance,native,kind}',
      'semanticType', memory.metadata #>> '{governance,native,semanticType}',
      'admissionRoute', memory.metadata->>'admissionRoute',
      'lifecycleStatus', memory.lifecycle_status,
      'contextEligible', memory.metadata->'contextEligible',
      'valueScore', memory.metadata->'valueScore',
      'importance', memory.importance,
      'confidence', memory.metadata->'confidence',
      'validatorAudit', memory.metadata->'audit',
      'treeRouting', memory.metadata #> '{governance,candidate,treeRouting}'
    ) FROM memories memory
    WHERE memory.id::text = candidate_receipt.result->'activeMemoryIds'->>0
      AND memory.tenant_id = $2 AND memory.user_id = $3
      AND memory.canonical_project_id = $5 AND memory.product_id = $4
      AND memory.producer_id = $6 AND memory.namespace = $7 AND memory.visibility = $8
      AND COALESCE(memory.workspace_id, '') = $9
      AND COALESCE(memory.metadata->>'sessionId', '') = $10) AS candidate_governance,
  ARRAY(SELECT link_id FROM mengshu_memory_evidence_links
    WHERE evidence_memory_id = $1 AND source = 'entity_graph'
      AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
      AND agent_id = $6 AND namespace = $7 AND visibility = $8
      AND workspace_id = $9 AND session_id = $10 ORDER BY link_id) AS memory_link_ids,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'linkId', link_id, 'targetId', target_memory_id, 'evidenceId', evidence_memory_id
    ) ORDER BY link_id), '[]'::jsonb) FROM mengshu_memory_evidence_links
    WHERE target_memory_id = candidate_receipt.result->'activeMemoryIds'->>0
      AND evidence_memory_id = $1 AND source = 'entity_graph'
      AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
      AND agent_id = $6 AND namespace = $7 AND visibility = $8
      AND workspace_id = $9 AND session_id = $10) AS memory_link_bindings,
  ARRAY(SELECT link_id FROM mengshu_graph_entity_evidence
    WHERE evidence_memory_id = $1 AND tenant_id = $2 AND user_id = $3
      AND app_id = $4 AND project_id = $5 AND agent_id = $6 AND namespace = $7
      AND visibility = $8 AND workspace_id = $9 AND session_id = $10 ORDER BY link_id) AS entity_link_ids,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'linkId', link_id, 'targetId', entity_id, 'evidenceId', evidence_memory_id
    ) ORDER BY link_id), '[]'::jsonb) FROM mengshu_graph_entity_evidence
    WHERE evidence_memory_id = $1
      AND entity_id IN (SELECT jsonb_array_elements_text(graph_receipt.result->'entityIds'))
      AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
      AND agent_id = $6 AND namespace = $7 AND visibility = $8
      AND workspace_id = $9 AND session_id = $10) AS entity_link_bindings,
  ARRAY(SELECT link_id FROM mengshu_graph_relation_evidence
    WHERE evidence_memory_id = $1 AND tenant_id = $2 AND user_id = $3
      AND app_id = $4 AND project_id = $5 AND agent_id = $6 AND namespace = $7
      AND visibility = $8 AND workspace_id = $9 AND session_id = $10 ORDER BY link_id) AS relation_link_ids,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'linkId', link_id, 'targetId', relation_id, 'evidenceId', evidence_memory_id
    ) ORDER BY link_id), '[]'::jsonb) FROM mengshu_graph_relation_evidence
    WHERE evidence_memory_id = $1
      AND relation_id IN (SELECT jsonb_array_elements_text(graph_receipt.result->'relationIds'))
      AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
      AND agent_id = $6 AND namespace = $7 AND visibility = $8
      AND workspace_id = $9 AND session_id = $10) AS relation_link_bindings,
  ARRAY(SELECT id FROM mengshu_work_memory_nodes
    WHERE record_id IN ($1, candidate_receipt.result->'activeMemoryIds'->>0)
      AND tenant_id = candidate_job.tenant_id AND user_id = candidate_job.user_id
      AND app_id = candidate_job.app_id AND project_id = candidate_job.project_id
      AND agent_id = candidate_job.agent_id AND namespace = candidate_job.namespace
      AND visibility = candidate_job.visibility
      AND workspace_id = COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '')
      AND session_id = COALESCE(candidate_job.payload #>> '{scope,sessionId}', '')
    ORDER BY id) AS work_memory_node_ids,
  (SELECT id FROM mengshu_work_memory_nodes WHERE node_type = 'memory'
    AND record_id = candidate_receipt.result->'activeMemoryIds'->>0
    AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
    AND agent_id = $6 AND namespace = $7 AND visibility = $8
    AND workspace_id = $9 AND session_id = $10) AS work_memory_active_node_id,
  (SELECT id FROM mengshu_work_memory_nodes WHERE node_type = 'evidence' AND record_id = $1
    AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
    AND agent_id = $6 AND namespace = $7 AND visibility = $8
    AND workspace_id = $9 AND session_id = $10) AS work_memory_evidence_node_id,
  ARRAY(SELECT edge.id FROM mengshu_work_memory_edges edge
    JOIN mengshu_work_memory_nodes memory_node
      ON memory_node.scope_fingerprint = edge.scope_fingerprint AND memory_node.id = edge.source_id
    JOIN mengshu_work_memory_nodes evidence_node
      ON evidence_node.scope_fingerprint = edge.scope_fingerprint AND evidence_node.id = edge.target_id
    WHERE memory_node.record_id = candidate_receipt.result->'activeMemoryIds'->>0
      AND evidence_node.record_id = $1 AND edge.predicate = 'grounded_by'
      AND edge.tenant_id = candidate_job.tenant_id AND edge.user_id = candidate_job.user_id
      AND edge.app_id = candidate_job.app_id AND edge.project_id = candidate_job.project_id
      AND edge.agent_id = candidate_job.agent_id AND edge.namespace = candidate_job.namespace
      AND edge.visibility = candidate_job.visibility
      AND edge.workspace_id = COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '')
      AND edge.session_id = COALESCE(candidate_job.payload #>> '{scope,sessionId}', '')
    ORDER BY edge.id) AS work_memory_edge_ids,
  (SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'edgeId', edge.id, 'predicate', edge.predicate,
      'sourceId', edge.source_id, 'targetId', edge.target_id,
      'evidenceChunkIds', edge.evidence_chunk_ids
    ) ORDER BY edge.id), '[]'::jsonb)
    FROM mengshu_work_memory_edges edge
    JOIN mengshu_work_memory_nodes memory_node
      ON memory_node.scope_fingerprint = edge.scope_fingerprint AND memory_node.id = edge.source_id
    JOIN mengshu_work_memory_nodes evidence_node
      ON evidence_node.scope_fingerprint = edge.scope_fingerprint AND evidence_node.id = edge.target_id
    WHERE memory_node.record_id = candidate_receipt.result->'activeMemoryIds'->>0
      AND evidence_node.record_id = $1 AND edge.predicate = 'grounded_by'
      AND edge.tenant_id = candidate_job.tenant_id AND edge.user_id = candidate_job.user_id
      AND edge.app_id = candidate_job.app_id AND edge.project_id = candidate_job.project_id
      AND edge.agent_id = candidate_job.agent_id AND edge.namespace = candidate_job.namespace
      AND edge.visibility = candidate_job.visibility
      AND edge.workspace_id = COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '')
      AND edge.session_id = COALESCE(candidate_job.payload #>> '{scope,sessionId}', '')
  ) AS work_memory_edge_bindings
FROM mengshu_jobs_v2 candidate_job
JOIN mengshu_job_v2_effect_receipts candidate_receipt
  ON candidate_receipt.job_id = candidate_job.id AND candidate_receipt.effect_key = '${CANDIDATE_EFFECT_KEY}'
JOIN mengshu_jobs_v2 graph_job ON graph_job.type = 'extract_graph'
  AND graph_job.payload->>'activeMemoryId' = candidate_receipt.result->'activeMemoryIds'->>0
  AND graph_job.payload->>'evidenceId' = $1
  AND graph_job.tenant_id = candidate_job.tenant_id AND graph_job.user_id = candidate_job.user_id
  AND graph_job.app_id = candidate_job.app_id AND graph_job.project_id = candidate_job.project_id
  AND graph_job.agent_id = candidate_job.agent_id AND graph_job.namespace = candidate_job.namespace
  AND graph_job.visibility = candidate_job.visibility
  AND COALESCE(graph_job.payload #>> '{scope,workspaceId}', '') =
    COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '')
  AND COALESCE(graph_job.payload #>> '{scope,sessionId}', '') =
    COALESCE(candidate_job.payload #>> '{scope,sessionId}', '')
JOIN mengshu_job_v2_effect_receipts graph_receipt
  ON graph_receipt.job_id = graph_job.id AND graph_receipt.effect_key = '${GRAPH_EFFECT_KEY}'
  AND graph_receipt.result->>'evidenceId' = $1
JOIN mengshu_jobs_v2 source_job
  ON source_job.type = 'build_tree' AND source_job.payload->>'treeType' = 'source'
  AND source_job.payload->>'treeKey' = $10
  AND source_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
  AND source_job.payload #>> '{leaf,chunkId}' = $1
  AND source_job.tenant_id = candidate_job.tenant_id AND source_job.user_id = candidate_job.user_id
  AND source_job.app_id = candidate_job.app_id AND source_job.project_id = candidate_job.project_id
  AND source_job.agent_id = candidate_job.agent_id AND source_job.namespace = candidate_job.namespace
  AND source_job.visibility = candidate_job.visibility
  AND COALESCE(source_job.payload #>> '{scope,workspaceId}', '') = $9
  AND COALESCE(source_job.payload #>> '{scope,sessionId}', '') = $10
JOIN mengshu_job_v2_effect_receipts source_receipt
  ON source_receipt.job_id = source_job.id AND source_receipt.effect_key = '${TREE_EFFECT_KEY}'
LEFT JOIN mengshu_jobs_v2 global_job
  ON global_job.type = 'build_tree' AND global_job.payload->>'treeType' = 'global'
  AND global_job.payload->>'treeKey' ~ '^\\d{4}-\\d{2}-\\d{2}$'
  AND global_job.payload #>> '{leaf,id}' = candidate_receipt.result->'activeMemoryIds'->>0
  AND global_job.payload #>> '{leaf,chunkId}' = $1
  AND global_job.tenant_id = candidate_job.tenant_id AND global_job.user_id = candidate_job.user_id
  AND global_job.app_id = candidate_job.app_id AND global_job.project_id = candidate_job.project_id
  AND global_job.agent_id = candidate_job.agent_id AND global_job.namespace = candidate_job.namespace
  AND global_job.visibility = candidate_job.visibility
  AND COALESCE(global_job.payload #>> '{scope,workspaceId}', '') = $9
  AND COALESCE(global_job.payload #>> '{scope,sessionId}', '') = $10
  AND global_job.status = 'completed'
LEFT JOIN mengshu_job_v2_effect_receipts global_receipt
  ON global_receipt.job_id = global_job.id AND global_receipt.effect_key = '${TREE_EFFECT_KEY}'
WHERE candidate_job.type = 'extract_candidate'
  AND candidate_job.payload->>'traceId' = $1
  AND candidate_job.tenant_id = $2 AND candidate_job.user_id = $3
  AND candidate_job.app_id = $4 AND candidate_job.project_id = $5
  AND candidate_job.agent_id = $6 AND candidate_job.namespace = $7
  AND candidate_job.visibility = $8
  AND COALESCE(candidate_job.payload #>> '{scope,workspaceId}', '') = $9
  AND COALESCE(candidate_job.payload #>> '{scope,sessionId}', '') = $10
  AND candidate_job.status = 'completed' AND graph_job.status = 'completed'
  AND source_job.status = 'completed'
  AND candidate_receipt.result->'activeMemoryIds'->>0 = graph_job.payload->>'activeMemoryId'
LIMIT 1`, [
      evidenceId, scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    const row = result.rows[0];
    if (!row || typeof row.candidate_job_id !== "string" ||
        typeof row.active_memory_id !== "string" || typeof row.graph_job_id !== "string" ||
        !Number.isSafeInteger(Number(row.graph_attempts)) || Number(row.graph_attempts) < 1 ||
        typeof row.source_tree_job_id !== "string" ||
        (row.global_tree_job_id !== null && typeof row.global_tree_job_id !== "string") ||
        typeof row.source_leaf_id !== "string" ||
        (row.global_leaf_id !== null && typeof row.global_leaf_id !== "string") ||
        typeof row.storage_key !== "string") return null;
    const graphEntityIds = strings(row.graph_entity_ids);
    const graphRelationIds = strings(row.graph_relation_ids);
    const memoryEvidenceLinkIds = strings(row.memory_link_ids);
    const entityEvidenceLinkIds = strings(row.entity_link_ids);
    const relationEvidenceLinkIds = strings(row.relation_link_ids);
    const memoryEvidenceBindings = evidenceBindings(row.memory_link_bindings);
    const entityEvidenceBindings = evidenceBindings(row.entity_link_bindings);
    const relationEvidenceBindings = evidenceBindings(row.relation_link_bindings);
    const workMemoryNodeIds = strings(row.work_memory_node_ids);
    const workMemoryEdgeIds = strings(row.work_memory_edge_ids);
    const parsedWorkMemoryEdgeBindings = workMemoryEdgeBindings(row.work_memory_edge_bindings);
    const topicTreeJobIds = strings(row.topic_tree_job_ids);
    const topicTreeKeys = strings(row.topic_tree_keys);
    const topicLeafIds = strings(row.topic_leaf_ids);
    const treeBufferIds = strings(row.tree_buffer_ids);
    const parsedTreeBufferBindings = treeBufferBindings(row.tree_buffer_bindings);
    const candidateResult = plainObject(row.candidate_result) ? row.candidate_result : undefined;
    const candidateIds = candidateResult ? exactStrings(candidateResult.candidateIds) : undefined;
    const memoryIds = candidateResult ? exactStrings(candidateResult.memoryIds) : undefined;
    const activeMemoryIds = candidateResult ? exactStrings(candidateResult.activeMemoryIds) : undefined;
    const duplicateCount = Number(candidateResult?.duplicateCount);
    const capacityRejectedCount = Number(candidateResult?.capacityRejectedCount);
    const droppedCount = Number(candidateResult?.droppedCount);
    const created = Number(candidateResult?.created);
    const governance = plainObject(row.candidate_governance) ? row.candidate_governance : undefined;
    const validatorAudit = governance && plainObject(governance.validatorAudit)
      ? governance.validatorAudit
      : undefined;
    const treeRouting = governance && plainObject(governance.treeRouting)
      ? governance.treeRouting
      : undefined;
    const workMemoryActiveNodeId = typeof row.work_memory_active_node_id === "string"
      ? row.work_memory_active_node_id
      : undefined;
    const workMemoryEvidenceNodeId = typeof row.work_memory_evidence_node_id === "string"
      ? row.work_memory_evidence_node_id
      : undefined;
    const exactJobCounts = {
      candidate: Number(row.candidate_job_count),
      graph: Number(row.graph_job_count),
      sourceTree: Number(row.source_tree_job_count),
      globalTree: Number(row.global_tree_job_count),
    };
    const semanticType = governance?.semanticType;
    const riskFlags = treeRouting ? exactStrings(treeRouting.riskFlags) : undefined;
    const routedEntityIds = treeRouting ? exactStrings(treeRouting.entityIds) : undefined;
    const routedTopicLabels = treeRouting ? exactStrings(treeRouting.topicLabels) : undefined;
    const scopeVisibility = treeRouting?.scopeVisibility;
    const valueScore = governance?.valueScore;
    const importance = governance?.importance;
    const routingFacts = treeRouting && treeRouting.version === 1 &&
        treeRouting.evidenceId === evidenceId && typeof treeRouting.sourceId === "string" &&
        riskFlags && routedEntityIds && routedTopicLabels && routedEntityIds.length === 0 &&
        routedTopicLabels.length === 0 && treeRouting.topicHotnessEligible === false &&
        typeof valueScore === "number" && Number.isFinite(valueScore) &&
        valueScore >= 0 && valueScore <= 1 &&
        typeof importance === "number" && Number.isFinite(importance) &&
        importance >= 0 && importance <= 1 && typeof scopeVisibility === "string" &&
        ["session", "project", "workspace", "app", "user", "global"].includes(scopeVisibility) &&
        typeof semanticType === "string" && SEMANTIC_TYPE_SET.has(semanticType as MemorySemanticType) &&
        (treeRouting.explicitGlobal === undefined || typeof treeRouting.explicitGlobal === "boolean") &&
        (treeRouting.isWorkspaceRule === undefined || typeof treeRouting.isWorkspaceRule === "boolean")
      ? {
          valueScore,
          importance,
          semanticType: semanticType as MemorySemanticType,
          scopeVisibility: scopeVisibility as NonNullable<LeafRoutingInput["scopeVisibility"]>,
          riskFlags,
          ...(treeRouting.explicitGlobal === undefined
            ? {}
            : { explicitGlobal: treeRouting.explicitGlobal as boolean }),
          ...(treeRouting.isWorkspaceRule === undefined
            ? {}
            : { isWorkspaceRule: treeRouting.isWorkspaceRule as boolean }),
        }
      : undefined;
    const expectedTreeTypes = routingFacts
      ? expectedRuntimeTreeTypes(routingFacts, requireTopic)
      : [];
    const expectsGlobal = expectedTreeTypes.includes("global");
    const expectsTopic = expectedTreeTypes.includes("topic");
    const actualTreeTypes = [
      "source" as const,
      ...(row.global_tree_job_id === null ? [] : ["global" as const]),
      ...(topicTreeJobIds.length === 0 ? [] : ["topic" as const]),
    ].sort();
    const actualBindingCount = 1 + (row.global_tree_job_id === null ? 0 : 1) +
      topicTreeJobIds.length;
    if (graphEntityIds.length === 0 || graphRelationIds.length === 0 ||
        memoryEvidenceLinkIds.length === 0 || entityEvidenceLinkIds.length === 0 ||
        relationEvidenceLinkIds.length === 0 || workMemoryNodeIds.length < 2 ||
        workMemoryEdgeIds.length === 0 || treeBufferIds.length < 1 ||
        !memoryEvidenceBindings || !entityEvidenceBindings || !relationEvidenceBindings ||
        !parsedTreeBufferBindings ||
        JSON.stringify(memoryEvidenceBindings.map(({ linkId }) => linkId).sort()) !==
          JSON.stringify([...memoryEvidenceLinkIds].sort()) ||
        JSON.stringify(entityEvidenceBindings.map(({ linkId }) => linkId).sort()) !==
          JSON.stringify([...entityEvidenceLinkIds].sort()) ||
        JSON.stringify(relationEvidenceBindings.map(({ linkId }) => linkId).sort()) !==
          JSON.stringify([...relationEvidenceLinkIds].sort()) ||
        memoryEvidenceBindings.some(({ targetId, evidenceId: linkedEvidenceId }) =>
          targetId !== row.active_memory_id || linkedEvidenceId !== evidenceId) ||
        entityEvidenceBindings.some(({ targetId, evidenceId: linkedEvidenceId }) =>
          !graphEntityIds.includes(targetId) || linkedEvidenceId !== evidenceId) ||
        relationEvidenceBindings.some(({ targetId, evidenceId: linkedEvidenceId }) =>
          !graphRelationIds.includes(targetId) || linkedEvidenceId !== evidenceId) ||
        !workMemoryActiveNodeId || !workMemoryEvidenceNodeId || !parsedWorkMemoryEdgeBindings ||
        !workMemoryNodeIds.includes(workMemoryActiveNodeId) ||
        !workMemoryNodeIds.includes(workMemoryEvidenceNodeId) ||
        JSON.stringify(parsedWorkMemoryEdgeBindings.map(({ edgeId }) => edgeId).sort()) !==
          JSON.stringify([...workMemoryEdgeIds].sort()) ||
        parsedWorkMemoryEdgeBindings.some(({ sourceId, targetId, evidenceChunkIds }) =>
          sourceId !== workMemoryActiveNodeId || targetId !== workMemoryEvidenceNodeId ||
          evidenceChunkIds.length === 0 || new Set(evidenceChunkIds).size !== evidenceChunkIds.length ||
          !evidenceChunkIds.includes(evidenceId)) ||
        exactJobCounts.candidate !== 1 || exactJobCounts.graph !== 1 ||
        exactJobCounts.sourceTree !== 1 || exactJobCounts.globalTree !== (expectsGlobal ? 1 : 0) ||
        !candidateResult || !governance || !validatorAudit || !routingFacts ||
        ![created, duplicateCount, capacityRejectedCount, droppedCount]
          .every((count) => Number.isSafeInteger(count) && count >= 0) ||
        created !== 1 || duplicateCount !== 0 || capacityRejectedCount !== 0 || droppedCount !== 0 ||
        !candidateIds || !memoryIds || !activeMemoryIds ||
        candidateIds.length !== 0 || memoryIds.length !== 1 || activeMemoryIds.length !== 1 ||
        memoryIds[0] !== row.active_memory_id || activeMemoryIds[0] !== row.active_memory_id ||
        typeof governance.memoryKind !== "string" ||
        !MEMORY_KINDS.has(governance.memoryKind as MemoryKind) ||
        !SEMANTIC_TYPE_SET.has(governance.semanticType as MemorySemanticType) ||
        governance.admissionRoute !== "active" ||
        governance.lifecycleStatus !== "active" || governance.contextEligible !== true ||
        typeof governance.valueScore !== "number" || typeof governance.importance !== "number" ||
        typeof governance.confidence !== "number" ||
        JSON.stringify(parsedTreeBufferBindings.map(({ bufferId }) => bufferId).sort()) !==
          JSON.stringify([...treeBufferIds].sort()) ||
        parsedTreeBufferBindings.some(({ leafId }) => leafId !== row.active_memory_id) ||
        new Set(parsedTreeBufferBindings.map(({ jobId }) => jobId)).size !==
          actualBindingCount ||
        !parsedTreeBufferBindings.some(({ jobId, treeType, treeKey }) =>
          jobId === row.source_tree_job_id && treeType === "source" && treeKey === scope.sessionId) ||
        (expectsGlobal !== (row.global_tree_job_id !== null && row.global_leaf_id !== null)) ||
        (expectsGlobal && !parsedTreeBufferBindings.some(({ jobId, treeType, treeKey }) =>
          jobId === row.global_tree_job_id && treeType === "global" &&
          /^\d{4}-\d{2}-\d{2}$/.test(treeKey))) ||
        parsedTreeBufferBindings.filter(({ treeType }) => treeType === "topic").some(
          ({ jobId, treeKey }) => !topicTreeJobIds.includes(jobId) || !topicTreeKeys.includes(treeKey),
        ) ||
        JSON.stringify(actualTreeTypes) !== JSON.stringify(expectedTreeTypes) ||
        (expectsTopic &&
          (topicTreeJobIds.length === 0 || topicLeafIds.length === 0 ||
          topicTreeKeys.length === 0 || topicTreeJobIds.length !== topicLeafIds.length ||
          topicTreeJobIds.length !== topicTreeKeys.length)) ||
        (!expectsTopic &&
          (topicTreeJobIds.length !== 0 || topicLeafIds.length !== 0 || topicTreeKeys.length !== 0))) {
      return null;
    }
    const ledgerIds = [row.storage_key, ...memoryEvidenceLinkIds,
      ...entityEvidenceLinkIds, ...relationEvidenceLinkIds,
      ...workMemoryNodeIds, ...workMemoryEdgeIds].sort();
    return {
      candidateJobId: row.candidate_job_id,
      candidateAttempts: Number(row.candidate_attempts),
      activeMemoryId: row.active_memory_id,
      graphJobId: row.graph_job_id,
      graphAttempts: Number(row.graph_attempts),
      graphEntityIds, graphRelationIds,
      sourceTreeJobId: row.source_tree_job_id,
      sourceTreeKey: scope.sessionId,
      globalTreeJobId: row.global_tree_job_id,
      topicTreeJobIds,
      topicTreeKeys,
      sourceLeafId: row.source_leaf_id,
      globalLeafId: row.global_leaf_id,
      topicLeafIds,
      treeBufferIds,
      storageKey: row.storage_key,
      memoryEvidenceLinkIds, entityEvidenceLinkIds, relationEvidenceLinkIds,
      memoryEvidenceBindings, entityEvidenceBindings, relationEvidenceBindings,
      workMemoryNodeIds, workMemoryActiveNodeId, workMemoryEvidenceNodeId, workMemoryEdgeIds,
      workMemoryEdgeBindings: parsedWorkMemoryEdgeBindings,
      candidateGovernance: {
        memoryKind: governance.memoryKind as MemoryKind,
        semanticType: semanticType as MemorySemanticType,
        admissionRoute: "active",
        lifecycleStatus: "active",
        contextEligible: true,
        valueScore: governance.valueScore,
        importance: governance.importance,
        confidence: governance.confidence,
        treeRouting: routingFacts,
        validatorAudit,
        dedupTrace: {
          created: 1,
          duplicateCount,
          capacityRejectedCount,
          droppedCount,
          candidateIds,
          memoryIds,
          activeMemoryIds,
        },
      },
      effectReceiptIds: [
        `${row.candidate_job_id}:${CANDIDATE_EFFECT_KEY}`,
        `${row.graph_job_id}:${GRAPH_EFFECT_KEY}`,
        `${row.source_tree_job_id}:${TREE_EFFECT_KEY}`,
        ...(row.global_tree_job_id === null
          ? []
          : [`${row.global_tree_job_id}:${TREE_EFFECT_KEY}`]),
        ...topicTreeJobIds.map((jobId) => `${jobId}:${TREE_EFFECT_KEY}`),
      ].sort(),
      ledgerIds,
      treeBufferBindings: parsedTreeBufferBindings,
      exactJobCounts,
      expectedTreeTypes,
    };
  } finally {
    await client.end();
  }
}

async function waitForRuntimeChain(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  evidenceId: string,
  timeoutMs: number,
  minimumCandidateAttempts = 1,
  requireTopic = false,
  minimumGraphAttempts = 1,
  expectedTopicKeys?: readonly string[],
): Promise<RuntimeChainEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: RuntimeChainEvidence | null = null;
  while (Date.now() < deadline) {
    latest = await readRuntimeChain(config, scope, evidenceId, requireTopic);
    if (latest && latest.candidateAttempts >= minimumCandidateAttempts &&
        latest.graphAttempts >= minimumGraphAttempts &&
        (expectedTopicKeys === undefined ||
          canonicalTopicKeysSettled(latest.topicTreeKeys, expectedTopicKeys))) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const diagnosticClient = new Client(config);
  await diagnosticClient.connect();
  try {
    const diagnostics = await diagnosticClient.query(`SELECT
  job.id, job.type, job.status, job.attempts, job.last_error_code,
  job.last_error_retryable, receipt.effect_key, receipt.result
FROM mengshu_jobs_v2 job
LEFT JOIN mengshu_job_v2_effect_receipts receipt ON receipt.job_id = job.id
WHERE job.tenant_id = $1 AND job.user_id = $2 AND job.app_id = $3 AND job.project_id = $4
  AND job.agent_id = $5 AND job.namespace = $6 AND job.visibility = $7
  AND COALESCE(job.payload #>> '{scope,workspaceId}', '') = $8
  AND COALESCE(job.payload #>> '{scope,sessionId}', '') = $9
  AND (job.payload->>'traceId' = $10 OR job.payload->>'evidenceId' = $10
    OR job.payload #>> '{leaf,chunkId}' = $10)
ORDER BY job.created_at, job.id`, [
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId, evidenceId,
    ]);
    throw new Error(
      `production RuntimeHost five-stage evidence timed out: ${JSON.stringify({
        latest,
        jobs: diagnostics.rows,
      })}`,
    );
  } finally {
    await diagnosticClient.end();
  }
}

async function readColdTopicState(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  evidenceId: string,
  activeMemoryId: string,
): Promise<{ readonly jobIds: string[]; readonly bufferIds: string[] }> {
  const client = new Client(config);
  await client.connect();
  try {
    const jobs = await client.query<{ id: string }>(`SELECT id
FROM mengshu_jobs_v2
WHERE type = 'build_tree' AND payload->>'treeType' = 'topic'
  AND payload #>> '{leaf,id}' = $1 AND payload #>> '{leaf,chunkId}' = $2
  AND tenant_id = $3 AND user_id = $4 AND app_id = $5 AND project_id = $6
  AND agent_id = $7 AND namespace = $8 AND visibility = $9
  AND COALESCE(payload #>> '{scope,workspaceId}', '') = $10
  AND COALESCE(payload #>> '{scope,sessionId}', '') = $11
ORDER BY id`, [
      activeMemoryId, evidenceId, scope.tenantId, scope.userId, scope.appId,
      scope.projectId, scope.agentId, scope.namespace, scope.visibility,
      scope.workspaceId, scope.sessionId,
    ]);
    const buffers = await client.query<{ id: string }>(`SELECT id
FROM mengshu_tree_buffers
WHERE tree_type = 'topic' AND leaf_ids ? $1
  AND tenant_id = $2 AND user_id = $3 AND app_id = $4 AND project_id = $5
  AND agent_id = $6 AND namespace = $7 AND visibility = $8
  AND workspace_id = $9 AND session_id = $10
ORDER BY id`, [
      activeMemoryId, scope.tenantId, scope.userId, scope.appId, scope.projectId,
      scope.agentId, scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
    ]);
    return Object.freeze({
      jobIds: jobs.rows.map(({ id }) => id),
      bufferIds: buffers.rows.map(({ id }) => id),
    });
  } finally {
    await client.end();
  }
}

function hotnessSnapshot(
  row: Record<string, unknown>,
  now: number,
): RuntimeHotnessEvidence | null {
  if (typeof row.id !== "string" || typeof row.canonical_name !== "string") return null;
  const mentionCount30d = Number(row.mention_count_30d);
  const distinctSourceCount = Number(row.distinct_source_count);
  const lastSeenAt = Number(row.last_seen_at);
  const graphCentrality = Number(row.graph_centrality);
  const queryHits30d = Number(row.query_hits_30d);
  if (![mentionCount30d, distinctSourceCount, lastSeenAt, graphCentrality, queryHits30d]
    .every(Number.isFinite)) return null;
  const decay = recencyDecay(now, lastSeenAt);
  const weights = SCORING_WEIGHTS_V1.hotness;
  return Object.freeze({
    topicEntityId: row.id,
    canonicalName: row.canonical_name,
    mentionCount30d,
    distinctSourceCount,
    lastSeenAt,
    recencyDecay: decay,
    graphCentrality,
    queryHits30d,
    score: weights.ln_mention_coeff * Math.log(mentionCount30d + 1) +
      weights.distinct_source_coeff * distinctSourceCount + decay +
      weights.centrality_coeff * graphCentrality + weights.query_hits_coeff * queryHits30d,
  });
}

async function readCanonicalTopicHotness(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  entityIds: readonly string[],
): Promise<RuntimeHotnessEvidence[]> {
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT
  id, canonical_name, mention_count_30d, distinct_source_count,
  last_seen_at, graph_centrality, query_hits_30d
FROM mengshu_graph_entities
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = $9
  AND id = ANY($10::text[]) AND status = 'active'
ORDER BY id`, [
      scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
      scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId,
      [...entityIds],
    ]);
    const now = Date.now();
    return result.rows.flatMap((row) => {
      const snapshot = hotnessSnapshot(row, now);
      return snapshot ? [snapshot] : [];
    });
  } finally {
    await client.end();
  }
}

async function waitForCanonicalTopicHotness(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  entityId: string,
  timeoutMs: number,
): Promise<RuntimeHotnessEvidence> {
  const deadline = Date.now() + timeoutMs;
  let latest: RuntimeHotnessEvidence | undefined;
  while (Date.now() < deadline) {
    [latest] = await readCanonicalTopicHotness(config, scope, [entityId]);
    if (latest && latest.score >= TOPIC_CREATION_THRESHOLD) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`canonical topic hotness timed out: ${JSON.stringify(latest)}`);
}

export const PRODUCTION_CANDIDATE_REPLAY_SQL = `UPDATE mengshu_jobs_v2 SET
  status = 'retry_wait', next_attempt_at = $2,
  lease_owner = NULL, lease_token = NULL, lease_until = NULL, heartbeat_at = NULL,
  last_error_code = 'RUNTIME_E2E_REPLAY', last_error_retryable = TRUE,
  last_error_fingerprint = $3, updated_at = $2
WHERE id = $1 AND type = 'extract_candidate' AND status = 'completed'
  AND attempts < max_attempts
  AND tenant_id = $4 AND user_id = $5 AND app_id = $6 AND project_id = $7
  AND agent_id = $8 AND namespace = $9 AND visibility = $10
  AND COALESCE(payload #>> '{scope,workspaceId}', '') = $11
  AND COALESCE(payload #>> '{scope,sessionId}', '') = $12`;

export const PRODUCTION_GRAPH_REPLAY_SQL = `UPDATE mengshu_jobs_v2 SET
  status = 'retry_wait', next_attempt_at = $2,
  lease_owner = NULL, lease_token = NULL, lease_until = NULL, heartbeat_at = NULL,
  last_error_code = 'RUNTIME_E2E_D21_REPLAY', last_error_retryable = TRUE,
  last_error_fingerprint = $3, updated_at = $2
WHERE id = $1 AND type = 'extract_graph' AND status = 'completed'
  AND attempts < max_attempts
  AND tenant_id = $4 AND user_id = $5 AND app_id = $6 AND project_id = $7
  AND agent_id = $8 AND namespace = $9 AND visibility = $10
  AND COALESCE(payload #>> '{scope,workspaceId}', '') = $11
  AND COALESCE(payload #>> '{scope,sessionId}', '') = $12
  AND payload->>'activeMemoryId' = $13 AND payload->>'evidenceId' = $14`;

export const PRODUCTION_BUILD_TREE_REPLAY_SQL = `UPDATE mengshu_jobs_v2 SET
  status = 'retry_wait', next_attempt_at = $2,
  lease_owner = NULL, lease_token = NULL, lease_until = NULL, heartbeat_at = NULL,
  last_error_code = 'RUNTIME_E2E_REPLAY', last_error_retryable = TRUE,
  last_error_fingerprint = $3, updated_at = $2
WHERE id = $1 AND type = 'build_tree' AND status = 'completed'
  AND attempts < max_attempts
  AND payload->>'treeType' = 'source' AND payload->>'treeKey' = $12
  AND tenant_id = $4 AND user_id = $5 AND app_id = $6 AND project_id = $7
  AND agent_id = $8 AND namespace = $9 AND visibility = $10
  AND COALESCE(payload #>> '{scope,workspaceId}', '') = $11
  AND COALESCE(payload #>> '{scope,sessionId}', '') = $12`;

async function scheduleCandidateReplay(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  candidateJobId: string,
): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    const now = Date.now();
    const result = await client.query(
      PRODUCTION_CANDIDATE_REPLAY_SQL,
      [
        candidateJobId, now, "0".repeat(64), scope.tenantId, scope.userId,
        scope.appId, scope.projectId, scope.agentId, scope.namespace, scope.visibility,
        scope.workspaceId, scope.sessionId,
      ],
    );
    if (result.rowCount !== 1) throw new Error("production candidate replay scheduling failed");
  } finally {
    await client.end();
  }
}

async function scheduleGraphReplay(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  graphJobId: string,
  activeMemoryId: string,
  evidenceId: string,
): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    const now = Date.now();
    const result = await client.query(PRODUCTION_GRAPH_REPLAY_SQL, [
      graphJobId, now, "0".repeat(64), scope.tenantId, scope.userId,
      scope.appId, scope.projectId, scope.agentId, scope.namespace, scope.visibility,
      scope.workspaceId, scope.sessionId, activeMemoryId, evidenceId,
    ]);
    if (result.rowCount !== 1) throw new Error("production graph replay scheduling failed");
  } finally {
    await client.end();
  }
}

async function scheduleBuildTreeReplay(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  jobId: string,
): Promise<void> {
  const client = new Client(config);
  await client.connect();
  try {
    const now = Date.now();
    const result = await client.query(PRODUCTION_BUILD_TREE_REPLAY_SQL, [
      jobId, now, "0".repeat(64), scope.tenantId, scope.userId,
      scope.appId, scope.projectId, scope.agentId, scope.namespace, scope.visibility,
      scope.workspaceId, scope.sessionId,
    ]);
    if (result.rowCount !== 1) throw new Error("production build_tree replay scheduling failed");
  } finally {
    await client.end();
  }
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 3_000)),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

function idsFromContext(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const slots = (value as { slots?: Record<string, { sourceIds?: unknown }> }).slots ?? {};
  return [...new Set(Object.values(slots).flatMap((slot) => strings(slot?.sourceIds)))];
}

function contextSlots(value: unknown): Record<string, {
  sourceIds?: unknown;
  recallReceipts?: unknown;
}> {
  if (!plainObject(value) || !plainObject(value.slots)) return {};
  return value.slots as Record<string, { sourceIds?: unknown }>;
}

function contextRecallHit(
  value: unknown,
  semanticType: MemorySemanticType,
  sourceId: string,
): RuntimeRecallHit | undefined {
  const slot = contextSlots(value)[semanticType];
  if (!plainObject(slot) || !Array.isArray(slot.recallReceipts)) return undefined;
  return runtimeRecallHits({
    hits: slot.recallReceipts.map((receipt) => plainObject(receipt)
      ? { ...receipt, id: receipt.sourceId }
      : receipt),
  }).find((hit) => hit.id === sourceId);
}

function semanticRecord<T>(entries: Array<readonly [MemorySemanticType, T]>): Record<MemorySemanticType, T> {
  return Object.fromEntries(entries) as Record<MemorySemanticType, T>;
}

function normalizedSlotSourceIds(
  value: Record<MemorySemanticType, string[]>,
): Record<MemorySemanticType, string[]> {
  return semanticRecord(SEMANTIC_TYPES.map((semanticType) => [
    semanticType,
    [...new Set(value[semanticType])].sort(),
  ] as const));
}

function idsFromHits(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const hits = (value as { hits?: Array<Record<string, unknown>> }).hits ?? [];
  return [...new Set(hits.flatMap((hit) => {
    if (typeof hit.id === "string") return [hit.id];
    const record = hit.record;
    return record && typeof record === "object" && typeof (record as { id?: unknown }).id === "string"
      ? [(record as { id: string }).id]
      : [];
  }))];
}

interface RuntimeRecallHit {
  readonly id: string;
  readonly score: number;
  readonly scoreBreakdown: RecallHit["scoreBreakdown"];
}

function runtimeRecallHits(value: unknown): RuntimeRecallHit[] {
  if (!plainObject(value) || !Array.isArray(value.hits)) return [];
  return value.hits.flatMap((item) => {
    if (!plainObject(item) || typeof item.score !== "number" || !plainObject(item.scoreBreakdown)) {
      return [];
    }
    const record = plainObject(item.record) ? item.record : item;
    return typeof record.id === "string"
      ? [{ id: record.id, score: item.score, scoreBreakdown: item.scoreBreakdown }]
      : [];
  });
}

function hasCompleteMultisourceRecall(
  hit: RuntimeRecallHit | undefined,
): hit is RuntimeRecallHit & { scoreBreakdown: CompleteRecallScoreBreakdown } {
  if (!hit) return false;
  const breakdown = hit.scoreBreakdown;
  if (!isRecallScoreBreakdown(breakdown) || Math.abs(hit.score - breakdown.score) > 1e-9) {
    return false;
  }
  const matchedBy = new Set(breakdown.matchedBy);
  const signals = new Set(Object.keys(breakdown.sourceSignals));
  return (["vector", "text", "graph", "tree"] as const)
    .every((source) => matchedBy.has(source)) &&
    ["vector", "bm25", "entity_graph", "work_memory_graph", "tree"]
      .every((source) => signals.has(source));
}

function completeMultisourceBreakdown(
  hit: RuntimeRecallHit | undefined,
): CompleteRecallScoreBreakdown | undefined {
  return hasCompleteMultisourceRecall(hit) ? hit.scoreBreakdown : undefined;
}

function validRecallBreakdown(
  hit: RuntimeRecallHit | undefined,
): CompleteRecallScoreBreakdown | undefined {
  if (!hit || !isRecallScoreBreakdown(hit.scoreBreakdown) ||
      Math.abs(hit.score - hit.scoreBreakdown.score) > 1e-9) return undefined;
  return hit.scoreBreakdown;
}

function recallBreakdownDiagnostic(hit: RuntimeRecallHit | undefined): Readonly<Record<string, unknown>> {
  if (!hit) return Object.freeze({ present: false });
  const breakdown = hit.scoreBreakdown;
  return Object.freeze({
    present: true,
    scoreConsistent: isRecallScoreBreakdown(breakdown) &&
      Math.abs(hit.score - breakdown.score) <= 1e-9,
    matchedBy: isRecallScoreBreakdown(breakdown) ? [...breakdown.matchedBy].sort() : [],
    sourceSignals: isRecallScoreBreakdown(breakdown)
      ? Object.keys(breakdown.sourceSignals).sort()
      : [],
  });
}

function filteredReasonCounts(value: unknown): Record<string, number> {
  if (!plainObject(value) || !Array.isArray(value.filtered)) return {};
  const counts: Record<string, number> = {};
  for (const item of value.filtered) {
    if (!plainObject(item) || typeof item.filteredReason !== "string" ||
        !/^[a-z_]{1,64}$/.test(item.filteredReason)) continue;
    counts[item.filteredReason] = (counts[item.filteredReason] ?? 0) + 1;
  }
  return counts;
}

async function readFiveSlotDiagnostics(
  config: RuntimeE2ePostgresConfig,
  scope: RuntimeE2eScope,
  expectedIds: Record<MemorySemanticType, string>,
): Promise<readonly Record<string, unknown>[]> {
  const client = new Client(config);
  await client.connect();
  try {
    const result = await client.query<Record<string, unknown>>(`SELECT
  id::text AS id,
  lifecycle_status,
  metadata->>'admissionRoute' AS admission_route,
  metadata->>'contextEligible' AS context_eligible,
  metadata->>'semanticType' AS semantic_type,
  metadata #>> '{governance,native,kind}' AS native_kind,
  metadata #>> '{governance,native,semanticType}' AS native_semantic_type,
  COALESCE(metadata->>'sessionId', metadata #>> '{governance,provenance,sessionId}', '')
    AS effective_session_id,
  metadata #>> '{governance,provenance,sessionId}' AS governance_session_id,
  jsonb_typeof(metadata->'sourceNodeIds') AS source_ids_type,
  jsonb_typeof(metadata #> '{governance,evidenceIds}') AS evidence_ids_type,
  jsonb_typeof(metadata #> '{governance,candidate,evidence,eventIds}') AS event_ids_type,
  jsonb_array_length(COALESCE(metadata #> '{governance,evidenceIds}', '[]'::jsonb))
    AS evidence_id_count,
  metadata->'sourceNodeIds' = metadata #> '{governance,evidenceIds}' AS source_evidence_match,
  metadata #> '{governance,evidenceIds}' =
    metadata #> '{governance,candidate,evidence,eventIds}' AS evidence_event_match
FROM memories
WHERE id::text = ANY($1::text[])
  AND tenant_id = $2 AND user_id = $3 AND product_id = $4
  AND canonical_project_id = $5 AND producer_id = $6 AND namespace = $7
  AND visibility = $8 AND COALESCE(workspace_id, '') = $9
ORDER BY id`, [
      Object.values(expectedIds), scope.tenantId, scope.userId, scope.appId,
      scope.projectId, scope.agentId, scope.namespace, scope.visibility, scope.workspaceId,
    ]);
    return result.rows;
  } finally {
    await client.end();
  }
}

async function waitForFiveSlotContext(
  config: RuntimeE2ePostgresConfig,
  baseUrl: string,
  scope: RuntimeE2eScope,
  task: string,
  expectedIds: Record<MemorySemanticType, string>,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  let latest: unknown;
  while (Date.now() < deadline) {
    latest = await postJson<unknown>(baseUrl, "/v1/agent/context", {
      scope: clientScope(scope),
      task,
    });
    const ready = SEMANTIC_TYPES.every((semanticType) => {
      const expectedId = expectedIds[semanticType];
      return strings(contextSlots(latest)[semanticType]?.sourceIds).includes(expectedId) &&
        validRecallBreakdown(contextRecallHit(latest, semanticType, expectedId)) !== undefined;
    });
    if (ready) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const slots = contextSlots(latest);
  const diagnostics = await readFiveSlotDiagnostics(config, scope, expectedIds);
  throw new Error(`production five-slot context timed out: ${JSON.stringify({
    readySlots: SEMANTIC_TYPES.filter((semanticType) =>
      strings(slots[semanticType]?.sourceIds).includes(expectedIds[semanticType])),
    completeSlots: SEMANTIC_TYPES.filter((semanticType) =>
      validRecallBreakdown(contextRecallHit(
        latest, semanticType, expectedIds[semanticType],
      )) !== undefined),
    contextSourceIds: idsFromContext(latest),
    filteredReasons: filteredReasonCounts(latest),
    persisted: diagnostics,
  })}`);
}

/**
 * Explicit-live runner. RuntimeHost, REST, workers, PostgreSQL, embedding and LLM
 * all come from the operator-owned production configuration.
 */
export async function runProductionRestRuntimeE2eSuite(
  fixturePath: string,
  options: ProductionRestRuntimeE2eOptions,
): Promise<{ results: CaseResult[]; summary: SuiteSummary }> {
  if (process.env.MENGSHU_RUN_LIVE_TESTS !== "1") {
    throw new Error("runtime-e2e requires MENGSHU_RUN_LIVE_TESTS=1");
  }
  const goldenCase = parseRuntimeRestFixture(fixturePath);
  if (!options.configPath.trim() || !options.embeddingModel.trim() ||
      !options.extractionModel.trim()) {
    throw new Error("runtime-e2e requires operator config and provider identities");
  }
  const isolation = createRuntimeIsolation();
  const sealIsolation = createRuntimeIsolation();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
  let child: ChildProcessWithoutNullStreams | undefined;
  const startedAt = Date.now();
  try {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawnProductionServe(projectRoot, options.configPath, port, isolation.scope);
    const health = await waitForHealth(child, baseUrl, timeoutMs);
    const coldObserved = await postJson<ObserveResponse>(baseUrl, "/v1/agent/observe", {
      scope: clientScope(isolation.scope), eventType: "observation",
      text: goldenCase.input.observations[0].text, intent: "remember",
      idempotencyKey: goldenCase.input.observations[0].idempotencyKey,
    });
    progress(options, "initial_graph_tree", 0, 1);
    const coldChain = await waitForRuntimeChain(
      options.postgres, isolation.scope, coldObserved.persistedId, timeoutMs,
    );
    progress(options, "initial_graph_tree", 1, 1);
    const coldTopicState = await readColdTopicState(
      options.postgres, isolation.scope, coldObserved.persistedId, coldChain.activeMemoryId,
    );
    const coldHotnessCandidates = await readCanonicalTopicHotness(
      options.postgres, isolation.scope, coldChain.graphEntityIds,
    );
    const coldHotness = selectColdHotnessWitness(
      coldHotnessCandidates,
      coldChain.graphEntityIds,
      goldenCase.input.observations[0].text,
    );
    if (!coldHotness) {
      throw new Error(`cold canonical topic witness was unavailable: ${JSON.stringify({
        candidates: coldHotnessCandidates,
        receiptEntityIds: coldChain.graphEntityIds,
      })}`);
    }
    const warmupRecallA = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: goldenCase.input.query, minScore: 0, limit: 10,
    });
    const warmupRecallB = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: goldenCase.input.query, minScore: 0, limit: 10,
    });
    const warmupRecallC = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: goldenCase.input.query, minScore: 0, limit: 10,
    });
    const hotTopic = await waitForCanonicalTopicHotness(
      options.postgres, isolation.scope, coldHotness.topicEntityId, timeoutMs,
    );
    await scheduleGraphReplay(
      options.postgres, isolation.scope, coldChain.graphJobId,
      coldChain.activeMemoryId, coldObserved.persistedId,
    );
    const topicProjectionStarted = await waitForRuntimeChain(
      options.postgres, isolation.scope, coldObserved.persistedId, timeoutMs, 1, true,
      coldChain.graphAttempts + 1,
    );
    const postReplayHotness = await readCanonicalTopicHotness(
      options.postgres, isolation.scope, topicProjectionStarted.graphEntityIds,
    );
    const expectedCanonicalTopicKeys = [...new Set(postReplayHotness
      .filter(({ score }) => score >= TOPIC_CREATION_THRESHOLD)
      .map(({ canonicalName }) => normalizeTopicLabel(canonicalName)))]
      .filter((key) => key.length > 0)
      .sort();
    const beforeRestart = await waitForRuntimeChain(
      options.postgres, isolation.scope, coldObserved.persistedId, timeoutMs, 1, true,
      coldChain.graphAttempts + 1, expectedCanonicalTopicKeys,
    );
    const multisourceTopic = selectHotMultisourceWitness(hotTopic, beforeRestart.topicTreeKeys);
    if (!multisourceTopic) {
      throw new Error(`post-replay canonical topic witness was unavailable: ${JSON.stringify({
        actualTopicTreeKeys: [...beforeRestart.topicTreeKeys].sort(),
        expectedCanonicalTopicKeys,
      })}`);
    }
    const observed = await postJson<ObserveResponse>(baseUrl, "/v1/agent/observe", {
      scope: clientScope(isolation.scope), eventType: "observation",
      text: goldenCase.input.observations[1].text, intent: "remember",
      idempotencyKey: goldenCase.input.observations[1].idempotencyKey,
    });
    const secondaryChain = await waitForRuntimeChain(
      options.postgres, isolation.scope, observed.persistedId, timeoutMs,
    );
    const pendingObserved = await postJson<ObserveResponse>(baseUrl, "/v1/agent/observe", {
      scope: clientScope(isolation.scope), eventType: "observation",
      text: goldenCase.input.pendingObservation.text, intent: "auto",
      idempotencyKey: goldenCase.input.pendingObservation.idempotencyKey,
    });
    const pendingPersistedBeforeRestart = await waitForPendingCandidateEvidence(
      options.postgres, isolation.scope, pendingObserved.persistedId, timeoutMs * 2,
    );

    const slotSaveResponses: ExplicitSaveResponse[] = [];
    progress(options, "slot_save", 0, 5);
    for (const slotMemory of goldenCase.input.slotMemories) {
      try {
        slotSaveResponses.push(await postJson<ExplicitSaveResponse>(baseUrl, "/v1/memories", {
          idempotencyKey: slotMemory.idempotencyKey,
          record: {
            scope: clientScope(isolation.scope),
            text: slotMemory.text,
            kind: slotMemory.kind,
            semanticType: slotMemory.semanticType,
            ...(slotMemory.metadata === undefined ? {} : { metadata: slotMemory.metadata }),
          },
        }));
        progress(options, "slot_save", slotSaveResponses.length, 5);
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        throw new Error(`production ${slotMemory.semanticType} slot save failed: ${detail}`);
      }
    }
    const slotActiveMemoryIds = semanticRecord(slotSaveResponses.map((response, index) => [
      SEMANTIC_TYPES[index]!, response.id,
    ] as const));
    const sharedRecallQuery = [
      multisourceTopic.canonicalName,
      goldenCase.input.query,
      ...goldenCase.input.slotMemories.map(({ text }) => text),
    ].join("\n");

    const context = await waitForFiveSlotContext(
      options.postgres, baseUrl, isolation.scope, sharedRecallQuery, slotActiveMemoryIds, timeoutMs,
    );
    const lookup = await postJson<unknown>(baseUrl, "/v1/agent/lookup", {
      scope: clientScope(isolation.scope), query: sharedRecallQuery, minScore: 0, limit: 10,
    });
    const recall = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: sharedRecallQuery, minScore: 0, limit: 10,
    });
    const pendingContext = await postJson<unknown>(baseUrl, "/v1/agent/context", {
      scope: clientScope(isolation.scope), task: goldenCase.input.pendingQuery,
    });
    const pendingLookup = await postJson<unknown>(baseUrl, "/v1/agent/lookup", {
      scope: clientScope(isolation.scope), query: goldenCase.input.pendingQuery, minScore: 0, limit: 10,
    });
    const pendingRecall = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: goldenCase.input.pendingQuery, minScore: 0, limit: 10,
    });
    const pendingBeforeRestart: RuntimePendingCandidateEvidence = {
      ...pendingPersistedBeforeRestart,
      visibility: {
        contextSourceIds: idsFromContext(pendingContext),
        lookupHitIds: idsFromHits(pendingLookup),
        recallHitIds: idsFromHits(pendingRecall),
      },
    };
    const contextSourceIds = idsFromContext(context);
    const slots = contextSlots(context);
    const filledSlots = Object.entries(slots)
      .filter(([, slot]) => strings(slot.sourceIds).length > 0)
      .map(([semanticType]) => semanticType as MemorySemanticType)
      .sort();
    const governedSlotSourceIds = strings(
      slots[beforeRestart.candidateGovernance.semanticType]?.sourceIds,
    );
    const slotSourceIds = semanticRecord(SEMANTIC_TYPES.map((semanticType) => [
      semanticType, strings(slots[semanticType]?.sourceIds),
    ] as const));
    const slotScoreBreakdowns = semanticRecord(SEMANTIC_TYPES.map((semanticType) => [
      semanticType,
      validRecallBreakdown(contextRecallHit(
        context, semanticType, slotActiveMemoryIds[semanticType],
      )),
    ] as const));
    const lookupHitIds = idsFromHits(lookup);
    const recallHitIds = idsFromHits(recall);

    await stopChild(child);
    child = undefined;

    child = spawnProductionServe(projectRoot, options.configPath, port, sealIsolation.scope);
    await waitForHealth(child, baseUrl, timeoutMs);
    const sealSaveResponses: ExplicitSaveResponse[] = [];
    progress(options, "seal_save", 0, 20);
    for (const sealedMemory of goldenCase.input.sealedSourceMemories) {
      sealSaveResponses.push(await postJson<ExplicitSaveResponse>(baseUrl, "/v1/memories", {
        idempotencyKey: sealedMemory.idempotencyKey,
        record: {
          scope: clientScope(sealIsolation.scope),
          text: sealedMemory.text,
          kind: "other",
          semanticType: "rules",
          metadata: sealedMemory.metadata,
        },
      }));
      progress(options, "seal_save", sealSaveResponses.length, 20);
    }
    if (sealSaveResponses.some((response) => response.stored !== true ||
        response.status !== "persisted" || response.route !== "active" ||
        response.recordType !== "memory") ||
        new Set(sealSaveResponses.map(({ id }) => id)).size !== 20) {
      throw new Error("production sealed source fixture did not persist 20 unique active memories");
    }
    const sealedActiveMemoryIds = sealSaveResponses.map(({ id }) => id);
    progress(options, "sealed_summary_ready", 0, 1);
    const sealedSummaryBeforeRestart = await waitForProductionSealedSummary(
      options.postgres, sealIsolation.scope, sealedActiveMemoryIds, timeoutMs,
    );
    progress(options, "sealed_summary_ready", 1, 1);
    await stopChild(child);
    child = undefined;
    progress(options, "restart_replay", 0, 3);
    await scheduleBuildTreeReplay(
      options.postgres, sealIsolation.scope, sealedSummaryBeforeRestart.jobId,
    );
    child = spawnProductionServe(projectRoot, options.configPath, port, sealIsolation.scope);
    await waitForHealth(child, baseUrl, timeoutMs);
    const sealedSummaryAfterRestart = await waitForProductionSealedSummary(
      options.postgres, sealIsolation.scope, sealedActiveMemoryIds, timeoutMs,
      sealedSummaryBeforeRestart.jobAttempts + 1,
    );
    progress(options, "restart_replay", 1, 3);
    await stopChild(child);
    child = undefined;

    const preReplay = await waitForRuntimeChain(
      options.postgres, isolation.scope, coldObserved.persistedId, timeoutMs, 1, true,
      beforeRestart.graphAttempts, expectedCanonicalTopicKeys,
    );
    await scheduleCandidateReplay(options.postgres, isolation.scope, beforeRestart.candidateJobId);
    await scheduleCandidateReplay(
      options.postgres, isolation.scope, pendingBeforeRestart.jobId,
    );
    child = spawnProductionServe(projectRoot, options.configPath, port, isolation.scope);
    await waitForHealth(child, baseUrl, timeoutMs);
    const afterRestart = await waitForRuntimeChain(
      options.postgres, isolation.scope, coldObserved.persistedId, timeoutMs,
      beforeRestart.candidateAttempts + 1, true, beforeRestart.graphAttempts,
      expectedCanonicalTopicKeys,
    );
    progress(options, "restart_replay", 2, 3);
    const pendingPersistedAfterRestart = await waitForPendingCandidateEvidence(
      options.postgres, isolation.scope, pendingObserved.persistedId, timeoutMs,
      pendingBeforeRestart.candidateAttempts + 1,
    );
    progress(options, "restart_replay", 3, 3);
    const contextAfterRestart = await waitForFiveSlotContext(
      options.postgres, baseUrl, isolation.scope, sharedRecallQuery, slotActiveMemoryIds, timeoutMs,
    );
    const lookupAfterRestart = await postJson<unknown>(baseUrl, "/v1/agent/lookup", {
      scope: clientScope(isolation.scope), query: sharedRecallQuery, minScore: 0, limit: 10,
    });
    const recallAfterRestart = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: sharedRecallQuery, minScore: 0, limit: 10,
    });
    const pendingContextAfterRestart = await postJson<unknown>(baseUrl, "/v1/agent/context", {
      scope: clientScope(isolation.scope), task: goldenCase.input.pendingQuery,
    });
    const pendingLookupAfterRestart = await postJson<unknown>(baseUrl, "/v1/agent/lookup", {
      scope: clientScope(isolation.scope), query: goldenCase.input.pendingQuery, minScore: 0, limit: 10,
    });
    const pendingRecallAfterRestart = await postJson<unknown>(baseUrl, "/v1/recall", {
      scope: clientScope(isolation.scope), query: goldenCase.input.pendingQuery, minScore: 0, limit: 10,
    });
    const pendingAfterRestart: RuntimePendingCandidateEvidence = {
      ...pendingPersistedAfterRestart,
      visibility: {
        contextSourceIds: idsFromContext(pendingContextAfterRestart),
        lookupHitIds: idsFromHits(pendingLookupAfterRestart),
        recallHitIds: idsFromHits(pendingRecallAfterRestart),
      },
    };
    const contextSourceIdsAfterRestart = idsFromContext(contextAfterRestart);
    const lookupHitIdsAfterRestart = idsFromHits(lookupAfterRestart);
    const recallHitIdsAfterRestart = idsFromHits(recallAfterRestart);
    const slotSourceIdsAfterRestart = semanticRecord(SEMANTIC_TYPES.map((semanticType) => [
      semanticType, strings(contextSlots(contextAfterRestart)[semanticType]?.sourceIds),
    ] as const));

    const failures: string[] = [];
    if (health.ok !== goldenCase.expected.healthOk) failures.push("health.ok mismatch");
    if (coldChain.topicTreeJobIds.length !== 0 || coldChain.topicLeafIds.length !== 0 ||
        coldTopicState.jobIds.length !== 0 || coldTopicState.bufferIds.length !== 0) {
      failures.push("cold canonical topic must remain a D-03/D-21 no-op");
    }
    if (![idsFromHits(warmupRecallA), idsFromHits(warmupRecallB), idsFromHits(warmupRecallC)]
      .every((ids) => ids.includes(coldChain.activeMemoryId)) ||
        hotTopic.score < TOPIC_CREATION_THRESHOLD ||
        hotTopic.queryHits30d <= coldHotness.queryHits30d) {
      failures.push("real recall did not accumulate canonical topic query hits");
    }
    if (coldObserved.ack !== true || coldObserved.stored !== true ||
        coldObserved.admissionRoute !== "evidence_only" ||
        coldObserved.queuedJobs[0] !== coldChain.candidateJobId) {
      failures.push("cold REST observe receipt mismatch");
    }
    if (observed.ack !== true || observed.stored !== true ||
        observed.admissionRoute !== "evidence_only" || observed.queuedJobs.length !== 1 ||
        observed.queuedJobs[0] !== secondaryChain.candidateJobId ||
        secondaryChain.activeMemoryId === beforeRestart.activeMemoryId) {
      failures.push("secondary REST observe receipt mismatch");
    }
    if (pendingObserved.ack !== true || pendingObserved.stored !== true ||
        pendingObserved.admissionRoute !== "evidence_only" || pendingObserved.queuedJobs.length !== 1 ||
        pendingObserved.queuedJobs[0] !== pendingBeforeRestart.jobId) {
      failures.push("pending REST auto-observe receipt mismatch");
    }
    if (Object.values(pendingBeforeRestart.visibility).some((ids) =>
        ids.includes(pendingBeforeRestart.candidate.candidateId)) ||
        Object.values(pendingAfterRestart.visibility).some((ids) =>
          ids.includes(pendingAfterRestart.candidate.candidateId))) {
      failures.push("pending candidate leaked into context/lookup/recall");
    }
    if (slotSaveResponses.some((response) => response.stored !== true ||
        response.status !== "persisted" || response.route !== "active" ||
        response.recordType !== "memory") ||
        new Set(Object.values(slotActiveMemoryIds)).size !== SEMANTIC_TYPES.length) {
      failures.push("production saveExplicit did not persist five unique active memories");
    }
    const treeIdentityMismatches = [
      ...(beforeRestart.sourceLeafId === beforeRestart.activeMemoryId ? [] : ["source_leaf"]),
      ...(beforeRestart.expectedTreeTypes.includes("global")
        ? beforeRestart.globalLeafId === beforeRestart.activeMemoryId ? [] : ["global_leaf"]
        : beforeRestart.globalLeafId === null ? [] : ["unexpected_global_leaf"]),
      ...(beforeRestart.expectedTreeTypes.includes("topic") &&
          beforeRestart.topicLeafIds.length === 0 ? ["missing_topic_leaf"] : []),
      ...(beforeRestart.topicLeafIds.some((leafId) => leafId !== beforeRestart.activeMemoryId)
        ? ["topic_leaf"] : []),
      ...(beforeRestart.graphEntityIds.includes(hotTopic.topicEntityId)
        ? [] : ["hot_topic_receipt"]),
      ...(beforeRestart.expectedTreeTypes.includes("topic") &&
          JSON.stringify([...beforeRestart.topicTreeKeys].sort()) !==
            JSON.stringify(expectedCanonicalTopicKeys)
        ? ["canonical_topic_key"] : []),
    ];
    if (treeIdentityMismatches.length > 0) {
      failures.push(`source/global/topic tree identity mismatch: ${
        treeIdentityMismatches.join(",")}; ${JSON.stringify({
          expectedCanonicalTopicKeys,
          actualTopicTreeKeys: [...beforeRestart.topicTreeKeys].sort(),
          topicEntities: postReplayHotness.map(({ topicEntityId, canonicalName, score }) => ({
            topicEntityId, canonicalName, score,
          })),
        })}`);
    }
    const slotIds = Object.values(slotActiveMemoryIds);
    const slotsAreIsolated = SEMANTIC_TYPES.every((semanticType) => {
      const ownId = slotActiveMemoryIds[semanticType];
      const foreignIds = slotIds.filter((id) => id !== ownId);
      return slotSourceIds[semanticType].includes(ownId) &&
        foreignIds.every((foreignId) => !slotSourceIds[semanticType].includes(foreignId));
    });
    if (!governedSlotSourceIds.includes(beforeRestart.activeMemoryId) ||
        JSON.stringify(filledSlots) !== JSON.stringify([...SEMANTIC_TYPES].sort()) ||
        !slotsAreIsolated ||
        ![lookupHitIds, recallHitIds].every((ids) => ids.includes(beforeRestart.activeMemoryId))) {
      failures.push("context/lookup/recall did not preserve the five native semantic slots");
    }
    const activeRecallHit = runtimeRecallHits(recall)
      .find((hit) => hit.id === beforeRestart.activeMemoryId);
    const activeLookupHit = runtimeRecallHits(lookup)
      .find((hit) => hit.id === beforeRestart.activeMemoryId);
    const activeContextHit = contextRecallHit(
      context, beforeRestart.candidateGovernance.semanticType,
      beforeRestart.activeMemoryId,
    );
    const contextScoreBreakdown = completeMultisourceBreakdown(activeContextHit);
    const lookupScoreBreakdown = completeMultisourceBreakdown(activeLookupHit);
    const recallScoreBreakdown = completeMultisourceBreakdown(activeRecallHit);
    const contextScoreBreakdownAfterRestart = completeMultisourceBreakdown(contextRecallHit(
      contextAfterRestart, beforeRestart.candidateGovernance.semanticType,
      beforeRestart.activeMemoryId,
    ));
    const lookupScoreBreakdownAfterRestart = completeMultisourceBreakdown(
      runtimeRecallHits(lookupAfterRestart)
        .find((hit) => hit.id === beforeRestart.activeMemoryId),
    );
    const recallScoreBreakdownAfterRestart = completeMultisourceBreakdown(
      runtimeRecallHits(recallAfterRestart)
        .find((hit) => hit.id === beforeRestart.activeMemoryId),
    );
    if (!contextScoreBreakdown || !lookupScoreBreakdown || !recallScoreBreakdown ||
        !sameCompleteRecallBreakdowns([
          contextScoreBreakdown, lookupScoreBreakdown, recallScoreBreakdown,
        ])) {
      failures.push(`context/lookup/recall did not expose the unique six-factor multisource breakdown: ${
        JSON.stringify({
          context: recallBreakdownDiagnostic(activeContextHit),
          lookup: recallBreakdownDiagnostic(activeLookupHit),
          recall: recallBreakdownDiagnostic(activeRecallHit),
        })}`);
    }
    if (SEMANTIC_TYPES.some((semanticType) => !slotScoreBreakdowns[semanticType])) {
      failures.push("five native slots did not expose a valid six-factor breakdown");
    }
    const effectIdentityChanged = JSON.stringify(afterRestart.effectReceiptIds) !==
      JSON.stringify(preReplay.effectReceiptIds);
    const ledgerIdentityChanged = JSON.stringify(afterRestart.ledgerIds) !==
      JSON.stringify(preReplay.ledgerIds);
    if (effectIdentityChanged || ledgerIdentityChanged) {
      failures.push(`restart replay changed durable identities: ${[
        ...(effectIdentityChanged ? ["effects"] : []),
        ...(ledgerIdentityChanged ? ["ledger"] : []),
      ].join(",")}`);
    }
    if (JSON.stringify(afterRestart.candidateGovernance) !==
          JSON.stringify(preReplay.candidateGovernance) ||
        JSON.stringify(afterRestart.graphEntityIds) !== JSON.stringify(preReplay.graphEntityIds) ||
        JSON.stringify(afterRestart.graphRelationIds) !== JSON.stringify(preReplay.graphRelationIds) ||
        JSON.stringify(afterRestart.treeBufferBindings) !==
          JSON.stringify(preReplay.treeBufferBindings) ||
        JSON.stringify(contextSourceIdsAfterRestart.sort()) !==
          JSON.stringify([...contextSourceIds].sort()) ||
        JSON.stringify(normalizedSlotSourceIds(slotSourceIdsAfterRestart)) !==
          JSON.stringify(normalizedSlotSourceIds(slotSourceIds)) ||
        !lookupHitIdsAfterRestart.includes(beforeRestart.activeMemoryId) ||
        !recallHitIdsAfterRestart.includes(beforeRestart.activeMemoryId) ||
        !contextScoreBreakdownAfterRestart || !lookupScoreBreakdownAfterRestart ||
        !recallScoreBreakdownAfterRestart ||
        !sameCompleteRecallBreakdowns([
          contextScoreBreakdown, lookupScoreBreakdown, recallScoreBreakdown,
          contextScoreBreakdownAfterRestart, lookupScoreBreakdownAfterRestart,
          recallScoreBreakdownAfterRestart,
        ])) {
      failures.push(`restart replay changed governed graph/tree/slot/recall state: ${JSON.stringify({
        governanceChanged: JSON.stringify(afterRestart.candidateGovernance) !==
          JSON.stringify(preReplay.candidateGovernance),
        graphEntitiesChanged: JSON.stringify(afterRestart.graphEntityIds) !==
          JSON.stringify(preReplay.graphEntityIds),
        graphRelationsChanged: JSON.stringify(afterRestart.graphRelationIds) !==
          JSON.stringify(preReplay.graphRelationIds),
        treeBuffersChanged: JSON.stringify(afterRestart.treeBufferBindings) !==
          JSON.stringify(preReplay.treeBufferBindings),
        contextSourcesChanged: JSON.stringify(contextSourceIdsAfterRestart.sort()) !==
          JSON.stringify([...contextSourceIds].sort()),
        slotSourcesChanged: JSON.stringify(normalizedSlotSourceIds(slotSourceIdsAfterRestart)) !==
          JSON.stringify(normalizedSlotSourceIds(slotSourceIds)),
        lookupMissing: !lookupHitIdsAfterRestart.includes(beforeRestart.activeMemoryId),
        recallMissing: !recallHitIdsAfterRestart.includes(beforeRestart.activeMemoryId),
        contextBreakdown: recallBreakdownDiagnostic(contextRecallHit(
          contextAfterRestart, beforeRestart.candidateGovernance.semanticType,
          beforeRestart.activeMemoryId,
        )),
        lookupBreakdown: recallBreakdownDiagnostic(runtimeRecallHits(lookupAfterRestart)
          .find((hit) => hit.id === beforeRestart.activeMemoryId)),
        recallBreakdown: recallBreakdownDiagnostic(runtimeRecallHits(recallAfterRestart)
          .find((hit) => hit.id === beforeRestart.activeMemoryId)),
      })}`);
    }
    if (JSON.stringify(pendingAfterRestart.candidate) !==
          JSON.stringify(pendingBeforeRestart.candidate) ||
        JSON.stringify(pendingAfterRestart.effectTrace) !==
          JSON.stringify(pendingBeforeRestart.effectTrace) ||
        JSON.stringify(pendingAfterRestart.proposalReceipts) !==
          JSON.stringify(pendingBeforeRestart.proposalReceipts) ||
        JSON.stringify(pendingAfterRestart.derivationCounts) !==
          JSON.stringify(pendingBeforeRestart.derivationCounts) ||
        JSON.stringify(pendingAfterRestart.visibility) !==
          JSON.stringify(pendingBeforeRestart.visibility)) {
      failures.push("restart replay changed pending candidate governance or zero-derivation state");
    }
    const { jobAttempts: _sealedAttemptsBefore, ...sealedIdentityBefore } =
      sealedSummaryBeforeRestart;
    const { jobAttempts: _sealedAttemptsAfter, ...sealedIdentityAfter } =
      sealedSummaryAfterRestart;
    if (JSON.stringify(sealedIdentityAfter) !== JSON.stringify(sealedIdentityBefore)) {
      failures.push("restart replay changed sealed source summary, leaf, evidence, or effect identity");
    }

    const stageEvidence: ProductionStageEvidence = {
      write_observe: {
        executed: true,
        receiptIds: [coldObserved.traceId, beforeRestart.storageKey, coldObserved.persistedId],
        traceId: coldObserved.traceId, storageKey: beforeRestart.storageKey,
        evidenceId: coldObserved.persistedId, activeMemoryId: beforeRestart.activeMemoryId,
      },
      candidate: {
        executed: true,
        receiptIds: [beforeRestart.candidateJobId, CANDIDATE_EFFECT_KEY,
          coldObserved.persistedId, beforeRestart.activeMemoryId],
        jobId: beforeRestart.candidateJobId, effectKey: CANDIDATE_EFFECT_KEY,
        evidenceId: coldObserved.persistedId, activeMemoryId: beforeRestart.activeMemoryId,
        ...beforeRestart.candidateGovernance,
        pending: pendingBeforeRestart,
      },
      graph: {
        executed: true,
        receiptIds: [beforeRestart.graphJobId, GRAPH_EFFECT_KEY, coldObserved.persistedId,
          beforeRestart.activeMemoryId, ...beforeRestart.graphEntityIds,
          ...beforeRestart.graphRelationIds, ...beforeRestart.memoryEvidenceLinkIds,
          ...beforeRestart.entityEvidenceLinkIds, ...beforeRestart.relationEvidenceLinkIds,
          ...beforeRestart.workMemoryNodeIds, ...beforeRestart.workMemoryEdgeIds],
        jobId: beforeRestart.graphJobId, effectKey: GRAPH_EFFECT_KEY,
        evidenceId: coldObserved.persistedId, activeMemoryId: beforeRestart.activeMemoryId,
        entityIds: beforeRestart.graphEntityIds, relationIds: beforeRestart.graphRelationIds,
        memoryEvidenceLinkIds: beforeRestart.memoryEvidenceLinkIds,
        entityEvidenceLinkIds: beforeRestart.entityEvidenceLinkIds,
        relationEvidenceLinkIds: beforeRestart.relationEvidenceLinkIds,
        memoryEvidenceBindings: beforeRestart.memoryEvidenceBindings,
        entityEvidenceBindings: beforeRestart.entityEvidenceBindings,
        relationEvidenceBindings: beforeRestart.relationEvidenceBindings,
        workMemoryNodeIds: beforeRestart.workMemoryNodeIds,
        workMemoryActiveNodeId: beforeRestart.workMemoryActiveNodeId,
        workMemoryEvidenceNodeId: beforeRestart.workMemoryEvidenceNodeId,
        workMemoryEdgeIds: beforeRestart.workMemoryEdgeIds,
        workMemoryEdgeBindings: beforeRestart.workMemoryEdgeBindings,
      },
      tree: {
        executed: true,
        receiptIds: [TREE_EFFECT_KEY, beforeRestart.sourceTreeJobId,
          ...(beforeRestart.globalTreeJobId === null ? [] : [beforeRestart.globalTreeJobId]),
          beforeRestart.activeMemoryId,
          ...beforeRestart.topicTreeJobIds,
          ...beforeRestart.treeBufferBindings.map(({ bufferId }) => bufferId),
          sealedSummaryBeforeRestart.jobId, sealedSummaryBeforeRestart.nodeId,
          ...sealedSummaryBeforeRestart.leafIds, ...sealedSummaryBeforeRestart.evidenceChunkIds],
        effectKey: TREE_EFFECT_KEY, evidenceId: coldObserved.persistedId,
        activeMemoryId: beforeRestart.activeMemoryId,
        expectedTreeTypes: beforeRestart.expectedTreeTypes,
        sourceJobId: beforeRestart.sourceTreeJobId, globalJobId: beforeRestart.globalTreeJobId,
        sourceTreeKey: beforeRestart.sourceTreeKey,
        sourceLeafId: beforeRestart.sourceLeafId, globalLeafId: beforeRestart.globalLeafId,
        topicJobIds: beforeRestart.topicTreeJobIds, topicLeafIds: beforeRestart.topicLeafIds,
        topicTreeKeys: beforeRestart.topicTreeKeys,
        bufferBindings: beforeRestart.treeBufferBindings,
        coldTopicJobIds: coldTopicState.jobIds,
        coldTopicBufferIds: coldTopicState.bufferIds,
        hotness: {
          topicEntityId: hotTopic.topicEntityId,
          threshold: TOPIC_CREATION_THRESHOLD,
          beforeRecall: coldHotness,
          afterRecall: hotTopic,
        },
        sealedSummary: sealedIdentityBefore,
      },
      context_recall: {
        executed: true,
        receiptIds: [beforeRestart.activeMemoryId, ...Object.values(slotActiveMemoryIds)],
        evidenceId: coldObserved.persistedId, activeMemoryId: beforeRestart.activeMemoryId,
        contextSourceIds, lookupHitIds, recallHitIds,
        contextScoreBreakdown: contextScoreBreakdown!,
        lookupScoreBreakdown: lookupScoreBreakdown!,
        recallScoreBreakdown: recallScoreBreakdown!,
        slotActiveMemoryIds,
        slotSourceIds,
        slotScoreBreakdowns: slotScoreBreakdowns as Record<
          MemorySemanticType,
          CompleteRecallScoreBreakdown
        >,
      },
    };
    const result: CaseResult = {
      caseId: goldenCase.id, suite: goldenCase.suite,
      passed: failures.length === 0, failures,
      hitRequired: failures.length === 0
        ? [coldObserved.persistedId, beforeRestart.activeMemoryId, beforeRestart.graphJobId,
            beforeRestart.sourceTreeJobId,
            ...(beforeRestart.globalTreeJobId === null ? [] : [beforeRestart.globalTreeJobId]),
            ...beforeRestart.topicTreeJobIds]
        : [],
      missedRequired: failures.length === 0 ? [] : [...REQUIRED_PRODUCTION_STAGES],
      injectedForbidden: [], filledSlots,
      latencyMs: Date.now() - startedAt, tokenEstimate: 0,
    };
    const passed = result.passed ? 1 : 0;
    return {
      results: [result],
      summary: {
        suite: goldenCase.suite, total: 1, passed, failed: 1 - passed, passRate: passed,
        slotRecallPassRate: passed, wrongInjectionRate: 0,
        latencyP50Ms: result.latencyMs, latencyP95Ms: result.latencyMs,
        failedCases: result.passed ? [] : [result],
        metrics: [createMetric({
          name: "case_pass_rate", numerator: passed, denominator: 1,
          direction: "min", threshold: 1,
        })],
        execution: {
          runMode: "runtime-e2e", provider: "postgresql-pgvector+operator-configured-openai-compatible",
          model: `${options.embeddingModel}+${options.extractionModel}`,
          prompt: "candidate+entity-graph-structured-v1",
          version: "production-rest-runtime-host-v3", fallback: false, degraded: false,
          productionStageEvidence: stageEvidence,
          productionRestartReplayEvidence: {
            restarted: true,
            replayedCandidateJobId: preReplay.candidateJobId,
            effectReceiptIdsBeforeRestart: preReplay.effectReceiptIds,
            effectReceiptIdsAfterRestart: afterRestart.effectReceiptIds,
            ledgerIdsBeforeRestart: preReplay.ledgerIds,
            ledgerIdsAfterRestart: afterRestart.ledgerIds,
            effectReceiptCountBeforeRestart: preReplay.effectReceiptIds.length,
            effectReceiptCountAfterRestart: afterRestart.effectReceiptIds.length,
            ledgerCountBeforeRestart: preReplay.ledgerIds.length,
            ledgerCountAfterRestart: afterRestart.ledgerIds.length,
            contextSourceIdsBeforeRestart: contextSourceIds,
            contextSourceIdsAfterRestart,
            lookupHitIdsBeforeRestart: lookupHitIds,
            lookupHitIdsAfterRestart,
            recallHitIdsBeforeRestart: recallHitIds,
            recallHitIdsAfterRestart,
            slotSourceIdsBeforeRestart: slotSourceIds,
            slotSourceIdsAfterRestart,
            contextScoreBreakdownBeforeRestart: contextScoreBreakdown!,
            contextScoreBreakdownAfterRestart: contextScoreBreakdownAfterRestart!,
            lookupScoreBreakdownBeforeRestart: lookupScoreBreakdown!,
            lookupScoreBreakdownAfterRestart: lookupScoreBreakdownAfterRestart!,
            recallScoreBreakdownBeforeRestart: recallScoreBreakdown!,
            recallScoreBreakdownAfterRestart: recallScoreBreakdownAfterRestart!,
            pending: {
              replayedCandidateJobId: pendingBeforeRestart.jobId,
              candidateBeforeRestart: pendingBeforeRestart.candidate,
              candidateAfterRestart: pendingAfterRestart.candidate,
              effectTraceBeforeRestart: pendingBeforeRestart.effectTrace,
              effectTraceAfterRestart: pendingAfterRestart.effectTrace,
              proposalReceiptsBeforeRestart: pendingBeforeRestart.proposalReceipts,
              proposalReceiptsAfterRestart: pendingAfterRestart.proposalReceipts,
              derivationCountsBeforeRestart: pendingBeforeRestart.derivationCounts,
              derivationCountsAfterRestart: pendingAfterRestart.derivationCounts,
              visibilityBeforeRestart: pendingBeforeRestart.visibility,
              visibilityAfterRestart: pendingAfterRestart.visibility,
            },
            sealedSummaryBeforeRestart: sealedIdentityBefore,
            sealedSummaryAfterRestart: sealedIdentityAfter,
            sealedSummaryAttemptsBeforeRestart: sealedSummaryBeforeRestart.jobAttempts,
            sealedSummaryAttemptsAfterRestart: sealedSummaryAfterRestart.jobAttempts,
          },
        },
      },
    };
  } finally {
    if (child) await stopChild(child);
  }
}
