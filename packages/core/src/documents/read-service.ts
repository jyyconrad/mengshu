import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import {
  validateGovernedDocumentAssetVersion,
  validateGovernedDocumentIndex,
} from "./canonical.js";
import type {
  CanonicalPublicDocumentContent,
  DocumentGovernanceDescriptor,
  GovernedDocumentAssetVersion,
  GovernedDocumentIndex,
} from "./types.js";

export type GovernedDocumentReadErrorCode =
  | "DOCUMENT_NOT_FOUND"
  | "SCOPE_MISMATCH"
  | "INDEX_MISSING"
  | "INDEX_STALE"
  | "SECTION_NOT_FOUND"
  | "INVALID_READ_REQUEST";

export class GovernedDocumentReadError extends Error {
  constructor(readonly code: GovernedDocumentReadErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GovernedDocumentReadError";
  }
}

export interface GovernedDocumentReadRepository {
  getComplete(
    scope: MemoryScope,
    assetId: string,
  ): Promise<GovernedDocumentAssetVersion | undefined>;
  getIndex(
    scope: MemoryScope,
    assetId: string,
    assetVersion: number,
  ): Promise<GovernedDocumentIndex | undefined>;
}

export type GovernedDocumentReadResult =
  | {
      readonly kind: "index_required";
      readonly code: "INDEX_REQUIRED";
      readonly assetId: string;
      readonly assetVersion: number;
      readonly descriptor: DocumentGovernanceDescriptor;
      readonly index: GovernedDocumentIndex;
    }
  | {
      readonly kind: "section";
      readonly assetId: string;
      readonly assetVersion: number;
      readonly section: CanonicalPublicDocumentContent["sections"][number];
    }
  | {
      readonly kind: "document";
      readonly assetId: string;
      readonly assetVersion: number;
      readonly content: CanonicalPublicDocumentContent;
    }
  | {
      readonly kind: "filtered";
      readonly assetId: string;
      readonly reason:
        | "draft"
        | "review"
        | "deprecated"
        | "revoked"
        | "stale"
        | "review_required"
        | "conflicted"
        | "evidence_incomplete";
      readonly fallback: "native_recall";
      readonly navigationRefs: readonly string[];
    };

function filtered(
  asset: GovernedDocumentAssetVersion,
  reason: Extract<GovernedDocumentReadResult, { kind: "filtered" }>["reason"],
): GovernedDocumentReadResult {
  return Object.freeze({
    kind: "filtered",
    assetId: asset.assetId,
    reason,
    fallback: "native_recall",
    navigationRefs: Object.freeze([...asset.governanceDescription.navigationRefs]),
  });
}

export class GovernedDocumentReadService {
  constructor(private readonly input: {
    readonly repository: GovernedDocumentReadRepository;
  }) {}

  async describe(
    scope: MemoryScope,
    assetId: string,
  ): Promise<{
    readonly descriptor: DocumentGovernanceDescriptor;
    readonly index?: GovernedDocumentIndex;
  }> {
    const asset = await this.load(scope, assetId);
    const index = asset.governanceDescription.complexityClass === "complex"
      ? await this.loadIndex(scope, asset)
      : undefined;
    return Object.freeze({
      descriptor: asset.governanceDescription,
      ...(index ? { index } : {}),
    });
  }

  async read(
    scope: MemoryScope,
    assetId: string,
    options: { readonly sectionId?: string; readonly full?: boolean } = {},
  ): Promise<GovernedDocumentReadResult> {
    if (options.sectionId !== undefined && options.full === true) {
      throw new GovernedDocumentReadError(
        "INVALID_READ_REQUEST",
        "sectionId and full are mutually exclusive",
      );
    }
    const asset = await this.load(scope, assetId);
    if (asset.lifecycleState !== "active") return filtered(asset, asset.lifecycleState);
    if (asset.governanceState !== "current") return filtered(asset, asset.governanceState);
    if (asset.governanceDescription.claimEvidenceCoverage !== 1 ||
        asset.governanceDescription.sourceDispositionCoverage !== 1) {
      return filtered(asset, "evidence_incomplete");
    }

    const complex = asset.governanceDescription.complexityClass === "complex";
    const index = complex ? await this.loadIndex(scope, asset) : undefined;
    if (options.sectionId !== undefined) {
      if (!index?.sections.some((section) => section.sectionId === options.sectionId)) {
        throw new GovernedDocumentReadError("SECTION_NOT_FOUND");
      }
      const section = asset.content.sections.find((item) => item.id === options.sectionId);
      if (!section) throw new GovernedDocumentReadError("SECTION_NOT_FOUND");
      return Object.freeze({
        kind: "section",
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        section,
      });
    }
    if (complex && options.full !== true) {
      return Object.freeze({
        kind: "index_required",
        code: "INDEX_REQUIRED",
        assetId: asset.assetId,
        assetVersion: asset.assetVersion,
        descriptor: asset.governanceDescription,
        index: index!,
      });
    }
    return Object.freeze({
      kind: "document",
      assetId: asset.assetId,
      assetVersion: asset.assetVersion,
      content: asset.content,
    });
  }

  private async load(scope: MemoryScope, assetId: string): Promise<GovernedDocumentAssetVersion> {
    const asset = await this.input.repository.getComplete(scope, assetId);
    if (!asset) throw new GovernedDocumentReadError("DOCUMENT_NOT_FOUND");
    validateGovernedDocumentAssetVersion(asset);
    if (asset.scopeFingerprint !== authorityScopeFingerprint(scope)) {
      throw new GovernedDocumentReadError("SCOPE_MISMATCH");
    }
    return asset;
  }

  private async loadIndex(
    scope: MemoryScope,
    asset: GovernedDocumentAssetVersion,
  ): Promise<GovernedDocumentIndex> {
    const index = await this.input.repository.getIndex(scope, asset.assetId, asset.assetVersion);
    if (!index) throw new GovernedDocumentReadError("INDEX_MISSING");
    try {
      return validateGovernedDocumentIndex(index, asset);
    } catch (error) {
      throw new GovernedDocumentReadError(
        "INDEX_STALE",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
