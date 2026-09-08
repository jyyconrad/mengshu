import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { resolveAuthorityScope, type AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { EvolutionError } from "../packages/core/src/evolution/schema.js";
import type { EvolutionJson, EvolutionReviewActor } from "../packages/core/src/evolution/types.js";
import { PostgresEvolutionError, transaction, type PostgresEvolutionPool, type PostgresEvolutionQueryClient } from "../packages/core/src/evolution/postgres-common.js";
import type { PostgresEvolutionAdministrativeReviewGuard } from "../packages/core/src/evolution/postgres-source-reconciliation.js";

export const EVOLUTION_HOST_STATE_KINDS = ["source_attestation", "source_revocation", "governance_undo", "reuse_grants", "target_profile", "compatibility_binding", "paired_evaluation", "skill_draft_gate", "paired_holdout"] as const;
export type EvolutionHostStateKind = typeof EVOLUTION_HOST_STATE_KINDS[number];
export type EvolutionHostControlKind = Exclude<EvolutionHostStateKind, "paired_holdout">;
export const EVOLUTION_HOST_STATE_MAX_VALUE_BYTES = 16_384;
export const EVOLUTION_HOST_STATE_MAX_ENTRY_BYTES = 32_768;
export interface EvolutionHostStateKey { kind: EvolutionHostControlKind; id: string }
export interface EvolutionHostStateEntry {
  kind: EvolutionHostStateKind; id: string; scopeFingerprint: string; ownerKey: string;
  revision: number; value: EvolutionJson; valueHash: string; updatedAt: number; expiresAt?: number; revokedAt?: number;
}
export interface EvolutionHostStateMutation extends EvolutionHostStateKey {
  expectedRevision: number; idempotencyKey: string; value: EvolutionJson; expiresAt?: number; operation?: "put" | "revoke";
}
export interface EvolutionHostStateReceipt {
  id: string; kind: EvolutionHostStateKind; entryId: string; scopeFingerprint: string; ownerKey: string;
  operation: "put" | "revoke" | "claim"; requestHash: string; idempotencyKey: string;
  revision: number; valueHash: string; createdAt: number;
  actor: EvolutionReviewActor | { actorId: "host:paired_evaluator"; authentication: "host_task"; tenantId: string; userId: string };
}
export interface EvolutionHostStatePort {
  readonly scope: MemoryScope;
  readonly authority: AuthorityScope;
  readonly scopeFingerprint: string;
  read(key: EvolutionHostStateKey, signal?: AbortSignal): Promise<EvolutionHostStateEntry | undefined>;
  readMany(keys: readonly EvolutionHostStateKey[], budget: { maxRecords: number; maxBytes: number; signal?: AbortSignal }): Promise<{ entries: EvolutionHostStateEntry[]; recordsRead: number; bytesRead: number; revision: string }>;
  /** Caller owns the transaction; locks prevent even an absent revocation key from being inserted before commit. */
  readManyLocked(client: PostgresEvolutionQueryClient, keys: readonly EvolutionHostStateKey[], budget: { maxRecords: number; maxBytes: number; signal?: AbortSignal }): Promise<{ entries: EvolutionHostStateEntry[]; recordsRead: number; bytesRead: number; revision: string }>;
  list(kind: EvolutionHostControlKind, signal?: AbortSignal): Promise<{ entries: EvolutionHostStateEntry[]; revision: string }>;
  put(request: EvolutionHostStateMutation, signal?: AbortSignal): Promise<EvolutionHostStateReceipt>;
  getReceipt(receiptId: string): Promise<EvolutionHostStateReceipt | undefined>;
  claimHoldout(input: { planHash: string; holdoutRef: string; holdoutHash: string; sourceScope: MemoryScope; signal?: AbortSignal }): Promise<boolean>;
  readonly administrativeReviewGuard: PostgresEvolutionAdministrativeReviewGuard;
}
export interface PostgresEvolutionHostStateOptions {
  pool: PostgresEvolutionPool; authority: AuthorityScope; scope: MemoryScope;
  /** Must inspect independently authenticated host control context, never client request fields. */
  authorizeOwner: () => EvolutionReviewActor | Promise<EvolutionReviewActor>;
  now?: () => number;
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const HASH = /^[a-f0-9]{64}$/;
function error(code: string): never { throw new EvolutionError(code); }
const hash = (value: unknown): string => typeof value === "string" && HASH.test(value) ? value : error("host_state_hash_invalid");
const id = (value: unknown): string => typeof value === "string" && ID.test(value) ? value : error("host_state_id_invalid");
const integer = (value: unknown): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : error("host_state_revision_invalid");
function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(k => !keys.includes(k) || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, k)!, "value"))) error("host_state_request_invalid");
}
function kind(value: unknown, claim = false): EvolutionHostStateKind {
  if (!EVOLUTION_HOST_STATE_KINDS.includes(value as EvolutionHostStateKind) || !claim && value === "paired_holdout") error("host_state_kind_invalid");
  return value as EvolutionHostStateKind;
}
function undoBinding(value: unknown, scopeFingerprint: string): void {
  closed(value, ["operation", "scopeFingerprint", "target", "idempotencyKey"]);
  if (value.operation !== "undo_governance" || value.scopeFingerprint !== scopeFingerprint) error("host_state_undo_approval_invalid");
  closed(value.target, ["operationReceiptId", "currentStateHash"]);
  hash(value.target.operationReceiptId); hash(value.target.currentStateHash); id(value.idempotencyKey);
}
function scopeWithin(scope: MemoryScope, authority: AuthorityScope): void {
  const resolved = resolveAuthorityScope(authority, { appId: scope.appId, projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace, visibility: scope.visibility });
  if (authorityScopeFingerprint(resolved) !== authorityScopeFingerprint(scope)) error("host_state_scope_mismatch");
}

