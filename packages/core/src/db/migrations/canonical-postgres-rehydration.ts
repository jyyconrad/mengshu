import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_HASH = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SEMANTIC_TYPES = new Set(["profile", "task_context", "rules", "experience", "resource"]);

export type CanonicalRehydrationErrorCode =
  | "CANONICAL_REHYDRATION_INVALID_INPUT"
  | "CANONICAL_REHYDRATION_HASH_DRIFT"
  | "CANONICAL_REHYDRATION_COUNT_MISMATCH"
  | "CANONICAL_REHYDRATION_IDENTITY_CONFLICT"
  | "CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED"
  | "CANONICAL_REHYDRATION_REHEARSAL_FAILED";

export class CanonicalRehydrationError extends Error {
  constructor(readonly code: CanonicalRehydrationErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "CanonicalRehydrationError";
  }
}

export interface CanonicalMemoryProjectionRow {
  readonly schema: "mengshu.canonical-memory-row/v1";
  readonly assetId: string;
  readonly memoryId: string;
  readonly row: Readonly<Record<string, unknown>>;
  readonly rowSha256: string;
}

export interface GovernedDocumentProjectionRow {
  readonly schema: "mengshu.governed-document-projection-row/v1";
  readonly assetId: string;
  readonly assetVersion: number;
  readonly semanticType: string;
  readonly scopeFingerprint: string;
  readonly memoryId: string;
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
  readonly claimIds: readonly string[];
  readonly relations: readonly Readonly<Record<string, unknown>>[];
  readonly rowSha256: string;
  readonly [key: string]: unknown;
}

export interface ClaimEvidenceProjectionRow {
  readonly schema: "mengshu.claim-evidence-projection-row/v1";
  readonly evidenceId: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly claimId: string;
  readonly scopeFingerprint: string;
  readonly sourceRef: string;
  readonly sourceMemoryId: string;
  readonly sourceHash: string;
  readonly rowSha256: string;
  readonly [key: string]: unknown;
}

export interface CanonicalSourceMappingRow {
  readonly schema: "mengshu.canonical-source-mapping-row/v1";
  readonly sourceRef: string;
  readonly sourceHash: string;
  readonly sourceTable: "memories" | "knowledge";
  readonly sourceRecordId: string;
  readonly scopeFingerprint: string;
  readonly disposition: string;
  readonly operation: string;
  readonly targetAssetIds: readonly string[];
  readonly targetMemoryIds: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly reasonCode: string;
  readonly mappingSha256: string;
}

export interface CanonicalEmbeddingJob {
  readonly schema: "mengshu.canonical-embedding-job/v1";
  readonly jobId: string;
  readonly assetId: string;
  readonly memoryId: string;
  readonly contentHash: string;
  readonly requiredState: "reembedded";
  readonly vectorReuseAllowed: false;
  readonly networkExecuted: false;
}

