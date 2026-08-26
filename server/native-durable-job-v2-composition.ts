import type { CandidateComputationDeps } from
  "../packages/core/src/lifecycle/candidate-spec-computation.js";
import type { CandidateWriteMaterializerDependencies } from
  "../packages/core/src/lifecycle/candidate-write-materializer.js";
import type { CandidateEvidenceReadPort } from
  "../packages/core/src/lifecycle/postgres-candidate-evidence-read-port.js";
import type { AuthoritativeEntityGraphReadPort } from
  "../packages/core/src/graph/postgres-authoritative-entity-graph-read-port.js";
import type { EntityGraphEmbeddingBatch } from
  "../packages/core/src/graph/postgres-entity-canonicalization.js";
import type { GraphEntityRecord } from "../packages/core/src/graph/types.js";
import type { LlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import {
  DURABLE_JOB_V2_AUTHORITATIVE_TYPES,
  type DurableJobV2Scope,
} from "../packages/core/src/storage/repositories/job-v2.js";
import {
  assertProviderOwnedPostgresDurableJobV2RuntimeBundle,
  type PostgresDurableJobV2RuntimeBundle,
} from "../packages/core/src/db/providers/postgres.js";
import { createProviderOwnedNativeBuildTreeHandler } from "./native-build-tree-handler.js";
import {
  createNativeExtractCandidateHandler,
  type NativeCommittedActiveDerivation,
} from "./native-extract-candidate-handler.js";
import { createProviderOwnedNativeExtractGraphHandler } from "./native-extract-graph-handler.js";
import {
  createNativeDurableJobV2ServeCapability,
  type DurableJobV2ServeCapability,
} from "./runtime-host-factory.js";
import {
  createAuthoritativeDurableJobV2WorkerHandlerRegistry,
  type DurableJobV2AuthoritativeHandlerRegistry,
} from "./workers-v2.js";

export interface NativeDurableJobV2CompositionInput {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly scope: DurableJobV2Scope;
  readonly candidateComputation: CandidateComputationDeps;
  readonly candidateMaterialization: CandidateWriteMaterializerDependencies;
  readonly candidateEvidenceRead: CandidateEvidenceReadPort;
  readonly authoritativeEntityGraphRead: AuthoritativeEntityGraphReadPort;
  readonly prepareEntityEmbeddings: (
    entities: readonly Readonly<GraphEntityRecord>[],
    signal: AbortSignal,
  ) => Promise<EntityGraphEmbeddingBatch>;
  readonly deriveCommittedActive: NativeCommittedActiveDerivation;
  readonly onCommittedActiveDerivationWarning?: () => void | Promise<void>;
  readonly llmClient: LlmClient;
}
export interface NativeDurableJobV2Composition {
  readonly runtimeBundle: PostgresDurableJobV2RuntimeBundle;
  readonly registry: DurableJobV2AuthoritativeHandlerRegistry;
  readonly serveCapability: DurableJobV2ServeCapability;
}

/** 生产 exact-three handler registry 的唯一深组合入口。 */
export function createNativeDurableJobV2Composition(
  input: NativeDurableJobV2CompositionInput,
): NativeDurableJobV2Composition {
  const runtimeBundle = assertProviderOwnedPostgresDurableJobV2RuntimeBundle(
    input?.runtimeBundle,
  );
  const candidateMaterialization = input?.candidateMaterialization;
  if (!candidateMaterialization ||
      typeof candidateMaterialization.resolveMaxSimilarity !== "function" ||
      typeof candidateMaterialization.embed !== "function" ||
      typeof candidateMaterialization.scoreImportance !== "function" ||
      typeof candidateMaterialization.exactDedup !== "function" ||
      typeof candidateMaterialization.semanticDedup !== "function" ||
      typeof candidateMaterialization.stampMetadata !== "function") {
    throw new Error("Native candidate materialization and similarity resolver dependencies are required");
  }
  if (typeof input?.deriveCommittedActive !== "function") {
    throw new Error("Native committed active derivation dependency is required");
  }
  if (!input?.candidateEvidenceRead ||
      typeof input.candidateEvidenceRead.readAuthoritativeEvidenceFacts !== "function") {
    throw new Error("Native candidate evidence read dependency is required");
  }
  if (!input?.authoritativeEntityGraphRead ||
      typeof input.authoritativeEntityGraphRead.read !== "function") {
    throw new Error("Native authoritative Entity Graph read dependency is required");
  }
  if (typeof input?.prepareEntityEmbeddings !== "function") {
    throw new Error("Native Entity Graph embedding preparation dependency is required");
  }
  const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
    build_tree: createProviderOwnedNativeBuildTreeHandler({ runtimeBundle }),
    extract_candidate: createNativeExtractCandidateHandler({
      runtimeBundle,
      computation: input.candidateComputation,
      materialization: candidateMaterialization,
      evidenceRead: input.candidateEvidenceRead,
      deriveCommittedActive: input.deriveCommittedActive,
      onCommittedActiveDerivationWarning: input.onCommittedActiveDerivationWarning,
    }),
    extract_graph: createProviderOwnedNativeExtractGraphHandler({
      runtimeBundle,
      llmClient: input.llmClient,
      authoritativeRead: input.authoritativeEntityGraphRead,
      prepareEntityEmbeddings: input.prepareEntityEmbeddings,
    }),
  });
  if (registry.types.length !== DURABLE_JOB_V2_AUTHORITATIVE_TYPES.length ||
      registry.types.some((type, index) => type !== DURABLE_JOB_V2_AUTHORITATIVE_TYPES[index])) {
    throw new Error("Native durable job v2 handler registry is not exact-three");
  }
  const serveCapability = createNativeDurableJobV2ServeCapability({
    repository: runtimeBundle.repository,
    registry,
    scope: input.scope,
  });
  return Object.freeze({ runtimeBundle, registry, serveCapability });
}
