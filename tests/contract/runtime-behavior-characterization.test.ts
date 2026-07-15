import { describe, expect, test, vi } from "vitest";
import { AgentFastPathService } from "../../packages/api/src/agent-fast-path/index.js";
import { SlotContextBuilder } from "../../packages/core/src/context/slot-context-builder.js";
import { SlotSnapshotCache } from "../../packages/core/src/context/slot-snapshot.js";
import type {
  EmbeddingPort,
  MemoryRepository,
  MemoryRepositoryQuery,
} from "../../packages/core/src/domain/service-types.js";
import type {
  MemoryRecord,
  MemoryScope,
} from "../../packages/core/src/domain/types.js";
import { DefaultMemoryService } from "../../packages/core/src/service/memory-service.js";
import {
  createMcpMemoryTools,
  type McpMemoryTool,
} from "../../packages/mcp/src/tools.js";

const TARGET_SCOPE: MemoryScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "user-a",
  projectId: "project-a",
  agentId: "codex",
  namespace: "memories",
  visibility: "private",
};

const OTHER_SCOPE: MemoryScope = {
  ...TARGET_SCOPE,
  projectId: "project-b",
};

function memoryRecord(
  id: string,
  scope: MemoryScope,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  return {
    id,
    scope,
    kind: "fact",
    semanticType: "resource",
    lifecycleStatus: "active",
    text: `${id} text`,
    contentHash: `${id}-hash`,
    importance: 0.8,
    category: "core",
    dataType: "memory",
    tableName: "memories",
    metadata: {},
    provenance: { source: "contract-fixture", createdAt: 1 },
    createdAt: 1,
    ...overrides,
  };
}

class CharacterizationRepository implements MemoryRepository {
  private records: MemoryRecord[];

  constructor(records: MemoryRecord[]) {
    this.records = [...records];
  }

  async store(records: MemoryRecord[]): Promise<void> {
    this.records = [...this.records, ...records];
  }

  async query(input: MemoryRepositoryQuery): Promise<Array<MemoryRecord & { score: number }>> {
    const project = input.filter?._projectName;
    const product = input.filter?._appName;
    return this.records
      .filter((record) => typeof project !== "string" || record.scope.projectId === project)
      .filter((record) => typeof product !== "string" || record.scope.appId === product)
      .map((record) => ({ ...record, score: 0.8 }));
  }

  async delete(ids: string[]): Promise<void> {
    const removed = new Set(ids);
    this.records = this.records.filter((record) => !removed.has(record.id));
  }

  async deleteByFilter(filter: Record<string, unknown>): Promise<number> {
    const before = this.records.length;
    this.records = this.records.filter((record) =>
      Object.entries(filter).some(([key, value]) => record.metadata[key] !== value),
    );
    return before - this.records.length;
  }

  async count(): Promise<number> {
    return this.records.length;
  }
}

const embeddings: EmbeddingPort = {
  embed: async () => [0.1, 0.2, 0.3],
};

function findTool(tools: McpMemoryTool[], name: string): McpMemoryTool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) {
    throw new Error(`missing MCP tool: ${name}`);
  }
  return found;
}

function createService(records: MemoryRecord[]) {
  const repository = new CharacterizationRepository(records);
  const service = new DefaultMemoryService({ repository, embeddings });
  return { repository, service };
}

