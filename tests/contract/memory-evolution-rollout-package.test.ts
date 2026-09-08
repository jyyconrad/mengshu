import { spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { globSync } from "glob";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const relative = (file: string) => path.relative(root, file).split(path.sep).join("/");
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const manifest = readJson(path.join(root, "package.json")) as {
  name: string; version: string; main: string; types: string;
  bin: Record<string, string>; exports: Record<string, unknown>; files: string[];
  scripts: Record<string, string>; openclaw: { extensions: string[] };
};
const requiredSources = [
  "bin/ms.ts", "runtime.ts", "config.ts",
  "server/evolution-runtime.ts", "server/evolution-config.ts", "server/background-work.ts",
  "server/evolution-control.ts", "server/evolution-host-state.ts", "server/evolution-attestation.ts",
  "server/reuse-runtime.ts", "server/reuse-evaluator.ts",
  "packages/api/src/cli/evolve.ts", "packages/api/src/evolution-review.ts",
  "packages/api/src/evolution-source-control.ts",
  "packages/api/src/evolution-owner-auth.ts", "packages/api/src/rest/router.ts",
  "packages/api/src/runtime-client.ts", "packages/api/src/sdk/client.ts",
  "packages/mcp/src/evolution-tools.ts", "packages/mcp/src/stdio-server.ts",
  "packages/core/src/evolution/batch-service.ts", "packages/core/src/evolution/postgres-repository.ts",
  "packages/core/src/evolution/postgres-inventory.ts", "packages/core/src/evolution/governed-writer.ts",
  "packages/core/src/db/migrations/schema-migrations.ts",
  "packages/core/src/storage/repositories/evolution-query-pool.ts",
  "scripts/operator-evolution-history.ts",
  "plugins/openclaw/src/index.ts", "plugins/openclaw/src/cli/index.ts",
];
const requiredAssets = [
  "openclaw.plugin.json", "plugins/openclaw/openclaw.plugin.json", "plugins/openclaw/README.md",
  ".agents/plugins/marketplace.json", "plugins/codex/.codex-plugin/plugin.json",
  "plugins/codex/.mcp.json", "plugins/codex/mcp/server.mjs",
  "plugins/codex/skills/mengshu-memory/SKILL.md", "plugins/codex/sources/adapter.ts",
  "plugins/codex/README.md", "scripts/pack-codex-marketplace.mjs",
  "docs/guides/continuous-memory-evolution.md", "docs/api/cli-commands.md",
  "docs/api/memory-api.md", "docs/guides/configuration.md", "docs/design/schema.md",
  "docs/README.md", "config.example.json", "config/authority.example.json",
];
const privateSentinels = [
  ".env", ".mengshu/config.json", "work/tasks/private-fixture.txt",
  "tests/private-fixture.json", "node_modules/private-fixture/index.js",
];

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(exportTargets);
}

