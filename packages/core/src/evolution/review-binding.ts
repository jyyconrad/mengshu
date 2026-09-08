import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { evolutionHash } from "./fingerprints.js";
import { EvolutionError } from "./schema.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDraft, EvolutionReviewBinding, EvolutionReviewReceipt } from "./types.js";

export function evolutionProposalDraft(proposal: EvolutionProposalDraft): EvolutionProposalDraft {
  const { operation, claimClass, reasonCode, targetRefs, quotes, proposedText, kind, semanticType, profileDimension, validFrom, validTo } = proposal;
  return { operation, claimClass, reasonCode, targetRefs, quotes, ...(proposedText === undefined ? {} : { proposedText }), ...(kind === undefined ? {} : { kind }), ...(semanticType === undefined ? {} : { semanticType }), ...(profileDimension === undefined ? {} : { profileDimension }), ...(validFrom === undefined ? {} : { validFrom }), ...(validTo === undefined ? {} : { validTo }) };
}

export function buildEvolutionReviewBinding(proposal: EvolutionProposal, unit: EvolutionInputUnit): EvolutionReviewBinding {
  const evidence = proposal.quotes.map(quote => {
    const source = unit.evidence.find(e => e.id === quote.evidenceId);
    if (!source) throw new EvolutionError("review_evidence_missing");
    const { text: _text, ...reference } = source;
    return { ...reference, quote };
  });
  const targets = proposal.targetRefs.map(ref => {
    const target = unit.targets.find(t => t.memoryId === ref.memoryId);
    if (!target) throw new EvolutionError("review_target_missing");
    return target;
  });
  return {
    proposalId: proposal.reviewedProposalId ?? proposal.id,
    scopeFingerprint: authorityScopeFingerprint(unit.scope), inputFingerprint: proposal.inputFingerprint,
    sourceSnapshotHash: unit.snapshotHash, configFingerprint: proposal.configFingerprint, policyVersion: proposal.policyVersion,
    diffHash: evolutionHash(evolutionProposalDraft(proposal)), evidenceHash: evolutionHash(evidence), targetStateHash: evolutionHash(targets),
    targetRefs: targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })),
  };
}

export function assertEvolutionApproval(proposal: EvolutionProposal, unit: EvolutionInputUnit, receipt: EvolutionReviewReceipt, now: number): void {
  if (receipt.decision !== "approve" || proposal.ownerApprovalReceiptId !== undefined && proposal.ownerApprovalReceiptId !== receipt.id) throw new EvolutionError("approval_not_granted");
  if (!Number.isSafeInteger(receipt.decidedAt) || !Number.isSafeInteger(receipt.expiresAt) || receipt.decidedAt > now || receipt.expiresAt <= now || receipt.expiresAt <= receipt.decidedAt) throw new EvolutionError("approval_expired");
  if (receipt.actor.tenantId !== unit.scope.tenantId || receipt.actor.userId !== unit.scope.userId || !receipt.actor.actorId || !["local_owner", "authenticated_owner"].includes(receipt.actor.authentication)) throw new EvolutionError("review_authority_mismatch");
  if (proposal.scopeFingerprint !== authorityScopeFingerprint(unit.scope) || proposal.sourceSnapshotHash !== unit.snapshotHash ||
    receipt.bindingHash !== evolutionHash(receipt.binding) || receipt.bindingHash !== evolutionHash(buildEvolutionReviewBinding(proposal, unit))) throw new EvolutionError("approval_binding_mismatch");
}
