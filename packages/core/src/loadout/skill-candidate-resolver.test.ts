import { describe, expect, test } from "vitest";

import { computeRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import type { SkillReadResult } from "../skills/types.js";
import { AgentLoadoutAssembler } from "./assembler.js";
import { InMemoryAgentLoadoutRepository } from "./in-memory-repository.js";
import { AgentLoadoutService } from "./service.js";
import { resolveSkillLoadoutCandidate } from "./skill-candidate-resolver.js";

const scope: MemoryScope = {
  tenantId: "tenant-1", userId: "user-1", appId: "codex", projectId: "project-1",
  agentId: "agent-1", namespace: "memories", visibility: "private",
};

function read(validity: SkillReadResult["validity"] = "valid"): SkillReadResult {
  return {
    artifact: {
      skillId: "skill-release", version: 3, isHead: true, ownerUserId: "user-1",
      scope: { ...scope, visibility: "private" }, title: "Release safely",
      description: "Use reviewed CI", applicability: "production releases",
      triggerConditions: ["publishing"], preconditions: ["CI green"], steps: ["review"],
      successSignals: ["healthy"], antiPatterns: ["manual edit"],
      riskBoundaries: ["never bypass approval"], evidenceMemoryIds: ["memory-1"],
      evidenceChunkIds: ["evidence-1"], manifest: [], contentHash: "a".repeat(64),
      status: "published", executionMode: "suggest_only",
      expectedOutcomePolicyVersion: "outcome-v1", createdAt: "2026-08-30T00:00:00.000Z",
    },
    validity,
    warnings: validity === "valid" ? [] : ["evidence_unavailable"],
  };
}

function score() {
  const record: MemoryRecord = {
    id: "skill-release", scope, kind: "knowledge", semanticType: "experience",
    lifecycleStatus: "active", text: "Release safely", contentHash: "b".repeat(32),
    importance: 0.9, confidence: 0.9, category: "other", dataType: "memory",
    metadata: {}, provenance: {}, sourceNodeIds: ["evidence-1"], createdAt: 1,
  };
  return computeRecallScoreBreakdown(
    record, { relevance: 0.9, scopeFit: 1 }, ["text"], { text: 0.9 },
  );
}

describe("resolveSkillLoadoutCandidate", () => {
  test("never relabels a Skill artifact with the caller scope or routes an unreviewed draft", () => {
    const breakdown = score();
    const candidate = resolveSkillLoadoutCandidate({ read: read(), scope: { ...scope, appId: "other" },
      score: breakdown.score, scoreBreakdown: breakdown, tokenEstimate: 30 });
    expect(candidate.scope).toEqual(scope);
    expect(candidate.lifecycleEligible).toBe(false);
    for (const status of ["draft", "review", "revoked"] as const) {
      expect(resolveSkillLoadoutCandidate({ read: { ...read(), artifact: { ...read().artifact, status } },
        scope, score: breakdown.score, scoreBreakdown: breakdown, tokenEstimate: 30 }).lifecycleEligible).toBe(false);
    }
  });

  test("published suggest-only Skill can bind only to experience/resource with governed score", async () => {
    const breakdown = score();
    const candidate = resolveSkillLoadoutCandidate({
      read: read(), scope, score: breakdown.score, scoreBreakdown: breakdown, tokenEstimate: 30,
    });
    const { loadout } = await new AgentLoadoutService(new InMemoryAgentLoadoutRepository())
      .createVersion({
        id: "loadout-1", idempotencyKey: "loadout-skill", expectedLatestVersion: 0,
        scope, appId: "codex", agentId: "agent-1", projectId: "project-1",
        slotBindings: [{ assetId: "skill-release", assetKind: "skill", slot: "experience",
          disclosureMode: "index_then_tool", priority: 10, required: true }],
        nativeMemoryPolicy: {
          semanticTypes: ["experience", "resource"], scopeReuse: "project_only",
          treeDepth: "topic", tokenBudgets: { profile: 0, task_context: 0, rules: 0,
            experience: 200, resource: 200 },
        },
      });
    const assembled = new AgentLoadoutAssembler().assemble(loadout, [candidate]);

    expect(candidate).toMatchObject({
      assetKind: "skill", contentValidity: "current", semanticTypes: ["experience", "resource"],
      lifecycleEligible: true, score: breakdown.score, recallSource: "text",
    });
    expect(assembled.contributions[0]).toMatchObject({
      assetId: "skill-release", assetKind: "skill", slot: "experience",
    });
    expect(assembled.receipt?.assetVersions).toEqual([
      { assetId: "skill-release", assetKind: "skill", version: 3 },
    ]);
  });

  test("stale Skill remains non-eligible and cannot satisfy required binding", () => {
    const breakdown = score();
    const candidate = resolveSkillLoadoutCandidate({
      read: read("stale"), scope, score: breakdown.score,
      scoreBreakdown: breakdown, tokenEstimate: 30,
    });
    expect(candidate).toMatchObject({ contentValidity: "stale", lifecycleEligible: false });
  });
});
