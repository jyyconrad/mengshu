import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { recordToMemoryEntry } from "../../../packages/core/src/domain/legacy-mapping.js";
import { parseEvolutionGovernanceRequest } from "../../../packages/api/src/evolution-control.js";
import type { publicEvolutionReview } from "../../../packages/api/src/evolution-review.js";
import { LlmEvolutionProposer } from "../../../packages/core/src/evolution/proposer.js";
import { parseEvolutionProposal } from "../../../packages/core/src/evolution/schema.js";
import { evolutionGovernanceSnapshotHash, evolutionGovernanceState } from "../../../packages/core/src/evolution/postgres-governance-state.js";
import { EVOLUTION_MEMORY_COLUMNS_SQL, EVOLUTION_MEMORY_SCOPE_SQL } from "../../../packages/core/src/evolution/postgres-inventory.js";
import { scopeParams } from "../../../packages/core/src/evolution/postgres-common.js";
import { writeEvolutionLink } from "../../../packages/core/src/evolution/governed-metadata.js";
import { readManifest } from "../../../packages/core/src/evolution/sources/manifest.js";
import type { EvolutionBatchReport, EvolutionControlRequest, EvolutionControlWork, EvolutionReviewReceipt } from "../../../packages/core/src/evolution/types.js";
import { evolutionJobIdentity } from "../../../server/evolution-job.js";
import { CONTROLLED_NATIVE_SOURCE, openNativeRolloutRuntime } from "./native-runtime.js";
import { createPostgresRolloutSeed } from "./postgres.js";
import { safeNativeBatchDiagnostic } from "./startup-diagnostics.js";

export const NATIVE_CONTROL_SOURCE_ID = "rollout-native-source";
export function nativeControlRequest(work: EvolutionControlWork, idempotencyKey: string): EvolutionControlRequest {
  return parseEvolutionGovernanceRequest("control/run", { input: { mode: "control", work }, action: "execute_control", idempotencyKey,
    limits: { maxRecords: 1000, maxFiles: work.kind === "source_reconcile" ? 12 : 0, maxBytes: 1_000_000, maxDurationMs: 60_000 } }) as EvolutionControlRequest;
}
const CONTROL_REASONS = new Set(["control_capability_unavailable", "control_operation_failed", "control_job_required",
  "source_not_registered", "source_scan_partial", "source_manifest_confirmation_failed", "source_revision_stale", "source_revoked",
  "source_receipt_conflict", "source_relation_limit", "undo_state_changed", "undo_receipt_unavailable", "undo_source_revoked",
  "undo_idempotency_conflict", "host_state_administrative_review_missing", "host_state_administrative_review_mismatch"]);
export function safeNativeControlDiagnostic(report: EvolutionBatchReport, proposals?: unknown): string {
  const base = JSON.parse(safeNativeBatchDiagnostic(report, proposals));
  base.reasons = report.reasons.slice(0, 8).map((reason, index) => CONTROL_REASONS.has(reason) ? reason : base.reasons[index]);
  return JSON.stringify({ ...base, work: { kind: ["source_reconcile", "source_revoke", "undo_governance"].includes(report.work?.kind ?? "")
    ? report.work!.kind : "unknown_work", receiptPresent: /^[a-f0-9]{64}$/.test(report.work?.result?.receiptId ?? ""),
    manifestConfirmed: report.work?.result?.sourceManifestConfirmed === true } });
}
export const receiptIdHash = (id: string) => createHash("sha256").update(id).digest("hex");

