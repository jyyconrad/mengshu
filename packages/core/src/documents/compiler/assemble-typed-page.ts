import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope, MemorySemanticType } from "../../domain/types.js";
import {
  computeGovernanceProjectionHash,
  computePublicContentHash,
  validateGovernedDocumentAssetVersion,
} from "../canonical.js";
import type { GovernedDocumentAssetVersion } from "../types.js";

export interface TypedPageClaim {
  readonly id: string;
  readonly text: string;
  readonly evidenceRefs: readonly string[];
  readonly inputRefs: readonly string[];
}

export interface TypedPageSection {
  readonly sectionId: string;
  readonly heading: string;
  readonly brief: string;
  readonly claims: readonly TypedPageClaim[];
}

export interface TypedPageBindings {
  readonly claimEvidence: Readonly<Record<string, readonly string[]>>;
  readonly inputRefs: Readonly<Record<string, readonly string[]>>;
}

export interface BuildTypedMemoryDocumentInput {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly semanticType: Extract<MemorySemanticType, "task_context" | "resource">;
  readonly scope: MemoryScope;
  readonly title: string;
  readonly abstract: string;
  readonly sections: readonly TypedPageSection[];
  readonly userNotes: string;
  readonly provenanceRefs: readonly string[];
  readonly sourceDispositionRefs: readonly string[];
  readonly resolutionHash: string;
  readonly policyVersion: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly topics?: readonly string[];
  readonly sourceAssetIds?: readonly string[];
  readonly relatedAssetIds?: readonly string[];
  readonly aliases?: readonly string[];
  readonly tags?: readonly string[];
}

function freezeList(values: readonly string[]): readonly string[] {
  return Object.freeze([...values]);
}

function freezeMap(
  entries: readonly (readonly [string, readonly string[]])[],
): Readonly<Record<string, readonly string[]>> {
  return Object.freeze(Object.fromEntries(entries.map(([key, value]) => [
    key,
    freezeList(value),
  ])));
}

export function typedPageBindings(sections: readonly TypedPageSection[]): TypedPageBindings {
  const claimEvidence: (readonly [string, readonly string[]])[] = [];
  const inputRefs: (readonly [string, readonly string[]])[] = [];
  for (const section of sections) {
    for (const claim of section.claims) {
      claimEvidence.push([claim.id, claim.evidenceRefs]);
      inputRefs.push([claim.id, claim.inputRefs]);
    }
  }
  return Object.freeze({
    claimEvidence: freezeMap(claimEvidence),
    inputRefs: freezeMap(inputRefs),
  });
}

export function buildTypedMemoryDocument(
  input: BuildTypedMemoryDocumentInput,
): { readonly asset: GovernedDocumentAssetVersion; readonly bindings: TypedPageBindings } {
  const bindings = typedPageBindings(input.sections);
  const evidenceRefs: string[] = [];
  const seenEvidence = new Set<string>();
  for (const section of input.sections) {
    for (const claim of section.claims) {
      for (const evidenceRef of claim.evidenceRefs) {
        if (seenEvidence.has(evidenceRef)) continue;
        seenEvidence.add(evidenceRef);
        evidenceRefs.push(evidenceRef);
      }
    }
  }
  const content = Object.freeze({
    title: input.title,
    abstract: input.abstract,
    sections: Object.freeze(input.sections.map((section) => Object.freeze({
      id: section.sectionId,
      heading: section.heading,
      claims: Object.freeze(section.claims.map((claim) => Object.freeze({
        id: claim.id,
        text: claim.text,
      }))),
    }))),
    userNotes: input.userNotes,
    topics: freezeList(input.topics ?? []),
    relatedAssetIds: freezeList(input.relatedAssetIds ?? []),
    sourceAssetIds: freezeList(input.sourceAssetIds ?? input.provenanceRefs),
    aliases: freezeList(input.aliases ?? []),
    tags: freezeList(input.tags ?? []),
  });
  const scopeFingerprint = authorityScopeFingerprint(input.scope);
  const publicContentHash = computePublicContentHash(content);
  const governanceProjectionHash = computeGovernanceProjectionHash({
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    claimEvidence: bindings.claimEvidence,
    provenanceRefs: input.provenanceRefs,
    relationRefs: [],
    sourceDispositionRefs: input.sourceDispositionRefs,
    resolutionHash: input.resolutionHash,
    policyVersion: input.policyVersion,
  });
  const asset = validateGovernedDocumentAssetVersion({
    assetId: input.assetId,
    assetVersion: input.assetVersion,
    schemaVersion: 1,
    kind: "memory_document",
    purpose: "typed_memory",
    semanticType: input.semanticType,
    title: input.title,
    lifecycleState: "active",
    governanceState: "current",
    scope: input.scope,
    scopeFingerprint,
    governanceDescription: {
      assetId: input.assetId,
      assetVersion: input.assetVersion,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: input.semanticType,
      scopeFingerprint,
      lifecycleState: "active",
      governanceState: "current",
      complexityClass: "simple",
      title: input.title,
      abstract: input.abstract,
      sectionIndex: Object.freeze(input.sections.map((section) => Object.freeze({
        sectionId: section.sectionId,
        heading: section.heading,
        brief: section.brief,
      }))),
      claimEvidenceCoverage: 1,
      sourceDispositionCoverage: 1,
      conflictCount: 0,
      staleReasons: Object.freeze([]),
      publicContentHash,
      governanceProjectionHash,
      navigationRefs: freezeList(input.provenanceRefs),
    },
    content,
    publicContentHash,
    governanceProjectionHash,
    provenanceRefs: freezeList(input.provenanceRefs),
    evidenceRefs: freezeList(evidenceRefs),
    relations: Object.freeze([]),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  });
  return Object.freeze({ asset, bindings });
}
