import { describe, expect, test } from "vitest";
import {
  ProviderFilterError,
  normalizeProviderFilter,
  type ProviderFilterAuthority,
  type ProviderFilterErrorCode,
} from "./provider-filter.js";

const AUTHORITY: ProviderFilterAuthority = {
  tenantId: "tenant-a",
  userId: "user-a",
};

function providerFilterError(
  action: () => unknown,
  code: ProviderFilterErrorCode,
  field?: string,
): ProviderFilterError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderFilterError);
    const providerError = error as ProviderFilterError;
    expect(providerError.code).toBe(code);
    if (field) {
      expect(providerError.field).toBe(field);
    }
    return providerError;
  }
  throw new Error(`expected ProviderFilterError(${code})`);
}

function readRequest(filter: Record<string, unknown> = {}) {
  return {
    operation: "read",
    tableName: "memories",
    dataTypes: ["memory"],
    filter,
  };
}

describe("normalizeProviderFilter", () => {
  test("normalizes an authorized read into a deeply immutable provider-neutral structure", () => {
    const request = Object.freeze({
      operation: "read",
      tableName: "memories",
      dataTypes: Object.freeze(["memory"]),
      filter: Object.freeze({
        pinned: true,
        category: "core",
        id: "memory-1",
        createdAt: 1_720_000_000_000,
        importance: 0.8,
      }),
    });

    const normalized = normalizeProviderFilter(Object.freeze(AUTHORITY), request);

    expect(normalized).toEqual({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: {
        tenantId: "tenant-a",
        userId: "user-a",
        id: "memory-1",
        category: "core",
        createdAt: 1_720_000_000_000,
        importance: 0.8,
        pinned: true,
      },
    });
    expect(Object.isFrozen(normalized)).toBe(true);
    expect(Object.isFrozen(normalized.dataTypes)).toBe(true);
    expect(Object.isFrozen(normalized.filter)).toBe(true);
  });

  test("allows scoped empty-filter reads but still injects tenant/user authority", () => {
    expect(normalizeProviderFilter(AUTHORITY, readRequest())).toEqual({
      operation: "read",
      tableName: "memories",
      dataTypes: ["memory"],
      filter: { tenantId: "tenant-a", userId: "user-a" },
    });
  });

  test("normalizes a scoped delete with an explicit target", () => {
    expect(normalizeProviderFilter(AUTHORITY, {
      operation: "delete",
      tableName: "knowledge",
      dataTypes: ["knowledge", "document"],
      filter: { projectId: "project-a", category: "architecture" },
    })).toEqual({
      operation: "delete",
      tableName: "knowledge",
      dataTypes: ["document", "knowledge"],
      filter: {
        tenantId: "tenant-a",
        userId: "user-a",
        projectId: "project-a",
        category: "architecture",
      },
    });
  });

  test.each([undefined, "", "update", "drop", { op: "read" }])(
    "rejects unknown operation %j",
    (operation) => {
      providerFilterError(
        () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), operation }),
        "OPERATION_NOT_ALLOWED",
        "operation",
      );
    },
  );

  test.each([undefined, null, "", "MEMORIES", "documents", "users", "knowledge_private"])(
    "rejects missing or arbitrary table %j",
    (tableName) => {
      const expected = tableName === undefined || tableName === null || tableName === ""
        ? "TABLE_REQUIRED"
        : "TABLE_NOT_ALLOWED";
      providerFilterError(
        () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), tableName }),
        expected,
        "tableName",
      );
    },
  );

  test.each([
    ["memories", ["document"]],
    ["memories", ["knowledge"]],
    ["knowledge", ["memory"]],
  ])("rejects table/dataType mismatch %s %j", (tableName, dataTypes) => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), tableName, dataTypes }),
      "TABLE_DATA_TYPE_MISMATCH",
      "dataTypes",
    );
  });

  test.each([
    undefined,
    null,
    [],
    "memory",
    ["unknown"],
    ["memory", "memory"],
    ["memory", null],
  ])("rejects invalid dataTypes %j", (dataTypes) => {
    const expected = Array.isArray(dataTypes) && dataTypes.length === 0
      ? "DATA_TYPES_REQUIRED"
      : dataTypes === undefined || dataTypes === null
        ? "DATA_TYPES_REQUIRED"
        : "DATA_TYPE_NOT_ALLOWED";
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), dataTypes }),
      expected,
      "dataTypes",
    );
  });

  test("rejects a missing filter object", () => {
    const request = { ...readRequest() } as Record<string, unknown>;
    delete request.filter;
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, request),
      "FILTER_REQUIRED",
      "filter",
    );
  });

  test("rejects empty-filter delete-all by default", () => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), operation: "delete", filter: {} }),
      "DELETE_FILTER_REQUIRED",
      "filter",
    );
  });

  test.each(["tenantId", "userId", "tableName", "dataType", "dataTypes"])(
    "rejects selector override inside filter: %s",
    (key) => {
      providerFilterError(
        () => normalizeProviderFilter(AUTHORITY, readRequest({ [key]: "victim" })),
        "FILTER_KEY_NOT_ALLOWED",
        "filter",
      );
    },
  );

  test.each([
    "__proto__",
    "prototype",
    "constructor",
    "metadata.path",
    "metadata->>path",
    "metadata[path]",
    "$where",
    "field;drop",
    "field name",
    "field\u0000name",
  ])("rejects prototype/SQL/JSON-path key %s", (key) => {
    const error = providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, readRequest({ [key]: "x" })),
      "FILTER_KEY_UNSAFE",
      "filter",
    );
    expect(error.message).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
  });

  test.each([
    ["id", ""],
    ["id", " memory-1"],
    ["id", "memory-1;drop table memories"],
    ["category", "x' OR '1'='1"],
    ["category", ["core"]],
    ["category", { $eq: "core" }],
    ["category", null],
    ["visibility", "owner"],
    ["createdAt", -1],
    ["createdAt", Number.NaN],
    ["createdAt", {}],
    ["importance", 2],
    ["importance", Number.POSITIVE_INFINITY],
    ["pinned", "true"],
  ] as const)("rejects invalid filter value %s=%j", (key, value) => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, readRequest({ [key]: value })),
      "FILTER_VALUE_INVALID",
      key,
    );
  });

  test.each([
    null,
    [],
    "id=memory-1",
    Object.create({ id: "inherited" }) as Record<string, unknown>,
  ])("rejects non-plain filter input", (filter) => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), filter }),
      "FILTER_REQUIRED",
      "filter",
    );
  });

  test.each([
    [null, "AUTHORITY_REQUIRED"],
    [{ tenantId: "" }, "AUTHORITY_REQUIRED"],
    [{ tenantId: "tenant-a", userId: "" }, "AUTHORITY_REQUIRED"],
    [{ tenantId: " tenant-a", userId: "user-a" }, "AUTHORITY_INVALID"],
  ] as const)("rejects invalid server authority %j", (authority, code) => {
    providerFilterError(
      () => normalizeProviderFilter(authority as ProviderFilterAuthority, readRequest()),
      code,
      "authority",
    );
  });

  test("rejects a non-object provider filter request", () => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, null),
      "REQUEST_INVALID",
      "request",
    );
  });
});

