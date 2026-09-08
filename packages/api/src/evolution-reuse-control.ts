import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SkillPairedValidationResult } from "../../core/src/evolution/reuse/skill-paired-validator.js";
import { EvolutionError } from "../../core/src/evolution/schema.js";
import { EvolutionTransportError, type EvolutionBatchCapability } from "./evolution.js";

const closed = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" });
const scopeId = Type.String({ pattern: "^[^\\s\\u0000-\\u001f\\u007f]{1,256}$" });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const EVOLUTION_REUSE_GRANTS_SCHEMA = Type.Object({ expectedRevision: revision, idempotencyKey: id,
  grants: Type.Array(Type.Object({ id, source: Type.Object({ appId: scopeId, projectId: scopeId, agentId: scopeId,
    namespace: scopeId, visibility: Type.Union([Type.Literal("private"), Type.Literal("workspace")]) }, closed),
    claimKinds: Type.Array(Type.Union(["preference", "decision", "entity", "fact", "task", "plan", "goal", "document", "knowledge", "observation", "other"].map(value => Type.Literal(value))), { minItems: 1, maxItems: 11, uniqueItems: true }),
    notBefore: Type.String({ maxLength: 32 }), expiresAt: Type.String({ maxLength: 32 }),
  }, closed), { maxItems: 32 }),
}, closed);
export type EvolutionReuseGrantsRequest = Static<typeof EVOLUTION_REUSE_GRANTS_SCHEMA>;
export interface EvolutionReuseControlCapability {
  status(): Promise<{ targetFingerprint?: string; grantsRevision: number; grantIds: string[] }>;
  replaceGrants(request: EvolutionReuseGrantsRequest, signal?: AbortSignal): Promise<{ receiptId: string; revision: number; valueHash: string }>;
  evaluate(request: { planId: string }, signal?: AbortSignal): Promise<SkillPairedValidationResult>;
}
export const EVOLUTION_REUSE_OPERATIONS = ["reuse/status", "reuse/grants", "reuse/evaluate"] as const;
export type EvolutionReuseOperation = typeof EVOLUTION_REUSE_OPERATIONS[number];
export const isEvolutionReuseOperation = (value: string): value is EvolutionReuseOperation => (EVOLUTION_REUSE_OPERATIONS as readonly string[]).includes(value);
export function evolutionReuseSchema(operation: EvolutionReuseOperation) {
  return operation === "reuse/grants" ? EVOLUTION_REUSE_GRANTS_SCHEMA : operation === "reuse/evaluate" ? Type.Object({ planId: Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$" }) }, closed) : Type.Object({}, closed);
}
export function parseEvolutionReuseGrants(value: unknown): EvolutionReuseGrantsRequest {
  if (!Value.Check(EVOLUTION_REUSE_GRANTS_SCHEMA, value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  return structuredClone(value);
}
export async function invokeEvolutionReuseControl(capability: EvolutionBatchCapability, operation: EvolutionReuseOperation, value: unknown) {
  if (!capability.reuse) throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
  if (!Value.Check(evolutionReuseSchema(operation), value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  try {
    if (operation === "reuse/status") return capability.reuse.status();
    if (operation === "reuse/grants") return capability.reuse.replaceGrants(parseEvolutionReuseGrants(value));
    const result = await capability.reuse.evaluate(value as { planId: string });
    if (result.status !== "accepted_for_review") return result;
    const v = result.validation;
    return { status: result.status, publishAllowed: false, executionAllowed: false, validation: {
      subject: { kind: v.subject.kind, id: v.subject.id, revision: v.subject.revision, contentHash: v.subject.contentHash },
      evaluatorId: v.evaluatorId, reviewReceiptId: v.reviewReceiptId, planHash: v.planHash, reportHash: v.reportHash,
      targetFingerprint: v.targetFingerprint, holdoutRef: v.holdoutRef, validatedAt: v.validatedAt,
      quality: v.quality, criticalSubclasses: v.criticalSubclasses, costReduction: v.costReduction,
    } };
  } catch (error) {
    if (error instanceof EvolutionError) throw new EvolutionTransportError(409, "EVOLUTION_REUSE_STATE_REJECTED");
    throw error;
  }
}
