import {
  PostgresDurableJobV2RuntimeBundleError,
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { createHash } from "node:crypto";
import {
  computeCandidateSpecs,
  type CandidateComputationDeps,
  type CandidateProposalReceiptV1,
} from "../packages/core/src/lifecycle/candidate-spec-computation.js";
import {
  CandidateWriteMaterializationError,
  materializeCandidateWriteRecords,
  type CandidateWriteMaterializerDependencies,
} from "../packages/core/src/lifecycle/candidate-write-materializer.js";
import type { CandidateEvidenceReadPort } from
  "../packages/core/src/lifecycle/postgres-candidate-evidence-read-port.js";
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

export interface NativeCommittedActiveDerivationInput {
  readonly scope: DurableJobV2["scope"];
  readonly context: Readonly<{ workspaceId?: string; sessionId?: string }>;
  readonly activeMemoryIds: readonly string[];
  readonly signal: AbortSignal;
}

export type NativeCommittedActiveDerivation = (
  input: NativeCommittedActiveDerivationInput,
) => Promise<void>;

export interface NativeExtractCandidateHandlerDependencies {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly computation: CandidateComputationDeps;
  /** Provider-owned persisted evidence hydration；confidence 不接受 job/LLM metadata。 */
  readonly evidenceRead: CandidateEvidenceReadPort;
  /** Optional only during staged Runtime composition migration; execution fails closed when absent. */
  readonly materialization?: CandidateWriteMaterializerDependencies;
  /** Effect receipt 提交后，按 persisted active IDs 回读并确保幂等 graph/tree 派生。 */
  readonly deriveCommittedActive?: NativeCommittedActiveDerivation;
  /** 派生失败仅发出无参数信号，禁止把 error、scope 或 identity 交给日志边界。 */
  readonly onCommittedActiveDerivationWarning?: () => void | Promise<void>;
}

export interface NativeExtractCandidateHandlerResult {
  readonly status: "applied" | "replayed";
  readonly created: number;
  readonly duplicateCount: number;
  readonly capacityRejectedCount: number;
  readonly candidateIds: readonly string[];
  readonly memoryIds: readonly string[];
  readonly activeMemoryIds: readonly string[];
  readonly droppedCount: number;
  readonly proposalReceipts: readonly CandidateProposalReceiptV1[];
}

const LEASE_OWNER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
const LEASE_TOKEN = /^[A-Za-z0-9._~-]{32,256}$/;

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

function deriveNativeExtractMemoryId(jobId: string, index: number): string {
  const digest = createHash("sha256")
    .update("mengshu.native-extract-candidate.memory-id.v1\0")
    .update(jobId)
    .update("\0")
    .update(String(index))
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
    `8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
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
  const materialization = dependencies.materialization;
  const computation: CandidateComputationDeps = Object.freeze({
    extractor: dependencies.computation.extractor,
    ...(dependencies.computation.llmClient === undefined
      ? {}
      : { llmClient: dependencies.computation.llmClient }),
    ...(typeof materialization?.resolveMaxSimilarity !== "function"
      ? {}
      : { resolveMaxSimilarity: materialization.resolveMaxSimilarity.bind(materialization) }),
  });
  const evidenceRead = dependencies.evidenceRead;
  if (!evidenceRead || typeof evidenceRead.readAuthoritativeEvidenceFacts !== "function") {
    throw new Error("Native candidate evidence read dependency is required");
  }
  const deriveCommittedActive = dependencies.deriveCommittedActive;
  const onCommittedActiveDerivationWarning =
    dependencies.onCommittedActiveDerivationWarning;

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

    const fullScope = Object.freeze({ ...job.scope, ...contract.context });
    let evidenceFacts: Awaited<ReturnType<
      CandidateEvidenceReadPort["readAuthoritativeEvidenceFacts"]
    >>;
    try {
      evidenceFacts = await evidenceRead.readAuthoritativeEvidenceFacts({
        evidenceIds: Object.freeze([contract.semanticRequest.traceId]),
        scope: fullScope,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      throw failure("EXTRACT_CANDIDATE_EVIDENCE_RETRYABLE", true);
    }

    let computed: Awaited<ReturnType<typeof computeCandidateSpecs>>;
    try {
      computed = await computeCandidateSpecs(computation, {
        scope: fullScope,
        text: contract.semanticRequest.text,
        traceId: contract.semanticRequest.traceId,
        intent: contract.semanticRequest.intent,
        evidenceFacts,
      }, context.signal);
      throwIfAborted(context.signal);
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      throw failure("EXTRACT_CANDIDATE_COMPUTATION_FAILED", true);
    }

    if (!materialization) {
      throw failure("EXTRACT_CANDIDATE_MATERIALIZATION_UNAVAILABLE", false);
    }

    let records: Awaited<ReturnType<typeof materializeCandidateWriteRecords>>;
    try {
      records = await materializeCandidateWriteRecords(materialization, {
        specs: computed.specs,
        scope: fullScope,
        fallbackReason: computed.fallbackReason,
        traceId: contract.semanticRequest.traceId,
        intent: contract.semanticRequest.intent,
        createdAt: job.createdAt,
        createRecordId: (sourceIndex) => {
          const route = computed.specs[sourceIndex]?.metadata.admission;
          return route === "candidate" || route === "candidate_low_priority"
            ? deriveNativeExtractCandidateId(job.id, sourceIndex)
            : deriveNativeExtractMemoryId(job.id, sourceIndex);
        },
      }, context.signal);
    } catch (error) {
      if (isAbortError(error) || context.signal.aborted) throw abortError(context.signal);
      if (error instanceof CandidateWriteMaterializationError) {
        throw failure("EXTRACT_CANDIDATE_OUTPUT_INVALID", false);
      }
      throw failure("EXTRACT_CANDIDATE_MATERIALIZATION_FAILED", true);
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
        records,
        proposalReceipts: computed.proposalReceipts,
      });
      if (effect.status === "stale") {
        throw failure("EXTRACT_CANDIDATE_EFFECT_STALE", true);
      }
      const summary = effect.receipt.result;
      if (deriveCommittedActive && summary.activeMemoryIds?.length) {
        try {
          await deriveCommittedActive(Object.freeze({
            scope: Object.freeze({ ...job.scope }),
            context: Object.freeze({ ...contract.context }),
            activeMemoryIds: Object.freeze([...summary.activeMemoryIds]),
            signal: context.signal,
          }));
          throwIfAborted(context.signal);
        } catch (error) {
          if (isAbortError(error)) throw error;
          if (context.signal.aborted) throw abortError(context.signal);
          try {
            await onCommittedActiveDerivationWarning?.();
          } catch {
            // Observability is best-effort after the authoritative receipt is committed.
          }
          throw failure("EXTRACT_CANDIDATE_ACTIVE_DERIVATION_RETRYABLE", true);
        }
      }
      return Object.freeze({
        status: effect.status,
        created: summary.created,
        duplicateCount: summary.duplicateCount,
        capacityRejectedCount: summary.capacityRejectedCount,
        candidateIds: Object.freeze([...summary.candidateIds]),
        memoryIds: Object.freeze([...(summary.memoryIds ?? [])]),
        activeMemoryIds: Object.freeze([...(summary.activeMemoryIds ?? [])]),
        droppedCount: summary.droppedCount ?? 0,
        proposalReceipts: Object.freeze([...(summary.proposalReceipts ?? [])]),
      });
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (context.signal.aborted) throw abortError(context.signal);
      if (error instanceof DurableJobV2HandlerFailure) throw error;
      throw mapProviderError(error);
    }
  };
}
