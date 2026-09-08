import { join } from "node:path";
import type { AuthorityScope } from "../packages/core/src/domain/authority-scope.js";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { assertPostgresBundleOwnsEvolutionPersistence, type PostgresDurableJobV2RuntimeBundle, type PostgresEvolutionPersistence } from "../packages/core/src/db/providers/postgres.js";
import type { DurableJobV2 } from "../packages/core/src/storage/repositories/job-v2.js";
import { PostgresEvolutionError } from "../packages/core/src/evolution/postgres-common.js";
import { EvolutionError, parseEvolutionControlRequest } from "../packages/core/src/evolution/schema.js";
import type { EvolutionControlPort } from "../packages/core/src/evolution/types.js";
import { DirectorySourceScanner } from "../packages/core/src/evolution/sources/scanner.js";
import type { SourceCommitReceipt } from "../packages/core/src/evolution/sources/types.js";
import type { PostgresEvolutionAdministrativeReviewGuard } from "../packages/core/src/evolution/postgres-source-reconciliation.js";
import { reconcileSourceScan } from "../packages/core/src/evolution/sources/reconciliation.js";
import { evolutionHash } from "../packages/core/src/evolution/fingerprints.js";
import { assertEvolutionOwnerRequest } from "../packages/api/src/evolution-owner-auth.js";
import { parseEvolutionGovernanceRequest, type EvolutionGovernanceControlCapability, type EvolutionUndoApprovalRequest,
  type EvolutionUndoPreview, type EvolutionUndoPreviewRequest } from "../packages/api/src/evolution-control.js";
import type { EvolutionHostControl } from "./evolution-control.js";
import type { GlobalEvolutionConfig } from "./evolution-config.js";

