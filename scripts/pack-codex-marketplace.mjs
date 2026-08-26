import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const GENERATED_MARKER = ".mengshu-codex-marketplace.json";
const PLUGIN_NAME = "mengshu-memory";
const RUNTIME_PACKAGE = "@mengshu/core";
const PLUGIN_ENTRIES = [
  ".codex-plugin",
  ".mcp.json",
  "mcp",
  "skills",
  "sources",
  "README.md",
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function safeOutputPath(projectRoot, outputDir) {
  const resolved = path.resolve(outputDir);
  const forbidden = new Set([
    path.parse(resolved).root,
    path.resolve(projectRoot),
    path.resolve(process.env.HOME || path.parse(resolved).root),
  ]);
  if (forbidden.has(resolved)) {
    throw new Error(`Refusing unsafe Codex marketplace output path: ${resolved}`);
  }
  return resolved;
}

function replaceGeneratedOutput(stagingDir, outputDir) {
  if (existsSync(outputDir)) {
    const markerPath = path.join(outputDir, GENERATED_MARKER);
    if (!existsSync(markerPath)) {
      throw new Error(`Refusing to replace non-generated output directory: ${outputDir}`);
    }
    const marker = readJson(markerPath);
    if (marker.kind !== "mengshu-codex-marketplace") {
      throw new Error(`Refusing to replace output with an unknown marker: ${outputDir}`);
    }
    rmSync(outputDir, { recursive: true, force: true });
  }
  renameSync(stagingDir, outputDir);
}

function installRuntime(packageTarball, runtimeDir, npmCommand) {
  const result = spawnSync(
    npmCommand,
    [
      "install",
      "--prefix",
      runtimeDir,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      packageTarball,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0) {
    const detail = result.stderr.trim() || result.error?.message || `exit ${result.status}`;
    throw new Error(`Failed to install Codex bundled runtime: ${detail}`);
  }
  rmSync(path.join(runtimeDir, "package.json"), { force: true });
  rmSync(path.join(runtimeDir, "node_modules/.package-lock.json"), { force: true });
  rmSync(path.join(runtimeDir, "node_modules/.bin"), { recursive: true, force: true });
}

function sha256(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export async function prepareCodexMarketplace(options) {
  const projectRoot = path.resolve(options.projectRoot ?? defaultProjectRoot);
  const packageTarball = path.resolve(options.packageTarball);
  const outputDir = safeOutputPath(projectRoot, options.outputDir);
  const npmCommand = options.npmCommand ?? (process.platform === "win32" ? "npm.cmd" : "npm");
  if (!existsSync(packageTarball)) {
    throw new Error(`Runtime package tarball not found: ${packageTarball}`);
  }

  const pluginSource = path.join(projectRoot, "plugins/codex");
  const sourceMarketplacePath = path.join(projectRoot, ".agents/plugins/marketplace.json");
  const sourceManifest = readJson(path.join(pluginSource, ".codex-plugin/plugin.json"));
  const sourceMarketplace = readJson(sourceMarketplacePath);
  const parentDir = path.dirname(outputDir);
  mkdirSync(parentDir, { recursive: true });
  const stagingDir = mkdtempSync(path.join(parentDir, ".mengshu-codex-marketplace-"));

  try {
    const pluginDir = path.join(stagingDir, "plugins", PLUGIN_NAME);
    mkdirSync(pluginDir, { recursive: true });
    for (const entry of PLUGIN_ENTRIES) {
      const source = path.join(pluginSource, entry);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(pluginDir, entry), { recursive: true });
    }

    const runtimeDir = path.join(pluginDir, "runtime");
    installRuntime(packageTarball, runtimeDir, npmCommand);
    const installedPackageDir = path.join(runtimeDir, "node_modules", "@mengshu", "core");
    const installedPackage = readJson(path.join(installedPackageDir, "package.json"));
    const installedRuntime = path.join(installedPackageDir, "dist/bin/ms.js");
    if (installedPackage.name !== RUNTIME_PACKAGE || installedPackage.version !== sourceManifest.version) {
      throw new Error(
        `Codex runtime version mismatch: plugin ${sourceManifest.version}, runtime ${installedPackage.version}`,
      );
    }
    if (!existsSync(installedRuntime)) {
      throw new Error(`Codex bundled runtime entry not found: ${installedRuntime}`);
    }

    const marketplace = {
      ...sourceMarketplace,
      plugins: sourceMarketplace.plugins.map((plugin) =>
        plugin.name === PLUGIN_NAME
          ? {
              ...plugin,
              source: { source: "local", path: `./plugins/${PLUGIN_NAME}` },
            }
          : plugin),
    };
    const marketplaceDir = path.join(stagingDir, ".agents/plugins");
    mkdirSync(marketplaceDir, { recursive: true });
    writeFileSync(
      path.join(marketplaceDir, "marketplace.json"),
      `${JSON.stringify(marketplace, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(stagingDir, GENERATED_MARKER),
      `${JSON.stringify({
        kind: "mengshu-codex-marketplace",
        plugin: PLUGIN_NAME,
        version: sourceManifest.version,
        runtimePackage: RUNTIME_PACKAGE,
        runtimePackageSha256: sha256(packageTarball),
        platform: process.platform,
        arch: process.arch,
      }, null, 2)}\n`,
      "utf8",
    );

    replaceGeneratedOutput(stagingDir, outputDir);
    return {
      outputDir,
      pluginDir: path.join(outputDir, "plugins", PLUGIN_NAME),
      runtimePath: path.join(
        outputDir,
        "plugins",
        PLUGIN_NAME,
        "runtime/node_modules/@mengshu/core/dist/bin/ms.js",
      ),
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function cliOptions(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--package") result.packageTarball = argv[++index];
    else if (value === "--out") result.outputDir = argv[++index];
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.packageTarball || !result.outputDir) {
    throw new Error("Usage: pack-codex-marketplace --package <tarball> --out <directory>");
  }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const options = cliOptions(process.argv.slice(2));
    const result = await prepareCodexMarketplace({
      projectRoot: defaultProjectRoot,
      ...options,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
