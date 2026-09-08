import { describe, expect, it, vi } from "vitest";
import { InventoryEvolutionInput, compareEvolutionKeys } from "./inventory-input.js";
import { DEFAULT_EVOLUTION_LIMITS } from "./schema.js";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { authority, draft, scope, unit } from "./test-fixtures.js";
import type { EvolutionCursor, EvolutionInputContext, EvolutionInventoryReadPort } from "./types.js";

function inventory() {
  const units = ["a", "b", "c"].map(id => {
    const input = unit(id);
    input.targets = [{ memoryId: id, expectedRevision: 1, beforeHash: input.evidence[0].snapshotHash, text: input.evidence[0].text, scope, kind: "fact", createdAt: 10, evidenceRootIds: [] }];
    return input;
  });
  const repository: EvolutionInventoryReadPort = {
    freeze: vi.fn(async () => ({ selectionEpoch: 20, upperKey: { createdAt: 10, memoryId: "c" } })),
    readPage: vi.fn(async (_scope, _snapshot, after, limit) => {
      const remaining = units.filter(u => !after || compareEvolutionKeys({ createdAt: 10, memoryId: u.id }, after) > 0);
      return { units: remaining.slice(0, limit), complete: remaining.length <= limit };
    }),
    readTargets: vi.fn<EvolutionInventoryReadPort["readTargets"]>(async (_scope, refs) => units.flatMap(u => u.targets).filter(t => refs.some(r => r.memoryId === t.memoryId))),
    verifyEvidence: vi.fn(async () => ({ valid: true })),
  };
  const input = new InventoryEvolutionInput(repository);
  const context: EvolutionInputContext = { input: { mode: "inventory", selection: "baseline" }, scope, limits: { ...DEFAULT_EVOLUTION_LIMITS } };
  return { units, repository, input, context };
}
describe("inventory keyset input", () => {
  it("walks tied createdAt IDs exclusively and counts target/evidence bytes", async () => {
    const t = inventory();
    const snapshot = await t.input.open(t.context);
    const first = await t.input.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    expect(first).toMatchObject({ nextCursor: { createdAt: 10, memoryId: "a" }, complete: false });
    expect(first.bytesRead).toBe(Buffer.byteLength(t.units[0].evidence[0].text) * 2);
    const second = await t.input.readPage({ ...t.context, snapshot, cursor: first.nextCursor, limit: 1 });
    expect(second.units[0].id).toBe("b");
    expect(await t.input.verifyUnit(t.units[0], t.context)).toEqual({ valid: true });
    expect(await t.input.readTargets(t.units[0].targets, t.context)).toHaveLength(1);
  });
  it.each(["changed", "due"] as const)("maps %s capability codes without leaking provider errors", async selection => {
    const t = inventory();
    t.repository.freeze = vi.fn(async () => { throw Object.assign(new Error("sensitive database host details"), { code: `${selection.toUpperCase()}_INVENTORY_UNAVAILABLE` }); });
    await expect(t.input.open({ ...t.context, input: { mode: "inventory", selection } })).rejects.toThrow(`inventory_${selection}_unsupported`);
  });
  it("does not map arbitrary provider error messages to accepted capability codes", async () => {
    const t = inventory();
    const error = new Error("CHANGED_INVENTORY_UNAVAILABLE");
    t.repository.freeze = vi.fn(async () => { throw error; });
    await expect(t.input.open(t.context)).rejects.toBe(error);
  });
  it.each<EvolutionCursor>(["malformed", { createdAt: 10, memoryId: "a", text: "forged" }, { createdAt: 1.5, memoryId: "a" }])("rejects invalid cursor %s", async cursor => {
    const t = inventory();
    await expect(t.input.readPage({ ...t.context, snapshot: await t.input.open(t.context), cursor, limit: 1 })).rejects.toThrow("inventory_cursor_invalid");
  });
  it("rejects nonexclusive or upper-bound-escaping provider pages", async () => {
    const t = inventory();
    const snapshot = await t.input.open(t.context);
    t.repository.readPage = vi.fn(async () => ({ units: [t.units[0]], complete: true }));
    await expect(t.input.readPage({ ...t.context, snapshot, cursor: { createdAt: 10, memoryId: "a" }, limit: 1 })).rejects.toThrow("inventory_keyset_violation");
    await expect(t.input.readPage({ ...t.context, snapshot: { ...snapshot, upperKey: { createdAt: 1, memoryId: "a" } }, cursor: null, limit: 1 })).rejects.toThrow("inventory_keyset_violation");
  });
  it("resumes past the first bounded page instead of starving later inventory records", async () => {
    const t = inventory();
    const service = new MemoryEvolutionBatchService({ authority, scope, inputs: [t.input], repository: new InMemoryEvolutionRepository(), configFingerprint: "global", proposer: { available: true, maxAttempts: 1, estimateInputTokens: () => 1, propose: async u => draft({ ...u, targets: [] }) } });
    const request = { input: { mode: "inventory" as const, selection: "baseline" as const }, action: "propose" as const, limits: { maxRecords: 3 }, idempotencyKey: "bounded" };
    const first = await service.run(request);
    expect(first).toMatchObject({ status: "partial", counts: { proposed: 1 }, checkpoint: { cursor: { memoryId: "a" } } });
    const second = await service.resume(first.batchId);
    expect(second).toMatchObject({ status: "partial", counts: { proposed: 2 }, checkpoint: { cursor: { memoryId: "b" } } });
    const last = await service.resume(first.batchId);
    expect(last).toMatchObject({ status: "completed", counts: { proposed: 3 }, usage: { records: 9 }, checkpoint: { cursor: { memoryId: "c" } } });
  });
  it.each(["changed", "due"] as const)("uses the frozen %s item cursor and acknowledges only durable proposal completion", async selection => {
    const t = inventory();
    const own = { ...t.units[0], selectionEvent: { eventId: "own", memoryId: "a", revision: 1, origin: "evolution" as const } };
    const external = { ...t.units[1], selectionEvent: { eventId: "late-commit", memoryId: "b", revision: 1, origin: "external" as const } };
    t.repository.readSelectedPage = vi.fn(async (_scope, _snapshot, cursor) => cursor === null
      ? { units: [own], nextCursor: { selectionId: "frozen", item: "own" }, complete: false, recordsRead: 2, bytesRead: 80, filesRead: 0 }
      : { units: [external], nextCursor: { selectionId: "frozen", item: "late-commit" }, complete: true, recordsRead: 2, bytesRead: 80, filesRead: 0 });
    const repository = new InMemoryEvolutionRepository();
    const processed = vi.spyOn(repository, "recordProcessed");
    t.repository.acknowledgeSelection = vi.fn(async (_scope, _snapshot, cursor, action, proof) => {
      expect(action).toBe("propose");
      expect(proof?.proposalId).toBeDefined();
      if (cursor && typeof cursor === "object" && !Array.isArray(cursor) && cursor.item === "late-commit") expect(processed).toHaveBeenCalledTimes(1);
    });
    const proposer = { available: true, maxAttempts: 1, estimateInputTokens: () => 1, propose: vi.fn(async input => draft(input)) };
    const service = new MemoryEvolutionBatchService({ authority, scope, inputs: [t.input], repository, configFingerprint: "global", proposer });
    const request = { input: { mode: "inventory" as const, selection }, action: "propose" as const, idempotencyKey: "selected" };
    expect(await service.run({ ...request, action: "preview", idempotencyKey: "preview-selected" })).toMatchObject({ status: "completed" });
    expect(t.repository.acknowledgeSelection).not.toHaveBeenCalled();
    expect(await service.run(request)).toMatchObject({ status: "completed", counts: { proposed: 1 }, checkpoint: { cursor: { item: "late-commit" } } });
    expect(proposer.propose).toHaveBeenCalledTimes(1);
    expect(t.repository.readPage).not.toHaveBeenCalled();
    expect(t.repository.acknowledgeSelection).toHaveBeenCalledTimes(1);
  });
  it("rejects selected events whose exact target revision or event identity is invalid", async () => {
    const t = inventory();
    const context = { ...t.context, input: { mode: "inventory" as const, selection: "changed" as const } };
    t.repository.readSelectedPage = vi.fn(async () => ({ units: [{ ...t.units[0], selectionEvent: { eventId: "event", memoryId: "a", revision: 9, origin: "external" as const } }], complete: true, nextCursor: "event", recordsRead: 2, bytesRead: 80, filesRead: 0 }));
    await expect(t.input.readPage({ ...context, snapshot: await t.input.open(context), cursor: null, limit: 1 })).rejects.toThrow("inventory_event_revision_changed");
  });
});
