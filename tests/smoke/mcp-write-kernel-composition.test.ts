import { describe, expect, test, vi } from "vitest";
import type { MemoryService } from "../../core/service-types.js";
import type { McpServerAuthorityConfig } from "../../packages/mcp/src/server.js";
import { createMcpStdioServer } from "../../packages/mcp/src/stdio-server.js";
import { createCliMcpStdioServerOptions } from "../../packages/api/src/cli/ms.js";
import { createStandaloneMcpStdioServerOptions } from "../../scripts/mengshu-mcp.js";
import { AgentFastPathService } from "../../packages/api/src/agent-fast-path/index.js";
import {
  MemoryWriteKernel,
  type MemoryWriteCommand,
  type MemoryWriteKernelResult,
  type WriteMemoryRecord,
} from "../../packages/core/src/service/write-kernel.js";
import type { MemoryWriteReceipt } from "../../packages/core/src/service/write-kernel-transaction.js";
import { createEvidenceFirstMemoryWriteExecutor } from "../../packages/core/src/service/evidence-first-memory-write-executor.js";

const authorityConfig: McpServerAuthorityConfig = {
  authority: {
    tenantId: "tenant-1",
    userId: "user-1",
    allow: {
      appIds: ["mengshu"],
      projectIds: ["project-1"],
      agentIds: ["agent-1"],
      namespaces: ["memories", "knowledge"],
      visibilities: ["private"],
    },
  },
  defaultScope: {
    tenantId: "tenant-1",
    appId: "mengshu",
    userId: "user-1",
    projectId: "project-1",
    agentId: "agent-1",
    namespace: "memories",
    visibility: "private",
  },
};

function createService() {
  return {
    storeMemory: vi.fn(),
  } as unknown as MemoryService;
}

function createRuntime(
  service: MemoryService,
  executeMemoryWrite?: (command: never) => Promise<never>,
  agentFastPath?: AgentFastPathService,
) {
  return {
    memoryService: service,
    executeMemoryWrite,
    agentFastPath,
  } as never;
}

