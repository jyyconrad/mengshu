import { describe, expect, test, vi } from "vitest";

import type { MemoryScope } from "../packages/core/src/domain/types.js";
import type {
  ActiveMemoryEvidenceFact,
  ActiveMemoryTreeFacts,
} from "../packages/core/src/graph/active-memory-derivation.js";
import type { WriteMemoryRecord } from "../packages/core/src/service/write-kernel.js";
import {
  orchestrateCommittedActiveMemoryDerivations,
  type NativeActiveDerivationDependencies,
} from "./native-active-derivation-orchestrator.js";

type ContentRecord = Extract<WriteMemoryRecord, { mutation: "content" }>;

const scope: MemoryScope = {
  tenantId: "tenant-a",
  userId: "user-a",
  appId: "mengshu",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "memory",
  workspaceId: "workspace-a",
  sessionId: "session-a",
  visibility: "workspace",
};

function record(
  id: string,
  route: ContentRecord["route"] = "active",
  overrides: Partial<ContentRecord> = {},
): ContentRecord {
  return {
    id,
    commandType: "saveExplicit",
    mutation: "content",
    scope,
    text: `memory ${id}`,
    metadata: {},
    vector: [0.1, 0.2],
    route,
    valueScore: 0.92,
    importance: 0.9,
    kind: "decision",
    semanticType: "rules",
    confidence: 0.8,
    provenance: { source: "user", sourceId: "message-a", createdAt: 1_000 },
    evidenceIds: [`evidence-${id}`],
    governance: { candidate: {}, admissionReason: "fixture" },
    createdAt: 1_000,
    ...overrides,
  };
}

function evidenceFact(evidenceId: string): ActiveMemoryEvidenceFact {
  return {
    evidenceId,
    scope,
    evidenceKind: "message",
    label: `evidence ${evidenceId}`,
    metadata: { source: "conversation" },
    createdAt: 900,
  };
}

function treeFacts(memoryId: string): ActiveMemoryTreeFacts {
  return {
    memoryId,
    scope,
    evidenceId: `evidence-${memoryId}`,
    sourceId: "conversation-a",
    entityIds: ["entity-a"],
    scopeVisibility: "workspace",
    riskFlags: [],
    topicLabels: ["Runtime Architecture"],
    topicHotnessEligible: true,
    explicitGlobal: false,
    isWorkspaceRule: true,
  };
}

function dependencies(
  overrides: Partial<NativeActiveDerivationDependencies> = {},
): NativeActiveDerivationDependencies {
  return {
    readEvidenceFacts: vi.fn(async ({ records }) =>
      records.flatMap((item: ContentRecord) => item.evidenceIds.map(evidenceFact))),
    readTreeFacts: vi.fn(async ({ records }) =>
      records.map((item: ContentRecord) => treeFacts(item.id))),
    upsertWorkMemoryGraph: vi.fn(async () => undefined),
    enqueueEntityGraphTarget: vi.fn(async () => "job-entity-graph"),
    enqueueTreeTarget: vi.fn(async (request) => `job-${request.target.treeType}`),
    ...overrides,
  };
}

