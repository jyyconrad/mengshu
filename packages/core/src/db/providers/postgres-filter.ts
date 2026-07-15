/** Safe Postgres fragment generation from a normalized provider filter. */

import {
  normalizeProviderFilter,
  ProviderFilterError,
  type NormalizedProviderFilter,
  type ProviderFilterErrorCode,
  type ProviderFilterOperation,
  type ProviderFilterTable,
} from "../../domain/provider-filter.js";

export type PostgresFilterErrorCode =
  | "INPUT_NOT_IMMUTABLE"
  | "INPUT_NOT_NORMALIZED"
  | "OPERATION_NOT_SUPPORTED"
  | "TABLE_NOT_SUPPORTED"
  | "DATA_TYPE_NOT_SUPPORTED"
  | "FILTER_KEY_NOT_SUPPORTED"
  | "FILTER_VALUE_INVALID"
  | "DELETE_FILTER_REQUIRED";

export class PostgresFilterError extends Error {
  readonly code: PostgresFilterErrorCode;
  readonly field?: string;

  constructor(code: PostgresFilterErrorCode, message: string, field?: string) {
    super(message);
    this.name = "PostgresFilterError";
    this.code = code;
    this.field = field;
  }
}

export interface PostgresFilterFragment {
  readonly operation: ProviderFilterOperation;
  /** FROM fragment for read; complete DELETE prefix for delete. */
  readonly sql: string;
  readonly params: readonly unknown[];
}

const NORMALIZED_TOP_LEVEL_KEYS = ["operation", "tableName", "dataTypes", "filter"] as const;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function mappedNormalizationError(error: ProviderFilterError): PostgresFilterError {
  const mappings: Readonly<Record<ProviderFilterErrorCode, PostgresFilterErrorCode>> = {
    AUTHORITY_REQUIRED: "FILTER_VALUE_INVALID",
    AUTHORITY_INVALID: "FILTER_VALUE_INVALID",
    REQUEST_INVALID: "INPUT_NOT_NORMALIZED",
    OPERATION_NOT_ALLOWED: "OPERATION_NOT_SUPPORTED",
    TABLE_REQUIRED: "TABLE_NOT_SUPPORTED",
    TABLE_NOT_ALLOWED: "TABLE_NOT_SUPPORTED",
    DATA_TYPES_REQUIRED: "DATA_TYPE_NOT_SUPPORTED",
    DATA_TYPE_NOT_ALLOWED: "DATA_TYPE_NOT_SUPPORTED",
    TABLE_DATA_TYPE_MISMATCH: "DATA_TYPE_NOT_SUPPORTED",
    FILTER_REQUIRED: "INPUT_NOT_NORMALIZED",
    DELETE_FILTER_REQUIRED: "DELETE_FILTER_REQUIRED",
    FILTER_KEY_UNSAFE: "FILTER_KEY_NOT_SUPPORTED",
    FILTER_KEY_NOT_ALLOWED: "FILTER_KEY_NOT_SUPPORTED",
    FILTER_VALUE_INVALID: "FILTER_VALUE_INVALID",
  };
  const code = mappings[error.code];
  const field = code === "FILTER_KEY_NOT_SUPPORTED" ? "filter" : error.field;
  return new PostgresFilterError(code, `normalized provider filter rejected: ${code}`, field);
}

function sameNormalizedInput(
  input: Record<string, unknown>,
  expected: NormalizedProviderFilter,
): boolean {
  if (!sameKeys(Object.keys(input), NORMALIZED_TOP_LEVEL_KEYS)) {
    return false;
  }
  const dataTypes = input.dataTypes;
  const filter = input.filter;
  if (
    input.operation !== expected.operation ||
    input.tableName !== expected.tableName ||
    !Array.isArray(dataTypes) ||
    !isPlainRecord(filter)
  ) {
    return false;
  }
  if (
    dataTypes.length !== expected.dataTypes.length ||
    dataTypes.some((value, index) => value !== expected.dataTypes[index])
  ) {
    return false;
  }
  const actualFilterKeys = Object.keys(filter);
  const expectedFilterKeys = Object.keys(expected.filter);
  return (
    sameKeys(actualFilterKeys, expectedFilterKeys) &&
    actualFilterKeys.every((key) => filter[key] === expected.filter[key as keyof typeof expected.filter])
  );
}

