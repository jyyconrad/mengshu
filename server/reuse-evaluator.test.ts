import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authorityScopeFingerprint } from "../packages/core/src/domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../packages/core/src/domain/types.js";
import { OpenAiLlmClient, type ChatCompletionClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { InMemorySkillCandidateRepository } from "../packages/core/src/lifecycle/skill-candidate-repository.js";
import { InMemorySkillArtifactRepository } from "../packages/core/src/skills/in-memory-repository.js";
import { SkillArtifactService } from "../packages/core/src/skills/skill-artifact-service.js";
import { SkillPairedValidationService, skillAtomicDiffFingerprint, type SkillPairedEvaluationPlan } from
  "../packages/core/src/evolution/reuse/skill-paired-validator.js";
import { HostReuseCompatibilityReader, fingerprintTargetProfile, skillCompatibilitySubject } from "../packages/core/src/evolution/reuse/target-compatibility.js";
import { scope, authority } from "../packages/core/src/evolution/test-fixtures.js";
import { createPostgresEvolutionHostState, type EvolutionHostStatePort } from "./evolution-host-state.js";
import type { PostgresEvolutionPool } from "../packages/core/src/evolution/postgres-common.js";
import { skillCandidateContentHash } from "../packages/core/src/evolution/maintenance/patterns.js";
import type { ExperiencePattern } from "../packages/core/src/evolution/maintenance/experience-types.js";
import { createHostReuseRuntime, readHostCompatibilityBinding } from "./reuse-runtime.js";
import { createHostSkillPairedEvaluator, createLlmReuseEvaluationModel, syntheticHoldoutHash, syntheticSplitManifestHash,
  createHostSkillPairedValidator, createHostSkillDraftGate, type HostSkillPairedEvaluatorOptions, type SyntheticReuseHoldout } from "./reuse-evaluator.js";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const now = Date.parse("2026-09-06T00:00:00Z");
const target = { model: { provider: "offline-test", modelId: "deterministic-fixture", revision: "1" }, tools: [],
  environmentFingerprint: "e".repeat(64), applicability: ["synthetic:fact-selection-v1"] };

function sqlStateFixture(hostAuthority = authority) {
  const records = new Map<string, Record<string, unknown>>();
  const receipts = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    const domain = [...records.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const proofs = [...receipts.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const key = JSON.stringify(p.slice(0, 4));
    if (sql.includes("evolution:host-state-read")) {
      const keys = JSON.parse(String(p[2])) as { kind: string; entry_id: string }[];
      return { rows: structuredClone(domain.filter(row => keys.some(k => k.kind === row.kind && k.entry_id === row.entry_id))) };
    }
    if (sql.includes("evolution:host-state-list")) return { rows: structuredClone(domain.filter(row => row.kind === p[2])) };
    if (sql.includes("evolution:host-state-lock")) return { rows: structuredClone(domain.filter(row => row.kind === p[2] && row.entry_id === p[3])) };
    if (sql.includes("evolution:host-state-quota")) return { rows: [{ entries: domain.filter(row => row.kind === p[2]).length, receipts: proofs.length }] };
    if (sql.includes("evolution:host-receipt-key")) return { rows: structuredClone(proofs.filter(row => row.kind === p[2] && row.idempotency_key === p[3])) };
    if (sql.includes("evolution:host-receipt-read")) return { rows: structuredClone(proofs.filter(row => row.receipt_id === p[2])) };
    if (sql.includes("evolution:host-state-save")) {
      records.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], entry_id: p[3], revision: p[4],
        value: JSON.parse(String(p[5])), value_hash: p[6], updated_at: p[7], expires_at: p[8], revoked_at: p[9] });
      return { rows: [{ revision: p[4] }] };
    }
    if (sql.includes("evolution:host-receipt-save")) receipts.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2],
      idempotency_key: p[3], request_hash: p[4], receipt_id: p[5], receipt: JSON.parse(String(p[6])), created_at: p[7] });
    return { rows: [] };
  });
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as PostgresEvolutionPool;
  const options = { pool, scope, authority: hostAuthority, now: () => now, authorizeOwner: () => ({ tenantId: scope.tenantId,
    userId: scope.userId, actorId: "fixture-owner", authentication: "authenticated_owner" as const }) };
  const forScope = (bound: MemoryScope) => createPostgresEvolutionHostState({ ...options, scope: bound });
  return { state: forScope(scope), restart: () => forScope(scope), forScope, query, records };
}

