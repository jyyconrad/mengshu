import { describe, expect, test } from "vitest";

import {
  CanonicalRehydrationError,
  assertCanonicalProductionApplyAuthorization,
  assertCanonicalRehydrationMode,
  assertCanonicalRehydrationRehearsalChecks,
  assertEphemeralPostgresIdentity,
  canonicalSourceLifecycleAction,
  canonicalSourceMigrationDisposition,
  canonicalRehydrationDomainHash,
  canonicalRehydrationJson,
} from "./canonical-postgres-rehydration.js";

describe("canonical PostgreSQL rehydration guards", () => {
  test("production apply is unavailable before the independent P15 authorization", () => {
    expect(() => assertCanonicalRehydrationMode("apply")).toThrowError(
      expect.objectContaining<Partial<CanonicalRehydrationError>>({
        code: "CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED",
      }),
    );
    expect(() => assertCanonicalRehydrationMode("rehearse")).not.toThrow();
  });

  test("rehearsal accepts only the expected temporary Unix-socket instance", () => {
    expect(() => assertEphemeralPostgresIdentity({
      inetServerAddress: null,
      actualDataDirectory: "/tmp/mengshu-p14/data",
      expectedDataDirectory: "/tmp/mengshu-p14/data",
      currentDatabase: "postgres",
    })).not.toThrow();
    expect(() => assertEphemeralPostgresIdentity({
      inetServerAddress: "127.0.0.1",
      actualDataDirectory: "/var/lib/postgresql/data",
      expectedDataDirectory: "/tmp/mengshu-p14/data",
      currentDatabase: "mengshu",
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_REHEARSAL_FAILED",
    }));
  });

  test("all P14 gates must pass", () => {
    const passing = {
      schema: true,
      embedding: true,
      canonicalRead: true,
      evidenceDrilldown: true,
      fiveSlotRecall: true,
      disclosureR0R4: true,
      lookup: true,
      resource: true,
      tree: true,
      graph: true,
      scopeIsolation: true,
      restartConsistency: true,
      rollbackRestore: true,
    } as const;
    expect(() => assertCanonicalRehydrationRehearsalChecks(passing)).not.toThrow();
    expect(() => assertCanonicalRehydrationRehearsalChecks({
      ...passing,
      restartConsistency: false,
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_REHEARSAL_FAILED",
    }));
  });

  test("canonical hashing is stable across object key order", () => {
    expect(canonicalRehydrationDomainHash("domain", { b: 2, a: 1 })).toBe(
      canonicalRehydrationDomainHash("domain", { a: 1, b: 2 }),
    );
    expect(canonicalRehydrationJson({ b: 2, a: 1 })).toBe("{\n  \"a\": 1,\n  \"b\": 2\n}\n");
  });

  test("production apply authorization is bound to the immutable P15 receipt", () => {
    const preflightHash = "a".repeat(64);
    const input = {
      mode: "apply",
      runId: "markdown-workset-2026-08-28-prod-01",
      projectionHash: "b".repeat(64),
      expectedProjectionHash: "b".repeat(64),
      preflightHash,
      applyToken: `P15_APPLY:markdown-workset-2026-08-28-prod-01:${preflightHash}`,
      receiptApplyToken: `P15_APPLY:markdown-workset-2026-08-28-prod-01:${preflightHash}`,
      maintenance: true,
      quiescenceConfirmed: true,
      physicalPurgeAuthorized: false,
    } as const;
    expect(() => assertCanonicalProductionApplyAuthorization(input)).not.toThrow();
    expect(() => assertCanonicalProductionApplyAuthorization({
      ...input,
      applyToken: `${input.applyToken} `,
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED",
    }));
    expect(() => assertCanonicalProductionApplyAuthorization({
      ...input,
      quiescenceConfirmed: false,
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED",
    }));
    expect(() => assertCanonicalProductionApplyAuthorization({
      ...input,
      physicalPurgeAuthorized: true,
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_PRODUCTION_AUTH_REQUIRED",
    }));
  });

  test("source dispositions retain exact governance semantics and explicit v27 compatibility", () => {
    expect(canonicalSourceMigrationDisposition({
      disposition: "attached_to_typed_document",
      operation: "archive_after_activation",
    })).toEqual({ governanceDisposition: "attached_to_typed_document", migrationDisposition: "merge_semantic" });
    expect(canonicalSourceMigrationDisposition({
      disposition: "deferred",
      operation: "archive_deferred",
    })).toEqual({ governanceDisposition: "deferred", migrationDisposition: "lookup_only" });
    expect(canonicalSourceMigrationDisposition({
      disposition: "lookup_only",
      operation: "preserve_lookup_only",
    })).toEqual({ governanceDisposition: "lookup_only", migrationDisposition: "lookup_only" });
    expect(() => canonicalSourceMigrationDisposition({
      disposition: "deferred",
      operation: "preserve_lookup_only",
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_INVALID_INPUT",
    }));
  });

  test("legacy rows leave or remain in the online layer according to the frozen operation", () => {
    expect(canonicalSourceLifecycleAction({
      sourceTable: "memories",
      operation: "archive_after_activation",
    })).toBe("archive");
    expect(canonicalSourceLifecycleAction({
      sourceTable: "memories",
      operation: "preserve_memory_lookup_only",
    })).toBe("archive");
    expect(canonicalSourceLifecycleAction({
      sourceTable: "knowledge",
      operation: "preserve_lookup_only",
    })).toBe("preserve");
    expect(canonicalSourceLifecycleAction({
      sourceTable: "knowledge",
      operation: "quarantine",
    })).toBe("quarantine");
    expect(() => canonicalSourceLifecycleAction({
      sourceTable: "knowledge",
      operation: "archive_after_activation",
    })).toThrowError(expect.objectContaining({
      code: "CANONICAL_REHYDRATION_INVALID_INPUT",
    }));
  });
});
