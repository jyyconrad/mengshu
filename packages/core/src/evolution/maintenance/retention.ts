import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import { sha256, stableJson } from "../sources/shared.js";
import type { EvolutionLease } from "../types.js";
import type { MaintenanceOutcome, MaintenanceRetentionPort } from "./types.js";

const safeId = (value: string) => /^[^\s\p{Cc}]{1,512}$/u.test(value);
const HOUR = 3600000;

export async function recordMaintenanceOutcome(port: Pick<MaintenanceRetentionPort, "recordOutcome">,
  outcome: MaintenanceOutcome, attempt: { attemptId: string; failureCount: number }) {
  const scopeFingerprint = authorityScopeFingerprint(outcome.scope);
  if (!["failed", "rejected", "noop"].includes(outcome.outcome) || !/^[a-z][a-z0-9_]{0,79}$/.test(outcome.reasonCode) ||
      ![outcome.workId, outcome.inputFingerprint, outcome.policyVersion, attempt.attemptId].every(safeId) ||
      !Number.isSafeInteger(outcome.at) || outcome.at < 0 || !Number.isSafeInteger(attempt.failureCount) || attempt.failureCount < 0) throw new Error("invalid_maintenance_outcome");
  const fingerprint = sha256(stableJson({ scopeFingerprint, workId: outcome.workId, input: outcome.inputFingerprint,
    policy: outcome.policyVersion, outcome: outcome.outcome, reason: outcome.reasonCode }));
  const retryAfter = outcome.at + Math.min(7 * 24 * HOUR, HOUR * 2 ** Math.min(8, attempt.failureCount));
  if (!Number.isSafeInteger(retryAfter)) throw new Error("invalid_maintenance_outcome");
  const eventId = sha256(stableJson({ fingerprint, attemptId: attempt.attemptId }));
  // Explicit projection prevents accidental persistence of extra raw error/body fields from an adapter.
  await port.recordOutcome({ scope: { ...outcome.scope }, workId: outcome.workId, inputFingerprint: outcome.inputFingerprint,
    policyVersion: outcome.policyVersion, outcome: outcome.outcome, reasonCode: outcome.reasonCode, at: outcome.at,
    fingerprint, eventId, retryAfter });
  return { fingerprint, eventId, retryAfter };
}

export async function cleanupMaintenance(input: {
  scope: MemoryScope; lease: EvolutionLease; now: number; limit: number;
  port: Pick<MaintenanceRetentionPort, "listExpired" | "cleanupUnreferenced">;
  foregroundBusy?: boolean; signal?: AbortSignal;
}): Promise<{ deleted: string[]; preserved: string[]; reason?: string }> {
  if (authorityScopeFingerprint(input.scope) !== input.lease.scopeFingerprint) throw new Error("maintenance_scope_mismatch");
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100 || !Number.isSafeInteger(input.now) || input.now < 0) throw new Error("invalid_retention_limit");
  if (input.foregroundBusy || input.signal?.aborted) return { deleted: [], preserved: [], reason: input.foregroundBusy ? "foreground_busy" : "cancelled" };
  const expired = await input.port.listExpired({ scope: input.scope, before: input.now, limit: input.limit });
  if (expired.length > input.limit) return { deleted: [], preserved: [], reason: "retention_page_overflow" };
  const result: { deleted: string[]; preserved: string[]; reason?: string } = { deleted: [], preserved: [] };
  const kinds = new Set(["temporary_artifact", "rejected_proposal_body", "noop_proposal_body", "orphan_evidence"]);
  const seen = new Set<string>();
  for (const candidate of expired) {
    if (input.signal?.aborted) { result.reason = "cancelled"; break; }
    if (!kinds.has(candidate.kind) || !safeId(candidate.id) || !safeId(candidate.revision) ||
        !Number.isSafeInteger(candidate.expiresAt) || candidate.expiresAt < 0 || candidate.expiresAt > input.now || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const receipt = await input.port.cleanupUnreferenced({ scope: input.scope, candidate, lease: input.lease });
    if (receipt.status === "deleted") {
      if (!receipt.receiptId || !safeId(receipt.receiptId)) throw new Error("retention_receipt_required");
      result.deleted.push(candidate.id);
    } else result.preserved.push(candidate.id);
  }
  return result;
}
