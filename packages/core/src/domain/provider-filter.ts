/** Provider-neutral, fail-closed filter normalization for read/delete operations. */

import type { DataType } from "../db/types.js";
import type { MemoryVisibility } from "./types.js";

export type ProviderFilterOperation = "read" | "delete";
export type ProviderFilterTable = "memories" | "knowledge";

export type ProviderFilterErrorCode =
  | "AUTHORITY_REQUIRED"
  | "AUTHORITY_INVALID"
  | "REQUEST_INVALID"
  | "OPERATION_NOT_ALLOWED"
  | "TABLE_REQUIRED"
  | "TABLE_NOT_ALLOWED"
  | "DATA_TYPES_REQUIRED"
  | "DATA_TYPE_NOT_ALLOWED"
  | "TABLE_DATA_TYPE_MISMATCH"
  | "FILTER_REQUIRED"
  | "DELETE_FILTER_REQUIRED"
  | "FILTER_KEY_UNSAFE"
  | "FILTER_KEY_NOT_ALLOWED"
  | "FILTER_VALUE_INVALID";

export class ProviderFilterError extends Error {
  readonly code: ProviderFilterErrorCode;
  readonly field?: string;

  constructor(code: ProviderFilterErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ProviderFilterError";
    this.code = code;
    this.field = field;
  }
}

export interface ProviderFilterAuthority {
  tenantId: string;
  userId: string;
}

export interface ProviderFilterValues {
  id?: string;
  contentHash?: string;
  appId?: string;
  projectId?: string;
  agentId?: string;
  namespace?: string;
  visibility?: MemoryVisibility;
  category?: string;
  kind?: string;
  semanticType?: string;
  lifecycleStatus?: string;
  source?: string;
  createdAt?: number;
  importance?: number;
  pinned?: boolean;
}

export interface ProviderFilterRequest {
  operation: ProviderFilterOperation;
  tableName: ProviderFilterTable;
  dataTypes: readonly DataType[];
  filter: ProviderFilterValues;
}

export type NormalizedProviderFilterValues = Readonly<
  ProviderFilterValues & {
    tenantId: string;
    userId: string;
  }
>;

export interface NormalizedProviderFilter {
  readonly operation: ProviderFilterOperation;
  readonly tableName: ProviderFilterTable;
  readonly dataTypes: readonly DataType[];
  readonly filter: NormalizedProviderFilterValues;
}

type ProviderFilterKey = keyof ProviderFilterValues;

const OPERATIONS = new Set<ProviderFilterOperation>(["read", "delete"]);
const TABLES = new Set<ProviderFilterTable>(["memories", "knowledge"]);
const DATA_TYPE_ORDER = ["memory", "document", "knowledge"] as const satisfies readonly DataType[];
const DATA_TYPES = new Set<DataType>(DATA_TYPE_ORDER);
const TABLE_DATA_TYPES: Readonly<Record<ProviderFilterTable, ReadonlySet<DataType>>> = {
  memories: new Set<DataType>(["memory"]),
  knowledge: new Set<DataType>(["document", "knowledge"]),
};

const FILTER_KEYS = [
  "id",
  "contentHash",
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
  "category",
  "kind",
  "semanticType",
  "lifecycleStatus",
  "source",
  "createdAt",
  "importance",
  "pinned",
] as const satisfies readonly ProviderFilterKey[];
const FILTER_KEY_SET = new Set<string>(FILTER_KEYS);
const STRING_FILTER_KEYS = new Set<ProviderFilterKey>([
  "id",
  "contentHash",
  "appId",
  "projectId",
  "agentId",
  "namespace",
  "visibility",
  "category",
  "kind",
  "semanticType",
  "lifecycleStatus",
  "source",
]);
const VALID_VISIBILITIES = new Set<MemoryVisibility>([
  "private",
  "workspace",
  "team",
  "public",
]);

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DANGEROUS_VALUE_TOKEN = /(?:;|--|\/\*|\*\/|'|"|`)/;
const UNSAFE_FILTER_KEY = /(?:\.|->|\[|\]|\$|;|'|"|`|\s|[\u0000-\u001f\u007f])/;
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasValidCanonicalString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    value.normalize("NFKC") === value &&
    !CONTROL_CHARACTERS.test(value) &&
    !DANGEROUS_VALUE_TOKEN.test(value)
  );
}

function validatedAuthority(authority: ProviderFilterAuthority): ProviderFilterAuthority {
  if (!isRecord(authority)) {
    throw new ProviderFilterError(
      "AUTHORITY_REQUIRED",
      "provider filter authority is required",
      "authority",
    );
  }
  const tenantId = authority.tenantId;
  const userId = authority.userId;
  if (
    typeof tenantId !== "string" ||
    tenantId.trim().length === 0 ||
    typeof userId !== "string" ||
    userId.trim().length === 0
  ) {
    throw new ProviderFilterError(
      "AUTHORITY_REQUIRED",
      "provider filter authority requires tenantId and userId",
      "authority",
    );
  }
  if (!hasValidCanonicalString(tenantId) || !hasValidCanonicalString(userId)) {
    throw new ProviderFilterError(
      "AUTHORITY_INVALID",
      "provider filter authority is not canonical",
      "authority",
    );
  }
  return { tenantId, userId };
}

function validatedOperation(value: unknown): ProviderFilterOperation {
  if (typeof value !== "string" || !OPERATIONS.has(value as ProviderFilterOperation)) {
    throw new ProviderFilterError(
      "OPERATION_NOT_ALLOWED",
      "provider filter operation is not allowed",
      "operation",
    );
  }
  return value as ProviderFilterOperation;
}

