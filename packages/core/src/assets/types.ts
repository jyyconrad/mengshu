import type {
  MemoryLifecycleStatus,
  MemoryScope,
  MemorySemanticType,
} from "../domain/types.js";

export type MemoryViewAssetStatus =
  | "draft"
  | "review"
  | "published"
  | "deprecated"
  | "revoked";

export type MemoryViewContentValidity = "current" | "stale";

export interface MemoryProjectionContentRef {
  readonly type: "memory_projection";
  readonly recordIds: readonly string[];
  readonly treeNodeIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly resolutionHash: string;
}

export interface MemoryViewAssetQualitySnapshot {
  readonly minValueScore?: number;
  readonly importance?: number;
  readonly confidence?: number;
  readonly hotness?: number;
  readonly scoringVersion: string;
}

export interface MemoryViewAssetDescriptor {
  readonly id: string;
  readonly kind: "memory_view";
  readonly owner: {
    readonly subjectType: "user";
    readonly subjectId: string;
  };
  readonly title: string;
  readonly description?: string;
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly sourceScope: MemoryScope & { readonly visibility: "private" };
  readonly version: number;
  readonly status: MemoryViewAssetStatus;
  readonly visibility: "private";
  /** 有效性只能读时解析；持久描述符不得把 stale 混入发布状态机。 */
  readonly contentValidity?: undefined;
  readonly contentRef: MemoryProjectionContentRef;
  readonly provenanceRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly riskFlags: readonly string[];
  readonly qualitySnapshot: MemoryViewAssetQualitySnapshot;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type MemoryViewPromotionDecision =
  | "private_scope"
  | "content_ref_valid"
  | "exact_scope"
  | "active_memory"
  | "evidence_complete"
  | "semantic_type_consistent"
  | "conflict_free"
  | "risk_free"
  | "faithfulness_passed";

export interface MemoryViewPromotionReceipt {
  readonly id: string;
  readonly requestKey: string;
  readonly requestHash: string;
  readonly assetId: string;
  readonly assetVersion: number;
  readonly scopeFingerprint: string;
  readonly targetStatus: MemoryViewAssetStatus;
  readonly decisions: readonly MemoryViewPromotionDecision[];
  readonly createdAt: string;
}

export interface MemoryViewMemoryFact {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly lifecycleStatus: MemoryLifecycleStatus;
  readonly semanticType?: MemorySemanticType;
  readonly evidenceIds: readonly string[];
  readonly riskFlags: readonly string[];
  readonly unresolvedConflict: boolean;
}

export interface MemoryViewTreeFact {
  readonly id: string;
  readonly scope: MemoryScope;
  readonly evidenceIds: readonly string[];
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly stale: boolean;
  readonly faithfulnessPassed: boolean;
}

export interface MemoryViewSourceSnapshot {
  readonly memories: readonly MemoryViewMemoryFact[];
  readonly trees: readonly MemoryViewTreeFact[];
  readonly faithfulnessPassed: boolean;
}

export interface MemoryViewSourceResolver {
  resolveMemories(input: {
    readonly scope: MemoryScope;
    readonly recordIds: readonly string[];
  }): Promise<readonly MemoryViewMemoryFact[]>;
  resolveTrees?(input: {
    readonly scope: MemoryScope;
    readonly treeNodeIds: readonly string[];
  }): Promise<readonly MemoryViewTreeFact[]>;
}

export interface CreateMemoryViewAssetVersionInput {
  readonly kind?: "memory_view";
  readonly assetId: string;
  readonly idempotencyKey: string;
  readonly expectedLatestVersion: number;
  readonly scope: MemoryScope;
  readonly ownerUserId: string;
  readonly title: string;
  readonly description?: string;
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly contentRef: MemoryProjectionContentRef;
  readonly provenanceRefs?: readonly string[];
  readonly riskFlags: readonly string[];
  readonly qualitySnapshot: MemoryViewAssetQualitySnapshot;
  readonly targetStatus: "draft" | "review" | "published";
}

export interface ChangeMemoryViewAssetStatusInput {
  readonly scope: MemoryScope;
  readonly assetId: string;
  readonly expectedLatestVersion: number;
  readonly targetStatus: "deprecated" | "revoked";
  readonly idempotencyKey: string;
}

export interface MemoryViewPromotionResult {
  readonly asset: MemoryViewAssetDescriptor;
  readonly receipt: MemoryViewPromotionReceipt;
  readonly replayed: boolean;
}

export interface MemoryViewAssetReadResult {
  readonly asset: MemoryViewAssetDescriptor;
  readonly contentValidity: MemoryViewContentValidity;
  readonly staleReasons: readonly string[];
  readonly explanation: {
    readonly assetId: string;
    readonly version: number;
    readonly status: MemoryViewAssetStatus;
    readonly scopeFingerprint: string;
    readonly recordIds: readonly string[];
    readonly treeNodeIds: readonly string[];
    readonly evidenceIds: readonly string[];
    readonly semanticTypes: readonly MemorySemanticType[];
    readonly qualitySnapshot: MemoryViewAssetQualitySnapshot;
  };
}

export type MemoryViewAssetSearchField =
  | "title"
  | "description"
  | "semanticTypes"
  | "sourceRefs";

export interface SearchMemoryViewAssetsInput {
  readonly query: string;
  readonly limit?: number;
  readonly semanticType?: MemorySemanticType;
}

export interface MemoryViewAssetSearchResult {
  readonly query: string;
  readonly assets: ReadonlyArray<{
    readonly asset: MemoryViewAssetDescriptor;
    readonly matchedFields: readonly MemoryViewAssetSearchField[];
  }>;
  readonly filtered: ReadonlyArray<{
    readonly assetId: string;
    readonly reason: "semantic_type_mismatch" | "query_mismatch";
  }>;
}