describe("P0-0 runtime black-box characterization", () => {
  test("soft recall keeps cross-project candidates but ranks the matching scope first", async () => {
    const { service } = createService([
      memoryRecord("other", OTHER_SCOPE),
      memoryRecord("target", TARGET_SCOPE),
    ]);
    const recall = findTool(createMcpMemoryTools({ unsafeLegacyScope: true, service }), "memory_recall");

    const result = await recall.execute({
      query: "mengshu upgrade",
      raw: true,
      scope: TARGET_SCOPE,
      scopeFilterMode: "soft",
      filterProject: TARGET_SCOPE.projectId,
    }) as { hits: Array<{ record: MemoryRecord }> };

    expect(result.hits.map((hit) => hit.record.id)).toEqual(["target", "other"]);
  });

  test("hard recall passes project/product isolation through and excludes other projects", async () => {
    const { service } = createService([
      memoryRecord("other", OTHER_SCOPE),
      memoryRecord("target", TARGET_SCOPE),
    ]);
    const recall = findTool(createMcpMemoryTools({ unsafeLegacyScope: true, service }), "memory_recall");

    const result = await recall.execute({
      query: "mengshu upgrade",
      raw: true,
      scope: TARGET_SCOPE,
      scopeFilterMode: "hard",
      filterProject: TARGET_SCOPE.projectId,
      filterProduct: TARGET_SCOPE.appId,
    }) as { hits: Array<{ record: MemoryRecord }> };

    expect(result.hits.map((hit) => hit.record.id)).toEqual(["target"]);
  });

  test("context_fast exposes five semantic slots and filters revoked records", async () => {
    const active = (["profile", "task_context", "rules", "experience", "resource"] as const)
      .map((semanticType) => memoryRecord(semanticType, TARGET_SCOPE, {
        semanticType,
        text: `${semanticType} active`,
      }));
    const revoked = memoryRecord("revoked", TARGET_SCOPE, {
      semanticType: "rules",
      lifecycleStatus: "revoked",
      text: "must not enter prompt",
    });
    const fastPath = new AgentFastPathService({
      defaultScope: TARGET_SCOPE,
      builder: new SlotContextBuilder(new SlotSnapshotCache()),
      loadRecordsForScope: async () => [...active, revoked],
      recall: async (scope, query) => ({ scope, query, hits: [] }),
    });
    const context = findTool(
      createMcpMemoryTools({ unsafeLegacyScope: true,
        service: createService([]).service,
        agentFastPath: fastPath,
        defaultScope: TARGET_SCOPE,
      }),
      "memory_context_fast",
    );

    const result = await context.execute({ scope: TARGET_SCOPE, task: "upgrade mengshu" }) as {
      slots: Record<string, unknown>;
      content: string;
      filtered: Array<{ recordId: string }>;
    };

    expect(Object.keys(result.slots).sort()).toEqual([
      "experience",
      "profile",
      "resource",
      "rules",
      "task_context",
    ]);
    expect(result.content).not.toContain("must not enter prompt");
    expect(result.filtered).toEqual(expect.arrayContaining([expect.objectContaining({ recordId: "revoked" })]));
  });

  test("observe_light remember acknowledges storage and enqueues candidate, source-tree, and graph work", async () => {
    const storeObservation = vi.fn(async () => ({ id: "observation-1", stored: true }));
    const enqueueJob = vi.fn(async ({ type }: { type: string }) => `${type}-job`);
    const fastPath = new AgentFastPathService({
      defaultScope: TARGET_SCOPE,
      loadRecordsForScope: async () => [],
      recall: async (scope, query) => ({ scope, query, hits: [] }),
      storeObservation,
      enqueueJob,
    });
    const observe = findTool(
      createMcpMemoryTools({ unsafeLegacyScope: true, service: createService([]).service, agentFastPath: fastPath }),
      "memory_observe_light",
    );

    const result = await observe.execute({
      scope: TARGET_SCOPE,
      eventType: "decision",
      text: "remember this stable decision",
      intent: "remember",
    }) as { ack: boolean; queuedJobs: string[] };

    expect(result).toMatchObject({
      ack: true,
      queuedJobs: ["extract_candidate-job", "build_tree-job", "extract_graph-job"],
    });
    expect(storeObservation).toHaveBeenCalledWith(expect.objectContaining({
      text: "remember this stable decision",
      metadata: expect.objectContaining({ intent: "remember", eventType: "decision" }),
    }));
  });

  test("legacy forget tool is not advertised without transactional authority capability", async () => {
    const { service } = createService([memoryRecord("forget-me", TARGET_SCOPE)]);
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });

    expect(tools.some((tool) => tool.name === "memory_forget")).toBe(false);
    const recalled = await findTool(tools, "memory_recall").execute({
      query: "forget-me",
      raw: true,
      scope: TARGET_SCOPE,
    }) as { hits: unknown[] };

    expect(recalled.hits).toHaveLength(1);
  });

  test("observe_light intent=ignore returns ignored ack without durable work", async () => {
    const storeObservation = vi.fn(async () => ({ id: "unexpected", stored: true }));
    const enqueueJob = vi.fn(async () => "unexpected-job");
    const fastPath = new AgentFastPathService({
      defaultScope: TARGET_SCOPE,
      loadRecordsForScope: async () => [],
      recall: async (scope, query) => ({ scope, query, hits: [] }),
      storeObservation,
      enqueueJob,
    });
    const observe = findTool(
      createMcpMemoryTools({ unsafeLegacyScope: true, service: createService([]).service, agentFastPath: fastPath }),
      "memory_observe_light",
    );

    const result = await observe.execute({
      scope: TARGET_SCOPE,
      eventType: "noise",
      text: "do not remember this",
      intent: "ignore",
    });

    expect(result).toMatchObject({ ack: true, ignored: true, queuedJobs: [] });
    expect(storeObservation).not.toHaveBeenCalled();
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  test.todo(
    "forget must apply server-owned authority scope before deleting by id or filter " +
    "(current gap: MCP DeleteMemoryInput contains no authority scope)",
  );
});