function realWriteRuntime(service: MemoryService) {
  const receipts = new Map<string, MemoryWriteReceipt>();
  const writes: WriteMemoryRecord[] = [];
  const durableJobs = new Map<string, string>();
  let idSequence = 0;
  const kernel = new MemoryWriteKernel({
    resolveAuthority: ({ serverAuthority, clientScope }) => {
      const authority = serverAuthority as typeof authorityConfig.authority;
      const requested = clientScope as typeof authorityConfig.defaultScope;
      return {
        ...requested,
        tenantId: authority.tenantId,
        userId: authority.userId,
      };
    },
    normalize: ({ command }) => ({
      text: "text" in command ? command.text : "",
      metadata: Object.freeze({ ...(command.metadata ?? {}) }),
      promptRisk: false,
    }),
    embeddingGuard: () => ({ ok: true as const }),
    embed: async () => [0.1, 0.2, 0.3],
    validate: ({ command, normalized }) => {
      if (command.type === "importEvidence") {
        return { accepted: true as const, candidate: { phase: "raw_evidence" } };
      }
      if (command.type === "correctMemory") {
        return { accepted: false as const, reason: "unsupported" };
      }
      if (command.type === "observeAuto" && command.semanticType === undefined) {
        return { accepted: false as const, reason: "unknown_semantic_type" };
      }
      return {
        accepted: true as const,
        candidate: command.semanticType === undefined
          ? { compatibility: "kind_only_explicit", text: normalized.text }
          : { semanticType: command.semanticType, text: normalized.text },
      };
    },
    scoreAdmission: ({ command, candidate }) => {
      if (command.type === "importEvidence") {
        return { route: "evidence_only" as const, valueScore: 0 };
      }
      if (candidate.compatibility === "kind_only_explicit") {
        return { route: "lookup_only" as const, valueScore: 0.5 };
      }
      return { route: "candidate" as const, valueScore: 0.7 };
    },
    scoreImportance: () => 0.5,
    exactDedup: () => ({ duplicate: false }),
    semanticDedup: () => ({ duplicate: false }),
    transaction: async (work) => work({
      getReceipt: async (identity) => receipts.get(identity.storageKey),
      saveReceipt: async (receipt) => { receipts.set(receipt.identity.storageKey, receipt); },
      writeMemory: async (memory) => {
        writes.push(memory);
        return { memoryId: memory.id, stored: true };
      },
      appendAudit: async () => undefined,
      appendOutbox: async () => undefined,
    }),
    ack: async () => undefined,
    createId: () => `memory-${++idSequence}`,
    now: () => 1_800_000_000_000 + idSequence,
  });
  const evidenceFirst = createEvidenceFirstMemoryWriteExecutor({
    executeKernel: (command) => kernel.execute(command),
  });
  const executeMemoryWrite = async (
    command: MemoryWriteCommand,
  ): Promise<MemoryWriteKernelResult> => {
    const result = await evidenceFirst.execute(command);
    switch (result.status) {
      case "evidence_not_persisted": return result.evidence;
      case "governance_persisted":
      case "governance_rejected":
      case "governance_duplicate":
      case "governance_ignored": return result.governance;
      default: return result;
    }
  };
  const ensureCandidateJob = async ({ type, payload }: {
    type: string;
    payload: Record<string, unknown>;
  }) => {
    const key = `${type}:${String(payload.traceId)}`;
    const jobId = durableJobs.get(key) ?? `job-${durableJobs.size + 1}`;
    durableJobs.set(key, jobId);
    return jobId;
  };
  const agentFastPath = new AgentFastPathService({
    defaultScope: authorityConfig.defaultScope,
    loadRecordsForScope: async () => [],
    recall: async (scope, query) => ({ scope, query, hits: [] }),
    storeObservation: async ({ scope, text, metadata, intent, idempotencyKey }) => {
      const stableMetadata = { ...metadata };
      delete stableMetadata.traceId;
      for (const key of [
        "tenantId", "userId", "appId", "projectId", "agentId", "namespace",
        "visibility", "workspaceId", "sessionId", "source",
      ]) {
        delete stableMetadata[key];
      }
      const sourceId = `agent-observation:${idempotencyKey}`;
      const result = await executeMemoryWrite({
        type: "importEvidence",
        idempotencyKey: idempotencyKey!,
        serverAuthority: authorityConfig.authority,
        clientScope: scope,
        text,
        kind: "observation",
        container: "session_candidate",
        confidence: intent === "remember" ? 0.9 : 0.6,
        category: "core",
        dataType: "memory",
        tableName: "memories",
        sourceId,
        evidenceIds: [sourceId],
        metadata: { ...stableMetadata, source: "agent-fast-path" },
        provenance: { source: "agent-fast-path", sourceId },
      });
      if (result.status !== "persisted" || !("route" in result)) {
        throw new Error("evidence write was not persisted");
      }
      return {
        id: result.memoryId,
        stored: result.stored,
        recordType: result.recordType,
        admissionRoute: result.route,
      };
    },
    enqueueJob: ensureCandidateJob,
    ensureJob: ensureCandidateJob,
  });
  return {
    runtime: createRuntime(service, executeMemoryWrite as never, agentFastPath),
    writes,
    durableJobs,
  };
}

