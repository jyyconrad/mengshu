import { describe, expect, test, vi } from "vitest";
import { MemoryClient, MemoryClientError } from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("MemoryClient", () => {
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

    await expect(client.storeMemory({ record: { id: "mem-1" } as never })).resolves.toEqual({
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
      body: JSON.stringify({ record: { id: "mem-1" } }),
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
