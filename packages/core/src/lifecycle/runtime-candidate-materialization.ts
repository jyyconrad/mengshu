/** F0 Runtime candidate materialization composition. */

import type { KnownEmbeddingSpace } from "../domain/embedding-space.js";
import { computeImportanceForRecord } from "../domain/recall-scoring.js";
import type { SourceKind } from "../scoring/importance-score.js";
import { attachEmbeddingSpaceMetadata } from "../storage/db-provider-adapters.js";
import {
  computeCandidateMaximumSimilarity,
  evaluateCandidateDedup,
  type CandidateDedupComparable,
} from "./candidate-dedup-policy.js";
import type { CandidateDedupReadPort } from "./candidate-dedup-read-port.js";
import {
  CandidateWriteMaterializationError,
  resolveCandidateMemoryKind,
  type CandidateMaterializationStepInput,
  type CandidateWriteMaterializerDependencies,
} from "./candidate-write-materializer.js";

export interface RuntimeCandidateMaterializationInput {
  readonly embeddingSpace: KnownEmbeddingSpace;
  readonly assertEmbeddingWriteAllowed: () => void;
  readonly embed: (text: string) => Promise<readonly number[]>;
  readonly dedupReadPort: CandidateDedupReadPort;
}

const SOURCE_KINDS = new Set<SourceKind>([
  "rule_file", "session_user", "work_log", "document", "tool_result", "agent_output",
]);

function invalid(): never {
  throw new CandidateWriteMaterializationError();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error && reason.name === "AbortError") throw reason;
  throw new DOMException("Candidate similarity resolution aborted", "AbortError");
}

function salience(input: CandidateMaterializationStepInput): number | undefined {
  const value = input.spec.metadata.salience;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function sourceKind(input: CandidateMaterializationStepInput): SourceKind {
  const value = input.spec.metadata.sourceKind;
  if (typeof value !== "string" || !SOURCE_KINDS.has(value as SourceKind)) invalid();
  return value as SourceKind;
}

function comparable(input: CandidateMaterializationStepInput): CandidateDedupComparable[] {
  return input.batchRecords.map((record) => Object.freeze({
    id: record.id,
    text: record.text,
    vector: record.vector,
    kind: record.kind,
    ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
  }));
}

function candidate(input: CandidateMaterializationStepInput, withVector: boolean) {
  return Object.freeze({
    text: input.spec.text,
    ...(withVector ? { vector: input.vector } : {}),
    ...(salience(input) === undefined ? {} : { salience: salience(input) }),
    confidence: input.spec.confidence,
    kind: input.kind,
    ...(input.spec.semanticType === undefined ? {} : { semanticType: input.spec.semanticType }),
  });
}

function stampAuthoritative(
  metadata: Readonly<Record<string, unknown>>,
  scope: CandidateMaterializationStepInput["scope"],
  embeddingSpace: KnownEmbeddingSpace,
): Readonly<Record<string, unknown>> {
  const authoritative = {
    ...(scope.workspaceId === undefined ? {} : { workspaceId: scope.workspaceId }),
    ...(scope.sessionId === undefined ? {} : { sessionId: scope.sessionId }),
  };
  for (const [key, value] of Object.entries(authoritative)) {
    if (Object.hasOwn(metadata, key) && metadata[key] !== value) invalid();
  }
  try {
    return Object.freeze(attachEmbeddingSpaceMetadata({ ...metadata, ...authoritative }, embeddingSpace));
  } catch {
    return invalid();
  }
}

async function existing(
  port: CandidateDedupReadPort,
  embeddingSpace: KnownEmbeddingSpace,
  input: CandidateMaterializationStepInput,
) {
  return port.findExisting({
    scope: input.scope,
    kind: input.kind,
    ...(input.spec.semanticType === undefined ? {} : { semanticType: input.spec.semanticType }),
    embeddingSpaceId: embeddingSpace.embeddingSpaceId,
    embeddingSpaceState: "known-queryable",
    excludeIds: input.excludeIds,
  });
}

export function createRuntimeCandidateMaterialization(
  input: RuntimeCandidateMaterializationInput,
): CandidateWriteMaterializerDependencies {
  if (!input || typeof input !== "object" ||
      typeof input.assertEmbeddingWriteAllowed !== "function" ||
      typeof input.embed !== "function" ||
      !input.dedupReadPort || typeof input.dedupReadPort.findExisting !== "function" ||
      input.embeddingSpace.state !== "known-queryable") invalid();

  const dependencies: CandidateWriteMaterializerDependencies = {
    resolveMaxSimilarity: async (query) => {
      throwIfAborted(query.signal);
      input.assertEmbeddingWriteAllowed();
      const vector = await input.embed(query.text);
      input.assertEmbeddingWriteAllowed();
      throwIfAborted(query.signal);
      const kind = resolveCandidateMemoryKind({
        kind: query.kind,
        ...(query.semanticType === undefined ? {} : { semanticType: query.semanticType }),
      });
      const records = await input.dedupReadPort.findExisting({
        scope: query.scope,
        kind,
        ...(query.semanticType === undefined ? {} : { semanticType: query.semanticType }),
        embeddingSpaceId: input.embeddingSpace.embeddingSpaceId,
        embeddingSpaceState: "known-queryable",
        excludeIds: [],
      });
      throwIfAborted(query.signal);
      const result = computeCandidateMaximumSimilarity({
        candidate: Object.freeze({
          text: query.text,
          vector,
          kind,
          ...(query.semanticType === undefined ? {} : { semanticType: query.semanticType }),
        }),
        existingRecords: records,
        batchRecords: Object.freeze([]),
      });
      return Object.freeze({
        authority: "runtime_embedding_resolution" as const,
        embeddingSpaceId: input.embeddingSpace.embeddingSpaceId,
        ...(result.known ? { maxSimilarity: result.maxSimilarity } : {}),
        vector: Object.freeze([...vector]),
      });
    },
    embed: async ({ text, spec }) => {
      const resolution = spec.similarityResolution;
      if (resolution !== undefined) {
        input.assertEmbeddingWriteAllowed();
        if (resolution.embeddingSpaceId !== input.embeddingSpace.embeddingSpaceId) invalid();
        return resolution.vector;
      }
      input.assertEmbeddingWriteAllowed();
      const vector = await input.embed(text);
      input.assertEmbeddingWriteAllowed();
      return vector;
    },
    scoreImportance: (step) => computeImportanceForRecord({
      salience: salience(step),
      sourceKind: sourceKind(step),
      explicitSave: step.spec.metadata.intent === "remember",
      semanticType: step.spec.semanticType,
    }),
    exactDedup: async (step) => {
      const records = await existing(input.dedupReadPort, input.embeddingSpace, step);
      const result = evaluateCandidateDedup({
        candidate: candidate(step, false),
        existingRecords: records,
        batchRecords: comparable(step),
      });
      return result.duplicate
        ? { duplicate: true, duplicateOf: result.duplicateOf, layer: result.layer }
        : { duplicate: false };
    },
    semanticDedup: async (step) => {
      const records = await existing(input.dedupReadPort, input.embeddingSpace, step);
      const result = evaluateCandidateDedup({
        candidate: candidate(step, true),
        existingRecords: records,
        batchRecords: comparable(step),
      });
      return result.duplicate
        ? { duplicate: true, duplicateOf: result.duplicateOf, layer: result.layer }
        : { duplicate: false };
    },
    stampMetadata: (metadata, context) =>
      stampAuthoritative(metadata, context.scope, input.embeddingSpace),
  };
  return Object.freeze(dependencies);
}
