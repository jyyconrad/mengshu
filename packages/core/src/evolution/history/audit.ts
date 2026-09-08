import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { canonicalSourceMigrationDisposition } from "../../db/migrations/canonical-postgres-rehydration.js";
import { exactObject, historyHash, isCount, isHash, isRef, parseHistoryInput, rejectHistory } from "./schema.js";
import type { HistoryAudit, HistoryClaimBinding, HistoryContinuationInput, HistoryParentObservation, HistoryReadPort, HistorySourceWitness, HistoryTargetWitness } from "./types.js";

export function validateHistorySource(row: HistorySourceWitness): void {
  exactObject(row, ["sourceRef", "sourceHash", "mappingHash", "scopeFingerprint", "beforeSemanticHash", "currentSemanticHash", "beforeRowHash", "currentRowHash", "currentRevision", "disposition", "operation", "targetMemoryIds"], ["knowledgeIdentity", "knowledgeBinding"]);
  if (!isRef(row.sourceRef) || !/^(memories|knowledge):.+/.test(row.sourceRef) ||
      [row.sourceHash, row.mappingHash, row.scopeFingerprint, row.beforeSemanticHash, row.beforeRowHash].some(hash => !isHash(hash)) ||
      [row.currentSemanticHash, row.currentRowHash].some(hash => hash !== null && !isHash(hash)) || (row.currentRevision !== null && !isRef(row.currentRevision)) ||
      !isRef(row.disposition) || !isRef(row.operation) || !Array.isArray(row.targetMemoryIds) || row.targetMemoryIds.length > 1000 || row.targetMemoryIds.some(id => !isRef(id))) rejectHistory("HISTORY_SOURCE_INVALID");
  if (row.knowledgeIdentity) {
    exactObject(row.knowledgeIdentity, ["resourceHash", "versionHash", "contentHash", "reviewReceiptHash", "canonicalSourceRef", "sourceSetHash", "aggregationPlanHash"]);
    const { canonicalSourceRef, ...hashes } = row.knowledgeIdentity;
    if (!row.sourceRef.startsWith("knowledge:") || !isRef(canonicalSourceRef) || !canonicalSourceRef.startsWith("knowledge:") || Object.values(hashes).some(hash => !isHash(hash))) rejectHistory("HISTORY_SOURCE_INVALID");
  }
  if (row.knowledgeBinding) {
    exactObject(row.knowledgeBinding, ["resolutionReceiptHash", "semanticPlanHash", "unitId", "resourceIdentity", "logicalSourceDisposition", "revisionKind", "logicalSourceIdentities", "resourceLocators", "ordinalCount", "disposition"]);
    const binding = row.knowledgeBinding;
    if (!row.sourceRef.startsWith("knowledge:") || !isHash(binding.resolutionReceiptHash) || !isHash(binding.semanticPlanHash) || !isRef(binding.unitId) || !isRef(binding.resourceIdentity) ||
        !["snapshot_document", "locator_resource", "distinct_chunk"].includes(binding.logicalSourceDisposition) || !["snapshot_chunks", "unversioned"].includes(binding.revisionKind) ||
        !["lookup_only", "quarantine"].includes(binding.disposition) || !isCount(binding.ordinalCount, 1000000) ||
        [binding.logicalSourceIdentities, binding.resourceLocators].some(values => !Array.isArray(values) || values.length > 1000 || values.some(value => typeof value !== "string" || !value.length || value.length > 4096 || /[\p{Cc}]/u.test(value)))) rejectHistory("HISTORY_SOURCE_INVALID");
  }
}
export function validateHistoryTarget(row: HistoryTargetWitness): void {
  exactObject(row, ["memoryId", "assetId", "assetVersion", "scope", "expectedSemanticHash", "currentSemanticHash", "revision", "lifecycle", "documentState", "documentMatchesProjection", "pinned", "tombstoned", "current", "confidence", "claimIds"], ["kind", "semanticType"]);
  exactObject(row.scope, ["tenantId", "appId", "userId", "projectId", "agentId", "namespace"], ["workspaceId", "sessionId", "visibility"]);
  if (Object.values(row.scope).some(value => typeof value !== "string" || value.length > 512 || /[\p{Cc}]/u.test(value)) ||
      (row.scope.visibility !== undefined && !["private", "workspace", "team", "public"].includes(row.scope.visibility)) ||
      !isRef(row.memoryId) || !isRef(row.assetId) || !isCount(row.assetVersion, 1000000, 1) || !isHash(row.expectedSemanticHash) ||
      (row.currentSemanticHash !== null && !isHash(row.currentSemanticHash)) || [row.revision, row.lifecycle, row.documentState].some(value => value !== null && !isRef(value)) ||
      [row.documentMatchesProjection, row.pinned, row.tombstoned, row.current].some(value => typeof value !== "boolean") ||
      !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1 || !Array.isArray(row.claimIds) || row.claimIds.length > 10000 || row.claimIds.some(id => !isRef(id)) ||
      (row.kind !== undefined && !["preference", "decision", "entity", "fact", "task", "plan", "goal", "document", "knowledge", "observation", "other"].includes(row.kind)) ||
      (row.semanticType !== undefined && !["profile", "task_context", "rules", "experience", "resource"].includes(row.semanticType))) rejectHistory("HISTORY_TARGET_INVALID");
}
export function validateHistoryBinding(row: HistoryClaimBinding): void {
  exactObject(row, ["evidenceId", "claimId", "assetId", "assetVersion", "targetMemoryId", "sourceRef", "sourceHash", "scopeFingerprint", "rootEvidenceId", "independenceGroupId"], ["anchor"]);
  if ([row.evidenceId, row.claimId, row.assetId, row.targetMemoryId, row.sourceRef, row.rootEvidenceId, row.independenceGroupId].some(value => !isRef(value)) ||
      !isHash(row.sourceHash) || !isHash(row.scopeFingerprint) || !isCount(row.assetVersion, 1000000, 1)) rejectHistory("HISTORY_BINDING_INVALID");
  if (row.anchor) {
    exactObject(row.anchor, ["utf8ByteStart", "utf8ByteEnd", "excerptHash"]);
    if (!isCount(row.anchor.utf8ByteStart, Number.MAX_SAFE_INTEGER) || !isCount(row.anchor.utf8ByteEnd, Number.MAX_SAFE_INTEGER, row.anchor.utf8ByteStart + 1) || !isHash(row.anchor.excerptHash)) rejectHistory("HISTORY_BINDING_INVALID");
  }
}
function validateParent(parent: HistoryParentObservation): void {
  exactObject(parent, ["runId", "materializationComplete", "receiptHash", "projectionHash", "sourceManifestHash", "governanceManifestHash", "sources", "mappings", "targets", "claimBindings", "outsideCohortRows", "outsideCohortHash", "unrelatedQueueHash"]);
  if (!isRef(parent.runId) || typeof parent.materializationComplete !== "boolean" ||
      [parent.receiptHash, parent.projectionHash, parent.sourceManifestHash, parent.governanceManifestHash, parent.outsideCohortHash, parent.unrelatedQueueHash].some(hash => !isHash(hash)) ||
      [parent.sources, parent.mappings, parent.targets, parent.claimBindings, parent.outsideCohortRows].some(count => !isCount(count, Number.MAX_SAFE_INTEGER))) rejectHistory("HISTORY_PARENT_INVALID");
}