describe("native committed active derivation orchestrator", () => {
  test("只读取并派生 receipt activeMemoryIds 中真实 route=active 的完整记录", async () => {
    const active = record("active-a");
    const deps = dependencies();

    const result = await orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [
        active,
        record("candidate-a", "candidate"),
        record("lookup-a", "lookup_only"),
        record("evidence-a", "evidence_only"),
        record("active-not-committed"),
      ],
      activeMemoryIds: ["active-a", "candidate-a", "lookup-a", "evidence-a", "missing-a"],
      signal: new AbortController().signal,
    });

    expect(result.activeMemoryIds).toEqual(["active-a"]);
    expect(deps.readEvidenceFacts).toHaveBeenCalledWith(expect.objectContaining({
      memoryIds: ["active-a"],
      records: [active],
    }));
    expect(deps.readTreeFacts).toHaveBeenCalledWith(expect.objectContaining({
      memoryIds: ["active-a"],
      records: [active],
    }));
    expect(deps.upsertWorkMemoryGraph).toHaveBeenCalledTimes(1);
    expect(deps.enqueueEntityGraphTarget).toHaveBeenCalledTimes(1);
    expect(deps.enqueueTreeTarget).toHaveBeenCalledTimes(3);
    expect(result.derivations).toEqual([
      {
        memoryId: "active-a",
        entityGraph: {
          status: "ensured",
          targets: [{
            evidenceId: "evidence-active-a",
            dedupeKey: expect.stringMatching(/^extract_graph:/),
            jobId: "job-entity-graph",
          }],
        },
        workMemoryGraph: { status: "upserted" },
        tree: {
          status: "ensured",
          admitted: true,
          targets: [
            expect.objectContaining({ treeType: "source", jobId: "job-source" }),
            expect.objectContaining({ treeType: "topic", jobId: "job-topic" }),
            expect.objectContaining({ treeType: "global", jobId: "job-global" }),
          ],
        },
      },
    ]);
  });

  test("projection unavailable 显式返回，且不伪造 graph 或 tree 副作用", async () => {
    const active = record("active-a", "active", {
      evidenceIds: [],
      semanticType: undefined,
    });
    const deps = dependencies({
      readEvidenceFacts: vi.fn(async () => []),
      readTreeFacts: vi.fn(async () => []),
    });

    const result = await orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [active],
      activeMemoryIds: [active.id],
      signal: new AbortController().signal,
    });

    expect(result.derivations).toEqual([{
      memoryId: active.id,
      entityGraph: { status: "unavailable", reason: "evidence_ids_missing" },
      workMemoryGraph: { status: "unavailable", reason: "evidence_ids_missing" },
      tree: { status: "unavailable", reason: "semantic_type_missing" },
    }]);
    expect(deps.upsertWorkMemoryGraph).not.toHaveBeenCalled();
    expect(deps.enqueueEntityGraphTarget).not.toHaveBeenCalled();
    expect(deps.enqueueTreeTarget).not.toHaveBeenCalled();
  });

  test("父 job receipt replay 使用相同 graph batch、native payload 与 scope-bound dedupe", async () => {
    const active = record("active-a");
    const calls: unknown[] = [];
    const deps = dependencies({
      enqueueTreeTarget: vi.fn(async (request) => {
        calls.push(request);
        return `job-${request.target.treeType}`;
      }),
    });
    const input = {
      records: [active],
      activeMemoryIds: [active.id],
      signal: new AbortController().signal,
    };

    const first = await orchestrateCommittedActiveMemoryDerivations(deps, input);
    const replay = await orchestrateCommittedActiveMemoryDerivations(deps, input);

    expect(replay).toEqual(first);
    expect(vi.mocked(deps.upsertWorkMemoryGraph).mock.calls[1])
      .toEqual(vi.mocked(deps.upsertWorkMemoryGraph).mock.calls[0]);
    expect(calls.slice(3)).toEqual(calls.slice(0, 3));
    for (const request of calls as Array<{
      dedupeKey: string;
      payload: Record<string, unknown>;
      target: { idempotencyKey: string };
    }>) {
      expect(request.dedupeKey).toMatch(/^build_tree:[a-f0-9]{64}$/);
      expect(request.payload).toMatchObject({
        scope,
        traceId: active.id,
        leaf: {
          id: active.id,
          chunkId: `evidence-${active.id}`,
          entityIds: ["entity-a"],
        },
        targetIdempotencyKey: request.target.idempotencyKey,
      });
    }
  });

  test("tree target 部分 enqueue 失败后抛错，父 job replay 以同一 dedupe 修补缺失 target", async () => {
    const active = record("active-a");
    const ensured = new Set<string>();
    let failTopicOnce = true;
    const enqueue = vi.fn(async (request: Parameters<
      NativeActiveDerivationDependencies["enqueueTreeTarget"]
    >[0]) => {
      if (request.target.treeType === "topic" && failTopicOnce) {
        failTopicOnce = false;
        throw new Error("temporary enqueue failure");
      }
      ensured.add(request.dedupeKey);
      return `job-${request.target.treeType}`;
    });
    const deps = dependencies({ enqueueTreeTarget: enqueue });
    const input = {
      records: [active],
      activeMemoryIds: [active.id],
      signal: new AbortController().signal,
    };

    await expect(orchestrateCommittedActiveMemoryDerivations(deps, input))
      .rejects.toThrow("temporary enqueue failure");
    await expect(orchestrateCommittedActiveMemoryDerivations(deps, input))
      .resolves.toMatchObject({
        derivations: [{ tree: { status: "ensured", targets: [{}, {}, {}] } }],
      });

    const sourceCalls = enqueue.mock.calls
      .map(([request]) => request)
      .filter((request) => request.target.treeType === "source");
    expect(sourceCalls).toHaveLength(2);
    expect(sourceCalls[1]!.dedupeKey).toBe(sourceCalls[0]!.dedupeKey);
    expect(ensured).toHaveLength(3);
    expect(deps.upsertWorkMemoryGraph).toHaveBeenCalledTimes(2);
  });

  test("D-03 high-importance routing preserves global target without explicit global scope", async () => {
    const active = record("active-a");
    const deps = dependencies({
      readTreeFacts: vi.fn(async () => [{
        ...treeFacts(active.id),
        explicitGlobal: false,
        isWorkspaceRule: false,
      }]),
    });

    await orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [active],
      activeMemoryIds: [active.id],
      signal: new AbortController().signal,
    });

    expect(vi.mocked(deps.enqueueTreeTarget).mock.calls.map(([request]) => request.target.treeType))
      .toEqual(["source", "topic", "global"]);
  });

  test("没有 committed active record 时不读取 facts，也不触发任何派生副作用", async () => {
    const deps = dependencies();

    await expect(orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [record("candidate-a", "candidate"), record("lookup-a", "lookup_only")],
      activeMemoryIds: ["candidate-a", "lookup-a"],
      signal: new AbortController().signal,
    })).resolves.toEqual({ activeMemoryIds: [], derivations: [] });

    expect(deps.readEvidenceFacts).not.toHaveBeenCalled();
    expect(deps.readTreeFacts).not.toHaveBeenCalled();
    expect(deps.upsertWorkMemoryGraph).not.toHaveBeenCalled();
    expect(deps.enqueueEntityGraphTarget).not.toHaveBeenCalled();
    expect(deps.enqueueTreeTarget).not.toHaveBeenCalled();
  });

  test("执行前 abort 原样保留 AbortError，零读取、零副作用", async () => {
    const deps = dependencies();
    const controller = new AbortController();
    const abort = new DOMException("stop", "AbortError");
    controller.abort(abort);

    await expect(orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [record("active-a")],
      activeMemoryIds: ["active-a"],
      signal: controller.signal,
    })).rejects.toBe(abort);

    expect(deps.readEvidenceFacts).not.toHaveBeenCalled();
    expect(deps.readTreeFacts).not.toHaveBeenCalled();
    expect(deps.upsertWorkMemoryGraph).not.toHaveBeenCalled();
    expect(deps.enqueueEntityGraphTarget).not.toHaveBeenCalled();
    expect(deps.enqueueTreeTarget).not.toHaveBeenCalled();
  });

  test("enqueue 未返回安全 durable job id 时 fail-closed，不伪造 ensure 回执", async () => {
    const deps = dependencies({
      enqueueTreeTarget: vi.fn(async () => "bad job id"),
    });

    await expect(orchestrateCommittedActiveMemoryDerivations(deps, {
      records: [record("active-a")],
      activeMemoryIds: ["active-a"],
      signal: new AbortController().signal,
    })).rejects.toMatchObject({
      code: "ACTIVE_MEMORY_DERIVATION_ORCHESTRATION_INVALID",
    });
  });
});
