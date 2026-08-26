import { describe, expect, test } from "vitest";

import type { ContextFastResponse } from "../domain/semantic-types.js";
import type { AgentLoadout, LoadoutAssemblyResult } from "../loadout/types.js";
import {
  createContextAssemblyReceipt,
  validatePersistedContextAssemblyReceipt,
} from "./assembly-receipt.js";

const scope = {
  tenantId: "tenant-a", userId: "user-a", appId: "codex", projectId: "project-a",
  agentId: "agent-a", namespace: "memory", visibility: "private" as const,
  sessionId: "session-a",
};

const response: ContextFastResponse = {
  scope,
  slots: {},
  content: "safe",
  assemblyPlan: {
    sessionId: scope.sessionId,
    slots: {
      rules: {
        semanticType: "rules",
        mustRead: [{ ref: "memory-1", semanticType: "rules", content: "rule", evidenceRefs: ["e-1"] }],
        navigation: [
          { ref: "memory-1", kind: "memory", level: "R1", semanticType: "rules" },
          { ref: "tree-1", kind: "topic_tree", level: "R2", semanticType: "rules" },
        ],
        assetRefs: [{ assetId: "asset-1", version: 2 }],
        evidenceRefs: ["e-1"],
        filtered: [{ ref: "asset-2", reason: "budget_exceeded" }],
        tokenBudget: 500,
      },
    },
    tools: [{ name: "memory_asset_read" }],
    denied: [{ ref: "asset-3", reason: "asset_stale" }],
    versions: {
      slotSnapshot: 2, loadout: 3, assetVersionSetHash: "a".repeat(64),
      retrieval: "v1", scoring: "v1", promptPolicy: "v1",
    },
    stableContentHash: "b".repeat(64),
    dynamicContentHash: "c".repeat(64),
    expiresAt: "2026-08-13T01:00:00.000Z",
  },
  warnings: ["budget_exceeded: asset asset-2 downgraded to navigation"],
  telemetry: { latencyMs: 1, nodesUsed: 1, cacheHit: false },
};

const loadout: AgentLoadout = {
  id: "loadout-1", scope, appId: scope.appId, agentId: scope.agentId,
  projectId: scope.projectId, version: 3, visibility: "private",
  slotBindings: [{
    assetId: "asset-1", slot: "rules", disclosureMode: "must_read",
    priority: 20, required: true,
  }],
  nativeMemoryPolicy: {
    semanticTypes: ["rules"], scopeReuse: "project_only", treeDepth: "topic",
    tokenBudgets: { profile: 500, task_context: 500, rules: 500, experience: 500, resource: 500 },
  },
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
};

const assembly: LoadoutAssemblyResult = {
  enhancementEnabled: true,
  contributions: [],
  denied: [{ assetId: "asset-3", reason: "asset_stale" }],
  degraded: [{ assetId: "asset-2", slot: "rules", reason: "budget_exceeded" }],
  receipt: { loadoutId: loadout.id, loadoutVersion: loadout.version,
    assetVersions: [{ assetId: "asset-1", version: 2 }] },
};

describe("ContextAssemblyReceipt", () => {
  test("records final plan, bindings, disclosure, denial, degradation and provenance", () => {
    const receipt = createContextAssemblyReceipt({ scope, response, loadout, assembly, now: 1_786_579_200_000 });

    expect(receipt).toMatchObject({
      scopeFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      sessionId: "session-a",
      loadout: { id: "loadout-1", version: 3 },
      memoryRefs: ["memory-1"], treeRefs: ["tree-1"],
      assetRefs: [{ assetId: "asset-1", version: 2 }], evidenceRefs: ["e-1"],
      denied: [{ ref: "asset-3", reason: "asset_stale" }],
      degraded: [{ assetId: "asset-2", slot: "rules", reason: "budget_exceeded" }],
      bindings: [{ assetId: "asset-1", slot: "rules", priority: 20, required: true,
        requestedDisclosureMode: "must_read", selectedVersion: 2 }],
      stableContentHash: "b".repeat(64), dynamicContentHash: "c".repeat(64),
    });
    expect(validatePersistedContextAssemblyReceipt(structuredClone(receipt))).toEqual(receipt);
    expect(Object.isFrozen(receipt.plan)).toBe(true);
  });

  test("records must-read-only native memory refs without classifying must-read assets as memory", () => {
    const mustReadOnly: ContextFastResponse = {
      ...response,
      assemblyPlan: {
        ...response.assemblyPlan!,
        slots: {
          rules: {
            ...response.assemblyPlan!.slots.rules!,
            mustRead: [
              { ref: "memory-only", semanticType: "rules", content: "native", evidenceRefs: ["e-2"] },
              { ref: "asset-1", semanticType: "rules", content: "asset", evidenceRefs: ["e-3"] },
            ],
            navigation: [],
          },
        },
      },
    };

    const receipt = createContextAssemblyReceipt({
      scope, response: mustReadOnly, loadout, assembly, now: 1_786_579_200_000,
    });

    expect(receipt.memoryRefs).toEqual(["memory-only"]);
    expect(receipt.assetRefs).toEqual([{ assetId: "asset-1", version: 2 }]);
  });

  test("requires a real authority-bound session and rejects tampered hashes", () => {
    expect(() => createContextAssemblyReceipt({
      scope: { ...scope, sessionId: undefined }, response, now: 1,
    })).toThrow(/session/i);
    const receipt = createContextAssemblyReceipt({ scope, response, now: 1_786_579_200_000 });
    expect(() => validatePersistedContextAssemblyReceipt({ ...receipt, scopeFingerprint: "attacker" }))
      .toThrow(/receipt/i);
  });

  test("keeps session ids within the v22 database contract", () => {
    for (const sessionId of ["x".repeat(257), "session with spaces"]) {
      expect(() => createContextAssemblyReceipt({
        scope: { ...scope, sessionId },
        response: {
          ...response,
          scope: { ...scope, sessionId },
          assemblyPlan: { ...response.assemblyPlan!, sessionId },
        },
        now: 1_786_579_200_000,
      })).toThrow(/session/i);
    }
  });
});
