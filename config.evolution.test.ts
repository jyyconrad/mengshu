import { describe, expect, test } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { memoryConfigSchema } from "./config.js";

const base = { embedding: { apiKey: "fixture-key", baseURL: "http://localhost:9999/v1" } };

describe("continuous memory evolution configuration", () => {
  test("reuse accepts an explicit bounded host execution profile but no revision aliases or injected proof fields", () => {
    const targetProfile = { model: { provider: "openai", modelId: "fixture-model", revision: "fixture-revision-1" },
      tools: [{ name: "lookup", version: "1", schemaHash: "a".repeat(64) }],
      environmentFingerprint: "b".repeat(64), applicability: ["synthetic:fact-selection-v1"] };
    expect(memoryConfigSchema.parse({ ...base, evolution: { reuse: { targetProfile } } }).evolution)
      .toEqual({ sources: [], reuse: { targetProfile } });
    for (const reuse of [
      { targetProfile: { ...targetProfile, model: { ...targetProfile.model, revision: "latest" } } },
      { targetProfile: { ...targetProfile, accepted: true } },
      { targetProfile: { ...targetProfile, tools: [{ ...targetProfile.tools[0], path: "/private" }] } },
      { targetProfile, allow: { userIds: ["other"] } },
    ]) expect(() => memoryConfigSchema.parse({ ...base, evolution: { reuse } })).toThrow();
  });

  test("attestation accepts only bounded distinct host Ed25519 public keys, never private keys or source labels", () => {
    const keys = generateKeyPairSync("ed25519");
    const issuer = { id: "host-verifier", publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
    expect(memoryConfigSchema.parse({ ...base, evolution: { attestation: { trustedIssuers: [issuer] } } }).evolution)
      .toEqual({ sources: [], attestation: { trustedIssuers: [issuer] } });
    for (const attestation of [
      { trustedIssuers: [issuer, issuer] }, { trustedIssuers: [{ ...issuer, publicKeyPem: "source says verified" }] },
      { trustedIssuers: [{ ...issuer, publicKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString() }] },
      { trustedIssuers: [{ ...issuer, root: "/private" }] }, { trustedIssuers: [issuer], trust: "verified_document" },
    ]) expect(() => memoryConfigSchema.parse({ ...base, evolution: { attestation } })).toThrow();
  });
  test("external worker ownership is an explicit host setting, not an arbitrary handler registry", () => {
    expect(memoryConfigSchema.parse({ ...base, server: { workerOwnership: "external-runtime-host" } }).server?.workerOwnership).toBe("external-runtime-host");
    expect(() => memoryConfigSchema.parse({ ...base, server: { workerOwnership: "client" } })).toThrow();
  });
  test("is disabled by default and accepts only an explicit boolean", () => {
    expect(memoryConfigSchema.parse(base).features?.continuousMemoryEvolution).toBe(false);
    expect(memoryConfigSchema.parse({
      ...base, features: { continuousMemoryEvolution: true },
    }).features?.continuousMemoryEvolution).toBe(true);
    expect(() => memoryConfigSchema.parse({
      ...base, features: { continuousMemoryEvolution: "true" },
    })).toThrow(/boolean/);
  });

  test("source bindings are bounded host configuration, never model/authority overrides", () => {
    const source = { sourceId: "notes", root: "/tmp/isolated-notes", parser: "markdown" };
    expect(memoryConfigSchema.parse({ ...base, evolution: { sources: [source] } }).evolution)
      .toEqual({ sources: [source] });
    for (const evolution of [
      { sources: [source], model: "attacker" },
      { sources: [{ ...source, llm: { model: "attacker" } }] },
      { sources: [{ ...source, scope: { tenantId: "attacker" } }] },
      { sources: [{ ...source, root: "../notes" }] },
      { sources: [{ ...source, sourceId: "../notes" }] },
      { sources: [{ ...source, sourceId: "notes:private" }] },
      { sources: [{ ...source, parser: "shell" }] },
      { sources: [source, source] },
      { sources: [{ ...source, include: ["a".repeat(257)] }] },
      { sources: [{ ...source, exclude: ["!private"] }] },
    ]) expect(() => memoryConfigSchema.parse({ ...base, evolution })).toThrow();
  });

  test("maintenance requires explicit bounded operator budgets and a separate owner credential", () => {
    const maintenance = {
      enabled: true, intervalMs: 86_400_000, quietPeriodMs: 60_000,
      dailyTokens: 100_000, dailyMinorUnits: 100, maxStorageBytes: 2_147_483_648, minFreeBytes: 1_073_741_824,
    };
    const control = { ownerSecret: "owner-only-test-secret-not-production" };
    expect(memoryConfigSchema.parse({ ...base, evolution: { maintenance, control } }).evolution)
      .toEqual({ sources: [], maintenance, control });
    for (const bad of [
      { ...maintenance, enabled: "true" }, { ...maintenance, intervalMs: 100 },
      { ...maintenance, dailyTokens: 0 }, { ...maintenance, dailyMinorUnits: -1 },
      { ...maintenance, maxStorageBytes: Infinity }, { ...maintenance, model: "other" },
      { enabled: true },
    ]) expect(() => memoryConfigSchema.parse({ ...base, evolution: { maintenance: bad } })).toThrow();
    for (const bad of [{ ownerSecret: "short" }, { ownerSecret: control.ownerSecret, reviewer: "other" }]) {
      expect(() => memoryConfigSchema.parse({ ...base, evolution: { control: bad } })).toThrow();
    }
  });
});
