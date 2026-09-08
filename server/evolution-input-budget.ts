import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { EvolutionError } from "../packages/core/src/evolution/schema.js";
import type { EvolutionApplyContext, EvolutionInputContext, EvolutionInputPort, EvolutionInputUnit } from "../packages/core/src/evolution/types.js";
import type { PostgresEvolutionQueryClient } from "../packages/core/src/evolution/postgres-common.js";
import type { EvolutionAttestationService } from "./evolution-attestation.js";

/** Core persists this upper bound before writer entry. Its byte refund must retain the in-transaction portion. */
export class EvolutionInputBudget implements EvolutionInputPort {
  readonly mode: EvolutionInputPort["mode"];
  readonly readProposal?: EvolutionInputPort["readProposal"];
  private pending?: { original: EvolutionInputUnit; reserved: EvolutionInputUnit; cost: { records: number; bytes: number } };
  private verified?: EvolutionInputContext;

  constructor(private readonly source: EvolutionInputPort, private readonly attestation: EvolutionAttestationService) {
    this.mode = source.mode;
    if (source.readProposal) this.readProposal = async (proposal, context) => {
      this.clear();
      const read = await source.readProposal!(proposal, context);
      return { ...read, ...(read.unit ? { unit: this.reserve(read.unit) } : {}) };
    };
  }
  open(context: EvolutionInputContext) { this.clear(); return this.source.open(context); }
  readTargets: EvolutionInputPort["readTargets"] = (refs, context) => this.source.readTargets(refs, context);
  acknowledge: NonNullable<EvolutionInputPort["acknowledge"]> = async context => { await this.source.acknowledge?.(context); };
  private clear() { this.pending = undefined; this.verified = undefined; }
  private base(unit: EvolutionInputUnit) {
    return unit.verificationBudget ?? { records: unit.evidence.length, files: 0,
      bytes: unit.evidence.reduce((sum, evidence) => sum + Buffer.byteLength(evidence.text), 0) };
  }
  private reserve(unit: EvolutionInputUnit): EvolutionInputUnit {
    const original = structuredClone(unit), reserved = structuredClone(unit);
    const cost = this.attestation.transactionBudget(unit.evidence.flatMap(evidence => evidence.hostAttestation ? [evidence.hostAttestation] : []));
    const base = this.base(original);
    if (![base.records, base.files, base.bytes, cost.records, cost.bytes].every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new EvolutionError("attestation_budget_exceeded");
    }
    reserved.verificationBudget = { records: base.records + cost.records, files: base.files, bytes: base.bytes + cost.bytes };
    this.pending = { original, reserved: structuredClone(reserved), cost };
    return reserved;
  }
  async readPage(context: Parameters<EvolutionInputPort["readPage"]>[0]) {
    this.clear();
    const page = await this.source.readPage(context);
    if (page.units.length > 1) throw new EvolutionError("input_contract_invalid");
    return { ...page, units: page.units.map(unit => this.reserve(unit)) };
  }
  async verifyUnit(unit: EvolutionInputUnit, context: EvolutionInputContext) {
    this.verified = undefined;
    const pending = this.pending;
    if (!pending || evolutionHash(pending.reserved) !== evolutionHash(unit)) return { valid: false, reason: "attestation_snapshot_expired", bytesRead: 0 };
    const base = this.base(pending.original), cost = pending.cost;
    if (base.records + cost.records > context.limits.maxRecords || base.bytes + cost.bytes > context.limits.maxBytes || base.files > context.limits.maxFiles) {
      throw new EvolutionError("attestation_budget_exceeded");
    }
    const checked = await this.source.verifyUnit(pending.original, { ...context,
      limits: { ...context.limits, maxRecords: base.records, maxFiles: base.files, maxBytes: base.bytes } });
    const bytes = checked.bytesRead ?? base.bytes;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > base.bytes) throw new EvolutionError("verification_budget_exceeded");
    if (checked.valid) this.verified = { ...context, input: structuredClone(context.input), scope: structuredClone(context.scope),
      limits: { ...context.limits, maxRecords: cost.records, maxFiles: 0, maxBytes: cost.bytes } };
    return { ...checked, bytesRead: bytes + cost.bytes };
  }
  async assertApplyInTransaction(client: PostgresEvolutionQueryClient, apply: EvolutionApplyContext): Promise<void> {
    const context = this.verified;
    const matches = this.hasVerifiedApply(apply);
    this.verified = undefined;
    if (!context || !matches) throw new EvolutionError("attestation_transaction_budget_exhausted");
    apply.signal?.throwIfAborted();
    context.signal?.throwIfAborted();
    const cost = this.attestation.transactionBudgetForEvidence(apply.evidence);
    if (cost.records > context.limits.maxRecords || cost.bytes > context.limits.maxBytes) throw new EvolutionError("attestation_budget_exceeded");
    const read = await this.attestation.assertApplyInTransaction(client, apply, { ...context, signal: apply.signal ?? context.signal });
    if (![read.recordsRead, read.bytesRead].every(value => Number.isSafeInteger(value) && value >= 0) ||
        read.recordsRead > context.limits.maxRecords || read.bytesRead > context.limits.maxBytes) throw new EvolutionError("attestation_budget_exceeded");
  }
  hasVerifiedApply(apply: EvolutionApplyContext): boolean {
    return !!this.verified && !!this.pending && evolutionHash(this.verified.scope) === evolutionHash(apply.proposal.scope) &&
      this.pending.original.id === apply.proposal.inputUnitId && this.pending.original.snapshotHash === apply.proposal.sourceSnapshotHash;
  }
}
