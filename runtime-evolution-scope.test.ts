import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "./config.js";
import { createMengshuRuntime } from "./runtime.js";
import * as evolutionRuntime from "./server/evolution-runtime.js";
import { PostgresProvider } from "./packages/core/src/db/providers/postgres.js";
import { authorityScopeFingerprint } from "./packages/core/src/domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "./packages/core/src/scoring/hash-utils.js";
import { MemoryWriteKernel, type MemoryWriteCommand } from "./packages/core/src/service/write-kernel.js";
import { createEvolutionRawEvidenceMaterializer } from "./packages/core/src/evolution/governed-evidence-materializer.js";
import type { PostgresEvolutionVerifiedInput } from "./packages/core/src/evolution/governed-writer.js";
import type { EvolutionValidation } from "./packages/core/src/evolution/types.js";

const selectors = { appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const authority = { tenantId: "tenant", userId: "user", workspaceId: "workspace", sessionId: "session", allow: {
  appIds: [selectors.appId], projectIds: [selectors.projectId], agentIds: [selectors.agentId],
  namespaces: [selectors.namespace], visibilities: [selectors.visibility],
} };
const scope = { ...selectors, tenantId: authority.tenantId, userId: authority.userId,
  workspaceId: authority.workspaceId, sessionId: authority.sessionId };
const config = memoryConfigSchema.parse({ embedding: { apiKey: "synthetic", baseURL: "http://127.0.0.1:9/v1" },
  dbType: "postgres", postgres: { host: "unused", port: 5432, database: "unused", user: "unused", password: "unused" },
  features: { continuousMemoryEvolution: true } });

function verifiedInput(): PostgresEvolutionVerifiedInput {
  const text = "Synthetic source requiring owner review.";
  const hash = computeCanonicalContentHash(text), scopeFingerprint = authorityScopeFingerprint(scope);
  const evidence = { id: "source-evidence", sourceId: "source", revision: "1", snapshotHash: hash, text, scope,
    rootEvidenceId: "root", origin: "external" as const, trust: "untrusted" as const };
  const { text: _text, ...ref } = evidence;
  const supportedEvidence = [{ ...ref, quote: text, start: 0, end: text.length }];
  const validation: EvolutionValidation = { outcome: "review", reasons: ["source_authority_unverified"],
    independentEvidenceRootIds: [], contextEligible: false, reviewRequirement: "owner" };
  return { evidence: [evidence], targets: [], validation, supportedEvidence, canonicalEvidenceIds: [], context: {
    authority, evidence: supportedEvidence,
    proposal: { id: "proposal", batchId: "batch", scope, scopeFingerprint, operation: "create", claimClass: "fact",
      reasonCode: "new_claim", targetRefs: [], proposedText: text, kind: "fact",
      quotes: [{ evidenceId: evidence.id, quote: text, start: 0, end: text.length }], inputUnitId: "unit",
      inputFingerprint: hash, sourceSnapshotHash: hash, configFingerprint: hash, policyVersion: "v1",
      validation, status: "review", createdAt: 1000 },
    lease: { batchId: "batch", scopeFingerprint, ownerId: "owner", fencingToken: 1, expiresAt: 50000 },
    verifySource: vi.fn(async () => ({ valid: true })),
  } };
}

function command(route: "raw" | "canonical", clientScope: unknown = selectors): MemoryWriteCommand {
  const common = { idempotencyKey: `scope-${route}`, serverAuthority: authority, clientScope,
    text: "Synthetic scope regression.", kind: "fact" as const };
  return route === "raw" ? { ...common, type: "importEvidence", sourceId: "synthetic-source" }
    : { ...common, type: "saveExplicit" };
}

// Real Runtime/provider factories and kernel; only the SQL boundary is replaced, with no runtime.start().
function fixture() {
  const factory = vi.spyOn(evolutionRuntime, "createEvolutionRuntime");
  const provider = new PostgresProvider(config.postgres!, "text-embedding-3-small");
  const query = vi.fn(async (sql: string) => {
    if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) && !sql.includes("pg_advisory_xact_lock") &&
        !sql.includes("FROM mengshu_write_receipts") && !sql.includes("FROM mengshu_candidate_write_receipts")) {
      throw new Error("UNEXPECTED_FIXTURE_SQL");
    }
    return { rows: [], rowCount: 0 };
  });
  Object.assign(provider, { pool: { query, connect: async () => ({ query, release: vi.fn() }) },
    schemaVersion: 37, schemaContractState: "ready" });
  vi.spyOn(provider, "initialize").mockResolvedValue();
  const runtime = createMengshuRuntime({ config, resolvedDbPath: "/unused", defaultScope: scope, db: provider,
    continuousMemoryEvolutionHost: { authority, config }, runtimeCostLedger: { append: vi.fn(), query: vi.fn(async () => []) } });
  expect(factory).toHaveBeenCalledOnce();
  expect(runtime.continuousMemoryEvolution?.run).toBeTypeOf("function");
  expect(query).not.toHaveBeenCalled();
  const dependencies = factory.mock.calls[0]![0].kernelDependencies;
  return { runtime, provider, query, dependencies };
}

