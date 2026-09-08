import { describe, expect, test, vi } from "vitest";
import { scope, unit } from "../packages/core/src/evolution/test-fixtures.js";
import { DEFAULT_EVOLUTION_LIMITS } from "../packages/core/src/evolution/schema.js";
import type { EvolutionEvidenceAttestationPort, EvolutionInputPort, EvolutionProposal } from "../packages/core/src/evolution/types.js";
import { EvolutionAttestedProposalInput } from "./evolution-attested-proposal-input.js";

describe("attested indexed proposal input", () => {
  test("preserves exact provider proposal reads and verifies the original unit without first-page replay", async () => {
    const input = unit(); input.evidence[0].trust = "untrusted";
    const checkpoint = { snapshot: { selectionEpoch: 1 }, cursor: { afterId: "exact" } };
    const originalVerify = vi.fn(async value => { expect(value).toEqual(input); return { valid: true, bytesRead: 30 }; });
    const source: EvolutionInputPort = { mode: "inventory", open: vi.fn(), readPage: vi.fn(), readTargets: vi.fn(),
      readProposal: vi.fn(async () => ({ unit: structuredClone(input), recordsRead: 2, filesRead: 0, bytesRead: 50, checkpoint })),
      verifyUnit: originalVerify };
    const port: EvolutionEvidenceAttestationPort = { attest: vi.fn(async () => ({ attestations: [], recordsRead: 2, bytesRead: 8,
      verificationBudget: { records: 2, bytes: 8 } })), verify: vi.fn(async () => ({ valid: true, recordsRead: 2, bytesRead: 8 })) };
    const adapter = new EvolutionAttestedProposalInput(source, port);
    const context = { input: { mode: "inventory" as const, selection: "changed" as const }, scope, limits: DEFAULT_EVOLUTION_LIMITS };
    const proposal = { inputUnitId: input.id } as EvolutionProposal;
    const read = await adapter.readProposal(proposal, context);
    expect(source.readProposal).toHaveBeenCalledExactlyOnceWith(proposal, context);
    expect(source.open).not.toHaveBeenCalled(); expect(source.readPage).not.toHaveBeenCalled();
    expect(read).toMatchObject({ checkpoint, recordsRead: 4, bytesRead: 58 });
    expect(await adapter.verifyUnit(read.unit!, context)).toMatchObject({ valid: true, bytesRead: 38 });
    expect(originalVerify).toHaveBeenCalledTimes(1);
  });
  test("a missing exact reader remains explicitly blocked and does not hide the contract with a rescan", async () => {
    const source = { mode: "directory", readPage: vi.fn() } as unknown as EvolutionInputPort;
    const adapter = new EvolutionAttestedProposalInput(source, {} as never);
    await expect(adapter.readProposal({} as never, {} as never)).rejects.toThrow("review_source_reader_unavailable");
    expect(source.readPage).not.toHaveBeenCalled();
  });
});
