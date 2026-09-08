import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { DirectorySourceScanner } from "./scanner.js";
import { planSourceReconciliation, reconcileSourceScan, revokeSource } from "./reconciliation.js";
import type { SourceReconciliationPort } from "./reconciliation-types.js";

const scope = { tenantId: "t", appId: "a", userId: "u", projectId: "p", agentId: "g", namespace: "n", visibility: "private" as const };
const lease = { batchId: "b", scopeFingerprint: authorityScopeFingerprint(scope), ownerId: "worker", fencingToken: 1, expiresAt: 9999999999999 };
const line = (id: string, text: string) => JSON.stringify({ type: "response_item", payload: {
  type: "message", id, role: "user", content: [{ type: "input_text", text }],
} }) + "\n";
let temp: string;
let scanner: DirectorySourceScanner;
let port: SourceReconciliationPort;
beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), "source-reconcile-"));
  await mkdir(join(temp, "input"));
  scanner = await DirectorySourceScanner.create({ binding: { sourceId: "s", root: join(temp, "input"), scope, parser: "auto" }, manifestPath: join(temp, "state", "manifest.json") });
  port = { reconcile: vi.fn(async ({ plan, verifySource }) => {
    if (!(await verifySource()).valid) throw new Error("source_drift");
    return { receiptId: plan.id, sourceSnapshotHash: plan.snapshotHash, recordIds: plan.recordIds };
  }), revoke: vi.fn(async () => ({ receiptId: "revoked", affectedMemoryIds: ["m"], suppressed: true as const })) };
});
afterEach(async () => { await scanner?.close(); await rm(temp, { recursive: true, force: true }); });
const scan = () => reconcileSourceScan({ scanner, port, lease });