afterEach(() => vi.restoreAllMocks());

describe.each(["raw", "canonical"] as const)("evolution %s Runtime authority composition", route => {
  function resolver() {
    const f = fixture(), deps = f.dependencies(route === "raw" ? undefined : verifiedInput());
    return { ...f, deps, resolve: (clientScope: unknown) => {
      const request = command(route, clientScope);
      return deps.resolveAuthority({ serverAuthority: request.serverAuthority, clientScope, command: request });
    } };
  }

  test("resolves five selectors to the complete host-owned scope", async () => {
    const f = resolver();
    expect(await f.resolve(selectors)).toEqual(scope);
    expect(f.query).not.toHaveBeenCalled();
  });

  test.each(["tenantId", "userId", "workspaceId", "sessionId"] as const)("rejects client identity field %s even when it matches the host", async field => {
    const f = resolver();
    await expect(Promise.resolve().then(() => f.resolve({ ...selectors, [field]: authority[field] })))
      .rejects.toMatchObject({ code: "CLIENT_FIELD_FORBIDDEN", field });
    expect(f.query).not.toHaveBeenCalled();
  });

  test.each(["appId", "projectId", "agentId", "namespace", "visibility"] as const)("rejects a selector outside the host %s allowlist", async field => {
    const f = resolver();
    await expect(Promise.resolve().then(() => f.resolve({ ...selectors, [field]: field === "visibility" ? "public" : "outside" })))
      .rejects.toMatchObject({ code: "CLIENT_VALUE_NOT_ALLOWED", field });
    expect(f.query).not.toHaveBeenCalled();
  });

  test("still reaches the native embedding guard before any model call", async () => {
    const f = resolver();
    const normalize = vi.fn(f.deps.normalize), embed = vi.fn(f.deps.embed);
    const port = f.provider.createMemoryWriteKernelTransactionPort();
    const kernel = new MemoryWriteKernel({ ...f.deps, normalize, embed, transaction: work => port.transaction(work) });
    const blocked = f.runtime.embeddingWriteGuard.snapshot().decision;
    expect(blocked.allowed).toBe(false);
    const execution = route === "raw" ? createEvolutionRawEvidenceMaterializer(kernel)(verifiedInput())
      : kernel.execute(command(route));
    await expect(execution).rejects.toMatchObject({ name: "EmbeddingWriteBlockedError" });
    expect(normalize).toHaveBeenCalledWith(expect.objectContaining({ scope }));
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("ordinary Runtime legacy scope gate", () => {
  test("still requires full client scope when evolution is enabled", async () => {
    const f = fixture();
    await expect(f.runtime.memoryWriteKernel!.execute(command("raw"))).rejects.toThrow("runtime write scope tenantId is required");
    expect(f.query).not.toHaveBeenCalled();
  });

  test.each(["tenantId", "userId", "workspaceId", "sessionId"] as const)("still rejects a mismatched legacy %s", async field => {
    const f = fixture();
    await expect(f.runtime.memoryWriteKernel!.execute(command("raw", { ...scope, [field]: "outside" })))
      .rejects.toThrow("runtime write authority does not own the requested scope");
    expect(f.query).not.toHaveBeenCalled();
  });

  test("still accepts matching full scope without bypassing the embedding guard", async () => {
    const f = fixture();
    await expect(f.runtime.memoryWriteKernel!.execute(command("raw", scope)))
      .rejects.toMatchObject({ name: "EmbeddingWriteBlockedError" });
    expect(f.query).toHaveBeenCalled();
  });
});
