import { createHash } from "node:crypto";
import { parseKnowledgeResourcePlan } from "../../db/migrations/knowledge-resource-curation.js";
import { historyHash, exactObject, isHash, isRef, isCount, rejectHistory, verifyHistoryHash } from "./schema.js";
import { validateHistorySource } from "./audit.js";
import type { HistoryAudit, HistorySourceWitness } from "./types.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const sealed = new WeakSet<object>();
const countKeys = ["batches", "units", "sources", "reviewBatches", "reviewUnits", "acceptedReviews", "arbitrated", "unresolved", "coverage", "eligibleSources", "lookupOnlySources", "quarantineSources", "supersede"];
const cohorts = ["quarantine", "snapshot_document", "strong_locator", "low_signal_resource", "namespace_hint_only"];
const logicalDispositions = ["snapshot_document", "locator_resource", "distinct_chunk"];
const revisions = ["snapshot_chunks", "unversioned"];
const textList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every(text => typeof text === "string" && text.length > 0 && text.length <= 4096 && !/[\p{Cc}]/u.test(text));
const parse = (text: string): unknown => { try { return JSON.parse(text); } catch { return rejectHistory("HISTORY_KNOWLEDGE_JSON_INVALID"); } };
const lines = (text: string, maxRows: number) => {
  const rows = text.split("\n").filter(line => line.trim());
  if (rows.length > maxRows || rows.some(line => Buffer.byteLength(line) > 1024 * 1024)) rejectHistory("HISTORY_KNOWLEDGE_BUDGET");
  return rows.map(parse);
};
const guards = (value: unknown) => {
  const row = exactObject(value, ["canonicalTargetsSelected", "formalAssetsWritten", "treeArtifactsWritten", "postgresTouched"]);
  if (Object.values(row).some(value => value !== false)) rejectHistory("HISTORY_KNOWLEDGE_LEGACY_AUTHORITY_INVALID");
};

export interface LegacyKnowledgeResolutionInput {
  plan: string;
  planSha256: string;
  receipt: string;
  receiptSha256: string;
  bindings: string;
  dispositions: string;
  unitDecisions: string;
  summary: string;
  maxBytes?: number;
  maxRows?: number;
}
export interface LegacyKnowledgeResolution {
  receiptSha256: string;
  semanticPlanSha256: string;
  sourceManifestSha256: string;
  sources: { sourceRef: string; sourceHash: string; scopeFingerprint: string; binding: NonNullable<HistorySourceWitness["knowledgeBinding"]> }[];
  counts: Record<string, number>;
  canonicalTargetsSelected: false;
  formalAssetsWritten: false;
  supersedeAllowed: false;
  hash: string;
}