export interface CanonicalProjectionManifest {
  readonly schema: "mengshu.postgres-canonical-projection/v1";
  readonly governanceRunId: string;
  readonly projectionHash: string;
  readonly targetSchemaVersion: number;
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly files: Readonly<Record<string, Readonly<{
    file: string;
    sha256: string;
    rows: number;
  }>>>;
  readonly counts: Readonly<Record<string, number>>;
  readonly preconditions: Readonly<Record<string, unknown>>;
  readonly guards: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface CanonicalProjectionBundle {
  readonly manifest: CanonicalProjectionManifest;
  readonly memories: readonly CanonicalMemoryProjectionRow[];
  readonly documents: readonly GovernedDocumentProjectionRow[];
  readonly evidence: readonly ClaimEvidenceProjectionRow[];
  readonly mappings: readonly CanonicalSourceMappingRow[];
  readonly embeddingJobs: readonly CanonicalEmbeddingJob[];
}

function fail(code: CanonicalRehydrationErrorCode, detail?: string): never {
  throw new CanonicalRehydrationError(code, detail);
}

export interface CanonicalProductionApplyAuthorization {
  readonly mode: string;
  readonly runId: string;
  readonly projectionHash: string;
  readonly expectedProjectionHash: string;
  readonly preflightHash: string;
  readonly applyToken: string;
  readonly receiptApplyToken: string;
  readonly maintenance: boolean;
  readonly quiescenceConfirmed: boolean;
  readonly physicalPurgeAuthorized: boolean;
}

export function assertCanonicalProductionApplyAuthorization(
  input: CanonicalProductionApplyAuthorization,
): void {
  const expectedToken = `P15_APPLY:${input.runId}:${input.preflightHash}`;
  if (input.mode !== "apply" || input.runId.length === 0 ||
      !SHA256.test(input.projectionHash) || input.projectionHash !== input.expectedProjectionHash ||
      !SHA256.test(input.preflightHash) || input.applyToken !== expectedToken ||
      input.receiptApplyToken !== expectedToken || input.maintenance !== true ||
      input.quiescenceConfirmed !== true || input.physicalPurgeAuthorized !== false) {
    fail("CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED");
  }
}

export type CanonicalMigrationDisposition =
  | "canonical_keep"
  | "merge_exact"
  | "merge_semantic"
  | "supersede"
  | "archive_stale"
  | "lookup_only"
  | "quarantine"
  | "distinct_keep";

export type CanonicalGovernanceDisposition =
  | "attached_to_typed_document"
  | "deferred"
  | "lookup_only"
  | "archive_stale"
  | "quarantine";

const SOURCE_DISPOSITION_COMPATIBILITY = new Map<string, Readonly<{
  governanceDisposition: CanonicalGovernanceDisposition;
  migrationDisposition: CanonicalMigrationDisposition;
}>>([
  ["attached_to_typed_document\0archive_after_activation", Object.freeze({
    governanceDisposition: "attached_to_typed_document",
    migrationDisposition: "merge_semantic",
  })],
  ["deferred\0archive_deferred", Object.freeze({
    governanceDisposition: "deferred",
    migrationDisposition: "lookup_only",
  })],
  ["lookup_only\0preserve_lookup_only", Object.freeze({
    governanceDisposition: "lookup_only",
    migrationDisposition: "lookup_only",
  })],
  ["lookup_only\0preserve_memory_lookup_only", Object.freeze({
    governanceDisposition: "lookup_only",
    migrationDisposition: "lookup_only",
  })],
  ["archive_stale\0archive_stale", Object.freeze({
    governanceDisposition: "archive_stale",
    migrationDisposition: "archive_stale",
  })],
  ["quarantine\0quarantine", Object.freeze({
    governanceDisposition: "quarantine",
    migrationDisposition: "quarantine",
  })],
]);

export function canonicalSourceMigrationDisposition(input: Readonly<{
  readonly disposition: string;
  readonly operation: string;
}>): Readonly<{
  governanceDisposition: CanonicalGovernanceDisposition;
  migrationDisposition: CanonicalMigrationDisposition;
}> {
  const result = SOURCE_DISPOSITION_COMPATIBILITY.get(
    `${input.disposition}\0${input.operation}`,
  );
  if (!result) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "unsupported source disposition");
  return result;
}

export type CanonicalSourceLifecycleAction = "archive" | "preserve" | "quarantine";

const SOURCE_LIFECYCLE_ACTIONS = new Map<string, CanonicalSourceLifecycleAction>([
  ["memories\0archive_after_activation", "archive"],
  ["memories\0archive_deferred", "archive"],
  ["memories\0archive_stale", "archive"],
  ["memories\0preserve_memory_lookup_only", "archive"],
  ["memories\0quarantine", "quarantine"],
  ["knowledge\0preserve_lookup_only", "preserve"],
  ["knowledge\0quarantine", "quarantine"],
]);

