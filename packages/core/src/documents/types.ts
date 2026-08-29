import type { MemoryScope, MemorySemanticType } from "../domain/types.js";

export type GovernedDocumentKind =
  | "memory_document"
  | "tree_document"
  | "index_document";

export type GovernedDocumentPurpose =
  | "typed_memory"
  | "tree_summary"
  | "home"
  | "type_index"
  | "tree_index"
  | "project_index"
  | "topic_index"
  | "source_index"
  | "document_index"
  | "governance_catalog";

export type DocumentLifecycleState =
  | "draft"
  | "review"
  | "active"
  | "deprecated"
  | "revoked";

export type DocumentGovernanceState =
  | "current"
  | "stale"
  | "review_required"
  | "conflicted";

export interface GovernedTreeRef {
  readonly treeType: "source" | "topic" | "global";
  readonly level: "L1" | "L2" | "L3";
  readonly treeKey: string;
  readonly nodeId: string;
  readonly sealVersion: number;
}

export interface CanonicalPublicDocumentContent {
  readonly title: string;
  readonly abstract?: string;
  readonly sections: readonly {
    readonly id: string;
    readonly heading: string;
    readonly claims: readonly {
      readonly id: string;
      readonly text: string;
    }[];
  }[];
  readonly userNotes: string;
  readonly topics: readonly string[];
  readonly relatedAssetIds: readonly string[];
  readonly sourceAssetIds: readonly string[];
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
}

export interface GovernedDocumentProjection {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly claimEvidence: Readonly<Record<string, readonly string[]>>;
  readonly provenanceRefs: readonly string[];
  readonly relationRefs: readonly string[];
  readonly sourceDispositionRefs: readonly string[];
  readonly resolutionHash: string;
  readonly policyVersion: string;
}

export interface GovernedDocumentIndex {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly title: string;
  readonly abstract?: string;
  readonly complexityClass: "simple" | "complex";
  readonly recommendedReadOrder: readonly string[];
  readonly sections: readonly {
    readonly sectionId: string;
    readonly heading: string;
    readonly level: number;
    readonly brief: string;
    readonly childSectionIds: readonly string[];
    readonly prerequisiteSectionIds: readonly string[];
    readonly claimCount: number;
    readonly evidenceAvailable: boolean;
  }[];
  readonly relatedAssetIds: readonly string[];
  readonly publicContentHash: string;
}

export interface GovernedDocumentCompletionContract {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly schemaVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType?: MemorySemanticType;
  readonly semanticTypes?: readonly MemorySemanticType[];
  readonly treeRef?: GovernedTreeRef;
  readonly lifecycleState: DocumentLifecycleState;
  readonly governanceState: DocumentGovernanceState;
  readonly scopeFingerprint: string;
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
}

export interface DocumentAssetCommitReceipt {
  readonly receiptId: string;
  readonly vaultId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly postgresPublicContentHash: string;
  readonly markdownPublicContentHash: string;
  readonly governanceProjectionHash: string;
  readonly completionContractHash: string;
  readonly disposition: "complete" | "pending" | "conflict" | "aborted";
  readonly createdAt: string;
}

export type GovernanceDisposition =
  | "attached_to_typed_document"
  | "attached_and_routed"
  | "tree_only"
  | "native_only"
  | "lookup_only"
  | "rejected_below_threshold"
  | "deferred"
  | "redundant_with_evidence"
  | "superseded"
  | "archive_stale"
  | "conflict"
  | "quarantine";

export interface InformationDispositionRecord {
  readonly informationRef: string;
  readonly sourceKind: "conversation" | "file" | "knowledge" | "tool" | "system_event";
  readonly scopeFingerprint: string;
  readonly semanticType?: MemorySemanticType;
  readonly treeRoutes: readonly {
    readonly treeType: "source" | "topic" | "global";
    readonly treeKey: string;
  }[];
  readonly disposition: GovernanceDisposition;
  readonly targetAssetIds: readonly string[];
  readonly reasonCode: string;
  readonly governanceRunId: string;
  readonly createdAt: string;
}

