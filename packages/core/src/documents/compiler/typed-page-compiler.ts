import { createHash } from "node:crypto";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import {
  isMemoryForm,
  type MemoryForm,
  type MemoryScope,
  type SourceWatermark,
} from "../../domain/types.js";
import type { TemporalRecallSelector } from "../../temporal/types.js";
import { assertDocumentCompileFields } from "../compile-contract.js";
import { DocumentCompileContractError } from "../compile-contract.js";
import { evaluateDocumentGovernanceProposal } from "../governance.js";
import type { GovernedDocumentAssetWriteKernel } from "../write-kernel.js";
import { GovernedDocumentWriteError } from "../write-kernel.js";
import type {
  DocumentChangeKind,
  DocumentGovernanceProposal,
  GovernedDocumentAssetVersion,
} from "../types.js";
import {
  buildTypedMemoryDocument,
  type TypedPageBindings,
  type TypedPageClaim,
  type TypedPageSection,
} from "./assemble-typed-page.js";
import { hashTypedPageSection } from "./section-hash.js";
import {
  RetainedGovernedDocumentStore,
  type RetainedTypedPageVersion,
} from "./retained-store.js";

export const TYPED_PAGE_PUBLISH_STAGE = "publish_document" as const;

const PILOT_SEMANTIC_TYPES = new Set(["task_context", "resource"]);
const CANONICAL_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export interface TypedPageSectionPatch {
  readonly sectionId: string;
  readonly heading: string;
  readonly brief: string;
  readonly claims: readonly TypedPageClaim[];
}

export interface TypedPagePublishInput {
  readonly scope: MemoryScope;
  readonly assetId: string;
  readonly expectedLatestVersion: number;
  readonly updates: readonly TypedPageSectionPatch[];
  readonly plannedWatermarks: readonly SourceWatermark[];
  readonly observedWatermarks: readonly SourceWatermark[];
  readonly memoryForm: MemoryForm;
  readonly compiledAt: string;
  readonly governanceRunId: string;
  readonly proposalId: string;
  readonly validTimeSelector?: TemporalRecallSelector;
}

export type TypedPagePublishResult =
  | {
      readonly status: "published";
      readonly stage: typeof TYPED_PAGE_PUBLISH_STAGE;
      readonly asset: GovernedDocumentAssetVersion;
      readonly bindings: TypedPageBindings;
      readonly proposal: DocumentGovernanceProposal;
      readonly preservedSectionIds: readonly string[];
      readonly replayed: boolean;
    }
  | {
      readonly status: "stale_input";
      readonly stage: typeof TYPED_PAGE_PUBLISH_STAGE;
      readonly code: "SOURCE_REVISION_DRIFT" | "HEAD_CAS_CONFLICT";
    }
  | {
      readonly status: "not_published";
      readonly code:
        | "INVALID_INPUT"
        | "REVIEW_REQUIRED"
        | "QUARANTINE"
        | "WRITE_INCOMPLETE"
        | "SEMANTIC_TYPE_NOT_IN_PILOT";
    };

