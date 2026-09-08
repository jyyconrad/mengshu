import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { evolutionHash } from "./fingerprints.js";
import { EvolutionError } from "./schema.js";
import type { EvolutionEvidenceAttestation, EvolutionEvidenceAttestationPort, EvolutionInputContext, EvolutionInputPort, EvolutionInputUnit, EvolutionPage } from "./types.js";

/** Only an explicitly injected host verifier may upgrade trust; source parsers never call it. */
export class AttestedEvolutionInput implements EvolutionInputPort {
  readonly mode: EvolutionInputPort["mode"];
  private pending?: { original: EvolutionInputUnit; attested: EvolutionInputUnit; proofs: EvolutionEvidenceAttestation[]; budget: { records: number; bytes: number } };
  constructor(private readonly source: EvolutionInputPort, private readonly attester: EvolutionEvidenceAttestationPort, private readonly now: () => number = Date.now) { this.mode = source.mode; }
  open(context: EvolutionInputContext) { return this.source.open(context); }
  readTargets: EvolutionInputPort["readTargets"] = (refs, context) => this.source.readTargets(refs, context);
  acknowledge: NonNullable<EvolutionInputPort["acknowledge"]> = async context => { await this.source.acknowledge?.(context); };
  private assertProof(proof: EvolutionEvidenceAttestation, unit: EvolutionInputUnit, context: EvolutionInputContext): void {
    const e = unit.evidence.find(e => e.id === proof.evidenceId);
    if (!e || e.origin !== "external" || proof.scopeFingerprint !== authorityScopeFingerprint(context.scope) || authorityScopeFingerprint(e.scope) !== proof.scopeFingerprint || proof.sourceId !== e.sourceId || proof.revision !== e.revision || proof.snapshotHash !== e.snapshotHash || proof.snapshotHash !== computeCanonicalContentHash(e.text) || proof.rootEvidenceId !== e.rootEvidenceId || !proof.id || !proof.issuer || !["user_statement", "verified_document", "verified_result"].includes(proof.trust)) throw new EvolutionError("attestation_binding_mismatch");
    if (![proof.verifiedAt, proof.expiresAt].every(Number.isSafeInteger) || proof.verifiedAt > this.now() || proof.expiresAt <= this.now() || proof.expiresAt <= proof.verifiedAt) throw new EvolutionError("attestation_expired");
    if (proof.trust === "user_statement" && !proof.authorId) throw new EvolutionError("attestation_author_required");
    if (proof.authorizedTargetRefs.length > 8 || proof.authorizedTargetRefs.some(ref => !unit.targets.some(t => t.memoryId === ref.memoryId && t.expectedRevision === ref.expectedRevision && t.beforeHash === ref.beforeHash))) throw new EvolutionError("attestation_target_mismatch");
  }
  async readPage(context: Parameters<EvolutionInputPort["readPage"]>[0]): Promise<EvolutionPage> {
    const page = await this.source.readPage(context);
    this.pending = undefined;
    if (page.units.length !== 1) { if (page.units.length > 1) throw new EvolutionError("input_contract_invalid"); return page; }
    const original = structuredClone(page.units[0]);
    const records = page.recordsRead ?? original.targets.length + original.evidence.length;
    const limits = { ...context.limits, maxRecords: context.limits.maxRecords - records, maxBytes: context.limits.maxBytes - page.bytesRead };
    if (limits.maxRecords < 0 || limits.maxBytes < 0) throw new EvolutionError("attestation_budget_exceeded");
    const checked = await this.attester.attest({ ...context, limits, unit: structuredClone(original) });
    context.signal?.throwIfAborted();
    if (![checked.recordsRead, checked.bytesRead, checked.verificationBudget.records, checked.verificationBudget.bytes].every(n => Number.isSafeInteger(n) && n >= 0) || checked.recordsRead > limits.maxRecords || checked.bytesRead > limits.maxBytes || checked.attestations.length > original.evidence.length || Buffer.byteLength(JSON.stringify(checked.attestations)) > 32768 || new Set(checked.attestations.map(a => a.evidenceId)).size !== checked.attestations.length) throw new EvolutionError("attestation_budget_exceeded");
    const attested = structuredClone(original);
    for (const proof of checked.attestations) {
      this.assertProof(proof, original, context);
      const e = attested.evidence.find(e => e.id === proof.evidenceId)!;
      e.trust = proof.trust; e.hostAttestation = structuredClone(proof); e.authorizedTargetIds = proof.authorizedTargetRefs.map(t => t.memoryId);
      if (proof.occurredAt !== undefined) e.occurredAt = proof.occurredAt;
    }
    const before = original.verificationBudget ?? { records: original.evidence.length, files: 0, bytes: original.evidence.reduce((n, e) => n + Buffer.byteLength(e.text), 0) };
    attested.verificationBudget = { records: before.records + checked.verificationBudget.records, files: before.files, bytes: before.bytes + checked.verificationBudget.bytes };
    this.pending = { original, attested: structuredClone(attested), proofs: structuredClone(checked.attestations), budget: checked.verificationBudget };
    return { ...page, units: [attested], recordsRead: records + checked.recordsRead, bytesRead: page.bytesRead + checked.bytesRead };
  }
  async verifyUnit(unit: EvolutionInputUnit, context: EvolutionInputContext): ReturnType<EvolutionInputPort["verifyUnit"]> {
    const pending = this.pending;
    if (!pending || evolutionHash(pending.attested) !== evolutionHash(unit)) return { valid: false, reason: "attestation_snapshot_expired", bytesRead: 0 };
    for (const proof of pending.proofs) this.assertProof(proof, pending.original, context);
    const budget = pending.budget;
    if (budget.records > context.limits.maxRecords || budget.bytes > context.limits.maxBytes) throw new EvolutionError("attestation_budget_exceeded");
    const verified = await this.attester.verify(pending.proofs, { ...context, limits: { ...context.limits, maxRecords: budget.records, maxBytes: budget.bytes } });
    if (![verified.recordsRead, verified.bytesRead].every(n => Number.isSafeInteger(n) && n >= 0) || verified.recordsRead > budget.records || verified.bytesRead > budget.bytes) throw new EvolutionError("attestation_budget_exceeded");
    if (!verified.valid) return { valid: false, reason: verified.reason ?? "attestation_revoked", bytesRead: verified.bytesRead };
    const originalBudget = pending.original.verificationBudget ?? { records: pending.original.evidence.length, files: 0, bytes: pending.original.evidence.reduce((n, e) => n + Buffer.byteLength(e.text), 0) };
    const result = await this.source.verifyUnit(pending.original, { ...context, limits: { ...context.limits, maxRecords: originalBudget.records, maxFiles: originalBudget.files, maxBytes: originalBudget.bytes } });
    return { ...result, bytesRead: verified.bytesRead + (result.bytesRead ?? originalBudget.bytes) };
  }
}
