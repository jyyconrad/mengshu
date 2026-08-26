import { describe, expect, it } from "vitest";

import { computeRecallScoreBreakdown } from "../domain/recall-scoring.js";
import type { MemoryRecord, MemoryScope } from "../domain/types.js";
import { AgentLoadoutAssembler } from "./assembler.js";
import { InMemoryAgentLoadoutRepository } from "./in-memory-repository.js";
import { AgentLoadoutError, AgentLoadoutService } from "./service.js";
import type { LoadoutAssetCandidate } from "./types.js";

const SCOPE: MemoryScope = {
  tenantId: "tenant-1",
  userId: "user-1",
  appId: "app-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memory",
  visibility: "private",
};

function binding(assetId: string, overrides: Record<string, unknown> = {}) {
  return {
    assetId,
    slot: "rules" as const,
    disclosureMode: "must_read" as const,
    priority: 10,
    required: false,
    maxTokens: 300,
    ...overrides,
  };
}

function loadoutInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "loadout-1",
    idempotencyKey: "loadout-request-1",
    expectedLatestVersion: 0,
    scope: SCOPE,
    appId: "app-1",
    agentId: "agent-1",
    projectId: "project-1",
    slotBindings: [binding("asset-1")],
    nativeMemoryPolicy: {
      semanticTypes: ["profile", "task_context", "rules", "experience", "resource"] as const,
      scopeReuse: "project_only" as const,
      treeDepth: "topic" as const,
      tokenBudgets: {
        profile: 600,
        task_context: 1000,
        rules: 1000,
        experience: 800,
        resource: 600,
      },
    },
    ...overrides,
  };
}

function candidate(
  assetId: string,
  score: number,
  overrides: Partial<LoadoutAssetCandidate> = {},
): LoadoutAssetCandidate {
  const record: MemoryRecord = {
    id: `${assetId}-memory`,
    scope: SCOPE,
    kind: "decision",
    semanticType: "rules",
    lifecycleStatus: "active",
    text: `${assetId} governed rule`,
    contentHash: "a".repeat(32),
    importance: 0.8,
    confidence: 0.9,
    category: "decision",
    dataType: "memory",
    metadata: {},
    provenance: {},
    sourceNodeIds: [`${assetId}-evidence`],
    createdAt: 1,
  };
  const breakdown = computeRecallScoreBreakdown(
    record,
    { relevance: score, scopeFit: 1 },
    ["vector"],
    { vector: score },
  );
  return {
    assetId,
    assetVersion: 1,
    assetKind: "memory_view",
    status: "published",
    contentValidity: "current",
    scope: SCOPE,
    semanticTypes: ["rules"],
    recordId: record.id,
    content: record.text,
    evidenceRefs: record.sourceNodeIds!,
    lifecycleEligible: true,
    riskBlocked: false,
    conflictUnresolved: false,
    score: breakdown.score,
    scoreBreakdown: breakdown,
    tokenEstimate: 40,
    ...overrides,
  };
}

