import { describe, expect, test, vi } from "vitest";
import { createRestRouter } from "./router.js";
import { assertEvolutionOwnerRequest } from "../evolution-owner-auth.js";
import { EvolutionError } from "../../../core/src/evolution/schema.js";
import type { EvolutionBatchReport, EvolutionControlRequest } from "../../../core/src/evolution/types.js";
import { createRuntimeMcpFacade, createMcpStdioServer } from "../../../mcp/src/stdio-server.js";
import { MemoryClient } from "../sdk/client.js";

const authority = { tenantId: "tenant", userId: "owner", allow: {
  appIds: ["codex"], projectIds: ["project"], agentIds: ["agent"], namespaces: ["memories"], visibilities: ["private" as const],
} };
const secret = "independent-governance-owner-fixture";
const hash = "a".repeat(64), stateHash = "b".repeat(64);
const request: EvolutionControlRequest = { input: { mode: "control", work: { kind: "source_reconcile", sourceId: "notes" } },
  action: "execute_control", idempotencyKey: "control-one", limits: { maxRecords: 12, maxFiles: 2, maxBytes: 1000, maxDurationMs: 1000 } };
const preview = { operationReceiptId: hash };
const approval = { ...preview, currentStateHash: stateHash, expectedRevision: 0, idempotencyKey: "approve-one",
  operationIdempotencyKey: "undo-one", expiresAt: 1000 };
const rows = [
  { operation: "control/run", method: "run", body: request, tool: "memory_evolution_control_run" },
  { operation: "control/undo-preview", method: "previewUndo", body: preview, tool: "memory_evolution_control_undo_preview" },
  { operation: "control/undo-approve", method: "approveUndo", body: approval, tool: "memory_evolution_control_undo_approve" },
] as const;
const report: EvolutionBatchReport = { batchId: "control-batch", status: "queued", reasons: [],
  usage: { records: 0, files: 0, bytes: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0, durationMs: 0 },
  counts: { proposed: 0, applied: 0, rejected: 0, review: 0, noop: 0, skipped: 0 },
  checkpoint: { cursor: { locator: "/private/source", state: "internal-only" } }, configFingerprint: hash, resumable: true,
  work: { kind: "source_reconcile" } };

function fixture(enabled = true) {
  const control = {
    run: vi.fn(async (_value: EvolutionControlRequest) => { assertEvolutionOwnerRequest(authority); return report; }),
    previewUndo: vi.fn(async (_value: unknown) => { assertEvolutionOwnerRequest(authority); return {
      ...preview, operation: "mark_disputed" as const, memoryIds: ["memory-one"], currentStateHash: stateHash, internalCheckpoint: "internal-only" }; }),
    approveUndo: vi.fn(async (_value: unknown) => { assertEvolutionOwnerRequest(authority); return {
      id: hash, kind: "governance_undo" as const, entryId: stateHash, operation: "put" as const, revision: 1,
      valueHash: hash, createdAt: 10, ownerSecret: secret }; }),
  };
  const capability = { run: vi.fn(async () => report), status: async () => report, resume: vi.fn(async (batchId: string) => {
    if (batchId === "control-batch") assertEvolutionOwnerRequest(authority);
    return { ...report, batchId };
  }), ...(enabled ? { control } : {}) };
  const options = { service: {} as never, authority, continuousMemoryEvolution: capability, defaultScope: {
    tenantId: authority.tenantId, userId: authority.userId, appId: "codex", projectId: "project",
    agentId: "agent", namespace: "memories", visibility: "private" as const,
  } };
  const facade = createRuntimeMcpFacade(options);
  const router = createRestRouter({ ...options, evolutionOwnerSecret: secret, runtimeControl: {} as never, runtimeMcp: facade });
  const send = (path: string, body?: unknown, headers: Record<string, string | string[] | undefined> = {}, method: "GET" | "POST" = "POST") =>
    router.handle({ method, path, body, headers, remoteAddress: "127.0.0.1" });
  return { control, capability, options, facade, send, post: (operation: string, body: unknown, owner = true) =>
    send(`/v1/evolution/${operation}`, body, owner ? { "x-mengshu-owner-token": secret } : {}) };
}

