import { describe, expect, test } from "vitest";
import { InMemoryMemoryStore } from "../storage/repositories/in-memory.js";
import { IngestionPipeline } from "./pipeline.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

describe("IngestionPipeline", () => {
  test("writes document/chunks/audit and queues deterministic jobs without embeddings", async () => {
    let nextId = 0;
    const store = new InMemoryMemoryStore({
      now: () => 1710000000000,
      idFactory: () => `generated-id-${nextId += 1}`,
    });
    const pipeline = new IngestionPipeline({
      documents: store.documents,
      chunks: store.chunks,
      jobs: store.jobs,
      audit: store.audit,
    });

    const result = await pipeline.ingest({
      scope,
      sourceId: "/docs/guide.md",
      content: "# Guide\n\nalpha beta gamma",
      metadata: { filePath: "/docs/guide.md" },
      chunkSize: 12,
    });

    expect(result).toMatchObject({
      documentId: expect.any(String),
      chunksAdmitted: 3,
      chunksDropped: 0,
      jobsQueued: 3,
    });
    await expect(store.documents.get(result.documentId)).resolves.toMatchObject({
      id: result.documentId,
      uri: "/docs/guide.md",
      scope,
    });
    await expect(store.chunks.listByDocument(result.documentId, { scope })).resolves.toHaveLength(3);
    await expect(store.jobs.list("queued")).resolves.toHaveLength(3);
    await expect(store.audit.list({ scope })).resolves.toMatchObject([
      { action: "ingest.document", targetId: result.documentId },
    ]);
  });

  test("dedupes chunks by content hash within a document", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1710000000000 });
    const pipeline = new IngestionPipeline({
      documents: store.documents,
      chunks: store.chunks,
      jobs: store.jobs,
      audit: store.audit,
    });

    const result = await pipeline.ingest({
      scope,
      sourceId: "/docs/repeat.md",
      content: "repeat\n\nrepeat",
      chunkSize: 6,
    });

    expect(result.chunksAdmitted).toBe(1);
    expect(result.chunksDropped).toBeGreaterThan(0);
    expect(result.jobsQueued).toBe(1);
  });
});