describe("AgentLoadoutService", () => {
  it("保存 private 版本化 Loadout，并以 CAS 保护 append-only 历史", async () => {
    const repository = new InMemoryAgentLoadoutRepository({ now: () => 1_700_000_000_000 });
    const service = new AgentLoadoutService(repository);
    const first = await service.createVersion(loadoutInput());
    const second = await service.createVersion(loadoutInput({
      idempotencyKey: "loadout-request-2",
      expectedLatestVersion: 1,
      slotBindings: [binding("asset-1", { priority: 20 })],
    }));

    expect(first.loadout).toMatchObject({ version: 1, visibility: "private" });
    expect(second.loadout.version).toBe(2);
    expect((await repository.getVersion(SCOPE, "loadout-1", 1))?.slotBindings[0]?.priority)
      .toBe(10);
    await expect(service.createVersion(loadoutInput({
      idempotencyKey: "loadout-request-3",
      expectedLatestVersion: 1,
    }))).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("拒绝跨 authority scope、重复 binding 和越界槽位", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    await expect(service.createVersion(loadoutInput({ appId: "other-app" })))
      .rejects.toMatchObject({ code: "SCOPE_MISMATCH" });
    await expect(service.createVersion(loadoutInput({
      slotBindings: [binding("asset-1"), binding("asset-1")],
    }))).rejects.toMatchObject({ code: "DUPLICATE_BINDING" });
    await expect(service.createVersion(loadoutInput({
      slotBindings: [binding("asset-1", { slot: "workflow_policy" })],
    }))).rejects.toBeInstanceOf(AgentLoadoutError);
  });

  it("unbind 以 append-only 新版本移除精确槽位绑定，并支持幂等重放", async () => {
    const repository = new InMemoryAgentLoadoutRepository({ now: () => 1_700_000_000_000 });
    const service = new AgentLoadoutService(repository);
    await service.createVersion(loadoutInput({
      slotBindings: [binding("asset-1"), binding("asset-1", { slot: "experience" })],
    }));
    const input = {
      scope: SCOPE, loadoutId: "loadout-1", assetId: "asset-1", slot: "rules" as const,
      expectedLatestVersion: 1, idempotencyKey: "unbind-request-1",
    };

    const changed = await service.unbind(input);
    const replayed = await service.unbind(input);

    expect(changed).toMatchObject({ replayed: false, loadout: { version: 2 } });
    expect(changed.loadout.slotBindings).toEqual([
      expect.objectContaining({ assetId: "asset-1", slot: "experience" }),
    ]);
    expect(replayed).toMatchObject({ replayed: true, loadout: { version: 2 } });
    expect((await repository.getVersion(SCOPE, "loadout-1", 1))?.slotBindings).toHaveLength(2);
  });

  it("pause 追加空绑定版本，原生 memory policy 与历史版本保持不变", async () => {
    const repository = new InMemoryAgentLoadoutRepository({ now: () => 1_700_000_000_000 });
    const service = new AgentLoadoutService(repository);
    const original = await service.createVersion(loadoutInput());
    const paused = await service.pause({
      scope: SCOPE, loadoutId: "loadout-1", expectedLatestVersion: 1,
      idempotencyKey: "pause-request-1",
    });

    expect(paused.loadout).toMatchObject({ version: 2, slotBindings: [] });
    expect(paused.loadout.nativeMemoryPolicy).toEqual(original.loadout.nativeMemoryPolicy);
    expect((await repository.getVersion(SCOPE, "loadout-1", 1))?.slotBindings).toHaveLength(1);
    await expect(service.resolveForAssembly(SCOPE)).resolves.toBeUndefined();
    await expect(service.resolveCurrent(SCOPE)).resolves.toMatchObject({ version: 2 });
  });
});

describe("AgentLoadoutAssembler", () => {
  it("无 Loadout 时返回空增强，原生 5 槽位路径不受影响", () => {
    expect(new AgentLoadoutAssembler().assemble(undefined, [])).toEqual({
      enhancementEnabled: false,
      contributions: [],
      denied: [],
      degraded: [],
      receipt: undefined,
    });
  });

  it("先执行 hard filter 和六因子门槛，再用 priority 作为同分 tie-break", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    const { loadout } = await service.createVersion(loadoutInput({
      slotBindings: [
        binding("high-score", { priority: 1 }),
        binding("tie-low", { priority: 5 }),
        binding("tie-high", { priority: 50 }),
        binding("below-threshold", { priority: 1000 }),
      ],
    }));
    const high = candidate("high-score", 1);
    const tiedLow = candidate("tie-low", 0.7);
    const tiedHigh = candidate("tie-high", 0.7, {
      score: tiedLow.score,
      scoreBreakdown: tiedLow.scoreBreakdown,
    });
    const below = candidate("below-threshold", 0);

    const result = new AgentLoadoutAssembler({ minScore: 0.5 }).assemble(
      loadout,
      [below, tiedLow, high, tiedHigh],
    );

    expect(result.contributions.map((item) => item.assetId)).toEqual([
      "high-score", "tie-high", "tie-low",
    ]);
    expect(result.denied).toContainEqual({ assetId: "below-threshold", reason: "score_below_threshold" });
  });

  it("pinned/latest 固化实际版本，资产状态、scope、lifecycle/risk/conflict 均 fail-closed", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    const { loadout } = await service.createVersion(loadoutInput({
      slotBindings: [
        binding("pinned", { pinnedVersion: 1 }),
        binding("latest"),
        binding("revoked"),
        binding("wrong-scope"),
        binding("unsafe"),
      ],
    }));
    const result = new AgentLoadoutAssembler().assemble(loadout, [
      candidate("pinned", 1, { assetVersion: 1 }),
      candidate("pinned", 1, { assetVersion: 2 }),
      candidate("latest", 1, { assetVersion: 1 }),
      candidate("latest", 1, { assetVersion: 3 }),
      candidate("revoked", 1, { status: "revoked" }),
      candidate("wrong-scope", 1, { scope: { ...SCOPE, projectId: "other" } }),
      candidate("unsafe", 1, { riskBlocked: true }),
    ]);

    expect(result.receipt?.assetVersions).toEqual([
      { assetId: "latest", version: 3 },
      { assetId: "pinned", version: 1 },
    ]);
    expect(result.denied).toEqual(expect.arrayContaining([
      { assetId: "revoked", reason: "asset_not_published" },
      { assetId: "wrong-scope", reason: "scope_mismatch" },
      { assetId: "unsafe", reason: "risk_blocked" },
    ]));
  });

  it("required binding 解析或门禁失败时 session fail-closed", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    const { loadout } = await service.createVersion(loadoutInput({
      slotBindings: [binding("required", { required: true })],
    }));

    expect(() => new AgentLoadoutAssembler().assemble(loadout, []))
      .toThrowError(expect.objectContaining({ code: "REQUIRED_BINDING_UNAVAILABLE" }));
  });

  it("memory_view 只能贡献已声明槽位，且 budget 超限降级为 navigation", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    const { loadout } = await service.createVersion(loadoutInput({
      slotBindings: [binding("mismatch"), binding("large", { maxTokens: 10 })],
    }));
    const result = new AgentLoadoutAssembler().assemble(loadout, [
      candidate("mismatch", 1, { semanticTypes: ["experience"] }),
      candidate("large", 1, { tokenEstimate: 11 }),
    ]);

    expect(result.contributions).toEqual([
      expect.objectContaining({
        assetId: "large",
        disclosureMode: "navigation",
        requestedDisclosureMode: "must_read",
        degradedReason: "budget_exceeded",
      }),
    ]);
    expect(result.denied).toEqual(expect.arrayContaining([
      { assetId: "mismatch", reason: "slot_incompatible" },
    ]));
    expect(result.degraded).toEqual([
      { assetId: "large", slot: "rules", reason: "budget_exceeded" },
    ]);
    expect(result.receipt?.assetVersions).toContainEqual({ assetId: "large", version: 1 });
  });

  it("按治理分数顺序累计扣除原生与同槽 Asset 预算，剩余正文降级为 navigation", async () => {
    const service = new AgentLoadoutService(new InMemoryAgentLoadoutRepository());
    const { loadout } = await service.createVersion(loadoutInput({
      nativeMemoryPolicy: {
        semanticTypes: ["rules"], scopeReuse: "project_only", treeDepth: "topic",
        tokenBudgets: { profile: 100, task_context: 100, rules: 100,
          experience: 100, resource: 100 },
      },
      slotBindings: [
        binding("lower", { priority: 100 }),
        binding("higher", { priority: 1 }),
      ],
    }));
    const higher = candidate("higher", 1, { tokenEstimate: 45 });
    const lower = candidate("lower", 0.7, { tokenEstimate: 40 });

    const result = new AgentLoadoutAssembler().assemble(loadout, [lower, higher], {
      nativeTokenUsage: { rules: 30 },
    });

    expect(result.contributions.map((item) => [item.assetId, item.disclosureMode])).toEqual([
      ["higher", "must_read"],
      ["lower", "navigation"],
    ]);
    expect(result.degraded).toEqual([
      { assetId: "lower", slot: "rules", reason: "budget_exceeded" },
    ]);
  });
});
