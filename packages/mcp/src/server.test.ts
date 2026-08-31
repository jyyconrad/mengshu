import fs, { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { MemoryService } from "../../../core/service-types.js";
import {
  createMcpMemoryServer,
  loadMcpServerAuthorityFromEnv,
  parseMcpServerAuthorityConfig,
} from "./server.js";
import { createExactMcpAuthority } from "./authority.js";
import { AuthorityScopeError } from "../../core/src/domain/authority-scope.js";

const service = {
  async storeMemory() { return { id: "mem-1", stored: true }; },
  async recall() { return { scope: { tenantId: "local", appId: "openclaw", userId: "default", projectId: "default", agentId: "default", namespace: "memories" }, query: "", hits: [] }; },
  async buildContext() { return { scope: { tenantId: "local", appId: "openclaw", userId: "default", projectId: "default", agentId: "default", namespace: "memories" }, content: "", hits: [] }; },
  async delete() { return { deleted: 0 }; },
  async health() { return { ok: true }; },
} satisfies MemoryService;

const authority = createExactMcpAuthority({
  tenantId: "local",
  appId: "openclaw",
  userId: "default",
  projectId: "default",
  agentId: "default",
  namespace: "memories",
  visibility: "private",
});

const authorityConfig = {
  authority,
  defaultScope: {
    tenantId: "local",
    appId: "openclaw",
    userId: "default",
    projectId: "default",
    agentId: "default",
    namespace: "memories",
    visibility: "private" as const,
  },
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("MCP memory server adapter", () => {
  test("provides a minimal tool registry without binding to a transport", async () => {
    const server = createMcpMemoryServer({
      service,
      authority,
      defaultScope: authorityConfig.defaultScope,
    });

    expect(server.name).toBe("mengshu");
    expect(server.listTools().map((tool) => tool.name)).toContain("memory_health");
    expect(server.listTools().map((tool) => tool.name)).not.toContain("memory_forget");
    await expect(server.callTool("memory_health", {})).resolves.toEqual({ ok: true });
    await expect(server.callTool("missing", {})).rejects.toThrow("Unknown MCP tool: missing");
  });

  test("negotiates memory_asset_search and fails stably without its capability", async () => {
    const without = createMcpMemoryServer({
      service,
      authority,
      defaultScope: authorityConfig.defaultScope,
      memoryAssets: {
        list: async () => [],
        read: async () => ({
          asset: { id: "asset-1", version: 1, status: "published" },
          contentValidity: "current",
          staleReasons: [],
          explanation: { assetId: "asset-1", version: 1, evidenceIds: [] },
        }),
      } as never,
    });
    expect(without.listTools().map((tool) => tool.name)).not.toContain("memory_asset_search");
    await expect(without.callTool("memory_asset_search", { query: "rules" }))
      .rejects.toThrow("Unknown MCP tool: memory_asset_search");

    const search = vi.fn(async () => ({ query: "rules", assets: [], filtered: [] }));
    const withSearch = createMcpMemoryServer({
      service,
      authority,
      defaultScope: authorityConfig.defaultScope,
      memoryAssets: {
        list: async () => [],
        read: async () => ({
          asset: { id: "asset-1", version: 1, status: "published" },
          contentValidity: "current",
          staleReasons: [],
          explanation: { assetId: "asset-1", version: 1, evidenceIds: [] },
        }),
        search,
      } as never,
    });
    const descriptor = withSearch.listTools()
      .find((tool) => tool.name === "memory_asset_search");
    expect(descriptor?.inputSchema).toMatchObject({
      required: ["query"],
      additionalProperties: false,
    });
    await expect(withSearch.callTool("memory_asset_search", { query: "rules" }))
      .resolves.toEqual({ query: "rules", assets: [], filtered: [] });
    expect(search).toHaveBeenCalledWith(authorityConfig.defaultScope, { query: "rules" });

    for (const forbidden of ["scope", "sql", "path", "url"]) {
      await expect(withSearch.callTool("memory_asset_search", {
        query: "rules",
        [forbidden]: "attacker-value",
      })).rejects.toThrow(/INVALID_REQUEST/);
    }
    expect(search).toHaveBeenCalledTimes(1);
  });

  test("negotiates persisted memory_session_explain only with its capability", async () => {
    const without = createMcpMemoryServer({
      service,
      authority,
      defaultScope: authorityConfig.defaultScope,
    });
    expect(without.listTools().map((tool) => tool.name)).not.toContain("memory_session_explain");
    await expect(without.callTool("memory_session_explain", { sessionId: "session-1" }))
      .rejects.toThrow("Unknown MCP tool: memory_session_explain");

    const receipt = { id: "receipt-1", sessionId: "session-1", bindings: [] };
    const getLatest = vi.fn(async () => receipt);
    const withExplain = createMcpMemoryServer({
      service,
      authority,
      defaultScope: authorityConfig.defaultScope,
      sessionReceipts: { getLatest } as never,
    });
    const descriptor = withExplain.listTools()
      .find((tool) => tool.name === "memory_session_explain");
    expect(descriptor?.inputSchema).toMatchObject({
      required: ["sessionId"],
      additionalProperties: false,
    });
    await expect(withExplain.callTool("memory_session_explain", { sessionId: "session-1" }))
      .resolves.toBe(receipt);
    expect(getLatest).toHaveBeenCalledWith(
      { ...authorityConfig.defaultScope, sessionId: "session-1" },
      "session-1",
    );
  });

  test("transport-agnostic calls do not expose raw service errors", async () => {
    const secret = "postgres://user:raw-secret@host/db";
    const server = createMcpMemoryServer({
      service,
      memoryWrite: {
        async executeMemoryWrite() { throw new Error(secret); },
      },
      authority,
      defaultScope: authorityConfig.defaultScope,
    });

    const failure = await server.callTool("memory_save", {
      text: "safe",
      idempotencyKey: "server-save-1",
    })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("INTERNAL_ERROR");
    expect((failure as Error).message).not.toContain(secret);
  });

  test("transport-agnostic calls preserve safe typed error codes", async () => {
    const server = createMcpMemoryServer({
      service,
      memoryWrite: {
        async executeMemoryWrite() {
        throw new AuthorityScopeError(
          "CLIENT_VALUE_NOT_ALLOWED",
          "secret allowlist value is not allowed",
          "appId",
        );
        },
      },
      authority,
      defaultScope: authorityConfig.defaultScope,
    });

    const failure = await server.callTool("memory_save", {
      text: "safe",
      idempotencyKey: "server-save-2",
    })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("CLIENT_VALUE_NOT_ALLOWED");
    expect((failure as Error).message).not.toContain("secret allowlist value");
  });
});

describe("MCP server-owned authority config", () => {
  test("strictly parses explicit authority + matching defaultScope", () => {
    expect(parseMcpServerAuthorityConfig(authorityConfig)).toEqual(authorityConfig);
    expect(() => parseMcpServerAuthorityConfig({
      ...authorityConfig,
      unexpected: true,
    })).toThrow(/invalid/i);
    expect(() => parseMcpServerAuthorityConfig({
      ...authorityConfig,
      defaultScope: { ...authorityConfig.defaultScope, sessionId: " bad\n" },
    })).toThrow(/invalid/i);
  });

  test("parsed authority remains valid when workspace/session scope is pinned", () => {
    const scoped = {
      authority: authorityConfig.authority,
      defaultScope: {
        ...authorityConfig.defaultScope,
        workspaceId: "workspace-1",
        sessionId: "session-1",
      },
    };
    const parsed = parseMcpServerAuthorityConfig(scoped);

    expect(parseMcpServerAuthorityConfig(parsed)).toEqual(parsed);
    expect(() => parseMcpServerAuthorityConfig({
      authority: { ...parsed.authority, workspaceId: "other-workspace" },
      defaultScope: parsed.defaultScope,
    })).toThrow(/does not match defaultScope/i);
  });

  test("missing/ambiguous host env fails closed", () => {
    expect(() => loadMcpServerAuthorityFromEnv({})).toThrow(/requires/i);
    expect(() => loadMcpServerAuthorityFromEnv({
      MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
      MENGSHU_AUTHORITY_FILE: "/tmp/authority.json",
    })).toThrow(/exactly one/i);
  });

  test("JSON parse/identity mismatch errors are sanitized", () => {
    const secret = "super-secret-authority-payload";
    for (const raw of [
      `{"secret":"${secret}",`,
      JSON.stringify({
        ...authorityConfig,
        defaultScope: { ...authorityConfig.defaultScope, tenantId: secret },
      }),
    ]) {
      let failure: unknown;
      try {
        loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_JSON: raw });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(secret);
    }
  });

  test("authority file must be absolute regular 0600 before content is parsed", () => {
    const dir = mkdtempSync(join(tmpdir(), "mengshu-authority-"));
    tempDirs.push(dir);
    const file = join(dir, "authority.json");
    writeFileSync(file, JSON.stringify(authorityConfig), { mode: 0o600 });

    expect(loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: file }))
      .toEqual(authorityConfig);
    chmodSync(file, 0o644);
    expect(() => loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: file }))
      .toThrow(/0600/);
    expect(() => loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: "relative.json" }))
      .toThrow(/absolute/i);
  });

  test("authority file rejects symlinks even when the target is a regular 0600 file", () => {
    const dir = mkdtempSync(join(tmpdir(), "mengshu-authority-symlink-"));
    tempDirs.push(dir);
    const target = join(dir, "target.json");
    const link = join(dir, "authority.json");
    writeFileSync(target, JSON.stringify(authorityConfig), { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: link }))
      .toThrow(/unavailable|symlink/i);
  });

  test("authority file enforces the 64 KiB read limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "mengshu-authority-large-"));
    tempDirs.push(dir);
    const file = join(dir, "authority.json");
    writeFileSync(file, "x".repeat(64 * 1024 + 1), { mode: 0o600 });

    expect(() => loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: file }))
      .toThrow(/size/i);
  });

  test("authority file rejects a same-inode same-size rewrite during the same-fd read", () => {
    const dir = mkdtempSync(join(tmpdir(), "mengshu-authority-rewrite-"));
    tempDirs.push(dir);
    const file = join(dir, "authority.json");
    const original = JSON.stringify(authorityConfig);
    const replacement = original.replace('"tenantId":"local"', '"tenantId":"other"');
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    writeFileSync(file, original, { mode: 0o600 });

    const readSync = fs.readSync.bind(fs);
    let rewritten = false;
    const readSpy = vi.spyOn(fs, "readSync").mockImplementation((...args) => {
      if (!rewritten) {
        rewritten = true;
        writeFileSync(file, replacement, { mode: 0o600 });
      }
      return Reflect.apply(readSync, fs, args as Parameters<typeof fs.readSync>);
    });
    try {
      expect(() => loadMcpServerAuthorityFromEnv({ MENGSHU_AUTHORITY_FILE: file }))
        .toThrow(/changed while reading/i);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("authority parser rejects symbols and accessors without executing getters", () => {
    const symbolConfig = { ...authorityConfig } as Record<PropertyKey, unknown>;
    symbolConfig[Symbol("unexpected")] = true;
    expect(() => parseMcpServerAuthorityConfig(symbolConfig)).toThrow(/invalid/i);

    let reads = 0;
    const getterConfig = {
      get authority() {
        reads += 1;
        return authorityConfig.authority;
      },
      defaultScope: authorityConfig.defaultScope,
    };
    expect(() => parseMcpServerAuthorityConfig(getterConfig)).toThrow(/invalid/i);
    expect(reads).toBe(0);
  });

  test("authority parser returns a detached deeply-frozen snapshot", () => {
    const mutable = JSON.parse(JSON.stringify(authorityConfig)) as {
      authority: {
        tenantId: string;
        userId: string;
        allow: {
          appIds: string[];
          projectIds: string[];
          agentIds: string[];
          namespaces: string[];
          visibilities: Array<"private" | "workspace" | "team" | "public">;
        };
      };
      defaultScope: typeof authorityConfig.defaultScope;
    };
    const parsed = parseMcpServerAuthorityConfig(mutable);

    mutable.authority.allow.namespaces[0] = "attacker";
    mutable.defaultScope.namespace = "attacker";

    expect(parsed.authority.allow.namespaces).toEqual(["memories"]);
    expect(parsed.defaultScope.namespace).toBe("memories");
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.authority)).toBe(true);
    expect(Object.isFrozen(parsed.authority.allow.namespaces)).toBe(true);
  });
});
