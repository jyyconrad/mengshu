import type { EvolutionBatchReport, EvolutionReviewDecisionRequest, EvolutionReviewItem, EvolutionReviewReceipt, EvolutionProposal, EvolutionProposalDetail, EvolutionProposalListRequest, EvolutionProposalPage } from "../../core/src/evolution/types.js";
import { EvolutionError, EVOLUTION_REVIEW_DECISION_SCHEMA, EVOLUTION_PROPOSAL_LIST_SCHEMA, parseEvolutionProposal, parseEvolutionProposalList, parseEvolutionReviewDecision } from "../../core/src/evolution/schema.js";
import { evolutionProposalDraft } from "../../core/src/evolution/review-binding.js";
import { EvolutionTransportError, publicEvolutionReport, type EvolutionBatchCapability } from "./evolution.js";

export interface EvolutionReviewCapability {
  list?(request: EvolutionProposalListRequest): Promise<EvolutionProposalPage>;
  detail?(proposalId: string): Promise<EvolutionProposalDetail | undefined>;
  preview(proposalId: string): Promise<EvolutionReviewItem>;
  status(reviewId: string): Promise<EvolutionReviewItem | undefined>;
  decide(request: EvolutionReviewDecisionRequest): Promise<EvolutionReviewReceipt>;
  apply(approvalReceiptId: string): Promise<EvolutionBatchReport>;
}
export const EVOLUTION_CONTROL_OPERATIONS = ["review/list", "review/detail", "review/preview", "review/status", "review/decide", "review/apply", "cancel"] as const;
export type EvolutionControlOperation = typeof EVOLUTION_CONTROL_OPERATIONS[number];
export function isEvolutionControlOperation(operation: string): operation is EvolutionControlOperation {
  return (EVOLUTION_CONTROL_OPERATIONS as readonly string[]).includes(operation);
}
export function isEvolutionOwnerTool(name: string): boolean {
  return name.startsWith("memory_evolution_review_") || name.startsWith("memory_evolution_source_") || name.startsWith("memory_evolution_reuse_") || name === "memory_evolution_cancel";
}
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function evolutionControlSchema(operation: EvolutionControlOperation): Record<string, unknown> {
  if (operation === "review/list") return EVOLUTION_PROPOSAL_LIST_SCHEMA;
  if (operation === "review/decide") return EVOLUTION_REVIEW_DECISION_SCHEMA;
  const field = operation === "cancel" ? "batchId" : operation === "review/apply" ? "approvalReceiptId" : operation === "review/status" ? "reviewId" : "proposalId";
  return { type: "object", additionalProperties: false, required: [field], properties: { [field]: { type: "string", minLength: 1, maxLength: 128, pattern: ID.source } } };
}

export function publicEvolutionProposalSummary(proposal: EvolutionProposal) {
  return { id: proposal.id, batchId: proposal.batchId, status: proposal.status, createdAt: proposal.createdAt,
    operation: proposal.operation, claimClass: proposal.claimClass, reasonCode: proposal.reasonCode,
    configFingerprint: proposal.configFingerprint, policyVersion: proposal.policyVersion,
    validation: { outcome: proposal.validation.outcome, reasons: proposal.validation.reasons.slice(0, 32),
      reviewRequirement: proposal.validation.reviewRequirement, contextEligible: proposal.validation.contextEligible } };
}

export function publicEvolutionProposalDetail(detail: EvolutionProposalDetail) {
  const result = { ...publicEvolutionProposalSummary(detail.proposal), proposal: parseEvolutionProposal(evolutionProposalDraft(detail.proposal)),
    evidence: detail.evidence.map(evidence => ({ id: evidence.id, sourceId: evidence.sourceId, revision: evidence.revision,
      snapshotHash: evidence.snapshotHash, quote: evidence.quote, start: evidence.start, end: evidence.end,
      trust: evidence.trust, contextIncomplete: evidence.contextIncomplete === true })),
    ...(detail.review ? { review: { id: detail.review.id, reviewId: detail.review.reviewId,
      bindingHash: detail.review.bindingHash, decision: detail.review.decision, expiresAt: detail.review.expiresAt } } : {}),
  };
  if (result.evidence.length > 8 || Buffer.byteLength(JSON.stringify(result)) > 128_000) throw new EvolutionTransportError(500, "EVOLUTION_REVIEW_LIMIT_EXCEEDED");
  return result;
}
function identifier(value: unknown, key: string): string {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 1 ||
      !(key in value) || typeof (value as Record<string, unknown>)[key] !== "string" || !ID.test((value as Record<string, string>)[key]!)) {
    throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID");
  }
  return (value as Record<string, string>)[key]!;
}

