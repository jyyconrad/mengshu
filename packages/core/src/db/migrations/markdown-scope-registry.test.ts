import { describe, expect, it } from "vitest";

import { authorityScopeFingerprint } from "../../domain/authority-scope-fingerprint.js";
import type { MemoryScope } from "../../domain/types.js";
import {
  authorityScopeFromMarkdownRecord,
  createMarkdownScopeRegistry,
  MarkdownScopeRegistryError,
  parseMarkdownScopeRegistry,
  serializeMarkdownScopeRegistry,
} from "./markdown-scope-registry.js";
import {
  createMarkdownWorksetRecord,
  type MarkdownWorksetNativeRecord,
} from "./markdown-workset.js";

const SCOPE: MemoryScope = {
  tenantId: "tenant-a",
  appId: "app-a",
  userId: "user-a",
  projectId: "project-a",
  agentId: "agent-a",
  namespace: "default",
  visibility: "private",
  workspaceId: "workspace-a",
};

function nativeRecord(
  id: string,
  sourceTable: "memories" | "knowledge" = "memories",
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
): MarkdownWorksetNativeRecord {
  return {
    id,
    sourceTable,
    text: `正文 ${id}`,
    contentHash: `${id}-content-hash`,
    vector: [0.1, 0.2],
    importance: 0.8,
    category: "test",
    dataType: "fact",
    metadata: {},
    createdAt: "2026-08-28T00:00:00.000Z",
    tenantId: SCOPE.tenantId,
    productId: SCOPE.appId,
    userId: SCOPE.userId,
    canonicalProjectId: SCOPE.projectId,
    producerId: SCOPE.agentId,
    namespace: SCOPE.namespace,
    visibility: SCOPE.visibility,
    workspaceId: SCOPE.workspaceId,
    ...overrides,
  };
}

function source(
  id: string,
  sourceTable: "memories" | "knowledge" = "memories",
  overrides: Partial<MarkdownWorksetNativeRecord> = {},
) {
  const record = nativeRecord(id, sourceTable, overrides);
  const scope = authorityScopeFromMarkdownRecord(record);
  return createMarkdownWorksetRecord({
    phase: "source",
    ...(scope ? { scopeFingerprint: authorityScopeFingerprint(scope) } : {}),
    record,
  });
}

function create() {
  return createMarkdownScopeRegistry({
    migrationRunId: "run-a",
    sourceManifestFileSha256: "a".repeat(64),
    sourceSnapshotSha256: "b".repeat(64),
    createdAt: "2026-08-28T01:00:00.000Z",
    records: [
      source("memory-1"),
      source("knowledge-1", "knowledge"),
      source("unscoped", "memories", { tenantId: "" }),
    ],
  });
}

describe("markdown scope registry", () => {
  it("从冻结 source records 生成可复算的完整 authority scope 注册表", () => {
    const registry = create();

    expect(registry.entries).toHaveLength(1);
    expect(registry.entries[0]).toMatchObject({
      scopeFingerprint: authorityScopeFingerprint(SCOPE),
      scope: SCOPE,
      sourceCount: 2,
      memorySourceCount: 1,
      knowledgeSourceCount: 1,
    });
    expect(registry.summary).toEqual({
      sourceCount: 3,
      scopedSourceCount: 2,
      unscopedSourceCount: 1,
      memoryScopedSourceCount: 1,
      knowledgeScopedSourceCount: 1,
      scopeCount: 1,
    });
    expect(parseMarkdownScopeRegistry(serializeMarkdownScopeRegistry(registry))).toEqual(registry);
  });

  it("不从 metadata 猜测 sessionId", () => {
    const record = nativeRecord("memory-1", "memories", {
      metadata: { sessionId: "session-private" },
    });

    expect(authorityScopeFromMarkdownRecord(record)).toEqual(SCOPE);
    expect(authorityScopeFromMarkdownRecord(record)).not.toHaveProperty("sessionId");
  });

  it("拒绝 envelope 指纹与完整 scope 不一致", () => {
    const candidate = source("memory-1");
    const drifted = { ...candidate, scopeFingerprint: "c".repeat(64) };

    expect(() => createMarkdownScopeRegistry({
      migrationRunId: "run-a",
      sourceManifestFileSha256: "a".repeat(64),
      sourceSnapshotSha256: "b".repeat(64),
      createdAt: "2026-08-28T01:00:00.000Z",
      records: [drifted],
    })).toThrowError(MarkdownScopeRegistryError);
  });

  it("拒绝完整 scope 存在但 envelope 未冻结指纹", () => {
    const candidate = createMarkdownWorksetRecord({
      phase: "source",
      record: nativeRecord("memory-1"),
    });

    expect(() => createMarkdownScopeRegistry({
      migrationRunId: "run-a",
      sourceManifestFileSha256: "a".repeat(64),
      sourceSnapshotSha256: "b".repeat(64),
      createdAt: "2026-08-28T01:00:00.000Z",
      records: [candidate],
    })).toThrowError(MarkdownScopeRegistryError);
  });

  it("拒绝 registry semantic hash 或 scope descriptor 漂移", () => {
    const parsed = JSON.parse(serializeMarkdownScopeRegistry(create())) as {
      registrySha256: string;
      entries: Array<{ scope: { projectId: string } }>;
    };
    parsed.entries[0]!.scope.projectId = "project-b";

    expect(() => parseMarkdownScopeRegistry(JSON.stringify(parsed)))
      .toThrowError(MarkdownScopeRegistryError);
  });
});
