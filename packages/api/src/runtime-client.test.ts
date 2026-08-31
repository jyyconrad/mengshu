import { describe, expect, test, vi } from "vitest";

import {
  RuntimeClient,
  RuntimeClientError,
  type RuntimeClientTransport,
} from "./runtime-client.js";

const homeFingerprint = "a".repeat(64);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    protocolVersion: 1,
    ownerId: "runtime-owner-1",
    homeFingerprint,
    generation: 3,
    state: "ready",
    ready: true,
    accepting: true,
    workerOwner: true,
    ...overrides,
  };
}

function transport(...responses: unknown[]): RuntimeClientTransport & {
  request: ReturnType<typeof vi.fn>;
} {
  const request = vi.fn();
  for (const response of responses) {
    request.mockResolvedValueOnce({ status: 200, body: response });
  }
  return { request };
}

function businessResponse(body: unknown, overrides: Record<string, unknown> = {}) {
  return {
    status: 200,
    body,
    runtimeIdentity: {
      ownerId: "runtime-owner-1",
      homeFingerprint,
      generation: 3,
      ...overrides,
    },
  };
}

describe("RuntimeClient M0 contract", () => {
  test("连接前校验 canonical home、single worker owner 与 readiness", async () => {
    const adapter = transport(snapshot());
    const client = new RuntimeClient({ transport: adapter, expectedHomeFingerprint: homeFingerprint });

    await expect(client.connect()).resolves.toEqual(snapshot());
    expect(client.snapshot()).toEqual(snapshot());
    expect(adapter.request).toHaveBeenCalledWith({ method: "GET", path: "/v1/runtime" });
  });

  test("control GET retries one stale transport connection without replaying business calls", async () => {
    const adapter: RuntimeClientTransport & { request: ReturnType<typeof vi.fn> } = {
      request: vi.fn()
        .mockRejectedValueOnce(new Error("stale pooled socket"))
        .mockResolvedValueOnce({ status: 200, body: snapshot() }),
    };
    const client = new RuntimeClient({ transport: adapter, expectedHomeFingerprint: homeFingerprint });
    await expect(client.connect()).resolves.toEqual(snapshot());
    expect(adapter.request).toHaveBeenCalledTimes(2);
  });

  test.each([
    ["home mismatch", snapshot({ homeFingerprint: "b".repeat(64) }), "RUNTIME_HOME_MISMATCH"],
    [
      "not ready",
      snapshot({ state: "starting", ready: false, accepting: false }),
      "RUNTIME_NOT_READY",
    ],
    ["not accepting", snapshot({ accepting: false }), "RUNTIME_NOT_READY"],
    ["not worker owner", snapshot({ workerOwner: false }), "RUNTIME_NOT_OWNER"],
  ])("%s 时 fail-closed", async (_label, response, code) => {
    const client = new RuntimeClient({
      transport: transport(response),
      expectedHomeFingerprint: homeFingerprint,
    });
    await expect(client.connect()).rejects.toEqual(new RuntimeClientError(code as never));
  });

  test("已连接 client 拒绝 owner 漂移和 generation 回退", async () => {
    const changedOwner = new RuntimeClient({
      transport: transport(snapshot(), snapshot({ ownerId: "runtime-owner-2", generation: 4 })),
      expectedHomeFingerprint: homeFingerprint,
    });
    await changedOwner.connect();
    await expect(changedOwner.refresh()).rejects.toEqual(
      new RuntimeClientError("RUNTIME_OWNER_CHANGED"),
    );

    const staleGeneration = new RuntimeClient({
      transport: transport(snapshot(), snapshot({ generation: 2 })),
      expectedHomeFingerprint: homeFingerprint,
    });
    await staleGeneration.connect();
    await expect(staleGeneration.refresh()).rejects.toEqual(
      new RuntimeClientError("RUNTIME_GENERATION_STALE"),
    );
  });

  test("business invoke refreshes readiness and binds the response to owner/home/generation", async () => {
    const adapter: RuntimeClientTransport & { request: ReturnType<typeof vi.fn> } = {
      request: vi.fn()
        .mockResolvedValueOnce({ status: 200, body: snapshot() })
        .mockResolvedValueOnce(businessResponse({ ok: true })),
    };
    const client = new RuntimeClient({ transport: adapter, expectedHomeFingerprint: homeFingerprint });

    await expect(client.invoke<{ ok: boolean }>({ method: "GET", path: "/v1/health" }))
      .resolves.toEqual({ ok: true });
    expect(adapter.request).toHaveBeenNthCalledWith(1, { method: "GET", path: "/v1/runtime" });
    expect(adapter.request).toHaveBeenNthCalledWith(2, { method: "GET", path: "/v1/health" });
  });

  test.each([
    ["owner", businessResponse({}, { ownerId: "runtime-owner-2" }), "RUNTIME_OWNER_CHANGED"],
    ["home", businessResponse({}, { homeFingerprint: "b".repeat(64) }), "RUNTIME_HOME_MISMATCH"],
    ["generation", businessResponse({}, { generation: 4 }), "RUNTIME_GENERATION_STALE"],
    ["missing identity", { status: 200, body: {} }, "RUNTIME_HOME_MISMATCH"],
  ])("business invoke rejects %s drift", async (_label, response, code) => {
    const adapter: RuntimeClientTransport = {
      request: vi.fn()
        .mockResolvedValueOnce({ status: 200, body: snapshot() })
        .mockResolvedValueOnce(response),
    };
    const client = new RuntimeClient({ transport: adapter, expectedHomeFingerprint: homeFingerprint });
    await expect(client.invoke({ method: "POST", path: "/v1/recall", body: {} }))
      .rejects.toEqual(new RuntimeClientError(code as never));
  });
});