async function fixture(published = false, hostAuthority = authority) {
  const dir = await mkdtemp(join(tmpdir(), "mengshu-host-reuse-")); dirs.push(dir);
  const candidates = new InMemorySkillCandidateRepository();
  await candidates.create({ id: "candidate", title: "Select verified facts", topicLabel: "facts", scope,
    applicability: "synthetic:fact-selection-v1", triggerConditions: ["synthetic task"], preconditions: ["read only"],
    steps: ["Return no selected facts."], successSignals: ["exact selection"], antiPatterns: [], riskBoundaries: ["no writes"],
    evidenceMemoryIds: ["m"], evidenceChunkIds: ["e"], highRisk: false, status: "pending", confidence: 0.9 });
  const stored = new InMemorySkillArtifactRepository();
  const service = new SkillArtifactService({ repository: stored, candidates, now: () => now,
    evidence: { validate: async () => ({ readable: true }) } });
  await service.proposeFromCandidate({ scope, ownerUserId: scope.userId, candidateId: "candidate", skillId: "skill",
    expectedLatestVersion: 0, manifest: [], expectedOutcomePolicyVersion: "v1", idempotencyKey: "propose" });
  const oldReview = await service.review({ scope, skillId: "skill", expectedLatestVersion: 1, reviewerUserId: scope.userId,
    decision: "approve", reason: "reviewed old", idempotencyKey: "review-old" });
  const old = published ? (await service.publish({ scope, skillId: "skill", expectedLatestVersion: oldReview.artifact.version,
    reviewerUserId: scope.userId, reviewReceiptId: oldReview.receipt.id, idempotencyKey: "publish-old" })).artifact : oldReview.artifact;
  await service.appendVersion({ scope, skillId: "skill", expectedLatestVersion: old.version, ownerUserId: scope.userId,
    updates: { steps: ["Select the allowed fact requested in the query."] }, idempotencyKey: "append" });
  const newReview = await service.review({ scope, skillId: "skill", expectedLatestVersion: old.version + 1, reviewerUserId: scope.userId,
    decision: "approve", reason: "reviewed new", idempotencyKey: "review-new" });
  const next = published ? (await service.publish({ scope, skillId: "skill", expectedLatestVersion: newReview.artifact.version,
    reviewerUserId: scope.userId, reviewReceiptId: newReview.receipt.id, idempotencyKey: "publish-new" })).artifact : newReview.artifact;
  await writeFile(join(dir, "old.json"), JSON.stringify(old));
  await writeFile(join(dir, "new.json"), JSON.stringify(next));
  const fingerprint = authorityScopeFingerprint(scope);
  for (let version = 1; version <= next.version; version++) await writeFile(join(dir, `v-${version}.json`),
    JSON.stringify(await stored.getVersion(fingerprint, "skill", version)));
  await writeFile(join(dir, "receipts.json"), JSON.stringify(await stored.listReceipts(fingerprint, "skill")));
  const repository = {
    getVersion: vi.fn(async (fp: string, id: string, version: number) => fp === fingerprint && id === "skill"
      ? JSON.parse(await readFile(join(dir, version === old.version ? "old.json" : version === next.version ? "new.json" : `v-${version}.json`), "utf8")) : undefined),
    getLatest: async () => JSON.parse(await readFile(join(dir, "new.json"), "utf8")),
    listReceipts: async () => JSON.parse(await readFile(join(dir, "receipts.json"), "utf8")),
  };
  const holdout: SyntheticReuseHoldout = { schema: "synthetic:fact-selection-v1", trainingCaseIds: ["training"],
    applicability: target.applicability,
    cases: Array.from({ length: 200 }, (_, i) => ({ id: `case-${i}`, independenceGroupId: `group-${i}`,
      subclass: "authority", query: `Select fact answer-${i}.`,
      facts: [{ id: `answer-${i}`, value: `value-${i}`, authorized: true }, { id: `denied-${i}`, value: "restricted", authorized: false }],
      expectedFactIds: [`answer-${i}`] })),
  };
  const sql = sqlStateFixture(hostAuthority);
  const state = sql.state;
  const claimHoldout = vi.spyOn(state, "claimHoldout");
  const complete = vi.fn(async (input: { messages: readonly { role: string; content: string }[] }) => {
    const task = JSON.parse(input.messages[1]!.content);
    const selected = task.suggestion.steps[0].startsWith("Return no") ? []
      : task.task.facts.filter((fact: { authorized: boolean }) => fact.authorized).map(({ id, value }: { id: string; value: string }) => ({ id, value }));
    return { text: JSON.stringify({ selected }), targetFingerprint: fingerprintTargetProfile(target), tokens: 10 };
  });
  const evaluatorOptions: HostSkillPairedEvaluatorOptions = { state, repository, readTarget: async () => target,
    holdoutTasks: { read: async () => holdout }, model: { complete }, now: () => now };
  const evaluator = createHostSkillPairedEvaluator(evaluatorOptions)!;
  const plan: SkillPairedEvaluationPlan = { id: "plan", proposerId: "owner-proposer", frozenAt: "2026-09-05T00:00:00.000Z",
    expiresAt: "2026-09-07T00:00:00.000Z", sourceScope: scope, targetScope: scope,
    oldSubject: skillCompatibilitySubject(old), newSubject: skillCompatibilitySubject(next), atomicField: "steps",
    diffFingerprint: skillAtomicDiffFingerprint(old, next, "steps"), target, holdoutRef: "holdout",
    holdoutHash: syntheticHoldoutHash(holdout), splitManifestHash: syntheticSplitManifestHash(holdout),
    objective: { kind: "quality", minimumGain: 0.05 }, confidenceAlpha: 0.05, maximumQualityRegression: 0.1,
    criticalSubclasses: ["authority"], minimumPairs: 200, minimumSubclassPairs: 200,
    budget: { maximumPairs: 200, maximumToolCallsPerCase: 0, maximumCostPerArm: 10_000,
      maximumArmDurationMs: 3000, costUnit: "tokens" }, rejectedRetentionMs: 1000 };
  const candidate = { ...(await candidates.get("candidate"))!, steps: [...next.steps] };
  return { dir, old, next, repository, evaluator, evaluatorOptions, plan, claimHoldout, complete, state, holdout, sql, candidate };
}

