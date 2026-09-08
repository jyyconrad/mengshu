import { canonicalRehydrationDomainHash, canonicalRehydrationJson } from "../../db/migrations/canonical-postgres-rehydration.js";
import type { HistoryContinuationInput } from "./types.js";

export class HistoryError extends Error {
  constructor(readonly code: string) { super(code); this.name = "HistoryError"; }
}
export function rejectHistory(code: string): never { throw new HistoryError(code); }
export const historyHash = (value: unknown): string => canonicalRehydrationDomainHash("mengshu.history-p16/v1", value);
export const historyJson = canonicalRehydrationJson;
export const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const isRef = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && !/[\s\p{Cc}]/u.test(value);
export const isCount = (value: unknown, max: number, min = 0): value is number => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;

export function exactObject(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) rejectHistory("HISTORY_INPUT_INVALID");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key) && !optional.includes(key)) || keys.some(key => !(key in row))) rejectHistory("HISTORY_INPUT_INVALID");
  return row;
}

export function parseHistoryInput(value: unknown): HistoryContinuationInput {
  const row = exactObject(value, ["schema", "runId", "parentRunId", "parentReceiptHash", "projectionHash", "sourceManifestHash", "governanceManifestHash", "policyVersion", "expected", "limits"]);
  if (row.schema !== "mengshu.history-p16-input/v1" || !isRef(row.runId) || !isRef(row.parentRunId) || row.runId === row.parentRunId ||
      [row.runId, row.parentRunId, row.policyVersion].some(id => !isRef(id) || id.length > 256) ||
      [row.parentReceiptHash, row.projectionHash, row.sourceManifestHash, row.governanceManifestHash].some(hash => !isHash(hash))) rejectHistory("HISTORY_INPUT_INVALID");
  const counts = exactObject(row.expected, ["sources", "targets", "claimBindings", "scopes"]);
  const limits = exactObject(row.limits, ["pageSize", "maxSources", "maxTargets", "maxBindings", "maxBatchUnits", "maxDurationMs"]);
  for (const key of ["sources", "targets", "claimBindings", "scopes"]) if (!isCount(counts[key], 1000000, 1)) rejectHistory("HISTORY_INPUT_INVALID");
  for (const key of ["maxSources", "maxTargets", "maxBindings"]) if (!isCount(limits[key], 1000000, 1)) rejectHistory("HISTORY_INPUT_INVALID");
  if (!isCount(limits.pageSize, 1000, 1) || !isCount(limits.maxBatchUnits, 100, 1) || !isCount(limits.maxDurationMs, 3600000, 1) ||
      Number(counts.sources) > Number(limits.maxSources) || Number(counts.targets) > Number(limits.maxTargets) || Number(counts.claimBindings) > Number(limits.maxBindings) ||
      Number(counts.scopes) > Number(counts.sources)) rejectHistory("HISTORY_INPUT_INVALID");
  return structuredClone(row) as unknown as HistoryContinuationInput;
}

export function verifyHistoryHash<T extends { hash: string }>(value: T): T {
  const { hash, ...body } = value;
  if (!isHash(hash) || historyHash(body) !== hash) rejectHistory("HISTORY_ARTIFACT_DRIFT");
  return value;
}
