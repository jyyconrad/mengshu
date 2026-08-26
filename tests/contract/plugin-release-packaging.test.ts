import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

const rootDir = path.resolve(import.meta.dirname, "../..");
const tempDirs: string[] = [];

function jsonFile(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

function makeTemp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function npmPack(projectDir: string, destination: string): string {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
    { cwd: projectDir, encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as Array<{ filename: string }>;
  return path.join(destination, report[0]!.filename);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("release plugin packaging", () => {
  test("npm tarball exposes the OpenClaw and Codex release assets", () => {
    const result = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--dry-run", "--json"],
      { cwd: rootDir, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);

    const report = JSON.parse(result.stdout) as Array<{
      files: Array<{ path: string }>;
    }>;
    const packedPaths = report[0]!.files.map((entry) => entry.path);
    expect(packedPaths).toEqual(expect.arrayContaining([
      "openclaw.plugin.json",
      ".agents/plugins/marketplace.json",
      "plugins/codex/sources/adapter.ts",
      "scripts/pack-codex-marketplace.mjs",
    ]));

    const rootManifest = jsonFile(path.join(rootDir, "openclaw.plugin.json"));
    const sourceManifest = jsonFile(
      path.join(rootDir, "plugins/openclaw/openclaw.plugin.json"),
    );
    expect(rootManifest).toEqual(sourceManifest);
    expect(rootManifest.id).toBe("mengshu-openclaw");
  });

  test("Codex marketplace output remains self-contained after the host copies only the plugin directory", async () => {
    const packerPath = path.join(rootDir, "scripts/pack-codex-marketplace.mjs");
    expect(existsSync(packerPath)).toBe(true);
    if (!existsSync(packerPath)) return;

    const temp = makeTemp("mengshu-codex-release-");
    const fixture = path.join(temp, "runtime-package");
    const fixtureBin = path.join(fixture, "dist/bin/ms.js");
    const pluginVersion = String(
      jsonFile(path.join(rootDir, "plugins/codex/.codex-plugin/plugin.json")).version,
    );
    mkdirSync(path.dirname(fixtureBin), { recursive: true });
    writeFileSync(
      path.join(fixture, "package.json"),
      `${JSON.stringify({
        name: "@mengshu/core",
        version: pluginVersion,
        type: "module",
        bin: { ms: "./dist/bin/ms.js" },
        files: ["dist"],
      }, null, 2)}\n`,
    );
    writeFileSync(
      fixtureBin,
      [
        "#!/usr/bin/env node",
        `if (process.argv[2] === "--version") { console.log(${JSON.stringify(pluginVersion)}); process.exit(0); }`,
        "if (process.argv[2] !== \"mcp\") process.exit(64);",
        "process.stdin.resume();",
        "process.stdin.once(\"end\", () => process.exit(0));",
        "",
      ].join("\n"),
    );
    chmodSync(fixtureBin, 0o755);

    const packageTarball = npmPack(fixture, path.join(temp, "npm"));
    const outputDir = path.join(temp, "codex-marketplace");
    const packer = await import(pathToFileURL(packerPath).href) as {
      prepareCodexMarketplace(options: {
        projectRoot: string;
        packageTarball: string;
        outputDir: string;
      }): Promise<{ pluginDir: string }>;
    };
    const prepared = await packer.prepareCodexMarketplace({
      projectRoot: rootDir,
      packageTarball,
      outputDir,
    });

    const marketplace = jsonFile(
      path.join(outputDir, ".agents/plugins/marketplace.json"),
    ) as { plugins: Array<{ name: string; source: { path: string } }> };
    expect(marketplace.plugins.find(({ name }) => name === "mengshu-memory")?.source.path)
      .toBe("./plugins/mengshu-memory");
    expect(existsSync(path.join(
      prepared.pluginDir,
      "runtime/node_modules/@mengshu/core/dist/bin/ms.js",
    ))).toBe(true);
    expect(existsSync(path.join(prepared.pluginDir, "runtime/package.json"))).toBe(false);
    expect(existsSync(path.join(
      prepared.pluginDir,
      "runtime/node_modules/.package-lock.json",
    ))).toBe(false);
    expect(existsSync(path.join(prepared.pluginDir, "runtime/node_modules/.bin"))).toBe(false);

    const cacheDir = path.join(temp, "codex-cache/mengshu-local/mengshu-memory", pluginVersion);
    cpSync(prepared.pluginDir, cacheDir, { recursive: true });
    const started = spawnSync(process.execPath, ["mcp/server.mjs"], {
      cwd: cacheDir,
      encoding: "utf8",
      input: "",
      env: {
        ...process.env,
        PATH: "",
        MENGSHU_AUTHORITY_JSON: "{}",
        MENGSHU_AUTHORITY_FILE: "",
        MENGSHU_CODEX_MS_PATH: "",
      },
    });
    expect(started.status, started.stderr).toBe(0);
    expect(started.stderr).not.toContain("BUNDLED_RUNTIME_NOT_FOUND");
  }, 30_000);
});
