import { createHash } from "node:crypto";

import type { MemoryCategory } from "../../../../../config.js";
import type {
  MemoryContainer,
  MemoryKind,
  MemoryRecord,
  MemoryScope,
  MemorySemanticType,
  RecordProvenance,
} from "../../domain/types.js";

export interface PostgresCandidatePromotionQueryResult<
  Row extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly rows: Row[];
  readonly rowCount?: number | null;
}

export interface PostgresCandidatePromotionClient {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PostgresCandidatePromotionQueryResult<Row>>;
  release(): void;
}

export interface PostgresCandidatePromotionPool {
  connect(): Promise<PostgresCandidatePromotionClient>;
}

export interface PostgresCandidatePromotionInsertResult {
  readonly requestedId: string;
  readonly persistedId: string;
  readonly stored: boolean;
}

export type PostgresCandidatePromotionInsert = (
  client: PostgresCandidatePromotionClient,
  memory: MemoryRecord,
) => Promise<PostgresCandidatePromotionInsertResult>;

export interface CandidatePromotionInput {
  readonly candidateId: string;
  readonly material: CandidatePromotionMemoryMaterial;
}

export interface CandidatePromotionMemoryMaterial {
  readonly id: string;
  readonly importance: number;
  readonly category: MemoryCategory;
  readonly container?: MemoryContainer;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly provenance?: Readonly<RecordProvenance>;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly vector: readonly number[];
}

export interface CandidatePromotionResult {
  readonly status: "applied" | "replayed";
  readonly candidateId: string;
  readonly memoryId: string;
  readonly stored: true;
  readonly cleanupFailed?: true;
}

export type PostgresCandidatePromotionErrorCode =
  | "INVALID_INPUT"
  | "EVOLUTION_REVIEW_REQUIRED"
  | "CANDIDATE_NOT_PENDING"
  | "PROMOTION_CONFLICT"
  | "PROMOTION_FAILED";

export class PostgresCandidatePromotionError extends Error {
  readonly retryable: boolean;

  constructor(readonly code: PostgresCandidatePromotionErrorCode) {
    super("Postgres candidate promotion failed");
    this.name = "PostgresCandidatePromotionError";
    this.retryable = code === "PROMOTION_FAILED";
  }
}

export interface ProviderOwnedCandidatePromotionPort {
  promote(input: CandidatePromotionInput): Promise<CandidatePromotionResult>;
}

const PROVIDER_OWNED_PORTS = new WeakSet<object>();
const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);

interface CanonicalScope {
  readonly tenantId: string;
  readonly userId: string;
  readonly appId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly namespace: string;
  readonly visibility: "private" | "workspace" | "team" | "public";
  readonly workspaceId: string;
  readonly sessionId: string;
}

export interface LockedCandidatePromotionSource {
  readonly id: string;
  readonly text: string;
  readonly semanticType?: MemorySemanticType;
  readonly kind: string;
  readonly confidence: number;
  readonly contentHash: string;
  readonly evidenceIds: readonly string[];
  readonly status: "pending" | "approved" | "rejected" | "archived" | "expired";
  readonly promotedToMemoryId?: string;
}

interface PromotionReceipt {
  readonly candidateId: string;
  readonly memoryId: string;
  readonly stored: true;
}

function fail(code: PostgresCandidatePromotionErrorCode): PostgresCandidatePromotionError {
  return new PostgresCandidatePromotionError(code);
}

function requiredId(value: unknown): string {
  if (typeof value !== "string" || !SAFE_ID.test(value) || value !== value.trim()) {
    throw fail("INVALID_INPUT");
  }
  return value;
}

function canonicalScope(scope: MemoryScope): CanonicalScope {
  const visibility = scope?.visibility ?? "private";
  if (!["private", "workspace", "team", "public"].includes(visibility)) {
    throw fail("INVALID_INPUT");
  }
  return Object.freeze({
    tenantId: requiredId(scope?.tenantId),
    userId: requiredId(scope?.userId),
    appId: requiredId(scope?.appId),
    projectId: requiredId(scope?.projectId),
    agentId: requiredId(scope?.agentId),
    namespace: requiredId(scope?.namespace),
    visibility,
    workspaceId: scope?.workspaceId === undefined ? "" : requiredId(scope.workspaceId),
    sessionId: scope?.sessionId === undefined ? "" : requiredId(scope.sessionId),
  });
}

