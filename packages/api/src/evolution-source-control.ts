import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { EvolutionError } from "../../core/src/evolution/schema.js";
import { EvolutionTransportError, type EvolutionBatchCapability } from "./evolution.js";

export interface EvolutionSourceControlReceipt {
  id: string;
  kind: "source_attestation" | "source_revocation";
  entryId: string;
  operation: "put" | "revoke";
  revision: number;
  valueHash: string;
  createdAt: number;
}

/** No generic state mutation: signed provenance and source trust revocation only. */
export interface EvolutionSourceControlCapability {
  issueSourceAttestation(request: EvolutionSourceAttestationRequest, signal?: AbortSignal): Promise<EvolutionSourceControlReceipt>;
  revokeSourceAttestation(request: EvolutionSourceAttestationRevocationRequest, signal?: AbortSignal): Promise<EvolutionSourceControlReceipt>;
}

export const EVOLUTION_SOURCE_CONTROL_OPERATIONS = ["source/attest", "source/revoke-attestation"] as const;
export type EvolutionSourceControlOperation = typeof EVOLUTION_SOURCE_CONTROL_OPERATIONS[number];
export function isEvolutionSourceControlOperation(value: string): value is EvolutionSourceControlOperation {
  return (EVOLUTION_SOURCE_CONTROL_OPERATIONS as readonly string[]).includes(value);
}
const closed = { additionalProperties: false };
const id = Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$" });
const hash = Type.String({ pattern: "^[a-f0-9]{64}$" });
const time = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const issue = Type.Object({ statement: Type.Object({ issuer: id, scopeFingerprint: hash, evidenceId: id,
  sourceId: id, revision: id, snapshotHash: hash, rootEvidenceId: id, origin: Type.Literal("external"),
  trust: Type.Union([Type.Literal("user_statement"), Type.Literal("verified_document"), Type.Literal("verified_result")]),
  authorId: Type.Optional(id), occurredAt: Type.Optional(time),
  authorizedTargetRefs: Type.Array(Type.Object({ memoryId: id, expectedRevision: time, beforeHash: hash }, closed), { maxItems: 8 }),
  issuedAt: time, expiresAt: time,
}, closed), signature: Type.String({ pattern: "^[A-Za-z0-9_-]{86}$" }), expectedRevision: time, idempotencyKey: id }, closed);
const revoke = Type.Object({ sourceId: id, sourceRevision: id, expectedRevision: time, idempotencyKey: id,
  operationIdempotencyKey: id, expiresAt: time }, closed);
export type EvolutionSourceAttestationRequest = Static<typeof issue>;
export type EvolutionSourceAttestationRevocationRequest = Static<typeof revoke>;
export function evolutionSourceControlSchema(operation: EvolutionSourceControlOperation): TSchema {
  return operation === "source/attest" ? issue : revoke;
}
export function parseEvolutionSourceControl(operation: EvolutionSourceControlOperation, value: unknown) {
  if (!Value.Check(evolutionSourceControlSchema(operation), value) || Buffer.byteLength(JSON.stringify(value)) > 16_384) {
    throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  }
  return structuredClone(value) as EvolutionSourceAttestationRequest | EvolutionSourceAttestationRevocationRequest;
}
export async function invokeEvolutionSourceControl(capability: EvolutionBatchCapability, operation: EvolutionSourceControlOperation, value: unknown) {
  if (!capability.sourceControl) throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
  const request = parseEvolutionSourceControl(operation, value);
  try {
    const receipt = operation === "source/attest" ? await capability.sourceControl.issueSourceAttestation(request as EvolutionSourceAttestationRequest) :
      await capability.sourceControl.revokeSourceAttestation(request as EvolutionSourceAttestationRevocationRequest);
    return { id: receipt.id, kind: receipt.kind, entryId: receipt.entryId, operation: receipt.operation,
      revision: receipt.revision, valueHash: receipt.valueHash, createdAt: receipt.createdAt };
  } catch (error) {
    if (error instanceof EvolutionError) throw new EvolutionTransportError(409,
      /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? `EVOLUTION_${error.code.toUpperCase()}` : "EVOLUTION_SOURCE_CONTROL_REJECTED");
    throw error;
  }
}
