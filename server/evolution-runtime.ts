import { join } from "node:path";
import type { AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { resolveHomeDir } from "../packages/core/src/runtime/paths.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { MemoryWriteKernel, type MemoryWriteKernelDependencies } from "../packages/core/src/service/write-kernel.js";
import { MemoryEvolutionBatchService } from "../packages/core/src/evolution/batch-service.js";
import { MemoryEvolutionReviewService } from "../packages/core/src/evolution/review-service.js";
import { BoundedEvolutionProposalSource } from "../packages/core/src/evolution/proposal-source.js";
import { InventoryEvolutionInput } from "../packages/core/src/evolution/inventory-input.js";
import { DirectoryEvolutionInput } from "../packages/core/src/evolution/directory-input.js";
import { AttestedEvolutionInput } from "../packages/core/src/evolution/attested-input.js";
import { EvolutionAttestedProposalInput } from "./evolution-attested-proposal-input.js";
import { EvolutionInputBudget } from "./evolution-input-budget.js";
import { LlmEvolutionProposer } from "../packages/core/src/evolution/proposer.js";
import { createEvolutionRawEvidenceMaterializer } from "../packages/core/src/evolution/governed-evidence-materializer.js";
import type { PostgresEvolutionVerifiedInput } from "../packages/core/src/evolution/governed-writer.js";
import { EvolutionError } from "../packages/core/src/evolution/schema.js";
import type { EvolutionBatch, EvolutionBatchReport, EvolutionEvidence, EvolutionInputPort, EvolutionInputUnit, EvolutionReviewActor } from "../packages/core/src/evolution/types.js";
import {
  assertPostgresBundleOwnsEvolutionPersistence, assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import {
  assertDurableJobV2, deriveDurableJobV2ScopedDedupeKey, type DurableJobV2,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import type { EvolutionBatchCapability } from "../packages/api/src/evolution.js";
import { assertEvolutionOwnerRequest } from "../packages/api/src/evolution-owner-auth.js";
import { DurableJobV2HandlerFailure, type DurableJobV2Handler, type DurableJobV2HandlerContext } from "./workers-v2.js";
import type { GlobalEvolutionConfig } from "./evolution-config.js";
import { evolutionJobIdentity } from "./evolution-job.js";
import { createEvolutionHostControl, assertEvolutionHostControlOwner, type EvolutionHostControl } from "./evolution-control.js";
import { createEvolutionMaintenance, type EvolutionMaintenanceDriver, type EvolutionMaintenanceResult, type EvolutionMaintenanceReservation } from "./evolution-maintenance.js";
import type { EvolutionActivity } from "./evolution-activity.js";
import { withEvolutionSessionLeaseHook } from "./evolution-session-lease.js";
import { createEvolutionControlWork } from "./evolution-control-work.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";

export interface EvolutionRuntime {
  readonly hostControl: EvolutionHostControl;
  readonly capability: EvolutionBatchCapability;
  readonly handler: DurableJobV2Handler;
  readonly assertReady: () => Promise<void>;
  readonly onIdle: (signal: AbortSignal) => Promise<void>;
  readonly maintenanceStatus: () => EvolutionMaintenanceSnapshot;
}
export interface EvolutionMaintenanceSnapshot {
  enabled: boolean; status: EvolutionMaintenanceResult["status"]; reasons: string[]; updatedAt: number;
  batchId?: string; jobId?: string; budgetReserved: boolean;
  localFreeBytes: number | null; databaseFreeBytes: null;
}
const OWNERS = new WeakMap<object, { bundle: PostgresDurableJobV2RuntimeBundle; scope: DurableJobV2Scope }>();

export function assertEvolutionRuntimeOwner(value: EvolutionRuntime | undefined, bundle: PostgresDurableJobV2RuntimeBundle, scope: DurableJobV2Scope): EvolutionRuntime {
  const owner = value && OWNERS.get(value);
  if (!owner || owner.bundle !== bundle || !sameJobScope(owner.scope, scope)) throw new Error("EVOLUTION_RUNTIME_OWNER_MISMATCH");
  return value!;
}

function sameJobScope(left: DurableJobV2Scope, right: DurableJobV2Scope): boolean {
  return ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"]
    .every(key => left[key as keyof DurableJobV2Scope] === right[key as keyof DurableJobV2Scope]);
}

/** One host capability and one handler on the existing provider-owned durable worker. */
export function createEvolutionRuntime(input: {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly authority: AuthorityScope;
  readonly scope: MemoryScope;
  readonly config: GlobalEvolutionConfig;
  readonly llmClient: LlmClient;
  readonly kernelDependencies: (verified?: PostgresEvolutionVerifiedInput) => Omit<MemoryWriteKernelDependencies, "transaction">;
  readonly onCommitted: (memoryIds: readonly string[]) => void | Promise<void>;
  readonly onWarning?: () => void;
  readonly hostControl?: EvolutionHostControl;
  readonly reuse?: NonNullable<EvolutionBatchCapability["reuse"]>;
  readonly maintenanceHost?: { activity: EvolutionActivity; backgroundMode: () => "all" | "paused" | "evolution_only" };
}): EvolutionRuntime {
  const bundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(input.runtimeBundle);
  if (!bundle.handlerTypes.includes("evolve_memory_batch" as never) || !bundle.createEvolutionPersistence) {
    throw new Error("EVOLUTION_PROVIDER_CAPABILITY_UNAVAILABLE");
  }
  const scope = Object.freeze(structuredClone(input.scope));
  const scopeFingerprint = authorityScopeFingerprint(scope);
  const hostControl = assertEvolutionHostControlOwner(input.hostControl ?? createEvolutionHostControl({
    persistence: bundle.createEvolutionPersistence(scope, {}), authority: input.authority, scope, config: input.config,
  }), bundle, scope, input.config.configFingerprint);
  const manifestRoot = join(resolveHomeDir(), "evolution", "sources", scopeFingerprint);
  const authority = structuredClone(input.authority);
  const jobScope: DurableJobV2Scope = Object.freeze({
    tenantId: scope.tenantId, userId: scope.userId, appId: scope.appId, projectId: scope.projectId,
    agentId: scope.agentId, namespace: scope.namespace, visibility: scope.visibility!,
  });
  deriveDurableJobV2ScopedDedupeKey(jobScope, "evolution-runtime");
  const maintenanceEnabled = input.config.config.evolution?.maintenance?.enabled === true;
  let maintenance: EvolutionMaintenanceDriver;
  let maintenanceState: EvolutionMaintenanceSnapshot = { enabled: maintenanceEnabled, status: "idle",
    reasons: [maintenanceEnabled ? "maintenance_not_polled" : "maintenance_disabled"], updatedAt: Date.now(), budgetReserved: false,
    localFreeBytes: null, databaseFreeBytes: null };
  const recordMaintenance = (result: EvolutionMaintenanceResult) => {
    maintenanceState = { enabled: maintenanceEnabled, status: result.status, reasons: result.reasons.slice(0, 8), updatedAt: Date.now(),
      ...(result.batchId ? { batchId: result.batchId } : {}), ...(result.jobId ? { jobId: result.jobId } : {}), budgetReserved: !!result.reservation,
      localFreeBytes: input.maintenanceHost?.activity.snapshot().localFreeBytes ?? null, databaseFreeBytes: null };
  };
  const sampleStorage = async (signal: AbortSignal) => {
    const host = input.maintenanceHost;
    if (!maintenanceEnabled || !host || host.backgroundMode() !== "all") return;
    const activity = host.activity.snapshot();
    if (activity.foregroundBusy || Date.now() - activity.lastForegroundAt < input.config.config.evolution!.maintenance!.quietPeriodMs) return;
    await host.activity.refreshStorage(signal);
  };

  const session = (job?: DurableJobV2, signal?: AbortSignal) => {
    const evidenceCache = new Map<string, EvolutionEvidence>();
    let budgetInputs: EvolutionInputBudget[] = [];
    let rawKernel: MemoryWriteKernel;
    const persistence = assertPostgresBundleOwnsEvolutionPersistence(bundle, bundle.createEvolutionPersistence!(scope, {
      job, signal, kernelDependencies: input.kernelDependencies,
      writer: {
        assertApplyInTransaction: (client, context) => {
          const port = budgetInputs.find(input => input.hasVerifiedApply(context));
          if (!port) throw new EvolutionError("attestation_transaction_budget_exhausted");
          return port.assertApplyInTransaction(client, context);
        },
        hydrateEvidence: async context => [...new Set(context.evidence.map(span => span.id))].map(id => {
          const evidence = evidenceCache.get(id);
          if (!evidence || context.evidence.some(span => span.id === id &&
              (evidence.snapshotHash !== span.snapshotHash || evidence.revision !== span.revision))) {
            throw new EvolutionError("trusted_evidence_unavailable");
          }
          return structuredClone(evidence);
        }),
        materializeEvidence: verified => createEvolutionRawEvidenceMaterializer(rawKernel)(verified),
      },
    }), scope, job);
    rawKernel = new MemoryWriteKernel({ ...input.kernelDependencies(), transaction: work => persistence.evidenceTransactionPort.transaction(work) });
    const inventory = new InventoryEvolutionInput(persistence.inventory);
    const directory = new DirectoryEvolutionInput({
      sources: input.config.sources.map(binding => ({
        binding,
        manifestPath: join(manifestRoot, binding.sourceId, "manifest.json"),
      })),
      repository: persistence.repository, configFingerprint: input.config.configFingerprint,
      readTargets: (refs, context) => inventory.readTargets(refs, context),
      resolveTargets: persistence.relatedTargets.resolve,
    });
    const rememberEvidence = (units: readonly EvolutionInputUnit[]) => {
      evidenceCache.clear();
      for (const unit of units) for (const evidence of unit.evidence) evidenceCache.set(evidence.id, structuredClone(evidence));
    };
    const remember = (port: EvolutionInputPort): EvolutionInputPort => ({
      mode: port.mode, open: context => port.open(context),
      readPage: async context => {
        const page = await port.readPage(context);
        rememberEvidence(page.units);
        return page;
      },
      verifyUnit: (unit, context) => port.verifyUnit(unit, context),
      readTargets: (refs, context) => port.readTargets(refs, context),
      ...(port.readProposal ? { readProposal: async (...args: Parameters<NonNullable<EvolutionInputPort["readProposal"]>>) => {
        const read = await port.readProposal!(...args);
        rememberEvidence(read.unit ? [read.unit] : []);
        return read;
      } } : {}),
      ...(port.acknowledge ? { acknowledge: (...args: Parameters<NonNullable<EvolutionInputPort["acknowledge"]>>) => port.acknowledge!(...args) } : {}),
    });
    const sourceInputs: EvolutionInputPort[] = [inventory, directory];
    budgetInputs = sourceInputs.map(port => new EvolutionInputBudget(
      input.config.config.evolution?.attestation?.trustedIssuers.length
        ? port.readProposal ? new EvolutionAttestedProposalInput(port, hostControl.attestation.port)
          : new AttestedEvolutionInput(port, hostControl.attestation.port) : port,
      hostControl.attestation,
    ));
    const inputs = budgetInputs.map(remember);
    const proposalSource = new BoundedEvolutionProposalSource(inputs);
    const control = createEvolutionControlWork({ runtimeBundle: bundle, persistence, job, authority, scope,
      config: input.config, hostControl, manifestRoot, onCommitted: input.onCommitted, onWarning: input.onWarning });
    let reservation: EvolutionMaintenanceReservation | undefined;
    const serviceRepository = job ? withEvolutionSessionLeaseHook(persistence.repository, async lease => {
      if (!reservation || signal?.aborted) return;
      try {
        const batch = await persistence.repository.getBatch(lease.batchId, scopeFingerprint);
        if (!batch) throw new EvolutionError("batch_not_found");
        recordMaintenance(await maintenance.afterBatch({ job, persistence, lease, batch, signal }));
        // Batch usage is reserved budget, not provider usage. Unknown actuals retain the reservation.
        recordMaintenance(await maintenance.settleReservation({ batch, reservation, signal }));
      } catch { input.onWarning?.(); }
    }) : persistence.repository;
    const service = new MemoryEvolutionBatchService({
      authority, scope, configFingerprint: input.config.configFingerprint,
      repository: serviceRepository, reviews: persistence.repository, inputs, proposalSource,
      control: control.port,
      proposer: new LlmEvolutionProposer(input.llmClient, { maxAttempts: 1 }),
      writer: {
        supportedOperations: persistence.writer.supportedOperations,
        apply: async context => {
          const result = await persistence.writer.apply(context);
          if (result.outcome === "applied") {
            try { await input.onCommitted(result.receipt.memoryIds); }
            catch { input.onWarning?.(); }
          }
          return result;
        },
      },
    });
    const review = (actor: EvolutionReviewActor) => new MemoryEvolutionReviewService({
      authority, scope, actor, repository: persistence.repository, source: proposalSource,
      configFingerprint: input.config.configFingerprint,
    });
    return { service, review, governance: control.governance, persistence, close: () => directory.close(), assertReady: persistence.assertReady,
      beforeBatch: async (batch: EvolutionBatch) => {
        if (batch.request.action === "execute_control") return;
        if (batch.request.idempotencyKey.startsWith("evolution-maintenance:")) await sampleStorage(signal ?? new AbortController().signal);
        const result = await maintenance.beforeBatch(batch, signal);
        if (result.status !== "not_maintenance") recordMaintenance(result);
        if (!["not_maintenance", "admitted"].includes(result.status)) throw new DurableJobV2HandlerFailure("EVOLUTION_MAINTENANCE_DEFERRED", result.status === "deferred");
        reservation = result.reservation;
      },
    };
  };
  const withReview = async <T>(work: (review: MemoryEvolutionReviewService) => Promise<T>): Promise<T> => {
    const owner = assertEvolutionOwnerRequest(authority);
    const current = session();
    try { return await work(current.review({ ...owner, actorId: "runtime-host-owner", authentication: "authenticated_owner" })); }
    finally { await current.close(); }
  };
  const withSession = async <T>(work: (service: MemoryEvolutionBatchService) => Promise<T>, job?: DurableJobV2, signal?: AbortSignal): Promise<T> => {
    const current = session(job, signal);
    try { return await work(current.service); }
    finally { await current.close(); }
  };
  const enqueue = async (report: EvolutionBatchReport): Promise<EvolutionBatchReport> => {
    if (report.status !== "queued") return report;
    const segmentAttempt = report.segment?.attempt;
    if (!Number.isSafeInteger(segmentAttempt) || segmentAttempt! < 1) throw new Error("EVOLUTION_SEGMENT_INVALID");
    const { id, dedupeKey } = evolutionJobIdentity(scope, report.batchId, segmentAttempt!);
    let control: { kind: string; requestHash: string } | undefined;
    if (report.work && report.work.kind !== "memory_evolution") {
      const current = session();
      try {
        const batch = await current.persistence.repository.getBatch(report.batchId, scopeFingerprint);
        if (!batch || batch.request.action !== "execute_control" || batch.request.input.work.kind !== report.work.kind ||
          batch.segment?.attempt !== segmentAttempt || batch.requestHash !== evolutionHash(batch.request)) throw new Error("EVOLUTION_CONTROL_BATCH_INVALID");
        control = { kind: batch.request.input.work.kind, requestHash: batch.requestHash };
      } finally { await current.close(); }
    }
    await bundle.assertEnqueueReady();
    const job = await bundle.repository.enqueue({
      id, type: "evolve_memory_batch",
      payload: { batchId: report.batchId, segmentAttempt, ...(control ? { control } : {}) }, dedupeKey, scope: jobScope, maxAttempts: 3,
    });
    assertDurableJobV2(job);
    if (job.id !== id || job.type !== "evolve_memory_batch" || job.dedupeKey !== dedupeKey || !sameJobScope(job.scope, jobScope) ||
        job.payload.batchId !== report.batchId || job.payload.segmentAttempt !== segmentAttempt ||
        evolutionHash(job.payload.control ?? null) !== evolutionHash(control ?? null)) {
      throw new Error("EVOLUTION_ENQUEUE_RESULT_INVALID");
    }
    return report;
  };
  maintenance = createEvolutionMaintenance({ runtimeBundle: bundle, authority, scope, config: input.config,
    environment: () => ({ ...(input.maintenanceHost?.activity.snapshot() ?? { foregroundBusy: false, lastForegroundAt: Date.now() }),
      // A host filesystem sample cannot attest free space on the PostgreSQL backing volume.
      freeBytes: null, backgroundMode: input.maintenanceHost?.backgroundMode() ?? "paused" }),
    prepareBatch: async (request, signal) => {
      const current = session();
      try {
        signal?.throwIfAborted();
        const report = await current.service.prepare(request);
        const batch = await current.persistence.repository.getBatch(report.batchId, scopeFingerprint);
        if (!batch) throw new EvolutionError("batch_not_found");
        return batch;
      } finally { await current.close(); }
    },
    enqueueBatch: async (batch, signal) => {
      signal?.throwIfAborted();
      const report = await withSession(service => service.status(batch.id));
      if (!report || report.status !== "queued" || report.segment?.attempt !== 1) throw new EvolutionError("maintenance_batch_mismatch");
      await enqueue(report);
      return { batchId: report.batchId, segmentAttempt: 1, jobId: evolutionJobIdentity(scope, report.batchId, 1).id };
    },
  });
  const runtime: EvolutionRuntime = Object.freeze({
    hostControl,
    maintenanceStatus: () => structuredClone(maintenanceState),
    onIdle: async (signal: AbortSignal) => {
      if (!maintenanceEnabled) { recordMaintenance({ status: "deferred", reasons: ["maintenance_disabled"] }); return; }
      await sampleStorage(signal);
      recordMaintenance(await maintenance.idleTick(signal));
    },
    capability: Object.freeze({
      sourceControl: hostControl.capability,
      control: Object.freeze({
        run: (request, signal) => withSession(service => {
          signal?.throwIfAborted();
          return service.prepareControl(request).then(enqueue);
        }, undefined, signal),
        previewUndo: async (request, signal) => {
          const current = session(undefined, signal);
          try { return await current.governance.previewUndo(request, signal); } finally { await current.close(); }
        },
        approveUndo: async (request, signal) => {
          const current = session(undefined, signal);
          try { return await current.governance.approveUndo(request, signal); } finally { await current.close(); }
        },
      } satisfies NonNullable<EvolutionBatchCapability["control"]>),
      ...(input.reuse ? { reuse: input.reuse } : {}),
      run: (request, signal) => withSession(service => {
        signal?.throwIfAborted();
        if (request.input.mode === "directory" && !input.config.sources.some(source =>
          request.input.mode === "directory" && source.sourceId === request.input.sourceId)) {
          throw new EvolutionError("source_not_registered");
        }
        return request.action === "preview" ? service.run(request, signal) : service.prepare(request).then(enqueue);
      }),
      status: batchId => withSession(service => service.status(batchId)),
      resume: (batchId, signal) => withSession(async service => {
        signal?.throwIfAborted();
        return enqueue(await service.prepareResume(batchId));
      }),
      cancel: async batchId => {
        assertEvolutionOwnerRequest(authority);
        return withSession(service => service.cancel(batchId));
      },
      review: Object.freeze({
        list: request => withReview(review => review.list(request)),
        detail: proposalId => withReview(review => review.detail(proposalId)),
        preview: proposalId => withReview(review => review.preview(proposalId)),
        status: reviewId => withReview(review => review.status(reviewId)),
        decide: request => withReview(review => review.decide(request)),
        apply: async approvalReceiptId => {
          assertEvolutionOwnerRequest(authority);
          return withSession(service => service.prepareApproved(approvalReceiptId).then(enqueue));
        },
      } satisfies NonNullable<EvolutionBatchCapability["review"]>),
    } satisfies EvolutionBatchCapability),
    handler: async (job: DurableJobV2, context: DurableJobV2HandlerContext) => {
      try {
        assertDurableJobV2(job);
        const control = job.payload.control;
        if (control !== undefined && (!control || typeof control !== "object" || Array.isArray(control) || Object.keys(control).length !== 2 ||
            !("kind" in control) || !["source_reconcile", "source_revoke", "undo_governance"].includes(String(control.kind)) ||
            !("requestHash" in control) || typeof control.requestHash !== "string" || !/^[a-f0-9]{64}$/.test(control.requestHash))) throw new Error("invalid control");
        if (job.type !== "evolve_memory_batch" || job.status !== "running" || !sameJobScope(job.scope, jobScope) ||
            !job.payload || Object.keys(job.payload).length !== (control === undefined ? 2 : 3) ||
            typeof job.payload.batchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.payload.batchId) ||
            !Number.isSafeInteger(job.payload.segmentAttempt) || (job.payload.segmentAttempt as number) < 1 ||
            job.dedupeKey !== `evolve_memory_batch:${job.payload.batchId}:${job.payload.segmentAttempt}`) {
          throw new Error("invalid job");
        }
      } catch { throw new DurableJobV2HandlerFailure("EVOLUTION_INVALID_JOB", false); }
      context.signal.throwIfAborted();
      const current = session(job, context.signal);
      try {
        const previous = await current.service.status(job.payload.batchId as string);
        if (!previous) throw new DurableJobV2HandlerFailure("EVOLUTION_BATCH_NOT_FOUND", false);
        // A delayed old job may not consume an explicitly authorized later segment.
        if (previous.segment?.attempt !== job.payload.segmentAttempt) return previous;
        const batch = await current.persistence.repository.getBatch(previous.batchId, scopeFingerprint);
        if (!batch) throw new DurableJobV2HandlerFailure("EVOLUTION_BATCH_NOT_FOUND", false);
        const expected = batch.request.action === "execute_control" ? { kind: batch.request.input.work.kind, requestHash: batch.requestHash } : null;
        if (evolutionHash(job.payload.control ?? null) !== evolutionHash(expected) ||
            expected && evolutionHash(batch.request) !== expected.requestHash) throw new DurableJobV2HandlerFailure("EVOLUTION_CONTROL_JOB_MISMATCH", false);
        if (!["completed", "cancelled"].includes(batch.status) && batch.cancelRequestedAt === undefined) await current.beforeBatch(batch);
        const report = await current.service.retry(previous.batchId, context.signal);
        if (report.status === "failed" || report.reasons.includes("batch_leased")) {
          throw new DurableJobV2HandlerFailure("EVOLUTION_BATCH_RETRY", true);
        }
        return report;
      } finally { await current.close(); }
    },
    assertReady: () => withSession(async () => { await bundle.assertReady(); }),
  });
  OWNERS.set(runtime, { bundle, scope: jobScope });
  return runtime;
}
