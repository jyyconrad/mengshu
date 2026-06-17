import { describe, expect, test } from "vitest";
import { InMemoryGraphRepository } from "./repository.js";
import { GraphQueryService } from "./query.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

function entity(id: string, canonicalName: string, hotness = 1): GraphEntityRecord {
  return {
    id,
    scope,
    canonicalName,
    displayName: canonicalName,
    type: "project",
    aliases: [canonicalName],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: 1710000000000,
    hotness,
    queryHits30d: 0,
    status: "active",
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
    metadata: {},
  };
}

function relation(id: string, subjectId: string, objectId: string, evidenceChunkIds: string[]): GraphRelationRecord {
  return {
    id,
    scope,
    subjectId,
    predicate: "uses",
    objectId,
    confidence: 0.8,
    evidenceChunkIds,
    evidenceCount: evidenceChunkIds.length,
    firstSeenAt: 1710000000000,
    lastSeenAt: 1710000000000,
    status: "active",
    sourceKinds: ["scan"],
    metadata: {},
  };
}

describe("GraphQueryService", () => {
  test("looks up entity and traverses relations with evidence chunks", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertEntities([
      entity("project", "mengshu", 10),
      entity("tool", "postgresql", 5),
      entity("file", "src/index.ts", 3),
    ]);
    await repository.upsertRelations([
      relation("rel-1", "project", "tool", ["chunk-1"]),
      relation("rel-2", "tool", "file", ["chunk-2"]),
    ]);
    const service = new GraphQueryService(repository);

    const result = await service.query({
      scope,
      query: "mengshu",
      depth: 2,
    });

    expect(result.entities.map((item) => item.id)).toEqual(["project", "tool", "file"]);
    expect(result.relations.map((item) => item.id)).toEqual(["rel-1", "rel-2"]);
    expect(result.evidenceChunkIds).toEqual(["chunk-1", "chunk-2"]);
  });
});
