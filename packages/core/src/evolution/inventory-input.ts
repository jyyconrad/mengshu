import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { assertEvolutionCheckpoint, EvolutionError } from "./schema.js";
import type { EvolutionAction, EvolutionCursor, EvolutionInputContext, EvolutionInputPort, EvolutionInputSnapshot, EvolutionInputUnit, EvolutionInventoryReadPort, EvolutionKey, EvolutionPage, EvolutionTargetRef } from "./types.js";

function key(value: EvolutionCursor): EvolutionKey | undefined {
  if (value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) || typeof value.createdAt !== "number" || !Number.isSafeInteger(value.createdAt) || typeof value.memoryId !== "string" || Object.keys(value).some(k => k !== "createdAt" && k !== "memoryId")) throw new EvolutionError("inventory_cursor_invalid");
  return { createdAt: value.createdAt, memoryId: value.memoryId };
}
export function compareEvolutionKeys(a: EvolutionKey, b: EvolutionKey): number {
  return a.createdAt - b.createdAt || (a.memoryId < b.memoryId ? -1 : a.memoryId > b.memoryId ? 1 : 0);
}
export class InventoryEvolutionInput implements EvolutionInputPort {
  readonly mode = "inventory" as const;
  readonly readProposal?: EvolutionInputPort["readProposal"];
  constructor(private readonly repository: EvolutionInventoryReadPort) {
    if (repository.readProposalUnit) this.readProposal = (proposal, context) => repository.readProposalUnit!(proposal, context);
  }
  async open(context: EvolutionInputContext): Promise<EvolutionInputSnapshot> {
    if (context.input.mode !== this.mode) throw new EvolutionError("input_mode_invalid");
    context.signal?.throwIfAborted();
    try {
      return await this.repository.freeze(context.scope, context.input.selection, context.limits.maxRecords);
    } catch (error) {
      const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
      if (code === "CHANGED_INVENTORY_UNAVAILABLE") throw new EvolutionError("inventory_changed_unsupported");
      if (code === "DUE_INVENTORY_UNAVAILABLE") throw new EvolutionError("inventory_due_unsupported");
      throw error;
    }
  }
  async readPage(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; limit: number }): Promise<EvolutionPage> {
    context.signal?.throwIfAborted();
    if (context.input.mode !== "inventory") throw new EvolutionError("input_mode_invalid");
    if (context.input.selection !== "baseline") {
      if (!this.repository.readSelectedPage) throw new EvolutionError(`inventory_${context.input.selection}_unsupported`);
      assertEvolutionCheckpoint(context.cursor);
      const page = await this.repository.readSelectedPage(context.scope, context.snapshot, context.cursor, Math.min(context.limit, context.limits.maxRecords), { maxRecords: context.limits.maxRecords, maxBytes: context.limits.maxBytes });
      assertEvolutionCheckpoint(page.nextCursor);
      for (const unit of page.units) {
        if (authorityScopeFingerprint(unit.scope) !== authorityScopeFingerprint(context.scope)) throw new EvolutionError("scope_mismatch");
        const event = unit.selectionEvent;
        if (!event || !event.eventId || event.eventId.length > 256 || !["external", "evolution", "access"].includes(event.origin)) throw new EvolutionError("inventory_event_required");
        if (!unit.targets.some(t => t.memoryId === event.memoryId && t.expectedRevision === event.revision)) throw new EvolutionError("inventory_event_revision_changed");
      }
      const recordsRead = page.recordsRead ?? page.units.reduce((n, u) => n + u.targets.length + u.evidence.length, 0);
      return { ...page, recordsRead, units: page.units.filter(u => u.selectionEvent!.origin === "external") };
    }
    const after = key(context.cursor);
    const page = await this.repository.readPage(context.scope, context.snapshot, after, Math.min(context.limit, context.limits.maxRecords), { maxRecords: context.limits.maxRecords, maxBytes: context.limits.maxBytes });
    let previous = after;
    for (const unit of page.units) {
      const target = unit.targets[0];
      if (!target) throw new EvolutionError("inventory_target_missing");
      const current = { memoryId: target.memoryId, createdAt: target.createdAt };
      if (previous && compareEvolutionKeys(current, previous) <= 0 || context.snapshot.upperKey && compareEvolutionKeys(current, context.snapshot.upperKey) > 0) throw new EvolutionError("inventory_keyset_violation");
      if (authorityScopeFingerprint(unit.scope) !== authorityScopeFingerprint(context.scope)) throw new EvolutionError("scope_mismatch");
      previous = current;
    }
    return { units: page.units, complete: page.complete, nextCursor: previous ? { ...previous } : null, bytesRead: page.bytesRead ?? page.units.reduce((sum, u) => sum + u.evidence.reduce((n, e) => n + Buffer.byteLength(e.text), 0) + u.targets.reduce((n, t) => n + Buffer.byteLength(t.text), 0), 0), filesRead: 0, ...(page.recordsRead === undefined ? {} : { recordsRead: page.recordsRead }) };
  }
  async verifyUnit(unit: EvolutionInputUnit, context: EvolutionInputContext): Promise<{ valid: boolean; reason?: string }> {
    context.signal?.throwIfAborted();
    return this.repository.verifyEvidence(context.scope, unit.evidence);
  }
  async readTargets(refs: EvolutionTargetRef[], context: EvolutionInputContext) {
    context.signal?.throwIfAborted();
    return this.repository.readTargets(context.scope, refs);
  }
  async acknowledge(context: EvolutionInputContext & { snapshot: EvolutionInputSnapshot; cursor: EvolutionCursor; action?: EvolutionAction; proposalId?: string }): Promise<void> {
    if (context.input.mode !== "inventory" || context.input.selection === "baseline" || !context.action || context.action === "preview" || !context.proposalId) return;
    if (!this.repository.acknowledgeSelection) throw new EvolutionError(`inventory_${context.input.selection}_acknowledge_unsupported`);
    await this.repository.acknowledgeSelection(context.scope, context.snapshot, context.cursor, context.action, { proposalId: context.proposalId });
  }
}
