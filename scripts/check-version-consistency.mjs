import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectRoot = path.resolve(path.dirname(scriptPath), "..");
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readText(projectRoot, relativePath) {
  return readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function readJson(projectRoot, relativePath) {
  try {
    return JSON.parse(readText(projectRoot, relativePath));
  } catch (error) {
    throw new Error(
      `JSON 读取失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function requireVersion(value) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    throw new Error(`版本必须为有效 semver，实际为 ${JSON.stringify(value)}`);
  }
  return value;
}

function readJsonVersion(projectRoot, relativePath) {
  return requireVersion(readJson(projectRoot, relativePath).version);
}

function extractVersion(projectRoot, relativePath, pattern) {
  const match = readText(projectRoot, relativePath).match(pattern);
  if (!match?.[1]) {
    throw new Error("未找到版本声明");
  }
  return requireVersion(match[1]);
}

const VERSION_CONSUMERS = [
  {
    source: "openclaw.plugin.json",
    read: (root) => readJsonVersion(root, "openclaw.plugin.json"),
  },
  {
    source: "plugins/openclaw/package.json",
    read: (root) => readJsonVersion(root, "plugins/openclaw/package.json"),
  },
  {
    source: "plugins/openclaw/openclaw.plugin.json",
    read: (root) => readJsonVersion(root, "plugins/openclaw/openclaw.plugin.json"),
  },
  {
    source: "plugins/codex/.codex-plugin/plugin.json",
    read: (root) => readJsonVersion(root, "plugins/codex/.codex-plugin/plugin.json"),
  },
  {
    source: "packages/api/src/cli/ms.ts#CLI_VERSION",
    read: (root) =>
      extractVersion(
        root,
        "packages/api/src/cli/ms.ts",
        /const CLI_VERSION = "([^"]+)";/,
      ),
  },
  {
    source: "packages/mcp/src/stdio-server.ts#SERVER_VERSION",
    read: (root) =>
      extractVersion(
        root,
        "packages/mcp/src/stdio-server.ts",
        /const SERVER_VERSION = "([^"]+)";/,
      ),
  },
];

export function checkVersionConsistency(projectRoot = defaultProjectRoot) {
  let packageVersion;
  try {
    packageVersion = readJsonVersion(projectRoot, "package.json");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`版本一致性检查失败：\n- package.json: ${detail}`);
  }

  const consumers = [];
  const failures = [];
  for (const consumer of VERSION_CONSUMERS) {
    try {
      const version = consumer.read(projectRoot);
      consumers.push({ source: consumer.source, version });
      if (version !== packageVersion) {
        failures.push(
          `${consumer.source}: ${version}（期望 ${packageVersion}）`,
        );
      }
    } catch (error) {
      failures.push(
        `${consumer.source}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `版本一致性检查失败：\n${failures.map((failure) => `- ${failure}`).join("\n")}`,
    );
  }

  return { packageVersion, consumers };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const result = checkVersionConsistency();
    console.log(
      `Version consistency OK: ${result.packageVersion} (${result.consumers.length} consumers)`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
