import { createHash } from "node:crypto";
import { isAbsolute, posix } from "node:path";

import { authorityScopeFingerprint } from "../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../domain/types.js";
import type { SkillCandidate, SkillCandidateRepository } from
  "../lifecycle/skill-candidate-types.js";
import type { SkillArtifactRepository } from "./repository.js";
import type { MemoryPolicyResolver } from "../policy/memory-policy-overlay.js";
import type { MemoryPolicyResolutionReceipt } from "../policy/types.js";
import type {
  ProposeSkillInput,
  CuratedSkillImportInput,
  AppendSkillVersionInput,
  PublishSkillInput,
  ReadSkillInput,
  ReviewSkillInput,
  RevokeSkillInput,
  SearchSkillInput,
  SkillArtifactMutationResult,
  SkillArtifactReceipt,
  SkillArtifactStatus,
  SkillArtifactVersion,
  SkillExplanation,
  SkillReadResult,
  SkillResourceManifestEntry,
  SkillSearchResult,
} from "./types.js";

export type SkillArtifactErrorCode =
  | "SKILL_INVALID"
  | "SKILL_SCOPE_MISMATCH"
  | "SKILL_CANDIDATE_NOT_FOUND"
  | "SKILL_CANDIDATE_INELIGIBLE"
  | "SKILL_EVIDENCE_UNAVAILABLE"
  | "SKILL_RESOURCE_INVALID"
  | "SKILL_REVIEW_REQUIRED"
  | "SKILL_REVIEWER_UNAUTHORIZED"
  | "SKILL_HIGH_RISK_BLOCKED"
  | "SKILL_VERSION_STALE"
  | "SKILL_IDEMPOTENCY_CONFLICT"
  | "SKILL_ARTIFACT_NOT_FOUND";

export class SkillArtifactError extends Error {
  override readonly name = "SkillArtifactError";
  constructor(readonly code: SkillArtifactErrorCode) {
    super(code);
  }
}

export interface SkillEvidenceValidationResult {
  readonly readable: boolean;
  readonly reason?: string;
}

export interface SkillEvidenceValidator {
  validate(input: {
    readonly scope: MemoryScope;
    readonly memoryIds: readonly string[];
    readonly chunkIds: readonly string[];
  }): Promise<SkillEvidenceValidationResult>;
}

export interface SkillArtifactServiceDependencies {
  readonly repository: SkillArtifactRepository;
  readonly candidates: SkillCandidateRepository;
  readonly evidence: SkillEvidenceValidator;
  readonly now?: () => number;
  readonly maxResourceBytes?: number;
  readonly embeddingSearch?: SkillArtifactEmbeddingSearch;
  readonly policyResolver?: Pick<MemoryPolicyResolver, "resolve">;
  /** Host-owned target binding reader. Incompatibility stops retrieval, never widens scope. */
  readonly targetCompatibility?: {
    allowsSkill(artifact: SkillArtifactVersion, targetScope: MemoryScope): Promise<boolean>;
  };
}

export interface SkillArtifactEmbeddingSearch {
  search(input: {
    readonly scope: MemoryScope;
    readonly query: string;
    readonly limit: number;
  }): Promise<readonly { readonly skillId: string; readonly score: number }[]>;
}

const SAFE_ID = /^[^\s\p{Cc}]{1,256}$/u;
const SHA256 = /^[0-9a-f]{64}$/;
const SECRET = /(?:sk-[A-Za-z0-9_-]{16,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{16,})/i;
const SPDX_ID = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/;

function hash(domain: string, value: unknown): string {
  return createHash("sha256").update(`${domain}\0${JSON.stringify(value)}`).digest("hex");
}

function exactPrivateScope(scope: MemoryScope): string {
  if (scope.visibility !== "private") throw new SkillArtifactError("SKILL_SCOPE_MISMATCH");
  try {
    return authorityScopeFingerprint(scope);
  } catch {
    throw new SkillArtifactError("SKILL_SCOPE_MISMATCH");
  }
}

function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  try {
    return authorityScopeFingerprint(left) === authorityScopeFingerprint(right);
  } catch {
    return false;
  }
}

function validateId(value: string): void {
  if (!SAFE_ID.test(value)) throw new SkillArtifactError("SKILL_INVALID");
}

