import { randomUUID } from "node:crypto";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { resolveAuthorityScope } from "../domain/authority-scope.js";
import { deterministicUuid } from "../scoring/hash-utils.js";
import { redactSecrets } from "../ingest/agent-history/redaction.js";
import { evolutionHash, evolutionInputFingerprint } from "./fingerprints.js";
import { validateEvolutionProposal, validateEvolutionApprovedProposal, stageEvolutionEvidence } from "./proposal-validation.js";
import { BoundedEvolutionProposalSource } from "./proposal-source.js";
import { abortableEvolution, serializedEvolutionProposal } from "./proposer.js";
import { assertEvolutionCheckpoint, EvolutionError, EVOLUTION_POLICY_VERSION, parseEvolutionControlRequest, parseEvolutionControlResult, parseEvolutionProposal, parseEvolutionRunRequest } from "./schema.js";
import type { EvolutionBatch, EvolutionBatchReport, EvolutionControlRequest, EvolutionInputContext, EvolutionInputPort, EvolutionInputUnit, EvolutionLease, EvolutionLimits, EvolutionProposal, EvolutionProposalDraft, EvolutionReviewReceipt, EvolutionRunRequest, EvolutionUsage, EvolutionValidation, MemoryEvolutionBatchServiceOptions } from "./types.js";

