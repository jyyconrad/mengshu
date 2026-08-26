import { describe, expect, test } from "vitest";
import type { MemoryScope } from "../domain/types.js";
import { bufferId, InMemoryTreeRepository } from "./buffer.js";
import {
  createTreeFanOutHandler,
  executeTreeFanOut,
  normalizeTopicLabel,
  planTreeFanOut,
  type TreeFanOutInput,
} from "./tree-fan-out.js";
import type { TreeBuffer, TreeRepository } from "./types.js";

const scope: MemoryScope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  sessionId: "session-1",
  visibility: "private",
};

function input(overrides: Partial<TreeFanOutInput> = {}): TreeFanOutInput {
  return {
    scope,
    leaf: {
      id: "leaf-1",
      scope,
      chunkId: "chunk-1",
      sourceId: "source-1",
      entityIds: ["entity-1"],
      importance: 0.8,
      eventAt: Date.parse("2026-08-12T02:03:04.000Z"),
      createdAt: Date.parse("2026-08-12T02:03:04.000Z"),
      text: "PostgreSQL migration uses a fenced transaction.",
      tokenCount: 12,
    },
    routing: {
      valueScore: 0.75,
      importance: 0.8,
      semanticType: "experience",
      topicLabels: [" PostgreSQL Migration ", "postgresql-migration"],
      topicHotnessEligible: true,
      scopeVisibility: "project",
      riskFlags: [],
    },
    ...overrides,
  };
}