function validateResources(
  resources: readonly SkillResourceManifestEntry[],
  maxResourceBytes: number,
): readonly SkillResourceManifestEntry[] {
  let total = 0;
  const paths = new Set<string>();
  const normalized = resources.map((resource) => {
    const path = resource.path.replaceAll("\\", "/");
    const clean = posix.normalize(path);
    total += resource.sizeBytes;
    if (!path || path !== clean || isAbsolute(path) || path.startsWith("../") ||
        path.includes("/../") || /[\p{Cc}]/u.test(path) || paths.has(path) ||
        !SHA256.test(resource.contentHash) || !Number.isSafeInteger(resource.sizeBytes) ||
        resource.sizeBytes < 0 || !/^[^\s\p{Cc}]{1,128}$/u.test(resource.mimeType) ||
        resource.executable !== false ||
        (resource.provenanceRef !== undefined && !SAFE_ID.test(resource.provenanceRef))) {
      throw new SkillArtifactError("SKILL_RESOURCE_INVALID");
    }
    paths.add(path);
    return Object.freeze({ ...resource, path });
  });
  if (total > maxResourceBytes) throw new SkillArtifactError("SKILL_RESOURCE_INVALID");
  return Object.freeze(normalized);
}

function validateCandidateContent(candidate: SkillCandidate): void {
  const required = [candidate.triggerConditions, candidate.preconditions, candidate.steps,
    candidate.successSignals, candidate.riskBoundaries];
  if (!candidate.title.trim() || candidate.title.length > 80 ||
      required.some((items) => items.length === 0) || candidate.preconditions.length > 8 ||
      candidate.steps.length > 12 || candidate.successSignals.length > 8 ||
      candidate.riskBoundaries.length > 8 || candidate.evidenceMemoryIds.length === 0 ||
      candidate.evidenceChunkIds.length === 0 ||
      SECRET.test(JSON.stringify({
        title: candidate.title,
        applicability: candidate.applicability,
        triggerConditions: candidate.triggerConditions,
        preconditions: candidate.preconditions,
        steps: candidate.steps,
        successSignals: candidate.successSignals,
        antiPatterns: candidate.antiPatterns,
        riskBoundaries: candidate.riskBoundaries,
      }))) {
    throw new SkillArtifactError("SKILL_CANDIDATE_INELIGIBLE");
  }
}

function validateArtifactContent(artifact: Pick<SkillArtifactVersion,
  "title" | "description" | "triggerConditions" | "preconditions" | "steps" |
  "successSignals" | "antiPatterns" | "riskBoundaries" | "evidenceMemoryIds" |
  "evidenceChunkIds" | "expectedOutcomePolicyVersion">): void {
  const required = [artifact.triggerConditions, artifact.preconditions, artifact.steps,
    artifact.successSignals, artifact.riskBoundaries];
  const allLists = [...required, artifact.antiPatterns, artifact.evidenceMemoryIds,
    artifact.evidenceChunkIds];
  if (!artifact.title.trim() || artifact.title.length > 80 || !artifact.description.trim() ||
      artifact.description.length > 4_096 || !SAFE_ID.test(artifact.expectedOutcomePolicyVersion) ||
      required.some((items) => items.length === 0) || artifact.preconditions.length > 8 ||
      artifact.steps.length > 12 || artifact.successSignals.length > 8 ||
      artifact.riskBoundaries.length > 8 || artifact.evidenceMemoryIds.length === 0 ||
      artifact.evidenceChunkIds.length === 0 || allLists.some((items) =>
        items.some((item) => typeof item !== "string" || !item.trim() || item.length > 2_048)) ||
      SECRET.test(JSON.stringify(artifact))) {
    throw new SkillArtifactError("SKILL_CANDIDATE_INELIGIBLE");
  }
}

