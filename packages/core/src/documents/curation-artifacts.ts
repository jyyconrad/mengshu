import { createHash } from "node:crypto";
import { types as nodeUtilTypes } from "node:util";

import type { MemoryCurationBatchPlan } from "../db/migrations/markdown-curation-batch-planner.js";
import type { MemorySemanticType } from "../domain/types.js";
import { validateGovernedDocumentAssetVersion } from "./canonical.js";
import type {
  DocumentGovernanceState,
  DocumentLifecycleState,
  GovernanceDisposition,
  GovernedDocumentAssetVersion,
  GovernedDocumentKind,
  GovernedDocumentPurpose,
  GovernedTreeRef,
} from "./types.js";

export const CURATION_ARTIFACT_BUNDLE_SCHEMA =
  "mengshu.curation-artifact-bundle/v1" as const;
export const CURATION_BATCH_RECEIPT_SCHEMA =
  "mengshu.curation-batch-receipt/v1" as const;
export const CURATION_UNIT_DECISION_SCHEMA =
  "mengshu.curation-unit-decision/v1" as const;
export const CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA =
  "mengshu.curation-document-proposal-ref/v1" as const;
export const CURATION_RELATION_PROPOSAL_SCHEMA =
  "mengshu.curation-relation-proposal/v1" as const;
export const CURATION_REVIEW_VERDICT_SCHEMA =
  "mengshu.curation-review-verdict/v1" as const;
export const GOVERNED_CANONICAL_MANIFEST_SCHEMA =
  "mengshu.governed-canonical-manifest/v1" as const;
export const GOVERNED_ASSET_CATALOG_SCHEMA =
  "mengshu.governed-asset-catalog/v1" as const;
export const GOVERNED_INDEX_MANIFEST_SCHEMA =
  "mengshu.governed-index-manifest/v1" as const;

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,511}$/;
const SAFE_TEXT = /^[^\s\p{Cc}](?:[^\p{Cc}]{0,2046}[^\s\p{Cc}])?$/u;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const DOCUMENT_KINDS = new Set<GovernedDocumentKind>([
  "memory_document", "tree_document", "index_document",
]);
const DOCUMENT_PURPOSES = new Set<GovernedDocumentPurpose>([
  "typed_memory", "tree_summary", "home", "type_index", "tree_index",
  "project_index", "topic_index", "source_index", "document_index",
  "governance_catalog",
]);
const LIFECYCLE_STATES = new Set<DocumentLifecycleState>([
  "draft", "review", "active", "deprecated", "revoked",
]);
const GOVERNANCE_STATES = new Set<DocumentGovernanceState>([
  "current", "stale", "review_required", "conflicted",
]);
const DISPOSITIONS = new Set<GovernanceDisposition>([
  "attached_to_typed_document", "attached_and_routed", "tree_only", "native_only",
  "lookup_only", "rejected_below_threshold", "deferred", "redundant_with_evidence",
  "superseded", "archive_stale", "conflict", "quarantine",
]);

export type GovernedRelationType =
  | "related"
  | "references"
  | "derived_from"
  | "depends_on"
  | "supersedes"
  | "superseded_by"
  | "contradicts"
  | "tree_route";

const RELATION_TYPES = new Set<GovernedRelationType>([
  "related", "references", "derived_from", "depends_on", "supersedes",
  "superseded_by", "contradicts", "tree_route",
]);
const EVIDENCE_RELATIONS = new Set<GovernedRelationType>([
  "derived_from", "supersedes", "superseded_by", "contradicts",
]);
const PROPOSAL_GUARDS = [
  "agent_output_is_proposal_not_disposition",
  "postgres_activation_is_forbidden_during_curation",
] as const;

export class CurationArtifactContractError extends Error {
  constructor(message: string) {
    super(`CURATION_ARTIFACT_CONTRACT_INVALID: ${message}`);
    this.name = "CurationArtifactContractError";
  }
}

function fail(message: string): never {
  throw new CurationArtifactContractError(message);
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      nodeUtilTypes.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!plainRecord(value)) fail(`${label} shape or proxy is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} shape contains an unknown or missing key`);
  }
  return value;
}

function array(value: unknown, label: string, allowEmpty = true): readonly unknown[] {
  if (!Array.isArray(value) || nodeUtilTypes.isProxy(value) || (!allowEmpty && value.length === 0)) {
    fail(`${label} array or proxy is invalid`);
  }
  return value;
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !SAFE_ID.test(value)) {
    fail(`${label} ID is invalid`);
  }
  return value;
}

function safeText(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") || !SAFE_TEXT.test(value)) {
    fail(`${label} text is invalid`);
  }
  return value;
}

function hash(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${label} hash is invalid`);
  return value;
}

function iso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString() !== value) fail(`${label} ISO timestamp is invalid`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} count is invalid`);
  }
  return value;
}

function relativeMarkdownPath(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.normalize("NFC") ||
      value.startsWith("/") || value.includes("\\") || value.includes("//") ||
      /[\u0000-\u001f\u007f]/.test(value) || !value.endsWith(".md")) {
    fail(`${label} path is invalid`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(`${label} path is invalid`);
  }
  return value;
}

function stableValue(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("canonical hash input contains a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    if (nodeUtilTypes.isProxy(value) || seen.has(value)) fail("canonical hash input proxy/cycle");
    seen.add(value);
    const result = value.map((item) => stableValue(item, seen));
    seen.delete(value);
    return result;
  }
  if (!plainRecord(value) || seen.has(value)) fail("canonical hash input shape or proxy is invalid");
  seen.add(value);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (key !== key.normalize("NFC") || item === undefined || typeof item === "function" ||
        typeof item === "symbol" || typeof item === "bigint") {
      fail("canonical hash input is invalid");
    }
    result[key] = stableValue(item, seen);
  }
  seen.delete(value);
  return result;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function canonicalHash(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function serializedHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalSerialization(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function parseCanonicalJson(serialized: string, label: string): unknown {
  if (typeof serialized !== "string") fail(`${label} serialized value is invalid`);
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail(`${label} JSON is invalid`);
  }
  if (canonicalSerialization(value) !== serialized) fail(`${label} is not canonical JSON`);
  return value;
}

function stringList(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly identifiers?: boolean } = {},
): readonly string[] {
  const values = array(value, label, options.allowEmpty ?? true).map((item) =>
    options.identifiers ? safeId(item, label) : safeText(item, label));
  if (new Set(values).size !== values.length) fail(`${label} contains duplicates`);
  return Object.freeze(values);
}

export interface SourceBinding {
  readonly sourceRef: string;
  readonly sourceHash: string;
}

function sourceBinding(value: unknown, label: string): SourceBinding {
  const item = exactKeys(value, ["sourceRef", "sourceHash"], label);
  return Object.freeze({
    sourceRef: safeText(item.sourceRef, `${label}.sourceRef`),
    sourceHash: hash(item.sourceHash, `${label}.sourceHash`),
  });
}

function sourceBindings(value: unknown, label: string, allowEmpty = false): readonly SourceBinding[] {
  const bindings = array(value, label, allowEmpty).map((item, index) =>
    sourceBinding(item, `${label}[${index}]`));
  const refs = new Set<string>();
  for (const binding of bindings) {
    if (refs.has(binding.sourceRef)) fail(`${label} contains duplicate sourceRef`);
    refs.add(binding.sourceRef);
  }
  return Object.freeze(bindings);
}

function bindingKey(value: SourceBinding): string {
  return `${value.sourceRef}\0${value.sourceHash}`;
}

function exactBindingSet(left: readonly SourceBinding[], right: readonly SourceBinding[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right.map(bindingKey));
  return left.every((item) => expected.has(bindingKey(item)));
}

function semanticType(value: unknown, label: string): MemorySemanticType {
  if (typeof value !== "string" || !SEMANTIC_TYPES.has(value as MemorySemanticType)) {
    fail(`${label} semantic type is invalid`);
  }
  return value as MemorySemanticType;
}

export type CurationUnitDisposition =
  | "propose_asset"
  | "exclude"
  | "needs_review"
  | "defer";

export interface CurationUnitDecision {
  readonly schema: typeof CURATION_UNIT_DECISION_SCHEMA;
  readonly unitId: string;
  readonly scopeFingerprint: string | null;
  readonly sources: readonly SourceBinding[];
  readonly proposedSemanticType: MemorySemanticType | null;
  readonly disposition: CurationUnitDisposition;
  readonly documentProposalIds: readonly string[];
  readonly reasonCodes: readonly string[];
  readonly candidateOnly: true;
}

