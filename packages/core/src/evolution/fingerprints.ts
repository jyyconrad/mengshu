import { createHash } from "node:crypto";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { EvolutionInputUnit } from "./types.js";

export function evolutionHash(value: unknown): string {
  const canonical = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonical);
    if (input !== null && typeof input === "object") return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
    return input;
  };
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export function evolutionInputFingerprint(unit: EvolutionInputUnit, configFingerprint: string, policyVersion: string): string {
  return evolutionHash({
    contract: "evolution-input-v1", scope: authorityScopeFingerprint(unit.scope), configFingerprint, policyVersion,
    targets: unit.targets.map(t => [t.memoryId, t.expectedRevision, t.beforeHash, [...t.evidenceRootIds].sort(), !!t.tombstoned, !!t.pinned, !!t.highImpact, t.validFrom, t.validTo]).sort(),
    // Paths and wrappers are not independent evidence. Revisions still invalidate stale proposals.
    evidence: unit.evidence.map(e => [e.rootEvidenceId, e.revision, e.snapshotHash, e.origin, e.trust, !!e.revoked, e.occurredAt, [...e.authorizedTargetIds ?? []].sort(), ...(e.contextIncomplete ? ["context_incomplete"] : []), ...(e.hostAttestation ? [evolutionHash(e.hostAttestation)] : [])]).sort(),
  });
}
