import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemoryService } from "../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, MemoryScope, RecallResult } from "../../../core/types.js";
import type { IngestInput, IngestResult } from "../../core/src/ingest/types.js";
import type { IngestionPipeline } from "../../core/src/ingest/pipeline.js";
import { IngestionPipeline as RealIngestionPipeline } from "../../core/src/ingest/pipeline.js";
import { InMemoryMemoryStore } from "../../core/src/storage/repositories/in-memory.js";
import type { AuthorityScope } from "../../core/src/domain/authority-scope.js";
import type { AgentObserveLightRequest } from "../../api/src/agent-fast-path/index.js";
import { createAuthorityScopedForgetCapability } from "../../core/src/service/authority-forget-capability.js";
import { PostgresForgetTransactionPort } from "../../core/src/db/providers/postgres-forget-transaction.js";
import { createMcpMemoryTools } from "./tools.js";
import type { MemoryWriteCommand } from "../../core/src/service/write-kernel.js";
import { computeRecallScoreBreakdown } from "../../../core/recall-scoring.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

const record: MemoryRecord = {
  id: "mem-1",
  scope,
  kind: "preference",
  text: "User prefers concise replies",
  contentHash: "hash-1",
  importance: 0.8,
  category: "preference",
  dataType: "memory",
  tableName: "memories",
  metadata: {},
  provenance: {},
  createdAt: 1710000000000,
};

const scoreBreakdown = computeRecallScoreBreakdown(
  record,
  { relevance: 0.9, scopeFit: 1 },
  ["vector"],
  { vector: 0.9 },
);

class FakeMemoryService implements MemoryService {
  calls: string[] = [];

