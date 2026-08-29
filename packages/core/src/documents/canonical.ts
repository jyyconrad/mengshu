import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemorySemanticType } from "../domain/types.js";
import type {
  CanonicalPublicDocumentContent,
  DocumentGovernanceDescriptor,
  GovernedDocumentAssetVersion,
  GovernedDocumentCompletionContract,
  GovernedDocumentIndex,
  GovernedDocumentProjection,
  GovernedTreeRef,
} from "./types.js";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SEMANTIC_TYPES = new Set<MemorySemanticType>([
  "profile", "task_context", "rules", "experience", "resource",
]);
const LIFECYCLE_STATES = new Set([
  "draft", "review", "active", "deprecated", "revoked",
]);
const GOVERNANCE_STATES = new Set([
  "current", "stale", "review_required", "conflicted",
]);
const MEMORY_PURPOSES = new Set(["typed_memory"]);
const TREE_PURPOSES = new Set(["tree_summary"]);
const INDEX_PURPOSES = new Set([
  "home", "type_index", "tree_index", "project_index", "topic_index",
  "source_index", "document_index", "governance_catalog",
]);
const RELATION_TYPES = new Set([
  "related", "references", "derived_from", "depends_on", "supersedes",
  "superseded_by", "contradicts", "tree_route",
]);

function fail(message: string): never {
  throw new Error(`INVALID_GOVERNED_DOCUMENT: ${message}`);
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) fail(`${label} is invalid`);
  return value;
}

function text(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() ||
      value.length > maxLength || /[\p{Cc}\r\n]/u.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) ||
      new Date(Date.parse(value)).toISOString() !== value) fail(`${label} is invalid`);
  return value;
}

function finiteRatio(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${label} is invalid`);
  }
  return value;
}

function stringArray(
  value: unknown,
  label: string,
  options: { readonly allowEmpty?: boolean; readonly identifiers?: boolean } = {},
): readonly string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    fail(`${label} is invalid`);
  }
  const result = value.map((item) => options.identifiers
    ? safeId(item, label)
    : text(item, label, 512));
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`);
  return Object.freeze(result);
}

function semanticTypes(value: unknown): readonly MemorySemanticType[] {
  const result = stringArray(value, "semanticTypes") as readonly MemorySemanticType[];
  if (result.some((item) => !SEMANTIC_TYPES.has(item))) fail("semanticTypes is invalid");
  return result;
}

function treeRef(value: GovernedTreeRef): GovernedTreeRef {
  if (!value || !["source", "topic", "global"].includes(value.treeType) ||
      !["L1", "L2", "L3"].includes(value.level) ||
      !Number.isSafeInteger(value.sealVersion) || value.sealVersion < 1) {
    fail("treeRef is invalid");
  }
  return Object.freeze({
    treeType: value.treeType,
    level: value.level,
    treeKey: safeId(value.treeKey, "treeRef.treeKey"),
    nodeId: safeId(value.nodeId, "treeRef.nodeId"),
    sealVersion: value.sealVersion,
  });
}

