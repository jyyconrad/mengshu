import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import { createCliServeRuntimeHost, requiresServerAuthority, runMengshuCli } from "./ms.js";

let cliHome: string | undefined;

afterEach(() => {
  if (cliHome) rmSync(cliHome, { recursive: true, force: true });
  cliHome = undefined;
  delete process.env.MENGSHU_HOME;
  delete process.env.MENGSHU_AUTHORITY_JSON;
  delete process.env.MENGSHU_AUTHORITY_FILE;
});

function setupCliHome(config: unknown): void {
  cliHome = mkdtempSync(join(tmpdir(), "mengshu-serve-authority-"));
  process.env.MENGSHU_HOME = cliHome;
  writeFileSync(join(cliHome, "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}

function configureServerAuthority(): void {
  process.env.MENGSHU_AUTHORITY_JSON = JSON.stringify({
    authority: {
      tenantId: "tenant-cli",
      userId: "user-cli",
      allow: {
        appIds: ["mengshu"],
        projectIds: ["project-cli"],
        agentIds: ["agent-cli"],
        namespaces: ["working-context"],
        visibilities: ["private"],
      },
    },
    defaultScope: {
      tenantId: "tenant-cli",
      appId: "mengshu",
      userId: "user-cli",
      projectId: "project-cli",
      agentId: "agent-cli",
      namespace: "working-context",
      visibility: "private",
    },
  });
}

function validLanceConfig() {
  return {
    embedding: {
      apiKey: "test-key",
      baseURL: "http://127.0.0.1:9/v1",
      model: "text-embedding-3-small",
    },
    dbType: "lancedb",
    dbPath: join(cliHome!, "lancedb"),
    server: { host: "127.0.0.1", port: 9 },
  };
}

describe("ms serve RuntimeHost composition", () => {
  test("Postgres runtime 未公开 durable job v2 capability 时 fail-closed，不读取 legacy jobs", () => {
    let legacyJobsRead = false;
    const source = {
      config: { dbType: "postgres" },
      lifecycle: { snapshot: () => ({ state: "ready", ready: true }) },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      get ingestionStore() {
        legacyJobsRead = true;
        throw new Error("legacy jobs must not be read");
      },
    };

    expect(() => createCliServeRuntimeHost(source)).toThrow(/durable job v2 serve capability/i);

    expect(legacyJobsRead).toBe(false);
    expect(source.start).not.toHaveBeenCalled();
  });

  test("非 Postgres serve 在 runtime/listener 启动前明确拒绝", () => {
    const source = {
      config: { dbType: "lancedb" },
      lifecycle: { snapshot: () => ({ state: "created", ready: false }) },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };

    expect(() => createCliServeRuntimeHost(source)).toThrow(/durable job v2 serve capability/i);
    expect(source.start).not.toHaveBeenCalled();
  });

  test.each(["serve", "status", "health", "migrate"])(
    "%s 缺 server authority 时在 config/runtime/DB/listener 副作用前拒绝",
    async (command) => {
      setupCliHome("invalid-config-must-not-be-read");

      await expect(runMengshuCli(["node", "ms", command])).rejects.toThrow(/authority.*requires/i);
    },
  );

  test("普通短命令不被 server authority 前置条件误伤", async () => {
    expect(requiresServerAuthority(["node", "ms", "stats"])).toBe(false);
    setupCliHome("invalid-short-command-config");

    await expect(runMengshuCli(["node", "ms", "stats"]))
      .rejects.not.toThrow(/authority/i);
  });

  test("真实 standalone serve 装配携带 authority 并到达 RuntimeHost factory", async () => {
    setupCliHome({});
    writeFileSync(join(cliHome!, "config.json"), JSON.stringify(validLanceConfig()));
    configureServerAuthority();

    await expect(runMengshuCli(["node", "ms", "serve"]))
      .rejects.toThrow(/durable job v2 serve capability/i);
  });

  test("真实 standalone status/health 在通用 server authority 下进入 action，非 Postgres migrate 明确拒绝", async () => {
    setupCliHome({});
    writeFileSync(join(cliHome!, "config.json"), JSON.stringify(validLanceConfig()));
    configureServerAuthority();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runMengshuCli(["node", "ms", "status"]))
        .rejects.toThrow(/server is not reachable/i);
      await expect(runMengshuCli(["node", "ms", "health"])).resolves.toBeUndefined();
      await expect(runMengshuCli(["node", "ms", "migrate"]))
        .rejects.toThrow(/supported only for PostgreSQL/i);

      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Server reachable: false");
      expect(output).toContain('"ok": true');
      expect(output).not.toContain('"contractApplied"');
    } finally {
      log.mockRestore();
    }
  });
});