describe("source support reconciliation", () => {
  it("commits changed/deleted current spans with historical preservation before manifest confirmation", async () => {
    const path = join(temp, "input", "note.md");
    await writeFile(path, "# Policy\n\nUse A.\n\nKeep backups.\n");
    await scan();
    await writeFile(path, "# Policy\n\nUse B.\n");
    const result = await scan();
    const event = result.plan.events.find(e => e.kind === "supersede_spans");
    expect(event?.spanIds).toHaveLength(2);
    expect(event).toMatchObject({ preserveHistoricalEvidence: true, requestReview: true, semantics: "current_document" });
    expect(port.revoke).not.toHaveBeenCalled();
    expect((await scan()).plan.events.some(e => e.kind === "supersede_spans")).toBe(false);
  });

  it("unavailable requests review and preserves support, never synthesizes revoke", async () => {
    const path = join(temp, "input", "note.md");
    await writeFile(path, "Keep backups.\n");
    await scan();
    await rm(path);
    const result = await scan();
    expect(result.plan.events).toEqual([expect.objectContaining({ kind: "source_unavailable", preserveHistoricalEvidence: true, requestReview: true, spanIds: [] })]);
    expect(port.revoke).not.toHaveBeenCalled();
  });

  it("partial enumeration never declares whole-source file loss", async () => {
    const path = join(temp, "input", "note.md");
    await writeFile(path, "First.\n\nSecond.\n");
    await scan();
    await rm(path);
    const report = await scanner.scan({ limits: { maxEntries: 1 } });
    report.enumerationComplete = false;
    report.status = "partial";
    const plan = planSourceReconciliation(scope, report);
    expect(plan.events).toEqual([]);
  });

  it.each([{ maxFiles: 1 }, { maxEntries: 1 }])("retires a completed file's removed spans before confirming a globally partial scan: %j", async limits => {
    const supports = new Set<string>();
    port.reconcile = vi.fn(async ({ plan, verifySource }) => {
      if (!(await verifySource()).valid) throw new Error("source_drift");
      for (const record of plan.records) supports.add(record.spanOrEventId);
      for (const event of plan.events) if (event.kind === "supersede_spans") for (const id of event.spanIds) supports.delete(id);
      return { receiptId: plan.id, sourceSnapshotHash: plan.snapshotHash, recordIds: plan.recordIds };
    });
    await writeFile(join(temp, "input", "a.md"), "Old A.\n\nKeep A.\n");
    await writeFile(join(temp, "input", "b.md"), "Old B.\n\nKeep B.\n");
    const initial = await scan();
    const firstPath = initial.report.files[0].relativePath;
    const removed = initial.report.records.find(record => record.relativePath === firstPath && record.quote.startsWith("Old "))!;
    const retained = initial.report.records.find(record => record.relativePath === firstPath && record.quote.startsWith("Keep "))!;
    await writeFile(join(temp, "input", firstPath), `${retained.quote}\n`);
    const first = await reconcileSourceScan({ scanner, port, lease, scanOptions: { limits } });
    expect(first.report.enumerationComplete).toBe(false);
    expect(first.report.files[0].status).toBe("changed");
    expect(first.report.records).toHaveLength(0);
    expect(first.plan.events).toContainEqual(expect.objectContaining({ kind: "supersede_spans", spanIds: [removed.spanOrEventId] }));
    expect(first.plan.events.some(event => event.kind === "source_unavailable")).toBe(false);
    expect(supports.has(removed.spanOrEventId)).toBe(false);
    const manifest = JSON.parse(await readFile(join(temp, "state", "manifest.json"), "utf8"));
    expect(manifest.files[removed.pathId].spans[removed.spanOrEventId]).toBeUndefined();
    // Abandon the cursor, as a later batch/restart can. The first receipt already retired support.
    const second = await reconcileSourceScan({ scanner, port, lease, scanOptions: { limits } });
    expect(second.report.files[0].status).toBe("unchanged");
    expect(second.plan.events.some(event => event.kind === "supersede_spans")).toBe(false);
    expect(supports.has(removed.spanOrEventId)).toBe(false);
  });

  it("does not retire spans from a partial file and retains them for the next complete scan", async () => {
    const path = join(temp, "input", "note.md");
    await writeFile(path, "Old assertion.\n\nKeep assertion.\n");
    const initial = await scan();
    const removed = initial.report.records.find(record => record.quote === "Old assertion.")!;
    await writeFile(path, "First replacement.\n\nSecond replacement.\n\nKeep assertion.\n");
    const partial = await reconcileSourceScan({ scanner, port, lease, scanOptions: { limits: { maxRecords: 1 } } });
    expect(partial.report.files[0].status).toBe("partial");
    expect(partial.report.files[0].removedSpanIds).toEqual([]);
    expect(partial.plan.events.some(event => event.kind === "supersede_spans")).toBe(false);
    const manifest = JSON.parse(await readFile(join(temp, "state", "manifest.json"), "utf8"));
    expect(manifest.files[removed.pathId].spans[removed.spanOrEventId]).toBeDefined();
    const complete = await scan();
    expect(complete.plan.events).toContainEqual(expect.objectContaining({ kind: "supersede_spans", spanIds: [removed.spanOrEventId] }));
  });

  it("append preserves history; rewritten native event is not a new independent source", async () => {
    const path = join(temp, "input", "session.jsonl");
    await writeFile(path, line("one", "Use A."));
    const first = await scan();
    await appendFile(path, line("two", "Keep backups."));
    expect((await scan()).plan.events.some(e => e.kind === "history_revised")).toBe(false);
    await writeFile(path, line("one", "Use B.") + line("two", "Keep backups."));
    const rewritten = await scan();
    expect(rewritten.plan.events).toContainEqual(expect.objectContaining({ kind: "history_revised", spanIds: [first.report.records[0].spanOrEventId], preserveHistoricalEvidence: true }));
    expect(rewritten.plan.records[0].continuityKey).toBe(first.plan.records[0].continuityKey);
    expect(rewritten.plan.records[0].rootEvidenceId).not.toBe(first.plan.records[0].rootEvidenceId);
    expect(JSON.stringify(rewritten.plan)).not.toContain("Use B.");
  });

  it("truncation marks rotation without deleting historical assertions", async () => {
    const path = join(temp, "input", "session.jsonl");
    await writeFile(path, line("one", "Use A.") + line("two", "Keep backups."));
    await scan();
    await writeFile(path, line("three", "Check."));
    const result = await scan();
    expect(result.plan.events).toContainEqual(expect.objectContaining({ kind: "history_rotated", preserveHistoricalEvidence: true, requestReview: true }));
    expect(result.plan.events.some(e => e.kind === "supersede_spans")).toBe(false);
  });

  it("keeps known history semantics when a rotated file is emptied", async () => {
    const path = join(temp, "input", "session.jsonl");
    await writeFile(path, line("one", "Keep history."));
    await scan();
    await writeFile(path, "");
    const result = await scan();
    expect(result.plan.events).toContainEqual(expect.objectContaining({ kind: "history_rotated", semantics: "append_history" }));
    expect(result.plan.events.some(e => e.kind === "supersede_spans")).toBe(false);
  });

  it("charges repeated strong verification against one bounded byte allowance", async () => {
    const text = "Keep backups.\n";
    await writeFile(join(temp, "input", "note.md"), text);
    port.reconcile = vi.fn(async ({ plan, verifySource }) => {
      expect((await verifySource()).valid).toBe(true);
      expect((await verifySource()).valid).toBe(false);
      return { receiptId: "bad-provider", sourceSnapshotHash: plan.snapshotHash, recordIds: plan.recordIds };
    });
    await expect(reconcileSourceScan({ scanner, port, lease, verifyOptions: { maxBytes: Buffer.byteLength(text) } })).rejects.toThrow("verification_required");
    await expect(readFile(join(temp, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not checkpoint after a failed durable transaction or changed snapshot", async () => {
    const path = join(temp, "input", "note.md");
    await writeFile(path, "Use A.\n");
    port.reconcile = vi.fn(async ({ verifySource }) => {
      await writeFile(path, "Use B.\n");
      expect((await verifySource()).valid).toBe(false);
      throw new Error("source_drift");
    });
    await expect(scan()).rejects.toThrow("source_drift");
    await expect(readFile(join(temp, "state", "manifest.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects mismatched scope before reading or revoking; requires explicit review receipt", async () => {
    await expect(reconcileSourceScan({ scanner, port, lease: { ...lease, scopeFingerprint: "wrong" } })).rejects.toThrow("scope");
    await expect(revokeSource(port, { scope, sourceId: "s", expectedRevision: "r", reviewReceiptId: "", idempotencyKey: "k", lease })).rejects.toThrow("review");
    expect(port.revoke).not.toHaveBeenCalled();
    expect(await revokeSource(port, { scope, sourceId: "s", expectedRevision: "r", reviewReceiptId: "host-review", idempotencyKey: "k", lease })).toMatchObject({ suppressed: true });
    expect(port.revoke).toHaveBeenCalledTimes(1);
  });

  it("reference snapshot changes never supersede historical support", async () => {
    await scanner.close();
    scanner = await DirectorySourceScanner.create({ binding: { sourceId: "s", root: join(temp, "input"), scope, parser: "markdown", semantics: "reference_snapshot" }, manifestPath: join(temp, "state", "manifest.json") });
    await writeFile(join(temp, "input", "note.md"), "Use A.\n");
    await scan();
    await writeFile(join(temp, "input", "note.md"), "Use B.\n");
    const result = await scan();
    expect(result.plan.events.some(e => e.kind === "supersede_spans")).toBe(false);
    expect(result.plan.events.every(e => e.preserveHistoricalEvidence)).toBe(true);
  });
});
