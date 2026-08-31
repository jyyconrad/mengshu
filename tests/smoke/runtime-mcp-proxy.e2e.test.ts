import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { MemoryService } from "../../core/service-types.js";
import type { AuthorityScope } from "../../packages/core/src/domain/authority-scope.js";
import { fingerprintRuntimeHome } from "../../packages/core/src/runtime/host-contract.js";
import {
  RuntimeClient,
  RuntimeClientError,
  createFetchRuntimeClientTransport,
  createUnixSocketRuntimeClientTransport,
} from "../../packages/api/src/runtime-client.js";
import { loadRuntimeMcpTools } from "../../packages/mcp/src/runtime-client-proxy.js";
import { startMemoryServer, type MemoryServerLifecycleHost } from "../../server/daemon.js";

const authority: AuthorityScope = {
  tenantId: "tenant-runtime-client",
  userId: "user-runtime-client",
  allow: {
    appIds: ["codex"], projectIds: ["project-1"], agentIds: ["agent-1"],
    namespaces: ["memories"], visibilities: ["private"],
  },
};

const service: MemoryService = {
  storeMemory: async () => ({ id: "unused", stored: false }),
  recall: async () => ({
    scope: {
      tenantId: authority.tenantId, userId: authority.userId, appId: "codex",
      projectId: "project-1", agentId: "agent-1", namespace: "memories",
      visibility: "private",
    },
    query: "unused",
    hits: [],
  }),
  buildContext: async () => ({
    scope: {
      tenantId: authority.tenantId, userId: authority.userId, appId: "codex",
      projectId: "project-1", agentId: "agent-1", namespace: "memories",
      visibility: "private",
    },
    content: "",
    hits: [],
    tokenEstimate: 0,
  }),
  delete: async () => ({ deleted: 0 }),
  health: async () => ({ ok: true }),
};

class Host implements MemoryServerLifecycleHost {
  state: "created" | "ready" | "stopped" = "created";
  ready = false;
  constructor(readonly generation: number) {}
  async start(): Promise<void> { this.state = "ready"; this.ready = true; }
  async stop(): Promise<void> { this.state = "stopped"; this.ready = false; }
  snapshot() {
    return {
      state: this.state,
      ready: this.ready,
      accepting: this.ready,
      generation: this.generation,
    };
  }
}

let runtimeHome: string | undefined;

afterEach(() => {
  if (runtimeHome) rmSync(runtimeHome, { recursive: true, force: true });
  runtimeHome = undefined;
});

describe("RuntimeHost MCP thin proxy", () => {
  test("serves the thin facade through an owner-only Unix socket and removes it on stop", async () => {
    runtimeHome = mkdtempSync(join(tmpdir(), "mengshu-runtime-proxy-"));
    const socketPath = join(runtimeHome, "run", "mengshu.sock");
    const running = await startMemoryServer({
      service,
      authority,
      runtimeMcp: {
        listTools: () => [{
          name: "memory_health", description: "Health", inputSchema: { type: "object" },
        }],
        callTool: async () => ({ ok: true }),
      },
      runtimeHost: new Host(1),
      runtimeHome,
      socketPath,
    });
    expect(running.url).toContain("http+unix://");
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    const client = new RuntimeClient({
      transport: createUnixSocketRuntimeClientTransport({ socketPath }),
      expectedHomeFingerprint: fingerprintRuntimeHome(runtimeHome),
    });
    const tools = await loadRuntimeMcpTools(client);
    await expect(tools[0]!.execute({})).resolves.toEqual({ ok: true });
    await running.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  test("executes through one owner and rejects the same client after daemon restart", async () => {
    runtimeHome = mkdtempSync(join(tmpdir(), "mengshu-runtime-proxy-"));
    const runtimeMcp = {
      listTools: () => [{
        name: "memory_health", description: "Health", inputSchema: { type: "object" },
      }],
      callTool: async (name: string) => ({ ok: name === "memory_health" }),
    };
    const first = await startMemoryServer({
      service, authority, runtimeMcp, runtimeHost: new Host(1), runtimeHome,
      host: "127.0.0.1", port: 0,
    });
    const client = new RuntimeClient({
      transport: createFetchRuntimeClientTransport({ baseUrl: first.url }),
      expectedHomeFingerprint: fingerprintRuntimeHome(runtimeHome),
    });
    const tools = await loadRuntimeMcpTools(client);
    await expect(tools[0]!.execute({})).resolves.toEqual({ ok: true });
    const port = Number(new URL(first.url).port);
    await first.stop();

    const second = await startMemoryServer({
      service, authority, runtimeMcp, runtimeHost: new Host(2), runtimeHome,
      host: "127.0.0.1", port,
    });
    try {
      await expect(tools[0]!.execute({})).rejects.toEqual(
        new RuntimeClientError("RUNTIME_OWNER_CHANGED"),
      );
    } finally {
      await second.stop();
    }
  });
});
