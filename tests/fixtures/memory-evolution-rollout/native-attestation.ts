import { generateKeyPairSync, sign } from "node:crypto";
import { join } from "node:path";
import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { DirectoryEvolutionInput } from "../../../packages/core/src/evolution/directory-input.js";
import type { EvolutionInputUnit, EvolutionRepository } from "../../../packages/core/src/evolution/types.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { evolutionAttestationSigningPayload, type EvolutionAttestationStatement } from "../../../server/evolution-attestation.js";
import type { GlobalEvolutionConfig } from "../../../server/evolution-config.js";
import { ROLLOUT_SCOPE } from "./source-corpus.js";

export const SYNTHETIC_ATTESTED_SOURCE = "The synthetic acceptance runbook documents disposable PostgreSQL schemas, bounded verification checks, and cleanup after each isolated run.";
export const NATIVE_ATTESTED_LIMITS = Object.freeze({ maxRecords: 100, maxFiles: 5, maxBytes: 1_000_000,
  maxLlmCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1000, maxDurationMs: 45_000 });

/** Independent read-only scanner, not a replacement for the default runtime's source input. */
export async function readUnsignedNativeSource(config: GlobalEvolutionConfig, repository: EvolutionRepository, manifestRoot: string): Promise<EvolutionInputUnit> {
  if (config.sources.length !== 1) throw new Error("single_synthetic_source_required");
  const input = new DirectoryEvolutionInput({ sources: config.sources.map(binding => ({ binding,
    manifestPath: join(manifestRoot, binding.sourceId, "manifest.json") })), repository, configFingerprint: config.configFingerprint });
  const context = { scope: ROLLOUT_SCOPE, input: { mode: "directory" as const, sourceId: config.sources[0].sourceId }, limits: NATIVE_ATTESTED_LIMITS };
  try {
    const snapshot = await input.open(context);
    const page = await input.readPage({ ...context, snapshot, cursor: null, limit: 1 });
    if (!page.complete || page.reasons?.length || page.units.length !== 1 || page.units[0].evidence.length !== 1) {
      throw new Error("single_complete_synthetic_unit_required");
    }
    if (!(await input.verifyUnit(page.units[0], context)).valid) throw new Error("synthetic_source_changed");
    return page.units[0];
  } finally { await input.close(); }
}

/** Ephemeral test-host key, restricted to the one fresh synthetic document; never an historical author assertion. */
export function createSyntheticNativeIssuer() {
  const keys = generateKeyPairSync("ed25519");
  const trustedIssuer = { id: "synthetic-acceptance-host", publicKeyPem: keys.publicKey.export({ format: "pem", type: "spki" }).toString() };
  return { trustedIssuer, signSource(unit: EvolutionInputUnit) {
    const evidence = unit.evidence[0];
    const fingerprint = authorityScopeFingerprint(ROLLOUT_SCOPE);
    if (unit.evidence.length !== 1 || unit.targets.length !== 0 || authorityScopeFingerprint(unit.scope) !== fingerprint ||
        !evidence || authorityScopeFingerprint(evidence.scope) !== fingerprint || evidence.sourceId !== "rollout-native-source" ||
        evidence.text !== SYNTHETIC_ATTESTED_SOURCE || evidence.snapshotHash !== computeCanonicalContentHash(evidence.text) ||
        evidence.origin !== "external" || evidence.trust !== "untrusted" || evidence.revoked || evidence.hostAttestation) {
      throw new Error("only_fresh_synthetic_document_may_be_attested");
    }
    const statement: EvolutionAttestationStatement = { issuer: trustedIssuer.id, scopeFingerprint: fingerprint,
      evidenceId: evidence.id, sourceId: evidence.sourceId, revision: evidence.revision, snapshotHash: evidence.snapshotHash,
      rootEvidenceId: evidence.rootEvidenceId, origin: "external", trust: "verified_document", authorizedTargetRefs: [],
      issuedAt: Date.now() - 1000, expiresAt: Date.now() + 300_000 };
    return { statement, signature: sign(null, evolutionAttestationSigningPayload(statement), keys.privateKey).toString("base64url"),
      expectedRevision: 0, idempotencyKey: "synthetic-signed-document" };
  } };
}
