import { describe, expect, test } from "vitest";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveMcpRuntimeMode,
  resolveMcpRuntimeSocketPath,
  resolveMcpRuntimeUrl,
} from "./mengshu-mcp.js";

describe("Mengshu MCP RuntimeClient target", () => {
  test.each([
    [{}, "proxy"],
    [{ MENGSHU_MCP_MODE: "proxy" }, "proxy"],
    [{ MENGSHU_MCP_MODE: "standalone" }, "standalone"],
    [{ MENGSHU_MCP_DIRECT_DIAGNOSTIC: "1" }, "standalone"],
  ])("resolves the explicit MCP runtime mode", (env, expected) => {
    expect(resolveMcpRuntimeMode(env)).toBe(expected);
  });

  test.each(["direct", "embedded", "invalid"])(
    "rejects unsupported MCP runtime mode %s",
    (mode) => {
      expect(() => resolveMcpRuntimeMode({ MENGSHU_MCP_MODE: mode }))
        .toThrow(/MENGSHU_MCP_MODE/);
    },
  );

  test("rejects conflicting explicit and legacy modes", () => {
    expect(() => resolveMcpRuntimeMode({
      MENGSHU_MCP_MODE: "proxy",
      MENGSHU_MCP_DIRECT_DIAGNOSTIC: "1",
    })).toThrow(/conflicts/);
  });

  test.each([
    [{}, undefined, "http://127.0.0.1:3847/"],
    [{ server: { host: "0.0.0.0", port: 4000 } }, undefined, "http://127.0.0.1:4000/"],
    [{ server: { host: "::", port: 4001 } }, undefined, "http://[::1]:4001/"],
    [{}, "http://localhost:5000", "http://localhost:5000/"],
  ])("normalizes local daemon targets", (config, explicit, expected) => {
    expect(resolveMcpRuntimeUrl(config, explicit)).toBe(expected);
  });

  test.each([
    "https://example.com:3847",
    "http://10.0.0.5:3847",
    "http://user:secret@127.0.0.1:3847",
    "file:///tmp/mengshu.sock",
  ])("rejects non-loopback or credential-bearing targets", (value) => {
    expect(() => resolveMcpRuntimeUrl({}, value)).toThrow(/loopback/i);
  });

  test("accepts only the canonical runtime run directory for explicit sockets", () => {
    const home = mkdtempSync(join(tmpdir(), "mengshu-mcp-home-"));
    try {
      expect(resolveMcpRuntimeSocketPath(home, join(home, "run", "custom.sock")))
        .toBe(join(home, "run", "custom.sock"));
      expect(() => resolveMcpRuntimeSocketPath(home, join(home, "other.sock")))
        .toThrow(/MENGSHU_HOME\/run/i);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