export interface CurationDocumentProposalRef {
  readonly schema: typeof CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA;
  readonly proposalId: string;
  readonly unitIds: readonly string[];
  readonly scopeFingerprint: string;
  readonly semanticType: MemorySemanticType;
  readonly relativePath: string;
  readonly markdownSha256: string;
  readonly sources: readonly SourceBinding[];
  readonly candidateOnly: true;
}

export interface CurationRelationProposal {
  readonly schema: typeof CURATION_RELATION_PROPOSAL_SCHEMA;
  readonly relationId: string;
  readonly sourceProposalId: string;
  readonly relationType: GovernedRelationType;
  readonly targetRef: string;
  readonly sourceScopeFingerprint: string;
  readonly targetScopeFingerprint: string;
  readonly sources: readonly SourceBinding[];
  readonly evidenceRefs: readonly string[];
  readonly routeReceiptHash: string | null;
  readonly candidateOnly: true;
}

export interface CurationReviewVerdict {
  readonly schema: typeof CURATION_REVIEW_VERDICT_SCHEMA;
  readonly verdictId: string;
  readonly proposalId: string;
  readonly reviewedArtifactHash: string;
  readonly reviewer: "agent" | "human" | "deterministic";
  readonly verdict: "accept" | "reject" | "needs_review";
  readonly reasonCodes: readonly string[];
  readonly createdAt: string;
  readonly candidateOnly: true;
}

export interface CurationArtifactSectionHashes {
  readonly unitDecisions: string;
  readonly documentProposals: string;
  readonly relationProposals: string;
  readonly reviewVerdicts: string;
}

export interface CurationBatchReceipt {
  readonly schema: typeof CURATION_BATCH_RECEIPT_SCHEMA;
  readonly batchId: string;
  readonly planSha256: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceManifestSha256: string;
  readonly preprocessedManifestSha256: string;
  readonly inventorySha256: string;
  readonly unitCount: number;
  readonly sourceCount: number;
  readonly sectionHashes: CurationArtifactSectionHashes;
  readonly candidateOnly: true;
  readonly canonicalTargetsSelected: false;
  readonly formalAssetsWritten: false;
  readonly treeArtifactsWritten: false;
  readonly postgresTouched: false;
  readonly createdAt: string;
}

export interface CurationArtifactBundle {
  readonly schema: typeof CURATION_ARTIFACT_BUNDLE_SCHEMA;
  readonly receipt: CurationBatchReceipt;
  readonly unitDecisions: readonly CurationUnitDecision[];
  readonly documentProposals: readonly CurationDocumentProposalRef[];
  readonly relationProposals: readonly CurationRelationProposal[];
  readonly reviewVerdicts: readonly CurationReviewVerdict[];
}

export type CurationArtifactListKind =
  | "unit-decisions"
  | "document-proposals"
  | "relation-proposals"
  | "review-verdicts";

const ARTIFACT_LIST_KINDS = new Set<CurationArtifactListKind>([
  "unit-decisions", "document-proposals", "relation-proposals", "review-verdicts",
]);

export function computeCurationArtifactListHash(
  kind: CurationArtifactListKind,
  values: readonly unknown[],
): string {
  if (!ARTIFACT_LIST_KINDS.has(kind) || !Array.isArray(values) || nodeUtilTypes.isProxy(values)) {
    fail("artifact list hash input is invalid");
  }
  return canonicalHash(`mengshu.curation-artifacts/${kind}/v1`, values);
}

function validateUnitDecision(value: unknown): CurationUnitDecision {
  const item = exactKeys(value, [
    "schema", "unitId", "scopeFingerprint", "sources", "proposedSemanticType",
    "disposition", "documentProposalIds", "reasonCodes", "candidateOnly",
  ], "unit decision");
  if (item.schema !== CURATION_UNIT_DECISION_SCHEMA) fail("unit decision schema is invalid");
  if (item.candidateOnly !== true) fail("unit decision must remain proposal-only");
  const disposition = item.disposition;
  if (!["propose_asset", "exclude", "needs_review", "defer"].includes(String(disposition))) {
    fail("unit decision disposition is invalid");
  }
  const proposedSemanticType = item.proposedSemanticType === null
    ? null : semanticType(item.proposedSemanticType, "unit decision");
  const scopeFingerprint = item.scopeFingerprint === null
    ? null : hash(item.scopeFingerprint, "unit scopeFingerprint");
  const documentProposalIds = stringList(item.documentProposalIds, "documentProposalIds", {
    allowEmpty: true, identifiers: true,
  });
  if (disposition === "propose_asset" &&
      (proposedSemanticType === null || documentProposalIds.length === 0)) {
    fail("propose_asset decision requires semantic type and document proposal");
  }
  if ((disposition === "exclude" || disposition === "defer") && documentProposalIds.length > 0) {
    fail("excluded/deferred unit cannot select a document proposal");
  }
  if (scopeFingerprint === null && disposition !== "exclude") {
    fail("only excluded unit decisions may omit scope");
  }
  return Object.freeze({
    schema: CURATION_UNIT_DECISION_SCHEMA,
    unitId: safeId(item.unitId, "unitId"),
    scopeFingerprint,
    sources: sourceBindings(item.sources, "unit decision sources"),
    proposedSemanticType,
    disposition: disposition as CurationUnitDisposition,
    documentProposalIds,
    reasonCodes: stringList(item.reasonCodes, "unit decision reasonCodes", {
      allowEmpty: false, identifiers: true,
    }),
    candidateOnly: true,
  });
}

function validateDocumentProposal(value: unknown): CurationDocumentProposalRef {
  const item = exactKeys(value, [
    "schema", "proposalId", "unitIds", "scopeFingerprint", "semanticType",
    "relativePath", "markdownSha256", "sources", "candidateOnly",
  ], "document proposal artifact ref");
  if (item.schema !== CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA) {
    fail("document proposal artifact schema is invalid");
  }
  if (item.candidateOnly !== true) fail("document proposal must remain proposal-only");
  const relativePath = relativeMarkdownPath(item.relativePath, "document proposal");
  if (!relativePath.startsWith("document-proposals/")) {
    fail("document proposal path must be under document-proposals");
  }
  return Object.freeze({
    schema: CURATION_DOCUMENT_PROPOSAL_REF_SCHEMA,
    proposalId: safeId(item.proposalId, "proposalId"),
    unitIds: stringList(item.unitIds, "proposal unitIds", {
      allowEmpty: false, identifiers: true,
    }),
    scopeFingerprint: hash(item.scopeFingerprint, "proposal scopeFingerprint"),
    semanticType: semanticType(item.semanticType, "proposal"),
    relativePath,
    markdownSha256: hash(item.markdownSha256, "proposal markdownSha256"),
    sources: sourceBindings(item.sources, "proposal sources"),
    candidateOnly: true,
  });
}

function validateRelationProposal(value: unknown): CurationRelationProposal {
  const item = exactKeys(value, [
    "schema", "relationId", "sourceProposalId", "relationType", "targetRef",
    "sourceScopeFingerprint", "targetScopeFingerprint", "sources", "evidenceRefs",
    "routeReceiptHash", "candidateOnly",
  ], "relation proposal");
  if (item.schema !== CURATION_RELATION_PROPOSAL_SCHEMA) fail("relation proposal schema is invalid");
  if (item.candidateOnly !== true) fail("relation proposal must remain proposal-only");
  if (typeof item.relationType !== "string" ||
      !RELATION_TYPES.has(item.relationType as GovernedRelationType)) {
    fail("relation type is invalid");
  }
  const relationType = item.relationType as GovernedRelationType;
  const evidenceRefs = stringList(item.evidenceRefs, "relation evidenceRefs", {
    allowEmpty: true, identifiers: true,
  });
  if (EVIDENCE_RELATIONS.has(relationType) && evidenceRefs.length === 0) {
    fail(`${relationType} relation requires evidence`);
  }
  const routeReceiptHash = item.routeReceiptHash === null
    ? null : hash(item.routeReceiptHash, "routeReceiptHash");
  if ((relationType === "tree_route") !== (routeReceiptHash !== null)) {
    fail("tree_route relation requires an exclusive route receipt hash");
  }
  const sourceScopeFingerprint = hash(item.sourceScopeFingerprint, "relation source scope");
  const targetScopeFingerprint = hash(item.targetScopeFingerprint, "relation target scope");
  if (sourceScopeFingerprint !== targetScopeFingerprint) fail("relation crosses scope");
  const sourceProposalId = safeId(item.sourceProposalId, "relation sourceProposalId");
  const targetRef = safeId(item.targetRef, "relation targetRef");
  if (["depends_on", "supersedes", "superseded_by"].includes(relationType) &&
      sourceProposalId === targetRef) fail("relation cannot target itself");
  return Object.freeze({
    schema: CURATION_RELATION_PROPOSAL_SCHEMA,
    relationId: safeId(item.relationId, "relationId"),
    sourceProposalId,
    relationType,
    targetRef,
    sourceScopeFingerprint,
    targetScopeFingerprint,
    sources: sourceBindings(item.sources, "relation sources"),
    evidenceRefs,
    routeReceiptHash,
    candidateOnly: true,
  });
}

