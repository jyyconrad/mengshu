import type { TypedPageCompiler, TypedPagePublishInput } from
  "../packages/core/src/documents/compiler/typed-page-compiler.js";
import { isMemoryForm } from "../packages/core/src/domain/types.js";
import type { DurableJobV2 } from "../packages/core/src/storage/repositories/job-v2.js";
import {
  DurableJobV2HandlerFailure,
  type DurableJobV2Handler,
} from "./workers-v2.js";

export interface CompileDocumentJobRunner {
  publish(input: TypedPagePublishInput): Promise<Awaited<ReturnType<TypedPageCompiler["publish"]>>>;
}

function failure(code: string): DurableJobV2HandlerFailure {
  return new DurableJobV2HandlerFailure(code, false);
}

function plain(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseJob(job: DurableJobV2): TypedPagePublishInput {
  if (job.type !== "compile_document" || !plain(job.payload)) {
    throw failure("COMPILE_DOCUMENT_INVALID_JOB");
  }
  const allowed = new Set([
    "assetId",
    "expectedLatestVersion",
    "updates",
    "plannedWatermarks",
    "observedWatermarks",
    "memoryForm",
    "compiledAt",
    "governanceRunId",
    "proposalId",
    "validTimeSelector",
  ]);
  const keys = Reflect.ownKeys(job.payload);
  if (keys.some((key) => typeof key !== "string" || !allowed.has(key))) {
    throw failure("COMPILE_DOCUMENT_INVALID_JOB");
  }
  const payload = job.payload;
  if (typeof payload.assetId !== "string" ||
      !Number.isSafeInteger(payload.expectedLatestVersion) ||
      !Array.isArray(payload.updates) ||
      !Array.isArray(payload.plannedWatermarks) ||
      !Array.isArray(payload.observedWatermarks) ||
      !isMemoryForm(payload.memoryForm) ||
      typeof payload.compiledAt !== "string" ||
      typeof payload.governanceRunId !== "string" ||
      typeof payload.proposalId !== "string") {
    throw failure("COMPILE_DOCUMENT_INVALID_JOB");
  }
  return {
    scope: {
      tenantId: job.scope.tenantId,
      userId: job.scope.userId,
      appId: job.scope.appId,
      projectId: job.scope.projectId,
      agentId: job.scope.agentId,
      namespace: job.scope.namespace,
      visibility: job.scope.visibility,
    },
    assetId: payload.assetId,
    expectedLatestVersion: payload.expectedLatestVersion as number,
    updates: payload.updates as TypedPagePublishInput["updates"],
    plannedWatermarks: payload.plannedWatermarks as TypedPagePublishInput["plannedWatermarks"],
    observedWatermarks: payload.observedWatermarks as TypedPagePublishInput["observedWatermarks"],
    memoryForm: payload.memoryForm,
    compiledAt: payload.compiledAt,
    governanceRunId: payload.governanceRunId,
    proposalId: payload.proposalId,
    ...(payload.validTimeSelector === undefined
      ? {}
      : { validTimeSelector: payload.validTimeSelector as TypedPagePublishInput["validTimeSelector"] }),
  };
}

/** compile_document runs the typed-page compiler. publish_document is its commit stage. */
export function createNativeCompileDocumentHandler(input: {
  readonly compiler: CompileDocumentJobRunner;
}): DurableJobV2Handler {
  return async (job, context) => {
    if (context.signal.aborted) {
      const error = new Error("compile_document aborted");
      error.name = "AbortError";
      throw error;
    }
    const request = parseJob(job);
    const result = await input.compiler.publish(request);
    if (context.signal.aborted) {
      const error = new Error("compile_document aborted");
      error.name = "AbortError";
      throw error;
    }
    if (result.status === "stale_input") throw failure(result.code);
    if (result.status !== "published") throw failure("COMPILE_DOCUMENT_NOT_PUBLISHED");
    return Object.freeze({
      status: "published" as const,
      stage: result.stage,
      assetId: result.asset.assetId,
      assetVersion: result.asset.assetVersion,
      replayed: result.replayed,
    });
  };
}