function assertNormalizedImmutable(input: NormalizedProviderFilter): NormalizedProviderFilter {
  const candidate: unknown = input;
  if (!isPlainRecord(candidate) || !Object.isFrozen(candidate)) {
    throw new PostgresFilterError(
      "INPUT_NOT_IMMUTABLE",
      "Postgres filter input must be a frozen normalized contract",
      "input",
    );
  }
  const dataTypes = candidate.dataTypes;
  const filter = candidate.filter;
  if (
    !Array.isArray(dataTypes) ||
    !Object.isFrozen(dataTypes) ||
    !isPlainRecord(filter) ||
    !Object.isFrozen(filter)
  ) {
    throw new PostgresFilterError(
      "INPUT_NOT_IMMUTABLE",
      "Postgres filter input must be a frozen normalized contract",
      "input",
    );
  }
  if (!sameKeys(Object.keys(candidate), NORMALIZED_TOP_LEVEL_KEYS)) {
    throw new PostgresFilterError(
      "INPUT_NOT_NORMALIZED",
      "Postgres filter input has unexpected top-level fields",
      "input",
    );
  }
  const businessFilterCount = Object.keys(filter)
    .filter((key) => key !== "tenantId" && key !== "userId")
    .length;
  if (candidate.operation === "delete" && businessFilterCount === 0) {
    throw new PostgresFilterError(
      "DELETE_FILTER_REQUIRED",
      "Postgres delete requires an explicit business filter",
      "filter",
    );
  }

  const tenantId = filter.tenantId;
  const userId = filter.userId;
  const clientFilter = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(filter)) {
    if (key !== "tenantId" && key !== "userId") {
      Object.defineProperty(clientFilter, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }

  let expected: NormalizedProviderFilter;
  try {
    expected = normalizeProviderFilter(
      { tenantId: tenantId as string, userId: userId as string },
      {
        operation: candidate.operation,
        tableName: candidate.tableName,
        dataTypes,
        filter: clientFilter,
      },
    );
  } catch (error) {
    if (error instanceof ProviderFilterError) {
      throw mappedNormalizationError(error);
    }
    throw new PostgresFilterError(
      "INPUT_NOT_NORMALIZED",
      "Postgres filter input could not be validated",
      "input",
    );
  }
  if (!sameNormalizedInput(candidate, expected)) {
    throw new PostgresFilterError(
      "INPUT_NOT_NORMALIZED",
      "Postgres filter input does not match normalized form",
      "input",
    );
  }
  return input;
}

function tableIdentifier(tableName: ProviderFilterTable): string {
  switch (tableName) {
    case "memories":
      return '"memories"';
    case "knowledge":
      return '"knowledge"';
    default:
      throw new PostgresFilterError(
        "TABLE_NOT_SUPPORTED",
        "Postgres filter table is not supported",
        "tableName",
      );
  }
}

function operationPrefix(operation: ProviderFilterOperation): string {
  switch (operation) {
    case "read":
      return "FROM";
    case "delete":
      return "DELETE FROM";
    default:
      throw new PostgresFilterError(
        "OPERATION_NOT_SUPPORTED",
        "Postgres filter operation is not supported",
        "operation",
      );
  }
}

function dataTypeValue(value: string): string {
  switch (value) {
    case "memory":
      return "memory";
    case "document":
      return "document";
    case "knowledge":
      return "knowledge";
    default:
      throw new PostgresFilterError(
        "DATA_TYPE_NOT_SUPPORTED",
        "Postgres filter data type is not supported",
        "dataTypes",
      );
  }
}

function filterIdentifier(key: string): string {
  switch (key) {
    case "tenantId":
      return '"tenant_id"';
    case "userId":
      return '"user_id"';
    case "id":
      return '"id"';
    case "contentHash":
      return '"content_hash"';
    case "appId":
      return '"app_name"';
    case "projectId":
      return '"project_name"';
    case "agentId":
      return '"agent_id"';
    case "namespace":
      return '"namespace"';
    case "visibility":
      return '"visibility"';
    case "category":
      return '"category"';
    case "kind":
      return '"kind"';
    case "semanticType":
      return '"semantic_type"';
    case "lifecycleStatus":
      return '"lifecycle_status"';
    case "source":
      return '"source"';
    case "createdAt":
      return '"created_at"';
    case "importance":
      return '"importance"';
    case "pinned":
      return '"pinned"';
    default:
      throw new PostgresFilterError(
        "FILTER_KEY_NOT_SUPPORTED",
        "Postgres filter contains an unsupported key",
        "filter",
      );
  }
}

function postgresParamValue(key: string, value: unknown): unknown {
  switch (key) {
    case "createdAt":
      return new Date(value as number).toISOString();
    case "tenantId":
    case "userId":
    case "id":
    case "contentHash":
    case "appId":
    case "projectId":
    case "agentId":
    case "namespace":
    case "visibility":
    case "category":
    case "kind":
    case "semanticType":
    case "lifecycleStatus":
    case "source":
    case "importance":
    case "pinned":
      return value;
    default:
      throw new PostgresFilterError(
        "FILTER_KEY_NOT_SUPPORTED",
        "Postgres filter contains an unsupported key",
        "filter",
      );
  }
}

/** Convert a frozen T303 contract into fixed Postgres identifiers and params. */
export function toPostgresFilterFragment(
  input: NormalizedProviderFilter,
): PostgresFilterFragment {
  const normalized = assertNormalizedImmutable(input);
  const params: unknown[] = [];
  const conditions: string[] = [];
  const dataTypes = normalized.dataTypes.map((value) => dataTypeValue(value));
  if (dataTypes.length === 1) {
    params.push(dataTypes[0]);
    conditions.push(`"data_type" = $${params.length}`);
  } else {
    const frozenDataTypes = Object.freeze([...dataTypes]);
    params.push(frozenDataTypes);
    conditions.push(`"data_type" = ANY($${params.length}::text[])`);
  }

  for (const [key, value] of Object.entries(normalized.filter)) {
    const identifier = filterIdentifier(key);
    params.push(postgresParamValue(key, value));
    conditions.push(`${identifier} = $${params.length}`);
  }

  const sql = `${operationPrefix(normalized.operation)} ${tableIdentifier(normalized.tableName)} WHERE ${conditions.join(" AND ")}`;
  return Object.freeze({
    operation: normalized.operation,
    sql,
    params: Object.freeze(params),
  });
}