function validateReviewVerdict(value: unknown): CurationReviewVerdict {
  const item = exactKeys(value, [
    "schema", "verdictId", "proposalId", "reviewedArtifactHash", "reviewer",
    "verdict", "reasonCodes", "createdAt", "candidateOnly",
  ], "review verdict");
  if (item.schema !== CURATION_REVIEW_VERDICT_SCHEMA) fail("review verdict schema is invalid");
  if (item.candidateOnly !== true) fail("review verdict must remain proposal-only");
  if (!["agent", "human", "deterministic"].includes(String(item.reviewer)) ||
      !["accept", "reject", "needs_review"].includes(String(item.verdict))) {
    fail("review verdict actor or decision is invalid");
  }
  return Object.freeze({
    schema: CURATION_REVIEW_VERDICT_SCHEMA,
    verdictId: safeId(item.verdictId, "verdictId"),
    proposalId: safeId(item.proposalId, "review proposalId"),
    reviewedArtifactHash: hash(item.reviewedArtifactHash, "reviewedArtifactHash"),
    reviewer: item.reviewer as CurationReviewVerdict["reviewer"],
    verdict: item.verdict as CurationReviewVerdict["verdict"],
    reasonCodes: stringList(item.reasonCodes, "review reasonCodes", {
      allowEmpty: false, identifiers: true,
    }),
    createdAt: iso(item.createdAt, "review createdAt"),
    candidateOnly: true,
  });
}

function validateBatchReceipt(value: unknown): CurationBatchReceipt {
  const item = exactKeys(value, [
    "schema", "batchId", "planSha256", "sourceSnapshotSha256", "sourceManifestSha256",
    "preprocessedManifestSha256", "inventorySha256", "unitCount", "sourceCount",
    "sectionHashes", "candidateOnly", "canonicalTargetsSelected", "formalAssetsWritten",
    "treeArtifactsWritten", "postgresTouched", "createdAt",
  ], "batch receipt");
  const section = exactKeys(item.sectionHashes, [
    "unitDecisions", "documentProposals", "relationProposals", "reviewVerdicts",
  ], "batch receipt section hashes");
  if (item.schema !== CURATION_BATCH_RECEIPT_SCHEMA) fail("batch receipt schema is invalid");
  if (item.candidateOnly !== true || item.canonicalTargetsSelected !== false ||
      item.formalAssetsWritten !== false || item.treeArtifactsWritten !== false ||
      item.postgresTouched !== false) {
    fail("batch receipt violates proposal/formal/postgres guards");
  }
  return Object.freeze({
    schema: CURATION_BATCH_RECEIPT_SCHEMA,
    batchId: safeId(item.batchId, "receipt batchId"),
    planSha256: hash(item.planSha256, "receipt planSha256"),
    sourceSnapshotSha256: hash(item.sourceSnapshotSha256, "receipt sourceSnapshotSha256"),
    sourceManifestSha256: hash(item.sourceManifestSha256, "receipt sourceManifestSha256"),
    preprocessedManifestSha256: hash(
      item.preprocessedManifestSha256, "receipt preprocessedManifestSha256",
    ),
    inventorySha256: hash(item.inventorySha256, "receipt inventorySha256"),
    unitCount: nonNegativeInteger(item.unitCount, "receipt unitCount"),
    sourceCount: nonNegativeInteger(item.sourceCount, "receipt sourceCount"),
    sectionHashes: Object.freeze({
      unitDecisions: hash(section.unitDecisions, "unitDecisions section hash"),
      documentProposals: hash(section.documentProposals, "documentProposals section hash"),
      relationProposals: hash(section.relationProposals, "relationProposals section hash"),
      reviewVerdicts: hash(section.reviewVerdicts, "reviewVerdicts section hash"),
    }),
    candidateOnly: true,
    canonicalTargetsSelected: false,
    formalAssetsWritten: false,
    treeArtifactsWritten: false,
    postgresTouched: false,
    createdAt: iso(item.createdAt, "receipt createdAt"),
  });
}

function planUnitBindings(
  plan: MemoryCurationBatchPlan,
  unitId: string,
): readonly SourceBinding[] {
  const unit = plan.units.find((candidate) => candidate.unitId === unitId);
  if (!unit || unit.files.length !== unit.sourceCount ||
      unit.sourceRefs.length !== unit.sourceHashes.length) {
    fail("batch plan unit/source binding is invalid");
  }
  const fileBindings = sourceBindings(unit.files.map((file) => ({
    sourceRef: file.sourceRef,
    sourceHash: file.sourceHash,
  })), `plan unit ${unitId} file sources`);
  const legacyBindings = sourceBindings(unit.sourceRefs.map((sourceRef, index) => ({
    sourceRef,
    sourceHash: unit.sourceHashes[index],
  })), `plan unit ${unitId} legacy sources`);
  if (!exactBindingSet(fileBindings, legacyBindings)) fail("batch plan source binding drifted");
  return fileBindings;
}

function exactIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const actual = new Set(left);
  const expected = new Set(right);
  return actual.size === left.length && expected.size === right.length &&
    actual.size === expected.size && [...actual].every((item) => expected.has(item));
}

function assertNoDependsOnCycle(relations: readonly CurationRelationProposal[]): void {
  const edges = new Map<string, string[]>();
  for (const relation of relations.filter((item) => item.relationType === "depends_on")) {
    const current = edges.get(relation.sourceProposalId) ?? [];
    current.push(relation.targetRef);
    edges.set(relation.sourceProposalId, current);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): void => {
    if (visiting.has(node)) fail("depends_on relation contains a cycle");
    if (visited.has(node)) return;
    visiting.add(node);
    for (const target of edges.get(node) ?? []) visit(target);
    visiting.delete(node);
    visited.add(node);
  };
  for (const node of edges.keys()) visit(node);
}

export interface ValidateCurationArtifactBundleContext {
  readonly plan: MemoryCurationBatchPlan;
  readonly batchId: string;
}

