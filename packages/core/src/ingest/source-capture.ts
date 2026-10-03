import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope, SourceRevisionRef } from "../domain/types.js";
import {
  CaptureContractError,
  captureIdempotencyKey,
  type CaptureReceipt,
  type RawArchiveManifest,
} from "./capture-contract.js";
import {
  type FileRawArchive,
  parseRawArchiveManifest,
  rawContentRelativePath,
  type RawArchiveKind,
  type RawArchiveMediaType,
  RawArchiveError,
} from "./raw-archive.js";

export const SOURCE_CAPTURE_SCHEMA_VERSION = 38;

const TEXT_MEDIA = new Set<RawArchiveMediaType>(["text/plain", "application/json"]);
const CAPTURE_COLUMNS = `
  scope_fingerprint, capture_id, idempotency_key, source_id, revision, payload_hash,
  manifest, status, outbox_status, trace_id, job_id, occurred_at`;

export class SourceCaptureError extends Error {
  override readonly name = "SourceCaptureError";

  constructor(
    readonly code: "CAPTURE_REVISION_CONFLICT" | "SOURCE_CAPTURE_NOT_FOUND" | "SOURCE_CAPTURE_DAMAGED",
  ) {
    super(code);
  }
}

export interface SourceCaptureRow {
  readonly scopeFingerprint: string;
  readonly captureId: string;
  readonly idempotencyKey: string;
  readonly sourceId: string;
  readonly revision: string;
  readonly payloadHash: string;
  readonly manifest: RawArchiveManifest;
  readonly status: "captured" | "damaged";
  readonly outboxStatus: "pending" | "published";
  readonly traceId: string;
  readonly jobId?: string;
  readonly occurredAt: number;
}

export interface SourceCaptureCommitInput {
  readonly scopeFingerprint: string;
  readonly captureId: string;
  readonly idempotencyKey: string;
  readonly source: SourceRevisionRef;
  readonly manifest: RawArchiveManifest;
  readonly occurredAt: number;
}

export interface SourceCaptureStore {
  commit(input: SourceCaptureCommitInput): Promise<SourceCaptureRow & { readonly replayed: boolean }>;
  findByCaptureId(scopeFingerprint: string, captureId: string): Promise<SourceCaptureRow | undefined>;
  findByIdempotency(scopeFingerprint: string, idempotencyKey: string): Promise<SourceCaptureRow | undefined>;
  ackPublished(scopeFingerprint: string, captureId: string, jobId: string): Promise<boolean>;
  markDamaged(scopeFingerprint: string, captureId: string): Promise<boolean>;
  listPending(scopeFingerprint: string | undefined, limit: number): Promise<readonly SourceCaptureRow[]>;
  listCaptured(limit: number): Promise<readonly SourceCaptureRow[]>;
}

export interface SourceCaptureRequest {
  readonly scope: MemoryScope;
  readonly sourceId: string;
  readonly revision?: string;
  readonly bytes: Uint8Array;
  readonly mediaType: RawArchiveMediaType;
  readonly kind: RawArchiveKind;
}

export interface SourceCaptureEnqueueInput {
  readonly type: "extract_candidate";
  readonly payload: {
    readonly scope: MemoryScope;
    readonly text: string;
    readonly traceId: string;
    readonly intent: "auto";
  };
}

export interface SourceCaptureCompensateResult {
  readonly enqueued: number;
  readonly damaged: number;
  readonly pending: number;
}

export interface SourceCaptureReconcileResult {
  readonly recovered: number;
  readonly damaged: number;
}

interface QueryResult {
  readonly rows: readonly Record<string, unknown>[];
  readonly rowCount: number | null;
}

export interface SourceCaptureQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResult>;
  release(): void;
}

export interface SourceCapturePool {
  connect(): Promise<SourceCaptureQueryClient>;
}

function limitOf(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new CaptureContractError("CAPTURE_CONTRACT_INVALID");
  }
  return limit;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rowSource(row: SourceCaptureRow): SourceRevisionRef {
  return Object.freeze({
    sourceId: row.sourceId,
    revision: row.revision,
    payloadHash: row.payloadHash,
  });
}

function receiptFromRow(
  row: SourceCaptureRow,
  replayed: boolean,
): CaptureReceipt {
  return Object.freeze({
    captureId: row.captureId,
    status: row.status,
    source: rowSource(row),
    idempotencyKey: row.idempotencyKey,
    ...(row.jobId === undefined ? {} : { jobId: row.jobId }),
    replayed,
  });
}

function epochMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

function mapRow(value: Record<string, unknown>): SourceCaptureRow {
  let manifest: RawArchiveManifest;
  try {
    manifest = parseRawArchiveManifest(value.manifest);
  } catch {
    throw new SourceCaptureError("SOURCE_CAPTURE_DAMAGED");
  }
  const status = value.status === "damaged" ? "damaged" : value.status === "captured" ? "captured" : undefined;
  const outboxStatus = value.outbox_status === "published"
    ? "published"
    : value.outbox_status === "pending" ? "pending" : undefined;
  const occurredAt = epochMillis(value.occurred_at);
  const jobId = value.job_id === null || value.job_id === undefined ? undefined : value.job_id;
  if (status === undefined || outboxStatus === undefined || occurredAt === undefined ||
      typeof value.scope_fingerprint !== "string" || typeof value.capture_id !== "string" ||
      typeof value.idempotency_key !== "string" || typeof value.source_id !== "string" ||
      typeof value.revision !== "string" || typeof value.payload_hash !== "string" ||
      typeof value.trace_id !== "string" || (jobId !== undefined && typeof jobId !== "string") ||
      value.capture_id !== manifest.captureId || value.payload_hash !== manifest.source.payloadHash ||
      value.source_id !== manifest.source.sourceId || value.revision !== manifest.source.revision) {
    throw new SourceCaptureError("SOURCE_CAPTURE_DAMAGED");
  }
  return Object.freeze({
    scopeFingerprint: value.scope_fingerprint,
    captureId: value.capture_id,
    idempotencyKey: value.idempotency_key,
    sourceId: value.source_id,
    revision: value.revision,
    payloadHash: value.payload_hash,
    manifest,
    status,
    outboxStatus,
    traceId: value.trace_id,
    ...(jobId === undefined ? {} : { jobId }),
    occurredAt,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "23505";
}

export class InMemorySourceCaptureStore implements SourceCaptureStore {
  readonly rows = new Map<string, SourceCaptureRow>();
  failCommits = 0;

  async commit(input: SourceCaptureCommitInput): Promise<SourceCaptureRow & { readonly replayed: boolean }> {
    if (this.failCommits > 0) {
      this.failCommits -= 1;
      throw new Error("source capture store unavailable");
    }
    const existing = [...this.rows.values()].find((row) =>
      row.scopeFingerprint === input.scopeFingerprint && row.idempotencyKey === input.idempotencyKey);
    if (existing) return Object.freeze({ ...existing, replayed: true });
    const revision = [...this.rows.values()].find((row) =>
      row.scopeFingerprint === input.scopeFingerprint && row.sourceId === input.source.sourceId &&
      row.revision === input.source.revision);
    if (revision) throw new SourceCaptureError("CAPTURE_REVISION_CONFLICT");
    const row = Object.freeze({
      scopeFingerprint: input.scopeFingerprint,
      captureId: input.captureId,
      idempotencyKey: input.idempotencyKey,
      sourceId: input.source.sourceId,
      revision: input.source.revision,
      payloadHash: input.source.payloadHash,
      manifest: input.manifest,
      status: "captured" as const,
      outboxStatus: "pending" as const,
      traceId: input.captureId,
      occurredAt: input.occurredAt,
    });
    this.rows.set(`${row.scopeFingerprint}\0${row.captureId}`, row);
    return Object.freeze({ ...row, replayed: false });
  }

  async findByCaptureId(scopeFingerprint: string, captureId: string): Promise<SourceCaptureRow | undefined> {
    return this.rows.get(`${scopeFingerprint}\0${captureId}`);
  }

  async findByIdempotency(scopeFingerprint: string, idempotencyKey: string): Promise<SourceCaptureRow | undefined> {
    return [...this.rows.values()].find((row) =>
      row.scopeFingerprint === scopeFingerprint && row.idempotencyKey === idempotencyKey);
  }

  async ackPublished(scopeFingerprint: string, captureId: string, jobId: string): Promise<boolean> {
    const row = await this.findByCaptureId(scopeFingerprint, captureId);
    if (!row || row.status !== "captured" || row.outboxStatus !== "pending") return false;
    this.rows.set(`${scopeFingerprint}\0${captureId}`, Object.freeze({
      ...row,
      outboxStatus: "published",
      jobId,
    }));
    return true;
  }

  async markDamaged(scopeFingerprint: string, captureId: string): Promise<boolean> {
    const row = await this.findByCaptureId(scopeFingerprint, captureId);
    if (!row || row.status !== "captured") return false;
    this.rows.set(`${scopeFingerprint}\0${captureId}`, Object.freeze({ ...row, status: "damaged" }));
    return true;
  }

  async listPending(scopeFingerprint: string | undefined, limit: number): Promise<readonly SourceCaptureRow[]> {
    return Object.freeze([...this.rows.values()]
      .filter((row) => row.status === "captured" && row.outboxStatus === "pending" &&
        (scopeFingerprint === undefined || row.scopeFingerprint === scopeFingerprint))
      .sort((left, right) => left.occurredAt - right.occurredAt || left.captureId.localeCompare(right.captureId))
      .slice(0, limitOf(limit)));
  }

  async listCaptured(limit: number): Promise<readonly SourceCaptureRow[]> {
    return Object.freeze([...this.rows.values()]
      .filter((row) => row.status === "captured")
      .sort((left, right) => left.occurredAt - right.occurredAt || left.captureId.localeCompare(right.captureId))
      .slice(0, limitOf(limit)));
  }
}

export class PostgresSourceCaptureStore implements SourceCaptureStore {
  constructor(private readonly pool: SourceCapturePool) {}

  private async transaction<T>(run: (query: SourceCaptureQueryClient["query"]) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let started = false;
    try {
      await client.query("BEGIN");
      started = true;
      const value = await run((sql, params) => client.query(sql, params));
      await client.query("COMMIT");
      started = false;
      return value;
    } catch (error) {
      if (started) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "source capture rollback failed");
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async query(sql: string, params: readonly unknown[] = []): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      return await client.query(sql, params);
    } finally {
      client.release();
    }
  }

  async commit(input: SourceCaptureCommitInput): Promise<SourceCaptureRow & { readonly replayed: boolean }> {
    const manifest = parseRawArchiveManifest(input.manifest);
    try {
      return await this.transaction(async (query) => {
        const byKey = await query(
          `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE scope_fingerprint = $1 AND idempotency_key = $2 FOR UPDATE`,
          [input.scopeFingerprint, input.idempotencyKey],
        );
        const existing = byKey.rows[0];
        if (existing) return Object.freeze({ ...mapRow(existing), replayed: true });
        const byRevision = await query(
          `SELECT payload_hash FROM mengshu_source_captures
WHERE scope_fingerprint = $1 AND source_id = $2 AND revision = $3 FOR UPDATE`,
          [input.scopeFingerprint, input.source.sourceId, input.source.revision],
        );
        if (byRevision.rows[0]) throw new SourceCaptureError("CAPTURE_REVISION_CONFLICT");
        await query(
          `INSERT INTO mengshu_source_captures (
  scope_fingerprint, capture_id, idempotency_key, source_id, revision, payload_hash,
  manifest, status, outbox_status, trace_id, job_id, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, 'captured', 'pending', $8, NULL, $9)`,
          [
            input.scopeFingerprint,
            input.captureId,
            input.idempotencyKey,
            input.source.sourceId,
            input.source.revision,
            input.source.payloadHash,
            JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>,
            input.captureId,
            input.occurredAt,
          ],
        );
        return Object.freeze({
          scopeFingerprint: input.scopeFingerprint,
          captureId: input.captureId,
          idempotencyKey: input.idempotencyKey,
          sourceId: input.source.sourceId,
          revision: input.source.revision,
          payloadHash: input.source.payloadHash,
          manifest,
          status: "captured" as const,
          outboxStatus: "pending" as const,
          traceId: input.captureId,
          occurredAt: input.occurredAt,
          replayed: false,
        });
      });
    } catch (error) {
      if (error instanceof SourceCaptureError) throw error;
      if (!isUniqueViolation(error)) throw error;
      const replay = await this.findByIdempotency(input.scopeFingerprint, input.idempotencyKey);
      if (replay) return Object.freeze({ ...replay, replayed: true });
      throw new SourceCaptureError("CAPTURE_REVISION_CONFLICT");
    }
  }

  async findByCaptureId(scopeFingerprint: string, captureId: string): Promise<SourceCaptureRow | undefined> {
    const result = await this.query(
      `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE scope_fingerprint = $1 AND capture_id = $2`,
      [scopeFingerprint, captureId],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async findByIdempotency(scopeFingerprint: string, idempotencyKey: string): Promise<SourceCaptureRow | undefined> {
    const result = await this.query(
      `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE scope_fingerprint = $1 AND idempotency_key = $2`,
      [scopeFingerprint, idempotencyKey],
    );
    const row = result.rows[0];
    return row ? mapRow(row) : undefined;
  }

  async ackPublished(scopeFingerprint: string, captureId: string, jobId: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE mengshu_source_captures
SET outbox_status = 'published', job_id = $3
WHERE scope_fingerprint = $1 AND capture_id = $2
  AND status = 'captured' AND outbox_status = 'pending'`,
      [scopeFingerprint, captureId, jobId],
    );
    return result.rowCount === 1;
  }

  async markDamaged(scopeFingerprint: string, captureId: string): Promise<boolean> {
    const result = await this.query(
      `UPDATE mengshu_source_captures
SET status = 'damaged'
WHERE scope_fingerprint = $1 AND capture_id = $2 AND status = 'captured'`,
      [scopeFingerprint, captureId],
    );
    return result.rowCount === 1;
  }

  async listPending(scopeFingerprint: string | undefined, limit: number): Promise<readonly SourceCaptureRow[]> {
    const bounded = limitOf(limit);
    const result = scopeFingerprint === undefined
      ? await this.query(
        `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE status = 'captured' AND outbox_status = 'pending'
ORDER BY occurred_at, capture_id
LIMIT $1`,
        [bounded],
      )
      : await this.query(
        `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE scope_fingerprint = $1 AND status = 'captured' AND outbox_status = 'pending'
ORDER BY occurred_at, capture_id
LIMIT $2`,
        [scopeFingerprint, bounded],
      );
    return Object.freeze(result.rows.map((row) => mapRow(row)));
  }

  async listCaptured(limit: number): Promise<readonly SourceCaptureRow[]> {
    const result = await this.query(
      `SELECT ${CAPTURE_COLUMNS} FROM mengshu_source_captures
WHERE status = 'captured'
ORDER BY occurred_at, capture_id
LIMIT $1`,
      [limitOf(limit)],
    );
    return Object.freeze(result.rows.map((row) => mapRow(row)));
  }
}

function pendingReceipt(input: {
  readonly captureId: string;
  readonly source: SourceRevisionRef;
  readonly idempotencyKey: string;
}): CaptureReceipt {
  return Object.freeze({
    captureId: input.captureId,
    status: "captured_local_pending",
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    replayed: false,
  });
}

export class SourceCaptureService {
  private readonly now: () => number;

  constructor(private readonly options: {
    readonly archive: FileRawArchive;
    readonly store: SourceCaptureStore;
    readonly now?: () => number;
  }) {
    this.now = options.now ?? Date.now;
  }

  async capture(input: SourceCaptureRequest): Promise<CaptureReceipt> {
    if (input.bytes.byteLength < 1) throw new CaptureContractError("CAPTURE_CONTRACT_INVALID");
    const scopeFingerprint = authorityScopeFingerprint(input.scope);
    const payloadHash = sha256(input.bytes);
    const source = Object.freeze({
      sourceId: input.sourceId,
      revision: input.revision ?? payloadHash,
      payloadHash,
    });
    const idempotencyKey = captureIdempotencyKey({ scopeFingerprint, source });
    const manifest = parseRawArchiveManifest({
      captureId: idempotencyKey,
      scope: input.scope,
      source,
      byteLength: input.bytes.byteLength,
      mediaType: input.mediaType,
      relativePath: rawContentRelativePath({
        kind: input.kind,
        sourceId: input.sourceId,
        revision: source.revision,
        mediaType: input.mediaType,
      }),
    });
    try {
      await this.options.archive.put({ manifest, bytes: input.bytes });
    } catch (error) {
      if (error instanceof RawArchiveError && error.code === "RAW_ARCHIVE_CONFLICT") {
        throw new SourceCaptureError("CAPTURE_REVISION_CONFLICT");
      }
      if (error instanceof CaptureContractError || error instanceof SourceCaptureError) throw error;
      if (error instanceof RawArchiveError && error.code === "RAW_ARCHIVE_INVALID") throw error;
      const staged = await this.options.archive.findManifest(scopeFingerprint, idempotencyKey);
      if (staged?.source.payloadHash === payloadHash) return pendingReceipt({ captureId: idempotencyKey, source, idempotencyKey });
      throw error;
    }
    try {
      const row = await this.options.store.commit({
        scopeFingerprint,
        captureId: idempotencyKey,
        idempotencyKey,
        source,
        manifest,
        occurredAt: this.now(),
      });
      return receiptFromRow(row, row.replayed);
    } catch (error) {
      if (error instanceof SourceCaptureError || error instanceof CaptureContractError) throw error;
      if (error instanceof RawArchiveError && error.code !== "RAW_ARCHIVE_DAMAGED") throw error;
      return pendingReceipt({ captureId: idempotencyKey, source, idempotencyKey });
    }
  }

  async read(scope: MemoryScope, captureId: string): Promise<Uint8Array> {
    const scopeFingerprint = authorityScopeFingerprint(scope);
    const row = await this.options.store.findByCaptureId(scopeFingerprint, captureId);
    const manifest = row?.manifest ?? await this.options.archive.findManifest(scopeFingerprint, captureId);
    if (!manifest) throw new SourceCaptureError("SOURCE_CAPTURE_NOT_FOUND");
    try {
      return await this.options.archive.read(manifest);
    } catch (error) {
      if (row?.status === "captured") await this.options.store.markDamaged(scopeFingerprint, captureId);
      if (error instanceof SourceCaptureError) throw error;
      throw new SourceCaptureError("SOURCE_CAPTURE_DAMAGED");
    }
  }

  async acknowledge(scope: MemoryScope, captureId: string, jobId: string): Promise<boolean> {
    if (jobId.trim() === "" || jobId.length > 256) throw new CaptureContractError("CAPTURE_CONTRACT_INVALID");
    return this.options.store.ackPublished(authorityScopeFingerprint(scope), captureId, jobId);
  }

  async compensate(
    enqueue: (input: SourceCaptureEnqueueInput) => Promise<string>,
  ): Promise<SourceCaptureCompensateResult> {
    const pending = await this.options.store.listPending(undefined, 100);
    let enqueued = 0;
    let damaged = 0;
    let stillPending = 0;
    for (const row of pending) {
      let bytes: Uint8Array;
      try {
        bytes = await this.options.archive.read(row.manifest);
      } catch {
        if (await this.options.store.markDamaged(row.scopeFingerprint, row.captureId)) damaged += 1;
        continue;
      }
      if (!TEXT_MEDIA.has(row.manifest.mediaType as RawArchiveMediaType)) {
        stillPending += 1;
        continue;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        stillPending += 1;
        continue;
      }
      try {
        const jobId = await enqueue({
          type: "extract_candidate",
          payload: {
            scope: row.manifest.scope,
            text,
            traceId: row.captureId,
            intent: "auto",
          },
        });
        if (await this.options.store.ackPublished(row.scopeFingerprint, row.captureId, jobId)) enqueued += 1;
        else stillPending += 1;
      } catch {
        stillPending += 1;
      }
    }
    return Object.freeze({ enqueued, damaged, pending: stillPending });
  }

  async reconcile(): Promise<SourceCaptureReconcileResult> {
    let recovered = 0;
    let damaged = 0;
    const damagedIds = new Set<string>();
    for (const manifest of await this.options.archive.listManifests()) {
      const scopeFingerprint = authorityScopeFingerprint(manifest.scope);
      try {
        await this.options.archive.read(manifest);
      } catch {
        if (await this.options.store.markDamaged(scopeFingerprint, manifest.captureId)) {
          damaged += 1;
          damagedIds.add(`${scopeFingerprint}\0${manifest.captureId}`);
        }
        continue;
      }
      try {
        const row = await this.options.store.commit({
          scopeFingerprint,
          captureId: manifest.captureId,
          idempotencyKey: manifest.captureId,
          source: manifest.source,
          manifest,
          occurredAt: this.now(),
        });
        if (!row.replayed) recovered += 1;
      } catch (error) {
        if (error instanceof SourceCaptureError && error.code === "CAPTURE_REVISION_CONFLICT") continue;
        throw error;
      }
    }
    for (const row of await this.options.store.listCaptured(1_000)) {
      const key = `${row.scopeFingerprint}\0${row.captureId}`;
      if (damagedIds.has(key)) continue;
      try {
        await this.options.archive.read(row.manifest);
      } catch {
        if (await this.options.store.markDamaged(row.scopeFingerprint, row.captureId)) {
          damaged += 1;
          damagedIds.add(key);
        }
      }
    }
    return Object.freeze({ recovered, damaged });
  }
}
