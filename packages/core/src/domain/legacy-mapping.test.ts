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

    // baseEntry.category=preference -> kind=preference -> semanticType=profile（边界统一推导），
    // 该推导值会回写进 metadata.semanticType，因此 round-trip 后多出该字段。
    // D-25：scope 维度（projectId/appId/userId/agentId）会镜像到独立列，
    // workspaceId 在 baseEntry 中未设置，故为 undefined。
    expect(entry).toEqual({
      ...baseEntry,
      metadata: { ...baseEntry.metadata, semanticType: "profile" },
      // 独立列镜像
      projectName: "/workspace/app",
      appName: "openclaw",
      userId: "user-1",
      agentId: "openclaw-agent",
      workspaceId: undefined,
    });
  });

  test("uses an explicit vector when converting back to legacy entry", () => {
    const record = memoryEntryToRecord(baseEntry);
    const entry = recordToMemoryEntry({ ...record, vector: undefined }, [0.9, 0.8]);

    expect(entry.vector).toEqual([0.9, 0.8]);
  });

  test("preserves v3.0 fields across a record -> entry -> record round-trip", () => {
    const record = memoryEntryToRecord(baseEntry, { appId: "openclaw" });
    const enriched = {
      ...record,
      hotness: 7,
      sourceNodeIds: ["node-a", "node-b", "node-c"],
      confidence: 0.91,
      semanticType: "experience" as const,
    };

    const entry = recordToMemoryEntry(enriched);
    expect(entry.metadata.hotness).toBe(7);
    expect(entry.metadata.sourceNodeIds).toEqual(["node-a", "node-b", "node-c"]);
    expect(entry.metadata.confidence).toBe(0.91);
    expect(entry.metadata.semanticType).toBe("experience");

    const restored = memoryEntryToRecord(entry, { appId: "openclaw" });
    expect(restored.hotness).toBe(7);
    expect(restored.sourceNodeIds).toEqual(["node-a", "node-b", "node-c"]);
    expect(restored.confidence).toBe(0.91);
    expect(restored.semanticType).toBe("experience");
    expect(restored.updatedAt).toBe(1710000001000);
  });

  test("falls back to undefined for v3.0 fields missing from legacy metadata", () => {
    const record = memoryEntryToRecord(baseEntry, { appId: "openclaw" });

    expect(record.hotness).toBeUndefined();
    expect(record.sourceNodeIds).toBeUndefined();
    expect(record.confidence).toBeUndefined();
    // semanticType 缺失时从 kind 高置信度推导（preference -> profile），不再是 undefined
    expect(record.semanticType).toBe("profile");
  });

  test("derives semanticType from kind when legacy metadata lacks it", () => {
    // 迁移数据普遍只有 kind/category，缺 metadata.semanticType。
    // 边界应统一从 kind 高置信度映射，让 5 槽位/importance 明细等消费方受益。
    const decision = memoryEntryToRecord(
      { ...baseEntry, category: "decision" },
      { appId: "openclaw" },
    );
    expect(decision.semanticType).toBe("rules");

    const goal = memoryEntryToRecord(
      { ...baseEntry, category: "goal" },
      { appId: "openclaw" },
    );
    expect(goal.semanticType).toBe("task_context");

    // 无法稳定归类的 kind（entity/fact/other）保持 undefined（kind-only 记忆）
    const entity = memoryEntryToRecord(
      { ...baseEntry, category: "entity" },
      { appId: "openclaw" },
    );
    expect(entity.semanticType).toBeUndefined();
  });

  test("coerces string importance to a clamped number at the boundary", () => {
    // 迁移数据 importance 可能存为字符串 "0.9"，违反 MemoryRecord.importance: number 契约
    const fromString = memoryEntryToRecord(
      { ...baseEntry, importance: "0.9" as unknown as number },
      { appId: "openclaw" },
    );
    expect(fromString.importance).toBe(0.9);
    expect(typeof fromString.importance).toBe("number");

    // 超界值 clamp 到 [0,1]
    const tooHigh = memoryEntryToRecord(
      { ...baseEntry, importance: "1.5" as unknown as number },
      { appId: "openclaw" },
    );
    expect(tooHigh.importance).toBe(1);

    // 非法值回退中性默认 0.5
    const invalid = memoryEntryToRecord(
      { ...baseEntry, importance: "abc" as unknown as number },
      { appId: "openclaw" },
    );
    expect(invalid.importance).toBe(0.5);
  });

  test("ignores invalid v3.0 field types when restoring a record", () => {
    const entry: MemoryEntry = {
      ...baseEntry,
      metadata: {
        ...baseEntry.metadata,
        hotness: "hot",
        confidence: "high",
        sourceNodeIds: ["valid", 42, null],
        semanticType: "not-a-real-type",
      },
    };

    const record = memoryEntryToRecord(entry, { appId: "openclaw" });
    expect(record.hotness).toBeUndefined();
    expect(record.confidence).toBeUndefined();
    expect(record.sourceNodeIds).toEqual(["valid"]);
    // 非法 metadata.semanticType 被忽略后，回退到 kind 推导（preference -> profile）
    expect(record.semanticType).toBe("profile");
  });

  test("does not emit undefined v3.0 fields into legacy metadata", () => {
    // category=other -> kind=other（unmappable），semanticType 保持 undefined，
    // 因此不会回写进 metadata，可验证"undefined 字段不外溢"。
    const record = memoryEntryToRecord(
      { ...baseEntry, category: "other", metadata: { custom: "kept" } },
      { appId: "openclaw" },
    );
    const entry = recordToMemoryEntry(record);

    expect(entry.metadata).not.toHaveProperty("hotness");
    expect(entry.metadata).not.toHaveProperty("sourceNodeIds");
    expect(entry.metadata).not.toHaveProperty("confidence");
    expect(entry.metadata).not.toHaveProperty("semanticType");
    expect(entry.metadata.custom).toBe("kept");
  });

  describe("D-25: scope 维度独立列支持", () => {
    test("recordToMemoryEntry 写入时把非默认 scope 维度镜像到独立字段", () => {
      const record = memoryEntryToRecord(baseEntry, {
        tenantId: "tenant-a",
        appId: "codex",
      });

      // 手动设置 scope 维度
      record.scope.projectId = "project-alpha";
      record.scope.appId = "codex";
      record.scope.userId = "user-123";
      record.scope.agentId = "agent-456";
      record.scope.workspaceId = "workspace-789";

      const entry = recordToMemoryEntry(record);

      // 验证独立字段正确写入
      expect(entry.projectName).toBe("project-alpha");
      expect(entry.appName).toBe("codex");
      expect(entry.userId).toBe("user-123");
      expect(entry.agentId).toBe("agent-456");
      expect(entry.workspaceId).toBe("workspace-789");
    });

    test("recordToMemoryEntry 不写入默认值（避免污染）", () => {
      const record = memoryEntryToRecord(baseEntry, {
        tenantId: "tenant-a",
        appId: "default",
      });

      // scope 全是默认值
      record.scope.projectId = "default";
      record.scope.appId = "default";
      record.scope.userId = "default";
      record.scope.agentId = "default";
      record.scope.workspaceId = undefined;

      const entry = recordToMemoryEntry(record);

      // 验证默认值不写入独立字段
      expect(entry.projectName).toBeUndefined();
      expect(entry.appName).toBeUndefined();
      expect(entry.userId).toBeUndefined();
      expect(entry.agentId).toBeUndefined();
      expect(entry.workspaceId).toBeUndefined();
    });

    test("memoryEntryToRecord 读回时优先使用独立列（新数据）", () => {
      const entry: MemoryEntry = {
        ...baseEntry,
        projectName: "project-beta",
        appName: "claude-code",
        userId: "user-999",
        agentId: "agent-888",
        workspaceId: "workspace-777",
        metadata: {
          // 旧字段仍存在，但应被独立列覆盖
          projectPath: "/old/path",
          agentName: "old-agent",
          userId: "old-user",
        },
      };

      const record = memoryEntryToRecord(entry, {
        tenantId: "tenant-x",
        appId: "fallback-app",
        projectId: "fallback-project",
      });

      // 验证优先使用独立列（而非 metadata 或 defaults）
      expect(record.scope.projectId).toBe("project-beta");
      expect(record.scope.appId).toBe("claude-code");
      expect(record.scope.userId).toBe("user-999");
      expect(record.scope.agentId).toBe("agent-888");
      expect(record.scope.workspaceId).toBe("workspace-777");
      expect(record.scope.tenantId).toBe("tenant-x"); // tenantId 仍用 defaults
    });

    test("memoryEntryToRecord 独立列为 NULL 时回退 defaults（向后兼容旧数据）", () => {
      const entry: MemoryEntry = {
        ...baseEntry,
        // 旧数据无独立列
        projectName: undefined,
        appName: undefined,
        userId: undefined,
        agentId: undefined,
        workspaceId: undefined,
        metadata: {
          // 也无旧 metadata 映射字段
        },
      };

      const record = memoryEntryToRecord(entry, {
        tenantId: "tenant-compat",
        appId: "openclaw",
        projectId: "/compat/project",
        userId: "compat-user",
        agentId: "compat-agent",
        workspaceId: "compat-workspace",
      });

      // 验证回退 defaults（向后兼容行为）
      expect(record.scope.projectId).toBe("/compat/project");
      expect(record.scope.appId).toBe("openclaw");
      expect(record.scope.userId).toBe("compat-user");
      expect(record.scope.agentId).toBe("compat-agent");
      expect(record.scope.workspaceId).toBe("compat-workspace");
    });

    test("scope 维度无损回转（写入→读回→再写入）", () => {
      // 第一步：从 entry（带旧 metadata）到 record
      const originalEntry: MemoryEntry = {
        ...baseEntry,
        metadata: {
          ...baseEntry.metadata,
          projectPath: "/workspace/app",
          agentName: "openclaw-agent",
          userId: "user-1",
        },
      };

      const record1 = memoryEntryToRecord(originalEntry, {
        tenantId: "tenant-test",
        appId: "codex",
      });

      // 手动修改 scope 维度（模拟更新）
      record1.scope.projectId = "project-gamma";
      record1.scope.appId = "claude-code";
      record1.scope.userId = "user-new";
      record1.scope.agentId = "agent-new";
      record1.scope.workspaceId = "workspace-new";

      // 第二步：写回 entry（独立列应镜像 scope）
      const entry2 = recordToMemoryEntry(record1);

      expect(entry2.projectName).toBe("project-gamma");
      expect(entry2.appName).toBe("claude-code");
      expect(entry2.userId).toBe("user-new");
      expect(entry2.agentId).toBe("agent-new");
      expect(entry2.workspaceId).toBe("workspace-new");

      // 第三步：再次读回 record（应优先用独立列，无损恢复）
      const record2 = memoryEntryToRecord(entry2, {
        tenantId: "tenant-test",
        appId: "fallback",
        projectId: "fallback",
      });

      expect(record2.scope.projectId).toBe("project-gamma");
      expect(record2.scope.appId).toBe("claude-code");
      expect(record2.scope.userId).toBe("user-new");
      expect(record2.scope.agentId).toBe("agent-new");
      expect(record2.scope.workspaceId).toBe("workspace-new");
    });

    test("独立列优先级：独立列 > 旧 metadata > defaults（三层回退）", () => {
      const entry: MemoryEntry = {
        ...baseEntry,
        // 独立列：projectName 有值，userId 无值
        projectName: "explicit-project",
        userId: undefined,
        appName: undefined,
        agentId: undefined,
        workspaceId: undefined,
        metadata: {
          // 旧 metadata：userId 有值，agentName 无值
          userId: "metadata-user",
          projectPath: "/should/be/overridden",
        },
      };

      const record = memoryEntryToRecord(entry, {
        tenantId: "tenant-priority",
        appId: "default-app",
        projectId: "default-project",
        userId: "default-user",
        agentId: "default-agent",
      });

      // projectId：独立列优先（explicit-project）
      expect(record.scope.projectId).toBe("explicit-project");

      // userId：独立列 undefined → 回退旧 metadata（metadata-user）
      expect(record.scope.userId).toBe("metadata-user");

      // appId：独立列 undefined，旧 metadata 无映射 → 回退 defaults（default-app）
      expect(record.scope.appId).toBe("default-app");

      // agentId：独立列 undefined，旧 metadata 无 → 回退 defaults（default-agent）
      expect(record.scope.agentId).toBe("default-agent");
    });
  });
});
