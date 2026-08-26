import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import type { MemoryService } from "../../core/service-types.js";
import { createMcpStdioServer } from "../../packages/mcp/src/stdio-server.js";
import { createExactMcpAuthority } from "../../packages/mcp/src/authority.js";

const rootDir = process.cwd();
const codexPluginDir = join(rootDir, "plugins/codex");
const codexPluginVersion = (
  JSON.parse(readFileSync(join(codexPluginDir, ".codex-plugin/plugin.json"), "utf8")) as {
    version: string;
  }
).version;
const children: ChildProcessWithoutNullStreams[] = [];
const mcpScope = {
  tenantId: "smoke-tenant",
  appId: "mengshu",
  userId: "smoke-user",
  projectId: "smoke-project",
  agentId: "codex",
  namespace: "working-context",
  visibility: "private" as const,
};
const authorityConfig = {
  authority: createExactMcpAuthority(mcpScope),
  defaultScope: mcpScope,
};

function makeMsShim(dir: string): void {
  const shim = join(dir, "ms");
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      `exec "${join(rootDir, "node_modules/.bin/tsx")}" "${join(rootDir, "bin/ms.ts")}" "$@"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
}

function makeVersionedMsShim(
  dir: string,
  options: {
    readonly versionOutput?: string;
    readonly versionExitCode?: number;
  } = {},
): string {
  const shim = join(dir, "ms");
  const versionOutput = options.versionOutput ?? codexPluginVersion;
  const versionExitCode = options.versionExitCode ?? 0;
  writeFileSync(
    shim,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then",
      `  printf '%s\\n' ${JSON.stringify(versionOutput)}`,
      `  exit ${versionExitCode}`,
      "fi",
      "if [ \"$1\" = \"mcp\" ]; then",
      "  if [ -n \"$MENGSHU_TEST_MCP_MARKER\" ]; then : > \"$MENGSHU_TEST_MCP_MARKER\"; fi",
      "  exit 0",
      "fi",
      "exit 64",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return shim;
}

async function runCodexWrapper(
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(process.execPath, ["mcp/server.mjs"], {
    cwd: codexPluginDir,
    env: {
      ...process.env,
      MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
      MENGSHU_AUTHORITY_FILE: "",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

function readJsonResponse(child: ChildProcessWithoutNullStreams, id: number): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for MCP response ${id}. stderr: ${stderr}`));
    }, 10_000);

    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }
        try {
          const message = JSON.parse(line) as { id?: number };
          if (message.id === id) {
            cleanup();
            resolve(message as unknown as Record<string, unknown>);
            return;
          }
        } catch {
          // Wait for a complete JSON line.
        }
      }
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`MCP child exited before response ${id} with code ${code}. stderr: ${stderr}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

function send(child: ChildProcessWithoutNullStreams, message: Record<string, unknown>): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

afterEach(() => {
  for (const child of children.splice(0)) {
    child.kill("SIGTERM");
  }
});

describe("Codex MCP plugin smoke", () => {
  test("Codex manifest resolves the global Mengshu home and 0600 authority file from HOME", () => {
    const manifest = JSON.parse(
      readFileSync(join(rootDir, "plugins/codex/.mcp.json"), "utf8"),
    ) as { mcpServers?: { mengshu?: { env?: Record<string, string> } } };
    expect(manifest.mcpServers?.mengshu?.env).toMatchObject({
      MENGSHU_HOME: "${HOME}/.mengshu",
      MENGSHU_AUTHORITY_FILE: "${HOME}/.mengshu/authority.json",
    });
  });

  test("runtime preflight executes mcp only after an explicit runtime matches the plugin version", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-version-match-"));
    try {
      const binDir = join(temp, "bin");
      const marker = join(temp, "mcp-started");
      mkdirSync(binDir, { recursive: true });
      makeVersionedMsShim(binDir);

      const result = await runCodexWrapper({
        PATH: binDir,
        MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        MENGSHU_TEST_MCP_MARKER: marker,
      });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("runtime preflight does not consult PATH when an absolute runtime override is provided", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-no-path-"));
    try {
      const executable = makeVersionedMsShim(temp);
      const result = await runCodexWrapper({ PATH: "", MENGSHU_CODEX_MS_PATH: executable });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("runtime preflight rejects an old selected ms without executing mcp", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-version-old-"));
    try {
      const binDir = join(temp, "bin");
      const marker = join(temp, "mcp-started");
      mkdirSync(binDir, { recursive: true });
      makeVersionedMsShim(binDir, { versionOutput: "1.0.6" });

      const result = await runCodexWrapper({
        PATH: binDir,
        MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        MENGSHU_TEST_MCP_MARKER: marker,
      });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/version mismatch/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("runtime preflight ignores PATH ordering and uses only the explicit runtime override", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-version-order-"));
    try {
      const oldBinDir = join(temp, "old-bin");
      const newBinDir = join(temp, "new-bin");
      const marker = join(temp, "mcp-started");
      mkdirSync(oldBinDir, { recursive: true });
      mkdirSync(newBinDir, { recursive: true });
      makeVersionedMsShim(oldBinDir, { versionOutput: "1.0.6" });
      makeVersionedMsShim(newBinDir);

      const result = await runCodexWrapper({
        PATH: oldBinDir,
        MENGSHU_CODEX_MS_PATH: join(newBinDir, "ms"),
        MENGSHU_TEST_MCP_MARKER: marker,
      });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "unparseable output", versionOutput: "mengshu development build", versionExitCode: 0 },
    { name: "failed process", versionOutput: codexPluginVersion, versionExitCode: 23 },
  ])("runtime preflight rejects $name without executing mcp", async ({ versionOutput, versionExitCode }) => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-version-invalid-"));
    try {
      const binDir = join(temp, "bin");
      const marker = join(temp, "mcp-started");
      mkdirSync(binDir, { recursive: true });
      makeVersionedMsShim(binDir, { versionOutput, versionExitCode });

      const result = await runCodexWrapper({
        PATH: binDir,
        MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        MENGSHU_TEST_MCP_MARKER: marker,
      });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toMatch(/runtime preflight/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test.each([
    { name: "relative", value: "./ms" },
    { name: "missing", value: "/definitely/missing/mengshu-ms" },
  ])("runtime preflight rejects $name explicit runtime paths", async ({ value }) => {
    const result = await runCodexWrapper({
      PATH: process.env.PATH ?? "",
      MENGSHU_CODEX_MS_PATH: value,
    });

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/runtime preflight/i);
  });

  test("runtime preflight accepts a matching executable absolute override with an empty PATH", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-version-override-"));
    try {
      const binDir = join(temp, "bin");
      const marker = join(temp, "mcp-started");
      mkdirSync(binDir, { recursive: true });
      const executable = makeVersionedMsShim(binDir);

      const result = await runCodexWrapper({
        PATH: "",
        MENGSHU_CODEX_MS_PATH: executable,
        MENGSHU_TEST_MCP_MARKER: marker,
      });

      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      expect(existsSync(marker)).toBe(true);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("starts through plugins/codex/mcp/server.mjs and lists mengshu tools", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-mcp-"));
    try {
      const binDir = join(temp, "bin");
      const homeDir = join(temp, "home");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      makeMsShim(binDir);
      writeFileSync(
        join(homeDir, "config.json"),
        JSON.stringify({
          embedding: {
            apiKey: "test-key",
            baseURL: "http://127.0.0.1:9/v1",
            model: "text-embedding-3-small",
          },
          dbType: "lancedb",
          dbPath: join(temp, "lancedb"),
        }),
      );

      const child = spawn("node", ["mcp/server.mjs"], {
        cwd: join(rootDir, "plugins/codex"),
        env: {
          ...process.env,
          MENGSHU_HOME: homeDir,
          MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
          MENGSHU_AUTHORITY_FILE: "",
          PATH: process.env.PATH ?? "",
          MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);

      send(child, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "codex-plugin-smoke", version: "1.0.0" },
        },
      });
      const initialized = await readJsonResponse(child, 1);
      expect(initialized.result).toBeDefined();

      send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      const listed = await readJsonResponse(child, 2);
      const result = listed.result as { tools?: Array<{ name: string }> };
      const toolNames = result.tools?.map((tool) => tool.name) ?? [];

      expect(toolNames).toContain("memory_recall");
      expect(toolNames).toContain("memory_save");
      expect(toolNames).toContain("memory_health");
      expect(toolNames).not.toContain("memory_forget");

      const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
      child.stdin.end();
      await expect(Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("MCP wrapper did not exit after stdin EOF")),
          5_000,
        )),
      ])).resolves.toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 15_000);

  test("missing authority rejects before config/runtime and does not echo raw config", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-mcp-no-auth-"));
    try {
      const binDir = join(temp, "bin");
      const homeDir = join(temp, "home");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(homeDir, { recursive: true });
      makeMsShim(binDir);
      writeFileSync(join(homeDir, "config.json"), "raw-secret-invalid-config");
      const child = spawn("node", ["mcp/server.mjs"], {
        cwd: join(rootDir, "plugins/codex"),
        env: {
          ...process.env,
          MENGSHU_HOME: homeDir,
          MENGSHU_AUTHORITY_JSON: "",
          MENGSHU_AUTHORITY_FILE: "",
          PATH: process.env.PATH ?? "",
          MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.on("exit", (code) => resolve({ code, stderr }));
      });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/authority configuration.*requires/i);
      expect(result.stderr).not.toContain("raw-secret-invalid-config");
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("unresolved authority placeholders fail before spawning ms", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-placeholder-"));
    try {
      const binDir = join(temp, "bin");
      const marker = join(temp, "spawned");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "ms"),
        "#!/bin/sh\ntouch \"$MENGSHU_TEST_SPAWN_MARKER\"\n",
        { mode: 0o755 },
      );
      const child = spawn("node", ["mcp/server.mjs"], {
        cwd: join(rootDir, "plugins/codex"),
        env: {
          ...process.env,
          MENGSHU_AUTHORITY_JSON: "",
          MENGSHU_AUTHORITY_FILE: "\${MENGSHU_AUTHORITY_FILE}",
          MENGSHU_TEST_SPAWN_MARKER: marker,
          PATH: process.env.PATH ?? "",
          MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(child);
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        child.once("exit", (code) => resolve({ code, stderr }));
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/authority configuration/i);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("structural fake forget capability cannot expose memory_forget", () => {
    const service = {
      async storeMemory() { return { id: "mem-1", stored: true }; },
      async recall() { return { scope: mcpScope, query: "", hits: [] }; },
      async buildContext() { return { scope: mcpScope, content: "", hits: [] }; },
      async delete() { return { deleted: 0 }; },
      async health() { return { ok: true }; },
    } satisfies MemoryService;
    const forgetService = {
      async forget() {
        return {
          action: "delete" as const,
          affected: 0,
          deleted: 0,
          affectedIds: [],
          transactional: true as const,
          idempotentReplay: false,
        };
      },
    };
    const { tools } = createMcpStdioServer({
      service,
      forgetCapability: forgetService as never,
      authority: authorityConfig.authority,
      defaultScope: authorityConfig.defaultScope,
    });
    expect(tools.map((tool) => tool.name)).not.toContain("memory_forget");
  });

  test("wrapper forwards SIGTERM and waits for its child to exit", async () => {
    const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-signal-"));
    try {
      const binDir = join(temp, "bin");
      const pidFile = join(temp, "child.pid");
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        join(binDir, "ms"),
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `if (process.argv[2] === '--version') { console.log(${JSON.stringify(codexPluginVersion)}); process.exit(0); }`,
          "if (process.argv[2] !== 'mcp') process.exit(64);",
          "fs.writeFileSync(process.env.MENGSHU_TEST_CHILD_PID_FILE, String(process.pid));",
          "const timer = setInterval(() => {}, 1000);",
          "process.on('SIGTERM', () => { process.exitCode = 0; clearInterval(timer); });",
          "process.on('SIGINT', () => { process.exitCode = 0; clearInterval(timer); });",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );
      const wrapper = spawn("node", ["mcp/server.mjs"], {
        cwd: join(rootDir, "plugins/codex"),
        env: {
          ...process.env,
          MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
          MENGSHU_AUTHORITY_FILE: "",
          MENGSHU_TEST_CHILD_PID_FILE: pidFile,
          PATH: process.env.PATH ?? "",
          MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      children.push(wrapper);
      const deadline = Date.now() + 10_000;
      while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
        if (Date.now() >= deadline) throw new Error("wrapper child pid was not written");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const childPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      const exited = new Promise<number | null>((resolve) => wrapper.once("exit", resolve));

      wrapper.kill("SIGTERM");
      await expect(Promise.race([
        exited,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error("wrapper did not stop its child")),
          5_000,
        )),
      ])).resolves.toBe(143);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")(
    "wrapper SIGTERM terminates the real POSIX child process group including grandchildren",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-process-group-"));
      let childPid: number | undefined;
      let grandchildPid: number | undefined;
      try {
        const binDir = join(temp, "bin");
        const pidFile = join(temp, "processes.json");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
          join(binDir, "ms"),
          [
            "#!/usr/bin/env node",
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            `if (process.argv[2] === '--version') { console.log(${JSON.stringify(codexPluginVersion)}); process.exit(0); }`,
            "if (process.argv[2] !== 'mcp') process.exit(64);",
            "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "fs.writeFileSync(process.env.MENGSHU_TEST_PROCESS_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));",
            "const timer = setInterval(() => {}, 1000);",
            "process.on('SIGTERM', () => { clearInterval(timer); });",
            "process.on('SIGINT', () => { clearInterval(timer); });",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const wrapper = spawn("node", ["mcp/server.mjs"], {
          cwd: join(rootDir, "plugins/codex"),
          env: {
            ...process.env,
            MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
            MENGSHU_AUTHORITY_FILE: "",
            MENGSHU_TEST_PROCESS_FILE: pidFile,
            PATH: process.env.PATH ?? "",
            MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(wrapper);
        let stderr = "";
        wrapper.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
          if (Date.now() >= deadline) throw new Error("wrapper process group pids were not written");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { child: number; grandchild: number };
        childPid = pids.child;
        grandchildPid = pids.grandchild;
        const exited = new Promise<{ code: number | null; stderr: string }>((resolve) =>
          wrapper.once("exit", (code) => resolve({ code, stderr })),
        );

        wrapper.kill("SIGTERM");
        await expect(Promise.race([
          exited,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error("wrapper did not stop its process group")),
            7_000,
          )),
        ])).resolves.toEqual({ code: 143, stderr: "" });

        expect(() => process.kill(childPid!, 0)).toThrow();
        expect(() => process.kill(grandchildPid!, 0)).toThrow();
      } finally {
        for (const pid of [grandchildPid, childPid]) {
          if (!pid) continue;
          try { process.kill(pid, "SIGKILL"); } catch { /* already stopped */ }
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
    15_000,
  );

  test.skipIf(process.platform === "win32")(
    "wrapper stdin EOF cleans grandchildren left after the direct child exits normally",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "mengshu-codex-eof-group-"));
      let grandchildPid: number | undefined;
      try {
        const binDir = join(temp, "bin");
        const pidFile = join(temp, "grandchild.pid");
        mkdirSync(binDir, { recursive: true });
        writeFileSync(
          join(binDir, "ms"),
          [
            "#!/usr/bin/env node",
            "const { spawn } = require('node:child_process');",
            "const fs = require('node:fs');",
            `if (process.argv[2] === '--version') { console.log(${JSON.stringify(codexPluginVersion)}); process.exit(0); }`,
            "if (process.argv[2] !== 'mcp') process.exit(64);",
            "const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
            "fs.writeFileSync(process.env.MENGSHU_TEST_GRANDCHILD_FILE, String(grandchild.pid));",
            "process.stdin.resume();",
            "process.stdin.once('end', () => process.exit(0));",
            "",
          ].join("\n"),
          { mode: 0o755 },
        );
        const wrapper = spawn("node", ["mcp/server.mjs"], {
          cwd: join(rootDir, "plugins/codex"),
          env: {
            ...process.env,
            MENGSHU_AUTHORITY_JSON: JSON.stringify(authorityConfig),
            MENGSHU_AUTHORITY_FILE: "",
            MENGSHU_TEST_GRANDCHILD_FILE: pidFile,
            PATH: process.env.PATH ?? "",
            MENGSHU_CODEX_MS_PATH: join(binDir, "ms"),
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        children.push(wrapper);
        let stderr = "";
        wrapper.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
        const deadline = Date.now() + 10_000;
        while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
          if (Date.now() >= deadline) throw new Error("EOF grandchild pid was not written");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        grandchildPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        const exited = new Promise<{ code: number | null; stderr: string }>((resolve) =>
          wrapper.once("exit", (code) => resolve({ code, stderr })),
        );

        wrapper.stdin.end();
        await expect(Promise.race([
          exited,
          new Promise<never>((_, reject) => setTimeout(
            () => reject(new Error("wrapper did not finish EOF process-group cleanup")),
            7_000,
          )),
        ])).resolves.toEqual({ code: 0, stderr: "" });
        expect(() => process.kill(grandchildPid!, 0)).toThrow();
      } finally {
        if (grandchildPid) {
          try { process.kill(grandchildPid, "SIGKILL"); } catch { /* already stopped */ }
        }
        rmSync(temp, { recursive: true, force: true });
      }
    },
    15_000,
  );
});
