import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { parseGovernedCanonicalManifest } from
  "../packages/core/src/documents/curation-artifacts.js";
import { parsePrivateEvidenceBindingsManifest } from
  "../packages/core/src/documents/private-evidence-bindings.js";
import type { GovernedDocumentAssetVersion } from "../packages/core/src/documents/types.js";
import { computeContentHash } from "../packages/core/src/scoring/hash-utils.js";

const INPUT_SCHEMA = "mengshu.p13-projection-input/v1";
const PROJECTION_SCHEMA = "mengshu.postgres-canonical-projection/v1";
const RECEIPT_SCHEMA = "mengshu.p13-postgres-dry-run-receipt/v1";
const SHA256 = /^[0-9a-f]{64}$/;

interface ArtifactRef {
  readonly path: string;
  readonly sha256: string;
}

interface ProjectionInput {
  readonly schema: typeof INPUT_SCHEMA;
  readonly governanceRunId: string;
  readonly createdAt: string;
  readonly outputRoot: string;
  readonly finalAcceptance: ArtifactRef;
  readonly canonicalManifest: ArtifactRef;
  readonly assetRecords: ArtifactRef;
  readonly privateEvidence: ArtifactRef;
  readonly routeReceipts: ArtifactRef;
}

export interface RouteReceipt {
  readonly assetId: string;
  readonly valueScore: number;
  readonly importance: number;
  readonly sourceTreeEligible: boolean;
  readonly topicTreeKeys: readonly string[];
  readonly globalTreeEligible: boolean;
  readonly materializedTreeTypes: readonly string[];
}

class P13ProjectionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "P13ProjectionError";
  }
}

