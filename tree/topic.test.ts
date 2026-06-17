import { describe, expect, test } from "vitest";
import type { GraphEntityRecord } from "../graph/types.js";
import { InMemoryTreeRepository } from "./buffer.js";
import { computeHotness, recencyDecay, routeLeafToTopicTree, shouldCreateTopicTree } from "./topic.js";
import { SCORING_WEIGHTS_V1 } from "../processing/scoring-weights.js";
import type { TreeLeaf } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function entity(overrides: Partial<GraphEntityRecord> = {}): GraphEntityRecord {
  return {
    id: "entity-hot",
    scope,
    canonicalName: "mengshu",
    displayName: "mengshu",
    type: "project",
    aliases: ["mengshu"],
    mentionCount: 10,
    mentionCount30d: 10,
    distinctSourceCount: 4,
    lastSeenAt: 1710000000000,
    hotness: 0,
    graphCentrality: 0.5,
    queryHits30d: 1,
    status: "active",
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
    metadata: {},
    ...overrides,
  };
}

const leaf: TreeLeaf = {
  id: "leaf-1",
  scope,
  chunkId: "chunk-1",
  sourceId: "file:/docs/guide.md",
  entityIds: ["entity-hot"],
  importance: 0.8,
  eventAt: 1710000000000,
  createdAt: 1710000000000,
  text: "topic event",
  tokenCount: 3,
};

describe("topic tree policy", () => {
  test("computes deterministic hotness with recency decay", () => {
    expect(recencyDecay(1710000000000, 1710000000000)).toBe(1);
    expect(computeHotness(entity(), 1710000000000)).toBeGreaterThan(6);
    expect(shouldCreateTopicTree(entity(), 1710000000000)).toBe(true);
    expect(shouldCreateTopicTree(entity({ mentionCount30d: 0, distinctSourceCount: 0, queryHits30d: 0, graphCentrality: 0 }), 1710000000000)).toBe(false);
  });

  test("recencyDecay follows the §4.4 piecewise-linear forgetting curve", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 1710000000000;
    // 无 lastSeenAt -> 0
    expect(recencyDecay(now, undefined)).toBe(0);
    // <= 1 天平台：系数 1.0
    expect(recencyDecay(now, now)).toBe(1);
    expect(recencyDecay(now, now - 1 * DAY)).toBe(1);
    // 1~7 天线性插值：4 天处应在 1.0 -> 0.5 中点
    expect(recencyDecay(now, now - 4 * DAY)).toBeCloseTo(0.75, 6);
    // 7 天处 = 0.5
    expect(recencyDecay(now, now - 7 * DAY)).toBeCloseTo(0.5, 6);
    // 7~30 天线性插值：中点 (18.5 天) 处约 0.25
    expect(recencyDecay(now, now - 18.5 * DAY)).toBeCloseTo(0.25, 6);
    // >= 30 天 -> 0
    expect(recencyDecay(now, now - 30 * DAY)).toBeCloseTo(0, 6);
    expect(recencyDecay(now, now - 90 * DAY)).toBe(0);
  });

  test("hotness sums all five terms using centralized SCORING_WEIGHTS_V1", () => {
    const w = SCORING_WEIGHTS_V1.hotness;
    const now = 1710000000000;
    // lastSeenAt = now -> recency = 1.0（平台）
    const e = entity({ mentionCount30d: 10, distinctSourceCount: 4, graphCentrality: 0.5, queryHits30d: 1, lastSeenAt: now });
    const expected =
      w.ln_mention_coeff * Math.log(10 + 1) +
      w.distinct_source_coeff * 4 +
      1.0 +
      w.centrality_coeff * 0.5 +
      w.query_hits_coeff * 1;
    expect(computeHotness(e, now)).toBeCloseTo(expected, 6);
  });

  test("recencyDecay accepts a custom bucket table", () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = 1710000000000;
    const buckets = [
      [2, 1.0],
      [10, 0.0],
    ] as const;
    expect(recencyDecay(now, now - 2 * DAY, buckets)).toBe(1);
    expect(recencyDecay(now, now - 6 * DAY, buckets)).toBeCloseTo(0.5, 6);
    expect(recencyDecay(now, now - 20 * DAY, buckets)).toBe(0);
  });

  test("routes hot entity leaves into topic buffers only", async () => {
    const repository = new InMemoryTreeRepository();
    const routed = await routeLeafToTopicTree(
      repository,
      leaf,
      [entity(), entity({ id: "cold", mentionCount30d: 0, distinctSourceCount: 0, queryHits30d: 0, graphCentrality: 0 })],
      {
        valueScore: 0.75,        // D-03: >= 0.70 才进 topic tree
        importance: 0.8,
        hasTopicLabel: true,
        semanticType: "experience",
      },
      1710000000000,
      { maxLeafCount: 1 },
    );

    expect(routed).toHaveLength(1);
    expect(routed[0].buffer.treeType).toBe("topic");
    expect(routed[0].buffer.treeKey).toBe("entity-hot");
    expect(routed[0].shouldSeal).toBe(true);
  });

  test("D-03: valueScore < 0.70 不路由到 topic tree（即使 entity hot）", async () => {
    const repository = new InMemoryTreeRepository();
    const routed = await routeLeafToTopicTree(
      repository,
      leaf,
      [entity()], // hot entity
      {
        valueScore: 0.65,        // < 0.70，不满足 topic tree 门槛
        importance: 0.8,
        hasTopicLabel: true,
        semanticType: "experience",
      },
      1710000000000,
    );

    expect(routed).toHaveLength(0); // 0.55-0.70 只进 source tree
  });

  test("D-03: valueScore >= 0.70 且 entity hot 才路由到 topic tree", async () => {
    const repository = new InMemoryTreeRepository();
    const routed = await routeLeafToTopicTree(
      repository,
      leaf,
      [entity()],
      {
        valueScore: 0.75,        // >= 0.70，满足 topic tree 门槛
        importance: 0.8,
        hasTopicLabel: true,
        semanticType: "experience",
      },
      1710000000000,
    );

    expect(routed).toHaveLength(1);
    expect(routed[0].buffer.treeType).toBe("topic");
  });
});
