import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { memoryConfigSchema } from "../config.js";
import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import { createDurableJobHandlerRegistry, createDurableJobV2, leaseDurableJobV2, type DurableJobV2 } from "../packages/core/src/storage/repositories/job-v2.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import { parseEvolutionControlRequest } from "../packages/core/src/evolution/schema.js";
import { evolutionGovernanceSnapshotHash, evolutionGovernanceState } from "../packages/core/src/evolution/governed-metadata.js";
import { computeCanonicalContentHash } from "../packages/core/src/scoring/hash-utils.js";
import type { EvolutionBatch, EvolutionControlWork } from "../packages/core/src/evolution/types.js";
import type { MemoryWriteKernelDependencies } from "../packages/core/src/service/write-kernel.js";
import { NullLlmClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { DirectorySourceScanner } from "../packages/core/src/evolution/sources/scanner.js";
import { withAuthenticatedEvolutionOwner } from "../packages/api/src/evolution-owner-auth.js";
import { createEvolutionHostControl } from "./evolution-control.js";
import { createEvolutionControlWork } from "./evolution-control-work.js";
import { loadGlobalEvolutionConfig } from "./evolution-config.js";
import { createEvolutionRuntime } from "./evolution-runtime.js";
import * as controlBudget from "../packages/core/src/storage/repositories/evolution-control-budget.js";

const scope = { tenantId: "tenant", userId: "owner", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const authority = { tenantId: scope.tenantId, userId: scope.userId, allow: { appIds: [scope.appId], projectIds: [scope.projectId], agentIds: [scope.agentId], namespaces: [scope.namespace], visibilities: [scope.visibility] } };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

/** Only pg query results are doubled; host state, scanner, receipts, guards, factory and executor are native. */
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "evolution-control-")); dirs.push(dir);
  const root = join(dir, "source"), home = join(dir, "home"), manifestRoot = join(home, "sources");
  await mkdir(root); await mkdir(home); await writeFile(join(root, "notes.md"), "# Review\n\nA bounded documented fact for review.\n");
  vi.stubEnv("MENGSHU_HOME", home);
  const states = new Map<string, Record<string, unknown>>(), reviews = new Map<string, Record<string, unknown>>();
  const dispositions = new Map<string, Record<string, unknown>>(), receipts = new Map<string, Record<string, unknown>>();
  const batches = new Map<string, EvolutionBatch>();
  const rawText = "The original documented fact.";
  const raw = { id: "raw", text: rawText, content_hash: computeCanonicalContentHash(rawText), created_at_ms: 100,
    data_type: "memory", legacy_quarantine_reason: null, lifecycle_status: "archived", metadata: {
      evolutionEvidence: { sourceId: "docs" }, admissionRoute: "evidence_only", contextEligible: false, memoryContainer: "session_candidate",
      eventType: "observation", sourceNodeIds: ["event"], governance: { commandType: "importEvidence", evidenceIds: ["event"],
        native: { dataType: "memory", kind: "observation", container: "session_candidate" }, provenance: { source: "evolution", sourceId: "event" },
        candidate: { phase: "raw_evidence", evidenceOnly: true, quote: rawText, sourceId: "event" } } } };
  const id = "11111111-1111-4111-8111-111111111111";
  const before = { id, content_hash: "a".repeat(64), lineage_id: null, revision: null, lifecycle_status: "active",
    metadata: { contextEligible: true, admissionRoute: "active", confidence: 0.9, sourceNodeIds: ["raw"],
      governance: { evidenceIds: ["raw"], native: { kind: "fact" }, evolution: { effectiveRootIds: ["root"] } } } };
  const target = { ...before, evolution_disputed: true, evolution_review_due_at: 2000,
    metadata: { ...before.metadata, contextEligible: false, governance: { ...before.metadata.governance,
      evolution: { ...before.metadata.governance.evolution, disputed: true, lastOperationId: "proposal" } } } };
  const operation = { id: "c".repeat(64), proposalId: "proposal", operation: "mark_disputed", memoryIds: [id],
    before: [evolutionGovernanceState(before)], after: [evolutionGovernanceState(target)], beforeLinks: [], afterLinks: [],
    currentStateHash: evolutionGovernanceSnapshotHash([evolutionGovernanceState(target)], []), at: 2000 };
  const calls: string[] = [];
  let beforeSourceLock: (() => Promise<void>) | undefined;
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
    calls.push(sql);
    const hostRows = [...states.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const hostReceipts = [...reviews.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    let rows: Record<string, unknown>[] = [];
    if (sql.includes("evolution:batch-insert")) { const batch = JSON.parse(String(p[4])) as EvolutionBatch; batches.set(batch.id, batch); rows = [{ body: batch }]; }
    else if (sql.includes("evolution:batch-get")) { const batch = batches.get(String(p[1])); rows = batch ? [{ body: batch }] : []; }
    else if (sql.includes("evolution:batch-save")) { const batch = JSON.parse(String(p[2])) as EvolutionBatch; batches.set(batch.id, batch); rows = [{ body: batch }]; }
    else if (sql.includes("evolution:job-fence")) rows = [{ id: p[0] }];
    else if (sql.includes("evolution:lease-acquire")) rows = [{ fencing_token: 1, lease_expires_at: Date.now() + 30000 }];
    else if (sql.includes("evolution:lease-lock")) rows = [{ id: p[1] }];
    else if (sql.includes("evolution:host-state-lock")) rows = hostRows.filter(row => row.kind === p[2] && row.entry_id === p[3]);
    else if (sql.includes("evolution:host-state-quota")) rows = [{ entries: hostRows.length, receipts: hostReceipts.length }];
    else if (sql.includes("evolution:host-receipt-key")) rows = hostReceipts.filter(row => row.kind === p[2] && row.idempotency_key === p[3]);
    else if (sql.includes("evolution:host-state-save")) {
      states.set(JSON.stringify(p.slice(0, 4)), { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], entry_id: p[3], revision: p[4],
        value: JSON.parse(String(p[5])), value_hash: p[6], updated_at: p[7], expires_at: p[8], revoked_at: p[9] }); rows = [{ revision: p[4] }];
    } else if (sql.includes("evolution:host-receipt-save")) reviews.set(String(p[5]), { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], idempotency_key: p[3],
      request_hash: p[4], receipt_id: p[5], receipt: JSON.parse(String(p[6])) });
    else if (sql.includes("evolution:host-administrative-lock")) rows = hostReceipts.filter(row => row.receipt_id === p[2]);
    else if (sql.includes("evolution:host-administrative-consume")) {
      const review = reviews.get(String(p[2])); if (review) { review.consumed_by = p[3]; rows = [{ receipt_id: p[2] }]; }
    } else if (sql.includes("evolution:source-global-lock")) { await beforeSourceLock?.(); const value = dispositions.get(""); rows = value ? [value] : []; }
    else if (sql.includes("evolution:source-file-lock")) { const value = dispositions.get(String(p[2])); rows = value ? [value] : []; }
    else if (sql.includes("evolution:source-file-save")) dispositions.set(String(p[2]), { revision: p[3], disposition: p[5] });
    else if (sql.includes("evolution:source-global-save")) dispositions.set("", { revision: p[2], disposition: "current" });
    else if (sql.includes("evolution:source-prior-receipt") || sql.includes("evolution:source-revoke-receipt") || sql.includes("evolution:undo-replay")) {
      const value = receipts.get(String(p[1])); rows = value ? [value] : [];
    } else if (sql.includes("evolution:source-receipt") || sql.includes("evolution:source-revoke-commit") || sql.includes("evolution:undo-receipt")) receipts.set(String(p[1]), { request_hash: p[2], receipt: JSON.parse(String(p[3])) });
    else if (sql.includes("evolution:source-revoke-state")) { for (const row of dispositions.values()) row.disposition = "revoked"; }
    else if (sql.includes("evolution:undo-original")) rows = [{ receipt: operation }];
    else if (sql.includes("evolution:undo-target")) rows = [target];
    else if (sql.includes("evolution:undo-raw-origins")) rows = [{ id: raw.id, metadata: raw.metadata }];
    else if (sql.includes("evolution:undo-raw-lock")) rows = [raw];
    else if (sql.includes("evolution:undo-restore-row") || sql.includes("evolution:metadata-write")) rows = [{ id }];
    else if (sql.includes("to_regclass('mengshu_evolution_batches')")) rows = [{ batches: true, receipts: true, processed: true, reviews: true,
      sources: true, operations: true, budgets: true, host_state: true, host_receipts: true }];
    else if (sql.startsWith("SELECT pg_advisory")) rows = [{}];
    return { rows: structuredClone(rows), rowCount: rows.length };
  });
  const provider = new PostgresProvider({ host: "unused", database: "unused", user: "unused", password: "unused", port: 5432 }, "text-embedding-3-small");
  Object.assign(provider, { pool: { query, connect: async () => ({ query, release() {} }) }, schemaVersion: 37, schemaContractState: "ready" });
  vi.spyOn(provider, "initialize").mockResolvedValue();
  const bundle = provider.createDurableJobV2RuntimeBundle({ clock: Date.now, tokenFactory: () => "a".repeat(32), backoffMs: () => 1, enableMemoryEvolution: true });
  const job = leaseDurableJobV2(createDurableJobV2({ id: "job", type: "evolve_memory_batch", payload: { batchId: "batch", segmentAttempt: 1 },
    scope, dedupeKey: "batch", maxAttempts: 1 }, { now: Date.now(), registry: createDurableJobHandlerRegistry(bundle.handlerTypes) }),
    { now: Date.now(), owner: "worker", leaseMs: 30000, tokenFactory: () => "b".repeat(32) }).job;
  const config = loadGlobalEvolutionConfig({ scope, authority, hostConfig: memoryConfigSchema.parse({ embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" },
    features: { continuousMemoryEvolution: true }, evolution: { sources: [{ sourceId: "docs", root, parser: "markdown", semantics: "current_document" }] } }) });
  const persistence = bundle.createEvolutionPersistence!(scope, { job });
  const hostControl = createEvolutionHostControl({ persistence: bundle.createEvolutionPersistence!(scope, {}), config, authority, scope });
  const onCommitted = vi.fn(async () => {});
  const helper = createEvolutionControlWork({ runtimeBundle: bundle, persistence, job, config, authority, scope, hostControl, manifestRoot, onCommitted });
  const lease = (await persistence.repository.acquireLease("batch", authorityScopeFingerprint(scope), "owner", 30000))!;
  calls.length = 0; query.mockClear();
  const context = (work: EvolutionControlWork, key = "control") => {
    const request = parseEvolutionControlRequest({ input: { mode: "control", work }, action: "execute_control", idempotencyKey: key,
      limits: { maxRecords: 1000, maxFiles: work.kind === "source_reconcile" ? 20 : 0, maxBytes: 1000000 } });
    return { request, batchId: "batch", scope, lease, limits: request.limits, signal: new AbortController().signal };
  };
  const secret = "independent-owner-test-secret-not-production";
  const owner = <T>(work: () => Promise<T>) => withAuthenticatedEvolutionOwner({ owner: authority, secret, headers: { "x-mengshu-owner-token": secret } }, work);
  return { helper, context, owner, root, manifestRoot, calls, query, onCommitted, hostControl, receipts, reviews, dispositions, operation, target, states, batches, config, bundle,
    beforeSourceLock: (hook: () => Promise<void>) => { beforeSourceLock = hook; } };
}