function validatedTable(value: unknown): ProviderFilterTable {
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderFilterError(
      "TABLE_REQUIRED",
      "provider filter tableName is required",
      "tableName",
    );
  }
  if (!TABLES.has(value as ProviderFilterTable)) {
    throw new ProviderFilterError(
      "TABLE_NOT_ALLOWED",
      "provider filter tableName is not allowlisted",
      "tableName",
    );
  }
  return value as ProviderFilterTable;
}

function validatedDataTypes(value: unknown, tableName: ProviderFilterTable): readonly DataType[] {
  if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new ProviderFilterError(
      "DATA_TYPES_REQUIRED",
      "provider filter dataTypes are required",
      "dataTypes",
    );
  }
  if (!Array.isArray(value)) {
    throw new ProviderFilterError(
      "DATA_TYPE_NOT_ALLOWED",
      "provider filter dataTypes must be an array",
      "dataTypes",
    );
  }

  const unique = new Set<DataType>();
  for (const item of value) {
    if (typeof item !== "string" || !DATA_TYPES.has(item as DataType) || unique.has(item as DataType)) {
      throw new ProviderFilterError(
        "DATA_TYPE_NOT_ALLOWED",
        "provider filter dataTypes contain an invalid or duplicate value",
        "dataTypes",
      );
    }
    unique.add(item as DataType);
  }
  if (Array.from(unique).some((dataType) => !TABLE_DATA_TYPES[tableName].has(dataType))) {
    throw new ProviderFilterError(
      "TABLE_DATA_TYPE_MISMATCH",
      "provider filter tableName and dataTypes do not match",
      "dataTypes",
    );
  }
  return Object.freeze(DATA_TYPE_ORDER.filter((dataType) => unique.has(dataType)));
}

function unsafeFilterKey(key: string): boolean {
  return PROTOTYPE_KEYS.has(key) || UNSAFE_FILTER_KEY.test(key);
}

function validatedFilterValue(key: ProviderFilterKey, value: unknown): string | number | boolean {
  if (STRING_FILTER_KEYS.has(key)) {
    if (!hasValidCanonicalString(value)) {
      throw new ProviderFilterError(
        "FILTER_VALUE_INVALID",
        `provider filter value for ${key} is invalid`,
        key,
      );
    }
    if (key === "visibility" && !VALID_VISIBILITIES.has(value as MemoryVisibility)) {
      throw new ProviderFilterError(
        "FILTER_VALUE_INVALID",
        "provider filter visibility is invalid",
        key,
      );
    }
    return value;
  }

  if (key === "createdAt") {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new ProviderFilterError(
        "FILTER_VALUE_INVALID",
        "provider filter createdAt must be a non-negative integer",
        key,
      );
    }
    return value;
  }
  if (key === "importance") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ProviderFilterError(
        "FILTER_VALUE_INVALID",
        "provider filter importance must be between 0 and 1",
        key,
      );
    }
    return value;
  }
  if (key === "pinned" && typeof value === "boolean") {
    return value;
  }
  throw new ProviderFilterError(
    "FILTER_VALUE_INVALID",
    `provider filter value for ${key} is invalid`,
    key,
  );
}

function validatedFilter(
  value: unknown,
  operation: ProviderFilterOperation,
  authority: ProviderFilterAuthority,
): NormalizedProviderFilterValues {
  if (!isPlainRecord(value)) {
    throw new ProviderFilterError(
      "FILTER_REQUIRED",
      "provider filter must be a plain object",
      "filter",
    );
  }

  const keys = Object.keys(value);
  if (operation === "delete" && keys.length === 0) {
    throw new ProviderFilterError(
      "DELETE_FILTER_REQUIRED",
      "delete requires at least one explicit scoped filter",
      "filter",
    );
  }
  for (const key of keys) {
    if (unsafeFilterKey(key)) {
      throw new ProviderFilterError(
        "FILTER_KEY_UNSAFE",
        "provider filter contains an unsafe key",
        "filter",
      );
    }
    if (!FILTER_KEY_SET.has(key)) {
      throw new ProviderFilterError(
        "FILTER_KEY_NOT_ALLOWED",
        "provider filter contains a key that is not allowlisted",
        "filter",
      );
    }
  }

  const normalized: Record<string, string | number | boolean> = {
    tenantId: authority.tenantId,
    userId: authority.userId,
  };
  for (const key of FILTER_KEYS) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      normalized[key] = validatedFilterValue(key, value[key]);
    }
  }
  return Object.freeze(normalized) as NormalizedProviderFilterValues;
}

/**
 * Validate and normalize provider filter input without building a provider
 * query. Adapters must consume the returned typed values with their own safe,
 * parameterized APIs.
 */
export function normalizeProviderFilter(
  authority: ProviderFilterAuthority,
  input: unknown,
): NormalizedProviderFilter {
  const trusted = validatedAuthority(authority);
  if (!isPlainRecord(input)) {
    throw new ProviderFilterError(
      "REQUEST_INVALID",
      "provider filter request must be a plain object",
      "request",
    );
  }

  const operation = validatedOperation(input.operation);
  const tableName = validatedTable(input.tableName);
  const dataTypes = validatedDataTypes(input.dataTypes, tableName);
  const filter = validatedFilter(input.filter, operation, trusted);
  return Object.freeze({ operation, tableName, dataTypes, filter });
}
