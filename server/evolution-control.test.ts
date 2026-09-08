import { generateKeyPairSync, sign } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "../config.js";
import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import { authority, scope, unit } from "../packages/core/src/evolution/test-fixtures.js";
import { DEFAULT_EVOLUTION_LIMITS } from "../packages/core/src/evolution/schema.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { withAuthenticatedEvolutionOwner } from "../packages/api/src/evolution-owner-auth.js";
import { evolutionAttestationSigningPayload, type EvolutionAttestationStatement } from "./evolution-attestation.js";
import { loadGlobalEvolutionConfig } from "./evolution-config.js";
import { createEvolutionHostControl, assertEvolutionHostControlOwner } from "./evolution-control.js";

function fixture() {
  const provider = new PostgresProvider({ host: "unused", database: "unused", user: "unused", password: "unused", port: 5432 }, "text-embedding-3-small");
  const states = new Map<string, Record<string, unknown>>(), receipts = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    const rows = [...states.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const priorReceipts = [...receipts.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    if (sql.includes("evolution:host-state-lock")) return { rows: rows.filter(row => row.kind === p[2] && row.entry_id === p[3]) };
    if (sql.includes("evolution:host-state-read")) {
      const keys = JSON.parse(String(p[2])) as Array<{ kind: string; entry_id: string }>;
      return { rows: rows.filter(row => keys.some(key => key.kind === row.kind && key.entry_id === row.entry_id)) };
    }
    if (sql.includes("evolution:host-state-quota")) return { rows: [{ entries: rows.length, receipts: priorReceipts.length }] };
    if (sql.includes("evolution:host-receipt-key")) return { rows: priorReceipts.filter(row => row.kind === p[2] && row.idempotency_key === p[3]) };
    if (sql.includes("evolution:host-state-save")) {
      states.set(JSON.stringify(p.slice(0, 4)), { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], entry_id: p[3], revision: p[4], value: JSON.parse(String(p[5])), value_hash: p[6], updated_at: p[7], expires_at: p[8], revoked_at: p[9] });
      return { rows: [{ revision: p[4] }] };
    }
    if (sql.includes("evolution:host-receipt-save")) receipts.set(JSON.stringify(p.slice(0, 4)), { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], idempotency_key: p[3], request_hash: p[4], receipt_id: p[5], receipt: JSON.parse(String(p[6])) });
    return { rows: [] };
  });
  Object.assign(provider, { pool: { query, connect: async () => ({ query, release: vi.fn() }) }, schemaVersion: 37, schemaContractState: "ready" });
  vi.spyOn(provider, "initialize").mockResolvedValue();
  const keys = generateKeyPairSync("ed25519");
  const config = loadGlobalEvolutionConfig({ authority, scope, hostConfig: memoryConfigSchema.parse({
    embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" }, features: { continuousMemoryEvolution: true },
    evolution: { attestation: { trustedIssuers: [{ id: "verifier", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() }] },
      reuse: { targetProfile: { model: { provider: "openai", modelId: "fixture-model", revision: "fixture-revision" },
        tools: [], environmentFingerprint: "b".repeat(64), applicability: ["synthetic:fact-selection-v1"] } } },
  }) });
  const control = createEvolutionHostControl({ persistence: provider.createEvolutionPersistence(scope), authority, scope, config });
  const bundle = provider.createDurableJobV2RuntimeBundle({ clock: Date.now, tokenFactory: () => "a".repeat(32), backoffMs: () => 10, enableMemoryEvolution: true });
  const input = unit(); input.evidence[0].trust = "untrusted";
  const e = input.evidence[0];
  const statement: EvolutionAttestationStatement = { issuer: "verifier", scopeFingerprint: authorityScopeFingerprint(scope),
    evidenceId: e.id, sourceId: e.sourceId, revision: e.revision, snapshotHash: e.snapshotHash, rootEvidenceId: e.rootEvidenceId,
    origin: "external", trust: "verified_document", authorizedTargetRefs: [], issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
  };
  const request = { statement, signature: sign(null, evolutionAttestationSigningPayload(statement), keys.privateKey).toString("base64url"), expectedRevision: 0, idempotencyKey: "signed-approval" };
  const owner = <T>(work: () => Promise<T>) => withAuthenticatedEvolutionOwner({ owner: authority, secret: "owner-only-fixture-credential-not-real", headers: { "x-mengshu-owner-token": "owner-only-fixture-credential-not-real" } }, work);
  return { control, config, bundle, provider, query, input, request, owner };
}
afterEach(() => vi.restoreAllMocks());

describe("native provider-bound host control composition", () => {
  test("target profile reads host state every time and a persistent revocation denies the next read", async () => {
    const f = fixture();
    const profile = f.config.config.evolution!.reuse!.targetProfile;
    expect(await f.control.readTarget(scope)).toEqual(profile);
    expect(await f.control.readTarget(scope)).toEqual(profile);
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("evolution:host-state-read"))).toHaveLength(2);
    await f.owner(() => f.control.state.put({ kind: "target_profile", id: "target", expectedRevision: 0,
      idempotencyKey: "target-revoke", operation: "revoke", value: { profile: JSON.parse(JSON.stringify(profile)) } }));
    expect(await f.control.readTarget(scope)).toBeUndefined();
    const before = f.query.mock.calls.length;
    expect(() => f.control.stateForScope({ ...scope, appId: "other" })).toThrow("REUSE_HOST_SCOPE_MISMATCH");
    expect(f.query.mock.calls).toHaveLength(before);
  });

  test("uses persistent signed attestations and revocation, not an injected verifier or a source trust label", async () => {
    const f = fixture();
    const context = { scope, input: { mode: "inventory" as const, selection: "baseline" as const }, limits: { ...DEFAULT_EVOLUTION_LIMITS, maxBytes: 10_000_000 }, unit: f.input };
    expect(f.query).not.toHaveBeenCalled();
    await expect(f.control.capability.issueSourceAttestation(f.request)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(f.query).not.toHaveBeenCalled();
    await f.owner(() => f.control.capability.issueSourceAttestation(f.request));
    const proofs = (await f.control.attestation.port.attest(context)).attestations;
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({ trust: "verified_document", rootEvidenceId: f.input.evidence[0].rootEvidenceId });
    await f.owner(() => f.control.capability.revokeSourceAttestation({ sourceId: f.request.statement.sourceId,
      sourceRevision: f.request.statement.revision, expectedRevision: 0, idempotencyKey: "revoke-attestation", operationIdempotencyKey: "reconcile-source", expiresAt: Date.now() + 60_000,
    }));
    await expect(f.control.attestation.port.verify(proofs, context)).resolves.toMatchObject({ valid: false });
    expect(f.query.mock.calls.some(([sql]) => sql.includes("evolution:host-state-save"))).toBe(true);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("evolution:job-fence"))).toBe(false);
  });

  test("the host control mint is exact-provider, exact-scope and frozen-config bound", () => {
    const f = fixture();
    expect(assertEvolutionHostControlOwner(f.control, f.bundle, scope, f.config.configFingerprint)).toBe(f.control);
    expect(() => assertEvolutionHostControlOwner({ ...f.control }, f.bundle, scope, f.config.configFingerprint)).toThrow();
    expect(() => assertEvolutionHostControlOwner(f.control, fixture().bundle, scope, f.config.configFingerprint)).toThrow();
    expect(() => assertEvolutionHostControlOwner(f.control, f.bundle, { ...scope, appId: "other" }, f.config.configFingerprint)).toThrow();
    expect(() => assertEvolutionHostControlOwner(f.control, f.bundle, scope, "changed-config")).toThrow();
  });
});
