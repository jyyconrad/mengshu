import { createHash } from "node:crypto";

import type {
  CandidateSource,
  RawCandidate,
  RejectReason,
} from "./candidate-validator.js";

export const CANDIDATE_VALIDATION_POLICY_VERSION = "candidate-validator-v1" as const;

export const CANDIDATE_GATE_IDS = [
  "G01", "G02", "G03", "G04", "G05", "G06",
  "G07", "G08", "G09", "G10", "G11",
] as const;

export type CandidateGateId = typeof CANDIDATE_GATE_IDS[number];
export type CandidateGateStatus =
  | "passed"
  | "rejected"
  | "not_evaluated"
  | "not_applicable";
export type CandidateGateSnapshotValue = string | number | boolean | null;

export interface CandidateGateReceipt {
  readonly gateId: CandidateGateId;
  readonly status: CandidateGateStatus;
  readonly reasonCode: string;
  readonly policyVersion: typeof CANDIDATE_VALIDATION_POLICY_VERSION;
  readonly before?: Readonly<Record<string, CandidateGateSnapshotValue>>;
  readonly after?: Readonly<Record<string, CandidateGateSnapshotValue>>;
}

export interface CandidateValidationReceiptV1 {
  readonly version: 1;
  readonly policyVersion: typeof CANDIDATE_VALIDATION_POLICY_VERSION;
  readonly candidateOrdinal: number;
  readonly proposalHash: string;
  readonly evidenceIds: readonly string[];
  readonly outcome: "accepted" | "rejected";
  readonly rejectedReason?: RejectReason;
  readonly gates: readonly CandidateGateReceipt[];
}

export interface CandidateValidationReceiptOptions {
  readonly candidateOrdinal?: number;
}

export function candidateProposalHash(candidate: RawCandidate): string {
  const evidence = candidate && typeof candidate.evidence === "object" && candidate.evidence !== null
    ? candidate.evidence
    : undefined;
  const snapshot = [
    typeof candidate?.text === "string" ? candidate.text : null,
    typeof candidate?.semanticType === "string" ? candidate.semanticType : null,
    typeof candidate?.salience === "number" && Number.isFinite(candidate.salience)
      ? candidate.salience
      : null,
    typeof candidate?.temporality === "string" ? candidate.temporality : null,
    typeof candidate?.crossContextual === "boolean" ? candidate.crossContextual : null,
    typeof candidate?.targetScope === "string" ? candidate.targetScope : null,
    typeof candidate?.profileDimension === "string" ? candidate.profileDimension : null,
    typeof evidence?.quote === "string" ? evidence.quote : null,
    Array.isArray(evidence?.eventIds)
      ? evidence.eventIds.filter((id): id is string => typeof id === "string")
      : [],
  ];
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

export function receiptEvidenceIds(candidate: RawCandidate): readonly string[] {
  if (!candidate || typeof candidate.evidence !== "object" || candidate.evidence === null ||
      !Array.isArray(candidate.evidence.eventIds)) {
    return Object.freeze([]);
  }
  return Object.freeze(candidate.evidence.eventIds.filter(
    (id): id is string => typeof id === "string",
  ));
}

export function initialCandidateGateReceipts(): CandidateGateReceipt[] {
  return CANDIDATE_GATE_IDS.map((gateId) => ({
    gateId,
    status: "not_evaluated",
    reasonCode: "prior_gate_rejected",
    policyVersion: CANDIDATE_VALIDATION_POLICY_VERSION,
  }));
}

export function candidateGateReceipt(
  gateId: CandidateGateId,
  status: CandidateGateStatus,
  reasonCode: string,
  transition?: {
    readonly before?: Readonly<Record<string, CandidateGateSnapshotValue>>;
    readonly after?: Readonly<Record<string, CandidateGateSnapshotValue>>;
  },
): CandidateGateReceipt {
  return Object.freeze({
    gateId,
    status,
    reasonCode,
    policyVersion: CANDIDATE_VALIDATION_POLICY_VERSION,
    ...(transition?.before === undefined
      ? {}
      : { before: Object.freeze({ ...transition.before }) }),
    ...(transition?.after === undefined
      ? {}
      : { after: Object.freeze({ ...transition.after }) }),
  });
}

export function finalizeCandidateValidationReceipt(args: {
  readonly candidate: RawCandidate;
  readonly source: CandidateSource;
  readonly candidateOrdinal: number;
  readonly outcome: "accepted" | "rejected";
  readonly rejectedReason?: RejectReason;
  readonly gates: readonly CandidateGateReceipt[];
}): CandidateValidationReceiptV1 {
  void args.source;
  return Object.freeze({
    version: 1,
    policyVersion: CANDIDATE_VALIDATION_POLICY_VERSION,
    candidateOrdinal: args.candidateOrdinal,
    proposalHash: candidateProposalHash(args.candidate),
    evidenceIds: receiptEvidenceIds(args.candidate),
    outcome: args.outcome,
    ...(args.rejectedReason === undefined ? {} : { rejectedReason: args.rejectedReason }),
    gates: Object.freeze([...args.gates]),
  });
}
