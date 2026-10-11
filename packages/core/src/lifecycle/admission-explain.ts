/**
 * Admission explain helpers for Agents.
 *
 * Surfaces validator + admission routing for a candidate draft (dry-run) without
 * persisting. Complements CLI `ms why` which explains already-stored memories.
 */

import type { MemorySemanticType } from "../domain/types.js";
import {
  decideAdmissionWithBreakdown,
  type AdmissionContext,
  type AdmissionDecisionResult,
} from "./admission-decision.js";
import {
  validateCandidateWithReceipt,
  type CandidateSource,
  type RawCandidate,
  type RejectReason,
  type ValidatedCandidate,
} from "./candidate-validator.js";
import type { CandidateValidationReceiptV1 } from "./candidate-validation-receipt.js";

export type AdmissionExplainOutcome =
  | {
      outcome: "rejected";
      rejectedReason: RejectReason;
      reasonCodes: string[];
      semanticType?: MemorySemanticType;
      receipt: CandidateValidationReceiptV1;
      admission?: undefined;
    }
  | {
      outcome: "routed";
      reasonCodes: string[];
      semanticType: MemorySemanticType;
      receipt: CandidateValidationReceiptV1;
      admission: AdmissionDecisionResult;
    };

export interface ExplainAdmissionCandidateInput {
  text: string;
  semanticType: MemorySemanticType;
  /** Defaults to persistent. */
  temporality?: RawCandidate["temporality"];
  salience?: number;
  crossContextual?: boolean;
  targetScope?: RawCandidate["targetScope"];
  profileDimension?: string;
  /** Source text that must contain the evidence quote; defaults to `text`. */
  sourceText?: string;
  sourceScope?: CandidateSource["scope"];
  eventIds?: readonly string[];
  intent?: AdmissionContext["intent"];
  hasConflict?: boolean;
}

/**
 * Dry-run: run §3.1 validator gates then §6.2 admission routing.
 * Does not write to any store.
 */
export function explainAdmissionCandidate(
  input: ExplainAdmissionCandidateInput,
): AdmissionExplainOutcome {
  const sourceText = input.sourceText ?? input.text;
  const source: CandidateSource = {
    text: sourceText,
    scope: input.sourceScope ?? "project",
    eventIds: input.eventIds ?? ["evt-explain"],
  };
  const candidate: RawCandidate = {
    text: input.text,
    semanticType: input.semanticType,
    salience: input.salience ?? 0.8,
    temporality: input.temporality ?? "persistent",
    crossContextual: input.crossContextual,
    targetScope: input.targetScope ?? "project",
    profileDimension: input.profileDimension,
    evidence: {
      quote: input.text.slice(0, Math.min(input.text.length, 200)),
      eventIds: [...(source.eventIds ?? ["evt-explain"])],
    },
  };

  const { verdict, receipt } = validateCandidateWithReceipt(candidate, source);
  if (verdict.rejected) {
    return {
      outcome: "rejected",
      rejectedReason: verdict.reason,
      reasonCodes: [verdict.reason, `semanticType_gate:${input.semanticType}`],
      semanticType: input.semanticType,
      receipt,
    };
  }

  const validated = verdict as ValidatedCandidate;
  const admission = decideAdmissionWithBreakdown(validated, {
    intent: input.intent ?? "auto",
    hasConflict: input.hasConflict === true,
  });

  return {
    outcome: "routed",
    reasonCodes: [
      admission.reason,
      `route:${admission.route}`,
      `semanticType:${validated.semanticType}`,
      ...(validated.evidenceOnly ? ["evidence_only"] : []),
      ...validated.riskFlags.map((flag) => `risk:${flag}`),
    ],
    semanticType: validated.semanticType,
    receipt,
    admission,
  };
}
