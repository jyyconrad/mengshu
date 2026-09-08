import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { evolutionHash } from "../../../packages/core/src/evolution/fingerprints.js";
import { EVOLUTION_PROPOSER_PROMPT } from "../../../packages/core/src/evolution/proposer.js";
import { EVOLUTION_POLICY_VERSION, EVOLUTION_PROPOSAL_SCHEMA } from "../../../packages/core/src/evolution/schema.js";
import { CURRENT_SCHEMA_VERSION } from "../../../packages/core/src/db/migrations/schema-migrations.js";
import type { MemoryConfig } from "../../../config.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_SCOPE } from "../../fixtures/memory-evolution-rollout/source-corpus.js";
import { createNativeRolloutConfig } from "../../fixtures/memory-evolution-rollout/native-runtime.js";
import type { DiagnosticDataset, FrozenSettings } from "./types.js";

export function nativePilotConfigFingerprint(config: MemoryConfig): string {
  // Physical source/schema paths and ephemeral credentials differ across isolated arms, not behavior.
  const effective = createNativeRolloutConfig(config, config.postgres, "/synthetic-freeze/source", "synthetic-freeze-owner-not-a-real-credential");
  const { postgres: _postgres, embedding, llm, server, evolution: _evolution, authority: _authority, ...rest } = effective;
  const { apiKey: _embeddingKey, ...embeddingConfig } = embedding;
  const { apiKey: _modelKey, ...modelConfig } = llm ?? {};
  const { secret: _serverSecret, ...serverConfig } = server ?? {};
  return evolutionHash({ ...rest, features: { ...rest.features, continuousMemoryEvolution: true, temporalMemory: true },
    dbType: "postgres", postgres: "isolated-schema-per-arm", embedding: embeddingConfig, llm: modelConfig,
    server: { ...serverConfig, workerOwnership: "runtime-host", backgroundWork: { mode: "paused", allowedBatchIds: [] } }, authority: ROLLOUT_AUTHORITY,
    evolution: { sourceId: "rollout-native-source", parser: "markdown", root: "isolated-synthetic-source", maintenance: false, ownerControl: "independent-secret" } });
}

/** Pure settings freeze. The caller supplies an explicitly loaded private config; no global discovery. */
export function createNativePilotSettings(config: MemoryConfig, at: number): FrozenSettings {
  const proposer = config.llm?.extractionModel ?? config.llm?.model;
  if (!proposer || !Number.isSafeInteger(at)) throw new Error("explicit_native_model_and_time_required");
  return { sourceCutoffAt: at, knownAt: at, asOf: at, configFingerprint: nativePilotConfigFingerprint(config),
    governanceSnapshotHash: evolutionHash({ policy: EVOLUTION_POLICY_VERSION, authority: ROLLOUT_AUTHORITY, attestation: "absent", baseline: "empty" }),
    schemaVersion: `postgres-migrations-${CURRENT_SCHEMA_VERSION}`, models: { proposer, answerer: "independent-native-lookup-quote/v1", embedding: config.embedding.model ?? "text-embedding-3-small" },
    toolFingerprint: evolutionHash("native-proposer-no-tools"), promptHashes: { proposer: evolutionHash(EVOLUTION_PROPOSER_PROMPT),
      proposalSchema: evolutionHash(EVOLUTION_PROPOSAL_SCHEMA), answerer: evolutionHash("independent-native-lookup-quote/v1") },
    randomSeed: 42, topK: 5, contextTokenBudget: 2048, cacheMode: "cold" };
}

/** Small create-only pilot. Gold stays separate; no native correction/maintenance effect claim. */
export function createNativeCreatePilotDataset(settings: FrozenSettings): DiagnosticDataset {
  const texts = ["The synthetic rollout audit retention period is 37 days.", "The synthetic rollout release window is 10:00 UTC."];
  return { id: "rollout-native-create-pilot", version: "1", provenance: "synthetic", settings: structuredClone(settings),
    cases: texts.map((text, index) => {
      const id = `native-create-${index + 1}`;
      const textHash = computeCanonicalContentHash(text);
      return { id, capability: index ? "current-window" : "current-retention", partition: "holdout", familyIds: [id],
        material: { repeatCount: 2, unit: { id, scope: ROLLOUT_SCOPE, snapshotHash: evolutionHash({ text }), targets: [],
          evidence: [{ id: `${id}:original`, sourceId: id, revision: "1", snapshotHash: textHash, text, scope: ROLLOUT_SCOPE,
            rootEvidenceId: id, origin: "external", trust: "untrusted", occurredAt: settings.sourceCutoffAt }] } },
        question: { text: index ? "What is the synthetic rollout release window?" : "What is the synthetic rollout audit retention period?",
          scope: ROLLOUT_SCOPE, asOf: settings.asOf, knownAt: settings.knownAt },
        oracle: { acceptedAnswers: [text], allowAbstain: false, allowedEvidenceIds: [], allowedEvidenceTextHashes: [textHash],
          requiredFragments: [], forbiddenFragments: [] },
      };
    }) };
}
