import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { authority, scope } from "../packages/core/src/evolution/test-fixtures.js";
import { withAuthenticatedEvolutionOwner } from "../packages/api/src/evolution-owner-auth.js";
import { NullLlmClient, OpenAiLlmClient, type ChatCompletionClient } from "../packages/core/src/runtime/llm/llm-client.js";
import { PostgresProvider } from "../packages/core/src/db/providers/postgres.js";
import { InMemorySkillCandidateRepository } from "../packages/core/src/lifecycle/skill-candidate-repository.js";
import { InMemorySkillArtifactRepository } from "../packages/core/src/skills/in-memory-repository.js";
import { SkillArtifactService } from "../packages/core/src/skills/skill-artifact-service.js";
import { skillAtomicDiffFingerprint } from "../packages/core/src/evolution/reuse/skill-paired-validator.js";
import { skillCompatibilitySubject } from "../packages/core/src/evolution/reuse/target-compatibility.js";
import { memoryConfigSchema } from "../config.js";
import { loadGlobalEvolutionConfig } from "./evolution-config.js";
import { createEvolutionReuseRuntime, readPinnedEvolutionJson } from "./evolution-reuse.js";
import { createEvolutionHostControl, type EvolutionHostControl } from "./evolution-control.js";
import { createHostReuseRuntimeRouter } from "./reuse-runtime.js";
import { syntheticHoldoutHash, syntheticSplitManifestHash, type SyntheticReuseHoldout, type HostSkillPairedEvaluationPlan } from "./reuse-evaluator.js";

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await rm(dir, { force: true, recursive: true }); });
const owner = <T>(work: () => Promise<T>) => withAuthenticatedEvolutionOwner({ owner: authority,
  secret: "owner-only-test-secret-not-production", headers: { "x-mengshu-owner-token": "owner-only-test-secret-not-production" } }, work);

// Only the SQL boundary is doubled; all host state, evaluator and validator code is production code.
function stateProvider() {
  const records = new Map<string, Record<string, unknown>>(), receipts = new Map<string, Record<string, unknown>>();
  const query = vi.fn(async (sql: string, p: readonly unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> => {
    const rows = [...records.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const prior = [...receipts.values()].filter(row => row.owner_key === p[0] && row.scope_fingerprint === p[1]);
    const key = JSON.stringify(p.slice(0, 4));
    if (sql.includes("evolution:host-state-read")) {
      const keys = JSON.parse(String(p[2])) as { kind: string; entry_id: string }[];
      return { rows: structuredClone(rows.filter(row => keys.some(k => k.kind === row.kind && k.entry_id === row.entry_id))) };
    }
    if (sql.includes("evolution:host-state-list")) return { rows: structuredClone(rows.filter(row => row.kind === p[2])) };
    if (sql.includes("evolution:host-state-lock")) return { rows: structuredClone(rows.filter(row => row.kind === p[2] && row.entry_id === p[3])) };
    if (sql.includes("evolution:host-state-quota")) return { rows: [{ entries: rows.filter(row => row.kind === p[2]).length, receipts: prior.length }] };
    if (sql.includes("evolution:host-receipt-key")) return { rows: structuredClone(prior.filter(row => row.kind === p[2] && row.idempotency_key === p[3])) };
    if (sql.includes("evolution:host-receipt-read")) return { rows: structuredClone(prior.filter(row => row.receipt_id === p[2])) };
    if (sql.includes("evolution:host-state-save")) {
      records.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2], entry_id: p[3], revision: p[4],
        value: JSON.parse(String(p[5])), value_hash: p[6], updated_at: p[7], expires_at: p[8], revoked_at: p[9] });
      return { rows: [{ revision: p[4] }] };
    }
    if (sql.includes("evolution:host-receipt-save")) receipts.set(key, { owner_key: p[0], scope_fingerprint: p[1], kind: p[2],
      idempotency_key: p[3], request_hash: p[4], receipt_id: p[5], receipt: JSON.parse(String(p[6])), created_at: p[7] });
    return { rows: [] };
  });
  const provider = new PostgresProvider({ host: "unused", database: "unused", user: "unused", password: "unused", port: 5432 }, "text-embedding-3-small");
  Object.assign(provider, { pool: { query, connect: async () => ({ query, release() {} }) }, schemaVersion: 37, schemaContractState: "ready" });
  vi.spyOn(provider, "initialize").mockResolvedValue();
  return { provider, query, records };
}

