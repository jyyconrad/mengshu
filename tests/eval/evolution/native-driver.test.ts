import { afterEach, describe, expect, test, vi } from "vitest";
import { createNativeRuntimeDiagnosticFactory } from "./native-driver.js";
import { createNativeCreatePilotDataset, createNativePilotSettings } from "./native-create-pilot.js";
import { memoryConfigSchema } from "../../../config.js";
import { writeNativePilot } from "./write-native-pilot.js";
import { createSyntheticDiagnosticDataset } from "./synthetic-fixture.js";
import { exactDiagnosticVerifier, freezeDiagnosticDataset } from "./diagnostic-runner.js";
import { createNativeRolloutConfig, openNativeRolloutRuntime } from "../../fixtures/memory-evolution-rollout/native-runtime.js";
import { ROLLOUT_AUTHORITY, ROLLOUT_SCOPE } from "../../fixtures/memory-evolution-rollout/source-corpus.js";
import { loadGlobalEvolutionConfig } from "../../../server/evolution-config.js";
import { authorityScopeFingerprint } from "../../../packages/core/src/domain/authority-scope-fingerprint.js";
import { unknownCost } from "./component-driver.js";

afterEach(() => vi.unstubAllEnvs());
describe("native diagnostic boundaries, no PG or model calls", () => {
  test("fixture obeys serialized HostAuthority while host resolution preserves all nine scope coordinates", () => {
    const base = memoryConfigSchema.parse({ embedding: { provider: "openai", apiKey: "synthetic-only", baseURL: "https://embedding.invalid/v1" },
      llm: { provider: "openai", apiKey: "synthetic-only", baseURL: "https://models.invalid/v1", model: "synthetic-only" } });
    const config = createNativeRolloutConfig(base, { host: "127.0.0.1", port: 54329, database: "synthetic_fixture", user: "test", password: "test", ssl: false },
      "/synthetic-only/source", "synthetic-owner-secret-that-is-not-a-credential");
    expect(Object.keys(config.authority!).sort()).toEqual(["allow", "tenantId", "userId"]);
    expect(memoryConfigSchema.parse(config)).toEqual(config);
    const resolved = loadGlobalEvolutionConfig({ authority: ROLLOUT_AUTHORITY, scope: ROLLOUT_SCOPE, hostConfig: config });
    expect(resolved.sources[0].scope).toEqual(ROLLOUT_SCOPE);
    expect(Object.keys(resolved.sources[0].scope)).toHaveLength(9);
    expect(resolved.sources[0].scope).toMatchObject({ workspaceId: ROLLOUT_AUTHORITY.workspaceId, sessionId: ROLLOUT_AUTHORITY.sessionId });
    expect(authorityScopeFingerprint(resolved.sources[0].scope)).toBe(authorityScopeFingerprint(ROLLOUT_SCOPE));
    expect(() => memoryConfigSchema.parse({ ...config, authority: ROLLOUT_AUTHORITY })).toThrow("authority has unknown keys");
    expect(createNativePilotSettings(config, 1_788_000_000_000).configFingerprint)
      .toBe(createNativePilotSettings(base, 1_788_000_000_000).configFingerprint);
  });
  test("native runtime cannot start without both explicit live and real-model opt-ins", async () => {
    vi.stubEnv("MENGSHU_RUN_LIVE_TESTS", "0");
    vi.stubEnv("MENGSHU_EVOLUTION_REAL_MODEL", "0");
    await expect(openNativeRolloutRuntime("A synthetic fact.")).rejects.toThrow("explicit_live_and_real_model_opt_in");
  });
  test("pilot is an empty-baseline source cohort, not a precomputed correct C result", () => {
    const pilot = createNativeCreatePilotDataset(createSyntheticDiagnosticDataset().settings);
    expect(freezeDiagnosticDataset(pilot).dataset.cases).toHaveLength(2);
    for (const item of pilot.cases) {
      expect(item.material.unit.targets).toEqual([]);
      expect(item.material.unit.evidence[0].trust).toBe("untrusted");
      expect(item.material).not.toHaveProperty("oracle");
      expect(item.material).not.toHaveProperty("question");
      expect(item.oracle.allowedEvidenceTextHashes).toHaveLength(1);
    }
  });
  test("unsupported baseline/correction cases fail instead of being silently omitted", async () => {
    const data = createSyntheticDiagnosticDataset();
    await expect(createNativeRuntimeDiagnosticFactory().open({ arm: "C", governanceMode: "auto", caseId: data.cases[0].id,
      material: data.cases[0].material, settings: data.settings, isolationKey: "never-opened", freezeFingerprint: "none" }))
      .rejects.toThrow("empty_baseline_single_source");
  });
  test("native freeze reflects actual model/config while excluding disposable credentials and paths", async () => {
    const config = memoryConfigSchema.parse({ embedding: { provider: "openai", apiKey: "synthetic-embedding-key", baseURL: "https://embedding.invalid/v1" },
      llm: { provider: "openai", apiKey: "synthetic-model-key", baseURL: "https://models.invalid/v1", model: "synthetic-host-model" } });
    const at = 1_788_000_000_000;
    const frozen = createNativePilotSettings(config, at);
    const rotated = structuredClone(config);
    rotated.llm!.apiKey = "rotated-synthetic-key";
    expect(createNativePilotSettings(rotated, at)).toEqual(frozen);
    rotated.llm!.model = "different-host-model";
    expect(createNativePilotSettings(rotated, at).configFingerprint).not.toBe(frozen.configFingerprint);
    expect(JSON.stringify(frozen)).not.toContain("synthetic-model-key");
    await expect(writeNativePilot(["--output", "relative.json"])).rejects.toThrow("absolute_output");
  });
  test("provider-minted IDs require independently frozen raw text hashes and the original authorized scope", () => {
    const item = createNativeCreatePilotDataset(createSyntheticDiagnosticDataset().settings).cases[0];
    const observation = { status: "answered" as const, text: item.oracle.acceptedAnswers[0], evidenceIds: ["native-raw-id"],
      injected: null, hydratedEvidence: [{ id: "native-raw-id", textHash: item.oracle.allowedEvidenceTextHashes![0], scope: item.question.scope }], cost: unknownCost() };
    expect(exactDiagnosticVerifier.verify({ question: item.question, oracle: item.oracle, observation }).answerCorrect).toBe(true);
    observation.hydratedEvidence[0].scope = { ...item.question.scope, userId: "other-owner" };
    expect(exactDiagnosticVerifier.verify({ question: item.question, oracle: item.oracle, observation }).answerCorrect).toBe(false);
  });
});
