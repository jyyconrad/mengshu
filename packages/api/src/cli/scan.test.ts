import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { Command } from "commander";
import { DatabaseFactory } from "../../../core/src/db/factory.js";
import type { DirectoryScanProposal } from "../../../core/src/ingest/directory-governance.js";
import { runMengshuCli, requiresServerAuthority } from "./ms.js";
import {
  DIRECTORY_SCAN_APPLY_CAPABILITY_ERROR,
  DIRECTORY_SCAN_APPLY_CONFLICT_ERROR,
  buildDirectoryScanWriteCommand,
  registerDirectoryScanCommand,
} from "./scan.js";

let home: string | undefined;

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  delete process.env.MENGSHU_HOME;
  delete process.env.MENGSHU_AUTHORITY_JSON;
  delete process.env.MENGSHU_AUTHORITY_FILE;
});

function proposal(overrides: Partial<DirectoryScanProposal> = {}): DirectoryScanProposal {
  return {
    relativePath: "notes/api.md",
    filePath: "/tmp/notes/api.md",
    extension: ".md",
    fingerprint: "a".repeat(64),
    annotatedSemanticType: "resource",
    semanticType: "resource",
    annotationSource: "default_resource",
    text: "The API base URL is https://example.test/v1 and the client retries 3 times.",
    truncated: false,
    admission: {
      outcome: "routed",
      reasonCodes: ["explicit_save_fast_track"],
      route: "active",
      persistedRoute: "candidate",
    },
    ...overrides,
  };
}

describe("ms scan CLI", () => {
  test("help names dry-run, apply, and the evolve boundary", async () => {
    home = mkdtempSync(join(tmpdir(), "mengshu-scan-help-"));
    process.env.MENGSHU_HOME = home;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "scan", "--help"]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("--dry-run");
      expect(output).toContain("--apply");
      expect(output).toContain("--ignore");
      expect(output).toContain("ms evolve scan");
      expect(output).toContain("writes nothing");
    } finally {
      log.mockRestore();
    }
  });

  test("dry-run on a temp directory writes nothing and does not open a database", async () => {
    home = mkdtempSync(join(tmpdir(), "mengshu-scan-home-"));
    const directory = mkdtempSync(join(tmpdir(), "mengshu-scan-dir-"));
    process.env.MENGSHU_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({
      embedding: {
        apiKey: "test-key",
        baseURL: "http://127.0.0.1:9/v1",
        model: "text-embedding-3-small",
      },
      dbType: "lancedb",
      dbPath: join(home, "lancedb"),
      server: { host: "127.0.0.1", port: 9 },
    }));
    writeFileSync(
      join(directory, "api.md"),
      "The API base URL is https://example.test/v1 and the client retries 3 times.",
    );
    const createProvider = vi.spyOn(DatabaseFactory, "createProvider");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runMengshuCli(["node", "ms", "scan", directory]);
      const output = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("Scan mode: dry-run");
      expect(output).toContain("Analyzer database writes: 0");
      expect(output).toContain("Apply: not requested");
      expect(output).toContain("semanticType=resource");
      expect(createProvider).not.toHaveBeenCalled();
    } finally {
      createProvider.mockRestore();
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("--apply requires authority before config or a database is opened", async () => {
    expect(requiresServerAuthority(["node", "ms", "scan", "./docs"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "scan", "./docs", "--dry-run"])).toBe(false);
    expect(requiresServerAuthority(["node", "ms", "scan", "./docs", "--apply"])).toBe(true);

    home = mkdtempSync(join(tmpdir(), "mengshu-scan-authority-"));
    process.env.MENGSHU_HOME = home;
    writeFileSync(join(home, "config.json"), "invalid-config-must-not-be-read");
    await expect(runMengshuCli(["node", "ms", "scan", home, "--apply"]))
      .rejects.toThrow(/authority/i);
  });

  test("refuses to combine --dry-run and --apply", async () => {
    home = mkdtempSync(join(tmpdir(), "mengshu-scan-conflict-"));
    process.env.MENGSHU_HOME = home;
    writeFileSync(join(home, "config.json"), "invalid-config-must-not-be-read");
    await expect(runMengshuCli(["node", "ms", "scan", home, "--dry-run", "--apply"]))
      .rejects.toThrow(DIRECTORY_SCAN_APPLY_CONFLICT_ERROR);
  });

  test("command dry-run does not call the writer; apply sends only admitted proposals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mengshu-scan-command-"));
    writeFileSync(
      join(directory, "api.md"),
      "The API base URL is https://example.test/v1 and the client retries 3 times.",
    );
    writeFileSync(join(directory, "short.md"), "hi");
    const write = vi.fn(async (proposal: { relativePath: string }) => ({
      status: "persisted" as const,
      memoryId: "mem-1",
      relativePath: proposal.relativePath,
    }));
    const createWriter = vi.fn(() => write);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const dryRun = new Command().name("ms").exitOverride();
      registerDirectoryScanCommand(dryRun, { createWriter });
      await dryRun.parseAsync(["node", "ms", "scan", directory, "--dry-run"]);
      expect(createWriter).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();

      const apply = new Command().name("ms").exitOverride();
      registerDirectoryScanCommand(apply, { createWriter });
      await apply.parseAsync(["node", "ms", "scan", directory, "--apply", "--json"]);
      expect(createWriter).toHaveBeenCalledOnce();
      expect(write).toHaveBeenCalledOnce();
      expect(write.mock.calls[0]?.[0]?.relativePath).toBe("api.md");
      const json = log.mock.calls.map((call) => String(call[0])).join("\n");
      expect(json).toContain('"databaseWrites": 0');
      expect(json).toContain('"written": 1');
    } finally {
      log.mockRestore();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("apply without a write kernel fails closed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mengshu-scan-nowriter-"));
    writeFileSync(join(directory, "api.md"), "The API base URL is https://example.test/v1.");
    const program = new Command().name("ms").exitOverride();
    registerDirectoryScanCommand(program, {});
    await expect(program.parseAsync(["node", "ms", "scan", directory, "--apply"]))
      .rejects.toThrow(DIRECTORY_SCAN_APPLY_CAPABILITY_ERROR);
    rmSync(directory, { recursive: true, force: true });
  });

  test("write commands use observeAuto and are not built for rejected proposals", () => {
    const command = buildDirectoryScanWriteCommand({
      proposal: proposal(),
      serverAuthority: { tenantId: "tenant" },
      clientScope: { namespace: "working-context" },
      category: "other",
      dataType: "knowledge",
      tableName: "knowledge",
    });
    expect(command).toMatchObject({
      type: "observeAuto",
      intent: "remember",
      semanticType: "resource",
      kind: "knowledge",
      idempotencyKey: `scan:${"a".repeat(64)}`,
    });
    expect(() => buildDirectoryScanWriteCommand({
      proposal: proposal({
        semanticType: null,
        admission: { outcome: "skipped_invalid_type", reasonCodes: ["semantic_type_invalid"] },
      }),
      serverAuthority: {},
      clientScope: {},
      category: "other",
      dataType: "knowledge",
      tableName: "knowledge",
    })).toThrow(/refused to build a write/);
  });
});
