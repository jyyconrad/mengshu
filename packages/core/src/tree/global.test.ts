import { describe, expect, test } from "vitest";
import { InMemoryTreeRepository } from "./buffer.js";
import { buildDailyDigest, dayKey } from "./global.js";
import type { TreeLeaf } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function leaf(id: string, text: string): TreeLeaf {
  return {
    id,
    scope,
    chunkId: `chunk-${id}`,
    sourceId: "session:abc",
    entityIds: [],
    importance: 0.5,
    eventAt: 1710000000000,
    createdAt: 1710000000000,
    text,
    tokenCount: 4,
  };
}

describe("global memory tree", () => {
  test("computes UTC day key", () => {
    expect(dayKey(Date.parse("2026-06-06T10:20:30.000Z"))).toBe("2026-06-06");
  });

  test("builds daily digest summary node", async () => {
    const repository = new InMemoryTreeRepository();

    const node = await buildDailyDigest(
      repository,
      scope,
      "2026-06-06",
      [leaf("1", "first event"), leaf("2", "second event")],
      1710000010000,
    );

    expect(node).toMatchObject({
      treeType: "global",
      treeKey: "2026-06-06",
      title: "Daily Digest 2026-06-06",
      status: "sealed",
      evidenceChunkIds: ["chunk-1", "chunk-2"],
    });
    await expect(repository.listSummaries({ scope, treeType: "global", treeKey: "2026-06-06" })).resolves.toEqual([node]);
  });
});