export function validateCurationArtifactBundle(
  value: unknown,
  context: ValidateCurationArtifactBundleContext,
): CurationArtifactBundle {
  const root = exactKeys(value, [
    "schema", "receipt", "unitDecisions", "documentProposals", "relationProposals",
    "reviewVerdicts",
  ], "curation artifact bundle");
  if (root.schema !== CURATION_ARTIFACT_BUNDLE_SCHEMA) fail("artifact bundle schema is invalid");
  if (!plainRecord(context) || !context.plan || typeof context.batchId !== "string") {
    fail("artifact validation context is invalid");
  }
  const batch = context.plan.batches.find((candidate) => candidate.batchId === context.batchId);
  if (!batch || PROPOSAL_GUARDS.some((guard) => !context.plan.guards.includes(guard))) {
    fail("batch plan proposal-only guard is invalid");
  }
  const receipt = validateBatchReceipt(root.receipt);
  if (receipt.batchId !== context.batchId || receipt.planSha256 !== context.plan.planSha256 ||
      receipt.sourceSnapshotSha256 !== context.plan.sourceSnapshotSha256 ||
      receipt.sourceManifestSha256 !== context.plan.sourceManifestSha256 ||
      receipt.preprocessedManifestSha256 !== context.plan.preprocessedManifestSha256 ||
      receipt.inventorySha256 !== context.plan.inventorySha256) {
    fail("batch receipt frozen hash or batch identity drifted");
  }

  const rawUnitDecisions = array(root.unitDecisions, "unit decisions");
  const rawDocumentProposals = array(root.documentProposals, "document proposals");
  const rawRelationProposals = array(root.relationProposals, "relation proposals");
  const rawReviewVerdicts = array(root.reviewVerdicts, "review verdicts");
  const sectionHashes: CurationArtifactSectionHashes = {
    unitDecisions: computeCurationArtifactListHash("unit-decisions", rawUnitDecisions),
    documentProposals: computeCurationArtifactListHash("document-proposals", rawDocumentProposals),
    relationProposals: computeCurationArtifactListHash("relation-proposals", rawRelationProposals),
    reviewVerdicts: computeCurationArtifactListHash("review-verdicts", rawReviewVerdicts),
  };
  if (Object.entries(sectionHashes).some(([key, expected]) =>
    receipt.sectionHashes[key as keyof CurationArtifactSectionHashes] !== expected)) {
    fail("batch receipt section hash drifted");
  }

  const unitDecisions = Object.freeze(rawUnitDecisions.map(validateUnitDecision));
  const decisionByUnit = new Map<string, CurationUnitDecision>();
  const coveredSources: SourceBinding[] = [];
  for (const decision of unitDecisions) {
    if (decisionByUnit.has(decision.unitId) || !batch.unitIds.includes(decision.unitId)) {
      fail("unit decision coverage contains duplicate or foreign unit");
    }
    const unit = context.plan.units.find((candidate) => candidate.unitId === decision.unitId)!;
    const expectedBindings = planUnitBindings(context.plan, decision.unitId);
    if (decision.scopeFingerprint !== (unit.scopeFingerprint ?? null) ||
        !exactBindingSet(decision.sources, expectedBindings)) {
      fail("unit source binding or scope coverage drifted");
    }
    decisionByUnit.set(decision.unitId, decision);
    coveredSources.push(...decision.sources);
  }
  if (!exactIdSet([...decisionByUnit.keys()], batch.unitIds) ||
      receipt.unitCount !== batch.unitIds.length || receipt.sourceCount !== batch.sourceCount ||
      coveredSources.length !== batch.sourceCount ||
      new Set(coveredSources.map((item) => item.sourceRef)).size !== coveredSources.length) {
    fail("batch unit/source coverage is incomplete");
  }

  const documentProposals = Object.freeze(rawDocumentProposals.map(validateDocumentProposal));
  const proposalById = new Map<string, CurationDocumentProposalRef>();
  for (const proposal of documentProposals) {
    if (proposalById.has(proposal.proposalId) ||
        proposal.unitIds.some((unitId) => !decisionByUnit.has(unitId))) {
      fail("document proposal coverage contains duplicate or foreign identity");
    }
    const decisions = proposal.unitIds.map((unitId) => decisionByUnit.get(unitId)!);
    const expectedBindings = decisions.flatMap((decision) => decision.sources);
    if (decisions.some((decision) => decision.scopeFingerprint !== proposal.scopeFingerprint ||
        decision.proposedSemanticType !== proposal.semanticType ||
        !decision.documentProposalIds.includes(proposal.proposalId)) ||
        !exactBindingSet(proposal.sources, expectedBindings)) {
      fail("document proposal unit/source binding coverage drifted");
    }
    proposalById.set(proposal.proposalId, proposal);
  }
  const selectedProposalIds = [...new Set(unitDecisions.flatMap((item) => item.documentProposalIds))];
  if (!exactIdSet([...proposalById.keys()], selectedProposalIds)) {
    fail("document proposal coverage is incomplete");
  }

  const relationProposals = Object.freeze(rawRelationProposals.map(validateRelationProposal));
  const relationIds = new Set<string>();
  for (const relation of relationProposals) {
    const source = proposalById.get(relation.sourceProposalId);
    const target = proposalById.get(relation.targetRef);
    if (!source || relationIds.has(relation.relationId) ||
        relation.sourceScopeFingerprint !== source.scopeFingerprint ||
        target && relation.targetScopeFingerprint !== target.scopeFingerprint ||
        !relation.sources.every((binding) =>
          source.sources.some((candidate) => bindingKey(candidate) === bindingKey(binding)))) {
      fail("relation endpoint/scope/source binding is invalid");
    }
    relationIds.add(relation.relationId);
  }
  assertNoDependsOnCycle(relationProposals);

  const reviewVerdicts = Object.freeze(rawReviewVerdicts.map(validateReviewVerdict));
  const verdictIds = new Set<string>();
  for (const verdict of reviewVerdicts) {
    const proposal = proposalById.get(verdict.proposalId);
    if (!proposal || verdictIds.has(verdict.verdictId) ||
        verdict.reviewedArtifactHash !== proposal.markdownSha256) {
      fail("review verdict proposal/hash coverage is invalid");
    }
    verdictIds.add(verdict.verdictId);
  }

  return deepFreeze({
    schema: CURATION_ARTIFACT_BUNDLE_SCHEMA,
    receipt,
    unitDecisions,
    documentProposals,
    relationProposals,
    reviewVerdicts,
  });
}

