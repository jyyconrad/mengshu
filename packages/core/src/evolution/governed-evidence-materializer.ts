import type { MemoryWriteKernel } from "../service/write-kernel.js";
import { fail, jsonHash } from "./postgres-common.js";
import type { PostgresEvolutionGovernedWriterOptions } from "./governed-writer.js";

/** The supplied kernel is host-owned and must use the same durable-job fence as the apply writer. */
export function createEvolutionRawEvidenceMaterializer(
  kernel: Pick<MemoryWriteKernel, "execute">,
): NonNullable<PostgresEvolutionGovernedWriterOptions["materializeEvidence"]> {
  return async ({ context, evidence, supportedEvidence }) => {
    const bindings = [];
    const ids = [...new Set(supportedEvidence.map((e) => e.id))];
    for (const id of ids) {
      if (context.signal?.aborted) fail("cancelled");
      const spans = supportedEvidence.filter((e) => e.id === id);
      const source = evidence.find((e) => e.id === id);
      // Multiple disjoint spans need a distinct canonical binding contract; do not copy the document instead.
      if (!source || spans.length !== 1 || source.text.slice(spans[0]!.start, spans[0]!.end) !== spans[0]!.quote) fail("raw_evidence_span_binding_unavailable");
      const span = spans[0]!;
      const sourceKey = `evolution-source:${jsonHash([context.proposal.scopeFingerprint, source.rootEvidenceId, source.revision, source.snapshotHash, span.start, span.end])}`;
      const scope = context.proposal.scope;
      const receipt = await kernel.execute({
        type: "importEvidence", idempotencyKey: `evolution-evidence:${jsonHash([context.proposal.scopeFingerprint, context.proposal.id, id])}`,
        serverAuthority: context.authority,
        clientScope: { appId: scope.appId, projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace, visibility: scope.visibility ?? "private" },
        text: span.quote, kind: "observation", container: "session_candidate", sourceId: sourceKey, evidenceIds: [sourceKey],
        provenance: { source: "evolution", sourceId: sourceKey },
        metadata: { eventType: "observation", evolutionEvidence: { sourceEvidenceId: id, sourceId: source.sourceId, snapshotHash: source.snapshotHash, revision: source.revision, rootEvidenceId: source.rootEvidenceId, ...(source.locator ? { locator: source.locator } : {}), expiresAt: context.proposal.createdAt + 7 * 86400000 } },
      });
      if (receipt.status !== "persisted" || receipt.recordType !== "memory" || !("route" in receipt) || receipt.route !== "evidence_only") fail("raw_evidence_not_persisted");
      bindings.push({ sourceEvidenceId: id, evidenceMemoryId: receipt.memoryId });
    }
    return bindings;
  };
}