describe("native source and administrative control execution", () => {
  test("real source receipt commits before manifest confirmation and cache invalidation", async () => {
    const f = await fixture();
    const confirm = vi.spyOn(DirectorySourceScanner.prototype, "confirm");
    const result = await f.helper.port.execute(f.context({ kind: "source_reconcile", sourceId: "docs" }));
    expect(result).toMatchObject({ status: "completed", sourceManifestConfirmed: true });
    expect(result).not.toHaveProperty("affectedMemoryIds");
    expect([...f.receipts.values()].some(row => (row.receipt as { receiptId: string }).receiptId === result.receiptId)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(join(f.manifestRoot, "docs", "manifest.json"), "utf8")).generation).toBe(1);
    expect(f.calls.findIndex(sql => sql.includes("evolution:source-receipt"))).toBeGreaterThan(f.calls.findIndex(sql => sql.includes("evolution:job-fence")));
    expect(f.onCommitted).toHaveBeenCalledExactlyOnceWith([]);
  });
  test("source drift during the native transaction never yields a receipt or confirms a manifest", async () => {
    const f = await fixture(), confirm = vi.spyOn(DirectorySourceScanner.prototype, "confirm");
    f.beforeSourceLock(() => writeFile(join(f.root, "notes.md"), "# Changed\n\nThe original source changed.\n"));
    await expect(f.helper.port.execute(f.context({ kind: "source_reconcile", sourceId: "docs" }))).rejects.toThrow("source_changed");
    expect(f.receipts.size).toBe(0); expect(confirm).not.toHaveBeenCalled(); expect(f.onCommitted).not.toHaveBeenCalled();
    expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  test("source revoke consumes the real owner approval in the same fenced transaction, not a file absence", async () => {
    const f = await fixture();
    const observed = await f.helper.port.execute(f.context({ kind: "source_reconcile", sourceId: "docs" }));
    const review = await f.owner(() => f.hostControl.capability.revokeSourceAttestation({ sourceId: "docs", sourceRevision: observed.sourceSnapshotHash!,
      expectedRevision: 0, idempotencyKey: "review-source", operationIdempotencyKey: "revoke-source", expiresAt: Date.now() + 60000 }));
    f.calls.length = 0;
    const result = await f.helper.port.execute(f.context({ kind: "source_revoke", sourceId: "docs", expectedRevision: observed.sourceSnapshotHash!, reviewReceiptId: review.id }, "revoke-source"));
    expect(result).toMatchObject({ status: "completed", affectedMemoryIds: [] });
    expect(f.dispositions.get("")?.disposition).toBe("revoked"); expect(f.reviews.get(review.id)?.consumed_by).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.filter(sql => sql === "BEGIN")).toHaveLength(1);
    expect(f.calls.some(sql => sql.includes("evolution:host-administrative-consume"))).toBe(true);
    expect(f.calls.at(-1)).toBe("COMMIT");
  });
  test("native undo previews actual state, binds owner approval, and invokes the canonical administrative writer", async () => {
    const f = await fixture();
    await expect(f.helper.governance.previewUndo({ operationReceiptId: f.operation.id })).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(f.query).not.toHaveBeenCalled();
    const preview = await f.owner(() => f.helper.governance.previewUndo({ operationReceiptId: f.operation.id }));
    expect(preview.currentStateHash).toBe(f.operation.currentStateHash);
    const review = await f.owner(() => f.helper.governance.approveUndo({ operationReceiptId: f.operation.id, currentStateHash: preview.currentStateHash,
      expectedRevision: 0, idempotencyKey: "review-undo", operationIdempotencyKey: "undo", expiresAt: Date.now() + 60000 }));
    f.calls.length = 0;
    const result = await f.helper.port.execute(f.context({ kind: "undo_governance", operationReceiptId: f.operation.id,
      currentStateHash: preview.currentStateHash, reviewReceiptId: review.id }, "undo"));
    expect(result).toMatchObject({ status: "completed", affectedMemoryIds: f.operation.memoryIds });
    expect(f.reviews.get(review.id)?.consumed_by).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.some(sql => sql.includes("evolution:undo-restore-row"))).toBe(true);
    expect(f.calls.some(sql => sql.includes("evolution:undo-receipt"))).toBe(true);
    expect(f.calls.at(-1)).toBe("COMMIT"); expect(f.onCommitted).toHaveBeenCalledExactlyOnceWith(f.operation.memoryIds);
  });
  test("manifest failure after a true commit reports its receipt and does not pretend no write occurred", async () => {
    const f = await fixture();
    vi.spyOn(DirectorySourceScanner.prototype, "confirm").mockRejectedValueOnce(new Error("host disk write failed"));
    const result = await f.helper.port.execute(f.context({ kind: "source_reconcile", sourceId: "docs" }));
    expect(result).toMatchObject({ status: "partial", sourceManifestConfirmed: false, reasons: ["source_manifest_confirmation_failed"] });
    expect([...f.receipts.values()].some(row => (row.receipt as { receiptId: string }).receiptId === result.receiptId)).toBe(true);
    expect(f.onCommitted).toHaveBeenCalledTimes(1);
  });
  test("missing administrative review has a finite reason and never restores a target", async () => {
    const f = await fixture();
    await expect(f.helper.port.execute(f.context({ kind: "undo_governance", operationReceiptId: f.operation.id,
      currentStateHash: f.operation.currentStateHash, reviewReceiptId: "missing" }, "undo"))).rejects.toThrow("host_state_administrative_review_missing");
    expect(f.calls.some(sql => sql.includes("evolution:undo-restore-row"))).toBe(false);
    expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
  test("the real durable entry prepares, leases and executes native reconciliation without a model or injected execution port", async () => {
    const f = await fixture(), queued: DurableJobV2[] = [];
    const createScanner = vi.spyOn(DirectorySourceScanner, "create"), scan = vi.spyOn(DirectorySourceScanner.prototype, "scan"),
      verify = vi.spyOn(DirectorySourceScanner.prototype, "verifySnapshot"), budget = vi.spyOn(controlBudget, "budgetEvolutionControlPool");
    vi.spyOn(f.bundle.repository, "enqueue").mockImplementation(async request => {
      const job = createDurableJobV2(request, { now: Date.now(), registry: createDurableJobHandlerRegistry(f.bundle.handlerTypes) }); queued.push(job); return job;
    });
    const llm = new NullLlmClient(), complete = vi.spyOn(llm, "complete");
    const runtime = createEvolutionRuntime({ runtimeBundle: f.bundle, authority, scope, config: f.config, llmClient: llm,
      kernelDependencies: () => ({} as Omit<MemoryWriteKernelDependencies, "transaction">), onCommitted: f.onCommitted });
    const prepared = await f.owner(() => runtime.capability.control!.run({ input: { mode: "control", work: { kind: "source_reconcile", sourceId: "docs" } },
      action: "execute_control", idempotencyKey: "worker-source", limits: { maxBytes: 120000 } }));
    expect(prepared).toMatchObject({ status: "queued", work: { kind: "source_reconcile" } });
    expect(f.receipts.size).toBe(0);
    const job = leaseDurableJobV2(queued[0], { now: Date.now(), owner: "worker", leaseMs: 30000, tokenFactory: () => "b".repeat(32) }).job;
    const report = await runtime.handler(job, { signal: new AbortController().signal, workerId: "worker" });
    expect(report).toMatchObject({ status: "completed", counts: { applied: 1 }, usage: { llmCalls: 0 },
      work: { kind: "source_reconcile", result: { sourceManifestConfirmed: true } } });
    expect(f.batches.get(prepared.batchId)?.controlResult?.receiptId).toMatch(/^[a-f0-9]{64}$/);
    expect(complete).not.toHaveBeenCalled(); expect(f.calls.some(sql => sql.includes("evolution:lease-release"))).toBe(true);
    const manifestBytes = createScanner.mock.calls[0][0].maxManifestBytes!;
    const scanBytes = scan.mock.calls[0][0]!.limits!.maxBytes!, verifyBytes = verify.mock.calls[0][1]!.maxBytes!;
    const sqlBytes = budget.mock.calls[0][1].maxBytes;
    expect({ manifestBytes, scanBytes, verifyBytes, sqlBytes }).toEqual({ manifestBytes: 20000, scanBytes: 20000, verifyBytes: 20000, sqlBytes: 20000 });
    expect(3 * manifestBytes + scanBytes + verifyBytes + sqlBytes).toBeLessThanOrEqual(120000);
    expect(scan.mock.calls[0][0]!.limits!.maxFiles! * 2).toBeLessThanOrEqual(f.batches.get(prepared.batchId)!.request.limits.maxFiles);
    const preview = await f.owner(() => runtime.capability.control!.previewUndo({ operationReceiptId: f.operation.id }));
    const undoReview = await f.owner(() => runtime.capability.control!.approveUndo({ operationReceiptId: preview.operationReceiptId,
      currentStateHash: preview.currentStateHash, expectedRevision: 0, idempotencyKey: "worker-undo-review",
      operationIdempotencyKey: "worker-undo", expiresAt: Date.now() + 60000 }));
    const runDbControl = async (work: EvolutionControlWork, idempotencyKey: string) => {
      const next = await f.owner(() => runtime.capability.control!.run({ input: { mode: "control", work }, action: "execute_control",
        idempotencyKey, limits: { maxFiles: 0 } }));
      const leased = leaseDurableJobV2(queued.at(-1)!, { now: Date.now(), owner: "worker", leaseMs: 30000, tokenFactory: () => "b".repeat(32) }).job;
      expect(await runtime.handler(leased, { signal: new AbortController().signal, workerId: "worker" })).toMatchObject({
        batchId: next.batchId, status: "completed", counts: { applied: 1 }, usage: { files: 0, llmCalls: 0 }, work: { kind: work.kind } });
    };
    await runDbControl({ kind: "undo_governance", operationReceiptId: preview.operationReceiptId, currentStateHash: preview.currentStateHash,
      reviewReceiptId: undoReview.id }, "worker-undo");
    const revision = f.batches.get(prepared.batchId)!.controlResult!.sourceSnapshotHash!;
    const revokeReview = await f.owner(() => runtime.capability.sourceControl!.revokeSourceAttestation({ sourceId: "docs", sourceRevision: revision,
      expectedRevision: 0, idempotencyKey: "worker-revoke-review", operationIdempotencyKey: "worker-revoke", expiresAt: Date.now() + 60000 }));
    await runDbControl({ kind: "source_revoke", sourceId: "docs", expectedRevision: revision, reviewReceiptId: revokeReview.id }, "worker-revoke");
    expect(complete).not.toHaveBeenCalled(); expect(queued).toHaveLength(3);
    expect(createScanner).toHaveBeenCalledTimes(1);
  });
  test("prepare binds only a registered source and rejects ordinary credentials before scanner or SQL access", async () => {
    const f = await fixture(), create = vi.spyOn(DirectorySourceScanner, "create");
    const request = { input: { mode: "control" as const, work: { kind: "source_reconcile" as const, sourceId: "docs" } }, action: "execute_control" as const, idempotencyKey: "owner" };
    await expect(f.helper.port.authorizePrepare(request)).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    await f.owner(() => f.helper.port.authorizePrepare(request));
    await expect(f.owner(() => f.helper.port.authorizePrepare({ ...request, input: { mode: "control", work: { kind: "source_reconcile", sourceId: "unregistered" } } }))).rejects.toThrow("source_not_registered");
    expect(create).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled();
  });
  test.each([
    ["max_files", { maxFiles: 1 }], ["max_bytes", { maxBytes: 255 }], ["max_records", { maxRecords: 1 }],
  ])("source scan fails before I/O with %s", async (reason, limits) => {
    const f = await fixture(), context = f.context({ kind: "source_reconcile", sourceId: "docs" });
    await expect(f.helper.port.execute({ ...context, limits: { ...context.limits, ...limits } })).rejects.toThrow(reason);
    expect(f.query).not.toHaveBeenCalled(); expect(f.receipts.size).toBe(0);
  });
  test("cancelled or mismatched batch contexts cannot reach a mutation", async () => {
    const f = await fixture(), context = f.context({ kind: "source_reconcile", sourceId: "docs" });
    await expect(f.helper.port.execute({ ...context, signal: AbortSignal.abort() })).rejects.toThrow();
    await expect(f.helper.port.execute({ ...context, batchId: "other" })).rejects.toThrow("control_job_required");
    expect(f.query).not.toHaveBeenCalled();
  });
  test("undo approval rejects mismatched hash; a changed target after approval cannot consume the receipt", async () => {
    const f = await fixture();
    const request = { operationReceiptId: f.operation.id, currentStateHash: f.operation.currentStateHash, expectedRevision: 0,
      idempotencyKey: "review-undo", operationIdempotencyKey: "undo", expiresAt: Date.now() + 60000 };
    await expect(f.owner(() => f.helper.governance.approveUndo({ ...request, currentStateHash: "f".repeat(64) }))).rejects.toThrow("undo_state_changed");
    expect(f.reviews.size).toBe(0);
    const review = await f.owner(() => f.helper.governance.approveUndo(request));
    f.target.content_hash = "d".repeat(64);
    f.calls.length = 0;
    await expect(f.helper.port.execute(f.context({ kind: "undo_governance", operationReceiptId: f.operation.id,
      currentStateHash: f.operation.currentStateHash, reviewReceiptId: review.id }, "undo"))).rejects.toThrow("undo_state_changed");
    expect(f.reviews.get(review.id)?.consumed_by).toBeUndefined();
    expect(f.calls.some(sql => sql.includes("evolution:undo-restore-row"))).toBe(false);
  });
  test("expired owner approval fails closed without restoring any target", async () => {
    const f = await fixture();
    const review = await f.owner(() => f.helper.governance.approveUndo({ operationReceiptId: f.operation.id, currentStateHash: f.operation.currentStateHash,
      expectedRevision: 0, idempotencyKey: "review-undo", operationIdempotencyKey: "undo", expiresAt: Date.now() + 60000 }));
    for (const row of f.states.values()) if (row.kind === "governance_undo") row.expires_at = Date.now() - 1;
    f.calls.length = 0;
    await expect(f.helper.port.execute(f.context({ kind: "undo_governance", operationReceiptId: f.operation.id,
      currentStateHash: f.operation.currentStateHash, reviewReceiptId: review.id }, "undo"))).rejects.toThrow("host_state_administrative_review_mismatch");
    expect(f.calls.some(sql => sql.includes("evolution:undo-restore-row"))).toBe(false);
    expect(f.calls.at(-1)).toBe("ROLLBACK");
  });
});