export function canonicalSourceLifecycleAction(input: Readonly<{
  readonly sourceTable: "memories" | "knowledge";
  readonly operation: string;
}>): CanonicalSourceLifecycleAction {
  const action = SOURCE_LIFECYCLE_ACTIONS.get(`${input.sourceTable}\0${input.operation}`);
  if (!action) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "unsupported source lifecycle action");
  return action;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || nodeUtilTypes.isProxy(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    }
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || typeof item === "function" || typeof item === "symbol" ||
        typeof item === "bigint") fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalRehydrationJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

export function canonicalRehydrationSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalRehydrationDomainHash(domain: string, value: unknown): string {
  return canonicalRehydrationSha256(`${domain}\0${JSON.stringify(stableValue(value))}`);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid JSON");
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  if (!text.endsWith("\n") || text.trim().length === 0) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "JSONL must be non-empty and newline terminated");
  }
  return text.trimEnd().split("\n").map((line) => {
    const value = parseJson(line);
    if (!plainRecord(value)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "JSONL row must be an object");
    return value;
  });
}

function safeStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) ||
      value.some((item) => typeof item !== "string")) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT");
  }
  return value as string[];
}

function safeRows<T>(
  rows: readonly Record<string, unknown>[],
  schema: string,
  decode: (row: Record<string, unknown>) => T,
): readonly T[] {
  return Object.freeze(rows.map((row) => {
    if (row.schema !== schema) fail("CANONICAL_REHYDRATION_INVALID_INPUT", `unexpected ${schema} row`);
    return decode(row);
  }));
}

function stringField(row: Record<string, unknown>, key: string, pattern?: RegExp): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0 || (pattern && !pattern.test(value))) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", `invalid ${key}`);
  }
  return value;
}

function integerField(row: Record<string, unknown>, key: string, minimum = 0): number {
  const value = row[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", `invalid ${key}`);
  }
  return value as number;
}

function parseMemoryRows(text: string): readonly CanonicalMemoryProjectionRow[] {
  return safeRows(parseJsonLines(text), "mengshu.canonical-memory-row/v1", (item) => {
    if (!plainRecord(item.row)) fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid memory row");
    const row = item.row;
    const assetId = stringField(item, "assetId");
    const memoryId = stringField(item, "memoryId", UUID);
    const rowSha256 = stringField(item, "rowSha256", SHA256);
    stringField(row, "text");
    stringField(row, "content_hash", CONTENT_HASH);
    stringField(row, "scope_key", SHA256);
    const metadata = row.metadata;
    if (row.data_type !== "memory" || !plainRecord(metadata) ||
        !SEMANTIC_TYPES.has(String(metadata.semanticType)) || row.vector !== null ||
        canonicalRehydrationDomainHash("mengshu.canonical-memory-row/payload/v1", row) !== rowSha256) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", assetId);
    }
    return { schema: "mengshu.canonical-memory-row/v1", assetId, memoryId, row, rowSha256 };
  });
}

function parseDocumentRows(text: string): readonly GovernedDocumentProjectionRow[] {
  return safeRows(parseJsonLines(text), "mengshu.governed-document-projection-row/v1", (item) => {
    const assetId = stringField(item, "assetId");
    const assetVersion = integerField(item, "assetVersion", 1);
    const semanticType = stringField(item, "semanticType");
    if (!SEMANTIC_TYPES.has(semanticType)) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    const scopeFingerprint = stringField(item, "scopeFingerprint", SHA256);
    const memoryId = stringField(item, "memoryId", UUID);
    const publicContentHash = stringField(item, "publicContentHash", SHA256);
    const governanceProjectionHash = stringField(item, "governanceProjectionHash", SHA256);
    const rowSha256 = stringField(item, "rowSha256", SHA256);
    const claimIds = safeStrings(item.claimIds);
    if (!Array.isArray(item.relations) || nodeUtilTypes.isProxy(item.relations) ||
        item.relations.some((relation) => !plainRecord(relation))) {
      fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid relations");
    }
    const expected = canonicalRehydrationDomainHash(
      "mengshu.governed-document-projection-row/v1",
      { assetId, publicContentHash, governanceProjectionHash },
    );
    if (expected !== rowSha256) fail("CANONICAL_REHYDRATION_HASH_DRIFT", assetId);
    return item as unknown as GovernedDocumentProjectionRow;
  });
}