export function canonicalizePublicContent(
  value: CanonicalPublicDocumentContent,
): CanonicalPublicDocumentContent {
  if (!value || typeof value !== "object" || !Array.isArray(value.sections)) {
    fail("content is invalid");
  }
  const sections = value.sections.map((
    section: CanonicalPublicDocumentContent["sections"][number],
  ) => {
    const id = safeId(section.id, "section.id");
    const claims = Array.isArray(section.claims) ? section.claims.map((claim: {
      readonly id: string;
      readonly text: string;
    }) => Object.freeze({
      id: safeId(claim.id, "claim.id"),
      text: text(claim.text, "claim.text", 24_000),
    })) : fail("section.claims is invalid");
    if (claims.length === 0 || new Set(claims.map((claim) => claim.id)).size !== claims.length) {
      fail("section.claims is invalid");
    }
    return Object.freeze({
      id,
      heading: text(section.heading, "section.heading", 256),
      claims: Object.freeze(claims),
    });
  });
  if (new Set(sections.map((section) => section.id)).size !== sections.length) {
    fail("section ids contain duplicates");
  }
  const claimIds = sections.flatMap((section) => section.claims.map((claim) => claim.id));
  if (new Set(claimIds).size !== claimIds.length) fail("claim ids contain duplicates");
  if (typeof value.userNotes !== "string" || value.userNotes.includes("\r") ||
      (value.userNotes.length > 0 && !value.userNotes.endsWith("\n")) ||
      value.userNotes.includes("<!-- mengshu:user-notes:end -->")) {
    fail("userNotes must be LF text ending with a newline");
  }
  return Object.freeze({
    title: text(value.title, "content.title", 256),
    ...(value.abstract === undefined
      ? {}
      : { abstract: text(value.abstract, "content.abstract", 2_000) }),
    sections: Object.freeze(sections),
    userNotes: value.userNotes,
    topics: stringArray(value.topics, "topics", { allowEmpty: true }),
    relatedAssetIds: stringArray(value.relatedAssetIds, "relatedAssetIds", {
      allowEmpty: true, identifiers: true,
    }),
    sourceAssetIds: stringArray(value.sourceAssetIds, "sourceAssetIds", {
      allowEmpty: true, identifiers: true,
    }),
    aliases: stringArray(value.aliases, "aliases", { allowEmpty: true }),
    tags: stringArray(value.tags, "tags", { allowEmpty: true }),
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainHash(domain: string, value: unknown): string {
  return createHash("sha256").update(domain).update("\0").update(stableJson(value)).digest("hex");
}

export function computePublicContentHash(value: CanonicalPublicDocumentContent): string {
  const content = canonicalizePublicContent(value);
  return domainHash("mengshu.governed-document-public-content/v1", {
    ...content,
    topics: [...content.topics].sort(),
    relatedAssetIds: [...content.relatedAssetIds].sort(),
    sourceAssetIds: [...content.sourceAssetIds].sort(),
    aliases: [...content.aliases].sort(),
    tags: [...content.tags].sort(),
  });
}

export function computeGovernanceProjectionHash(value: GovernedDocumentProjection): string {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.assetVersion) ||
      value.assetVersion < 1 || !SHA256.test(value.resolutionHash)) {
    fail("governance projection is invalid");
  }
  const claimEvidence = Object.fromEntries(Object.entries(value.claimEvidence)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([claimId, evidence]) => [
      safeId(claimId, "claimEvidence claim"),
      [...stringArray(evidence, "claimEvidence evidence", { identifiers: true })].sort(),
    ]));
  return domainHash("mengshu.governed-document-projection/v1", {
    assetId: safeId(value.assetId, "assetId"),
    assetVersion: value.assetVersion,
    claimEvidence,
    provenanceRefs: [...stringArray(value.provenanceRefs, "provenanceRefs", {
      allowEmpty: true, identifiers: true,
    })].sort(),
    relationRefs: [...stringArray(value.relationRefs, "relationRefs", {
      allowEmpty: true, identifiers: true,
    })].sort(),
    sourceDispositionRefs: [...stringArray(value.sourceDispositionRefs, "sourceDispositionRefs", {
      allowEmpty: true, identifiers: true,
    })].sort(),
    resolutionHash: value.resolutionHash,
    policyVersion: text(value.policyVersion, "policyVersion", 256),
  });
}

export function computeCompletionContractHash(
  value: GovernedDocumentCompletionContract,
): string {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.assetVersion) ||
      value.assetVersion < 1 || value.schemaVersion !== 1 ||
      !SHA256.test(value.scopeFingerprint) || !SHA256.test(value.publicContentHash) ||
      !SHA256.test(value.governanceProjectionHash)) {
    fail("completion contract is invalid");
  }
  const normalized = {
    assetId: safeId(value.assetId, "assetId"),
    assetVersion: value.assetVersion,
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    purpose: value.purpose,
    semanticType: value.semanticType,
    semanticTypes: value.semanticTypes ? [...semanticTypes(value.semanticTypes)].sort() : undefined,
    treeRef: value.treeRef ? treeRef(value.treeRef) : undefined,
    lifecycleState: value.lifecycleState,
    governanceState: value.governanceState,
    scopeFingerprint: value.scopeFingerprint,
    publicContentHash: value.publicContentHash,
    governanceProjectionHash: value.governanceProjectionHash,
  };
  return domainHash("mengshu.governed-document-completion/v1", normalized);
}

function exactSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item) => right.includes(item));
}

export function validateGovernedDocumentIndex(
  value: GovernedDocumentIndex,
  document: GovernedDocumentAssetVersion,
): GovernedDocumentIndex {
  validateGovernedDocumentAssetVersion(document);
  if (!value || value.assetId !== document.assetId ||
      value.assetVersion !== document.assetVersion || value.title !== document.title ||
      value.abstract !== document.content.abstract ||
      value.publicContentHash !== document.publicContentHash ||
      !["simple", "complex"].includes(value.complexityClass) ||
      !Array.isArray(value.sections)) {
    fail("document index identity is inconsistent");
  }
  const sourceSections = new Map(document.content.sections.map((section) => [section.id, section]));
  const indexIds = value.sections.map((section) => section.sectionId);
  if (new Set(indexIds).size !== indexIds.length ||
      !exactSet(indexIds, [...sourceSections.keys()])) {
    fail("document index sections do not match content");
  }
  const order = stringArray(value.recommendedReadOrder, "recommended read order", {
    allowEmpty: value.sections.length === 0,
    identifiers: true,
  });
  if (!exactSet(order, indexIds)) fail("recommended read order must cover every section");
  for (const section of value.sections) {
    const source = sourceSections.get(safeId(section.sectionId, "index sectionId"));
    if (!source || source.heading !== section.heading ||
        !Number.isSafeInteger(section.level) || section.level < 1 || section.level > 6 ||
        section.claimCount !== source.claims.length || typeof section.evidenceAvailable !== "boolean") {
      fail("document index section is inconsistent");
    }
    text(section.brief, "index section brief", 2_000);
    const children = stringArray(section.childSectionIds, "childSectionIds", {
      allowEmpty: true, identifiers: true,
    });
    const prerequisites = stringArray(section.prerequisiteSectionIds, "prerequisiteSectionIds", {
      allowEmpty: true, identifiers: true,
    });
    if ([...children, ...prerequisites].some((id) => !sourceSections.has(id) || id === section.sectionId)) {
      fail("document index section relation is invalid");
    }
  }
  const related = stringArray(value.relatedAssetIds, "relatedAssetIds", {
    allowEmpty: true, identifiers: true,
  });
  if (!exactSet(related, document.content.relatedAssetIds)) {
    fail("document index related assets are inconsistent");
  }
  return value;
}

