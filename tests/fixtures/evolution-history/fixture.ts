import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { historyHash } from "../../../packages/core/src/evolution/history/schema.js";
import type { HistoryClaimBinding, HistoryContinuationInput, HistoryParentObservation, HistoryReadPort, HistorySourceWitness, HistoryTargetWitness } from "../../../packages/core/src/evolution/history/types.js";

export function historyFixture() {
  const h = historyHash;
  const scope = { tenantId: "fixture-tenant", userId: "fixture-user", appId: "fixture-app", projectId: "fixture-project", agentId: "fixture-agent", namespace: "fixture", visibility: "private" as const };
  const fingerprint = authorityScopeFingerprint(scope);
  const sources: HistorySourceWitness[] = ["memories:source-a", "knowledge:source-b", "knowledge:source-c", "knowledge:source-d"].map((sourceRef, index) => ({
    sourceRef, sourceHash: h(sourceRef), mappingHash: h(`mapping:${sourceRef}`), scopeFingerprint: fingerprint,
    beforeSemanticHash: h(`semantic:${sourceRef}`), currentSemanticHash: h(`semantic:${sourceRef}`), beforeRowHash: h(`row:${sourceRef}`), currentRowHash: h(`row:${sourceRef}`), currentRevision: "1",
    disposition: index < 2 ? "attached_to_typed_document" : "lookup_only", operation: index < 2 ? "archive_after_activation" : "preserve_lookup_only", targetMemoryIds: index < 2 ? ["canonical-a"] : [],
    ...(index >= 2 ? { knowledgeIdentity: { resourceHash: h("resource"), versionHash: h("version"), contentHash: h("content"), reviewReceiptHash: h("new-p16-selection-review"),
      canonicalSourceRef: "knowledge:source-c", aggregationPlanHash: h("new-p16-aggregation-plan"), sourceSetHash: h(["knowledge:source-c", "knowledge:source-d"].map(sourceRef => ({ sourceRef, sourceHash: h(sourceRef) }))) } } : {}),
  }));
  const targets: HistoryTargetWitness[] = [{ memoryId: "canonical-a", assetId: "asset-a", assetVersion: 1, scope,
    expectedSemanticHash: h("canonical-semantic"), currentSemanticHash: h("canonical-semantic"), revision: "1", lifecycle: "pending", documentState: "review",
    documentMatchesProjection: true, kind: "fact", pinned: false, tombstoned: false, current: true, confidence: 0.8, claimIds: ["claim-a", "claim-b"] }];
  const bindings: HistoryClaimBinding[] = sources.slice(0, 2).map((source, index) => ({ evidenceId: `evidence-${index}`, claimId: `claim-${index ? "b" : "a"}`,
    assetId: "asset-a", assetVersion: 1, targetMemoryId: "canonical-a", sourceRef: source.sourceRef, sourceHash: source.sourceHash, scopeFingerprint: fingerprint,
    rootEvidenceId: `root-${index}`, independenceGroupId: `group-${index}`, anchor: { utf8ByteStart: 0, utf8ByteEnd: 10, excerptHash: h(`excerpt-${index}`) } }));
  const input: HistoryContinuationInput = { schema: "mengshu.history-p16-input/v1", runId: "p16-fixture", parentRunId: "p15-fixture", parentReceiptHash: h("receipt"),
    projectionHash: h("projection"), sourceManifestHash: h("manifest"), governanceManifestHash: h("governance"), policyVersion: "p16/v1",
    expected: { sources: 4, targets: 1, claimBindings: 2, scopes: 1 }, limits: { pageSize: 2, maxSources: 100, maxTargets: 100, maxBindings: 100, maxBatchUnits: 100, maxDurationMs: 60000 } };
  const parent: HistoryParentObservation = { runId: input.parentRunId, materializationComplete: true, receiptHash: input.parentReceiptHash,
    projectionHash: input.projectionHash, sourceManifestHash: input.sourceManifestHash, governanceManifestHash: input.governanceManifestHash,
    sources: 4, mappings: 4, targets: 1, claimBindings: 2, outsideCohortRows: 7, outsideCohortHash: h("untouched-outside-rows"), unrelatedQueueHash: h("untouched-queue") };
  const page = <T>(rows: T[], key: (row: T) => string, after: string | undefined, limit: number) => {
    const remaining = rows.filter(row => !after || key(row) > after).sort((a, b) => key(a).localeCompare(key(b)));
    return { rows: structuredClone(remaining.slice(0, limit)), ...(remaining.length > limit ? { next: key(remaining[limit - 1]) } : {}) };
  };
  const port: HistoryReadPort = { readParent: async () => structuredClone(parent),
    readSources: async ({ after, limit }) => page(sources, row => row.sourceRef, after, limit),
    readTargets: async ({ after, limit }) => page(targets, row => row.memoryId, after, limit),
    readBindings: async ({ after, limit }) => page(bindings, row => row.evidenceId, after, limit) };
  return { input, parent, sources, targets, bindings, port, scope };
}