function parseEvidenceRows(text: string): readonly ClaimEvidenceProjectionRow[] {
  return safeRows(parseJsonLines(text), "mengshu.claim-evidence-projection-row/v1", (item) => {
    const rowSha256 = stringField(item, "rowSha256", SHA256);
    const payload = { ...item };
    delete payload.rowSha256;
    delete payload.schema;
    if (canonicalRehydrationDomainHash("mengshu.claim-evidence-projection-row/v1", payload) !==
        rowSha256) fail("CANONICAL_REHYDRATION_HASH_DRIFT", String(item.evidenceId));
    stringField(item, "evidenceId");
    stringField(item, "assetId");
    integerField(item, "assetVersion", 1);
    stringField(item, "claimId");
    stringField(item, "scopeFingerprint", SHA256);
    stringField(item, "sourceRef");
    stringField(item, "sourceMemoryId", UUID);
    stringField(item, "sourceHash", SHA256);
    return item as unknown as ClaimEvidenceProjectionRow;
  });
}

function parseMappingRows(text: string): readonly CanonicalSourceMappingRow[] {
  return safeRows(parseJsonLines(text), "mengshu.canonical-source-mapping-row/v1", (item) => {
    const sourceRef = stringField(item, "sourceRef");
    const sourceTable = stringField(item, "sourceTable");
    if ((sourceTable !== "memories" && sourceTable !== "knowledge") ||
        !sourceRef.startsWith(`${sourceTable}:`)) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    stringField(item, "sourceHash", SHA256);
    stringField(item, "sourceRecordId");
    stringField(item, "scopeFingerprint", SHA256);
    stringField(item, "disposition");
    stringField(item, "operation");
    stringField(item, "reasonCode");
    stringField(item, "mappingSha256", SHA256);
    safeStrings(item.targetAssetIds);
    safeStrings(item.targetMemoryIds);
    safeStrings(item.evidenceRefs);
    return item as unknown as CanonicalSourceMappingRow;
  });
}

function parseEmbeddingJobs(text: string): readonly CanonicalEmbeddingJob[] {
  return safeRows(parseJsonLines(text), "mengshu.canonical-embedding-job/v1", (item) => {
    stringField(item, "jobId");
    stringField(item, "assetId");
    stringField(item, "memoryId", UUID);
    stringField(item, "contentHash", CONTENT_HASH);
    if (item.requiredState !== "reembedded" || item.vectorReuseAllowed !== false ||
        item.networkExecuted !== false) fail("CANONICAL_REHYDRATION_INVALID_INPUT");
    return item as unknown as CanonicalEmbeddingJob;
  });
}

function parseManifest(text: string): CanonicalProjectionManifest {
  const value = parseJson(text);
  if (!plainRecord(value) || value.schema !== "mengshu.postgres-canonical-projection/v1" ||
      typeof value.governanceRunId !== "string" || value.governanceRunId.length === 0 ||
      typeof value.projectionHash !== "string" || !SHA256.test(value.projectionHash) ||
      value.targetSchemaVersion !== 27 || !plainRecord(value.inputs) ||
      !plainRecord(value.files) || !plainRecord(value.counts) ||
      !plainRecord(value.preconditions) || !plainRecord(value.guards)) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "invalid projection manifest");
  }
  const withoutHash = { ...value };
  delete withoutHash.projectionHash;
  if (canonicalRehydrationDomainHash("mengshu.postgres-canonical-projection/v1", withoutHash) !==
      value.projectionHash) fail("CANONICAL_REHYDRATION_HASH_DRIFT", "projectionHash");
  const guards = value.guards;
  if (guards.dryRunOnly !== true || guards.executableSqlIncluded !== false ||
      guards.applyTokenIncluded !== false || guards.productionConnectionOpened !== false ||
      guards.postgresTouched !== false) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", "projection is not a dry-run artifact");
  }
  return value as unknown as CanonicalProjectionManifest;
}