/** Parse the actual v1 legacy schemas; resourceIdentity and revisionKind are NOT content/version hashes. */
export function parseLegacyKnowledgeResolution(input: LegacyKnowledgeResolutionInput): LegacyKnowledgeResolution {
  const maxBytes = input.maxBytes ?? 256 * 1024 * 1024, maxRows = input.maxRows ?? 1000000;
  if (!isCount(maxBytes, 256 * 1024 * 1024, 1) || !isCount(maxRows, 1000000, 1) || !isHash(input.planSha256) || !isHash(input.receiptSha256) ||
      [input.plan, input.receipt, input.bindings, input.dispositions, input.unitDecisions, input.summary].some(value => typeof value !== "string") ||
      [input.plan, input.receipt, input.bindings, input.dispositions, input.unitDecisions, input.summary].reduce((sum, text) => sum + Buffer.byteLength(text), 0) > maxBytes) rejectHistory("HISTORY_KNOWLEDGE_BUDGET");
  if (hash(input.plan) !== input.planSha256 || hash(input.receipt) !== input.receiptSha256) rejectHistory("HISTORY_KNOWLEDGE_ARTIFACT_DRIFT");
  const plan = parseKnowledgeResourcePlan(input.plan);
  if (plan.units.length > maxRows || plan.summary.sourceCount > maxRows || !isCount(plan.summary.sourceCount, maxRows, 1) || plan.summary.sourceCoverage !== 1 ||
      plan.guards.canonicalTargetsSelected !== false || plan.guards.formalAssetsWritten !== false || plan.guards.supersedeAllowed !== false || plan.guards.crossScopeGroupingAllowed !== false) rejectHistory("HISTORY_KNOWLEDGE_PLAN_INVALID");
  const receipt = exactObject(parse(input.receipt), ["schema", "createdAt", "inputHashes", "outputHashes", "outputArtifactSetSha256", "counts", "guards", "candidateOnly"]);
  const summary = exactObject(parse(input.summary), ["schema", "createdAt", "planFileSha256", "semanticPlanSha256", "counts", "guards", "candidateOnly"]);
  if (receipt.schema !== "mengshu.knowledge-resource-resolution-receipt/v1" || summary.schema !== "mengshu.knowledge-resource-resolution-summary/v1" || receipt.candidateOnly !== false || summary.candidateOnly !== false ||
      summary.planFileSha256 !== input.planSha256 || summary.semanticPlanSha256 !== plan.semanticPlanSha256) rejectHistory("HISTORY_KNOWLEDGE_SCHEMA_INVALID");
  guards(receipt.guards); guards(summary.guards);
  const inputs = exactObject(receipt.inputHashes, ["planFileSha256", "semanticPlanSha256", "arbitrationFileSha256", "reviewFiles"]);
  if (inputs.planFileSha256 !== input.planSha256 || inputs.semanticPlanSha256 !== plan.semanticPlanSha256 || !isHash(inputs.arbitrationFileSha256) || !Array.isArray(inputs.reviewFiles) || inputs.reviewFiles.length > maxRows) rejectHistory("HISTORY_KNOWLEDGE_PLAN_INVALID");
  for (const raw of inputs.reviewFiles) {
    const review = exactObject(raw, ["agent", "relativePath", "batchId", "fileSha256"]);
    if (!["agent-a", "agent-b", "agent-c"].includes(String(review.agent)) || !isRef(review.relativePath) || !isRef(review.batchId) || !isHash(review.fileSha256)) rejectHistory("HISTORY_KNOWLEDGE_REVIEW_INVALID");
  }
  const outputs = exactObject(receipt.outputHashes, ["unitDecisions", "knowledgeResourceBindings", "knowledgeSourceDispositions", "resolutionSummary"]);
  const actual = { unitDecisions: hash(input.unitDecisions), knowledgeResourceBindings: hash(input.bindings), knowledgeSourceDispositions: hash(input.dispositions), resolutionSummary: hash(input.summary) };
  const setHash = hash(Object.entries(actual).sort(([left], [right]) => left.localeCompare(right)).map(([name, value]) => `${name}\t${value}\n`).join(""));
  if (historyHash(outputs) !== historyHash(actual) || receipt.outputArtifactSetSha256 !== setHash) rejectHistory("HISTORY_KNOWLEDGE_ARTIFACT_DRIFT");
  const counts = exactObject(receipt.counts, countKeys) as Record<string, number>;
  exactObject(summary.counts, countKeys);
  if (Object.values(counts).some(value => !isCount(value, maxRows)) || historyHash(counts) !== historyHash(summary.counts) || counts.unresolved !== 0 || counts.coverage !== 1 || counts.supersede !== 0 ||
      counts.sources !== plan.summary.sourceCount || counts.units !== plan.units.length || counts.batches !== plan.batches.length || counts.eligibleSources !== counts.lookupOnlySources ||
      counts.lookupOnlySources + counts.quarantineSources !== counts.sources || counts.acceptedReviews + counts.arbitrated !== counts.reviewUnits) rejectHistory("HISTORY_KNOWLEDGE_COVERAGE_INVALID");
  const bindingRows = lines(input.bindings, maxRows), dispositionRows = lines(input.dispositions, maxRows), decisionRows = lines(input.unitDecisions, maxRows);
  if (bindingRows.length !== counts.units || dispositionRows.length !== counts.sources || decisionRows.length !== counts.units) rejectHistory("HISTORY_KNOWLEDGE_COVERAGE_INVALID");
  const units = new Map(plan.units.map(unit => [unit.unitId, unit]));
  const decisions = new Map<string, Record<string, unknown>>();
  for (const raw of decisionRows) {
    const row = exactObject(raw, ["schema", "unitId", "batchId", "sequence", "scopeFingerprint", "cohort", "disposition", "logicalSourceDisposition", "revisionKind", "confidence", "conflict", "resourceIdentity", "resolutionBasis", "reasonCodes", "candidateOnly"]);
    const unit = units.get(String(row.unitId)), batch = plan.batches.find(batch => batch.batchId === row.batchId && batch.unitIds.includes(String(row.unitId)));
    if (row.schema !== "mengshu.knowledge-resource-unit-decision/v1" || row.candidateOnly !== false || !unit || !batch || decisions.has(unit.unitId) || row.scopeFingerprint !== unit.scopeFingerprint || row.cohort !== unit.cohort || row.sequence !== batch.sequence ||
        !cohorts.includes(String(row.cohort)) || !["lookup_only", "quarantine"].includes(String(row.disposition)) || !logicalDispositions.includes(String(row.logicalSourceDisposition)) || !revisions.includes(String(row.revisionKind)) ||
        typeof row.confidence !== "number" || row.confidence < 0 || row.confidence > 1 || !Number.isFinite(row.confidence) || typeof row.conflict !== "boolean" ||
        !["quarantine", "deterministic", "accepted_review", "arbitration"].includes(String(row.resolutionBasis)) || !textList(row.reasonCodes)) rejectHistory("HISTORY_KNOWLEDGE_DECISION_INVALID");
    const expectedIdentity = `resource_${hash(["mengshu.private-knowledge-resource-identity/v1", plan.semanticPlanSha256, unit.unitId].join("\0")).slice(0, 32)}`;
    if (row.resourceIdentity !== expectedIdentity) rejectHistory("HISTORY_KNOWLEDGE_IDENTITY_INVALID");
    decisions.set(unit.unitId, row);
  }
  const sourceBindings = new Map<string, { sourceHash: string; scopeFingerprint: string; binding: NonNullable<HistorySourceWitness["knowledgeBinding"]> }>();
  const seenUnits = new Set<string>();
  for (const raw of bindingRows) {
    const row = exactObject(raw, ["schema", "resourceIdentity", "unitId", "scopeFingerprint", "logicalSourceDisposition", "revisionKind", "logicalSourceIdentities", "resourceLocators", "ordinalCount", "sources", "candidateOnly"]);
    const unit = units.get(String(row.unitId)), decision = decisions.get(String(row.unitId));
    if (row.schema !== "mengshu.knowledge-resource-binding/v1" || row.candidateOnly !== false || !unit || !decision || seenUnits.has(unit.unitId) || !Array.isArray(row.sources) || !row.sources.length ||
        ["resourceIdentity", "scopeFingerprint", "logicalSourceDisposition", "revisionKind"].some(key => row[key] !== decision[key]) ||
        historyHash(row.sources) !== historyHash(unit.sources) || historyHash(row.logicalSourceIdentities) !== historyHash(unit.logicalSourceIdentities) || historyHash(row.resourceLocators) !== historyHash(unit.resourceLocators) || row.ordinalCount !== unit.ordinalCount ||
        !textList(row.logicalSourceIdentities) || !textList(row.resourceLocators) || !isCount(row.ordinalCount, maxRows)) rejectHistory("HISTORY_KNOWLEDGE_BINDING_INVALID");
    seenUnits.add(unit.unitId);
    const binding: NonNullable<HistorySourceWitness["knowledgeBinding"]> = { resolutionReceiptHash: input.receiptSha256, semanticPlanHash: plan.semanticPlanSha256,
      unitId: unit.unitId, resourceIdentity: String(row.resourceIdentity), logicalSourceDisposition: row.logicalSourceDisposition as "distinct_chunk", revisionKind: row.revisionKind as "unversioned",
      logicalSourceIdentities: row.logicalSourceIdentities, resourceLocators: row.resourceLocators, ordinalCount: row.ordinalCount,
      disposition: decision.disposition as "lookup_only" | "quarantine" };
    for (const source of unit.sources) {
      exactObject(source, ["sourceRef", "sourceHash"]);
      if (!isRef(source.sourceRef) || !source.sourceRef.startsWith("knowledge:") || !isHash(source.sourceHash) || !isHash(unit.scopeFingerprint) || sourceBindings.has(source.sourceRef)) rejectHistory("HISTORY_KNOWLEDGE_COVERAGE_INVALID");
      sourceBindings.set(source.sourceRef, { sourceHash: source.sourceHash, scopeFingerprint: unit.scopeFingerprint, binding });
    }
  }
  const seenSources = new Set<string>(); let quarantine = 0;
  for (const raw of dispositionRows) {
    const row = exactObject(raw, ["schema", "sourceRef", "sourceHash", "unitId", "resourceIdentity", "scopeFingerprint", "cohort", "disposition", "logicalSourceDisposition", "revisionKind", "candidateOnly"]);
    const binding = sourceBindings.get(String(row.sourceRef)), decision = decisions.get(String(row.unitId));
    if (row.schema !== "mengshu.knowledge-source-disposition/v1" || row.candidateOnly !== false || !binding || !decision || row.unitId !== binding.binding.unitId || row.sourceHash !== binding.sourceHash || row.scopeFingerprint !== binding.scopeFingerprint ||
        seenSources.has(String(row.sourceRef)) || ["unitId", "resourceIdentity", "cohort", "disposition", "logicalSourceDisposition", "revisionKind"].some(key => row[key] !== decision[key])) rejectHistory("HISTORY_KNOWLEDGE_DISPOSITION_INVALID");
    seenSources.add(String(row.sourceRef)); if (row.disposition === "quarantine") quarantine++;
  }
  if (seenSources.size !== counts.sources || sourceBindings.size !== counts.sources || quarantine !== counts.quarantineSources) rejectHistory("HISTORY_KNOWLEDGE_COVERAGE_INVALID");
  const body = { receiptSha256: input.receiptSha256, semanticPlanSha256: plan.semanticPlanSha256, sourceManifestSha256: plan.sourceManifestSha256,
    sources: [...sourceBindings].map(([sourceRef, binding]) => ({ sourceRef, ...binding })).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef)), counts,
    canonicalTargetsSelected: false as const, formalAssetsWritten: false as const, supersedeAllowed: false as const };
  const result = { ...body, hash: historyHash(body) }; sealed.add(result); return result;
}

