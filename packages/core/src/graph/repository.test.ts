import { describe, expect, test } from "vitest";
import { InMemoryGraphRepository } from "./repository.js";
import type { GraphEntityRecord, GraphRelationRecord } from "./types.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

const otherScope = {
  ...scope,
  userId: "user-2",
};

function entity(id: string, canonicalName: string, recordScope = scope): GraphEntityRecord {
  return {
    id,
    scope: recordScope,
    canonicalName,
    displayName: canonicalName,
    type: "project",
    aliases: [canonicalName],
    mentionCount: 1,
    mentionCount30d: 1,
    distinctSourceCount: 1,
    lastSeenAt: 1710000000000,
    hotness: 2,
    queryHits30d: 0,
    status: "active",
    createdAt: 1710000000000,
    updatedAt: 1710000000000,
    metadata: {},
  };
}

function relation(id: string, subjectId: string, objectId: string): GraphRelationRecord {
  return {
    id,
    scope,
    subjectId,
    predicate: "uses",
    objectId,
    confidence: 0.7,
    evidenceChunkIds: ["chunk-1"],
    evidenceCount: 1,
    firstSeenAt: 1710000000000,
    lastSeenAt: 1710000000000,
    status: "active",
    sourceKinds: ["scan"],
    metadata: {},
  };
}

describe("InMemoryGraphRepository", () => {
  test("upserts entities and isolates by scope", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertEntities([
      entity("entity-1", "mengshu"),
      entity("entity-1", "mengshu"),
      entity("entity-2", "mengshu", otherScope),
    ]);

    const results = await repository.findEntities({ scope, query: "mengshu" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "entity-1",
      mentionCount: 2,
    });
  });

  test("upserts relations and merges evidence", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertRelations([
      relation("relation-1", "project", "postgres"),
      { ...relation("relation-1", "project", "postgres"), evidenceChunkIds: ["chunk-2"], confidence: 0.9 },
    ]);

    const results = await repository.findRelations({ scope, entityId: "project" });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      confidence: 0.9,
      evidenceChunkIds: ["chunk-1", "chunk-2"],
      evidenceCount: 2,
    });
  });
});
