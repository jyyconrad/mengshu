import { describe, expect, it, vi } from "vitest";
import { BoundedEvolutionProposalSource } from "./proposal-source.js";
import { DEFAULT_EVOLUTION_LIMITS } from "./schema.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { draft, inputPort, scope, unit } from "./test-fixtures.js";
import type { EvolutionProposal } from "./types.js";

describe("bounded current proposal source", () => {
  const wanted = unit("wanted");
  const proposal: EvolutionProposal = { ...draft(wanted), id: "proposal", batchId: "batch", scope, scopeFingerprint: authorityScopeFingerprint(scope), inputUnitId: wanted.id, inputFingerprint: "fp", sourceSnapshotHash: wanted.snapshotHash, configFingerprint: "config", policyVersion: "policy", validation: { outcome: "review", reasons: [], reviewRequirement: "owner", contextEligible: false, independentEvidenceRootIds: [] }, status: "review", createdAt: 1 };
  const context = { input: { mode: "inventory" as const, selection: "baseline" as const }, scope, limits: DEFAULT_EVOLUTION_LIMITS };
  it("finds the exact current unit with charged bounded reads instead of rebuilding from stored quotes", async () => {
    const input = inputPort([unit("other"), wanted]);
    const source = new BoundedEvolutionProposalSource([input]);
    expect(await source.read(proposal, context)).toMatchObject({ unit: wanted, recordsRead: 2, bytesRead: expect.any(Number) });
  });
  it("stops on budget and stagnant cursors", async () => {
    const input = inputPort([unit("other"), wanted]);
    const source = new BoundedEvolutionProposalSource([input]);
    await expect(source.read(proposal, { ...context, limits: { ...DEFAULT_EVOLUTION_LIMITS, maxRecords: 1 } })).rejects.toThrow("review_source_budget_exceeded");
    input.readPage = vi.fn(async () => ({ units: [], nextCursor: null, complete: false, bytesRead: 0, filesRead: 0 }));
    await expect(source.read(proposal, context)).rejects.toThrow("input_gap");
    expect(input.readPage).toHaveBeenCalledTimes(1);
  });
  it("resumes from a staged baseline position instead of starving the hundredth item", async () => {
    const input = inputPort([...Array.from({ length: 100 }, (_, i) => unit(`earlier-${i}`)), wanted]);
    const read = vi.spyOn(input, "readPage");
    const source = new BoundedEvolutionProposalSource([input]);
    const result = await source.read({ ...proposal, inputPosition: { snapshot: { selectionEpoch: 1 }, cursor: 100 } }, { ...context, limits: { ...DEFAULT_EVOLUTION_LIMITS, maxRecords: 1 } });
    expect(result.unit?.id).toBe("wanted");
    expect(read).toHaveBeenCalledTimes(1);
  });
  it("uses the host indexed reader for changed/due proposals", async () => {
    const input = inputPort([]);
    input.readProposal = vi.fn(async () => ({ unit: wanted, recordsRead: 1, bytesRead: 100, filesRead: 0 }));
    const open = vi.spyOn(input, "open");
    expect(await new BoundedEvolutionProposalSource([input]).read(proposal, { ...context, input: { mode: "inventory", selection: "changed" } })).toMatchObject({ unit: wanted });
    expect(open).not.toHaveBeenCalled();
  });
});
