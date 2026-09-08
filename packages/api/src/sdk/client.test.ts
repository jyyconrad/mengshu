import { describe, expect, test, vi } from "vitest";
import { MemoryClient, MemoryClientError } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MemoryClient", () => {
  test("resume forwards optional owner credentials without attaching them to ordinary run", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {}));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", ownerToken: "owner-fixture", fetch: fetchImpl });
    await client.resumeEvolution("control-batch");
    expect(fetchImpl.mock.calls[0]).toEqual(["http://127.0.0.1:3847/v1/evolution/resume", expect.objectContaining({
      body: JSON.stringify({ batchId: "control-batch" }), redirect: "error",
      headers: expect.objectContaining({ "x-mengshu-owner-token": "owner-fixture" }),
    })]);
    const ordinary = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", fetch: fetchImpl });
    await ordinary.resumeEvolution("ordinary-batch");
    expect(fetchImpl.mock.calls[1]![1]!.headers).not.toHaveProperty("x-mengshu-owner-token");
    await client.evolveMemory({ input: { mode: "inventory", selection: "baseline" }, action: "preview", idempotencyKey: "ordinary" });
    expect(fetchImpl.mock.calls[2]![1]!.headers).not.toHaveProperty("x-mengshu-owner-token");
  });
  test("governance SDK methods use exact bodies, owner headers and redirect rejection", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {}));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", ownerToken: "owner-fixture", fetch: fetchImpl });
    const hash = "a".repeat(64), request = { input: { mode: "control" as const, work: { kind: "source_reconcile" as const, sourceId: "notes" } },
      action: "execute_control" as const, idempotencyKey: "control", limits: { maxRecords: 12, maxFiles: 2, maxBytes: 1000, maxDurationMs: 1000 } };
    const approval = { operationReceiptId: hash, currentStateHash: hash, expectedRevision: 0,
      idempotencyKey: "approve", operationIdempotencyKey: "undo", expiresAt: 1000 };
    await client.runEvolutionControl(request); await client.previewEvolutionUndo(hash); await client.approveEvolutionUndo(approval);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["run", "undo-preview", "undo-approve"]
      .map(path => `http://127.0.0.1:3847/v1/evolution/control/${path}`));
    expect(fetchImpl.mock.calls.map(([, init]) => JSON.parse(init!.body as string))).toEqual([request, { operationReceiptId: hash }, approval]);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.method).toBe("POST"); expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ "x-mengshu-owner-token": "owner-fixture" }); expect(init?.body).not.toContain("owner-fixture");
    }
    fetchImpl.mockClear();
    await expect(client.runEvolutionControl({ ...request, authority: "injected" } as never)).rejects.toThrow("EVOLUTION_REQUEST_INVALID");
    await expect(client.runEvolutionControl({ ...request, limits: { maxLlmCalls: 0 } } as never)).rejects.toThrow("EVOLUTION_REQUEST_INVALID");
    await expect(client.previewEvolutionUndo("../private")).rejects.toThrow("EVOLUTION_REQUEST_INVALID");
    await expect(client.approveEvolutionUndo({ ...approval, path: "/private" } as never)).rejects.toThrow("EVOLUTION_REQUEST_INVALID");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test("governance SDK preserves owner denial instead of claiming success", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(403, { error: "EVOLUTION_OWNER_REQUIRED" }));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", fetch: fetchImpl });
    await expect(client.previewEvolutionUndo("a".repeat(64))).rejects.toMatchObject({ status: 403, message: "EVOLUTION_OWNER_REQUIRED" });
    expect(fetchImpl.mock.calls[0]![1]!.headers).not.toHaveProperty("x-mengshu-owner-token");
    expect(fetchImpl.mock.calls[0]![1]!.redirect).toBe("error");
  });
  test("signed source and reuse controls carry owner auth but cannot select a remote model or file", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {}));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", ownerToken: "owner-fixture", fetch: fetchImpl });
    await client.evolutionReuseStatus();
    await client.replaceEvolutionReuseGrants({ expectedRevision: 0, idempotencyKey: "grants", grants: [] });
    await client.evaluateEvolutionReuse("plan-one");
    await client.revokeEvolutionSourceAttestation({ sourceId: "notes", sourceRevision: "r1", expectedRevision: 0,
      idempotencyKey: "revoke", operationIdempotencyKey: "operation", expiresAt: 1000 });
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["reuse/status", "reuse/grants", "reuse/evaluate", "source/revoke-attestation"]
      .map(operation => `http://127.0.0.1:3847/v1/evolution/${operation}`));
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init?.headers).toMatchObject({ "x-mengshu-owner-token": "owner-fixture" });
      expect(init?.redirect).toBe("error");
      expect(init?.body).not.toContain("owner-fixture");
    }
    expect(JSON.parse(fetchImpl.mock.calls[2]![1]!.body as string)).toEqual({ planId: "plan-one" });
  });
  test("background status is an ordinary read and updates use owner credentials and revision", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {}));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", ownerToken: "owner-fixture", fetch: fetchImpl });
    const request = { expectedRevision: "11111111-1111-4111-8111-111111111111", mode: "paused" as const, allowedBatchIds: [] };
    await client.backgroundWorkStatus();
    await client.updateBackgroundWork(request);
    expect(fetchImpl.mock.calls[0]?.[1]?.headers).not.toHaveProperty("x-mengshu-owner-token");
    expect(fetchImpl.mock.calls[1]).toEqual(["http://127.0.0.1:3847/v1/runtime/background", expect.objectContaining({
      method: "POST", body: JSON.stringify(request), redirect: "error", headers: expect.objectContaining({ "x-mengshu-owner-token": "owner-fixture" }),
    })]);
  });
  test("review uses an independent owner header and never sends that credential on normal reads", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, {}));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", ownerToken: "owner-fixture", fetch: fetchImpl });
    await client.listEvolutionProposals({ batchId: "batch-1", status: "review", limit: 12 });
    await client.evolutionProposalDetail("proposal-1");
    await client.previewEvolutionReview("proposal-1");
    await client.decideEvolutionReview({ reviewId: "r", expectedBindingHash: "a".repeat(64), decision: "approve", idempotencyKey: "decision" });
    await client.applyEvolutionReview("approval-1");
    await client.cancelEvolution("batch-1");
    await client.health();
    for (const [, init] of fetchImpl.mock.calls.slice(0, 6)) {
      expect(init?.headers).toMatchObject({ "x-mengshu-owner-token": "owner-fixture" });
      expect(init?.redirect).toBe("error");
      expect(init?.body).not.toContain("owner-fixture");
    }
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://127.0.0.1:3847/v1/evolution/review/list");
    expect(fetchImpl.mock.calls[1]?.[0]).toBe("http://127.0.0.1:3847/v1/evolution/review/detail");
    expect(fetchImpl.mock.calls.at(-1)?.[1]?.headers).not.toHaveProperty("x-mengshu-owner-token");
  });
  test("evolution operations proxy to the bounded host routes without path or scope", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(200, { batchId: "batch", status: "queued" }));
    const client = new MemoryClient({ baseUrl: "http://127.0.0.1:3847", fetch: fetchImpl });
    const request = { input: { mode: "inventory" as const, selection: "baseline" as const }, action: "propose" as const, idempotencyKey: "one" };
    await client.evolveMemory(request);
    await client.evolutionStatus("batch");
    await client.resumeEvolution("batch");
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["run", "status", "resume"].map(operation => `http://127.0.0.1:3847/v1/evolution/${operation}`));
    expect(fetchImpl.mock.calls.map(call => JSON.parse((call[1] as RequestInit).body as string))).toEqual([request, { batchId: "batch" }, { batchId: "batch" }]);
  });
  test("calls health with bearer header", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, records: 1 }));
    const client = new MemoryClient({
      baseUrl: "http://127.0.0.1:3847",
      token: "secret-token",
      fetch: fetchImpl,
    });

    await expect(client.health()).resolves.toEqual({ ok: true, records: 1 });
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:3847/v1/health", {
      method: "GET",
      headers: { authorization: "Bearer secret-token" },
      signal: expect.any(AbortSignal),
    });
  });

  test("stores, recalls, and builds context", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(201, { id: "mem-1", stored: true }))
      .mockResolvedValueOnce(jsonResponse(200, { query: "concise", hits: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { content: "safe", hits: [] }));
    const client = new MemoryClient({ baseUrl: "http://localhost:3847/", fetch: fetchImpl });

    await expect(client.storeMemory({
      record: { id: "mem-1" } as never,
      idempotencyKey: "sdk-store-1",
    })).resolves.toEqual({
      id: "mem-1",
      stored: true,
    });
    await expect(client.recall({ query: "concise" })).resolves.toEqual({ query: "concise", hits: [] });
    await expect(client.buildContext({ query: "concise" })).resolves.toEqual({ content: "safe", hits: [] });

    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual([
      "http://localhost:3847/v1/memories",
      "http://localhost:3847/v1/recall",
      "http://localhost:3847/v1/context",
    ]);
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: { id: "mem-1" }, idempotencyKey: "sdk-store-1" }),
    });
  });

  test("wraps HTTP errors with status and response body", async () => {
    const client = new MemoryClient({
      baseUrl: "http://localhost:3847",
      fetch: async () => jsonResponse(401, { error: "Invalid bearer token" }),
    });

    await expect(client.health()).rejects.toMatchObject({
      name: "MemoryClientError",
      status: 401,
      message: "Invalid bearer token",
    });
  });

  test("aborts requests after timeout", async () => {
    const client = new MemoryClient({
      baseUrl: "http://localhost:3847",
      timeoutMs: 1,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });

    await expect(client.health()).rejects.toBeInstanceOf(MemoryClientError);
    await expect(client.health()).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
