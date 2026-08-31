import type { MemoryScope } from "../domain/types.js";

export type MemoryPolicyLayer =
  | "candidate_extraction"
  | "tree_summary"
  | "skill_review"
  | "document_organization";

export interface MemoryPolicyTarget {
  readonly appId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
}

export interface MemoryPolicyOverlayVersion {
  readonly id: string;
  readonly version: number;
  readonly target: MemoryPolicyTarget;
  readonly layer: MemoryPolicyLayer;
  readonly focusHints: readonly string[];
  readonly ignoreHints: readonly string[];
  readonly aggregationHints: readonly string[];
  readonly status: "draft" | "active" | "revoked";
  readonly ownerUserId: string;
  readonly scope: MemoryScope & { readonly visibility: "private" };
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface MemoryPolicyOverlayReceipt {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly overlayId: string;
  readonly version: number;
  readonly occurredAt: string;
}

export interface AppendMemoryPolicyOverlayInput {
  readonly scope: MemoryScope;
  readonly id: string;
  readonly expectedLatestVersion: number;
  readonly idempotencyKey: string;
  readonly ownerUserId: string;
  readonly target: MemoryPolicyTarget;
  readonly layer: MemoryPolicyLayer;
  readonly focusHints: readonly string[];
  readonly ignoreHints: readonly string[];
  readonly aggregationHints: readonly string[];
  readonly status: MemoryPolicyOverlayVersion["status"];
}

export interface MemoryPolicyMutationResult {
  readonly overlay: MemoryPolicyOverlayVersion;
  readonly receipt: MemoryPolicyOverlayReceipt;
  readonly replayed: boolean;
}

export interface MemoryPolicyResolutionReceipt {
  readonly scopeFingerprint: string;
  readonly layer: MemoryPolicyLayer;
  readonly overlayId?: string;
  readonly overlayVersion?: number;
  readonly contentHash?: string;
  readonly guardVersion: "memory-policy-guard-v1";
  readonly resolutionHash: string;
}

export interface ResolvedMemoryPolicy {
  readonly source: "system_default" | "overlay";
  readonly overlay?: MemoryPolicyOverlayVersion;
  readonly policy: Readonly<{
    focusHints: readonly string[];
    ignoreHints: readonly string[];
    aggregationHints: readonly string[];
  }>;
  readonly rendered: string;
  readonly warnings: readonly string[];
  readonly receipt: Readonly<MemoryPolicyResolutionReceipt>;
}
