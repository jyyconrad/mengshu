import { describe, expect, test } from "vitest";
import type { MemoryEntry } from "../db/types.js";
import {
  categoryToKind,
  memoryEntryToRecord,
  recordToMemoryEntry,
  tableNameToNamespace,
} from "./legacy-mapping.js";
import { scopeToKey } from "../../../../core/scope.js";

const baseEntry: MemoryEntry = {
  id: "mem-1",
  text: "User prefers concise answers",
  contentHash: "hash-1",
  vector: [0.1, 0.2],
  importance: 0.82,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {
    userId: "user-1",
    sessionId: "session-1",
    conversationId: "conversation-1",
    messageId: "message-1",
    projectPath: "/workspace/app",
    agentName: "openclaw-agent",
    source: "user",
    custom: "kept",
    updatedAt: 1710000001000,
  },
  createdAt: 1710000000000,
};

describe("legacy memory mapping", () => {
  test("maps table names to namespaces", () => {
    expect(tableNameToNamespace("memories")).toBe("memories");
    expect(tableNameToNamespace("knowledge")).toBe("knowledge");
    expect(tableNameToNamespace("documents")).toBe("documents");
    expect(tableNameToNamespace("knowledge_work")).toBe("knowledge_work");
    expect(tableNameToNamespace(undefined)).toBe("memories");
  });

  test("maps memory categories to core kinds", () => {
    expect(categoryToKind("preference")).toBe("preference");
    expect(categoryToKind("decision")).toBe("decision");
    expect(categoryToKind("entity")).toBe("entity");
    expect(categoryToKind("fact")).toBe("fact");
    expect(categoryToKind("task")).toBe("task");
    expect(categoryToKind("plan")).toBe("plan");
    expect(categoryToKind("goal")).toBe("goal");
    expect(categoryToKind("core")).toBe("other");
    expect(categoryToKind("other")).toBe("other");
  });

  test("promotes legacy metadata into scope and provenance", () => {
    const record = memoryEntryToRecord(baseEntry, {
      tenantId: "tenant-a",
      appId: "openclaw",
    });

    expect(record.scope).toEqual({
      tenantId: "tenant-a",
      appId: "openclaw",
      userId: "user-1",
      projectId: "/workspace/app",
      agentId: "openclaw-agent",
      namespace: "memories",
    });
    expect(scopeToKey(record.scope)).toBe(
      "tenant-a:openclaw:user-1:%2Fworkspace%2Fapp:openclaw-agent:memories",
    );
    expect(record.kind).toBe("preference");
    expect(record.provenance).toMatchObject({
      source: "user",
      sessionId: "session-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      createdAt: 1710000000000,
    });
    expect(record.metadata.custom).toBe("kept");
    expect(record.updatedAt).toBe(1710000001000);
  });

  test("maps knowledge entries into knowledge namespace and kind", () => {
    const record = memoryEntryToRecord({
      ...baseEntry,
      dataType: "knowledge",
      tableName: "knowledge",
      category: "other",
      metadata: {
        ...baseEntry.metadata,
        filePath: "/docs/guide.md",
        source: "scan",
      },
    });

    expect(record.scope.namespace).toBe("knowledge");
    expect(record.kind).toBe("knowledge");
    expect(record.provenance.filePath).toBe("/docs/guide.md");
    expect(record.provenance.source).toBe("scan");
  });

  test("round-trips a core record back to a legacy MemoryEntry without losing fields", () => {
    const record = memoryEntryToRecord(baseEntry, { appId: "openclaw" });
    const entry = recordToMemoryEntry(record);

    expect(entry).toEqual(baseEntry);
  });

  test("uses an explicit vector when converting back to legacy entry", () => {
    const record = memoryEntryToRecord(baseEntry);
    const entry = recordToMemoryEntry({ ...record, vector: undefined }, [0.9, 0.8]);

    expect(entry.vector).toEqual([0.9, 0.8]);
  });
});