function validateDescriptor(
  value: DocumentGovernanceDescriptor,
  asset: GovernedDocumentAssetVersion,
): void {
  if (!value || value.assetId !== asset.assetId || value.assetVersion !== asset.assetVersion ||
      value.kind !== asset.kind || value.purpose !== asset.purpose ||
      value.semanticType !== asset.semanticType || value.scopeFingerprint !== asset.scopeFingerprint ||
      value.lifecycleState !== asset.lifecycleState || value.governanceState !== asset.governanceState ||
      value.title !== asset.title || value.abstract !== asset.content.abstract ||
      value.publicContentHash !== asset.publicContentHash ||
      value.governanceProjectionHash !== asset.governanceProjectionHash ||
      !["simple", "complex"].includes(value.complexityClass) ||
      finiteRatio(value.claimEvidenceCoverage, "claimEvidenceCoverage") < 0 ||
      finiteRatio(value.sourceDispositionCoverage, "sourceDispositionCoverage") < 0 ||
      !Number.isSafeInteger(value.conflictCount) || value.conflictCount < 0) {
    fail("governanceDescription is inconsistent");
  }
  if (asset.kind === "tree_document" &&
      stableJson(value.treeRef) !== stableJson(asset.treeRef)) {
    fail("governanceDescription treeRef is inconsistent");
  }
  if (value.complexityClass === "complex" && !value.documentIndexAssetId) {
    fail("complex governanceDescription requires documentIndexAssetId");
  }
  stringArray(value.staleReasons, "staleReasons", { allowEmpty: true });
  stringArray(value.navigationRefs, "navigationRefs", { allowEmpty: true, identifiers: true });
}

export function validateGovernedDocumentAssetVersion(
  value: GovernedDocumentAssetVersion,
): GovernedDocumentAssetVersion {
  if (!value || typeof value !== "object" || !Number.isSafeInteger(value.assetVersion) ||
      value.assetVersion < 1 || value.schemaVersion !== 1 || !SHA256.test(value.scopeFingerprint) ||
      !SHA256.test(value.publicContentHash) || !SHA256.test(value.governanceProjectionHash) ||
      !LIFECYCLE_STATES.has(value.lifecycleState) || !GOVERNANCE_STATES.has(value.governanceState)) {
    fail("asset identity or state is invalid");
  }
  safeId(value.assetId, "assetId");
  if (authorityScopeFingerprint(value.scope) !== value.scopeFingerprint) {
    fail("scopeFingerprint does not match scope");
  }
  const content = canonicalizePublicContent(value.content);
  if (value.title !== content.title) fail("title does not match content");
  if (computePublicContentHash(content) !== value.publicContentHash) {
    fail("publicContentHash does not match content");
  }
  if (value.kind === "memory_document") {
    if (!MEMORY_PURPOSES.has(value.purpose) || !value.semanticType ||
        !SEMANTIC_TYPES.has(value.semanticType) || value.semanticTypes !== undefined ||
        value.treeRef !== undefined) fail("memory_document kind fields are invalid");
  } else if (value.kind === "tree_document") {
    if (!TREE_PURPOSES.has(value.purpose) || value.semanticType !== undefined ||
        value.semanticTypes === undefined || value.semanticTypes.length === 0 ||
        value.semanticTypes.some((item) => !SEMANTIC_TYPES.has(item)) || !value.treeRef) {
      fail("tree_document kind requires semanticTypes and treeRef");
    }
    semanticTypes(value.semanticTypes);
    treeRef(value.treeRef);
  } else if (value.kind === "index_document") {
    if (!INDEX_PURPOSES.has(value.purpose) || value.semanticType !== undefined ||
        value.semanticTypes !== undefined || value.treeRef !== undefined) {
      fail("index_document kind cannot declare semanticType, semanticTypes, or treeRef");
    }
  } else {
    fail("kind is invalid");
  }
  timestamp(value.createdAt, "createdAt");
  timestamp(value.updatedAt, "updatedAt");
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) fail("updatedAt precedes createdAt");
  stringArray(value.provenanceRefs, "provenanceRefs", { allowEmpty: true, identifiers: true });
  stringArray(value.evidenceRefs, "evidenceRefs", { allowEmpty: true, identifiers: true });
  for (const relation of value.relations) {
    if (!RELATION_TYPES.has(relation.type)) fail("relation type is invalid");
    safeId(relation.targetAssetId, "relation targetAssetId");
  }
  validateDescriptor(value.governanceDescription, value);
  return value;
}
