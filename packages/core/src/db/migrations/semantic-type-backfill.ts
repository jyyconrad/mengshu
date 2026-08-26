import { createHash } from "node:crypto";

import type {
  MemoryKind,
  MemoryLifecycleStatus,
  MemorySemanticType,
} from "../../domain/types.js";
import { kindToSemanticType } from "../../domain/semantic-type-mapper.js";

const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
]);

export type SemanticTypeBackfillDisposition =
  | "preserve_explicit"
  | "backfill"
  | "lookup_only"
  | "invalid_explicit";

export interface LegacySemanticTypeBackfillRecord {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly lifecycleStatus?: MemoryLifecycleStatus;
  /** 多个 legacy kind 来源互相矛盾时只能进入人工复核，禁止猜测 5 type。 */
  readonly classificationConflict?: boolean;
}

export interface LegacySemanticTypeBackfillPlan {
  readonly recordId: string;
  readonly disposition: SemanticTypeBackfillDisposition;
  readonly semanticType?: MemorySemanticType;
  readonly eligibleForContext: boolean;
  readonly originalValueHash: string;
  readonly mutation?: Readonly<{
    readonly semanticType?: MemorySemanticType;
    readonly isolateLookupOnly?: true;
  }>;
}

function plainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function explicitSemanticTypes(metadata: Readonly<Record<string, unknown>>): {
  readonly top: unknown;
  readonly nested: unknown;
  readonly hasNativeEnvelope: boolean;
} {
  const governance = plainRecord(metadata.governance) ? metadata.governance : undefined;
  const native = governance && plainRecord(governance.native) ? governance.native : undefined;
  return {
    top: metadata.semanticType,
    nested: native?.semanticType,
    hasNativeEnvelope: native !== undefined,
  };
}

function validSemanticType(value: unknown): value is MemorySemanticType {
  return typeof value === "string" && SEMANTIC_TYPES.has(value as MemorySemanticType);
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key,
      canonicalValue((value as Record<string, unknown>)[key]),
    ]));
  }
  return { type: typeof value };
}

function originalValueHash(record: LegacySemanticTypeBackfillRecord): string {
  return createHash("sha256")
    .update("mengshu.semantic-type-backfill/v1\0")
    .update(JSON.stringify(canonicalValue({
      id: record.id,
      kind: record.kind,
      lifecycleStatus: record.lifecycleStatus,
      classificationConflict: record.classificationConflict === true,
      metadata: record.metadata,
    })))
    .digest("hex");
}

export function planLegacySemanticTypeBackfill(
  record: LegacySemanticTypeBackfillRecord,
): LegacySemanticTypeBackfillPlan {
  const hash = originalValueHash(record);
  const explicit = explicitSemanticTypes(record.metadata);
  const active = record.lifecycleStatus === undefined || record.lifecycleStatus === "active";

  const topPresent = explicit.top !== undefined && explicit.top !== null;
  const nestedPresent = explicit.nested !== undefined && explicit.nested !== null;
  const topValid = validSemanticType(explicit.top);
  const nestedValid = validSemanticType(explicit.nested);
  if ((topPresent && !topValid) || (nestedPresent && !nestedValid) ||
      (topValid && nestedValid && explicit.top !== explicit.nested) ||
      record.classificationConflict === true) {
    return {
      recordId: record.id,
      disposition: "invalid_explicit",
      semanticType: undefined,
      eligibleForContext: false,
      originalValueHash: hash,
      mutation: Object.freeze({ isolateLookupOnly: true }),
    };
  }

  const resolvedExplicit = topValid ? explicit.top : nestedValid ? explicit.nested : undefined;
  if (resolvedExplicit !== undefined) {
    const mirrorsMissing = explicit.hasNativeEnvelope && (!topValid || !nestedValid);
    return {
      recordId: record.id,
      disposition: "preserve_explicit",
      semanticType: resolvedExplicit,
      eligibleForContext: active,
      originalValueHash: hash,
      mutation: mirrorsMissing
        ? Object.freeze({ semanticType: resolvedExplicit })
        : undefined,
    };
  }

  const mapped = kindToSemanticType(record.kind);
  if (mapped.confidence === "high" && mapped.semanticType !== null) {
    return {
      recordId: record.id,
      disposition: "backfill",
      semanticType: mapped.semanticType,
      eligibleForContext: active,
      originalValueHash: hash,
      mutation: Object.freeze({ semanticType: mapped.semanticType }),
    };
  }
  return {
    recordId: record.id,
    disposition: "lookup_only",
    semanticType: undefined,
    eligibleForContext: false,
    originalValueHash: hash,
    mutation: Object.freeze({ isolateLookupOnly: true }),
  };
}
