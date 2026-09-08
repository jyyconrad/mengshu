import { describe, expect, test, vi } from "vitest";
import { createRestRouter } from "./router.js";
import { createMcpMemoryTools } from "../../../mcp/src/tools.js";
import { loadRuntimeMcpTools } from "../../../mcp/src/runtime-client-proxy.js";
import type { EvolutionBatchReport } from "../../../core/src/evolution/types.js";

const authority = { tenantId: "tenant", userId: "user", allow: {
  appIds: ["codex"], projectIds: ["project"], agentIds: ["agent"],
  namespaces: ["memories"], visibilities: ["private" as const],
} };
const report: EvolutionBatchReport = {
  batchId: "batch-one", status: "completed", reasons: [],
  usage: { records: 1, files: 0, bytes: 10, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 1 },
  counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
  checkpoint: { cursor: { internalPath: "/private/operator/notes.md", content: "not public" } },
  configFingerprint: "a".repeat(64), resumable: false,
};
const request = { input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "test-one" };
function setup(enabled = true) {
  const capability = { run: vi.fn(async (_request?: unknown) => report), status: vi.fn(async () => report), resume: vi.fn(async () => report) };
  const options = { service: {} as never, authority, ...(enabled ? { continuousMemoryEvolution: capability } : {}) };
  const router = createRestRouter(options);
  return { capability, tools: createMcpMemoryTools(options),
    post: (operation: string, body: unknown) => router.handle({
      method: "POST", path: `/v1/evolution/${operation}`, body, headers: {}, remoteAddress: "127.0.0.1",
    }),
  };
}

describe("host-owned evolution transports", () => {
  test("absent capabilities are not advertised or executed", async () => {
    const f = setup(false);
    expect((await f.post("run", request)).status).toBe(404);
    expect(f.tools.map(t => t.name)).not.toContain("memory_evolution_run");
    expect(f.capability.run).not.toHaveBeenCalled();
  });
  test("REST and MCP invoke the same service with bounded, content-free reports", async () => {
    const f = setup();
    const response = await f.post("run", request);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toMatch(/private\/operator|not public|internalPath/);
    expect(response.body).toMatchObject({ batchId: "batch-one", status: "completed", usageAccounting: "budget_reservation" });
    const tool = f.tools.find(t => t.name === "memory_evolution_run")!;
    expect(await tool.execute(request)).toEqual(response.body);
    expect(f.capability.run).toHaveBeenCalledTimes(2);
    expect(f.capability.run.mock.calls[0]?.[0]).not.toHaveProperty("scope");
  });
  test("MCP proxy discovers and calls the existing host tool, without constructing a service", async () => {
    const f = setup();
    const invoke = vi.fn(async (input: { method: string; path: string; body?: { name: string; arguments: Record<string, unknown> } }) => {
      if (input.path === "/v1/runtime/mcp-tools") return { tools: f.tools.map(({ execute: _execute, ...tool }) => tool) };
      expect(input.path).toBe("/v1/runtime/mcp-call");
      return f.tools.find(tool => tool.name === input.body!.name)!.execute(input.body!.arguments);
    });
    const proxy = await loadRuntimeMcpTools({ invoke } as never);
    const tool = proxy.find(candidate => candidate.name === "memory_evolution_run")!;
    expect(await tool.execute(request)).toMatchObject({ batchId: "batch-one", usageAccounting: "budget_reservation" });
    expect(f.capability.run).toHaveBeenCalledOnce();
  });
  test("all transports reject authority/path/model and nested injection before calling", async () => {
    const f = setup();
    const tool = f.tools.find(t => t.name === "memory_evolution_run")!;
    for (const payload of [
      ...["scope", "authority", "path", "model", "configFingerprint"].map(key => ({ ...request, [key]: "attacker" })),
      { ...request, input: { mode: "directory", sourceId: "../secret" } },
      { ...request, input: { mode: "directory", sourceId: "notes:private" } },
      { ...request, input: { mode: "directory", sourceId: "notes", path: "/private" } },
      { ...request, limits: { maxRecords: 999999 } },
    ]) {
      expect((await f.post("run", payload)).status).toBe(400);
      await expect(tool.execute(payload)).rejects.toThrow();
    }
    expect(f.capability.run).not.toHaveBeenCalled();
  });
  test("status/resume cannot add scope and unknown IDs do not reveal another scope", async () => {
    const f = setup();
    for (const operation of ["status", "resume"] as const) {
      expect((await f.post(operation, { batchId: "batch-one", scope: { userId: "other" } })).status).toBe(400);
      expect(f.capability[operation]).not.toHaveBeenCalled();
      expect((await f.post(operation, { batchId: "batch-one" })).status).toBe(200);
    }
    f.capability.status.mockResolvedValueOnce(undefined as never);
    expect((await f.post("status", { batchId: "other-batch" })).status).toBe(404);
  });
  test("provider error messages never escape", async () => {
    const f = setup();
    f.capability.run.mockRejectedValueOnce(new Error("postgres password=secret /private/path"));
    const response = await f.post("run", request);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response)).not.toMatch(/password|private/);
  });
});
