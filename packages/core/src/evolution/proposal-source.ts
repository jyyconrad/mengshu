import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { evolutionHash } from "./fingerprints.js";
import { assertEvolutionCheckpoint, EvolutionError } from "./schema.js";
import type { EvolutionCursor, EvolutionInputContext, EvolutionInputPort, EvolutionProposal, EvolutionProposalSourcePort } from "./types.js";

/** Bounded fallback for existing adapters; providers may supply indexed exact-source reads. */
export class BoundedEvolutionProposalSource implements EvolutionProposalSourcePort {
  constructor(private readonly inputs: readonly EvolutionInputPort[], private readonly now: () => number = Date.now) {}
  async read(proposal: EvolutionProposal, context: EvolutionInputContext): ReturnType<EvolutionProposalSourcePort["read"]> {
    const input = this.inputs.find(p => p.mode === context.input.mode);
    if (!input) throw new EvolutionError("input_capability_unavailable");
    if (proposal.scopeFingerprint !== authorityScopeFingerprint(context.scope)) throw new EvolutionError("scope_mismatch");
    if (input.readProposal) return input.readProposal(proposal, context);
    const start = this.now();
    const usage = { recordsRead: 0, filesRead: 0, bytesRead: 0 };
    const position = context.input.mode === "inventory" && context.input.selection === "baseline" ? proposal.inputPosition : undefined;
    if (position) assertEvolutionCheckpoint(position);
    const snapshot = position?.snapshot ?? await input.open(context);
    assertEvolutionCheckpoint(snapshot);
    let cursor: EvolutionCursor = position?.cursor ?? null;
    for (let pageNo = 0; pageNo < context.limits.maxRecords + context.limits.maxFiles + 1; pageNo++) {
      context.signal?.throwIfAborted();
      const limits = { ...context.limits, maxRecords: context.limits.maxRecords - usage.recordsRead, maxBytes: context.limits.maxBytes - usage.bytesRead, maxFiles: context.limits.maxFiles - usage.filesRead, maxDurationMs: context.limits.maxDurationMs - (this.now() - start) };
      if (limits.maxRecords <= 0 || limits.maxBytes <= 0 || limits.maxDurationMs <= 0) throw new EvolutionError("review_source_budget_exceeded");
      const page = await input.readPage({ ...context, limits, snapshot, cursor, limit: 1 });
      assertEvolutionCheckpoint(page.nextCursor);
      const returned = page.units.reduce((n, u) => n + u.targets.length + u.evidence.length, 0);
      const records = page.recordsRead ?? returned;
      if (page.units.length > 1 || ![records, page.bytesRead, page.filesRead].every(n => Number.isSafeInteger(n) && n >= 0) || records < returned || records > limits.maxRecords || page.bytesRead > limits.maxBytes || page.filesRead > limits.maxFiles) throw new EvolutionError("review_source_budget_exceeded");
      usage.recordsRead += records; usage.filesRead += page.filesRead; usage.bytesRead += page.bytesRead;
      const unit = page.units.find(u => u.id === proposal.inputUnitId);
      if (unit) return { ...usage, unit, checkpoint: { snapshot, cursor: page.nextCursor } };
      if (page.reasons?.length) throw new EvolutionError("review_source_gap");
      if (page.complete) return usage;
      if (evolutionHash(cursor) === evolutionHash(page.nextCursor)) throw new EvolutionError("input_gap");
      cursor = page.nextCursor;
    }
    throw new EvolutionError("review_source_budget_exceeded");
  }
}
