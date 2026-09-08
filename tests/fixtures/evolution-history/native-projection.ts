import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../../packages/core/src/domain/types.js";
import { computePublicContentHash, computeGovernanceProjectionHash, validateGovernedDocumentAssetVersion } from "../../../packages/core/src/documents/canonical.js";
import type { GovernedDocumentAssetVersion } from "../../../packages/core/src/documents/types.js";
import { canonicalRehydrationDomainHash as domainHash, parseCanonicalProjectionBundle } from "../../../packages/core/src/db/migrations/canonical-postgres-rehydration.js";
import { computeContentHash } from "../../../packages/core/src/scoring/hash-utils.js";
import { historyContentSha256 } from "../../../packages/core/src/evolution/history/native-materials.js";

/** Entirely synthetic P13 artifacts, checked by the actual strict projection parser. */
export function historyNativeProjection(scope: MemoryScope, sourceId: string, targetId: string) {
  const sourceRef = `memories:${sourceId}`, fingerprint = authorityScopeFingerprint(scope);
  const text = "The synthetic P16 adapter retains original evidence and private scope.";
  const sourceText = `Observed in an isolated fixture: ${text} This is not historical author verification.`;
  const sourceHash = historyContentSha256(sourceText), assetId = `history-fixture-${targetId}`, evidenceId = `claim-evidence-${targetId}`;
  const content = { title: "Synthetic P16 reference", abstract: text, sections: [{ id: "scope", heading: "Scope", claims: [{ id: "claim", text }] }],
    userNotes: "", topics: ["synthetic"], relatedAssetIds: [], sourceAssetIds: [sourceRef], aliases: [], tags: [] };
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({ assetId, assetVersion: 1, claimEvidence: { claim: [evidenceId] }, provenanceRefs: [sourceRef], relationRefs: [], sourceDispositionRefs: [sourceRef], resolutionHash: sourceHash, policyVersion: "history-fixture/v1" });
  const asset: GovernedDocumentAssetVersion = validateGovernedDocumentAssetVersion({ assetId, assetVersion: 1, schemaVersion: 1, kind: "memory_document", purpose: "typed_memory", semanticType: "resource", title: content.title,
    lifecycleState: "active", governanceState: "current", scope, scopeFingerprint: fingerprint, content, publicContentHash, governanceProjectionHash,
    governanceDescription: { assetId, assetVersion: 1, kind: "memory_document", purpose: "typed_memory", semanticType: "resource", scopeFingerprint: fingerprint, lifecycleState: "active", governanceState: "current", complexityClass: "simple", title: content.title,
      abstract: text, sectionIndex: [{ sectionId: "scope", heading: "Scope", brief: text }], claimEvidenceCoverage: 1, sourceDispositionCoverage: 1, conflictCount: 0, staleReasons: [], publicContentHash, governanceProjectionHash, navigationRefs: [sourceRef] },
    provenanceRefs: [sourceRef], evidenceRefs: [evidenceId], relations: [], createdAt: "2026-09-06T00:00:00.000Z", updatedAt: "2026-09-06T00:00:00.000Z" });
  const row = { id: targetId, text, content_hash: computeContentHash(text), data_type: "memory", category: "fact", importance: 0.6, scope_key: fingerprint, vector: null,
    tenant_id: scope.tenantId, user_id: scope.userId, product_id: scope.appId, canonical_project_id: scope.projectId, producer_id: scope.agentId, namespace: scope.namespace, visibility: scope.visibility,
    metadata: { kind: "fact", semanticType: "resource", confidence: 0.6, publicContentHash, admissionRoute: "pending", contextEligible: false } };
  const memory = { schema: "mengshu.canonical-memory-row/v1", assetId, memoryId: targetId, row, rowSha256: domainHash("mengshu.canonical-memory-row/payload/v1", row) };
  const document = { schema: "mengshu.governed-document-projection-row/v1", assetId, assetVersion: 1, semanticType: "resource", scopeFingerprint: fingerprint, memoryId: targetId, publicContentHash, governanceProjectionHash, claimIds: ["claim"], relations: [],
    rowSha256: domainHash("mengshu.governed-document-projection-row/v1", { assetId, publicContentHash, governanceProjectionHash }) };
  const start = Buffer.byteLength(sourceText.slice(0, sourceText.indexOf(text)));
  const evidencePayload = { evidenceId, assetId, assetVersion: 1, claimId: "claim", scopeFingerprint: fingerprint, sourceRef, sourceMemoryId: sourceId, sourceHash,
    anchor: { utf8ByteStart: start, utf8ByteEnd: start + Buffer.byteLength(text), excerptHash: historyContentSha256(text) } };
  const evidence = { schema: "mengshu.claim-evidence-projection-row/v1", ...evidencePayload, rowSha256: domainHash("mengshu.claim-evidence-projection-row/v1", evidencePayload) };
  const mapping = { schema: "mengshu.canonical-source-mapping-row/v1", sourceRef, sourceHash, sourceTable: "memories", sourceRecordId: sourceId, scopeFingerprint: fingerprint, disposition: "attached_to_typed_document", operation: "archive_after_activation",
    targetAssetIds: [assetId], targetMemoryIds: [targetId], evidenceRefs: [evidenceId], reasonCode: "synthetic_review", mappingSha256: historyContentSha256(`mapping:${sourceRef}`) };
  const job = { schema: "mengshu.canonical-embedding-job/v1", jobId: `embedding-${targetId}`, assetId, memoryId: targetId, contentHash: row.content_hash, requiredState: "reembedded", vectorReuseAllowed: false, networkExecuted: false };
  const texts = { canonicalMemoryRows: `${JSON.stringify(memory)}\n`, governedDocumentRows: `${JSON.stringify(document)}\n`, claimEvidenceRows: `${JSON.stringify(evidence)}\n`, sourceMappingRows: `${JSON.stringify(mapping)}\n`, embeddingJobs: `${JSON.stringify(job)}\n` };
  const manifestBody = { schema: "mengshu.postgres-canonical-projection/v1", governanceRunId: "synthetic-p15-fixture", targetSchemaVersion: 27, inputs: {},
    files: Object.fromEntries(Object.entries(texts).map(([key, value]) => [key, { file: `${key}.jsonl`, sha256: historyContentSha256(value), rows: 1 }])),
    counts: { canonicalMemoryInsert: 1, governedDocumentInsert: 1, claimEvidenceInsert: 1, sourceMappingInsert: 1, embeddingJobCount: 1 }, preconditions: {},
    guards: { dryRunOnly: true, executableSqlIncluded: false, applyTokenIncluded: false, productionConnectionOpened: false, postgresTouched: false } };
  const projectionManifest = JSON.stringify({ ...manifestBody, projectionHash: domainHash("mengshu.postgres-canonical-projection/v1", manifestBody) });
  return { text, sourceText, sourceHash, sourceRef, fingerprint, asset, bundle: parseCanonicalProjectionBundle({ ...texts, projectionManifest }) };
}
