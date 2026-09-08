import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryEvolutionInput } from "./directory-input.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { MemoryEvolutionReviewService } from "./review-service.js";
import { BoundedEvolutionProposalSource } from "./proposal-source.js";
import { computeCanonicalContentHash } from "../scoring/hash-utils.js";
import { DEFAULT_EVOLUTION_LIMITS } from "./schema.js";
import { authority, draft, scope } from "./test-fixtures.js";
import type { EvolutionGovernedWriter, EvolutionInputContext } from "./types.js";

const roots: string[] = [];
const adapters: DirectoryEvolutionInput[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "evolution-core-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(source);
  await mkdir(join(root, "state"));
  await writeFile(join(source, "notes.md"), "# Access policy\n\nNever expose project credentials to the public.\n\nExcept for test fixtures, all access requires approval.\n");
  const repository = new InMemoryEvolutionRepository();
  const options = { repository, configFingerprint: "global-config", sources: [{ binding: { sourceId: "notes", root: source, scope, parser: "markdown" as const }, manifestPath: join(root, "state", "manifest.json") }] };
  const adapter = new DirectoryEvolutionInput(options);
  adapters.push(adapter);
  const context: EvolutionInputContext = { input: { mode: "directory", sourceId: "notes" }, scope, limits: { ...DEFAULT_EVOLUTION_LIMITS } };
  return { adapter, options, context, root, source, repository };
}
describe("directory evolution input", () => {
  it("binds host scope, includes bounded context and keeps file/text hashes separate", async () => {
    const t = await setup();
    const snapshot = await t.adapter.open(t.context);
    const page = await t.adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    expect(page.units).toHaveLength(1);
    const unit = page.units[0];
    expect(unit.evidence[0].trust).toBe("untrusted");
    expect(unit.evidence[0].text).toContain("Access policy");
    expect(unit.evidence[0].snapshotHash).toBe(computeCanonicalContentHash(unit.evidence[0].text));
    expect(unit.snapshotHash).not.toBe(unit.evidence[0].snapshotHash);
    expect(JSON.stringify(snapshot)).not.toContain("Never expose");
    expect(JSON.stringify(page.nextCursor)).not.toContain("Never expose");
    expect(await t.adapter.verifyUnit(unit, t.context)).toMatchObject({ valid: true });
    await writeFile(join(t.source, "notes.md"), "changed");
    expect(await t.adapter.verifyUnit(unit, t.context)).toMatchObject({ valid: false, reason: "source_changed" });
  });
  it("rejects unknown source and authority mismatches", async () => {
    const t = await setup();
    await expect(t.adapter.open({ ...t.context, input: { mode: "directory", sourceId: "unknown" } })).rejects.toThrow("source_binding_unavailable");
    await expect(t.adapter.open({ ...t.context, scope: { ...scope, userId: "other" } })).rejects.toThrow("scope_mismatch");
  });
  it("propose/no-change do not advance canonical manifest or re-run the model", async () => {
    const t = await setup();
    const propose = vi.fn(async u => draft(u));
    const service = new MemoryEvolutionBatchService({ authority, scope, repository: t.repository, inputs: [t.adapter], configFingerprint: "global-config", proposer: { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose } });
    const request = { input: { mode: "directory" as const, sourceId: "notes" }, action: "propose" as const, idempotencyKey: "one" };
    const first = await service.run(request);
    expect(first.status).toBe("completed");
    const calls = propose.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    const second = await service.run({ ...request, idempotencyKey: "two" });
    expect(second.status).toBe("completed");
    expect(propose).toHaveBeenCalledTimes(calls);
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toThrow();
  });
  it("restarts a stale scanner cursor from bounded source reads, leaving DB dedup authoritative", async () => {
    const t = await setup();
    const snapshot = await t.adapter.open(t.context);
    const page = await t.adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    await t.adapter.close();
    const restarted = new DirectoryEvolutionInput(t.options);
    adapters.push(restarted);
    const reread = await restarted.readPage({ ...t.context, snapshot, cursor: page.nextCursor, limit: 1 });
    expect(reread.units[0].evidence[0].rootEvidenceId).toBe(page.units[0].evidence[0].rootEvidenceId);
  });
  it("processes real Codex session metadata followed by a user message without manual resume", async () => {
    const t = await setup();
    await rm(join(t.source, "notes.md"));
    await writeFile(join(t.source, "session.jsonl"), [
      { type: "session_meta", payload: { id: "session", cwd: "/project" } },
      { type: "response_item", timestamp: "2026-06-01T00:00:00.000Z", payload: { type: "message", id: "message", role: "user", content: [{ type: "input_text", text: "Record project approval before a production release." }] } },
    ].map(line => JSON.stringify(line)).join("\n") + "\n");
    const adapter = new DirectoryEvolutionInput({ ...t.options, sources: t.options.sources.map(source => ({ ...source, binding: { ...source.binding, parser: "codex-jsonl" } })) });
    adapters.push(adapter);
    const propose = vi.fn(async u => draft(u));
    const service = new MemoryEvolutionBatchService({ authority, scope, repository: t.repository, inputs: [adapter], configFingerprint: "global-config", proposer: { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose } });
    expect(await service.run({ input: { mode: "directory", sourceId: "notes" }, action: "propose", idempotencyKey: "metadata" })).toMatchObject({ status: "completed", counts: { proposed: 1 } });
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it("attaches host-resolved targets before proposing and charges bounded lookup reads", async () => {
    const t = await setup();
    const target = { memoryId: "existing", expectedRevision: 2, beforeHash: computeCanonicalContentHash("Existing approved project access policy."), text: "Existing approved project access policy.", scope, kind: "fact" as const, createdAt: 1, evidenceRootIds: [] };
    const resolveTargets = vi.fn(async () => ({ targets: [target], recordsRead: 1, bytesRead: Buffer.byteLength(target.text) }));
    const adapter = new DirectoryEvolutionInput({ ...t.options, resolveTargets });
    adapters.push(adapter);
    const snapshot = await adapter.open(t.context);
    const page = await adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    expect(page.units[0].targets).toEqual([target]);
    expect(page.recordsRead).toBe(2);
    expect(page.bytesRead).toBeGreaterThan(Buffer.byteLength(target.text));
    expect(resolveTargets).toHaveBeenCalledWith(expect.objectContaining({ scope, limit: 8, maxBytes: expect.any(Number), evidence: expect.any(Array) }));
    expect(await adapter.verifyUnit(page.units[0], t.context)).toMatchObject({ valid: true, bytesRead: expect.any(Number) });
  });
  it("retains the scanner's incomplete exception-context marker on the evidence", async () => {
    const t = await setup();
    await writeFile(join(t.source, "notes.md"), `# Access policy\n\nNever expose project credentials to the public.\n\nExcept when ${"the exception has a long condition ".repeat(40)}\n`);
    const snapshot = await t.adapter.open(t.context);
    const page = await t.adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    expect(page.units[0].evidence[0].contextIncomplete).toBe(true);
    expect(page.units[0].evidence[0].snapshotHash).toBe(computeCanonicalContentHash(page.units[0].evidence[0].text));
  });
  it("commits approved exact replay once without claiming the whole source page was confirmed", async () => {
    const t = await setup();
    const stage = vi.spyOn(t.repository, "stageProposal");
    const proposer = { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose: vi.fn(async input => draft(input)) };
    const writer: EvolutionGovernedWriter = { supportedOperations: ["create"], apply: vi.fn<EvolutionGovernedWriter["apply"]>(async context => {
      expect(context.evidence[0].trust).toBe("untrusted");
      expect(await context.verifySource()).toMatchObject({ valid: true });
      await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toThrow();
      const receipt = { id: "approved-directory-receipt", batchId: context.proposal.batchId, proposalId: context.proposal.id, scopeFingerprint: context.proposal.scopeFingerprint, operation: context.proposal.operation, outcome: "applied" as const, memoryIds: ["memory"], committedAt: Date.now() };
      await t.repository.commitReceipt(receipt, context.lease);
      return { outcome: "applied", receipt, replayed: false };
    }) };
    const source = new BoundedEvolutionProposalSource([t.adapter]);
    const service = new MemoryEvolutionBatchService({ authority, scope, repository: t.repository, reviews: t.repository, inputs: [t.adapter], configFingerprint: "global-config", proposer, writer, proposalSource: source });
    expect((await service.run({ input: { mode: "directory", sourceId: "notes" }, action: "propose", idempotencyKey: "staged-directory" })).status).toBe("completed");
    const original = stage.mock.calls[0][0];
    const calls = proposer.propose.mock.calls.length;
    const reviews = new MemoryEvolutionReviewService({ authority, scope, repository: t.repository, configFingerprint: "global-config", source, actor: { tenantId: scope.tenantId, userId: scope.userId, actorId: "operator", authentication: "local_owner" } });
    const preview = await reviews.preview(original.id);
    const approval = await reviews.decide({ reviewId: preview.id, expectedBindingHash: preview.bindingHash, decision: "approve", idempotencyKey: "approve-directory" });
    expect(await service.replayApproved(approval.id)).toMatchObject({ status: "completed", counts: { applied: 1 } });
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await service.replayApproved(approval.id)).toMatchObject({ status: "completed" });
    expect(writer.apply).toHaveBeenCalledTimes(1);
    expect(proposer.propose).toHaveBeenCalledTimes(calls);
  });
  it("rejects invalid snapshots, tampered units and unsupported target access without source confirmation", async () => {
    const t = await setup(); const snapshot = await t.adapter.open(t.context);
    await expect(t.adapter.readPage({ ...t.context, snapshot: { selectionEpoch: 1 }, cursor: null, limit: 1 })).rejects.toThrow("source_snapshot_invalid");
    const page = await t.adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    const changed = structuredClone(page.units[0]); changed.evidence[0].text += " Changed.";
    expect(await t.adapter.verifyUnit(changed, t.context)).toMatchObject({ valid: false, reason: "source_snapshot_changed" });
    await expect(t.adapter.readTargets([{ memoryId: "target", expectedRevision: 1, beforeHash: "0".repeat(64) }], t.context)).rejects.toThrow("directory_target_lookup_unsupported");
    await t.adapter.acknowledge({ ...t.context, snapshot, cursor: page.nextCursor, action: "apply_allowed", proposalId: "missing" });
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toThrow();
    await t.adapter.close();
    expect(await t.adapter.verifyUnit(page.units[0], t.context)).toMatchObject({ valid: false, reason: "source_snapshot_expired" });
  });
  it("bounds scanner sessions and rejects ambiguous host source bindings", async () => {
    const t = await setup();
    expect(() => new DirectoryEvolutionInput({ ...t.options, sources: [...t.options.sources, ...t.options.sources] })).toThrow("source_binding_ambiguous");
    for (let i = 0; i < 17; i++) await t.adapter.open(t.context);
    const snapshot = await t.adapter.open(t.context);
    expect(await t.adapter.readPage({ ...t.context, limits: { ...t.context.limits, maxRecords: 0 }, snapshot, cursor: null, limit: 1 })).toMatchObject({ units: [], reasons: ["source_budget_exhausted"] });
  });
  it.each(["records", "bytes", "scope"] as const)("rejects related resolver %s contract violations", async variant => {
    const t = await setup();
    const target = { memoryId: "target", expectedRevision: 1, beforeHash: "0".repeat(64), text: "Approved lookup target text.", kind: "fact" as const, scope: variant === "scope" ? { ...scope, userId: "other" } : scope, createdAt: 1, evidenceRootIds: [] };
    const adapter = new DirectoryEvolutionInput({ ...t.options, resolveTargets: async () => ({ targets: [target], recordsRead: variant === "records" ? 999 : 1, bytesRead: variant === "bytes" ? 999999999 : 10 }) });
    adapters.push(adapter);
    const snapshot = await adapter.open(t.context);
    await expect(adapter.readPage({ ...t.context, snapshot, cursor: null, limit: 1 })).rejects.toThrow(variant === "scope" ? "scope_mismatch" : "related_targets_budget_invalid");
  });
});