/** Durable metadata only. This store never establishes or expands the configured host authority. */
export class PostgresEvolutionHostState implements EvolutionHostStatePort {
  readonly scope: MemoryScope;
  readonly authority: AuthorityScope;
  readonly scopeFingerprint: string;
  readonly #ownerKey: string;
  readonly #now: () => number;
  constructor(private readonly options: PostgresEvolutionHostStateOptions) {
    scopeWithin(options.scope, options.authority);
    this.scope = Object.freeze(structuredClone(options.scope));
    this.authority = structuredClone(options.authority);
    Object.values(this.authority.allow).forEach(Object.freeze); Object.freeze(this.authority.allow); Object.freeze(this.authority);
    this.scopeFingerprint = authorityScopeFingerprint(this.scope);
    this.#ownerKey = evolutionHash(["evolution-host-owner-v1", this.scope.tenantId, this.scope.userId]);
    this.#now = options.now ?? Date.now;
  }
  #value(value: unknown): EvolutionJson {
    if (!value || typeof value !== "object") error("host_state_value_invalid");
    const visit = (v: unknown, depth = 0): void => {
      if (depth > 12) error("host_state_value_invalid");
      if (v === null || typeof v === "boolean") return;
      if (typeof v === "number") { if (!Number.isFinite(v)) error("host_state_value_invalid"); return; }
      if (typeof v === "string") { if (v.length > 1024 || /[\u0000-\u001f\u007f]/.test(v)) error("host_state_value_invalid"); return; }
      if (!v || typeof v !== "object" || !Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) error("host_state_value_invalid");
      if (Object.keys(v).length > 128) error("host_state_value_invalid");
      if (!Array.isArray(v) && ("tenantId" in v || "userId" in v)) scopeWithin(v as MemoryScope, this.authority);
      for (const key of Object.keys(v)) {
        const desc = Object.getOwnPropertyDescriptor(v, key)!;
        if (!Object.hasOwn(desc, "value") || /^(?:__proto__|prototype|constructor|text|body|quote|messages|context|content|prompt|answers|cases|steps|authority|secret|token|privateKey)$/i.test(key)) error("host_state_content_forbidden");
        if (key === "scopeFingerprint" && desc.value !== this.scopeFingerprint) error("host_state_scope_mismatch");
        visit(desc.value, depth + 1);
      }
    };
    visit(value);
    if (Buffer.byteLength(JSON.stringify(value)) > EVOLUTION_HOST_STATE_MAX_VALUE_BYTES) error("host_state_value_limit");
    return structuredClone(value) as EvolutionJson;
  }
  #entry(row: Record<string, unknown>, domain = this.scopeFingerprint): EvolutionHostStateEntry {
    if (row.owner_key !== this.#ownerKey || row.scope_fingerprint !== domain) error("host_state_scope_mismatch");
    const value = this.#value(row.value), valueHash = hash(row.value_hash);
    if (evolutionHash(value) !== valueHash) error("host_state_value_hash_mismatch");
    return { kind: kind(row.kind, domain === this.#ownerKey), id: id(row.entry_id), ownerKey: this.#ownerKey, scopeFingerprint: domain,
      revision: integer(Number(row.revision)), value, valueHash, updatedAt: integer(Number(row.updated_at)),
      ...(row.expires_at == null ? {} : { expiresAt: integer(Number(row.expires_at)) }), ...(row.revoked_at == null ? {} : { revokedAt: integer(Number(row.revoked_at)) }) };
  }
  #receipt(value: unknown, domain = this.scopeFingerprint): EvolutionHostStateReceipt {
    if (!value || typeof value !== "object" || Buffer.byteLength(JSON.stringify(value)) > 8192) error("host_state_receipt_invalid");
    const receipt = value as EvolutionHostStateReceipt;
    if (receipt.ownerKey !== this.#ownerKey || receipt.scopeFingerprint !== domain || receipt.actor?.tenantId !== this.scope.tenantId || receipt.actor?.userId !== this.scope.userId) error("host_state_scope_mismatch");
    id(receipt.id); id(receipt.entryId); id(receipt.idempotencyKey); kind(receipt.kind, domain === this.#ownerKey); hash(receipt.requestHash); hash(receipt.valueHash); integer(receipt.revision); integer(receipt.createdAt);
    if (!["put", "revoke", "claim"].includes(receipt.operation) || !["local_owner", "authenticated_owner", "host_task"].includes(receipt.actor.authentication)) error("host_state_receipt_invalid");
    return structuredClone(receipt);
  }
  async read(key: EvolutionHostStateKey, signal?: AbortSignal) {
    return (await this.readMany([key], { maxRecords: 1, maxBytes: EVOLUTION_HOST_STATE_MAX_ENTRY_BYTES, signal })).entries[0];
  }
  async readMany(keys: readonly EvolutionHostStateKey[], budget: { maxRecords: number; maxBytes: number; signal?: AbortSignal }) {
    return this.#readMany(this.options.pool, keys, budget);
  }
  async readManyLocked(client: PostgresEvolutionQueryClient, keys: readonly EvolutionHostStateKey[], budget: { maxRecords: number; maxBytes: number; signal?: AbortSignal }) {
    budget.signal?.throwIfAborted();
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-host-state:${this.#ownerKey}`]);
    return this.#readMany(client, keys, budget, true);
  }
  async #readMany(client: PostgresEvolutionQueryClient, keys: readonly EvolutionHostStateKey[], budget: { maxRecords: number; maxBytes: number; signal?: AbortSignal }, lock = false) {
    budget.signal?.throwIfAborted();
    if (keys.length > 32 || integer(budget.maxRecords) < keys.length || integer(budget.maxBytes) < 1) error("host_state_read_budget");
    const selected = keys.map(key => { closed(key, ["kind", "id"]); return { kind: kind(key.kind), entry_id: id(key.id) }; });
    if (new Set(selected.map(k => JSON.stringify(k))).size !== selected.length) error("host_state_key_duplicate");
    const rows = selected.length ? (await client.query(`/* evolution:host-state-read */ SELECT s.* FROM mengshu_evolution_host_state s
JOIN jsonb_to_recordset($3::jsonb) AS requested(kind text, entry_id text) ON requested.kind=s.kind AND requested.entry_id=s.entry_id
WHERE s.owner_key=$1 AND s.scope_fingerprint=$2 LIMIT $4${lock ? " FOR UPDATE OF s" : ""}`, [this.#ownerKey, this.scopeFingerprint, JSON.stringify(selected), selected.length])).rows : [];
    budget.signal?.throwIfAborted();
    const entries = rows.map(row => this.#entry(row)).sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    if (entries.some(e => !selected.some(k => k.kind === e.kind && k.entry_id === e.id)) || new Set(entries.map(e => `${e.kind}:${e.id}`)).size !== entries.length) error("host_state_read_invalid");
    const bytesRead = rows.reduce((n, row) => n + Buffer.byteLength(JSON.stringify(row)), 0);
    if (bytesRead > budget.maxBytes) error("host_state_read_budget");
    return { entries, recordsRead: selected.length, bytesRead, revision: evolutionHash(entries) };
  }
  async list(value: EvolutionHostControlKind, signal?: AbortSignal) {
    signal?.throwIfAborted(); kind(value);
    const rows = (await this.options.pool.query(`/* evolution:host-state-list */ SELECT * FROM mengshu_evolution_host_state WHERE owner_key=$1 AND scope_fingerprint=$2 AND kind=$3 ORDER BY entry_id LIMIT 257`, [this.#ownerKey, this.scopeFingerprint, value])).rows;
    signal?.throwIfAborted();
    if (rows.length > 256 || Buffer.byteLength(JSON.stringify(rows)) > 262144) error("host_state_list_limit");
    const entries = rows.map(row => this.#entry(row));
    if (entries.some(e => e.kind !== value)) error("host_state_read_invalid");
    return { entries, revision: evolutionHash(entries) };
  }
  async getReceipt(receiptId: string) {
    const row = (await this.options.pool.query(`/* evolution:host-receipt-read */ SELECT receipt FROM mengshu_evolution_host_receipts WHERE owner_key=$1 AND scope_fingerprint=$2 AND receipt_id=$3`, [this.#ownerKey, this.scopeFingerprint, id(receiptId)])).rows[0];
    return row ? this.#receipt(row.receipt) : undefined;
  }
  async put(request: EvolutionHostStateMutation, signal?: AbortSignal) {
    closed(request, ["kind", "id", "expectedRevision", "idempotencyKey", "value", "expiresAt", "operation"]);
    kind(request.kind); id(request.id); id(request.idempotencyKey); integer(request.expectedRevision);
    if (request.operation !== undefined && !["put", "revoke"].includes(request.operation)) error("host_state_request_invalid");
    const value = this.#value(request.value);
    if (request.kind === "governance_undo") {
      undoBinding(value, this.scopeFingerprint);
      const now = integer(this.#now());
      if (request.expiresAt === undefined || integer(request.expiresAt) <= now || request.expiresAt - now > 86_400_000) error("host_state_undo_approval_expiry_invalid");
    }
    const actor = structuredClone(await this.options.authorizeOwner());
    if (actor.tenantId !== this.scope.tenantId || actor.userId !== this.scope.userId || !["local_owner", "authenticated_owner"].includes(actor.authentication)) error("host_state_owner_required");
    id(actor.actorId);
    return (await this.#mutate({ ...request, value, operation: request.operation ?? "put" }, actor, this.scopeFingerprint, signal)).receipt;
  }
  async #mutate(request: Omit<EvolutionHostStateMutation, "kind" | "operation"> & { kind: EvolutionHostStateKind; operation: "put" | "revoke" | "claim" }, actor: EvolutionHostStateReceipt["actor"], domain: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const requestHash = evolutionHash({ contract: "evolution-host-state-v1", ownerKey: this.#ownerKey, scopeFingerprint: domain, request, actor });
    try {
      return await transaction(this.options.pool, async client => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-host-state:${this.#ownerKey}`]);
        const previousReceipt = (await client.query(`/* evolution:host-receipt-key */ SELECT receipt,request_hash FROM mengshu_evolution_host_receipts WHERE owner_key=$1 AND scope_fingerprint=$2 AND kind=$3 AND idempotency_key=$4`, [this.#ownerKey, domain, request.kind, request.idempotencyKey])).rows[0];
        if (previousReceipt) {
          if (previousReceipt.request_hash !== requestHash) throw new PostgresEvolutionError("host_state_idempotency_conflict");
          return { receipt: this.#receipt(previousReceipt.receipt, domain), created: false };
        }
        const prior = (await client.query(`/* evolution:host-state-lock */ SELECT * FROM mengshu_evolution_host_state WHERE owner_key=$1 AND scope_fingerprint=$2 AND kind=$3 AND entry_id=$4 FOR UPDATE`, [this.#ownerKey, domain, request.kind, request.id])).rows[0];
        const old = prior && this.#entry(prior, domain);
        if ((old?.revision ?? 0) !== request.expectedRevision) throw new PostgresEvolutionError("host_state_cas_conflict");
        const quota = (await client.query(`/* evolution:host-state-quota */ SELECT
(SELECT count(*) FROM mengshu_evolution_host_state WHERE owner_key=$1 AND scope_fingerprint=$2 AND kind=$3) AS entries,
(SELECT count(*) FROM mengshu_evolution_host_receipts WHERE owner_key=$1 AND scope_fingerprint=$2) AS receipts`, [this.#ownerKey, domain, request.kind])).rows[0];
        if (!quota || !old && Number(quota.entries) >= (request.kind === "paired_holdout" ? 4096 : 256) || Number(quota.receipts) >= 4096) throw new PostgresEvolutionError("host_state_capacity");
        const now = integer(this.#now());
        if (request.expiresAt !== undefined && (integer(request.expiresAt) <= now || request.expiresAt - now > 31_536_000_000)) throw new PostgresEvolutionError("host_state_expiry_invalid");
        const valueHash = evolutionHash(request.value), revision = integer(request.expectedRevision + 1);
        const receipt: EvolutionHostStateReceipt = { id: evolutionHash(["host-state-receipt-v1", requestHash]), ownerKey: this.#ownerKey, scopeFingerprint: domain, kind: request.kind, entryId: request.id, operation: request.operation, requestHash, idempotencyKey: request.idempotencyKey, revision, valueHash, createdAt: now, actor };
        const saved = await client.query(`/* evolution:host-state-save */ INSERT INTO mengshu_evolution_host_state
(owner_key,scope_fingerprint,kind,entry_id,revision,value,value_hash,updated_at,expires_at,revoked_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
ON CONFLICT(owner_key,scope_fingerprint,kind,entry_id) DO UPDATE SET revision=EXCLUDED.revision,value=EXCLUDED.value,value_hash=EXCLUDED.value_hash,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at,revoked_at=EXCLUDED.revoked_at
WHERE mengshu_evolution_host_state.revision=$11 RETURNING revision`, [this.#ownerKey, domain, request.kind, request.id, revision, JSON.stringify(request.value), valueHash, now, request.expiresAt ?? null, request.operation === "revoke" ? now : null, request.expectedRevision]);
        if (saved.rows.length !== 1 || Number(saved.rows[0]?.revision) !== revision) throw new PostgresEvolutionError("host_state_cas_conflict");
        await client.query(`/* evolution:host-receipt-save */ INSERT INTO mengshu_evolution_host_receipts
(owner_key,scope_fingerprint,kind,idempotency_key,request_hash,receipt_id,receipt,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`, [this.#ownerKey, domain, request.kind, request.idempotencyKey, requestHash, receipt.id, JSON.stringify(receipt), now]);
        signal?.throwIfAborted();
        return { receipt, created: true };
      });
    } catch (caught) {
      if (signal?.aborted) error("cancelled");
      if (caught instanceof EvolutionError) throw caught;
      if (caught instanceof PostgresEvolutionError && /^host_state_[a-z_]+$/.test(caught.code)) error(caught.code);
      error("host_state_transaction_failed");
    }
  }
  async claimHoldout(input: { planHash: string; holdoutRef: string; holdoutHash: string; sourceScope: MemoryScope; signal?: AbortSignal }): Promise<boolean> {
    if (authorityScopeFingerprint(input.sourceScope) !== this.scopeFingerprint) error("host_state_scope_mismatch");
    hash(input.planHash); hash(input.holdoutHash); id(input.holdoutRef);
    // Owner-global by cohort hash: renaming a holdout or changing app cannot make it fresh again.
    const key = evolutionHash(["evolution-heldout-v1", input.holdoutHash]);
    const value = { planHash: input.planHash, holdoutHash: input.holdoutHash, holdoutRef: input.holdoutRef, sourceScopeFingerprint: this.scopeFingerprint };
    try {
      const result = await this.#mutate({ kind: "paired_holdout", id: key, expectedRevision: 0, idempotencyKey: key, value, operation: "claim" }, { actorId: "host:paired_evaluator", authentication: "host_task", tenantId: this.scope.tenantId, userId: this.scope.userId }, this.#ownerKey, input.signal);
      return result.created;
    } catch (caught) {
      if (caught instanceof EvolutionError && ["host_state_cas_conflict", "host_state_idempotency_conflict"].includes(caught.code)) return false;
      throw caught;
    }
  }
  readonly administrativeReviewGuard: PostgresEvolutionAdministrativeReviewGuard = async (client, request) => {
    const undo = request.operation === "undo_governance";
    if ((!undo && request.operation !== "source_revoke") || request.scopeFingerprint !== this.scopeFingerprint || (!undo && !("sourceId" in request.target))) error("host_state_administrative_review_mismatch");
    const { reviewReceiptId: _reviewReceiptId, bindingHash, ...binding } = request;
    if (undo) {
      try {
        closed(request, ["operation", "scopeFingerprint", "target", "idempotencyKey", "reviewReceiptId", "bindingHash"]);
        undoBinding(binding, this.scopeFingerprint); hash(bindingHash);
      } catch { error("host_state_administrative_review_mismatch"); }
      if (evolutionHash(binding) !== bindingHash) error("host_state_administrative_review_mismatch");
    }
    const row = (await client.query(`/* evolution:host-administrative-lock */ SELECT receipt,consumed_by FROM mengshu_evolution_host_receipts WHERE owner_key=$1 AND scope_fingerprint=$2 AND receipt_id=$3 FOR UPDATE`, [this.#ownerKey, this.scopeFingerprint, id(request.reviewReceiptId)])).rows[0];
    if (!row) error("host_state_administrative_review_missing");
    const receipt = this.#receipt(row.receipt);
    if (receipt.kind !== (undo ? "governance_undo" : "source_revocation") || receipt.operation !== "put" || receipt.actor.authentication === "host_task") error("host_state_administrative_review_mismatch");
    const current = (await client.query(`/* evolution:host-state-lock */ SELECT * FROM mengshu_evolution_host_state WHERE owner_key=$1 AND scope_fingerprint=$2 AND kind=$3 AND entry_id=$4 FOR UPDATE`, [this.#ownerKey, this.scopeFingerprint, receipt.kind, receipt.entryId])).rows[0];
    const state = current && this.#entry(current);
    if (!state || state.revision !== receipt.revision || state.valueHash !== receipt.valueHash || state.revokedAt !== undefined || state.expiresAt === undefined || state.expiresAt <= this.#now() || evolutionHash(state.value) !== evolutionHash(binding) || evolutionHash(binding) !== bindingHash || row.consumed_by != null && row.consumed_by !== bindingHash) error("host_state_administrative_review_mismatch");
    if (undo && (receipt.createdAt > this.#now() || state.expiresAt - receipt.createdAt > 86_400_000)) error("host_state_administrative_review_mismatch");
    const consumed = await client.query(`/* evolution:host-administrative-consume */ UPDATE mengshu_evolution_host_receipts SET consumed_by=$4,consumed_at=$5 WHERE owner_key=$1 AND scope_fingerprint=$2 AND receipt_id=$3 AND (consumed_by IS NULL OR consumed_by=$4) RETURNING receipt_id`, [this.#ownerKey, this.scopeFingerprint, receipt.id, bindingHash, this.#now()]);
    if (consumed.rows.length !== 1) error("host_state_administrative_review_mismatch");
  };
}

export function createPostgresEvolutionHostState(options: PostgresEvolutionHostStateOptions): EvolutionHostStatePort {
  return new PostgresEvolutionHostState(options);
}
