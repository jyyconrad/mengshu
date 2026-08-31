import { describe, expect, test, vi } from "vitest";

import type { RuntimeClient } from "../../api/src/runtime-client.js";
import { loadRuntimeMcpTools } from "./runtime-client-proxy.js";

function client(...responses: unknown[]): RuntimeClient & { invoke: ReturnType<typeof vi.fn> } {
  const invoke = vi.fn();
  for (const response of responses) invoke.mockResolvedValueOnce(response);
  return { invoke } as unknown as RuntimeClient & { invoke: ReturnType<typeof vi.fn> };
}

describe("RuntimeClient MCP proxy", () => {
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
