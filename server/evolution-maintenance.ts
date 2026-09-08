import { resolveAuthorityScope, type AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { assertPostgresBundleOwnsEvolutionPersistence, assertProviderOwnedPostgresDurableJobV2RuntimeBundle, type PostgresDurableJobV2RuntimeBundle, type PostgresEvolutionPersistence } from "../packages/core/src/db/providers/postgres.js";
import type { DurableJobV2 } from "../packages/core/src/storage/repositories/job-v2.js";
import type { EvolutionBatch, EvolutionLease, EvolutionLimits, EvolutionRunRequest } from "../packages/core/src/evolution/types.js";
import { PostgresEvolutionBudgetLedger, type EvolutionBudgetReservation } from "../packages/core/src/evolution/postgres-budget.js";
import { PostgresEvolutionRepository } from "../packages/core/src/evolution/postgres-repository.js";
import { PostgresEvolutionMaintenancePort } from "../packages/core/src/evolution/postgres-maintenance.js";
import { jsonHash, lockLease } from "../packages/core/src/evolution/postgres-common.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { parseEvolutionRunRequest } from "../packages/core/src/evolution/schema.js";
import { planMaintenance } from "../packages/core/src/evolution/maintenance/planner.js";
import { cleanupMaintenance, recordMaintenanceOutcome } from "../packages/core/src/evolution/maintenance/retention.js";
import type { MaintenanceBudget, MaintenanceOutcome } from "../packages/core/src/evolution/maintenance/types.js";
import { estimateRuntimeCost, type RuntimePricingSnapshot } from "../packages/core/src/cost/runtime-cost.js";
import { runtimePricingSnapshotFromConfig } from "../packages/core/src/cost/runtime-pricing.js";
import type { GlobalEvolutionConfig } from "./evolution-config.js";
import { evolutionJobIdentity } from "./evolution-job.js";

export interface EvolutionMaintenanceEnvironment {
  backgroundMode: "all" | "paused" | "evolution_only";
  foregroundBusy: boolean;
  lastForegroundAt: number;
  /** Host-measured available space for the backing store; null means unknown, never unlimited. */
  freeBytes: number | null;
}
export interface EvolutionMaintenanceOptions {
  runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  authority: AuthorityScope;
  scope: MemoryScope;
  config: GlobalEvolutionConfig;
  environment: () => EvolutionMaintenanceEnvironment;
  /** Existing service.prepare only, followed by its exact persisted batch; no source/model IO. */
  prepareBatch: (request: EvolutionRunRequest, signal?: AbortSignal) => Promise<EvolutionBatch>;
  /** Existing evolve_memory_batch queue, never run/resume or another scheduler. */
  enqueueBatch: (batch: EvolutionBatch, signal?: AbortSignal) => Promise<{ batchId: string; segmentAttempt: number; jobId: string }>;
  limits?: Partial<EvolutionLimits>;
  dueLimit?: number;
  retentionLimit?: number;
  now?: () => number;
}
export interface EvolutionMaintenanceReservation extends EvolutionBudgetReservation {
  batchId: string;
  scopeFingerprint: string;
  segmentAttempt: 1;
  currency: string;
  pricingSnapshotVersion: string;
}
export interface EvolutionMaintenanceResult {
  status: "queued" | "idle" | "admitted" | "retained" | "settled" | "completed" | "deferred" | "blocked" | "not_maintenance";
  reasons: string[];
  batchId?: string;
  jobId?: string;
  reservation?: EvolutionMaintenanceReservation;
  deleted?: string[];
  preserved?: string[];
  outcomesRecorded?: number;
  outcomeEventsPruned?: number;
}
export interface EvolutionMaintenanceFencedInput {
  job: DurableJobV2;
  persistence: PostgresEvolutionPersistence;
  lease: EvolutionLease;
  batch: EvolutionBatch;
  outcomes?: readonly { outcome: MaintenanceOutcome; attemptId: string; failureCount: number }[];
  signal?: AbortSignal;
}
export interface EvolutionMaintenanceActualUsage {
  batchId: string;
  scopeFingerprint: string;
  segmentAttempt: 1;
  complete: true;
  provider: string;
  model: string;
  currency: string;
  pricingSnapshotVersion: string;
  inputTokens: number;
  outputTokens: number;
  /** Complete matching RuntimeCostEvent sum. Missing pricing/attribution must leave this undefined. */
  estimatedMinorUnits?: number;
}
export interface EvolutionMaintenanceDriver {
  idleTick(signal?: AbortSignal): Promise<EvolutionMaintenanceResult>;
  /** Existing worker must call before retry; it cannot recharge a new explicit-resume segment. */
  beforeBatch(batch: EvolutionBatch, signal?: AbortSignal): Promise<EvolutionMaintenanceResult>;
  /** Call before the existing job/batch lease is released, with provider-minted fenced persistence. */
  afterBatch(input: EvolutionMaintenanceFencedInput): Promise<EvolutionMaintenanceResult>;
  /** Host ledger projection only. Missing/uncertain usage retains the entire reservation. */
  settleReservation(input: { batch: EvolutionBatch; reservation: EvolutionMaintenanceReservation; usage?: EvolutionMaintenanceActualUsage; signal?: AbortSignal }): Promise<EvolutionMaintenanceResult>;
}

const PREFIX = "evolution-maintenance:";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const terminal = new Set(["completed", "partial", "blocked", "cancelled"]);
class MaintenanceStop extends Error {
  constructor(readonly code: string, readonly status: "deferred" | "blocked" = "blocked") { super(code); }
}
function stop(code: string, status?: "deferred" | "blocked"): never { throw new MaintenanceStop(code, status); }
function count(value: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) stop("maintenance_config_invalid"); return value;
}
function result(status: EvolutionMaintenanceResult["status"], reason?: string): EvolutionMaintenanceResult { return { status, reasons: reason ? [reason] : [] }; }
function failed(error: unknown, fallback: string, signal?: AbortSignal): EvolutionMaintenanceResult {
  if (signal?.aborted) return result("deferred", "maintenance_cancelled");
  if (error instanceof MaintenanceStop) return result(error.status, error.code);
  if (error && typeof error === "object" && "code" in error && ["EVOLUTION_CONNECTION_ACQUIRE_TIMEOUT", "EVOLUTION_TRANSACTION_TIMEOUT", "EVOLUTION_QUERY_CANCELLED"].includes(String(error.code))) return result("deferred", "maintenance_query_deferred");
  if (error && typeof error === "object" && "code" in error && ["LOCK_BUSY", "QUERY_TIMEOUT", "55P03", "57014", "STALE_LEASE", "STALE_BATCH_OR_LEASE"].includes(String(error.code))) return result("deferred", "maintenance_lock_busy");
  return result("blocked", fallback);
}
function whole(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) stop("maintenance_price_overflow"); return Number(value);
}