export interface GovernedCanonicalManifestAsset {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly schemaVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType: MemorySemanticType | null;
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly treeRef: GovernedTreeRef | null;
  readonly title: string;
  readonly scopeFingerprint: string;
  readonly canonicalPath: string;
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
  readonly lifecycleState: DocumentLifecycleState;
  readonly governanceState: DocumentGovernanceState;
  readonly markdownSha256: string;
  readonly status: "complete";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GovernedCanonicalTargetPointer {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly schemaVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType: MemorySemanticType | null;
  readonly scopeFingerprint: string;
  readonly canonicalPath: string;
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
}

export interface GovernedCanonicalSourceMapping {
  readonly source: SourceBinding;
  readonly scopeFingerprint: string;
  readonly disposition: GovernanceDisposition;
  readonly targets: readonly GovernedCanonicalTargetPointer[];
  readonly evidenceRefs: readonly string[];
  readonly reasonCode: string;
}

export interface GovernedCanonicalManifest {
  readonly schema: typeof GOVERNED_CANONICAL_MANIFEST_SCHEMA;
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceSnapshotSha256: string;
  readonly sourceCount: number;
  readonly assetCount: number;
  readonly assets: readonly GovernedCanonicalManifestAsset[];
  readonly sourceMappings: readonly GovernedCanonicalSourceMapping[];
  readonly artifactSetHash: string;
}

export interface CreateGovernedCanonicalManifestInput {
  readonly governanceRunId: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly sourceSnapshotSha256: string;
  readonly expectedSources: readonly SourceBinding[];
  readonly assets: readonly {
    readonly asset: GovernedDocumentAssetVersion;
    readonly canonicalPath: string;
    readonly markdownSha256: string;
  }[];
  readonly sourceMappings: readonly {
    readonly source: SourceBinding;
    readonly scopeFingerprint: string;
    readonly disposition: GovernanceDisposition;
    readonly targetAssetIds: readonly string[];
    readonly evidenceRefs: readonly string[];
    readonly reasonCode: string;
  }[];
}

function normalizedTreeRef(value: unknown, label: string): GovernedTreeRef | null {
  if (value === null) return null;
  const item = exactKeys(value, ["treeType", "level", "treeKey", "nodeId", "sealVersion"], label);
  if (!["source", "topic", "global"].includes(String(item.treeType)) ||
      !["L1", "L2", "L3"].includes(String(item.level)) ||
      typeof item.sealVersion !== "number" || !Number.isSafeInteger(item.sealVersion) ||
      item.sealVersion < 1) fail(`${label} is invalid`);
  return Object.freeze({
    treeType: item.treeType as GovernedTreeRef["treeType"],
    level: item.level as GovernedTreeRef["level"],
    treeKey: safeId(item.treeKey, `${label}.treeKey`),
    nodeId: safeId(item.nodeId, `${label}.nodeId`),
    sealVersion: item.sealVersion,
  });
}

function canonicalAssetFromGoverned(
  input: CreateGovernedCanonicalManifestInput["assets"][number],
): GovernedCanonicalManifestAsset {
  const asset = validateGovernedDocumentAssetVersion(input.asset);
  if (asset.lifecycleState !== "active" || asset.governanceState !== "current") {
    fail("formal canonical asset must be active/current complete");
  }
  return Object.freeze({
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    schemaVersion: asset.schemaVersion,
    kind: asset.kind,
    purpose: asset.purpose,
    semanticType: asset.semanticType ?? null,
    semanticTypes: Object.freeze([...(asset.semanticTypes ?? [])]),
    treeRef: asset.treeRef ? Object.freeze({ ...asset.treeRef }) : null,
    title: safeText(asset.title, "canonical asset title"),
    scopeFingerprint: asset.scopeFingerprint,
    canonicalPath: relativeMarkdownPath(input.canonicalPath, "canonical asset"),
    publicContentHash: asset.publicContentHash,
    governanceProjectionHash: asset.governanceProjectionHash,
    lifecycleState: asset.lifecycleState,
    governanceState: asset.governanceState,
    markdownSha256: hash(input.markdownSha256, "canonical markdownSha256"),
    status: "complete",
    createdAt: iso(asset.createdAt, "canonical asset createdAt"),
    updatedAt: iso(asset.updatedAt, "canonical asset updatedAt"),
  });
}

function canonicalPointer(asset: GovernedCanonicalManifestAsset): GovernedCanonicalTargetPointer {
  return Object.freeze({
    assetId: asset.assetId,
    assetVersion: asset.assetVersion,
    schemaVersion: asset.schemaVersion,
    kind: asset.kind,
    purpose: asset.purpose,
    semanticType: asset.semanticType,
    scopeFingerprint: asset.scopeFingerprint,
    canonicalPath: asset.canonicalPath,
    publicContentHash: asset.publicContentHash,
    governanceProjectionHash: asset.governanceProjectionHash,
  });
}

function targetRequired(disposition: GovernanceDisposition): boolean {
  return [
    "attached_to_typed_document", "attached_and_routed", "tree_only",
    "redundant_with_evidence", "superseded", "conflict",
  ].includes(disposition);
}

function targetForbidden(disposition: GovernanceDisposition): boolean {
  return [
    "native_only", "lookup_only", "rejected_below_threshold", "deferred",
    "archive_stale", "quarantine",
  ].includes(disposition);
}

function canonicalManifestBody(input: Omit<GovernedCanonicalManifest, "artifactSetHash">): string {
  return canonicalHash("mengshu.governed-canonical-manifest/artifact-set/v1", input);
}

export function createGovernedCanonicalManifest(
  input: CreateGovernedCanonicalManifestInput,
): GovernedCanonicalManifest {
  if (!plainRecord(input)) fail("canonical manifest input shape is invalid");
  const expectedSources = sourceBindings(input.expectedSources, "expected canonical sources", true);
  if (!Array.isArray(input.assets) || nodeUtilTypes.isProxy(input.assets) ||
      !Array.isArray(input.sourceMappings) || nodeUtilTypes.isProxy(input.sourceMappings)) {
    fail("canonical manifest asset/mapping shape is invalid");
  }
  const assets = input.assets.map(canonicalAssetFromGoverned).sort((left, right) =>
    left.canonicalPath.localeCompare(right.canonicalPath));
  const assetById = new Map<string, GovernedCanonicalManifestAsset>();
  const portablePaths = new Set<string>();
  for (const asset of assets) {
    const portablePath = asset.canonicalPath.toLowerCase();
    if (assetById.has(asset.assetId) || portablePaths.has(portablePath)) {
      fail("canonical asset identity/path is duplicated");
    }
    assetById.set(asset.assetId, asset);
    portablePaths.add(portablePath);
  }

  const mappings = input.sourceMappings.map((raw, index): GovernedCanonicalSourceMapping => {
    const item = exactKeys(raw, [
      "source", "scopeFingerprint", "disposition", "targetAssetIds", "evidenceRefs", "reasonCode",
    ], `canonical source mapping[${index}]`);
    if (typeof item.disposition !== "string" ||
        !DISPOSITIONS.has(item.disposition as GovernanceDisposition)) {
      fail("canonical source disposition is invalid");
    }
    const disposition = item.disposition as GovernanceDisposition;
    const scopeFingerprint = hash(item.scopeFingerprint, "mapping scopeFingerprint");
    const targetAssetIds = stringList(item.targetAssetIds, "mapping targetAssetIds", {
      allowEmpty: true, identifiers: true,
    });
    const evidenceRefs = stringList(item.evidenceRefs, "mapping evidenceRefs", {
      allowEmpty: true, identifiers: true,
    });
    if ((targetRequired(disposition) && (targetAssetIds.length === 0 || evidenceRefs.length === 0)) ||
        (targetForbidden(disposition) && targetAssetIds.length > 0)) {
      fail("canonical source disposition target contract is invalid");
    }
    const targets = targetAssetIds.map((assetId) => {
      const asset = assetById.get(assetId);
      if (!asset || asset.scopeFingerprint !== scopeFingerprint) {
        fail("canonical source target is missing or crosses scope");
      }
      return canonicalPointer(asset);
    });
    return Object.freeze({
      source: sourceBinding(item.source, "canonical source mapping binding"),
      scopeFingerprint,
      disposition,
      targets: Object.freeze(targets),
      evidenceRefs,
      reasonCode: safeId(item.reasonCode, "mapping reasonCode"),
    });
  }).sort((left, right) => left.source.sourceRef.localeCompare(right.source.sourceRef));
  const actualSources = mappings.map((mapping) => mapping.source);
  if (!exactBindingSet(actualSources, expectedSources) ||
      new Set(actualSources.map((item) => item.sourceRef)).size !== actualSources.length) {
    fail("canonical source binding coverage is incomplete or drifted");
  }
  const body = {
    schema: GOVERNED_CANONICAL_MANIFEST_SCHEMA,
    governanceRunId: safeId(input.governanceRunId, "governanceRunId"),
    policyVersion: safeText(input.policyVersion, "policyVersion"),
    createdAt: iso(input.createdAt, "canonical manifest createdAt"),
    sourceSnapshotSha256: hash(input.sourceSnapshotSha256, "sourceSnapshotSha256"),
    sourceCount: expectedSources.length,
    assetCount: assets.length,
    assets: Object.freeze(assets),
    sourceMappings: Object.freeze(mappings),
  } as const;
  return deepFreeze({ ...body, artifactSetHash: canonicalManifestBody(body) });
}

function validateCanonicalAsset(value: unknown): GovernedCanonicalManifestAsset {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "schemaVersion", "kind", "purpose", "semanticType",
    "semanticTypes", "treeRef", "title", "scopeFingerprint", "canonicalPath", "publicContentHash",
    "governanceProjectionHash", "lifecycleState", "governanceState", "markdownSha256",
    "status", "createdAt", "updatedAt",
  ], "canonical manifest asset");
  if (!DOCUMENT_KINDS.has(item.kind as GovernedDocumentKind) ||
      !DOCUMENT_PURPOSES.has(item.purpose as GovernedDocumentPurpose) || item.schemaVersion !== 1 ||
      item.status !== "complete" || item.lifecycleState !== "active" ||
      item.governanceState !== "current") fail("canonical complete asset identity/state is invalid");
  const semantic = item.semanticType === null ? null : semanticType(item.semanticType, "canonical asset");
  const semanticTypes = array(item.semanticTypes, "canonical semanticTypes").map((candidate) =>
    semanticType(candidate, "canonical semanticTypes"));
  if (new Set(semanticTypes).size !== semanticTypes.length) {
    fail("canonical semanticTypes contains duplicates");
  }
  const treeRef = normalizedTreeRef(item.treeRef, "canonical treeRef");
  const assetVersion = nonNegativeInteger(item.assetVersion, "canonical assetVersion");
  if (assetVersion < 1) fail("canonical assetVersion must be positive");
  if (item.kind === "memory_document") {
    if (item.purpose !== "typed_memory" || semantic === null || semanticTypes.length > 0 || treeRef) {
      fail("canonical memory asset kind contract is invalid");
    }
  } else if (item.kind === "tree_document") {
    const expectedLevel = treeRef && ({ source: "L1", topic: "L2", global: "L3" } as const)[
      treeRef.treeType
    ];
    if (item.purpose !== "tree_summary" || semantic !== null || semanticTypes.length === 0 ||
        !treeRef || treeRef.level !== expectedLevel) {
      fail("canonical tree asset kind contract is invalid");
    }
  } else if (item.purpose === "typed_memory" || item.purpose === "tree_summary" ||
      semantic !== null || semanticTypes.length > 0 || treeRef) {
    fail("canonical index asset kind contract is invalid");
  }
  const createdAt = iso(item.createdAt, "canonical asset createdAt");
  const updatedAt = iso(item.updatedAt, "canonical asset updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) fail("canonical asset updatedAt precedes createdAt");
  return Object.freeze({
    assetId: safeId(item.assetId, "canonical assetId"),
    assetVersion,
    schemaVersion: 1,
    kind: item.kind as GovernedDocumentKind,
    purpose: item.purpose as GovernedDocumentPurpose,
    semanticType: semantic,
    semanticTypes: Object.freeze(semanticTypes),
    treeRef,
    title: safeText(item.title, "canonical asset title"),
    scopeFingerprint: hash(item.scopeFingerprint, "canonical scopeFingerprint"),
    canonicalPath: relativeMarkdownPath(item.canonicalPath, "canonical asset"),
    publicContentHash: hash(item.publicContentHash, "canonical publicContentHash"),
    governanceProjectionHash: hash(
      item.governanceProjectionHash, "canonical governanceProjectionHash",
    ),
    lifecycleState: item.lifecycleState as DocumentLifecycleState,
    governanceState: item.governanceState as DocumentGovernanceState,
    markdownSha256: hash(item.markdownSha256, "canonical markdownSha256"),
    status: "complete",
    createdAt,
    updatedAt,
  });
}

