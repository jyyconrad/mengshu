import { describe, expect, test } from "vitest";
import { extractGraph } from "./extractor.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

describe("extractGraph", () => {
  test("extracts project, tool and file entities with evidence relations", () => {
    const result = extractGraph({
      scope,
      chunkId: "chunk-1",
      sourceId: "/repo/docs/guide.md",
      text: "mengshu project uses Postgres and LanceDB. See src/index.ts.",
      createdAt: 1710000000000,
      metadata: { source: "scan", projectPath: "/repo/mengshu" },
    });

    expect(result.entities.map((entity) => [entity.type, entity.canonicalName])).toEqual(
      expect.arrayContaining([
        ["chunk", "chunk-1"],
        ["project", "mengshu"],
        ["tool", "postgresql"],
        ["tool", "lancedb"],
        ["file", "src/index.ts"],
      ]),
    );
    expect(result.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          predicate: "uses",
          confidence: 0.72,
          evidenceChunkIds: ["chunk-1"],
        }),
        expect.objectContaining({
          predicate: "mentions",
          evidenceChunkIds: ["chunk-1"],
        }),
      ]),
    );
  });

  test("keeps extraction deterministic for the same scope and text", () => {
    const input = {
      scope,
      chunkId: "chunk-1",
      text: "OpenClaw uses MCP",
      createdAt: 1710000000000,
    };

    expect(extractGraph(input)).toEqual(extractGraph(input));
  });
});
