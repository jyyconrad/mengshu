import {
  PostgresDurableJobV2RuntimeBundleError,
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import {
  computeCandidateSpecs,
  type CandidateComputationDeps,
  type ComputedCandidateSpec,
} from "../packages/core/src/lifecycle/candidate-spec-computation.js";
import {
  PostgresCandidateRepository,
  type PostgresPendingCandidateInput,
} from
  "../packages/core/src/lifecycle/postgres-candidate-repository.js";
import { PostgresDurableJobV2EffectError } from
  "../packages/core/src/storage/repositories/postgres-job-v2-effect.js";
import {
  isDurableJobV2SafeIdentifier,
  type DurableJobV2,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  deriveNativeExtractCandidateId,
  parseNativeExtractCandidateJob,
} from "./native-extract-candidate-contract.js";
import {
  DurableJobV2HandlerFailure,
  type DurableJobV2Handler,
  type DurableJobV2HandlerContext,
} from "./workers-v2.js";

export interface NativeExtractCandidateHandlerDependencies {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly computation: CandidateComputationDeps;
}

export interface NativeExtractCandidateHandlerResult {
  readonly status: "applied" | "replayed";
  readonly created: number;
  readonly duplicateCount: number;
  readonly capacityRejectedCount: number;
  readonly candidateIds: readonly string[];
}

const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;
const CANDIDATE_OUTPUT_VALIDATOR = new PostgresCandidateRepository();

function failure(code: string, retryable: boolean): DurableJobV2HandlerFailure {
  return new DurableJobV2HandlerFailure(code, retryable);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  return new DOMException("Native candidate extraction aborted", "AbortError");
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function assertLease(job: DurableJobV2, context: DurableJobV2HandlerContext): void {
  if (job.status !== "running" || typeof job.leaseOwner !== "string" ||
      !LEASE_OWNER.test(job.leaseOwner) || job.leaseOwner !== context.workerId ||
      typeof job.leaseToken !== "string" || !LEASE_TOKEN.test(job.leaseToken) ||
      !Number.isSafeInteger(job.leaseGeneration) || job.leaseGeneration < 1) {
    throw failure("EXTRACT_CANDIDATE_INVALID_JOB", false);
  }
}

function candidateMetadata(
  spec: ComputedCandidateSpec,
  fallbackReason: "llm_extraction_failed" | null,
): Record<string, unknown> {
  return {
    computation: spec.metadata,
    audit: spec.auditMetadata,
    evidence: {
      quote: spec.evidence.quote,
      eventIds: [...spec.evidence.eventIds],
    },
    ...(fallbackReason === null ? {} : { fallbackReason }),
  };
}

function pendingCandidate(
  job: DurableJobV2,
  spec: ComputedCandidateSpec,
  index: number,
  fallbackReason: "llm_extraction_failed" | null,
): PostgresPendingCandidateInput {
  return Object.freeze({
    id: deriveNativeExtractCandidateId(job.id, index),
    text: spec.text,
    ...(spec.semanticType === undefined ? {} : { semanticType: spec.semanticType }),
    kind: spec.kind,
    confidence: spec.confidence,
    reason: spec.reason,
    evidenceIds: Object.freeze([...spec.evidence.eventIds]),
    extractor: spec.extractor,
    metadata: candidateMetadata(spec, fallbackReason),
    // Job creation time is stable across retries and avoids introducing another
    // clock into the provider-owned effect request.
    createdAt: job.createdAt,
  });
}

function mapProviderError(error: unknown): DurableJobV2HandlerFailure {
  if (error instanceof PostgresDurableJobV2EffectError ||
      error instanceof PostgresDurableJobV2RuntimeBundleError) {
    return failure(
      error.retryable
        ? "EXTRACT_CANDIDATE_EFFECT_RETRYABLE"
        : "EXTRACT_CANDIDATE_EFFECT_REJECTED",
      error.retryable,
    );
  }
  return failure("EXTRACT_CANDIDATE_EFFECT_RETRYABLE", true);
}

/**
 * Native DurableJobV2 extract_candidate handler.
 *
 * Computation deliberately finishes before the provider-owned fenced effect is
 * entered. This factory returns one handler only; it does not mint or advertise
 * the production exact-three handler registry.
 */
export function createNativeExtractCandidateHandler(
  dependencies: NativeExtractCandidateHandlerDependencies,
): DurableJobV2Handler {
  const runtimeBundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
    dependencies?.runtimeBundle,
  );
  if (!dependencies.computation || typeof dependencies.computation !== "object" ||
      typeof dependencies.computation.extractor?.extract !== "function" ||
      !isDurableJobV2SafeIdentifier(dependencies.computation.extractor.name)) {
    throw new Error("Native extract_candidate computation dependencies are invalid");
  }
  const computation: CandidateComputationDeps = Object.freeze({
    extractor: dependencies.computation.extractor,
    ...(dependencies.computation.llmClient === undefined
      ? {}
      : { llmClient: dependencies.computation.llmClient }),
  });

  return async (
    job: DurableJobV2,
    context: DurableJobV2HandlerContext,
  ): Promise<NativeExtractCandidateHandlerResult> => {
    throwIfAborted(context.signal);
    let contract: ReturnType<typeof parseNativeExtractCandidateJob>;
    try {
      contract = parseNativeExtractCandidateJob(job);
      assertLease(job, context);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw failure("EXTRACT_CANDIDATE_INVALID_JOB", false);
    }

    let computed: Awaited<ReturnType<typeof computeCandidateSpecs>>;
    try {
      computed = await computeCandidateSpecs(computation, {
        scope: Object.freeze({ ...job.scope, ...contract.context }),
        text: contract.semanticRequest.text,
        traceId: contract.semanticRequest.traceId,
        intent: contract.semanticRequest.intent,
      }, context.signal);
      throwIfAborted(context.signal);
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      throw failure("EXTRACT_CANDIDATE_COMPUTATION_FAILED", true);
    }

    let candidates: readonly Readonly<PostgresPendingCandidateInput>[];
    try {
      const pending = computed.specs.map((spec, index) => pendingCandidate(
          job,
          spec,
          index,
          computed.fallbackReason,
        ));
      // Strict canonical snapshot runs before executeCandidateEffect, so malformed
      // extractor output can never open a PostgreSQL transaction.
      candidates = CANDIDATE_OUTPUT_VALIDATOR.snapshotPendingCandidates(pending);
    } catch {
      throw failure("EXTRACT_CANDIDATE_OUTPUT_INVALID", false);
    }
    throwIfAborted(context.signal);

    try {
      const effect = await runtimeBundle.executeCandidateEffect({
        effectInput: Object.freeze({
          id: job.id,
          scope: Object.freeze({ ...job.scope }),
          owner: job.leaseOwner!,
          leaseToken: job.leaseToken!,
          leaseGeneration: job.leaseGeneration,
        }),
        context: contract.context,
        semanticRequest: contract.semanticRequest,
        candidates,
      });
      if (effect.status === "stale") {
        throw failure("EXTRACT_CANDIDATE_EFFECT_STALE", true);
      }
      const summary = effect.receipt.result;
      return Object.freeze({
        status: effect.status,
        created: summary.created,
        duplicateCount: summary.duplicateCount,
        capacityRejectedCount: summary.capacityRejectedCount,
        candidateIds: Object.freeze([...summary.candidateIds]),
      });
    } catch (error) {
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw mapProviderError(error);
    }
  };
}
