/**
 * MCP stdio server adapter 测试。
 *
 * 策略：
 *   - 主测提取出的纯函数 buildListToolsResult / buildCallToolHandler（handler 真实逻辑）。
 *   - 通过 FakeTransport 驱动真实 SDK Server，完成 initialize 握手后调用 tools/list、
 *     tools/call，验证端到端 wiring；不启动真实 stdio 进程。
 * 关键边界：未知工具与 execute 抛错均包成 isError content。
 */

import { describe, expect, test, vi } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { MemoryService } from "../../../core/service-types.js";
import {
  buildCallToolHandler,
  buildListToolsResult,
  closeMcpServerAndRuntime,
  createMcpStdioServer,
  startMcpStdioServer,
  waitForMcpServerShutdown,
} from "./stdio-server.js";
import { createExactMcpAuthority } from "./authority.js";
import type { McpMemoryTool } from "./tools.js";
import { AuthorityScopeError } from "../../core/src/domain/authority-scope.js";
import { AuthorityScopedForgetError } from "../../core/src/lifecycle/forget-transaction.js";

const scope = {
  tenantId: "local",
  appId: "openclaw",
  userId: "user-1",
  projectId: "project-1",
  agentId: "agent-1",
  namespace: "memories",
};
const authority = createExactMcpAuthority({ ...scope, visibility: "private" });
const defaultScope = { ...scope, visibility: "private" as const };

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

  disconnect(): void {
    this.onclose?.();
  }
}

describe("buildListToolsResult", () => {
  test("maps tools to MCP tool descriptors with inputSchema", () => {
    const { tools } = createMcpStdioServer({ authority, defaultScope, service: new FakeMemoryService() });
    const result = buildListToolsResult(tools);

    expect(result.tools).toHaveLength(7);
    expect(result.tools.map((tool) => tool.name)).not.toContain("memory_forget");
    const health = result.tools.find((t) => t.name === "memory_health");
    expect(health).toBeDefined();
    expect(health?.inputSchema).toHaveProperty("type", "object");
  });
});

