import { describe, expect, test } from "vitest";
import type { MemoryRecord, MemoryScope } from "../../domain/types.js";
import type { SkillArtifactVersion } from "../../skills/types.js";
import {
  HostReuseCompatibilityReader,
  fingerprintTargetProfile,
  isCompatibleBinding,
  memoryCompatibilitySubject,
  skillCompatibilitySubject,
  type ReuseCompatibilityBinding,
  type TargetExecutionProfile,
} from "./target-compatibility.js";

const source: MemoryScope = { tenantId: "t", userId: "u", appId: "codex", agentId: "a",
  namespace: "memory", projectId: "p", visibility: "private" };
const targetScope = { ...source, appId: "openclaw" };
const now = Date.parse("2026-09-06T00:00:00Z");
const target: TargetExecutionProfile = {
  model: { provider: "local-verifier", modelId: "target-model", revision: "r1" },
  tools: [{ name: "read", version: "v1", schemaHash: "a".repeat(64) }],
  environmentFingerprint: "b".repeat(64), applicability: ["read-only", "project:p"],
};
const memory: MemoryRecord = { id: "m", scope: source, kind: "knowledge", semanticType: "experience",
  text: "Reviewed experience", contentHash: "c".repeat(64), createdAt: 1, updatedAt: 2, importance: 0.9,
  category: "other", dataType: "memory", metadata: {}, provenance: {} };

function binding(): ReuseCompatibilityBinding {
  return {
    subject: memoryCompatibilitySubject(memory), targetScope,
    targetFingerprint: fingerprintTargetProfile(target), executionMode: "suggest_only",
    status: "validated", evaluatorId: "verifier-1", planHash: "d".repeat(64),
    reportHash: "e".repeat(64), holdoutRef: "holdout-v1", reviewReceiptId: "review-1",
    validatedAt: "2026-09-05T00:00:00.000Z", expiresAt: "2026-09-07T00:00:00.000Z",
  };
}

describe("target model/tool/environment compatibility", () => {
  test("a published Skill needs the exact host binding; draft/revoked/executable artifacts cannot reuse it", async () => {
    const skill: SkillArtifactVersion = {
      skillId: "s", version: 3, isHead: true, ownerUserId: source.userId,
      scope: { ...source, visibility: "private" }, title: "Suggestion", description: "Reviewed procedure",
      triggerConditions: ["task"], preconditions: ["read-only"], steps: ["inspect"], successSignals: ["verified"],
      antiPatterns: [], riskBoundaries: ["no writes"], evidenceMemoryIds: ["m"], evidenceChunkIds: ["e"],
      manifest: [], contentHash: "c".repeat(64), status: "published", executionMode: "suggest_only",
      expectedOutcomePolicyVersion: "v1", createdAt: "2026-09-01T00:00:00.000Z",
    };
    const reader = new HostReuseCompatibilityReader({ readTarget: async () => target,
      readBinding: async () => ({ ...binding(), subject: skillCompatibilitySubject(skill) }) }, () => now);
    expect(await reader.allowsSkill(skill, targetScope)).toBe(true);
    for (const status of ["draft", "review", "revoked"] as const) {
      expect(await reader.allowsSkill({ ...skill, status }, targetScope)).toBe(false);
    }
    expect(await reader.allowsSkill({ ...skill, executionMode: "execute" } as never, targetScope)).toBe(false);
    expect(await reader.allowsSkill({ ...skill, ownerUserId: "foreign" }, targetScope)).toBe(false);
    expect(await reader.allowsSkill({ ...skill, manifest: [{ executable: true }] } as never, targetScope)).toBe(false);
    expect(isCompatibleBinding(binding(), { subject: { ...memoryCompatibilitySubject(memory), id: undefined } as never,
      targetScope, target, now })).toBe(false);
  });

  test("unavailable host state and a profile change during binding I/O fail closed", async () => {
    const unavailable = new HostReuseCompatibilityReader({
      readTarget: async () => { throw new Error("unavailable"); }, readBinding: async () => binding(),
    }, () => now);
    expect(await unavailable.allows(memory, targetScope)).toBe(false);
    let calls = 0;
    const drift = new HostReuseCompatibilityReader({
      readTarget: async () => ++calls === 1 ? target : { ...target, environmentFingerprint: "9".repeat(64) },
      readBinding: async () => binding(),
    }, () => now);
    expect(await drift.allows(memory, targetScope)).toBe(false);
  });

  test("normalizes set order but not changed tools, models, environments or applicability", () => {
    expect(fingerprintTargetProfile({ ...target, applicability: [...target.applicability].reverse() }))
      .toBe(fingerprintTargetProfile(target));
    const mutations = [
      { ...target, model: { ...target.model, revision: "r2" } },
      { ...target, tools: [{ ...target.tools[0]!, schemaHash: "f".repeat(64) }] },
      { ...target, tools: [{ ...target.tools[0]!, version: "v2" }] },
      { ...target, environmentFingerprint: "f".repeat(64) },
      { ...target, applicability: ["write-enabled"] },
    ];
    for (const profile of mutations) expect(isCompatibleBinding(binding(), {
      subject: memoryCompatibilitySubject(memory), targetScope, target: profile, now,
    })).toBe(false);
  });

  test("validates exact content, revision, owner, scope, interval and suggest-only mode", () => {
    const input = { subject: memoryCompatibilitySubject(memory), targetScope, target, now };
    expect(isCompatibleBinding(binding(), input)).toBe(true);
    expect(isCompatibleBinding(binding(), { ...input, now: Date.parse(binding().expiresAt) })).toBe(false);
    expect(isCompatibleBinding(binding(), { ...input, subject: memoryCompatibilitySubject({ ...memory, updatedAt: 3 }) })).toBe(false);
    expect(isCompatibleBinding(binding(), { ...input, targetScope: { ...targetScope, userId: "other" } })).toBe(false);
    for (const update of [
      { executionMode: "execute" }, { status: "revoked" }, { reportHash: "fake-score" },
      { reviewReceiptId: "" }, { expiresAt: "invalid" },
    ]) expect(isCompatibleBinding({ ...binding(), ...update } as never, input)).toBe(false);
  });

  test("a host read rechecks current profile and current binding on every use", async () => {
    let current = target;
    let currentBinding: ReuseCompatibilityBinding | undefined = binding();
    const reader = new HostReuseCompatibilityReader({
      readTarget: async () => current,
      readBinding: async () => currentBinding,
    }, () => now);
    expect(await reader.allows(memory, targetScope)).toBe(true);
    current = { ...target, model: { ...target.model, revision: "r2" } };
    expect(await reader.allows(memory, targetScope)).toBe(false);
    current = target;
    currentBinding = undefined;
    expect(await reader.allows(memory, targetScope)).toBe(false);
  });

  test("unresolved model aliases, malformed hashes, duplicate tools and missing conditions are rejected", () => {
    for (const profile of [
      { ...target, model: { ...target.model, revision: "latest" } },
      { ...target, tools: [...target.tools, ...target.tools] },
      { ...target, environmentFingerprint: "unverified" },
      { ...target, applicability: [] },
    ]) expect(() => fingerprintTargetProfile(profile)).toThrow();
  });
});
