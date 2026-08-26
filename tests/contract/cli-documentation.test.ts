import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { runMengshuCli } from "../../packages/api/src/cli/ms.js";

const docsPath = path.resolve(import.meta.dirname, "../../docs/api/cli-commands.md");

async function renderedHelp(command: string): Promise<string> {
  const lines: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((value?: unknown) => {
    lines.push(String(value ?? ""));
  });
  try {
    await runMengshuCli(["node", "ms", command, "--help"]);
  } finally {
    log.mockRestore();
  }
  return lines.join("\n");
}

describe("CLI documentation contract", () => {
  test.each(["migrate", "migrate-history", "migrate-history-worker"])(
    "%s 的长选项全部出现在 CLI reference",
    async (command) => {
      const docs = readFileSync(docsPath, "utf8");
      const help = await renderedHelp(command);
      const flags = [...new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])]
        .filter((flag) => flag !== "--help");

      expect(flags.length).toBeGreaterThan(0);
      for (const flag of flags) expect(docs).toContain(flag);
    },
  );

  test("schema reference 使用当前 v24 并移除旧 v4/v23 限制", () => {
    const docs = readFileSync(docsPath, "utf8");
    expect(docs).toContain("--to-schema v24");
    expect(docs).not.toContain("当前只支持 `--to-schema v4`");
    expect(docs).not.toContain("默认 target 为 `v23`");
  });
});
