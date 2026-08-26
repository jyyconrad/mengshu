import type { CompleteRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryScope, MemorySemanticType, RecallHit } from "../domain/types.js";
import type {
  MemoryViewAssetStatus,
  MemoryViewContentValidity,
} from "../assets/types.js";

export type DisclosureMode =
  | "must_read"
  | "slot_summary"
  | "navigation"
  | "index_then_tool"
  | "tool_only";

export interface SlotAssetBinding {
  readonly assetId: string;
  readonly slot: MemorySemanticType;
  readonly pinnedVersion?: number;
  readonly disclosureMode: DisclosureMode;
  readonly priority: number;
  readonly required: boolean;
  readonly maxTokens?: number;
}

export interface NativeMemoryPolicy {
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly scopeReuse: "project_only" | "project_workspace" | "authorized";
  readonly treeDepth: "source" | "topic" | "global";
  readonly tokenBudgets: Readonly<Record<MemorySemanticType, number>>;
}

export interface AgentLoadout {
  readonly id: string;
  readonly scope: MemoryScope & { readonly visibility: "private" };
  readonly appId: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly version: number;
  readonly visibility: "private";
  readonly slotBindings: readonly SlotAssetBinding[];
  readonly nativeMemoryPolicy: NativeMemoryPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateAgentLoadoutVersionInput {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly expectedLatestVersion: number;
  readonly scope: MemoryScope;
  readonly appId: string;
  readonly agentId: string;
  readonly projectId?: string;
  readonly slotBindings: readonly SlotAssetBinding[];
  readonly nativeMemoryPolicy: NativeMemoryPolicy;
}

export interface AgentLoadoutReceipt {
  readonly requestKey: string;
  readonly requestHash: string;
  readonly loadoutId: string;
  readonly loadoutVersion: number;
}

export interface CreateAgentLoadoutVersionResult {
  readonly loadout: AgentLoadout;
  readonly replayed: boolean;
}

export interface UnbindAgentLoadoutAssetInput {
  readonly scope: MemoryScope;
  readonly loadoutId: string;
  readonly assetId: string;
  readonly slot: MemorySemanticType;
  readonly expectedLatestVersion: number;
  readonly idempotencyKey: string;
}

export interface PauseAgentLoadoutInput {
  readonly scope: MemoryScope;
  readonly loadoutId: string;
  readonly expectedLatestVersion: number;
  readonly idempotencyKey: string;
}

export interface LoadoutAssetCandidate {
  readonly assetId: string;
  readonly assetVersion: number;
  readonly assetKind: "memory_view";
  readonly status: MemoryViewAssetStatus;
  readonly contentValidity: MemoryViewContentValidity;
  readonly scope: MemoryScope;
  readonly semanticTypes: readonly MemorySemanticType[];
  readonly recordId: string;
  readonly content: string;
  readonly evidenceRefs: readonly string[];
  readonly lifecycleEligible: boolean;
  readonly riskBlocked: boolean;
  readonly conflictUnresolved: boolean;
  readonly score: number;
  readonly scoreBreakdown: CompleteRecallScoreBreakdown;
  /** The governed retrieval source that produced scoreBreakdown. */
  readonly recallSource?: RecallHit["source"];
  readonly tokenEstimate: number;
}

export type LoadoutDeniedReason =
  | "asset_unavailable"
  | "asset_not_published"
  | "asset_stale"
  | "scope_mismatch"
  | "slot_incompatible"
  | "lifecycle_ineligible"
  | "risk_blocked"
  | "conflict_unresolved"
  | "score_breakdown_unavailable"
  | "score_below_threshold"
  | "budget_exceeded";

export interface LoadoutContribution extends LoadoutAssetCandidate {
  readonly slot: MemorySemanticType;
  readonly disclosureMode: DisclosureMode;
  readonly requestedDisclosureMode?: DisclosureMode;
  readonly degradedReason?: "budget_exceeded";
  readonly bindingPriority: number;
}

export interface LoadoutAssemblyResult {
  readonly enhancementEnabled: boolean;
  readonly contributions: readonly LoadoutContribution[];
  readonly denied: ReadonlyArray<{ assetId: string; reason: LoadoutDeniedReason }>;
  readonly degraded: ReadonlyArray<{
    assetId: string;
    slot: MemorySemanticType;
    reason: "budget_exceeded";
  }>;
  readonly receipt?: {
    readonly loadoutId: string;
    readonly loadoutVersion: number;
    readonly assetVersions: ReadonlyArray<{ assetId: string; version: number }>;
  };
}