async function crossAppFixture() {
  const targetScope = { ...scope, appId: "openclaw", agentId: "openclaw" };
  const hostAuthority = { ...authority, allow: { ...authority.allow,
    appIds: [scope.appId, targetScope.appId], agentIds: [scope.agentId, targetScope.agentId] } };
  const h = await fixture(true, hostAuthority);
  const targetState = h.sql.forScope(targetScope);
  const configured = Object.freeze({ provider: "openai" as const, apiKey: "synthetic-offline-key",
    baseURL: "https://models.invalid/v1", model: "unused-default-snapshot", reasoningModel: "fixture-snapshot-7" });
  const executionProfile = Object.freeze({ ...target, model: { provider: configured.provider,
    modelId: configured.reasoningModel, revision: configured.reasoningModel }, tools: [] });
  const readTarget = async () => executionProfile;
  const completion = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async input => {
    const output = await h.complete({ messages: input.messages });
    return { choices: [{ message: { content: output.text } }] };
  });
  const client = new OpenAiLlmClient(configured, { client: { chat: { completions: { create: completion } } }, maxRetries: 0 });
  const model = createLlmReuseEvaluationModel({ client, readTarget, modelType: "reasoning" });
  const evaluatorOptions = { ...h.evaluatorOptions, model, readTarget };
  const evaluator = createHostSkillPairedEvaluator(evaluatorOptions)!;
  await targetState.put({ kind: "reuse_grants", id: "grants", expectedRevision: 0, idempotencyKey: "cross-app-grant",
    value: JSON.parse(JSON.stringify({ grants: [{ id: "cross-app-knowledge", sourceScope: scope, targetScope,
      claimKinds: ["knowledge"], notBefore: h.plan.frozenAt, expiresAt: h.plan.expiresAt }] })) });
  const runtime = createHostReuseRuntime({ authority: hostAuthority, boundScope: targetScope, state: targetState,
    candidateSource: () => ({ search: async () => [] }), hydrator: () => ({ hydrate: async () => undefined }),
    readTarget, now: () => now });
  const validator = createHostSkillPairedValidator({ state: targetState, evaluator,
    repository: h.repository, readTarget, reuseAuthorizer: runtime.authorizer, now: () => now });
  const revoke = () => targetState.put({ kind: "reuse_grants", id: "grants", expectedRevision: 1,
    idempotencyKey: "cross-app-revoke", value: { grants: [] } });
  return { ...h, evaluator, evaluatorOptions, targetScope, targetState, runtime, validator, revoke, completion, executionProfile,
    plan: { ...h.plan, targetScope, target: executionProfile, budget: { ...h.plan.budget, costUnit: "milliseconds" as const } } };
}

