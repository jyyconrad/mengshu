import { describe, expect, test, vi } from "vitest";
import type { MemoryService } from "../../../../core/service-types.js";
import type { ContextBlock, MemoryRecord, RecallResult } from "../../../../core/types.js";
import { InMemoryGraphRepository } from "../../../../graph/repository.js";
import { GraphQueryService } from "../../../../graph/query.js";
import { createConsoleApi } from "../../../../console/api.js";
import { InMemoryCandidateRepository } from "../../../../lifecycle/candidate-repository.js";
import { CandidateReviewService } from "../../../../lifecycle/candidate-review.js";
import { createRestApi, createRestRouter } from "./router.js";
import type { AuthorityScope } from "../../../core/src/domain/authority-scope.js";
import type { MemoryConfig } from "../../../../config.js";
import type {
  MemoryWriteCommand,
  MemoryWriteKernelResult,
} from "../../../core/src/service/write-kernel.js";
import { computeRecallScoreBreakdown } from "../../../../core/recall-scoring.js";

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

const transportAuthority: AuthorityScope = {
  tenantId: "server-tenant",
  userId: "server-user",
  allow: {
    appIds: ["rest"],
    projectIds: ["project-1"],
    agentIds: ["agent-1"],
    namespaces: ["memories"],
    visibilities: ["private"],
  },
};

const attackerScope = {
  tenantId: "attacker-tenant",
  userId: "attacker-user",
  appId: "rest",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
  visibility: "private",
};

const restConfig: MemoryConfig = {
  embedding: {
    provider: "openai",
    apiKey: "test-key",
    baseURL: "http://127.0.0.1:9/v1",
    model: "text-embedding-3-small",
  },
  dbType: "lancedb",
  dbPath: "/tmp/mengshu-rest-router-test",
};

class FakeMemoryService implements MemoryService {
  async storeMemory() {
    return { id: "mem-1", stored: true };
  }

