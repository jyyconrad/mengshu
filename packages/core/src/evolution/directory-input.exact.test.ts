import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectoryEvolutionInput } from "./directory-input.js";
import { DirectorySourceScanner } from "./sources/scanner.js";
import { InMemoryEvolutionRepository } from "./in-memory-repository.js";
import { BoundedEvolutionProposalSource } from "./proposal-source.js";
import { MemoryEvolutionBatchService } from "./batch-service.js";
import { MemoryEvolutionReviewService } from "./review-service.js";
import { PostgresEvolutionRepository, proposalRequestHash, type PostgresEvolutionProposalEnvelope } from "./postgres-repository.js";
import { stageEvolutionEvidence } from "./proposal-validation.js";
import type { PostgresEvolutionQueryClient } from "./postgres-common.js";
import { DEFAULT_EVOLUTION_LIMITS, EVOLUTION_POLICY_VERSION } from "./schema.js";
import { evolutionInputFingerprint } from "./fingerprints.js";
import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import { authority, draft, scope } from "./test-fixtures.js";
import type { EvolutionInputContext, EvolutionInputUnit, EvolutionProposal } from "./types.js";

const roots: string[] = [];
const adapters: DirectoryEvolutionInput[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const adapter of adapters.splice(0)) await adapter.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "evolution-proposal-exact-")); roots.push(root);
  const source = join(root, "input");
  await mkdir(join(source, "deep", "nested"), { recursive: true });
  await writeFile(join(source, "deep", "nested", "policy.md"), "# Policy\n\nAlways record release approval.\n\nExcept when testing synthetic fixtures.\n");
  const repository = new InMemoryEvolutionRepository();
  const options = { repository, configFingerprint: "global-config", sources: [{ binding: { sourceId: "notes", root: source, scope, parser: "markdown" as const }, manifestPath: join(root, "state", "manifest.json") }] };
  const context: EvolutionInputContext = { input: { mode: "directory", sourceId: "notes" }, scope, limits: { ...DEFAULT_EVOLUTION_LIMITS } };
  const adapter = new DirectoryEvolutionInput(options); adapters.push(adapter);
  const snapshot = await adapter.open(context);
  const page = await adapter.readPage({ ...context, snapshot, cursor: null, limit: 1 });
  const unit = page.units[0];
  return { root, source, repository, options, context, adapter, snapshot, page, unit };
}
function proposal(unit: EvolutionInputUnit): EvolutionProposal {
  return { ...draft(unit), id: "proposal", batchId: "batch", inputUnitId: unit.id, inputFingerprint: evolutionInputFingerprint(unit, "global-config", EVOLUTION_POLICY_VERSION), sourceSnapshotHash: unit.snapshotHash, scope, scopeFingerprint: authorityScopeFingerprint(scope), configFingerprint: "global-config", policyVersion: EVOLUTION_POLICY_VERSION,
    createdAt: 1, status: "review", validation: { outcome: "review", reasons: [], reviewRequirement: "owner", independentEvidenceRootIds: [], contextEligible: false }, directoryLocator: structuredClone(unit.directoryLocator) };
}