export interface DocumentGovernanceProposal {
  readonly proposalId: string;
  readonly governanceRunId: string;
  readonly scopeFingerprint: string;
  readonly targetAssetId?: string;
  readonly expectedLatestVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType?: MemorySemanticType;
  readonly treeRef?: GovernedTreeRef;
  readonly action: "create" | "update" | "split" | "merge" | "relink" | "deprecate";
  readonly title: string;
  readonly abstract?: string;
  readonly complexityClass: "simple" | "complex";
  readonly recommendedReadOrder: readonly string[];
  readonly sections: readonly {
    readonly sectionId: string;
    readonly heading: string;
    readonly brief: string;
    readonly claims: readonly {
      readonly text: string;
      readonly inputRefs: readonly string[];
      readonly evidenceRefs: readonly string[];
    }[];
  }[];
  readonly relatedAssetIds: readonly string[];
  readonly dispositions: readonly InformationDispositionRecord[];
  readonly riskClass: "low" | "medium" | "high";
  readonly reviewReasons: readonly string[];
  readonly changeSummary: string;
  readonly modelFingerprint: string;
  readonly promptVersion: string;
}

export interface DocumentGovernanceDescriptor {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType?: MemorySemanticType;
  readonly treeRef?: GovernedTreeRef;
  readonly scopeFingerprint: string;
  readonly lifecycleState: DocumentLifecycleState;
  readonly governanceState: DocumentGovernanceState;
  readonly complexityClass: "simple" | "complex";
  readonly title: string;
  readonly abstract?: string;
  readonly sectionIndex: readonly {
    readonly sectionId: string;
    readonly heading: string;
    readonly brief: string;
  }[];
  readonly documentIndexAssetId?: string;
  readonly claimEvidenceCoverage: number;
  readonly sourceDispositionCoverage: number;
  readonly conflictCount: number;
  readonly staleReasons: readonly string[];
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
  readonly navigationRefs: readonly string[];
}

export type GovernedDocumentRelationType =
  | "related"
  | "references"
  | "derived_from"
  | "depends_on"
  | "supersedes"
  | "superseded_by"
  | "contradicts"
  | "tree_route";

export interface GovernedDocumentRelation {
  readonly type: GovernedDocumentRelationType;
  readonly targetAssetId: string;
}

export interface GovernedDocumentAssetVersion {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly schemaVersion: number;
  readonly kind: GovernedDocumentKind;
  readonly purpose: GovernedDocumentPurpose;
  readonly semanticType?: MemorySemanticType;
  readonly semanticTypes?: readonly MemorySemanticType[];
  readonly treeRef?: GovernedTreeRef;
  readonly title: string;
  readonly lifecycleState: DocumentLifecycleState;
  readonly governanceState: DocumentGovernanceState;
  readonly scope: MemoryScope;
  readonly scopeFingerprint: string;
  readonly governanceDescription: DocumentGovernanceDescriptor;
  readonly documentIndexRef?: string;
  readonly content: CanonicalPublicDocumentContent;
  readonly publicContentHash: string;
  readonly governanceProjectionHash: string;
  readonly provenanceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly relations: readonly GovernedDocumentRelation[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ParsedGovernedDocumentMarkdown {
  readonly identity: {
    readonly assetId: string;
    readonly assetVersion: number;
    readonly schemaVersion: number;
    readonly kind: GovernedDocumentKind;
    readonly purpose: GovernedDocumentPurpose;
    readonly semanticType?: MemorySemanticType;
    readonly semanticTypes?: readonly MemorySemanticType[];
    readonly treeRef?: GovernedTreeRef;
    readonly lifecycleState: DocumentLifecycleState;
    readonly governanceState: DocumentGovernanceState;
    readonly scopeFingerprint: string;
    readonly publicContentHash: string;
  };
  readonly content: CanonicalPublicDocumentContent;
}