/** Hash/metadata only. Both pagination and the final receipt witness must remain stable. */
export async function auditHistory(rawInput: HistoryContinuationInput, port: HistoryReadPort, options: { signal?: AbortSignal; now?: () => number } = {}): Promise<HistoryAudit> {
  const input = parseHistoryInput(rawInput), now = options.now ?? Date.now, started = now();
  const checkBudget = () => { if (options.signal?.aborted || now() - started >= input.limits.maxDurationMs) rejectHistory("HISTORY_AUDIT_BUDGET"); };
  checkBudget();
  const parent = await port.readParent(input); validateParent(parent);
  const unresolved: HistoryAudit["unresolved"] = [], held: HistoryAudit["held"] = [], operationalDriftRefs: string[] = [];
  const issue = (ref: string, reason: string) => unresolved.push({ ref, reason });
  if (!parent.materializationComplete || parent.runId !== input.parentRunId || parent.receiptHash !== input.parentReceiptHash || parent.projectionHash !== input.projectionHash ||
      parent.sourceManifestHash !== input.sourceManifestHash || parent.governanceManifestHash !== input.governanceManifestHash) issue(input.parentRunId, "parent_materialization_mismatch");
  if (parent.sources !== input.expected.sources || parent.mappings !== input.expected.sources || parent.targets !== input.expected.targets || parent.claimBindings !== input.expected.claimBindings) issue(input.parentRunId, "parent_count_mismatch");
  const pages = async <T>(read: (request: { parentRunId: string; after?: string; limit: number }) => Promise<{ rows: T[]; next?: string }>, key: (row: T) => string, validate: (row: T) => void, maximum: number): Promise<T[]> => {
    const rows: T[] = []; let after: string | undefined;
    for (;;) {
      checkBudget();
      const page = await read({ parentRunId: input.parentRunId, ...(after ? { after } : {}), limit: input.limits.pageSize });
      exactObject(page, ["rows"], ["next"]);
      if (!Array.isArray(page.rows) || page.rows.length > input.limits.pageSize || rows.length + page.rows.length > maximum) rejectHistory("HISTORY_PAGE_BUDGET");
      let previous = after;
      for (const row of page.rows) {
        validate(row);
        if (previous && key(row) < previous) rejectHistory("HISTORY_CURSOR_INVALID");
        if (previous === key(row)) issue(key(row), "duplicate_identity");
        rows.push(structuredClone(row)); previous = key(row);
      }
      if (page.next === undefined) break;
      if (!isRef(page.next) || !page.rows.length || page.next !== previous || (after !== undefined && page.next <= after)) rejectHistory("HISTORY_CURSOR_INVALID");
      after = page.next;
    }
    return rows;
  };
  const sources = await pages(port.readSources.bind(port), row => row.sourceRef, validateHistorySource, input.limits.maxSources);
  const targets = await pages(port.readTargets.bind(port), row => row.memoryId, validateHistoryTarget, input.limits.maxTargets);
  const bindings = await pages(port.readBindings.bind(port), row => row.evidenceId, validateHistoryBinding, input.limits.maxBindings);
  if (sources.length !== input.expected.sources || targets.length !== input.expected.targets || bindings.length !== input.expected.claimBindings || new Set(sources.map(source => source.scopeFingerprint)).size !== input.expected.scopes) issue(input.parentRunId, "audit_count_mismatch");
  const bySource = new Map(sources.map(source => [source.sourceRef, source])), byTarget = new Map(targets.map(target => [target.memoryId, target]));
  for (const source of sources) {
    try { canonicalSourceMigrationDisposition(source); } catch { issue(source.sourceRef, "unknown_disposition"); }
    if (source.currentSemanticHash !== source.beforeSemanticHash || !source.currentRowHash || !source.currentRevision) held.push({ ref: source.sourceRef, reason: "source_semantic_drift_or_missing" });
    else if (source.currentRowHash !== source.beforeRowHash) operationalDriftRefs.push(source.sourceRef);
    if (byTarget.has(source.sourceRef.replace(/^memories:/, ""))) issue(source.sourceRef, "original_canonical_overlap");
    for (const id of source.targetMemoryIds) {
      const target = byTarget.get(id);
      if (!target || authorityScopeFingerprint(target.scope) !== source.scopeFingerprint) issue(source.sourceRef, "source_target_scope_or_identity_mismatch");
    }
  }
  for (const target of targets) {
    if (!target.documentMatchesProjection || target.currentSemanticHash !== target.expectedSemanticHash || !target.revision || target.lifecycle !== "pending" || target.documentState !== "review" || !target.kind || target.pinned || target.tombstoned || !target.current) held.push({ ref: target.memoryId, reason: "target_governance_or_revision_changed" });
    if (!target.claimIds.length || new Set(target.claimIds).size !== target.claimIds.length || target.claimIds.some(claim => !bindings.some(binding => binding.targetMemoryId === target.memoryId && binding.claimId === claim))) issue(target.memoryId, "claim_coverage_missing");
    if (!sources.some(source => source.targetMemoryIds.includes(target.memoryId))) issue(target.memoryId, "target_mapping_missing");
  }
  for (const binding of bindings) {
    const source = bySource.get(binding.sourceRef), target = byTarget.get(binding.targetMemoryId);
    if (!source || !target || binding.sourceHash !== source.sourceHash || binding.scopeFingerprint !== source.scopeFingerprint || binding.scopeFingerprint !== authorityScopeFingerprint(target.scope) ||
        binding.assetId !== target.assetId || binding.assetVersion !== target.assetVersion || !target.claimIds.includes(binding.claimId) || !source.targetMemoryIds.includes(target.memoryId)) issue(binding.evidenceId, "binding_identity_scope_or_hash_mismatch");
  }
  checkBudget();
  const finalParent = await port.readParent(input); validateParent(finalParent);
  if (historyHash(parent) !== historyHash(finalParent)) rejectHistory("HISTORY_PARENT_DRIFT");
  const body = { schema: "mengshu.history-p16-audit/v1" as const, inputHash: historyHash(input), parent, sources, targets, bindings,
    unresolved: unresolved.sort((a, b) => `${a.ref}:${a.reason}`.localeCompare(`${b.ref}:${b.reason}`)), held: held.sort((a, b) => a.ref.localeCompare(b.ref)), operationalDriftRefs: operationalDriftRefs.sort() };
  return { ...body, hash: historyHash(body) };
}