/** Uses the frozen native fixture. Only bounded reads and explicitly synthetic setup are added here. */
export async function openNativeControl() {
  const h = await openNativeRolloutRuntime(CONTROLLED_NATIVE_SOURCE, { modelTransport: "controlled_synthetic" });
  const pool = h.persistence.repository.pool;
  const manifestPath = join(dirname(dirname(h.sourcePath)), "state", "evolution", "sources", h.scopeFingerprint, NATIVE_CONTROL_SOURCE_ID, "manifest.json");
  const memory = async (id: string) => {
    const row = (await pool.query(`SELECT ${EVOLUTION_MEMORY_COLUMNS_SQL} FROM memories WHERE ${EVOLUTION_MEMORY_SCOPE_SQL} AND id::text=$10`, [...scopeParams(h.scope), id])).rows[0];
    if (!row) throw new Error("control_fixture_memory_missing");
    return row;
  };
  const job = async (batch: EvolutionBatchReport) => (await pool.query(
    "SELECT type,status,attempts,payload->'control' AS control FROM mengshu_jobs_v2 WHERE id=$1",
    [evolutionJobIdentity(h.scope, batch.batchId, batch.segment?.attempt ?? 1).id])).rows[0];
  return { ...h, pool, memory, job,
    manifest: () => readManifest(manifestPath, 2 * 1024 * 1024),
    async effects() {
      return (await pool.query(`SELECT
        (SELECT count(*)::int FROM mengshu_evolution_batches) AS batches,
        (SELECT count(*)::int FROM mengshu_jobs_v2) AS jobs,
        (SELECT count(*)::int FROM mengshu_candidates) AS candidates,
        (SELECT count(*)::int FROM memories) AS memories,
        (SELECT count(*)::int FROM mengshu_evolution_source_dispositions) AS dispositions,
        (SELECT count(*)::int FROM mengshu_evolution_operation_receipts) AS operations,
        (SELECT count(*)::int FROM mengshu_evolution_apply_receipts) AS applies,
        (SELECT count(*)::int FROM mengshu_evolution_host_state) AS host_states,
        (SELECT count(*)::int FROM mengshu_evolution_host_receipts) AS host_receipts,
        (SELECT count(*)::int FROM mengshu_write_outbox) AS outbox`)).rows[0];
    },
    async sourceState() {
      return (await pool.query("SELECT revision,disposition,receipt_id FROM mengshu_evolution_source_dispositions WHERE scope_fingerprint=$1 AND source_id=$2 AND logical_file_id=''",
        [h.scopeFingerprint, NATIVE_CONTROL_SOURCE_ID])).rows[0];
    },
    async operationReceipt(receiptId: string) {
      return (await pool.query("SELECT operation,receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND (receipt->>'receiptId'=$2 OR receipt->>'id'=$2)",
        [h.scopeFingerprint, receiptId])).rows[0];
    },
    async consumption(receiptId: string) {
      return (await pool.query("SELECT consumed_by,consumed_at FROM mengshu_evolution_host_receipts WHERE scope_fingerprint=$1 AND receipt_id=$2", [h.scopeFingerprint, receiptId])).rows[0];
    },
    async waitControl(queued: EvolutionBatchReport) {
      const result = await h.waitBatch(queued.batchId);
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const actual = await job(result);
        if (actual && !["queued", "running"].includes(String(actual.status))) return result;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`control_fixture_worker_completion_timeout:${safeNativeControlDiagnostic(result)}`);
    },
    async seed(withSourceRelation = false) {
      const vector = Array.from({ length: h.runtime.embeddingSpace.fingerprint.dim }, (_, index) => index === 0 ? 1 : 0);
      const seed = createPostgresRolloutSeed(CONTROLLED_NATIVE_SOURCE, { embeddingSpaceId: h.runtime.embeddingSpace.embeddingSpaceId, vector },
        { scope: h.scope, sourceId: NATIVE_CONTROL_SOURCE_ID });
      await h.provider.store([recordToMemoryEntry(seed.raw), recordToMemoryEntry(seed.canonical)]);
      if (withSourceRelation) {
        const evidence = (await h.readUnsignedSource()).evidence[0];
        if (evidence.trust !== "untrusted") throw new Error("control_fixture_requires_untrusted_source");
        await h.persistence.repository.mutation(client => writeEvolutionLink(client, { scope: h.scope, scopeFingerprint: h.scopeFingerprint,
          memoryId: seed.id, evidenceId: seed.rawId, now: Date.now(), state: "reviewed_reference", sourceKind: "untrusted",
          rootId: evidence.rootEvidenceId, sourceId: evidence.sourceId, sourceRevision: evidence.revision, sourceHash: evidence.snapshotHash,
          sourceRecordId: evidence.id, sourceLocator: evidence.locator }));
      }
      return seed;
    },
    async governanceHash(id: string) { return evolutionGovernanceSnapshotHash([evolutionGovernanceState(await memory(id))], []); },
  };
}
export type NativeControl = Awaited<ReturnType<typeof openNativeControl>>;

