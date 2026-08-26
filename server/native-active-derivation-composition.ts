import { createHash } from "node:crypto";

import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type {
  ActiveMemoryEvidenceFact,
  ActiveMemoryTreeFacts,
} from "../packages/core/src/graph/active-memory-derivation.js";
import type { WorkMemoryGraphRepository } from
  "../packages/core/src/graph/work-memory-types.js";
import type { WriteMemoryRecord } from
  "../packages/core/src/service/write-kernel.js";
import {
  isDurableJobV2SafeIdentifier,
  type DurableJobV2,
} from "../packages/core/src/storage/repositories/job-v2.js";
import type { PostgresDurableJobV2Repository } from
  "../packages/core/src/storage/repositories/postgres-job-v2.js";
import {
  orchestrateCommittedActiveMemoryDerivations,
  type NativeActiveEntityGraphTargetRequest,
  type NativeActiveDerivationReadInput,
} from "./native-active-derivation-orchestrator.js";
import type { NativeCommittedActiveDerivation } from
  "./native-extract-candidate-handler.js";

type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

export interface NativeActiveDerivationReadPort {
  readCommittedActiveRecords(input: {
    readonly activeMemoryIds: readonly string[];
    readonly scope: MemoryScope;
    readonly signal: AbortSignal;
  }): Promise<readonly ContentRecord[]>;
  readEvidenceFacts(
    input: NativeActiveDerivationReadInput,
  ): Promise<readonly ActiveMemoryEvidenceFact[]>;
  readTreeFacts(
    input: NativeActiveDerivationReadInput,
  ): Promise<readonly ActiveMemoryTreeFacts[]>;
}

export interface NativeCommittedActiveDerivationDependencies {
  readonly readPort: NativeActiveDerivationReadPort;
  readonly workMemoryGraph: Pick<WorkMemoryGraphRepository, "upsertWorkMemoryGraph">;
  readonly repository: Pick<PostgresDurableJobV2Repository, "enqueue">;
}

export class NativeActiveDerivationCompositionError extends Error {
  readonly code = "ACTIVE_MEMORY_DERIVATION_COMPOSITION_INVALID" as const;

  constructor() {
    super("Native committed active derivation composition is invalid");
    this.name = "NativeActiveDerivationCompositionError";
  }
}

function invalid(): never {
  throw new NativeActiveDerivationCompositionError();
}

function jobId(idempotencyKey: string, domain = "tree"): string {
  const digest = createHash("sha256")
    .update(`mengshu.active-memory-${domain}-job/v1\0`)
    .update(idempotencyKey)
    .digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
    `8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function fullScope(input: Parameters<NativeCommittedActiveDerivation>[0]): MemoryScope {
  const scope = Object.freeze({
    ...input.scope,
    ...(input.context.workspaceId === undefined
      ? {}
      : { workspaceId: input.context.workspaceId }),
    ...(input.context.sessionId === undefined
      ? {}
      : { sessionId: input.context.sessionId }),
  });
  const required = [
    scope.tenantId, scope.userId, scope.appId, scope.projectId,
    scope.agentId, scope.namespace,
  ];
  if (required.some((value) => !isDurableJobV2SafeIdentifier(value)) ||
      (scope.workspaceId !== undefined && !isDurableJobV2SafeIdentifier(scope.workspaceId)) ||
      (scope.sessionId !== undefined && !isDurableJobV2SafeIdentifier(scope.sessionId))) {
    invalid();
  }
  return scope;
}

function assertEnqueuedJob(
  job: DurableJobV2,
  expected: { readonly type: string; readonly dedupeKey: string },
): string {
  if (!job || typeof job !== "object" || !isDurableJobV2SafeIdentifier(job.id) ||
      job.type !== expected.type || job.dedupeKey !== expected.dedupeKey) {
    invalid();
  }
  return job.id;
}

/**
 * 把 provider-owned committed reads、Work Memory Graph 与 durable tree queue
 * 组合为 candidate handler 所需的单一深 callback。
 */
export function createNativeCommittedActiveDerivation(
  dependencies: NativeCommittedActiveDerivationDependencies,
): NativeCommittedActiveDerivation {
  if (!dependencies || typeof dependencies !== "object" ||
      typeof dependencies.readPort?.readCommittedActiveRecords !== "function" ||
      typeof dependencies.readPort?.readEvidenceFacts !== "function" ||
      typeof dependencies.readPort?.readTreeFacts !== "function" ||
      typeof dependencies.workMemoryGraph?.upsertWorkMemoryGraph !== "function" ||
      typeof dependencies.repository?.enqueue !== "function") {
    invalid();
  }
  return async (input) => {
    const scope = fullScope(input);
    const records = await dependencies.readPort.readCommittedActiveRecords({
      activeMemoryIds: input.activeMemoryIds,
      scope,
      signal: input.signal,
    });
    const result = await orchestrateCommittedActiveMemoryDerivations({
      readEvidenceFacts: (readInput) => dependencies.readPort.readEvidenceFacts(readInput),
      readTreeFacts: (readInput) => dependencies.readPort.readTreeFacts(readInput),
      upsertWorkMemoryGraph: async (batch, signal) => {
        if (signal.aborted) throw signal.reason;
        await dependencies.workMemoryGraph.upsertWorkMemoryGraph(batch);
        if (signal.aborted) throw signal.reason;
      },
      enqueueEntityGraphTarget: async (
        request: NativeActiveEntityGraphTargetRequest,
        signal,
      ) => {
        if (signal.aborted) throw signal.reason;
        const enqueued = await dependencies.repository.enqueue({
          id: jobId(request.dedupeKey, "entity-graph"),
          type: request.type,
          payload: { ...request.payload },
          dedupeKey: request.dedupeKey,
          scope: request.scope,
          maxAttempts: 3,
        });
        if (signal.aborted) throw signal.reason;
        return assertEnqueuedJob(enqueued, request);
      },
      enqueueTreeTarget: async (request, signal) => {
        if (signal.aborted) throw signal.reason;
        const enqueued = await dependencies.repository.enqueue({
          id: jobId(request.target.idempotencyKey),
          type: request.type,
          payload: { ...request.payload },
          dedupeKey: request.dedupeKey,
          scope: request.scope,
          maxAttempts: 3,
        });
        if (signal.aborted) throw signal.reason;
        return assertEnqueuedJob(enqueued, request);
      },
    }, {
      records,
      activeMemoryIds: input.activeMemoryIds,
      signal: input.signal,
    });
    if (result.activeMemoryIds.length !== input.activeMemoryIds.length ||
        result.derivations.length !== input.activeMemoryIds.length ||
        result.derivations.some((item) =>
          item.entityGraph.status !== "ensured" ||
          item.workMemoryGraph.status !== "upserted" ||
          item.tree.status !== "ensured" || !item.tree.admitted ||
          !item.tree.targets.some((target) => target.treeType === "source"))) {
      invalid();
    }
  };
}
