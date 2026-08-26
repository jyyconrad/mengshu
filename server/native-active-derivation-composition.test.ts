import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type { WriteMemoryRecord } from "../packages/core/src/service/write-kernel.js";
import type { DurableJobV2 } from
  "../packages/core/src/storage/repositories/job-v2.js";
import type { PostgresDurableJobV2EnqueueInput } from
  "../packages/core/src/storage/repositories/postgres-job-v2.js";
import {
  createNativeCommittedActiveDerivation,
} from "./native-active-derivation-composition.js";

type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

const scope: MemoryScope = Object.freeze({
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  visibility: "workspace" as const,
  workspaceId: "workspace-a",
  sessionId: "session-a",
});

const active: ContentRecord = Object.freeze({
  id: "memory-a",
  commandType: "observeAuto",
  mutation: "content",
  scope,
  text: "所有发布必须先运行完整测试",
  metadata: {},
  vector: Object.freeze([0.1, 0.2]),
  route: "active",
  valueScore: 0.92,
  importance: 0.9,
  kind: "decision",
  semanticType: "rules",
  confidence: 0.9,
  provenance: Object.freeze({ source: "agent", sourceId: "evidence-a", createdAt: 1_000 }),
  evidenceIds: Object.freeze(["evidence-a"]),
  governance: Object.freeze({ candidate: Object.freeze({}), admissionReason: "explicit_save" }),
  createdAt: 1_000,
});

function dependencies() {
  const readCommittedActiveRecords = vi.fn(async () => [active]);
  const readEvidenceFacts = vi.fn(async () => [{
    evidenceId: "evidence-a",
    scope,
    evidenceKind: "observation" as const,
    label: "raw observation",
    metadata: {},
    createdAt: 900,
  }]);
  const readTreeFacts = vi.fn(async () => [{
    memoryId: "memory-a",
    scope,
    evidenceId: "evidence-a",
    sourceId: "session-a",
    entityIds: [],
    scopeVisibility: "workspace" as const,
    riskFlags: [],
    topicLabels: ["Release Safety"],
    topicHotnessEligible: true,
    explicitGlobal: false,
    isWorkspaceRule: true,
  }]);
  const upsertWorkMemoryGraph = vi.fn(async () => undefined);
  const enqueue = vi.fn(async (
    input: PostgresDurableJobV2EnqueueInput,
  ): Promise<DurableJobV2> => ({
    id: input.id,
    type: input.type,
    payload: Object.freeze({ ...input.payload }),
    scope: Object.freeze({ ...input.scope }),
    dedupeKey: input.dedupeKey,
    scopedDedupeKey: `scoped:${input.dedupeKey}`,
    status: "queued",
    attempts: 0,
    leaseGeneration: 0,
    maxAttempts: input.maxAttempts,
    createdAt: 1_000,
    updatedAt: 1_000,
  }));
  return {
    readPort: { readCommittedActiveRecords, readEvidenceFacts, readTreeFacts },
    workMemoryGraph: { upsertWorkMemoryGraph },
    repository: { enqueue },
    spies: { readCommittedActiveRecords, readEvidenceFacts, readTreeFacts, upsertWorkMemoryGraph, enqueue },
  };
}

