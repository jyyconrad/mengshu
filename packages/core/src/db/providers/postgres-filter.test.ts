import { describe, expect, test } from "vitest";
import {
  normalizeProviderFilter,
  type NormalizedProviderFilter,
  type ProviderFilterOperation,
  type ProviderFilterTable,
  type ProviderFilterValues,
} from "../../domain/provider-filter.js";
import {
  PostgresFilterError,
  toPostgresFilterFragment,
  type PostgresFilterErrorCode,
} from "./postgres-filter.js";

const AUTHORITY = { tenantId: "tenant-a", userId: "user-a" } as const;

function normalized(
  operation: ProviderFilterOperation = "read",
  tableName: ProviderFilterTable = "memories",
  dataTypes: readonly string[] = ["memory"],
  filter: ProviderFilterValues = {},
): NormalizedProviderFilter {
  return normalizeProviderFilter(AUTHORITY, {
    operation,
    tableName,
    dataTypes,
    filter,
  });
}

function postgresFilterError(
  input: unknown,
  code: PostgresFilterErrorCode,
  field?: string,
): PostgresFilterError {
  try {
    toPostgresFilterFragment(input as NormalizedProviderFilter);
  } catch (error) {
    expect(error).toBeInstanceOf(PostgresFilterError);
    const postgresError = error as PostgresFilterError;
    expect(postgresError.code).toBe(code);
    if (field) {
      expect(postgresError.field).toBe(field);
    }
    return postgresError;
  }
  throw new Error(`expected PostgresFilterError(${code})`);
}

function freezeForged(input: Record<string, unknown>): NormalizedProviderFilter {
  const dataTypes = Array.isArray(input.dataTypes)
    ? Object.freeze([...input.dataTypes])
    : input.dataTypes;
  const filter = input.filter && typeof input.filter === "object"
    ? Object.freeze({ ...(input.filter as Record<string, unknown>) })
    : input.filter;
  return Object.freeze({ ...input, dataTypes, filter }) as unknown as NormalizedProviderFilter;
}

