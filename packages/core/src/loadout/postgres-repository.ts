import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { AgentLoadoutRepository } from "./repository.js";
import {
  AgentLoadoutError,
  validatePersistedAgentLoadout,
  validatePersistedAgentLoadoutReceipt,
} from "./service.js";
import type { AgentLoadout, AgentLoadoutReceipt } from "./types.js";

interface QueryResultLike {
  readonly rows?: readonly Record<string, unknown>[];
  readonly rowCount?: number | null;
}

export interface PostgresAgentLoadoutQueryClient {
  query(sql: string, params?: readonly unknown[]): Promise<QueryResultLike>;
}

export interface PostgresAgentLoadoutTransactionClient extends PostgresAgentLoadoutQueryClient {
  release(): void;
}

export interface PostgresAgentLoadoutPool extends PostgresAgentLoadoutQueryClient {
  connect(): Promise<PostgresAgentLoadoutTransactionClient>;
}

function fingerprint(scope: MemoryScope): string {
  const normalized = scope.visibility === undefined
    ? { ...scope, visibility: "private" as const }
    : scope;
  if (normalized.visibility !== "private") throw new AgentLoadoutError("PRIVATE_SCOPE_REQUIRED");
  try {
    return authorityScopeFingerprint(normalized);
  } catch {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
}

function first(result: QueryResultLike): Record<string, unknown> | undefined {
  return result.rows?.[0];
}

function descriptor(
  value: unknown,
  scopeFingerprint: string,
  loadoutId?: string,
  version?: number,
): AgentLoadout {
  const loadout = validatePersistedAgentLoadout(value);
  if (authorityScopeFingerprint(loadout.scope) !== scopeFingerprint ||
      (loadoutId !== undefined && loadout.id !== loadoutId) ||
      (version !== undefined && loadout.version !== version)) {
    throw new AgentLoadoutError("SCOPE_MISMATCH");
  }
  return loadout;
}

function descriptorRow(
  row: Record<string, unknown>,
  scopeFingerprint: string,
  loadoutId?: string,
  version?: number,
  requireHead = false,
): AgentLoadout {
  const loadout = descriptor(row.descriptor, scopeFingerprint, loadoutId, version);
  const persistedVersion = Number(row.version);
  const headVersion = Number(row.latest_version);
  const projectId = row.project_id === null ? undefined : row.project_id;
  if (row.scope_fingerprint !== scopeFingerprint || row.loadout_id !== loadout.id ||
      !Number.isSafeInteger(persistedVersion) || persistedVersion !== loadout.version ||
      row.app_id !== loadout.appId || row.agent_id !== loadout.agentId ||
      projectId !== loadout.projectId || row.visibility !== loadout.visibility ||
      (requireHead && (!Number.isSafeInteger(headVersion) || headVersion !== persistedVersion))) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return loadout;
}

function receipt(value: unknown): AgentLoadoutReceipt {
  return validatePersistedAgentLoadoutReceipt(value);
}

function receiptRow(
  row: Record<string, unknown>,
  scopeFingerprint: string,
  requestKey?: string,
): AgentLoadoutReceipt {
  const persisted = receipt(row.receipt);
  if (row.scope_fingerprint !== scopeFingerprint || row.request_key !== persisted.requestKey ||
      row.request_hash !== persisted.requestHash || row.loadout_id !== persisted.loadoutId ||
      Number(row.loadout_version) !== persisted.loadoutVersion ||
      (requestKey !== undefined && persisted.requestKey !== requestKey)) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return persisted;
}

function assertReturned(
  result: QueryResultLike,
  field: string,
  expected?: unknown,
): Record<string, unknown> {
  const row = first(result);
  if (result.rowCount !== 1 || result.rows?.length !== 1 || !row ||
      !Object.hasOwn(row, field) || row[field] === null || row[field] === undefined ||
      (expected !== undefined && row[field] !== expected)) {
    throw new AgentLoadoutError("INVALID_INPUT");
  }
  return row;
}

function sameIdempotentLoadout(left: AgentLoadout, right: AgentLoadout): boolean {
  const { createdAt: _leftCreatedAt, updatedAt: _leftUpdatedAt, ...leftStable } = left;
  const { createdAt: _rightCreatedAt, updatedAt: _rightUpdatedAt, ...rightStable } = right;
  return isDeepStrictEqual(leftStable, rightStable);
}

export class PostgresAgentLoadoutRepository implements AgentLoadoutRepository {
  readonly now: () => number;

  constructor(
    private readonly pool: PostgresAgentLoadoutPool,
    options: { readonly now?: () => number } = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  async resolveCurrent(scope: MemoryScope): Promise<AgentLoadout | undefined> {
    const scopeFingerprint = fingerprint(scope);
    const result = await this.pool.query(
      `/* loadout-repository:resolve-current */
SELECT heads.scope_fingerprint, heads.loadout_id, heads.latest_version,
       versions.version, versions.app_id, versions.agent_id, versions.project_id,
       versions.visibility, versions.descriptor
FROM mengshu_loadout_heads AS heads
JOIN mengshu_loadout_versions AS versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.loadout_id = heads.loadout_id
 AND versions.version = heads.latest_version
WHERE versions.scope_fingerprint = $1
  AND versions.app_id = $2
  AND versions.agent_id = $3
  AND (versions.project_id IS NULL OR versions.project_id = $4)
ORDER BY versions.loadout_id
LIMIT 2`,
      [scopeFingerprint, scope.appId, scope.agentId, scope.projectId],
    );
    if ((result.rows?.length ?? 0) > 1) throw new AgentLoadoutError("INVALID_INPUT");
    const row = first(result);
    return row ? descriptorRow(row, scopeFingerprint, undefined, undefined, true) : undefined;
  }

  async getLatest(scope: MemoryScope, id: string): Promise<AgentLoadout | undefined> {
    const scopeFingerprint = fingerprint(scope);
    const result = await this.pool.query(
      `/* loadout-repository:get-latest */
SELECT heads.scope_fingerprint, heads.loadout_id, heads.latest_version,
       versions.version, versions.app_id, versions.agent_id, versions.project_id,
       versions.visibility, versions.descriptor
FROM mengshu_loadout_heads AS heads
JOIN mengshu_loadout_versions AS versions
  ON versions.scope_fingerprint = heads.scope_fingerprint
 AND versions.loadout_id = heads.loadout_id
 AND versions.version = heads.latest_version
WHERE heads.scope_fingerprint = $1 AND heads.loadout_id = $2`,
      [scopeFingerprint, id],
    );
    const row = first(result);
    return row ? descriptorRow(row, scopeFingerprint, id, undefined, true) : undefined;
  }

  async getVersion(
    scope: MemoryScope,
    id: string,
    version: number,
  ): Promise<AgentLoadout | undefined> {
    const scopeFingerprint = fingerprint(scope);
    const result = await this.pool.query(
      `/* loadout-repository:get-version */
SELECT scope_fingerprint, loadout_id, version, app_id, agent_id, project_id,
       visibility, descriptor
FROM mengshu_loadout_versions
WHERE scope_fingerprint = $1 AND loadout_id = $2 AND version = $3`,
      [scopeFingerprint, id, version],
    );
    const row = first(result);
    return row ? descriptorRow(row, scopeFingerprint, id, version) : undefined;
  }

  async getReceipt(
    scope: MemoryScope,
    requestKey: string,
  ): Promise<AgentLoadoutReceipt | undefined> {
    const scopeFingerprint = fingerprint(scope);
    const result = await this.pool.query(
      `/* loadout-repository:get-receipt */
SELECT scope_fingerprint, request_key, request_hash, loadout_id, loadout_version, receipt
FROM mengshu_loadout_receipts
WHERE scope_fingerprint = $1 AND request_key = $2`,
      [scopeFingerprint, requestKey],
    );
    const row = first(result);
    return row ? receiptRow(row, scopeFingerprint, requestKey) : undefined;
  }

  async appendVersion(input: {
    readonly loadout: AgentLoadout;
    readonly receipt: AgentLoadoutReceipt;
    readonly expectedLatestVersion: number;
  }) {
    const loadout = validatePersistedAgentLoadout(input.loadout);
    const persistedReceipt = receipt(input.receipt);
    const scopeFingerprint = fingerprint(loadout.scope);
    if (!Number.isSafeInteger(input.expectedLatestVersion) || input.expectedLatestVersion < 0 ||
        loadout.version !== input.expectedLatestVersion + 1 ||
        persistedReceipt.loadoutId !== loadout.id ||
        persistedReceipt.loadoutVersion !== loadout.version) {
      throw new AgentLoadoutError("VERSION_CONFLICT");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const receiptLock = await client.query(
        `/* loadout-repository:receipt-lock */
WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1)))
SELECT receipts.scope_fingerprint, receipts.request_key, receipts.request_hash,
       receipts.loadout_id, receipts.loadout_version, receipts.receipt,
       versions.descriptor, versions.app_id AS version_app_id,
       versions.agent_id AS version_agent_id, versions.project_id AS version_project_id,
       versions.visibility AS version_visibility
FROM locked
LEFT JOIN mengshu_loadout_receipts AS receipts
  ON receipts.scope_fingerprint = $2 AND receipts.request_key = $3
LEFT JOIN mengshu_loadout_versions AS versions
  ON versions.scope_fingerprint = receipts.scope_fingerprint
 AND versions.loadout_id = receipts.loadout_id
 AND versions.version = receipts.loadout_version`,
        [`loadout-receipt:${scopeFingerprint}:${persistedReceipt.requestKey}`,
          scopeFingerprint, persistedReceipt.requestKey],
      );
      const existingValue = first(receiptLock)?.receipt;
      if (existingValue !== undefined && existingValue !== null) {
        const lockedRow = first(receiptLock)!;
        const existing = receiptRow(lockedRow, scopeFingerprint, persistedReceipt.requestKey);
        const persistedLoadout = descriptorRow({
          scope_fingerprint: lockedRow.scope_fingerprint,
          loadout_id: lockedRow.loadout_id,
          version: lockedRow.loadout_version,
          app_id: lockedRow.version_app_id,
          agent_id: lockedRow.version_agent_id,
          project_id: lockedRow.version_project_id,
          visibility: lockedRow.version_visibility,
          descriptor: lockedRow.descriptor,
        }, scopeFingerprint, existing.loadoutId, existing.loadoutVersion);
        if (existing.requestHash !== persistedReceipt.requestHash ||
            existing.loadoutId !== persistedReceipt.loadoutId ||
            existing.loadoutVersion !== persistedReceipt.loadoutVersion ||
            !isDeepStrictEqual(existing, persistedReceipt) ||
            !sameIdempotentLoadout(persistedLoadout, loadout)) {
          throw new AgentLoadoutError("IDEMPOTENCY_CONFLICT");
        }
        await client.query("COMMIT");
        return { loadout: persistedLoadout, receipt: existing, replayed: true };
      }
      const headLock = await client.query(
        `/* loadout-repository:head-lock */
WITH locked AS (SELECT pg_advisory_xact_lock(hashtext($1)))
SELECT heads.latest_version
FROM locked
LEFT JOIN mengshu_loadout_heads AS heads
  ON heads.scope_fingerprint = $2 AND heads.loadout_id = $3
FOR UPDATE OF heads`,
        [`loadout-head:${scopeFingerprint}:${loadout.id}`, scopeFingerprint, loadout.id],
      );
      const latestValue = first(headLock)?.latest_version;
      const latest = latestValue === undefined || latestValue === null ? 0 : Number(latestValue);
      if (!Number.isSafeInteger(latest) || latest !== input.expectedLatestVersion) {
        throw new AgentLoadoutError("VERSION_CONFLICT");
      }
      const insertedVersion = await client.query(
        `/* loadout-repository:insert-version */
INSERT INTO mengshu_loadout_versions (
  scope_fingerprint, loadout_id, version, app_id, agent_id,
  project_id, visibility, descriptor, created_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
RETURNING version`,
        [scopeFingerprint, loadout.id, loadout.version, loadout.appId, loadout.agentId,
          loadout.projectId ?? null, loadout.visibility, JSON.stringify(loadout),
          Date.parse(loadout.createdAt)],
      );
      assertReturned(insertedVersion, "version", loadout.version);
      const head = await client.query(
        `/* loadout-repository:upsert-head */
INSERT INTO mengshu_loadout_heads (scope_fingerprint, loadout_id, latest_version, changed_at)
VALUES ($1, $2, $3, $4)
ON CONFLICT (scope_fingerprint, loadout_id) DO UPDATE
SET latest_version = EXCLUDED.latest_version, changed_at = EXCLUDED.changed_at
WHERE mengshu_loadout_heads.latest_version = $5
RETURNING latest_version`,
        [scopeFingerprint, loadout.id, loadout.version, Date.parse(loadout.updatedAt),
          input.expectedLatestVersion],
      );
      if (head.rowCount === 0) throw new AgentLoadoutError("VERSION_CONFLICT");
      assertReturned(head, "latest_version", loadout.version);
      const insertedReceipt = await client.query(
        `/* loadout-repository:insert-receipt */
INSERT INTO mengshu_loadout_receipts (
  scope_fingerprint, request_key, request_hash, loadout_id,
  loadout_version, receipt, created_at
) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
RETURNING request_key`,
        [scopeFingerprint, persistedReceipt.requestKey, persistedReceipt.requestHash,
          loadout.id, loadout.version, JSON.stringify(persistedReceipt),
          Date.parse(loadout.updatedAt)],
      );
      assertReturned(insertedReceipt, "request_key", persistedReceipt.requestKey);
      const insertedAudit = await client.query(
        `/* loadout-repository:insert-audit */
INSERT INTO mengshu_loadout_audit (
  scope_fingerprint, loadout_id, loadout_version,
  event_type, request_key, occurred_at
) VALUES ($1, $2, $3, 'version_created', $4, $5)
RETURNING audit_id`,
        [scopeFingerprint, loadout.id, loadout.version, persistedReceipt.requestKey,
          Date.parse(loadout.updatedAt)],
      );
      assertReturned(insertedAudit, "audit_id");
      const eventId = createHash("sha256")
        .update(JSON.stringify([
          "mengshu.loadout-outbox/v1", scopeFingerprint, persistedReceipt.requestKey,
        ]))
        .digest("hex");
      const insertedOutbox = await client.query(
        `/* loadout-repository:insert-outbox */
INSERT INTO mengshu_loadout_outbox (
  event_id, scope_fingerprint, loadout_id, loadout_version,
  event_type, payload, occurred_at
) VALUES ($1, $2, $3, $4, 'loadout.version.created', $5::jsonb, $6)
RETURNING event_id`,
        [eventId, scopeFingerprint, loadout.id, loadout.version,
          JSON.stringify({ loadoutId: loadout.id, version: loadout.version }),
          Date.parse(loadout.updatedAt)],
      );
      assertReturned(insertedOutbox, "event_id", eventId);
      await client.query("COMMIT");
      return { loadout, receipt: persistedReceipt, replayed: false };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the domain or database error that caused the rollback.
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
