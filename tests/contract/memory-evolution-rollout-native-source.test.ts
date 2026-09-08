import { verify } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "../../config.js";
import { parseEvolutionSourceControl } from "../../packages/api/src/evolution-source-control.js";
import { authorityScopeFingerprint } from "../../packages/core/src/domain/authority-scope-fingerprint.js";
import { InMemoryEvolutionRepository } from "../../packages/core/src/evolution/in-memory-repository.js";
import { validateCandidateWithReceipt } from "../../packages/core/src/lifecycle/candidate-validator.js";
import { evolutionAttestationSigningPayload } from "../../server/evolution-attestation.js";
import { loadGlobalEvolutionConfig } from "../../server/evolution-config.js";
import { createNativeRolloutConfig } from "../fixtures/memory-evolution-rollout/native-runtime.js";
import { createSyntheticNativeIssuer, readUnsignedNativeSource, SYNTHETIC_ATTESTED_SOURCE } from "../fixtures/memory-evolution-rollout/native-attestation.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_SCOPE } from "../fixtures/memory-evolution-rollout/source-corpus.js";

afterEach(() => vi.unstubAllEnvs());
const base = () => memoryConfigSchema.parse({ embedding: { provider: "openai", apiKey: "synthetic-only", baseURL: "https://embedding.invalid/v1" } });

async function sourceFixture() {
  const root = await mkdtemp(join(tmpdir(), "mengshu-native-source-contract-"));
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(join(source, "claim.md"), `${SYNTHETIC_ATTESTED_SOURCE}\n`);
    vi.stubEnv("MENGSHU_HOME", join(root, "state"));
    const config = createNativeRolloutConfig(base(), undefined, source, "synthetic-owner-secret-is-not-a-credential");
    const resolved = loadGlobalEvolutionConfig({ hostConfig: config, authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE });
    // Repository transport is unused by this read-only offline construction, never a native runtime substitute.
    const repository = new InMemoryEvolutionRepository();
    const unit = await readUnsignedNativeSource(resolved, repository, join(root, "observer-one"));
    return { root, source, resolved, repository, unit, close: () => rm(root, { recursive: true, force: true }) };
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
}

describe("native synthetic source fixture construction, offline only and not a default-runtime E0 pass", () => {
  test("host config accepts only explicit public issuer keys and retains all nine scope coordinates", () => {
    const issuer = createSyntheticNativeIssuer();
    const original = base();
    original.evolution = { sources: [], attestation: { trustedIssuers: [issuer.trustedIssuer] } };
    const plain = createNativeRolloutConfig(original, undefined, "/synthetic-only/source", "synthetic-owner-secret-is-not-a-credential");
    expect(plain.evolution?.attestation).toBeUndefined();
    const configured = createNativeRolloutConfig(original, undefined, "/synthetic-only/source", "synthetic-owner-secret-is-not-a-credential",
      { trustedIssuers: [issuer.trustedIssuer] });
    expect(configured.evolution?.attestation?.trustedIssuers).toEqual([issuer.trustedIssuer]);
    expect(memoryConfigSchema.parse(configured)).toEqual(configured);
    expect(JSON.stringify(configured)).not.toContain("PRIVATE KEY");
    const resolved = loadGlobalEvolutionConfig({ hostConfig: configured, authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE });
    expect(resolved.sources[0].scope).toEqual(ROLLOUT_SCOPE);
    expect(Object.keys(resolved.sources[0].scope)).toHaveLength(9);
    expect(() => createNativeRolloutConfig(original, undefined, "/synthetic-only/source", "synthetic-owner-secret-is-not-a-credential",
      { trustedIssuers: [{ id: "synthetic-issuer", publicKeyPem: "not-a-public-key" }] })).toThrow();
  });
  test("two real independent scanners produce identical unsigned identities without acknowledging a manifest", async () => {
    const h = await sourceFixture();
    try {
      const again = await readUnsignedNativeSource(h.resolved, h.repository, join(h.root, "observer-two"));
      expect(again).toEqual(h.unit);
      expect(h.unit.evidence[0]).toMatchObject({ trust: "untrusted", origin: "external", text: SYNTHETIC_ATTESTED_SOURCE });
      expect(h.unit.evidence[0]).not.toHaveProperty("hostAttestation");
      await expect(access(join(h.root, "observer-one", "rollout-native-source", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(h.root, "observer-two", "rollout-native-source", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await h.close(); }
  });
  test("signed DTO binds the real source hash/revision/root/scope and refuses other material or fabricated trust", async () => {
    const h = await sourceFixture();
    try {
      const issuer = createSyntheticNativeIssuer();
      const request = issuer.signSource(h.unit);
      expect(parseEvolutionSourceControl("source/attest", request)).toEqual(request);
      expect(request.statement).toMatchObject({ scopeFingerprint: authorityScopeFingerprint(ROLLOUT_SCOPE), evidenceId: h.unit.evidence[0].id,
        revision: h.unit.evidence[0].revision, snapshotHash: h.unit.evidence[0].snapshotHash, rootEvidenceId: h.unit.evidence[0].rootEvidenceId,
        trust: "verified_document", authorizedTargetRefs: [] });
      expect(request.statement).not.toHaveProperty("authorId");
      expect(verify(null, evolutionAttestationSigningPayload(request.statement), issuer.trustedIssuer.publicKeyPem, Buffer.from(request.signature, "base64url"))).toBe(true);
      expect(verify(null, evolutionAttestationSigningPayload({ ...request.statement, revision: "different-revision" }), issuer.trustedIssuer.publicKeyPem, Buffer.from(request.signature, "base64url"))).toBe(false);
      expect(verify(null, evolutionAttestationSigningPayload(request.statement), createSyntheticNativeIssuer().trustedIssuer.publicKeyPem, Buffer.from(request.signature, "base64url"))).toBe(false);
      for (const mutation of [
        (unit: typeof h.unit) => { unit.evidence[0].text = "Other material must never be signed by this fixture."; },
        (unit: typeof h.unit) => { unit.evidence[0].trust = "verified_document"; },
        (unit: typeof h.unit) => { unit.evidence[0].scope.userId = "foreign-owner"; },
      ]) {
        const changed = structuredClone(h.unit); mutation(changed);
        expect(() => issuer.signSource(changed)).toThrow("only_fresh_synthetic_document");
      }
    } finally { await h.close(); }
  });
  test("the runbook is a resource candidate without a forged author or profile/rules promotion", () => {
    const checked = validateCandidateWithReceipt({ text: SYNTHETIC_ATTESTED_SOURCE, semanticType: "resource", salience: 0.5,
      temporality: "persistent", crossContextual: false, targetScope: "project", evidence: { quote: SYNTHETIC_ATTESTED_SOURCE, eventIds: ["synthetic-source"] } },
    { text: SYNTHETIC_ATTESTED_SOURCE, scope: "project", eventIds: ["synthetic-source"] });
    expect(checked.verdict).toMatchObject({ rejected: false, semanticType: "resource", evidenceOnly: false });
    // This validates fixture shape only. The live test requires the actual global proposer and real admission result.
  });
});