describe("native committed active derivation composition", () => {
  test("按 receipt IDs + 完整 9D scope 回读，并确保 Entity/Work Graph 与三类 tree", async () => {
    const deps = dependencies();
    const derive = createNativeCommittedActiveDerivation(deps);
    const signal = new AbortController().signal;

    await derive({
      scope: Object.freeze({
        tenantId: scope.tenantId,
        userId: scope.userId,
        appId: scope.appId,
        projectId: scope.projectId,
        agentId: scope.agentId,
        namespace: scope.namespace,
        visibility: "workspace",
      }),
      context: Object.freeze({ workspaceId: "workspace-a", sessionId: "session-a" }),
      activeMemoryIds: Object.freeze(["memory-a"]),
      signal,
    });

    expect(deps.spies.readCommittedActiveRecords).toHaveBeenCalledWith({
      activeMemoryIds: ["memory-a"],
      scope,
      signal,
    });
    expect(deps.spies.upsertWorkMemoryGraph).toHaveBeenCalledTimes(1);
    expect(deps.spies.enqueue).toHaveBeenCalledTimes(4);
    expect(deps.spies.enqueue.mock.calls.map(([request]) => request)).toEqual([
      expect.objectContaining({
        type: "extract_graph",
        dedupeKey: expect.stringMatching(/^extract_graph:/),
        payload: {
          scope,
          graphKind: "entity",
          activeMemoryId: "memory-a",
          evidenceId: "evidence-a",
        },
      }),
      expect.objectContaining({
        type: "build_tree",
        dedupeKey: expect.stringMatching(/^build_tree:/),
        payload: expect.objectContaining({ treeType: "source" }),
      }),
      expect.objectContaining({
        type: "build_tree",
        dedupeKey: expect.stringMatching(/^build_tree:/),
        payload: expect.objectContaining({ treeType: "topic" }),
      }),
      expect.objectContaining({
        type: "build_tree",
        dedupeKey: expect.stringMatching(/^build_tree:/),
        payload: expect.objectContaining({ treeType: "global" }),
      }),
    ]);
    const graphPayload = deps.spies.enqueue.mock.calls[0]?.[0].payload;
    expect(graphPayload).not.toHaveProperty("text");
    expect(graphPayload).not.toHaveProperty("chunkId");
    expect(graphPayload).not.toHaveProperty("metadata");
    expect(graphPayload).not.toHaveProperty("entities");
    expect(graphPayload).not.toHaveProperty("relations");
  });

  test("replay 使用相同 tree job identity；enqueue 结果不匹配时 fail-closed", async () => {
    const deps = dependencies();
    const derive = createNativeCommittedActiveDerivation(deps);
    const input = {
      scope: {
        tenantId: scope.tenantId, userId: scope.userId, appId: scope.appId,
        projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace,
        visibility: "workspace" as const,
      },
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      activeMemoryIds: ["memory-a"],
      signal: new AbortController().signal,
    };

    await derive(input);
    await derive(input);
    expect(deps.spies.enqueue.mock.calls.slice(4).map(([request]) => request))
      .toEqual(deps.spies.enqueue.mock.calls.slice(0, 4).map(([request]) => request));

    deps.spies.enqueue.mockResolvedValueOnce({
      id: "other-job",
      type: "build_tree",
      payload: {},
      scope: {
        tenantId: "tenant-a", userId: "user-a", appId: "mengshu",
        projectId: "project-a", agentId: "agent-a", namespace: "memory",
        visibility: "workspace",
      },
      dedupeKey: "other",
      scopedDedupeKey: "scoped:other",
      status: "queued",
      attempts: 0,
      leaseGeneration: 0,
      maxAttempts: 3,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    await expect(derive(input)).rejects.toThrow(/derivation|durable|job/i);
  });

  test("committed active graph/tree facts unavailable 时 fail-closed 以保留 durable retry", async () => {
    const deps = dependencies();
    deps.readPort.readTreeFacts.mockResolvedValueOnce([]);
    const derive = createNativeCommittedActiveDerivation(deps);

    await expect(derive({
      scope: {
        tenantId: scope.tenantId, userId: scope.userId, appId: scope.appId,
        projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace,
        visibility: "workspace",
      },
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      activeMemoryIds: ["memory-a"],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "ACTIVE_MEMORY_DERIVATION_COMPOSITION_INVALID",
    });
  });

  test("committed active 未真正准入 source tree 时不得伪造派生成功", async () => {
    const deps = dependencies();
    deps.readPort.readCommittedActiveRecords.mockResolvedValueOnce([{
      ...active,
      valueScore: 0.54,
    }]);
    const derive = createNativeCommittedActiveDerivation(deps);

    await expect(derive({
      scope: {
        tenantId: scope.tenantId, userId: scope.userId, appId: scope.appId,
        projectId: scope.projectId, agentId: scope.agentId, namespace: scope.namespace,
        visibility: "workspace",
      },
      context: { workspaceId: "workspace-a", sessionId: "session-a" },
      activeMemoryIds: ["memory-a"],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "ACTIVE_MEMORY_DERIVATION_COMPOSITION_INVALID",
    });
    expect(deps.spies.enqueue).toHaveBeenCalledTimes(1);
  });
});