function buildContract() {
  const config = ts.getParsedCommandLineOfConfigFile(path.join(root, "tsconfig.build.json"), {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: diagnostic => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
    },
  });
  if (!config || config.errors.length) {
    throw new Error(config?.errors.map(error => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n") ?? "Missing build configuration");
  }
  const emitted = new Set(config.fileNames.flatMap(file =>
    ts.getOutputFileNames(config, file, !ts.sys.useCaseSensitiveFileNames).map(relative)));
  return { config, emitted, sources: new Set(config.fileNames.map(relative)) };
}

function fixtureFile(directory: string, file: string, content: string | Buffer): void {
  const target = path.resolve(directory, file);
  if (!target.startsWith(`${directory}${path.sep}`)) throw new Error(`Fixture path escapes: ${file}`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function publishedAssets(): string[] {
  return [...new Set(manifest.files.filter(entry => entry !== "dist").flatMap(entry => {
    const fullPath = path.join(root, entry);
    const pattern = existsSync(fullPath) && lstatSync(fullPath).isDirectory() ? `${entry}/**/*` : entry;
    return globSync(pattern, { cwd: root, dot: true, nodir: true, follow: false })
      .filter(file => lstatSync(path.join(root, file)).isFile());
  }))];
}

function packFixture(directory: string, sandbox: string): Set<string> {
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", [
    "pack", "--dry-run", "--ignore-scripts", "--json", "--offline",
    "--audit=false", "--fund=false", "--update-notifier=false",
  ], {
    cwd: directory, encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? path.dirname(process.execPath),
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      HOME: path.join(sandbox, "home"), USERPROFILE: path.join(sandbox, "home"),
      TMPDIR: path.join(sandbox, "tmp"), CI: "1",
      NPM_CONFIG_USERCONFIG: path.join(sandbox, "user.npmrc"),
      NPM_CONFIG_GLOBALCONFIG: path.join(sandbox, "global.npmrc"),
      NPM_CONFIG_CACHE: path.join(sandbox, "cache"),
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/", NPM_CONFIG_OFFLINE: "true",
      NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_WORKSPACES: "false",
    },
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const report = JSON.parse(result.stdout) as Array<{ files: Array<{ path: string }> }>;
  expect(report).toHaveLength(1);
  return new Set(report[0]!.files.map(file => file.path));
}

describe("memory evolution rollout synthetic package contract", () => {
  const build = buildContract();
  let sandbox: string;
  let fixture: string;
  let packed: Set<string>;
  let fixtureManifest: typeof manifest;

  beforeAll(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), "mengshu-rollout-package-"));
    fixture = path.join(sandbox, "package");
    for (const directory of [fixture, "home", "tmp", "cache"].map(directory => path.resolve(sandbox, directory))) {
      mkdirSync(directory, { recursive: true });
    }
    fixtureFile(sandbox, "user.npmrc", "");
    fixtureFile(sandbox, "global.npmrc", "");
    const forbiddenLifecycle = "node -e \"require('node:fs').writeFileSync('lifecycle-ran', 'forbidden');process.exit(99)\"";
    fixtureManifest = { ...manifest, scripts: Object.fromEntries(
      ["prepack", "prepare", "postpack", "preinstall", "install", "postinstall"].map(name => [name, forbiddenLifecycle]),
    ) };
    fixtureFile(fixture, "package.json", JSON.stringify(fixtureManifest));
    // Model compiler output paths only; never build or inspect the shared dist directory.
    for (const file of build.emitted) {
      if (!file.startsWith("dist/")) throw new Error(`Unexpected build output: ${file}`);
      fixtureFile(fixture, file, file.endsWith(".d.ts") ? "export declare const synthetic: true;\n" : "export const synthetic = true;\n");
    }
    for (const file of publishedAssets()) fixtureFile(fixture, file, readFileSync(path.join(root, file)));
    for (const file of privateSentinels) fixtureFile(fixture, file, "synthetic-private-sentinel\n");
    packed = packFixture(fixture, sandbox);
  }, 30_000);

  afterAll(() => {
    if (sandbox) rmSync(sandbox, { recursive: true, force: true });
  });

  test("build includes runtime modules, declarations and plugin entry sources", () => {
    expect(build.config.options.noEmit).toBe(false);
    expect(build.config.options.declaration).toBe(true);
    expect(requiredSources.filter(file => !build.sources.has(file))).toEqual([]);
    expect([...build.sources].filter(file => file.startsWith("tests/") || file.endsWith(".test.ts"))).toEqual([]);
    for (const directory of ["sources", "maintenance", "reuse", "history"]) {
      expect([...build.sources].some(file => file.startsWith(`packages/core/src/evolution/${directory}/`)), directory).toBe(true);
    }
    for (const file of requiredSources) {
      expect(build.emitted.has(`dist/${file.slice(0, -3)}.js`), file).toBe(true);
      expect(build.emitted.has(`dist/${file.slice(0, -3)}.d.ts`), file).toBe(true);
    }
  });

  test("npm files selection retains every modeled compiler output, not only the CLI", () => {
    expect([...build.emitted].filter(file => !packed.has(file))).toEqual([]);
    expect(requiredAssets.filter(file => !packed.has(file))).toEqual([]);
  });

  test("all public exports, bins and OpenClaw entrypoints resolve inside the selected package", () => {
    expect(manifest.bin).toMatchObject({ ms: "./dist/bin/ms.js", mengshu: "./dist/bin/ms.js" });
    expect(Object.keys(manifest.exports)).toEqual(expect.arrayContaining([
      ".", "./api", "./mcp", "./ui", "./openclaw", "./runtime", "./config", "./package.json",
    ]));
    for (const target of [manifest.main, manifest.types, ...Object.values(manifest.bin),
      ...exportTargets(manifest.exports), ...manifest.openclaw.extensions]) {
      expect(target.startsWith("./") && !target.split("/").includes(".."), target).toBe(true);
      const file = target.slice(2);
      expect(packed.has(file), target).toBe(true);
      if (file.startsWith("dist/")) expect(build.emitted.has(file), target).toBe(true);
    }
  });

  test("Codex and OpenClaw metadata retain matching versions and source-independent entry contracts", () => {
    const plugin = readJson(path.join(fixture, "plugins/codex/.codex-plugin/plugin.json"));
    const mcp = readJson(path.join(fixture, "plugins/codex/.mcp.json"));
    expect(plugin.version).toBe(manifest.version);
    expect(plugin.mcpServers).toBe("./.mcp.json");
    expect(plugin.skills).toBe("./skills");
    expect(mcp.mcpServers.mengshu).toMatchObject({ command: "node", args: ["./mcp/server.mjs"] });
    expect(readJson(path.join(fixture, "openclaw.plugin.json")))
      .toEqual(readJson(path.join(fixture, "plugins/openclaw/openclaw.plugin.json")));
    expect(manifest.openclaw.extensions).toEqual(["./dist/plugins/openclaw/src/index.js"]);
    expect(manifest.scripts.prepack).toBe("npm run version:check && npm run build");
  });

  test("synthetic packing neither includes private sentinels nor executes lifecycle or install scripts", () => {
    expect(privateSentinels.filter(file => packed.has(file))).toEqual([]);
    expect(existsSync(path.join(fixture, "lifecycle-ran"))).toBe(false);
    expect(existsSync(path.join(fixture, "package-lock.json"))).toBe(false);
    expect(packed.has("node_modules/@mengshu/core/dist/bin/ms.js")).toBe(false);
  });

  test("a missing dist files entry is detected even when npm auto-includes bin and main", () => {
    fixtureFile(fixture, "package.json", JSON.stringify({ ...fixtureManifest, files: manifest.files.filter(file => file !== "dist") }));
    try {
      const incomplete = packFixture(fixture, sandbox);
      expect(incomplete.has(manifest.bin.ms!.slice(2))).toBe(true);
      expect(incomplete.has("dist/server/evolution-runtime.js")).toBe(false);
      expect([...build.emitted].some(file => !incomplete.has(file))).toBe(true);
    } finally {
      fixtureFile(fixture, "package.json", JSON.stringify(fixtureManifest));
    }
  }, 30_000);
});
