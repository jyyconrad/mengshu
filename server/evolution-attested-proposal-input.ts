import { AttestedEvolutionInput } from "../packages/core/src/evolution/attested-input.js";
import { EvolutionError } from "../packages/core/src/evolution/schema.js";
import type { EvolutionEvidenceAttestationPort, EvolutionInputContext, EvolutionInputPort, EvolutionPage, EvolutionProposal } from "../packages/core/src/evolution/types.js";

/** Attest an exact provider read through the same core verifier, without replacing its persisted locator. */
export class EvolutionAttestedProposalInput implements EvolutionInputPort {
  readonly mode: EvolutionInputPort["mode"];
  private readonly attested: AttestedEvolutionInput;
  private exact?: EvolutionPage;

  constructor(private readonly source: EvolutionInputPort, attester: EvolutionEvidenceAttestationPort) {
    this.mode = source.mode;
    this.attested = new AttestedEvolutionInput({
      mode: source.mode, open: context => source.open(context),
      readPage: context => {
        const exact = this.exact; this.exact = undefined;
        return exact ? Promise.resolve(exact) : source.readPage(context);
      },
      verifyUnit: (unit, context) => source.verifyUnit(unit, context),
      readTargets: (refs, context) => source.readTargets(refs, context),
      acknowledge: context => source.acknowledge?.(context) ?? Promise.resolve(),
    }, attester);
  }
  open: EvolutionInputPort["open"] = context => this.attested.open(context);
  readPage: EvolutionInputPort["readPage"] = context => this.attested.readPage(context);
  readTargets: EvolutionInputPort["readTargets"] = (refs, context) => this.attested.readTargets(refs, context);
  verifyUnit: EvolutionInputPort["verifyUnit"] = (unit, context) => this.attested.verifyUnit(unit, context);
  acknowledge: NonNullable<EvolutionInputPort["acknowledge"]> = context => this.attested.acknowledge(context);

  async readProposal(proposal: EvolutionProposal, context: EvolutionInputContext) {
    if (!this.source.readProposal) throw new EvolutionError("review_source_reader_unavailable");
    context.signal?.throwIfAborted();
    const read = await this.source.readProposal(proposal, context);
    if (!read.unit) return read;
    this.exact = { units: [read.unit], bytesRead: read.bytesRead, filesRead: read.filesRead,
      recordsRead: read.recordsRead, complete: true, nextCursor: read.checkpoint?.cursor ?? null };
    try {
      const page = await this.attested.readPage({ ...context, snapshot: read.checkpoint?.snapshot ?? { selectionEpoch: 0 }, cursor: null, limit: 1 });
      return { ...read, unit: page.units[0], recordsRead: page.recordsRead!, bytesRead: page.bytesRead };
    } finally { this.exact = undefined; }
  }
}