function artifactContent(artifact: Pick<SkillArtifactVersion,
  "ownerUserId" | "sourceCandidateId" | "title" | "description" | "applicability" |
  "triggerConditions" | "preconditions" | "steps" | "successSignals" | "antiPatterns" |
  "riskBoundaries" | "evidenceMemoryIds" | "evidenceChunkIds" | "manifest" |
  "expectedOutcomePolicyVersion">) {
  return {
    ownerUserId: artifact.ownerUserId,
    sourceCandidateId: artifact.sourceCandidateId,
    title: artifact.title,
    description: artifact.description,
    applicability: artifact.applicability,
    triggerConditions: [...artifact.triggerConditions],
    preconditions: [...artifact.preconditions],
    steps: [...artifact.steps],
    successSignals: [...artifact.successSignals],
    antiPatterns: [...artifact.antiPatterns],
    riskBoundaries: [...artifact.riskBoundaries],
    evidenceMemoryIds: [...artifact.evidenceMemoryIds],
    evidenceChunkIds: [...artifact.evidenceChunkIds],
    manifest: artifact.manifest.map((resource) => ({ ...resource })),
    expectedOutcomePolicyVersion: artifact.expectedOutcomePolicyVersion,
  };
}

/** Same canonical bytes as persisted versions; consumers must recompute, not trust contentHash. */
export function computeSkillArtifactContentHash(artifact: Parameters<typeof artifactContent>[0]): string {
  return hash("skill-artifact-content-v1", artifactContent(artifact));
}

function tokens(value: string): string[] {
  return value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}_-]+/gu) ?? [];
}

export class SkillArtifactService {
  readonly #repository: SkillArtifactRepository;
  readonly #candidates: SkillCandidateRepository;
  readonly #evidence: SkillEvidenceValidator;
  readonly #now: () => number;
  readonly #maxResourceBytes: number;
  readonly #embeddingSearch?: SkillArtifactEmbeddingSearch;
  readonly #policyResolver?: Pick<MemoryPolicyResolver, "resolve">;
  readonly #targetCompatibility?: SkillArtifactServiceDependencies["targetCompatibility"];

  constructor(deps: SkillArtifactServiceDependencies) {
    this.#repository = deps.repository;
    this.#candidates = deps.candidates;
    this.#evidence = deps.evidence;
    this.#now = deps.now ?? Date.now;
    this.#maxResourceBytes = deps.maxResourceBytes ?? 5_242_880;
    this.#embeddingSearch = deps.embeddingSearch;
    this.#policyResolver = deps.policyResolver;
    this.#targetCompatibility = deps.targetCompatibility;
  }

  async #replay(
    scopeFingerprint: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<SkillArtifactMutationResult | undefined> {
    const receipt = await this.#repository.getReceipt(scopeFingerprint, idempotencyKey);
    if (receipt === undefined) return undefined;
    if (receipt.requestHash !== requestHash) {
      throw new SkillArtifactError("SKILL_IDEMPOTENCY_CONFLICT");
    }
    const artifact = await this.#repository.getVersion(
      scopeFingerprint,
      receipt.skillId,
      receipt.artifactVersion,
    );
    if (artifact === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    return { artifact, receipt, replayed: true };
  }

