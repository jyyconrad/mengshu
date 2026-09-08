import { createHash } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { MemoryScope } from "../domain/types.js";
import { InMemorySkillCandidateRepository } from "../lifecycle/skill-candidate-repository.js";
import { InMemorySkillArtifactRepository } from "./in-memory-repository.js";
import { SkillArtifactService, type SkillArtifactServiceDependencies } from "./skill-artifact-service.js";

const scope: MemoryScope = {
  tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
  agentId: "agent-1", namespace: "memories", visibility: "private",
};
const resource = {
  path: "references/release.md",
  contentHash: createHash("sha256").update("release").digest("hex"),
  sizeBytes: 7,
  mimeType: "text/markdown",
  executable: false as const,
  provenanceRef: "evidence-1",
};

async function fixture(options: {
  highRisk?: boolean;
  evidenceReadable?: boolean;
  targetCompatibility?: SkillArtifactServiceDependencies["targetCompatibility"];
  policyReceipt?: {
    scopeFingerprint: string;
    layer: "skill_review";
    overlayId: string;
    overlayVersion: number;
    contentHash: string;
    guardVersion: "memory-policy-guard-v1";
    resolutionHash: string;
  };
} = {}) {
  const candidates = new InMemorySkillCandidateRepository({ now: () => 100 });
  const candidate = await candidates.create({
    id: "candidate-1",
    title: "Release safely",
    topicLabel: "release",
    applicability: "production releases",
    triggerConditions: ["when publishing"],
    preconditions: ["CI is green"],
    steps: ["Run CI", "Approve release"],
    successSignals: ["deployment is healthy"],
    antiPatterns: ["manual production edits"],
    riskBoundaries: ["never bypass approval"],
    highRisk: options.highRisk ?? false,
    evidenceMemoryIds: ["memory-v1"],
    evidenceChunkIds: ["evidence-1"],
    confidence: 0.95,
    status: "pending",
    scope,
  });
  const repository = new InMemorySkillArtifactRepository();
  const service = new SkillArtifactService({
    repository,
    candidates,
    evidence: {
      validate: async () => ({
        readable: options.evidenceReadable !== false,
        reason: options.evidenceReadable === false ? "revoked" : undefined,
      }),
    },
    now: () => 1_000,
    targetCompatibility: options.targetCompatibility,
    ...(options.policyReceipt === undefined ? {} : {
      policyResolver: {
        resolve: async () => ({
          source: "overlay" as const,
          policy: { focusHints: ["发布证据"], ignoreHints: [], aggregationHints: [] },
          rendered: "SKILL_POLICY_WITH_GUARD",
          warnings: [],
          receipt: options.policyReceipt!,
        }),
      },
    }),
  });
  return { candidate, candidates, repository, service };
}