/** Precondition only: fixed synthetic metadata suggestion, actual default review/worker/governed writer. */
export async function prepareNativeRevalidation(h: NativeControl, memoryId: string) {
  const proposer = vi.spyOn(LlmEvolutionProposer.prototype, "propose");
  const previous = proposer.getMockImplementation(), previousCalls = proposer.mock.calls.length;
  proposer.mockImplementation(async unit => {
    const evidence = unit.evidence.filter(source => source.origin === "external");
    if (unit.targets.length !== 1 || unit.targets[0].memoryId !== memoryId || evidence.length !== 1 ||
        evidence[0].trust !== "untrusted" || evidence[0].text !== CONTROLLED_NATIVE_SOURCE) throw new Error("control_fixture_revalidation_input_mismatch");
    return parseEvolutionProposal({ operation: "revalidate", claimClass: "fact", reasonCode: "unchanged",
      targetRefs: unit.targets.map(({ memoryId, expectedRevision, beforeHash }) => ({ memoryId, expectedRevision, beforeHash })),
      quotes: [{ evidenceId: evidence[0].id, quote: evidence[0].text, start: 0, end: evidence[0].text.length }] });
  });
  try {
    const limits = { maxRecords: 100, maxFiles: 5, maxBytes: 1_000_000, maxLlmCalls: 1, maxInputTokens: 16_000, maxOutputTokens: 1000, maxDurationMs: 45_000 };
    const queued = await h.capability.run({ input: { mode: "inventory", selection: "baseline" }, action: "propose", limits, idempotencyKey: "control-setup-revalidate" });
    const proposed = await h.waitBatch(queued.batchId), proposals = (await h.proposals(proposed.batchId)).proposals;
    if (proposals.length !== 1 || proposed.counts.review !== 1 || proposer.mock.calls.length - previousCalls !== 1) throw new Error(`control_fixture_proposal_failed:${safeNativeBatchDiagnostic(proposed, proposals)}`);
    const preview = await h.control("review/preview", { proposalId: proposals[0].id });
    if (preview.status !== 200) throw new Error("control_fixture_review_preview_failed");
    const review = preview.body as ReturnType<typeof publicEvolutionReview>;
    if (review.targets.length !== 1 || review.targets[0].memoryId !== memoryId || review.proposal.operation !== "revalidate" ||
        !review.proposal.quotes.every(quote => quote.quote === CONTROLLED_NATIVE_SOURCE) ||
        !review.evidence.every(source => source.trust === "untrusted")) throw new Error("control_fixture_owner_source_diff_mismatch");
    const decision = await h.control("review/decide", { reviewId: review.id, expectedBindingHash: review.bindingHash, decision: "approve", idempotencyKey: "control-setup-owner-review" });
    if (decision.status !== 200) throw new Error("control_fixture_owner_review_failed");
    const response = await h.control("review/apply", { approvalReceiptId: (decision.body as EvolutionReviewReceipt).id });
    if (response.status !== 200) throw new Error("control_fixture_approved_enqueue_failed");
    const applied = await h.waitBatch((response.body as EvolutionBatchReport).batchId), items = (await h.proposals(applied.batchId)).proposals;
    if (applied.status !== "completed" || applied.counts.applied !== 1 || applied.usage.llmCalls !== 0) throw new Error(`control_fixture_metadata_apply_failed:${safeNativeBatchDiagnostic(applied, items)}`);
    const written = items.find(item => item.status === "applied");
    const receipt = (await h.pool.query("SELECT receipt FROM mengshu_evolution_operation_receipts WHERE scope_fingerprint=$1 AND operation='revalidate' AND receipt->>'proposalId'=$2",
      [h.scopeFingerprint, written?.id])).rows[0]?.receipt as { id: string; currentStateHash: string } | undefined;
    if (!receipt || !/^[a-f0-9]{64}$/.test(receipt.id)) throw new Error("control_fixture_metadata_receipt_missing");
    return { receipt, setupProposalCalls: proposer.mock.calls.length - previousCalls };
  } finally { if (previous) proposer.mockImplementation(previous); else proposer.mockRestore(); }
}