function snapshotHash(value: unknown): string {
  return createHash("sha256")
    .update("mengshu.typed-page-input-snapshot/v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

function isoTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function sameWatermark(planned: SourceWatermark, observed: SourceWatermark | undefined): boolean {
  return observed !== undefined &&
    observed.revision === planned.revision &&
    observed.payloadHash === planned.payloadHash;
}

function watermarkShape(value: SourceWatermark): boolean {
  return Boolean(value) &&
    typeof value.sourceId === "string" && CANONICAL_ID.test(value.sourceId) &&
    typeof value.revision === "string" && value.revision.length > 0 &&
    value.revision.length <= 256 &&
    typeof value.payloadHash === "string" && SHA256.test(value.payloadHash);
}

/**
 * One typed-page compiler. Section text arrives as a proposal; this module
 * does not call a model. Publish goes through the document write kernel.
 * publish_document is a stage of that commit, not a second durable queue.
 */
export class TypedPageCompiler {
  constructor(private readonly dependencies: {
    readonly store: RetainedGovernedDocumentStore;
    readonly kernel: GovernedDocumentAssetWriteKernel;
    readonly vaultId: string;
    readonly canonicalPath: (asset: GovernedDocumentAssetVersion) => string;
    readonly policyVersion: string;
    readonly resolutionHash: string;
    readonly modelFingerprint: string;
    readonly promptVersion: string;
  }) {}

  read(
    scope: MemoryScope,
    assetId: string,
    assetVersion?: number,
  ): RetainedTypedPageVersion | undefined {
    const version = assetVersion ?? this.dependencies.store.headVersion(scope, assetId);
    if (version < 1) return undefined;
    return this.dependencies.store.readVersion(scope, assetId, version);
  }

  async publish(input: TypedPagePublishInput): Promise<TypedPagePublishResult> {
    const head = this.dependencies.store.readVersion(
      input.scope,
      input.assetId,
      input.expectedLatestVersion,
    );
    if (!head || this.dependencies.store.headVersion(input.scope, input.assetId) !==
        input.expectedLatestVersion) {
      return Object.freeze({
        status: "stale_input",
        stage: TYPED_PAGE_PUBLISH_STAGE,
        code: "HEAD_CAS_CONFLICT",
      });
    }
    if (authorityScopeFingerprint(input.scope) !== head.asset.scopeFingerprint) {
      return Object.freeze({ status: "not_published", code: "INVALID_INPUT" });
    }
    if (!PILOT_SEMANTIC_TYPES.has(head.asset.semanticType ?? "")) {
      return Object.freeze({ status: "not_published", code: "SEMANTIC_TYPE_NOT_IN_PILOT" });
    }
    const drift = this.#drift(input.plannedWatermarks, input.observedWatermarks);
    if (drift === "drift") {
      return Object.freeze({
        status: "stale_input",
        stage: TYPED_PAGE_PUBLISH_STAGE,
        code: "SOURCE_REVISION_DRIFT",
      });
    }
    if (drift === "invalid" || !isMemoryForm(input.memoryForm) ||
        !isoTimestamp(input.compiledAt) ||
        Date.parse(input.compiledAt) < Date.parse(head.asset.createdAt)) {
      return Object.freeze({ status: "not_published", code: "INVALID_INPUT" });
    }
    const built = this.#next(head, input);
    if (!built) return Object.freeze({ status: "not_published", code: "INVALID_INPUT" });
    let proposal: DocumentGovernanceProposal;
    try {
      proposal = this.#proposal(head.asset, built.sections, built.asset, input);
      assertDocumentCompileFields(proposal);
    } catch (error) {
      if (error instanceof DocumentCompileContractError) {
        return Object.freeze({ status: "not_published", code: "INVALID_INPUT" });
      }
      throw error;
    }
    const decision = evaluateDocumentGovernanceProposal({
      proposal,
      expectedScopeFingerprint: head.asset.scopeFingerprint,
      expectedLatestVersion: head.asset.assetVersion,
      selectedInformationRefs: built.selectedInformationRefs,
      readableEvidenceRefs: built.readableEvidenceRefs,
      readableInputRefs: built.selectedInformationRefs,
      unresolvedConflictRefs: [],
      sensitiveDisclosureRefs: [],
      previousSemanticType: head.asset.semanticType,
      policyVersion: this.dependencies.policyVersion,
    });
    if (decision.decision !== "auto_apply") {
      return Object.freeze({
        status: "not_published",
        code: decision.decision === "review" ? "REVIEW_REQUIRED" : "QUARANTINE",
      });
    }
    this.dependencies.store.putBindings(
      input.scope,
      built.asset.assetId,
      built.asset.assetVersion,
      built.bindings,
    );
    try {
      const committed = await this.dependencies.kernel.commit({
        asset: built.asset,
        vaultId: this.dependencies.vaultId,
        canonicalPath: this.dependencies.canonicalPath(built.asset),
        idempotencyKey: `cmp_${built.inputSnapshotHash}`,
        expectedCompleteVersion: head.asset.assetVersion,
        expectedBase: {
          assetVersion: head.asset.assetVersion,
          publicContentHash: head.asset.publicContentHash,
        },
      });
      if (committed.receipt.disposition !== "complete") {
        return Object.freeze({ status: "not_published", code: "WRITE_INCOMPLETE" });
      }
      return Object.freeze({
        status: "published",
        stage: TYPED_PAGE_PUBLISH_STAGE,
        asset: built.asset,
        bindings: built.bindings,
        proposal,
        preservedSectionIds: Object.freeze(built.preservedSectionIds),
        replayed: committed.replayed,
      });
    } catch (error) {
      if (error instanceof GovernedDocumentWriteError) {
        return Object.freeze({ status: "not_published", code: "WRITE_INCOMPLETE" });
      }
      if (error instanceof Error && error.message === "HEAD_CAS_CONFLICT") {
        return Object.freeze({
          status: "stale_input",
          stage: TYPED_PAGE_PUBLISH_STAGE,
          code: "HEAD_CAS_CONFLICT",
        });
      }
      throw error;
    }
  }

  #drift(
    planned: readonly SourceWatermark[],
    observed: readonly SourceWatermark[],
  ): "ok" | "drift" | "invalid" {
    if (planned.length === 0 || observed.length === 0) return "drift";
    const seen = new Set<string>();
    for (const watermark of planned) {
      if (!watermarkShape(watermark) || seen.has(watermark.sourceId)) return "invalid";
      seen.add(watermark.sourceId);
    }
    for (const watermark of observed) {
      if (!watermarkShape(watermark)) return "invalid";
    }
    const observedBySource = new Map(observed.map((item) => [item.sourceId, item]));
    for (const watermark of planned) {
      if (!sameWatermark(watermark, observedBySource.get(watermark.sourceId))) return "drift";
    }
    return "ok";
  }

  #next(head: RetainedTypedPageVersion, input: TypedPagePublishInput): {
    readonly asset: GovernedDocumentAssetVersion;
    readonly bindings: TypedPageBindings;
    readonly sections: readonly TypedPageSection[];
    readonly preservedSectionIds: readonly string[];
    readonly selectedInformationRefs: readonly string[];
    readonly readableEvidenceRefs: readonly string[];
    readonly inputSnapshotHash: string;
  } | undefined {
    if (input.updates.length === 0) return undefined;
    const updates = new Map<string, TypedPageSectionPatch>();
    for (const update of input.updates) {
      if (updates.has(update.sectionId) || update.claims.length === 0) return undefined;
      updates.set(update.sectionId, update);
    }
    const known = new Set(head.asset.content.sections.map((section) => section.id));
    if ([...updates.keys()].some((sectionId) => !known.has(sectionId))) return undefined;
    const briefs = new Map(head.asset.governanceDescription.sectionIndex.map((section) => [
      section.sectionId,
      section.brief,
    ]));
    const sections: TypedPageSection[] = [];
    const preservedSectionIds: string[] = [];
    for (const section of head.asset.content.sections) {
      const update = updates.get(section.id);
      if (!update) {
        const claims: TypedPageClaim[] = [];
        for (const claim of section.claims) {
          const evidenceRefs = head.bindings.claimEvidence[claim.id];
          const inputRefs = head.bindings.inputRefs[claim.id];
          if (!evidenceRefs || evidenceRefs.length === 0 || !inputRefs || inputRefs.length === 0) {
            return undefined;
          }
          claims.push({
            id: claim.id,
            text: claim.text,
            evidenceRefs: [...evidenceRefs],
            inputRefs: [...inputRefs],
          });
        }
        const brief = briefs.get(section.id);
        if (!brief) return undefined;
        sections.push({
          sectionId: section.id,
          heading: section.heading,
          brief,
          claims,
        });
        preservedSectionIds.push(section.id);
        continue;
      }
      sections.push({
        sectionId: section.id,
        heading: update.heading,
        brief: update.brief,
        claims: update.claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          evidenceRefs: [...claim.evidenceRefs],
          inputRefs: [...claim.inputRefs],
        })),
      });
    }
    const provenanceRefs = [...head.asset.provenanceRefs];
    for (const watermark of input.plannedWatermarks) {
      if (!provenanceRefs.includes(watermark.sourceId)) provenanceRefs.push(watermark.sourceId);
    }
    const informationRefs: string[] = [];
    const evidenceRefs: string[] = [];
    for (const section of sections) {
      for (const claim of section.claims) {
        for (const ref of claim.inputRefs) {
          if (!informationRefs.includes(ref)) informationRefs.push(ref);
        }
        for (const ref of claim.evidenceRefs) {
          if (!evidenceRefs.includes(ref)) evidenceRefs.push(ref);
        }
      }
    }
    const inputSnapshotHash = snapshotHash({
      assetId: head.asset.assetId,
      expectedLatestVersion: head.asset.assetVersion,
      publicContentHash: head.asset.publicContentHash,
      plannedWatermarks: input.plannedWatermarks.map((item) => ({
        sourceId: item.sourceId,
        revision: item.revision,
        payloadHash: item.payloadHash,
      })),
      updates: input.updates,
      memoryForm: input.memoryForm,
      validTimeSelector: input.validTimeSelector ?? null,
      policyVersion: this.dependencies.policyVersion,
      promptVersion: this.dependencies.promptVersion,
    });
    try {
      const built = buildTypedMemoryDocument({
        assetId: head.asset.assetId,
        assetVersion: head.asset.assetVersion + 1,
        semanticType: head.asset.semanticType as "task_context" | "resource",
        scope: head.asset.scope,
        title: head.asset.title,
        abstract: head.asset.content.abstract ?? head.asset.title,
        sections,
        userNotes: head.asset.content.userNotes,
        provenanceRefs,
        sourceDispositionRefs: informationRefs,
        resolutionHash: this.dependencies.resolutionHash,
        policyVersion: this.dependencies.policyVersion,
        createdAt: head.asset.createdAt,
        updatedAt: input.compiledAt,
        topics: head.asset.content.topics,
        sourceAssetIds: head.asset.content.sourceAssetIds,
        relatedAssetIds: head.asset.content.relatedAssetIds,
        aliases: head.asset.content.aliases,
        tags: head.asset.content.tags,
      });
      return {
        asset: built.asset,
        bindings: built.bindings,
        sections,
        preservedSectionIds,
        selectedInformationRefs: informationRefs,
        readableEvidenceRefs: evidenceRefs,
        inputSnapshotHash,
      };
    } catch {
      return undefined;
    }
  }

  #proposal(
    head: GovernedDocumentAssetVersion,
    sections: readonly TypedPageSection[],
    asset: GovernedDocumentAssetVersion,
    input: TypedPagePublishInput,
  ): DocumentGovernanceProposal {
    const preserved = new Set(sections
      .filter((section) => !input.updates.some((update) => update.sectionId === section.sectionId))
      .map((section) => section.sectionId));
    const changeKind: DocumentChangeKind = preserved.size === sections.length ? "no_op" : "replace";
    return {
      proposalId: input.proposalId,
      governanceRunId: input.governanceRunId,
      scopeFingerprint: head.scopeFingerprint,
      targetAssetId: head.assetId,
      expectedLatestVersion: head.assetVersion,
      kind: "memory_document",
      purpose: "typed_memory",
      semanticType: head.semanticType,
      action: "update",
      title: asset.title,
      ...(asset.content.abstract === undefined ? {} : { abstract: asset.content.abstract }),
      complexityClass: "simple",
      recommendedReadOrder: sections.map((section) => section.sectionId),
      sections: sections.map((section) => ({
        sectionId: section.sectionId,
        heading: section.heading,
        brief: section.brief,
        claims: section.claims.map((claim) => ({
          id: claim.id,
          text: claim.text,
          inputRefs: [...claim.inputRefs],
          evidenceRefs: [...claim.evidenceRefs],
        })),
      })),
      relatedAssetIds: [...asset.content.relatedAssetIds],
      dispositions: this.#dispositions(sections, input, head),
      riskClass: "low",
      reviewReasons: [],
      changeSummary: preserved.size === sections.length ? "章节未变化" : "只更新受影响章节",
      modelFingerprint: this.dependencies.modelFingerprint,
      promptVersion: this.dependencies.promptVersion,
      inputSnapshotHash: snapshotHash({
        assetId: head.assetId,
        expectedLatestVersion: head.assetVersion,
        publicContentHash: head.publicContentHash,
        plannedWatermarks: input.plannedWatermarks.map((item) => ({
          sourceId: item.sourceId,
          revision: item.revision,
          payloadHash: item.payloadHash,
        })),
        updates: input.updates,
        memoryForm: input.memoryForm,
        validTimeSelector: input.validTimeSelector ?? null,
        policyVersion: this.dependencies.policyVersion,
        promptVersion: this.dependencies.promptVersion,
      }),
      readSet: sections.map((section) => ({
        kind: "section" as const,
        ref: section.sectionId,
        contentHash: hashTypedPageSection(section),
      })),
      coverage: unique(sections.flatMap((section) => section.claims.flatMap((claim) => claim.inputRefs)))
        .map((ref) => ({ ref, state: "used" as const })),
      sectionDiff: sections.map((section) => ({
        sectionId: section.sectionId,
        claimIds: section.claims.map((claim) => claim.id),
        changeKind: preserved.has(section.sectionId) ? "no_op" as const : "replace" as const,
        preserved: preserved.has(section.sectionId),
      })),
      preserveSet: sections.filter((section) => preserved.has(section.sectionId)).map((section) => ({
        sectionId: section.sectionId,
        contentHash: hashTypedPageSection(section),
        evidenceRefs: unique(section.claims.flatMap((claim) => claim.evidenceRefs)),
      })),
      sourceWatermarks: input.plannedWatermarks.map((item) => ({
        sourceId: item.sourceId,
        revision: item.revision,
        payloadHash: item.payloadHash,
        ...(item.observedAt === undefined ? {} : { observedAt: item.observedAt }),
      })),
      changeKind,
      memoryForm: input.memoryForm,
      ...(input.validTimeSelector === undefined ? {} : { validTimeSelector: input.validTimeSelector }),
    };
  }

  #dispositions(
    sections: readonly TypedPageSection[],
    input: TypedPagePublishInput,
    head: GovernedDocumentAssetVersion,
  ) {
    const seen = new Set<string>();
    const dispositions = [];
    for (const section of sections) {
      for (const claim of section.claims) {
        for (const informationRef of claim.inputRefs) {
          if (seen.has(informationRef)) continue;
          seen.add(informationRef);
          dispositions.push({
            informationRef,
            sourceKind: "file" as const,
            scopeFingerprint: head.scopeFingerprint,
            semanticType: head.semanticType,
            treeRoutes: [],
            disposition: "attached_to_typed_document" as const,
            targetAssetIds: [head.assetId],
            reasonCode: "eligible_grounded_fact",
            governanceRunId: input.governanceRunId,
            createdAt: input.compiledAt,
          });
        }
      }
    }
    return dispositions;
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
