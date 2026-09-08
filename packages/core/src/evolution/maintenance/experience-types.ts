import type { MemoryScope } from "../../domain/types.js";
import type { SkillCandidate } from "../../lifecycle/skill-candidate-types.js";
import type { SkillArtifactService } from "../../skills/skill-artifact-service.js";

export interface ExperienceQuote { evidenceId: string; text: string }
export interface ExperienceEvidence {
  id: string;
  rootEvidenceId: string;
  independenceGroupId: string;
  origin: "external" | "summary" | "evaluation";
  quote: string;
  revoked: boolean;
  verificationReceiptId?: string;
}

/** Hydrated by a host/provider adapter, not accepted from file metadata or client request. */
export interface VerifiedExperience {
  memoryId: string;
  revision: string;
  scope: MemoryScope;
  topicLabel: string;
  occurredAt: number;
  confidence: number;
  /** Stored embedding for this exact memory revision; absence/mixed models blocks generalization. */
  embedding?: { model: string; values: number[] };
  evidence: ExperienceEvidence[];
  outcome: ExperienceQuote & { result: "success" | "failure" | "counterexample"; observedAt: number };
  applicability: ExperienceQuote[];
  triggers: ExperienceQuote[];
  preconditions: ExperienceQuote[];
  steps: ExperienceQuote[];
  riskBoundaries: ExperienceQuote[];
  highRisk: boolean;
  contextIncomplete?: boolean;
}

export interface ExperienceSourcePort {
  /** Native PG experience/evidence read, bounded keyset cursor. No pending-candidate/text-success fallback. */
  readPage(input: { scope: MemoryScope; limit: number; cursor?: string; signal?: AbortSignal }): Promise<{
    experiences: VerifiedExperience[];
    nextCursor?: string;
  }>;
  /** Recheck exact revisions, evidence receipts and tombstones before draft creation. */
  verify(input: { scope: MemoryScope; experiences: { memoryId: string; revision: string }[] }): Promise<{ valid: boolean }>;
}

export interface ExperiencePattern {
  id: string;
  scope: MemoryScope;
  topicLabel: string;
  experiences: VerifiedExperience[];
  evidenceRootIds: string[];
  successCount: number;
  failureCount: number;
  timeSpanDays: number;
  similarity: number;
  confidenceCeiling: number;
}

export interface SkillDraftGatePort {
  /** Host target/model/tool compatibility AND independent paired evaluator; absence must block. */
  evaluate(input: { scope: MemoryScope; pattern: ExperiencePattern; candidate: SkillCandidate; candidateHash: string }): Promise<
    | { status: "blocked"; reasonCode: string }
    | { status: "passed"; receiptId: string; patternId: string; candidateHash: string;
        targetFingerprint: string; policyVersion: string; expiresAt: number }
  >;
}

export type ReviewedSkillDraftPort = Pick<SkillArtifactService, "proposeFromCandidate">;
