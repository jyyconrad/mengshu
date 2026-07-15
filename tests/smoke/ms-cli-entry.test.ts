import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  runCliProgram,
  runMengshuCli,
  runSchemaMigrationCliProgram,
} from "../../packages/api/src/cli/ms.js";

let homeDir: string | undefined;

afterEach(() => {
  if (homeDir) {
    rmSync(homeDir, { recursive: true, force: true });
    homeDir = undefined;
  }
  delete process.env.MENGSHU_HOME;
  delete process.env.MENGSHU_AUTHORITY_JSON;
  delete process.env.MENGSHU_AUTHORITY_FILE;
  process.exitCode = undefined;
});

describe("ms CLI entry", () => {
  test("prints help through the packages/api CLI entry without requiring config", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "mengshu-cli-home-"));
    process.env.MENGSHU_HOME = homeDir;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runMengshuCli(["node", "ms", "--help"])).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    const output = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("scan <directory>");
    expect(output).toContain("embedding-space");
    expect(output).toContain("serve");
    expect(output).toContain("project");
    expect(output).toContain("migrate");
    expect(output).toContain("eval");

    log.mockRestore();
  });

  test.each(["--help", "--version"])("%s is not blocked by config or MCP authority", async (flag) => {
    homeDir = mkdtempSync(join(tmpdir(), "mengshu-cli-help-home-"));
    process.env.MENGSHU_HOME = homeDir;
    writeFileSync(join(homeDir, "config.json"), "invalid-config-must-not-be-read");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await expect(runMengshuCli(["node", "ms", flag])).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
    log.mockRestore();
  });

  test("migrate 缺 authority 时在读取 invalid config/创建 DB 前拒绝", async () => {
    homeDir = mkdtempSync(join(tmpdir(), "mengshu-cli-migrate-authority-home-"));
    process.env.MENGSHU_HOME = homeDir;
    writeFileSync(join(homeDir, "config.json"), "invalid-config-must-not-be-read");

    await expect(runMengshuCli(["node", "ms", "migrate"]))
      .rejects.toThrow(/authority/i);
  });

  test("schema migration parser 不启动 runtime，只在命令结束关闭 provider 资源", async () => {
    const calls: string[] = [];
    const program = {
      parseAsync: vi.fn(async () => { calls.push("parse"); }),
    };
    const close = vi.fn(async () => { calls.push("close"); });

    await runSchemaMigrationCliProgram(program, ["node", "ms", "migrate"], { close });

    expect(calls).toEqual(["parse", "close"]);
  });

  test("starts before parse and stops the runtime after a short command completes", async () => {
    const calls: string[] = [];
    const start = vi.fn(async () => { calls.push("start"); });
    const stop = vi.fn(async () => { calls.push("stop"); });
    const program = {
      parseAsync: vi.fn(async () => { calls.push("parse"); }),
    };

    await runCliProgram(program, ["node", "ms", "status"], { start, stop });

    expect(program.parseAsync).toHaveBeenCalledWith(["node", "ms", "status"]);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["start", "parse", "stop"]);
  });

  test("stops the runtime when a short command fails", async () => {
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const program = {
      parseAsync: vi.fn(async () => {
        throw new Error("status failed");
      }),
    };

    await expect(
      runCliProgram(program, ["node", "ms", "status"], { start, stop }),
    ).rejects.toThrow("status failed");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("start failure skips parse but still stops and preserves startup failure", async () => {
    const failure = new Error("runtime start failed");
    const start = vi.fn(async () => { throw failure; });
    const stop = vi.fn(async () => {});
    const program = { parseAsync: vi.fn(async () => {}) };

    await expect(runCliProgram(program, ["node", "ms", "status"], { start, stop })).rejects.toBe(failure);

    expect(program.parseAsync).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test("parse + stop 双失败时保留两个错误", async () => {
    const parseFailure = new Error("parse failed");
    const stopFailure = new Error("stop failed");
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => { throw stopFailure; });
    const program = { parseAsync: vi.fn(async () => { throw parseFailure; }) };

    const failure = await runCliProgram(program, ["node", "ms", "status"], { start, stop })
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([parseFailure, stopFailure]);
  });

  test.each(["mcp", "serve"])("does not stop the runtime while %s is still running", async (command) => {
    let finishCommand: (() => void) | undefined;
    const commandLifetime = new Promise<void>((resolve) => {
      finishCommand = resolve;
    });
    const stop = vi.fn(async () => {});
    const start = vi.fn(async () => {});
    const execution = runCliProgram(
      { parseAsync: async () => commandLifetime },
      ["node", "ms", command],
      { start, stop },
    );

    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();

    finishCommand?.();
    await execution;
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
