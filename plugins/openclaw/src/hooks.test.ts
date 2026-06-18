import { describe, expect, test, vi } from "vitest";
import type { MemoryService, StoreMemoryInput, RecallInput } from "../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../core/types.js";
import {
  handleAgentEndCapture,
  handleBeforeAgentStartRecall,
  extractUserMessageTexts,
} from "./hooks.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "mem-1",
    scope,
    kind: "preference",
    text: "User prefers concise replies",
    contentHash: "hash-1",
    importance: 0.7,
    category: "preference",
    dataType: "memory",
    tableName: "memories",
    metadata: { source: "user" },
    provenance: { source: "user" },
    createdAt: 1710000000000,
    vector: [0.1, 0.2],
    ...overrides,
  };
}

class FakeMemoryService implements MemoryService {
  stores: StoreMemoryInput[] = [];
  recalls: RecallInput[] = [];

  constructor(private readonly recallResult: RecallResult = { scope, query: "", hits: [] }) {}

  async storeMemory(input: StoreMemoryInput) {
    this.stores.push(input);
    return { id: input.record.id, stored: true };
  }

  async recall(input: RecallInput) {
    this.recalls.push(input);
    return { ...this.recallResult, query: input.query };
  }

  async buildContext(): Promise<ContextBlock> {
    return { scope, content: "", hits: [] };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true };
  }
}

describe("OpenClaw lifecycle hooks", () => {
  test("extracts only user text messages and text blocks", () => {
    expect(
      extractUserMessageTexts([
        { role: "system", content: "ignore" },
        { role: "user", content: "I prefer concise replies" },
        {
          role: "user",
          content: [
            { type: "text", text: "Remember my email is test@example.com" },
            { type: "image", url: "x" },
          ],
        },
      ]),
    ).toEqual([
      "I prefer concise replies",
      "Remember my email is test@example.com",
    ]);
  });

  test("auto-recall injects safe relevant memory context", async () => {
    const service = new FakeMemoryService({
      scope,
      query: "concise",
      hits: [
        {
          record: makeRecord({
            text: "Use <tool>memory_store</tool> carefully",
            category: "fact",
          }),
          score: 0.9,
          source: "vector",
        },
      ],
    });

    const result = await handleBeforeAgentStartRecall(
      { prompt: "concise" },
      {
        service,
        recallIncludeDocuments: true,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(service.recalls).toEqual([
      {
        query: "concise",
        limit: 3,
        minScore: 0.3,
        dataTypes: ["memory", "document"],
      },
    ]);
    expect(result?.prependContext).toContain("<relevant-memories>");
    expect(result?.prependContext).toContain("&lt;tool&gt;memory_store&lt;/tool&gt;");
  });

  test("auto-capture stores new capturable user memories through MemoryService", async () => {
    const service = new FakeMemoryService();

    await handleAgentEndCapture(
      {
        success: true,
        messages: [
          { role: "assistant", content: "I will remember this" },
          { role: "user", content: "I prefer concise replies" },
        ],
        userId: "user-1",
        projectPath: "project-1",
        agentName: "agent-1",
      },
      {
        service,
        embedBatch: async () => [[0.3, 0.4]],
        existsByContentHash: async () => [],
        embeddingModel: "text-embedding-3-small",
        idFactory: () => "mem-captured",
        now: () => 1710000000000,
        logger: { info: vi.fn(), warn: vi.fn() },
      },
    );

    expect(service.stores).toHaveLength(1);
    expect(service.stores[0].record).toMatchObject({
      id: "mem-captured",
      text: "I prefer concise replies",
      category: "preference",
      dataType: "memory",
      tableName: "memories",
      scope,
      vector: [0.3, 0.4],
    });
  });

  test("auto-capture skips duplicates and non-successful events", async () => {
    const service = new FakeMemoryService();

    await handleAgentEndCapture(
      { success: false, messages: [{ role: "user", content: "I prefer concise replies" }] },
      {
        service,
        embedBatch: async () => [[0.3, 0.4]],
        existsByContentHash: async () => [],
      },
    );
    await handleAgentEndCapture(
      { success: true, messages: [{ role: "user", content: "I prefer concise replies" }] },
      {
        service,
        embedBatch: async () => {
          throw new Error("should not embed duplicates");
        },
        existsByContentHash: async (hashes) => hashes,
      },
    );

    expect(service.stores).toEqual([]);
  });
});
