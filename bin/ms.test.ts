import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, test } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
const entrySource = readFileSync(join(root, "bin/ms.ts"), "utf8");
const formatterSource = readFileSync(join(root, "packages/api/src/cli/error-output.ts"), "utf8");
const tempDirs: string[] = [];

afterEach(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(layout: "source" | "dist") {
  const dir = mkdtempSync(join(tmpdir(), "mengshu-cli-entry-"));
  tempDirs.push(dir);
  // Both layouts use the real package manifest, including its self-reference export.
  copyFileSync(join(root, "package.json"), join(dir, "package.json"));
  const base = layout === "dist" ? join(dir, "dist") : dir;
  const extension = layout === "dist" ? "js" : "ts";
  const entry = join(base, `bin/ms.${extension}`);
  const write = (relative: string, source: string) => {
    const target = join(base, `${relative}.${extension}`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, layout === "dist" ? ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText : source);
  };
  write("bin/ms", entrySource);
  write("packages/api/src/cli/error-output", formatterSource);
  write("packages/api/src/cli/ms", `
    if (process.env.MENGSHU_TEST_REJECT_CLI_IMPORT === "1") throw new Error("HEAVY_CLI_IMPORTED");
    export async function runMengshuCli() {
      if (process.argv[2] === "fail") throw new Error("fixture\\ncommand failure");
      console.log(JSON.stringify(process.argv.slice(2)));
    }
  `);
  const cwd = join(dir, "unrelated-project");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "package.json"), "not a trusted package manifest");
  const configPath = join(cwd, "invalid-config.json");
  writeFileSync(configPath, "invalid config must not be read by version requests");
  return (args: string[], rejectImport = false) => spawnSync(process.execPath, [
    ...(layout === "source" ? ["--import", import.meta.resolve("tsx")] : []), entry, ...args,
  ], {
    cwd, encoding: "utf8", timeout: 5_000, maxBuffer: 4_096,
    env: { ...process.env, MENGSHU_HOME: dir, MENGSHU_CONFIG: configPath,
      MENGSHU_AUTHORITY_JSON: "invalid authority must not be parsed",
      MENGSHU_TEST_REJECT_CLI_IMPORT: rejectImport ? "1" : "0" },
  });
}

describe.each(["source", "dist"] as const)("ms %s entry point", layout => {
  test.each(["--version", "-V"])("%s reads the package version without loading the CLI", flag => {
    const result = fixture(layout)([flag], true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe(`${packageJson.version}\n`);
    expect(result.stderr).toBe("");
  });

  test("mixed version arguments still delegate unchanged to the original CLI", () => {
    const result = fixture(layout)(["--version", "doctor"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('["--version","doctor"]\n');
    expect(result.stderr).toBe("");
  });

  test("normal command failures retain the existing CLI error formatter and exit code", () => {
    const result = fixture(layout)(["fail"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: fixture command failure\n");
  });
});
