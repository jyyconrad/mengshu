import { describe, expect, test } from "vitest";
import type { MemoryService } from "../../core/service-types.js";
import { createMcpMemoryServer } from "./server.js";

const service = {
  async storeMemory() { return { id: "mem-1", stored: true }; },
  async recall() { return { scope: { tenantId: "local", appId: "openclaw", userId: "default", projectId: "default", agentId: "default", namespace: "memories" }, query: "", hits: [] }; },
  async buildContext() { return { scope: { tenantId: "local", appId: "openclaw", userId: "default", projectId: "default", agentId: "default", namespace: "memories" }, content: "", hits: [] }; },
  async delete() { return { deleted: 0 }; },
  async health() { return { ok: true }; },
} satisfies MemoryService;

describe("MCP memory server adapter", () => {
  test("provides a minimal tool registry without binding to a transport", async () => {
    const server = createMcpMemoryServer({ service });

    expect(server.name).toBe("mengshu");
    expect(server.listTools().map((tool) => tool.name)).toContain("memory_health");
    await expect(server.callTool("memory_health", {})).resolves.toEqual({ ok: true });
    await expect(server.callTool("missing", {})).rejects.toThrow("Unknown MCP tool: missing");
  });
});
