import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import type { EvolutionLease } from "../types.js";
import type { DirectorySourceScanner } from "./scanner.js";
import { sha256, stableJson } from "./shared.js";
import type { SourceScanOptions, SourceScanReport, SourceVerifyOptions } from "./types.js";
import type { SourceReconciliationEvent, SourceReconciliationPlan, SourceReconciliationPort } from "./reconciliation-types.js";

/** Pure plan only. The caller/provider must bind this report to a host scanner and durable source CAS. */
export function planSourceReconciliation(scope: MemoryScope, report: SourceScanReport): SourceReconciliationPlan {
  const scopeHash = authorityScopeFingerprint(scope);
  if (report.files.length > 4096 || report.records.length > 10000 || report.sourceId !== report.snapshot.sourceId || report.configFingerprint !== report.snapshot.configFingerprint ||
      report.sourceSnapshotHash !== report.snapshot.hash || report.records.some(record =>
        record.sourceId !== report.sourceId || authorityScopeFingerprint(record.scope) !== scopeHash)) throw new Error("source_report_invalid");
  const events: SourceReconciliationEvent[] = [];
  for (const file of report.files) {
    if (file.status === "partial" || (file.status === "source_unavailable" && !report.enumerationComplete)) continue;
    const semantics = file.semantics ?? report.records.find(record => record.pathId === file.pathId)?.semantics;
    if (!semantics) throw new Error("source_semantics_missing");
    const base = { pathId: file.pathId, logicalFileId: file.logicalFileId, semantics,
      previousRevisionId: file.previousRevisionId, revisionId: file.revisionId, preserveHistoricalEvidence: true as const };
    if (file.status === "source_unavailable") {
      events.push({ ...base, kind: "source_unavailable", spanIds: [], requestReview: true });
      continue;
    }
    if (!file.revisionId) throw new Error("source_revision_missing");
    events.push({ ...base, kind: "observe_revision", spanIds: [], requestReview: false });
    if (semantics === "current_document" && file.removedSpanIds.length) {
      events.push({ ...base, kind: "supersede_spans", spanIds: [...new Set(file.removedSpanIds)].sort(), requestReview: true });
    }
    if (semantics === "append_history" && file.revisionChange === "rotation") {
      events.push({ ...base, kind: "history_rotated", spanIds: [], requestReview: true });
    }
    if (semantics === "append_history" && (file.revisionChange === "rewrite" || file.replacedSpanIds?.length)) {
      events.push({ ...base, kind: "history_revised", spanIds: [...new Set(file.replacedSpanIds ?? [])].sort(), requestReview: true });
    }
  }
  const body = { scope: structuredClone(scope), sourceId: report.sourceId, configFingerprint: report.configFingerprint,
    snapshotHash: report.sourceSnapshotHash, enumerationComplete: report.enumerationComplete,
    events: events.sort((a, b) => `${a.pathId}:${a.kind}`.localeCompare(`${b.pathId}:${b.kind}`)),
    recordIds: [...new Set(report.records.map(record => record.id))].sort(),
    records: report.records.map(record => ({ id: record.id, logicalFileId: record.logicalFileId, revisionId: record.revisionId,
      spanOrEventId: record.spanOrEventId, contentHash: record.contentHash, rootEvidenceId: record.rootEvidenceId,
      independenceGroupId: record.independenceGroupId,
      continuityKey: sha256(stableJson({ scope: scopeHash, source: report.sourceId, logicalFile: record.logicalFileId, event: record.spanOrEventId }))
    })).sort((a, b) => a.id.localeCompare(b.id)) };
  return { id: sha256(stableJson(body)), ...body };
}

export async function reconcileSourceScan(input: {
  scanner: DirectorySourceScanner; port: SourceReconciliationPort; lease: EvolutionLease;
  scanOptions?: SourceScanOptions; verifyOptions?: SourceVerifyOptions;
}) {
  const { scanner, port, lease } = input;
  if (authorityScopeFingerprint(scanner.binding.scope) !== lease.scopeFingerprint) throw new Error("source_scope_mismatch");
  const report = await scanner.scan(input.scanOptions);
  const plan = planSourceReconciliation(scanner.binding.scope, report);
  let verificationBytesRead = 0;
  let verified = false;
  const verificationLimit = input.verifyOptions?.maxBytes ?? 10 * 1024 * 1024;
  const verificationDuration = input.verifyOptions?.maxDurationMs ?? 300000;
  const verificationStarted = performance.now();
  const receipt = await port.reconcile({ plan: structuredClone(plan), lease, verifySource: async () => {
    const result = await scanner.verifySnapshot(report.snapshot, { ...input.verifyOptions,
      maxBytes: Math.max(0, verificationLimit - verificationBytesRead),
      maxDurationMs: Math.max(0, verificationDuration - Math.ceil(performance.now() - verificationStarted)) });
    verificationBytesRead += result.bytesRead;
    verified = result.valid;
    return result;
  } });
  if (!verified) throw new Error("source_verification_required");
  await scanner.confirm(report, receipt);
  return { report, plan, receipt, verificationBytesRead };
}

export async function revokeSource(port: SourceReconciliationPort, input: Parameters<SourceReconciliationPort["revoke"]>[0]) {
  if (authorityScopeFingerprint(input.scope) !== input.lease.scopeFingerprint) throw new Error("source_scope_mismatch");
  if ([input.sourceId, input.expectedRevision, input.reviewReceiptId, input.idempotencyKey].some(value =>
    !value.trim() || value.length > 512 || /[\p{Cc}]/u.test(value))) throw new Error("source_review_required");
  return port.revoke(input);
}
