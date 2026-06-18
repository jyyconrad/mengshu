import { describe, expect, test } from "vitest";
import { appendLeafToBuffer, bufferId, InMemoryTreeRepository } from "./buffer.js";
import type { TreeLeaf } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function leaf(id: string, text = "memory tree event"): TreeLeaf {
  return {
    id,
    scope,
    chunkId: `chunk-${id}`,
    sourceId: "file:/docs/guide.md",
    entityIds: ["entity-1"],
    importance: 0.8,
    eventAt: 1710000000000,
    createdAt: 1710000000000,
    text,
    tokenCount: 4,
  };
}

describe("appendLeafToBuffer", () => {
  test("appends leaves to deterministic source buffer and detects seal threshold", async () => {
    const repository = new InMemoryTreeRepository();
    const first = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "file:/docs/guide.md",
      leaf: leaf("1"),
      now: 1710000000000,
    }, { maxLeafCount: 2 });
    const second = await appendLeafToBuffer(repository, {
      scope,
      treeType: "source",
      treeKey: "file:/docs/guide.md",
      leaf: leaf("2"),
      now: 1710000001000,
    }, { maxLeafCount: 2 });

    expect(first.shouldSeal).toBe(false);
    expect(second.shouldSeal).toBe(true);
    expect(second.buffer.id).toBe(bufferId(scope, "source", "file:/docs/guide.md", 0));
    expect(second.buffer.leafIds).toEqual(["1", "2"]);
  });
});