function descriptor(
  manifest: CanonicalProjectionManifest,
  name: string,
): Readonly<{ file: string; sha256: string; rows: number }> {
  const value = manifest.files[name];
  if (!plainRecord(value) || typeof value.file !== "string" || value.file.length === 0 ||
      typeof value.sha256 !== "string" || !SHA256.test(value.sha256) ||
      !Number.isSafeInteger(value.rows) || (value.rows as number) < 0) {
    fail("CANONICAL_REHYDRATION_INVALID_INPUT", `invalid file descriptor ${name}`);
  }
  return value as unknown as Readonly<{ file: string; sha256: string; rows: number }>;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", label);
  }
}

/** Validate every frozen P13 artifact before any PostgreSQL connection is opened. */
export function parseCanonicalProjectionBundle(input: Readonly<{
  projectionManifest: string;
  canonicalMemoryRows: string;
  governedDocumentRows: string;
  claimEvidenceRows: string;
  sourceMappingRows: string;
  embeddingJobs: string;
}>): CanonicalProjectionBundle {
  const manifest = parseManifest(input.projectionManifest);
  const texts: Readonly<Record<string, string>> = {
    canonicalMemoryRows: input.canonicalMemoryRows,
    governedDocumentRows: input.governedDocumentRows,
    claimEvidenceRows: input.claimEvidenceRows,
    sourceMappingRows: input.sourceMappingRows,
    embeddingJobs: input.embeddingJobs,
  };
  for (const [name, text] of Object.entries(texts)) {
    const file = descriptor(manifest, name);
    if (canonicalRehydrationSha256(text) !== file.sha256) {
      fail("CANONICAL_REHYDRATION_HASH_DRIFT", name);
    }
  }
  const memories = parseMemoryRows(input.canonicalMemoryRows);
  const documents = parseDocumentRows(input.governedDocumentRows);
  const evidence = parseEvidenceRows(input.claimEvidenceRows);
  const mappings = parseMappingRows(input.sourceMappingRows);
  const embeddingJobs = parseEmbeddingJobs(input.embeddingJobs);
  const sets = [
    ["canonicalMemoryRows", memories.length],
    ["governedDocumentRows", documents.length],
    ["claimEvidenceRows", evidence.length],
    ["sourceMappingRows", mappings.length],
    ["embeddingJobs", embeddingJobs.length],
  ] as const;
  for (const [name, count] of sets) {
    if (descriptor(manifest, name).rows !== count) {
      fail("CANONICAL_REHYDRATION_COUNT_MISMATCH", name);
    }
  }
  const expectedCounts: Readonly<Record<string, number>> = {
    canonicalMemoryInsert: memories.length,
    governedDocumentInsert: documents.length,
    claimEvidenceInsert: evidence.length,
    sourceMappingInsert: mappings.length,
    embeddingJobCount: embeddingJobs.length,
  };
  for (const [name, count] of Object.entries(expectedCounts)) {
    if (manifest.counts[name] !== count) fail("CANONICAL_REHYDRATION_COUNT_MISMATCH", name);
  }
  assertUnique(memories.map((row) => row.assetId), "memory assetId");
  assertUnique(memories.map((row) => row.memoryId), "memoryId");
  assertUnique(documents.map((row) => row.assetId), "document assetId");
  assertUnique(evidence.map((row) => row.evidenceId), "evidenceId");
  assertUnique(mappings.map((row) => row.sourceRef), "sourceRef");
  assertUnique(embeddingJobs.map((row) => row.jobId), "embedding jobId");
  const memoryByAsset = new Map(memories.map((row) => [row.assetId, row] as const));
  const documentByAsset = new Map(documents.map((row) => [row.assetId, row] as const));
  const jobByAsset = new Map(embeddingJobs.map((row) => [row.assetId, row] as const));
  if (memoryByAsset.size !== documentByAsset.size || memoryByAsset.size !== jobByAsset.size) {
    fail("CANONICAL_REHYDRATION_COUNT_MISMATCH", "asset coverage");
  }
  for (const [assetId, memory] of memoryByAsset) {
    const document = documentByAsset.get(assetId);
    const job = jobByAsset.get(assetId);
    const metadata = memory.row.metadata;
    if (!document || !job || document.memoryId !== memory.memoryId || job.memoryId !== memory.memoryId ||
        job.contentHash !== memory.row.content_hash || !plainRecord(metadata) ||
        document.publicContentHash !== metadata.publicContentHash ||
        document.scopeFingerprint !== memory.row.scope_key ||
        document.semanticType !== (metadata as Record<string, unknown>).semanticType) {
      fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", assetId);
    }
  }
  for (const row of evidence) {
    const document = documentByAsset.get(row.assetId);
    if (!document || document.assetVersion !== row.assetVersion ||
        document.scopeFingerprint !== row.scopeFingerprint || !document.claimIds.includes(row.claimId)) {
      fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", row.evidenceId);
    }
  }
  for (const mapping of mappings) {
    if (mapping.targetAssetIds.length !== mapping.targetMemoryIds.length) {
      fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", mapping.sourceRef);
    }
    for (let index = 0; index < mapping.targetAssetIds.length; index += 1) {
      const memory = memoryByAsset.get(mapping.targetAssetIds[index]!);
      if (!memory || memory.memoryId !== mapping.targetMemoryIds[index]) {
        fail("CANONICAL_REHYDRATION_IDENTITY_CONFLICT", mapping.sourceRef);
      }
    }
  }
  return Object.freeze({ manifest, memories, documents, evidence, mappings, embeddingJobs });
}