function publicScope(scope: CanonicalScope): MemoryScope {
  return Object.freeze({
    tenantId: scope.tenantId,
    userId: scope.userId,
    appId: scope.appId,
    projectId: scope.projectId,
    agentId: scope.agentId,
    namespace: scope.namespace,
    visibility: scope.visibility,
    ...(scope.workspaceId === "" ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
  });
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw fail("INVALID_INPUT");
    return JSON.stringify(value);
  }
  if (!value || typeof value !== "object" || seen.has(value)) throw fail("INVALID_INPUT");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function storageKey(scope: CanonicalScope, candidateId: string): string {
  return createHash("sha256").update([
    "candidate.promotion.v1", scope.tenantId, scope.userId, scope.appId,
    scope.projectId, scope.agentId, scope.namespace, scope.visibility,
    scope.workspaceId, scope.sessionId, candidateId,
  ].join("\0")).digest("hex");
}

function requestFingerprint(candidateId: string, memory: MemoryRecord): string {
  return createHash("sha256").update(canonicalJson({
    candidateId,
    memory: {
      id: memory.id,
      scope: canonicalScope(memory.scope),
      kind: memory.kind,
      semanticType: memory.semanticType,
      container: memory.container,
      lifecycleStatus: memory.lifecycleStatus,
      confidence: memory.confidence,
      text: memory.text,
      contentHash: memory.contentHash,
      importance: memory.importance,
      category: memory.category,
      dataType: memory.dataType,
      tableName: memory.tableName ?? "memories",
      metadata: memory.metadata,
      provenance: memory.provenance,
      sourceNodeIds: memory.sourceNodeIds,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    },
  })).digest("hex");
}

function eventId(key: string, memoryId: string): string {
  return createHash("sha256")
    .update(`candidate.promoted.v1\0${key}\0${memoryId}`)
    .digest("hex");
}

function candidateParams(scope: CanonicalScope, candidateId: string): readonly unknown[] {
  return [
    scope.tenantId, scope.userId, scope.appId, scope.projectId, scope.agentId,
    scope.namespace, scope.visibility, scope.workspaceId, scope.sessionId, candidateId,
  ];
}

function decodeCandidate(row: Record<string, unknown> | undefined): LockedCandidatePromotionSource {
  if (!row) throw fail("CANDIDATE_NOT_PENDING");
  const semanticType = row.semantic_type;
  const confidence = row.confidence;
  const status = row.status;
  const promotedToMemoryId = row.promoted_to_memory_id;
  const evidenceIds = row.evidence_ids;
  if (typeof row.id !== "string" || typeof row.text !== "string" || row.text.trim().length === 0 ||
      typeof row.kind !== "string" || row.kind.length === 0 ||
      typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1 ||
      typeof row.content_hash !== "string" || !SHA256.test(row.content_hash) ||
      !Array.isArray(evidenceIds) || evidenceIds.length > 10_000 ||
      evidenceIds.some((id) => typeof id !== "string" || !SAFE_ID.test(id)) ||
      (semanticType !== null && semanticType !== undefined &&
        (typeof semanticType !== "string" || !SEMANTIC_TYPES.has(semanticType as MemorySemanticType))) ||
      !["pending", "approved", "rejected", "archived", "expired"].includes(String(status)) ||
      (promotedToMemoryId !== null && promotedToMemoryId !== undefined &&
        (typeof promotedToMemoryId !== "string" || !SAFE_ID.test(promotedToMemoryId)))) {
    throw fail("PROMOTION_CONFLICT");
  }
  return Object.freeze({
    id: row.id,
    text: row.text,
    ...(typeof semanticType === "string" ? { semanticType: semanticType as MemorySemanticType } : {}),
    kind: row.kind,
    confidence,
    contentHash: row.content_hash,
    evidenceIds: Object.freeze([...evidenceIds]) as readonly string[],
    status: status as LockedCandidatePromotionSource["status"],
    ...(typeof promotedToMemoryId === "string" ? { promotedToMemoryId } : {}),
  });
}

function memoryKind(candidateKind: string): MemoryKind {
  const known: readonly MemoryKind[] = [
    "preference", "decision", "entity", "fact", "task", "plan", "goal",
    "document", "knowledge", "observation", "other",
  ];
  return (known as readonly string[]).includes(candidateKind)
    ? candidateKind as MemoryKind
    : "other";
}

export function createCandidatePromotionMemory(
  candidate: LockedCandidatePromotionSource,
  authorityScope: MemoryScope,
  material: CandidatePromotionMemoryMaterial,
): MemoryRecord {
  const scope = canonicalScope(authorityScope);
  if (!candidate || typeof candidate !== "object" || candidate.status === undefined ||
      !UUID.test(material?.id) || typeof material.importance !== "number" ||
      !Number.isFinite(material.importance) || material.importance < 0 || material.importance > 1 ||
      !Number.isSafeInteger(material.createdAt) || material.createdAt < 0 ||
      (material.updatedAt !== undefined &&
        (!Number.isSafeInteger(material.updatedAt) || material.updatedAt < material.createdAt)) ||
      !Array.isArray(material.vector) || material.vector.length === 0 ||
      material.vector.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
      !material.metadata || typeof material.metadata !== "object" || Array.isArray(material.metadata)) {
    throw fail("INVALID_INPUT");
  }
  return Object.freeze({
    id: material.id,
    scope: Object.freeze({
      tenantId: scope.tenantId,
      userId: scope.userId,
      appId: scope.appId,
      projectId: scope.projectId,
      agentId: scope.agentId,
      namespace: scope.namespace,
      visibility: scope.visibility,
      ...(scope.workspaceId === "" ? {} : { workspaceId: scope.workspaceId }),
      ...(scope.sessionId === "" ? {} : { sessionId: scope.sessionId }),
    }),
    kind: memoryKind(candidate.kind),
    ...(candidate.semanticType === undefined ? {} : { semanticType: candidate.semanticType }),
    container: material.container ?? "project",
    lifecycleStatus: "active",
    confidence: candidate.confidence,
    text: candidate.text,
    contentHash: candidate.contentHash,
    importance: material.importance,
    category: material.category,
    dataType: "memory",
    tableName: "memories",
    metadata: Object.freeze({
      ...material.metadata,
      admissionRoute: "active",
      contextEligible: true,
      importance: material.importance,
      promotedFromCandidate: candidate.id,
      candidateKind: candidate.kind,
    }),
    provenance: Object.freeze({
      ...material.provenance,
      source: material.provenance?.source ?? "candidate-promotion",
      sourceId: candidate.id,
    }),
    sourceNodeIds: Object.freeze([...candidate.evidenceIds]) as unknown as string[],
    createdAt: material.createdAt,
    ...(material.updatedAt === undefined ? {} : { updatedAt: material.updatedAt }),
    vector: Object.freeze([...material.vector]) as unknown as number[],
  });
}

function decodeReceipt(
  row: Record<string, unknown> | undefined,
  expected: { key: string; scope: CanonicalScope; fingerprint: string },
): PromotionReceipt | undefined {
  if (!row) return undefined;
  if (row.storage_key !== expected.key || row.tenant_id !== expected.scope.tenantId ||
      row.user_id !== expected.scope.userId || row.request_fingerprint !== expected.fingerprint ||
      !row.result || typeof row.result !== "object" || Array.isArray(row.result)) {
    throw fail("PROMOTION_CONFLICT");
  }
  const result = row.result as Record<string, unknown>;
  if (Object.keys(result).length !== 3 || typeof result.candidateId !== "string" ||
      typeof result.memoryId !== "string" || result.stored !== true) {
    throw fail("PROMOTION_CONFLICT");
  }
  return Object.freeze({
    candidateId: result.candidateId,
    memoryId: result.memoryId,
    stored: true,
  });
}

export function isProviderOwnedCandidatePromotionPort(
  value: unknown,
): value is ProviderOwnedCandidatePromotionPort {
  return typeof value === "object" && value !== null && PROVIDER_OWNED_PORTS.has(value);
}

/**
 * Candidate approval transaction bound to one server-owned authority scope.
 * The insert callback must be closed over the same provider and use this transaction client.
 */
export class PostgresCandidatePromotionPort implements ProviderOwnedCandidatePromotionPort {
  private readonly scope: CanonicalScope;

  constructor(
    private readonly pool: PostgresCandidatePromotionPool,
    private readonly insert: PostgresCandidatePromotionInsert,
    authorityScope: MemoryScope,
    private readonly clock: () => number = Date.now,
  ) {
    if (!pool || typeof pool.connect !== "function" || typeof insert !== "function" ||
        typeof clock !== "function") throw fail("INVALID_INPUT");
    this.scope = canonicalScope(authorityScope);
    PROVIDER_OWNED_PORTS.add(this);
  }

  async promote(input: CandidatePromotionInput): Promise<CandidatePromotionResult> {
    const candidateId = requiredId(input?.candidateId);
    const key = storageKey(this.scope, candidateId);
    let client: PostgresCandidatePromotionClient;
    try {
      client = await this.pool.connect();
    } catch {
      throw fail("PROMOTION_FAILED");
    }
    let begun = false;
    let committed = false;
    let failure: unknown;
    let result: CandidatePromotionResult | undefined;
    let cleanupFailed = false;
    try {
      await client.query("BEGIN");
      begun = true;
      const selected = await client.query(
        `SELECT id, text, semantic_type, kind, confidence, content_hash, evidence_ids, status, metadata,
  promoted_to_memory_id
FROM mengshu_candidates
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = $9 AND id = $10
FOR UPDATE`,
        candidateParams(this.scope, candidateId),
      );
      if ((selected.rowCount ?? selected.rows.length) !== selected.rows.length || selected.rows.length !== 1) {
        throw fail("CANDIDATE_NOT_PENDING");
      }
      // Only the evolution writer can hydrate staged evidence and atomically apply a proposal.
      const metadata = selected.rows[0]?.metadata;
      if (metadata && typeof metadata === "object" &&
          Object.prototype.hasOwnProperty.call(metadata, "evolution")) {
        throw fail("EVOLUTION_REVIEW_REQUIRED");
      }
      const candidate = decodeCandidate(selected.rows[0]);
      if (candidate.id !== candidateId) throw fail("PROMOTION_CONFLICT");
      if (candidate.status !== "pending" && candidate.status !== "approved") {
        throw fail("CANDIDATE_NOT_PENDING");
      }
      const memory = createCandidatePromotionMemory(
        candidate,
        publicScope(this.scope),
        input?.material,
      );
      const fingerprint = requestFingerprint(candidateId, memory);

      const receiptRows = await client.query(
        `SELECT storage_key, tenant_id, user_id, request_fingerprint, result
FROM mengshu_write_receipts
WHERE storage_key = $1`,
        [key],
      );
      if ((receiptRows.rowCount ?? receiptRows.rows.length) !== receiptRows.rows.length ||
          receiptRows.rows.length > 1) throw fail("PROMOTION_CONFLICT");
      const receipt = decodeReceipt(receiptRows.rows[0], {
        key,
        scope: this.scope,
        fingerprint,
      });

      if (candidate.status === "approved") {
        if (!receipt || candidate.promotedToMemoryId !== receipt.memoryId ||
            receipt.candidateId !== candidateId || receipt.memoryId !== memory.id) {
          throw fail("PROMOTION_CONFLICT");
        }
        result = Object.freeze({ status: "replayed", ...receipt });
      } else {
        if (receipt) throw fail("PROMOTION_CONFLICT");
        const inserted = await this.insert(client, memory);
        if (inserted.requestedId !== memory.id || inserted.persistedId !== memory.id ||
            inserted.stored !== true) throw fail("PROMOTION_CONFLICT");
        const now = new Date(this.clock());
        if (!Number.isFinite(now.getTime())) throw fail("PROMOTION_FAILED");
        const updated = await client.query(
          `UPDATE mengshu_candidates
SET status = 'approved', active_content_hash = NULL, promoted_to_memory_id = $11,
  updated_at = $12
WHERE tenant_id = $1 AND user_id = $2 AND app_id = $3 AND project_id = $4
  AND agent_id = $5 AND namespace = $6 AND visibility = $7
  AND workspace_id = $8 AND session_id = $9 AND id = $10 AND status = 'pending'
RETURNING id, status, promoted_to_memory_id`,
          [...candidateParams(this.scope, candidateId), memory.id, now.getTime()],
        );
        const updatedRow = updated.rows[0];
        if ((updated.rowCount ?? updated.rows.length) !== 1 || updated.rows.length !== 1 ||
            updatedRow?.id !== candidateId || updatedRow.status !== "approved" ||
            updatedRow.promoted_to_memory_id !== memory.id) throw fail("PROMOTION_CONFLICT");
        const scopeValues = [
          this.scope.tenantId, this.scope.userId, this.scope.projectId, this.scope.appId,
          this.scope.agentId, this.scope.namespace, this.scope.visibility,
          this.scope.workspaceId, this.scope.sessionId,
        ];
        await client.query(
          `INSERT INTO mengshu_write_audit (
  storage_key, memory_id, action, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.store', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [key, memory.id, ...scopeValues, now],
        );
        await client.query(
          `INSERT INTO mengshu_write_outbox (
  event_id, storage_key, topic, memory_id, tenant_id, user_id, canonical_project_id,
  product_id, producer_id, namespace, visibility, workspace_id, session_id, occurred_at
) VALUES ($1, $2, 'memory.written', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [eventId(key, memory.id), key, memory.id, ...scopeValues, now],
        );
        const durableResult: PromotionReceipt = Object.freeze({
          candidateId,
          memoryId: memory.id,
          stored: true,
        });
        await client.query(
          `INSERT INTO mengshu_write_receipts (
  storage_key, tenant_id, user_id, request_fingerprint, result
) VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [key, this.scope.tenantId, this.scope.userId, fingerprint, JSON.stringify(durableResult)],
        );
        result = Object.freeze({ status: "applied", ...durableResult });
      }
      await client.query("COMMIT");
      committed = true;
    } catch (error) {
      failure = error;
      if (begun && !committed) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          failure = new AggregateError([error, rollbackError], "Candidate promotion rollback failed");
        }
      }
      if (failure instanceof PostgresCandidatePromotionError) throw failure;
      throw fail("PROMOTION_FAILED");
    } finally {
      try {
        client.release();
      } catch {
        if (!failure && committed) cleanupFailed = true;
      }
    }
    if (!result || !committed) throw fail("PROMOTION_FAILED");
    return cleanupFailed ? { ...result, cleanupFailed: true } : result;
  }
}