function fail(code: string): never {
  throw new P13ProjectionError(code);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function canonicalLine(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function domainHash(domain: string, value: unknown): string {
  return sha256(`${domain}\0${JSON.stringify(stableValue(value))}`);
}

function deterministicUuid(domain: string, value: string): string {
  const digest = sha256(`${domain}\0${value}`).slice(0, 32).split("");
  digest[12] = "5";
  digest[16] = ["8", "9", "a", "b"][Number.parseInt(digest[16]!, 16) & 3]!;
  const hex = digest.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function strictDescendant(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function containedPath(root: string, path: string): string {
  if (!path || isAbsolute(path)) fail("P13_PROJECTION_PATH_INVALID");
  const target = resolve(root, path);
  if (!strictDescendant(root, target)) fail("P13_PROJECTION_PATH_INVALID");
  return target;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("P13_PROJECTION_INPUT_INVALID");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, expected: readonly string[]): Record<string, unknown> {
  const item = record(value);
  const actual = Object.keys(item).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    fail("P13_PROJECTION_INPUT_INVALID");
  }
  return item;
}

function artifact(value: unknown): ArtifactRef {
  const item = exactKeys(value, ["path", "sha256"]);
  if (typeof item.path !== "string" || typeof item.sha256 !== "string" ||
      !SHA256.test(item.sha256)) fail("P13_PROJECTION_INPUT_INVALID");
  return { path: item.path, sha256: item.sha256 };
}

function parseInput(value: unknown): ProjectionInput {
  const item = exactKeys(value, [
    "schema", "governanceRunId", "createdAt", "outputRoot", "finalAcceptance",
    "canonicalManifest", "assetRecords", "privateEvidence", "routeReceipts",
  ]);
  if (item.schema !== INPUT_SCHEMA || typeof item.governanceRunId !== "string" ||
      typeof item.createdAt !== "string" || new Date(item.createdAt).toISOString() !== item.createdAt ||
      typeof item.outputRoot !== "string") fail("P13_PROJECTION_INPUT_INVALID");
  return {
    schema: INPUT_SCHEMA,
    governanceRunId: item.governanceRunId,
    createdAt: item.createdAt,
    outputRoot: item.outputRoot,
    finalAcceptance: artifact(item.finalAcceptance),
    canonicalManifest: artifact(item.canonicalManifest),
    assetRecords: artifact(item.assetRecords),
    privateEvidence: artifact(item.privateEvidence),
    routeReceipts: artifact(item.routeReceipts),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("P13_PROJECTION_INPUT_INVALID");
  }
}

function parseJsonLines(text: string): unknown[] {
  if (!text.endsWith("\n") || text.trim().length === 0) {
    fail("P13_PROJECTION_INPUT_INVALID");
  }
  return text.trimEnd().split("\n").map(parseJson);
}

async function readVerified(root: string, ref: ArtifactRef): Promise<string> {
  const path = containedPath(root, ref.path);
  let current = root;
  for (const part of relative(root, path).split(sep)) {
    current = resolve(current, part);
    const info = await lstat(current).catch(() => fail("P13_PROJECTION_FILESYSTEM_ERROR"));
    if (info.isSymbolicLink()) fail("P13_PROJECTION_SYMLINK");
  }
  const text = await readFile(path, "utf8").catch(() => fail("P13_PROJECTION_FILESYSTEM_ERROR"));
  if (sha256(text) !== ref.sha256) fail("P13_PROJECTION_INPUT_DRIFT");
  return text;
}

function publicText(asset: GovernedDocumentAssetVersion): string {
  return [
    asset.content.title,
    ...asset.content.sections.flatMap((section) =>
      section.claims.map((claim) => claim.text)),
  ].join("\n\n");
}

const NATIVE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const NATIVE_MEMORY_TYPE = Object.freeze({
  profile: Object.freeze({ kind: "preference", category: "preference" }),
  task_context: Object.freeze({ kind: "task", category: "task" }),
  rules: Object.freeze({ kind: "decision", category: "decision" }),
  experience: Object.freeze({ kind: "observation", category: "fact" }),
  resource: Object.freeze({ kind: "document", category: "fact" }),
} as const);

export function buildCanonicalNativeMemoryRow(
  asset: GovernedDocumentAssetVersion,
  route: RouteReceipt,
  evidenceMemoryIds: readonly string[],
  createdAt: string,
): Record<string, unknown> {
  const text = publicText(asset);
  const memoryId = deterministicUuid("mengshu.canonical-memory-row/v1", asset.assetId);
  const semanticType = asset.semanticType;
  if (semanticType === undefined || !(semanticType in NATIVE_MEMORY_TYPE)) {
    fail("P13_PROJECTION_ASSET_COVERAGE_INVALID");
  }
  const native = NATIVE_MEMORY_TYPE[semanticType];
  if (evidenceMemoryIds.length === 0 || evidenceMemoryIds.length > 10_000 ||
      evidenceMemoryIds.some((id) => !NATIVE_ID.test(id)) ||
      new Set(evidenceMemoryIds).size !== evidenceMemoryIds.length) {
    fail("P13_PROJECTION_EVIDENCE_SOURCE_INVALID");
  }
  const provenance = {
    source: "markdown-curation-p13",
    sourceId: asset.assetId,
    ...(asset.scope.sessionId === undefined ? {} : { sessionId: asset.scope.sessionId }),
  };
  const row = {
    id: memoryId,
    text,
    content_hash: computeContentHash(text),
    vector: null,
    importance: route.importance,
    category: native.category,
    data_type: "memory",
    metadata: {
      canonicalAssetId: asset.assetId,
      assetVersion: asset.assetVersion,
      publicContentHash: asset.publicContentHash,
      governanceProjectionHash: asset.governanceProjectionHash,
      valueScore: route.valueScore,
      importance: route.importance,
      treeRoutes: route.materializedTreeTypes,
      topicKeys: route.topicTreeKeys,
      embeddingRequired: true,
      projectionPolicy: "postgres-canonical-projection/v1",
      admissionRoute: "active",
      contextEligible: true,
      confidence: 1,
      semanticType,
      memoryContainer: "project",
      sourceNodeIds: evidenceMemoryIds,
      riskFlags: [],
      governance: {
        commandType: "saveExplicit",
        evidenceIds: evidenceMemoryIds,
        candidate: {
          confidence: 1,
          evidence: { eventIds: evidenceMemoryIds },
          riskFlags: [],
          targetScope: "project",
        },
        provenance,
        native: {
          kind: native.kind,
          semanticType,
          container: "project",
          category: native.category,
          dataType: "memory",
        },
      },
    },
    created_at: createdAt,
    project_name: asset.scope.projectId,
    app_name: asset.scope.appId,
    user_id: asset.scope.userId,
    agent_id: asset.scope.agentId,
    workspace_id: asset.scope.workspaceId ?? null,
    tenant_id: asset.scope.tenantId,
    canonical_project_id: asset.scope.projectId,
    product_id: asset.scope.appId,
    producer_id: asset.scope.agentId,
    namespace: asset.scope.namespace,
    visibility: asset.scope.visibility ?? "private",
    lifecycle_status: "active",
    embedding_space_id: null,
    embedding_space_state: "pending_reembed",
    legacy_quarantine_reason: null,
    scope_key: asset.scopeFingerprint,
  };
  return {
    schema: "mengshu.canonical-memory-row/v1",
    assetId: asset.assetId,
    memoryId,
    row,
    rowSha256: domainHash("mengshu.canonical-memory-row/payload/v1", row),
  };
}

export function projectClaimEvidenceBinding(
  binding: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (typeof binding.sourceRef !== "string" || !binding.sourceRef.startsWith("memories:")) {
    fail("P13_PROJECTION_EVIDENCE_SOURCE_INVALID");
  }
  const sourceMemoryId = binding.sourceRef.slice("memories:".length);
  if (!NATIVE_ID.test(sourceMemoryId)) fail("P13_PROJECTION_EVIDENCE_SOURCE_INVALID");
  const payload = { ...binding, sourceMemoryId };
  return {
    schema: "mengshu.claim-evidence-projection-row/v1",
    ...payload,
    rowSha256: domainHash("mengshu.claim-evidence-projection-row/v1", payload),
  };
}

function sourceAction(disposition: string, sourceRef: string): string {
  const table = sourceRef.startsWith("knowledge:") ? "knowledge" : "memories";
  if (disposition === "attached_to_typed_document") return "archive_after_activation";
  if (disposition === "deferred") return "archive_deferred";
  if (disposition === "archive_stale") return "archive_stale";
  if (disposition === "quarantine") return "quarantine";
  if (disposition === "lookup_only") return table === "knowledge"
    ? "preserve_lookup_only" : "preserve_memory_lookup_only";
  return "preserve";
}

async function writeExclusive(path: string, content: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
      constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } catch {
    fail("P13_PROJECTION_OUTPUT_WRITE_FAILED");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function project(root: string, input: ProjectionInput): Promise<Record<string, unknown>> {
  const texts = await Promise.all([
    readVerified(root, input.finalAcceptance),
    readVerified(root, input.canonicalManifest),
    readVerified(root, input.assetRecords),
    readVerified(root, input.privateEvidence),
    readVerified(root, input.routeReceipts),
  ]);
  const acceptance = record(parseJson(texts[0]!));
  if (acceptance.schema !== "mengshu.final-md-accepted/v1" ||
      record(acceptance.guards).finalMdAccepted !== true ||
      record(acceptance.guards).postgresTouched !== false) {
    fail("P13_PROJECTION_FINAL_MD_NOT_ACCEPTED");
  }
  const manifest = parseGovernedCanonicalManifest(texts[1]!);
  const assets = parseJsonLines(texts[2]!) as GovernedDocumentAssetVersion[];
  const privateEvidence = parsePrivateEvidenceBindingsManifest(texts[3]!);
  const routes = parseJsonLines(texts[4]!) as RouteReceipt[];
  const assetById = new Map(assets.map((asset) => [asset.assetId, asset] as const));
  const routeById = new Map(routes.map((route) => [route.assetId, route] as const));
  if (manifest.assetCount !== assets.length || manifest.assetCount !== routes.length ||
      privateEvidence.summary.assetCount !== manifest.assetCount) {
    fail("P13_PROJECTION_ASSET_COVERAGE_INVALID");
  }
  const evidenceIdsByAsset = new Map<string, Set<string>>();
  for (const binding of privateEvidence.bindings) {
    const projected = projectClaimEvidenceBinding(binding as unknown as Record<string, unknown>);
    const assetId = String(projected.assetId);
    const ids = evidenceIdsByAsset.get(assetId) ?? new Set<string>();
    ids.add(String(projected.sourceMemoryId));
    evidenceIdsByAsset.set(assetId, ids);
  }
  const memoryRows = manifest.assets.map((entry) => {
    const asset = assetById.get(entry.assetId);
    const route = routeById.get(entry.assetId);
    const evidenceIds = evidenceIdsByAsset.get(entry.assetId);
    if (!asset || !route || !evidenceIds) fail("P13_PROJECTION_ASSET_COVERAGE_INVALID");
    return buildCanonicalNativeMemoryRow(
      asset,
      route,
      [...evidenceIds].sort(),
      input.createdAt,
    );
  }).sort((left, right) => String(left.assetId).localeCompare(String(right.assetId)));
  const memoryIdByAsset = new Map(memoryRows.map((row) =>
    [String(row.assetId), String(row.memoryId)] as const));
  const sourceMappings = manifest.sourceMappings.map((mapping) => ({
    schema: "mengshu.canonical-source-mapping-row/v1",
    sourceRef: mapping.source.sourceRef,
    sourceHash: mapping.source.sourceHash,
    sourceTable: mapping.source.sourceRef.startsWith("knowledge:") ? "knowledge" : "memories",
    sourceRecordId: mapping.source.sourceRef.slice(mapping.source.sourceRef.indexOf(":") + 1),
    scopeFingerprint: mapping.scopeFingerprint,
    disposition: mapping.disposition,
    operation: sourceAction(mapping.disposition, mapping.source.sourceRef),
    targetAssetIds: mapping.targets.map((target) => target.assetId),
    targetMemoryIds: mapping.targets.map((target) => {
      const id = memoryIdByAsset.get(target.assetId);
      if (!id) fail("P13_PROJECTION_TARGET_INVALID");
      return id;
    }),
    evidenceRefs: mapping.evidenceRefs,
    reasonCode: mapping.reasonCode,
    mappingSha256: domainHash("mengshu.canonical-source-mapping-row/v1", mapping),
  })).sort((left, right) => left.sourceRef.localeCompare(right.sourceRef));
  const documentRows = assets.map((asset) => ({
    schema: "mengshu.governed-document-projection-row/v1",
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    kind: asset.kind,
    purpose: asset.purpose,
    semanticType: asset.semanticType,
    scopeFingerprint: asset.scopeFingerprint,
    publicContentHash: asset.publicContentHash,
    governanceProjectionHash: asset.governanceProjectionHash,
    memoryId: memoryIdByAsset.get(asset.assetId),
    claimIds: asset.content.sections.flatMap((section) =>
      section.claims.map((claim) => claim.id)).sort(),
    relations: asset.relations,
    state: "complete",
    rowSha256: domainHash("mengshu.governed-document-projection-row/v1", {
      assetId: asset.assetId,
      publicContentHash: asset.publicContentHash,
      governanceProjectionHash: asset.governanceProjectionHash,
    }),
  })).sort((left, right) => left.assetId.localeCompare(right.assetId));
  const evidenceRows = privateEvidence.bindings.map((binding) =>
    projectClaimEvidenceBinding(binding as unknown as Record<string, unknown>));
  const embeddingJobs = memoryRows.map((memory) => ({
    schema: "mengshu.canonical-embedding-job/v1",
    jobId: `embedding_${sha256(String(memory.assetId)).slice(0, 32)}`,
    assetId: memory.assetId,
    memoryId: memory.memoryId,
    contentHash: record(memory.row).content_hash,
    requiredState: "reembedded",
    vectorReuseAllowed: false,
    networkExecuted: false,
  }));
  const operationCounts = Object.fromEntries([...new Set(sourceMappings.map((mapping) =>
    mapping.operation))].sort().map((operation) => [
    operation,
    sourceMappings.filter((mapping) => mapping.operation === operation).length,
  ]));
  const files = {
    canonicalMemoryRows: `${memoryRows.map(canonicalLine).join("\n")}\n`,
    governedDocumentRows: `${documentRows.map(canonicalLine).join("\n")}\n`,
    claimEvidenceRows: `${evidenceRows.map(canonicalLine).join("\n")}\n`,
    sourceMappingRows: `${sourceMappings.map(canonicalLine).join("\n")}\n`,
    embeddingJobs: `${embeddingJobs.map(canonicalLine).join("\n")}\n`,
  };
  const fileDescriptors = Object.fromEntries(Object.entries(files).map(([name, content]) => [name, {
    file: `${name.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)}.jsonl`,
    sha256: sha256(content),
    rows: content.trimEnd().split("\n").length,
  }]));
  const projection = {
    schema: PROJECTION_SCHEMA,
    governanceRunId: input.governanceRunId,
    createdAt: input.createdAt,
    targetSchemaVersion: 27,
    inputs: {
      finalAcceptanceSha256: input.finalAcceptance.sha256,
      canonicalManifestSha256: input.canonicalManifest.sha256,
      assetRecordsSha256: input.assetRecords.sha256,
      privateEvidenceSha256: input.privateEvidence.sha256,
      routeReceiptsSha256: input.routeReceipts.sha256,
    },
    files: fileDescriptors,
    counts: {
      canonicalMemoryInsert: memoryRows.length,
      governedDocumentInsert: documentRows.length,
      claimEvidenceInsert: evidenceRows.length,
      sourceMappingInsert: sourceMappings.length,
      embeddingJobCount: embeddingJobs.length,
      treeRowInsert: 0,
      ...operationCounts,
    },
    preconditions: {
      sourceSnapshotSha256: manifest.sourceSnapshotSha256,
      canonicalArtifactSetHash: manifest.artifactSetHash,
      finalMdAcceptanceSha256: input.finalAcceptance.sha256,
      requiredProductionSchemaVersion: 27,
      maintenanceRequired: true,
      quiescenceRequired: true,
      beforeImageRequired: true,
      rollbackReceiptRequired: true,
      embeddingCompletionRequiredBeforeActivation: true,
    },
    guards: {
      dryRunOnly: true,
      executableSqlIncluded: false,
      applyTokenIncluded: false,
      productionConnectionOpened: false,
      productionDdlCount: 0,
      productionDmlCount: 0,
      postgresTouched: false,
    },
  };
  const projectionHash = domainHash("mengshu.postgres-canonical-projection/v1", projection);
  const projectionText = canonicalJson({ ...projection, projectionHash });
  const diffText = canonicalJson({
    schema: "mengshu.postgres-canonical-operation-diff/v1",
    governanceRunId: input.governanceRunId,
    projectionHash,
    baseline: { memories: 1_502, knowledge: 47_963 },
    target: {
      activeCanonicalMemories: memoryRows.length,
      preservedKnowledge: sourceMappings.filter((mapping) =>
        mapping.sourceTable === "knowledge" && mapping.operation === "preserve_lookup_only").length,
      quarantinedKnowledge: sourceMappings.filter((mapping) =>
        mapping.sourceTable === "knowledge" && mapping.operation === "quarantine").length,
      governedDocuments: documentRows.length,
      claims: privateEvidence.summary.claimCount,
      claimEvidenceBindings: evidenceRows.length,
      trees: 0,
    },
    operations: operationCounts,
  });
  const receipt = {
    schema: RECEIPT_SCHEMA,
    governanceRunId: input.governanceRunId,
    createdAt: input.createdAt,
    projectionHash,
    projectionManifestSha256: sha256(projectionText),
    operationDiffSha256: sha256(diffText),
    counts: projection.counts,
    guards: projection.guards,
  };
  const receiptText = canonicalJson(receipt);
  const outputRoot = containedPath(root, input.outputRoot);
  try {
    await lstat(outputRoot);
    fail("P13_PROJECTION_OUTPUT_EXISTS");
  } catch (error) {
    if (error instanceof P13ProjectionError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("P13_PROJECTION_FILESYSTEM_ERROR");
  }
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    ...Object.entries(files).map(([name, content]) => {
      const descriptor = record(fileDescriptors[name]);
      return writeExclusive(resolve(outputRoot, String(descriptor.file)), content);
    }),
    writeExclusive(resolve(outputRoot, "projection-manifest.json"), projectionText),
    writeExclusive(resolve(outputRoot, "operation-diff.json"), diffText),
    writeExclusive(resolve(outputRoot, "receipt.json"), receiptText),
  ]);
  return {
    outputRoot: input.outputRoot,
    receiptSha256: sha256(receiptText),
    projectionHash,
    projectionManifestSha256: sha256(projectionText),
    counts: projection.counts,
    guards: projection.guards,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 6 || argv[0] !== "--migration-root" || argv[2] !== "--input" ||
      argv[4] !== "--input-sha256") fail("P13_PROJECTION_INVALID_ARGUMENT");
  const root = resolve(argv[1]!);
  if (!isAbsolute(argv[1]!) || root !== argv[1]) fail("P13_PROJECTION_INVALID_ARGUMENT");
  const inputText = await readVerified(root, { path: argv[3]!, sha256: argv[5]! });
  const input = parseInput(parseJson(inputText));
  process.stdout.write(`${JSON.stringify(await project(root, input))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    const code = error instanceof P13ProjectionError
      ? error.code
      : error instanceof Error
        ? `P13_PROJECTION_CONTRACT_ERROR:${error.name}:${error.message}`
        : "P13_PROJECTION_UNEXPECTED_ERROR";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