  #receipt(input: {
    scopeFingerprint: string; idempotencyKey: string; requestHash: string;
    skillId: string; artifactVersion: number; operation: SkillArtifactReceipt["operation"];
    reviewerUserId?: string; decision?: "approve" | "reject"; reason?: string;
    policyResolution?: MemoryPolicyResolutionReceipt;
  }): SkillArtifactReceipt {
    const occurredAt = new Date(this.#now()).toISOString();
    return Object.freeze({
      id: `sr_${hash("skill-artifact-receipt-v1", [
        input.scopeFingerprint, input.idempotencyKey, input.requestHash,
      ]).slice(0, 48)}`,
      ...input,
      occurredAt,
    });
  }

  async #resolvePolicy(scope: MemoryScope): Promise<MemoryPolicyResolutionReceipt | undefined> {
    return (await this.#policyResolver?.resolve({ scope, layer: "skill_review" }))?.receipt;
  }

  async #validateEvidence(scope: MemoryScope, artifact: Pick<SkillArtifactVersion,
    "evidenceMemoryIds" | "evidenceChunkIds">): Promise<void> {
    const result = await this.#evidence.validate({
      scope,
      memoryIds: artifact.evidenceMemoryIds,
      chunkIds: artifact.evidenceChunkIds,
    });
    if (!result.readable) throw new SkillArtifactError("SKILL_EVIDENCE_UNAVAILABLE");
  }

  async proposeFromCandidate(input: ProposeSkillInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.ownerUserId, input.candidateId, input.skillId,
      input.expectedOutcomePolicyVersion, input.idempotencyKey]) validateId(id);
    if (input.ownerUserId !== input.scope.userId || input.expectedLatestVersion !== 0) {
      throw new SkillArtifactError(input.ownerUserId !== input.scope.userId
        ? "SKILL_SCOPE_MISMATCH" : "SKILL_VERSION_STALE");
    }
    const requestHash = hash("skill-propose-v1", input);
    const replay = await this.#replay(scopeFingerprint, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
    const policyResolution = await this.#resolvePolicy(input.scope);
    const candidate = await this.#candidates.get(input.candidateId);
    if (candidate === undefined) throw new SkillArtifactError("SKILL_CANDIDATE_NOT_FOUND");
    if (!["pending", "active"].includes(candidate.status) || !sameScope(candidate.scope, input.scope)) {
      throw new SkillArtifactError("SKILL_CANDIDATE_INELIGIBLE");
    }
    validateCandidateContent(candidate);
    await this.#validateEvidence(input.scope, candidate);
    const manifest = validateResources(input.manifest, this.#maxResourceBytes);
    const content = {
      ownerUserId: input.ownerUserId,
      sourceCandidateId: candidate.id,
      title: candidate.title,
      description: candidate.reason ?? candidate.applicability ?? candidate.title,
      applicability: candidate.applicability,
      triggerConditions: [...candidate.triggerConditions], preconditions: [...candidate.preconditions],
      steps: [...candidate.steps], successSignals: [...candidate.successSignals],
      antiPatterns: [...candidate.antiPatterns], riskBoundaries: [...candidate.riskBoundaries],
      evidenceMemoryIds: [...candidate.evidenceMemoryIds],
      evidenceChunkIds: [...candidate.evidenceChunkIds], manifest,
      expectedOutcomePolicyVersion: input.expectedOutcomePolicyVersion,
    };
    const artifact: SkillArtifactVersion = Object.freeze({
      skillId: input.skillId,
      version: 1,
      isHead: true,
      scope: Object.freeze({ ...input.scope, visibility: "private" as const }),
      ...content,
      contentHash: hash("skill-artifact-content-v1", content),
      status: "draft",
      executionMode: "suggest_only",
      createdAt: new Date(this.#now()).toISOString(),
    });
    const receipt = this.#receipt({
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      skillId: input.skillId, artifactVersion: 1, operation: "propose",
      ...(policyResolution === undefined ? {} : { policyResolution }),
    });
    try {
      return await this.#repository.appendVersion({
        scopeFingerprint, artifact, receipt, expectedLatestVersion: 0,
      });
    } catch (error) {
      this.#mapRepositoryError(error);
    }
  }

  async importCurated(input: CuratedSkillImportInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.ownerUserId, input.skillId, input.expectedOutcomePolicyVersion,
      input.provenanceRef, input.idempotencyKey]) validateId(id);
    if (input.ownerUserId !== input.scope.userId || input.expectedLatestVersion !== 0 ||
        !SPDX_ID.test(input.license.spdxId) ||
        (input.license.sourceUrl !== undefined && (() => {
          try { return new URL(input.license.sourceUrl).protocol !== "https:"; } catch { return true; }
        })()) || input.manifest.some((resource) => resource.provenanceRef === undefined)) {
      throw new SkillArtifactError(input.ownerUserId !== input.scope.userId
        ? "SKILL_SCOPE_MISMATCH" : "SKILL_INVALID");
    }
    const manifest = validateResources(input.manifest, this.#maxResourceBytes);
    const content = {
      ownerUserId: input.ownerUserId,
      title: input.title,
      description: input.description,
      applicability: input.applicability,
      triggerConditions: [...input.triggerConditions],
      preconditions: [...input.preconditions],
      steps: [...input.steps],
      successSignals: [...input.successSignals],
      antiPatterns: [...input.antiPatterns],
      riskBoundaries: [...input.riskBoundaries],
      evidenceMemoryIds: [...input.evidenceMemoryIds],
      evidenceChunkIds: [...input.evidenceChunkIds],
      manifest,
      expectedOutcomePolicyVersion: input.expectedOutcomePolicyVersion,
    };
    validateArtifactContent(content);
    await this.#validateEvidence(input.scope, content);
    const curatedImportHash = hash("skill-curated-import-v1", {
      scopeFingerprint,
      skillId: input.skillId,
      content,
      provenanceRef: input.provenanceRef,
      license: input.license,
      highRisk: input.highRisk === true,
    });
    const candidateId = `curated_${hash("skill-curated-candidate-v1", [
      scopeFingerprint, input.skillId,
    ]).slice(0, 48)}`;
    const existing = await this.#candidates.get(candidateId);
    if (existing !== undefined && existing.metadata?.curatedImportHash !== curatedImportHash) {
      throw new SkillArtifactError("SKILL_IDEMPOTENCY_CONFLICT");
    }
    if (existing === undefined) {
      await this.#candidates.create({
        id: candidateId,
        title: input.title,
        topicLabel: `curated-${input.skillId}`.slice(0, 80),
        applicability: input.applicability,
        triggerConditions: [...input.triggerConditions],
        preconditions: [...input.preconditions],
        steps: [...input.steps],
        successSignals: [...input.successSignals],
        antiPatterns: [...input.antiPatterns],
        riskBoundaries: [...input.riskBoundaries],
        highRisk: input.highRisk === true,
        evidenceMemoryIds: [...input.evidenceMemoryIds],
        evidenceChunkIds: [...input.evidenceChunkIds],
        confidence: 0,
        status: "pending",
        reason: input.description,
        scope: input.scope,
        metadata: {
          source: "curated_import",
          curatedImportHash,
          provenanceRef: input.provenanceRef,
          license: { ...input.license },
          reviewRequired: true,
        },
      });
    }
    return this.proposeFromCandidate({
      scope: input.scope,
      ownerUserId: input.ownerUserId,
      candidateId,
      skillId: input.skillId,
      expectedLatestVersion: 0,
      manifest,
      expectedOutcomePolicyVersion: input.expectedOutcomePolicyVersion,
      idempotencyKey: input.idempotencyKey,
    });
  }

  async review(input: ReviewSkillInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.skillId, input.reviewerUserId, input.idempotencyKey]) validateId(id);
    if (input.reviewerUserId !== input.scope.userId) {
      throw new SkillArtifactError("SKILL_REVIEWER_UNAUTHORIZED");
    }
    const requestHash = hash("skill-review-v1", input);
    const replay = await this.#replay(scopeFingerprint, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
    const policyResolution = await this.#resolvePolicy(input.scope);
    const previous = await this.#repository.getLatest(scopeFingerprint, input.skillId);
    if (previous === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion || previous.status !== "draft") {
      throw new SkillArtifactError("SKILL_VERSION_STALE");
    }
    const version = previous.version + 1;
    const status: SkillArtifactStatus = input.decision === "approve" ? "review" : "revoked";
    const artifact: SkillArtifactVersion = Object.freeze({
      ...previous, version, isHead: true, status, createdAt: new Date(this.#now()).toISOString(),
    });
    const receipt = this.#receipt({
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      skillId: input.skillId, artifactVersion: version, operation: "review",
      reviewerUserId: input.reviewerUserId, decision: input.decision, reason: input.reason,
      ...(policyResolution === undefined ? {} : { policyResolution }),
    });
    try {
      return await this.#repository.appendVersion({
        scopeFingerprint, artifact, receipt, expectedLatestVersion: previous.version,
      });
    } catch (error) {
      this.#mapRepositoryError(error);
    }
  }

  async publish(input: PublishSkillInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.skillId, input.reviewerUserId, input.reviewReceiptId,
      input.idempotencyKey]) validateId(id);
    if (input.reviewerUserId !== input.scope.userId) {
      throw new SkillArtifactError("SKILL_REVIEWER_UNAUTHORIZED");
    }
    const requestHash = hash("skill-publish-v1", input);
    const replay = await this.#replay(scopeFingerprint, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
    const policyResolution = await this.#resolvePolicy(input.scope);
    const previous = await this.#repository.getLatest(scopeFingerprint, input.skillId);
    if (previous === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion || previous.status !== "review") {
      throw new SkillArtifactError("SKILL_VERSION_STALE");
    }
    const reviewReceipt = await this.#repository.getReceiptById(scopeFingerprint, input.reviewReceiptId);
    if (reviewReceipt?.operation !== "review" || reviewReceipt.decision !== "approve" ||
        reviewReceipt.skillId !== input.skillId ||
        reviewReceipt.artifactVersion !== previous.version ||
        reviewReceipt.reviewerUserId !== input.reviewerUserId) {
      throw new SkillArtifactError("SKILL_REVIEW_REQUIRED");
    }
    const candidate = previous.sourceCandidateId === undefined
      ? undefined
      : await this.#candidates.get(previous.sourceCandidateId);
    if (candidate === undefined || candidate.highRisk) {
      throw new SkillArtifactError(candidate?.highRisk
        ? "SKILL_HIGH_RISK_BLOCKED" : "SKILL_CANDIDATE_INELIGIBLE");
    }
    await this.#validateEvidence(input.scope, previous);
    validateResources(previous.manifest, this.#maxResourceBytes);
    const version = previous.version + 1;
    const artifact: SkillArtifactVersion = Object.freeze({
      ...previous,
      version,
      isHead: true,
      status: "published",
      executionMode: "suggest_only",
      createdAt: new Date(this.#now()).toISOString(),
    });
    const receipt = this.#receipt({
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      skillId: input.skillId, artifactVersion: version, operation: "publish",
      reviewerUserId: input.reviewerUserId,
      ...(policyResolution === undefined ? {} : { policyResolution }),
    });
    try {
      return await this.#repository.appendVersion({
        scopeFingerprint, artifact, receipt, expectedLatestVersion: previous.version,
      });
    } catch (error) {
      this.#mapRepositoryError(error);
    }
  }

  async appendVersion(input: AppendSkillVersionInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.skillId, input.ownerUserId, input.idempotencyKey]) validateId(id);
    if (input.ownerUserId !== input.scope.userId || !Number.isSafeInteger(input.expectedLatestVersion) ||
        input.expectedLatestVersion < 1 || !input.updates || typeof input.updates !== "object" ||
        Array.isArray(input.updates)) {
      throw new SkillArtifactError(input.ownerUserId !== input.scope.userId
        ? "SKILL_SCOPE_MISMATCH" : "SKILL_INVALID");
    }
    const requestHash = hash("skill-append-v1", input);
    const replay = await this.#replay(scopeFingerprint, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
    const policyResolution = await this.#resolvePolicy(input.scope);
    const previous = await this.#repository.getLatest(scopeFingerprint, input.skillId);
    if (previous === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion || previous.status === "revoked" ||
        previous.ownerUserId !== input.ownerUserId) {
      throw new SkillArtifactError("SKILL_VERSION_STALE");
    }
    const manifest = validateResources(input.updates.manifest ?? previous.manifest,
      this.#maxResourceBytes);
    const merged = {
      ...previous,
      ...input.updates,
      manifest,
      triggerConditions: Object.freeze([...(input.updates.triggerConditions ?? previous.triggerConditions)]),
      preconditions: Object.freeze([...(input.updates.preconditions ?? previous.preconditions)]),
      steps: Object.freeze([...(input.updates.steps ?? previous.steps)]),
      successSignals: Object.freeze([...(input.updates.successSignals ?? previous.successSignals)]),
      antiPatterns: Object.freeze([...(input.updates.antiPatterns ?? previous.antiPatterns)]),
      riskBoundaries: Object.freeze([...(input.updates.riskBoundaries ?? previous.riskBoundaries)]),
      evidenceMemoryIds: Object.freeze([...(input.updates.evidenceMemoryIds ?? previous.evidenceMemoryIds)]),
      evidenceChunkIds: Object.freeze([...(input.updates.evidenceChunkIds ?? previous.evidenceChunkIds)]),
    };
    validateArtifactContent(merged);
    await this.#validateEvidence(input.scope, merged);
    const content = artifactContent(merged);
    const contentHash = hash("skill-artifact-content-v1", content);
    if (contentHash === previous.contentHash) {
      const receipt = this.#receipt({
        scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
        skillId: input.skillId, artifactVersion: previous.version, operation: "append",
        reason: "content_unchanged",
        ...(policyResolution === undefined ? {} : { policyResolution }),
      });
      try {
        return await this.#repository.recordUnchangedAppend({
          scopeFingerprint,
          artifact: previous,
          receipt,
          expectedLatestVersion: previous.version,
        });
      } catch (error) {
        this.#mapRepositoryError(error);
      }
    }
    const version = previous.version + 1;
    const artifact: SkillArtifactVersion = Object.freeze({
      ...merged,
      version,
      isHead: true,
      contentHash,
      status: "draft",
      executionMode: "suggest_only",
      createdAt: new Date(this.#now()).toISOString(),
    });
    const receipt = this.#receipt({
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      skillId: input.skillId, artifactVersion: version, operation: "append",
      ...(policyResolution === undefined ? {} : { policyResolution }),
    });
    try {
      return await this.#repository.appendVersion({
        scopeFingerprint, artifact, receipt, expectedLatestVersion: previous.version,
      });
    } catch (error) {
      this.#mapRepositoryError(error);
    }
  }

  async revoke(input: RevokeSkillInput): Promise<SkillArtifactMutationResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    for (const id of [input.skillId, input.actorUserId, input.idempotencyKey]) validateId(id);
    if (input.actorUserId !== input.scope.userId || !Number.isSafeInteger(input.expectedLatestVersion) ||
        input.expectedLatestVersion < 1 || !input.reason.trim() || input.reason.length > 1_024) {
      throw new SkillArtifactError(input.actorUserId !== input.scope.userId
        ? "SKILL_REVIEWER_UNAUTHORIZED" : "SKILL_INVALID");
    }
    const requestHash = hash("skill-revoke-v1", input);
    const replay = await this.#replay(scopeFingerprint, input.idempotencyKey, requestHash);
    if (replay !== undefined) return replay;
    const policyResolution = await this.#resolvePolicy(input.scope);
    const previous = await this.#repository.getLatest(scopeFingerprint, input.skillId);
    if (previous === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    if (previous.version !== input.expectedLatestVersion || previous.status === "revoked") {
      throw new SkillArtifactError("SKILL_VERSION_STALE");
    }
    const version = previous.version + 1;
    const artifact: SkillArtifactVersion = Object.freeze({
      ...previous, version, isHead: true, status: "revoked",
      createdAt: new Date(this.#now()).toISOString(),
    });
    const receipt = this.#receipt({
      scopeFingerprint, idempotencyKey: input.idempotencyKey, requestHash,
      skillId: input.skillId, artifactVersion: version, operation: "revoke",
      reviewerUserId: input.actorUserId, reason: input.reason.trim(),
      ...(policyResolution === undefined ? {} : { policyResolution }),
    });
    try {
      return await this.#repository.appendVersion({
        scopeFingerprint, artifact, receipt, expectedLatestVersion: previous.version,
      });
    } catch (error) {
      this.#mapRepositoryError(error);
    }
  }

  async explain(input: ReadSkillInput): Promise<SkillExplanation> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    validateId(input.skillId);
    const artifact = input.version === undefined
      ? await this.#repository.getLatest(scopeFingerprint, input.skillId)
      : await this.#repository.getVersion(scopeFingerprint, input.skillId, input.version);
    if (artifact === undefined) throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    const receipts = await this.#repository.listReceipts(scopeFingerprint, input.skillId);
    const evidence = artifact.status === "revoked" ? { readable: false } :
      await this.#evidence.validate({
        scope: input.scope,
        memoryIds: artifact.evidenceMemoryIds,
        chunkIds: artifact.evidenceChunkIds,
      });
    const compatible = await this.#targetCompatible(artifact, input.scope);
    const validity = artifact.status === "revoked" ? "revoked" as const :
      evidence.readable && compatible ? "valid" as const : "stale" as const;
    const warnings = validity === "stale"
      ? [...(evidence.readable ? [] : ["evidence_unavailable"]), ...(compatible ? [] : ["target_incompatible"])]
      : [];
    return Object.freeze({
      artifact,
      validity,
      warnings: Object.freeze(warnings),
      receipts: Object.freeze(receipts.map((receipt) => Object.freeze({ ...receipt }))),
      evidenceMemoryIds: Object.freeze([...artifact.evidenceMemoryIds]),
      evidenceChunkIds: Object.freeze([...artifact.evidenceChunkIds]),
      manifest: Object.freeze(artifact.manifest.map((resource) => Object.freeze({ ...resource }))),
    });
  }

  async read(input: ReadSkillInput): Promise<SkillReadResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    const artifact = input.version === undefined
      ? await this.#repository.getLatest(scopeFingerprint, input.skillId)
      : await this.#repository.getVersion(scopeFingerprint, input.skillId, input.version);
    if (artifact === undefined || artifact.status === "revoked") {
      throw new SkillArtifactError("SKILL_ARTIFACT_NOT_FOUND");
    }
    const evidence = await this.#evidence.validate({
      scope: input.scope,
      memoryIds: artifact.evidenceMemoryIds,
      chunkIds: artifact.evidenceChunkIds,
    });
    const compatible = await this.#targetCompatible(artifact, input.scope);
    return evidence.readable && compatible
      ? { artifact, validity: "valid", warnings: [] }
      : { artifact, validity: "stale", warnings: [
        ...(evidence.readable ? [] : ["evidence_unavailable"]), ...(compatible ? [] : ["target_incompatible"]),
      ] };
  }

  async search(input: SearchSkillInput): Promise<SkillSearchResult> {
    const scopeFingerprint = exactPrivateScope(input.scope);
    if (!input.query.trim()) throw new SkillArtifactError("SKILL_INVALID");
    const limit = input.limit ?? 10;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new SkillArtifactError("SKILL_INVALID");
    }
    const bm25 = await this.#repository.searchPublished(scopeFingerprint, input.query, limit * 2);
    const scores = new Map(bm25.map((hit) => [hit.artifact.skillId, hit.score]));
    let mode: SkillSearchResult["mode"] = "bm25";
    const warnings: string[] = [];
    if (input.embeddingAvailable === true && this.#embeddingSearch !== undefined) {
      try {
        const semantic = await this.#embeddingSearch.search({
          scope: input.scope, query: input.query, limit: limit * 2,
        });
        for (const hit of semantic) {
          if (!Number.isFinite(hit.score)) continue;
          scores.set(hit.skillId, (scores.get(hit.skillId) ?? 0) + hit.score);
        }
        mode = "hybrid";
      } catch {
        warnings.push("embedding_failed_bm25_fallback");
      }
    } else if (input.embeddingAvailable === true) {
      warnings.push("embedding_unavailable_bm25_fallback");
    } else {
      warnings.push("embedding_unavailable_bm25_fallback");
    }
    const artifacts = new Map(bm25.map((hit) => [hit.artifact.skillId, hit.artifact]));
    const hits = await Promise.all([...scores.entries()].map(async ([skillId, score]) => {
      const artifact = artifacts.get(skillId) ??
        (await this.#repository.getLatest(scopeFingerprint, skillId));
      if (artifact?.status !== "published") return undefined;
      const read = await this.read({ scope: input.scope, skillId });
      if (this.#targetCompatibility && read.validity !== "valid") return undefined;
      return { ...read, score };
    }));
    const ranked = hits.filter((hit): hit is NonNullable<typeof hit> => hit !== undefined);
    ranked.sort((left, right) => right.score - left.score ||
      left.artifact.skillId.localeCompare(right.artifact.skillId));
    return {
      hits: ranked.filter((hit) => hit.score > 0).slice(0, limit),
      mode,
      warnings: Object.freeze(warnings),
    };
  }

  #mapRepositoryError(error: unknown): never {
    if (error instanceof Error) {
      if (error.message === "SKILL_VERSION_STALE") {
        throw new SkillArtifactError("SKILL_VERSION_STALE");
      }
      if (error.message === "SKILL_IDEMPOTENCY_CONFLICT") {
        throw new SkillArtifactError("SKILL_IDEMPOTENCY_CONFLICT");
      }
    }
    throw error;
  }

  async #targetCompatible(artifact: SkillArtifactVersion, scope: MemoryScope): Promise<boolean> {
    // Owners may inspect draft/review artifacts; those statuses remain ineligible for search and loadout.
    if (artifact.status !== "published") return true;
    if (artifact.executionMode !== "suggest_only") return false;
    if (!this.#targetCompatibility) return true;
    try {
      if (!await this.#targetCompatibility.allowsSkill(artifact, scope)) return false;
      const head = await this.#repository.getLatest(exactPrivateScope(scope), artifact.skillId);
      return head !== undefined && head.status !== "revoked" && head.status !== "deprecated";
    }
    catch { return false; }
  }
}
