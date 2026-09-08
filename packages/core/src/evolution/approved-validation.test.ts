import { describe, expect, it } from "vitest";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { evolutionHash } from "./fingerprints.js";
import { buildEvolutionReviewBinding } from "./review-binding.js";
import { validateEvolutionApprovedProposal, validateEvolutionProposal } from "./proposal-validation.js";
import { draft, scope, unit } from "./test-fixtures.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDraft, EvolutionReviewReceipt } from "./types.js";

function approved(input: EvolutionInputUnit, change: Partial<EvolutionProposalDraft> = {}) {
  const proposal: EvolutionProposal = { ...draft(input), ...change, id: "proposal", batchId: "batch", inputUnitId: input.id, scope, scopeFingerprint: authorityScopeFingerprint(scope), inputFingerprint: "input", sourceSnapshotHash: input.snapshotHash, configFingerprint: "config", policyVersion: "policy", status: "review", validation: { outcome: "review", reasons: [], contextEligible: false, independentEvidenceRootIds: [], reviewRequirement: "owner" }, createdAt: 1 };
  const binding = buildEvolutionReviewBinding(proposal, input);
  const receipt: EvolutionReviewReceipt = { id: "approval", reviewId: "review", binding, bindingHash: evolutionHash(binding), decision: "approve", actor: { tenantId: scope.tenantId, userId: scope.userId, actorId: "operator", authentication: "authenticated_owner" }, idempotencyKey: "decision", decidedAt: 1000, expiresAt: 2000 };
  return { proposal, receipt, validate: () => validateEvolutionApprovedProposal(proposal, input, scope, receipt, 1000) };
}
function targeted() {
  const input = unit(); input.evidence[0].trust = "untrusted";
  const text = "The project database runs PostgreSQL 15.";
  input.targets = [{ memoryId: "target", expectedRevision: 4, beforeHash: computeCanonicalContentHash(text), text, scope, kind: "fact", createdAt: 1, evidenceRootIds: ["original-root"], pinned: true }];
  return input;
}

describe("approval cannot waive deterministic evidence or target invariants", () => {
  it("permits explicitly reviewed pin changes without forging source authorship", () => {
    const input = targeted(); const t = approved(input, { operation: "correct", targetRefs: input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })) });
    expect(validateEvolutionProposal(t.proposal, input, scope)).toMatchObject({ outcome: "review" });
    expect(t.validate()).toMatchObject({ outcome: "allowed", evidenceMode: "reviewed_reference", independentEvidenceRootIds: [], contextEligible: false });
  });
  it.each(["expectedRevision", "pinned", "highImpact", "tombstoned", "kind", "validFrom"] as const)("binds current target %s, not only a matching beforeHash", field => {
    const input = targeted(); const t = approved(input, { operation: "correct", targetRefs: input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })) });
    Object.assign(input.targets[0], { [field]: field === "kind" ? "decision" : field === "expectedRevision" || field === "validFrom" ? 100 : !input.targets[0][field] });
    expect(() => t.validate()).toThrow("approval_binding_mismatch");
  });
  it("requires explicit validFrom matching the same evidence even after approval", () => {
    const input = targeted(); const refs = input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    expect(approved(input, { operation: "evolve", targetRefs: refs, validFrom: 100 }).validate().outcome).toBe("allowed");
    expect(approved(input, { operation: "evolve", targetRefs: refs, validFrom: 101 }).validate()).toMatchObject({ outcome: "review", reasons: ["valid_time_unverified"] });
  });
  it("never increases support for a repeated root and never treats unrelated evidence as add_evidence", () => {
    const input = targeted(); input.targets[0].text = input.evidence[0].text; input.targets[0].beforeHash = input.evidence[0].snapshotHash; input.targets[0].pinned = false;
    input.evidence[0].trust = "verified_document"; input.targets[0].evidenceRootIds = [input.evidence[0].rootEvidenceId];
    const refs = input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    expect(approved(input, { operation: "add_evidence", targetRefs: refs }).validate()).toMatchObject({ outcome: "noop", independentEvidenceRootIds: [] });
    input.evidence.push(unit("other", "An unrelated retention rule applies for one week.").evidence[0]);
    const quotes = input.evidence.map(e => ({ evidenceId: e.id, quote: e.text, start: 0, end: e.text.length }));
    expect(approved(input, { operation: "add_evidence", targetRefs: refs, quotes }).validate()).toMatchObject({ outcome: "review", reasons: ["evidence_semantics_unverified"] });
  });
  it("requires equivalence of content, classification and valid interval for an approved merge", () => {
    const input = targeted(); input.targets[0].text = input.evidence[0].text; input.targets[0].beforeHash = input.evidence[0].snapshotHash;
    input.targets.push({ ...input.targets[0], memoryId: "second" });
    const refs = input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    expect(approved(input, { operation: "merge_equivalent", targetRefs: refs }).validate()).toMatchObject({ outcome: "allowed", independentEvidenceRootIds: [] });
    input.targets[1].validFrom = 500;
    expect(approved(input, { operation: "merge_equivalent", targetRefs: refs }).validate()).toMatchObject({ outcome: "review", reasons: ["merge_equivalence_unverified"] });
  });
  it.each(["revalidate", "mark_disputed", "deprecate", "expire"] as const)("permits the explicitly reviewed %s operation as a reference-only administrative action", operation => {
    const input = targeted(); const t = approved(input, { operation, targetRefs: input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })), proposedText: undefined, ...(operation === "expire" ? { validTo: 500 } : {}) });
    expect(t.validate()).toMatchObject({ outcome: "allowed", independentEvidenceRootIds: [], contextEligible: false, evidenceMode: "reviewed_reference" });
  });
  it("cannot expire before the target's validFrom or use a future expiry", () => {
    const input = targeted(); input.targets[0].validFrom = 900;
    const refs = input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    expect(approved(input, { operation: "expire", targetRefs: refs, validTo: 500, proposedText: undefined }).validate()).toMatchObject({ outcome: "review", reasons: ["valid_time_unverified"] });
    expect(approved(input, { operation: "expire", targetRefs: refs, validTo: 3000, proposedText: undefined }).validate().outcome).toBe("review");
  });
  it.each(["split_conditions", "compile_pattern", "propose_skill"] as const)("does not convert suggest-only %s into a content write", operation => {
    const input = targeted(); const refs = input.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash }));
    expect(approved(input, { operation, targetRefs: refs }).validate()).toMatchObject({ outcome: "review", reasons: ["operation_requires_owner_review"] });
  });
  it("cannot accept rewritten negation, omitted context, extra unrelated quotes or evaluation evidence", () => {
    const input = unit("negative", "Never expose project credentials to the public.");
    expect(approved(input, { proposedText: "Expose project credentials to the public." }).validate().outcome).toBe("rejected");
    input.evidence[0].origin = "evaluation";
    expect(approved(input).validate()).toMatchObject({ outcome: "rejected", reasons: ["evaluation_evidence_forbidden"] });
    input.evidence[0].origin = "external"; input.evidence[0].contextIncomplete = true;
    expect(approved(input).validate()).toMatchObject({ outcome: "review", reasons: ["source_context_incomplete"] });
    delete input.evidence[0].contextIncomplete; input.evidence.push(unit("extra", "An unrelated archive policy applies to backups.").evidence[0]);
    expect(approved(input, { quotes: input.evidence.map(e => ({ evidenceId: e.id, quote: e.text, start: 0, end: e.text.length })) }).validate()).toMatchObject({ outcome: "review", reasons: ["unrelated_evidence_requires_review"] });
  });
});