  async recall(): Promise<RecallResult> {
    return {
      scope,
      query: "concise",
      hits: [{ record, score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
    };
  }

  async buildContext(): Promise<ContextBlock> {
    return {
      scope,
      content: "<retrieved-context>safe</retrieved-context>",
      hits: [{ record, score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
      tokenEstimate: 8,
    };
  }

  async delete() {
    return { deleted: 0 };
  }

  async health() {
    return { ok: true, records: 1 };
  }
}

describe("REST router", () => {
  test("runtime-owned MCP facade exposes immutable descriptors and delegates calls", async () => {
    const callTool = vi.fn(async (name: string) => ({ name, ok: true }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      runtimeControl: {
        snapshot: () => ({
          protocolVersion: 1, ownerId: "runtime-owner", homeFingerprint: "a".repeat(64),
          generation: 1, state: "ready", ready: true, accepting: true, workerOwner: true,
        }),
      },
      runtimeMcp: {
        listTools: () => [{
          name: "memory_health", description: "Health", inputSchema: { type: "object" },
        }],
        callTool,
      },
    });

    await expect(router.handle({
      method: "GET", path: "/v1/runtime/mcp-tools", headers: {},
    })).resolves.toMatchObject({
      status: 200,
      body: { tools: [{ name: "memory_health", inputSchema: { type: "object" } }] },
    });
    await expect(router.handle({
      method: "POST", path: "/v1/runtime/mcp-call", headers: {},
      body: { name: "memory_health", arguments: {} },
    })).resolves.toEqual({ status: 200, body: { name: "memory_health", ok: true } });
    expect(callTool).toHaveBeenCalledWith("memory_health", {});
    await expect(router.handle({
      method: "POST", path: "/v1/runtime/mcp-call", headers: {},
      body: { name: "memory_health", arguments: {}, authority: attackerScope },
    })).resolves.toMatchObject({ status: 400 });
  });

  test("curated Skill import delegates through the server-owned exact scope", async () => {
    const importCurated = vi.fn(async (input: { scope: unknown }) => ({
      artifact: { skillId: "skill-curated", version: 1, status: "draft", scope: input.scope },
      receipt: { operation: "propose" },
      replayed: false,
    }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      skillArtifacts: { importCurated } as never,
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/skills/import-curated",
      headers: {},
      body: {
        scope: attackerScope,
        ownerUserId: "server-user",
        skillId: "skill-curated",
        expectedLatestVersion: 0,
        title: "Curated release",
        description: "A source procedure",
        triggerConditions: ["release"], preconditions: ["green"], steps: ["approve"],
        successSignals: ["healthy"], antiPatterns: ["bypass"],
        riskBoundaries: ["no direct edits"], evidenceMemoryIds: ["memory-1"],
        evidenceChunkIds: ["evidence-1"],
        manifest: [{
          path: "SKILL.md", contentHash: "a".repeat(64), sizeBytes: 1,
          mimeType: "text/markdown", executable: false, provenanceRef: "source-1",
        }],
        expectedOutcomePolicyVersion: "outcome-v1",
        provenanceRef: "source-1",
        license: { spdxId: "Apache-2.0", sourceUrl: "https://example.test/skill" },
        idempotencyKey: "curated-import-1",
      },
    });

    expect(response).toMatchObject({ status: 201, body: { artifact: { status: "draft" } } });
    expect(importCurated).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({
        tenantId: "server-tenant", userId: "server-user", appId: "rest",
        projectId: "project-1", visibility: "private",
      }),
    }));
  });

  test("temporal history/as-of/expire/revoke/purge 全部使用 server-owned exact scope", async () => {
    const captured: unknown[] = [];
    const memoryEvolution = {
      history: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { lineageId: "release", versions: [], head: {}, scope: input.scope };
      }),
      recallAsOf: vi.fn(async (input: { scope: unknown }) => {
        captured.push(input.scope);
        return { lineageId: "release", revision: 1, historical: true };
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
        return { operationId: "purge-1", purgedVersions: 2 };
      }),
    };
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryEvolution: memoryEvolution as never,
    });
    const requests = [
      { path: "/v1/memories/history", body: { lineageId: "release", scope: attackerScope } },
      { path: "/v1/recall/as-of", body: { lineageId: "release", asOf: 100, scope: attackerScope } },
      { path: "/v1/memories/expire", body: {
        lineageId: "release", expectedHeadRevision: 2, validTo: 200,
        idempotencyKey: "expire-1", scope: attackerScope,
      } },
      { path: "/v1/memories/revoke", body: {
        lineageId: "release", expectedHeadRevision: 2, reason: "withdrawn",
        idempotencyKey: "revoke-1", scope: attackerScope,
      } },
      { path: "/v1/memories/purge", body: {
        lineageId: "release", confirmation: "PURGE",
        idempotencyKey: "purge-1", scope: attackerScope,
      } },
    ];

