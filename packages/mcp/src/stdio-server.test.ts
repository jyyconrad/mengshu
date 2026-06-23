/**
 * MCP stdio server adapter 测试。
 *
 * 策略：
 *   - 主测提取出的纯函数 buildListToolsResult / buildCallToolHandler（handler 真实逻辑）。
 *   - 通过 FakeTransport 驱动真实 SDK Server，完成 initialize 握手后调用 tools/list、
 *     tools/call，验证端到端 wiring；不启动真实 stdio 进程。
 * 关键边界：未知工具与 execute 抛错均包成 isError content。
 */

import { describe, expect, test } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MemoryService } from "../../../core/service-types.js";
import {
  buildCallToolHandler,
  buildListToolsResult,
  createMcpStdioServer,
} from "./stdio-server.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};

class FakeMemoryService implements MemoryService {
  async storeMemory() {
    return { id: "mem-1", stored: true };
  }
  async recall() {
    return { scope, query: "concise", hits: [] };
  }
  async buildContext() {
    return { scope, content: "safe", hits: [], tokenEstimate: 1 };
  }
  async delete() {
    return { deleted: 1 };
  }
  async health() {
    return { ok: true, records: 1 };
  }
}

/**
 * 内存 Transport 替身：捕获 Server 的出站消息，可注入入站消息。
 */
class FakeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
  async close(): Promise<void> {
    this.onclose?.();
  }

  /** 注入入站消息并等待 Server 异步处理完成 */
  async inject(message: JSONRPCMessage): Promise<void> {
    this.onmessage?.(message);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** 取出指定 id 的响应 */
  responseFor(id: number): JSONRPCMessage | undefined {
    return this.sent.find((m) => (m as { id?: number }).id === id);
  }
}

describe("buildListToolsResult", () => {
  test("maps tools to MCP tool descriptors with inputSchema", () => {
    const { tools } = createMcpStdioServer({ service: new FakeMemoryService() });
    const result = buildListToolsResult(tools);

    expect(result.tools).toHaveLength(8);
    const health = result.tools.find((t) => t.name === "memory_health");
    expect(health).toBeDefined();
    expect(health?.inputSchema).toHaveProperty("type", "object");
  });
});

describe("buildCallToolHandler", () => {
  test("routes a known tool and wraps result as text content", async () => {
    const { tools } = createMcpStdioServer({ service: new FakeMemoryService() });
    const call = buildCallToolHandler(tools);

    const result = await call("memory_health", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, records: 1 });
  });

  test("returns an isError content for unknown tools", async () => {
    const { tools } = createMcpStdioServer({ service: new FakeMemoryService() });
    const call = buildCallToolHandler(tools);

    const result = await call("missing", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown MCP tool: missing");
  });

  test("wraps execute errors as isError content", async () => {
    const throwingTool = {
      name: "boom",
      description: "throws",
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const call = buildCallToolHandler([throwingTool]);

    const result = await call("boom", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("kaboom");
  });
});

describe("createMcpStdioServer", () => {
  test("registers ListTools/CallTool handlers driven via transport", async () => {
    const { server } = createMcpStdioServer({ service: new FakeMemoryService() });
    const transport = new FakeTransport();
    await server.connect(transport);

    // MCP initialize 握手
    await transport.inject({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" },
      },
    });
    await transport.inject({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    // tools/list
    await transport.inject({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listResponse = transport.responseFor(2) as { result?: { tools?: unknown[] } };
    expect(listResponse?.result?.tools).toHaveLength(8);

    // tools/call
    await transport.inject({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "memory_health", arguments: {} },
    });
    const callResponse = transport.responseFor(3) as {
      result?: { content?: Array<{ text: string }> };
    };
    const text = callResponse?.result?.content?.[0]?.text ?? "{}";
    expect(JSON.parse(text)).toEqual({ ok: true, records: 1 });

    await server.close();
  });

  test("memory_ingest becomes callable when a pipeline is injected", async () => {
    const inputs: Array<Record<string, unknown>> = [];
    const pipeline = {
      async ingest(input: Record<string, unknown>) {
        inputs.push(input);
        return { documentId: "doc:x", chunksAdmitted: 1, chunksDropped: 0, jobsQueued: 1 };
      },
    };

    const { tools } = createMcpStdioServer({
      service: new FakeMemoryService(),
      pipeline: pipeline as unknown as Parameters<typeof createMcpStdioServer>[0]["pipeline"],
    });
    const call = buildCallToolHandler(tools);

    const result = await call("memory_ingest", {
      source: "ingest body content",
      sourceType: "text",
      scope,
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      documentId: "doc:x",
      chunksAdmitted: 1,
    });
    expect(inputs).toHaveLength(1);
  });
});