  async storeMemory() {
    this.calls.push("storeMemory");
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    this.calls.push("recall");
    return {
      scope,
      query: "concise",
      hits: [{ record, score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
    };
  }

  async buildContext(): Promise<ContextBlock> {
    this.calls.push("buildContext");
    return {
      scope,
      content: "safe",
      hits: [{ record, score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
      tokenEstimate: 1,
    };
  }

  async delete() {
    this.calls.push("delete");
    return { deleted: 1 };
  }

  async health() {
    this.calls.push("health");
    return { ok: true, records: 1 };
  }
}

/** 记录 ingest 调用入参的假 pipeline。 */
class FakePipeline {
  inputs: IngestInput[] = [];

  async ingest(input: IngestInput): Promise<IngestResult> {
    this.inputs.push(input);
    return {
      documentId: "doc:fake",
      chunksAdmitted: 2,
      chunksDropped: 0,
      jobsQueued: 2,
    };
  }
}

const ingestScope = {
  tenantId: "local",
  appId: "mengshu",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "knowledge",
};

const transportAuthority: AuthorityScope = {
  tenantId: "server-tenant",
  userId: "server-user",
  allow: {
    appIds: ["mengshu"],
    projectIds: ["project-1"],
    agentIds: ["agent-1"],
    namespaces: ["memories"],
    visibilities: ["private"],
  },
};

const attackerScope = {
  tenantId: "attacker-tenant",
  userId: "attacker-user",
  appId: "mengshu",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
};

function mintedForgetCapability(service: { forget(input: never): Promise<never> }) {
  return createAuthorityScopedForgetCapability(
    service as never,
    new PostgresForgetTransactionPort({
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
    }),
  );
}

describe("MCP memory tools", () => {
  test("asset tools are capability-gated and preserve server-owned exact scope", async () => {
    const list = vi.fn(async () => [{
      id: "asset-1", kind: "memory_view" as const, title: "Rules",
      semanticTypes: ["rules" as const], version: 1, status: "published" as const,
    }]);
    const read = vi.fn(async (_scope: MemoryScope, _assetId: string) => ({
      asset: { id: "asset-1", version: 1, status: "published" },
      contentValidity: "current" as const,
      staleReasons: [],
      explanation: { assetId: "asset-1", version: 1, evidenceIds: ["evidence-1"] },
    }));
    const without = createMcpMemoryTools({ service: new FakeMemoryService(), authority: transportAuthority });
    expect(without.map((tool) => tool.name)).not.toContain("memory_asset_list");

    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      defaultScope: {
        tenantId: transportAuthority.tenantId,
        userId: transportAuthority.userId,
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
      memoryAssets: { list, read } as never,
    });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_asset_list", "memory_asset_read", "memory_asset_explain",
    ]));
    await expect(tools.find((tool) => tool.name === "memory_asset_list")!.execute({}))
      .resolves.toMatchObject({ assets: [{ id: "asset-1", version: 1 }] });
    await expect(tools.find((tool) => tool.name === "memory_asset_explain")!
      .execute({ assetId: "asset-1" }))
      .resolves.toMatchObject({ assetId: "asset-1", evidenceIds: ["evidence-1"] });
    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: transportAuthority.tenantId }),
      "asset-1",
    );
  });

  test("asset search negotiates its own capability and accepts only core search input", async () => {
    const list = vi.fn(async () => []);
    const read = vi.fn(async () => ({
      asset: { id: "asset-1", version: 1, status: "published" },
      contentValidity: "current" as const,
      staleReasons: [],
      explanation: { assetId: "asset-1", version: 1, evidenceIds: [] },
    }));
    const search = vi.fn(async () => ({
      query: "rules",
      assets: [],
      filtered: [],
    }));
    const options = {
      service: new FakeMemoryService(),
      authority: transportAuthority,
      defaultScope: {
        tenantId: transportAuthority.tenantId,
        userId: transportAuthority.userId,
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private" as const,
      },
    };

    const readOnlyTools = createMcpMemoryTools({
      ...options,
      memoryAssets: { list, read } as never,
    });
    expect(readOnlyTools.map((tool) => tool.name)).not.toContain("memory_asset_search");

    const tools = createMcpMemoryTools({
      ...options,
      memoryAssets: { list, read, search } as never,
    });
    const tool = tools.find((candidate) => candidate.name === "memory_asset_search");
    expect(tool).toBeDefined();
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 512 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        semanticType: {
          type: "string",
          enum: ["profile", "task_context", "rules", "experience", "resource"],
        },
      },
      required: ["query"],
      additionalProperties: false,
    });
    await expect(tool!.execute({
      query: "rules",
      limit: 5,
      semanticType: "rules",
    })).resolves.toEqual({ query: "rules", assets: [], filtered: [] });
    expect(search).toHaveBeenCalledWith(options.defaultScope, {
      query: "rules",
      limit: 5,
      semanticType: "rules",
    });

    for (const forbidden of ["scope", "sql", "path", "url"]) {
      await expect(tool!.execute({ query: "rules", [forbidden]: "attacker-value" }))
        .rejects.toThrow(/accepts only query, limit, and semanticType/i);
    }
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("session explain is capability-gated and reads the persisted exact-session receipt", async () => {
    const receipt = { id: "receipt-1", sessionId: "session-1", bindings: [] };
    const without = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
    });
    expect(without.map((tool) => tool.name)).not.toContain("memory_session_explain");

    const getLatest = vi.fn(async () => receipt);
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      defaultScope: {
        tenantId: transportAuthority.tenantId,
        userId: transportAuthority.userId,
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
      sessionReceipts: { getLatest } as never,
    });
    const tool = tools.find((candidate) => candidate.name === "memory_session_explain");
    expect(tool?.inputSchema).toEqual({
      type: "object",
      properties: { sessionId: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["sessionId"],
      additionalProperties: false,
    });
    await expect(tool!.execute({ sessionId: "session-1" })).resolves.toBe(receipt);
    await expect(tool!.execute({ sessionId: "x".repeat(257) }))
      .rejects.toThrow(/valid sessionId/i);
    expect(getLatest).toHaveBeenCalledWith({
      tenantId: transportAuthority.tenantId,
      userId: transportAuthority.userId,
      appId: "mengshu",
      projectId: "project-1",
      agentId: "agent-1",
      namespace: "memories",
      visibility: "private",
      sessionId: "session-1",
    }, "session-1");

    for (const forbidden of ["scope", "sql", "path", "url"]) {
      await expect(tool!.execute({ sessionId: "session-1", [forbidden]: "attacker" }))
        .rejects.toThrow(/accepts only sessionId/i);
    }
    expect(getLatest).toHaveBeenCalledTimes(1);
  });

  test("temporal tools are capability-gated and preserve server-owned authority", async () => {
    const without = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
    });
    const names = [
      "memory_history", "memory_recall_as_of", "memory_expire", "memory_revoke", "memory_purge",
    ];
    expect(without.map((tool) => tool.name)).not.toEqual(expect.arrayContaining(names));

    const captured: unknown[] = [];
    const temporalMemory = {
      history: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { lineageId: "release", versions: [] };
      }),
      recallAsOf: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { lineageId: "release", historical: true };
      }),
      recallAsOfResolved: vi.fn(async (input: { scope: unknown; asOf: string }) => {
        captured.push(input.scope);
        return { memory: { historical: true }, asOfResolution: { original: input.asOf } };
      }),
      expire: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { receipt: { transitionType: "expired" } };
      }),
      revoke: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { receipt: { transitionType: "revoked" } };
      }),
      purge: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { operationId: "purge-1" };
      }),
    };
    const writeCommands: MemoryWriteCommand[] = [];
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      temporalMemory: temporalMemory as never,
      memoryWrite: {
        executeMemoryWrite: vi.fn(async (command: MemoryWriteCommand) => {
          writeCommands.push(command);
          return {
            status: "persisted" as const, route: "active" as const,
            recordType: "memory" as const, memoryId: "version-new", stored: true,
          };
        }),
      },
    });
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(names));
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "memory_evolve", "memory_correct", "memory_restore",
    ]));

    await tools.find((tool) => tool.name === "memory_history")!.execute({
      lineageId: "release", scope: attackerScope,
    });
    await tools.find((tool) => tool.name === "memory_recall_as_of")!.execute({
      lineageId: "release", asOf: 100, scope: attackerScope,
    });
    await expect(tools.find((tool) => tool.name === "memory_recall_as_of")!.execute({
      lineageId: "release", asOf: "昨天", timezoneOffsetMinutes: 480,
      scope: attackerScope,
    })).resolves.toMatchObject({ asOfResolution: { original: "昨天" } });
    await tools.find((tool) => tool.name === "memory_expire")!.execute({
      lineageId: "release", expectedHeadRevision: 2, validTo: 200,
      idempotencyKey: "expire-1", scope: attackerScope,
    });
    await tools.find((tool) => tool.name === "memory_revoke")!.execute({
      lineageId: "release", expectedHeadRevision: 2, reason: "withdrawn",
      idempotencyKey: "revoke-1", scope: attackerScope,
    });
    await tools.find((tool) => tool.name === "memory_purge")!.execute({
      lineageId: "release", confirmation: "PURGE",
      idempotencyKey: "purge-1", scope: attackerScope,
    });
    const transition = {
      lineageId: "release",
      expectedHeadRevision: 2,
      expectedHeadVersionId: "11111111-1111-4111-8111-111111111112",
      validFrom: 300,
      text: "CI approval release",
      kind: "decision",
      semanticType: "rules",
      evidenceIds: ["evidence-3"],
      idempotencyKey: "transition-3",
      scope: attackerScope,
    };
    await tools.find((tool) => tool.name === "memory_evolve")!.execute(transition);
    await tools.find((tool) => tool.name === "memory_correct")!.execute({
      ...transition, idempotencyKey: "correct-3", reason: "old content was wrong",
    });
    await tools.find((tool) => tool.name === "memory_restore")!.execute({
      ...transition,
      expectedHeadVersionId: undefined,
      sourceVersionId: "11111111-1111-4111-8111-111111111111",
      idempotencyKey: "restore-3",
    });

    expect(captured).toHaveLength(6);
    for (const resolved of captured) {
      expect(resolved).toMatchObject({
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        visibility: "private",
      });
    }
    expect(writeCommands.map((command) => command.type === "correctMemory" &&
      command.correctionKind === "replaceText" ? command.temporal?.transitionType : undefined))
      .toEqual(["evolved", "corrected", "restored"]);
    for (const command of writeCommands) {
      expect(command.clientScope).toMatchObject({
        tenantId: "server-tenant", userId: "server-user", visibility: "private",
      });
    }
  });

  test("session explain enforces authority session binding and stable not-found errors", async () => {
    const getLatest = vi.fn(async () => undefined);
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: { ...transportAuthority, sessionId: "session-owned" },
      defaultScope: {
        tenantId: transportAuthority.tenantId,
        userId: transportAuthority.userId,
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
        sessionId: "session-owned",
      },
      sessionReceipts: { getLatest } as never,
    });
    const tool = tools.find((candidate) => candidate.name === "memory_session_explain")!;
    await expect(tool.execute({ sessionId: "session-attacker" }))
      .rejects.toThrow(/sessionId does not match server authority/i);
    expect(getLatest).not.toHaveBeenCalled();
    await expect(tool.execute({ sessionId: "session-owned" }))
      .rejects.toThrow("Context assembly receipt not found");
    expect(getLatest).toHaveBeenCalledTimes(1);
  });

  test("server authority makes tenant/user client override zero across save/recall/context/observe/forget", async () => {
    const service = new FakeMemoryService();
    const capturedScopes: unknown[] = [];
    const executeMemoryWrite = vi.fn(async (command: MemoryWriteCommand) => {
      capturedScopes.push(command.clientScope);
      return {
        status: "persisted" as const,
        route: "active" as const,
        recordType: "memory" as const,
        memoryId: "mem-1",
        stored: true,
      };
    });
    service.recall = (async (input: { scope: unknown }) => {
      capturedScopes.push(input.scope);
      return { scope, query: "", hits: [] };
    }) as unknown as typeof service.recall;
    service.buildContext = (async (input: { scope: unknown }) => {
      capturedScopes.push(input.scope);
      return { scope, content: "", hits: [], tokenEstimate: 0 };
    }) as unknown as typeof service.buildContext;
    const forgetService = {
      async forget(input: { clientScope: unknown; serverAuthority: AuthorityScope }) {
        capturedScopes.push({
          ...(input.clientScope as Record<string, unknown>),
          tenantId: input.serverAuthority.tenantId,
          userId: input.serverAuthority.userId,
        });
        return {
          action: "delete" as const,
          affected: 0,
          deleted: 0,
          affectedIds: [],
          transactional: true as const,
          idempotentReplay: false,
        };
      },
    };
    const tools = createMcpMemoryTools({
      service,
      memoryWrite: { executeMemoryWrite },
      forgetCapability: mintedForgetCapability(forgetService as never),
      authority: transportAuthority,
      defaultScope: {
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
      },
    });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await byName.memory_save.execute({
      text: "save",
      scope: attackerScope,
      idempotencyKey: "mcp-save-1",
    });
    await byName.memory_recall.execute({ query: "recall", scope: attackerScope });
    await byName.memory_context.execute({ query: "context", scope: attackerScope });
    await byName.memory_observe.execute({
      text: "observe",
      semanticType: "experience",
      scope: attackerScope,
      idempotencyKey: "mcp-observe-1",
    });
    await byName.memory_forget.execute({
      filter: { category: "core" },
      scope: attackerScope,
      idempotencyKey: "request-1",
    });

    expect(capturedScopes).toHaveLength(5);
    for (const captured of capturedScopes) {
      expect(captured).toMatchObject({ tenantId: "server-tenant", userId: "server-user" });
      expect(captured).not.toMatchObject({ tenantId: "attacker-tenant" });
    }
    expect(service.calls).not.toContain("storeMemory");
    expect(executeMemoryWrite).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: "saveExplicit",
      idempotencyKey: "mcp-save-1",
      serverAuthority: transportAuthority,
    }));
    expect(executeMemoryWrite).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: "observeAuto",
      intent: "auto",
      idempotencyKey: "mcp-observe-1",
      serverAuthority: transportAuthority,
    }));
  });

  test("server registry injects and snapshots workspaceId for the authorized project", async () => {
    const service = new FakeMemoryService();
    const capturedScopes: MemoryScope[] = [];
    service.recall = (async (input: { scope: MemoryScope }) => {
      capturedScopes.push(input.scope);
      return { scope: input.scope, query: "", hits: [] };
    }) as unknown as typeof service.recall;
    const bindings: Record<string, string> = { "project-1": "workspace-1" };
    const tools = createMcpMemoryTools({
      service,
      authority: transportAuthority,
      projectWorkspaceByProjectId: bindings,
      defaultScope: {
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
    });
    bindings["project-1"] = "workspace-mutated-after-start";

    const recall = tools.find((tool) => tool.name === "memory_recall")!;
    await recall.execute({ query: "registry mapping" });

    expect(capturedScopes).toEqual([
      expect.objectContaining({ projectId: "project-1", workspaceId: "workspace-1" }),
    ]);
    expect(
      (recall.inputSchema.properties as Record<string, { properties?: Record<string, unknown> }>)
        .scope.properties,
    ).not.toHaveProperty("workspaceId");
  });

  test("invalid server registry workspace binding fails closed at tool startup", () => {
    expect(() => createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      projectWorkspaceByProjectId: { "project-1": "../workspace" },
    })).toThrow(/workspaceId.*canonical/i);
  });

  test("authority save and observe fail closed without capability or idempotency key", async () => {
    const service = new FakeMemoryService();
    const tools = createMcpMemoryTools({ service, authority: transportAuthority });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_save.execute({ text: "save" })).rejects.toThrow(
      /idempotencyKey/,
    );
    await expect(byName.memory_observe.execute({
      text: "observe",
      semanticType: "experience",
      idempotencyKey: "mcp-observe-2",
    })).rejects.toThrow(/write capability is unavailable/i);
    expect(service.calls).not.toContain("storeMemory");
  });

  test("authority memory_save owns MCP source and rejects nested/top-level source spoofing", async () => {
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "memory-mcp-source",
      stored: true,
    }));
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });
    const save = tools.find((tool) => tool.name === "memory_save")!;

    await save.execute({
      idempotencyKey: "mcp-authoritative-source-1",
      text: "authoritative MCP source",
      metadata: { source: "agent", topLabel: "preserved" },
      provenance: { source: "system", sourceId: "top-source-id" },
      record: {
        text: "authoritative MCP source",
        metadata: { source: "scan", nestedLabel: "preserved" },
        provenance: {
          source: "user",
          sourceId: "message-real-2",
          messageId: "message-2",
        },
      },
    });

    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      metadata: {
        source: "mcp",
        topLabel: "preserved",
        nestedLabel: "preserved",
      },
      provenance: {
        source: "mcp",
        sourceId: "message-real-2",
        messageId: "message-2",
      },
    }));
  });

  test.each([
    ["invalid action", { action: "destroy", ids: ["mem-1"] }],
    ["non-string id", { ids: ["mem-1", 42] }],
    ["empty id", { ids: [""] }],
    ["duplicate ids", { ids: ["mem-1", "mem-1"] }],
  ])("RED: authority forget rejects %s before service", async (_label, invalid) => {
    const inputs: unknown[] = [];
    const forgetService = {
      async forget(input: unknown) {
        inputs.push(input);
        return { action: "delete" as const, affected: 0, deleted: 0, affectedIds: [], transactional: true as const, idempotentReplay: false };
      },
    };
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      forgetCapability: mintedForgetCapability(forgetService as never),
      authority: transportAuthority,
    });
    const forget = tools.find((tool) => tool.name === "memory_forget")!;

    await expect(forget.execute({
      ...invalid,
      scope: {
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
      idempotencyKey: "request-1",
    })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(inputs).toEqual([]);
  });
  test("exposes the planned core tool names", () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_save",
      "memory_recall",
      "memory_context",
      "memory_observe",
      "memory_ingest",
      "memory_namespaces",
      "memory_health",
    ]);
  });

  test("authority mode does not list memory_forget without explicit transactional capability", () => {
    const service = Object.assign(new FakeMemoryService(), {
      forget: async () => { throw new Error("method presence is not a capability"); },
    });
    const tools = createMcpMemoryTools({ service, authority: transportAuthority });
    expect(tools.map((tool) => tool.name)).not.toContain("memory_forget");
  });

  test("explicit structural fake capability still does not list memory_forget", () => {
    const forgetService = {
      forget: async () => ({
        action: "delete" as const,
        affected: 0,
        deleted: 0,
        affectedIds: [],
        transactional: true as const,
        idempotentReplay: false,
      }),
    };
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      forgetCapability: forgetService as never,
    });
    expect(tools.map((tool) => tool.name)).not.toContain("memory_forget");
  });

  test("maps core tools to MemoryService calls", async () => {
    const service = new FakeMemoryService();
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_save.execute({ record })).resolves.toEqual({ id: "mem-1", stored: true });
    await expect(byName.memory_observe.execute({ record })).resolves.toEqual({ id: "mem-1", stored: true });
    await expect(byName.memory_recall.execute({ query: "concise" })).resolves.toContain("User prefers concise replies");
    await expect(byName.memory_context.execute({ query: "concise" })).resolves.toMatchObject({ content: "safe" });
    await expect(byName.memory_health.execute({})).resolves.toEqual({ ok: true });

    expect(service.calls).toEqual([
      "storeMemory",
      "storeMemory",
      "recall",
      "buildContext",
      "health",
    ]);
  });

  test("memory_recall returns text-first output by default", async () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const result = await byName.memory_recall.execute({ query: "concise" });

    expect(result).toBe(
      `### 召回结果\n\n1. **相关度：${scoreBreakdown.score.toFixed(3)}**\n\n   User prefers concise replies`,
    );
    expect(result).not.toContain("scoreBreakdown");
    expect(result).not.toContain("\"record\"");
    expect(result).not.toContain("scope");
  });

  test("memory_recall raw preserves the complete production score breakdown without vectors", async () => {
    const service = new FakeMemoryService();
    service.recall = (async () => ({
      scope,
      query: "concise",
      filtered: [{
        candidateId: "tree:blocked",
        authoritativeRecordId: "memory-blocked",
        source: "tree",
        filteredReason: "risk_blocked",
      }],
      hits: [{
        record: {
          ...record,
          vector: [0.1, 0.2, 0.3],
          metadata: { internal: true },
          provenance: { source: "test" },
        },
        score: scoreBreakdown.score,
        source: "vector",
        scoreBreakdown,
      }],
    })) as unknown as typeof service.recall;
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_recall.execute({ query: "concise", raw: true })).resolves.toEqual({
      query: "concise",
      hits: [
        {
          text: "User prefers concise replies",
          score: scoreBreakdown.score,
          source: "vector",
          scoreBreakdown,
        },
      ],
      filtered: [{
        candidateId: "tree:blocked",
        authoritativeRecordId: "memory-blocked",
        source: "tree",
        filteredReason: "risk_blocked",
      }],
    });
  });

  test("memory_recall fails closed when a production hit lacks a complete breakdown", async () => {
    const service = new FakeMemoryService();
    service.recall = (async () => ({
      scope,
      query: "concise",
      hits: [{ record, score: 0.9, source: "vector", scoreBreakdown: { vector: 0.9 } }],
    })) as unknown as typeof service.recall;
    const recall = createMcpMemoryTools({ unsafeLegacyScope: true, service })
      .find((tool) => tool.name === "memory_recall")!;

    await expect(recall.execute({ query: "concise", raw: true })).rejects.toThrow(
      "RECALL_SCORE_BREAKDOWN_REQUIRED",
    );
  });

  test("memory_context preserves the production breakdown and fails closed when it is missing", async () => {
    const service = new FakeMemoryService();
    const context = createMcpMemoryTools({ unsafeLegacyScope: true, service })
      .find((tool) => tool.name === "memory_context")!;

    await expect(context.execute({ query: "concise" })).resolves.toMatchObject({
      hits: [{ score: scoreBreakdown.score, scoreBreakdown }],
    });

    service.buildContext = async () => ({
      scope,
      content: "invalid",
      hits: [{ record, score: 0.9, source: "vector" }],
    });
    await expect(context.execute({ query: "concise" })).rejects.toThrow(
      "RECALL_SCORE_BREAKDOWN_REQUIRED",
    );
  });

  test("memory_recall explain renders the same six-factor breakdown", async () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const result = await byName.memory_recall.execute({ query: "concise", explain: true });

    expect(result).toContain("### 召回结果");
    expect(result).toContain(`**相关度：${scoreBreakdown.score.toFixed(3)}**`);
    expect(result).toContain(
      `relevance: value=${scoreBreakdown.factors.relevance.toFixed(3)}, contribution=${scoreBreakdown.contributions.relevance.toFixed(3)}`,
    );
    expect(result).toContain(`total: ${scoreBreakdown.score.toFixed(3)}`);
    expect(result).not.toContain("scoreBreakdown");
  });

  test("memory_recall compacts long text items by default", async () => {
    const longRecord = {
      ...record,
      text: `start ${"x".repeat(900)} end`,
    };
    const longBreakdown = computeRecallScoreBreakdown(
      longRecord,
      { relevance: 0.9, scopeFit: 1 },
      ["vector"],
      { vector: 0.9 },
    );
    const service = new FakeMemoryService();
    service.recall = (async () => ({
      scope,
      query: "long",
      hits: [{
        record: longRecord,
        score: longBreakdown.score,
        source: "vector",
        scoreBreakdown: longBreakdown,
      }],
    })) as unknown as typeof service.recall;
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const result = await byName.memory_recall.execute({ query: "long", maxTextChars: 120 });

    expect(result).toContain(`1. **相关度：${longBreakdown.score.toFixed(3)}**`);
    expect(result).toContain("start ");
    expect(result).toContain("...");
    expect(result).not.toContain(" end");
  });

  test("memory_save accepts top-level text and normalizes it to a record", async () => {
    let capturedInput: unknown = null;
    const service = new FakeMemoryService();
    service.storeMemory = (async (input: unknown) => {
      capturedInput = input;
      return { id: "mem-1", stored: true };
    }) as unknown as typeof service.storeMemory;

    const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
      service,
      defaultScope: {
        tenantId: "local",
        appId: "mengshu",
        projectId: "memory-autodb",
      },
    });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(
      byName.memory_save.execute({
        text: "Claude Code should be able to save this memory.",
        scope: { appId: "claude-code", namespace: "working-context" },
        metadata: { source: "claude-code" },
      }),
    ).resolves.toEqual({ id: "mem-1", stored: true });

    expect(capturedInput).toMatchObject({
      record: expect.objectContaining({
        text: "Claude Code should be able to save this memory.",
        kind: "other",
        category: "other",
        dataType: "memory",
        tableName: "memories",
        metadata: { source: "mcp" },
        provenance: { source: "mcp" },
        scope: expect.objectContaining({
          tenantId: "local",
          appId: "claude-code",
          projectId: "memory-autodb",
          namespace: "working-context",
        }),
      }),
    });
    const normalized = capturedInput as { record: { id: string; contentHash: string; createdAt: number } };
    expect(normalized.record.id).toMatch(/[0-9a-f-]{36}/);
    expect(normalized.record.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(normalized.record.createdAt).toBeGreaterThan(0);
  });

  test.each([
    ["top-level text", { text: "saved from Codex" }],
    ["top-level content alias", { content: "saved from a cached client" }],
    ["record.text", { record: { text: "saved from Claude" } }],
    ["record.content alias", { record: { content: "saved from Banto" } }],
  ])("memory_save accepts %s on the first execution", async (_label, input) => {
    const captured: unknown[] = [];
    const service = new FakeMemoryService();
    service.storeMemory = (async (storeInput: unknown) => {
      captured.push(storeInput);
      return { id: "mem-1", stored: true };
    }) as unknown as typeof service.storeMemory;
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });
    const save = tools.find((tool) => tool.name === "memory_save")!;

    await expect(save.execute(input)).resolves.toEqual({ id: "mem-1", stored: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      record: expect.objectContaining({ text: expect.stringMatching(/^saved from/) }),
    });
  });

  test("memory_save schema recommends text while declaring compatibility aliases", () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const save = tools.find((tool) => tool.name === "memory_save");
    const schema = save?.inputSchema as {
      description?: string;
      required?: string[];
      properties?: {
        text?: { minLength?: number; description?: string };
        content?: { minLength?: number; description?: string };
        record?: { type?: string; properties?: Record<string, unknown> };
        metadata?: { type?: string; additionalProperties?: boolean };
      };
      anyOf?: Array<{ required?: string[] }>;
    };

    expect(save?.description).toContain("top-level `text`");
    expect(save?.description).toContain("compatibility");
    expect(schema.description).toContain("top-level `text`");
    expect(schema.description).toContain("compatibility");
    expect(schema.properties?.text?.minLength).toBe(1);
    expect(schema.properties?.text?.description).toContain("Required memory body text");
    expect(schema.properties?.content?.minLength).toBe(1);
    expect(schema.properties?.record?.type).toBe("object");
    expect(schema.required).toBeUndefined();
    expect(schema.anyOf?.map((entry) => entry.required)).toEqual([
      ["text"],
      ["content"],
      ["record"],
    ]);
    expect(schema.properties?.metadata?.additionalProperties).toBe(true);
  });

  test("memory_save fails fast with an actionable text-field hint", async () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_save.execute({ title: "missing body" })).rejects.toThrow(
      /requires non-empty memory text.*text.*content/,
    );
  });

  test("authority memory_observe requires a valid 5-slot semanticType and maps top-level input", async () => {
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "candidate" as const,
      recordType: "candidate" as const,
      candidateId: "candidate-1",
      memoryId: "candidate-1",
      stored: true,
    }));
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });
    const observe = tools.find((tool) => tool.name === "memory_observe")!;

    await expect(observe.execute({
      text: "A governed observation with an explicit semantic view",
      idempotencyKey: "observe-semantic-1",
    })).rejects.toThrow(/requires semanticType/);
    await expect(observe.execute({
      text: "A governed observation with an invalid semantic view",
      semanticType: "general",
      idempotencyKey: "observe-semantic-2",
    })).rejects.toThrow(/5-slot semantic types/);
    expect(executeMemoryWrite).not.toHaveBeenCalled();

    await observe.execute({
      text: "A governed observation with an explicit semantic view",
      semanticType: "experience",
      idempotencyKey: "observe-semantic-3",
    });
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "observeAuto",
      semanticType: "experience",
      category: "other",
      kind: "other",
    }));
  });

  test("authority narrows the advertised visibility values to avoid first-call rejection", () => {
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
    });
    const save = tools.find((tool) => tool.name === "memory_save")!;
    const schema = save.inputSchema as {
      properties: {
        scope: {
          properties: {
            appId: { enum: string[] };
            agentId: { enum: string[] };
            visibility: { enum: string[]; description: string };
          };
        };
      };
    };

    expect(schema.properties.scope.properties.appId.enum).toEqual(["mengshu"]);
    expect(schema.properties.scope.properties.agentId.enum).toEqual(["agent-1"]);
    expect(schema.properties.scope.properties.visibility.enum).toEqual(["private"]);
    expect(schema.properties.scope.properties.visibility.description).toContain("omit");
  });

  test("memory_recall schema explains hard filters and compact raw output", () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const recall = tools.find((tool) => tool.name === "memory_recall")!;
    const schema = recall.inputSchema as {
      properties: {
        filterProject: { description: string };
        filterProduct: { description: string };
        projectPattern: { description: string };
        format: { description: string };
        raw: { description: string };
        explain: { description: string };
      };
    };

    expect(schema.properties.filterProject.description).toContain("scopeFilterMode='hard'");
    expect(schema.properties.filterProduct.description).toContain("scopeFilterMode='hard'");
    expect(schema.properties.projectPattern.description).toContain("scopeFilterMode='hard'");
    expect(schema.properties.format.description).not.toContain("完整结构化结果");
    expect(schema.properties.raw.description).toContain("complete six-factor scoreBreakdown");
    expect(schema.properties.explain.description).toContain("six-factor");
  });

  test("reports namespaces from configured defaults", async () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      namespaces: ["memories", "knowledge"],
    });
    const namespaces = tools.find((tool) => tool.name === "memory_namespaces");

    await expect(namespaces?.execute({})).resolves.toEqual({ namespaces: ["memories", "knowledge"] });
  });

  test("authority mode reports only allowlisted namespaces", async () => {
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      defaultScope: {
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
      namespaces: ["memories", "knowledge"],
    });
    const namespaces = tools.find((tool) => tool.name === "memory_namespaces");

    await expect(namespaces?.execute({})).resolves.toEqual({ namespaces: ["memories"] });
  });

  test("memory_health omits global counts and raw provider errors", async () => {
    const service = new FakeMemoryService();
    service.health = vi.fn(async () => ({
      ok: false,
      records: 12345,
      error: "postgres://user:raw-secret@host/db",
    }));
    const tools = createMcpMemoryTools({
      service,
      authority: transportAuthority,
      defaultScope: {
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
    });
    const health = tools.find((tool) => tool.name === "memory_health");

    await expect(health?.execute({})).resolves.toEqual({
      ok: false,
      code: "SERVICE_UNAVAILABLE",
    });
  });

  test("memory_ingest stays unimplemented when no pipeline is injected", async () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    const ingest = tools.find((tool) => tool.name === "memory_ingest");

    const result = (await ingest?.execute({ source: "file-system" })) as {
      status?: string;
      error?: string;
      hint?: string;
    };
    expect(result.status).toBe("not_implemented");
    expect(result.error).toMatch(/暂未开放|roadmap/i);
    // 必须给出可操作替代方案，避免调用方误判为配置错误。
    expect(result.hint).toMatch(/memory_observe|memory_save|ms scan/);
  });

  describe("memory_ingest with injected pipeline", () => {
    let tmpDir: string;
    let mdPath: string;

    beforeAll(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mengshu-ingest-tool-"));
      mdPath = path.join(tmpDir, "doc.md");
      fs.writeFileSync(mdPath, "# Title\n\nsome body content for ingest");
    });

    afterAll(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    test("ingests raw text and returns document summary", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: "hello world body",
        sourceType: "text",
        scope: ingestScope,
      })) as { documentId?: string; chunksAdmitted?: number };

      expect(result.documentId).toBe("doc:fake");
      expect(result.chunksAdmitted).toBe(2);
      expect(pipeline.inputs).toHaveLength(1);
      expect(pipeline.inputs[0].scope).toEqual(ingestScope);
      // prompt 注入防护：内容前应插入不可信数据警告 header。
      expect(pipeline.inputs[0].content).toMatch(/untrusted|不可信|do not follow/i);
      expect(pipeline.inputs[0].content).toContain("hello world body");
    });

    test("keeps raw document/chunk ingestion outside memory write and context/tree adapters", async () => {
      const store = new InMemoryMemoryStore({
        now: () => 1_800_000_000_000,
        idFactory: () => "ingest-generated-id",
      });
      const pipeline = new RealIngestionPipeline({
        documents: store.documents,
        chunks: store.chunks,
        jobs: store.jobs,
        audit: store.audit,
      });
      const service = new FakeMemoryService();
      const executeMemoryWrite = vi.fn();
      const authority: AuthorityScope = {
        ...transportAuthority,
        allow: { ...transportAuthority.allow, namespaces: ["memories", "knowledge"] },
      };
      const tools = createMcpMemoryTools({
        service,
        pipeline,
        memoryWrite: { executeMemoryWrite: executeMemoryWrite as never },
        authority,
        defaultScope: {
          tenantId: authority.tenantId,
          userId: authority.userId,
          appId: "mengshu",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "knowledge",
          visibility: "private",
        },
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest")!;

      const result = await ingest.execute({
        source: "raw knowledge is registered before any governed memory candidate exists",
        sourceType: "text",
        scope: { namespace: "knowledge" },
        chunkSize: 24,
      }) as { documentId: string; chunksAdmitted: number };

      expect(await store.documents.get(result.documentId)).toMatchObject({
        scope: expect.objectContaining({ namespace: "knowledge" }),
      });
      expect(await store.chunks.listByDocument(result.documentId)).toHaveLength(
        result.chunksAdmitted,
      );
      expect(await store.jobs.list("queued")).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "embed_chunk" }),
      ]));
      expect(await store.audit.list()).toEqual([
        expect.objectContaining({ action: "ingest.document", targetId: result.documentId }),
      ]);
      expect(executeMemoryWrite).not.toHaveBeenCalled();
      expect(service.calls).not.toContain("storeMemory");
      expect(service.calls).not.toContain("buildContext");
    });

    test("ingests a file path via safe loader", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: mdPath,
        sourceType: "file",
        scope: ingestScope,
      })) as { documentId?: string };

      expect(result.documentId).toBe("doc:fake");
      expect(pipeline.inputs).toHaveLength(1);
      expect(pipeline.inputs[0].content).toContain("some body content for ingest");
    });

    test("dryRun returns chunk preview without persisting", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      const result = (await ingest?.execute({
        source: "preview body content",
        sourceType: "text",
        scope: ingestScope,
        dryRun: true,
      })) as { dryRun?: boolean; chunkCount?: number };

      expect(result.dryRun).toBe(true);
      expect(result.chunkCount).toBeGreaterThanOrEqual(1);
      // dryRun 不得触达持久化 pipeline。
      expect(pipeline.inputs).toHaveLength(0);
    });

    test("rejects path traversal in file source", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      await expect(
        ingest?.execute({ source: "../../etc/passwd", sourceType: "file", scope: ingestScope }),
      ).rejects.toThrow(/path traversal|遍历|\.\./i);
      expect(pipeline.inputs).toHaveLength(0);
    });

    test("rejects unsupported file extension", async () => {
      const pipeline = new FakePipeline();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        pipeline: pipeline as unknown as IngestionPipeline,
      });
      const ingest = tools.find((tool) => tool.name === "memory_ingest");

      await expect(
        ingest?.execute({ source: "/tmp/script.sh", sourceType: "file", scope: ingestScope }),
      ).rejects.toThrow(/unsupported|扩展名|extension/i);
      expect(pipeline.inputs).toHaveLength(0);
    });
  });

  test("every tool exposes a JSON Schema inputSchema object", () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    for (const tool of tools) {
      expect(tool.inputSchema).toBeTypeOf("object");
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema).toHaveProperty("properties");
    }
  });

  test("keeps 7 safe base tools when no agentFastPath is injected", () => {
    const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service: new FakeMemoryService() });
    expect(tools).toHaveLength(7);
    expect(tools.map((tool) => tool.name)).not.toContain("memory_context_fast");
  });

  test("adds 5 progressive-disclosure fast-path tools when agentFastPath is injected", async () => {
    const calls: string[] = [];
    const fastPath = {
      async context() {
        calls.push("context");
        return { scope, slots: {}, content: "ctx" };
      },
      async observeLight() {
        calls.push("observeLight");
        return { ack: true as const, traceId: "t-1", queuedJobs: [] };
      },
      async lookup() {
        calls.push("lookup");
        return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } };
      },
      async navigate() {
        calls.push("navigate");
        return { ref: "memory-1", items: [] };
      },
      async evidenceRead() {
        calls.push("evidenceRead");
        return { evidence: [] };
      },
    };

    const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      // 只用到 3 个方法，用最小桩替身注入
      agentFastPath: fastPath as unknown as Parameters<
        typeof createMcpMemoryTools
      >[0]["agentFastPath"],
    });

    expect(tools).toHaveLength(12);
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("memory_context_fast");
    expect(names).toContain("memory_observe_light");
    expect(names).toContain("memory_lookup");
    expect(names).toContain("memory_navigate");
    expect(names).toContain("memory_evidence_read");

    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    await byName.memory_context_fast.execute({ scope, task: "t" });
    await byName.memory_observe_light.execute({ scope, eventType: "user_input", text: "x" });
    await byName.memory_lookup.execute({ scope, query: "q" });
    await byName.memory_navigate.execute({ scope, ref: "memory-1", level: "R0" });
    await byName.memory_evidence_read.execute({ scope, refs: ["evidence-1"] });

    expect(calls).toEqual(["context", "observeLight", "lookup", "navigate", "evidenceRead"]);
  });

  test("memory_context_fast fails closed when slot receipts are missing", async () => {
    const fastPath = {
      async context() {
        return {
          scope,
          slots: {
            rules: {
              semanticType: "rules" as const,
              question: "Q3",
              content: record.text,
              sourceIds: [record.id],
              nodeCount: 1,
            },
          },
          content: record.text,
          telemetry: { latencyMs: 1, nodesUsed: 1, cacheHit: false },
        };
      },
      async observeLight() { return { ack: true as const, traceId: "t", queuedJobs: [] }; },
      async lookup() { return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } }; },
    };
    const context = createMcpMemoryTools({
      unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      agentFastPath: fastPath as never,
    }).find((tool) => tool.name === "memory_context_fast")!;

    await expect(context.execute({ scope, task: "load context" })).rejects.toThrow(
      "CONTEXT_RECALL_BREAKDOWN_REQUIRED",
    );
  });

  test("authority memory_observe_light requires the write-kernel combination and forwards server scope/idempotency", async () => {
    const observed: AgentObserveLightRequest[] = [];
    const fastPath = {
      async context() { return { scope, slots: {}, content: "" }; },
      async observeLight(input: AgentObserveLightRequest) {
        observed.push(input);
        return {
          ack: true as const,
          traceId: "trace-light-1",
          persistedId: "evidence-light-1",
          stored: true,
          queuedJobs: ["extract-candidate-1"],
        };
      },
      async lookup() { return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } }; },
    };
    const memoryWrite = { executeMemoryWrite: vi.fn() as never };
    const tools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryWrite,
      agentFastPath: fastPath as never,
    });
    const observeLight = tools.find((tool) => tool.name === "memory_observe_light")!;

    const schema = observeLight.inputSchema as { required: string[] };
    expect(schema.required).toContain("idempotencyKey");
    await expect(observeLight.execute({
      scope: attackerScope,
      eventType: "user_input",
      text: "raw event",
    })).rejects.toThrow(/idempotencyKey/);
    expect(observed).toEqual([]);

    await observeLight.execute({
      scope: attackerScope,
      eventType: "user_input",
      text: "raw event",
      idempotencyKey: "observe-light-1",
      metadata: { tenantId: "attacker-metadata" },
    });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      idempotencyKey: "observe-light-1",
      scope: {
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
    });
    expect(observed[0].scope).not.toMatchObject({ tenantId: "attacker-tenant" });
    // MCP does not call the kernel separately: Runtime AgentFastPath owns the
    // single evidence write plus candidate-job composition.
    expect(memoryWrite.executeMemoryWrite).not.toHaveBeenCalled();

    const missingKernelTools = createMcpMemoryTools({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      agentFastPath: fastPath as never,
    });
    const missingKernel = missingKernelTools.find((tool) => tool.name === "memory_observe_light")!;
    await expect(missingKernel.execute({
      scope: attackerScope,
      eventType: "user_input",
      text: "must fail closed",
      idempotencyKey: "observe-light-2",
    })).rejects.toThrow(/write capability is unavailable/i);
    expect(observed).toHaveLength(1);
  });

  test("memory_lookup preserves the AgentFastPath complete breakdown", async () => {
    const lookupHit = {
      id: record.id,
      preview: record.text,
      score: scoreBreakdown.score,
      scoreBreakdown,
      source: "vector",
      evidence: [],
      actions: ["copy_reference" as const],
    };
    const fastPath = {
      async context() { return { scope, slots: {}, content: "" }; },
      async observeLight() { return { ack: true as const, traceId: "t", queuedJobs: [] }; },
      async lookup() {
        return { hits: [lookupHit], telemetry: { latencyMs: 1, mode: "fast" as const } };
      },
    };
    const lookup = createMcpMemoryTools({
      unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      agentFastPath: fastPath as never,
    }).find((tool) => tool.name === "memory_lookup")!;

    const result = await lookup.execute({ scope, query: "concise" }) as {
      hits: typeof lookupHit[];
    };
    expect(result.hits[0].scoreBreakdown).toBe(scoreBreakdown);
    expect(result.hits[0]).toEqual(lookupHit);
  });

  test("memory_lookup fails closed when AgentFastPath omits the complete breakdown", async () => {
    const fastPath = {
      async context() { return { scope, slots: {}, content: "" }; },
      async observeLight() { return { ack: true as const, traceId: "t", queuedJobs: [] }; },
      async lookup() {
        return {
          hits: [{ id: record.id, preview: record.text, score: 0.9, source: "vector", evidence: [], actions: [] }],
          telemetry: { latencyMs: 1, mode: "fast" as const },
        };
      },
    };
    const lookup = createMcpMemoryTools({
      unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      agentFastPath: fastPath as never,
    }).find((tool) => tool.name === "memory_lookup")!;

    await expect(lookup.execute({ scope, query: "concise" })).rejects.toThrow(
      "RECALL_SCORE_BREAKDOWN_REQUIRED",
    );
  });

  describe("defaultScope 自动填充（DEFECT-001 修复）", () => {
    test("未配置 defaultScope 时，客户端未传递 scope 不会崩溃", async () => {
      const service = new FakeMemoryService();
      const tools = createMcpMemoryTools({ unsafeLegacyScope: true, service });
      const observeTool = tools.find((t) => t.name === "memory_observe");

      // 客户端未传递 scope
      await expect(
        observeTool!.execute({
          record: {
            id: "test-1",
            text: "test content",
            kind: "preference",
            contentHash: "hash-1",
            importance: 0.5,
            category: "test",
            dataType: "memory",
            tableName: "memories",
            metadata: {},
            provenance: {},
            createdAt: Date.now(),
            // scope 未传递
          },
        })
      ).resolves.toBeDefined();

      expect(service.calls).toContain("storeMemory");
    });

    test("配置 defaultScope 后，自动填充到客户端调用中", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.storeMemory = (async (input: unknown) => {
        capturedInput = input;
        return { id: "mem-1", stored: true };
      }) as unknown as typeof service.storeMemory;

      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service,
        defaultScope: {
          tenantId: "claude-code",
          appId: "mengshu",
          projectId: "memory-autodb",
        },
      });

      const observeTool = tools.find((t) => t.name === "memory_observe");
      await observeTool!.execute({
        record: {
          id: "test-2",
          text: "test content",
          kind: "preference",
          contentHash: "hash-2",
          importance: 0.5,
          category: "test",
          dataType: "memory",
          tableName: "memories",
          metadata: {},
          provenance: {},
          createdAt: Date.now(),
          // 客户端未传递 scope
        },
      });

      // 验证 scope 包含了默认值
      expect(capturedInput).toMatchObject({
        record: expect.objectContaining({
          scope: expect.objectContaining({
            tenantId: "claude-code",
            appId: "mengshu",
            projectId: "memory-autodb",
          }),
        }),
      });
    });

    test("客户端传递的 scope 字段优先级高于 defaultScope", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.storeMemory = (async (input: unknown) => {
        capturedInput = input;
        return { id: "mem-1", stored: true };
      }) as unknown as typeof service.storeMemory;

      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service,
        defaultScope: {
          tenantId: "default-tenant",
          appId: "default-app",
        },
      });

      const observeTool = tools.find((t) => t.name === "memory_observe");
      await observeTool!.execute({
        record: {
          id: "test-3",
          text: "test content",
          kind: "preference",
          contentHash: "hash-3",
          importance: 0.5,
          category: "test",
          dataType: "memory",
          tableName: "memories",
          metadata: {},
          provenance: {},
          createdAt: Date.now(),
          scope: {
            tenantId: "custom-tenant", // 客户端传递的优先
            // appId 未传递，应使用默认值
          },
        },
      });

      // 验证：tenantId 使用客户端传递的，appId 使用默认值
      expect(capturedInput).toMatchObject({
        record: expect.objectContaining({
          scope: expect.objectContaining({
            tenantId: "custom-tenant", // 客户端值
            appId: "default-app", // 默认值
          }),
        }),
      });
    });

    test("memory_recall 也应用 defaultScope", async () => {
      let capturedInput: unknown = null;
      const service = new FakeMemoryService();
      service.recall = (async (input: unknown) => {
        capturedInput = input;
        return { scope: scope, query: "", hits: [] };
      }) as unknown as typeof service.recall;

      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service,
        defaultScope: {
          tenantId: "recall-tenant",
        },
      });

      const recallTool = tools.find((t) => t.name === "memory_recall");
      await recallTool!.execute({
        query: "test query",
        // scope 未传递
      });

      expect(capturedInput).toMatchObject({
        scope: expect.objectContaining({
          tenantId: "recall-tenant",
        }),
      });
    });

    test("fast path 工具也应用 defaultScope", async () => {
      let capturedInput: unknown = null;
      const fastPath = {
        async context(input: unknown) {
          capturedInput = input;
          return { scope: {}, slots: {}, content: "ctx" };
        },
        async observeLight() {
          return { ack: true as const, traceId: "t-1", queuedJobs: [] };
        },
        async lookup() {
          return { hits: [], telemetry: { latencyMs: 1, mode: "fast" as const } };
        },
      };

      const tools = createMcpMemoryTools({ unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        agentFastPath: fastPath as unknown as Parameters<
          typeof createMcpMemoryTools
        >[0]["agentFastPath"],
        defaultScope: {
          tenantId: "fastpath-tenant",
          projectId: "fastpath-project",
        },
      });

      const contextFastTool = tools.find((t) => t.name === "memory_context_fast");
      await contextFastTool!.execute({
        task: "test task",
        // scope 未传递
      });

      expect(capturedInput).toMatchObject({
        scope: expect.objectContaining({
          tenantId: "fastpath-tenant",
          projectId: "fastpath-project",
        }),
      });
    });

    test("Skill 与 Policy 工具声明所有可执行入参，避免 MCP schema 拒绝合法调用", () => {
      const tools = createMcpMemoryTools({
        unsafeLegacyScope: true,
        service: new FakeMemoryService(),
        defaultScope: scope,
        skillArtifacts: {
          proposeFromCandidate: vi.fn(),
          importCurated: vi.fn(),
          review: vi.fn(),
          publish: vi.fn(),
          read: vi.fn(),
          search: vi.fn(),
        } as never,
        memoryPolicy: {
          mutations: { appendVersion: vi.fn() },
          resolver: { resolve: vi.fn() },
        } as never,
      });
      const requiredProperties: Readonly<Record<string, readonly string[]>> = {
        memory_skill_propose: ["ownerUserId", "candidateId", "skillId", "expectedLatestVersion",
          "manifest", "expectedOutcomePolicyVersion", "idempotencyKey"],
        memory_skill_import_curated: ["ownerUserId", "skillId", "expectedLatestVersion", "title",
          "description", "triggerConditions", "preconditions", "steps", "successSignals",
          "antiPatterns", "riskBoundaries", "evidenceMemoryIds", "evidenceChunkIds", "manifest",
          "expectedOutcomePolicyVersion", "provenanceRef", "license", "idempotencyKey"],
        memory_skill_review: ["skillId", "expectedLatestVersion", "reviewerUserId", "decision",
          "reason", "idempotencyKey"],
        memory_skill_publish: ["skillId", "expectedLatestVersion", "reviewerUserId",
          "reviewReceiptId", "idempotencyKey"],
        memory_skill_read: ["skillId", "version"],
        memory_skill_search: ["query", "limit", "embeddingAvailable"],
        memory_policy_append: ["id", "expectedLatestVersion", "idempotencyKey", "ownerUserId",
          "target", "layer", "focusHints", "ignoreHints", "aggregationHints", "status"],
      };
      for (const [name, properties] of Object.entries(requiredProperties)) {
        const schema = tools.find((tool) => tool.name === name)?.inputSchema as {
          properties?: Record<string, unknown>;
          additionalProperties?: boolean;
        };
        expect(schema.additionalProperties, name).toBe(false);
        expect(Object.keys(schema.properties ?? {}), name).toEqual(
          expect.arrayContaining(["scope", ...properties]),
        );
      }
    });
  });
});
