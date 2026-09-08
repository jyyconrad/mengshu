import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import { historyHash, parseHistoryInput, rejectHistory, verifyHistoryHash } from "./schema.js";
import type { HistoryAudit, HistoryContinuationInput, HistoryPlan, HistoryPlanUnit, HistorySourceWitness } from "./types.js";

export function planHistory(rawInput: HistoryContinuationInput, audit: HistoryAudit): HistoryPlan {
  const input = parseHistoryInput(rawInput); verifyHistoryHash(audit);
  if (audit.schema !== "mengshu.history-p16-audit/v1" || audit.inputHash !== historyHash(input)) rejectHistory("HISTORY_AUDIT_INPUT_MISMATCH");
  const units: HistoryPlanUnit[] = [], held = [...audit.held];
  const blocked = new Set([...audit.held, ...audit.unresolved].map(item => item.ref));
  const disposition = new Map<string, HistoryPlan["sourceDispositions"][number]>(audit.sources.map(source => [source.sourceRef, {
    sourceRef: source.sourceRef, action: blocked.has(source.sourceRef) ? "review" : source.disposition === "quarantine" ? "quarantine" : "preserve", targetRefs: [...source.targetMemoryIds].sort(),
  }]));
  const add = (body: Omit<HistoryPlanUnit, "id">) => {
    const unit = { ...body, id: historyHash({ runId: input.runId, parentRunId: input.parentRunId, ...body }) };
    units.push(unit); return unit;
  };
  const targetUnits = new Map<string, string>();
  for (const target of audit.targets) {
    const sources = audit.sources.filter(source => source.targetMemoryIds.includes(target.memoryId));
    const bindings = audit.bindings.filter(binding => binding.targetMemoryId === target.memoryId);
    if (blocked.has(target.memoryId) || sources.some(source => blocked.has(source.sourceRef)) || bindings.some(binding => blocked.has(binding.evidenceId))) {
      for (const source of sources) disposition.get(source.sourceRef)!.action = "review";
      held.push({ ref: target.memoryId, reason: "target_or_support_held" }); continue;
    }
    const scopeFingerprint = authorityScopeFingerprint(target.scope);
    const rootBindings = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const key = `${binding.sourceRef}:${binding.rootEvidenceId}`;
      const group = rootBindings.get(key) ?? []; group.push(binding); rootBindings.set(key, group);
    }
    const evidenceIds = [...rootBindings.values()].map(group => add({ phase: "evidence", scopeFingerprint, target,
      sources: sources.filter(source => source.sourceRef === group[0].sourceRef), bindings: group, dependencies: [], confidenceCeiling: target.confidence }).id);
    const activation = add({ phase: "activate", scopeFingerprint, target, sources, bindings, dependencies: evidenceIds.sort(), confidenceCeiling: target.confidence });
    targetUnits.set(target.memoryId, activation.id);
  }
  const groups = new Map<string, HistorySourceWitness[]>();
  for (const source of audit.sources) {
    if (source.targetMemoryIds.length || source.disposition !== "lookup_only" || !source.knowledgeIdentity || blocked.has(source.sourceRef)) continue;
    const { resourceHash, versionHash, contentHash } = source.knowledgeIdentity;
    const key = historyHash({ scope: source.scopeFingerprint, resourceHash, versionHash, contentHash });
    const group = groups.get(key) ?? []; group.push(source); groups.set(key, group);
  }
  const knowledgeUnits = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    group.sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
    const decision = group[0].knowledgeIdentity!;
    const sourceSetHash = historyHash(group.map(source => ({ sourceRef: source.sourceRef, sourceHash: source.sourceHash })));
    if (!group.some(source => source.sourceRef === decision.canonicalSourceRef) || decision.sourceSetHash !== sourceSetHash || group.some(source => historyHash(source.knowledgeIdentity) !== historyHash(decision))) {
      for (const source of group) { disposition.get(source.sourceRef)!.action = "review"; held.push({ ref: source.sourceRef, reason: "knowledge_selection_receipt_mismatch" }); }
      continue;
    }
    const unit = add({ phase: "knowledge", scopeFingerprint: group[0].scopeFingerprint, sources: group, bindings: [], canonicalSourceRef: decision.canonicalSourceRef, dependencies: [] });
    for (const source of group.filter(source => source.sourceRef !== decision.canonicalSourceRef)) knowledgeUnits.set(source.sourceRef, unit.id);
  }
  for (const source of audit.sources) {
    if (blocked.has(source.sourceRef) || disposition.get(source.sourceRef)!.action === "review") continue;
    const targets = source.targetMemoryIds.map(id => targetUnits.get(id));
    const knowledge = knowledgeUnits.get(source.sourceRef);
    if (knowledge || (source.operation === "archive_after_activation" && targets.length && targets.every(Boolean))) {
      const dependencies = knowledge ? [knowledge] : targets as string[];
      add({ phase: "archive", scopeFingerprint: source.scopeFingerprint, sources: [source], bindings: [], dependencies: [...new Set(dependencies)].sort() });
      disposition.get(source.sourceRef)!.action = "archive_after_verify";
    } else if (["archive_after_activation", "archive_deferred", "archive_stale", "preserve_memory_lookup_only"].includes(source.operation)) {
      disposition.get(source.sourceRef)!.action = "review";
      held.push({ ref: source.sourceRef, reason: "archive_requires_verified_replacement" });
    }
  }
  const phaseOrder = ["evidence", "activate", "knowledge", "archive"];
  units.sort((a, b) => phaseOrder.indexOf(a.phase) - phaseOrder.indexOf(b.phase) || a.id.localeCompare(b.id));
  const sourceDispositions = [...disposition.values()].sort((a, b) => a.sourceRef.localeCompare(b.sourceRef));
  const candidateGroups = new Map<string, NonNullable<HistoryPlan["knowledgeReviewPlan"]>["candidates"][number]>();
  for (const source of audit.sources) {
    if (!source.knowledgeBinding || source.knowledgeIdentity || source.knowledgeBinding.disposition !== "lookup_only" || blocked.has(source.sourceRef)) continue;
    const key = `${source.scopeFingerprint}:${source.knowledgeBinding.unitId}`;
    const candidate = candidateGroups.get(key) ?? { unitId: source.knowledgeBinding.unitId, scopeFingerprint: source.scopeFingerprint, binding: source.knowledgeBinding, sources: [] };
    if (historyHash(candidate.binding) !== historyHash(source.knowledgeBinding)) rejectHistory("HISTORY_KNOWLEDGE_BINDING_MISMATCH");
    candidate.sources.push({ sourceRef: source.sourceRef, sourceHash: source.sourceHash }); candidateGroups.set(key, candidate);
  }
  const knowledgeReviewBody = { schema: "mengshu.history-p16-knowledge-review-plan/v1" as const, candidates: [...candidateGroups.values()].sort((a, b) => a.unitId.localeCompare(b.unitId)),
    canonicalTargetsSelected: false as const, formalAssetsWritten: false as const, supersedeAllowed: false as const };
  const body: Omit<HistoryPlan, "hash"> = { schema: "mengshu.history-p16-plan/v1", input, inputHash: historyHash(input), auditHash: audit.hash,
    witnessHash: historyHash({ sources: audit.sources, targets: audit.targets, bindings: audit.bindings }), units, sourceDispositions,
    unresolvedCount: audit.unresolved.length, held, outsideCohortRows: audit.parent.outsideCohortRows, outsideCohortHash: audit.parent.outsideCohortHash, unrelatedQueueHash: audit.parent.unrelatedQueueHash,
    ...(candidateGroups.size ? { knowledgeReviewPlan: { ...knowledgeReviewBody, hash: historyHash(knowledgeReviewBody) } } : {}),
    counts: { memoryTargets: targetUnits.size, knowledgeGroups: groups.size ? units.filter(unit => unit.phase === "knowledge").length : 0,
      rawEvidenceRoots: new Set(units.filter(unit => unit.phase === "evidence").flatMap(unit => unit.bindings.map(binding => `${binding.scopeFingerprint}:${binding.rootEvidenceId}`))).size,
      archiveSources: sourceDispositions.filter(row => row.action === "archive_after_verify").length, preservedSources: sourceDispositions.filter(row => row.action === "preserve").length } };
  return { ...body, hash: historyHash(body) };
}
