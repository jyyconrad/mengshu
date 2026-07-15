/**
 * Fail-closed guard for legacy provider delete filters.
 *
 * This boundary only prevents an accidental unfiltered delete. It deliberately
 * does not replace the normalized authority-scoped provider filter contract.
 */

export type LegacyDeleteFilterErrorCode = "DELETE_FILTER_REQUIRED";

export class LegacyDeleteFilterError extends Error {
  readonly code: LegacyDeleteFilterErrorCode;
  readonly field = "filter";

  constructor() {
    super("legacy delete requires at least one provider-consumed business filter");
    this.name = "LegacyDeleteFilterError";
    this.code = "DELETE_FILTER_REQUIRED";
  }
}

export interface LegacyDeleteFilterGuardOptions {
  /** True only when this provider actually translates dataType into a predicate. */
  readonly consumesDataType?: boolean;
}

const CREATED_AT_OPERATORS = new Set(["$gt", "$gte", "$lt", "$lte", "$eq"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isConsumedScalar(value: unknown): value is string | number | boolean {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function hasConsumedCreatedAt(value: unknown): boolean {
  if (!isPlainRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([operator, timestamp]) => (
    CREATED_AT_OPERATORS.has(operator) &&
    typeof timestamp === "number" &&
    Number.isFinite(timestamp)
  ));
}

function isProviderConsumedCondition(
  key: string,
  value: unknown,
  options: LegacyDeleteFilterGuardOptions,
): boolean {
  if (key === "tableName") {
    return false;
  }
  if (key === "dataType") {
    return options.consumesDataType === true && isConsumedScalar(value);
  }
  if (key === "createdAt") {
    return hasConsumedCreatedAt(value);
  }
  return isConsumedScalar(value);
}

/** Reject before provider initialization/query/delete when no predicate exists. */
export function assertSafeLegacyDeleteFilter(
  filter: unknown,
  options: LegacyDeleteFilterGuardOptions = {},
): asserts filter is Record<string, unknown> {
  if (
    !isPlainRecord(filter) ||
    !Object.entries(filter).some(([key, value]) => isProviderConsumedCondition(key, value, options))
  ) {
    throw new LegacyDeleteFilterError();
  }
}
