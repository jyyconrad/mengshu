import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import type { EvolutionEvidence } from "../../../packages/core/src/evolution/types.js";
import { computeCanonicalContentHash } from "../../../packages/core/src/scoring/hash-utils.js";

/** Synthetic host grant only; native user/MCP channel metadata never authorizes this fixture. */
export function testHostEvidenceAttestation(
  grant: Pick<EvolutionEvidence, "id" | "sourceId" | "revision" | "snapshotHash" | "scope">,
): (sources: readonly EvolutionEvidence[]) => EvolutionEvidence[] {
  const fixed = structuredClone(grant);
  const fingerprint = authorityScopeFingerprint(fixed.scope);
  const root = `test-host-attestation:${computeCanonicalContentHash(JSON.stringify(fixed))}`;
  return (sources) => {
    const source = sources[0];
    if (sources.length !== 1 || !source || source.id !== fixed.id || source.sourceId !== fixed.sourceId ||
        source.revision !== fixed.revision || source.snapshotHash !== fixed.snapshotHash ||
        computeCanonicalContentHash(source.text) !== fixed.snapshotHash || source.revoked ||
        authorityScopeFingerprint(source.scope) !== fingerprint || source.origin !== "external" || source.trust !== "untrusted") {
      throw new Error("Test host attestation requires the exact untrusted source revision and scope");
    }
    return [{ ...structuredClone(source), trust: "verified_document", rootEvidenceId: root }];
  };
}
