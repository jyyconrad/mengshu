import { describe, expect, test } from "vitest";
import type { ChunkRecord, DocumentRecord, MemoryRecord } from "../../core/types.js";
import { InMemoryMemoryStore } from "./in-memory.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

const otherScope = { ...scope, namespace: "memories" };

function memory(id: string, text = "alpha memory"): MemoryRecord {
  return {
    id,
    scope,
    kind: "knowledge",
    text,
    contentHash: `hash-${id}`,
    importance: 0.7,
    category: "other",
    dataType: "knowledge",
    tableName: "knowledge",
    metadata: {},
    provenance: {},
    createdAt: 1710000000000,
  };
}

function document(id: string): DocumentRecord {
  return {
    id,
    scope,
    title: "Guide",
    uri: "/docs/guide.md",
    contentHash: `doc-hash-${id}`,
    metadata: {},
    createdAt: 1710000000000,
  };
}

function chunk(id: string, documentId = "doc-1"): ChunkRecord {
  return {
    id,
    scope,
    documentId,
    text: `chunk ${id}`,
    contentHash: `chunk-hash-${id}`,
    ordinal: Number(id.replace(/\D/g, "")) || 0,
    metadata: {},
    provenance: {},
    createdAt: 1710000000000,
  };
}

describe("InMemoryMemoryStore", () => {
  test("stores and queries memories with scope isolation", async () => {
    const store = new InMemoryMemoryStore();
    await store.memories.store([
      memory("mem-1", "alpha memory"),
      { ...memory("mem-2", "beta memory"), scope: otherScope },
    ]);

    await expect(store.memories.query({ query: "alpha", scope })).resolves.toMatchObject([
      { id: "mem-1", score: 1 },
    ]);
    await expect(store.memories.count({ scope })).resolves.toBe(1);
  });

  test("stores documents and chunks by scope and document id", async () => {
    const store = new InMemoryMemoryStore();
    await store.documents.upsert(document("doc-1"));
    await store.chunks.upsertMany([chunk("chunk-1"), chunk("chunk-2"), { ...chunk("chunk-3"), scope: otherScope }]);

    await expect(store.documents.get("doc-1")).resolves.toMatchObject({ id: "doc-1" });
    await expect(store.documents.list({ scope })).resolves.toHaveLength(1);
    await expect(store.chunks.listByDocument("doc-1", { scope })).resolves.toHaveLength(2);
  });

  test("dedupes jobs by dedupe key and supports lease/complete/fail", async () => {
    const store = new InMemoryMemoryStore({ now: () => 1000 });
    const first = await store.jobs.enqueue({ type: "embed", payload: { id: "chunk-1" }, dedupeKey: "embed:chunk-1" });
    const duplicate = await store.jobs.enqueue({ type: "embed", payload: { id: "chunk-1" }, dedupeKey: "embed:chunk-1" });

    expect(duplicate.id).toBe(first.id);
    const lease = await store.jobs.lease({ workerId: "worker-1", leaseMs: 100 });
    expect(lease).toMatchObject({ id: first.id, status: "running", attempts: 1 });

    await store.jobs.fail(first.id, "temporary");
    const retry = await store.jobs.lease({ workerId: "worker-1", leaseMs: 100 });
    expect(retry).toMatchObject({ id: first.id, status: "running", attempts: 2 });

    await store.jobs.complete(first.id);
    await expect(store.jobs.lease({ workerId: "worker-1", leaseMs: 100 })).resolves.toBeUndefined();
  });

  test("recovers expired leases", async () => {
    let now = 1000;
    const store = new InMemoryMemoryStore({ now: () => now });
    await store.jobs.enqueue({ type: "embed", payload: {}, dedupeKey: "job-1" });
    const leased = await store.jobs.lease({ workerId: "worker-1", leaseMs: 10 });
    expect(leased?.status).toBe("running");

    now = 1011;
    const recovered = await store.jobs.lease({ workerId: "worker-2", leaseMs: 10 });
    expect(recovered).toMatchObject({ workerId: "worker-2", attempts: 2 });
  });

  test("records audit events", async () => {
    const store = new InMemoryMemoryStore();
    await store.audit.append({ scope, action: "ingest.document", targetId: "doc-1", metadata: { ok: true } });

    await expect(store.audit.list({ scope })).resolves.toMatchObject([
      { action: "ingest.document", targetId: "doc-1", metadata: { ok: true } },
    ]);
  });
});