export function attachLegacyKnowledgeResolution(audit: HistoryAudit, resolution: LegacyKnowledgeResolution): HistoryAudit {
  verifyHistoryHash(audit); verifyHistoryHash(resolution);
  if (!sealed.has(resolution) || resolution.sourceManifestSha256 !== audit.parent.sourceManifestHash) rejectHistory("HISTORY_KNOWLEDGE_UNVERIFIED_RESOLUTION");
  const bySource = new Map(resolution.sources.map(source => [source.sourceRef, source]));
  const knowledge = audit.sources.filter(source => source.sourceRef.startsWith("knowledge:"));
  if (knowledge.length !== bySource.size || knowledge.some(source => !bySource.has(source.sourceRef))) rejectHistory("HISTORY_KNOWLEDGE_COVERAGE_INVALID");
  const next = structuredClone(audit);
  for (const source of next.sources) {
    const resolved = bySource.get(source.sourceRef); if (!resolved) continue;
    if (source.sourceHash !== resolved.sourceHash || source.scopeFingerprint !== resolved.scopeFingerprint) rejectHistory("HISTORY_KNOWLEDGE_SOURCE_DRIFT");
    source.knowledgeBinding = structuredClone(resolved.binding); validateHistorySource(source);
    if (resolved.binding.disposition === "quarantine") next.held.push({ ref: source.sourceRef, reason: "legacy_knowledge_quarantine" });
  }
  const { hash: _hash, ...body } = next;
  return { ...body, hash: historyHash(body) };
}
