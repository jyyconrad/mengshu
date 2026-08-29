import type { MemorySemanticType } from "../domain/types.js";
import type { DocumentGovernanceProposal } from "./types.js";

export type DocumentGovernanceReasonCode =
  | "SCOPE_MISMATCH"
  | "VERSION_CONFLICT"
  | "KIND_CONTRACT_INVALID"
  | "DISPOSITION_INCOMPLETE"
  | "DISPOSITION_INVALID"
  | "INPUT_UNREADABLE"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_UNREADABLE"
  | "UNRESOLVED_CONFLICT"
  | "SENSITIVE_DISCLOSURE"
  | "SEMANTIC_TYPE_CHANGE"
  | "PROTECTED_SEMANTIC_TYPE"
  | "GLOBAL_TREE_CHANGE"
  | "CLAIM_OWNERSHIP_CHANGE"
  | "DESTRUCTIVE_ACTION"
  | "RISK_REVIEW_REQUIRED"
  | "MODEL_REVIEW_REQUIRED";

export interface EvaluateDocumentGovernanceProposalInput {
  readonly proposal: DocumentGovernanceProposal;
  readonly expectedScopeFingerprint: string;
  readonly expectedLatestVersion: number;
  readonly selectedInformationRefs: readonly string[];
  readonly readableEvidenceRefs: readonly string[];
  readonly readableInputRefs: readonly string[];
  readonly unresolvedConflictRefs: readonly string[];
  readonly sensitiveDisclosureRefs: readonly string[];
  readonly previousSemanticType?: MemorySemanticType;
  readonly policyVersion: string;
}

export interface DocumentGovernanceEvaluation {
  readonly decision: "auto_apply" | "review" | "quarantine";
  readonly reasonCodes: readonly DocumentGovernanceReasonCode[];
  readonly selectedInformationCount: number;
  readonly dispositionCoverage: number;
  readonly claimEvidenceCoverage: number;
  readonly policyVersion: string;
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function kindContractValid(proposal: DocumentGovernanceProposal): boolean {
  if (proposal.kind === "memory_document") {
    return proposal.purpose === "typed_memory" && proposal.semanticType !== undefined &&
      proposal.treeRef === undefined;
  }
  if (proposal.kind === "tree_document") {
    return proposal.purpose === "tree_summary" && proposal.semanticType === undefined &&
      proposal.treeRef !== undefined;
  }
  return proposal.kind === "index_document" &&
    proposal.purpose !== "typed_memory" && proposal.purpose !== "tree_summary" &&
    proposal.semanticType === undefined && proposal.treeRef === undefined;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function evaluateDocumentGovernanceProposal(
  input: EvaluateDocumentGovernanceProposalInput,
): DocumentGovernanceEvaluation {
  const quarantine: DocumentGovernanceReasonCode[] = [];
  const review: DocumentGovernanceReasonCode[] = [];
  const proposal = input.proposal;

  if (proposal.scopeFingerprint !== input.expectedScopeFingerprint) {
    quarantine.push("SCOPE_MISMATCH");
  }
  if (proposal.expectedLatestVersion !== input.expectedLatestVersion) {
    quarantine.push("VERSION_CONFLICT");
  }
  if (!kindContractValid(proposal)) quarantine.push("KIND_CONTRACT_INVALID");

  const selected = new Set(input.selectedInformationRefs);
  const dispositionRefs = proposal.dispositions.map((item) => item.informationRef);
  const covered = input.selectedInformationRefs.filter((ref) =>
    dispositionRefs.filter((candidate) => candidate === ref).length === 1).length;
  if (!unique(input.selectedInformationRefs) || covered !== input.selectedInformationRefs.length) {
    quarantine.push("DISPOSITION_INCOMPLETE");
  }
  const invalidDisposition = !unique(dispositionRefs) || proposal.dispositions.some((item) =>
    !selected.has(item.informationRef) || item.scopeFingerprint !== proposal.scopeFingerprint ||
    item.governanceRunId !== proposal.governanceRunId || item.reasonCode.length === 0 ||
    (["attached_to_typed_document", "attached_and_routed"].includes(item.disposition) &&
      (item.semanticType === undefined || item.targetAssetIds.length === 0)) ||
    (["tree_only", "attached_and_routed"].includes(item.disposition) &&
      item.treeRoutes.length === 0));
  if (invalidDisposition) quarantine.push("DISPOSITION_INVALID");

  const readableInputs = new Set(input.readableInputRefs);
  const readableEvidence = new Set(input.readableEvidenceRefs);
  const conflicts = new Set(input.unresolvedConflictRefs);
  const sensitive = new Set(input.sensitiveDisclosureRefs);
  let claimCount = 0;
  let groundedClaims = 0;
  let inputUnreadable = false;
  let evidenceRequired = false;
  let evidenceUnreadable = false;
  let unresolvedConflict = false;
  let sensitiveDisclosure = false;
  for (const section of proposal.sections) {
    for (const claim of section.claims) {
      claimCount += 1;
      if (claim.inputRefs.length === 0 ||
          claim.inputRefs.some((ref) => !readableInputs.has(ref) || !selected.has(ref))) {
        inputUnreadable = true;
      }
      if (claim.evidenceRefs.length === 0) {
        evidenceRequired = true;
      } else if (claim.evidenceRefs.some((ref) => !readableEvidence.has(ref))) {
        evidenceUnreadable = true;
      } else {
        groundedClaims += 1;
      }
      if (claim.inputRefs.some((ref) => conflicts.has(ref))) unresolvedConflict = true;
      if ([...claim.inputRefs, ...claim.evidenceRefs].some((ref) => sensitive.has(ref))) {
        sensitiveDisclosure = true;
      }
    }
  }
  if (inputUnreadable) quarantine.push("INPUT_UNREADABLE");
  if (evidenceRequired) quarantine.push("EVIDENCE_REQUIRED");
  if (evidenceUnreadable) quarantine.push("EVIDENCE_UNREADABLE");
  if (unresolvedConflict) quarantine.push("UNRESOLVED_CONFLICT");
  if (sensitiveDisclosure) quarantine.push("SENSITIVE_DISCLOSURE");

  if (input.previousSemanticType !== undefined &&
      proposal.semanticType !== input.previousSemanticType) {
    review.push("SEMANTIC_TYPE_CHANGE");
  }
  if (proposal.semanticType === "rules" || proposal.semanticType === "profile") {
    review.push("PROTECTED_SEMANTIC_TYPE");
  }
  if (proposal.treeRef?.treeType === "global") review.push("GLOBAL_TREE_CHANGE");
  if (proposal.action === "split" || proposal.action === "merge") {
    review.push("CLAIM_OWNERSHIP_CHANGE");
  }
  if (proposal.action === "deprecate") review.push("DESTRUCTIVE_ACTION");
  if (proposal.riskClass !== "low") review.push("RISK_REVIEW_REQUIRED");
  if (proposal.reviewReasons.length > 0) review.push("MODEL_REVIEW_REQUIRED");

  const reasonCodes = quarantine.length > 0 ? quarantine : review;
  return Object.freeze({
    decision: quarantine.length > 0 ? "quarantine" : review.length > 0 ? "review" : "auto_apply",
    reasonCodes: Object.freeze([...new Set(reasonCodes)]),
    selectedInformationCount: input.selectedInformationRefs.length,
    dispositionCoverage: ratio(covered, input.selectedInformationRefs.length),
    claimEvidenceCoverage: ratio(groundedClaims, claimCount),
    policyVersion: input.policyVersion,
  });
}
