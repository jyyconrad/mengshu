import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { checkVersionConsistency } from "./check-version-consistency.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];
const VERSION = "1.0.5";

const ACTIVE_SOURCES = [
  "plugins/openclaw/package.json",
  "plugins/openclaw/openclaw.plugin.json",
  "plugins/codex/.codex-plugin/plugin.json",
  "packages/api/src/cli/ms.ts#CLI_VERSION",
  "packages/mcp/src/stdio-server.ts#SERVER_VERSION",
] as const;

function write(root: string, relativePath: string, content: string): void {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, "utf8");
}

function writeJson(root: string, relativePath: string, value: unknown): void {
  write(root, relativePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "mengshu-version-gate-"));
  tempDirs.push(root);
  writeJson(root, "package.json", { name: "fixture", version: VERSION });
  writeJson(root, "plugins/openclaw/package.json", { version: VERSION });
  writeJson(root, "plugins/openclaw/openclaw.plugin.json", { version: VERSION });
  writeJson(root, "plugins/codex/.codex-plugin/plugin.json", { version: VERSION });
  write(root, "packages/api/src/cli/ms.ts", `const CLI_VERSION = "${VERSION}";\n`);
  write(
    root,
    "packages/mcp/src/stdio-server.ts",
    `const SERVER_VERSION = "${VERSION}";\n`,
  );
  return root;
}

function driftSource(root: string, source: (typeof ACTIVE_SOURCES)[number]): void {
  const drifted = "9.9.9";
  if (source.endsWith("#CLI_VERSION")) {
    write(root, source.split("#")[0], `const CLI_VERSION = "${drifted}";\n`);
  } else if (source.endsWith("#SERVER_VERSION")) {
    write(root, source.split("#")[0], `const SERVER_VERSION = "${drifted}";\n`);
  } else {
    writeJson(root, source, { version: drifted });
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("version consistency gate", () => {
  test("当前仓库所有 active 版本来源一致", () => {
    const result = checkVersionConsistency(projectRoot);

    expect(result.packageVersion).toBe(VERSION);
    expect(result.consumers.map((consumer) => consumer.source)).toEqual(
      ACTIVE_SOURCES,
    );
  });

  test.each(ACTIVE_SOURCES)("%s 漂移时 fail-closed 并列出来源", (source) => {
    const root = createFixture();
    driftSource(root, source);

    expect(() => checkVersionConsistency(root)).toThrow(
      new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  });

  test("多个来源同时漂移时一次列出全部来源", () => {
    const root = createFixture();
    for (const source of ACTIVE_SOURCES) driftSource(root, source);

    let message = "";
    try {
      checkVersionConsistency(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    for (const source of ACTIVE_SOURCES) expect(message).toContain(source);
  });

  test("CLI 版本声明缺失时 fail-closed 并指明来源", () => {
    const root = createFixture();
    write(root, "packages/api/src/cli/ms.ts", "export const name = 'ms';\n");

    expect(() => checkVersionConsistency(root)).toThrow(
      /packages\/api\/src\/cli\/ms\.ts#CLI_VERSION.*未找到版本声明/s,
    );
  });
});