describe("buildCallToolHandler", () => {
  test("routes a known tool and wraps result as text content", async () => {
    const { tools } = createMcpStdioServer({ authority, defaultScope, service: new FakeMemoryService() });
    const call = buildCallToolHandler(tools);

    const result = await call("memory_health", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true });
  });

  test("returns an isError content for unknown tools", async () => {
    const { tools } = createMcpStdioServer({ authority, defaultScope, service: new FakeMemoryService() });
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
    expect(result.content[0].text).toContain("INTERNAL_ERROR");
    expect(result.content[0].text).not.toContain("kaboom");
  });

  test("never echoes secret-like provider errors to the MCP client", async () => {
    const secret = "postgres://user:raw-secret@host/db";
    const call = buildCallToolHandler([{
      name: "boom",
      description: "throws",
      inputSchema: { type: "object" },
      execute: async () => { throw new Error(secret); },
    }]);

    const result = await call("boom", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).not.toContain(secret);
    expect(result.content[0].text).toContain("INTERNAL_ERROR");
  });

  test("returns a stable scope error code without exposing authority details", async () => {
    const call = buildCallToolHandler([{
      name: "scope_error",
      description: "throws a typed scope error",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new AuthorityScopeError(
          "CLIENT_VALUE_NOT_ALLOWED",
          "secret allowlist value is not allowed",
          "appId",
        );
      },
    }]);

    const result = await call("scope_error", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("CLIENT_VALUE_NOT_ALLOWED");
    expect(result.content[0].text).not.toContain("secret allowlist value");
  });

  test("forget target mismatch explains tableName and dataTypes defaults", async () => {
    const call = buildCallToolHandler([{
      name: "forget_error",
      description: "throws a typed forget error",
      inputSchema: { type: "object" },
      execute: async () => {
        throw new AuthorityScopedForgetError(
          "TARGET_NOT_FOUND_OR_FORBIDDEN",
          "forget target was not found or is not authorized",
        );
      },
    }]);

    const result = await call("forget_error", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("TARGET_NOT_FOUND_OR_FORBIDDEN");
    expect(result.content[0].text).toContain("tableName");
    expect(result.content[0].text).toContain("dataTypes");
  });

  test("passes string tool results through without JSON quoting", async () => {
    const textTool = {
      name: "text_result",
      description: "returns text",
      inputSchema: { type: "object", properties: {} },
      execute: async () => "1. User prefers concise replies",
    };
    const call = buildCallToolHandler([textTool]);

    const result = await call("text_result", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe("1. User prefers concise replies");
  });
});

describe("createMcpStdioServer", () => {
  test("rejects production stdio construction without authority", () => {
    expect(() => createMcpStdioServer({ service: new FakeMemoryService() } as never)).toThrow(
      /MCP authority is required|authority configuration/i,
    );
  });

  test("rejects missing or mismatched defaultScope before transport startup", () => {
    expect(() => createMcpStdioServer({
      authority,
      service: new FakeMemoryService(),
    } as never)).toThrow(/defaultScope|authority configuration/i);
    expect(() => createMcpStdioServer({
      authority,
      defaultScope: { ...defaultScope, namespace: "other" },
      service: new FakeMemoryService(),
    })).toThrow(/defaultScope|authority configuration/i);
  });

  test("freezes the registry used by list and call so it cannot drift after startup", () => {
    const { tools } = createMcpStdioServer({ authority, defaultScope, service: new FakeMemoryService() });

    expect(Object.isFrozen(tools)).toBe(true);
    expect(() => (tools as unknown as McpMemoryTool[]).push({
      name: "late",
      description: "late",
      inputSchema: { type: "object" },
      execute: async () => "late",
    })).toThrow();
    expect(buildListToolsResult(tools).tools.map((tool) => tool.name)).not.toContain("late");
  });

  test("registers ListTools/CallTool handlers driven via transport", async () => {
    const { server } = createMcpStdioServer({ authority, defaultScope, service: new FakeMemoryService() });
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
    expect(listResponse?.result?.tools).toHaveLength(7);

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
    expect(JSON.parse(text)).toEqual({ ok: true });

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

    const { tools } = createMcpStdioServer({ authority, defaultScope,
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

  test("transport close resolves the running server lifecycle", async () => {
    const transport = new FakeTransport();
    const running = await startMcpStdioServer(
      { authority, defaultScope, service: new FakeMemoryService() },
      { transport },
    );
    let closed = false;
    void running.closed.then(() => { closed = true; });

    transport.disconnect();
    await running.closed;

    expect(closed).toBe(true);
    await expect(running.close()).resolves.toBeUndefined();
  });

  test("signal shutdown closes transport and resolves without process.exit", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const signals = {
      once: (signal: string, listener: (...args: unknown[]) => void) => {
        listeners.set(signal, listener);
        return signals;
      },
      off: (signal: string) => {
        listeners.delete(signal);
        return signals;
      },
    };
    let resolveClosed!: () => void;
    const close = vi.fn(async () => { resolveClosed(); });
    const running = {
      close,
      closed: new Promise<void>((resolve) => { resolveClosed = resolve; }),
    };
    const waiting = waitForMcpServerShutdown(running, signals);

    listeners.get("SIGTERM")?.();
    const reason = await waiting;

    expect(reason).toBe("SIGTERM");
    expect(close).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
  });

  test("shutdown still stops runtime when transport close fails", async () => {
    const closeFailure = new Error("close-secret");
    const runtimeFailure = new Error("runtime-secret");
    const running = {
      closed: Promise.resolve(),
      close: vi.fn(async () => { throw closeFailure; }),
    };
    const runtime = {
      stop: vi.fn(async () => { throw runtimeFailure; }),
    };

    const failure = await closeMcpServerAndRuntime(running, runtime).catch((error) => error);

    expect(running.close).toHaveBeenCalledTimes(1);
    expect(runtime.stop).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([closeFailure, runtimeFailure]);
  });
});
