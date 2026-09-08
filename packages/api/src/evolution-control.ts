import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { EvolutionBatchReport, EvolutionControlRequest } from "../../core/src/evolution/types.js";
import { EVOLUTION_CONTROL_REQUEST_SCHEMA, EvolutionError, parseEvolutionControlRequest } from "../../core/src/evolution/schema.js";
import { EvolutionTransportError, publicEvolutionReport, type EvolutionBatchCapability } from "./evolution.js";

const closed = { additionalProperties: false };
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" });
const integer = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const preview = Type.Object({ operationReceiptId: hash }, closed);
const approve = Type.Object({ operationReceiptId: hash, currentStateHash: hash, expectedRevision: integer,
  idempotencyKey: id, operationIdempotencyKey: id, expiresAt: integer }, closed);
const previewResult = Type.Object({ operationReceiptId: hash,
  operation: Type.Union(["mark_disputed", "revalidate", "add_evidence", "merge_equivalent"].map(value => Type.Literal(value))),
  memoryIds: Type.Array(id, { maxItems: 8, uniqueItems: true }), currentStateHash: hash }, closed);
const approvalResult = Type.Object({ id, kind: Type.Literal("governance_undo"), entryId: id, operation: Type.Literal("put"),
  revision: integer, valueHash: hash, createdAt: integer }, closed);
export type EvolutionUndoPreviewRequest = Static<typeof preview>;
export type EvolutionUndoApprovalRequest = Static<typeof approve>;
export interface EvolutionUndoPreview {
  operationReceiptId: string;
  operation: "mark_disputed" | "revalidate" | "add_evidence" | "merge_equivalent";
  memoryIds: string[]; currentStateHash: string;
}
export interface EvolutionUndoApprovalReceipt {
  id: string; kind: "governance_undo"; entryId: string; operation: "put";
  revision: number; valueHash: string; createdAt: number;
}
export interface EvolutionGovernanceControlCapability {
  run(request: EvolutionControlRequest, signal?: AbortSignal): Promise<EvolutionBatchReport>;
  previewUndo(request: EvolutionUndoPreviewRequest, signal?: AbortSignal): Promise<EvolutionUndoPreview>;
  approveUndo(request: EvolutionUndoApprovalRequest, signal?: AbortSignal): Promise<EvolutionUndoApprovalReceipt>;
}
export const EVOLUTION_GOVERNANCE_OPERATIONS = ["control/run", "control/undo-preview", "control/undo-approve"] as const;
export type EvolutionGovernanceOperation = typeof EVOLUTION_GOVERNANCE_OPERATIONS[number];
export function isEvolutionGovernanceOperation(value: string): value is EvolutionGovernanceOperation {
  return (EVOLUTION_GOVERNANCE_OPERATIONS as readonly string[]).includes(value);
}
export function isEvolutionGovernanceOwnerTool(name: string): boolean {
  return name.startsWith("memory_evolution_control_");
}
export function evolutionGovernanceSchema(operation: EvolutionGovernanceOperation): TSchema {
  if (!isEvolutionGovernanceOperation(operation)) throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  return operation === "control/run" ? EVOLUTION_CONTROL_REQUEST_SCHEMA : operation === "control/undo-preview" ? preview : approve;
}
function checkedUndoRequest(value: unknown, schema: TSchema): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid");
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor) ||
        !["string", "number"].includes(typeof descriptor.value)) throw new Error("invalid");
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 4096 || !Value.Check(schema, value)) throw new Error("invalid");
  return structuredClone(value);
}
export function parseEvolutionGovernanceRequest(operation: EvolutionGovernanceOperation, value: unknown): EvolutionControlRequest | EvolutionUndoPreviewRequest | EvolutionUndoApprovalRequest {
  try {
    if (operation === "control/run") {
      const parsed = parseEvolutionControlRequest(value);
      const { maxRecords, maxFiles, maxBytes, maxDurationMs } = parsed.limits;
      return { ...parsed, limits: { maxRecords, maxFiles, maxBytes, maxDurationMs } };
    }
    return checkedUndoRequest(value, evolutionGovernanceSchema(operation)) as EvolutionUndoPreviewRequest | EvolutionUndoApprovalRequest;
  } catch { throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID"); }
}
export async function invokeEvolutionGovernanceControl(capability: EvolutionBatchCapability, operation: EvolutionGovernanceOperation, value: unknown): Promise<unknown> {
  if (!capability.control) throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
  const request = parseEvolutionGovernanceRequest(operation, value);
  try {
    if (operation === "control/run") return publicEvolutionReport(await capability.control.run(request as EvolutionControlRequest));
    if (operation === "control/undo-preview") {
      const result = await capability.control.previewUndo(request as EvolutionUndoPreviewRequest);
      const projection = { operationReceiptId: result.operationReceiptId, operation: result.operation,
        memoryIds: result.memoryIds, currentStateHash: result.currentStateHash };
      if (!Value.Check(previewResult, projection) || projection.operationReceiptId !== (request as EvolutionUndoPreviewRequest).operationReceiptId ||
          Buffer.byteLength(JSON.stringify(projection)) > 4096) throw new Error("invalid undo projection");
      return structuredClone(projection);
    }
    const result = await capability.control.approveUndo(request as EvolutionUndoApprovalRequest);
    const projection = { id: result.id, kind: result.kind, entryId: result.entryId, operation: result.operation,
      revision: result.revision, valueHash: result.valueHash, createdAt: result.createdAt };
    if (!Value.Check(approvalResult, projection) || Buffer.byteLength(JSON.stringify(projection)) > 4096) throw new Error("invalid undo receipt");
    return projection;
  } catch (error) {
    if (error instanceof EvolutionError) throw new EvolutionTransportError(409,
      /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? `EVOLUTION_${error.code.toUpperCase()}` : "EVOLUTION_CONTROL_REJECTED");
    if (error instanceof EvolutionTransportError) throw error;
    throw new EvolutionTransportError(500, "EVOLUTION_OPERATION_FAILED");
  }
}