/** Actual provider ports; no second scheduler, source manifest owner, or caller-supplied authority. */
export function createEvolutionControlWork(input: {
  runtimeBundle: PostgresDurableJobV2RuntimeBundle; persistence: PostgresEvolutionPersistence; job?: DurableJobV2;
  authority: AuthorityScope; scope: MemoryScope; config: GlobalEvolutionConfig; hostControl: EvolutionHostControl;
  manifestRoot: string; onCommitted: (memoryIds: readonly string[]) => void | Promise<void>; onWarning?: () => void;
}): { port: EvolutionControlPort; governance: Pick<EvolutionGovernanceControlCapability, "previewUndo" | "approveUndo"> } {
  const persistence = assertPostgresBundleOwnsEvolutionPersistence(input.runtimeBundle, input.persistence, input.scope, input.job);
  const scope = structuredClone(input.scope), scopeFingerprint = authorityScopeFingerprint(scope);
  const source = (sourceId: string) => {
    const binding = input.config.sources.find(source => source.sourceId === sourceId);
    if (!binding || authorityScopeFingerprint(binding.scope) !== scopeFingerprint) throw new EvolutionError("source_not_registered");
    return binding;
  };
  const notify = async (ids: readonly string[]) => { try { await input.onCommitted(ids); } catch { input.onWarning?.(); } };
  const administrativeReview: PostgresEvolutionAdministrativeReviewGuard = async (client, request) => {
    try { await input.hostControl.state.administrativeReviewGuard(client, request); }
    catch (error) {
      if (error instanceof EvolutionError) throw new PostgresEvolutionError(error.code);
      throw error;
    }
  };
  const failure = (caught: unknown): never => {
    if (caught instanceof PostgresEvolutionError) {
      const code = caught.code === "CONTROL_MAX_RECORDS" ? "max_records" : caught.code === "CONTROL_MAX_BYTES" ? "max_bytes" : caught.code.toLowerCase();
      throw new EvolutionError(/^[a-z][a-z0-9_]{0,79}$/.test(code) ? code : "control_operation_failed");
    }
    throw caught;
  };
  const previewUndo: EvolutionGovernanceControlCapability["previewUndo"] = async (value, signal) => {
    assertEvolutionOwnerRequest(input.authority); signal?.throwIfAborted();
    const request = parseEvolutionGovernanceRequest("control/undo-preview", value) as EvolutionUndoPreviewRequest;
    try {
      const preview = await persistence.createControlPorts({ limits: { maxRecords: 1000, maxBytes: 1_000_000 }, signal }).previewUndo(request);
      if (!["mark_disputed", "revalidate", "add_evidence", "merge_equivalent"].includes(preview.operation)) throw new EvolutionError("undo_receipt_unavailable");
      return { ...preview, operation: preview.operation as EvolutionUndoPreview["operation"], operationReceiptId: request.operationReceiptId };
    } catch (error) { return failure(error); }
  };
  return {
    governance: {
      previewUndo,
      approveUndo: async (value, signal) => {
        assertEvolutionOwnerRequest(input.authority); signal?.throwIfAborted();
        const request = parseEvolutionGovernanceRequest("control/undo-approve", value) as EvolutionUndoApprovalRequest;
        const current = await previewUndo({ operationReceiptId: request.operationReceiptId }, signal);
        if (current.currentStateHash !== request.currentStateHash) throw new EvolutionError("undo_state_changed");
        const binding = { operation: "undo_governance", scopeFingerprint,
          target: { operationReceiptId: request.operationReceiptId, currentStateHash: request.currentStateHash }, idempotencyKey: request.operationIdempotencyKey };
        const receipt = await input.hostControl.state.put({ kind: "governance_undo", id: evolutionHash(["evolution-undo-review-v1", request.operationReceiptId]),
          value: binding, expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey, expiresAt: request.expiresAt }, signal);
        if (receipt.kind !== "governance_undo" || receipt.operation !== "put") throw new EvolutionError("undo_review_receipt_invalid");
        return { id: receipt.id, kind: "governance_undo", entryId: receipt.entryId, operation: "put", revision: receipt.revision, valueHash: receipt.valueHash, createdAt: receipt.createdAt };
      },
    },
    port: {
      authorizePrepare: async value => {
        assertEvolutionOwnerRequest(input.authority);
        const request = parseEvolutionControlRequest(value);
        if (request.input.work.kind !== "undo_governance") source(request.input.work.sourceId);
      },
      execute: async context => {
        if (!input.job || input.job.payload.batchId !== context.batchId || context.lease.batchId !== context.batchId ||
            context.lease.scopeFingerprint !== scopeFingerprint || authorityScopeFingerprint(context.scope) !== scopeFingerprint) throw new EvolutionError("control_job_required");
        context.signal.throwIfAborted();
        const { work } = context.request.input;
        const options = { signal: context.signal, authorizeAdministrativeReview: administrativeReview };
        try {
          if (work.kind === "undo_governance") {
            const result = await persistence.createControlPorts({ ...options, limits: context.limits }).undo({
              operationReceiptId: work.operationReceiptId, currentStateHash: work.currentStateHash,
              reviewReceiptId: work.reviewReceiptId, idempotencyKey: context.request.idempotencyKey, lease: context.lease });
            await notify(result.restoredMemoryIds);
            return { status: "completed", receiptId: result.receiptId, affectedMemoryIds: result.restoredMemoryIds };
          }
          const binding = source(work.sourceId);
          if (work.kind === "source_revoke") {
            const result = await persistence.createControlPorts({ ...options, limits: context.limits }).source(binding.sourceId, input.config.configFingerprint).revoke({
              scope, sourceId: binding.sourceId, expectedRevision: work.expectedRevision, reviewReceiptId: work.reviewReceiptId,
              idempotencyKey: context.request.idempotencyKey, lease: context.lease });
            await notify(result.affectedMemoryIds);
            return { status: "completed", receiptId: result.receiptId, affectedMemoryIds: result.affectedMemoryIds };
          }
          // Reserve scan + verification + three manifest operations before assigning the SQL remainder.
          const files = Math.floor(context.limits.maxFiles / 2), bytes = Math.floor(context.limits.maxBytes / 6), records = Math.floor(context.limits.maxRecords / 2);
          if (files < 1) throw new EvolutionError("max_files");
          if (bytes < 256) throw new EvolutionError("max_bytes");
          if (records < 1) throw new EvolutionError("max_records");
          const scanner = await DirectorySourceScanner.create({ binding, manifestPath: join(input.manifestRoot, binding.sourceId, "manifest.json"),
            maxManifestBytes: Math.min(bytes, 2 * 1024 * 1024) });
          let committed: SourceCommitReceipt | undefined;
          try {
            const native = persistence.createControlPorts({ ...options, limits: { maxRecords: context.limits.maxRecords - records,
              maxBytes: context.limits.maxBytes - bytes * 5 } }).source(binding.sourceId, scanner.configFingerprint);
            const result = await reconcileSourceScan({ scanner, lease: context.lease,
              port: { revoke: value => native.revoke(value), reconcile: async value => {
                const receipt = await native.reconcile(value);
                committed = receipt;
                await notify([]);
                return receipt;
              } },
              scanOptions: { signal: context.signal, limits: { maxFiles: Math.min(files, 32), maxRecords: Math.min(records, 256),
                maxBytes: bytes, maxEntries: Math.min(records, 4096), maxDurationMs: context.limits.maxDurationMs,
                maxRecordBytes: Math.min(bytes, 65536), maxSnippetChars: 2048, maxContextChars: 256 } },
              verifyOptions: { signal: context.signal, maxBytes: bytes, maxDurationMs: Math.min(4000, context.limits.maxDurationMs) },
            });
            return { status: result.report.status === "complete" ? "completed" : "partial", receiptId: result.receipt.receiptId,
              sourceManifestConfirmed: true, sourceSnapshotHash: result.receipt.sourceSnapshotHash,
              ...(result.report.status === "partial" ? { reasons: ["source_scan_partial"] } : {}) };
          } catch (error) {
            if (!committed) throw error;
            return { status: "partial", receiptId: committed.receiptId, sourceManifestConfirmed: false,
              sourceSnapshotHash: committed.sourceSnapshotHash, reasons: ["source_manifest_confirmation_failed"] };
          } finally { await scanner.close(); }
        } catch (error) { return failure(error); }
      },
    },
  };
}
