import { createHash } from "node:crypto";
import type { EvolutionBatchReport, EvolutionRunRequest, EvolutionUsage } from "../../core/src/evolution/types.js";
import { EVOLUTION_RUN_REQUEST_SCHEMA, EvolutionError, parseEvolutionControlResult, parseEvolutionRunRequest } from "../../core/src/evolution/schema.js";

export interface EvolutionBatchCapability {
  run(request: EvolutionRunRequest, signal?: AbortSignal): Promise<EvolutionBatchReport>;
  status(batchId: string): Promise<EvolutionBatchReport | undefined>;
  resume(batchId: string, signal?: AbortSignal): Promise<EvolutionBatchReport>;
  cancel?(batchId: string): Promise<EvolutionBatchReport>;
  readonly review?: import("./evolution-review.js").EvolutionReviewCapability;
  readonly sourceControl?: import("./evolution-source-control.js").EvolutionSourceControlCapability;
  readonly reuse?: import("./evolution-reuse-control.js").EvolutionReuseControlCapability;
  readonly control?: import("./evolution-control.js").EvolutionGovernanceControlCapability;
}
export class EvolutionTransportError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "EvolutionTransportError";
  }
}

export const EVOLUTION_RUN_INPUT_SCHEMA = EVOLUTION_RUN_REQUEST_SCHEMA;
export const EVOLUTION_BATCH_INPUT_SCHEMA = {
  type: "object", additionalProperties: false, required: ["batchId"],
  properties: { batchId: { type: "string", minLength: 1, maxLength: 128 } },
} as const;

function batchIdRequest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !("batchId" in value) ||
      typeof value.batchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.batchId)) {
    throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  }
  return value.batchId;
}

/** Internal checkpoints can contain source locators; clients resume by batch ID only. */
export function publicEvolutionReport(report: EvolutionBatchReport): EvolutionBatchReport {
  const counter = (value: number) => {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid evolution report");
    return value;
  };
  if (!["queued", "running", "completed", "partial", "blocked", "cancelled", "failed"].includes(report.status) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(report.batchId) ||
      !/^[A-Za-z0-9:._-]{1,256}$/.test(report.configFingerprint)) {
    throw new Error("Invalid evolution report");
  }
  const usage = (value: EvolutionUsage): EvolutionUsage => ({
    records: counter(value.records), files: counter(value.files), bytes: counter(value.bytes),
    llmCalls: counter(value.llmCalls), inputTokens: counter(value.inputTokens),
    outputTokens: counter(value.outputTokens), durationMs: counter(value.durationMs),
  });
  return {
    batchId: report.batchId, status: report.status,
    reasons: report.reasons.slice(0, 32).map(reason =>
      /^[a-z][a-z0-9_:-]{0,79}$/.test(reason) ? reason : "evolution_operation_failed"),
    usage: usage(report.usage), usageAccounting: "budget_reservation",
    ...(report.segment ? { segment: { attempt: counter(report.segment.attempt), usage: usage(report.segment.usage) } } : {}),
    counts: {
      proposed: counter(report.counts.proposed), applied: counter(report.counts.applied),
      rejected: counter(report.counts.rejected), review: counter(report.counts.review),
      noop: counter(report.counts.noop), skipped: counter(report.counts.skipped),
    },
    checkpoint: {
      cursor: report.checkpoint.cursor === null ? null :
        `sha256:${createHash("sha256").update(JSON.stringify(report.checkpoint.cursor)).digest("hex")}`,
      ...(report.checkpoint.selectionEpoch === undefined ? {} :
        { selectionEpoch: counter(report.checkpoint.selectionEpoch) }),
    },
    configFingerprint: report.configFingerprint, resumable: report.resumable === true,
    ...(report.work ? { work: {
      kind: ["memory_evolution", "source_reconcile", "source_revoke", "undo_governance"].includes(report.work.kind) ? report.work.kind : (() => { throw new Error("Invalid evolution work"); })(),
      ...(report.work.result === undefined ? {} : { result: parseEvolutionControlResult(report.work.result) }),
    } } : {}),
  };
}

export async function invokeEvolutionCapability(
  capability: EvolutionBatchCapability,
  operation: "run" | "status" | "resume",
  input: unknown,
): Promise<EvolutionBatchReport> {
  let request: EvolutionRunRequest | undefined;
  let batchId: string | undefined;
  try {
    if (operation === "run") {
      request = parseEvolutionRunRequest(input);
      if (request.input.mode === "directory" && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(request.input.sourceId)) {
        throw new Error("Invalid sourceId");
      }
    }
    else batchId = batchIdRequest(input);
  } catch {
    throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  }
  let report: EvolutionBatchReport | undefined;
  try {
    report = operation === "run" ? await capability.run(request!) :
      operation === "status" ? await capability.status(batchId!) : await capability.resume(batchId!);
  } catch (error) {
    if (error instanceof EvolutionError && error.code === "batch_not_found") {
      throw new EvolutionTransportError(404, "EVOLUTION_BATCH_NOT_FOUND");
    }
    if (error instanceof EvolutionError && error.code === "config_changed") {
      throw new EvolutionTransportError(409, "EVOLUTION_CONFIG_CHANGED");
    }
    if (error instanceof EvolutionError && error.code === "source_not_registered") {
      throw new EvolutionTransportError(404, "EVOLUTION_SOURCE_NOT_REGISTERED");
    }
    throw error;
  }
  if (!report) throw new EvolutionTransportError(404, "EVOLUTION_BATCH_NOT_FOUND");
  return publicEvolutionReport(report);
}
