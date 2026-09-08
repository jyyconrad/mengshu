import { describe, expect, test, vi } from "vitest";
import { unit, scope, authority } from "../packages/core/src/evolution/test-fixtures.js";
import { DEFAULT_EVOLUTION_LIMITS } from "../packages/core/src/evolution/schema.js";
import type { EvolutionApplyContext, EvolutionInputPort } from "../packages/core/src/evolution/types.js";
import type { EvolutionAttestationService } from "./evolution-attestation.js";
import { EvolutionInputBudget } from "./evolution-input-budget.js";

function fixture() {
  const original = unit();
  original.verificationBudget = { records: 3, files: 1, bytes: 100 };
  const context = { input: { mode: "inventory" as const, selection: "baseline" as const }, scope,
    limits: { ...DEFAULT_EVOLUTION_LIMITS, maxRecords: 100, maxBytes: 1_000_000 } };
  const source: EvolutionInputPort = {
    mode: "inventory", open: async () => ({ selectionEpoch: 1 }),
    readPage: async () => ({ units: [structuredClone(original)], nextCursor: null, complete: true, recordsRead: 2, filesRead: 1, bytesRead: 40 }),
    readTargets: async () => [],
    verifyUnit: vi.fn(async (value, ctx) => {
      expect(value).toEqual(original);
      expect(ctx.limits).toMatchObject({ maxRecords: 3, maxFiles: 1, maxBytes: 100 });
      return { valid: true, bytesRead: 40 };
    }),
  };
  const guard = vi.fn(async () => ({ recordsRead: 2, bytesRead: 10 }));
  const attestation = { transactionBudget: () => ({ records: 4, bytes: 256 }),
    transactionBudgetForEvidence: () => ({ records: 4, bytes: 256 }),
    assertApplyInTransaction: guard } as unknown as EvolutionAttestationService;
  const port = new EvolutionInputBudget(source, attestation);
  const apply = { authority, evidence: [], proposal: { inputUnitId: original.id, sourceSnapshotHash: original.snapshotHash, scope }, signal: undefined } as unknown as EvolutionApplyContext;
  const client = { query: vi.fn() };
  return { port, source, original, context, guard, apply, client };
}

describe("evolution host transaction verification reservation", () => {
  test("retains the transaction reservation without changing the source snapshot or its read limits", async () => {
    const f = fixture();
    const page = await f.port.readPage({ ...f.context, snapshot: { selectionEpoch: 1 }, cursor: null, limit: 1 });
    expect(page.units[0].verificationBudget).toEqual({ records: 7, files: 1, bytes: 356 });
    expect(page.bytesRead).toBe(40);
    expect(f.original.verificationBudget).toEqual({ records: 3, files: 1, bytes: 100 });
    const reserved = { ...f.context, limits: { ...f.context.limits, maxRecords: 7, maxFiles: 1, maxBytes: 356 } };
    await expect(f.port.verifyUnit(page.units[0], reserved)).resolves.toEqual({ valid: true, bytesRead: 296 });
    await f.port.assertApplyInTransaction(f.client, f.apply);
    expect(f.guard).toHaveBeenCalledWith(f.client, f.apply, expect.objectContaining({ limits: expect.objectContaining({ maxRecords: 4, maxBytes: 256 }) }));
    await expect(f.port.assertApplyInTransaction(f.client, f.apply)).rejects.toThrow("attestation_transaction_budget_exhausted");
  });

  test("rejects changed units and unreserved or cancelled apply before any SQL", async () => {
    const f = fixture();
    await expect(f.port.assertApplyInTransaction(f.client, f.apply)).rejects.toThrow("attestation_transaction_budget_exhausted");
    const page = await f.port.readPage({ ...f.context, snapshot: { selectionEpoch: 1 }, cursor: null, limit: 1 });
    await expect(f.port.verifyUnit({ ...page.units[0], id: "changed" }, f.context)).resolves.toMatchObject({ valid: false });
    expect(f.source.verifyUnit).not.toHaveBeenCalled();
    await expect(f.port.verifyUnit(page.units[0], { ...f.context, limits: { ...f.context.limits, maxBytes: 100 } })).rejects.toThrow("attestation_budget_exceeded");
    await f.port.verifyUnit(page.units[0], f.context);
    await expect(f.port.assertApplyInTransaction(f.client, { ...f.apply, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(f.guard).not.toHaveBeenCalled();
    expect(f.client.query).not.toHaveBeenCalled();
  });
});
