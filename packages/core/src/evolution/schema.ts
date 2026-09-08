import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { EvolutionControlRequest, EvolutionControlResult, EvolutionLimits, EvolutionProposalDraft, EvolutionProposalListRequest, EvolutionReviewDecisionRequest, EvolutionRunRequest } from "./types.js";

export const EVOLUTION_POLICY_VERSION = "evolution-v1";
export const DEFAULT_EVOLUTION_LIMITS: Readonly<EvolutionLimits> = Object.freeze({
  maxRecords: 100, maxFiles: 20, maxBytes: 1_000_000, maxLlmCalls: 8,
  maxInputTokens: 32_000, maxOutputTokens: 8_000, maxDurationMs: 120_000,
});
export const MAX_EVOLUTION_LIMITS: Readonly<EvolutionLimits> = Object.freeze({
  maxRecords: 1000, maxFiles: 200, maxBytes: 10_000_000, maxLlmCalls: 100,
  maxInputTokens: 256_000, maxOutputTokens: 64_000, maxDurationMs: 600_000,
});
const id = () => Type.String({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" });
const hash = () => Type.String({ pattern: "^[0-9a-f]{64}$" });
const enumeration = (values: string[]) => Type.Union(values.map(v => Type.Literal(v)));
const closed = { additionalProperties: false };
const limitProperties = Object.fromEntries(Object.entries(MAX_EVOLUTION_LIMITS).map(([key, maximum]) => [
  key, Type.Optional(Type.Integer({ minimum: ["maxLlmCalls", "maxInputTokens", "maxOutputTokens"].includes(key) ? 0 : 1, maximum })),
]));
export const EVOLUTION_RUN_REQUEST_SCHEMA = Type.Object({
  input: Type.Union([
    Type.Object({ mode: Type.Literal("inventory"), selection: enumeration(["baseline", "changed", "due"]) }, closed),
    Type.Object({ mode: Type.Literal("directory"), sourceId: id() }, closed),
  ]),
  action: enumeration(["preview", "propose", "apply_allowed"]),
  limits: Type.Optional(Type.Object(limitProperties, closed)),
  idempotencyKey: id(),
}, closed);
const sourceId = () => Type.String({ pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$" });
const controlLimitProperties = { ...Object.fromEntries(["maxRecords", "maxBytes", "maxDurationMs"].map(key => [key, limitProperties[key]])),
  maxFiles: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_EVOLUTION_LIMITS.maxFiles })) };
export const EVOLUTION_CONTROL_REQUEST_SCHEMA = Type.Object({
  input: Type.Object({ mode: Type.Literal("control"), work: Type.Union([
    Type.Object({ kind: Type.Literal("source_reconcile"), sourceId: sourceId() }, closed),
    Type.Object({ kind: Type.Literal("source_revoke"), sourceId: sourceId(), expectedRevision: id(), reviewReceiptId: id() }, closed),
    Type.Object({ kind: Type.Literal("undo_governance"), operationReceiptId: hash(), currentStateHash: hash(), reviewReceiptId: id() }, closed),
  ]) }, closed),
  action: Type.Literal("execute_control"), limits: Type.Optional(Type.Object(controlLimitProperties, closed)), idempotencyKey: id(),
}, closed);
const controlResultSchema = Type.Object({
  status: enumeration(["completed", "partial"]), receiptId: hash(),
  affectedMemoryIds: Type.Optional(Type.Array(id(), { maxItems: 256, uniqueItems: true })),
  sourceManifestConfirmed: Type.Optional(Type.Boolean()), sourceSnapshotHash: Type.Optional(hash()),
  reasons: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9_]{0,79}$" }), { maxItems: 16 })),
}, closed);
export const EVOLUTION_PROPOSAL_SCHEMA = Type.Object({
  operation: enumeration(["create", "add_evidence", "merge_equivalent", "split_conditions", "evolve", "correct", "mark_disputed", "deprecate", "expire", "revalidate", "compile_pattern", "propose_skill", "noop"]),
  claimClass: enumeration(["preference", "fact", "decision", "constraint", "task", "experience", "skill"]),
  reasonCode: enumeration(["new_claim", "independent_support", "explicit_correction", "attribute_changed", "conflicting_evidence", "equivalent_claim", "mixed_conditions", "applicability_ended", "source_changed", "pattern_observed", "unchanged", "format_only"]),
  targetRefs: Type.Array(Type.Object({ memoryId: id(), expectedRevision: Type.Integer({ minimum: 0 }), beforeHash: hash() }, closed), { maxItems: 8 }),
  quotes: Type.Array(Type.Object({ evidenceId: id(), quote: Type.String({ minLength: 1, maxLength: 8192 }), start: Type.Integer({ minimum: 0, maximum: 65536 }), end: Type.Integer({ minimum: 1, maximum: 65536 }) }, closed), { maxItems: 8 }),
  proposedText: Type.Optional(Type.String({ minLength: 8, maxLength: 8192 })),
  kind: Type.Optional(enumeration(["preference", "decision", "entity", "fact", "task", "plan", "goal", "document", "knowledge", "observation", "other"])),
  semanticType: Type.Optional(enumeration(["profile", "task_context", "rules", "experience", "resource"])),
  profileDimension: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
  validFrom: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
  validTo: Type.Optional(Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
}, closed);

export class EvolutionError extends Error {
  constructor(readonly code: string) { super(code); this.name = "EvolutionError"; }
}
export const EVOLUTION_REVIEW_DECISION_SCHEMA = Type.Object({
  reviewId: id(), expectedBindingHash: hash(), decision: enumeration(["approve", "reject"]), idempotencyKey: id(),
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
}, closed);
export const EVOLUTION_PROPOSAL_LIST_SCHEMA = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 1024 })),
  batchId: Type.Optional(id()), status: Type.Optional(enumeration(["staged", "rejected", "review", "applied", "noop"])),
}, closed);
export function parseEvolutionProposalList(value: unknown): EvolutionProposalListRequest {
  return checked<EvolutionProposalListRequest>(value, EVOLUTION_PROPOSAL_LIST_SCHEMA, 4096);
}
export function parseEvolutionReviewDecision(value: unknown): EvolutionReviewDecisionRequest {
  return checked<EvolutionReviewDecisionRequest>(value, EVOLUTION_REVIEW_DECISION_SCHEMA, 4096);
}
function assertPlain(value: unknown, depth = 0): void {
  if (depth > 16) throw new EvolutionError("schema_invalid");
  if (value === null || typeof value !== "object") {
    if (["undefined", "function", "symbol", "bigint"].includes(typeof value) || typeof value === "number" && !Number.isFinite(value)) throw new EvolutionError("schema_invalid");
    return;
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new EvolutionError("schema_invalid");
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (["__proto__", "prototype", "constructor"].includes(key) || !Object.hasOwn(descriptor, "value")) throw new EvolutionError("schema_invalid");
    assertPlain(descriptor.value, depth + 1);
  }
}
function checked<T>(value: unknown, schema: TSchema, maxBytes: number): T {
  assertPlain(value);
  if (Buffer.byteLength(JSON.stringify(value)) > maxBytes || !Value.Check(schema, value)) throw new EvolutionError("schema_invalid");
  return structuredClone(value) as T;
}
export function parseEvolutionRunRequest(value: unknown): EvolutionRunRequest & { limits: EvolutionLimits } {
  const request = checked<EvolutionRunRequest>(value, EVOLUTION_RUN_REQUEST_SCHEMA, 16_384);
  return { ...request, limits: { ...DEFAULT_EVOLUTION_LIMITS, ...request.limits } };
}
export function parseEvolutionControlRequest(value: unknown): EvolutionControlRequest & { limits: EvolutionLimits } {
  const request = checked<EvolutionControlRequest>(value, EVOLUTION_CONTROL_REQUEST_SCHEMA, 16_384);
  const source = request.input.work.kind === "source_reconcile";
  const maxFiles = source ? request.limits?.maxFiles ?? DEFAULT_EVOLUTION_LIMITS.maxFiles : 0;
  if (source && maxFiles === 0) throw new EvolutionError("schema_invalid");
  return { ...request, limits: { ...DEFAULT_EVOLUTION_LIMITS, ...request.limits, maxFiles, maxLlmCalls: 0, maxInputTokens: 0, maxOutputTokens: 0 } };
}
export function parseEvolutionControlResult(value: unknown): EvolutionControlResult {
  return checked<EvolutionControlResult>(value, controlResultSchema, 32768);
}
export function parseEvolutionProposal(value: unknown): EvolutionProposalDraft {
  const draft = checked<EvolutionProposalDraft>(value, EVOLUTION_PROPOSAL_SCHEMA, 100_000);
  const singleTarget = ["add_evidence", "correct", "evolve", "mark_disputed", "deprecate", "expire", "split_conditions"];
  if (singleTarget.includes(draft.operation) && draft.targetRefs.length !== 1 ||
      draft.operation === "create" && draft.targetRefs.length !== 0 ||
      draft.operation === "merge_equivalent" && draft.targetRefs.length < 2 ||
      ["create", "correct", "evolve"].includes(draft.operation) && !draft.proposedText ||
      draft.operation !== "noop" && !draft.quotes.length ||
      new Set(draft.targetRefs.map(r => r.memoryId)).size !== draft.targetRefs.length ||
      draft.quotes.some(q => q.end <= q.start || q.end - q.start !== q.quote.length) ||
      draft.validFrom !== undefined && draft.validTo !== undefined && draft.validTo <= draft.validFrom) throw new EvolutionError("schema_invalid");
  return draft;
}

/** Checkpoints hold positions/identities only. Never persist source content as adapter state. */
export function assertEvolutionCheckpoint(value: unknown): void {
  assertPlain(value);
  if (Buffer.byteLength(JSON.stringify(value)) > 16_384) throw new EvolutionError("checkpoint_too_large");
  const visit = (v: unknown): void => {
    if (typeof v === "string" && v.length > 1024) throw new EvolutionError("checkpoint_too_large");
    if (v && typeof v === "object") for (const [key, child] of Object.entries(v)) {
      if (/^(?:text|body|quote|context|messages|records|evidence|content|proposedText)$/i.test(key)) throw new EvolutionError("checkpoint_content_forbidden");
      visit(child);
    }
  };
  visit(value);
}