describe("SkillArtifactService", () => {
  test("a revoked head invalidates a pinned published version even while the target binding remains valid", async () => {
    const { service } = await fixture({ targetCompatibility: { allowsSkill: async () => true } });
    await service.proposeFromCandidate({ scope, ownerUserId: scope.userId, candidateId: "candidate-1",
      skillId: "skill-pinned", expectedLatestVersion: 0, manifest: [resource],
      expectedOutcomePolicyVersion: "v1", idempotencyKey: "pinned-propose" });
    const reviewed = await service.review({ scope, skillId: "skill-pinned", expectedLatestVersion: 1,
      reviewerUserId: scope.userId, decision: "approve", reason: "reviewed", idempotencyKey: "pinned-review" });
    await service.publish({ scope, skillId: "skill-pinned", expectedLatestVersion: 2,
      reviewerUserId: scope.userId, reviewReceiptId: reviewed.receipt.id, idempotencyKey: "pinned-publish" });
    expect(await service.read({ scope, skillId: "skill-pinned", version: 3 })).toMatchObject({ validity: "valid" });
    await service.revoke({ scope, skillId: "skill-pinned", expectedLatestVersion: 3, actorUserId: scope.userId,
      reason: "withdrawn procedure", idempotencyKey: "pinned-revoke" });
    expect(await service.read({ scope, skillId: "skill-pinned", version: 3 })).toMatchObject({
      validity: "stale", warnings: ["target_incompatible"], artifact: { status: "published", executionMode: "suggest_only" },
    });
    expect(await service.explain({ scope, skillId: "skill-pinned", version: 3 })).toMatchObject({ validity: "stale" });
  });

  test("host target incompatibility invalidates published read, explain and search on the next call", async () => {
    let compatible = true;
    const { service } = await fixture({ targetCompatibility: { allowsSkill: async () => compatible } });
    await service.proposeFromCandidate({ scope, ownerUserId: scope.userId, candidateId: "candidate-1",
      skillId: "skill-target", expectedLatestVersion: 0, manifest: [resource],
      expectedOutcomePolicyVersion: "v1", idempotencyKey: "target-propose" });
    const reviewed = await service.review({ scope, skillId: "skill-target", expectedLatestVersion: 1,
      reviewerUserId: scope.userId, decision: "approve", reason: "reviewed", idempotencyKey: "target-review" });
    await service.publish({ scope, skillId: "skill-target", expectedLatestVersion: 2,
      reviewerUserId: scope.userId, reviewReceiptId: reviewed.receipt.id, idempotencyKey: "target-publish" });
    expect(await service.read({ scope, skillId: "skill-target" })).toMatchObject({ validity: "valid" });
    compatible = false;
    expect(await service.read({ scope, skillId: "skill-target" })).toMatchObject({
      validity: "stale", warnings: ["target_incompatible"], artifact: { executionMode: "suggest_only" },
    });
    expect(await service.explain({ scope, skillId: "skill-target" })).toMatchObject({
      validity: "stale", warnings: ["target_incompatible"],
    });
    expect((await service.search({ scope, query: "Release" })).hits).toEqual([]);
  });

  test("curated import validates license/provenance and still stops at review-required draft", async () => {
    const { service, candidates } = await fixture();
    const input = {
      scope,
      ownerUserId: "user-1",
      skillId: "skill-curated",
      expectedLatestVersion: 0 as const,
      title: "Curated release",
      description: "A reviewed source procedure",
      applicability: "production release",
      triggerConditions: ["when releasing"],
      preconditions: ["CI green"],
      steps: ["review", "release"],
      successSignals: ["healthy"],
      antiPatterns: ["bypass"],
      riskBoundaries: ["no direct production edits"],
      evidenceMemoryIds: ["memory-v1"],
      evidenceChunkIds: ["evidence-1"],
      manifest: [resource],
      expectedOutcomePolicyVersion: "outcome-v1",
      provenanceRef: "curated-source-1",
      license: { spdxId: "Apache-2.0", sourceUrl: "https://example.test/skill" },
      idempotencyKey: "curated-import-1",
    };
    const imported = await service.importCurated(input);
    expect(imported).toMatchObject({
      artifact: { version: 1, status: "draft", executionMode: "suggest_only" },
      receipt: { operation: "propose" },
      replayed: false,
    });
    const source = await candidates.get(imported.artifact.sourceCandidateId!);
    expect(source?.metadata).toMatchObject({
      source: "curated_import",
      provenanceRef: "curated-source-1",
      license: { spdxId: "Apache-2.0" },
      reviewRequired: true,
    });
    await expect(service.importCurated(input)).resolves.toEqual({ ...imported, replayed: true });
    await expect(service.importCurated({
      ...input,
      skillId: "skill-no-provenance",
      idempotencyKey: "curated-import-invalid",
      manifest: [{ ...resource, provenanceRef: undefined }],
    })).rejects.toMatchObject({ code: "SKILL_INVALID" });
  });

  test("reviewed publish creates immutable suggest-only versions with CAS and receipts", async () => {
    const { service } = await fixture();
    const draft = await service.proposeFromCandidate({
      scope,
      ownerUserId: "user-1",
      candidateId: "candidate-1",
      skillId: "skill-release",
      expectedLatestVersion: 0,
      manifest: [resource],
      expectedOutcomePolicyVersion: "outcome-v1",
      idempotencyKey: "propose-1",
    });
    const reviewed = await service.review({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 1,
      reviewerUserId: "user-1",
      decision: "approve",
      reason: "evidence verified",
      idempotencyKey: "review-1",
    });
    const published = await service.publish({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 2,
      reviewerUserId: "user-1",
      reviewReceiptId: reviewed.receipt.id,
      idempotencyKey: "publish-1",
    });

    expect(draft.artifact).toMatchObject({ version: 1, status: "draft" });
    expect(reviewed.artifact).toMatchObject({ version: 2, status: "review" });
    expect(published.artifact).toMatchObject({
      version: 3,
      status: "published",
      executionMode: "suggest_only",
      isHead: true,
    });
    expect(await service.read({ scope, skillId: "skill-release" })).toMatchObject({
      artifact: { version: 3 }, validity: "valid",
    });
    await expect(service.publish({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 2,
      reviewerUserId: "user-1",
      reviewReceiptId: reviewed.receipt.id,
      idempotencyKey: "publish-stale",
    })).rejects.toMatchObject({ code: "SKILL_VERSION_STALE" });
  });

  test("path traversal and high-risk publication fail closed", async () => {
    const normal = await fixture();
    await expect(normal.service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-bad",
      expectedLatestVersion: 0,
      manifest: [{ ...resource, path: "../secret" }],
      expectedOutcomePolicyVersion: "outcome-v1", idempotencyKey: "bad-path",
    })).rejects.toMatchObject({ code: "SKILL_RESOURCE_INVALID" });

    const risky = await fixture({ highRisk: true });
    await risky.service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-risk",
      expectedLatestVersion: 0, manifest: [resource],
      expectedOutcomePolicyVersion: "outcome-v1", idempotencyKey: "risk-propose",
    });
    const review = await risky.service.review({
      scope, skillId: "skill-risk", expectedLatestVersion: 1,
      reviewerUserId: "user-1", decision: "approve", reason: "review only",
      idempotencyKey: "risk-review",
    });
    await expect(risky.service.publish({
      scope, skillId: "skill-risk", expectedLatestVersion: 2,
      reviewerUserId: "user-1", reviewReceiptId: review.receipt.id,
      idempotencyKey: "risk-publish",
    })).rejects.toMatchObject({ code: "SKILL_HIGH_RISK_BLOCKED" });
  });

  test("revoked evidence makes a published artifact stale at read time", async () => {
    const state = { readable: true };
    const candidates = new InMemorySkillCandidateRepository({ now: () => 100 });
    await candidates.create({
      id: "candidate-1", title: "Release safely", topicLabel: "release",
      triggerConditions: ["publish"], preconditions: ["green"], steps: ["approve"],
      successSignals: ["healthy"], antiPatterns: ["manual"], riskBoundaries: ["no bypass"],
      highRisk: false, evidenceMemoryIds: ["memory-v1"], evidenceChunkIds: ["evidence-1"],
      confidence: 1, status: "pending", scope,
    });
    const service = new SkillArtifactService({
      repository: new InMemorySkillArtifactRepository(), candidates,
      evidence: { validate: async () => ({ readable: state.readable }) }, now: () => 1_000,
    });
    await service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-release",
      expectedLatestVersion: 0, manifest: [resource], expectedOutcomePolicyVersion: "outcome-v1",
      idempotencyKey: "p",
    });
    const review = await service.review({
      scope, skillId: "skill-release", expectedLatestVersion: 1, reviewerUserId: "user-1",
      decision: "approve", reason: "ok", idempotencyKey: "r",
    });
    await service.publish({
      scope, skillId: "skill-release", expectedLatestVersion: 2, reviewerUserId: "user-1",
      reviewReceiptId: review.receipt.id, idempotencyKey: "x",
    });
    state.readable = false;
    await expect(service.read({ scope, skillId: "skill-release" })).resolves.toMatchObject({
      validity: "stale",
      warnings: ["evidence_unavailable"],
    });
  });

  test("appendVersion creates a new review draft, explain traces receipts, and revoke wins over head reads", async () => {
    const { service } = await fixture();
    await service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-release",
      expectedLatestVersion: 0, manifest: [resource], expectedOutcomePolicyVersion: "outcome-v1",
      idempotencyKey: "append-p",
    });
    const review = await service.review({
      scope, skillId: "skill-release", expectedLatestVersion: 1, reviewerUserId: "user-1",
      decision: "approve", reason: "ok", idempotencyKey: "append-r",
    });
    await service.publish({
      scope, skillId: "skill-release", expectedLatestVersion: 2, reviewerUserId: "user-1",
      reviewReceiptId: review.receipt.id, idempotencyKey: "append-x",
    });

    const appended = await service.appendVersion({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 3,
      ownerUserId: "user-1",
      updates: { description: "release through reviewed CI only" },
      idempotencyKey: "append-v4",
    });
    expect(appended.artifact).toMatchObject({
      version: 4,
      status: "draft",
      description: "release through reviewed CI only",
    });
    const unchanged = await service.appendVersion({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 4,
      ownerUserId: "user-1",
      updates: { description: "release through reviewed CI only" },
      idempotencyKey: "append-v4-unchanged",
    });
    expect(unchanged).toMatchObject({
      artifact: { version: 4, contentHash: appended.artifact.contentHash },
      receipt: { artifactVersion: 4, operation: "append", reason: "content_unchanged" },
      replayed: false,
    });
    await expect(service.appendVersion({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 4,
      ownerUserId: "user-1",
      updates: { description: "release through reviewed CI only" },
      idempotencyKey: "append-v4-unchanged",
    })).resolves.toEqual({ ...unchanged, replayed: true });
    await expect(service.read({ scope, skillId: "skill-release", version: 3 }))
      .resolves.toMatchObject({ artifact: { status: "published" } });
    const explanation = await service.explain({ scope, skillId: "skill-release" });
    expect(explanation.receipts.map((receipt) => receipt.operation)).toEqual([
      "propose", "review", "publish", "append", "append",
    ]);

    const revoked = await service.revoke({
      scope,
      skillId: "skill-release",
      expectedLatestVersion: 4,
      actorUserId: "user-1",
      reason: "superseded procedure",
      idempotencyKey: "revoke-v5",
    });
    expect(revoked.artifact).toMatchObject({ version: 5, status: "revoked" });
    await expect(service.read({ scope, skillId: "skill-release" }))
      .rejects.toMatchObject({ code: "SKILL_ARTIFACT_NOT_FOUND" });
  });

  test("search reports actual BM25 fallback and never claims hybrid without an embedding retriever", async () => {
    const { service } = await fixture();
    await service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-release",
      expectedLatestVersion: 0, manifest: [resource], expectedOutcomePolicyVersion: "outcome-v1",
      idempotencyKey: "search-p",
    });
    const review = await service.review({
      scope, skillId: "skill-release", expectedLatestVersion: 1, reviewerUserId: "user-1",
      decision: "approve", reason: "ok", idempotencyKey: "search-r",
    });
    await service.publish({
      scope, skillId: "skill-release", expectedLatestVersion: 2, reviewerUserId: "user-1",
      reviewReceiptId: review.receipt.id, idempotencyKey: "search-x",
    });

    const result = await service.search({
      scope,
      query: "release safely",
      embeddingAvailable: true,
    });
    expect(result.mode).toBe("bm25");
    expect(result.warnings).toContain("embedding_unavailable_bm25_fallback");
    expect(result.hits[0]?.artifact.skillId).toBe("skill-release");
  });

  test("skill mutation receipts persist the resolved overlay identity", async () => {
    const policyReceipt = {
      scopeFingerprint: "a".repeat(64),
      layer: "skill_review" as const,
      overlayId: "skill-policy",
      overlayVersion: 3,
      contentHash: "b".repeat(64),
      guardVersion: "memory-policy-guard-v1" as const,
      resolutionHash: "c".repeat(64),
    };
    const { service } = await fixture({ policyReceipt });
    const proposed = await service.proposeFromCandidate({
      scope, ownerUserId: "user-1", candidateId: "candidate-1", skillId: "skill-policy-test",
      expectedLatestVersion: 0, manifest: [resource], expectedOutcomePolicyVersion: "outcome-v1",
      idempotencyKey: "policy-propose",
    });
    const reviewed = await service.review({
      scope, skillId: "skill-policy-test", expectedLatestVersion: 1,
      reviewerUserId: "user-1", decision: "approve", reason: "evidence verified",
      idempotencyKey: "policy-review",
    });

    expect(proposed.receipt.policyResolution).toEqual(policyReceipt);
    expect(reviewed.receipt.policyResolution).toEqual(policyReceipt);
  });
});
