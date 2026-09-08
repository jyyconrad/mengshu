import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import type { EvolutionInputUnit } from "../../../packages/core/src/evolution/types.js";

export const DIAGNOSTIC_ARMS = ["A", "B", "C"] as const;
export type DiagnosticArm = typeof DIAGNOSTIC_ARMS[number];
export type DiagnosticGovernanceMode = "auto" | "reviewed";
export interface FrozenSettings {
  sourceCutoffAt: number;
  knownAt: number;
  asOf: number;
  configFingerprint: string;
  governanceSnapshotHash: string;
  schemaVersion: string;
  models: { proposer: string; answerer: string; embedding: string };
  toolFingerprint: string;
  promptHashes: Record<string, string>;
  randomSeed: number;
  topK: number;
  contextTokenBudget: number;
  cacheMode: "cold" | "warm";
}
export interface DiagnosticMaterial {
  unit: EvolutionInputUnit;
  repeatCount: number;
  fault?: "model_unavailable" | "embedding_mismatch" | "budget_exhausted";
}
export interface DiagnosticQuestion {
  text: string;
  scope: MemoryScope;
  asOf: number;
  knownAt: number;
}
export interface DiagnosticOracle {
  acceptedAnswers: string[];
  allowAbstain: boolean;
  allowedEvidenceIds: string[];
  /** Native raw rows have provider-minted IDs; independently frozen source hashes may bind them. */
  allowedEvidenceTextHashes?: string[];
  requiredFragments: string[];
  forbiddenFragments: string[];
}
export interface DiagnosticCase {
  id: string;
  capability: string;
  partition: "calibration" | "holdout";
  /** Copies, summaries and all revisions must share the same family. */
  familyIds: string[];
  material: DiagnosticMaterial;
  question: DiagnosticQuestion;
  oracle: DiagnosticOracle;
}
export interface DiagnosticDataset {
  id: string;
  version: string;
  provenance: "synthetic" | "frozen-authorized";
  settings: FrozenSettings;
  cases: DiagnosticCase[];
}
export interface ObservedMemory {
  id: string;
  text: string;
  scope: MemoryScope;
  evidenceIds: string[];
  validFrom?: number;
  validTo?: number;
}
export const COST_FIELDS = ["llmCalls", "inputTokens", "outputTokens", "embeddingCalls", "bytesRead", "databaseBytesDelta", "costUsd"] as const;
export type CostField = typeof COST_FIELDS[number];
export type DiagnosticCost = Record<CostField, number | null>;
export interface EvolutionObservation {
  status: "completed" | "blocked" | "partial" | "unavailable";
  reasons: string[];
  cost: DiagnosticCost;
  /** Actual telemetry only; a batch budget reservation is not token consumption. */
  costBasis: "measured" | "component-measured";
  governance: {
    mode: DiagnosticGovernanceMode;
    autoApplied: number | null;
    reviewedApplied: number | null;
    reviewDecisionBasis: "not-requested" | "owner-source-diff-only" | "unavailable";
    reviewPolicyId?: string;
  };
  stagedCount: number | null;
  canonicalWrites: number | null;
  evidenceWrites: number | null;
  confidenceDelta: number | null;
  repeatMutationDelta: number | null;
  commitToLookupMs: number | null;
  commitToContextMs: number | null;
}
export interface AnswerObservation {
  status: "answered" | "abstained" | "unavailable";
  text?: string;
  /** Actual assembled context, not just retrieved candidates. Null means not observed. */
  injected: ObservedMemory[] | null;
  evidenceIds: string[];
  hydratedEvidence?: Array<{ id: string; textHash: string; scope: MemoryScope }>;
  cost: DiagnosticCost;
}
export interface DiagnosticArmSession {
  isolationKey: string;
  /** Concrete isolated store identity, e.g. the actual random PostgreSQL schema. */
  storageIdentity: string;
  freezeFingerprint: string;
  evolve(): Promise<EvolutionObservation>;
  answer(question: DiagnosticQuestion): Promise<AnswerObservation>;
  close(): Promise<void>;
}
export interface DiagnosticArmFactory {
  id: string;
  executionBoundary: "component-controlled-model" | "isolated-postgres-controlled-model" | "isolated-postgres-real-model";
  /** This interface never receives holdout questions, answers or verifier annotations. */
  open(input: {
    arm: DiagnosticArm;
    governanceMode: DiagnosticGovernanceMode;
    caseId: string;
    isolationKey: string;
    freezeFingerprint: string;
    settings: FrozenSettings;
    material: DiagnosticMaterial;
  }): Promise<DiagnosticArmSession>;
}
export interface DiagnosticVerdict {
  answerCorrect: boolean | null;
  fidelity: boolean | null;
  injectedError: boolean | null;
  reasons: string[];
}
export interface DiagnosticVerifier {
  id: string;
  authority: "independent-frozen-fixture" | "independent-executable";
  verify(input: { question: DiagnosticQuestion; oracle: DiagnosticOracle; observation: AnswerObservation }): DiagnosticVerdict;
}
export interface DiagnosticCaseResult {
  caseId: string;
  capability: string;
  status: "observed" | "failed";
  failureCode?: string;
  storageIdentity?: string;
  evolution?: EvolutionObservation;
  answer?: AnswerObservation;
  verdict?: DiagnosticVerdict;
  wallTimeMs: number;
}