/** Review is an owner-only diff, not a public raw-source/locator dump. Never truncate a diff being approved. */
export function publicEvolutionReview(review: EvolutionReviewItem) {
  const result = {
    id: review.id, proposalId: review.binding.proposalId, bindingHash: review.bindingHash,
    status: review.status, createdAt: review.createdAt, expiresAt: review.expiresAt,
    proposal: parseEvolutionProposal(review.proposal),
    targets: review.targets.map(target => ({ memoryId: target.memoryId, expectedRevision: target.expectedRevision, beforeHash: target.beforeHash, text: target.text })),
    evidence: review.evidence.map(evidence => ({ id: evidence.id, sourceId: evidence.sourceId, revision: evidence.revision,
      snapshotHash: evidence.snapshotHash, quote: evidence.quote, start: evidence.start, end: evidence.end,
      trust: evidence.trust, contextIncomplete: evidence.contextIncomplete === true })),
  };
  if (result.targets.length > 8 || result.evidence.length > 8 || Buffer.byteLength(JSON.stringify(result)) > 128_000) {
    throw new EvolutionTransportError(500, "EVOLUTION_REVIEW_LIMIT_EXCEEDED");
  }
  return result;
}

export async function invokeEvolutionControl(capability: EvolutionBatchCapability, operation: EvolutionControlOperation, value: unknown): Promise<unknown> {
  if (operation === "cancel" ? !capability.cancel : !capability.review) {
    throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
  }
  try {
    if (operation === "review/list") {
      if (!capability.review?.list) throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
      let request: EvolutionProposalListRequest;
      try { request = parseEvolutionProposalList(value); }
      catch { throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID"); }
      const page = await capability.review.list(request);
      if (page.proposals.length > (request.limit ?? 20)) throw new EvolutionTransportError(500, "EVOLUTION_REVIEW_LIMIT_EXCEEDED");
      return { proposals: page.proposals.map(publicEvolutionProposalSummary), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
    }
    if (operation === "review/detail") {
      if (!capability.review?.detail) throw new EvolutionTransportError(404, "EVOLUTION_CONTROL_UNAVAILABLE");
      const detail = await capability.review.detail(identifier(value, "proposalId"));
      if (!detail) throw new EvolutionTransportError(404, "EVOLUTION_PROPOSAL_NOT_FOUND");
      return publicEvolutionProposalDetail(detail);
    }
    if (operation === "cancel") return publicEvolutionReport(await capability.cancel!(identifier(value, "batchId")));
    if (operation === "review/apply") return publicEvolutionReport(await capability.review!.apply(identifier(value, "approvalReceiptId")));
    if (operation === "review/decide") {
      let request: EvolutionReviewDecisionRequest;
      try { request = parseEvolutionReviewDecision(value); }
      catch { throw new EvolutionTransportError(400, "EVOLUTION_REQUEST_INVALID"); }
      const receipt = await capability.review!.decide(request);
      return { id: receipt.id, reviewId: receipt.reviewId, bindingHash: receipt.bindingHash,
        decision: receipt.decision, decidedAt: receipt.decidedAt, expiresAt: receipt.expiresAt,
        ...(receipt.reason ? { reason: receipt.reason } : {}) };
    }
    const review = operation === "review/preview" ? await capability.review!.preview(identifier(value, "proposalId")) :
      await capability.review!.status(identifier(value, "reviewId"));
    if (!review) throw new EvolutionTransportError(404, "EVOLUTION_REVIEW_NOT_FOUND");
    return publicEvolutionReview(review);
  } catch (error) {
    if (error instanceof EvolutionError) {
      const status = error.code.endsWith("_not_found") ? 404 : 409;
      throw new EvolutionTransportError(status, /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? `EVOLUTION_${error.code.toUpperCase()}` : "EVOLUTION_REVIEW_REJECTED");
    }
    throw error;
  }
}