    const responses = await Promise.all(requests.map(({ path, body }) =>
      router.handle({ method: "POST", path, headers: {}, body })));

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 200, 200]);
    expect(memoryEvolution.history).toHaveBeenCalledOnce();
    expect(memoryEvolution.recallAsOf).toHaveBeenCalledOnce();
    expect(memoryEvolution.expire).toHaveBeenCalledOnce();
    expect(memoryEvolution.revoke).toHaveBeenCalledOnce();
    expect(memoryEvolution.purge).toHaveBeenCalledOnce();
    for (const resolved of captured) {
      expect(resolved).toMatchObject({
        tenantId: "server-tenant",
        userId: "server-user",
        appId: "rest",
        projectId: "project-1",
        visibility: "private",
      });
    }
  });

  test("evolve/correct/restore delegate text changes to the governed Write Kernel", async () => {
    const commands: MemoryWriteCommand[] = [];
    const executeMemoryWrite = vi.fn(async (command: MemoryWriteCommand) => {
      commands.push(command);
      return {
        status: "persisted" as const,
        route: "active" as const,
        recordType: "memory" as const,
        memoryId: "version-new",
        stored: true,
      };
    });
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
      memoryEvolution: {
        history: vi.fn(), recallAsOf: vi.fn(), expire: vi.fn(), purge: vi.fn(),
      } as never,
    });
    const common = {
      scope: attackerScope,
      lineageId: "release-process",
      expectedHeadRevision: 2,
      expectedHeadVersionId: "11111111-1111-4111-8111-111111111112",
      validFrom: 300,
      text: "CI approval release",
      kind: "decision",
      semanticType: "rules",
      evidenceIds: ["evidence-3"],
      idempotencyKey: "transition-3",
    };
    const responses = await Promise.all([
      router.handle({ method: "POST", path: "/v1/memories/evolve", headers: {}, body: common }),
      router.handle({ method: "POST", path: "/v1/memories/correct", headers: {}, body: {
        ...common, idempotencyKey: "correct-3", reason: "old content was wrong",
      } }),
      router.handle({ method: "POST", path: "/v1/memories/restore", headers: {}, body: {
        ...common,
        expectedHeadVersionId: undefined,
        sourceVersionId: "11111111-1111-4111-8111-111111111111",
        idempotencyKey: "restore-3",
      } }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 201, 201]);
    expect(commands.map((command) => command.type)).toEqual([
      "correctMemory", "correctMemory", "correctMemory",
    ]);
    expect(commands.map((command) => command.type === "correctMemory" &&
      command.correctionKind === "replaceText" ? command.temporal?.transitionType : undefined))
      .toEqual(["evolved", "corrected", "restored"]);
    for (const command of commands) {
      expect(command.clientScope).toMatchObject({
        tenantId: "server-tenant", userId: "server-user", visibility: "private",
      });
    }
  });

  test("as-of temporal expressions return their absolute resolution receipt", async () => {
    const recallAsOfResolved = vi.fn(async (input: { asOf: string; timezoneOffsetMinutes?: number }) => ({
      memory: { revision: 1, historical: true },
      asOfResolution: { original: input.asOf, timezoneOffsetMinutes: input.timezoneOffsetMinutes },
    }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryEvolution: {
        recallAsOfResolved,
        history: vi.fn(), recallAsOf: vi.fn(), expire: vi.fn(), revoke: vi.fn(), purge: vi.fn(),
      } as never,
    });
    const response = await router.handle({
      method: "POST",
      path: "/v1/recall/as-of",
      headers: {},
      body: { lineageId: "release", asOf: "昨天", timezoneOffsetMinutes: 480 },
    });
    expect(response).toMatchObject({
      status: 200,
      body: { asOfResolution: { original: "昨天", timezoneOffsetMinutes: 480 } },
    });
    expect(recallAsOfResolved).toHaveBeenCalledWith(expect.objectContaining({
      asOf: "昨天", timezoneOffsetMinutes: 480,
    }));
  });

  test("RuntimeHost 控制面只返回脱敏 owner/home/generation 快照", async () => {
    const runtimeSnapshot = {
      protocolVersion: 1 as const,
      ownerId: "runtime-owner-1",
      homeFingerprint: "a".repeat(64),
      generation: 4,
      state: "ready" as const,
      ready: true,
      accepting: true,
      workerOwner: true,
    };
    const router = createRestRouter({
      unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      runtimeControl: { snapshot: () => runtimeSnapshot },
    });

    await expect(router.handle({ method: "GET", path: "/v1/runtime", headers: {} }))
      .resolves.toEqual({ status: 200, body: runtimeSnapshot });
    await expect(router.handle({ method: "POST", path: "/v1/runtime", headers: {} }))
      .resolves.toEqual({ status: 405, body: { error: "Method not allowed" } });
    expect(JSON.stringify(runtimeSnapshot)).not.toContain("/.mengshu");
  });

  test("server-owned workspace/session are preserved and client overrides are rejected", async () => {
    const executeMemoryWrite = vi.fn(async (): Promise<MemoryWriteKernelResult> => ({
      status: "persisted",
      route: "active",
      recordType: "memory",
      memoryId: "memory-1",
      stored: true,
    }));
    const authority: AuthorityScope = {
      ...transportAuthority,
      workspaceId: "workspace-server",
      sessionId: "session-server",
    };
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority,
      memoryWrite: { executeMemoryWrite },
    });

    const accepted = await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: {
        idempotencyKey: "scope-fidelity-1",
        record: { ...record, scope: {} },
      },
    });
    expect(accepted.status).toBe(201);
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      clientScope: expect.objectContaining({
        workspaceId: "workspace-server",
        sessionId: "session-server",
      }),
    }));

    const rejected = await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: {
        idempotencyKey: "scope-fidelity-2",
        record: { ...record, scope: { sessionId: "session-client" } },
      },
    });
    expect(rejected).toEqual({
      status: 400,
      body: { error: "Invalid scope: CLIENT_FIELD_FORBIDDEN" },
    });
  });

  test("rejects production router construction without authority", () => {
    expect(() => createRestRouter({ service: new FakeMemoryService() })).toThrow(
      /REST authority is required/,
    );
  });

  test("createRestApi 将 exact authority 解析为 runtime 的唯一持久 scope", () => {
    const api = createRestApi(restConfig, restConfig.dbPath!, transportAuthority);

    expect(api.runtime.defaultScope).toEqual({
      tenantId: "server-tenant",
      userId: "server-user",
      appId: "rest",
      projectId: "project-1",
      agentId: "agent-1",
      namespace: "memories",
      visibility: "private",
    });
  });

  test("createRestApi 拒绝无法解析为单一 runtime scope 的多值 authority", () => {
    expect(() => createRestApi(restConfig, restConfig.dbPath!, {
      ...transportAuthority,
      allow: {
        ...transportAuthority.allow,
        projectIds: ["project-1", "project-2"],
      },
    })).toThrow();
  });

  test("candidate review 在进入 Console 前解析并校验 server authority scope", async () => {
    const reviewCandidates = vi.fn(async () => ({ affected: 0, promoted: [], errors: [] }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      console: { reviewCandidates } as unknown as NonNullable<
        Parameters<typeof createRestRouter>[0]["console"]
      >,
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: {
        scope: { ...attackerScope, appId: "outside-authority" },
        action: { action: "approve", ids: ["candidate-1"] },
      },
    });

    expect(response.status).toBe(400);
    expect(reviewCandidates).not.toHaveBeenCalled();
  });

  test("authority makes attacker tenant/user override zero before save/recall/context/observe/forget", async () => {
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
        return { action: "delete" as const, affected: 0, deleted: 0, affectedIds: [], transactional: true as const, idempotentReplay: false };
      },
    };
    const agentFastPath = {
      async observeLight(input: { scope: unknown }) {
        capturedScopes.push(input.scope);
        return { ack: true as const, traceId: "trace-1", queuedJobs: [] };
      },
    } as unknown as NonNullable<Parameters<typeof createRestRouter>[0]["agentFastPath"]>;
    const router = createRestRouter({
      service,
      forgetService,
      agentFastPath,
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });

    const responses = await Promise.all([
      router.handle({
        method: "POST",
        path: "/v1/memories",
        headers: {},
        body: {
          idempotencyKey: "rest-save-1",
          record: { ...record, scope: attackerScope },
        },
      }),
      router.handle({
        method: "POST",
        path: "/v1/recall",
        headers: {},
        body: { query: "recall", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/context",
        headers: {},
        body: { query: "context", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/agent/observe",
        headers: {},
        body: { text: "observe", eventType: "user_input", scope: attackerScope },
      }),
      router.handle({
        method: "POST",
        path: "/v1/forget",
        headers: {},
        body: { filter: { category: "core" }, scope: attackerScope, idempotencyKey: "request-1" },
      }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([201, 200, 200, 200, 200]);
    expect(capturedScopes).toHaveLength(5);
    for (const captured of capturedScopes) {
      expect(captured).toMatchObject({ tenantId: "server-tenant", userId: "server-user" });
      expect(captured).not.toMatchObject({ tenantId: "attacker-tenant" });
    }
  });

  test("authority save delegates only to the runtime write capability", async () => {
    const service = new FakeMemoryService();
    const directStore = vi.spyOn(service, "storeMemory");
    const executeMemoryWrite = vi.fn(async (_command: MemoryWriteCommand) => ({
      status: "persisted" as const,
      route: "candidate" as const,
      recordType: "candidate" as const,
      candidateId: "candidate-1",
      memoryId: "candidate-1",
      stored: true,
    }));
    const router = createRestRouter({
      service,
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: {
        idempotencyKey: "rest-save-2",
        record: { ...record, scope: attackerScope },
      },
    });

    expect(response).toEqual({
      status: 201,
      body: {
        id: "candidate-1",
        stored: true,
        status: "persisted",
        route: "candidate",
        recordType: "candidate",
      },
    });
    expect(directStore).not.toHaveBeenCalled();
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      idempotencyKey: "rest-save-2",
      serverAuthority: transportAuthority,
      clientScope: expect.objectContaining({
        tenantId: "server-tenant",
        userId: "server-user",
      }),
      text: record.text,
      kind: record.kind,
    }));
  });

  test("authority save owns REST source and rejects provenance/metadata source spoofing", async () => {
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "memory-rest-source",
      stored: true,
    }));
    const router = createRestRouter({
      service: new FakeMemoryService(),
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });

    await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: {
        idempotencyKey: "rest-authoritative-source-1",
        record: {
          ...record,
          scope: attackerScope,
          metadata: { source: "system", clientLabel: "preserved" },
          provenance: {
            source: "scan",
            sourceId: "message-real-1",
            messageId: "message-1",
          },
        },
      },
    });

    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      metadata: { source: "user", clientLabel: "preserved" },
      provenance: {
        source: "user",
        sourceId: "message-real-1",
        messageId: "message-1",
      },
    }));
  });

  test("authority save derives a stable compatibility key for legacy SDK records", async () => {
    const service = new FakeMemoryService();
    const directStore = vi.spyOn(service, "storeMemory");
    const executeMemoryWrite = vi.fn(async (_command: MemoryWriteCommand) => ({
      status: "persisted" as const,
      memoryId: "legacy-memory-1",
      stored: true,
      recordType: "memory" as const,
      route: "active" as const,
    }));
    const router = createRestRouter({
      service,
      authority: transportAuthority,
      memoryWrite: { executeMemoryWrite },
    });

    const first = await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: { record: { ...record, scope: {} } },
    });
    const replay = await router.handle({
      method: "POST",
      path: "/v1/memories",
      headers: {},
      body: { record: { ...record, scope: {} } },
    });

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstCommand = executeMemoryWrite.mock.calls[0]![0];
    const replayCommand = executeMemoryWrite.mock.calls[1]![0];
    expect(firstCommand).toEqual(expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^legacy-rest-v1:[0-9a-f]{64}$/),
    }));
    expect(replayCommand.idempotencyKey).toBe(firstCommand.idempotencyKey);
    expect(directStore).not.toHaveBeenCalled();
  });

  test.each([
    ["invalid action", { action: "destroy", ids: ["mem-1"] }],
    ["non-string id", { ids: ["mem-1", 42] }],
    ["empty id", { ids: [""] }],
    ["duplicate ids", { ids: ["mem-1", "mem-1"] }],
  ])("RED: REST forget rejects %s before service", async (_label, invalid) => {
    const inputs: unknown[] = [];
    const forgetService = {
      async forget(input: unknown) {
        inputs.push(input);
        return { action: "delete" as const, affected: 0, deleted: 0, affectedIds: [], transactional: true as const, idempotentReplay: false };
      },
    };
    const router = createRestRouter({
      service: new FakeMemoryService(),
      forgetService,
      authority: transportAuthority,
    });

    const response = await router.handle({
      method: "POST",
      path: "/v1/forget",
      headers: {},
      body: {
        ...invalid,
        scope: {
          appId: "rest",
          projectId: "project-1",
          agentId: "agent-1",
          namespace: "memories",
          visibility: "private",
        },
        idempotencyKey: "request-1",
      },
    });

    expect(response.status).toBe(400);
    expect(inputs).toEqual([]);
  });
  test("returns health snapshot", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(router.handle({ method: "GET", path: "/v1/health", headers: {} })).resolves.toEqual({
      status: 200,
      body: { ok: true, records: 1 },
    });
  });

  test("returns 503 when the service health snapshot is not ready", async () => {
    const router = createRestRouter({
      unsafeLegacyScope: true,
      service: { health: async () => ({ ok: false, error: "db unavailable" }) } as never,
    });

    await expect(router.handle({ method: "GET", path: "/v1/health", headers: {} })).resolves.toEqual({
      status: 503,
      body: { ok: false, error: "db unavailable" },
    });
  });

  test("stores memory from JSON body", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(
      router.handle({
        method: "POST",
        path: "/v1/memories",
        headers: {},
        body: {
          record,
        },
      }),
    ).resolves.toEqual({
      status: 201,
      body: { id: "mem-1", stored: true },
    });
  });

  test("recalls memories and builds context", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    const recall = await router.handle({
      method: "POST",
      path: "/v1/recall",
      headers: {},
      body: { query: "concise", scope: { appId: "openclaw" } },
    });
    const context = await router.handle({
      method: "POST",
      path: "/v1/context",
      headers: {},
      body: { query: "concise", scope: { appId: "openclaw" } },
    });

    expect(recall.status).toBe(200);
    expect(recall.body).toMatchObject({
      query: "concise",
      hits: [{ score: scoreBreakdown.score, source: "vector", scoreBreakdown }],
    });
    expect(context.status).toBe(200);
    expect(context.body).toMatchObject({
      content: "<retrieved-context>safe</retrieved-context>",
      hits: [{ score: scoreBreakdown.score, scoreBreakdown }],
    });
  });

  test("context returns an explicit error when the service omits the production breakdown", async () => {
    const service = new FakeMemoryService();
    service.buildContext = async () => ({
      scope,
      content: "unsafe contract",
      hits: [{ record, score: 0.9, source: "vector" }],
    });
    const router = createRestRouter({ unsafeLegacyScope: true, service });

    await expect(router.handle({
      method: "POST",
      path: "/v1/context",
      headers: {},
      body: { query: "concise" },
    })).resolves.toEqual({
      status: 500,
      body: { error: "RECALL_SCORE_BREAKDOWN_REQUIRED" },
    });
  });

  test("recall returns an explicit error when the service omits the production breakdown", async () => {
    const service = new FakeMemoryService();
    service.recall = (async () => ({
      scope,
      query: "concise",
      hits: [{ record, score: 0.9, source: "vector" }],
    })) as typeof service.recall;
    const router = createRestRouter({ unsafeLegacyScope: true, service });

    await expect(router.handle({
      method: "POST",
      path: "/v1/recall",
      headers: {},
      body: { query: "concise" },
    })).resolves.toEqual({
      status: 500,
      body: { error: "RECALL_SCORE_BREAKDOWN_REQUIRED" },
    });
  });

  test("agent lookup preserves the FastPath complete breakdown", async () => {
    const lookupHit = {
      id: record.id,
      preview: record.text,
      score: scoreBreakdown.score,
      scoreBreakdown,
      source: "vector",
      evidence: [],
      actions: ["copy_reference" as const],
    };
    const agentFastPath = {
      async lookup() {
        return { hits: [lookupHit], telemetry: { latencyMs: 1, mode: "fast" as const } };
      },
    } as unknown as NonNullable<Parameters<typeof createRestRouter>[0]["agentFastPath"]>;
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService(), agentFastPath });

    const response = await router.handle({
      method: "POST",
      path: "/v1/agent/lookup",
      headers: {},
      body: { query: "concise" },
    });

    expect(response.status).toBe(200);
    expect((response.body as { hits: typeof lookupHit[] }).hits[0].scoreBreakdown).toBe(scoreBreakdown);
    expect((response.body as { hits: typeof lookupHit[] }).hits[0]).toEqual(lookupHit);
  });

  test("agent lookup returns an explicit error when FastPath omits the breakdown", async () => {
    const agentFastPath = {
      async lookup() {
        return {
          hits: [{ id: record.id, preview: record.text, score: 0.9, source: "vector", evidence: [], actions: [] }],
          telemetry: { latencyMs: 1, mode: "fast" as const },
        };
      },
    } as unknown as NonNullable<Parameters<typeof createRestRouter>[0]["agentFastPath"]>;
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService(), agentFastPath });

    await expect(router.handle({
      method: "POST",
      path: "/v1/agent/lookup",
      headers: {},
      body: { query: "concise" },
    })).resolves.toEqual({
      status: 500,
      body: { error: "RECALL_SCORE_BREAKDOWN_REQUIRED" },
    });
  });

  test("agent context rejects slots whose sourceIds and recallReceipts diverge", async () => {
    const agentFastPath = {
      async context() {
        return {
          scope,
          slots: {
            rules: {
              semanticType: "rules" as const,
              question: "Q3",
              content: `- ${record.text}`,
              sourceIds: [record.id],
              recallReceipts: [],
              nodeCount: 1,
            },
          },
          content: record.text,
          telemetry: { latencyMs: 1, nodesUsed: 1, cacheHit: false },
        };
      },
    } as unknown as NonNullable<Parameters<typeof createRestRouter>[0]["agentFastPath"]>;
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService(), agentFastPath });

    await expect(router.handle({
      method: "POST",
      path: "/v1/agent/context",
      headers: {},
      body: { task: "load context" },
    })).resolves.toEqual({
      status: 500,
      body: { error: "CONTEXT_RECALL_BREAKDOWN_REQUIRED" },
    });
  });

  test("applies auth guard and returns JSON errors", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      server: { secret: "secret-token" },
    });

    await expect(
      router.handle({
        method: "GET",
        path: "/v1/health",
        headers: { authorization: "Bearer wrong" },
        remoteAddress: "127.0.0.1",
      }),
    ).resolves.toEqual({
      status: 401,
      body: { error: "Invalid bearer token" },
    });
  });

  test("routes graph query when graph service is configured", async () => {
    const repository = new InMemoryGraphRepository();
    await repository.upsertEntities([
      {
        id: "entity-1",
        scope,
        canonicalName: "mengshu",
        displayName: "mengshu",
        type: "project",
        aliases: ["mengshu"],
        mentionCount: 1,
        mentionCount30d: 1,
        distinctSourceCount: 1,
        lastSeenAt: 1710000000000,
        hotness: 4,
        queryHits30d: 0,
        status: "active",
        createdAt: 1710000000000,
        updatedAt: 1710000000000,
        metadata: {},
      },
    ]);
    const router = createRestRouter({ unsafeLegacyScope: true,
      service: new FakeMemoryService(),
      graph: new GraphQueryService(repository),
    });

    const result = await router.handle({
      method: "POST",
      path: "/v1/graph/query",
      headers: {},
      body: { scope, query: "mengshu" },
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      entities: [expect.objectContaining({ id: "entity-1" })],
      evidenceChunkIds: [],
    });
  });

  test("routes console overview, lookup and jobs", async () => {
    const service = new FakeMemoryService();
    const router = createRestRouter({ unsafeLegacyScope: true,
      service,
      console: createConsoleApi({ service }),
    });

    const overview = await router.handle({
      method: "POST",
      path: "/v1/console/overview",
      headers: {},
      body: { scope },
    });
    const lookup = await router.handle({
      method: "POST",
      path: "/v1/console/lookup",
      headers: {},
      body: { scope, query: "concise" },
    });
    const jobs = await router.handle({
      method: "GET",
      path: "/v1/console/jobs",
      headers: {},
    });

    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ metrics: { memories: 1 } });
    expect(lookup.status).toBe(200);
    expect(lookup.body).toMatchObject({ results: [expect.objectContaining({ id: "mem-1" })] });
    expect(jobs.status).toBe(200);
    expect(jobs.body).toEqual({ jobs: [], counts: {} });
  });

  test("routes console candidates list and review", async () => {
    const service = new FakeMemoryService();
    const repository = new InMemoryCandidateRepository();
    const candidate = await repository.enqueue({
      scope,
      text: "candidate via REST",
      semanticType: "profile",
      kind: "preference",
      confidence: 0.8,
      evidenceIds: ["ev-1"],
      metadata: {},
    });
    const review = new CandidateReviewService({
      repository,
      promoteCandidate: async ({ candidate: c }) => ({ memoryId: `mem-${c.id}` }),
    });
    const router = createRestRouter({ unsafeLegacyScope: true,
      service,
      console: createConsoleApi({ service, candidates: repository, candidateReview: review }),
    });

    const list = await router.handle({
      method: "POST",
      path: "/v1/console/candidates",
      headers: {},
      body: { scope, filter: { status: "pending" } },
    });
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({
      total: 1,
      candidates: [expect.objectContaining({ id: candidate.id, preview: "candidate via REST" })],
    });

    const reviewResult = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: { action: { action: "approve", ids: [candidate.id] } },
    });
    expect(reviewResult.status).toBe(200);
    expect(reviewResult.body).toMatchObject({ affected: 1, promoted: [`mem-${candidate.id}`] });

    const missingAction = await router.handle({
      method: "POST",
      path: "/v1/console/candidates/review",
      headers: {},
      body: { scope },
    });
    expect(missingAction.status).toBe(400);
  });

  test("returns 404 and 405 for unsupported routes", async () => {
    const router = createRestRouter({ unsafeLegacyScope: true, service: new FakeMemoryService() });

    await expect(router.handle({ method: "GET", path: "/v1/missing", headers: {} })).resolves.toEqual({
      status: 404,
      body: { error: "Not found" },
    });
    await expect(router.handle({ method: "GET", path: "/v1/recall", headers: {} })).resolves.toEqual({
      status: 405,
      body: { error: "Method not allowed" },
    });
  });
});