const ZERO_USAGE = { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 };
const ZERO_COUNTS = { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 };
const runningBatches = new Map<string, AbortController>();
function controlAuthorizationRequest(request: EvolutionControlRequest & { limits: EvolutionLimits }): EvolutionControlRequest {
  const { maxRecords, maxFiles, maxBytes, maxDurationMs } = request.limits;
  return { ...structuredClone(request), limits: { maxRecords, maxFiles, maxBytes, maxDurationMs } };
}
function report(batch: EvolutionBatch): EvolutionBatchReport {
  return structuredClone({ batchId: batch.id, status: batch.status, reasons: batch.reasons.slice(0, 32), usage: batch.usage, usageAccounting: "budget_reservation", segment: batch.segment, counts: batch.counts, checkpoint: { cursor: batch.cursor, selectionEpoch: batch.snapshot?.selectionEpoch, upperKey: batch.snapshot?.upperKey }, configFingerprint: batch.configFingerprint, resumable: ["queued", "running", "partial", "cancelled", "failed"].includes(batch.status),
    work: { kind: batch.request.action === "execute_control" ? batch.request.input.work.kind : "memory_evolution", ...(batch.controlResult ? { result: batch.controlResult } : {}) } });
}
const segmentUsage = (batch: EvolutionBatch): EvolutionUsage => batch.segment?.usage ?? batch.usage;
function charge(batch: EvolutionBatch, key: keyof EvolutionUsage, amount: number): void {
  batch.usage[key] += amount;
  if (batch.segment) batch.segment.usage[key] += amount;
}
function draftOf(proposal: EvolutionProposal): EvolutionProposalDraft {
  const { operation, claimClass, reasonCode, targetRefs, quotes, proposedText, kind, semanticType, profileDimension, validFrom, validTo } = proposal;
  return { operation, claimClass, reasonCode, targetRefs, quotes, ...(proposedText === undefined ? {} : { proposedText }), ...(kind === undefined ? {} : { kind }), ...(semanticType === undefined ? {} : { semanticType }), ...(profileDimension === undefined ? {} : { profileDimension }), ...(validFrom === undefined ? {} : { validFrom }), ...(validTo === undefined ? {} : { validTo }) };
}
export class MemoryEvolutionBatchService {
  private readonly options: MemoryEvolutionBatchServiceOptions;
  private readonly scopeFingerprint: string;
  private readonly now: () => number;
  private readonly ownerId: string;
  constructor(options: MemoryEvolutionBatchServiceOptions) {
    const { appId, projectId, agentId, namespace, visibility } = options.scope;
    const resolved = resolveAuthorityScope(options.authority, { appId, projectId, agentId, namespace, visibility });
    this.scopeFingerprint = authorityScopeFingerprint(resolved);
    if (this.scopeFingerprint !== authorityScopeFingerprint(options.scope)) throw new EvolutionError("scope_mismatch");
    if (!options.configFingerprint || options.configFingerprint.length > 256 || /\s/.test(options.configFingerprint)) throw new EvolutionError("config_fingerprint_invalid");
    if (new Set(options.inputs.map(p => p.mode)).size !== options.inputs.length) throw new EvolutionError("ambiguous_input_port");
    this.options = { ...options, scope: structuredClone(options.scope), authority: structuredClone(options.authority), inputs: [...options.inputs] };
    this.now = options.now ?? Date.now;
    this.ownerId = options.ownerId ?? randomUUID();
  }
  async run(request: EvolutionRunRequest, signal?: AbortSignal): Promise<EvolutionBatchReport> {
    return this.retry((await this.prepare(request)).batchId, signal);
  }
  async prepareApproved(approvalReceiptId: string, limits?: Partial<EvolutionLimits>): Promise<EvolutionBatchReport> {
    const approval = await this.options.reviews?.getReviewReceipt(approvalReceiptId, this.scopeFingerprint);
    if (!approval || approval.decision !== "approve") throw new EvolutionError("approval_not_granted");
    const proposal = await this.options.repository.getProposal(approval.binding.proposalId, this.scopeFingerprint);
    const original = proposal && await this.options.repository.getBatch(proposal.batchId, this.scopeFingerprint);
    if (!proposal || !original) throw new EvolutionError("proposal_not_found");
    this.assertConfig(original);
    const request = parseEvolutionRunRequest({ input: original.request.input, action: "apply_allowed", idempotencyKey: `approved:${approvalReceiptId}`, ...(limits ? { limits } : {}) });
    const id = deterministicUuid(`evolution-approved-batch:${this.scopeFingerprint}:${approvalReceiptId}`);
    const approvedReplay = { proposalId: proposal.id, approvalReceiptId };
    const requestHash = evolutionHash({ request, approvedReplay });
    const old = await this.options.repository.getBatch(id, this.scopeFingerprint);
    if (old) {
      if (old.requestHash !== requestHash) throw new EvolutionError("idempotency_conflict");
      return report(old);
    }
    if (approval.expiresAt <= this.now()) throw new EvolutionError("approval_expired");
    const now = this.now();
    return report((await this.options.repository.createBatch({ id, scope: this.options.scope, scopeFingerprint: this.scopeFingerprint,
      request, requestHash, approvedReplay, configFingerprint: this.options.configFingerprint, policyVersion: this.options.policyVersion ?? EVOLUTION_POLICY_VERSION,
      status: "queued", reasons: [], cursor: null, usage: { ...ZERO_USAGE }, segment: { attempt: 1, usage: { ...ZERO_USAGE } }, counts: { ...ZERO_COUNTS }, createdAt: now, updatedAt: now, version: 0,
    })).batch);
  }
  async replayApproved(approvalReceiptId: string, limits?: Partial<EvolutionLimits>, signal?: AbortSignal): Promise<EvolutionBatchReport> {
    return this.retry((await this.prepareApproved(approvalReceiptId, limits)).batchId, signal);
  }
  async cancel(batchId: string): Promise<EvolutionBatchReport> {
    if (!this.options.repository.requestCancellation) throw new EvolutionError("cancel_capability_unavailable");
    const batch = await this.options.repository.requestCancellation(batchId, this.scopeFingerprint, this.now());
    if (!batch) throw new EvolutionError("batch_not_found");
    runningBatches.get(`${this.scopeFingerprint}:${batchId}`)?.abort();
    return report(batch);
  }
  /** Host-only durable enqueue preparation. No input reads, model calls or canonical writes. */
  async prepare(request: EvolutionRunRequest): Promise<EvolutionBatchReport> {
    return this.prepareRequest(parseEvolutionRunRequest(request));
  }
  async prepareControl(request: EvolutionControlRequest): Promise<EvolutionBatchReport> {
    const parsed = parseEvolutionControlRequest(request);
    if (!this.options.control) throw new EvolutionError("control_capability_unavailable");
    await this.options.control.authorizePrepare(controlAuthorizationRequest(parsed));
    return this.prepareRequest(parsed);
  }
  private async prepareRequest(parsed: EvolutionBatch["request"]): Promise<EvolutionBatchReport> {
    const now = this.now();
    const { batch } = await this.options.repository.createBatch({
      id: deterministicUuid(`evolution-batch:${this.scopeFingerprint}:${parsed.idempotencyKey}`), scope: this.options.scope, scopeFingerprint: this.scopeFingerprint,
      request: parsed, requestHash: evolutionHash(parsed), configFingerprint: this.options.configFingerprint, policyVersion: this.options.policyVersion ?? EVOLUTION_POLICY_VERSION,
      status: "queued", reasons: [], cursor: null, usage: { ...ZERO_USAGE }, segment: { attempt: 1, usage: { ...ZERO_USAGE } }, counts: { ...ZERO_COUNTS }, createdAt: now, updatedAt: now, version: 0,
    });
    this.assertConfig(batch);
    return report(batch);
  }
  async status(batchId: string): Promise<EvolutionBatchReport | undefined> {
    const batch = await this.options.repository.getBatch(batchId, this.scopeFingerprint);
    return batch && report(batch);
  }
  async resume(batchId: string, signal?: AbortSignal): Promise<EvolutionBatchReport> {
    const prepared = await this.prepareResume(batchId);
    if (prepared.status !== "queued") return prepared;
    return this.retry(batchId, signal);
  }
  /** Durable workers must retry the original segment, never call resume. */
  async retry(batchId: string, signal?: AbortSignal): Promise<EvolutionBatchReport> {
    const batch = await this.options.repository.getBatch(batchId, this.scopeFingerprint);
    if (!batch) throw new EvolutionError("batch_not_found");
    return this.execute(batch, signal);
  }
  async prepareResume(batchId: string): Promise<EvolutionBatchReport> {
    const repository = this.options.repository;
    const initial = await repository.getBatch(batchId, this.scopeFingerprint);
    if (!initial) throw new EvolutionError("batch_not_found");
    this.assertConfig(initial);
    if (initial.request.action === "execute_control") {
      if (!this.options.control) throw new EvolutionError("control_capability_unavailable");
      await this.options.control.authorizePrepare(controlAuthorizationRequest(initial.request));
    }
    if (!["partial", "cancelled", "failed"].includes(initial.status)) return report(initial);
    const lease = await repository.acquireLease(batchId, this.scopeFingerprint, this.ownerId, 30_000);
    if (!lease) return { ...report(initial), status: "blocked", reasons: ["batch_leased"], resumable: true };
    try {
      const batch = (await repository.getBatch(batchId, this.scopeFingerprint))!;
      this.assertConfig(batch);
      if (!["partial", "cancelled", "failed"].includes(batch.status)) return report(batch);
      batch.segment = { attempt: (batch.segment?.attempt ?? 1) + 1, usage: { ...ZERO_USAGE } };
      delete batch.cancelRequestedAt;
      batch.status = "queued";
      batch.reasons = [];
      batch.updatedAt = this.now();
      return report(await repository.saveBatch(batch, batch.version, lease));
    } finally { await repository.releaseLease(lease); }
  }
  private assertConfig(batch: EvolutionBatch): void {
    if (batch.configFingerprint !== this.options.configFingerprint || batch.policyVersion !== (this.options.policyVersion ?? EVOLUTION_POLICY_VERSION)) throw new EvolutionError("config_changed");
    if (batch.request.action === "execute_control") {
      const { maxLlmCalls, maxInputTokens, maxOutputTokens, ...limits } = batch.request.limits;
      if (maxLlmCalls !== 0 || maxInputTokens !== 0 || maxOutputTokens !== 0 || batch.approvedReplay) throw new EvolutionError("control_request_invalid");
      const parsed = parseEvolutionControlRequest({ ...batch.request, limits });
      if (evolutionHash(parsed) !== batch.requestHash || evolutionHash(batch.request) !== batch.requestHash) throw new EvolutionError("control_request_changed");
    }
  }
  private context(batch: EvolutionBatch, signal?: AbortSignal): EvolutionInputContext {
    if (batch.request.action === "execute_control") throw new EvolutionError("control_input_forbidden");
    const limits = batch.request.limits;
    const usage = segmentUsage(batch);
    return { input: batch.request.input, scope: batch.scope, limits: { ...limits, maxRecords: Math.max(0, limits.maxRecords - usage.records), maxFiles: Math.max(0, limits.maxFiles - usage.files), maxBytes: Math.max(0, limits.maxBytes - usage.bytes), maxDurationMs: Math.max(0, limits.maxDurationMs - usage.durationMs) }, signal };
  }
  private async execute(initial: EvolutionBatch, outerSignal?: AbortSignal): Promise<EvolutionBatchReport> {
    this.assertConfig(initial);
    if (initial.status === "completed" || initial.status === "cancelled" || initial.cancelRequestedAt !== undefined) return report(initial);
    const repository = this.options.repository;
    const lease = await repository.acquireLease(initial.id, this.scopeFingerprint, this.ownerId, initial.request.limits.maxDurationMs + 30_000);
    if (!lease) return { ...report(initial), status: "blocked", reasons: ["batch_leased"], resumable: true };
    const batch = (await repository.getBatch(initial.id, this.scopeFingerprint))!;
    batch.segment ??= { attempt: 1, usage: { ...batch.usage } };
    const controller = new AbortController();
    const runningKey = `${this.scopeFingerprint}:${batch.id}`;
    runningBatches.set(runningKey, controller);
    const cancel = () => controller.abort();
    outerSignal?.addEventListener("abort", cancel, { once: true });
    if (outerSignal?.aborted) cancel();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; cancel(); }, Math.max(1, batch.request.limits.maxDurationMs - segmentUsage(batch).durationMs));
    let lastSaveTime = this.now();
    const persist = async (): Promise<void> => {
      const now = this.now();
      charge(batch, "durationMs", Math.max(0, now - lastSaveTime));
      lastSaveTime = now;
      batch.updatedAt = now;
      Object.assign(batch, await repository.saveBatch(batch, batch.version, lease));
      if (batch.cancelRequestedAt !== undefined) controller.abort();
    };
    const finish = async (status: EvolutionBatch["status"], reason?: string): Promise<EvolutionBatchReport> => {
      batch.status = status;
      if (reason && !batch.reasons.includes(reason)) batch.reasons = [...batch.reasons, reason].slice(-32);
      await persist();
      return report(batch);
    };
    const checkpoint = async (input: EvolutionInputPort, cursor: EvolutionBatch["cursor"], proposalId?: string): Promise<void> => {
      batch.cursor = cursor;
      await persist();
      if (batch.request.action !== "preview" && batch.request.action !== "execute_control") await input.acknowledge?.({ ...this.context(batch, controller.signal), snapshot: batch.snapshot!, cursor, action: batch.request.action, ...(proposalId ? { proposalId } : {}) });
    };
    try {
      this.assertConfig(batch);
      batch.status = "running";
      batch.reasons = [];
      await persist();
      if (controller.signal.aborted) return await finish("cancelled", "cancelled");
      if (batch.request.action === "execute_control") {
        if (!this.options.control) return await finish("blocked", "control_capability_unavailable");
        const limits = { ...batch.request.limits };
        for (const [limit, key, reason] of [["maxRecords", "records", "max_records"], ["maxFiles", "files", "max_files"],
          ["maxBytes", "bytes", "max_bytes"], ["maxDurationMs", "durationMs", "max_duration"]] as const) {
          limits[limit] = Math.max(0, limits[limit] - segmentUsage(batch)[key]);
          if (limits[limit] <= 0 && (limit !== "maxFiles" || batch.request.input.work.kind === "source_reconcile")) return await finish("partial", reason);
        }
        for (const [limit, key] of [["maxRecords", "records"], ["maxFiles", "files"], ["maxBytes", "bytes"]] as const) charge(batch, key, limits[limit]);
        await persist();
        if (controller.signal.aborted) return await finish("cancelled", "cancelled");
        // Await the real bounded transaction/rollback; racing cancellation would leave mutations running.
        const result = parseEvolutionControlResult(await this.options.control.execute({ request: structuredClone(batch.request),
          batchId: batch.id, scope: structuredClone(batch.scope), lease, limits, signal: controller.signal }));
        if (batch.controlResult?.receiptId !== result.receiptId) batch.counts.applied++;
        batch.controlResult = result;
        for (const reason of result.reasons ?? []) if (!batch.reasons.includes(reason)) batch.reasons.push(reason);
        return await finish(result.status);
      }
      const input = this.options.inputs.find(p => p.mode === batch.request.input.mode);
      if (!input) return await finish("blocked", "input_capability_unavailable");
      if (batch.request.action === "apply_allowed" && !this.options.writer) return await finish("blocked", "apply_capability_unavailable");
      if (controller.signal.aborted) return await finish("cancelled", "cancelled");
      if (batch.approvedReplay) {
        const result = await this.executeApproved(batch, input, lease, persist, controller.signal);
        return await finish(result.status, result.reason);
      }
      if (!batch.snapshot) {
        batch.snapshot = await abortableEvolution(input.open(this.context(batch, controller.signal)), controller.signal);
        assertEvolutionCheckpoint(batch.snapshot);
        await persist();
      }
      for (;;) {
        if (controller.signal.aborted) return await finish(timedOut ? "partial" : "cancelled", timedOut ? "max_duration" : "cancelled");
        const remaining = this.context(batch, controller.signal);
        if (remaining.limits.maxRecords <= 0) return await finish("partial", "max_records");
        if (remaining.limits.maxBytes <= 0) return await finish("partial", "max_bytes");
        if (remaining.limits.maxDurationMs <= 0) return await finish("partial", "max_duration");
        // Persist the IO allowance before reading; an interrupted adapter cannot make retries free.
        charge(batch, "records", remaining.limits.maxRecords); charge(batch, "files", remaining.limits.maxFiles); charge(batch, "bytes", remaining.limits.maxBytes);
        await persist();
        const page = await abortableEvolution(input.readPage({ ...remaining, snapshot: batch.snapshot, cursor: batch.cursor, limit: 1 }), controller.signal);
        assertEvolutionCheckpoint(page.nextCursor);
        if (page.units.length > 1 || !Number.isSafeInteger(page.bytesRead) || page.bytesRead < 0 || !Number.isSafeInteger(page.filesRead) || page.filesRead < 0) return await finish("blocked", "input_contract_invalid");
        const selectedRecords = page.units.reduce((sum, u) => sum + u.targets.length + u.evidence.length, 0);
        const records = page.recordsRead ?? selectedRecords;
        if (!Number.isSafeInteger(records) || records < selectedRecords) return await finish("blocked", "input_accounting_invalid");
        charge(batch, "records", records - remaining.limits.maxRecords);
        charge(batch, "bytes", page.bytesRead - remaining.limits.maxBytes);
        charge(batch, "files", page.filesRead - remaining.limits.maxFiles);
        await persist();
        if (records > remaining.limits.maxRecords || page.bytesRead > remaining.limits.maxBytes || page.filesRead > remaining.limits.maxFiles) return await finish("partial", "input_budget_exceeded");
        if (!page.units.length) {
          const advanced = evolutionHash(page.nextCursor) !== evolutionHash(batch.cursor);
          await checkpoint(input, page.nextCursor);
          if (page.reasons?.length) return await finish("partial", this.reason(page.reasons[0]));
          if (page.complete) return await finish(batch.counts.review && batch.request.action === "apply_allowed" ? "blocked" : "completed", batch.counts.review ? "owner_review_required" : undefined);
          if (advanced) continue;
          return await finish("partial", "input_gap");
        }
        const unit = page.units[0];
        this.assertUnit(unit, batch);
        if (batch.request.action === "preview") {
          await checkpoint(input, page.nextCursor);
        } else {
          const inputFingerprint = evolutionInputFingerprint(unit, batch.configFingerprint, batch.policyVersion);
          const action = batch.request.action;
          const processed = await repository.findProcessed(this.scopeFingerprint, inputFingerprint, action);
          const localId = deterministicUuid(`evolution-proposal:${batch.id}:${inputFingerprint}`);
          let proposal = await repository.getProposal(localId, this.scopeFingerprint);
          if (processed && (processed.proposalId !== localId || processed.processedAt <= (batch.accountedThrough ?? 0))) {
            const old = await repository.getProposal(processed.proposalId, this.scopeFingerprint);
            if (!old) return await finish("blocked", "processed_proposal_missing");
            batch.counts.skipped++;
            if (old.batchId !== batch.id && old.validation.reviewRequirement === "owner") batch.counts.review++;
            await checkpoint(input, page.nextCursor, old.id);
          } else {
            if (!proposal && action === "apply_allowed") {
              const staged = await repository.findProcessed(this.scopeFingerprint, inputFingerprint, "propose");
              const previous = staged && await repository.getProposal(staged.proposalId, this.scopeFingerprint);
              if (previous) {
                proposal = { ...previous, id: localId, batchId: batch.id, createdAt: this.now(),
                  directoryLocator: unit.directoryLocator ? structuredClone(unit.directoryLocator) : undefined,
                  inputPosition: { snapshot: batch.snapshot, cursor: batch.cursor } };
                proposal = await repository.stageProposal(proposal, stageEvolutionEvidence(proposal, unit), lease);
              }
            }
            if (!proposal) {
              const proposer = this.options.proposer;
              if (!proposer?.available) return await finish("blocked", "model_unavailable");
              const attempts = proposer.maxAttempts;
              const tokens = proposer.estimateInputTokens(unit);
              if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(tokens) || tokens < 1) return await finish("blocked", "model_budget_invalid");
              if (segmentUsage(batch).llmCalls + attempts > batch.request.limits.maxLlmCalls) return await finish("partial", "max_llm_calls");
              if (segmentUsage(batch).inputTokens + tokens * attempts > batch.request.limits.maxInputTokens) return await finish("partial", "max_input_tokens");
              const outputTokens = Math.min(2048, Math.floor((batch.request.limits.maxOutputTokens - segmentUsage(batch).outputTokens) / attempts));
              if (outputTokens < 64) return await finish("partial", "max_output_tokens");
              charge(batch, "llmCalls", attempts);
              charge(batch, "inputTokens", tokens * attempts);
              charge(batch, "outputTokens", outputTokens * attempts);
              // Persist pessimistic reservations before the external side effect; crashes cannot reset cost.
              await persist();
              const raw = await serializedEvolutionProposal(() => proposer.propose(unit, { maxOutputTokens: outputTokens, timeoutMs: this.context(batch).limits.maxDurationMs, signal: controller.signal }), controller.signal);
              let draft: EvolutionProposalDraft;
              let validation: EvolutionValidation | undefined;
              try { draft = parseEvolutionProposal(raw); }
              catch (error) {
                if (!(error instanceof EvolutionError)) throw error;
                draft = { operation: "noop", claimClass: "fact", reasonCode: "unchanged", targetRefs: [], quotes: [] };
                validation = { outcome: "rejected", reasons: ["schema_invalid"], reviewRequirement: "none", independentEvidenceRootIds: [], contextEligible: false };
              }
              if (!validation) {
                const verification = await this.chargeVerification(batch, unit, persist, controller.signal);
                const verified = await this.verify(input, unit, verification, batch);
                validation = verified.valid ? validateEvolutionProposal(draft, unit, batch.scope) : { outcome: "rejected", reasons: [this.reason(verified.reason ?? "source_changed")], reviewRequirement: "none", independentEvidenceRootIds: [], contextEligible: false };
              }
              // Rejected model quotes are not evidence. Keep only a bounded reason/reference record.
              if (validation.outcome === "rejected") draft = { ...draft, quotes: [], ...(draft.proposedText ? { proposedText: redactSecrets(draft.proposedText).text } : {}) };
              proposal = await repository.stageProposal({ ...draft, id: localId, batchId: batch.id, scope: batch.scope, scopeFingerprint: this.scopeFingerprint, inputUnitId: unit.id, inputFingerprint, sourceSnapshotHash: unit.snapshotHash, configFingerprint: batch.configFingerprint, policyVersion: batch.policyVersion, validation, status: validation.outcome === "allowed" ? "staged" : validation.outcome, createdAt: this.now(), inputPosition: { snapshot: batch.snapshot, cursor: batch.cursor }, ...(unit.directoryLocator ? { directoryLocator: structuredClone(unit.directoryLocator) } : {}) }, stageEvolutionEvidence(draft, unit), lease);
            }
            const outcome = await this.processProposal(proposal, unit, input, batch, lease, persist, controller.signal);
            if (outcome.blocked) return await finish("blocked", outcome.blocked);
            const processedAt = Math.max(this.now(), (batch.accountedThrough ?? 0) + 1);
            await repository.recordProcessed({ scopeFingerprint: this.scopeFingerprint, inputFingerprint, action, proposalId: outcome.proposalId ?? proposal.id, processedAt }, lease);
            const committedProgress = await repository.findProcessed(this.scopeFingerprint, inputFingerprint, action);
            batch.accountedThrough = Math.max(batch.accountedThrough ?? 0, committedProgress?.processedAt ?? processedAt);
            batch.counts.proposed++;
            if (outcome.count) batch.counts[outcome.count]++;
            await checkpoint(input, page.nextCursor, outcome.proposalId ?? proposal.id);
          }
        }
        if (page.reasons?.length) return await finish("partial", this.reason(page.reasons[0]));
        if (page.complete) return await finish(batch.counts.review && batch.request.action === "apply_allowed" ? "blocked" : "completed", batch.counts.review ? "owner_review_required" : undefined);
      }
    } catch (error) {
      if (controller.signal.aborted) return await finish(timedOut ? "partial" : "cancelled", timedOut ? "max_duration" : "cancelled");
      const reason = error instanceof EvolutionError ? error.code : "batch_operation_failed";
      if (reason === "lease_lost" || reason === "batch_cas_conflict") return { ...report(batch), status: "blocked", reasons: [reason], resumable: true };
      return await finish(reason.startsWith("max_") || reason === "review_source_budget_exceeded" ? "partial" : reason.startsWith("approval_") || reason.startsWith("review_") || reason.endsWith("_unsupported") || reason.endsWith("_required") || reason.endsWith("_unavailable") ? "blocked" : "failed", reason);
    } finally {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", cancel);
      if (runningBatches.get(runningKey) === controller) runningBatches.delete(runningKey);
      await repository.releaseLease(lease);
    }
  }
  private async executeApproved(batch: EvolutionBatch, input: EvolutionInputPort, lease: EvolutionLease, persist: () => Promise<void>, signal: AbortSignal): Promise<{ status: EvolutionBatch["status"]; reason?: string }> {
    const replay = batch.approvedReplay!;
    const approval = await this.options.reviews?.getReviewReceipt(replay.approvalReceiptId, this.scopeFingerprint);
    const original = await this.options.repository.getProposal(replay.proposalId, this.scopeFingerprint);
    if (!approval || !original || approval.binding.proposalId !== original.id) throw new EvolutionError("approval_not_granted");
    const proposalId = deterministicUuid(`evolution-approved-proposal:${approval.id}`);
    const committed = await this.options.repository.getReceipt(proposalId, this.scopeFingerprint);
    if (committed) {
      batch.counts.proposed = 1; batch.counts[committed.outcome === "applied" ? "applied" : "noop"] = 1;
      return { status: "completed" };
    }
    if (approval.expiresAt <= this.now()) throw new EvolutionError("approval_expired");
    const context = this.context(batch, signal);
    if (context.limits.maxRecords <= 0) throw new EvolutionError("max_records");
    if (context.limits.maxBytes <= 0) throw new EvolutionError("max_bytes");
    const source = this.options.proposalSource ?? new BoundedEvolutionProposalSource(this.options.inputs, this.now);
    // Failed/cancelled source reads retain their bounded reservation; worker retries cannot buy more IO.
    charge(batch, "records", context.limits.maxRecords); charge(batch, "files", context.limits.maxFiles); charge(batch, "bytes", context.limits.maxBytes);
    await persist();
    const read = await abortableEvolution(source.read(original, context), signal);
    if (![read.recordsRead, read.filesRead, read.bytesRead].every(n => Number.isSafeInteger(n) && n >= 0) || read.recordsRead > context.limits.maxRecords || read.filesRead > context.limits.maxFiles || read.bytesRead > context.limits.maxBytes || read.unit && read.recordsRead < read.unit.targets.length + read.unit.evidence.length) throw new EvolutionError("review_source_budget_exceeded");
    charge(batch, "records", read.recordsRead - context.limits.maxRecords); charge(batch, "files", read.filesRead - context.limits.maxFiles); charge(batch, "bytes", read.bytesRead - context.limits.maxBytes);
    await persist();
    if (!read.unit || read.unit.id !== original.inputUnitId) throw new EvolutionError("review_source_changed");
    this.assertUnit(read.unit, batch);
    const validation = validateEvolutionApprovedProposal(original, read.unit, batch.scope, approval, this.now());
    if (!["allowed", "noop"].includes(validation.outcome)) return { status: "blocked", reason: validation.reasons[0] ?? "approval_not_allowed" };
    const staged = await this.options.repository.getProposal(proposalId, this.scopeFingerprint);
    const proposal = await this.options.repository.stageProposal({ ...original, id: proposalId, batchId: batch.id, reviewedProposalId: original.id, ownerApprovalReceiptId: approval.id, validation, status: validation.outcome === "noop" ? "noop" : "staged", createdAt: staged?.createdAt ?? this.now() }, stageEvolutionEvidence(original, read.unit), lease);
    const outcome = await this.processProposal(proposal, read.unit, input, batch, lease, persist, signal, approval);
    if (outcome.blocked) return { status: "blocked", reason: outcome.blocked };
    batch.counts.proposed = 1;
    if (outcome.count) batch.counts[outcome.count] = 1;
    if (read.checkpoint) {
      assertEvolutionCheckpoint(read.checkpoint);
      batch.snapshot = read.checkpoint.snapshot; batch.cursor = read.checkpoint.cursor;
      await persist();
      await input.acknowledge?.({ ...this.context(batch, signal), ...read.checkpoint, action: "apply_allowed", proposalId: proposal.id });
    }
    return { status: outcome.count === "review" || outcome.count === "rejected" ? "blocked" : "completed" };
  }
  private reason(reason: string): string { return /^[a-z][a-z0-9_]{0,95}$/.test(reason) ? reason : "input_verification_failed"; }
  private assertUnit(unit: EvolutionInputUnit, batch: EvolutionBatch): void {
    if (!unit.id || unit.id.length > 256 || !/^[0-9a-f]{64}$/.test(unit.snapshotHash) || unit.targets.length > 8 || unit.evidence.length > 8 || !unit.evidence.length || Buffer.byteLength(JSON.stringify(unit)) > 128_000 || unit.evidence.some(e => e.text.length > 32768) || unit.targets.some(t => t.text.length > 32768)) throw new EvolutionError("input_unit_invalid");
    if ([unit.scope, ...unit.targets.map(t => t.scope), ...unit.evidence.map(e => e.scope)].some(s => authorityScopeFingerprint(s) !== this.scopeFingerprint)) throw new EvolutionError("scope_mismatch");
    if (batch.request.action !== "preview" && [...unit.evidence, ...unit.targets].some(item => redactSecrets(item.text).redactedCount > 0)) throw new EvolutionError("input_redaction_required");
  }
  private async chargeVerification(batch: EvolutionBatch, unit: EvolutionInputUnit, persist: () => Promise<void>, signal?: AbortSignal): Promise<EvolutionInputContext> {
    const cost = unit.verificationBudget ?? { records: unit.evidence.length, files: 0, bytes: unit.evidence.reduce((n, e) => n + Buffer.byteLength(e.text), 0) };
    for (const key of ["records", "files", "bytes"] as const) {
      if (!Number.isSafeInteger(cost[key]) || cost[key] < 0) throw new EvolutionError("verification_budget_invalid");
      const maximum = key === "records" ? batch.request.limits.maxRecords : key === "files" ? batch.request.limits.maxFiles : batch.request.limits.maxBytes;
      if (segmentUsage(batch)[key] + cost[key] > maximum) throw new EvolutionError(`max_${key}`);
    }
    if (cost.records < unit.evidence.length) throw new EvolutionError("verification_budget_invalid");
    for (const key of ["records", "files", "bytes"] as const) charge(batch, key, cost[key]);
    await persist();
    const context = this.context(batch, signal);
    return { ...context, limits: { ...context.limits, maxRecords: cost.records, maxFiles: cost.files, maxBytes: cost.bytes } };
  }
  private async verify(input: EvolutionInputPort, unit: EvolutionInputUnit, context: EvolutionInputContext, batch: EvolutionBatch): Promise<{ valid: boolean; reason?: string }> {
    const verification = await input.verifyUnit(unit, context);
    if (verification.bytesRead !== undefined) {
      if (!Number.isSafeInteger(verification.bytesRead) || verification.bytesRead < 0 || verification.bytesRead > context.limits.maxBytes) throw new EvolutionError("verification_budget_exceeded");
      charge(batch, "bytes", verification.bytesRead - context.limits.maxBytes);
    }
    return verification;
  }
  private async processProposal(proposal: EvolutionProposal, unit: EvolutionInputUnit, input: EvolutionInputPort, batch: EvolutionBatch, lease: EvolutionLease, persist: () => Promise<void>, signal: AbortSignal, approval?: EvolutionReviewReceipt): Promise<{ blocked?: string; proposalId?: string; count?: "applied" | "rejected" | "review" | "noop" }> {
    if (signal.aborted) throw new EvolutionError("cancelled");
    const validation = proposal.validation;
    const invalidate = async (count: "review" | "rejected", reason: string) => {
      const safeReason = this.reason(reason);
      batch.reasons = [...new Set([...batch.reasons, safeReason])].slice(-32);
      const stored = await this.options.repository.stageProposal({ ...proposal,
        id: deterministicUuid(`evolution-result:${proposal.id}:${count}:${safeReason}`), status: count,
        ...(count === "rejected" ? { quotes: [] } : {}),
        validation: { outcome: count, reasons: [safeReason], reviewRequirement: count === "review" ? "owner" : "none", independentEvidenceRootIds: [], contextEligible: false },
      }, count === "rejected" ? [] : stageEvolutionEvidence(proposal, unit), lease);
      return { count, proposalId: stored.id };
    };
    batch.reasons = [...new Set([...batch.reasons, ...validation.reasons.filter(r => r !== "kind_only_lookup_only")])].slice(-32);
    if (validation.reviewRequirement === "owner" || validation.outcome === "review") return { count: "review" };
    if (validation.outcome === "rejected") return { count: "rejected" };
    if (validation.outcome === "noop") return { count: "noop" };
    if (batch.request.action === "propose") return {};
    const repository = this.options.repository;
    const receipt = await repository.getReceipt(proposal.id, this.scopeFingerprint);
    if (receipt) return { count: receipt.outcome === "applied" ? "applied" : "noop" };
    if (!this.options.writer?.supportedOperations.includes(proposal.operation)) return { blocked: "operation_capability_unavailable" };
    const verification = await this.chargeVerification(batch, unit, persist, signal);
    const verified = await this.verify(input, unit, verification, batch);
    if (!verified.valid) return invalidate("rejected", verified.reason ?? "source_changed");
    if (segmentUsage(batch).records + proposal.targetRefs.length > batch.request.limits.maxRecords) throw new EvolutionError("max_records");
    charge(batch, "records", proposal.targetRefs.length);
    await persist();
    const targets = await input.readTargets(proposal.targetRefs, this.context(batch, signal));
    const current = approval ? validateEvolutionApprovedProposal(proposal, { ...unit, targets }, batch.scope, approval, this.now()) : validateEvolutionProposal(draftOf(proposal), { ...unit, targets }, batch.scope);
    if (current.outcome === "rejected") return invalidate("rejected", current.reasons[0] ?? "target_cas_conflict");
    if (current.outcome === "review") return invalidate("review", current.reasons[0] ?? "owner_review_required");
    if (current.outcome === "noop") return { count: "noop" };
    if (evolutionHash(current) !== evolutionHash(validation)) return invalidate("review", "validation_changed");
    const transactionVerification = await this.chargeVerification(batch, unit, persist, signal);
    let verifiedInTransaction = false;
    const applied = await this.options.writer.apply({ proposal, evidence: stageEvolutionEvidence(proposal, unit), authority: this.options.authority, lease, signal, ...(approval ? { approval } : {}), verifySource: async () => {
      if (signal.aborted) return { valid: false, reason: "cancelled" };
      if (verifiedInTransaction) return { valid: false, reason: "verification_budget_exhausted" };
      verifiedInTransaction = true;
      return this.verify(input, unit, transactionVerification, batch);
    } });
    if ("reason" in applied) return applied.outcome === "blocked" ? { blocked: this.reason(applied.reason) } : invalidate("rejected", applied.reason);
    const committed = await repository.getReceipt(proposal.id, this.scopeFingerprint);
    if (!committed || committed.id !== applied.receipt.id || committed.batchId !== batch.id || committed.operation !== proposal.operation) return { blocked: "apply_receipt_missing" };
    return { count: committed.outcome === "applied" ? "applied" : "noop" };
  }
}
