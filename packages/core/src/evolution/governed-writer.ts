import { resolveAuthorityScope } from "../domain/authority-scope.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { MemoryWriteKernel, type MemoryWriteCommand, type MemoryWriteKernelDependencies, type WriteMemoryRecord } from "../service/write-kernel.js";
import type { NormalizedMemoryWriteReceipt } from "../service/write-kernel-transaction.js";
import { isProviderOwnedMemoryWriteKernelTransactionWithHooks, type PostgresMemoryWriteKernelTransactionHooks, type ProviderOwnedMemoryWriteKernelTransactionPort } from "../service/write-kernel-postgres-transaction.js";
import { PostgresEvolutionRepository, EVOLUTION_CANDIDATE_SCOPE_SQL, proposalRequestHash, validateStagedEvidence } from "./postgres-repository.js";
import { boundedJson, fail, integer, jsonHash, lockLease, POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL, PostgresEvolutionError, scopedFingerprint, scopeParams, transaction, type PostgresEvolutionQueryClient } from "./postgres-common.js";
import { decodeEvolutionOriginalEvidence, decodeEvolutionTarget, EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_ROW_BOUNDS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "./postgres-inventory.js";
import { validateEvolutionProposal, validateEvolutionApprovedProposal } from "./proposal-validation.js";
import type { EvolutionApplyContext, EvolutionApplyReceipt, EvolutionApplyResult, EvolutionEvidence, EvolutionGovernedWriter, EvolutionInputUnit, EvolutionOperation, EvolutionStagedEvidence, EvolutionTarget, EvolutionValidation } from "./types.js";
import { applyEvolutionMetadata, EVOLUTION_METADATA_OPERATIONS, lockEvolutionMetadataHeads } from "./governed-metadata.js";
import { PostgresTemporalMemoryRepository } from "../temporal/postgres-repository.js";
import { EvolutionError } from "./schema.js";
import { EvolutionApplyDiagnostics, type EvolutionApplyDiagnosticObserver } from "./governed-diagnostics.js";

export interface PostgresEvolutionVerifiedInput {
  context: EvolutionApplyContext;
  evidence: readonly EvolutionEvidence[];
  targets: readonly EvolutionTarget[];
  validation: EvolutionValidation;
  /** Exact approved claim support, at most one span per independent root. */
  supportedEvidence: readonly EvolutionStagedEvidence[];
  canonicalEvidenceIds: readonly string[];
}
export interface PostgresEvolutionEvidenceBinding {
  sourceEvidenceId: string;
  evidenceMemoryId: string;
}
/** The writer installs transaction itself; a callback cannot silently omit the proposal hooks. */
export type PostgresEvolutionKernelFactory = (
  hooks: PostgresMemoryWriteKernelTransactionHooks,
  verified: PostgresEvolutionVerifiedInput,
) => {
  dependencies: Omit<MemoryWriteKernelDependencies, "transaction">;
  transactionPort: ProviderOwnedMemoryWriteKernelTransactionPort;
};
export interface PostgresEvolutionGovernedWriterOptions {
  repository: PostgresEvolutionRepository;
  createKernel?: PostgresEvolutionKernelFactory;
  /** Re-read original documents/events. Quotes alone must never satisfy this port. */
  hydrateEvidence?: (context: EvolutionApplyContext) => Promise<readonly EvolutionEvidence[]>;
  /** Import only selected spans through Write Kernel, without effective canonical links. */
  materializeEvidence?: (input: Omit<PostgresEvolutionVerifiedInput, "canonicalEvidenceIds">) => Promise<readonly PostgresEvolutionEvidenceBinding[]>;
  /** Host-only. Lock/revalidate attestation and revocation on this client, never a nested transaction. */
  assertApplyInTransaction?: (client: PostgresEvolutionQueryClient, context: EvolutionApplyContext) => Promise<void>;
  /** Host-only bounded failure observer. No payloads; never forwarded to receipts or public results. */
  onDiagnostic?: EvolutionApplyDiagnosticObserver;
  now?: () => number;
}

export class PostgresEvolutionGovernedWriter implements EvolutionGovernedWriter {
  readonly supportedOperations: readonly EvolutionOperation[];
  readonly #repository: PostgresEvolutionRepository;
  readonly #now: () => number;
  constructor(private readonly options: PostgresEvolutionGovernedWriterOptions) {
    this.#repository = options.repository;
    this.#now = options.now ?? Date.now;
    this.supportedOperations = Object.freeze(["noop", ...(options.hydrateEvidence ? EVOLUTION_METADATA_OPERATIONS : []),
      ...(options.createKernel && options.hydrateEvidence ? ["create", "evolve", "correct"] as const : [])]);
  }
  #assertContext(context: EvolutionApplyContext): void {
    const { proposal: p } = context;
    this.#repository.assertScope(p.scopeFingerprint, p.scope);
    const authorized = resolveAuthorityScope(context.authority, {
      appId: p.scope.appId, projectId: p.scope.projectId, agentId: p.scope.agentId,
      namespace: p.scope.namespace, visibility: p.scope.visibility ?? "private",
    });
    if (scopedFingerprint(authorized) !== p.scopeFingerprint) fail("scope_mismatch");
    if (context.signal?.aborted) fail("cancelled");
    validateStagedEvidence(p, context.evidence);
  }
  async #receipt(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext): Promise<EvolutionApplyReceipt | undefined> {
    const p = context.proposal;
    const result = await client.query(
      `/* evolution:receipt-lock */ SELECT request_hash, receipt FROM mengshu_evolution_apply_receipts
WHERE scope_fingerprint = $1 AND proposal_id = $2`, [p.scopeFingerprint, p.id],
    );
    if (!result.rows[0]) return undefined;
    if (result.rows[0].request_hash !== proposalRequestHash(p, context.evidence)) fail("idempotency_conflict");
    const receipt = boundedJson(result.rows[0].receipt) as EvolutionApplyReceipt;
    if (receipt.scopeFingerprint !== p.scopeFingerprint || receipt.proposalId !== p.id || receipt.batchId !== p.batchId || receipt.operation !== p.operation || !["applied", "noop"].includes(receipt.outcome)) fail("invalid_receipt");
    return receipt;
  }
  async #targets(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext, lock: boolean): Promise<{ targets: EvolutionTarget[]; rows: Record<string, unknown>[] }> {
    const refs = context.proposal.targetRefs;
    if (refs.length === 0) return { targets: [], rows: [] };
    if (refs.length > 8 || refs.length !== 1 && context.proposal.operation !== "merge_equivalent" || new Set(refs.map(ref => ref.memoryId)).size !== refs.length) fail("multi_target_transaction_unavailable");
    const result = await client.query(
      `/* evolution:${lock ? "target-lock" : "target-read"} */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND ${EVOLUTION_MEMORY_ROW_BOUNDS_SQL} AND ${refs.length === 1 ? "id = $10::uuid" : "id = ANY($10::uuid[])"} ORDER BY id${lock ? " FOR UPDATE" : ""}`,
      [...scopeParams(this.#repository.scope), refs.length === 1 ? refs[0]!.memoryId : refs.map(ref => ref.memoryId).sort()],
    );
    if (result.rows.length !== refs.length) fail("target_tombstoned_or_missing");
    const rows = refs.map(ref => result.rows.find(row => row.id === ref.memoryId)!);
    const targets = rows.map((r) => decodeEvolutionTarget(r, this.#repository.scope));
    for (const t of targets) {
      const ref = refs.find((r) => r.memoryId === t.memoryId);
      if (!ref || ref.beforeHash !== t.beforeHash || ref.expectedRevision !== t.expectedRevision) fail("target_cas_conflict");
      if (t.tombstoned || t.validTo !== undefined) fail("target_tombstoned");
      if ((t.pinned || t.highImpact) && !context.approval) fail("owner_review_required");
    }
    return { targets, rows };
  }
  #validateHydration(context: EvolutionApplyContext, sources: readonly EvolutionEvidence[]): EvolutionEvidence[] {
    if (sources.length === 0 && context.evidence.length > 0 || sources.length > 32 || new Set(sources.map((s) => s.id)).size !== sources.length) fail("source_hydration_invalid");
    const hydrated = boundedJson(sources, 1048576);
    for (const span of context.evidence) {
      const source = hydrated.find((s) => s.id === span.id);
      if (!source || scopedFingerprint(source.scope) !== context.proposal.scopeFingerprint || source.snapshotHash !== span.snapshotHash || computeCanonicalContentHash(source.text) !== span.snapshotHash || source.revision !== span.revision || source.sourceId !== span.sourceId || source.rootEvidenceId !== span.rootEvidenceId || source.origin !== span.origin || source.trust !== span.trust || source.revoked || source.contextIncomplete === true !== (span.contextIncomplete === true) || source.occurredAt !== span.occurredAt || jsonHash(source.authorizedTargetIds ?? []) !== jsonHash(span.authorizedTargetIds ?? []) || source.text.slice(span.start, span.end) !== span.quote) fail("source_hydration_mismatch");
      if (source.locator !== span.locator || jsonHash(source.hostAttestation ?? null) !== jsonHash(span.hostAttestation ?? null)) fail("source_hydration_mismatch");
    }
    return [...hydrated];
  }
  #validate(context: EvolutionApplyContext, targets: EvolutionTarget[], evidence: EvolutionEvidence[]): EvolutionValidation {
    const unit: EvolutionInputUnit = { id: context.proposal.inputUnitId, scope: context.proposal.scope, snapshotHash: context.proposal.sourceSnapshotHash, targets, evidence };
    const validation = context.approval
      ? validateEvolutionApprovedProposal(context.proposal, unit, context.proposal.scope, context.approval, this.#now())
      : validateEvolutionProposal(context.proposal, unit, context.proposal.scope);
    if (validation.outcome === "review") fail("owner_review_required");
    if (validation.outcome !== "allowed" && validation.outcome !== "noop") fail(validation.reasons[0] ?? "validation_rejected");
    return validation;
  }
  #support(context: EvolutionApplyContext, targets: EvolutionTarget[], validation: EvolutionValidation): EvolutionStagedEvidence[] {
    const exactText = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
    const metadataOnly = ["mark_disputed", "expire", "deprecate", "revalidate"].includes(context.proposal.operation);
    const text = exactText(context.proposal.proposedText ?? targets[0]?.text ?? "");
    if (!metadataOnly && (!text || context.evidence.some((e) => exactText(e.quote) !== text))) fail("owner_review_required");
    const recognizedRoots = new Set([...validation.independentEvidenceRootIds, ...targets.flatMap((t) => t.evidenceRootIds)]);
    const roots = new Set<string>();
    return context.evidence.filter((e) => {
      const reference = (validation.evidenceMode === "reviewed_reference" || metadataOnly) && context.approval !== undefined;
      if (e.origin === "evaluation" || e.revoked || roots.has(e.rootEvidenceId) ||
        !reference && (e.origin !== "external" || e.trust === "untrusted" || !recognizedRoots.has(e.rootEvidenceId))) return false;
      roots.add(e.rootEvidenceId);
      return true;
    });
  }
  async #guard(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext, diagnostic: EvolutionApplyDiagnostics): Promise<void> {
    diagnostic.phase = "proposal_guard";
    this.#assertContext(context);
    const p = context.proposal;
    await this.#repository.assertMutationAllowed(client);
    await lockLease(client, context.lease, p.scopeFingerprint, p.batchId);
    const envelope = await this.#repository.readEnvelope(client, p.id, true);
    if (!envelope || envelope.requestHash !== proposalRequestHash(p, context.evidence)) fail("proposal_conflict");
    if (envelope.expiresAt <= integer(this.#now())) fail("proposal_expired");
    if (context.approval || p.ownerApprovalReceiptId) await this.#repository.reviews.lockApproval(client, context);
    if (context.evidence.length) {
      const origins = await client.query(`/* evolution:source-origins */ SELECT metadata #>> '{evolutionEvidence,sourceId}' AS source_id FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text = ANY($10::text[]) LIMIT 32`, [...scopeParams(p.scope), context.evidence.map(e => e.id)]);
      const sources = [...new Set([...context.evidence.map(e => e.sourceId), ...origins.rows.flatMap(row => typeof row.source_id === "string" ? [row.source_id] : [])])].sort();
      for (const sourceId of sources) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`evolution-source:${p.scopeFingerprint}:${sourceId}`]);
      const revoked = await client.query(`/* evolution:source-tombstones */ SELECT source_id FROM mengshu_evolution_source_dispositions
WHERE scope_fingerprint = $1 AND source_id = ANY($2::text[]) AND logical_file_id = '' AND disposition = 'revoked' LIMIT 1`, [p.scopeFingerprint, sources]);
      if (revoked.rows.length) fail("source_revoked");
    }
    if (context.signal?.aborted) fail("cancelled");
    diagnostic.phase = "source_verification";
    const verified = await context.verifySource();
    if (!verified.valid) fail(verified.reason ?? "source_changed_or_revoked");
    if (context.signal?.aborted) fail("cancelled");
    // Host budget guards require the completed source-verification usage before authorizing writes.
    diagnostic.phase = "host_guard";
    try { await this.options.assertApplyInTransaction?.(client, context); }
    catch (error) { if (error instanceof EvolutionError) fail(error.code); throw error; }
    if (context.signal?.aborted) fail("cancelled");
  }
  async #commit(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext, outcome: "applied" | "noop", memoryIds: string[]): Promise<EvolutionApplyReceipt> {
    const p = context.proposal;
    const receipt: EvolutionApplyReceipt = {
      id: jsonHash(["evolution-apply-v1", p.scopeFingerprint, p.id]), proposalId: p.id, batchId: p.batchId,
      scopeFingerprint: p.scopeFingerprint, operation: p.operation, outcome, memoryIds, committedAt: integer(this.#now()),
    };
    await this.#repository.assertMutationAllowed(client);
    await lockLease(client, context.lease, p.scopeFingerprint, p.batchId);
    await this.#repository.reviews.consumeApproval(client, context);
    const inserted = await client.query(
      `/* evolution:apply-receipt */ INSERT INTO mengshu_evolution_apply_receipts
(scope_fingerprint, proposal_id, batch_id, request_hash, receipt) VALUES ($1,$2,$3,$4,$5::jsonb)
RETURNING proposal_id`,
      [p.scopeFingerprint, p.id, p.batchId, proposalRequestHash(p, context.evidence), JSON.stringify(receipt)],
    );
    if (inserted.rows[0]?.proposal_id !== p.id) fail("receipt_write_failed");
    const updated = await client.query(
      `/* evolution:proposal-applied */ UPDATE mengshu_candidates
SET metadata = jsonb_set(metadata, '{evolution,proposal,status}', $11::jsonb),
    status = 'approved', active_content_hash = NULL, promoted_to_memory_id = $12, updated_at = $13
WHERE ${EVOLUTION_CANDIDATE_SCOPE_SQL} AND id = $10 AND status = 'pending' RETURNING id`,
      [...scopeParams(p.scope), p.id, JSON.stringify(outcome), memoryIds[0] ?? null, receipt.committedAt],
    );
    if (updated.rows[0]?.id !== p.id) fail("proposal_apply_conflict");
    return receipt;
  }
  async #lockRawEvidence(client: PostgresEvolutionQueryClient, context: EvolutionApplyContext,
    sources: readonly EvolutionEvidence[], bindings: readonly PostgresEvolutionEvidenceBinding[]): Promise<void> {
    const ids = [...new Set(bindings.map((b) => b.evidenceMemoryId))];
    if (!ids.length) return;
    const result = await client.query(
      `/* evolution:raw-evidence-lock */ SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id = ANY($10::uuid[]) ORDER BY id FOR SHARE`,
      [...scopeParams(context.proposal.scope), ids],
    );
    if (result.rows.length !== ids.length) fail("canonical_evidence_missing");
    const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    for (const binding of bindings) {
      const row = result.rows.find((r) => r.id === binding.evidenceMemoryId);
      const source = sources.find((s) => s.id === binding.sourceEvidenceId);
      if (!row || !source) fail("canonical_evidence_missing");
      const raw = decodeEvolutionOriginalEvidence(row, context.proposal.scope);
      if (!raw) fail("canonical_evidence_invalid");
      if (raw.revoked) fail("canonical_evidence_revoked");
      const metadata = object(row.metadata), governance = object(metadata.governance);
      const candidate = object(governance.candidate);
      const origin = object(metadata.evolutionEvidence);
      // expiresAt is an orphan-cleanup threshold, not revocation of a still-present, reverified quote.
      const original = row.text === source.text && candidate.sourceId === source.sourceId;
      const materialized = origin.sourceEvidenceId === source.id && origin.sourceId === source.sourceId && origin.snapshotHash === source.snapshotHash && origin.revision === source.revision && origin.rootEvidenceId === source.rootEvidenceId && context.evidence.filter((e) => e.id === source.id).every((e) => row.text === e.quote);
      if (!original && !materialized) fail("canonical_evidence_source_mismatch");
    }
  }
  #command(context: EvolutionApplyContext, evidenceIds: readonly string[], row?: Record<string, unknown>): MemoryWriteCommand {
    const p = context.proposal;
    if (!p.proposedText || !p.kind) fail("proposal_content_missing");
    const shared = {
      idempotencyKey: `evolution:${jsonHash([p.scopeFingerprint, p.id])}`,
      serverAuthority: context.authority,
      clientScope: { appId: p.scope.appId, projectId: p.scope.projectId, agentId: p.scope.agentId, namespace: p.scope.namespace, visibility: p.scope.visibility ?? "private" },
      text: p.proposedText, kind: p.kind, ...(p.semanticType ? { semanticType: p.semanticType } : {}),
      evidenceIds: [...evidenceIds],
      provenance: { source: "evolution", sourceId: p.id },
      metadata: { evolutionOrigin: { proposalId: p.id, batchId: p.batchId, sourceSnapshotHash: p.sourceSnapshotHash } },
    };
    if (p.operation === "create") {
      if (p.targetRefs.length > 0) fail("create_has_target");
      return { ...shared, type: "saveExplicit" };
    }
    if (!["evolve", "correct"].includes(p.operation) || p.targetRefs.length !== 1) fail("operation_atomic_apply_unavailable");
    if (!row || typeof row.lineage_id !== "string" || Number(row.revision) < 1) fail("temporal_lineage_required");
    const validFrom = p.validFrom ?? (p.operation === "correct" && row.valid_from_ms != null ? Number(row.valid_from_ms) : undefined);
    if (validFrom === undefined || validFrom > this.#now()) fail("verified_current_valid_time_required");
    return { ...shared, type: "correctMemory", correctionKind: "replaceText", targetId: p.targetRefs[0]!.memoryId,
      temporal: { lineageId: row.lineage_id, expectedHeadRevision: p.targetRefs[0]!.expectedRevision, expectedHeadVersionId: p.targetRefs[0]!.memoryId, validFrom, transitionType: p.operation === "correct" ? "corrected" : "evolved", reason: p.reasonCode } };
  }
  async apply(input: EvolutionApplyContext): Promise<EvolutionApplyResult> {
    const context: EvolutionApplyContext = { ...input, proposal: boundedJson(input.proposal), evidence: boundedJson(input.evidence), authority: boundedJson(input.authority), lease: { ...input.lease } };
    let guardReason: string | undefined;
    let authorized = false;
    const diagnostic = new EvolutionApplyDiagnostics(this.options.onDiagnostic);
    try {
      this.#assertContext(context);
      authorized = true;
      diagnostic.phase = "receipt_read";
      const replay = await this.#receipt(this.#repository.pool, context);
      if (replay) return { outcome: replay.outcome, receipt: replay, replayed: true };
      if (context.evidence.some(e => e.hostAttestation !== undefined) && typeof this.options.assertApplyInTransaction !== "function") {
        return { outcome: "blocked", reason: "attestation_transaction_guard_unavailable" };
      }
      if (!context.approval && (context.proposal.validation.reviewRequirement === "owner" || context.proposal.validation.outcome === "review")) return { outcome: "blocked", reason: "owner_review_required" };
      if (context.proposal.validation.outcome === "rejected") return { outcome: "rejected", reason: "validation_rejected" };
      if (context.proposal.operation === "noop") {
        return await this.#repository.mutation(async (client) => {
          await this.#guard(client, context, diagnostic);
          diagnostic.phase = "receipt_read";
          const prior = await this.#receipt(client, context);
          if (prior) return { outcome: prior.outcome, receipt: prior, replayed: true } as const;
          diagnostic.phase = "target_lock";
          await this.#targets(client, context, true);
          diagnostic.phase = "apply_receipt";
          return { outcome: "noop", receipt: await this.#commit(client, context, "noop", []), replayed: false } as const;
        });
      }
      if (!this.options.hydrateEvidence) return { outcome: "blocked", reason: "source_hydration_unavailable" };
      const metadataOnly = (EVOLUTION_METADATA_OPERATIONS as readonly string[]).includes(context.proposal.operation);
      if (!metadataOnly && !this.options.createKernel) return { outcome: "blocked", reason: "atomic_kernel_unavailable" };
      if (!metadataOnly && !["create", "evolve", "correct"].includes(context.proposal.operation)) return { outcome: "blocked", reason: "operation_atomic_apply_unavailable" };
      diagnostic.phase = "hydrate_evidence";
      const evidence = this.#validateHydration(context, await this.options.hydrateEvidence(context));
      diagnostic.phase = "target_read";
      const before = await this.#targets(this.#repository.pool, context, false);
      diagnostic.phase = "proposal_validation";
      const validation = this.#validate(context, before.targets, evidence);
      const supportedEvidence = this.#support(context, before.targets, validation);
      if (!metadataOnly && supportedEvidence.length === 0) return { outcome: "blocked", reason: "owner_review_required" };
      const verified = { context, evidence, targets: before.targets, validation, supportedEvidence };
      diagnostic.phase = "materialize_evidence";
      const bindings = supportedEvidence.length > 0 && validation.outcome !== "noop" && this.options.materializeEvidence
        ? boundedJson(await this.options.materializeEvidence(verified))
        : validation.outcome === "noop" ? [] : supportedEvidence.map((e) => ({ sourceEvidenceId: e.id, evidenceMemoryId: e.id }));
      if (metadataOnly && validation.outcome === "noop") return await this.#repository.mutation(async client => {
        await this.#guard(client, context, diagnostic);
        diagnostic.phase = "target_lock";
        const current = await this.#targets(client, context, true);
        diagnostic.phase = "proposal_validation";
        if (this.#validate(context, current.targets, evidence).outcome !== "noop") fail("effective_support_changed");
        diagnostic.phase = "apply_receipt";
        return { outcome: "noop", receipt: await this.#commit(client, context, "noop", current.targets.map(t => t.memoryId)), replayed: false };
      });
      if (bindings.length !== new Set(supportedEvidence.map((e) => e.id)).size || bindings.some((binding) =>
        !supportedEvidence.some((e) => e.id === binding.sourceEvidenceId) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(binding.evidenceMemoryId)) ||
        new Set(bindings.map((b) => b.sourceEvidenceId)).size !== bindings.length) return { outcome: "blocked", reason: "canonical_evidence_materialization_required" };
      const canonicalEvidenceIds = [...new Set(bindings.map((b) => b.evidenceMemoryId))];
      if (metadataOnly) return await this.#repository.mutation(async client => {
        await this.#guard(client, context, diagnostic);
        const fullVerified = { ...verified, canonicalEvidenceIds };
        diagnostic.phase = "target_lock";
        await lockEvolutionMetadataHeads(client, fullVerified, before.rows, this.#now());
        const current = await this.#targets(client, context, true);
        diagnostic.phase = "proposal_validation";
        if (jsonHash(current.targets) !== jsonHash(before.targets)) fail("governance_state_changed");
        const currentValidation = this.#validate(context, current.targets, evidence);
        const currentSupport = this.#support(context, current.targets, currentValidation);
        if (jsonHash(currentSupport) !== jsonHash(supportedEvidence)) fail("effective_support_changed");
        diagnostic.phase = "raw_evidence_lock";
        await this.#lockRawEvidence(client, context, evidence, bindings);
        diagnostic.phase = "metadata_apply";
        const ids = await applyEvolutionMetadata({ client, verified: { ...fullVerified, targets: current.targets, supportedEvidence: currentSupport, validation: currentValidation }, rows: current.rows, bindings, now: integer(this.#now()), temporal: new PostgresTemporalMemoryRepository(this.#repository.pool) });
        diagnostic.phase = "apply_receipt";
        return { outcome: "applied", receipt: await this.#commit(client, context, "applied", ids), replayed: false };
      });
      diagnostic.phase = "command";
      const command = this.#command(context, canonicalEvidenceIds, before.rows[0]);
      let committed: EvolutionApplyReceipt | undefined;
      let currentSupport: EvolutionStagedEvidence[] | undefined;
      const hooks: PostgresMemoryWriteKernelTransactionHooks = Object.freeze({
        afterBegin: async (client: PostgresEvolutionQueryClient) => { await client.query(POSTGRES_EVOLUTION_TRANSACTION_LIMITS_SQL); },
        beforeMutation: async (client: PostgresEvolutionQueryClient, memory: WriteMemoryRecord) => {
          try {
            await this.#guard(client, context, diagnostic);
            diagnostic.phase = "target_lock";
            if (memory.mutation === "content" && memory.temporal) {
              await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
                `memory-version-receipt:${memory.temporal.receipt.scopeFingerprint}:${memory.temporal.receipt.idempotencyKey}`,
              ]);
              await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
                `memory-lineage:${memory.temporal.receipt.scopeFingerprint}:${memory.temporal.lineageId}`,
              ]);
            }
            const current = await this.#targets(client, context, true);
            diagnostic.phase = "proposal_validation";
            const currentValidation = this.#validate(context, current.targets, evidence);
            currentSupport = this.#support(context, current.targets, currentValidation);
            if (jsonHash(currentSupport) !== jsonHash(supportedEvidence)) fail("effective_support_changed");
            diagnostic.phase = "raw_evidence_lock";
            await this.#lockRawEvidence(client, context, evidence, bindings);
            diagnostic.phase = "kernel_result_guard";
            if (memory.mutation !== "content" || !["active", "lookup_only"].includes(memory.route) || scopedFingerprint(memory.scope) !== context.proposal.scopeFingerprint || memory.text !== context.proposal.proposedText || memory.kind !== context.proposal.kind || memory.semanticType !== context.proposal.semanticType) fail("kernel_result_contract_mismatch");
            if ((!context.proposal.semanticType || currentValidation.evidenceMode === "reviewed_reference") && memory.route !== "lookup_only") fail("kind_only_context_forbidden");
            if (current.targets.length > 0 && currentValidation.independentEvidenceRootIds.length === 0) {
              const metadata = current.rows[0]?.metadata as { confidence?: number } | undefined;
              if ((memory.confidence ?? 0) > (metadata?.confidence ?? 0)) fail("confidence_increase_without_fresh_evidence");
            }
            const candidateEvidence = memory.governance.candidate.evidence as { eventIds?: unknown } | undefined;
            if (jsonHash(memory.evidenceIds) !== jsonHash(canonicalEvidenceIds) || jsonHash(candidateEvidence?.eventIds ?? []) !== jsonHash(canonicalEvidenceIds)) fail("canonical_evidence_binding_mismatch");
            if (context.proposal.operation !== "create" && (!memory.temporal || memory.temporal.expectedHeadVersionId !== context.proposal.targetRefs[0]?.memoryId)) fail("temporal_write_required");
            diagnostic.phase = "kernel_transaction";
          } catch (error) { guardReason = error instanceof PostgresEvolutionError || error instanceof EvolutionError ? error.code : "apply_guard_failed"; throw error; }
        },
        afterReceipt: async (client: PostgresEvolutionQueryClient, receipt: NormalizedMemoryWriteReceipt, memory: WriteMemoryRecord) => {
          diagnostic.phase = "effective_evidence";
          if (receipt.result.recordType !== "memory" || !receipt.result.stored || memory.mutation !== "content") fail("canonical_write_not_created");
          if (!currentSupport) fail("effective_support_not_validated");
          const referenceOnly = validation.evidenceMode === "reviewed_reference";
          const relationState = referenceOnly ? "reviewed_reference" : "effective";
          const effective = boundedJson({ effectiveRootIds: referenceOnly ? [] : currentSupport.map((e) => e.rootEvidenceId).sort(), evidence: currentSupport.map((e) => ({ ...e, relationState })), proposalId: context.proposal.id,
            ...(context.approval ? { ownerApprovalReceiptId: context.approval.id } : {}) });
          const changed = await client.query(
            `/* evolution:effective-evidence */ UPDATE memories
SET metadata = jsonb_set(metadata, '{governance}', COALESCE(metadata->'governance', '{}'::jsonb) || jsonb_build_object('evolution', $11::jsonb)),
temporal_snapshot = CASE WHEN temporal_snapshot IS NULL THEN NULL ELSE jsonb_set(temporal_snapshot, '{record,metadata}',
jsonb_set(metadata, '{governance}', COALESCE(metadata->'governance', '{}'::jsonb) || jsonb_build_object('evolution', $11::jsonb))) END
WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id = $10::uuid RETURNING id::text AS id`,
            [...scopeParams(context.proposal.scope), receipt.result.memoryId, JSON.stringify(effective)],
          );
          if (changed.rows.length !== 1 || changed.rows[0]?.id !== receipt.result.memoryId) fail("effective_evidence_write_failed");
          for (const binding of bindings) {
            const source = currentSupport.find(e => e.id === binding.sourceEvidenceId)!;
            const linkId = jsonHash(["evolution-effective-evidence-v1", context.proposal.scopeFingerprint, receipt.result.memoryId, binding.evidenceMemoryId]);
            await client.query(
              `/* evolution:effective-evidence-link */ INSERT INTO mengshu_memory_evidence_links
(link_id, scope_fingerprint, tenant_id, user_id, app_id, project_id, agent_id, namespace,
 visibility, workspace_id, session_id, target_memory_id, evidence_memory_id, link_kind, source, created_at,
 relation_state, root_evidence_id, source_id, source_revision, source_hash, source_kind, source_record_id, source_path_id, source_span_id)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'grounded_by','memory_evolution',$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
ON CONFLICT (scope_fingerprint, target_memory_id, evidence_memory_id, link_kind, source) DO NOTHING`,
              [linkId, context.proposal.scopeFingerprint, ...scopeParams(context.proposal.scope), receipt.result.memoryId, binding.evidenceMemoryId, integer(this.#now()), relationState, source.rootEvidenceId, source.sourceId, source.revision, source.snapshotHash, source.trust, source.id, source.locator?.match(/^([a-f0-9]{64}):\d+-\d+:(.{1,256})$/)?.[1] ?? null, source.locator?.match(/^([a-f0-9]{64}):\d+-\d+:(.{1,256})$/)?.[2] ?? null],
            );
          }
          diagnostic.phase = "apply_receipt";
          committed = await this.#commit(client, context, "applied", [receipt.result.memoryId]);
          diagnostic.phase = "mark_origin";
          await client.query(`/* evolution:mark-origin */ UPDATE mengshu_write_outbox SET evolution_origin = TRUE
WHERE storage_key = $1 AND tenant_id = $2 AND user_id = $3`, [receipt.identity.storageKey, context.proposal.scope.tenantId, context.proposal.scope.userId]);
          if (memory.temporal) await client.query(`/* evolution:mark-version-origin */ UPDATE mengshu_memory_version_outbox SET evolution_origin = TRUE
WHERE scope_fingerprint = $1 AND lineage_id = $2 AND revision = $3`, [context.proposal.scopeFingerprint, memory.temporal.lineageId, memory.temporal.receipt.revision]);
          diagnostic.phase = "kernel_transaction";
        },
      });
      diagnostic.phase = "kernel_factory";
      const configured = this.options.createKernel!(hooks, { ...verified, canonicalEvidenceIds });
      if (!isProviderOwnedMemoryWriteKernelTransactionWithHooks(configured.transactionPort, hooks)) return { outcome: "blocked", reason: "provider_owned_transaction_required" };
      if (!context.proposal.semanticType && context.proposal.operation !== "create" && configured.dependencies.temporalLookupOnlyEnabled !== true) return { outcome: "blocked", reason: "kind_only_temporal_read_unavailable" };
      const kernel = new MemoryWriteKernel(diagnostic.wrapKernel({ ...configured.dependencies,
        validate: async value => {
          const checked = await configured.dependencies.validate(value);
          if (!checked.accepted) return checked;
          const ceiling = validation.evidenceMode === "reviewed_reference" ? 0
            : before.targets.length && !validation.independentEvidenceRootIds.length
              ? Number((before.rows[0]?.metadata as { confidence?: number } | undefined)?.confidence ?? 0) : undefined;
          return ceiling === undefined ? checked : { accepted: true, candidate: { ...checked.candidate, confidence: Math.min(Number(checked.candidate.confidence ?? ceiling), ceiling) } };
        },
        scoreAdmission: async value => {
          const scored = await configured.dependencies.scoreAdmission(value);
          return validation.evidenceMode === "reviewed_reference" && scored.route === "active" ? { ...scored, route: "lookup_only" } : scored;
        },
        transaction: (work) => configured.transactionPort.transaction(work) }));
      diagnostic.phase = "kernel_prepare";
      const result = await kernel.execute(command);
      if (result.status === "rejected") return { outcome: "rejected", reason: result.reason };
      if (!committed) {
        diagnostic.phase = "receipt_read";
        const replay = await this.#receipt(this.#repository.pool, context);
        if (replay) return { outcome: replay.outcome, receipt: replay, replayed: true };
        return { outcome: "blocked", reason: result.status === "duplicate" ? "duplicate_requires_evidence_review" : "atomic_receipt_missing" };
      }
      return { outcome: "applied", receipt: committed, replayed: false };
    } catch (error) {
      diagnostic.reportFailure(error);
      // A post-commit acknowledgement/connection cleanup failure does not undo a durable receipt.
      try {
        const receipt = authorized ? await this.#receipt(this.#repository.pool, context) : undefined;
        if (receipt) return { outcome: receipt.outcome, receipt, replayed: true };
      } catch { /* Keep the original failure when receipt recovery is unavailable. */ }
      const reason = guardReason ?? (error instanceof PostgresEvolutionError || error instanceof EvolutionError ? error.code : "atomic_apply_failed");
      return { outcome: ["LOCK_BUSY", "QUERY_TIMEOUT", "STALE_LEASE", "owner_review_required", "temporal_lineage_required", "verified_current_valid_time_required"].includes(reason) || reason.includes("unavailable") ? "blocked" : "rejected", reason };
    }
  }
}