function validateCanonicalPointer(
  value: unknown,
  assetById: ReadonlyMap<string, GovernedCanonicalManifestAsset>,
  scopeFingerprint: string,
): GovernedCanonicalTargetPointer {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "schemaVersion", "kind", "scopeFingerprint", "canonicalPath",
    "purpose", "semanticType", "publicContentHash", "governanceProjectionHash",
  ], "canonical target pointer");
  const assetId = safeId(item.assetId, "target assetId");
  const asset = assetById.get(assetId);
  if (!asset || scopeFingerprint !== asset.scopeFingerprint) {
    fail("canonical target pointer is missing or crosses scope");
  }
  const pointer = canonicalPointer(asset);
  if (JSON.stringify(stableValue(pointer)) !== JSON.stringify(stableValue(item))) {
    fail("canonical target identity/hash/path drifted");
  }
  return pointer;
}

export function validateGovernedCanonicalManifest(
  value: unknown,
  expectedSources?: readonly SourceBinding[],
): GovernedCanonicalManifest {
  const item = exactKeys(value, [
    "schema", "governanceRunId", "policyVersion", "createdAt", "sourceSnapshotSha256",
    "sourceCount", "assetCount", "assets", "sourceMappings", "artifactSetHash",
  ], "governed canonical manifest");
  if (item.schema !== GOVERNED_CANONICAL_MANIFEST_SCHEMA) fail("canonical manifest schema is invalid");
  const assets = array(item.assets, "canonical manifest assets").map(validateCanonicalAsset);
  if (assets.length !== nonNegativeInteger(item.assetCount, "canonical assetCount")) {
    fail("canonical asset coverage count drifted");
  }
  const assetById = new Map<string, GovernedCanonicalManifestAsset>();
  const paths = new Set<string>();
  for (const asset of assets) {
    const path = asset.canonicalPath.toLowerCase();
    if (asset.assetVersion < 1 || assetById.has(asset.assetId) || paths.has(path)) {
      fail("canonical asset identity/path is duplicated");
    }
    assetById.set(asset.assetId, asset);
    paths.add(path);
  }
  const mappings = array(item.sourceMappings, "canonical sourceMappings").map((raw, index) => {
    const mapping = exactKeys(raw, [
      "source", "scopeFingerprint", "disposition", "targets", "evidenceRefs", "reasonCode",
    ], `canonical source mapping[${index}]`);
    if (typeof mapping.disposition !== "string" ||
        !DISPOSITIONS.has(mapping.disposition as GovernanceDisposition)) {
      fail("canonical source disposition is invalid");
    }
    const disposition = mapping.disposition as GovernanceDisposition;
    const scopeFingerprint = hash(mapping.scopeFingerprint, "mapping scopeFingerprint");
    const targets = array(mapping.targets, "mapping targets").map((target) =>
      validateCanonicalPointer(target, assetById, scopeFingerprint));
    const evidenceRefs = stringList(mapping.evidenceRefs, "mapping evidenceRefs", {
      allowEmpty: true, identifiers: true,
    });
    if ((targetRequired(disposition) && (targets.length === 0 || evidenceRefs.length === 0)) ||
        (targetForbidden(disposition) && targets.length > 0)) {
      fail("canonical source disposition target contract is invalid");
    }
    return Object.freeze({
      source: sourceBinding(mapping.source, "canonical source mapping binding"),
      scopeFingerprint,
      disposition,
      targets: Object.freeze(targets),
      evidenceRefs,
      reasonCode: safeId(mapping.reasonCode, "mapping reasonCode"),
    });
  });
  const sourceCount = nonNegativeInteger(item.sourceCount, "canonical sourceCount");
  if (mappings.length !== sourceCount ||
      new Set(mappings.map((mapping) => mapping.source.sourceRef)).size !== mappings.length) {
    fail("canonical source mapping coverage is incomplete or duplicated");
  }
  if (expectedSources !== undefined && !exactBindingSet(
    mappings.map((mapping) => mapping.source),
    sourceBindings(expectedSources, "expected canonical source snapshot", true),
  )) {
    fail("canonical source mapping drifted from the expected source snapshot");
  }
  const body = {
    schema: GOVERNED_CANONICAL_MANIFEST_SCHEMA,
    governanceRunId: safeId(item.governanceRunId, "governanceRunId"),
    policyVersion: safeText(item.policyVersion, "policyVersion"),
    createdAt: iso(item.createdAt, "canonical manifest createdAt"),
    sourceSnapshotSha256: hash(item.sourceSnapshotSha256, "sourceSnapshotSha256"),
    sourceCount,
    assetCount: assets.length,
    assets: Object.freeze(assets),
    sourceMappings: Object.freeze(mappings),
  } as const;
  const artifactSetHash = hash(item.artifactSetHash, "canonical artifactSetHash");
  if (canonicalManifestBody(body) !== artifactSetHash) fail("canonical artifact set hash drifted");
  return deepFreeze({ ...body, artifactSetHash });
}

export function serializeGovernedCanonicalManifest(value: GovernedCanonicalManifest): string {
  return canonicalSerialization(validateGovernedCanonicalManifest(value));
}

export function parseGovernedCanonicalManifest(
  serialized: string,
  expectedSources?: readonly SourceBinding[],
): GovernedCanonicalManifest {
  return validateGovernedCanonicalManifest(
    parseCanonicalJson(serialized, "canonical manifest"),
    expectedSources,
  );
}

export function governedCanonicalManifestSha256(
  serialized: string,
  expectedSources?: readonly SourceBinding[],
): string {
  parseGovernedCanonicalManifest(serialized, expectedSources);
  return serializedHash(serialized);
}

export interface GovernedAssetCatalogEntry extends GovernedCanonicalManifestAsset {
  readonly projects: readonly string[];
  readonly topics: readonly string[];
  readonly sources: readonly SourceBinding[];
  readonly relatedAssetIds: readonly string[];
  readonly sectionIds: readonly string[];
}

export interface GovernedAssetCatalog {
  readonly schema: typeof GOVERNED_ASSET_CATALOG_SCHEMA;
  readonly canonicalManifestHash: string;
  readonly canonicalManifestSha256: string;
  readonly createdAt: string;
  readonly assetCount: number;
  readonly assets: readonly GovernedAssetCatalogEntry[];
  readonly catalogHash: string;
}

export interface CreateGovernedAssetCatalogInput {
  readonly canonicalManifest: GovernedCanonicalManifest;
  readonly canonicalManifestSha256: string;
  readonly createdAt: string;
  readonly memberships: readonly {
    readonly assetId: string;
    readonly projects: readonly string[];
    readonly topics: readonly string[];
    readonly relatedAssetIds: readonly string[];
    readonly sectionIds: readonly string[];
  }[];
}

function catalogBody(input: Omit<GovernedAssetCatalog, "catalogHash">): string {
  return canonicalHash("mengshu.governed-asset-catalog/content/v1", input);
}

function sourcesByAsset(manifest: GovernedCanonicalManifest): ReadonlyMap<string, readonly SourceBinding[]> {
  const values = new Map<string, SourceBinding[]>();
  for (const mapping of manifest.sourceMappings) {
    for (const target of mapping.targets) {
      const current = values.get(target.assetId) ?? [];
      current.push(mapping.source);
      values.set(target.assetId, current);
    }
  }
  return new Map([...values].map(([assetId, sources]) => [
    assetId,
    Object.freeze(sources.sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))),
  ]));
}

