import { describe, expect, test, vi } from "vitest";

import {
  parseMarkdownWorksetOperatorArgs,
  runMarkdownWorksetOperatorCli,
  type MarkdownWorksetOperatorCliDependencies,
} from "./operator-markdown-workset-cli.js";

const HASH = "a".repeat(64);

describe("Markdown workset operator CLI", () => {
  test("export 参数固定 config/root/output/run/policy 和受限并发参数", () => {
    expect(parseMarkdownWorksetOperatorArgs([
      "export",
      "--config", "/tmp/config.json",
      "--containment-root", "/tmp/migration",
      "--output", "/tmp/migration/source",
      "--run-id", "run-01",
      "--policy-version", "markdown-export/v1",
      "--page-size", "500",
      "--write-concurrency", "64",
    ])).toMatchObject({
      operation: "export",
      configPath: "/tmp/config.json",
      containmentRoot: "/tmp/migration",
      outputDirectory: "/tmp/migration/source",
      runId: "run-01",
      policyVersion: "markdown-export/v1",
      pageSize: 500,
      writeConcurrency: 64,
    });
    expect(() => parseMarkdownWorksetOperatorArgs([
      "export", "--config", "/tmp/config.json", "--containment-root", "/tmp",
      "--output", "/tmp/out", "--run-id", "run", "--policy-version", "v1",
      "--page-size", "0",
    ])).toThrow(/argument/i);
    expect(() => parseMarkdownWorksetOperatorArgs([
      "export", "--config", "/tmp/config.json", "--containment-root", "/tmp",
      "--output", "/tmp/out", "--run-id", "run", "--policy-version", "v1",
      "--write-concurrency", "65",
    ])).toThrow(/argument/i);
  });

  test("govern 和 plan-import 必须 pin manifest sha256，未知/force 参数拒绝", () => {
    expect(parseMarkdownWorksetOperatorArgs([
      "govern", "--manifest", "/tmp/source/manifest.json", "--manifest-sha256", HASH,
      "--containment-root", "/tmp", "--output", "/tmp/governed",
      "--policy-version", "markdown-governance/v1",
    ])).toMatchObject({ operation: "govern", manifestSha256: HASH });
    expect(parseMarkdownWorksetOperatorArgs([
      "plan-import", "--manifest", "/tmp/governed/manifest.json",
      "--manifest-sha256", HASH,
    ])).toMatchObject({ operation: "plan-import", mode: "dry_run" });
    expect(() => parseMarkdownWorksetOperatorArgs([
      "plan-import", "--manifest", "/tmp/manifest.json", "--manifest-sha256", HASH,
      "--force",
    ])).toThrow(/argument/i);
  });

  test("run export 使用已解析 PostgreSQL config 并保证连接关闭", async () => {
    const close = vi.fn(async () => undefined);
    const runExport = vi.fn(async () => ({
      outputDirectory: "/tmp/migration/source",
      manifestPath: "/tmp/migration/source/manifest.json",
      manifestSha256: HASH,
      manifest: { sourceCount: 2 },
    }));
    const dependencies: MarkdownWorksetOperatorCliDependencies = {
      loadPostgresConfig: vi.fn(() => ({ host: "db", port: 5432, database: "m", user: "u", password: "p" })),
      connect: vi.fn(async () => ({ client: { query: vi.fn() }, close })),
      runExport: runExport as never,
      runPreprocess: vi.fn() as never,
      loadBundle: vi.fn() as never,
      writeGoverned: vi.fn() as never,
      prepareImport: vi.fn() as never,
      createImporter: vi.fn() as never,
      clock: () => "2026-08-28T08:00:00.000Z",
    };

    const report = await runMarkdownWorksetOperatorCli([
      "export", "--config", "/tmp/config.json", "--containment-root", "/tmp/migration",
      "--output", "/tmp/migration/source", "--run-id", "run-01",
      "--policy-version", "markdown-export/v1", "--write-concurrency", "32",
    ], dependencies);

    expect(report).toMatchObject({ operation: "export", sourceCount: 2, manifestSha256: HASH });
    expect(runExport).toHaveBeenCalledWith(expect.objectContaining({ writeConcurrency: 32 }));
    expect(runExport).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  test("plan-import 只返回 hash/count 摘要，不输出正文或向量", async () => {
    const prepareImport = vi.fn(() => ({
      runId: "run-01",
      sourceSnapshotHash: HASH,
      manifestHash: HASH,
      verifyHash: "b".repeat(64),
      planHash: "c".repeat(64),
      stageHash: "d".repeat(64),
      counts: {
        sourceTotal: 10, liveTargetTotal: 4, mappingTotal: 10,
        archiveTotal: 2, quarantineTotal: 1, unresolvedTotal: 0,
      },
    }));
    const dependencies: MarkdownWorksetOperatorCliDependencies = {
      loadPostgresConfig: vi.fn() as never,
      connect: vi.fn() as never,
      runExport: vi.fn() as never,
      runPreprocess: vi.fn() as never,
      loadBundle: vi.fn(async () => ({
        manifestSha256: HASH,
        manifest: { phase: "governed" },
        files: [{ markdown: "secret memory" }],
      })) as never,
      writeGoverned: vi.fn() as never,
      prepareImport: prepareImport as never,
      createImporter: vi.fn() as never,
      clock: () => "2026-08-28T08:00:00.000Z",
    };

    const report = await runMarkdownWorksetOperatorCli([
      "plan-import", "--manifest", "/tmp/governed/manifest.json",
      "--manifest-sha256", HASH,
    ], dependencies);

    expect(report).toMatchObject({
      operation: "plan-import",
      runId: "run-01",
      sourceTotal: 10,
      liveTargetTotal: 4,
      unresolvedTotal: 0,
      expectedCurrentSnapshotHash: HASH,
    });
    expect(String((report as unknown as Record<string, unknown>).activationConfirmationToken))
      .toContain("ACTIVATE_MARKDOWN_WORKSET:run-01:");
    expect(JSON.stringify(report)).not.toContain("secret memory");
  });

  test("preprocess 透传 pinned source manifest 且不加载整份 bundle", async () => {
    const loadBundle = vi.fn();
    const runPreprocess = vi.fn(async () => ({
      manifestPath: "/tmp/preprocessed/manifest.json",
      manifestSha256: HASH,
      inventory: { inventorySha256: "b".repeat(64) },
      manifest: {
        migrationRunId: "run-01",
        sourceCount: 2,
        sourceSnapshotSha256: "c".repeat(64),
      },
    }));
    const dependencies: MarkdownWorksetOperatorCliDependencies = {
      loadPostgresConfig: vi.fn() as never,
      connect: vi.fn() as never,
      runExport: vi.fn() as never,
      runPreprocess: runPreprocess as never,
      loadBundle: loadBundle as never,
      writeGoverned: vi.fn() as never,
      prepareImport: vi.fn() as never,
      createImporter: vi.fn() as never,
      clock: () => "2026-08-28T08:00:00.000Z",
    };

    const report = await runMarkdownWorksetOperatorCli([
      "preprocess", "--manifest", "/tmp/source/manifest.json",
      "--manifest-sha256", HASH, "--containment-root", "/tmp",
      "--output", "/tmp/preprocessed", "--policy-version", "markdown-preprocess/v1",
      "--concurrency", "32",
    ], dependencies);

    expect(report).toMatchObject({
      operation: "preprocess",
      sourceCount: 2,
      inventorySha256: "b".repeat(64),
    });
    expect(runPreprocess).toHaveBeenCalledWith(expect.objectContaining({
      sourceManifestSha256: HASH,
      concurrency: 32,
    }));
    expect(loadBundle).not.toHaveBeenCalled();
  });

  test("activate-import 强制要求全部写入门禁且拒绝 force", () => {
    expect(parseMarkdownWorksetOperatorArgs([
      "activate-import",
      "--config", "/tmp/config.json",
      "--manifest", "/tmp/governed/manifest.json",
      "--manifest-sha256", HASH,
      "--source-manifest-sha256", "b".repeat(64),
      "--expected-current-snapshot-sha256", "c".repeat(64),
      "--idempotency-key", "activate-01",
      "--confirmation-token", "ACTIVATE_MARKDOWN_WORKSET:run",
      "--maintenance", "--quiescence-confirmed",
    ])).toMatchObject({
      operation: "activate-import",
      maintenanceMode: true,
      quiescenceConfirmed: true,
    });
    expect(() => parseMarkdownWorksetOperatorArgs([
      "activate-import", "--force",
    ])).toThrow(/argument/i);
  });
});
