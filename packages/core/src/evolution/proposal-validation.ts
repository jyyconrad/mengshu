import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import { validateCandidateWithReceipt } from "../lifecycle/candidate-validator.js";
import { detectSensitive } from "../lifecycle/sensitive-filter.js";
import { PROMPT_INJECTION_PATTERNS } from "../runtime/llm/extraction-rules.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { assertEvolutionApproval } from "./review-binding.js";
import type { EvolutionInputUnit, EvolutionProposal, EvolutionProposalDraft, EvolutionReviewReceipt, EvolutionStagedEvidence, EvolutionValidation } from "./types.js";

const exactText = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();
export function validateEvolutionProposal(draft: EvolutionProposalDraft, unit: EvolutionInputUnit, scope: MemoryScope): EvolutionValidation {
  return validate(draft, unit, scope);
}
export function validateEvolutionApprovedProposal(proposal: EvolutionProposal, unit: EvolutionInputUnit, scope: MemoryScope, approval: EvolutionReviewReceipt, now: number): EvolutionValidation {
  assertEvolutionApproval(proposal, unit, approval, now);
  return validate(proposal, unit, scope, approval);
}
function validate(draft: EvolutionProposalDraft, unit: EvolutionInputUnit, scope: MemoryScope, approval?: EvolutionReviewReceipt): EvolutionValidation {
  const result: EvolutionValidation = { outcome: "allowed", reasons: [], reviewRequirement: "none", independentEvidenceRootIds: [], contextEligible: false };
  const reject = (reason: string): EvolutionValidation => ({ ...result, outcome: "rejected", reasons: [reason] });
  const review = (reason: string): EvolutionValidation => ({ ...result, outcome: "review", reasons: [reason], reviewRequirement: "owner", independentEvidenceRootIds: [] });
  const fingerprint = authorityScopeFingerprint(scope);
  if ([unit.scope, ...unit.evidence.map(e => e.scope), ...unit.targets.map(t => t.scope)].some(s => authorityScopeFingerprint(s) !== fingerprint)) return reject("scope_mismatch");
  if (new Set(unit.evidence.map(e => e.id)).size !== unit.evidence.length || new Set(unit.targets.map(t => t.memoryId)).size !== unit.targets.length) return reject("ambiguous_input_identity");
  for (const ref of draft.targetRefs) {
    const target = unit.targets.find(t => t.memoryId === ref.memoryId);
    if (!target || target.beforeHash !== ref.beforeHash || target.expectedRevision !== ref.expectedRevision || computeCanonicalContentHash(target.text) !== ref.beforeHash) return reject("target_cas_conflict");
    if (target.tombstoned) return reject("target_tombstoned");
    if (draft.kind && target.kind !== draft.kind || draft.semanticType && target.semanticType !== draft.semanticType) return reject("target_classification_changed");
  }
  const refs = draft.quotes.map(q => unit.evidence.find(e => e.id === q.evidenceId));
  for (let index = 0; index < draft.quotes.length; index++) {
    const quote = draft.quotes[index];
    const source = refs[index];
    if (!source || source.text.slice(quote.start, quote.end) !== quote.quote) return reject("quote_mismatch");
    if (source.revoked) return reject("source_revoked");
    if (computeCanonicalContentHash(source.text) !== source.snapshotHash) return reject("evidence_hash_mismatch");
    // Only whole statements are admissible; substring matching can clip negation/conditions.
    const before = source.text.slice(0, quote.start);
    const after = source.text.slice(quote.end);
    if (before.trim() && !/[.!?\u3002\uff01\uff1f\n]\s*$/.test(before) || after.trim() && !/[.!?\u3002\uff01\uff1f\n]\s*$/.test(quote.quote)) return reject("quote_context_clipped");
  }
  if (unit.evidence.some(e => e.contextIncomplete)) return review("source_context_incomplete");
  if (draft.operation === "noop") return { ...result, outcome: "noop", reasons: ["unchanged"] };
  const comparedText = draft.operation === "add_evidence" ? unit.targets.find(t => t.memoryId === draft.targetRefs[0]?.memoryId)?.text : draft.proposedText;
  const matched = draft.quotes.flatMap((quote, index) => comparedText && exactText(quote.quote) === exactText(comparedText) ? [{ quote, evidence: refs[index]! }] : []);
  // Authorization, claim truth and independence must come from the same matching span.
  const support = matched.filter(({ evidence }) => evidence.origin === "external" && evidence.trust !== "untrusted" && !evidence.revoked);
  if (draft.operation === "add_evidence" && (matched.length !== draft.quotes.length || draft.proposedText && exactText(draft.proposedText) !== exactText(comparedText ?? ""))) return review("evidence_semantics_unverified");
  const oldRoots = new Set(unit.targets.flatMap(t => t.evidenceRootIds));
  result.independentEvidenceRootIds = [...new Set(support.filter(({ evidence }) => !oldRoots.has(evidence.rootEvidenceId)).map(({ evidence }) => evidence.rootEvidenceId))];
  if (draft.operation === "add_evidence" && !result.independentEvidenceRootIds.length) return { ...result, outcome: "noop", reasons: ["no_independent_evidence"] };
  if (["split_conditions", "compile_pattern", "propose_skill"].includes(draft.operation) || draft.claimClass === "skill") return review("operation_requires_owner_review");
  if (!approval && ["merge_equivalent", "revalidate"].includes(draft.operation)) return review("operation_requires_owner_review");
  if (!approval && (unit.targets.some(t => t.pinned || t.highImpact || t.kind === "decision" || t.semanticType === "rules") || ["decision", "constraint"].includes(draft.claimClass) || draft.kind === "decision" || draft.semanticType === "rules")) return review("high_impact_owner_review");
  if (refs.some(e => e?.origin === "evaluation")) return reject("evaluation_evidence_forbidden");
  if (draft.proposedText && !draft.quotes.some(q => exactText(q.quote) === exactText(draft.proposedText!))) return reject("semantic_rewrite_unverified");
  // Downstream evidence links must not treat extra unrelated quotes as effective support.
  if (["create", "evolve", "correct"].includes(draft.operation) && matched.length !== draft.quotes.length) return review("unrelated_evidence_requires_review");
  if (draft.proposedText && PROMPT_INJECTION_PATTERNS.some(pattern => pattern.test(draft.proposedText!))) return reject("prompt_injection");
  if (draft.proposedText && detectSensitive(draft.proposedText).sensitive) return review("sensitive_content");
  if (!approval && !support.length) return review("source_authority_unverified");
  const cited = approval ? draft.quotes.map((quote, i) => ({ evidence: refs[i]!, quote })) : support;
  if (cited.some(({ evidence, quote }) => exactText(evidence.text) !== exactText(quote.quote))) return review("evidence_context_requires_review");
  if (!approval && draft.claimClass === "preference" && !support.some(({ evidence }) => evidence.trust === "user_statement")) return review("user_statement_required");
  if (!approval && ["experience", "task"].includes(draft.claimClass) && !support.some(({ evidence }) => evidence.trust === "verified_result" || evidence.trust === "user_statement")) return review("verified_outcome_required");
  if (["correct", "evolve"].includes(draft.operation)) {
    if (!approval && !draft.targetRefs.every(t => support.some(({ evidence }) => evidence.authorizedTargetIds?.includes(t.memoryId)))) return review("target_authorization_required");
    if (draft.operation === "evolve" && (draft.validFrom === undefined || !(approval ? cited : support).some(({ evidence }) => (approval || evidence.authorizedTargetIds?.includes(draft.targetRefs[0].memoryId)) && evidence.occurredAt === draft.validFrom))) return review("valid_time_unverified");
  }
  if (!approval && ["mark_disputed", "deprecate", "expire"].includes(draft.operation)) return review("classification_review_required");
  if (draft.operation === "merge_equivalent") {
    const targets = draft.targetRefs.map(ref => unit.targets.find(t => t.memoryId === ref.memoryId)!);
    const first = targets[0];
    if (targets.length < 2 || targets.some(t => exactText(t.text) !== exactText(first.text) || t.kind !== first.kind || t.semanticType !== first.semanticType || t.validFrom !== first.validFrom || t.validTo !== first.validTo) || draft.quotes.some(q => exactText(q.quote) !== exactText(first.text))) return review("merge_equivalence_unverified");
    result.independentEvidenceRootIds = [];
  }
  if (draft.operation === "expire" && (draft.validTo === undefined || approval && draft.validTo > approval.decidedAt || draft.targetRefs.some(ref => { const from = unit.targets.find(t => t.memoryId === ref.memoryId)?.validFrom; return from !== undefined && draft.validTo! <= from; }))) return review("valid_time_unverified");
  if (draft.proposedText && draft.semanticType) {
    const { evidence: source, quote } = support[0] ?? cited[0];
    const checked = validateCandidateWithReceipt({ text: draft.proposedText, semanticType: draft.semanticType, profileDimension: draft.profileDimension, salience: 0.5, temporality: "persistent", crossContextual: false, targetScope: "project", evidence: { quote: quote.quote, eventIds: [source.id] } }, { text: source.text, scope: "project", eventIds: [source.id] });
    result.candidateReceipt = checked.receipt;
    if (checked.verdict.rejected) return reject(`candidate_${checked.verdict.reason}`);
    if (checked.verdict.evidenceOnly || checked.verdict.riskFlags.length) return review("candidate_evidence_only");
    result.contextEligible = true;
  } else if (draft.proposedText) {
    if (draft.proposedText.replace(/\s/g, "").length < 8 || !draft.kind) return reject("kind_only_invalid");
    result.reasons.push("kind_only_lookup_only");
  }
  if (approval) {
    result.ownerApprovalReceiptId = approval.id;
    result.evidenceMode = support.length ? "verified_support" : "reviewed_reference";
    if (!support.length) { result.contextEligible = false; result.independentEvidenceRootIds = []; result.reasons.push("owner_reviewed_reference"); }
  }
  return result;
}

export function stageEvolutionEvidence(draft: EvolutionProposalDraft, unit: EvolutionInputUnit): EvolutionStagedEvidence[] {
  return draft.quotes.flatMap(quote => {
    const source = unit.evidence.find(e => e.id === quote.evidenceId);
    if (!source || source.text.slice(quote.start, quote.end) !== quote.quote) return [];
    const { text: _text, ...reference } = source;
    return [{ ...reference, quote: quote.quote, start: quote.start, end: quote.end }];
  });
}