describe("tree fan-out contract", () => {
  test("normalizes D-18/D-21 topic labels instead of using entity ids", () => {
    expect(normalizeTopicLabel(" `PostgreSQL / 迁移` ")).toBe("postgresql-迁移");
    expect(normalizeTopicLabel(`  ${"A".repeat(100)}  `)).toHaveLength(80);

    const plan = planTreeFanOut(input({
      topicAliases: { "postgresql-migration": "Database Migration" },
    }));

    expect(plan.targets.map((target) => [target.treeType, target.treeKey])).toEqual([
      ["source", "source-1"],
      ["topic", "database-migration"],
    ]);
    expect(plan.targets[1].treeKey).not.toBe("entity-1");
  });

  test("D-03 rejects leaves below 0.55 and keeps 0.55-0.70 in source only", () => {
    expect(planTreeFanOut(input({
      leaf: { ...input().leaf, importance: 1 },
      routing: {
        valueScore: 0.549,
        importance: 1,
        semanticType: "experience",
        topicLabels: ["ignored"],
        topicHotnessEligible: true,
        scopeVisibility: "project",
        riskFlags: [],
        explicitGlobal: true,
      },
    })).targets).toEqual([]);

    const middle = planTreeFanOut(input({
      leaf: { ...input().leaf, importance: 1 },
      routing: {
        valueScore: 0.69,
        importance: 1,
        semanticType: "experience",
        topicLabels: ["ignored"],
        topicHotnessEligible: true,
        scopeVisibility: "project",
        riskFlags: [],
        explicitGlobal: true,
      },
    }));
    expect(middle.targets.map((target) => target.treeType)).toEqual(["source"]);
  });

  test(">=0.70 fans out to eligible source/topic/global targets with deterministic keys", () => {
    const plan = planTreeFanOut(input({
      leaf: { ...input().leaf, importance: 0.9 },
      routing: {
        valueScore: 0.7,
        importance: 0.9,
        semanticType: "rules",
        topicLabels: ["Deploy Rules"],
        topicHotnessEligible: true,
        scopeVisibility: "workspace",
        isWorkspaceRule: true,
        riskFlags: [],
      },
    }));

    expect(plan.decision.treeTypes).toEqual(["source", "topic", "global"]);
    expect(plan.targets.map((target) => [target.treeType, target.treeKey])).toEqual([
      ["source", "source-1"],
      ["topic", "deploy-rules"],
      ["global", "2026-08-12"],
    ]);
    expect(new Set(plan.targets.map((target) => target.idempotencyKey)).size).toBe(3);
    expect(plan.evidenceChunkIds).toEqual(["chunk-1"]);
  });

  test("profile skips topic and sensitive project/session evidence never expands to global", () => {
    const plan = planTreeFanOut(input({
      leaf: { ...input().leaf, importance: 0.95 },
      routing: {
        valueScore: 0.9,
        importance: 0.95,
        semanticType: "profile",
        topicLabels: ["Private Preference"],
        topicHotnessEligible: true,
        scopeVisibility: "project",
        riskFlags: ["sensitive"],
      },
    }));
    expect(plan.targets.map((target) => target.treeType)).toEqual(["source"]);
  });

  test("requires a real evidence reference and normalized topic labels", () => {
    expect(() => planTreeFanOut(input({
      leaf: { ...input().leaf, chunkId: "" },
    }))).toThrow("evidence chunkId");
    expect(() => planTreeFanOut(input({
      routing: { ...input().routing, topicLabels: ["---"] },
    }))).toThrow("topic label");
  });

  test("topic fan-out fails closed until the hotness lifecycle admits the tree", () => {
    const plan = planTreeFanOut(input({
      routing: { ...input().routing, topicHotnessEligible: false },
    }));
    expect(plan.targets.map((target) => target.treeType)).toEqual(["source"]);
  });

  test("global fan-out can be explicitly gated without disabling source or topic", () => {
    const plan = planTreeFanOut(input({
      leaf: { ...input().leaf, importance: 0.95 },
      routing: {
        ...input().routing,
        importance: 0.95,
        globalHotnessEligible: false,
      },
    }));

    expect(plan.targets.map((target) => target.treeType)).toEqual(["source", "topic"]);
    expect(plan.decision.treeTypes).toEqual(["source", "topic"]);
  });

  test("prompt injection evidence is rejected before any tree target is planned", () => {
    const plan = planTreeFanOut(input({
      routing: { ...input().routing, riskFlags: ["prompt_injection"] },
    }));
    expect(plan.admitted).toBe(false);
    expect(plan.targets).toEqual([]);
  });

  test("workspace rule claims must match the semantic type and scope", () => {
    expect(() => planTreeFanOut(input({
      routing: { ...input().routing, isWorkspaceRule: true },
    }))).toThrow("workspace rule context");
  });

  test("executor replay does not duplicate leaves or token counts", async () => {
    const repository = new InMemoryTreeRepository();
    const first = await executeTreeFanOut(repository, input(), { maxLeafCount: 20 });
    const replay = await executeTreeFanOut(repository, input(), { maxLeafCount: 20 });

    expect(first.targets.map((target) => target.status)).toEqual(["applied", "applied"]);
    expect(replay.targets.map((target) => target.status)).toEqual(["replayed", "replayed"]);
    for (const target of first.plan.targets) {
      const buffer = await repository.getBuffer(bufferId(scope, target.treeType, target.treeKey, 0));
      expect(buffer?.leafIds).toEqual(["leaf-1"]);
      expect(buffer?.tokenCount).toBe(12);
    }
  });

  test("same leaf id with changed evidence is a fingerprint conflict, not a replay", async () => {
    const repository = new InMemoryTreeRepository();
    await executeTreeFanOut(repository, input());
    await expect(executeTreeFanOut(repository, input({
      leaf: { ...input().leaf, chunkId: "chunk-changed" },
    }))).rejects.toThrow("fingerprint conflict");
  });

  test("seal receipts and summaries retain evidence across replay", async () => {
    const repository = new InMemoryTreeRepository();
    const first = await executeTreeFanOut(repository, input(), { maxLeafCount: 1 });
    const replay = await executeTreeFanOut(repository, input(), { maxLeafCount: 1 });

    expect(first.targets.every((target) => target.sealed && target.status === "applied")).toBe(true);
    expect(replay.targets.every((target) => target.sealed && target.status === "replayed")).toBe(true);
    for (const target of replay.targets) {
      expect(target.evidenceChunkIds).toEqual(["chunk-1"]);
      const node = await repository.getSummary(target.nodeId!);
      expect(node?.leafIds).toEqual(["leaf-1"]);
      expect(node?.evidenceChunkIds).toEqual(["chunk-1"]);
    }
  });

  test("partial failure converges on job replay", async () => {
    const backing = new InMemoryTreeRepository();
    let failed = false;
    const repository: TreeRepository = {
      upsertLeaf: backing.upsertLeaf.bind(backing),
      getLeaf: backing.getLeaf.bind(backing),
      listLeaves: backing.listLeaves.bind(backing),
      getBuffer: backing.getBuffer.bind(backing),
      deleteBuffer: backing.deleteBuffer.bind(backing),
      upsertSummary: backing.upsertSummary.bind(backing),
      getSummary: backing.getSummary.bind(backing),
      listSummaries: backing.listSummaries.bind(backing),
      getParent: backing.getParent.bind(backing),
      upsertBuffer: async (buffer: TreeBuffer) => {
        if (!failed && buffer.treeType === "topic") {
          failed = true;
          throw new Error("transient topic write failure");
        }
        await backing.upsertBuffer(buffer);
      },
    };

    await expect(executeTreeFanOut(repository, input())).rejects.toThrow("transient");
    const replay = await executeTreeFanOut(repository, input());
    expect(replay.targets.map((target) => target.status)).toEqual(["replayed", "applied"]);
  });

  test("job handler exposes the fan-out contract to a worker", async () => {
    const repository = new InMemoryTreeRepository();
    const handler = createTreeFanOutHandler({ repository, policy: { maxLeafCount: 20 } });
    const result = await handler({
      id: "job-1",
      type: "build_tree",
      payload: input() as unknown as Record<string, unknown>,
      dedupeKey: "build_tree_fan_out:leaf-1",
      status: "running",
      attempts: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(result).toMatchObject({
      admitted: true,
      targetCount: 2,
      evidenceChunkIds: ["chunk-1"],
    });
    await expect(handler({
      id: "job-2",
      type: "extract_graph",
      payload: input() as unknown as Record<string, unknown>,
      dedupeKey: "extract_graph:leaf-1",
      status: "running",
      attempts: 1,
      createdAt: 1,
      updatedAt: 1,
    })).rejects.toThrow("requires a build_tree job");
  });
});
