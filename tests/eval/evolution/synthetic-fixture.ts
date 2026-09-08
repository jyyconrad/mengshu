import { evolutionHash } from "../../../packages/core/src/evolution/fingerprints.js";
import { EVOLUTION_PROPOSER_PROMPT } from "../../../packages/core/src/evolution/proposer.js";
import { EVOLUTION_PROPOSAL_SCHEMA } from "../../../packages/core/src/evolution/schema.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { ROLLOUT_NOW, ROLLOUT_SCOPE } from "../../fixtures/memory-evolution-rollout/source-corpus.js";
import type { DiagnosticCase, DiagnosticDataset, DiagnosticMaterial } from "./types.js";

function example(id: string, baseline: string | undefined, source: string, expected: string[], options: {
  capability?: string; fault?: DiagnosticMaterial["fault"]; required?: string[]; forbidden?: string[];
  allowAbstain?: boolean; foreign?: boolean;
} = {}): DiagnosticCase {
  const scope = options.foreign ? { ...ROLLOUT_SCOPE, projectId: "foreign-project" } : ROLLOUT_SCOPE;
  const root = `${id}:source-root`;
  const evidenceId = `${id}:original`;
  return {
    id, capability: options.capability ?? "current-facts", partition: "holdout", familyIds: [`${id}:family`],
    material: { repeatCount: 2, ...(options.fault ? { fault: options.fault } : {}), unit: {
      id, scope, snapshotHash: evolutionHash({ baseline, source }),
      targets: baseline ? [{ memoryId: `${id}:memory`, expectedRevision: 1,
        beforeHash: computeCanonicalContentHash(baseline), text: baseline, scope, kind: "fact",
        createdAt: ROLLOUT_NOW - 20_000, evidenceRootIds: [root] }] : [],
      evidence: [{ id: evidenceId, sourceId: `${id}:source`, revision: "2", snapshotHash: computeCanonicalContentHash(source),
        text: source, scope, rootEvidenceId: root, origin: "external", trust: "untrusted", occurredAt: ROLLOUT_NOW - 10_000 }],
    } },
    question: { text: `HOLDOUT_QUESTION_CANARY: Return the retained claim for ${id}.`,
      scope: ROLLOUT_SCOPE, asOf: ROLLOUT_NOW, knownAt: ROLLOUT_NOW },
    oracle: { acceptedAnswers: expected, allowAbstain: options.allowAbstain ?? false,
      allowedEvidenceIds: [root, evidenceId], requiredFragments: options.required ?? [],
      forbiddenFragments: [...options.forbidden ?? [], "VERIFIER_ONLY_CANARY"] },
  };
}

export function createSyntheticDiagnosticDataset(): DiagnosticDataset {
  return {
    id: "rollout-synthetic-diagnostic", version: "1", provenance: "synthetic",
    settings: { sourceCutoffAt: ROLLOUT_NOW, knownAt: ROLLOUT_NOW, asOf: ROLLOUT_NOW,
      configFingerprint: evolutionHash("rollout-component-config/v1"), governanceSnapshotHash: evolutionHash("synthetic-baseline/v1"),
      schemaVersion: "component-no-database", models: { proposer: "controlled-global-extractor", answerer: "fixture-exact-reader", embedding: "not-used" },
      toolFingerprint: evolutionHash("no-tools"), promptHashes: { proposer: evolutionHash(EVOLUTION_PROPOSER_PROMPT),
        proposalSchema: evolutionHash(EVOLUTION_PROPOSAL_SCHEMA), answerer: evolutionHash("fixture-exact-reader/v1") },
      randomSeed: 42, topK: 5, contextTokenBudget: 2048, cacheMode: "cold" },
    cases: [
      example("changed-window", "The release window is 09:00 UTC.", "The release window is 10:00 UTC.", ["The release window is 10:00 UTC."], { forbidden: ["09:00"] }),
      example("condition", "Deploy only after approval; do not deploy without audit.", "Deploy only after approval; do not deploy without audit.",
        ["Deploy only after approval; do not deploy without audit."], { capability: "claim-fidelity", required: ["only after approval", "do not deploy without audit"] }),
      example("unknown", undefined, "The rollback result is not known.", [], { capability: "unknown-abstention", allowAbstain: true }),
      example("foreign-project", "A private assertion from another project.", "A private assertion from another project.", [], { capability: "scope-permissions", foreign: true, allowAbstain: true }),
      example("same-source", "The audit retention is 30 days.", "The audit retention is 30 days.", ["The audit retention is 30 days."], { capability: "independent-evidence" }),
      example("model-unavailable", "The audit retention is 30 days.", "The audit retention is 90 days.", ["The audit retention is 30 days."], { capability: "failure-recovery", fault: "model_unavailable" }),
      example("embedding-mismatch", "The audit retention is 30 days.", "The audit retention is 90 days.", ["The audit retention is 30 days."], { capability: "failure-recovery", fault: "embedding_mismatch" }),
      example("budget-exhausted", "The audit retention is 30 days.", "The audit retention is 90 days.", ["The audit retention is 30 days."], { capability: "failure-recovery", fault: "budget_exhausted" }),
    ],
  };
}