const MALICIOUS_KEYS = Array.from({ length: 60 }, (_, index) =>
  index % 3 === 0
    ? `metadata.path_${index}`
    : index % 3 === 1
      ? `field_${index}->>secret`
      : `unknown_filter_${index}`,
);

const MALICIOUS_TABLES = Array.from({ length: 60 }, (_, index) =>
  index % 3 === 0
    ? `memories_${index}`
    : index % 3 === 1
      ? `knowledge_${index};drop`
      : `tenant_${index}.memories`,
);

describe("provider filter malicious key/table corpus", () => {
  test.each(MALICIOUS_KEYS)("fails closed for malicious filter key %s", (key) => {
    const error = providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, readRequest({ [key]: "x" })),
      key.includes(".") || key.includes("->>")
        ? "FILTER_KEY_UNSAFE"
        : "FILTER_KEY_NOT_ALLOWED",
      "filter",
    );
    expect(error.message).not.toContain(key);
    expect(JSON.stringify(error)).not.toContain(key);
  });

  test.each(MALICIOUS_TABLES)("fails closed for malicious table %s", (tableName) => {
    providerFilterError(
      () => normalizeProviderFilter(AUTHORITY, { ...readRequest(), tableName }),
      "TABLE_NOT_ALLOWED",
      "tableName",
    );
  });
});