describe("directory proposal exact reads", () => {
  it("persists the host locator through normal batch staging and restores that proposal exactly", async () => {
    const t = await setup();
    const stage = vi.spyOn(t.repository, "stageProposal");
    const service = new MemoryEvolutionBatchService({ authority, scope, repository: t.repository, inputs: [t.adapter], configFingerprint: "global-config", proposer: { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose: async u => draft(u) } });
    expect(await service.run({ input: t.context.input, action: "propose", idempotencyKey: "durable-locator" })).toMatchObject({ status: "completed" });
    expect(stage.mock.calls.length).toBeGreaterThan(0);
    expect(stage.mock.calls.every(([p]) => p.directoryLocator !== undefined)).toBe(true);
    const stored = await t.repository.getProposal(stage.mock.calls[0][0].id, authorityScopeFingerprint(scope));
    await t.adapter.close();
    const fresh = new DirectoryEvolutionInput(t.options); adapters.push(fresh);
    const readPage = vi.spyOn(fresh, "readPage").mockRejectedValue(new Error("a staged directory proposal must use its exact locator"));
    expect((await fresh.readProposal(JSON.parse(JSON.stringify(stored)), t.context)).unit!.id).toBe(stored!.inputUnitId);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("refreshes a reused proposal's locator and input position from the current host read", async () => {
    const t = await setup();
    const stage = vi.spyOn(t.repository, "stageProposal");
    const service = new MemoryEvolutionBatchService({ authority, scope, repository: t.repository, inputs: [t.adapter], configFingerprint: "global-config",
      proposer: { available: true, maxAttempts: 1, estimateInputTokens: () => 10, propose: async u => draft(u) },
      writer: { supportedOperations: ["create"], apply: async () => { throw new Error("untrusted input still needs owner review"); } } });
    await service.run({ input: t.context.input, action: "propose", idempotencyKey: "previous-proposal" });
    const previous = stage.mock.calls[0][0];
    const originalLookup = t.repository.getProposal.bind(t.repository);
    vi.spyOn(t.repository, "getProposal").mockImplementation(async (id, fingerprint) => {
      const p = await originalLookup(id, fingerprint);
      return p?.id === previous.id ? { ...p, directoryLocator: { ...t.unit.directoryLocator!, relativePath: "obsolete.md" } } : p;
    });
    stage.mockClear();
    const readPage = vi.spyOn(t.adapter, "readPage");
    const report = await service.run({ input: t.context.input, action: "apply_allowed", idempotencyKey: "current-apply" });
    const current = (await readPage.mock.results[0].value).units[0];
    const staged = stage.mock.calls[0][0];
    expect(staged.directoryLocator).toEqual(current.directoryLocator);
    expect(staged.directoryLocator).not.toBe(current.directoryLocator);
    const batch = await t.repository.getBatch(report.batchId, authorityScopeFingerprint(scope));
    expect(staged.inputPosition).toEqual({ snapshot: batch!.snapshot, cursor: null });
    expect(staged.inputPosition).not.toEqual(previous.inputPosition);
    expect(staged.validation.reviewRequirement).toBe("owner");
  });

  it("round-trips and integrity-binds the locator through the production Postgres envelope code", async () => {
    const t = await setup();
    const p = proposal(t.unit);
    const evidence = stageEvolutionEvidence(p, t.unit);
    let metadata: { evolution: PostgresEvolutionProposalEnvelope } | undefined;
    const commands: string[] = [];
    const query: PostgresEvolutionQueryClient["query"] = async <Row extends Record<string, unknown>>(sql: string, params: readonly unknown[] = []) => {
      commands.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("evolution:lease-lock")) rows = [{ id: p.batchId }];
      else if (sql.includes("evolution:proposal-insert")) { metadata = JSON.parse(params[12] as string); rows = [{ id: p.id }]; }
      else if (sql.includes("evolution:proposal-get")) rows = [{ metadata: JSON.parse(JSON.stringify(metadata)), status: "pending" }];
      else if (!["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) && !sql.includes("set_config(")) throw new Error(`unexpected synthetic SQL: ${sql}`);
      return { rows: rows as Row[], rowCount: rows.length };
    };
    const client = { query, release: vi.fn() };
    const repository = new PostgresEvolutionRepository({ scope, pool: { query, connect: async () => client } });
    const lease = { batchId: p.batchId, scopeFingerprint: p.scopeFingerprint, ownerId: "synthetic-owner", fencingToken: 1, expiresAt: 1000 };
    await repository.stageProposal(p, evidence, lease);
    const stored = await repository.getProposal(p.id, p.scopeFingerprint);
    expect(stored!.directoryLocator).toEqual(JSON.parse(JSON.stringify(t.unit.directoryLocator)));
    expect(metadata!.evolution.requestHash).toBe(proposalRequestHash(stored!, evidence));
    const fresh = new DirectoryEvolutionInput(t.options); adapters.push(fresh);
    expect((await fresh.readProposal(stored!, t.context)).unit).toEqual(t.unit);
    metadata!.evolution.proposal.directoryLocator!.record.digest = "0".repeat(64);
    await expect(repository.getProposal(p.id, p.scopeFingerprint)).rejects.toThrow("INVALID_PROPOSAL");
    const reviews = new MemoryEvolutionReviewService({ authority, scope, repository, configFingerprint: "global-config", source: new BoundedEvolutionProposalSource([fresh]), actor: { tenantId: scope.tenantId, userId: scope.userId, actorId: "operator", authentication: "local_owner" } });
    await expect(reviews.preview(p.id)).rejects.toThrow("INVALID_PROPOSAL");
    metadata!.evolution.requestHash = proposalRequestHash(metadata!.evolution.proposal, evidence);
    const rehashed = await repository.getProposal(p.id, p.scopeFingerprint);
    await expect(fresh.readProposal(rehashed!, t.context)).rejects.toThrow("review_source_changed");
    expect(commands.some(sql => /(?:INSERT INTO|UPDATE) memories\b/.test(sql))).toBe(false);
  });
  it("restores a durable deep proposal without a page scan and keeps current source verification active", async () => {
    const t = await setup();
    expect(t.unit.directoryLocator).toBeDefined();
    const original = JSON.parse(JSON.stringify(proposal(t.unit))) as EvolutionProposal;
    await t.adapter.close();
    await writeFile(join(t.source, "unrelated.md"), "An unrelated file must not be opened.\n");
    const restarted = new DirectoryEvolutionInput(t.options); adapters.push(restarted);
    const scan = vi.spyOn(DirectorySourceScanner.prototype, "scan").mockRejectedValue(new Error("unexpected directory scan"));
    const read = await new BoundedEvolutionProposalSource([restarted]).read(original, { ...t.context, limits: { ...t.context.limits, maxFiles: 1 } });
    expect(scan).not.toHaveBeenCalled();
    expect(read.unit).toEqual(t.unit);
    expect(read).toMatchObject({ filesRead: 1, recordsRead: 3, bytesRead: t.unit.directoryLocator!.snapshot.hashBytes });
    expect(read.checkpoint).toBeUndefined();
    expect(read.unit!.evidence[0]).toMatchObject({ trust: "untrusted", origin: "external" });
    expect(await restarted.verifyUnit(read.unit!, t.context)).toMatchObject({ valid: true });
    await writeFile(join(t.source, "deep", "nested", "policy.md"), "Replaced source.\n");
    expect(await restarted.verifyUnit(read.unit!, t.context)).toMatchObject({ valid: false, reason: "source_changed" });
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never falls back when a new proposal locator is invalid, drifted or out of budget", async () => {
    const t = await setup();
    const fresh = new DirectoryEvolutionInput(t.options); adapters.push(fresh);
    const scan = vi.spyOn(fresh, "readPage").mockRejectedValue(new Error("must not fall back"));
    const source = new BoundedEvolutionProposalSource([fresh]);
    const original = proposal(t.unit);
    await expect(source.read({ ...original, directoryLocator: { ...original.directoryLocator!, relativePath: "../escape.md" } }, t.context)).rejects.toThrow("review_source_changed");
    await expect(source.read(original, { ...t.context, limits: { ...t.context.limits, maxFiles: 0 } })).rejects.toThrow("review_source_budget_exceeded");
    await expect(source.read(original, { ...t.context, limits: { ...t.context.limits, maxRecords: 1 } })).rejects.toThrow("review_source_budget_exceeded");
    await expect(source.read({ ...original, configFingerprint: "changed" }, t.context)).rejects.toThrow("config_changed");
    await expect(source.read({ ...original, sourceSnapshotHash: "0".repeat(64) }, t.context)).rejects.toThrow("review_source_changed");
    const controller = new AbortController(); controller.abort();
    await expect(source.read(original, { ...t.context, signal: controller.signal })).rejects.toThrow();
    expect(scan).not.toHaveBeenCalled();
  });

  it("retains bounded fallback for legacy proposals without a durable locator", async () => {
    const t = await setup();
    const legacy = proposal(t.unit); delete legacy.directoryLocator;
    const fresh = new DirectoryEvolutionInput(t.options); adapters.push(fresh);
    const scan = vi.spyOn(fresh, "readPage");
    const read = await new BoundedEvolutionProposalSource([fresh]).read(legacy, t.context);
    expect(read.unit?.id).toBe(t.unit.id);
    expect(scan).toHaveBeenCalled();
  });

  it("acknowledges only the current receipted page and keeps duplicate acknowledgement idempotent", async () => {
    const t = await setup();
    const p = { ...proposal(t.unit), inputPosition: { snapshot: t.snapshot, cursor: null } };
    vi.spyOn(t.repository, "getProposal").mockResolvedValue(p);
    const getReceipt = vi.spyOn(t.repository, "getReceipt");
    const acknowledge = { ...t.context, snapshot: t.snapshot, cursor: t.page.nextCursor, action: "apply_allowed" as const, proposalId: p.id };
    await t.adapter.acknowledge(acknowledge);
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
    getReceipt.mockResolvedValue({ id: "committed-receipt", batchId: p.batchId, proposalId: p.id, scopeFingerprint: p.scopeFingerprint, operation: p.operation, outcome: "applied", memoryIds: ["memory"], committedAt: 1 });
    await t.adapter.acknowledge(acknowledge);
    const bytes = await readFile(join(t.root, "state", "manifest.json"), "utf8");
    const manifest = JSON.parse(bytes);
    expect(manifest.files[t.unit.directoryLocator!.snapshot.pathId].complete).toBe(false);
    expect(bytes).not.toContain("release approval");
    await t.adapter.acknowledge(acknowledge);
    expect(await readFile(join(t.root, "state", "manifest.json"), "utf8")).toBe(bytes);
  });

  it("does not swallow an unconfirmed preceding page when acknowledging a later receipt", async () => {
    const t = await setup();
    const later = await t.adapter.readPage({ ...t.context, snapshot: t.snapshot, cursor: t.page.nextCursor, limit: 1 });
    expect(later.units).toHaveLength(1);
    const p = { ...proposal(later.units[0]), inputPosition: { snapshot: t.snapshot, cursor: t.page.nextCursor } };
    vi.spyOn(t.repository, "getProposal").mockResolvedValue(p);
    vi.spyOn(t.repository, "getReceipt").mockResolvedValue({ id: "later-receipt", batchId: p.batchId, proposalId: p.id, scopeFingerprint: p.scopeFingerprint, operation: p.operation, outcome: "applied", memoryIds: ["memory"], committedAt: 1 });
    await expect(t.adapter.acknowledge({ ...t.context, snapshot: t.snapshot, cursor: later.nextCursor, action: "apply_allowed", proposalId: p.id })).rejects.toThrow(/preceding source page/);
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not borrow an old proposal receipt to confirm a fresh scanner page", async () => {
    const t = await setup();
    const p = { ...proposal(t.unit), inputPosition: { snapshot: t.snapshot, cursor: null } };
    vi.spyOn(t.repository, "getProposal").mockResolvedValue(p);
    const receipt = vi.spyOn(t.repository, "getReceipt").mockResolvedValue({ id: "old-receipt", batchId: p.batchId, proposalId: p.id, scopeFingerprint: p.scopeFingerprint, operation: p.operation, outcome: "applied", memoryIds: ["memory"], committedAt: 1 });
    const fresh = new DirectoryEvolutionInput(t.options); adapters.push(fresh);
    const snapshot = await fresh.open(t.context);
    const page = await fresh.readPage({ ...t.context, snapshot, cursor: null, limit: 1 });
    await fresh.acknowledge({ ...t.context, snapshot, cursor: page.nextCursor, action: "apply_allowed", proposalId: p.id });
    expect(receipt).not.toHaveBeenCalled();
    await expect(readFile(join(t.root, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("re-resolves targets under the remaining budget instead of trusting proposal target refs", async () => {
    const t = await setup();
    const target = { memoryId: "related", expectedRevision: 2, beforeHash: "0".repeat(64), text: "Existing project policy.", kind: "fact" as const, scope, createdAt: 1, evidenceRootIds: [] };
    const resolveTargets = vi.fn(async () => ({ targets: [target], recordsRead: 1, bytesRead: Buffer.byteLength(target.text) }));
    const fresh = new DirectoryEvolutionInput({ ...t.options, resolveTargets }); adapters.push(fresh);
    const read = await new BoundedEvolutionProposalSource([fresh]).read(proposal(t.unit), t.context);
    expect(read.unit!.targets).toEqual([target]);
    expect(read.recordsRead).toBe(4);
    expect(read.bytesRead).toBe(t.unit.directoryLocator!.snapshot.hashBytes + Buffer.byteLength(target.text));
    expect(read.unit!.evidence[0].authorizedTargetIds).toBeUndefined();
    expect(await fresh.verifyUnit(read.unit!, t.context)).toMatchObject({ valid: true });
    target.expectedRevision = 3;
    const latest = await fresh.readProposal(proposal(t.unit), t.context);
    expect(await fresh.verifyUnit(latest.unit!, t.context)).toMatchObject({ valid: true });
  });
});
