import type { MemoryCategory } from "../../../../config.js";
import { types as nodeUtilTypes } from "node:util";
import type { PostgresPendingCandidateInput } from "../lifecycle/postgres-candidate-repository.js";
import { computeContentHash } from "../scoring/hash-utils.js";
import type { MemoryRecord } from "../domain/types.js";
import type { WriteAdmissionRoute, WriteMemoryRecord } from "./write-kernel.js";

type ContentWriteRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

const CANDIDATE_ROUTES = new Set<WriteAdmissionRoute>([
  "candidate_low_priority",
  "candidate",
]);

const MEMORY_ROUTES = new Set<WriteAdmissionRoute>([
  "active",
  "lookup_only",
  "evidence_only",
]);

function contentRecord(record: WriteMemoryRecord): ContentWriteRecord {
  if (record.mutation !== "content") {
    throw new Error("write persistence mapping requires a content record");
  }
  return record;
}

function score(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`write persistence ${label} must be within [0,1]`);
  }
  return value;
}

function category(record: ContentWriteRecord): MemoryCategory {
  if (record.category) return record.category;
  switch (record.kind) {
    case "preference":
    case "decision":
    case "entity":
    case "fact":
    case "task":
    case "plan":
    case "goal":
      return record.kind;
    default:
      return "other";
  }
}

function confidence(record: ContentWriteRecord): number | undefined {
  if (record.confidence !== undefined) return score(record.confidence, "confidence");
  if (record.governance.candidate.confidence !== undefined) {
    return score(record.governance.candidate.confidence, "validated candidate confidence");
  }
  if (record.route === "evidence_only" &&
      record.governance.candidate.phase === "raw_evidence") {
    return undefined;
  }
  throw new Error("write persistence validated candidate confidence must be within [0,1]");
}

function extractor(record: ContentWriteRecord): string | undefined {
  const value = record.governance.candidate.extractor;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function scopedProvenance(record: ContentWriteRecord): ContentWriteRecord["provenance"] {
  return {
    ...record.provenance,
    ...(record.scope.sessionId === undefined ? {} : { sessionId: record.scope.sessionId }),
  };
}

function strictJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("write persistence governance must be JSON serializable");
    return value;
  }
  if (!value || typeof value !== "object" || nodeUtilTypes.isProxy(value) || ancestors.has(value)) {
    throw new Error("write persistence governance must be JSON serializable");
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.length !== value.length + 1 || !keys.includes("length")) {
        throw new Error("write persistence governance must contain dense JSON arrays");
      }
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) {
          throw new Error("write persistence governance must contain dense JSON arrays");
        }
        result.push(strictJson(descriptor.value, ancestors));
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("write persistence governance must contain plain JSON objects");
    }
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error("write persistence governance must contain safe JSON keys");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new Error("write persistence governance must contain plain JSON fields");
      }
      if (descriptor.value !== undefined) result[key] = strictJson(descriptor.value, ancestors);
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function governanceSnapshot(record: ContentWriteRecord): Record<string, unknown> {
  return strictJson({
    commandType: record.commandType,
    candidate: record.governance.candidate,
    ...(record.governance.admissionReason === undefined
      ? {}
      : { admissionReason: record.governance.admissionReason }),
    ...(record.governance.admissionBreakdown === undefined
      ? {}
      : { admissionBreakdown: { ...record.governance.admissionBreakdown } }),
    provenance: scopedProvenance(record),
    evidenceIds: [...record.evidenceIds],
    native: {
      kind: record.kind,
      ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
      ...(record.container === undefined ? {} : { container: record.container }),
      category: category(record),
      dataType: record.dataType ?? "memory",
      ...(record.tableName === undefined ? {} : { tableName: record.tableName }),
    },
  }) as Record<string, unknown>;
}

function metadataSnapshot(
  record: ContentWriteRecord,
  additional: Record<string, unknown>,
): Record<string, unknown> {
  return strictJson({
    ...record.metadata,
    ...additional,
  }) as Record<string, unknown>;
}

export function writeRecordToMemoryRecord(input: WriteMemoryRecord): MemoryRecord {
  const record = contentRecord(input);
  if (!MEMORY_ROUTES.has(record.route)) {
    throw new Error(`write persistence route ${record.route} cannot map to memory`);
  }
  const contextEligible = record.route === "active";
  const governedConfidence = confidence(record);
  return {
    id: record.id,
    scope: { ...record.scope },
    kind: record.kind,
    ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
    container: contextEligible ? (record.container ?? "project") : "session_candidate",
    lifecycleStatus: contextEligible ? "active" : "archived",
    ...(governedConfidence === undefined ? {} : { confidence: governedConfidence }),
    text: record.text,
    contentHash: computeContentHash(record.text),
    importance: score(record.importance, "importance"),
    category: category(record),
    dataType: record.dataType ?? "memory",
    ...(record.tableName === undefined ? {} : { tableName: record.tableName }),
    metadata: metadataSnapshot(record, {
      admissionRoute: record.route,
      contextEligible,
      valueScore: score(record.valueScore, "valueScore"),
      importance: record.importance,
      governance: governanceSnapshot(record),
    }),
    provenance: scopedProvenance(record),
    sourceNodeIds: [...record.evidenceIds],
    createdAt: record.createdAt,
    vector: [...record.vector],
  };
}

export function writeRecordToPostgresPendingCandidate(
  input: WriteMemoryRecord,
): PostgresPendingCandidateInput {
  const record = contentRecord(input);
  if (!CANDIDATE_ROUTES.has(record.route)) {
    throw new Error(`write persistence route ${record.route} cannot map to pending candidate`);
  }
  const candidateConfidence = confidence(record);
  if (candidateConfidence === undefined) {
    throw new Error("write persistence validated candidate confidence must be within [0,1]");
  }
  return {
    id: record.id,
    text: record.text,
    ...(record.semanticType === undefined ? {} : { semanticType: record.semanticType }),
    kind: record.kind,
    confidence: candidateConfidence,
    ...(record.governance.admissionReason === undefined
      ? {}
      : { reason: record.governance.admissionReason }),
    evidenceIds: [...record.evidenceIds],
    ...(extractor(record) === undefined ? {} : { extractor: extractor(record) }),
    metadata: metadataSnapshot(record, {
      admissionRoute: record.route,
      valueScore: score(record.valueScore, "valueScore"),
      importance: score(record.importance, "importance"),
      governance: governanceSnapshot(record),
    }),
    createdAt: record.createdAt,
  };
}
