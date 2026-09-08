import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createCliMcpStdioServerOptions,
  createCliServeRuntimeHost,
  registerMemoryAssetCliCommands,
  registerMemoryLoadoutCliCommands,
  registerMemorySessionCliCommands,
  requiresServerAuthority,
  resolveRuntimeMemoryWriteCapability,
  semanticTypeBackfillOperatorArgv,
  historyRebuildOperatorArgv,
  dispatchHistoryRebuildOperator,
  dispatchHistoryRebuildAndDrainTrees,
  dispatchHistoryTreeWorkerOperator,
  historyTreeWorkerOperatorArgv,
  markdownWorksetOperatorArgv,
  topicTreeMigrationOperatorArgv,
  runMengshuCli,
} from "./ms.js";
import { Command } from "commander";
import { CURRENT_SCHEMA_VERSION } from "../../../core/src/db/migrations/schema-migrations.js";
import { RuntimeClient } from "../runtime-client.js";
import { DatabaseFactory } from "../../../core/src/db/factory.js";

let cliHome: string | undefined;

afterEach(() => {
  if (cliHome) rmSync(cliHome, { recursive: true, force: true });
  cliHome = undefined;
  delete process.env.MENGSHU_HOME;
  delete process.env.MENGSHU_CONFIG;
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
  test("ms evolve proxies to the existing host before constructing any database/runtime owner", async () => {
    setupCliHome({});
    writeFileSync(join(cliHome!, "config.json"), JSON.stringify({ ...validLanceConfig(), features: { continuousMemoryEvolution: true } }));
    const invoke = vi.spyOn(RuntimeClient.prototype, "invoke").mockResolvedValue({ batchId: "batch", status: "queued" });
    const createProvider = vi.spyOn(DatabaseFactory, "createProvider");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "evolve", "inventory", "--propose", "--idempotency-key", "one"]);
      expect(createProvider).not.toHaveBeenCalled();
      expect(invoke).toHaveBeenCalledWith({ method: "POST", path: "/v1/evolution/run", body: {
        input: { mode: "inventory", selection: "baseline" }, action: "propose", idempotencyKey: "one",
      } });
      expect(existsSync(join(cliHome!, "evolution"))).toBe(false);
    } finally { invoke.mockRestore(); createProvider.mockRestore(); log.mockRestore(); }
  });
  test("asset explain/revoke 使用 exact scope，并把状态变更交给治理 service", async () => {
    const scope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };
    const list = vi.fn(async () => []);
    const read = vi.fn(async () => ({
      asset: { id: "asset-1" }, contentValidity: "stale" as const,
      staleReasons: ["memory_not_active:memory-1"],
      explanation: { assetId: "asset-1", version: 2, evidenceIds: ["evidence-1"] },
    }));
    const changeStatus = vi.fn(async (input) => ({ asset: { id: input.assetId }, replayed: false }));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const explainProgram = new Command().exitOverride();
      registerMemoryAssetCliCommands(explainProgram, {
        capability: { list, read, changeStatus } as never,
        scope,
      });
      await explainProgram.parseAsync(["node", "ms", "asset", "explain", "asset-1"]);
      expect(read).toHaveBeenCalledWith(scope, "asset-1");
      expect(log.mock.calls.map((call) => String(call[0])).join("\n"))
        .toContain('"contentValidity": "stale"');

      const revokeProgram = new Command().exitOverride();
      registerMemoryAssetCliCommands(revokeProgram, {
        capability: { list, read, changeStatus } as never,
        scope,
      });
      await revokeProgram.parseAsync([
        "node", "ms", "asset", "revoke", "asset-1",
        "--expected-version", "2", "--idempotency-key", "revoke-request-1",
      ]);
      expect(changeStatus).toHaveBeenCalledWith({
        scope, assetId: "asset-1", expectedLatestVersion: 2,
        targetStatus: "revoked", idempotencyKey: "revoke-request-1",
      });
    } finally {
      log.mockRestore();
    }
  });

  test("asset 状态命令在 capability 缺失或 CAS 版本非法时 fail-closed", async () => {
    const scope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };
    const unavailable = new Command().exitOverride();
    registerMemoryAssetCliCommands(unavailable, { scope });
    await expect(unavailable.parseAsync(["node", "ms", "asset", "list"]))
      .rejects.toThrow(/PostgreSQL v20 overlay/i);

    const invalid = new Command().exitOverride();
    const changeStatus = vi.fn();
    registerMemoryAssetCliCommands(invalid, {
      scope,
      capability: { list: vi.fn(), read: vi.fn(), changeStatus } as never,
    });
    await expect(invalid.parseAsync([
      "node", "ms", "asset", "deprecate", "asset-1",
      "--expected-version", "0", "--idempotency-key", "deprecate-1",
    ])).rejects.toThrow(/positive integer/i);
    expect(changeStatus).not.toHaveBeenCalled();
  });

  test("loadout unbind/pause 使用 exact scope、CAS 和幂等键追加版本", async () => {
    const scope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };
    const unbind = vi.fn(async () => ({ loadout: { version: 2 }, replayed: false }));
    const pause = vi.fn(async () => ({ loadout: { version: 3 }, replayed: false }));
    const capability = {
      resolveCurrent: vi.fn(), getLatest: vi.fn(), unbind, pause,
    } as never;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const unbindProgram = new Command().exitOverride();
      registerMemoryLoadoutCliCommands(unbindProgram, { capability, scope });
      await unbindProgram.parseAsync([
        "node", "ms", "loadout", "unbind", "loadout-1", "asset-1",
        "--slot", "rules", "--expected-version", "1",
        "--idempotency-key", "unbind-request-1",
      ]);
      expect(unbind).toHaveBeenCalledWith({
        scope, loadoutId: "loadout-1", assetId: "asset-1", slot: "rules",
        expectedLatestVersion: 1, idempotencyKey: "unbind-request-1",
      });

      const pauseProgram = new Command().exitOverride();
      registerMemoryLoadoutCliCommands(pauseProgram, { capability, scope });
      await pauseProgram.parseAsync([
        "node", "ms", "loadout", "pause", "loadout-1",
        "--expected-version", "2", "--idempotency-key", "pause-request-1",
      ]);
      expect(pause).toHaveBeenCalledWith({
        scope, loadoutId: "loadout-1", expectedLatestVersion: 2,
        idempotencyKey: "pause-request-1",
      });
    } finally {
      log.mockRestore();
    }
  });

  test("session explain 从持久化 repository 读取 exact private session receipt", async () => {
    const scope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };
    const receipt = { id: "receipt-1", sessionId: "session-1", bindings: [] };
    const getLatest = vi.fn(async () => receipt);
    const program = new Command().exitOverride();
    registerMemorySessionCliCommands(program, {
      capability: { getLatest } as never,
      scope,
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "ms", "session", "explain", "session-1"]);
      expect(getLatest).toHaveBeenCalledWith(
        { ...scope, sessionId: "session-1" },
        "session-1",
      );
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(receipt);
    } finally {
      log.mockRestore();
    }
  });

  test("session explain 缺 capability、非 private scope 或 receipt 不存在时稳定失败", async () => {
    const scope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };
    const unavailable = new Command().exitOverride();
    registerMemorySessionCliCommands(unavailable, { scope });
    await expect(unavailable.parseAsync([
      "node", "ms", "session", "explain", "session-1",
    ])).rejects.toThrow(/session receipt capability is unavailable/i);

    const missing = new Command().exitOverride();
    registerMemorySessionCliCommands(missing, {
      scope,
      capability: { getLatest: vi.fn(async () => undefined) } as never,
    });
    await expect(missing.parseAsync([
      "node", "ms", "session", "explain", "session-1",
    ])).rejects.toThrow("Context assembly receipt not found");

    const nonPrivate = new Command().exitOverride();
    const getLatest = vi.fn();
    registerMemorySessionCliCommands(nonPrivate, {
      scope: { ...scope, visibility: "workspace" },
      capability: { getLatest } as never,
    });
    await expect(nonPrivate.parseAsync([
      "node", "ms", "session", "explain", "session-1",
    ])).rejects.toThrow(/private scope/i);
    expect(getLatest).not.toHaveBeenCalled();

    const invalid = new Command().exitOverride();
    const invalidGetLatest = vi.fn();
    registerMemorySessionCliCommands(invalid, {
      scope,
      capability: { getLatest: invalidGetLatest } as never,
    });
    await expect(invalid.parseAsync([
      "node", "ms", "session", "explain", "x".repeat(257),
    ])).rejects.toThrow(/valid sessionId/i);
    expect(invalidGetLatest).not.toHaveBeenCalled();
  });

  test("semantic type migration defaults config without changing operator gates", () => {
    expect(semanticTypeBackfillOperatorArgv([
      "node", "ms", "migrate-semantic-types", "--manifest", "/tmp/manifest.json",
    ], "/tmp/config.json")).toEqual([
      "--config", "/tmp/config.json", "--manifest", "/tmp/manifest.json",
    ]);
    expect(semanticTypeBackfillOperatorArgv([
      "node", "ms", "migrate-semantic-types", "--config", "/other/config.json",
      "--manifest", "/tmp/manifest.json", "--apply", "--maintenance",
    ], "/tmp/config.json")).toEqual([
      "--config", "/other/config.json", "--manifest", "/tmp/manifest.json",
      "--apply", "--maintenance",
    ]);
    expect(topicTreeMigrationOperatorArgv([
      "node", "ms", "migrate-topic-tree", "--migration-id", "topic-v1",
    ], "/tmp/config.json")).toEqual([
      "--config", "/tmp/config.json", "--migration-id", "topic-v1",
    ]);
  });

  test("Markdown workset export 默认注入 config，离线 govern 参数保持原样", () => {
    expect(markdownWorksetOperatorArgv([
      "node", "ms", "migrate-markdown-workset", "export",
      "--containment-root", "/tmp/migration", "--output", "/tmp/migration/source",
      "--run-id", "run-01", "--policy-version", "markdown-export/v1",
    ], "/tmp/config.json")).toEqual([
      "export", "--config", "/tmp/config.json",
      "--containment-root", "/tmp/migration", "--output", "/tmp/migration/source",
      "--run-id", "run-01", "--policy-version", "markdown-export/v1",
    ]);
    expect(markdownWorksetOperatorArgv([
      "node", "ms", "migrate-markdown-workset", "govern",
      "--manifest", "/tmp/source/manifest.json",
    ], "/tmp/config.json")).toEqual([
      "govern", "--manifest", "/tmp/source/manifest.json",
    ]);
  });

  test("history rebuild command forwards config, live-model and write gates to its operator", async () => {
    expect(historyRebuildOperatorArgv([
      "node", "ms", "migrate-history", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json", "--plan",
    ], "/tmp/config.json")).toEqual([
      "--config", "/tmp/config.json", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json", "--plan",
    ]);
    const runner = vi.fn(async () => ({ operation: "dry-run", sourceCount: 0 }));
    await expect(dispatchHistoryRebuildOperator([
      "node", "ms", "migrate-history", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json",
    ], "/tmp/config.json", runner)).resolves.toMatchObject({ operation: "dry-run" });
    expect(runner).toHaveBeenCalledWith([
      "--config", "/tmp/config.json", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json",
    ]);
  });

  test("history tree worker command only supplies config and preserves every operator gate", async () => {
    const workerArgs = [
      "node", "ms", "migrate-history-worker",
      "--migration-id", "history-v1",
      "--manifest-sha256", "a".repeat(64),
      "--expected-scopes", "41",
      "--worker-id", "history-tree-worker",
      "--lease-ms", "60000",
      "--heartbeat-ms", "20000",
      "--poll-ms", "100",
      "--timeout-ms", "21600000",
      "--max-jobs", "6100",
      "--maintenance",
      "--quiescence-confirmed",
    ];
    expect(historyTreeWorkerOperatorArgv(workerArgs, "/tmp/config.json")).toEqual([
      "--config", "/tmp/config.json", ...workerArgs.slice(3),
    ]);

    const runner = vi.fn(async () => ({
      historyScopes: 41, workerScopes: 24, targetJobs: 6011, completedJobs: 6011,
    }));
    await expect(dispatchHistoryTreeWorkerOperator(workerArgs, "/tmp/config.json", runner))
      .resolves.toMatchObject({ targetJobs: 6011, completedJobs: 6011 });
    expect(runner).toHaveBeenCalledWith([
      "--config", "/tmp/config.json", ...workerArgs.slice(3),
    ]);
  });

  test("history rebuild drain mode sequences apply, fenced tree worker, and strict verify", async () => {
    const hash = "a".repeat(64);
    const argv = [
      "node", "ms", "migrate-history",
      "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json",
      "--apply", "--live-model", "--drain-trees",
      "--maintenance", "--quiescence-confirmed",
      "--manifest-sha256", hash,
      "--confirmation-token", "APPLY:history-v1",
      "--tree-worker-id", "history-auto-worker",
      "--tree-timeout-ms", "90000",
    ];
    const history = vi.fn()
      .mockResolvedValueOnce({
        operation: "apply", manifestSha256: hash, scopes: 41, treeJobs: 6100,
      })
      .mockResolvedValueOnce({
        operation: "verify", manifestSha256: hash,
        sealedTreeVerification: { historyTreeJobs: 6100, completedTreeJobs: 6100 },
      });
    const worker = vi.fn(async () => ({ targetJobs: 6100, completedJobs: 6100 }));

    await expect(dispatchHistoryRebuildAndDrainTrees(
      argv, "/tmp/config.json", { history, worker },
    )).resolves.toMatchObject({
      operation: "apply-drain-verify",
      apply: { scopes: 41, treeJobs: 6100 },
      worker: { completedJobs: 6100 },
      verify: { operation: "verify" },
    });
    expect(history.mock.calls[0]?.[0]).toEqual([
      "--config", "/tmp/config.json", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json",
      "--apply", "--live-model", "--maintenance", "--quiescence-confirmed",
      "--manifest-sha256", hash, "--confirmation-token", "APPLY:history-v1",
    ]);
    expect(worker).toHaveBeenCalledWith([
      "--config", "/tmp/config.json",
      "--migration-id", "history-v1", "--manifest-sha256", hash,
      "--expected-scopes", "41", "--worker-id", "history-auto-worker",
      "--lease-ms", "60000", "--heartbeat-ms", "20000", "--poll-ms", "100",
      "--stall-timeout-ms", "60000", "--concurrency", "4",
      "--timeout-ms", "90000", "--max-jobs", "6100",
      "--maintenance", "--quiescence-confirmed",
    ]);
    expect(history.mock.calls[1]?.[0]).toEqual([
      "--config", "/tmp/config.json", "--manifest", "/tmp/history.json",
      "--tree-policy-bundle", "/tmp/tree-policy.json", "--verify",
    ]);
  });

  test("history rebuild drain mode accepts a zero-tree cohort and proceeds directly to strict verify", async () => {
    const hash = "b".repeat(64);
    const argv = [
      "node", "ms", "migrate-history",
      "--manifest", "/tmp/history-empty.json",
      "--tree-policy-bundle", "/tmp/tree-policy-empty.json",
      "--apply", "--live-model", "--drain-trees",
      "--maintenance", "--quiescence-confirmed",
      "--manifest-sha256", hash,
      "--confirmation-token", "APPLY:history-empty",
    ];
    const history = vi.fn()
      .mockResolvedValueOnce({
        operation: "apply", manifestSha256: hash, scopes: 2, treeJobs: 0,
      })
      .mockResolvedValueOnce({
        operation: "verify", manifestSha256: hash,
        sealedTreeVerification: { historyTreeJobs: 0, completedTreeJobs: 0 },
      });
    const worker = vi.fn();

    await expect(dispatchHistoryRebuildAndDrainTrees(
      argv, "/tmp/config.json", { history, worker },
    )).resolves.toMatchObject({
      operation: "apply-drain-verify",
      apply: { treeJobs: 0 },
      worker: { skipped: true, targetJobs: 0, completedJobs: 0 },
      verify: { operation: "verify" },
    });
    expect(worker).not.toHaveBeenCalled();
    expect(history).toHaveBeenCalledTimes(2);
  });

  test("history rebuild drain mode rejects non-apply or missing write gates before any runner", async () => {
    const history = vi.fn();
    const worker = vi.fn();
    await expect(dispatchHistoryRebuildAndDrainTrees([
      "node", "ms", "migrate-history", "--manifest", "/tmp/history.json",
      "--plan", "--drain-trees",
    ], "/tmp/config.json", { history, worker })).rejects.toThrow(/apply.*gate|drain/i);
    expect(history).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  test("history rebuild configless help exposes prepare and pinned write gates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "migrate-history", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("--prepare-manifest <path>");
      expect(output).toContain("--generate-tree-policy <path>");
      expect(output).toContain("--audit-report <path>");
      expect(output).toContain("--migration-id <id>");
      expect(output).toContain("--max-records <count>");
      expect(output).toContain("--max-model-calls <count>");
      expect(output).toContain("--max-input-tokens <count>");
      expect(output).toContain("--max-output-tokens <count>");
      expect(output).toContain("--max-cost-minor-units <count>");
      expect(output).toContain("--currency <code>");
      expect(output).toContain("--pricing-snapshot-version <version>");
      expect(output).toContain("--input-cost-per-million-tokens <count>");
      expect(output).toContain("--output-cost-per-million-tokens <count>");
      expect(output).toContain("--remote-egress <mode>");
      expect(output).toContain("--tree-policy-version <version>");
      expect(output).toContain("--topic-label-version <version>");
      expect(output).toContain("--tree-policy-bundle <path>");
      expect(output).toContain("--tree-policy-bundle-sha256 <sha256>");
      expect(output.match(/--tree-policy-bundle <path>/g)).toHaveLength(1);
      expect(output.match(/--tree-policy-bundle-sha256 <sha256>/g)).toHaveLength(1);
      expect(output).toContain("--plan");
      expect(output).toContain("--dry-run");
      expect(output).toContain("--verify");
      expect(output).toContain("--apply");
      expect(output).toContain("--rollback");
      expect(output).toContain("--manifest-sha256 <sha256>");
      expect(output).toContain("--quiescence-confirmed");
      expect(output).toContain("--tree-stall-timeout-ms <milliseconds>");
      expect(output).toContain("--tree-concurrency <count>");
    } finally {
      log.mockRestore();
    }
  });

  test("history tree worker configless help exposes all cohort and write gates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "migrate-history-worker", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      for (const option of [
        "--config <path>", "--migration-id <id>", "--manifest-sha256 <sha256>",
        "--expected-scopes <count>", "--worker-id <id>", "--lease-ms <milliseconds>",
        "--heartbeat-ms <milliseconds>", "--poll-ms <milliseconds>",
        "--stall-timeout-ms <milliseconds>", "--timeout-ms <milliseconds>",
        "--max-jobs <count>", "--concurrency <count>", "--maintenance",
        "--quiescence-confirmed",
      ]) {
        expect(output).toContain(option);
      }
    } finally {
      log.mockRestore();
    }
  });

  test("schema migration configless help exposes the current schema cutover gates", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "migrate", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("--to-schema <schema>");
      expect(output).toContain(`(default: "v${CURRENT_SCHEMA_VERSION}")`);
      expect(output).toContain("--apply");
      expect(output).toContain("--maintenance");
      expect(output).toContain("--quiescence-confirmed");
      expect(output).toContain("--confirm <token>");
      expect(output).toContain("--allow-quarantine <count>");
    } finally {
      log.mockRestore();
    }
  });

  test("只把 runtime 已有 executeMemoryWrite 暴露为 production serve capability", async () => {
    const executeMemoryWrite = vi.fn(async () => ({
      status: "persisted" as const,
      route: "active" as const,
      recordType: "memory" as const,
      memoryId: "memory-cli-1",
      stored: true,
    }));

    const capability = resolveRuntimeMemoryWriteCapability({ executeMemoryWrite });

    expect(capability).toEqual({ executeMemoryWrite });
    await capability?.executeMemoryWrite({ type: "saveExplicit" } as never);
    expect(executeMemoryWrite).toHaveBeenCalledWith({ type: "saveExplicit" });
    expect(resolveRuntimeMemoryWriteCapability({ executeMemoryWrite: undefined })).toBeUndefined();
  });

  test("MCP composition 透传同一持久化 session receipt repository", () => {
    const contextAssemblyReceipts = { getLatest: vi.fn() };
    const runtime = {
      memoryService: {},
      executeMemoryWrite: undefined,
      authorityScopedForgetCapability: undefined,
      agentFastPath: undefined,
      memoryViewAssets: undefined,
      contextAssemblyReceipts,
      ingestionPipeline: undefined,
      llmClient: undefined,
    } as never;
    const authority = {
      tenantId: "tenant-cli", userId: "user-cli",
      allow: {
        appIds: ["mengshu"], projectIds: ["project-cli"],
        agentIds: ["agent-cli"], namespaces: ["memories"], visibilities: ["private"],
      },
    } as const;
    const defaultScope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };

    expect(createCliMcpStdioServerOptions(runtime, { authority, defaultScope }).sessionReceipts)
      .toBe(contextAssemblyReceipts);
  });

  test("MCP 默认是 RuntimeHost 的薄适配器，不取得 durable worker ownership", () => {
    const repository = {};
    const runtime = {
      config: { dbType: "postgres" },
      db: {},
      durableJobV2ServeCapability: {
        version: 2,
        authoritative: true,
        repository,
        registry: { authoritative: true, types: [], get: vi.fn() },
        scope: {},
      },
      durableJobV2RuntimeBundle: { repository },
      memoryService: {},
      executeMemoryWrite: undefined,
      authorityScopedForgetCapability: undefined,
      agentFastPath: undefined,
      memoryViewAssets: undefined,
      knowledgeResources: undefined,
      contextAssemblyReceipts: undefined,
      ingestionPipeline: undefined,
      llmClient: undefined,
    } as never;
    const authority = {
      tenantId: "tenant-cli", userId: "user-cli",
      allow: {
        appIds: ["mengshu"], projectIds: ["project-cli"],
        agentIds: ["agent-cli"], namespaces: ["memories"], visibilities: ["private"],
      },
    } as const;
    const defaultScope = {
      tenantId: "tenant-cli", userId: "user-cli", appId: "mengshu",
      projectId: "project-cli", agentId: "agent-cli", namespace: "memories",
      visibility: "private" as const,
    };

    const options = createCliMcpStdioServerOptions(runtime, { authority, defaultScope });

    expect(options.durableJobV2).toBeUndefined();
    expect(options.workerOwnership).toBe("external-runtime-host");
  });

  test("无配置 help 展示 session explain 命令面", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "--help"]);
      expect(log.mock.calls.map((call) => String(call[0])).join("\n"))
        .toContain("session");
    } finally {
      log.mockRestore();
    }
  });

  test("无配置 doctor --help 展示 doctor 子命令而不是顶层帮助", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "doctor", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Usage: ms doctor [options] [dir]");
      expect(output).toContain("Diagnose config, DB, embedding, disk and manifest health");
      expect(output).not.toContain("Commands:");
    } finally {
      log.mockRestore();
    }
  });

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

  test("CLI serve 把显式 authority 交给 production factory 且非法 authority fail-closed", () => {
    let bundleRead = false;
    const source = {
      config: { dbType: "postgres" },
      lifecycle: { snapshot: () => ({ state: "ready", ready: true }) },
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      get durableJobV2RuntimeBundle() {
        bundleRead = true;
        return undefined;
      },
    };

    expect(() => createCliServeRuntimeHost(source, {
      tenantId: "tenant-cli",
      userId: "user-cli",
      allow: {
        appIds: [],
        projectIds: ["project-cli"],
        agentIds: ["agent-cli"],
        namespaces: ["working-context"],
        visibilities: ["private"],
      },
    } as never)).toThrow(/authority/i);

    expect(bundleRead).toBe(false);
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

  test.each(["serve", "status", "migrate", "session"])(
    "%s 缺 server authority 时在 config/runtime/DB/listener 副作用前拒绝",
    async (command) => {
      setupCliHome("invalid-config-must-not-be-read");

      await expect(runMengshuCli(["node", "ms", command])).rejects.toThrow(/authority.*requires/i);
    },
  );

  test("普通短命令不被 server authority 前置条件误伤", async () => {
    expect(requiresServerAuthority(["node", "ms", "stats"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "health"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "init"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "project", "status"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "project", "context"])).toBe(true);
    expect(requiresServerAuthority(["node", "ms", "project", "lookup"])).toBe(true);
    setupCliHome("invalid-short-command-config");

    await expect(runMengshuCli(["node", "ms", "stats"]))
      .rejects.not.toThrow(/authority/i);
  });

  test("ms init 不读取 runtime 配置或 authority，只初始化目标项目", async () => {
    setupCliHome("invalid-config-must-not-be-read");
    const projectDir = mkdtempSync(join(tmpdir(), "mengshu-init-product-neutral-"));
    try {
      await expect(runMengshuCli(["node", "ms", "init", projectDir])).resolves.toBeUndefined();
      expect(existsSync(join(projectDir, ".mengshu.json"))).toBe(true);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("ms project status 只读取本地 identity，不解析 runtime 配置", async () => {
    setupCliHome("invalid-config-must-not-be-read");
    const projectDir = mkdtempSync(join(tmpdir(), "mengshu-status-product-neutral-"));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "init", projectDir]);
      await expect(runMengshuCli(["node", "ms", "project", "status", projectDir]))
        .resolves.toBeUndefined();
      expect(log.mock.calls.map((call) => String(call[0])).join("\n"))
        .toContain("Project Workspace Status");
    } finally {
      log.mockRestore();
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  test("configless init help 展示项目身份参数，不再描述为全局配置", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "init", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Usage: ms init [options] [dir]");
      expect(output).toContain("--project-id <id>");
      expect(output).toContain("Initialize a product-neutral project memory workspace");
    } finally {
      log.mockRestore();
    }
  });

  test("standalone health 无 scope authority 仍可执行 host readiness", async () => {
    setupCliHome({});
    writeFileSync(join(cliHome!, "config.json"), JSON.stringify(validLanceConfig()));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runMengshuCli(["node", "ms", "health"])).resolves.toBeUndefined();
      expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain('"ok": true');
    } finally {
      log.mockRestore();
    }
  });

  test("真实 standalone serve 装配携带 authority 并到达 RuntimeHost factory", async () => {
    setupCliHome({});
    writeFileSync(join(cliHome!, "config.json"), JSON.stringify(validLanceConfig()));
    configureServerAuthority();

    await expect(runMengshuCli(["node", "ms", "serve"]))
      .rejects.toThrow(/durable job v2 serve capability/i);
  });

  test("MENGSHU_CONFIG 覆盖全局 home 配置路径", async () => {
    setupCliHome("invalid-home-config-must-not-be-read");
    const explicitConfigPath = join(cliHome!, "operator-owned-config.json");
    writeFileSync(explicitConfigPath, JSON.stringify(validLanceConfig()));
    process.env.MENGSHU_CONFIG = explicitConfigPath;
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