export function createGovernedAssetCatalog(
  input: CreateGovernedAssetCatalogInput,
): GovernedAssetCatalog {
  if (!plainRecord(input)) fail("asset catalog input shape is invalid");
  const manifest = validateGovernedCanonicalManifest(input.canonicalManifest);
  const canonicalSerialized = serializeGovernedCanonicalManifest(manifest);
  const canonicalManifestSha256 = hash(
    input.canonicalManifestSha256, "catalog canonicalManifestSha256",
  );
  if (serializedHash(canonicalSerialized) !== canonicalManifestSha256) {
    fail("catalog canonical manifest hash drifted");
  }
  const memberships = array(input.memberships, "catalog memberships");
  const membershipById = new Map<string, Record<string, unknown>>();
  for (const raw of memberships) {
    const membership = exactKeys(raw, [
      "assetId", "projects", "topics", "relatedAssetIds", "sectionIds",
    ], "catalog membership");
    const assetId = safeId(membership.assetId, "catalog membership assetId");
    if (membershipById.has(assetId)) fail("catalog membership asset is duplicated");
    membershipById.set(assetId, membership);
  }
  if (!exactIdSet([...membershipById.keys()], manifest.assets.map((asset) => asset.assetId))) {
    fail("catalog membership asset coverage is incomplete");
  }
  const sourceMap = sourcesByAsset(manifest);
  const catalogAssets = manifest.assets.map((asset): GovernedAssetCatalogEntry => {
    const membership = membershipById.get(asset.assetId)!;
    return Object.freeze({
      ...asset,
      projects: stringList(membership.projects, "catalog projects", { allowEmpty: true }),
      topics: stringList(membership.topics, "catalog topics", { allowEmpty: true }),
      sources: sourceMap.get(asset.assetId) ?? Object.freeze([]),
      relatedAssetIds: stringList(membership.relatedAssetIds, "catalog relatedAssetIds", {
        allowEmpty: true, identifiers: true,
      }),
      sectionIds: stringList(membership.sectionIds, "catalog sectionIds", {
        allowEmpty: true, identifiers: true,
      }),
    });
  }).sort((left, right) => left.canonicalPath.localeCompare(right.canonicalPath));
  const catalogById = new Map(catalogAssets.map((asset) => [asset.assetId, asset] as const));
  for (const asset of catalogAssets) {
    for (const relatedAssetId of asset.relatedAssetIds) {
      const target = catalogById.get(relatedAssetId);
      if (!target || target.scopeFingerprint !== asset.scopeFingerprint) {
        fail("catalog related target is missing or crosses scope");
      }
    }
  }
  const body = {
    schema: GOVERNED_ASSET_CATALOG_SCHEMA,
    canonicalManifestHash: manifest.artifactSetHash,
    canonicalManifestSha256,
    createdAt: iso(input.createdAt, "catalog createdAt"),
    assetCount: catalogAssets.length,
    assets: Object.freeze(catalogAssets),
  } as const;
  return deepFreeze({ ...body, catalogHash: catalogBody(body) });
}

function validateCatalogEntry(value: unknown): GovernedAssetCatalogEntry {
  const item = exactKeys(value, [
    "assetId", "assetVersion", "schemaVersion", "kind", "purpose", "semanticType",
    "semanticTypes", "treeRef", "title", "scopeFingerprint", "canonicalPath", "publicContentHash",
    "governanceProjectionHash", "lifecycleState", "governanceState", "markdownSha256",
    "status", "createdAt", "updatedAt", "projects", "topics", "sources", "relatedAssetIds",
    "sectionIds",
  ], "asset catalog entry");
  const canonical = validateCanonicalAsset(Object.fromEntries(Object.entries(item).filter(([key]) =>
    !["projects", "topics", "sources", "relatedAssetIds", "sectionIds"].includes(key))));
  return Object.freeze({
    ...canonical,
    projects: stringList(item.projects, "catalog projects", { allowEmpty: true }),
    topics: stringList(item.topics, "catalog topics", { allowEmpty: true }),
    sources: sourceBindings(item.sources, "catalog sources", true),
    relatedAssetIds: stringList(item.relatedAssetIds, "catalog relatedAssetIds", {
      allowEmpty: true, identifiers: true,
    }),
    sectionIds: stringList(item.sectionIds, "catalog sectionIds", {
      allowEmpty: true, identifiers: true,
    }),
  });
}

export function validateGovernedAssetCatalog(
  value: unknown,
  canonicalManifest?: GovernedCanonicalManifest,
): GovernedAssetCatalog {
  const item = exactKeys(value, [
    "schema", "canonicalManifestHash", "canonicalManifestSha256", "createdAt", "assetCount",
    "assets", "catalogHash",
  ], "governed asset catalog");
  if (item.schema !== GOVERNED_ASSET_CATALOG_SCHEMA) fail("asset catalog schema is invalid");
  const assets = array(item.assets, "catalog assets").map(validateCatalogEntry);
  if (assets.length !== nonNegativeInteger(item.assetCount, "catalog assetCount")) {
    fail("catalog asset coverage count drifted");
  }
  const assetById = new Map<string, GovernedAssetCatalogEntry>();
  const paths = new Set<string>();
  for (const asset of assets) {
    const path = asset.canonicalPath.toLowerCase();
    if (assetById.has(asset.assetId) || paths.has(path)) fail("catalog asset identity/path duplicated");
    assetById.set(asset.assetId, asset);
    paths.add(path);
  }
  for (const asset of assets) {
    for (const relatedAssetId of asset.relatedAssetIds) {
      const target = assetById.get(relatedAssetId);
      if (!target || target.scopeFingerprint !== asset.scopeFingerprint) {
        fail("catalog related target is missing or crosses scope");
      }
    }
  }
  const canonicalManifestHash = hash(item.canonicalManifestHash, "catalog canonicalManifestHash");
  const canonicalManifestSha256 = hash(
    item.canonicalManifestSha256, "catalog canonicalManifestSha256",
  );
  if (canonicalManifest) {
    const manifest = validateGovernedCanonicalManifest(canonicalManifest);
    if (manifest.artifactSetHash !== canonicalManifestHash ||
        serializedHash(serializeGovernedCanonicalManifest(manifest)) !== canonicalManifestSha256 ||
        !exactIdSet(assets.map((asset) => asset.assetId), manifest.assets.map((asset) => asset.assetId))) {
      fail("catalog canonical manifest identity/asset coverage drifted");
    }
    const manifestById = new Map(manifest.assets.map((asset) => [asset.assetId, asset] as const));
    const expectedSources = sourcesByAsset(manifest);
    for (const asset of assets) {
      const expected = manifestById.get(asset.assetId)!;
      const canonicalPart = Object.fromEntries(Object.entries(asset).filter(([key]) =>
        !["projects", "topics", "sources", "relatedAssetIds", "sectionIds"].includes(key)));
      if (JSON.stringify(stableValue(canonicalPart)) !== JSON.stringify(stableValue(expected)) ||
          !exactBindingSet(asset.sources, expectedSources.get(asset.assetId) ?? [])) {
        fail("catalog asset identity/hash/source coverage drifted");
      }
    }
  }
  const body = {
    schema: GOVERNED_ASSET_CATALOG_SCHEMA,
    canonicalManifestHash,
    canonicalManifestSha256,
    createdAt: iso(item.createdAt, "catalog createdAt"),
    assetCount: assets.length,
    assets: Object.freeze(assets),
  } as const;
  const catalogHash = hash(item.catalogHash, "catalogHash");
  if (catalogBody(body) !== catalogHash) fail("asset catalog hash drifted");
  return deepFreeze({ ...body, catalogHash });
}

export function serializeGovernedAssetCatalog(value: GovernedAssetCatalog): string {
  return canonicalSerialization(validateGovernedAssetCatalog(value));
}

export function parseGovernedAssetCatalog(
  serialized: string,
  canonicalManifest?: GovernedCanonicalManifest,
): GovernedAssetCatalog {
  return validateGovernedAssetCatalog(
    parseCanonicalJson(serialized, "asset catalog"), canonicalManifest,
  );
}

export function governedAssetCatalogSha256(
  serialized: string,
  canonicalManifest?: GovernedCanonicalManifest,
): string {
  parseGovernedAssetCatalog(serialized, canonicalManifest);
  return serializedHash(serialized);
}

export interface GovernedIndexManifestEntry {
  readonly indexId: string;
  readonly relativePath: string;
  readonly purpose: Extract<GovernedDocumentPurpose,
  "home" | "type_index" | "tree_index" | "project_index" | "topic_index" |
  "source_index" | "document_index" | "governance_catalog">;
  readonly scopeFingerprint: string;
  readonly memberAssetIds: readonly string[];
  readonly childIndexIds: readonly string[];
  readonly markdownSha256: string;
}

export interface GovernedIndexManifestLink {
  readonly fromIndexId: string;
  readonly targetKind: "asset" | "index";
  readonly targetId: string;
}

export interface GovernedIndexManifest {
  readonly schema: typeof GOVERNED_INDEX_MANIFEST_SCHEMA;
  readonly catalogHash: string;
  readonly catalogSha256: string;
  readonly createdAt: string;
  readonly indexCount: number;
  readonly indexes: readonly GovernedIndexManifestEntry[];
  readonly linkGraph: readonly GovernedIndexManifestLink[];
  readonly artifactSetHash: string;
}

export interface CreateGovernedIndexManifestInput {
  readonly catalog: GovernedAssetCatalog;
  readonly catalogSha256: string;
  readonly createdAt: string;
  readonly indexes: readonly GovernedIndexManifestEntry[];
}

const INDEX_PURPOSES = new Set<GovernedIndexManifestEntry["purpose"]>([
  "home", "type_index", "tree_index", "project_index", "topic_index", "source_index",
  "document_index", "governance_catalog",
]);

