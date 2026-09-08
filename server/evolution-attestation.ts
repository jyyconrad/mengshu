import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { EvolutionError } from "../packages/core/src/evolution/schema.js";
import { DB_NOW_MS, type PostgresEvolutionQueryClient } from "../packages/core/src/evolution/postgres-common.js";
import type { EvolutionApplyContext, EvolutionEvidence, EvolutionEvidenceAttestation, EvolutionEvidenceAttestationPort, EvolutionInputContext, EvolutionJson, EvolutionStagedEvidence } from "../packages/core/src/evolution/types.js";
import { computeCanonicalContentHash } from "../packages/core/src/scoring/hash-utils.js";
import { EVOLUTION_HOST_STATE_MAX_ENTRY_BYTES, type EvolutionHostStateEntry, type EvolutionHostStateKey, type EvolutionHostStatePort, type EvolutionHostStateReceipt } from "./evolution-host-state.js";

export interface EvolutionAttestationStatement extends Omit<EvolutionEvidenceAttestation, "id" | "verifiedAt"> {
  origin: "external";
  issuedAt: number;
}
export interface EvolutionSignedAttestation { statement: EvolutionAttestationStatement; signature: string }
export interface EvolutionAttestationControl {
  issue(request: EvolutionSignedAttestation & { expectedRevision: number; idempotencyKey: string }, signal?: AbortSignal): Promise<EvolutionHostStateReceipt>;
  /** A distinct owner-only administrative receipt; it never attests an historical author. */
  revokeSource(request: { sourceId: string; sourceRevision: string; expectedRevision: number; idempotencyKey: string; operationIdempotencyKey: string; expiresAt: number }, signal?: AbortSignal): Promise<EvolutionHostStateReceipt>;
}
export interface EvolutionAttestationService {
  readonly port: EvolutionEvidenceAttestationPort;
  readonly control: EvolutionAttestationControl;
  transactionBudget(attestations: readonly EvolutionEvidenceAttestation[]): { records: number; bytes: number };
  transactionBudgetForEvidence(evidence: readonly EvolutionStagedEvidence[]): { records: number; bytes: number };
  assertApplyInTransaction(client: PostgresEvolutionQueryClient, apply: EvolutionApplyContext, context: EvolutionInputContext): Promise<{ recordsRead: number; bytesRead: number }>;
  /** Caller owns transaction/commit. No pool access, connect, BEGIN, saveBatch, or nested transaction. */
  assertInTransaction(client: PostgresEvolutionQueryClient, attestations: readonly EvolutionEvidenceAttestation[], context: EvolutionInputContext): Promise<{ recordsRead: number; bytesRead: number }>;
}
export interface EvolutionAttestationOptions {
  state: EvolutionHostStatePort;
  /** Trusted issuer keys come only from host configuration, not source metadata or request fields. */
  trustedIssuers: readonly { id: string; publicKeyPem: string }[];
  now?: () => number;
}
const closed = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const statementSchema = Type.Object({ issuer: id, scopeFingerprint: hash, evidenceId: id, sourceId: id, revision: id,
  snapshotHash: hash, rootEvidenceId: id, origin: Type.Literal("external"),
  trust: Type.Union([Type.Literal("user_statement"), Type.Literal("verified_document"), Type.Literal("verified_result")]),
  authorId: Type.Optional(id), occurredAt: Type.Optional(time),
  authorizedTargetRefs: Type.Array(Type.Object({ memoryId: id, expectedRevision: time, beforeHash: hash }, closed), { maxItems: 8 }),
  issuedAt: time, expiresAt: time,
}, closed);
const signedSchema = Type.Object({ statement: statementSchema, signature: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$" }) }, closed);
const issueSchema = Type.Object({ ...signedSchema.properties, expectedRevision: time, idempotencyKey: id }, closed);
const revokeSchema = Type.Object({ sourceId: id, sourceRevision: id, expectedRevision: time, idempotencyKey: id, operationIdempotencyKey: id, expiresAt: time }, closed);
function fail(code: string): never { throw new EvolutionError(code); }
function plain(value: unknown, depth = 0): void {
  if (depth > 12) fail("attestation_schema_invalid");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object" || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("attestation_schema_invalid");
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (["__proto__", "constructor", "prototype"].includes(key) || !Object.hasOwn(descriptor, "value")) fail("attestation_schema_invalid");
    plain(descriptor.value, depth + 1);
  }
}
function checked<T>(value: unknown, schema: TSchema): T {
  plain(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 8192 || !Value.Check(schema, value)) fail("attestation_schema_invalid");
  return structuredClone(value) as T;
}
export function evolutionAttestationSigningPayload(value: EvolutionAttestationStatement): Buffer {
  const statement = checked<EvolutionAttestationStatement>(value, statementSchema);
  return Buffer.from(`mengshu.evolution-source-attestation/v1\n${evolutionHash(statement)}`, "utf8");
}
export function evolutionSourceAttestationKey(evidence: Pick<EvolutionEvidence, "sourceId" | "id">): EvolutionHostStateKey {
  return { kind: "source_attestation", id: evolutionHash(["evolution-source-proof-v1", evidence.sourceId, evidence.id]) };
}
export function evolutionSourceRevocationKey(sourceId: string): EvolutionHostStateKey {
  return { kind: "source_revocation", id: evolutionHash(["evolution-source-revocation-v1", sourceId]) };
}

class HostEvolutionAttestation implements EvolutionAttestationService {
  readonly #issuers = new Map<string, KeyObject>();
  readonly #now: () => number;
  constructor(private readonly options: EvolutionAttestationOptions) {
    if (options.trustedIssuers.length > 32) fail("attestation_issuer_invalid");
    for (const issuer of options.trustedIssuers) {
      if (!Value.Check(id, issuer.id) || this.#issuers.has(issuer.id) || issuer.publicKeyPem.length > 4096) fail("attestation_issuer_invalid");
      try {
        const key = createPublicKey(issuer.publicKeyPem);
        if (key.asymmetricKeyType !== "ed25519") fail("attestation_issuer_invalid");
        this.#issuers.set(issuer.id, key);
      } catch { fail("attestation_issuer_invalid"); }
    }
    this.#now = options.now ?? Date.now;
  }
  #scope(context: EvolutionInputContext) {
    if (authorityScopeFingerprint(context.scope) !== this.options.state.scopeFingerprint) fail("attestation_scope_mismatch");
    context.signal?.throwIfAborted();
  }
  #signature(value: unknown, now: number): EvolutionSignedAttestation {
    const signed = checked<EvolutionSignedAttestation>(value, signedSchema), s = signed.statement;
    const key = this.#issuers.get(s.issuer);
    if (!key) fail("attestation_verifier_unavailable");
    if (s.scopeFingerprint !== this.options.state.scopeFingerprint) fail("attestation_scope_mismatch");
    if (s.issuedAt > now || s.expiresAt <= now || s.expiresAt <= s.issuedAt || s.expiresAt - s.issuedAt > 31_536_000_000) fail("attestation_expired");
    if (s.trust === "user_statement" && !s.authorId) fail("attestation_author_required");
    if (new Set(s.authorizedTargetRefs.map(t => t.memoryId)).size !== s.authorizedTargetRefs.length) fail("attestation_target_mismatch");
    const signature = Buffer.from(signed.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== signed.signature || !verifySignature(null, evolutionAttestationSigningPayload(s), key, signature)) fail("attestation_signature_invalid");
    return signed;
  }
  #keys(evidence: readonly { id: string; sourceId: string }[]): EvolutionHostStateKey[] {
    const keys = evidence.flatMap(e => [evolutionSourceAttestationKey(e), evolutionSourceRevocationKey(e.sourceId)]);
    return [...new Map(keys.map(k => [`${k.kind}:${k.id}`, k])).values()];
  }
  #proof(entries: readonly EvolutionHostStateEntry[], evidenceId: string, sourceId: string, now: number): EvolutionEvidenceAttestation | undefined {
    const key = evolutionSourceAttestationKey({ id: evidenceId, sourceId });
    const entry = entries.find(e => e.kind === key.kind && e.id === key.id);
    if (!entry || entry.revokedAt !== undefined || entry.expiresAt === undefined || entry.expiresAt <= now || entry.updatedAt > now || entry.scopeFingerprint !== this.options.state.scopeFingerprint) return undefined;
    const revokedKey = evolutionSourceRevocationKey(sourceId);
    // Expiration of an administrative permission does not restore a revoked source's trust.
    if (entries.some(e => e.kind === revokedKey.kind && e.id === revokedKey.id)) return undefined;
    const signed = this.#signature(entry.value, now), s = signed.statement;
    if (s.evidenceId !== evidenceId || s.sourceId !== sourceId || entry.expiresAt > s.expiresAt || entry.updatedAt < s.issuedAt || entry.valueHash !== evolutionHash(signed)) fail("attestation_state_invalid");
    const { origin: _origin, issuedAt: _issuedAt, ...claim } = s;
    return { ...claim, id: evolutionHash(["host-attestation-proof-v1", key.id, entry.revision, entry.valueHash]), verifiedAt: entry.updatedAt, expiresAt: Math.min(entry.expiresAt, s.expiresAt) };
  }
  async #stable(keys: EvolutionHostStateKey[], context: EvolutionInputContext) {
    if (!keys.length) return { entries: [], recordsRead: 0, bytesRead: 0 };
    if (context.limits.maxRecords < keys.length * 2) fail("attestation_budget_exceeded");
    const first = await this.options.state.readMany(keys, { maxRecords: context.limits.maxRecords, maxBytes: context.limits.maxBytes, signal: context.signal });
    const second = await this.options.state.readMany(keys, { maxRecords: context.limits.maxRecords - first.recordsRead, maxBytes: context.limits.maxBytes - first.bytesRead, signal: context.signal });
    if (first.revision !== second.revision) fail("attestation_state_changed");
    return { entries: second.entries, recordsRead: first.recordsRead + second.recordsRead, bytesRead: first.bytesRead + second.bytesRead };
  }
  readonly control: EvolutionAttestationControl = {
    issue: async (value, signal) => {
      signal?.throwIfAborted();
      const request = checked<EvolutionSignedAttestation & { expectedRevision: number; idempotencyKey: string }>(value, issueSchema);
      const signed = this.#signature({ statement: request.statement, signature: request.signature }, this.#now());
      const key = evolutionSourceAttestationKey({ id: signed.statement.evidenceId, sourceId: signed.statement.sourceId });
      return this.options.state.put({ ...key, value: signed as unknown as EvolutionJson, expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey, expiresAt: signed.statement.expiresAt }, signal);
    },
    revokeSource: async (value, signal) => {
      signal?.throwIfAborted();
      const request = checked<Parameters<EvolutionAttestationControl["revokeSource"]>[0]>(value, revokeSchema);
      const binding = { operation: "source_revoke", scopeFingerprint: this.options.state.scopeFingerprint, target: { sourceId: request.sourceId, revision: request.sourceRevision }, idempotencyKey: request.operationIdempotencyKey };
      return this.options.state.put({ ...evolutionSourceRevocationKey(request.sourceId), value: binding, expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey, expiresAt: request.expiresAt }, signal);
    },
  };
  readonly port: EvolutionEvidenceAttestationPort = {
    attest: async context => {
      this.#scope(context);
      const unit = context.unit;
      if (unit.evidence.length > 8 || unit.targets.length > 8 || new Set(unit.evidence.map(e => e.id)).size !== unit.evidence.length || [unit.scope, ...unit.evidence.map(e => e.scope), ...unit.targets.map(t => t.scope)].some(s => authorityScopeFingerprint(s) !== this.options.state.scopeFingerprint)) fail("attestation_input_invalid");
      const selected = unit.evidence.filter(e => e.origin === "external" && !e.revoked);
      if (selected.length && !this.#issuers.size) fail("attestation_verifier_unavailable");
      const keys = this.#keys(selected);
      const read = await this.#stable(keys, context);
      const attestations = selected.flatMap(e => {
        const proof = this.#proof(read.entries, e.id, e.sourceId, this.#now());
        if (!proof) return [];
        if (proof.revision !== e.revision || proof.snapshotHash !== e.snapshotHash || proof.snapshotHash !== computeCanonicalContentHash(e.text) || proof.rootEvidenceId !== e.rootEvidenceId) return [];
        if (proof.authorizedTargetRefs.some(ref => !unit.targets.some(t => t.memoryId === ref.memoryId && t.expectedRevision === ref.expectedRevision && t.beforeHash === ref.beforeHash && computeCanonicalContentHash(t.text) === ref.beforeHash))) fail("attestation_target_mismatch");
        return [proof];
      });
      return { attestations, recordsRead: read.recordsRead, bytesRead: read.bytesRead, verificationBudget: { records: keys.length * 2, bytes: keys.length * 2 * EVOLUTION_HOST_STATE_MAX_ENTRY_BYTES } };
    },
    verify: async (attestations, context) => {
      this.#scope(context);
      if (attestations.length > 8 || new Set(attestations.map(a => a.evidenceId)).size !== attestations.length) fail("attestation_input_invalid");
      const keys = this.#keys(attestations.map(a => ({ id: a.evidenceId, sourceId: a.sourceId })));
      const read = await this.#stable(keys, context);
      const valid = attestations.every(a => { const proof = this.#proof(read.entries, a.evidenceId, a.sourceId, this.#now()); return proof !== undefined && evolutionHash(proof) === evolutionHash(a); });
      return { valid, ...(valid ? {} : { reason: "attestation_revoked_or_changed" }), recordsRead: read.recordsRead, bytesRead: read.bytesRead };
    },
  };
  transactionBudget(attestations: readonly EvolutionEvidenceAttestation[]) {
    if (attestations.length > 8) fail("attestation_input_invalid");
    const count = this.#keys(attestations.map(a => ({ id: a.evidenceId, sourceId: a.sourceId }))).length;
    return { records: count ? count + 1 : 0, bytes: count ? count * EVOLUTION_HOST_STATE_MAX_ENTRY_BYTES + 64 : 0 };
  }
  #applyProofs(evidence: readonly EvolutionStagedEvidence[]): EvolutionEvidenceAttestation[] {
    if (evidence.length > 8) fail("attestation_input_invalid");
    const proofs = evidence.flatMap(e => {
      if (authorityScopeFingerprint(e.scope) !== this.options.state.scopeFingerprint) fail("attestation_scope_mismatch");
      const proof = e.hostAttestation;
      if (!proof) {
        if (e.origin === "external" && e.trust !== "untrusted") fail("attestation_required");
        return [];
      }
      if (e.origin !== "external" || e.revoked || proof.evidenceId !== e.id || proof.sourceId !== e.sourceId || proof.revision !== e.revision || proof.snapshotHash !== e.snapshotHash || proof.rootEvidenceId !== e.rootEvidenceId || proof.trust !== e.trust || evolutionHash([...(e.authorizedTargetIds ?? [])].sort()) !== evolutionHash(proof.authorizedTargetRefs.map(t => t.memoryId).sort())) fail("attestation_apply_binding_mismatch");
      return [proof];
    });
    const unique = new Map<string, EvolutionEvidenceAttestation>();
    for (const proof of proofs) {
      const old = unique.get(proof.id);
      if (old && evolutionHash(old) !== evolutionHash(proof)) fail("attestation_apply_binding_mismatch");
      unique.set(proof.id, proof);
    }
    return [...unique.values()];
  }
  transactionBudgetForEvidence(evidence: readonly EvolutionStagedEvidence[]) {
    return this.transactionBudget(this.#applyProofs(evidence));
  }
  async assertApplyInTransaction(client: PostgresEvolutionQueryClient, apply: EvolutionApplyContext, context: EvolutionInputContext) {
    if (apply.proposal.scopeFingerprint !== this.options.state.scopeFingerprint || authorityScopeFingerprint(apply.proposal.scope) !== this.options.state.scopeFingerprint) fail("attestation_scope_mismatch");
    return this.assertInTransaction(client, this.#applyProofs(apply.evidence), context);
  }
  async assertInTransaction(client: PostgresEvolutionQueryClient, attestations: readonly EvolutionEvidenceAttestation[], context: EvolutionInputContext) {
    this.#scope(context);
    const cost = this.transactionBudget(attestations);
    if (cost.records > context.limits.maxRecords || cost.bytes > context.limits.maxBytes) fail("attestation_budget_exceeded");
    if (!attestations.length) return { recordsRead: 0, bytesRead: 0 };
    const keys = this.#keys(attestations.map(a => ({ id: a.evidenceId, sourceId: a.sourceId })));
    const read = await this.options.state.readManyLocked(client, keys, { maxRecords: context.limits.maxRecords - 1, maxBytes: context.limits.maxBytes - 64, signal: context.signal });
    const clock = (await client.query(`/* evolution:attestation-clock */ SELECT ${DB_NOW_MS} AS now`)).rows[0];
    const now = Number(clock?.now);
    if (!Number.isSafeInteger(now) || now < 0) fail("attestation_clock_invalid");
    for (const provided of attestations) {
      const proof = this.#proof(read.entries, provided.evidenceId, provided.sourceId, now);
      if (!proof || evolutionHash(proof) !== evolutionHash(provided)) fail("attestation_revoked_or_changed");
    }
    context.signal?.throwIfAborted();
    return { recordsRead: read.recordsRead + 1, bytesRead: read.bytesRead + Buffer.byteLength(JSON.stringify(clock)) };
  }
}

export function createEvolutionAttestation(options: EvolutionAttestationOptions): EvolutionAttestationService {
  return new HostEvolutionAttestation(options);
}
