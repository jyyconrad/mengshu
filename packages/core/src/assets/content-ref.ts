import type { MemorySemanticType } from "../domain/types.js";
import type { MemoryProjectionContentRef } from "./types.js";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile",
  "task_context",
  "rules",
  "experience",
  "resource",
]);
const CONTENT_REF_KEYS = new Set([
  "type",
  "recordIds",
  "treeNodeIds",
  "evidenceIds",
  "semanticTypes",
  "resolutionHash",
]);

export type MemoryViewAssetErrorCode =
  | "INVALID_INPUT"
  | "INVALID_CONTENT_REF"
  | "PRIVATE_SCOPE_REQUIRED"
  | "OWNER_SCOPE_MISMATCH"
  | "SOURCE_SCOPE_MISMATCH"
  | "SOURCE_REFERENCE_MISMATCH"
  | "MEMORY_NOT_ACTIVE"
  | "EVIDENCE_REQUIRED"
  | "EVIDENCE_MISMATCH"
  | "SEMANTIC_TYPE_MISMATCH"
  | "UNRESOLVED_CONFLICT"
  | "RISK_NOT_CLEARED"
  | "FAITHFULNESS_REQUIRED"
  | "VERSION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "ASSET_NOT_FOUND"
  | "INVALID_STATUS_TRANSITION";

export class MemoryViewAssetError extends Error {
  readonly code: MemoryViewAssetErrorCode;

  constructor(code: MemoryViewAssetErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "MemoryViewAssetError";
    this.code = code;
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateRefArray(
  value: unknown,
  label: string,
  options: { allowEmpty?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", `${label} is empty`);
  }
  const refs = value.map((item) => {
    if (typeof item !== "string" || !SAFE_REF.test(item)) {
      throw new MemoryViewAssetError("INVALID_CONTENT_REF", `${label} contains an unsafe ref`);
    }
    return item;
  });
  if (new Set(refs).size !== refs.length) {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", `${label} contains duplicate refs`);
  }
  return Object.freeze(refs);
}

function validateSemanticTypes(value: unknown): readonly MemorySemanticType[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", "semanticTypes is empty");
  }
  const types = value.map((item) => {
    if (typeof item !== "string" || !SEMANTIC_TYPES.has(item as MemorySemanticType)) {
      throw new MemoryViewAssetError("INVALID_CONTENT_REF", "semanticTypes contains an unknown type");
    }
    return item as MemorySemanticType;
  });
  if (new Set(types).size !== types.length) {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", "semanticTypes contains duplicates");
  }
  return Object.freeze(types);
}

export function validateMemoryProjectionContentRef(
  value: unknown,
): MemoryProjectionContentRef {
  if (!plainRecord(value) || Object.keys(value).some((key) => !CONTENT_REF_KEYS.has(key)) ||
      Object.keys(value).length !== CONTENT_REF_KEYS.size || value.type !== "memory_projection") {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", "only exact memory_projection is supported");
  }
  if (typeof value.resolutionHash !== "string" || !SHA256.test(value.resolutionHash)) {
    throw new MemoryViewAssetError("INVALID_CONTENT_REF", "resolutionHash must be lowercase sha256");
  }
  return Object.freeze({
    type: "memory_projection",
    recordIds: validateRefArray(value.recordIds, "recordIds"),
    treeNodeIds: validateRefArray(value.treeNodeIds, "treeNodeIds", { allowEmpty: true }),
    evidenceIds: validateRefArray(value.evidenceIds, "evidenceIds"),
    semanticTypes: validateSemanticTypes(value.semanticTypes),
    resolutionHash: value.resolutionHash,
  });
}

export function validateAssetIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_REF.test(value)) {
    throw new MemoryViewAssetError("INVALID_INPUT", `${label} is invalid`);
  }
  return value;
}

export function validateAssetText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxLength ||
      /[\p{Cc}]/u.test(value)) {
    throw new MemoryViewAssetError("INVALID_INPUT", `${label} is invalid`);
  }
  return value.trim();
}