describe("F2 owner governance REST and native MCP registry", () => {
  test("SDK control resume traverses the actual REST owner boundary while ordinary resume needs no credential", async () => {
    const f = fixture();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const response = await f.send(new URL(String(url)).pathname, JSON.parse(init!.body as string), headers);
      return new Response(JSON.stringify(response.body), { status: response.status, headers: { "content-type": "application/json" } });
    });
    const owner = new MemoryClient({ baseUrl: "http://127.0.0.1:9", ownerToken: secret, fetch: fetchImpl });
    const ordinary = new MemoryClient({ baseUrl: "http://127.0.0.1:9", fetch: fetchImpl });
    await expect(owner.resumeEvolution("control-batch")).resolves.toMatchObject({ batchId: "control-batch" });
    await expect(ordinary.resumeEvolution("control-batch")).rejects.toMatchObject({ status: 403 });
    await expect(ordinary.resumeEvolution("ordinary-batch")).resolves.toMatchObject({ batchId: "ordinary-batch" });
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("error");
    expect(fetchImpl.mock.calls[1]![1]!.headers).not.toHaveProperty("x-mengshu-owner-token");
    expect(() => assertEvolutionOwnerRequest(authority)).toThrow();
  });
  test("existing resume optionally carries authenticated owner context and leaves ordinary batches compatible", async () => {
    const f = fixture();
    expect((await f.post("resume", { batchId: "control-batch" }, false)).status).toBe(403);
    expect((await f.post("resume", { batchId: "ordinary-batch" }, false)).status).toBe(200);
    expect((await f.post("resume", { batchId: "control-batch" })).status).toBe(200);
    const calls = f.capability.resume.mock.calls.length;
    for (const headers of [{ "x-mengshu-owner-token": "wrong" }, { "x-mengshu-owner-token": [secret] },
      { "x-mengshu-owner-token": secret, "X-Mengshu-Owner-Token": secret }]) {
      expect((await f.send("/v1/evolution/resume", { batchId: "control-batch" }, headers)).status).toBe(403);
    }
    expect(f.capability.resume).toHaveBeenCalledTimes(calls);
    expect((await f.send("/v1/evolution/resume", { batchId: "control-batch" }, { "X-Mengshu-Owner-Token": secret })).status).toBe(200);
    f.capability.run.mockImplementationOnce(async () => { expect(() => assertEvolutionOwnerRequest(authority)).toThrow(); return report; });
    expect((await f.post("run", { input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "ordinary" })).status).toBe(200);
    expect(() => assertEvolutionOwnerRequest(authority)).toThrow();
  });
  test.each(rows)("routes $operation only after independent owner authentication", async row => {
    const f = fixture();
    for (const headers of [{}, { "x-mengshu-owner-token": "wrong" }, { "x-mengshu-owner-token": [secret, secret] },
      { "x-mengshu-owner-token": secret, "X-Mengshu-Owner-Token": secret }]) {
      expect((await f.send(`/v1/evolution/${row.operation}`, row.body, headers)).status).toBe(403);
    }
    expect(f.control[row.method]).not.toHaveBeenCalled();
    const result = await f.post(row.operation, row.body);
    expect(result.status).toBe(200);
    expect(f.control[row.method]).toHaveBeenCalledExactlyOnceWith(row.body);
    expect(JSON.stringify(result.body)).not.toMatch(/internal-only|private\/source|ownerSecret/);
    expect(JSON.stringify(result.body)).not.toContain(secret);
    expect(() => assertEvolutionOwnerRequest(authority)).toThrow();
  });

  test.each(rows)("fails closed when $operation capability is absent", async row => {
    const f = fixture(false);
    expect((await f.post(row.operation, row.body)).status).toBe(404);
    expect(f.facade.listTools().some(tool => tool.name === row.tool)).toBe(false);
    expect(f.control[row.method]).not.toHaveBeenCalled();
  });

  test.each(rows)("rejects injected fields before invoking $operation", async row => {
    const f = fixture();
    for (const field of ["authority", "scope", "path", "model", "handler", "ownerSecret", "checkpoint"]) {
      expect((await f.post(row.operation, { ...row.body, [field]: "injected" })).status).toBe(400);
      const result = await f.send("/v1/runtime/mcp-call", { name: row.tool, arguments: { ...row.body, [field]: "injected" } },
        { "x-mengshu-owner-token": secret });
      expect(result.status).toBe(400);
    }
    expect(f.control[row.method]).not.toHaveBeenCalled();
  });

  test("ordinary run, open-ended work and unknown routes cannot dispatch control", async () => {
    const f = fixture();
    expect((await f.post("run", request, false)).status).toBe(400);
    for (const body of [{ ...request, input: { mode: "control", work: { kind: "build_tree", sourceId: "notes" } } },
      { ...request, limits: { maxLlmCalls: 0 } }, { ...request, limits: { maxFiles: 0 } },
      { ...request, input: { mode: "control", work: { kind: "source_revoke", sourceId: "notes" } } }]) {
      expect((await f.post("control/run", body)).status).toBe(400);
    }
    expect((await f.post("control/put", request)).status).toBe(404);
    expect((await f.send("/v1/evolution/control/run", request, {}, "GET")).status).toBe(405);
    expect(f.control.run).not.toHaveBeenCalled(); expect(f.capability.run).not.toHaveBeenCalled();
  });

  test("owner MCP controls are hidden and uncallable to ordinary clients and direct stdio", async () => {
    const f = fixture();
    const ordinary = await f.send("/v1/runtime/mcp-tools", undefined, {}, "GET");
    expect(ordinary.status).toBe(200);
    for (const row of rows) {
      expect(JSON.stringify(ordinary.body)).not.toContain(row.tool);
      expect((await f.send("/v1/runtime/mcp-call", { name: row.tool, arguments: row.body })).status).toBe(403);
      await expect(f.facade.callTool(row.tool, { ...row.body })).rejects.toMatchObject({ code: "EVOLUTION_OWNER_REQUIRED" });
      expect(f.control[row.method]).not.toHaveBeenCalled();
      expect((await f.send("/v1/runtime/mcp-call", { name: row.tool, arguments: row.body },
        { "x-mengshu-owner-token": secret })).status).toBe(200);
    }
    const direct = createMcpStdioServer(f.options);
    expect(direct.tools.some(tool => tool.name.startsWith("memory_evolution_control_"))).toBe(false);
    await direct.server.close();
  });

  test("backend failures preserve safe error codes without returning internal messages", async () => {
    const f = fixture();
    f.control.run.mockRejectedValueOnce(new EvolutionError("source_revision_changed"));
    expect(await f.post("control/run", request)).toMatchObject({ status: 409, body: { error: "EVOLUTION_SOURCE_REVISION_CHANGED" } });
    f.control.run.mockRejectedValueOnce(new Error(`password=${secret} /private/source`));
    expect(await f.post("control/run", request)).toMatchObject({ status: 500, body: { error: "EVOLUTION_OPERATION_FAILED" } });
  });
});