describe("real host paired evaluator adapter (offline synthetic model)", () => {
  test("source-state evaluator and target-state validator accept a real cross-app pair without weakening either scope", async () => {
    const h = await crossAppFixture();
    await h.targetState.put({ kind: "target_profile", id: "profile", expectedRevision: 0, idempotencyKey: "owner-profile-claim",
      value: { ...h.executionProfile, model: { provider: "owner-json", modelId: "pretend-model", revision: "pretend-revision" } } });
    const wronglyShared = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, state: h.targetState });
    expect(await createHostSkillPairedValidator({ state: h.targetState, evaluator: wronglyShared,
      repository: h.repository, readTarget: h.evaluatorOptions.readTarget, reuseAuthorizer: h.runtime.authorizer,
      now: () => now }).validate(h.plan)).toMatchObject({ status: "blocked" });
    expect(h.complete).not.toHaveBeenCalled();

    expect(await h.validator.validate(h.plan)).toMatchObject({ status: "accepted_for_review",
      publishAllowed: false, executionAllowed: false });
    expect(h.complete).toHaveBeenCalledTimes(400);
    expect(h.completion.mock.calls.every(([input]) => input.model === "fixture-snapshot-7")).toBe(true);
    expect(h.claimHoldout).toHaveBeenCalledWith(expect.objectContaining({ sourceScope: scope }));
    expect((await h.state.list("paired_evaluation")).entries).toHaveLength(0);
    expect((await h.targetState.list("paired_evaluation")).entries).toHaveLength(1);
    expect((await h.targetState.list("compatibility_binding")).entries).toHaveLength(1);
    expect((await h.targetState.list("compatibility_binding")).entries[0]!.value).toMatchObject({
      binding: { targetFingerprint: fingerprintTargetProfile(h.executionProfile) },
    });
    expect(await h.runtime.compatibility.allowsSkill(h.next, h.targetScope)).toBe(true);
    const permit = await h.runtime.authorizer.authorize(scope, h.targetScope, "knowledge");
    expect(permit).toBeDefined();

    const restartedSource = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, state: h.sql.restart() });
    expect(await createHostSkillPairedValidator({ state: h.sql.forScope(h.targetScope), evaluator: restartedSource,
      repository: h.repository, readTarget: h.evaluatorOptions.readTarget, reuseAuthorizer: h.runtime.authorizer,
      now: () => now }).validate({ ...h.plan, id: "another-cross-app-plan", holdoutRef: "renamed-cohort" }))
      .toMatchObject({ status: "blocked", reason: "holdout_already_used" });
    expect(await h.sql.forScope(h.targetScope).claimHoldout({ sourceScope: h.targetScope, planHash: "f".repeat(64),
      holdoutHash: h.plan.holdoutHash, holdoutRef: "another-app-cohort" })).toBe(false);
    expect([...h.sql.records.values()].filter(row => row.kind === "paired_holdout")).toHaveLength(1);

    await h.revoke();
    expect(await h.runtime.authorizer.revalidate(permit!, "knowledge")).toBe(false);
    expect(await h.validator.validate({ ...h.plan, id: "after-revoke" }))
      .toMatchObject({ status: "blocked", reason: "reuse_grant_required" });
    expect(h.complete).toHaveBeenCalledTimes(400);
  });
  test.each(["during-model", "during-binding-cas"] as const)("cross-app grant revoked %s cannot return accepted", async stage => {
    const h = await crossAppFixture();
    let revoked = false;
    if (stage === "during-model") {
      const complete = h.complete.getMockImplementation()!;
      h.complete.mockImplementation(async input => {
        if (!revoked) { revoked = true; await h.revoke(); }
        return complete(input);
      });
    } else {
      const put = h.targetState.put.bind(h.targetState);
      vi.spyOn(h.targetState, "put").mockImplementation(async input => {
        const receipt = await put(input);
        if (input.kind === "compatibility_binding" && !revoked) { revoked = true; await h.revoke(); }
        return receipt;
      });
    }
    expect(await h.validator.validate(h.plan)).toMatchObject({ status: "blocked", publishAllowed: false,
      executionAllowed: false, reason: stage === "during-model" ? "reuse_grant_revoked" : "reuse_validation_not_current" });
    expect(await h.runtime.authorizer.authorize(scope, h.targetScope, "knowledge")).toBeUndefined();
    if (stage === "during-model") expect((await h.targetState.list("paired_evaluation")).entries).toEqual([]);
  });
  test("target change during the report CAS cannot return an accepted current binding", async () => {
    const h = await fixture();
    let profile = structuredClone(target);
    const put = h.state.put.bind(h.state);
    vi.spyOn(h.state, "put").mockImplementation(async input => {
      const receipt = await put(input);
      if (input.kind === "compatibility_binding") profile = { ...profile, model: { ...profile.model, revision: "2" } };
      return receipt;
    });
    const validator = createHostSkillPairedValidator({ state: h.state, evaluator: h.evaluator,
      repository: h.repository, readTarget: async () => profile, now: () => now });
    expect(await validator.validate(h.plan)).toMatchObject({ status: "blocked", reason: "reuse_validation_not_current" });
  });
  test.each(["facts", "authority", "fake-result"] as const)("real output scorer rejects %s violations on either arm", async fault => {
    const h = await fixture();
    h.complete.mockImplementation(async input => {
      const { task } = JSON.parse(input.messages[1]!.content);
      const text = fault === "fake-result" ? JSON.stringify({ success: true, quality: 1, hardGates: { facts: true, authority: true } })
        : JSON.stringify({ selected: [{ id: task.facts[fault === "authority" ? 1 : 0].id,
          value: fault === "facts" ? "invented" : task.facts[1].value }] });
      return { text, targetFingerprint: fingerprintTargetProfile(target), tokens: 10 };
    });
    const result = await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan);
    expect(result).toMatchObject({ status: "rejected", publishAllowed: false, executionAllowed: false,
      retained: { reasons: expect.arrayContaining(["hard_gate_failed"]) } });
    expect((await h.state.list("paired_evaluation")).entries).toEqual([]);
  });
  test.each(["missing-review", "wrong-owner-review", "revoked-head", "wrong-owner-artifact"] as const)("%s blocks persisted load before model IO", async fault => {
    const h = await fixture();
    if (fault === "missing-review") await writeFile(join(h.dir, "receipts.json"), "[]");
    if (fault === "wrong-owner-review") {
      const receipts = JSON.parse(await readFile(join(h.dir, "receipts.json"), "utf8"));
      await writeFile(join(h.dir, "receipts.json"), JSON.stringify(receipts.map((receipt: object) => ({ ...receipt, reviewerUserId: "other-owner" }))));
    }
    if (fault === "revoked-head" || fault === "wrong-owner-artifact") await writeFile(join(h.dir, "new.json"), JSON.stringify({ ...h.next,
      ...(fault === "revoked-head" ? { status: "revoked" } : { ownerUserId: "other-owner" }) }));
    expect(await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan)).toMatchObject({ status: "blocked" });
    expect(h.complete).not.toHaveBeenCalled();
  });
  test.each(["hash", "overlap", "duplicate-group", "wrong-split"] as const)("%s holdout cannot become a behavior receipt", async fault => {
    const h = await fixture();
    const holdout = structuredClone(h.holdout);
    if (fault === "overlap") (holdout.trainingCaseIds as string[]).push(holdout.cases[0]!.id);
    if (fault === "duplicate-group") (holdout.cases as unknown as { independenceGroupId: string }[])[1]!.independenceGroupId = holdout.cases[0]!.independenceGroupId;
    const evaluator = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, holdoutTasks: { read: async () => holdout } });
    const plan = { ...h.plan, ...(fault === "hash" ? { holdoutHash: "a".repeat(64) } : {}),
      ...(fault === "wrong-split" ? { splitManifestHash: "b".repeat(64) } : {}) };
    expect(await new SkillPairedValidationService({ evaluator }, () => now).validate(plan)).toMatchObject({ status: "blocked" });
    expect(h.complete).not.toHaveBeenCalled();
  });
  test("restart, aliases and case order do not make a claimed cohort fresh", async () => {
    const h = await fixture();
    expect(await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan)).toMatchObject({ status: "accepted_for_review" });
    const reordered = { ...h.holdout, cases: [...h.holdout.cases].reverse(), trainingCaseIds: ["unrelated-training-id"] };
    expect(syntheticHoldoutHash(reordered)).toBe(syntheticHoldoutHash(h.holdout));
    const evaluator = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, state: h.sql.restart() });
    expect(await new SkillPairedValidationService({ evaluator }, () => now).validate({ ...h.plan, id: "another-plan", holdoutRef: "renamed" }))
      .toMatchObject({ status: "blocked", reason: "holdout_already_used" });
  });
  test("actual target drift during a completion and missing token measurement cannot pass", async () => {
    for (const fault of ["target-drift", "missing-tokens"] as const) {
      const h = await fixture();
      let profile = structuredClone(target);
      const evaluator = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, readTarget: async () => profile,
        model: { complete: async () => {
          if (fault === "target-drift") profile = { ...profile, model: { ...profile.model, revision: "2" } };
          return { text: '{"selected":[]}', targetFingerprint: fingerprintTargetProfile(target) };
        } } });
      expect(await new SkillPairedValidationService({ evaluator }, () => now).validate(h.plan)).toMatchObject({ status: "blocked" });
    }
  });
  test("cancellation and real arm deadlines abort the stateless model without writing success state", async () => {
    const h = await fixture();
    let modelSignal: AbortSignal | undefined;
    const evaluator = createHostSkillPairedEvaluator({ ...h.evaluatorOptions, model: { complete: async input => {
      modelSignal = input.signal;
      return new Promise<never>(() => {});
    } } });
    const result = await new SkillPairedValidationService({ evaluator }, () => now).validate({ ...h.plan,
      budget: { ...h.plan.budget, maximumArmDurationMs: 20 } });
    expect(result).toMatchObject({ status: "blocked", publishAllowed: false, executionAllowed: false });
    expect(modelSignal?.aborted).toBe(true);
    expect((await h.state.list("paired_evaluation")).entries).toEqual([]);
    const aborted = new AbortController(); aborted.abort();
    expect(await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan, aborted.signal))
      .toMatchObject({ status: "blocked", reason: "evaluation_cancelled" });
  });
  test("persists actual paired evaluation plus compatibility in the shared CAS store and survives host restart", async () => {
    const h = await fixture(true);
    const service = createHostSkillPairedValidator({ state: h.state, evaluator: h.evaluator,
      repository: h.repository, readTarget: async () => target, now: () => now });
    const result = await service.validate(h.plan);
    expect(result).toMatchObject({ status: "accepted_for_review", publishAllowed: false, executionAllowed: false });
    const restarted = h.sql.restart();
    let profile = structuredClone(target);
    const reader = new HostReuseCompatibilityReader({ readTarget: async () => profile,
      readBinding: (subject, targetScope) => readHostCompatibilityBinding(restarted, subject, targetScope, now) }, () => now);
    expect(await reader.allowsSkill(h.next, scope)).toBe(true);
    for (const changed of [
      { ...target, model: { ...target.model, revision: "2" } },
      { ...target, environmentFingerprint: "f".repeat(64) },
      { ...target, tools: [{ name: "new-tool", version: "1", schemaHash: "d".repeat(64) }] },
      { ...target, applicability: ["other-condition"] },
    ]) { profile = changed as typeof profile; expect(await reader.allowsSkill(h.next, scope)).toBe(false); }
    profile = structuredClone(target);
    const entry = (await restarted.list("paired_evaluation")).entries[0]!;
    await restarted.put({ kind: "paired_evaluation", id: entry.id, expectedRevision: entry.revision,
      idempotencyKey: "revoke-evaluation", value: entry.value, operation: "revoke" });
    expect(await reader.allowsSkill(h.next, scope)).toBe(false);
    expect(JSON.stringify([...h.sql.records.values()])).not.toContain("expectedFactIds");
    expect(JSON.stringify([...h.sql.records.values()])).not.toContain("Return no selected facts");
  });
  test("draft gate requires an actually evaluated exact candidate, not success text or supplied result booleans", async () => {
    const h = await fixture();
    const gate = createHostSkillDraftGate({ state: h.state, readTarget: async () => target, now: () => now });
    const pattern = { id: "pattern", scope, experiences: [] } as unknown as ExperiencePattern;
    const candidateHash = skillCandidateContentHash(h.candidate);
    const request = { scope, pattern, candidate: h.candidate, candidateHash };
    expect(await gate.evaluate(request)).toMatchObject({ status: "blocked" });
    const service = createHostSkillPairedValidator({ state: h.state, evaluator: h.evaluator,
      repository: h.repository, readTarget: async () => target, now: () => now });
    expect(await service.validate({ ...h.plan, draftBinding: { patternId: pattern.id, candidate: h.candidate } }))
      .toMatchObject({ status: "accepted_for_review", publishAllowed: false, executionAllowed: false });
    expect(await gate.evaluate(request)).toMatchObject({ status: "passed", candidateHash });
    expect(await gate.evaluate({ ...request, candidate: { ...h.candidate, steps: ["success"] } }))
      .toMatchObject({ status: "blocked" });
    expect((await h.repository.getLatest()).status).toBe("review");
    const fake = { ...h.evaluator, run: async () => ({ success: true }) };
    const untrusted = createHostSkillPairedValidator({ state: h.state, evaluator: fake as never,
      repository: h.repository, readTarget: async () => target, now: () => now });
    expect(await untrusted.validate(h.plan)).toMatchObject({ status: "blocked", reason: "host_evaluator_required" });
  });
  test("reloads persisted reviewed artifacts and scores raw model answers without exposing holdout answers", async () => {
    const h = await fixture();
    const result = await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan);
    expect(result).toMatchObject({ status: "accepted_for_review", publishAllowed: false, executionAllowed: false });
    expect(h.repository.getVersion).toHaveBeenCalled();
    expect(h.complete).toHaveBeenCalledTimes(400);
    expect(JSON.stringify(h.complete.mock.calls)).not.toContain("expectedFactIds");
    expect(await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan))
      .toMatchObject({ status: "blocked", reason: "holdout_already_used" });
  });
  test("tampered persisted text with an unchanged contentHash cannot reach the model", async () => {
    const h = await fixture();
    await writeFile(join(h.dir, "new.json"), JSON.stringify({ ...h.next, steps: ["unreviewed tamper"] }));
    expect(await new SkillPairedValidationService({ evaluator: h.evaluator }, () => now).validate(h.plan))
      .toMatchObject({ status: "blocked" });
    expect(h.complete).not.toHaveBeenCalled();
  });
  test("no model or no synthetic tasks remains unavailable, never a fabricated acceptance", async () => {
    const h = await fixture();
    expect(createHostSkillPairedEvaluator({ state: h.state, repository: h.repository, readTarget: async () => target })).toBeUndefined();
    const complete = vi.fn(async () => "{}");
    const model = createLlmReuseEvaluationModel({ client: { available: true, complete }, readTarget: async () => target, modelType: "reasoning" });
    const response = await model.complete({ scope, messages: [{ role: "user", content: "synthetic" }],
      maxTokens: 100, timeoutMs: 1000, signal: new AbortController().signal });
    expect(response.targetFingerprint).toBe(fingerprintTargetProfile(target));
    expect(complete).toHaveBeenCalledWith([{ role: "user", content: "synthetic" }], expect.objectContaining({ modelType: "reasoning", maxTokens: 100 }));
  });
});
