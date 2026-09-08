import { describe, expect, test, vi } from "vitest";

import { RuntimeClient } from "../../api/src/runtime-client.js";
import { createRestRouter } from "../../api/src/rest/router.js";
import { buildEvolutionTools } from "./evolution-tools.js";
import type { EvolutionBatchReport } from "../../core/src/evolution/types.js";
import { loadRuntimeMcpTools } from "./runtime-client-proxy.js";
import { createRuntimeMcpFacade } from "./stdio-server.js";
import { assertEvolutionOwnerRequest } from "../../api/src/evolution-owner-auth.js";

function client(...responses: unknown[]): RuntimeClient & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn();
  for (const response of responses) invoke.mockResolvedValueOnce(response);
  return { invoke } as unknown as RuntimeClient & { invoke: ReturnType<typeof vi.fn> };
}

describe("RuntimeClient MCP proxy", () => {
  test("governance tools traverse the real owner-filtered registry and RuntimeClient request boundary", async () => {
    const authority = { tenantId: "tenant", userId: "owner", allow: { appIds: ["app"], projectIds: ["project"], agentIds: ["agent"],
      namespaces: ["memories"], visibilities: ["private" as const] } };
    const defaultScope = { tenantId: "tenant", userId: "owner", appId: "app", projectId: "project", agentId: "agent", namespace: "memories", visibility: "private" as const };
    const hash = "a".repeat(64), ownerSecret = "independent-governance-proxy-fixture";
    const report: EvolutionBatchReport = { batchId: "control-batch", status: "queued", reasons: [],
      usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
      checkpoint: { cursor: null }, configFingerprint: hash, resumable: true, work: { kind: "source_reconcile" } };
    const control = {
      run: vi.fn(async (_value: unknown) => { assertEvolutionOwnerRequest(authority); return report; }),
      previewUndo: vi.fn(async (_value: unknown) => { assertEvolutionOwnerRequest(authority); return {
        operationReceiptId: hash, currentStateHash: hash, operation: "mark_disputed" as const, memoryIds: ["memory-one"] }; }),
      approveUndo: vi.fn(async (_value: unknown) => { assertEvolutionOwnerRequest(authority); return {
        id: hash, kind: "governance_undo" as const, entryId: hash, operation: "put" as const, revision: 1, valueHash: hash, createdAt: 1 }; }),
    };
    const capability = { run: vi.fn(async () => report), status: async () => report, resume: vi.fn(async (batchId: string) => {
      if (batchId === "control-batch") assertEvolutionOwnerRequest(authority);
      return { ...report, batchId };
    }), control };
    const identity = { ownerId: "one-host", homeFingerprint: hash, generation: 1 };
    const router = createRestRouter({ service: {} as never, authority, evolutionOwnerSecret: ownerSecret,
      continuousMemoryEvolution: capability,
      runtimeControl: { snapshot: () => ({ ...identity, protocolVersion: 1, state: "ready", ready: true, accepting: true, workerOwner: true }) } as never,
      runtimeMcp: createRuntimeMcpFacade({ service: {} as never, authority, defaultScope, continuousMemoryEvolution: capability }) });
    const makeClient = (ownerToken?: string) => new RuntimeClient({ expectedHomeFingerprint: hash,
      transport: { request: async request => ({ ...await router.handle({ ...request,
        headers: ownerToken ? { "x-mengshu-owner-token": ownerToken } : {}, remoteAddress: "127.0.0.1",
      }), runtimeIdentity: identity }) } });
    const request = { input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes" } }, action: "execute_control", idempotencyKey: "control",
      limits: { maxRecords: 12, maxFiles: 2, maxBytes: 1000, maxDurationMs: 1000 } };
    const approval = { operationReceiptId: hash, currentStateHash: hash, expectedRevision: 0,
      idempotencyKey: "approve", operationIdempotencyKey: "undo", expiresAt: 1000 };
    const ordinary = makeClient(), publicTools = await loadRuntimeMcpTools(ordinary), ownerTools = await loadRuntimeMcpTools(makeClient(ownerSecret));
    for (const [name, method, body] of [["control_run", "run", request], ["control_undo_preview", "previewUndo", { operationReceiptId: hash }],
      ["control_undo_approve", "approveUndo", approval]] as const) {
      const toolName = `memory_evolution_${name}`;
      expect(publicTools.some(tool => tool.name === toolName)).toBe(false);
      await expect(ordinary.invoke({ method: "POST", path: "/v1/runtime/mcp-call", body: { name: toolName, arguments: body } }))
        .rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
      const tool = ownerTools.find(tool => tool.name === toolName)!;
      expect(tool).toBeDefined(); await tool.execute(body);
      expect(control[method]).toHaveBeenCalledExactlyOnceWith(body);
      await expect(tool.execute({ ...body, model: "injected", ownerSecret })).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
      expect(control[method]).toHaveBeenCalledTimes(1);
    }
    expect(capability.run).not.toHaveBeenCalled();
    const publicResume = publicTools.find(tool => tool.name === "memory_evolution_resume")!;
    const ownerResume = ownerTools.find(tool => tool.name === "memory_evolution_resume")!;
    await expect(publicResume.execute({ batchId: "control-batch" })).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
    await expect(publicResume.execute({ batchId: "ordinary-batch" })).resolves.toMatchObject({ batchId: "ordinary-batch" });
    await expect(ownerResume.execute({ batchId: "control-batch" })).resolves.toMatchObject({ batchId: "control-batch" });
    const resumeCalls = capability.resume.mock.calls.length;
    await expect(makeClient("wrong").invoke({ method: "POST", path: "/v1/runtime/mcp-call", body: {
      name: "memory_evolution_resume", arguments: { batchId: "control-batch" },
    } })).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
    expect(capability.resume).toHaveBeenCalledTimes(resumeCalls);
    capability.run.mockImplementationOnce(async () => { expect(() => assertEvolutionOwnerRequest(authority)).toThrow(); return report; });
    await ownerTools.find(tool => tool.name === "memory_evolution_run")!.execute({
      input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "ordinary",
    });
    expect(() => assertEvolutionOwnerRequest(authority)).toThrow();
    await expect(loadRuntimeMcpTools(makeClient("wrong"))).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
  });
  test("ordinary proxy exposes callable host evolution tools without owning runtime, database or owner approval", async () => {
    const report = { batchId: "batch-one", status: "queued", reasons: [],
      usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
      counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
      checkpoint: { cursor: null }, configFingerprint: "a".repeat(64), resumable: true,
    } satisfies EvolutionBatchReport;
    const run = vi.fn(async () => report), cancel = vi.fn(async () => report);
    const capability = { run, status: async () => report, resume: async () => report, cancel };
    const registry = buildEvolutionTools(capability);
    const homeFingerprint = "a".repeat(64);
    const identity = { ownerId: "one-host", homeFingerprint, generation: 1 };
    const snapshot = { ...identity, protocolVersion: 1, state: "ready", ready: true, accepting: true, workerOwner: true };
    const ownerSecret = "independent-owner-credential-fixture";
    const router = createRestRouter({ service: {} as never,
      authority: { tenantId: "tenant", userId: "owner", allow: { appIds: ["codex"], projectIds: ["p"], agentIds: ["a"], namespaces: ["memories"], visibilities: ["private"] } },
      evolutionOwnerSecret: ownerSecret, continuousMemoryEvolution: capability,
      runtimeControl: { snapshot: () => snapshot } as never,
      runtimeMcp: { listTools: () => registry.map(({ execute: _execute, ...descriptor }) => descriptor),
        callTool: (name, args) => registry.find(tool => tool.name === name)!.execute(args) },
    });
    const makeClient = (ownerToken?: string) => new RuntimeClient({ expectedHomeFingerprint: homeFingerprint,
      transport: { request: async request => ({ ...await router.handle({ ...request,
        headers: ownerToken ? { "x-mengshu-owner-token": ownerToken } : {}, remoteAddress: "127.0.0.1",
      }), runtimeIdentity: identity }) },
    });
    const ordinary = makeClient();
    const tools = await loadRuntimeMcpTools(ordinary);
    expect(tools.map(tool => tool.name)).toEqual(["memory_evolution_run", "memory_evolution_status", "memory_evolution_resume"]);
    const request = { input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "same-request" };
    await expect(tools[0]!.execute(request)).resolves.toMatchObject({ batchId: "batch-one", status: "queued" });
    expect(run).toHaveBeenCalledExactlyOnceWith({ ...request, limits: expect.objectContaining({ maxRecords: 100, maxLlmCalls: 8 }) });
    await expect(tools[0]!.execute({ ...request, path: "/private", model: "other" })).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
    expect(run).toHaveBeenCalledTimes(1);
    await expect(ordinary.invoke({ method: "POST", path: "/v1/runtime/mcp-call", body: {
      name: "memory_evolution_cancel", arguments: { batchId: "batch-one" },
    } })).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
    expect(cancel).not.toHaveBeenCalled();
    const ownerTools = await loadRuntimeMcpTools(makeClient(ownerSecret));
    expect(ownerTools.map(tool => tool.name)).toContain("memory_evolution_cancel");
    await expect(loadRuntimeMcpTools(makeClient("incorrect-owner-token"))).rejects.toMatchObject({ code: "RUNTIME_REQUEST_FAILED" });
  });
  test("loads the frozen daemon registry and forwards only name plus arguments", async () => {
    const runtime = client({
      tools: [{
        name: "memory_health",
        description: "Return health",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      }],
    }, { ok: true });

    const tools = await loadRuntimeMcpTools(runtime);
    expect(tools).toHaveLength(1);
    expect(Object.isFrozen(tools)).toBe(true);
    await expect(tools[0]!.execute({})).resolves.toEqual({ ok: true });
    expect(runtime.invoke).toHaveBeenNthCalledWith(1, {
      method: "GET", path: "/v1/runtime/mcp-tools",
    });
    expect(runtime.invoke).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1/runtime/mcp-call",
      body: { name: "memory_health", arguments: {} },
    });
  });

  test.each([
    [{ tools: [] }],
    [{ tools: [{ name: "Bad-Name", description: "bad", inputSchema: {} }] }],
    [{ tools: [
      { name: "memory_health", description: "one", inputSchema: {} },
      { name: "memory_health", description: "two", inputSchema: {} },
    ] }],
    [{ tools: [{ name: "memory_health", description: "ok", inputSchema: {}, extra: true }] }],
  ])("rejects malformed or ambiguous registries", async (response) => {
    await expect(loadRuntimeMcpTools(client(response))).rejects.toThrow(
      "RUNTIME_MCP_REGISTRY_INVALID",
    );
  });
});