export interface CanonicalRehydrationRehearsalChecks {
  readonly schema: boolean;
  readonly embedding: boolean;
  readonly canonicalRead: boolean;
  readonly evidenceDrilldown: boolean;
  readonly fiveSlotRecall: boolean;
  readonly disclosureR0R4: boolean;
  readonly lookup: boolean;
  readonly resource: boolean;
  readonly tree: boolean;
  readonly graph: boolean;
  readonly scopeIsolation: boolean;
  readonly restartConsistency: boolean;
  readonly rollbackRestore: boolean;
}

export function assertCanonicalRehydrationRehearsalChecks(
  checks: CanonicalRehydrationRehearsalChecks,
): void {
  const failed = Object.entries(checks).filter(([, passed]) => passed !== true).map(([name]) => name);
  if (failed.length > 0) fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", failed.join(","));
}

export function assertCanonicalRehydrationMode(mode: string): asserts mode is "rehearse" {
  if (mode === "apply") fail("CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED");
  if (mode !== "rehearse") fail("CANONICAL_REHYDRATION_INVALID_INPUT", "unsupported mode");
}

export function assertEphemeralPostgresIdentity(input: Readonly<{
  inetServerAddress: string | null;
  actualDataDirectory: string;
  expectedDataDirectory: string;
  currentDatabase: string;
}>): void {
  if (input.inetServerAddress !== null || input.currentDatabase !== "postgres" ||
      input.actualDataDirectory !== input.expectedDataDirectory) {
    fail("CANONICAL_REHYDRATION_REHEARSAL_FAILED", "PostgreSQL instance is not ephemeral");
  }
}
