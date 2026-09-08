import { describe, expect, it, vi } from "vitest";
import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { cleanupMaintenance, recordMaintenanceOutcome } from "./retention.js";
import { applyEquivalentMerge, planEquivalentMerge } from "./merge.js";
import type { EquivalentClaim, MaintenanceRetentionPort, RetentionCandidate } from "./types.js";

const scope = { tenantId: "t", appId: "a", userId: "u", projectId: "p", agentId: "g", namespace: "n", visibility: "private" as const };
const lease = { batchId: "b", scopeFingerprint: authorityScopeFingerprint(scope), ownerId: "w", fencingToken: 1, expiresAt: 9999999999999 };
const claim = (memoryId: string, extra: Partial<EquivalentClaim> = {}): EquivalentClaim => ({ memoryId, revision: 1, contentHash: "a".repeat(64), scope,
  subject: "project", predicate: "uses", object: "server-a", applicability: ["production", "after approval"], polarity: "positive",
  verificationReceiptId: "verified-field-extraction", evidenceRootIds: ["root-a"], confidence: 0.7, ...extra });

describe("bounded maintenance governance", () => {
  it("aggregates identical failures without raw text and uses stable event idempotency", async () => {
    const rows = new Map<string, Set<string>>();
    const recordOutcome = vi.fn(async (input: Parameters<MaintenanceRetentionPort["recordOutcome"]>[0]) => {
      const row = rows.get(input.fingerprint) ?? new Set<string>();
      row.add(input.eventId); rows.set(input.fingerprint, row);
    });
    const outcome = { scope, workId: "w", inputFingerprint: "input-v1", policyVersion: "p1", outcome: "failed" as const, reasonCode: "model_timeout", at: 100 };
    await recordMaintenanceOutcome({ recordOutcome }, outcome, { attemptId: "one", failureCount: 1 });
    await recordMaintenanceOutcome({ recordOutcome }, outcome, { attemptId: "one", failureCount: 1 });
    await recordMaintenanceOutcome({ recordOutcome }, { ...outcome, at: 200 }, { attemptId: "two", failureCount: 2 });
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].size).toBe(2);
    expect(recordOutcome.mock.calls[2][0].retryAfter).toBeGreaterThan(recordOutcome.mock.calls[0][0].retryAfter);
    await recordMaintenanceOutcome({ recordOutcome }, { ...outcome, inputFingerprint: "input-v2" }, { attemptId: "three", failureCount: 0 });
    expect(rows.size).toBe(2);
    await expect(recordMaintenanceOutcome({ recordOutcome }, { ...outcome, reasonCode: "raw secret error\ntext" }, { attemptId: "x", failureCount: 0 })).rejects.toThrow("outcome");
  });

  it("invokes actual reference-aware cleanup, keeps referenced/stale items and obeys TTL", async () => {
    const rows: RetentionCandidate[] = ["free", "support", "stale"].map(id => ({ id, revision: "1", kind: "orphan_evidence", expiresAt: 100 }));
    rows.push({ id: "future", revision: "1", kind: "temporary_artifact", expiresAt: 201 });
    const cleanupUnreferenced = vi.fn(async ({ candidate }: { candidate: RetentionCandidate }) => ({ status: candidate.id === "support" ? "referenced" as const : candidate.id === "stale" ? "stale" as const : "deleted" as const, receiptId: "receipt" }));
    const result = await cleanupMaintenance({ scope, lease, now: 200, limit: 4, port: { listExpired: vi.fn(async () => rows), cleanupUnreferenced } });
    expect(result.deleted).toEqual(["free"]);
    expect(result.preserved).toEqual(["support", "stale"]);
    expect(cleanupUnreferenced).toHaveBeenCalledTimes(3);
  });

  it("fails closed on overflow, unsafe categories, budget/busy/cancellation and scope mismatch", async () => {
    const listExpired = vi.fn(async () => [{ id: "audit", revision: "1", kind: "audit_receipt" as RetentionCandidate["kind"], expiresAt: 1 }]);
    const cleanupUnreferenced = vi.fn();
    const input = { scope, lease, now: 200, limit: 1, port: { listExpired, cleanupUnreferenced } };
    expect((await cleanupMaintenance({ ...input, foregroundBusy: true })).reason).toBe("foreground_busy");
    expect(listExpired).not.toHaveBeenCalled();
    await cleanupMaintenance(input);
    expect(cleanupUnreferenced).not.toHaveBeenCalled();
    await expect(cleanupMaintenance({ ...input, lease: { ...lease, scopeFingerprint: "wrong" } })).rejects.toThrow("scope");
    await expect(cleanupMaintenance({ ...input, limit: 0 })).rejects.toThrow("limit");
    expect((await cleanupMaintenance({ ...input, signal: AbortSignal.abort() })).reason).toBe("cancelled");
  });

  it("merges only proven exact conditions, keeps aliases, and never boosts confidence", async () => {
    const a = claim("a", { confidence: 0.6 });
    const b = claim("b", { applicability: ["after approval", "production"], confidence: 0.9 });
    const result = planEquivalentMerge(a, b);
    expect(result.status).toBe("allowed");
    if (result.status !== "allowed") throw new Error("not allowed");
    expect(result.plan).toMatchObject({ canonical: { memoryId: "a" }, confidenceCeiling: 0.6, preserveAliases: true });
    expect(planEquivalentMerge(b, a)).toEqual(result);
    const mergeEquivalent = vi.fn(async () => ({ receiptId: "atomic-merge" }));
    expect(await applyEquivalentMerge({ port: { mergeEquivalent }, left: a, right: b, lease })).toMatchObject({ status: "applied", receiptId: "atomic-merge" });
    expect(mergeEquivalent).toHaveBeenCalledTimes(1);
  });

  it.each([
    { applicability: ["staging"] }, { polarity: "negative" as const }, { validTo: 1 },
    { scope: { ...scope, sessionId: "other" } }, { object: "server-b" }, { confidence: NaN },
    { verificationReceiptId: undefined }, { evidenceRootIds: [] }, { blocked: true },
  ])("holds uncertain or non-equivalent pairs for review: %j", async extra => {
    const mergeEquivalent = vi.fn();
    const result = await applyEquivalentMerge({ port: { mergeEquivalent }, left: claim("a"), right: claim("b", extra), lease });
    expect(result.status).toBe("review");
    expect(mergeEquivalent).not.toHaveBeenCalled();
  });
});