class NativeEvolutionMaintenance implements EvolutionMaintenanceDriver {
  readonly #now: () => number;
  readonly #scope: MemoryScope;
  readonly #authority: AuthorityScope;
  readonly #configuredLimits: Partial<EvolutionLimits>;
  readonly #config: GlobalEvolutionConfig;
  #lastTick?: number;
  #ticking = false;
  #nativeState?: { persistence: PostgresEvolutionPersistence; ledger: PostgresEvolutionBudgetLedger; bundle: PostgresDurableJobV2RuntimeBundle };
  constructor(private readonly options: EvolutionMaintenanceOptions) {
    this.#scope = structuredClone(options.scope); this.#authority = structuredClone(options.authority);
    this.#configuredLimits = structuredClone(options.limits ?? {}); this.#config = structuredClone(options.config); this.#now = options.now ?? Date.now;
  }
  #assertScope() {
    const { appId, projectId, agentId, namespace, visibility } = this.#scope;
    try {
      if (authorityScopeFingerprint(resolveAuthorityScope(this.#authority, { appId, projectId, agentId, namespace, visibility })) !== authorityScopeFingerprint(this.#scope)) stop("maintenance_scope_mismatch");
    } catch { stop("maintenance_scope_mismatch"); }
  }
  #gate(signal?: AbortSignal) {
    if (signal?.aborted) stop("maintenance_cancelled", "deferred");
    if (this.#config.config.features?.continuousMemoryEvolution !== true || this.#config.config.evolution?.maintenance?.enabled === false) stop("maintenance_disabled", "deferred");
    const config = this.#config.config.evolution?.maintenance;
    if (!config || config.enabled !== true || !HASH.test(this.#config.configFingerprint)) stop("maintenance_config_invalid");
    count(config.intervalMs, 30 * 86400000, 60000); count(config.quietPeriodMs, 86400000, 1000);
    for (const value of [config.dailyTokens, config.dailyMinorUnits, config.maxStorageBytes, config.minFreeBytes]) count(value, Number.MAX_SAFE_INTEGER, 1);
    const now = count(this.#now()), environment = this.options.environment();
    if (!["all", "paused", "evolution_only"].includes(environment.backgroundMode) || typeof environment.foregroundBusy !== "boolean") stop("maintenance_environment_invalid");
    if (environment.backgroundMode !== "all") stop("maintenance_background_paused", "deferred");
    if (environment.foregroundBusy) stop("maintenance_foreground_busy", "deferred");
    if (count(environment.lastForegroundAt) > now || now - environment.lastForegroundAt < config.quietPeriodMs) stop("maintenance_foreground_quiet", "deferred");
    this.#assertScope();
    return { config, environment, now };
  }
  #dispatchGate(signal?: AbortSignal) {
    const state = this.#gate(signal);
    if (state.environment.freeBytes === null || !Number.isSafeInteger(state.environment.freeBytes) || state.environment.freeBytes < 0) stop("maintenance_free_space_unknown");
    if (state.environment.freeBytes < state.config.minFreeBytes) stop("maintenance_free_space");
    return state;
  }
  #limits(): EvolutionLimits {
    try {
      const parsed = parseEvolutionRunRequest({ input: { mode: "inventory", selection: "due" }, action: "propose", idempotencyKey: "host-maintenance", limits: this.#configuredLimits });
      if (!parsed.limits.maxLlmCalls || !parsed.limits.maxInputTokens || !parsed.limits.maxOutputTokens) stop("maintenance_budget_invalid");
      return parsed.limits;
    } catch { stop("maintenance_budget_invalid"); }
  }
  #pricing() {
    const snapshot = runtimePricingSnapshotFromConfig(this.#config.config), llm = this.#config.config.llm;
    if (!snapshot || !llm || !snapshot.version || !/^[A-Z]{3}$/.test(snapshot.currency) || snapshot.currency === "XXX" || snapshot.provider !== llm.provider || !Number.isSafeInteger(snapshot.minorUnitsPerMajor) || snapshot.minorUnitsPerMajor < 1 || snapshot.minorUnitsPerMajor > 1000000) stop("maintenance_unpriced");
    const model = llm.extractionModel ?? llm.model, prices = snapshot.models[model];
    if (!prices || ![prices.inputPerMillion, prices.outputPerMillion].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0)) stop("maintenance_unpriced");
    return { snapshot, model, provider: llm.provider };
  }
  #cost(snapshot: RuntimePricingSnapshot, model: string, inputTokens: number, outputTokens: number, calls: number): number {
    count(inputTokens); count(outputTokens); count(calls);
    const estimate = estimateRuntimeCost(snapshot, { provider: snapshot.provider, model, inputTokens, outputTokens, embeddingUnits: null, embeddingUnitKind: null });
    if (estimate.estimatedMinorUnits === null || !Number.isFinite(estimate.estimatedMinorUnits) || estimate.estimatedMinorUnits < 0) stop("maintenance_unpriced");
    // The shared estimator rounds each call to 1e-6 minor units. Keep that rounding margin and one micro-major unit.
    const micros = Math.ceil((estimate.estimatedMinorUnits * 1000000 + calls) / snapshot.minorUnitsPerMajor) + 1;
    if (!Number.isSafeInteger(micros) || micros < 1) stop("maintenance_price_overflow");
    return micros;
  }
  #workBudget(): MaintenanceBudget {
    const limits = this.#limits(), { snapshot, model } = this.#pricing();
    return { records: limits.maxRecords, files: limits.maxFiles, bytes: limits.maxBytes, llmCalls: limits.maxLlmCalls, inputTokens: limits.maxInputTokens, outputTokens: limits.maxOutputTokens, durationMs: limits.maxDurationMs,
      costMicros: this.#cost(snapshot, model, limits.maxInputTokens, limits.maxOutputTokens, limits.maxLlmCalls) };
  }
  #native() {
    if (this.#nativeState) return this.#nativeState;
    try {
      const bundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(this.options.runtimeBundle);
      if (!bundle.createEvolutionPersistence || typeof this.options.prepareBatch !== "function" || typeof this.options.enqueueBatch !== "function") stop("maintenance_native_unavailable");
      const persistence = assertPostgresBundleOwnsEvolutionPersistence(bundle, bundle.createEvolutionPersistence(this.#scope, {}), this.#scope);
      if (persistence.repository.scopeFingerprint !== authorityScopeFingerprint(this.#scope)) stop("maintenance_scope_mismatch");
      const ledger = new PostgresEvolutionBudgetLedger({ pool: persistence.repository.pool, owner: this.#scope, now: this.#now });
      this.#nativeState = { persistence, ledger, bundle }; return this.#nativeState;
    } catch (error) { if (error instanceof MaintenanceStop) throw error; stop("maintenance_native_unavailable"); }
  }
  async #storage(signal?: AbortSignal) {
    const { config } = this.#dispatchGate(signal);
    const usage = await this.#native().ledger.storageUsage();
    count(usage.databaseBytes); count(usage.evolutionBytes);
    if (usage.databaseBytes > config.maxStorageBytes || usage.evolutionBytes > config.maxStorageBytes) stop("maintenance_storage_pressure");
    this.#dispatchGate(signal);
  }
  #assertBatch(batch: EvolutionBatch, expected?: EvolutionRunRequest) {
    this.#assertScope();
    const fp = authorityScopeFingerprint(this.#scope);
    if (!batch || !ID.test(batch.id) || batch.id.length > 128 || authorityScopeFingerprint(batch.scope) !== fp || batch.scopeFingerprint !== fp) stop("maintenance_batch_mismatch");
    const parsed = parseEvolutionRunRequest(batch.request);
    if (!parsed.idempotencyKey.startsWith(PREFIX) || !HASH.test(parsed.idempotencyKey.slice(PREFIX.length)) || parsed.input.mode !== "inventory" || parsed.input.selection !== "due" || parsed.action !== "propose" || evolutionHash(parsed.limits) !== evolutionHash(this.#limits()) || evolutionHash(parsed) !== batch.requestHash || (expected && evolutionHash(parsed) !== evolutionHash(expected)) || batch.configFingerprint !== this.#config.configFingerprint || batch.approvedReplay || batch.segment?.attempt !== 1) stop("maintenance_batch_mismatch");
    const limits = this.#limits();
    for (const [key, value] of Object.entries(limits)) {
      const usageKey = `${key[3].toLowerCase()}${key.slice(4)}`;
      const used = batch.segment.usage[usageKey as keyof typeof batch.segment.usage];
      if (!Number.isSafeInteger(used) || used < 0 || used > value) stop("maintenance_batch_mismatch");
    }
  }
  #reservationKey(batch: EvolutionBatch, snapshot: RuntimePricingSnapshot): string {
    return evolutionHash(["host-maintenance-reservation-v1", batch.scopeFingerprint, batch.id, batch.requestHash, 1, snapshot]);
  }
  async #reserve(batch: EvolutionBatch, signal?: AbortSignal) {
    const { config } = this.#dispatchGate(signal), limits = this.#limits(), { snapshot } = this.#pricing(), budget = this.#workBudget();
    const tokens = count(limits.maxInputTokens + limits.maxOutputTokens);
    const dailyMicros = whole(BigInt(config.dailyMinorUnits) * 1000000n / BigInt(snapshot.minorUnitsPerMajor));
    const reserved = await this.#native().ledger.reserve({ idempotencyKey: this.#reservationKey(batch, snapshot), tokens, costMicros: budget.costMicros, limits: { tokens: config.dailyTokens, costMicros: dailyMicros } });
    if (!reserved) stop("maintenance_daily_budget", "deferred");
    this.#dispatchGate(signal);
    return { ...reserved, batchId: batch.id, scopeFingerprint: batch.scopeFingerprint, segmentAttempt: 1 as const, currency: snapshot.currency, pricingSnapshotVersion: snapshot.version };
  }
  async idleTick(signal?: AbortSignal): Promise<EvolutionMaintenanceResult> {
    if (this.#ticking) return result("deferred", "maintenance_tick_busy");
    let reservation: EvolutionMaintenanceReservation | undefined;
    try {
      const { now, config } = this.#gate(signal);
      if (this.#lastTick !== undefined && now - this.#lastTick < config.intervalMs) return result("deferred", "maintenance_interval");
      this.#ticking = true; this.#lastTick = now;
      const budget = this.#workBudget(); count(this.options.dueLimit ?? 8, 100, 1);
      await this.#storage(signal);
      const { persistence } = this.#native();
      const due = new PostgresEvolutionMaintenancePort({ repository: persistence.repository, readClient: persistence.repository.pool, workBudget: budget, now: this.#now });
      const work = await due.listDue({ now, limit: this.options.dueLimit ?? 8 }); this.#gate(signal);
      if (work.length > (this.options.dueLimit ?? 8) || work.some(item => item.kind !== "revalidate" || authorityScopeFingerprint(item.scope) !== persistence.repository.scopeFingerprint)) stop("maintenance_due_invalid");
      const plan = planMaintenance(work, { enabled: true, foregroundBusy: false, storageHealthy: true, now, remaining: budget, maxTasks: 1 });
      if (!plan.selected.length) return result("idle", plan.reasons[0] ?? "maintenance_not_due");
      const trigger = plan.selected[0], { snapshot } = this.#pricing();
      const request = parseEvolutionRunRequest({ input: { mode: "inventory", selection: "due" }, action: "propose", limits: this.#limits(), idempotencyKey: PREFIX + evolutionHash({ scope: persistence.repository.scopeFingerprint, config: this.#config.configFingerprint, pricing: snapshot, limits: this.#limits(), trigger: { id: trigger.id, revision: trigger.revision } }) });
      const batch = await this.options.prepareBatch(request, signal); this.#gate(signal); this.#assertBatch(batch, request);
      if (terminal.has(batch.status) || batch.cancelRequestedAt !== undefined) return { ...result("idle", "maintenance_existing_batch"), batchId: batch.id };
      reservation = await this.#reserve(batch, signal); this.#dispatchGate(signal);
      let queued: Awaited<ReturnType<EvolutionMaintenanceOptions["enqueueBatch"]>>;
      try { queued = await this.options.enqueueBatch(structuredClone(batch), signal); }
      catch { return { ...result("deferred", "maintenance_enqueue_uncertain"), batchId: batch.id, reservation }; }
      if (queued.batchId !== batch.id || queued.segmentAttempt !== 1 || queued.jobId !== evolutionJobIdentity(this.#scope, batch.id, 1).id) stop("maintenance_enqueue_mismatch");
      this.#gate(signal);
      return { ...result("queued"), batchId: batch.id, jobId: queued.jobId, reservation };
    } catch (error) { return { ...failed(error, "maintenance_tick_failed", signal), ...(reservation ? { reservation, batchId: reservation.batchId } : {}) }; }
    finally { this.#ticking = false; }
  }
  async beforeBatch(batch: EvolutionBatch, signal?: AbortSignal): Promise<EvolutionMaintenanceResult> {
    if (!batch?.request?.idempotencyKey?.startsWith(PREFIX)) return result("not_maintenance");
    try {
      this.#gate(signal); this.#assertBatch(batch); this.#workBudget();
      if (terminal.has(batch.status) || batch.cancelRequestedAt !== undefined) return result("deferred", "maintenance_existing_batch");
      await this.#storage(signal);
      const reservation = await this.#reserve(batch, signal);
      return { ...result("admitted"), batchId: batch.id, reservation };
    } catch (error) { return failed(error, "maintenance_admission_failed", signal); }
  }
  async afterBatch(input: EvolutionMaintenanceFencedInput): Promise<EvolutionMaintenanceResult> {
    const output: EvolutionMaintenanceResult = { ...result("completed"), deleted: [], preserved: [], outcomesRecorded: 0, outcomeEventsPruned: 0 };
    let interrupted: MaintenanceStop | undefined;
    try {
      const { now } = this.#gate(input.signal); this.#assertBatch(input.batch);
      const limit = count(this.options.retentionLimit ?? 10, 100, 1), { persistence: reader, bundle } = this.#native();
      const job = input.job, expected = evolutionJobIdentity(this.#scope, input.batch.id, 1);
      if (job.type !== "evolve_memory_batch" || job.status !== "running" || job.id !== expected.id || job.dedupeKey !== expected.dedupeKey || job.payload?.batchId !== input.batch.id || job.payload.segmentAttempt !== 1 || ["tenantId", "userId", "appId", "projectId", "agentId", "namespace", "visibility"].some(k => job.scope[k as keyof typeof job.scope] !== this.#scope[k as keyof MemoryScope])) stop("maintenance_job_mismatch");
      const owned = assertPostgresBundleOwnsEvolutionPersistence(bundle, input.persistence, this.#scope, job);
      const lease = input.lease;
      if (lease.batchId !== input.batch.id || lease.scopeFingerprint !== owned.repository.scopeFingerprint || !ID.test(lease.ownerId) || !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1 || !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= now || (input.outcomes?.length ?? 0) > limit) stop("maintenance_lease_mismatch");
      const deadline = now + Math.min(10000, this.#limits().maxDurationMs);
      const check = () => {
        try { this.#gate(input.signal); if (this.#now() >= deadline || this.#now() >= lease.expiresAt) stop("maintenance_deferred", "deferred"); }
        catch (error) { if (error instanceof MaintenanceStop) interrupted = error; throw error; }
      };
      const repository = new PostgresEvolutionRepository({ pool: owned.repository.pool, scope: this.#scope, beforeMutation: async client => {
        check(); await owned.repository.assertMutationAllowed(client); await lockLease(client, lease, lease.scopeFingerprint, lease.batchId); check();
      } });
      const port = new PostgresEvolutionMaintenancePort({ repository, readClient: reader.repository.pool, now: this.#now });
      for (const entry of input.outcomes ?? []) {
        check(); if (authorityScopeFingerprint(entry.outcome.scope) !== lease.scopeFingerprint) stop("maintenance_scope_mismatch");
        await recordMaintenanceOutcome(port, entry.outcome, { attemptId: entry.attemptId, failureCount: entry.failureCount }); output.outcomesRecorded!++;
      }
      const cleaned = await cleanupMaintenance({ scope: this.#scope, lease, now, limit, signal: input.signal, port: {
        listExpired: async request => { check(); return port.listExpired(request); },
        cleanupUnreferenced: async request => {
          check(); const receipt = await port.cleanupUnreferenced(request);
          if (receipt.status === "deleted") output.deleted!.push(request.candidate.id); else output.preserved!.push(request.candidate.id);
          if (receipt.status === "stale") stop("maintenance_retention_stale", "deferred");
          return receipt;
        },
      } });
      if (cleaned.reason) return { ...output, ...result("deferred", cleaned.reason === "cancelled" ? "maintenance_cancelled" : "maintenance_retention_deferred") };
      check(); const pruned = await port.pruneMetadata({ lease, limit }); output.outcomeEventsPruned = count(pruned.outcomeEvents, limit);
      return output;
    } catch (error) { return { ...output, ...failed(interrupted ?? error, "maintenance_retention_failed", input.signal) }; }
  }
  async settleReservation(input: Parameters<EvolutionMaintenanceDriver["settleReservation"]>[0]): Promise<EvolutionMaintenanceResult> {
    try {
      this.#assertBatch(input.batch);
      if (!input.usage || input.usage.estimatedMinorUnits === undefined || input.signal?.aborted || !terminal.has(input.batch.status) || input.batch.status === "partial") return result("retained", "maintenance_usage_uncertain");
      const { snapshot, model, provider } = this.#pricing(), reservation = input.reservation, usage = input.usage, limits = this.#limits();
      if (!reservation || !HASH.test(reservation.reservationId) || !/^\d{4}-\d{2}-\d{2}$/.test(reservation.dayKey) || reservation.batchId !== input.batch.id || reservation.scopeFingerprint !== input.batch.scopeFingerprint || reservation.segmentAttempt !== 1 || reservation.currency !== snapshot.currency || reservation.pricingSnapshotVersion !== snapshot.version || usage.complete !== true || usage.batchId !== input.batch.id || usage.scopeFingerprint !== input.batch.scopeFingerprint || usage.segmentAttempt !== 1 || usage.currency !== snapshot.currency || usage.pricingSnapshotVersion !== snapshot.version || usage.provider !== provider || usage.model !== model) stop("maintenance_usage_mismatch");
      const ownerKey = jsonHash([this.#scope.tenantId, this.#scope.userId]);
      const expectedId = jsonHash([ownerKey, reservation.dayKey, this.#reservationKey(input.batch, snapshot)]);
      if (reservation.reservationId !== expectedId || reservation.tokens !== limits.maxInputTokens + limits.maxOutputTokens || reservation.costMicros !== this.#workBudget().costMicros) stop("maintenance_usage_mismatch");
      count(usage.inputTokens, limits.maxInputTokens); count(usage.outputTokens, limits.maxOutputTokens);
      const expectedCost = estimateRuntimeCost(snapshot, { provider, model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, embeddingUnits: null, embeddingUnitKind: null }).estimatedMinorUnits;
      const amount = usage.estimatedMinorUnits!;
      if (expectedCost === null || !Number.isFinite(amount) || amount < 0 || Math.abs(amount - expectedCost) > limits.maxLlmCalls * 0.000001 + Number.EPSILON * Math.max(1, expectedCost)) stop("maintenance_usage_mismatch");
      const tokens = count(usage.inputTokens + usage.outputTokens), costMicros = count(Math.ceil(amount * 1000000 / snapshot.minorUnitsPerMajor));
      if (tokens > reservation.tokens || costMicros > reservation.costMicros) stop("maintenance_usage_mismatch");
      await this.#native().ledger.settle({ reservationId: reservation.reservationId, dayKey: reservation.dayKey, tokens, costMicros });
      return { ...result("settled"), batchId: input.batch.id };
    } catch (error) { return failed(error, "maintenance_settlement_failed", input.signal); }
  }
}

export function createEvolutionMaintenance(options: EvolutionMaintenanceOptions): EvolutionMaintenanceDriver {
  return new NativeEvolutionMaintenance(options);
}
