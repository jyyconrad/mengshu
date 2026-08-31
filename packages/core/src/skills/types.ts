import type { MemoryScope } from "../domain/types.js";
import type { MemoryPolicyResolutionReceipt } from "../policy/types.js";

export type SkillArtifactStatus = "draft" | "review" | "published" | "deprecated" | "revoked";

export interface SkillResourceManifestEntry {
  readonly path: string;
  readonly contentHash: string;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly executable: false;
  readonly provenanceRef?: string;
}

export interface SkillArtifactVersion {
  readonly skillId: string;
  readonly version: number;
  readonly isHead: boolean;
  readonly ownerUserId: string;
  readonly scope: MemoryScope & { readonly visibility: "private" };
  readonly sourceCandidateId?: string;
  readonly title: string;
  readonly description: string;
  readonly applicability?: string;
  readonly triggerConditions: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly successSignals: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly riskBoundaries: readonly string[];
  readonly evidenceMemoryIds: readonly string[];
  readonly evidenceChunkIds: readonly string[];
  readonly manifest: readonly SkillResourceManifestEntry[];
  readonly contentHash: string;
  readonly status: SkillArtifactStatus;
  readonly executionMode: "suggest_only";
  readonly expectedOutcomePolicyVersion: string;
  readonly createdAt: string;
}

export type SkillArtifactOperation = "propose" | "review" | "publish" | "append" | "revoke";

export interface SkillArtifactReceipt {
  readonly id: string;
  readonly scopeFingerprint: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly skillId: string;
  readonly artifactVersion: number;
  readonly operation: SkillArtifactOperation;
  readonly reviewerUserId?: string;
  readonly decision?: "approve" | "reject";
  readonly reason?: string;
  readonly policyResolution?: MemoryPolicyResolutionReceipt;
  readonly occurredAt: string;
}

export interface SkillArtifactMutationResult {
  readonly artifact: SkillArtifactVersion;
  readonly receipt: SkillArtifactReceipt;
  readonly replayed: boolean;
}

export interface ProposeSkillInput {
  readonly scope: MemoryScope;
  readonly ownerUserId: string;
  readonly candidateId: string;
  readonly skillId: string;
  readonly expectedLatestVersion: number;
  readonly manifest: readonly SkillResourceManifestEntry[];
  readonly expectedOutcomePolicyVersion: string;
  readonly idempotencyKey: string;
}

export interface CuratedSkillImportInput {
  readonly scope: MemoryScope;
  readonly ownerUserId: string;
  readonly skillId: string;
  readonly expectedLatestVersion: 0;
  readonly title: string;
  readonly description: string;
  readonly applicability?: string;
  readonly triggerConditions: readonly string[];
  readonly preconditions: readonly string[];
  readonly steps: readonly string[];
  readonly successSignals: readonly string[];
  readonly antiPatterns: readonly string[];
  readonly riskBoundaries: readonly string[];
  readonly evidenceMemoryIds: readonly string[];
  readonly evidenceChunkIds: readonly string[];
  readonly manifest: readonly SkillResourceManifestEntry[];
  readonly expectedOutcomePolicyVersion: string;
  readonly provenanceRef: string;
  readonly license: Readonly<{
    readonly spdxId: string;
    readonly sourceUrl?: string;
  }>;
  readonly highRisk?: boolean;
  readonly idempotencyKey: string;
}

export interface ReviewSkillInput {
  readonly scope: MemoryScope;
  readonly skillId: string;
  readonly expectedLatestVersion: number;
  readonly reviewerUserId: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface PublishSkillInput {
  readonly scope: MemoryScope;
  readonly skillId: string;
  readonly expectedLatestVersion: number;
  readonly reviewerUserId: string;
  readonly reviewReceiptId: string;
  readonly idempotencyKey: string;
}

export type SkillArtifactEditableFields = Pick<SkillArtifactVersion,
  | "title"
  | "description"
  | "applicability"
  | "triggerConditions"
  | "preconditions"
  | "steps"
  | "successSignals"
  | "antiPatterns"
  | "riskBoundaries"
  | "evidenceMemoryIds"
  | "evidenceChunkIds"
  | "manifest"
  | "expectedOutcomePolicyVersion"
>;

export interface AppendSkillVersionInput {
  readonly scope: MemoryScope;
  readonly skillId: string;
  readonly expectedLatestVersion: number;
  readonly ownerUserId: string;
  readonly updates: Partial<SkillArtifactEditableFields>;
  readonly idempotencyKey: string;
}

export interface RevokeSkillInput {
  readonly scope: MemoryScope;
  readonly skillId: string;
  readonly expectedLatestVersion: number;
  readonly actorUserId: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ReadSkillInput {
  readonly scope: MemoryScope;
  readonly skillId: string;
  readonly version?: number;
}

export interface SkillReadResult {
  readonly artifact: SkillArtifactVersion;
  readonly validity: "valid" | "stale";
  readonly warnings: readonly string[];
}

export interface SearchSkillInput {
  readonly scope: MemoryScope;
  readonly query: string;
  readonly limit?: number;
  readonly embeddingAvailable?: boolean;
}

export interface SkillSearchResult {
  readonly hits: ReadonlyArray<SkillReadResult & { readonly score: number }>;
  readonly mode: "bm25" | "hybrid";
  readonly warnings: readonly string[];
}

export interface SkillExplanation {
  readonly artifact: SkillArtifactVersion;
  readonly validity: "valid" | "stale" | "revoked";
  readonly warnings: readonly string[];
  readonly receipts: readonly SkillArtifactReceipt[];
  readonly evidenceMemoryIds: readonly string[];
  readonly evidenceChunkIds: readonly string[];
  readonly manifest: readonly SkillResourceManifestEntry[];
}