describe("toPostgresFilterFragment", () => {
  test("maps every allowlisted filter field to fixed identifiers and parameter-only values", () => {
    const createdAt = 1_720_000_000_000;
    const fragment = toPostgresFilterFragment(normalized("read", "memories", ["memory"], {
      id: "memory-1",
      contentHash: "hash-1",
      appId: "mengshu",
      projectId: "project-a",
      agentId: "agent-a",
      namespace: "memories",
      visibility: "private",
      category: "core",
      kind: "fact",
      semanticType: "resource",
      lifecycleStatus: "active",
      source: "user",
      createdAt,
      importance: 0.8,
      pinned: true,
    }));

    expect(fragment).toEqual({
      operation: "read",
      sql:
        "FROM \"memories\" WHERE \"data_type\" = $1" +
        " AND \"tenant_id\" = $2" +
        " AND \"user_id\" = $3" +
        " AND \"id\" = $4" +
        " AND \"content_hash\" = $5" +
        " AND \"app_name\" = $6" +
        " AND \"project_name\" = $7" +
        " AND \"agent_id\" = $8" +
        " AND \"namespace\" = $9" +
        " AND \"visibility\" = $10" +
        " AND \"category\" = $11" +
        " AND \"kind\" = $12" +
        " AND \"semantic_type\" = $13" +
        " AND \"lifecycle_status\" = $14" +
        " AND \"source\" = $15" +
        " AND \"created_at\" = $16" +
        " AND \"importance\" = $17" +
        " AND \"pinned\" = $18",
      params: [
        "memory",
        "tenant-a",
        "user-a",
        "memory-1",
        "hash-1",
        "mengshu",
        "project-a",
        "agent-a",
        "memories",
        "private",
        "core",
        "fact",
        "resource",
        "active",
        "user",
        new Date(createdAt).toISOString(),
        0.8,
        true,
      ],
    });
    expect(Object.isFrozen(fragment)).toBe(true);
    expect(Object.isFrozen(fragment.params)).toBe(true);
  });

  test("maps delete with multiple dataTypes to one array parameter and never interpolates values", () => {
    const fragment = toPostgresFilterFragment(normalized(
      "delete",
      "knowledge",
      ["knowledge", "document"],
      { projectId: "project-a", category: "architecture" },
    ));

    expect(fragment).toEqual({
      operation: "delete",
      sql:
        "DELETE FROM \"knowledge\" WHERE \"data_type\" = ANY($1::text[])" +
        " AND \"tenant_id\" = $2" +
        " AND \"user_id\" = $3" +
        " AND \"project_name\" = $4" +
        " AND \"category\" = $5",
      params: [
        ["document", "knowledge"],
        "tenant-a",
        "user-a",
        "project-a",
        "architecture",
      ],
    });
    expect(fragment.sql).not.toContain("project-a");
    expect(fragment.sql).not.toContain("architecture");
    expect(Object.isFrozen(fragment.params[0])).toBe(true);
  });

  test.each([
    ["memories", ["memory"]],
    ["knowledge", ["knowledge"]],
  ] as const)("maps fixed table/dataType identifiers for %s", (tableName, dataTypes) => {
    const fragment = toPostgresFilterFragment(normalized("read", tableName, dataTypes));
    expect(fragment.sql).toContain(`FROM \"${tableName}\"`);
    expect(fragment.sql).toContain("\"data_type\" = $1");
    expect(fragment.params[0]).toBe(dataTypes[0]);
  });

  test("secondarily rejects an empty normalized delete", () => {
    postgresFilterError(freezeForged({
      operation: "delete",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: { tenantId: "tenant-a", userId: "user-a" },
    }), "DELETE_FILTER_REQUIRED", "filter");
  });

  test.each([
    ["operation", "drop", "OPERATION_NOT_SUPPORTED"],
    ["tableName", "memories;drop", "TABLE_NOT_SUPPORTED"],
    ["dataTypes", ["memory", "secret"], "DATA_TYPE_NOT_SUPPORTED"],
  ] as const)("rejects forged normalized selector %s", (field, value, code) => {
    const forged = freezeForged({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: { tenantId: "tenant-a", userId: "user-a" },
      [field]: value,
    });
    postgresFilterError(forged, code, field);
  });

  test.each([
    ["raw->>key", "x", "FILTER_KEY_NOT_SUPPORTED"],
    ["__proto__", "x", "FILTER_KEY_NOT_SUPPORTED"],
    ["id", { $eq: "memory-1" }, "FILTER_VALUE_INVALID"],
    ["category", ["core"], "FILTER_VALUE_INVALID"],
  ] as const)("rejects forged normalized filter %s", (key, value, code) => {
    const filter = Object.freeze({
      tenantId: "tenant-a",
      userId: "user-a",
      [key]: value,
    });
    const forged = freezeForged({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter,
    });
    const field = code === "FILTER_KEY_NOT_SUPPORTED" ? "filter" : key;
    const error = postgresFilterError(forged, code, field);
    if (code === "FILTER_KEY_NOT_SUPPORTED") {
      expect(error.message).not.toContain(key);
      expect(JSON.stringify(error)).not.toContain(key);
    }
  });

  test("rejects an extra raw operator even when the forged object is frozen", () => {
    postgresFilterError(freezeForged({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: { tenantId: "tenant-a", userId: "user-a" },
      operator: "OR 1=1",
    }), "INPUT_NOT_NORMALIZED", "input");
  });

  test.each([
    { operation: "read", tableName: "memories", dataTypes: ["memory"], filter: {} },
    Object.freeze({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: Object.freeze({ tenantId: "tenant-a", userId: "user-a" }),
    }),
  ])("rejects mutable top-level or nested inputs", (input) => {
    postgresFilterError(input, "INPUT_NOT_IMMUTABLE", "input");
  });
});
