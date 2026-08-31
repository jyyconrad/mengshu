import type {
  SkillArtifactMutationResult,
  SkillArtifactReceipt,
  SkillArtifactVersion,
} from "./types.js";

export interface SkillArtifactRepository {
  getLatest(scopeFingerprint: string, skillId: string): Promise<SkillArtifactVersion | undefined>;
  getVersion(
    scopeFingerprint: string,
    skillId: string,
    version: number,
  ): Promise<SkillArtifactVersion | undefined>;
  listLatest(scopeFingerprint: string): Promise<readonly SkillArtifactVersion[]>;
  searchPublished(
    scopeFingerprint: string,
    query: string,
    limit: number,
  ): Promise<readonly SkillArtifactSearchHit[]>;
  getReceipt(
    scopeFingerprint: string,
    idempotencyKey: string,
  ): Promise<SkillArtifactReceipt | undefined>;
  getReceiptById(scopeFingerprint: string, receiptId: string): Promise<SkillArtifactReceipt | undefined>;
  listReceipts(scopeFingerprint: string, skillId: string): Promise<readonly SkillArtifactReceipt[]>;
  appendVersion(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult>;
  recordUnchangedAppend(input: {
    readonly scopeFingerprint: string;
    readonly artifact: SkillArtifactVersion;
    readonly receipt: SkillArtifactReceipt;
    readonly expectedLatestVersion: number;
  }): Promise<SkillArtifactMutationResult>;
}

export interface SkillArtifactSearchHit {
  readonly artifact: SkillArtifactVersion;
  readonly score: number;
}