describe("default host reuse control composition", () => {
  test("registered native evaluation scores raw model output, persists real proof and observes target revocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolution-native-evaluator-")); dirs.push(dir);
    const candidates = new InMemorySkillCandidateRepository(), repository = new InMemorySkillArtifactRepository();
    await candidates.create({ id: "candidate", title: "Select verified facts", topicLabel: "facts", scope,
      applicability: "synthetic:fact-selection-v1", triggerConditions: ["synthetic task"], preconditions: ["read only"],
      steps: ["Return no selected facts."], successSignals: ["exact selection"], antiPatterns: [], riskBoundaries: ["no writes"],
      evidenceMemoryIds: ["m"], evidenceChunkIds: ["e"], highRisk: false, status: "pending", confidence: 0.9 });
    const service = new SkillArtifactService({ repository, candidates, evidence: { validate: async () => ({ readable: true }) } });
    await service.proposeFromCandidate({ scope, ownerUserId: scope.userId, candidateId: "candidate", skillId: "skill",
      expectedLatestVersion: 0, manifest: [], expectedOutcomePolicyVersion: "v1", idempotencyKey: "propose" });
    const old = (await service.review({ scope, skillId: "skill", expectedLatestVersion: 1, reviewerUserId: scope.userId,
      decision: "approve", reason: "reviewed old", idempotencyKey: "review-old" })).artifact;
    await service.appendVersion({ scope, skillId: "skill", expectedLatestVersion: old.version, ownerUserId: scope.userId,
      updates: { steps: ["Select the allowed fact requested in the query."] }, idempotencyKey: "append" });
    const next = (await service.review({ scope, skillId: "skill", expectedLatestVersion: old.version + 1, reviewerUserId: scope.userId,
      decision: "approve", reason: "reviewed next", idempotencyKey: "review-next" })).artifact;
    const model = { provider: "openai" as const, apiKey: "offline-only", baseURL: "http://127.0.0.1:9/v1", reasoningModel: "fixture-model", model: "fixture-model" };
    const target = { model: { provider: model.provider, modelId: model.reasoningModel, revision: "fixture-revision" }, tools: [],
      environmentFingerprint: "e".repeat(64), applicability: ["synthetic:fact-selection-v1"] };
    const holdout: SyntheticReuseHoldout = { schema: "synthetic:fact-selection-v1", trainingCaseIds: ["training"], applicability: target.applicability,
      cases: Array.from({ length: 200 }, (_, i) => ({ id: `case-${i}`, independenceGroupId: `group-${i}`, subclass: "authority",
        query: `Select fact answer-${i}.`, expectedFactIds: [`answer-${i}`],
        facts: [{ id: `answer-${i}`, value: `value-${i}`, authorized: true }, { id: `denied-${i}`, value: "restricted", authorized: false }] })) };
    const plan: HostSkillPairedEvaluationPlan = { id: "plan", proposerId: "owner-proposer", frozenAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(), sourceScope: scope, targetScope: scope,
      oldSubject: skillCompatibilitySubject(old), newSubject: skillCompatibilitySubject(next), atomicField: "steps",
      diffFingerprint: skillAtomicDiffFingerprint(old, next, "steps"), target, holdoutRef: "holdout",
      holdoutHash: syntheticHoldoutHash(holdout), splitManifestHash: syntheticSplitManifestHash(holdout),
      objective: { kind: "quality", minimumGain: 0.05 }, confidenceAlpha: 0.05, maximumQualityRegression: 0.1,
      criticalSubclasses: ["authority"], minimumPairs: 200, minimumSubclassPairs: 200,
      budget: { maximumPairs: 200, maximumToolCallsPerCase: 0, maximumCostPerArm: 30_000,
        maximumArmDurationMs: 30_000, costUnit: "milliseconds" }, rejectedRetentionMs: 1000 };
    const planFile = join(dir, "plan.json"), holdoutFile = join(dir, "holdout.json");
    const planBytes = JSON.stringify(plan), holdoutBytes = JSON.stringify(holdout);
    await writeFile(planFile, planBytes); await writeFile(holdoutFile, holdoutBytes);
    const config = loadGlobalEvolutionConfig({ authority, scope, hostConfig: memoryConfigSchema.parse({
      embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" }, llm: model, features: { continuousMemoryEvolution: true },
      evolution: { reuse: { targetProfile: target, evaluations: [{ id: plan.id, planFile, holdoutFile,
        planFileHash: createHash("sha256").update(planBytes).digest("hex"), holdoutFileHash: createHash("sha256").update(holdoutBytes).digest("hex") }] } },
    }) });
    const f = stateProvider(), persistence = f.provider.createEvolutionPersistence(scope);
    const control = createEvolutionHostControl({ persistence, authority, scope, config });
    const router = createHostReuseRuntimeRouter({ authority, boundScope: scope, stateForScope: control.stateForScope,
      readTarget: control.readTarget, candidateSource: () => ({ search: async () => [] }), hydrator: () => ({ hydrate: async () => undefined }) });
    const completion = vi.fn<ChatCompletionClient["chat"]["completions"]["create"]>(async input => {
      const task = JSON.parse(input.messages[1]!.content);
      expect(task).not.toHaveProperty("expectedFactIds"); expect(task.task).not.toHaveProperty("expectedFactIds");
      const selected = task.suggestion.steps[0].startsWith("Return no") ? [] : task.task.facts
        .filter((fact: { authorized: boolean }) => fact.authorized).map(({ id, value }: { id: string; value: string }) => ({ id, value }));
      return { choices: [{ message: { content: JSON.stringify({ selected }) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
    });
    const client = new OpenAiLlmClient(model, { client: { chat: { completions: { create: completion } } }, maxRetries: 0 });
    const complete = vi.spyOn(client, "complete");
    const runtime = createEvolutionReuseRuntime({ control, config, repository, pool: persistence.repository.pool, router, llmClient: client });
    expect(f.query).not.toHaveBeenCalled(); expect(completion).not.toHaveBeenCalled();
    const result = await owner(() => runtime.capability.evaluate({ planId: plan.id }));
    expect(result).toMatchObject({ status: "accepted_for_review", publishAllowed: false, executionAllowed: false });
    expect(completion).toHaveBeenCalledTimes(400);
    expect(completion.mock.calls.every(([input, options]) => input.model === model.reasoningModel && options?.signal instanceof AbortSignal)).toBe(true);
    expect(complete.mock.calls.every(([, options]) => options?.costContext?.operation === "memory_evolution.evaluate")).toBe(true);
    expect((await control.state.list("paired_evaluation")).entries).toHaveLength(1);
    expect((await control.state.list("compatibility_binding")).entries).toHaveLength(1);
    expect(next.status).toBe("review");
    await owner(() => control.state.put({ kind: "target_profile", id: "target", operation: "revoke", expectedRevision: 0,
      idempotencyKey: "revoke-target", value: { profile: JSON.parse(JSON.stringify(target)) } }));
    expect(await owner(() => runtime.capability.evaluate({ planId: plan.id }))).toMatchObject({ status: "blocked", reason: "evaluation_target_model_mismatch" });
    expect(completion).toHaveBeenCalledTimes(400);
  });
  test("construction and missing evaluation registration do not read files, query DB, or invoke models", async () => {
    const read = vi.fn(), put = vi.fn();
    const control = { state: { scope, authority, read, put }, readTarget: vi.fn() } as unknown as EvolutionHostControl;
    const config = loadGlobalEvolutionConfig({ scope, authority, hostConfig: memoryConfigSchema.parse({
      embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" }, features: { continuousMemoryEvolution: true },
    }) });
    const runtime = createEvolutionReuseRuntime({ control, config, repository: {} as never, pool: {} as never,
      router: {} as never, llmClient: new NullLlmClient() });
    expect(runtime.skillDraftGate.evaluate).toBeTypeOf("function");
    await expect(runtime.capability.evaluate({ planId: "unknown" })).rejects.toThrow("EVOLUTION_OWNER_REQUIRED");
    expect(await owner(() => runtime.capability.evaluate({ planId: "unknown" }))).toMatchObject({
      status: "blocked", reason: "evaluation_not_registered", publishAllowed: false, executionAllowed: false,
    });
    expect(read).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
    await expect(owner(() => runtime.capability.replaceGrants({ expectedRevision: 0, idempotencyKey: "bad",
      grants: [], authority: { userId: "other" } } as never))).rejects.toThrow("EVOLUTION_REQUEST_INVALID");
    expect(put).not.toHaveBeenCalled();
  });

  test("only hash-pinned bounded regular host files are read; late edits and symlinks fail closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "evolution-reuse-control-")); dirs.push(dir);
    const path = join(dir, "plan.json"), bytes = JSON.stringify({ id: "plan-one" });
    const hash = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    expect(await readPinnedEvolutionJson(path, hash, 128, new AbortController().signal)).toEqual({ id: "plan-one" });
    await expect(readPinnedEvolutionJson(path, hash, 2, new AbortController().signal)).rejects.toThrow();
    await expect(readPinnedEvolutionJson(path, hash, 128, AbortSignal.abort())).rejects.toThrow();
    const link = join(dir, "link.json"); await symlink(path, link);
    await expect(readPinnedEvolutionJson(link, hash, 128, new AbortController().signal)).rejects.toThrow();
    await writeFile(path, JSON.stringify({ id: "changed" }));
    await expect(readPinnedEvolutionJson(path, hash, 128, new AbortController().signal)).rejects.toThrow("evaluation_file_changed");
  });
});
