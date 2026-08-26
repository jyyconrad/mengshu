import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../../..");
const runnerPath = path.join(projectRoot, "tests/eval/runners/quick-eval.ts");
const tsxPath = path.join(projectRoot, "node_modules/.bin/tsx");
const tempDirs: string[] = [];

function runCli(args: string[]) {
  return spawnSync(tsxPath, [runnerPath, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, MENGSHU_RUN_LIVE_TESTS: "0" },
  });
}

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mengshu-quick-eval-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("quick-eval CLI fail-closed", () => {
  test("无参数默认执行完整 11 suite，offline quality 通过 exit 0，但不冒充 production gate", () => {
    const result = runCli([]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/未实现 runner|missing runner/i);
    expect(result.stdout).toContain("mengshu-v0.1");
    expect(result.stdout).toContain("mengshu-skill-candidate");
    expect(result.stdout).toContain("release gate: PASS");
    expect(result.stdout).toContain("production release gate: FAIL");
    expect(result.stdout).toMatch(/production gate reason:.*offline-component/);
  });

  test("all 写出完整 11 suite report，全部 offline quality gate 通过，production gate 仍失败", () => {
    const out = makeTempDir();
    const result = runCli(["all", "--out", out]);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toMatch(/未实现 runner/);
    const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(report.suites).toHaveLength(11);
    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(false);
    expect(report.manifest.suites).toHaveLength(11);
    expect(report.manifest.suites).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "mengshu-extraction",
        fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        gateIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
    const extensions = report.suites.filter((suite: { suite: string }) =>
      !suite.suite.startsWith("mengshu-v0.1") && suite.suite !== "mengshu-safety");
    expect(extensions).toHaveLength(9);
    expect(extensions.find((suite: { suite: string }) => suite.suite === "mengshu-extraction"))
      .toMatchObject({ gatePassed: true });
    expect(extensions.every((suite: { gatePassed: boolean }) => suite.gatePassed === true))
      .toBe(true);
    const markdown = readFileSync(path.join(out, "report.md"), "utf8");
    const extractionSection = markdown.split("## suite: mengshu-extraction")[1]!
      .split("## suite: mengshu-dedup")[0]!;
    expect(extractionSection).not.toContain("slot recall pass rate");
    expect(markdown).toContain("fixture sha256：");
    expect(markdown).toContain("gate identity：");
    expect(markdown).toMatch(/production gate reason：.*offline-component/);
    expect(markdown).not.toContain("### Contract issues");
  });

  test("baseline exact selection 保持 quality PASS，但 offline production FAIL", () => {
    const out = makeTempDir();
    const result = runCli(["mengshu-v0.1", "--out", out]);
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(report.suites.map((suite: { suite: string }) => suite.suite)).toEqual(["mengshu-v0.1"]);
    expect(report.releaseGatePassed).toBe(true);
    expect(report.productionReleaseGatePassed).toBe(false);
  });

  test("extension exact selection 只运行目标 suite，修复后 quality gate 通过", () => {
    const out = makeTempDir();
    const result = runCli(["mengshu-tree-summary", "--out", out]);
    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(report.suites.map((suite: { suite: string }) => suite.suite)).toEqual([
      "mengshu-tree-summary",
    ]);
    expect(report.suites[0].gatePassed).toBe(true);
    expect(report.manifest.suites[0]).toMatchObject({
      runner: "tree-summary-v1",
      fixtureSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      gateIdentity: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("--suite 显式选择 deterministic capability suite", () => {
    const out = makeTempDir();
    const result = runCli(["--suite", "mengshu-slot-loadout", "--out", out]);

    expect(result.status).toBe(0);
    const report = JSON.parse(readFileSync(path.join(out, "report.json"), "utf8"));
    expect(report.suites).toEqual([
      expect.objectContaining({
        suite: "mengshu-slot-loadout",
        total: 6,
        passed: 6,
        gatePassed: true,
      }),
    ]);
  });

  test("未知 suite 非零失败并指出未登记", () => {
    const result = runCli(["mengshu-unknown", "--out", makeTempDir()]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/未登记.*mengshu-unknown/);
  });

  test("manifest schema 错误非零失败", () => {
    const dir = makeTempDir();
    const invalidManifest = path.join(dir, "manifest.json");
    writeFileSync(
      invalidManifest,
      JSON.stringify({ schemaVersion: 1, suites: { broken: { file: "x.jsonl" } } }),
      "utf8",
    );

    const result = runCli([
      "broken",
      "--manifest",
      invalidManifest,
      "--out",
      dir,
    ]);

    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/manifest.*runner/s);
  });
});