describe("production MCP write-kernel composition", () => {
  test.each([
    {
      entry: "ms mcp",
      compose: (runtime: never) => createCliMcpStdioServerOptions(runtime, authorityConfig),
    },
    {
      entry: "scripts/mengshu-mcp.ts",
      compose: (runtime: never, service: MemoryService) => createStandaloneMcpStdioServerOptions(
        runtime,
        service,
        authorityConfig,
      ),
    },
  ])("$entry injects and delegates to the runtime executeMemoryWrite capability", async ({ compose }) => {
    const service = createService();
    const result = {
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "memory-1",
      stored: true,
    };
    const executeMemoryWrite = vi.fn(async () => result) as never;
    const runtime = createRuntime(service, executeMemoryWrite);
    const options = compose(runtime, service);

    expect(options.memoryWrite?.executeMemoryWrite).toBe(executeMemoryWrite);
    const save = createMcpStdioServer(options).tools.find((tool) => tool.name === "memory_save");
    await expect(save?.execute({
      text: "persist through the write kernel",
      idempotencyKey: "composition-1",
    })).resolves.toMatchObject({ id: "memory-1", stored: true, status: "persisted" });
    expect(executeMemoryWrite).toHaveBeenCalledWith(expect.objectContaining({
      type: "saveExplicit",
      idempotencyKey: "composition-1",
      serverAuthority: authorityConfig.authority,
    }));
    expect(service.storeMemory).not.toHaveBeenCalled();
  });

  test.each([
    {
      entry: "ms mcp",
      compose: (runtime: never) => createCliMcpStdioServerOptions(runtime, authorityConfig),
    },
    {
      entry: "scripts/mengshu-mcp.ts",
      compose: (runtime: never, service: MemoryService) => createStandaloneMcpStdioServerOptions(
        runtime,
        service,
        authorityConfig,
      ),
    },
  ])("$entry preserves real evidence-first/save/observe-light F0 semantics", async ({ compose }) => {
    const service = createService();
    const harness = realWriteRuntime(service);
    const options = compose(harness.runtime, service);
    const tools = createMcpStdioServer(options).tools;
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    await expect(byName.memory_save.execute({
      text: "kind-only explicit memory remains lookup-only",
      idempotencyKey: "real-save-1",
    })).resolves.toMatchObject({
      status: "persisted",
      route: "lookup_only",
      recordType: "memory",
    });
    expect(harness.writes.slice(0, 2)).toEqual([
      expect.objectContaining({
        commandType: "importEvidence",
        route: "evidence_only",
        kind: "observation",
        category: "other",
      }),
      expect.objectContaining({
        commandType: "saveExplicit",
        route: "lookup_only",
        kind: "other",
        category: "other",
      }),
    ]);

    await expect(byName.memory_observe.execute({
      text: "A typed observation enters governed candidate state",
      semanticType: "experience",
      idempotencyKey: "real-observe-1",
    })).resolves.toMatchObject({
      status: "persisted",
      route: "candidate",
      recordType: "candidate",
    });
    expect(harness.writes[2]).toMatchObject({
      commandType: "observeAuto",
      semanticType: "experience",
      category: "other",
    });

    const lightRequest = {
      scope: {
        tenantId: "forged-tenant",
        userId: "forged-user",
        appId: "mengshu",
        projectId: "project-1",
        agentId: "agent-1",
        namespace: "memories",
        visibility: "private",
      },
      eventType: "tool_result",
      text: "raw tool evidence is extracted asynchronously",
      idempotencyKey: "real-light-1",
      metadata: {
        tenantId: "forged-metadata-tenant",
        userId: "forged-metadata-user",
        source: "forged-source",
      },
    };
    await expect(byName.memory_observe_light.execute(lightRequest)).resolves.toMatchObject({
      ack: true,
      admissionRoute: "evidence_only",
      queuedJobs: ["job-1"],
    });
    await expect(byName.memory_observe_light.execute(lightRequest)).resolves.toMatchObject({
      ack: true,
      admissionRoute: "evidence_only",
      queuedJobs: ["job-1"],
    });

    const lightEvidence = harness.writes.filter((write) =>
      write.mutation === "content" &&
      write.commandType === "importEvidence" &&
      write.text === lightRequest.text);
    expect(lightEvidence).toHaveLength(1);
    expect(lightEvidence[0].scope).toMatchObject({
      tenantId: "tenant-1",
      userId: "user-1",
    });
    expect(lightEvidence[0].scope).not.toMatchObject({ tenantId: "forged-tenant" });
    expect(lightEvidence[0].metadata).not.toMatchObject({
      tenantId: "forged-metadata-tenant",
      userId: "forged-metadata-user",
      source: "forged-source",
    });
    expect([...harness.durableJobs.keys()]).toEqual([
      `extract_candidate:${lightEvidence[0].id}`,
    ]);
    expect(service.storeMemory).not.toHaveBeenCalled();
  });

  test.each([
    {
      entry: "ms mcp",
      compose: (runtime: never) => createCliMcpStdioServerOptions(runtime, authorityConfig),
    },
    {
      entry: "scripts/mengshu-mcp.ts",
      compose: (runtime: never, service: MemoryService) => createStandaloneMcpStdioServerOptions(
        runtime,
        service,
        authorityConfig,
      ),
    },
  ])("$entry leaves writes fail-closed when runtime has no capability", async ({ compose }) => {
    const service = createService();
    const observeLight = vi.fn(async () => ({
      ack: true as const,
      traceId: "must-not-run",
      queuedJobs: [],
    }));
    const agentFastPath = {
      context: vi.fn(),
      observeLight,
      lookup: vi.fn(),
    } as unknown as AgentFastPathService;
    const options = compose(createRuntime(service, undefined, agentFastPath), service);

    expect(options.memoryWrite).toBeUndefined();
    const save = createMcpStdioServer(options).tools.find((tool) => tool.name === "memory_save");
    await expect(save?.execute({
      text: "must not use legacy store",
      idempotencyKey: "composition-2",
    })).rejects.toThrow(/write capability is unavailable/i);
    const light = createMcpStdioServer(options).tools.find(
      (tool) => tool.name === "memory_observe_light",
    );
    await expect(light?.execute({
      scope: authorityConfig.defaultScope,
      eventType: "user_input",
      text: "must not use a fast-path fallback",
      idempotencyKey: "composition-light-2",
    })).rejects.toThrow(/write capability is unavailable/i);
    expect(observeLight).not.toHaveBeenCalled();
    expect(service.storeMemory).not.toHaveBeenCalled();
  });
});
