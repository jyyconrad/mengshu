import type { CandidateComputationDeps } from
  "../packages/core/src/lifecycle/candidate-spec-computation.js";
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
import { createNativeExtractCandidateHandler } from "./native-extract-candidate-handler.js";
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
  const registry = createAuthoritativeDurableJobV2WorkerHandlerRegistry({
    build_tree: createProviderOwnedNativeBuildTreeHandler({ runtimeBundle }),
    extract_candidate: createNativeExtractCandidateHandler({
      runtimeBundle,
      computation: input.candidateComputation,
    }),
    extract_graph: createProviderOwnedNativeExtractGraphHandler({
      runtimeBundle,
      llmClient: input.llmClient,
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