function validateIndexEntry(value: unknown): GovernedIndexManifestEntry {
  const item = exactKeys(value, [
    "indexId", "relativePath", "purpose", "scopeFingerprint", "memberAssetIds",
    "childIndexIds", "markdownSha256",
  ], "index manifest entry");
  if (typeof item.purpose !== "string" ||
      !INDEX_PURPOSES.has(item.purpose as GovernedIndexManifestEntry["purpose"])) {
    fail("index purpose is invalid");
  }
  const memberAssetIds = stringList(item.memberAssetIds, "index memberAssetIds", {
    allowEmpty: true, identifiers: true,
  });
  const childIndexIds = stringList(item.childIndexIds, "index childIndexIds", {
    allowEmpty: true, identifiers: true,
  });
  if (memberAssetIds.length + childIndexIds.length === 0) fail("empty index is forbidden");
  return Object.freeze({
    indexId: safeId(item.indexId, "indexId"),
    relativePath: relativeMarkdownPath(item.relativePath, "index"),
    purpose: item.purpose as GovernedIndexManifestEntry["purpose"],
    scopeFingerprint: hash(item.scopeFingerprint, "index scopeFingerprint"),
    memberAssetIds,
    childIndexIds,
    markdownSha256: hash(item.markdownSha256, "index markdownSha256"),
  });
}

function derivedLinkGraph(
  indexes: readonly GovernedIndexManifestEntry[],
): readonly GovernedIndexManifestLink[] {
  return Object.freeze(indexes.flatMap((entry) => [
    ...entry.memberAssetIds.map((targetId) => ({
      fromIndexId: entry.indexId, targetKind: "asset" as const, targetId,
    })),
    ...entry.childIndexIds.map((targetId) => ({
      fromIndexId: entry.indexId, targetKind: "index" as const, targetId,
    })),
  ]).sort((left, right) =>
    left.fromIndexId.localeCompare(right.fromIndexId) ||
    left.targetKind.localeCompare(right.targetKind) || left.targetId.localeCompare(right.targetId)));
}

function assertIndexCoverage(
  indexes: readonly GovernedIndexManifestEntry[],
  catalog: GovernedAssetCatalog,
): void {
  const indexById = new Map(indexes.map((entry) => [entry.indexId, entry] as const));
  const assetById = new Map(catalog.assets.map((asset) => [asset.assetId, asset] as const));
  for (const index of indexes) {
    if (index.memberAssetIds.some((assetId) => {
      const asset = assetById.get(assetId);
      return !asset || asset.scopeFingerprint !== index.scopeFingerprint;
    }) || index.childIndexIds.some((childId) => {
      const child = indexById.get(childId);
      return !child || child.scopeFingerprint !== index.scopeFingerprint || childId === index.indexId;
    })) fail("index member/link endpoint is missing or crosses scope");
  }
  const scopes = new Set(catalog.assets.map((asset) => asset.scopeFingerprint));
  for (const scopeFingerprint of scopes) {
    const roots = indexes.filter((entry) =>
      entry.purpose === "home" && entry.scopeFingerprint === scopeFingerprint);
    if (roots.length !== 1) fail("index scope requires exactly one Home root");
    const visited = new Set<string>();
    const reachedAssets = new Set<string>();
    const visit = (indexId: string): void => {
      if (visited.has(indexId)) return;
      visited.add(indexId);
      const entry = indexById.get(indexId);
      if (!entry) fail("index link is dangling");
      entry.memberAssetIds.forEach((assetId) => reachedAssets.add(assetId));
      entry.childIndexIds.forEach(visit);
    };
    visit(roots[0]!.indexId);
    const expected = catalog.assets.filter((asset) => asset.scopeFingerprint === scopeFingerprint)
      .map((asset) => asset.assetId);
    if (!exactIdSet([...reachedAssets], expected)) {
      fail("catalog asset index coverage/reachability is incomplete");
    }
  }
}

function indexManifestBody(input: Omit<GovernedIndexManifest, "artifactSetHash">): string {
  return canonicalHash("mengshu.governed-index-manifest/artifact-set/v1", input);
}

export function createGovernedIndexManifest(
  input: CreateGovernedIndexManifestInput,
): GovernedIndexManifest {
  if (!plainRecord(input)) fail("index manifest input shape is invalid");
  const catalog = validateGovernedAssetCatalog(input.catalog);
  const catalogSha256 = hash(input.catalogSha256, "index catalogSha256");
  if (serializedHash(serializeGovernedAssetCatalog(catalog)) !== catalogSha256) {
    fail("index catalog hash drifted");
  }
  const indexes = array(input.indexes, "index entries", false).map(validateIndexEntry)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const index of indexes) {
    const path = index.relativePath.toLowerCase();
    if (ids.has(index.indexId) || paths.has(path)) fail("index identity/path is duplicated");
    ids.add(index.indexId);
    paths.add(path);
  }
  assertIndexCoverage(indexes, catalog);
  const linkGraph = derivedLinkGraph(indexes);
  const body = {
    schema: GOVERNED_INDEX_MANIFEST_SCHEMA,
    catalogHash: catalog.catalogHash,
    catalogSha256,
    createdAt: iso(input.createdAt, "index manifest createdAt"),
    indexCount: indexes.length,
    indexes: Object.freeze(indexes),
    linkGraph,
  } as const;
  return deepFreeze({ ...body, artifactSetHash: indexManifestBody(body) });
}

function validateLink(value: unknown): GovernedIndexManifestLink {
  const item = exactKeys(value, ["fromIndexId", "targetKind", "targetId"], "index link");
  if (item.targetKind !== "asset" && item.targetKind !== "index") {
    fail("index link target kind is invalid");
  }
  return Object.freeze({
    fromIndexId: safeId(item.fromIndexId, "link fromIndexId"),
    targetKind: item.targetKind,
    targetId: safeId(item.targetId, "link targetId"),
  });
}

export function validateGovernedIndexManifest(
  value: unknown,
  catalog?: GovernedAssetCatalog,
): GovernedIndexManifest {
  const item = exactKeys(value, [
    "schema", "catalogHash", "catalogSha256", "createdAt", "indexCount", "indexes",
    "linkGraph", "artifactSetHash",
  ], "governed index manifest");
  if (item.schema !== GOVERNED_INDEX_MANIFEST_SCHEMA) fail("index manifest schema is invalid");
  const indexes = array(item.indexes, "index entries", false).map(validateIndexEntry);
  if (indexes.length !== nonNegativeInteger(item.indexCount, "indexCount")) {
    fail("index coverage count drifted");
  }
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const index of indexes) {
    const path = index.relativePath.toLowerCase();
    if (ids.has(index.indexId) || paths.has(path)) fail("index identity/path is duplicated");
    ids.add(index.indexId);
    paths.add(path);
  }
  const links = array(item.linkGraph, "index linkGraph").map(validateLink);
  const expectedLinks = derivedLinkGraph(indexes);
  if (JSON.stringify(stableValue(links)) !== JSON.stringify(stableValue(expectedLinks))) {
    fail("index link graph coverage drifted");
  }
  const catalogHash = hash(item.catalogHash, "index catalogHash");
  const catalogSha256 = hash(item.catalogSha256, "index catalogSha256");
  if (catalog) {
    const validatedCatalog = validateGovernedAssetCatalog(catalog);
    if (validatedCatalog.catalogHash !== catalogHash ||
        serializedHash(serializeGovernedAssetCatalog(validatedCatalog)) !== catalogSha256) {
      fail("index catalog identity/hash drifted");
    }
    assertIndexCoverage(indexes, validatedCatalog);
  }
  const body = {
    schema: GOVERNED_INDEX_MANIFEST_SCHEMA,
    catalogHash,
    catalogSha256,
    createdAt: iso(item.createdAt, "index manifest createdAt"),
    indexCount: indexes.length,
    indexes: Object.freeze(indexes),
    linkGraph: Object.freeze(links),
  } as const;
  const artifactSetHash = hash(item.artifactSetHash, "index artifactSetHash");
  if (indexManifestBody(body) !== artifactSetHash) fail("index artifact set hash drifted");
  return deepFreeze({ ...body, artifactSetHash });
}

export function serializeGovernedIndexManifest(value: GovernedIndexManifest): string {
  return canonicalSerialization(validateGovernedIndexManifest(value));
}

export function parseGovernedIndexManifest(
  serialized: string,
  catalog?: GovernedAssetCatalog,
): GovernedIndexManifest {
  return validateGovernedIndexManifest(
    parseCanonicalJson(serialized, "index manifest"), catalog,
  );
}

export function governedIndexManifestSha256(
  serialized: string,
  catalog?: GovernedAssetCatalog,
): string {
  parseGovernedIndexManifest(serialized, catalog);
  return serializedHash(serialized);
}
