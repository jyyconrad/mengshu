import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loadGlobalEvolutionConfig, createGlobalEvolutionLlm } from "./evolution-config.js";
import { memoryConfigSchema } from "../config.js";

const scope = { tenantId: "tenant", userId: "user", appId: "codex", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
const authority = { tenantId: scope.tenantId, userId: scope.userId, allow: {
  appIds: [scope.appId], projectIds: [scope.projectId, "other-project"], agentIds: [scope.agentId],
  namespaces: [scope.namespace], visibilities: [scope.visibility],
} };
const base = { embedding: { apiKey: "fixture", baseURL: "http://127.0.0.1:9/v1" }, features: { continuousMemoryEvolution: true },
  llm: { apiKey: "global-fixture", model: "global-model", extractionModel: "global-extraction", baseURL: "http://127.0.0.1:9/v1" } };
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function config(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "evolution-global-")); dirs.push(dir);
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(value));
  return configPath;
}
describe("global evolution configuration ownership", () => {
  test("issuer rotation changes the frozen batch fingerprint while owner credentials remain excluded", () => {
    const issuer = { id: "host-verifier", publicKeyPem: generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString() };
    const load = (publicKeyPem: string, ownerSecret: string) => loadGlobalEvolutionConfig({ authority, scope,
      hostConfig: memoryConfigSchema.parse({ ...base, evolution: { attestation: { trustedIssuers: [{ ...issuer, publicKeyPem }] }, control: { ownerSecret } } }),
    });
    const first = load(issuer.publicKeyPem, "first-owner-secret-fixture-not-real");
    expect(load(issuer.publicKeyPem, "second-owner-secret-fixture-not-real").configFingerprint).toBe(first.configFingerprint);
    expect(load(generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString(), "first-owner-secret-fixture-not-real").configFingerprint)
      .not.toBe(first.configFingerprint);
  });
  test("honors the trusted operator config path and freezes an already resolved host snapshot", async () => {
    vi.stubEnv("MENGSHU_CONFIG", await config(base));
    expect(loadGlobalEvolutionConfig({ authority, scope }).config.llm?.model).toBe("global-model");
    const hostConfig = memoryConfigSchema.parse(base);
    const resolved = loadGlobalEvolutionConfig({ authority, scope, hostConfig });
    hostConfig.llm!.model = "later-project-model";
    expect(resolved.config.llm?.model).toBe("global-model");
    expect(Object.isFrozen(resolved.config.llm)).toBe(true);
  });
  test("only host-authorized source bindings in the exact runtime scope are exposed", async () => {
    const configPath = await config({ ...base, evolution: { sources: [
      { sourceId: "notes", root: "/tmp/notes", parser: "markdown" },
      { sourceId: "other", root: "/tmp/other", parser: "markdown", scope: { projectId: "other-project" } },
    ] } });
    const result = loadGlobalEvolutionConfig({ authority, scope, configPath });
    expect(result.sources.map(source => source.sourceId)).toEqual(["notes"]);
    expect(result.sources[0]?.scope).toEqual(scope);
    expect(result.configFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.config.llm?.model).toBe("global-model");
    expect(JSON.stringify({ fingerprint: result.configFingerprint })).not.toContain("global-fixture");
  });
  test("requires global opt-in and rejects host identity and source binding mismatches", async () => {
    const disabled = await config({ ...base, features: {} });
    expect(() => loadGlobalEvolutionConfig({ authority, scope, configPath: disabled })).toThrow(/DISABLED/);
    const valid = await config(base);
    expect(() => loadGlobalEvolutionConfig({ authority, scope: { ...scope, userId: "other" }, configPath: valid })).toThrow();
    const outside = await config({ ...base, evolution: { sources: [{ sourceId: "notes", root: "/tmp/notes", scope: { projectId: "outside" } }] } });
    expect(() => loadGlobalEvolutionConfig({ authority, scope, configPath: outside })).toThrow();
  });
  test("global model calls use the existing ledger and never price unconfigured models as free", async () => {
    const resolved = loadGlobalEvolutionConfig({ authority, scope, configPath: await config(base) });
    const create = vi.fn(async () => ({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 11, completion_tokens: 2 } }));
    const append = vi.fn(async () => undefined);
    const client = createGlobalEvolutionLlm(resolved, { append }, scope, {
      client: { chat: { completions: { create } } },
    });
    await client.complete([{ role: "user", content: "fixture" }], { modelType: "extraction" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: "global-extraction", temperature: 0 }),
      expect.objectContaining({ signal: expect.any(AbortSignal), maxRetries: 0 }));
    expect(append).toHaveBeenCalledWith(expect.objectContaining({
      model: "global-extraction", category: "operator", operation: "memory_evolution.propose",
      inputTokens: 11, outputTokens: 2, estimatedMinorUnits: null,
    }));
  });
});
